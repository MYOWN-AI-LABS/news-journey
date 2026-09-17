import { assertPreparedModelTask, type PreparedModelTask } from './writing-task.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { draftNewsletter, newsletterWordCount, type NewsletterDraftOptions, type NewsletterStory } from './newsletter-draft.js';
import { newsletterVideoId } from './newsletter.js';
import type { DraftCall, DraftCheckpoint } from './script.js';
import { NEWSLETTER_LENGTHS } from '../personalization.js';
import { syntheticPassingFactualResponse } from './factual-obligations.test-fixture.js';
import { jsonOutputContract } from '../llm/json-output-contract.js';
import { SourceReviewDisputeError } from './review-dispute.js';
import { readFileSync } from 'node:fs';

const paragraphs = [
  'The Falcons won their opening match after a late goal. The club reported that its next fixture remains subject to scheduling confirmation.',
  'The Harbor team appointed Morgan Vale as captain for the coming season. The announcement did not give a date for the first match.',
  'The Ridge club opened registration for its youth training programme. Places remain subject to availability, and the notice did not announce additional sessions.',
];
const selected = (): NewsletterStory[] => paragraphs.map((text, i) => ({
  headline: ['Falcons opening match', 'Harbor appoints captain', 'Ridge training registration'][i]!,
  primaryUrl: `https://sports.example.org/story-${i}?source=selected`,
  weight: i === 1 ? 'lead' : 'standard',
  verifiedClaims: [text],
}));
const support = {
  radar: [{ repo: 'Example fixture results', url: 'https://results.example.org/ranked', line: 'The harvested results remain provisional.', observedAt: '2026-09-14T12:00:00Z' }],
  signals: [{ source: 'Example Sports Desk', url: 'https://desk.example.org/dispatch', line: 'The desk published a fixture update.' }],
};
const options = (extra: Partial<NewsletterDraftOptions> = {}): NewsletterDraftOptions => ({
  day: '2026-09-14', brief: 'Plain sports coverage.', writerKey: 'ollama/example-7b; rescue=false', budget: { min: 30, max: 150 }, ...extra,
});
const draftFor = (prompt: string) => {
  const focused = syntheticPassingFactualResponse(prompt);
  if (focused !== undefined) return focused;
  if (prompt.startsWith('SOURCE SUPPORT REVIEW')) {
    const sentences = JSON.parse(prompt.match(/^DRAFT_SENTENCES: (.*)$/m)![1]!) as { id: number; text: string }[];
    const claims = JSON.parse(prompt.match(/^PINNED_CLAIMS: (.*)$/m)![1]!) as { id: number; text: string }[];
    const ids = JSON.parse(prompt.match(/^REVIEW_SENTENCE_IDS: (.*)$/m)![1]!) as number[];
    return { sentences: sentences.filter(row => ids.includes(row.id)).map(row => {
      const claimIds = claims.filter(claim => [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(claim.text)]
        .some(part => part.segment.trim() === row.text.trim())).map(claim => claim.id);
      // Non-copy cases must provide their own explicit semantic fixture verdict below.
      return { id: row.id, supported: claimIds.length > 0, claimIds,
        reason: claimIds.length ? 'Fixture sentence is directly stated in its supplied claim.' : 'This fixture requires an explicit non-copy semantic verdict.' };
    }) };
  }
  const match = prompt.match(/^PINNED_CLAIMS: (.*)$/m);
  assert.ok(match, 'a topic prompt carries its complete pinned claim packet');
  const facts = JSON.parse(match[1]!) as { id: number; claim: string }[];
  return { text: facts.map(row => row.claim).join(' '), claimIds: facts.map(row => row.id) };
};
// These transport fixtures count writing/general-review stages. Focused semantic protocol,
// total task accounting and false approvals are exercised by their dedicated regression tests.
const checkedCall = (respond: (prompt: string) => unknown): DraftCall => async <T>(prompt: string, validate: (value: T) => string | null) => {
  const value = (syntheticPassingFactualResponse(prompt) ?? respond(prompt)) as T;
  const problem = validate(value);
  if (problem) throw new Error(problem);
  return value;
};

test('newsletter writer schemas keep complete claims and reject source-number errors independently of shape', async () => {
  let drafts = 0;
  const stories = selected();
  await draftNewsletter(stories, support, async <T>(prompt: string, validate: (value: T) => string | null) => {
    if (prompt.startsWith('NEWSLETTER TOPIC')) {
      const contract = jsonOutputContract(validate);
      assert.ok(contract);
      assert.deepEqual(contract.schema.required, ['text', 'claimIds']);
      assert.equal(contract.schema.additionalProperties, false);
      assert.equal(contract.schema.properties!.text!.maxLength, 6000);
      assert.equal(contract.schema.properties!.claimIds!.items!.maximum, 1);
      assert.doesNotMatch(JSON.stringify(contract.schema), /uniqueItems/);
      assert.ok(prompt.includes(stories[drafts]!.verifiedClaims![0]!));
      assert.match(validate({ text: 'The team scored 999 goals.', claimIds: [1] } as T)!, /numbers absent/);
      assert.match(validate([{ text: paragraphs[drafts], claimIds: [1] }] as T)!, /only an object/);
      assert.match(validate({ text: paragraphs[drafts], claimIds: [1, 1] } as T)!, /unique IDs/, 'Removing an unsupported decoder keyword never removes duplicate-ID validation');
      drafts++;
    }
    const value = draftFor(prompt) as T;
    assert.equal(validate(value), null);
    return value;
  }, options());
  assert.equal(drafts, 3);
});

test('topic jobs exclude unrelated stories and code preserves the exact slate, titles and source rows', async () => {
  const prompts: string[] = [];
  const stories = selected();
  stories[1]!.headline = 'The full selected Harbor headline remains intact even when it exceeds a short email subject limit';
  const issue = await draftNewsletter(stories, support, checkedCall(prompt => { prompts.push(prompt); return draftFor(prompt); }), options());
  assert.equal(prompts.length, 6);
  prompts.forEach((prompt, i) => {
    const topicIndex = Math.floor(i / 2);
    if (prompt.startsWith('NEWSLETTER TOPIC')) assert.match(prompt, /ENTIRE fact budget/);
    const context = JSON.parse(prompt.match(/^SOURCE_CONTEXT: (.*)$/m)![1]!);
    assert.equal(context.editionDay, '2026-09-14');
    assert.equal(context.primaryUrl, stories[topicIndex]!.primaryUrl);
    assert.deepEqual(context.sources, [{ url: stories[topicIndex]!.primaryUrl, attribution: 'sports.example.org', publishedAt: null }]);
    assert.ok(!JSON.stringify(JSON.parse(prompt.match(/^PINNED_CLAIMS: (.*)$/m)![1]!)).includes('2026-09-14'), 'edition metadata is not a source claim');
    assert.equal(prompt.includes('EDITION_DATE'), false);
    assert.ok(prompt.includes(paragraphs[topicIndex]!));
    for (const j of [0, 1, 2].filter(j => j !== topicIndex)) {
      assert.ok(!prompt.includes(stories[j]!.headline));
      assert.ok(!prompt.includes(paragraphs[j]!));
    }
    assert.ok(!prompt.includes(support.radar[0]!.url));
    for (const j of [0, 1, 2].filter(j => j !== topicIndex)) assert.ok(!prompt.includes(stories[j]!.primaryUrl));
  });
  assert.equal(issue.subject, stories[1]!.headline);
  assert.equal(issue.lead.title, stories[1]!.headline);
  assert.equal(issue.lead.sourceUrl, stories[1]!.primaryUrl);
  assert.equal(issue.lead.body, paragraphs[1]);
  assert.deepEqual(issue.items.map(row => row.url), [stories[0]!.primaryUrl, stories[2]!.primaryUrl]);
  assert.deepEqual(issue.items.map(row => row.line), [paragraphs[0], paragraphs[2]]);
  assert.deepEqual(issue.radar, support.radar);
  assert.deepEqual(issue.signals, support.signals);
  assert.ok(newsletterWordCount(issue) >= 30 && newsletterWordCount(issue) <= 150);
});

