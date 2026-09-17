import { preparedModelTask, assertPreparedModelTask, type PreparedModelTask } from './writing-task.js';
// Run: npx tsx --test src/pipeline/script.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { hookProblem, motionBriefProblem, stagedCardProblem, draftSupportedCard, STAGED_SCRIPT_VERSION } from "./script.js";
import type { ScriptSegment } from "../types.js";
import { syntheticPassingFactualResponse } from './factual-obligations.test-fixture.js';
import { jsonOutputContract } from '../llm/json-output-contract.js';
import { SourceReviewDisputeError } from './review-dispute.js';

/**
 * The gate exists to police MODEL output, which is untrusted and can carry any shape at runtime —
 * including a `kind` no renderer implements. The helper therefore takes a loose record and casts at
 * the boundary, exactly as the parsed JSON does, so these cases are expressible.
 */
const seg = (motion?: Record<string, string>): ScriptSegment => ({
  voiceover: "A sentence.",
  scene: "news_card",
  onScreen: { title: "Title" },
  motion: motion as unknown as ScriptSegment["motion"],
});

const GOOD = {
  who: "A research group",
  what: "published a calibration method",
  how: "by folding the correction into the readout loop",
  impact: "removes a manual tuning step",
  status: "preprint",
  kind: "device",
};

test('one card repair receives both measured oversized fields without relaxing its250-character limits', () => {
  const motion = { ...GOOD, how: 'h'.repeat(281), impact: 'i'.repeat(281) } as NonNullable<ScriptSegment['motion']>;
  const first = stagedCardProblem({ title: 'Simulated drone search', motion });
  assert.match(first!, /motion\.how.*281/); assert.match(first!, /motion\.impact.*281/);
  assert.match(first!, /Correct all invalid fields/);
  const oneFixed = stagedCardProblem({ title: 'Simulated drone search', motion: { ...motion, how: 'h'.repeat(237) } });
  assert.doesNotMatch(oneFixed!, /motion\.how/); assert.match(oneFixed!, /motion\.impact.*281/);
  assert.equal(stagedCardProblem({ title: 'Simulated drone search', motion: { ...motion, how: 'h'.repeat(250), impact: 'i'.repeat(250) } }), null);
  assert.match(stagedCardProblem({ title: 'one two three four five six seven eight nine', motion: { ...motion, kind: 'unsupported' as any } })!, /title has 9 words.*motion\.how.*motion\.impact.*motion\.kind/);
});

test('card status is source-reviewed and cannot turn simulation or source dates into unsupported absence or today', async () => {
  const facts = ['The authors report a simulation study.', 'The source announced a public research release.'];
  const initial = { title: 'A reported simulation', motion: { ...GOOD, status: 'Available today; not field-deployed or clinically validated' } };
  const descriptor = preparedModelTask({ role: 'script', capability: 'script-draft', taskId: 'card-test', topicIds: ['topic-1'], protocol: 1, evidence: facts });
  const sourceContext = createSourceSupportContext('2026-09-09', 'https://study.example/paper', [{ url: 'https://study.example/paper', publishedAt: '2026-09-08' }]);
  let calls = 0; const roles: string[] = [];
  const value = await draftSupportedCard('Draft the card.', facts, 'The authors report a simulation study.', async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    calls++; roles.push(task!.role); let value: unknown;
    if (calls === 1) value = initial;
    else if (calls === 3) value = { edits: [{ id: 'motion.status', text: 'Reported simulation study' }] };
    else {
      assert.ok(prompt.includes('2026-09-08')); assert.ok(prompt.includes('2026-09-09'));
      const fields = JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!);
      assert.equal(fields.find((field: any) => field.id === 'motion.who').text, GOOD.who);
      value = { fields: fields.map((field: any) => ({ id: field.id, supported: calls === 4 || field.id !== 'motion.status', claimIds: [1], reason: 'Source establishes simulation only; absence and edition-relative today need separate support.' })) };
    }
    assert.equal(validate(value as T), null); return value as T;
  }, descriptor, sourceContext);
  assert.equal(calls, 4); assert.deepEqual(roles, ['script', 'source-review', 'source-repair', 'source-review']);
  assert.equal(value.motion.status, 'Reported simulation study'); assert.equal(value.motion.who, initial.motion.who);
  assert.equal(initial.motion.status, 'Available today; not field-deployed or clinically validated');
});

