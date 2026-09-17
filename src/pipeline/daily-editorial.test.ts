import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runDailyEditorial, DailyEditorialHold, type DailyEditorialInput, type DailyEditorialReview, type DailyEditorialRoute,
  type DailyEditorialCheckpoint, type DailyNewsletterDraft } from './daily-editorial.js';
import { jsonOutputContract } from '../llm/json-output-contract.js';
import type { DraftCall } from './script.js';
import type { PreparedModelTask } from './writing-task.js';

// Synthetic orchestration controls, never real model or factual acceptance evidence.
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sentence = (name: string, n: number) => `The ${name} notice describes item ${n} as a currently planned local activity subject to the stated conditions.`;
const paragraph = (name: string) => Array.from({ length: 20 }, (_, i) => sentence(name, i + 1)).join(' ');
const input: DailyEditorialInput = { day: '2026-09-15', brief: 'A source-based sports briefing.', stories: ['Alpha', 'Bravo', 'Charlie'].map(name => {
  const text = paragraph(name);
  const url = `https://fixtures.example.com/${name.toLowerCase()}`;
  return { id: name, headline: `${name} notice`, primaryUrl: url, sources: [{ id: `${name}_source`, url,
    publishedAt: '2026-09-14', capturedAt: '2026-09-15T00:00:00Z', text, textSha256: hash(text), rawSha256: hash(`raw:${text}`) }] };
}) };
const newsletter = (): DailyNewsletterDraft => ({ sections: input.stories.map(story => ({ storyId: story.id, text: story.sources[0]!.text })) });
const script = () => ({ text: input.stories.flatMap(story => Array.from({ length: 4 }, (_, i) => sentence(story.id, i + 1))).join(' ') });
const supported = (): DailyEditorialReview => ({ verdict: 'supported', reviewedStoryIds: input.stories.map(row => row.id), findings: [] });
function routes(writerReply?: (taskId: string, prompt: string) => unknown, reviewerReply?: (taskId: string, prompt: string) => unknown) {
  const calls: { role: string; taskId: string; prompt: string }[] = [];
  const call = (role: 'writer' | 'reviewer'): DraftCall => async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    assert.ok(task); assert.ok(jsonOutputContract(validate));
    calls.push({ role, taskId: task.taskId, prompt });
    const response = role === 'writer'
      ? writerReply?.(task.taskId, prompt) ?? (task.taskId.includes('newsletter') ? newsletter() : script())
      : reviewerReply?.(task.taskId, prompt) ?? supported();
    const problem = validate(response as T); if (problem) throw new Error(problem);
    return response as T;
  };
  const writer: DailyEditorialRoute = { identity: { provider: 'ollama', model: 'writer-family', runtimeHash: hash('writer') }, call: call('writer') };
  const reviewer: DailyEditorialRoute = { identity: { provider: 'grok', model: 'reviewer-family', runtimeHash: hash('reviewer') }, call: call('reviewer') };
  return { writer, reviewer, calls };
}

test('whole newsletter and script use four independent calls, complete source packets and code-owned links', async () => {
  const model = routes(); const checkpoints: DailyEditorialCheckpoint[] = [];
  const result = await runDailyEditorial(input, { ...model, save: value => { checkpoints.push(value); } });
  assert.equal(result.newsletter.wordCount, 1020); assert.equal(result.script.wordCount, 204);
  assert.equal(model.calls.length, 4);
  assert.deepEqual(model.calls.map(row => row.role), ['writer', 'reviewer', 'writer', 'reviewer']);
  for (const call of model.calls) for (const story of input.stories) {
    assert.ok(call.prompt.includes(story.sources[0]!.text));
    assert.ok(call.prompt.includes(story.sources[0]!.textSha256));
  }
  assert.deepEqual(result.newsletter.sections.map(row => row.sourceUrls), input.stories.map(row => [row.primaryUrl]));
  assert.ok(model.calls[1]!.prompt.includes('A notice can report a rule without proving compliance'));
  assert.equal(result.checkpoint.artifacts.newsletter.reviews.length, 1);
  assert.equal(result.checkpoint.artifacts.newsletter.reviews[0]!.reviewer.model, 'reviewer-family');
  assert.equal(checkpoints[0]!.artifacts.newsletter.status, 'writing', 'Reserve before inference');
  assert.equal(checkpoints[0]!.artifacts.newsletter.candidates.length, 0, 'Saved checkpoints are independent snapshots');
});