test('a retry reuses valid earlier sections and restarts only the failed topic', async () => {
  const checkpoint: DraftCheckpoint = { values: {} };
  let calls = 0, saves = 0;
  await assert.rejects(draftNewsletter(selected(), support, checkedCall(prompt => {
    if (++calls === 3) throw new Error('fixture local deadline');
    return draftFor(prompt);
  }), options({ checkpoint, save: () => { saves++; } })), /fixture local deadline/);
  assert.equal(saves, 1);
  assert.deepEqual(Object.keys(checkpoint.values), ['topic:0']);
  const resumed: string[] = [];
  await draftNewsletter(selected(), support, checkedCall(prompt => { resumed.push(prompt); return draftFor(prompt); }), options({ checkpoint, save: () => { saves++; } }));
  assert.equal(resumed.length, 4);
  assert.ok(resumed.every(prompt => !prompt.includes(paragraphs[0]!)));
  assert.equal(saves, 3);
});

test('changed request, facts, writer, source evidence, settings, budget or date invalidates the saved topic identity', async () => {
  const checkpoint: DraftCheckpoint = { values: {} };
  await draftNewsletter(selected(), support, checkedCall(draftFor), options({ checkpoint }));
  const changes: Array<{ stories?: NewsletterStory[]; options?: Partial<NewsletterDraftOptions> }> = [
    { options: { brief: 'Only fixtures confirmed by the clubs.' } },
    { options: { writerKey: 'opencode/ollama/example-7b; rescue=false' } },
    { options: { day: '2026-09-15' } },
    { options: { settings: { request: 'new sports brief', maxCallsPerDay: 0 } } },
    { options: { budget: { min: 31, max: 151 } } },
    { options: { budget: { min: 30, max: 151 } } }, // Same capacity-capped targets still represent a changed request.
    { stories: selected().map((story, i) => i === 2 ? { ...story, verifiedClaims: [`${paragraphs[2]} The club did not publish a closing date.`] } : story) },
    { stories: selected().map((story, i) => i === 2 ? { ...story, primaryUrl: 'https://sports.example.org/current-registration' } : story) },
    { stories: selected().map((story, i) => i === 2 ? { ...story, claimEvidence: [{ url: story.primaryUrl, role: 'primary', status: 200, sha256: 'changed-source-bytes', observedAt: '2026-09-14T15:00:00Z' }] } : story) },
  ];
  for (const change of changes) {
    let calls = 0;
    await draftNewsletter(change.stories ?? selected(), support, checkedCall(prompt => { calls++; return draftFor(prompt); }), options({ checkpoint: structuredClone(checkpoint), ...change.options }));
    assert.equal(calls, 6);
  }
});

test('cached sections are revalidated and cannot carry invented source fields or out-of-range text', async () => {
  const checkpoint: DraftCheckpoint = { values: {} };
  await draftNewsletter(selected(), support, checkedCall(draftFor), options({ checkpoint }));
  (checkpoint.values['topic:1']!.value as { draft: Record<string, unknown> }).draft.url = 'https://unselected.example.org/story';
  let calls = 0;
  await draftNewsletter(selected(), support, checkedCall(prompt => { calls++; return draftFor(prompt); }), options({ checkpoint }));
  assert.equal(calls, 2);
  const cached = checkpoint.values['topic:1']!.value as { draft: { text: string } };
  cached.draft.text = `${cached.draft.text} The team expects better performance.`;
  calls = 0;
  await draftNewsletter(selected(), support, checkedCall(prompt => { calls++; return draftFor(prompt); }), options({ checkpoint }));
  assert.equal(calls, 2, 'a changed cached paragraph cannot inherit an earlier source review');
});

test('invalid claim/source mapping fails with finite calls even when an injected caller ignores validation', async () => {
  for (const bad of [
    { text: paragraphs[0], claimIds: [2] },
    { text: paragraphs[0], claimIds: [1, 1] },
    { text: `${paragraphs[0]} Read https://unselected.example.org/news.`, claimIds: [1] },
    { text: paragraphs[0], claimIds: [1], sourceUrl: 'https://unselected.example.org/news' },
    { text: 'The Falcons won 99 matches.', claimIds: [1] },
  ]) {
    let calls = 0;
    const unchecked: DraftCall = async <T>() => { calls++; return bad as T; };
    await assert.rejects(draftNewsletter(selected(), support, unchecked, options()), /rejected/);
    assert.equal(calls, 1);
  }
});

test('unsupported numerical claims identify exact tokens for repair without treating edition date as evidence', async () => {
  let calls = 0;
  const injected: DraftCall = async <T>(_prompt: string, validate: (value: T) => string | null) => {
    calls++;
    const value = { text: 'On September 14 the Falcons reported 99 matches and 99 wins.', claimIds: [1] } as T;
    assert.equal(validate(value), 'text contains numbers absent from its cited pinned claims: 14, 99');
    return value;
  };
  await assert.rejects(draftNewsletter(selected(), support, injected, options()), /absent from its cited pinned claims: 14, 99/);
  assert.equal(calls, 1);
});

test('all topics are preflighted before calls, and missing or oversized evidence never reuses a saved section', async () => {
  const checkpoint: DraftCheckpoint = { values: {} };
  await draftNewsletter(selected(), support, checkedCall(draftFor), options({ checkpoint }));
  for (const claims of [undefined, [], ['A complete qualified claim. '.repeat(500)]]) {
    const stories = selected();
    stories[2]!.verifiedClaims = claims;
    let calls = 0;
    await assert.rejects(draftNewsletter(stories, support, checkedCall(prompt => { calls++; return draftFor(prompt); }), options({ checkpoint })), /Source verification needed|bounded fact packet/);
    assert.equal(calls, 0);
  }
});