test('card review removes an unspoken source metric while keeping complete source conditions through repair', async () => {
  const narration = 'The authors report a method evaluated on synthetic event streams.';
  const sourceOnly = 'The method achieved 97 percent success only when the solver converged.';
  const facts = [narration, sourceOnly];
  const sourceContext = createSourceSupportContext('2026-09-09', 'https://study.example/hawkes', [{
    url: 'https://study.example/hawkes', publishedAt: '2026-09-08', sha256: 'a'.repeat(64), textSha256: 'b'.repeat(64),
    restrictions: [{ sourceSentenceId: 77, text: sourceOnly }, { sourceSentenceId: 78, text: 'The evaluation used synthetic event streams, not an unrestricted population.' }],
  }]);
  const initial = { title: 'Synthetic event evaluation', motion: { ...GOOD, impact: '97 percent success', status: 'General event-stream results' } };
  const originalBytes = JSON.stringify({ initial, facts, sourceContext });
  const descriptor = preparedModelTask({ role: 'script', capability: 'script-draft', taskId: 'card-accepted-narration', topicIds: ['topic-1'], protocol: 1, evidence: facts });
  const roles: string[] = [];
  const card = await draftSupportedCard('Draft the card from accepted narration.', facts, narration, async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    roles.push(task!.role); let value: unknown;
    if (roles.length === 1) {
      const contract = jsonOutputContract(validate); assert.ok(contract); assert.equal(contract.strict, true);
      const schema = contract.schema as any;
      assert.deepEqual(schema.required, ['title', 'motion']); assert.equal(schema.additionalProperties, false);
      assert.equal(schema.properties.title.maxLength, 90);
      assert.deepEqual(schema.properties.motion.required, ['who', 'what', 'how', 'impact', 'status', 'kind']);
      for (const name of ['who', 'what', 'how', 'impact', 'status']) assert.equal(schema.properties.motion.properties[name].maxLength, 250);
      assert.deepEqual(schema.properties.motion.properties.kind.enum, ['device', 'memory', 'robot', 'compress', 'flow']);
      assert.doesNotMatch(JSON.stringify(schema), /97|synthetic|default/);
      assert.match(validate({ ...initial, title: 'one two three four five six seven eight nine' } as T)!, /title has 9 words/, 'Character schema does not replace the eight-word validator');
      value = initial;
    }
    else {
      const evidence = JSON.parse(prompt.match(/^PINNED_CLAIMS: (.*)$/m)![1]!);
      assert.deepEqual(evidence, [{ id: 1, text: narration }], 'The source-only metric has no positive claim ID');
      assert.deepEqual(JSON.parse(prompt.match(/^SOURCE_CONTEXT: (.*)$/m)![1]!), sourceContext);
      const context = JSON.parse(prompt.match(/^PRESENTATION_CONTEXT: (.*)$/m)![1]!);
      assert.equal(context.narration, narration); assert.match(context.evidenceScope, /not extra positive evidence/);
      assert.deepEqual(context.sourceByClaim, [{ claimId: 1, primaryUrl: sourceContext.primaryUrl }]);
      assert.ok(prompt.includes('97 percent success only when the solver converged'), 'Complete restrictive source wording remains visible');
      if (task!.role === 'source-repair') value = { edits: [
        { id: 'motion.impact', text: 'Reported method evaluation' },
        { id: 'motion.status', text: 'Synthetic event streams' },
      ] };
      else {
        const fields = JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!);
        value = { fields: fields.map((field: any) => ({ id: field.id, supported: roles.length === 4 || !['motion.impact', 'motion.status'].includes(field.id), claimIds: [1],
          reason: 'The unspoken metric is not positive narration evidence; retained results must keep their synthetic evaluation scope.' })) };
      }
    }
    assert.equal(validate(value as T), null); return value as T;
  }, descriptor, sourceContext);
  assert.deepEqual(roles, ['script', 'source-review', 'source-repair', 'source-review']);
  assert.equal(card.motion.impact, 'Reported method evaluation'); assert.equal(card.motion.status, 'Synthetic event streams');
  assert.equal(card.title, initial.title); assert.equal(card.motion.kind, initial.motion.kind); assert.equal(card.motion.who, initial.motion.who);
  assert.equal(JSON.stringify({ initial, facts, sourceContext }), originalBytes, 'Original narration/source/card inputs are immutable');
});

test('a card cannot cite an unused source claim as though it were accepted narration', async () => {
  const narration = 'The authors report a simulation study.';
  const facts = [narration, 'A separate source-only metric reports 97 percent success.'];
  const descriptor = preparedModelTask({ role: 'script', capability: 'script-draft', taskId: 'unused-source-card', topicIds: ['topic-1'], protocol: 1, evidence: facts });
  let calls = 0;
  await assert.rejects(draftSupportedCard('Draft a card.', facts, narration, async <T>(prompt: string) => {
    calls++;
    if (calls === 1) return { title: 'Reported simulation', motion: GOOD } as T;
    return { fields: JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!).map((field: any) => ({ id: field.id, supported: true, claimIds: [2], reason: 'Attempt to cite the unused original source claim.' })) } as T;
  }, descriptor), /valid pinned-claim citations/);
  assert.equal(calls, 2, 'Invalid evidence citations cannot produce acceptance or extra repair calls');
});

test('missing or incomplete accepted narration cannot start card drafting', async () => {
  const facts = ['A valid original source claim exists.'];
  const descriptor = preparedModelTask({ role: 'script', capability: 'script-draft', taskId: 'invalid-narration-card', topicIds: ['topic-1'], protocol: 1, evidence: facts });
  for (const narration of ['', 'A cut-off phrase']) await assert.rejects(draftSupportedCard('Draft a card.', facts, narration, async () => { throw new Error('must not call'); }, descriptor), /Card needs complete bounded accepted narration/);
});

test('a failed card field review cannot become a completed staged checkpoint', async () => {
  const topic = draftTopic(), checkpoint: DraftCheckpoint = { values: {} }, good = draftWriter([]); let repairs = 0;
  const bad: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    if (prompt.startsWith('AUTHORED FIELD SOURCE REPAIR')) { repairs++; return { edits: [{ id: 'motion.status', text: 'Not clinically validated' }] } as T; }
    if (prompt.startsWith('AUTHORED FIELD SOURCE REVIEW')) return { fields: JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!).map((field: any) => ({ id: field.id, supported: field.id !== 'motion.status', claimIds: [1], reason: 'This negative clinical status is not in the source.' })) } as T;
    return good(prompt, validate, task);
  };
  await assert.rejects(stagedRoundupScript(topic, { min: 100, max: 160 }, bad, { checkpoint }), /field source support failed/);
  assert.equal(repairs, 1); assert.equal(checkpoint.values['story-1-card'], undefined);
  assert.ok(checkpoint.values['story-1-narration'], 'completed narration remains resumable');
});

test("a complete motion brief passes", () => {
  assert.equal(motionBriefProblem([seg(GOOD)]), null);
});

test("a missing brief is rejected, and names the story", () => {
  const problem = motionBriefProblem([seg(GOOD), seg(undefined)]);
  assert.match(String(problem), /story 2 is missing its shared motion brief/);
});

test("an empty field is rejected", () => {
  const problem = motionBriefProblem([seg({ ...GOOD, how: "   " })]);
  assert.match(String(problem), /story 1 motion\.how is empty/);
});