test('paragraph breaks do not become repeated empty sentences, while repeated prose still fails', async () => {
  const multi = newsletter();
  for (const row of multi.sections) row.text = row.text.replaceAll('. ', '.\n\n');
  const model = routes(taskId => taskId.includes('newsletter-write') ? multi : undefined);
  const result = await runDailyEditorial(input, model);
  assert.equal(model.calls.length, 4); assert.equal(result.newsletter.wordCount, 1020);
  assert.equal(result.newsletter.sections[0]!.text, multi.sections[0]!.text);
  const duplicate = structuredClone(multi); duplicate.sections[0]!.text += `\n\n${sentence('Alpha', 1)}`;
  const repeated = routes(taskId => taskId.includes('newsletter-write') ? duplicate : undefined);
  await assert.rejects(runDailyEditorial(input, repeated), /repeats complete sentences/);
  assert.equal(repeated.calls.length, 2, 'Reject repeated actual prose before review, within one repair');
});

test('owned publication metadata permits human date components absent from article text, without bypassing review', async () => {
  const dated = structuredClone(input); dated.stories[0]!.sources[0]!.publishedAt = '2031-12-29T03:47:27.050Z';
  const draft = newsletter(); draft.sections[0]!.text += ' The Alpha notice was published on 29 December 2031.';
  const model = routes(taskId => taskId.includes('newsletter-write') ? draft : undefined);
  const result = await runDailyEditorial(dated, model);
  assert.equal(model.calls.length, 4); assert.equal(result.checkpoint.artifacts.newsletter.reviews.length, 1);
  assert.ok(model.calls[1]!.prompt.includes('2031-12-29T03:47:27.050Z'));
});

test('capture timestamps and other-story dates are attention cues that the independent reviewer can reject', async () => {
  for (const kind of ['capture', 'other-story']) {
    const dated = structuredClone(input);
    if (kind === 'capture') dated.stories[0]!.sources[0]!.capturedAt = '2031-12-29T03:47:27.050Z';
    else dated.stories[1]!.sources[0]!.publishedAt = '2031-12-29T03:47:27.050Z';
    const draft = newsletter(); draft.sections[0]!.text += ' The Alpha notice was published on 29 December 2031.';
    const model = routes(taskId => taskId.includes('newsletter-write') ? draft : undefined, (_taskId, prompt) => {
      assert.match(prompt, /"unmatchedNumericTokens":\["29","2031"\]/);
      return { verdict: 'changes-required', reviewedStoryIds: supported().reviewedStoryIds, findings: [{
        storyId: 'Alpha', kind: 'unsupported', candidateExcerpt: 'The Alpha notice was published on 29 December 2031.', evidence: [],
        reason: 'This date is not the publication date of the Alpha source.' }] };
    });
    await assert.rejects(runDailyEditorial(dated, model), /not the publication date/);
    assert.equal(model.calls.length, 4, 'Both candidates reach independent review; no automatic lexical rejection');
  }
});

test('the same model and runtime can write and review through separate purpose calls', async () => {
  const model = routes(); model.reviewer.identity = { ...model.writer.identity };
  const result = await runDailyEditorial(input, model);
  assert.equal(model.calls.length, 4);
  assert.equal(result.checkpoint.artifacts.newsletter.reviews[0]!.reviewer.model, 'writer-family');
  const reused = routes(); reused.reviewer.call = reused.writer.call;
  await assert.rejects(runDailyEditorial(input, reused), /distinct call bindings/);
  assert.equal(reused.calls.length, 0);
});

test('a provided newsletter enters full review with provenance and no invented writer call', async () => {
  const model = routes(); model.reviewer.identity = { ...model.writer.identity };
  const provenance = { origin: 'recorded-codex-cli-with-assistant-edit', rawDraftHash: hash('raw draft'), edit: 'Clarified one source-faithful sentence.' };
  const result = await runDailyEditorial(input, { ...model, providedNewsletter: { draft: newsletter(), provenance } });
  assert.equal(model.calls.length, 3);
  assert.equal(model.calls[0]!.taskId, 'daily-editorial-newsletter-review-provided');
  assert.deepEqual(model.calls.map(row => row.role), ['reviewer', 'writer', 'reviewer']);
  assert.equal(result.checkpoint.artifacts.newsletter.writes, 0);
  assert.equal(result.checkpoint.artifacts.newsletter.origin, 'provided');
  assert.deepEqual(result.checkpoint.artifacts.newsletter.providedProvenance, provenance);
  assert.equal(result.checkpoint.artifacts.newsletter.reviews.length, 1);
  await assert.rejects(runDailyEditorial(input, { ...model, providedNewsletter: { draft: newsletter(), provenance: { ...provenance, edit: 'Changed provenance' } }, checkpoint: result.checkpoint }), /checkpoint identity/);
});