test('a bounded sentence edit reaches the exact selected total without dropping selected stories', async () => {
  const stories = selected().slice(0, 1);
  const extra = 'The match report did not include attendance figures.';
  stories[0]!.verifiedClaims!.push(extra);
  const initial = { text: paragraphs[0]!, claimIds: [1, 2] };
  const total = `${paragraphs[0]} ${extra}`.split(/\s+/).length;
  let calls = 0;
  const issue = await draftNewsletter(stories, { radar: [], signals: [] }, checkedCall(prompt => {
    calls++;
    if (prompt.startsWith('NEWSLETTER TOPIC')) return initial;
    if (prompt.startsWith('SOURCE SUPPORT REVIEW')) return draftFor(prompt);
    assert.match(prompt, /FOCUSED TEXT EDIT/);
    assert.ok(!prompt.includes(paragraphs[1]!));
    return { replacement: extra };
  }), options({ budget: { min: total, max: total } }));
  assert.equal(calls, 3);
  assert.equal(newsletterWordCount(issue), total);
  assert.equal(issue.lead.body, `${paragraphs[0]} ${extra}`);
});

test('exhausted measured repairs stop rather than accept an undersized edition', async () => {
  let calls = 0;
  const additions = ['The report omitted attendance figures.', 'The notice provided no venue details.'];
  const stories = selected().slice(0, 1);
  stories[0]!.verifiedClaims!.push(...additions, ...Array.from({ length: 8 }, (_, i) => `The Falcons listed provisional training session ${i + 1} for registered players.`));
  await assert.rejects(draftNewsletter(stories, { radar: [], signals: [] }, checkedCall(prompt => {
    calls++;
    return prompt.startsWith('NEWSLETTER TOPIC') ? { text: paragraphs[0], claimIds: [1, 2, 3] } : { replacement: additions[calls - 2] };
  }), options({ budget: { min: 90, max: 100 } })), /outside its word budget after two focused edits/);
  assert.equal(calls, 3);
});

test('the complete selected Quick newsletter range is enforced across prose rather than headings or supporting rows', async () => {
  const claims = [
    'The Falcons published their complete fixture list for the coming season, with home matches assigned to the club ground and away matches listed separately. The schedule identifies each opponent and gives the venue for every match that has been confirmed by both clubs.',
    'The club cautioned that dates may change after consultation with opponents. Supporters should use the updated fixture list for confirmed dates because the announcement does not make the initial schedule final. No ticket prices were included in the notice.',
    'The announcement also named Morgan Vale as captain. Training arrangements remain separate from the match schedule, and the club said further information would appear in its next notice.',
  ];
  const stories = selected().map((story, i) => {
    const name = ['Falcons', 'Harbor', 'Ridge'][i]!;
    return { ...story, weight: 'standard' as const, verifiedClaims: claims.map(claim => claim.replaceAll('Falcons', name).replaceAll('The club', `The ${name} club`).replaceAll('The announcement', `The ${name} announcement`)) };
  });
  const [min, max] = NEWSLETTER_LENGTHS.quick.words;
  const issue = await draftNewsletter(stories, support, checkedCall(draftFor), options({ budget: { min, max } }));
  assert.ok(newsletterWordCount(issue) >= min && newsletterWordCount(issue) <= max);
  assert.equal(issue.items.length, 2);
  assert.equal(newsletterWordCount({ ...issue, subject: 'Extra headings do not count', radar: [], signals: [] }), newsletterWordCount(issue));
});

test('unsupported added aims are repaired within the same topic and reviewed before a checkpoint is saved', async () => {
  const stories = selected().slice(0, 1);
  stories[0]!.verifiedClaims!.push('The club notice was issued by the competition secretary for registered supporters.');
  const unsupported = 'The club aims to improve player performance.';
  const replacement = 'The club said the next fixture remains provisional.';
  const checkpoint: DraftCheckpoint = { values: {} };
  let calls = 0, reviews = 0, saves = 0;
  const issue = await draftNewsletter(stories, { radar: [], signals: [] }, checkedCall(prompt => {
    calls++;
    if (prompt.startsWith('NEWSLETTER TOPIC')) return { text: `${paragraphs[0]} ${unsupported}`, claimIds: [1] };
    if (prompt.startsWith('SOURCE SUPPORT REPAIR')) {
      assert.match(prompt, /Unflagged sentences are locked/);
      return { edits: [{ id: 3, replacement }] };
    }
    assert.match(prompt, /^SOURCE SUPPORT REVIEW/);
    const response = draftFor(prompt) as { sentences: { id: number; supported: boolean; claimIds: number[]; reason: string }[] };
    if (++reviews === 1) response.sentences[2] = { id: 3, supported: false, claimIds: [], reason: 'The claims do not establish the club aim or a performance benefit.' };
    else {
      assert.ok(!prompt.includes(unsupported)); assert.ok(prompt.includes(replacement));
      response.sentences[2] = { id: 3, supported: true, claimIds: [1], reason: 'The replacement paraphrases the stated scheduling-confirmation condition.' };
    }
    return response;
  }), options({ checkpoint, budget: { min: 20, max: 150 }, save: () => { saves++; assert.equal(reviews, 2); } }));
  assert.equal(calls, 4);
  assert.equal(saves, 1);
  assert.equal(issue.lead.body, `${paragraphs[0]} ${replacement}`);
});

test('with attempts enabled, a held topic is drafted afresh with the findings and fully re-reviewed instead of holding', async () => {
  let calls = 0, redrafts = 0;
  const checkpoint: DraftCheckpoint = { values: {} };
  const stories = selected().slice(0, 1);
  stories[0]!.verifiedClaims!.push('The club notice was issued by the competition secretary for registered supporters.');
  const issue = await draftNewsletter(stories, { radar: [], signals: [] }, checkedCall(prompt => {
    calls++;
    if (prompt.startsWith('NEWSLETTER TOPIC')) {
      if (prompt.includes('SOURCE_SUPPORT_CORRECTION')) { redrafts++; return { text: paragraphs[0], claimIds: [1] }; }
      return { text: `${paragraphs[0]} The club aims to improve performance.`, claimIds: [1] };
    }
    if (prompt.startsWith('SOURCE SUPPORT REPAIR')) return { edits: [{ id: 3, replacement: 'The club aims to build a stronger team.' }] };
    const response = draftFor(prompt) as { sentences: { id: number; supported: boolean; claimIds: number[]; reason: string }[] };
    if (!prompt.includes('The club aims')) return response;
    response.sentences[2] = { id: 3, supported: false, claimIds: [], reason: 'The claimed aim remains unsupported.' };
    return response;
  }), options({ checkpoint, budget: { min: 20, max: 150 }, attempts: 2 }));
  assert.equal(redrafts, 1); assert.ok(calls > 4);
  assert.ok(issue, 'the fresh paragraph was accepted');
  assert.ok(Object.keys(checkpoint.values).length === 1, 'only the fully reviewed fresh draft is saved');
});