/**
 * The reason this gate is not just a non-empty check: INPUT → PROCESS → RESULT fills every field and
 * still describes no story, producing a diagram that explains nothing. Rejecting it costs one
 * corrective model retry; shipping it costs an edition.
 */
test("generic placeholders are rejected even though the field is non-empty", () => {
  for (const placeholder of ["INPUT", "process", "Result", "STEP 2", "TBD", "n/a"]) {
    const problem = motionBriefProblem([seg({ ...GOOD, what: placeholder })]);
    assert.match(String(problem), /generic placeholder/, `expected "${placeholder}" to be rejected`);
  }
});

test("an unsupported motion kind is rejected — there is no renderer for it", () => {
  const problem = motionBriefProblem([seg({ ...GOOD, kind: "quantum" })]);
  assert.match(String(problem), /unsupported motion\.kind "quantum"/);
});

test("every supported kind is accepted", () => {
  for (const kind of ["device", "memory", "robot", "compress", "flow"]) {
    assert.equal(motionBriefProblem([seg({ ...GOOD, kind })]), null, `expected "${kind}" to pass`);
  }
});

// Check interruption recovery and source ownership, not the model's literary quality.
import { draftNarration, repairTextLength, stagedRoundupScript, type DraftCall, type DraftCheckpoint } from './script.js';
import type { Topic } from '../types.js';
import { createSourceSupportContext, NEWSLETTER_SOURCE_CONTEXT_RULES } from './source-support.js';
const draftTopic = (): Topic => ({ id: 'draft-test', kind: 'roundup', headline: 'Two stories', angle: '', primaryUrl: 'https://example.org/a', sourceItems: [], repo: null, alternates: [], stories: [0, 1].map(i => ({ n: i + 1, headline: `Story ${i + 1}`, summary: `Candidate report ${i + 1}`, verifiedClaims: [`The source states a concrete finding for story ${i + 1}.`], weight: i === 0 ? 'lead' : 'standard', primaryUrl: `https://example.org/${i}`, repo: null, assetRef: `source-${i}`, suggestedScene: i === 0 ? 'news_card' : 'repo_card', principalEntity: `Entity ${i}`, area: 'other', verticals: ['other'] })) });
const supportedReview = (prompt: string) => {
  const claims = JSON.parse(prompt.match(/^PINNED_CLAIMS: (.*)$/m)![1]!) as { id: number; text: string }[];
  return { sentences: (JSON.parse(prompt.match(/DRAFT_SENTENCES: (.*)/)![1]!) as { id: number; text: string }[]).map(row => {
    const exact = claims.filter(claim => [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(claim.text)]
      .some(part => part.segment.trim() === row.text.trim())).map(claim => claim.id);
    // Other synthetic prose tests concern bounds/routing, not semantic model qualification.
    return { id: row.id, supported: true, claimIds: exact.length ? exact : [1], reason: 'Simulated direct source support.' };
  }) };
};
function draftWriter(seen: string[], fail?: string): DraftCall {
  return async <T>(prompt: string, validate: (v: T) => string | null) => {
    const focused = syntheticPassingFactualResponse(prompt);
    if (focused !== undefined) { assert.equal(validate(focused as T), null); return focused as T; }
    if (prompt.startsWith('AUTHORED FIELD SOURCE REVIEW')) {
      const fields = JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!);
      const value = { fields: fields.map((field: any) => ({ id: field.id, supported: true, claimIds: [1], reason: 'Injected complete field review.' })) } as T;
      const problem = validate(value); if (problem) throw new Error(problem); return value;
    }
    if (prompt.startsWith('SOURCE SUPPORT REVIEW')) {
      const value = supportedReview(prompt) as T;
      const problem = validate(value); if (problem) throw new Error(problem);
      return value;
    }
    const kind = prompt.match(/STAGED ROUNDUP: (\w+)/)![1]!;
    seen.push(kind + (prompt.includes('Story 2') || prompt.includes('STORY_ID: topic-2') ? ':2' : ':1'));
    if (kind === fail) throw new Error('simulated interruption');
    let value: unknown;
    if (kind === 'FRAMING') value = { hook: 'Verified reports reveal two findings.', cta: 'Subscribe for more.' };
    else if (kind === 'NARRATION') { const target = JSON.parse(prompt.match(/NARRATION_TARGET: (.*)/)![1]!); value = { voiceover: Array.from({ length: target.min }, (_, i) => `word${i}`).join(' ') + '.' }; }
    else if (kind === 'CARD') value = { title: 'The verified report', motion: GOOD, assetRef: 'forged', scene: 'invented' };
    else value = { title: 'Today’s reports', description: 'Two verified reports.', linkedinPost: 'Read the verified reports.', hashtags: [] };
    const problem = validate(value as T); if (problem) throw new Error(problem);
    return value as T;
  };
}
test('normal staged cards expose only their accepted narration as positive evidence with source restrictions intact', async () => {
  assert.equal(STAGED_SCRIPT_VERSION, 11);
  const selected = draftTopic(), checkpoint: DraftCheckpoint = { values: {} }, good = draftWriter([]);
  const unspokenFact = 'A separate experiment achieved 97 percent success.';
  for (const story of selected.stories!) {
    story.verifiedClaims!.push(unspokenFact);
    story.claimEvidence = [{ url: story.primaryUrl, role: 'primary', status: 200, observedAt: '2026-09-09T00:00:00Z', publishedAt: '2026-09-08', sha256: 'a'.repeat(64), textSha256: 'b'.repeat(64),
      restrictions: [{ sourceSentenceId: 77, text: 'The experiment is limited to synthetic event streams.' }] }];
  }
  let cards = 0;
  const result = await stagedRoundupScript(selected, { min: 100, max: 160 }, async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    if (prompt.includes('STAGED ROUNDUP: CARD')) {
      cards++;
      const narration = (checkpoint.values[`story-${cards}-narration`]!.value as { voiceover: string }).voiceover;
      assert.equal(JSON.parse(prompt.match(/^ACCEPTED_NARRATION: (.*)$/m)![1]!), narration);
      assert.doesNotMatch(prompt, /STORY:|97 percent success/);
      assert.match(prompt, /ONLY its accepted narration/); assert.match(prompt, /cannot supply extra facts/);
      const sourceContext = createSourceSupportContext('2026-09-09', selected.stories![cards - 1]!.primaryUrl, selected.stories![cards - 1]!.claimEvidence!);
      assert.deepEqual(JSON.parse(prompt.match(/^SOURCE_CONTEXT: (.*)$/m)![1]!), sourceContext);
      assert.match(prompt, /limited to synthetic event streams/);
      const expected = preparedModelTask({ role: 'script', capability: 'script-draft', taskId: 'expected', topicIds: ['topic-1'], protocol: 1, evidence: { acceptedNarration: narration, sourceContext } });
      assert.equal(task!.evidenceHash, expected.evidenceHash);
    }
    return good(prompt, validate, task);
  }, { checkpoint, day: '2026-09-09' });
  assert.equal(cards, 2);
  assert.deepEqual(result.body.map(segment => [segment.assetRef, segment.scene]), [['source-0', 'news_card'], ['source-1', 'repo_card']]);
  assert.ok(result.body.every(segment => !segment.sourceAccount), 'Normal cards retain their motion presentation contract');
});
test('staged draft resumes completed tasks and keeps selected sources and scenes in code', async () => {
  const checkpoint: DraftCheckpoint = { values: {} }, first: string[] = [], resumed: string[] = [];
  const topic = draftTopic(), options = { checkpoint, writerKey: 'model-a' };
  await assert.rejects(stagedRoundupScript(topic, { min: 100, max: 160 }, draftWriter(first, 'PUBLISH'), options), /interruption/);
  assert.equal(Object.keys(checkpoint.values).length, 5);
  const script = await stagedRoundupScript(topic, { min: 100, max: 160 }, draftWriter(resumed), options);
  assert.deepEqual(resumed, ['PUBLISH:1']);
  assert.deepEqual(script.body.map(b => [b.assetRef, b.scene]), [['source-0', 'news_card'], ['source-1', 'repo_card']]);
  assert.equal(script.fullVoiceoverText.split(/\s+/).length, 100);
  for (const story of topic.stories!) {
    assert.equal(script.publish.description.split(story.primaryUrl).length - 1, 1);
    assert.equal(script.publish.linkedinPost.split(story.primaryUrl).length - 1, 1);
  }
  const changed: string[] = [];
  topic.stories![1]!.verifiedClaims = ['The source states a corrected finding for the second story.'];
  await stagedRoundupScript(topic, { min: 100, max: 160 }, draftWriter(changed), options);
  assert.ok(changed.includes('NARRATION:2'));
  assert.ok(!changed.includes('NARRATION:1'), 'unaffected story narration survives a factual correction elsewhere');
  const newModel: string[] = [];
  await stagedRoundupScript(topic, { min: 100, max: 160 }, draftWriter(newModel), { ...options, writerKey: 'model-b' });
  assert.equal(newModel.length, 6, 'model change invalidates every completed task');
});
test('changing the duration or corrupting a cached answer forces validated regeneration', async () => {
  const checkpoint: DraftCheckpoint = { values: {} }, topic = draftTopic();
  await stagedRoundupScript(topic, { min: 100, max: 160 }, draftWriter([]), { checkpoint });
  const changed: string[] = [];
  await stagedRoundupScript(topic, { min: 150, max: 225 }, draftWriter(changed), { checkpoint });
  assert.equal(changed.filter(s => s.startsWith('NARRATION')).length, 2);
  (checkpoint.values['story-1-narration']!.value as { voiceover: string }).voiceover = 'Too short.';
  const repaired: string[] = [];
  await stagedRoundupScript(topic, { min: 150, max: 225 }, draftWriter(repaired), { checkpoint });
  assert.ok(repaired.includes('NARRATION:1'));
});