test('a rejected provided newsletter retains its original candidate and permits only one new writer repair', async () => {
  const model = routes(undefined, taskId => taskId.includes('newsletter-review') ? { verdict: 'changes-required', reviewedStoryIds: supported().reviewedStoryIds,
    findings: [{ storyId: 'Alpha', kind: 'unsupported', candidateExcerpt: sentence('Alpha', 1), evidence: [], reason: 'A material source dispute remains.' }] } : undefined);
  await assert.rejects(runDailyEditorial(input, { ...model, providedNewsletter: { draft: newsletter() } }), error => {
    assert.ok(error instanceof DailyEditorialHold);
    assert.equal(error.checkpoint.artifacts.newsletter.origin, 'provided');
    assert.equal(error.checkpoint.artifacts.newsletter.writes, 1);
    assert.equal(error.checkpoint.artifacts.newsletter.candidates.length, 2);
    assert.equal(error.checkpoint.artifacts.newsletter.reviews.length, 2);
    return true;
  });
  assert.deepEqual(model.calls.map(row => row.role), ['reviewer', 'writer', 'reviewer']);
  assert.ok(model.calls[1]!.prompt.includes('ONE TARGETED REPAIR'));
});

test('injected URLs remain a hard gate with one targeted repair before review', async () => {
  const bad = newsletter(); bad.sections[0]!.text += ' Attendance reached 9999 at https://unowned.example.com.';
  const model = routes(taskId => taskId === 'daily-editorial-newsletter-write-1' ? bad : undefined);
  const result = await runDailyEditorial(input, model);
  assert.equal(model.calls.length, 5);
  assert.match(model.calls[1]!.prompt, /without model-authored URLs/);
  assert.equal(result.checkpoint.artifacts.newsletter.candidates.length, 2);
  assert.ok(result.checkpoint.artifacts.newsletter.failures.some(row => row.includes('plain prose')));
  assert.equal(result.newsletter.sections[0]!.text, input.stories[0]!.sources[0]!.text);
});

test('an independent finding about a number borrowed from another story forces one repair', async () => {
  const changed = structuredClone(input);
  const otherSource = changed.stories[1]!.sources[0]!;
  otherSource.text += ' The Bravo notice includes item 9999.';
  otherSource.textSha256 = hash(otherSource.text);
  const bad = newsletter(); bad.sections[0]!.text += ' The Alpha notice includes item 9999.';
  const model = routes(taskId => taskId === 'daily-editorial-newsletter-write-1' ? bad : undefined, (taskId, prompt) => {
    if (taskId !== 'daily-editorial-newsletter-review-1') return undefined;
    const attention = JSON.parse(prompt.split('NUMERIC REVIEW ATTENTION:\n')[1]!.split('\nCANDIDATE:')[0]!);
    assert.deepEqual(attention[0].storyIds, ['Alpha']);
    assert.deepEqual(attention[0].ownedSources.map((row: { sourceId: string }) => row.sourceId), ['Alpha_source']);
    assert.deepEqual(attention[0].unmatchedNumericTokens, ['9999']);
    return { verdict: 'changes-required', reviewedStoryIds: supported().reviewedStoryIds, findings: [{ storyId: 'Alpha', kind: 'unsupported',
      candidateExcerpt: 'The Alpha notice includes item 9999.', evidence: [], reason: '9999 belongs to Bravo, not Alpha.' }] };
  });
  const result = await runDailyEditorial(changed, model);
  assert.ok(result.checkpoint.artifacts.newsletter.failures.some(row => row.includes('9999')));
  assert.equal(result.checkpoint.artifacts.newsletter.writes, 2);
  assert.equal(model.calls.length, 6);
});