test('a failed second source review never saves an unreviewed topic or starts another repair loop', async () => {
  let calls = 0;
  const checkpoint: DraftCheckpoint = { values: {} };
  const stories = selected().slice(0, 1);
  stories[0]!.verifiedClaims!.push('The club notice was issued by the competition secretary for registered supporters.');
  await assert.rejects(draftNewsletter(stories, { radar: [], signals: [] }, checkedCall(prompt => {
    calls++;
    if (prompt.startsWith('NEWSLETTER TOPIC')) return { text: `${paragraphs[0]} The club aims to improve performance.`, claimIds: [1] };
    if (prompt.startsWith('SOURCE SUPPORT REPAIR')) return { edits: [{ id: 3, replacement: 'The club aims to build a stronger team.' }] };
    const response = draftFor(prompt) as { sentences: { id: number; supported: boolean; claimIds: number[]; reason: string }[] };
    response.sentences[2] = { id: 3, supported: false, claimIds: [], reason: 'The claimed aim remains unsupported.' };
    return response;
  }), options({ checkpoint, budget: { min: 20, max: 150 } })), /Source support still failed after targeted repair/);
  assert.equal(calls, 4);
  assert.deepEqual(checkpoint.values, {});
});

test('two same-day packages need exact current identity, while rerender retains its cached package', () => {
  const older = '20260914-roundup-old', current = '20260914-roundup-current';
  const candidates = [older, current];
  assert.throws(() => newsletterVideoId(candidates), /Multiple video packages/);
  assert.equal(newsletterVideoId(candidates, current), current);
  assert.equal(newsletterVideoId(candidates, undefined, older), older);
  assert.throws(() => newsletterVideoId(candidates, current, older), /another video/);
  assert.throws(() => newsletterVideoId(candidates, '20260913-roundup-current'), /not an eligible package/);
  assert.throws(() => newsletterVideoId(candidates, '20260914-other-edition'), /not an eligible package/);
});

test('the reviewer sees unselected qualifiers and retains their original claim IDs', async () => {
  const story = selected()[0]!;
  story.verifiedClaims = ['The club published a fixture schedule.', 'The fixtures are provisional, and the source reports no completed results.'];
  const text = 'The club published a fixture schedule.';
  let reviews = 0;
  await draftNewsletter([story], { radar: [], signals: [] }, checkedCall(prompt => {
    if (prompt.startsWith('NEWSLETTER TOPIC')) return { text, claimIds: [1] };
    reviews++;
    const facts = JSON.parse(prompt.match(/^PINNED_CLAIMS: (.*)$/m)![1]!);
    assert.deepEqual(facts, story.verifiedClaims!.map((text, i) => ({ id: i + 1, text })));
    return { sentences: [{ id: 1, supported: true, claimIds: [1, 2], reason: 'Publication is stated without claiming final or completed fixtures.' }] };
  }), options({ budget: { min: 6, max: 20 } }));
  assert.equal(reviews, 1);
});

test('a late 32-sentence failure cannot spend beyond the original allowance or save a partial review', async () => {
  const sentences = Array.from({ length: 32 }, (_, i) => `The club published provisional fixture ${i + 1} for review.`);
  const replacement = 'The club states that fixture 32 remains provisional.';
  const story = { ...selected()[0]!, verifiedClaims: [sentences.join(' '), replacement] };
  const checkpoint: DraftCheckpoint = { values: {} };
  let writing = 0, reviews = 0, repairs = 0, saves = 0;
  await assert.rejects(draftNewsletter([story], { radar: [], signals: [] }, checkedCall(prompt => {
    if (prompt.startsWith('NEWSLETTER TOPIC')) { writing++; return { text: sentences.join(' '), claimIds: [1, 2] }; }
    if (prompt.startsWith('SOURCE SUPPORT REPAIR')) { repairs++; return { edits: [{ id: 32, replacement }] }; }
    reviews++;
    const response = draftFor(prompt) as { sentences: { id: number; supported: boolean; claimIds: number[]; reason: string }[] };
    assert.ok(response.sentences.length <= 4);
    if (reviews === 8) response.sentences[3] = { id: 32, supported: false, claimIds: [2], reason: 'Fixture test requires the source qualifier to be stated explicitly.' };
    return response;
  }), options({ checkpoint, budget: { min: 250, max: 350 }, save: () => { saves++; } })), /original 17-task allowance/);
  assert.equal(writing, 1);
  assert.equal(reviews, 8); assert.equal(repairs, 0);
  assert.equal(saves, 0); assert.deepEqual(checkpoint.values, {});
});

test('short review batches propagate the shared parent ceiling without saving partially reviewed prose', async () => {
  const sentences = Array.from({ length: 20 }, (_, i) => `The club published provisional fixture ${i + 1} for review.`);
  const story = { ...selected()[0]!, verifiedClaims: [sentences.join(' ')] };
  const checkpoint: DraftCheckpoint = { values: {} };
  const ceiling = new Error('Shared parent physical-call allowance exhausted');
  let admitted = 0;
  const call: DraftCall = async (prompt, validate) => {
    if (admitted === 4) throw ceiling;
    admitted++;
    return checkedCall(draftFor)(prompt, validate);
  };
  await assert.rejects(draftNewsletter([story], { radar: [], signals: [] }, call, options({ checkpoint, budget: { min: 150, max: 250 } })), error => error === ceiling);
  assert.equal(admitted, 4);
  assert.deepEqual(checkpoint.values, {});
});

test('saved citations come from the final review including newly used repair evidence, never stale initial IDs', async () => {
  const claims = ['The club published provisional fixtures.', 'The notice lists 12 provisional fixtures and names Morgan Vale captain.'];
  const story = { ...selected()[0]!, verifiedClaims: claims };
  const checkpoint: DraftCheckpoint = { values: {} };
  let reviews = 0;
  const issue = await draftNewsletter([story], { radar: [], signals: [] }, checkedCall(prompt => {
    if (prompt.startsWith('NEWSLETTER TOPIC')) return { text: 'The club completed every fixture.', claimIds: [1] };
    if (prompt.startsWith('SOURCE SUPPORT REPAIR')) return { edits: [{ id: 1, replacement: claims[1] }] };
    return { sentences: [{ id: 1, supported: ++reviews > 1, claimIds: reviews === 1 ? [1] : [2], reason: reviews === 1 ? 'Plans do not establish completion.' : 'Both fixture count and captain are stated in claim 2.' }] };
  }), options({ checkpoint, budget: { min: 5, max: 25 } }));
  assert.equal(issue.lead.body, claims[1]);
  assert.deepEqual((checkpoint.values['topic:0']!.value as { draft: { claimIds: number[] } }).draft.claimIds, [2]);
  assert.equal(reviews, 2);
});