test('model-written publishing URLs cannot replace authoritative source attribution', async () => {
  const good = draftWriter([]);
  const forged: DraftCall = (prompt, validate) => prompt.includes('STAGED ROUNDUP: PUBLISH')
    ? good(prompt, value => validate({ ...value as object, description: 'Read https://forged.example/report' } as typeof value))
    : good(prompt, validate);
  await assert.rejects(stagedRoundupScript(draftTopic(), { min: 100, max: 160 }, forged), /no URLs/);
});

test('hook and publication copy receive one bounded review against accepted narration with all distinct source restrictions', async () => {
  const topic = draftTopic(); topic.id = '20260909-publication';
  topic.stories![1]!.claimEvidence = [{ url: topic.stories![1]!.primaryUrl, role: 'primary', status: 200, observedAt: '2026-09-14T12:00:00Z', publishedAt: '2026-09-08',
    sha256: 'a'.repeat(64), textSha256: 'b'.repeat(64), restrictions: [{ sourceSentenceId: 43, text: 'The supplied timestamp must be strictly newer than the stored timestamp.' }] }];
  const checkpoint: DraftCheckpoint = { values: {} }, good = draftWriter([]), tasks: PreparedModelTask[] = [];
  let reviews = 0;
  const caller: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    if (!task!.taskId.startsWith('script-publication-review-fields-')) return good(prompt, validate, task);
    tasks.push(task!); let value: unknown;
    if (prompt.startsWith('AUTHORED FIELD SOURCE REPAIR')) value = { edits: [{ id: 'hook', text: 'Reported findings retain important qualifications.' }, { id: 'description', text: 'Read the findings and their stated qualifications.' }] };
    else {
      reviews++; const fields = JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!);
      const evidence = JSON.parse(prompt.match(/^PINNED_CLAIMS: (.*)$/m)![1]!);
      assert.deepEqual(evidence.map((claim: any) => claim.text), [1, 2].map(n => (checkpoint.values[`story-${n}-narration`].value as {voiceover:string}).voiceover));
      const contexts = JSON.parse(prompt.match(/^SOURCE_CONTEXTS: (.*)$/m)![1]!);
      assert.equal(contexts.length, 2); assert.equal(contexts[1].sources[0].publishedAt, '2026-09-08');
      assert.match(contexts[1].sources[0].restrictions[0].text, /strictly newer/);
      assert.equal(fields.find((field: any) => field.id === 'title').text, 'Today’s reports');
      value = { fields: fields.map((field: any) => ({ id: field.id, supported: reviews === 2 || !['hook', 'description'].includes(field.id), claimIds: [1, 2], reason: 'Injected review checks only accepted narration and its immutable source restrictions.' })) };
    }
    assert.equal(validate(value as T), null); return value as T;
  };
  const script = await stagedRoundupScript(topic, { min: 100, max: 160 }, caller, { checkpoint });
  assert.equal(script.hook, 'Reported findings retain important qualifications.');
  assert.equal(script.cta, 'Subscribe for sourced reporting.');
  assert.equal(script.publish.title, 'Today’s reports');
  assert.ok(script.publish.description.startsWith('Read the findings and their stated qualifications.'));
  assert.equal(script.fullVoiceoverText.split(/\s+/).length, 100);
  assert.deepEqual(tasks.map(task => task.role), ['source-review', 'source-repair', 'source-review']);
  assert.equal(tasks[0].evidenceHash, tasks[2].evidenceHash); assert.notEqual(tasks[0].candidateHash, tasks[2].candidateHash);
  assert.ok(checkpoint.values['publication-review']);
  await stagedRoundupScript(topic, { min: 100, max: 160 }, async () => { throw new Error('Exact accepted cache cannot call again'); }, { checkpoint });
});