test('a genuinely invented number reaches independent review and its supported finding triggers repair', async () => {
  const bad = newsletter(); bad.sections[0]!.text += ' Attendance reached 9999.';
  const model = routes(taskId => taskId === 'daily-editorial-newsletter-write-1' ? bad : undefined, (taskId, prompt) => {
    if (taskId !== 'daily-editorial-newsletter-review-1') return undefined;
    assert.ok(prompt.includes('Attendance reached 9999.'));
    return { verdict: 'changes-required', reviewedStoryIds: supported().reviewedStoryIds, findings: [{ storyId: 'Alpha', kind: 'unsupported',
      candidateExcerpt: 'Attendance reached 9999.', evidence: [], reason: 'The source reports no attendance measurement of 9999.' }] };
  });
  const result = await runDailyEditorial(input, model);
  assert.equal(model.calls.length, 6);
  assert.deepEqual(model.calls.slice(0, 4).map(row => row.role), ['writer', 'reviewer', 'writer', 'reviewer']);
  assert.equal(result.checkpoint.artifacts.newsletter.reviews[0]!.output.verdict, 'changes-required');
});

test('45m, named weekdays and relative years can reach full review without forced numeric rewrites', async () => {
  const changed = structuredClone(input), source = changed.stories[0]!.sources[0]!;
  source.publishedAt = '2026-09-15T03:47:27.050Z';
  source.text += ' The Alpha club received $45m on Monday. The announcement followed a meeting on Sunday. The earlier project began two years ago.';
  source.textSha256 = hash(source.text);
  const converted = newsletter();
  converted.sections[0]!.text += ' The Alpha club received 45 million dollars on 14 September 2026, following a meeting on 13 September 2026. The earlier project began in 2024.';
  const model = routes(taskId => taskId.includes('newsletter-write') ? converted : undefined);
  const result = await runDailyEditorial(changed, model);
  assert.equal(model.calls.length, 4, 'Lexical differences must not consume the repair');
  assert.equal(result.checkpoint.artifacts.newsletter.writes, 1);
  assert.equal(result.checkpoint.artifacts.newsletter.reviews.length, 1);
  assert.ok(model.calls[1]!.prompt.includes('"unmatchedNumericTokens":["45","2024"]'));
  assert.ok(model.calls[1]!.prompt.includes('$45m on Monday'));
  assert.ok(model.calls[1]!.prompt.includes('lexical differences, not factual findings'));
  assert.equal(result.newsletter.sections[0]!.text, converted.sections[0]!.text);
});

test('a reviewer condition finding causes one rewrite with full evidence and a fresh whole review', async () => {
  const finding: DailyEditorialReview = { verdict: 'changes-required', reviewedStoryIds: supported().reviewedStoryIds,
    findings: [{ storyId: 'Alpha', kind: 'missing-condition', candidateExcerpt: sentence('Alpha', 1),
      evidence: [{ sourceId: 'Alpha_source', quote: sentence('Alpha', 1) }], reason: 'Retain the conditional status explicitly.' }] };
  const model = routes(undefined, taskId => taskId === 'daily-editorial-newsletter-review-1' ? finding : undefined);
  const result = await runDailyEditorial(input, model);
  assert.equal(model.calls.length, 6);
  assert.equal(result.checkpoint.artifacts.newsletter.reviews.length, 2);
  assert.deepEqual(result.checkpoint.artifacts.newsletter.reviews[0]!.output, finding, 'Original rejection remains unchanged');
  assert.ok(model.calls[2]!.prompt.includes('Retain the conditional status explicitly.'));
  assert.ok(model.calls[3]!.prompt.includes(input.stories[2]!.sources[0]!.text));
});

test('a repeated semantic rejection holds after one repair; exact source copying cannot autoapprove it', async () => {
  const rejection: DailyEditorialReview = { verdict: 'changes-required', reviewedStoryIds: supported().reviewedStoryIds,
    findings: [{ storyId: 'Alpha', kind: 'unsupported', candidateExcerpt: sentence('Alpha', 1), evidence: [], reason: 'Independent reviewer disputes the assertion.' }] };
  const model = routes(undefined, () => rejection);
  await assert.rejects(runDailyEditorial(input, model), error => {
    assert.ok(error instanceof DailyEditorialHold);
    assert.equal(error.checkpoint.artifacts.newsletter.writes, 2);
    assert.equal(error.checkpoint.artifacts.newsletter.reviews.length, 2);
    assert.equal(error.checkpoint.artifacts.script.writes, 0);
    assert.equal(error.checkpoint.artifacts.newsletter.status, 'held');
    return true;
  });
  assert.equal(model.calls.length, 4);
});