test('final numbers must occur in the accepted review citation union, even when other supplied claims contain them', async () => {
  const story = { ...selected()[0]!, verifiedClaims: ['The club lists 12 provisional fixtures.', 'The fixtures are provisional.'] };
  // Exact copy with wrong critic IDs is a dispute, never permission to substitute convenient citations.
  {
    const text = story.verifiedClaims![0]!;
    const checkpoint: DraftCheckpoint = { values: {} }; let calls = 0;
    await assert.rejects(draftNewsletter([story], { radar: [], signals: [] }, checkedCall(prompt => {
      calls++;
      if (prompt.startsWith('NEWSLETTER TOPIC')) return { text, claimIds: [1] };
      return { sentences: [{ id: 1, supported: true, claimIds: [2], reason: 'Fixture test deliberately omits the actual count support ID.' }] };
    }), options({ checkpoint, budget: { min: 6, max: 25 } })), /Source review disputed/);
    assert.equal(calls, 2);
    assert.deepEqual(checkpoint.values, {}, 'Disputed citations cannot become a saved accepted paragraph');
  }
  // A faithful paraphrase still exercises the independent final numeric gate, which must not borrow an uncited claim.
  {
    const text = 'The club has listed 12 fixtures as provisional.';
    const checkpoint: DraftCheckpoint = { values: {} }; let calls = 0;
    await assert.rejects(draftNewsletter([story], { radar: [], signals: [] }, checkedCall(prompt => {
      calls++;
      if (prompt.startsWith('NEWSLETTER TOPIC')) return { text, claimIds: [1] };
      return { sentences: [{ id: 1, supported: true, claimIds: [2], reason: 'Fixture test deliberately omits the actual count support ID.' }] };
    }), options({ checkpoint, budget: { min: 6, max: 25 } })), /numbers absent from its cited pinned claims: 12/);
    assert.equal(calls, 2); assert.deepEqual(checkpoint.values, {});
  }
});

test('recorded local draft with omitted claim 3 keeps its prose and gets citations from mandatory review', async () => {
  const { candidate } = JSON.parse(readFileSync(new URL('./fixtures/harbor-league-omitted-citation.json', import.meta.url), 'utf8'));
  const { claims } = JSON.parse(readFileSync(new URL('./fixtures/harbor-league-review-disputes.json', import.meta.url), 'utf8'));
  const checkpoint: DraftCheckpoint = { values: {} };
  let writes = 0, reviews = 0;
  const issue = await draftNewsletter([{ ...selected()[0]!, verifiedClaims: claims }], { radar: [], signals: [] }, checkedCall(prompt => {
    if (prompt.startsWith('NEWSLETTER TOPIC')) {
      writes++;
      assert.match(prompt, /citation IDs only in claimIds/);
      return candidate;
    }
    assert.ok(prompt.startsWith('SOURCE SUPPORT REVIEW'), 'A faithful lead needs no prose rewrite');
    reviews++;
    const ids = JSON.parse(prompt.match(/^REVIEW_SENTENCE_IDS: (.*)$/m)![1]!);
    // Explicit fixture verdicts from the independent sentence-by-sentence audit.
    return { sentences: ids.map((id: number) => ({ id, supported: true, claimIds: [id], reason: 'Independently audited supplied source sentence; conditions retained.' })) };
  }), options({ checkpoint, budget: { min: 400, max: 430 } }));
  assert.equal(issue.lead.body, candidate.text);
  assert.equal(writes, 1);
  assert.equal(reviews, 4);
  assert.ok(!candidate.claimIds.includes(3));
  assert.deepEqual((checkpoint.values['topic:0']!.value as { draft: { claimIds: number[] } }).draft.claimIds, claims.map((_: string, i: number) => i + 1));
});

test('proposed citations retain strict IDs and unknown-number rejection before any factual approval', async () => {
  const claims = ['Venue bookings remain provisional.', 'The deadline is September 20.'];
  const stop = new Error('fixture stops after proposed-citation validation');
  await assert.rejects(draftNewsletter([{ ...selected()[0]!, verifiedClaims: claims }], { radar: [], signals: [] }, async <T>(_prompt: string, validate: (value: T) => string | null) => {
    assert.equal(validate({ text: claims.join(' '), claimIds: [1] } as T), null);
    assert.match(validate({ text: 'The deadline is September 999.', claimIds: [1] } as T)!, /numbers absent/);
    for (const claimIds of [[], [1, 1], [1.5], [3], [0]]) {
      assert.match(validate({ text: claims.join(' '), claimIds } as T)!, /unique IDs/);
    }
    throw stop;
  }, options({ budget: { min: 5, max: 20 } })), error => error === stop);
});

const provisionalFact = 'The fixtures remain provisional until the club confirms each venue.';
const extraSupportedFact = 'The notice names Morgan Vale as the team captain.';
const inventedFinality = 'The club confirmed that every fixture is final and said this would improve team performance throughout the coming season.';

test('a nine-word deficit after factual repair uses remaining writing allowance then receives a fresh complete review', async () => {
  const story = { ...selected()[0]!, verifiedClaims: [provisionalFact, extraSupportedFact] };
  const checkpoint: DraftCheckpoint = { values: {} };
  const tasks: string[] = [];
  let reviews = 0;
  const issue = await draftNewsletter([story], { radar: [], signals: [] }, checkedCall(prompt => {
    tasks.push(prompt.split('\n')[0]!);
    if (prompt.startsWith('NEWSLETTER TOPIC')) return { text: inventedFinality, claimIds: [1, 2] };
    if (prompt.startsWith('SOURCE SUPPORT REPAIR')) return { edits: [{ id: 1, replacement: provisionalFact }] };
    if (prompt.startsWith('FOCUSED TEXT EDIT')) return { replacement: extraSupportedFact };
    if (++reviews === 1) return { sentences: [{ id: 1, supported: false, claimIds: [1], reason: 'The source establishes provisional arrangements, not finality or performance gains.' }] };
    assert.ok(prompt.includes(provisionalFact)); assert.ok(prompt.includes(extraSupportedFact));
    return { sentences: [{ id: 1, supported: true, claimIds: [1], reason: 'The provisional condition is preserved.' }, { id: 2, supported: true, claimIds: [2], reason: 'The named captain is stated.' }] };
  }), options({ checkpoint, budget: { min: 19, max: 25 } }));
  assert.equal(provisionalFact.split(/\s+/).length, 10);
  assert.equal(extraSupportedFact.split(/\s+/).length, 9);
  assert.equal(newsletterWordCount(issue), 19);
  assert.deepEqual(tasks, ['NEWSLETTER TOPIC', 'SOURCE SUPPORT REVIEW', 'SOURCE SUPPORT REPAIR', 'FOCUSED TEXT EDIT', 'SOURCE SUPPORT REVIEW']);
  assert.deepEqual((checkpoint.values['topic:0']!.value as { draft: { claimIds: number[] } }).draft.claimIds, [1, 2]);
});

test('unsupported additions from a post-factual length edit fail final review without another factual repair loop', async () => {
  const story = { ...selected()[0]!, verifiedClaims: [provisionalFact, extraSupportedFact] };
  const checkpoint: DraftCheckpoint = { values: {} };
  let calls = 0, reviews = 0, repairs = 0;
  await assert.rejects(draftNewsletter([story], { radar: [], signals: [] }, checkedCall(prompt => {
    calls++;
    if (prompt.startsWith('NEWSLETTER TOPIC')) return { text: inventedFinality, claimIds: [1, 2] };
    if (prompt.startsWith('SOURCE SUPPORT REPAIR')) { repairs++; return { edits: [{ id: 1, replacement: provisionalFact }] }; }
    if (prompt.startsWith('FOCUSED TEXT EDIT')) return { replacement: 'The new schedule will improve team performance this season.' };
    if (++reviews === 1) return { sentences: [{ id: 1, supported: false, claimIds: [1], reason: 'Finality and performance gains are unsupported.' }] };
    return { sentences: [{ id: 1, supported: true, claimIds: [1], reason: 'The condition is stated.' }, { id: 2, supported: false, claimIds: [], reason: 'The added performance benefit is not in either claim.' }] };
  }), options({ checkpoint, budget: { min: 19, max: 25 } })), /Source support still failed after targeted repair/);
  assert.equal(calls, 5); assert.equal(repairs, 1); assert.deepEqual(checkpoint.values, {});
});