test('publication repair cannot change the locked narration budget and failed final review never creates an accepted checkpoint', async () => {
  for (const changeWords of [true, false]) {
    const checkpoint: DraftCheckpoint = { values: {} }, good = draftWriter([]); let reviewCalls = 0, repairCalls = 0;
    const call: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
      if (!task!.taskId.startsWith('script-publication-review-fields-')) return good(prompt, validate, task);
      if (prompt.startsWith('AUTHORED FIELD SOURCE REPAIR')) { repairCalls++; return { edits: [{ id: 'hook', text: changeWords ? 'Results prove clinical efficacy.' : 'Reported results establish clinical effectiveness.' }] } as T; }
      reviewCalls++;
      return { fields: JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!).map((field: any) => ({ id: field.id, supported: field.id !== 'hook', claimIds: [1], reason: 'The source does not establish this clinical result.' })) } as T;
    };
    await assert.rejects(stagedRoundupScript(draftTopic(), { min: 100, max: 160 }, call, { checkpoint }), changeWords ? /original word count/ : /failed after one repair/);
    assert.equal(repairCalls, 1); assert.equal(reviewCalls, changeWords ? 1 : 2);
    assert.equal(checkpoint.values['publication-review'], undefined);
    assert.ok(checkpoint.values['story-2-narration']); assert.ok(checkpoint.values.publish);
  }
});

test('hooks reject agenda placeholders but retain company names and qualified findings', () => {
  for (const hook of ['Here are today’s reports.', 'This is The Daily Signal.', 'September 13, 2026', 'Sunday briefing', '2026-09-13 news', 'AI changes everything.']) assert.ok(hookProblem(hook), hook);
  for (const hook of ['May Mobility adds a new safety system', 'Monday.com adds an automation feature', 'Simulated drones found gas leaks more often', 'Some responder health records remain sealed']) assert.equal(hookProblem(hook), null, hook);
});

test('a publication introduction counts toward narration and invalidates saved writer tasks', async () => {
  const checkpoint: DraftCheckpoint = { values: {} }, topic = draftTopic();
  const first = await stagedRoundupScript(topic, { min: 100, max: 160 }, draftWriter([]), { checkpoint, intro: 'This is The Daily Signal.' });
  assert.equal(first.fullVoiceoverText.split(/\s+/).length, 100);
  assert.match(first.fullVoiceoverText, /^Verified reports reveal two findings\. This is The Daily Signal\./);
  const calls: string[] = [];
  const second = await stagedRoundupScript(topic, { min: 100, max: 160 }, draftWriter(calls), { checkpoint, intro: 'This is Science Today.' });
  assert.equal(calls.length, 6);
  assert.equal(second.fullVoiceoverText.split(/\s+/).length, 100);
  assert.ok(!second.fullVoiceoverText.includes('The Daily Signal'));
});

const measuredWords = (text: string) => text.trim().split(/\s+/).length;
const exactTarget = (min: number, max: number) => ({ min, max, acceptedMin: min, acceptedMax: max });
const testFacts = { claims: ['The league announced an independent review of officiating decisions.', 'The review will examine replay procedures and publish its findings after the season.', 'No rule changes have been adopted.'] };
function answerQueue(answers: unknown[], seen: string[]): DraftCall {
  return async <T>(prompt: string, validate: (value: T) => string | null) => {
    // This queue measures writer/general-review behavior; focused review has separate fixtures.
    const focused = syntheticPassingFactualResponse(prompt);
    if (focused !== undefined) { assert.equal(validate(focused as T), null); return focused as T; }
    seen.push(prompt);
    if (prompt.startsWith('SOURCE SUPPORT REVIEW')) return supportedReview(prompt) as T;
    const contract = jsonOutputContract(validate); assert.ok(contract, 'Both narration writing and measured editing carry decoder contracts');
    const key = prompt.startsWith('FOCUSED TEXT EDIT') ? 'replacement' : 'voiceover';
    assert.deepEqual(contract.schema, { type: 'object', properties: { [key]: { type: 'string', minLength: 1, maxLength: 6000 } }, required: [key], additionalProperties: false });
    assert.equal(contract.strict, true);
    assert.notEqual(validate({ [key]: 'x'.repeat(6001) } as T), null, 'Existing complete-text validator retains the actual character bound');
    assert.ok(answers.length, 'no unexpected extra writer call');
    const value = answers.shift() as T;
    const problem = validate(value); if (problem) throw new Error(problem);
    return value;
  };
}