test('insufficient evidence stops without a futile rewrite', async () => {
  const model = routes(undefined, () => ({ verdict: 'insufficient-evidence', reviewedStoryIds: supported().reviewedStoryIds,
    findings: [{ storyId: 'Charlie', kind: 'coverage', candidateExcerpt: '', evidence: [], reason: 'The source cannot support the requested coverage.' }] }));
  await assert.rejects(runDailyEditorial(input, model), /cannot support/);
  assert.equal(model.calls.length, 2);
});

test('wrong source ownership and fabricated quotes are reviewer errors, never instructions to rewrite faithful prose', async () => {
  for (const evidence of [{ sourceId: 'Bravo_source', quote: sentence('Bravo', 1) }, { sourceId: 'Alpha_source', quote: 'Invented quotation.' }]) {
    const model = routes(undefined, () => ({ verdict: 'changes-required', reviewedStoryIds: supported().reviewedStoryIds,
      findings: [{ storyId: 'Alpha', kind: 'contradiction', candidateExcerpt: sentence('Alpha', 1), evidence: [evidence], reason: 'A conflicting source condition.' }] }));
    await assert.rejects(runDailyEditorial(input, model), /reviewer unavailable or invalid/);
    assert.equal(model.calls.length, 2);
  }
});

test('empty or partial review coverage never becomes an accepted artifact', async () => {
  const model = routes(undefined, () => ({ ...supported(), reviewedStoryIds: ['Alpha', 'Bravo'] }));
  await assert.rejects(runDailyEditorial(input, model), /cover every selected story/);
  assert.equal(model.calls.length, 2);
});

test('an accepted exact checkpoint skips generation; changed brief, sources, budget or review cannot inherit acceptance', async () => {
  const model = routes();
  const first = await runDailyEditorial(input, model);
  await runDailyEditorial(input, { ...model, checkpoint: first.checkpoint });
  assert.equal(model.calls.length, 4);
  for (const changed of [{ ...input, brief: 'Different coverage' }, { ...input, day: '2026-09-16' }]) {
    await assert.rejects(runDailyEditorial(changed, { ...model, checkpoint: first.checkpoint }), /checkpoint identity/);
  }
  await assert.rejects(runDailyEditorial(input, { ...model, newsletterBudget: { min: 800, max: 1300 }, checkpoint: first.checkpoint }), /checkpoint identity/);
  const tampered = structuredClone(first.checkpoint); tampered.artifacts.newsletter.reviews[0]!.output.findings.push({} as never);
  await assert.rejects(runDailyEditorial(input, { ...model, checkpoint: tampered }), /checkpoint identity or contents/);
});

test('invalid source hashes and oversized complete evidence fail before any model call', async () => {
  for (const oversized of [false, true]) {
    const altered = structuredClone(input), model = routes();
    altered.stories[0]!.sources[0]!.text += oversized ? ' omitted condition'.repeat(2000) : ' changed';
    if (oversized) altered.stories[0]!.sources[0]!.textSha256 = hash(altered.stories[0]!.sources[0]!.text);
    await assert.rejects(runDailyEditorial(altered, model), oversized ? /bounded input/ : /text hash/);
    assert.equal(model.calls.length, 0);
  }
});

test('a later script failure retains the successfully reviewed newsletter and does not reset attempts on resume', async () => {
  const model = routes(taskId => taskId.includes('script') ? { text: 'This is much too short.' } : undefined);
  let saved: DailyEditorialCheckpoint | undefined;
  await assert.rejects(runDailyEditorial(input, { ...model, save: value => { saved = value; } }), /one repair/);
  assert.equal(saved!.artifacts.newsletter.status, 'accepted');
  assert.equal(saved!.artifacts.script.writes, 2);
  const count = model.calls.length;
  await assert.rejects(runDailyEditorial(input, { ...model, checkpoint: saved }), /retained held state/);
  assert.equal(model.calls.length, count);
});