test('post-factual measured edits cannot reset the exhausted three-writing-task allowance', async () => {
  const small = 'The club published provisional fixtures.';
  const firstAddition = 'The notice named the team captain.';
  const secondAddition = 'The club listed every venue and stated the season opening date.';
  const unsupportedAddition = 'The club guaranteed every venue and the season opening date.';
  const story = { ...selected()[0]!, verifiedClaims: [small, firstAddition, secondAddition] };
  const checkpoint: DraftCheckpoint = { values: {} };
  let writing = 0, calls = 0;
  await assert.rejects(draftNewsletter([story], { radar: [], signals: [] }, checkedCall(prompt => {
    calls++;
    if (prompt.startsWith('NEWSLETTER TOPIC')) { writing++; return { text: small, claimIds: [1, 2, 3] }; }
    if (prompt.startsWith('FOCUSED TEXT EDIT')) return { replacement: ++writing === 2 ? firstAddition : unsupportedAddition };
    if (prompt.startsWith('SOURCE SUPPORT REPAIR')) return { edits: [{ id: 3, replacement: 'The club listed every venue.' }] };
    return { sentences: [{ id: 1, supported: true, claimIds: [1], reason: 'Stated.' }, { id: 2, supported: true, claimIds: [2], reason: 'Stated.' }, { id: 3, supported: false, claimIds: [3], reason: 'Listing venues and stating a date do not establish a guarantee.' }] };
  }), options({ checkpoint, budget: { min: 20, max: 30 } })), /exhausted its 3 bounded writing tasks/);
  assert.equal(writing, 3); assert.equal(calls, 5); assert.deepEqual(checkpoint.values, {});
});