test('short narration adds a complete sourced sentence while retaining existing wording exactly', async () => {
  const original = 'The league announced an independent review of officiating decisions.  No rule changes have been adopted.';
  const addition = 'The review will examine replay procedures and publish its findings after the season.';
  const seen: string[] = [];
  const result = await draftNarration('Write this story.', testFacts, exactTarget(28, 32), answerQueue([{ voiceover: original }, { replacement: addition }], seen));
  assert.equal(result.voiceover, original + ' ' + addition);
  assert.equal(seen.length, 3, 'draft, measured edit, then source review');
  assert.equal(measuredWords(result.voiceover), 28);
  assert.ok(seen[1]!.includes(JSON.stringify(testFacts)));
  assert.match(seen[1]!, /No invented benefit, filler/);
});

test('long narration uses a focused replacement and preserves its locked suffix and qualifier', async () => {
  const original = 'The league announced that it would conduct an independent review examining how officials make their decisions during games.  No rule changes have been adopted.';
  const replacement = 'The league announced an independent review of officiating decisions.';
  const seen: string[] = [];
  const result = await draftNarration('Write this story.', testFacts, exactTarget(15, 18), answerQueue([{ voiceover: original }, { replacement }], seen));
  assert.equal(result.voiceover, replacement + '  No rule changes have been adopted.');
  assert.match(seen[1]!, /LOCKED_AFTER: "  No rule changes have been adopted\."/);
  assert.match(seen[1]!, /Preserve every qualifier needed by any retained claim/);
});

test('unchanged, repeated and cut-off sentence edits are rejected', async () => {
  const original = 'The league announced a review.';
  for (const replacement of [original, 'No rule changes have been', 'The league announced a review. The league announced a review.']) {
    await assert.rejects(draftNarration('Write this story.', testFacts, exactTarget(12, 18), answerQueue([{ voiceover: original }, { replacement }], [])), /repeats|complete sentence/);
  }
  const long = 'The league announced an independent review of all officiating decisions during games.';
  await assert.rejects(draftNarration('Write this story.', testFacts, exactTarget(6, 8), answerQueue([{ voiceover: long }, { replacement: long }], [])), /did not improve/);
});

test('narration recovery stops after two improving edits and uses the same caller for every request', async () => {
  const seen: string[] = [];
  const responses = [{ voiceover: 'The league announced a review.' }, { replacement: 'The review covers replay procedures.' }, { replacement: 'No rule changes have been adopted.' }];
  await assert.rejects(draftNarration('Write this story.', testFacts, exactTarget(25, 30), answerQueue(responses, seen)), /after two focused edits/);
  assert.equal(seen.length, 3, 'one draft and at most two edit calls; each modelJson call has at most two local attempts');
  const deadline = new Error('Editorial qualification time ceiling exhausted before the next request.');
  let calls = 0;
  const expired: DraftCall = async <T>() => { if (++calls > 1) throw deadline; return { voiceover: 'The league announced a review.' } as T; };
  await assert.rejects(draftNarration('Write this story.', testFacts, exactTarget(25, 30), expired), error => error === deadline);
  assert.equal(calls, 2, 'deadline failure propagates without another edit attempt');
});

test('a failed focused edit cannot overwrite a previously validated narration checkpoint', async () => {
  const checkpoint: DraftCheckpoint = { values: {} }, topic = draftTopic();
  await stagedRoundupScript(topic, { min: 100, max: 160 }, draftWriter([]), { checkpoint });
  const prior = structuredClone(checkpoint.values['story-1-narration']);
  topic.stories![0]!.verifiedClaims = ['A newly corrected source claim requires new narration.'];
  const good = draftWriter([]);
  const failEdit: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null) => {
    if (prompt.includes('FOCUSED TEXT EDIT')) throw new Error('No additional supported detail.');
    if (prompt.includes('STAGED ROUNDUP: NARRATION')) return { voiceover: 'The league announced a review.' } as T;
    return good(prompt, validate);
  };
  await assert.rejects(stagedRoundupScript(topic, { min: 100, max: 160 }, failEdit, { checkpoint }), /No additional supported detail/);
  assert.deepEqual(checkpoint.values['story-1-narration'], prior);
});

test('length corrections use at most six local attempts before the separate source critic', async () => {
  const responses = [
    { voiceover: 'An unfinished phrase' }, { voiceover: 'The league announced a review.' },
    { replacement: 'The league announced a review.' }, { replacement: 'The review covers replay procedures.' },
    { replacement: 'The review covers replay procedures.' }, { replacement: 'No rule changes have been adopted.' },
  ];
  let physicalRequests = 0;
  const twice: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null) => {
    const focused = syntheticPassingFactualResponse(prompt);
    if (focused !== undefined) { physicalRequests++; assert.equal(validate(focused as T), null); return focused as T; }
    if (prompt.startsWith('SOURCE SUPPORT REVIEW')) { physicalRequests++; return supportedReview(prompt) as T; }
    for (let attempt = 0; attempt < 2; attempt++) {
      physicalRequests++;
      const value = responses.shift() as T;
      const problem = validate(value);
      if (!problem) return value;
      if (attempt === 1) throw new Error(problem);
    }
    throw new Error('unreachable');
  };
  const result = await draftNarration('Write this story.', testFacts, exactTarget(16, 18), twice);
  assert.equal(physicalRequests, 10, 'six draft/edit attempts plus three focused and one general critic request');
  assert.equal(measuredWords(result.voiceover), 16);
});