test('structured Journey scripts retain spoken length and send every authored field to source review', async () => {
  const structured = { speech: script().text, screenTitle: 'A 999-point display claim.' };
  const format = { identity: hash('journey-format-control-v1'), instructions: 'Return speech and screenTitle; both fields receive source review.',
    schema: { type: 'object' as const, additionalProperties: false as const, required: ['speech', 'screenTitle'], properties: {
      speech: { type: 'string' as const }, screenTitle: { type: 'string' as const } } },
    validate: (value: unknown) => { const row = value as typeof structured; return typeof row?.speech === 'string' && typeof row.screenTitle === 'string' ? null : 'Missing structured script fields'; },
    spokenText: (value: unknown) => (value as typeof structured).speech,
    reviewText: (value: unknown) => `${(value as typeof structured).speech}\n${(value as typeof structured).screenTitle}` };
  const model = routes(task => task.includes('script-write') ? structured : undefined, task => task.includes('script-review')
    ? { verdict: 'changes-required', reviewedStoryIds: supported().reviewedStoryIds, findings: [{ storyId: 'Alpha', kind: 'unsupported',
      candidateExcerpt: structured.screenTitle, evidence: [], reason: 'The display claim is unsupported by the supplied sources.' }] } : supported());
  await assert.rejects(runDailyEditorial(input, { ...model, scriptFormat: format }), error => {
    assert.ok(error instanceof DailyEditorialHold); assert.equal(error.checkpoint.artifacts.script.reviews.length, 2);
    assert.equal(error.checkpoint.artifacts.script.status, 'held'); return true;
  });
  const review = model.calls.find(row => row.taskId === 'daily-editorial-script-review-1')!;
  assert.ok(review.prompt.includes(structured.screenTitle));
  assert.ok(review.prompt.includes('"unmatchedNumericTokens":["999"]'));
  assert.equal(model.calls.filter(row => row.role === 'reviewer').length, 3, 'Newsletter plus both structured-script candidates are independently reviewed');
});

test('accepted structured scripts return exact payload and resume only with the identical format contract', async () => {
  const value = { narration: script().text };
  const format = { identity: hash('structured-positive-v1'), instructions: 'Return narration.',
    schema: { type: 'object' as const, additionalProperties: false as const, required: ['narration'], properties: { narration: { type: 'string' as const } } },
    validate: (candidate: unknown) => typeof (candidate as typeof value)?.narration === 'string' ? null : 'Missing narration',
    spokenText: (candidate: unknown) => (candidate as typeof value).narration, reviewText: (candidate: unknown) => (candidate as typeof value).narration };
  const model = routes(task => task.includes('script-write') ? value : undefined);
  const result = await runDailyEditorial(input, { ...model, scriptFormat: format });
  assert.equal(result.script.wordCount, 204); assert.deepEqual(result.script.structured, value); assert.equal(model.calls.length, 4);
  await runDailyEditorial(input, { ...model, scriptFormat: format, checkpoint: result.checkpoint });
  assert.equal(model.calls.length, 4, 'Resume verifies retained factual results without fresh inference');
  await assert.rejects(runDailyEditorial(input, { ...model, scriptFormat: { ...format, identity: hash('changed-format') }, checkpoint: result.checkpoint }), /identity or contents changed/);
});

test('a finding may quote multiple exact passages from one owned source, within the schema limit', async () => {
  const model = routes(undefined, () => ({ verdict: 'insufficient-evidence', reviewedStoryIds: supported().reviewedStoryIds, findings: [{
    storyId: 'Alpha', kind: 'coverage', candidateExcerpt: '', evidence: [
      { sourceId: 'Alpha_source', quote: sentence('Alpha', 1) },
      { sourceId: 'Alpha_source', quote: sentence('Alpha', 2) },
    ], reason: 'Fixture deliberately holds after two valid quotes from one source.' }] }));
  await assert.rejects(runDailyEditorial(input, model), error => {
    assert.ok(error instanceof DailyEditorialHold); assert.equal(error.checkpoint.artifacts.newsletter.reviews.length, 1);
    assert.equal(error.checkpoint.artifacts.newsletter.reviews[0]!.output.findings[0]!.evidence.length, 2);
    assert.match(error.message, /Fixture deliberately holds/); assert.ok(!error.message.includes('reviewer unavailable')); return true;
  });
  assert.equal(model.calls.length, 2);
});