test('major undercoverage spends one existing writing task on a complete all-facts redraft before source review', async () => {
  const facts = Array.from({ length: 10 }, (_, i) => `The club listed provisional fixture ${i + 1} for the season.`);
  const story = { ...selected()[0]!, verifiedClaims: facts };
  const checkpoint: DraftCheckpoint = { values: {} };
  let writing = 0, reviews = 0;
  const issue = await draftNewsletter([story], { radar: [], signals: [] }, checkedCall(prompt => {
    if (prompt.startsWith('NEWSLETTER TOPIC')) {
      writing++;
      if (writing === 1) return { text: facts[0], claimIds: [1] };
      assert.match(prompt, /COVERAGE_CORRECTION/);
      assert.ok(facts.every(fact => prompt.includes(fact)));
      assert.match(prompt, /needs 90–120/); // Original minimum is unchanged; optional headroom permits natural prose.
      return { text: facts.join(' '), claimIds: facts.map((_, i) => i + 1) };
    }
    assert.match(prompt, /^SOURCE SUPPORT REVIEW/); reviews++;
    const ids = JSON.parse(prompt.match(/^REVIEW_SENTENCE_IDS: (.*)$/m)![1]!) as number[];
    return { sentences: ids.map(id => ({ id, supported: true, claimIds: [id], reason: 'The exact provisional fixture is stated in this source claim.' })) };
  }), options({ checkpoint, budget: { min: 90, max: 120 } }));
  assert.equal(writing, 2); assert.equal(reviews, 3);
  assert.equal(newsletterWordCount(issue), 90);
  assert.deepEqual((checkpoint.values['topic:0']!.value as { draft: { claimIds: number[] } }).draft.claimIds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('a complete-section redraft cannot bypass full range or claim IDs even if the caller ignores validation', async () => {
  for (const bad of [{ text: paragraphs[0], claimIds: [1] }, { text: paragraphs[0], claimIds: [99] }]) {
    let calls = 0;
    const checkpoint: DraftCheckpoint = { values: {} };
    const unchecked: DraftCall = async <T>() => (++calls === 1 ? { text: 'The Falcons won.', claimIds: [1] } : bad) as T;
    const stories = selected().slice(0, 1);
    stories[0]!.verifiedClaims!.push(...Array.from({ length: 10 }, (_, i) => `The Falcons listed provisional training session ${i + 1} for registered players.`));
    await assert.rejects(draftNewsletter(stories, { radar: [], signals: [] }, unchecked,
      options({ checkpoint, budget: { min: 100, max: 120 } })), /complete-section redraft rejected/);
    assert.equal(calls, 2); assert.deepEqual(checkpoint.values, {});
  }
});


test('insufficient or repeated source capacity fails before writing without lowering the selected range', async () => {
  const requested = { min: 900, max: 1300 };
  for (const stories of [selected(), selected().map(story => ({ ...story, verifiedClaims: [paragraphs[0]!] }))]) {
    let calls = 0;
    const checkpoint: DraftCheckpoint = { values: {} };
    await assert.rejects(draftNewsletter(stories, support, checkedCall(prompt => { calls++; return draftFor(prompt); }), options({ budget: requested, checkpoint })), /needs more reviewed source evidence before writing/);
    assert.equal(calls, 0); assert.deepEqual(checkpoint.values, {});
    assert.deepEqual(requested, { min: 900, max: 1300 });
  }
});

test('capacity redistribution preserves every topic and the selected minimum when the lead has fewer source facts', async () => {
  const stories = selected();
  stories[0]!.weight = 'lead'; stories[1]!.weight = 'standard';
  stories[1]!.verifiedClaims!.push('The Harbor club issued the captain announcement to registered members after its committee meeting.');
  stories[2]!.verifiedClaims!.push('The Ridge notice lists the registration process and identifies the club office as the contact for applicants.');
  const capacity = stories.map(story => story.verifiedClaims!.join(' ').split(/\s+/).length);
  const total = capacity.reduce((sum, value) => sum + value, 0);
  const targets: Array<{ min: number; max: number }> = [];
  const requested = { min: total, max: total + 50 };
  const issue = await draftNewsletter(stories, support, checkedCall(prompt => {
    if (prompt.startsWith('NEWSLETTER TOPIC')) targets.push(JSON.parse(prompt.match(/^WORD_TARGET: (.*)$/m)![1]!));
    return draftFor(prompt);
  }), options({ budget: requested }));
  assert.deepEqual(targets.map(target => target.min), capacity);
  assert.ok(targets.every((target, i) => target.max >= capacity[i]!));
  assert.equal(targets.reduce((sum, target) => sum + target.max, 0), requested.max);
  assert.equal(newsletterWordCount(issue), requested.min);
  assert.equal(issue.lead.sourceUrl, stories[0]!.primaryUrl);
  assert.deepEqual(issue.items.map(item => item.url), stories.slice(1).map(story => story.primaryUrl));
  assert.deepEqual(requested, { min: total, max: total + 50 });
});


test('typed newsletter tasks route writing, factual repair and fresh critic review without guessing prompt text', async () => {
  const story = { ...selected()[0]!, verifiedClaims: [provisionalFact, extraSupportedFact] };
  const tasks: PreparedModelTask[] = [];
  const checkpoint: DraftCheckpoint = { values: {} };
  let reviews = 0;
  const call: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    const focused = syntheticPassingFactualResponse(prompt);
    if (focused !== undefined) { assert.equal(validate(focused as T), null); return focused as T; }
    assertPreparedModelTask(task); tasks.push(task);
    assert.deepEqual(task.topicIds, ['topic-1']);
    const sourceContext = JSON.parse(prompt.match(/^SOURCE_CONTEXT: (.*)$/m)![1]!);
    assert.equal(sourceContext.primaryUrl, story.primaryUrl);
    assert.equal(sourceContext.editionDay, '2026-09-14');
    assert.match(prompt, /Combine overlapping claims once/);
    let value: unknown;
    switch (task.capability) {
      case 'newsletter-draft': value = { text: inventedFinality, claimIds: [1, 2] }; break;
      case 'newsletter-edit': value = { replacement: extraSupportedFact }; break;
      case 'source-repair': value = { edits: [{ id: 1, replacement: provisionalFact }] }; break;
      case 'source-review': value = ++reviews === 1
        ? { sentences: [{ id: 1, supported: false, claimIds: [1], reason: 'The source establishes provisional arrangements, not finality or performance gains.' }] }
        : { sentences: [{ id: 1, supported: true, claimIds: [1], reason: 'The provisional condition is preserved.' }, { id: 2, supported: true, claimIds: [2], reason: 'The named captain is stated.' }] }; break;
      default: throw new Error(`Unexpected explicit task capability ${task.capability}`);
    }
    assert.equal(validate(value as T), null); return value as T;
  };
  const issue = await draftNewsletter([story], { radar: [], signals: [] }, call, options({ checkpoint, budget: { min: 19, max: 25 }, writerKey: 'writer-and-qualified-critic-identity' }));
  assert.equal(newsletterWordCount(issue), 19);
  assert.deepEqual(tasks.map(task => task.role), ['newsletter-draft', 'source-review', 'source-repair', 'newsletter-draft', 'source-review']);
  assert.deepEqual(tasks.map(task => task.capability), ['newsletter-draft', 'source-review', 'source-repair', 'newsletter-edit', 'source-review']);
  assert.equal(tasks[1]!.evidenceHash, tasks[4]!.evidenceHash);
  assert.notEqual(tasks[1]!.candidateHash, tasks[4]!.candidateHash, 'a revised paragraph cannot inherit the prior critic identity');
  const calls = tasks.length;
  await draftNewsletter([story], { radar: [], signals: [] }, call, options({ checkpoint, budget: { min: 19, max: 25 }, writerKey: 'writer-and-qualified-critic-identity' }));
  assert.equal(tasks.length, calls, 'an unchanged reviewed cache makes no dispatch call');
});


test('a copied source-relative date is preserved for adjudication without weakening metadata or numeric claims', async () => {
  const sourceClaim = 'Today, the source announces a catalogue that predicts molecular changes.';
  const sourceUrl = 'https://research.example.org/announcement';
  const story: NewsletterStory = { headline: 'A molecular catalogue', primaryUrl: sourceUrl, weight: 'lead', verifiedClaims: [sourceClaim],
    claimEvidence: [{ url: sourceUrl, role: 'primary', status: 200, sha256: 'a'.repeat(64), observedAt: '2026-09-14T12:00:00Z', publishedAt: '2026-09-08T00:00:00Z' }] };
  const bad = 'Today, the source announces a catalogue that predicts molecular changes.';
  const prompts: string[] = [];
  let reviews = 0;
  const checkpoint: DraftCheckpoint = { values: {} };
  await assert.rejects(draftNewsletter([story], { radar: [], signals: [] }, checkedCall(prompt => {
    prompts.push(prompt);
    const context = JSON.parse(prompt.match(/^SOURCE_CONTEXT: (.*)$/m)![1]!);
    assert.deepEqual(context, { editionDay: '2026-09-09', primaryUrl: sourceUrl,
      sources: [{ url: sourceUrl, attribution: 'research.example.org', publishedAt: '2026-09-08T00:00:00.000Z' }] });
    assert.ok(!prompt.includes('2026-09-14T12:00:00Z'), 'capture time is not source publication time');
    assert.match(prompt, /Unknown or relocated dates need neutral wording/);
    assert.match(prompt, /complete third-person sentences/);
    assert.match(prompt, /Combine overlapping claims once/);
    if (prompt.startsWith('NEWSLETTER TOPIC')) {
      assert.match(prompt, /Inline attribution within a sentence is allowed/);
      assert.ok(!prompt.includes('Do not write a headline, source name'));
      return { text: bad, claimIds: [1] };
    }
    assert.match(prompt, /^SOURCE SUPPORT REVIEW/);
    return { sentences: [{ id: 1, supported: ++reviews > 1, claimIds: [1], reason: reviews === 1 ? 'Today would relocate the source announcement from September8 to the September9 edition.' : 'The announcement is source-attributed with no relocated date.' }] };
  }), options({ day: '2026-09-09', budget: { min: 10, max: 20 }, checkpoint })), error => {
    assert.ok(error instanceof SourceReviewDisputeError);
    assert.equal(error.dispute.candidate.text, bad);
    assert.equal(error.dispute.sourceContext!.sources[0]!.publishedAt, '2026-09-08T00:00:00.000Z');
    assert.equal(error.dispute.sourceContext!.editionDay, '2026-09-09');
    assert.match(error.dispute.findings[0]!.reason, /relocate.*September8.*September9/);
    return true;
  });
  assert.equal(prompts.length, 2); assert.equal(reviews, 1);
  assert.ok(!prompts.some(prompt => prompt.startsWith('SOURCE SUPPORT REPAIR')));
  assert.deepEqual(checkpoint.values, {});
  // Mocked context preservation is not a qualification of a model's temporal judgment.
  let calls = 0;
  await assert.rejects(draftNewsletter([story], { radar: [], signals: [] }, checkedCall(() => {
    calls++; return { text: 'On September 8 the source announced 99 molecular findings.', claimIds: [1] };
  }), options({ day: '2026-09-09', budget: { min: 10, max: 20 } })), /absent from its cited pinned claims: 8, 99/);
  assert.equal(calls, 1, 'date metadata cannot authorize an uncited number');
});

test('source names and attributed quotations containing today remain usable with dated context', async () => {
  const sourceUrl = 'https://usatoday.example.org/report';
  const text = 'USA Today reports a new catalogue. The report describes it as "available today" in its announcement.';
  const story: NewsletterStory = { headline: 'USA Today catalogue report', primaryUrl: sourceUrl, weight: 'lead', verifiedClaims: [text],
    claimEvidence: [{ url: sourceUrl, role: 'primary', status: 200, sha256: 'b'.repeat(64), observedAt: '2026-09-14T12:00:00Z', publishedAt: '2026-09-08' }] };
  const issue = await draftNewsletter([story], { radar: [], signals: [] }, checkedCall(prompt => {
    assert.match(prompt, /Names such as USA Today are not dates/);
    assert.match(prompt, /clearly scoped source quotation\/report/);
    return draftFor(prompt);
  }), options({ day: '2026-09-09', budget: { min: 10, max: 30 } }));
  assert.equal(issue.lead.body, text);
});

test('publication-date changes invalidate a reviewed checkpoint and unknown dates never inherit capture time', async () => {
  const story = selected()[0]!;
  story.claimEvidence = [{ url: story.primaryUrl, role: 'primary', status: 200, sha256: 'c'.repeat(64), observedAt: '2026-09-14T12:00:00Z' }];
  const checkpoint: DraftCheckpoint = { values: {} };
  const tasks: PreparedModelTask[] = [];
  let expected: string | null = null;
  const call: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    const focused = syntheticPassingFactualResponse(prompt);
    if (focused !== undefined) { assert.equal(validate(focused as T), null); return focused as T; }
    assertPreparedModelTask(task); tasks.push(task);
    const context = JSON.parse(prompt.match(/^SOURCE_CONTEXT: (.*)$/m)![1]!);
    assert.equal(context.sources[0].publishedAt, expected);
    const value = draftFor(prompt) as T; assert.equal(validate(value), null); return value;
  };
  await draftNewsletter([story], support, call, options({ checkpoint, budget: { min: 10, max: 30 } }));
  const original = tasks[0]!;
  await draftNewsletter([story], support, call, options({ checkpoint, budget: { min: 10, max: 30 } }));
  assert.equal(tasks.length, 2);
  expected = '2026-09-08'; story.claimEvidence[0]!.publishedAt = expected;
  await draftNewsletter([story], support, call, options({ checkpoint, budget: { min: 10, max: 30 } }));
  assert.equal(tasks.length, 4);
  assert.notEqual(tasks[2]!.evidenceHash, original.evidenceHash);
});


test('invalid publication metadata in a later topic fails preflight before any writer or cache use', async () => {
  const stories = selected();
  stories[2]!.claimEvidence = [{ url: stories[2]!.primaryUrl, role: 'primary', status: 200, sha256: 'd'.repeat(64), observedAt: '2026-09-14T12:00:00Z', publishedAt: '2026-02-30' }];
  let calls = 0;
  await assert.rejects(draftNewsletter(stories, support, checkedCall(prompt => { calls++; return draftFor(prompt); }), options()), /valid ISO date/);
  assert.equal(calls, 0);
});

test('omitted source conditions invalidate old prose but supply neither evidence capacity nor numerical claims', async () => {
  const story = selected()[0]!;
  const checkpoint: DraftCheckpoint = { values: {} };
  await draftNewsletter([story], { radar: [], signals: [] }, checkedCall(draftFor), options({ checkpoint, budget: { min: 15, max: 30 } }));
  const oldHash = checkpoint.values['topic:0']!.hash;
  story.claimEvidence = [{ url: story.primaryUrl, role: 'primary', status: 200, sha256: 'a'.repeat(64), textSha256: 'b'.repeat(64), observedAt: '2026-09-14T12:00:00Z',
    restrictions: [{ sourceSentenceId: 43, text: 'When the separate eventClock reaches 999, the documented condition applies only to that field.' }] }];
  let calls = 0;
  await draftNewsletter([story], { radar: [], signals: [] }, checkedCall(prompt => {
    calls++;
    assert.equal(JSON.parse(prompt.match(/^SOURCE_CONTEXT: (.*)$/m)![1]!).sources[0].restrictions[0].sourceSentenceId, 43);
    assert.ok(!prompt.match(/^PINNED_CLAIMS: (.*)$/m)![1]!.includes('999'));
    return draftFor(prompt);
  }), options({ checkpoint, budget: { min: 15, max: 30 } }));
  assert.ok(calls > 0); assert.notEqual(checkpoint.values['topic:0']!.hash, oldHash);

  const sparse = { ...story, verifiedClaims: ['The report describes the planned match.'] };
  calls = 0;
  await assert.rejects(draftNewsletter([sparse], { radar: [], signals: [] }, checkedCall(() => { calls++; throw new Error('No call expected'); }), options({ budget: { min: 15, max: 30 } })), /more reviewed source evidence/);
  assert.equal(calls, 0, 'restriction words must not satisfy the missing positive evidence budget');
  await assert.rejects(draftNewsletter([sparse], { radar: [], signals: [] }, checkedCall(() => ({ text: 'The report describes 999 planned matches.', claimIds: [1] })), options({ budget: { min: 5, max: 10 } })), /numbers absent.*999/);
});

test('a saved newsletter retains both focused decisions and cannot reuse a removed or changed review receipt', async () => {
  const checkpoint: DraftCheckpoint = { values: {} }, stories = selected().slice(0, 1);
  const settings = options({ checkpoint, budget: { min: 15, max: 30 } });
  await draftNewsletter(stories, support, checkedCall(draftFor), settings);
  const saved = structuredClone(checkpoint.values['topic:0']!);
  const receipt = (saved.value as any).sourceReview;
  assert.equal(receipt.factualObligations.failures.length, 0);
  assert.equal(receipt.factualObligations.modality.sentences.length, 2);
  assert.ok(receipt.factualObligations.conditions.claimUses.length > 0);
  assert.match(receipt.factualObligations.candidateHash, /^[a-f0-9]{64}$/);
  const reseal = (value: any) => { value.reviewedHash = createHash('sha256').update(JSON.stringify({ draft: value.draft, sourceReview: value.sourceReview })).digest('hex'); };
  for (const mutate of [
    (value: any) => { delete value.sourceReview; },
    (value: any) => { value.sourceReview.factualObligations.modality.sentences[0].reason = 'Changed after acceptance'; },
    (value: any) => { value.sourceReview.factualObligations.failures.push({ sentenceId: 1, reason: 'Unresolved condition' }); },
    (value: any) => { value.sourceReview.factualObligations.candidateHash = 'a'.repeat(64); reseal(value); },
    (value: any) => { value.sourceReview.factualObligations.conditions.claimUses = []; reseal(value); },
    (value: any) => { value.sourceReview.sentences.pop(); reseal(value); },
  ]) {
    checkpoint.values['topic:0'] = structuredClone(saved); mutate(checkpoint.values['topic:0']!.value);
    let writes = 0;
    await draftNewsletter(stories, support, checkedCall(prompt => { if (prompt.startsWith('NEWSLETTER TOPIC')) writes++; return draftFor(prompt); }), settings);
    assert.equal(writes, 1, 'the current paragraph must receive fresh writing and review after receipt corruption');
  }
});