test('the caller factual gate can reject text even when its measured length passes', async () => {
  const unsupported = 'The league aims to increase transparency and accountability.';
  const gate = (text: string) => text.includes('aims') ? 'The supplied claims do not establish that intent.' : null;
  const noCalls: DraftCall = async () => { throw new Error('unexpected writer call'); };
  await assert.rejects(repairTextLength(unsupported, testFacts, exactTarget(8, 10), noCalls, gate), /do not establish that intent/);
});

test('same-length edits to cached narration invalidate its source-reviewed content identity', async () => {
  const checkpoint: DraftCheckpoint = { values: {} }, topic = draftTopic();
  await stagedRoundupScript(topic, { min: 100, max: 160 }, draftWriter([]), { checkpoint });
  const cached = checkpoint.values['story-1-narration']!.value as { voiceover: string };
  cached.voiceover = cached.voiceover.replace('word0', 'Unsupported');
  const seen: string[] = [];
  let reviews = 0;
  const good = draftWriter(seen);
  const checked: DraftCall = (prompt, validate) => { if (prompt.startsWith('SOURCE SUPPORT REVIEW')) reviews++; return good(prompt, validate); };
  const repaired = await stagedRoundupScript(topic, { min: 100, max: 160 }, checked, { checkpoint });
  assert.ok(seen.includes('NARRATION:1'));
  assert.equal(reviews, 1);
  assert.ok(!repaired.body[0]!.voiceover.includes('Unsupported'));
});


test('staged narration refuses unpinned summaries before a writer call or checkpoint reuse', async () => {
  const checkpoint: DraftCheckpoint = { values: {} }, accepted = draftTopic();
  await stagedRoundupScript(accepted, { min: 100, max: 160 }, draftWriter([]), { checkpoint });
  const saved = structuredClone(checkpoint);
  for (const claims of [undefined, [], [''], ['Too short'], ['Valid supported statement.', null], Array(25).fill('A concrete source statement.')] as unknown[]) {
    const topic = draftTopic();
    topic.stories![0]!.verifiedClaims = claims as string[];
    let calls = 0;
    const fail: DraftCall = async () => { calls++; throw new Error('Writer must not run without pinned claims'); };
    await assert.rejects(stagedRoundupScript(topic, { min: 100, max: 160 }, fail, { checkpoint }), /Story 1 has no valid verified source claims.*saved summary is not source evidence/);
    assert.equal(calls, 0);
    assert.deepEqual(checkpoint, saved);
  }
});


test('typed narration sends measured edits to the writer and returns repaired text to the critic with a new candidate identity', async () => {
  const { draftNarration } = await import('./script.js');
  const claims = ['The club published fixtures.', 'The fixtures remain provisional until the club confirms each venue.', 'The club listed fixtures.'];
  const task = preparedModelTask({ role: 'script', capability: 'script-draft', taskId: 'story-3-narration', topicIds: ['topic-3'], protocol: { version: 1 }, evidence: { claims } });
  const sourceContext = createSourceSupportContext('2026-09-09', 'https://league.example/fixtures', [{ url: 'https://league.example/fixtures', publishedAt: '2026-09-08' }]);
  const tasks: PreparedModelTask[] = []; let reviews = 0;
  const result = await draftNarration('Source-backed narration fixture.', { claims, sourceContext }, { min: 14, max: 20, acceptedMin: 14, acceptedMax: 20 },
    async <T>(_prompt: string, validate: (value: T) => string | null, current?: PreparedModelTask) => {
      const focused = syntheticPassingFactualResponse(_prompt);
      if (focused !== undefined) { assert.equal(validate(focused as T), null); return focused as T; }
      assert.ok(_prompt.includes(NEWSLETTER_SOURCE_CONTEXT_RULES));
      assert.deepEqual(JSON.parse(_prompt.match(/^SOURCE_CONTEXT: (.*)$/m)![1]!), sourceContext);
      assertPreparedModelTask(current); tasks.push(current);
      assert.deepEqual(current.topicIds, ['topic-3']);
      let value: unknown;
      switch (current.capability) {
        case 'script-draft': value = { voiceover: 'The club completed fixtures.' }; break;
        case 'script-edit': value = { replacement: claims[1] }; break;
        case 'source-repair': value = { edits: [{ id: 1, replacement: claims[2] }] }; break;
        case 'source-review': value = { sentences: [{ id: 1, supported: ++reviews > 1, claimIds: [reviews === 1 ? 1 : 3], reason: 'Publishing fixtures does not establish that the games were completed.' }, { id: 2, supported: true, claimIds: [2], reason: 'The provisional condition is explicitly stated.' }] }; break;
        default: throw new Error(`Unexpected explicit task ${current.capability}`);
      }
      assert.equal(validate(value as T), null); return value as T;
    }, task);
  assert.equal(result.voiceover, `${claims[2]} ${claims[1]}`);
  assert.deepEqual(tasks.map(row => row.capability), ['script-draft', 'script-edit', 'source-review', 'source-repair', 'source-review']);
  assert.equal(tasks[2]!.evidenceHash, tasks[4]!.evidenceHash);
  assert.notEqual(tasks[2]!.candidateHash, tasks[4]!.candidateHash);
});


test('staged script preserves separate source and edition dates through each topic and invalidates changed-date caches', async () => {
  const topic = draftTopic(); topic.id = '20260909-source-context';
  for (const [i, story] of topic.stories!.entries()) story.claimEvidence = [{ url: story.primaryUrl, role: 'primary', status: 200, sha256: 'a'.repeat(64), observedAt: '2026-09-14T12:00:00Z', publishedAt: i === 0 ? '2026-09-08' : null }];
  const checkpoint: DraftCheckpoint = { values: {} }, prompts: string[] = [];
  const good = draftWriter([]);
  const checked: DraftCall = (prompt, validate, task) => { prompts.push(prompt); return good(prompt, validate, task); };
  await stagedRoundupScript(topic, { min: 100, max: 160 }, checked, { checkpoint });
  assert.equal(prompts.length, 17, 'six writing tasks plus six focused, two general narration, two card and one derivative-copy reviews');
  for (const prompt of prompts) {
    if (prompt.startsWith('DRAFT ASSERTIONS')) {
      assert.ok(!prompt.includes('SOURCE_CONTEXT:') && !prompt.includes('PINNED_CLAIMS:'), 'draft meaning must be read without source evidence');
      continue;
    }
    if (!prompt.startsWith('FACTUAL ')) assert.ok(prompt.includes(NEWSLETTER_SOURCE_CONTEXT_RULES));
    if (prompt.includes('STAGED ROUNDUP: FRAMING')) {
      const facts = JSON.parse(prompt.match(/^FACTS: (.*)$/m)![1]!);
      assert.deepEqual(facts.map((row: any) => row.sourceContext.editionDay), ['2026-09-09', '2026-09-09']);
      assert.deepEqual(facts.map((row: any) => row.sourceContext.sources[0].publishedAt), ['2026-09-08', null]);
    } else if (prompt.includes('STAGED ROUNDUP: PUBLISH') || prompt.includes('SOURCE_CONTEXTS:')) {
      assert.equal(JSON.parse(prompt.match(/^SOURCE_CONTEXTS: (.*)$/m)![1]!).length, 2);
    } else {
      const context = JSON.parse(prompt.match(/^SOURCE_CONTEXT: (.*)$/m)![1]!);
      assert.equal(context.editionDay, '2026-09-09');
      const i = context.primaryUrl.endsWith('/0') ? 0 : 1;
      assert.equal(context.sources[0].publishedAt, i === 0 ? '2026-09-08' : null);
      assert.ok(!prompt.includes(topic.stories![1 - i]!.primaryUrl), 'one-topic call cannot inherit a sibling source');
      if (prompt.startsWith('SOURCE SUPPORT REVIEW')) {
        const claims = JSON.parse(prompt.match(/^PINNED_CLAIMS: (.*)$/m)![1]!);
        assert.deepEqual(claims, [{ id: 1, text: topic.stories![i]!.verifiedClaims![0] }]);
      }
    }
    assert.ok(!prompt.includes('2026-09-14'), 'capture time is not publication time');
  }
  prompts.length = 0;
  await stagedRoundupScript(topic, { min: 100, max: 160 }, checked, { checkpoint });
  assert.equal(prompts.length, 0);
  await stagedRoundupScript(topic, { min: 100, max: 160 }, checked, { checkpoint, day: '2026-09-10' });
  assert.equal(prompts.length, 17, 'a changed requested day invalidates all source-context-dependent tasks');
});

test('invalid script source dates fail before any model call or saved-checkpoint mutation', async () => {
  const topic = draftTopic(), checkpoint: DraftCheckpoint = { values: {} }; let calls = 0;
  const never: DraftCall = async () => { calls++; throw new Error('unexpected model call'); };
  await assert.rejects(stagedRoundupScript(topic, { min: 100, max: 160 }, never, { day: '2026-02-30', checkpoint }), /valid ISO date/);
  topic.stories![1]!.claimEvidence = [{ url: topic.stories![1]!.primaryUrl, role: 'primary', status: 200, sha256: 'b'.repeat(64), observedAt: '2026-09-14T12:00:00Z', publishedAt: '2026-02-30' }];
  await assert.rejects(stagedRoundupScript(topic, { min: 100, max: 160 }, never, { day: '2026-09-09', checkpoint }), /publication date/);
  assert.equal(calls, 0); assert.deepEqual(checkpoint, { values: {} });
});

test('dated narration preserves a copied source-relative-date rejection for adjudication before any repair', async () => {
  const claims = ['Today the company introduced its mapping model.'];
  const sourceContext = createSourceSupportContext('2026-09-09', 'https://company.example/news', [{ url: 'https://company.example/news', publishedAt: '2026-09-08' }]);
  let reviews = 0; const roles: string[] = [];
  const call: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    const focused = syntheticPassingFactualResponse(prompt);
    if (focused !== undefined) { assert.equal(validate(focused as T), null); return focused as T; }
    roles.push(task!.capability);
    assert.deepEqual(JSON.parse(prompt.match(/^SOURCE_CONTEXT: (.*)$/m)![1]!), sourceContext);
    assert.ok(prompt.includes('Unknown or relocated dates need neutral wording'));
    let value: unknown;
    if (task!.capability === 'script-draft') value = { voiceover: claims[0] };
    else value = { sentences: [{ id: 1, supported: ++reviews > 1, claimIds: [1], reason: reviews === 1 ? 'Today moves the source announcement onto the edition day.' : 'Neutral wording preserves the announcement without a new date.' }] };
    assert.equal(validate(value as T), null); return value as T;
  };
  await assert.rejects(draftNarration('Write the announcement.', { claims, sourceContext }, exactTarget(7, 12), call), error => {
    assert.ok(error instanceof SourceReviewDisputeError);
    assert.equal(error.dispute.candidate.text, claims[0]);
    assert.deepEqual(error.dispute.sourceContext, sourceContext);
    assert.match(error.dispute.findings[0]!.reason, /moves the source announcement onto the edition day/);
    return true;
  });
  assert.deepEqual(roles, ['script-draft', 'source-review']); assert.equal(reviews, 1);
  // This checks preserved context and the hold, not a model's temporal qualification.
});
