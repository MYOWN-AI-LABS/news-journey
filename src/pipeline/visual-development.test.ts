import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { solidPng } from './test-png.js';
import test from 'node:test';
import type { StoryDiagram, Topic, TopicStory } from '../types.js';
import { FIELD_SUPPORT_VERSION, type FieldSupportCall } from './field-support.js';
import { SOURCE_SUPPORT_VERSION } from './source-support.js';
import { jsonOutputContract } from '../llm/json-output-contract.js';
import { codexNativeSchema } from '../llm/codex.js';
import { ensureSourceVisualDevelopment, readSourceVisualConcept, SOURCE_VISUAL_DEVELOPMENT_VERSION } from './visual-development.js';
import { ensureVisualPlans, visualCueOptions, sourceAccountAdaptationProblem } from './visual-director.js';
import { preparedScriptReceipt } from './writing-context.js';
import { ensureEditionDiagrams, persistedVisualReleaseProblem } from './story-diagram.js';
import { applyVisualChoices, applyVisualChoicesWithAlignment, ensureVisualCandidates, lockVisualChoices, readVisualChoices, storeOwnImage, VisualAlignmentRequired, VisualChoiceRequired } from './visual-choice.js';

const day = '2026-09-09', writerKey = 'same-parent-writer-and-critic';
const claims = ['The guide asks the controller to read the sensor.', 'The guide specifies a response to the sensor.'];
const draft = { kind: 'diagram', intent: 'Documented instructions', reason: `Source excerpt: “${claims.join(' ')}”`, labels: ['Sensor input', 'Requested response'], caveat: 'Documented instructions' };
const story = (n: number): TopicStory => ({ n, headline: 'A controller guide', summary: '', weight: 'standard', primaryUrl: `https://example.com/guide-${n}`,
  repo: null, assetRef: `og-${n - 1}`, suggestedScene: 'news_card', principalEntity: 'Example', area: 'technology', verticals: [], verifiedClaims: [...claims],
  claimEvidence: [{ url: `https://example.com/guide-${n}`, role: 'primary', status: 200, sha256: 'a'.repeat(64), textSha256: 'b'.repeat(64), observedAt: '2026-09-14T00:00:00Z', publishedAt: '2026-09-08',
    restrictions: [{ sourceSentenceId: 9, text: 'These are documented instructions; this guide reports no execution measurements.' }] }] });
const topic = (count = 1): Topic => ({ id: '20260909-guides', kind: count > 1 ? 'roundup' : 'news', headline: 'Guides', angle: '', sourceItems: [], primaryUrl: story(1).primaryUrl, repo: null, alternates: [], stories: Array.from({ length: count }, (_, i) => story(i + 1)) });
function selection(value = draft, reasonClaimIds = [1, 2]) {
  const { reason: _reason, ...rest } = value;
  return { ...rest, reasonClaimIds };
}
function review(prompt: string, unsupported = false) {
  return { fields: JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!).map((field: { id: string }) => ({ id: field.id, supported: !unsupported || field.id !== 'intent', claimIds: [1, 2], reason: unsupported && field.id === 'intent' ? 'The source documents instructions, not completed execution.' : 'Fictional full-field review fixture.' })) };
}
function validCall(prompts: string[] = []): FieldSupportCall {
  return async (prompt, validate, task) => {
    prompts.push(prompt);
    assert.ok(task?.evidenceHash); assert.ok(task?.protocolHash);
    const value = prompt.startsWith('SOURCE VISUAL CONCEPT') ? selection() : review(prompt);
    assert.equal(validate(value as never), null);
    return value as never;
  };
}
function temporary(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'source-visual-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('source concept caller carries the exact bounded response contract and retains full field review', () => temporary(async dir => {
  let calls = 0;
  const result = await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: async (prompt, validate, task) => {
    calls++;
    if (prompt.startsWith('SOURCE VISUAL CONCEPT')) {
      const contract = jsonOutputContract(validate);
      assert.ok(contract);
      assert.equal(contract.strict, true, 'nullable mechanism makes the entire wire schema eligible for native strict decoding');
      assert.ok(contract.schema.required!.includes('mechanism'));
      assert.equal(Object.hasOwn(draft, 'mechanism'), false);
      assert.deepEqual(contract.schema, {
        type: 'object', additionalProperties: false,
        required: ['kind', 'intent', 'reasonClaimIds', 'labels', 'caveat', 'mechanism'],
        properties: {
          kind: { type: 'string', enum: ['diagram', 'three'] },
          intent: { type: 'string', minLength: 1, maxLength: 100 },
          reasonClaimIds: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer', enum: [1, 2] } },
          labels: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 22 } },
          caveat: { type: 'string', maxLength: 44 },
          mechanism: { type: ['string', 'null'], enum: ['assembly', 'data-flow', 'compression', 'robot-control', null] },
        },
      });
      assert.ok(Object.isFrozen(contract.schema));
      assert.equal(codexNativeSchema(contract), contract.schema, 'native strict decoding receives the exact bounds');
      for (const claim of claims) assert.ok(prompt.includes(claim), 'schema must not replace source evidence');
      assert.match(prompt, /These are documented instructions; this guide reports no execution measurements/);
      assert.doesNotMatch(JSON.stringify(contract.schema), /controller|sensor|execution measurements/);
    }
    if (prompt.startsWith('SOURCE VISUAL CONCEPT')) return { ...selection(), mechanism: null } as never;
    return validCall()(prompt, validate, task);
  } });
  assert.equal(Object.hasOwn(result.concepts[0]!, 'mechanism'), false);
  assert.equal(calls, 2, 'schema adds no drafting, validation or repair task');
  assert.equal(result.status, 'ready'); assert.equal(result.concepts[0]!.review.fields.length, 6);
}));

test('source concept response schema preserves mechanism, plaintext and exact ID validation', () => temporary(async dir => {
  const result = await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: async (prompt, validate, task) => {
    if (prompt.startsWith('SOURCE VISUAL CONCEPT')) {
      assert.match(validate({ ...selection(), mechanism: 'data-flow' } as never)!, /Only three-dimensional/);
      assert.match(validate({ ...selection(), kind: 'three' } as never)!, /supported spatial mechanism/);
      assert.match(validate({ ...selection(), kind: 'three', mechanism: 'assembly' } as never)!, /Assembly requires four/);
      assert.equal(validate({ ...selection(), kind: 'three', mechanism: 'assembly', labels: ['Board', 'Memory', 'Compute chip', 'Cooling'] } as never), null);
      assert.match(validate({ ...selection(), intent: ' ' } as never)!, /non-whitespace/);
      assert.match(validate({ ...selection(), caveat: '<Invented>' } as never)!, /plain text/);
      assert.match(validate({ ...selection(), reason: 'A paraphrase' } as never)!, /no free-form reason/);
      for (const ids of [[], [0], [3], [1, 1], [2, 1], [1.5], ['1']]) assert.match(validate({ ...selection(), reasonClaimIds: ids } as never)!, /real claim IDs/);
      assert.equal(validate(selection() as never), null);
      assert.equal(validate({ ...selection(), mechanism: null } as never), null);
      assert.match(validate({ ...selection(), kind: 'three', mechanism: null } as never)!, /supported spatial mechanism/);
    }
    return validCall()(prompt, validate, task);
  } });
  assert.equal(result.status, 'ready'); assert.deepEqual(result.concepts[0]!.reasonClaimIds, [1, 2]);
  assert.equal(result.concepts[0]!.reason, draft.reason);
}));

test('decoder contract protocol invalidates legacy visual concepts without altering their source evidence', () => temporary(async dir => {
  assert.equal(SOURCE_VISUAL_DEVELOPMENT_VERSION, 3);
  const selected = topic();
  await ensureSourceVisualDevelopment(dir, selected, { day, writerKey, call: validCall() });
  const path = join(dir, 'visual-development.json');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.inputHash = createHash('sha256').update(JSON.stringify({ protocol: { visualDevelopment: 2, fieldSupport: FIELD_SUPPORT_VERSION, sourceSupport: SOURCE_SUPPORT_VERSION }, day, writerKey, topic: selected })).digest('hex');
  for (const concept of saved.concepts) {
    concept.inputHash = saved.inputHash;
    const { contentHash: _old, ...receipt } = concept;
    concept.contentHash = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  }
  writeFileSync(path, JSON.stringify(saved));
  assert.throws(() => readSourceVisualConcept(dir, selected, 0, { day, writerKey }), /different source evidence or writer settings/);
  const retainedBytes = readFileSync(path);
  assert.equal(readSourceVisualConcept(dir, selected, 0, { day, writerKey, retainedDecoderVersion: 2 })!.contentHash, saved.concepts[0].contentHash);
  assert.ok(readFileSync(path).equals(retainedBytes), 'explicit media recovery validates the original receipt without migrating it');
  assert.throws(() => readSourceVisualConcept(dir, selected, 0, { day, writerKey: 'different writer', retainedDecoderVersion: 2 }), /different source evidence or writer settings/);
  const prompts: string[] = [];
  const current = await ensureSourceVisualDevelopment(dir, selected, { day, writerKey, call: validCall(prompts) });
  assert.equal(current.status, 'ready'); assert.equal(prompts.length, 2);
  assert.equal(current.concepts[0]!.sourceHash, saved.concepts[0].sourceHash);
}));

test('whole-claim length feedback is precise without echoing or shortening any source text', () => temporary(async dir => {
  const t = topic(), retained = 'A bounded captured claim.';
  t.stories![0]!.verifiedClaims = ['PRIVATE_UNTRUSTED_SOURCE '.padEnd(690, 'x'), 'PRIVATE_UNTRUSTED_SOURCE '.padEnd(529, 'y'), retained];
  const before = JSON.stringify(t), errors: string[] = [];
  const result = await ensureSourceVisualDevelopment(dir, t, { day, writerKey, call: async (prompt, validate) => {
    if (prompt.startsWith('SOURCE VISUAL CONCEPT')) {
      for (const [id, length] of [[1, 708], [2, 547]]) {
        const candidate = selection(draft, [id!]), error = validate(candidate as never)!;
        errors.push(error); assert.match(error, new RegExp(`reason from whole selected claims has ${length} UTF-16 code units; maximum 500`));
        assert.doesNotMatch(error, /intent|caveat|labels|PRIVATE_UNTRUSTED_SOURCE|xxxx|yyyy/);
      }
    }
    const value = prompt.startsWith('SOURCE VISUAL CONCEPT') ? selection(draft, [3]) : review(prompt);
    assert.equal(validate(value as never), null); return value as never;
  } });
  assert.equal(errors.length, 2); assert.equal(JSON.stringify(t), before);
  assert.equal(result.status, 'ready'); assert.equal(result.concepts[0]!.reason, `Source excerpt: “${retained}”`);
  assert.equal(result.concepts[0]!.review.fields.length, 6);
}));

test('unaccepted concept shape remains bounded while display overflow is retained for targeted repair', () => temporary(async dir => {
  const result = await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: async (prompt, validate, task) => {
    if (prompt.startsWith('SOURCE VISUAL CONCEPT')) {
      const cases: [unknown, RegExp][] = [
        [{ ...selection(), intent: 5 }, /intent must be a string/],
        [{ ...selection(), intent: '  ' }, /intent must contain non-whitespace text/],
        [{ ...selection(), caveat: '<PRIVATE>' }, /caveat must contain plain text/],
        [{ ...selection(), intent: 'https://private.invalid' }, /intent must contain plain text/],
        [{ ...selection(), labels: 'private' }, /labels must be an array containing 2–4 strings/],
        [{ ...selection(), labels: Array(50).fill('PRIVATE') }, /labels contains 50 items; minimum 2, maximum 4/],
        [{ ...selection(), labels: ['Valid', 'PRIVATE'.padEnd(89, 'x')] }, /labels\[1\] has 89 UTF-16 code units; maximum 88/],
        [{ ...selection(), labels: ['Valid', null] }, /labels\[1\] must be a string/],
      ];
      for (const [candidate, expected] of cases) {
        const error = validate(candidate as never)!; assert.match(error, expected); assert.doesNotMatch(error, /PRIVATE|private|https:\/\//);
      }
      assert.equal(validate({ ...selection(), intent: 'a'.repeat(101), caveat: 'b'.repeat(45), labels: ['c'.repeat(23), 'Valid'] } as never), null,
        'bounded draft overflow is retained, not accepted for rendering');
      const together = validate({ ...selection(), intent: 'a'.repeat(401), caveat: 'b'.repeat(177), labels: ['c'.repeat(89), 'Valid'] } as never)!;
      for (const message of ['intent has 401', 'caveat has 177', 'labels[0] has 89']) assert.ok(together.includes(message));
    }
    return validCall()(prompt, validate, task);
  } });
  assert.equal(result.status, 'ready');
}));

test('exact500 reason limit includes the fixed attribution wrapper and retains UTF-16 semantics', () => temporary(async dir => {
  const t = topic(); t.stories![0]!.verifiedClaims = ['b'.repeat(482)];
  const candidate = { ...selection(draft, [1]), intent: 'a'.repeat(100), caveat: 'c'.repeat(44), labels: ['d'.repeat(22), 'e'.repeat(22)] };
  let calls = 0;
  const result = await ensureSourceVisualDevelopment(dir, t, { day, writerKey, call: async (prompt, validate) => {
    calls++;
    if (prompt.startsWith('SOURCE VISUAL CONCEPT')) {
      assert.equal(validate({ ...candidate, intent: '😀'.repeat(50) } as never), null);
      assert.equal(validate({ ...candidate, intent: '😀'.repeat(51) } as never), null, 'draft can reach formatter');
      assert.match(validate({ ...candidate, intent: '😀'.repeat(201) } as never)!, /intent has 402 UTF-16 code units; maximum 400/);
      assert.equal(validate({ ...candidate, caveat: '' } as never), null);
    }
    const value = prompt.startsWith('SOURCE VISUAL CONCEPT') ? candidate : { fields: review(prompt).fields.map((row: object) => ({ ...row, claimIds: [1] })) };
    assert.equal(validate(value as never), null); return value as never;
  } });
  assert.equal(calls, 2); assert.equal(result.status, 'ready'); assert.equal(result.concepts[0]!.reason.length, 500);
  assert.equal(result.concepts[0]!.reason, `Source excerpt: “${t.stories![0]!.verifiedClaims![0]}”`);
}));

test('two rejected physical attempts cannot truncate overlong claims or start extra concept salvage', () => temporary(async dir => {
  const t = topic(); t.stories![0]!.verifiedClaims = ['x'.repeat(690), 'y'.repeat(529)];
  let logicalCalls = 0, physicalAttempts = 0;
  const result = await ensureSourceVisualDevelopment(dir, t, { day, writerKey, call: async (prompt, validate) => {
    logicalCalls++; assert.ok(prompt.startsWith('SOURCE VISUAL CONCEPT'));
    let error = '';
    for (const id of [1, 2]) { physicalAttempts++; error = validate(selection(draft, [id]) as never)!; assert.ok(error); }
    throw new Error(error);
  } });
  assert.equal(logicalCalls, 1); assert.equal(physicalAttempts, 2); assert.equal(result.status, 'failed'); assert.deepEqual(result.concepts, []);
  assert.match(result.failures[0]!.error, /reason from whole selected claims has 547 UTF-16 code units; maximum 500/);
}));

test('oversized caveat is preserved then repaired in one bounded task before complete source QA', () => temporary(async dir => {
  const caveat = 'These are documented instructions; the source does not report execution measurements.';
  let calls = 0;
  const result = await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: async (prompt, validate, task) => {
    calls++; let value;
    if (prompt.startsWith('SOURCE VISUAL CONCEPT')) value = { ...selection(), caveat };
    else if (prompt.startsWith('SOURCE VISUAL FORMAT REPAIR')) {
      const pending = readdirSync(dir).find(file => file.startsWith('visual-format-candidate-'))!;
      assert.equal(JSON.parse(readFileSync(join(dir, pending), 'utf8')).candidate.caveat, caveat);
      assert.match(prompt, /no execution measurements/);
      assert.equal(task!.taskId, 'source-visual-format-topic-1');
      assert.match(validate({ replacements: { field_1: { id: 'intent', text: 'Alter another field' } } } as never)!, /only the oversized/);
      assert.match(validate({ replacements: { field_1: { id: 'caveat', text: '' } } } as never)!, /non-whitespace/);
      assert.match(validate({ replacements: { field_1: { id: 'caveat', text: 'x'.repeat(45) } } } as never)!, /maximum 44/);
      value = { replacements: { field_1: { id: 'caveat', text: 'Instructions; no execution measurements' } } };
    } else {
      assert.match(prompt, /Instructions; no execution measurements/);
      assert.match(prompt, /These are documented instructions; this guide reports no execution measurements/);
      value = review(prompt);
    }
    assert.equal(validate(value as never), null); return value as never;
  } });
  assert.equal(calls, 3); assert.equal(result.status, 'ready');
  const accepted = readSourceVisualConcept(dir, topic(), 0, { day, writerKey })!;
  assert.equal(accepted.intent, draft.intent); assert.equal(accepted.reason, draft.reason);
  assert.deepEqual(accepted.labels, draft.labels); assert.ok(accepted.caveat.length <= 44);
}));

test('formatting cannot bypass source QA or expand the original four-task allowance', () => temporary(async dir => {
  let calls = 0;
  const result = await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: async (prompt, validate) => {
    calls++; let value;
    if (prompt.startsWith('SOURCE VISUAL CONCEPT')) value = { ...selection(), caveat: 'Instructions only; execution measurements are not reported in the supplied guide.' };
    else if (prompt.startsWith('SOURCE VISUAL FORMAT REPAIR')) value = { replacements: { field_1: { id: 'caveat', text: 'Proven execution' } } };
    else if (prompt.startsWith('AUTHORED FIELD SOURCE REPAIR')) value = { edits: { field_1: { id: 'caveat', text: 'Instructions; no execution measurements' } } };
    else value = { fields: review(prompt).fields.map((row: { id: string }) => row.id === 'caveat'
      ? { ...row, supported: false, claimIds: [], reason: 'The caveat claims proven execution; the source reports no execution measurements.' } : row) };
    assert.equal(validate(value as never), null); return value as never;
  } });
  assert.equal(calls, 4); assert.equal(result.status, 'failed'); assert.deepEqual(result.concepts, []);
  assert.match(result.failures[0]!.error, /four-task allowance/);
}));

test('each oversized replacement retains its own decoder bound and exact field slot before source QA', () => temporary(async dir => {
  const calls: string[] = [];
  const result = await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: async (prompt, validate, task) => {
    calls.push(task!.taskId);
    for (const claim of claims) assert.ok(prompt.includes(claim));
    assert.match(prompt, /this guide reports no execution measurements/);
    let value;
    if (prompt.startsWith('SOURCE VISUAL CONCEPT')) value = { ...selection(), labels: ['The requested sensor input', draft.labels[1]], caveat: 'Instructions only; execution measurements are not reported in the supplied guide.' };
    else if (prompt.startsWith('SOURCE VISUAL FORMAT REPAIR')) {
      const contract = jsonOutputContract(validate)!;
      const slots = contract.schema.properties!.replacements!.properties!;
      assert.equal(slots.field_1!.properties!.text!.maxLength, 22);
      assert.equal(slots.field_2!.properties!.text!.maxLength, 44);
      assert.deepEqual(slots.field_1!.properties!.id!.enum, ['label.1']);
      assert.equal(codexNativeSchema(contract), contract.schema);
      value = { replacements: { field_1: { id: 'label.1', text: 'Documented sensor rule' }, field_2: { id: 'caveat', text: 'Instructions; no execution measurements' } } };
      assert.equal(value.replacements.field_1.text.length, 22);
      assert.match(validate({ replacements: { ...value.replacements, field_1: { id: 'label.1', text: 'x'.repeat(23) } } } as never)!, /maximum 22/);
      assert.match(validate({ replacements: { field_1: value.replacements.field_1 } } as never)!, /exactly the requested/);
      assert.match(validate({ replacements: { field_1: value.replacements.field_2, field_2: value.replacements.field_1 } } as never)!, /supplied slots/);
    } else value = review(prompt);
    assert.equal(validate(value as never), null); return value as never;
  } });
  assert.equal(result.status, 'ready'); assert.equal(calls.length, 3);
  assert.match(calls[2]!, /initial-review$/, 'formatting still requires complete source review');
}));

test('source repair schema enforces label22 and caveat44, then reviews every exact replacement against complete evidence', () => temporary(async dir => {
  let calls = 0;
  const result = await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: async (prompt, validate) => {
    calls++;
    for (const claim of claims) assert.ok(prompt.includes(claim));
    assert.match(prompt, /this guide reports no execution measurements/);
    let value;
    if (prompt.startsWith('SOURCE VISUAL CONCEPT')) value = { ...selection(), labels: ['Proven execution', draft.labels[1]], caveat: 'Field deployment proven' };
    else if (prompt.startsWith('AUTHORED FIELD SOURCE REPAIR')) {
      const contract = jsonOutputContract(validate)!;
      const slots = contract.schema.properties!.edits!.properties!;
      assert.equal(slots.field_1!.properties!.text!.maxLength, 22);
      assert.equal(slots.field_2!.properties!.text!.maxLength, 44);
      assert.deepEqual(slots.field_1!.properties!.id!.enum, ['label.1']);
      assert.deepEqual(slots.field_2!.properties!.id!.enum, ['caveat']);
      assert.equal(codexNativeSchema(contract), contract.schema);
      value = { edits: { field_1: { id: 'label.1', text: 'Documented sensor rule' }, field_2: { id: 'caveat', text: 'Instructions; no execution measurements' } } };
      assert.match(validate({ edits: { ...value.edits, field_1: { id: 'label.1', text: 'x'.repeat(23) } } } as never)!, /maximum 22/);
      assert.match(validate({ edits: { field_1: value.edits.field_1 } } as never)!, /exactly the supplied/);
      assert.match(validate({ edits: { ...value.edits, field_3: value.edits.field_1 } } as never)!, /exactly the supplied/);
      assert.match(validate({ edits: { field_1: value.edits.field_2, field_2: value.edits.field_1 } } as never)!, /exact flagged field ID/);
      assert.match(validate({ edits: [value.edits.field_1, value.edits.field_1] } as never)!, /repeated or unknown/);
      assert.match(validate({ edits: { ...value.edits, field_1: { id: 'reason', text: 'A rewritten source' } } } as never)!, /exact flagged field ID/);
    } else {
      value = review(prompt);
      if (calls === 2) value.fields = value.fields.map((row: { id: string }) => ['label.1', 'caveat'].includes(row.id)
        ? { ...row, supported: false, claimIds: [], reason: 'Instructions do not establish observed execution or field deployment.' } : row);
      else {
        assert.equal(calls, 4, 'a valid repair has no authority without the full final critic');
        assert.match(prompt, /Documented sensor rule/); assert.match(prompt, /Instructions; no execution measurements/);
      }
    }
    assert.equal(validate(value as never), null); return value as never;
  } });
  assert.equal(calls, 4); assert.equal(result.status, 'ready');
  assert.equal(result.concepts[0]!.labels[0]!.length, 22);
  assert.equal(result.concepts[0]!.reason, draft.reason);
  const audits = readdirSync(join(dir, 'visual-field-reviews')).map(name => JSON.parse(readFileSync(join(dir, 'visual-field-reviews', name), 'utf8')).audit);
  assert.equal(audits.length, 2);
  assert.ok(audits.find(audit => audit.pass === 'initial-review').review.fields.some((row: { supported: boolean }) => !row.supported));
  assert.ok(audits.find(audit => audit.pass === 'final-review').review.fields.every((row: { supported: boolean }) => row.supported));
}));

test('complete real drone result retains curriculum, enforced control and comparison qualifiers without paraphrase', () => temporary(async dir => {
  // Exact archived source claims from the failed V23 concept. The verdict below is a
  // routing fixture; preserving bytes does not qualify the model's semantic review.
  const simulation = 'To address these challenges, we introduce an Information-Guided Safe Reinforcement Learning framework evaluated within a custom, GPU-accelerated 3D simulation environment coupling an Eulerian wind solver with a Lagrangian puff dispersion model.';
  const resultClaim = 'Trained via a progressive curriculum and safeguarded by a strictly enforced Robust Control Barrier Function (RCBF), our RL framework achieves nearly 80% localization success on complex, mobile sources - drastically outperforming classical baselines (~30%) - while ensuring zero safety violations.';
  const t = topic(); t.stories![0]!.verifiedClaims = [simulation, resultClaim];
  t.stories![0]!.claimEvidence![0]!.restrictions = [{ sourceSentenceId: 3, text: simulation }];
  const before = JSON.stringify(t), prompts: string[] = [];
  const result = await ensureSourceVisualDevelopment(dir, t, { day, writerKey, call: async (prompt, validate) => {
    prompts.push(prompt);
    const value = prompt.startsWith('SOURCE VISUAL CONCEPT') ? { ...selection(draft, [2]), intent: 'Compare simulated localization results', caveat: 'GPU-accelerated 3D simulation' } : review(prompt);
    if (prompt.startsWith('SOURCE VISUAL CONCEPT')) assert.match(validate(selection(draft, [1, 2]) as never)!, /has 559 UTF-16 code units; maximum 500/);
    else {
      const presented = JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!);
      assert.equal(presented.find((row: {id: string}) => row.id === 'reason').text, `Source excerpt: “${resultClaim}”`);
      assert.ok(prompt.includes(simulation), 'the separate full simulation scope must remain in source QA');
    }
    assert.equal(validate(value as never), null); return value as never;
  } });
  assert.equal(result.status, 'ready'); assert.equal(prompts.length, 2); assert.equal(JSON.stringify(t), before);
  assert.deepEqual(result.concepts[0]!.reasonClaimIds, [2]);
  assert.equal(result.concepts[0]!.reason, `Source excerpt: “${resultClaim}”`);
  assert.equal(result.concepts[0]!.reason.length, 314);
}));

test('rehashed saved reason or selection cannot bypass exact reconstruction, including deleted or invalid IDs', () => temporary(async dir => {
  await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: validCall() });
  const path = join(dir, 'visual-development.json'), original = readFileSync(path, 'utf8');
  for (const mutate of [
    (c: any) => { c.reason = 'The guide demonstrates a successful controller.'; },
    (c: any) => { c.reasonClaimIds = [1]; },
    (c: any) => { c.reasonClaimIds = [2, 1]; },
    (c: any) => { c.reasonClaimIds = [1, 1]; },
    (c: any) => { delete c.reasonClaimIds; },
  ]) {
    const saved = JSON.parse(original); mutate(saved.concepts[0]);
    const { contentHash: _old, ...receipt } = saved.concepts[0];
    saved.concepts[0].contentHash = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
    writeFileSync(path, JSON.stringify(saved));
    assert.throws(() => readSourceVisualConcept(dir, topic(), 0, { day, writerKey }), /complete selected claims exactly|real claim IDs/);
  }
  writeFileSync(path, original);
  assert.equal(readSourceVisualConcept(dir, topic(), 0, { day, writerKey })!.reason, draft.reason);
}));

test('a source critic rejection cannot trigger a free-form repair of the locked quoted reason', () => temporary(async dir => {
  let calls = 0;
  const result = await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: async (prompt, validate) => {
    calls++;
    if (prompt.startsWith('SOURCE VISUAL CONCEPT')) return selection() as never;
    if (prompt.startsWith('AUTHORED FIELD SOURCE REVIEW')) {
      const value = review(prompt); value.fields.find((row: {id: string}) => row.id === 'reason').supported = false;
      assert.equal(validate(value as never), null); return value as never;
    }
    throw new Error('Immutable source excerpts must never be sent to a repair model');
  } });
  assert.equal(calls, 2); assert.equal(result.status, 'failed'); assert.deepEqual(result.concepts, []);
  assert.match(result.failures[0]!.error, /immutable fields reason/);
  const receipts = readdirSync(join(dir, 'visual-field-reviews'));
  assert.equal(receipts.length, 1);
  const path = join(dir, 'visual-field-reviews', receipts[0]!);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.audit.pass, 'initial-review');
  assert.equal(saved.audit.fields.find((row: { id: string }) => row.id === 'reason').text, draft.reason);
  assert.equal(saved.audit.review.fields.find((row: { id: string }) => row.id === 'reason').supported, false);
  assert.deepEqual(saved.audit.claims, claims);
  assert.match(JSON.stringify(saved.audit.sourceContext), /no execution measurements/);
  assert.equal(saved.auditHash, createHash('sha256').update(JSON.stringify(saved.audit)).digest('hex'));
  assert.match(saved.inputHash, /^[a-f0-9]{64}$/); assert.match(saved.sourceHash, /^[a-f0-9]{64}$/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'visual-field-reviews')).mode & 0o777, 0o700);
  }
}));

test('source concepts develop without any script and retain full source dates and restrictions in independent QA', () => temporary(async dir => {
  const prompts: string[] = [];
  const result = await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: validCall(prompts) });
  assert.equal(result.status, 'ready'); assert.equal(prompts.length, 2);
  assert.equal(result.concepts[0]!.status, 'source-reviewed'); assert.equal(result.concepts[0]!.narrationAlignment, 'pending');
  for (const prompt of prompts) {
    assert.match(prompt, /this guide reports no execution measurements/);
    assert.match(prompt, /2026-09-08/); assert.match(prompt, /2026-09-09/);
    assert.doesNotMatch(prompt, /2026-09-14T00:00:00Z/);
  }
  const loaded = readSourceVisualConcept(dir, topic(), 0, { day, writerKey });
  assert.deepEqual(loaded, result.concepts[0]);
  for (const key of ['narration', 'cues', 'timing', 'svg', 'media', 'decision']) assert.equal(Object.hasOwn(loaded!, key), false);
  await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: async () => { throw new Error('cache must make zero calls'); } });
}));

test('a failed topic cannot prevent sibling development or erase their accepted bytes on resume', () => temporary(async dir => {
  let attempts = 0;
  const result = await ensureSourceVisualDevelopment(dir, topic(3), { day, writerKey, call: async (prompt, validate, task) => {
    if (task!.topicIds[0] === 'topic-2') { attempts++; throw new Error('Independent critic unavailable'); }
    return validCall()(prompt, validate, task);
  } });
  assert.equal(result.status, 'partial'); assert.equal(attempts, 1);
  assert.deepEqual(result.concepts.map(c => c.topicId), ['topic-1', 'topic-3']);
  assert.deepEqual(result.failures.map(c => c.topicId), ['topic-2']);
  const bytes = result.concepts.map(c => JSON.stringify(c));
  const resumedTasks: string[] = [];
  const resumed = await ensureSourceVisualDevelopment(dir, topic(3), { day, writerKey, call: async (prompt, validate, task) => {
    const persisted = JSON.parse(readFileSync(join(dir, 'visual-development.json'), 'utf8'));
    assert.deepEqual(persisted.concepts.map((c: {topicId:string}) => c.topicId), ['topic-1', 'topic-3'], 'a crash during this missing sibling must retain both already accepted siblings');
    resumedTasks.push(task!.topicIds[0]!); return validCall()(prompt, validate, task);
  } });
  assert.equal(resumed.status, 'ready'); assert.deepEqual(resumedTasks, ['topic-2', 'topic-2']);
  assert.equal(JSON.stringify(resumed.concepts[0]), bytes[0]); assert.equal(JSON.stringify(resumed.concepts[2]), bytes[1]);
}));

test('source/date/order/settings changes and changed review bytes cannot inherit a concept approval', () => temporary(async dir => {
  await ensureSourceVisualDevelopment(dir, topic(2), { day, writerKey, call: validCall() });
  for (const changed of [
    (() => { const t = topic(2); t.stories![0]!.verifiedClaims![0] += ' Changed.'; return t; })(),
    (() => { const t = topic(2); t.stories![0]!.claimEvidence![0]!.sha256 = 'c'.repeat(64); return t; })(),
    (() => { const t = topic(2); t.stories!.reverse(); return t; })(),
  ]) assert.throws(() => readSourceVisualConcept(dir, changed, 0, { day, writerKey }), /different source/);
  assert.throws(() => readSourceVisualConcept(dir, topic(2), 0, { day: '2026-09-10', writerKey }), /different source/);
  assert.throws(() => readSourceVisualConcept(dir, topic(2), 0, { day, writerKey: 'different critic' }), /different source/);
  const path = join(dir, 'visual-development.json'), saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.concepts[0].review.fields.pop();
  const { contentHash: _, ...body } = saved.concepts[0];
  saved.concepts[0].contentHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  writeFileSync(path, JSON.stringify(saved));
  assert.throws(() => readSourceVisualConcept(dir, topic(2), 0, { day, writerKey }), /complete accepted field/);
}));

test('unsupported concept gets one exact field repair and fresh whole review, never acceptance on shape', () => temporary(async dir => {
  const operations: string[] = [];
  const result = await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: async (prompt, validate, task) => {
    operations.push(task!.role);
    const value = prompt.startsWith('SOURCE VISUAL CONCEPT') ? { ...selection(), intent: 'The controller obeyed' }
      : prompt.startsWith('AUTHORED FIELD SOURCE REPAIR') ? { edits: { field_1: { id: 'intent', text: 'The controller complied' } } }
      : review(prompt, true);
    assert.equal(validate(value as never), null); return value as never;
  } });
  assert.deepEqual(operations, ['script', 'source-review', 'source-repair', 'source-review']);
  assert.equal(result.status, 'failed'); assert.deepEqual(result.concepts, []);
  assert.match(result.failures[0]!.error, /failed after one repair/);
}));

test('no fake narration, asset or unbound capture can start a concept review', () => temporary(async dir => {
  const missing = topic(); delete missing.stories![0]!.claimEvidence;
  const result = await ensureSourceVisualDevelopment(dir, missing, { day, writerKey, call: async () => { throw new Error('must not call'); } });
  assert.match(result.failures[0]!.error, /hash-bound primary/);
  let calls = 0;
  const bad = await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: async () => { calls++; return { ...selection(), narration: claims.join(' ') } as never; } });
  assert.equal(calls, 1); assert.equal(bad.status, 'failed'); assert.match(bad.failures[0]!.error, /no free-form reason, assets, narration/);
}));

test('full large source context fails before inference rather than clipping a restriction', () => temporary(async dir => {
  const t = topic(); t.stories![0]!.claimEvidence![0]!.restrictions = Array.from({ length: 5 }, (_, i) => ({ sourceSentenceId: i + 1, text: 'The complete condition applies. '.repeat(40) }));
  const result = await ensureSourceVisualDevelopment(dir, t, { day, writerKey, call: async () => { throw new Error('must not call'); } });
  assert.equal(result.status, 'failed'); assert.match(result.failures[0]!.error, /bounded metadata packet/);
}));

const narration = claims.join(' ');
const hashJson = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function accountBody(t: Topic) {
  return t.stories!.map(story => ({ scene: 'news_card' as const, assetRef: story.assetRef, voiceover: story.verifiedClaims!.join(' '), onScreen: { title: story.headline },
    sourceAccount: { version: 1 as const, claims: [...story.verifiedClaims!], sourceUrl: story.primaryUrl,
      packetHash: hashJson(story.verifiedClaims), evidenceHash: hashJson(story.claimEvidence) } }));
}
function saveAcceptedFixture(dir: string, t: Topic, segments: unknown[]) {
  // Synthetic acceptance only: the tests exercise exact downstream receipt consumption.
  const script = { body: segments }, receipt = preparedScriptReceipt(t, writerKey, script);
  writeFileSync(join(dir, 'script.json'), JSON.stringify(script));
  writeFileSync(join(dir, 'companion-writing-receipt.json'), JSON.stringify(receipt));
  return { script, receipt };
}
async function sourceAccountFixture(parent: string, t = topic()) {
  const dir = join(parent, t.id); mkdirSync(dir);
  writeFileSync(join(dir, 'topic.json'), JSON.stringify(t));
  const developed = await ensureSourceVisualDevelopment(dir, t, { day, writerKey, call: validCall() });
  assert.equal(developed.status, 'ready');
  const segments = accountBody(t);
  return { dir, t, developed, segments, ...saveAcceptedFixture(dir, t, segments) };
}

test('source account preserves its complete concept as context and reviews one truthful card on the original caller', () => temporary(async parent => {
  const { dir, t, developed, segments, receipt } = await sourceAccountFixture(parent);
  const preserved = ['script.json', 'companion-writing-receipt.json', 'visual-development.json'].map(name => [name, readFileSync(join(dir, name), 'utf8')] as const);
  let calls = 0, inspections = 0;
  const plans = await ensureVisualPlans(dir, segments, [], async (prompt, validate, task) => {
    calls++; assert.equal(task!.role, 'source-review'); assert.deepEqual(task!.topicIds, ['topic-1']);
    assert.match(task!.taskId, /source-account-adaptation-fields-initial-review/);
    assert.match(prompt, /complete unchanged source-account narration/); assert.ok(prompt.includes(segments[0]!.voiceover));
    assert.match(prompt, /this guide reports no execution measurements/); assert.match(prompt, /2026-09-08/);
    assert.doesNotMatch(prompt, /Fictional full-field review fixture/);
    const fields = JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!);
    assert.deepEqual(fields.map((field: { id: string }) => field.id), ['title', 'concept.kind', 'concept.intent', 'concept.reason', 'concept.label.1', 'concept.label.2', 'concept.caveat']);
    return validCall()(prompt, validate, task);
  }, (async () => { inspections++; throw new Error('card cannot claim a pixel inspection'); }) as never, false, writerKey);
  assert.equal(calls, 1); assert.equal(inspections, 0);
  const plan = plans[0]!, adaptation = plan.sourceAccountAdaptation!;
  assert.equal(sourceAccountAdaptationProblem(plan, segments[0]!, t.stories![0], developed.concepts[0]!, receipt.scriptHash), null);
  assert.equal(adaptation.sourceConceptHash, developed.concepts[0]!.contentHash);
  assert.equal(adaptation.scriptHash, receipt.scriptHash); assert.equal(adaptation.conceptArtworkRendered, false); assert.equal(adaptation.pixelReview, 'not-performed');
  for (const key of ['sourceConceptHash', 'conceptAdaptation', 'image', 'clip', 'media', 'mechanism']) assert.equal(Object.hasOwn(plan, key), false);
  assert.deepEqual(plan.labels, []); assert.deepEqual(plan.cues, []);
  for (const [name, bytes] of preserved) assert.equal(readFileSync(join(dir, name), 'utf8'), bytes);
  await ensureVisualPlans(dir, segments, [], async () => { throw new Error('exact card review must reuse its original receipt'); }, undefined, false, writerKey);
}));

test('source account compatibility failure and parent exhaustion hold before repair or new narration', () => temporary(async parent => {
  const { dir, segments } = await sourceAccountFixture(parent);
  const original = readFileSync(join(dir, 'visual-development.json'), 'utf8');
  let calls = 0;
  await assert.rejects(ensureVisualPlans(dir, segments, [], async (prompt, validate) => {
    calls++;
    const result = review(prompt); result.fields.find((row: {id: string}) => row.id === 'concept.intent').supported = false;
    assert.equal(validate(result as never), null); return result as never;
  }, undefined, false, writerKey), /accepted narration and complete source concept are locked/);
  assert.equal(calls, 1); assert.equal(existsSync(join(dir, 'visual-plans.json')), false);
  await assert.rejects(ensureVisualPlans(dir, segments, [], async () => { calls++; throw new Error('Original parent allowance exhausted'); }, undefined, false, writerKey), /Original parent allowance exhausted/);
  assert.equal(calls, 2); assert.equal(existsSync(join(dir, 'visual-plans.json')), false);
  assert.equal(readFileSync(join(dir, 'visual-development.json'), 'utf8'), original);
}));

test('complete source-account packet is preflighted before inference without clipping Unicode claims', () => temporary(async parent => {
  const t = topic();
  t.stories![0]!.verifiedClaims = [...claims, ...Array.from({ length: 4 }, (_, i) => `The guide records instruction ${i + 1}: ${'検証'.repeat(450)}.`)];
  const { dir, segments } = await sourceAccountFixture(parent, t);
  const concept = readFileSync(join(dir, 'visual-development.json'), 'utf8');
  let calls = 0;
  await assert.rejects(ensureVisualPlans(dir, segments, [], async () => { calls++; throw new Error('must preflight before calling'); }, undefined, false, writerKey), /Complete field\/source context exceeds its bounded packet/);
  assert.equal(calls, 0); assert.equal(existsSync(join(dir, 'visual-plans.json')), false);
  assert.equal(readFileSync(join(dir, 'visual-development.json'), 'utf8'), concept);
  assert.equal(JSON.parse(readFileSync(join(dir, 'script.json'), 'utf8')).body[0].voiceover, t.stories![0]!.verifiedClaims.join(' '));
}));

test('source account needs exact accepted script and keeps explicit artwork requests held', () => temporary(async parent => {
  const { dir, t, segments, receipt } = await sourceAccountFixture(parent);
  const noCall: FieldSupportCall = async () => { throw new Error('must not call'); };
  rmSync(join(dir, 'companion-writing-receipt.json'));
  await assert.rejects(ensureVisualPlans(dir, segments, [], noCall, undefined, false, writerKey), /saved video script is not bound/);
  writeFileSync(join(dir, 'companion-writing-receipt.json'), JSON.stringify({ ...receipt, scriptHash: 'a'.repeat(64) }));
  await assert.rejects(ensureVisualPlans(dir, segments, [], noCall, undefined, false, writerKey), /saved video script is not bound/);
  saveAcceptedFixture(dir, t, segments);
  await assert.rejects(ensureVisualPlans(dir, [{ ...segments[0]!, voiceover: `${segments[0]!.voiceover} A new result.` }], [], noCall, undefined, false, writerKey), /preserve every complete claim/);
  saveAcceptedFixture(dir, t, [...segments, segments[0]]);
  await assert.rejects(ensureVisualPlans(dir, segments, [], noCall, undefined, false, writerKey), /exact current accepted script body/);
  saveAcceptedFixture(dir, t, segments);
  for (const options of [{ conceptOnlyStories: [0] }, { sourceImages: [{ index: 0, candidateId: 'image' as const, file: 'source.png', sha256: 'a'.repeat(64), sourceUrl: t.primaryUrl }] }]) {
    await assert.rejects(ensureVisualPlans(dir, segments, [], noCall, undefined, false, writerKey, options), /explicitly selected artwork/);
  }
  writeFileSync(join(dir, 'visual-choices.json'), JSON.stringify({ stories: { '0': { candidateId: 'explanation', chosenBy: 'user' } } }));
  const chosen = readFileSync(join(dir, 'visual-choices.json'), 'utf8');
  await assert.rejects(ensureVisualPlans(dir, segments, [], noCall, undefined, false, writerKey), /explicitly selected artwork/);
  assert.equal(readFileSync(join(dir, 'visual-choices.json'), 'utf8'), chosen);
  assert.equal(existsSync(join(dir, 'visual-plans.json')), false);
}));

test('cache and saved release revalidate complete source-account adaptation rather than trusting an empty SVG', () => temporary(async parent => {
  const { dir, t, segments } = await sourceAccountFixture(parent);
  const plans = await ensureVisualPlans(dir, segments, [], validCall(), undefined, false, writerKey);
  writeFileSync(join(dir, 'diagrams.json'), JSON.stringify([{ svg: '', label: '', reading: '', legend: [] }]));
  const result = { ...plans[0]!, reason: 'Chosen by you.' };
  writeFileSync(join(dir, 'visual-results.json'), JSON.stringify([result]));
  assert.equal(persistedVisualReleaseProblem(dir), null);
  const raw = { svg: '', label: '', reading: '', legend: [] };
  writeFileSync(join(dir, 'diagrams.json'), JSON.stringify([{ ...raw, visual: result }]));
  assert.equal(persistedVisualReleaseProblem(dir), null);
  for (const kind of ['source', 'three']) {
    writeFileSync(join(dir, 'diagrams.json'), JSON.stringify([{ ...raw, visual: { ...result, kind } }]));
    assert.match(persistedVisualReleaseProblem(dir)!, /embedded visual conflicts/, 'the actual embedded renderer input cannot disagree with a valid display receipt');
  }
  const changedReceipt = structuredClone(result);
  changedReceipt.sourceAccountAdaptation!.review.fields[0]!.reason = 'Different review receipt';
  writeFileSync(join(dir, 'diagrams.json'), JSON.stringify([{ ...raw, visual: changedReceipt }]));
  assert.match(persistedVisualReleaseProblem(dir)!, /embedded visual conflicts/);
  writeFileSync(join(dir, 'diagrams.json'), JSON.stringify([raw]));
  rmSync(join(dir, 'visual-results.json'));
  assert.match(persistedVisualReleaseProblem(dir)!, /no current complete concept compatibility receipt/);
  for (const mutate of [
    (plan: any) => { delete plan.sourceAccountAdaptation; },
    (plan: any) => { plan.sourceAccountAdaptation.review.fields.pop(); },
    (plan: any) => { plan.sourceAccountAdaptation.pixelReview = 'passed'; },
    (plan: any) => { plan.sourceAccountAdaptation.conceptArtworkRendered = true; },
    (plan: any) => { plan.labels = ['New factual assertion']; },
    (plan: any) => { plan.kind = 'three'; },
  ]) {
    const modified = structuredClone(result); mutate(modified);
    writeFileSync(join(dir, 'visual-results.json'), JSON.stringify([modified]));
    assert.match(persistedVisualReleaseProblem(dir)!, /Source-account/);
    const cache = JSON.parse(readFileSync(join(dir, 'visual-plans.json'), 'utf8'));
    cache.plans[0] = structuredClone(plans[0]!); mutate(cache.plans[0]); cache.contentHashes[0] = hashJson(cache.plans[0]);
    writeFileSync(join(dir, 'visual-plans.json'), JSON.stringify(cache));
    let calls = 0;
    await ensureVisualPlans(dir, segments, [], async (prompt, validate, task) => { calls++; return validCall()(prompt, validate, task); }, undefined, false, writerKey);
    assert.equal(calls, 1, 'rewriting a cache hash cannot qualify a malformed receipt');
  }
  writeFileSync(join(dir, 'visual-results.json'), JSON.stringify([result]));
  const revisedScript = { body: segments, title: 'A different accepted whole script' };
  writeFileSync(join(dir, 'script.json'), JSON.stringify(revisedScript));
  writeFileSync(join(dir, 'companion-writing-receipt.json'), JSON.stringify(preparedScriptReceipt(t, writerKey, revisedScript)));
  assert.match(persistedVisualReleaseProblem(dir)!, /no current complete concept compatibility receipt/);
  let calls = 0;
  await ensureVisualPlans(dir, segments, [], async (prompt, validate, task) => { calls++; return validCall()(prompt, validate, task); }, undefined, false, writerKey);
  assert.equal(calls, 1, 'whole-script changes require a new compatibility review even when this narration is unchanged');
  const current = JSON.parse(readFileSync(join(dir, 'visual-plans.json'), 'utf8')).plans;
  writeFileSync(join(dir, 'visual-results.json'), JSON.stringify(current));
  assert.equal(persistedVisualReleaseProblem(dir), null);
  rmSync(join(dir, 'visual-development.json'));
  assert.match(persistedVisualReleaseProblem(dir)!, /lost its complete source concept/);
  await assert.rejects(ensureVisualPlans(dir, segments, [], async () => { throw new Error('missing concept must not downgrade to a legacy card'); }, undefined, false, writerKey), /lost its complete source concept/);
  await ensureSourceVisualDevelopment(dir, t, { day, writerKey, call: async (prompt, validate, task) => {
    if (!prompt.startsWith('SOURCE VISUAL CONCEPT')) return validCall()(prompt, validate, task);
    return { ...selection(), intent: 'The guide specifies' } as never;
  } });
  assert.match(persistedVisualReleaseProblem(dir)!, /no current complete concept compatibility receipt/);
  calls = 0;
  await ensureVisualPlans(dir, segments, [], async (prompt, validate, task) => { calls++; return validCall()(prompt, validate, task); }, undefined, false, writerKey);
  assert.equal(calls, 1, 'new complete concept review cannot inherit its predecessor card receipt');
}));

test('first source-account orchestration makes a reviewed attributed card without image capability or artwork calls', () => temporary(async parent => {
  const { dir, t, segments } = await sourceAccountFixture(parent);
  let calls = 0;
  const result = await ensureEditionDiagrams(dir, segments, false, async () => { throw new Error('text account must not author artwork'); }, {
    topic: t, day, writerKey, call: () => async (prompt, validate, task) => { calls++; return validCall()(prompt, validate, task); },
  });
  assert.equal(calls, 1); assert.equal(result[0]!.svg, ''); assert.equal(result[0]!.review, undefined);
  assert.equal(result[0]!.visual!.sourceAccountAdaptation!.pixelReview, 'not-performed');
  assert.equal(readVisualChoices(dir).stories['0']!.candidateId, 'snapshot');
  assert.equal(persistedVisualReleaseProblem(dir), null);
}));

test('locked snapshot resume binds source accounts but never generates unused sibling artwork', () => temporary(async parent => {
  const { dir, t, segments } = await sourceAccountFixture(parent, topic(2));
  const mixed = [segments[0]!, { assetRef: 'og-1', voiceover: narration, onScreen: { title: 'Documented guide' },
    motion: { who: 'Guide', what: 'Controller instructions', how: narration, impact: 'The guide specifies instructions.', status: 'Documented instructions', kind: 'flow' as const } }];
  saveAcceptedFixture(dir, t, mixed);
  const diagrams = mixed.map(() => ({ svg: '', label: '', reading: '', legend: [] }));
  writeFileSync(join(dir, 'diagrams.json'), JSON.stringify(diagrams));
  const candidates = ensureVisualCandidates(dir, mixed, diagrams, false);
  lockVisualChoices(dir, candidates, { '0': 'snapshot', '1': 'snapshot' }, 'user');
  const choices = readFileSync(join(dir, 'visual-choices.json'), 'utf8'), concept = readFileSync(join(dir, 'visual-development.json'), 'utf8');
  let calls = 0;
  const out = await ensureEditionDiagrams(dir, mixed, false, async () => { throw new Error('unused artwork must not be authored'); }, {
    topic: t, day, writerKey, call: () => async (prompt, validate, task) => {
      calls++; assert.deepEqual(task!.topicIds, ['topic-1']); assert.match(prompt, /^AUTHORED FIELD SOURCE REVIEW/);
      return validCall()(prompt, validate, task);
    },
  });
  assert.equal(calls, 1); assert.equal(out.length, 2); assert.ok(out.every(diagram => !diagram.svg));
  assert.ok(out[0]!.visual?.sourceAccountAdaptation); assert.equal(out[1]!.visual?.sourceAccountAdaptation, undefined);
  assert.equal(readFileSync(join(dir, 'visual-choices.json'), 'utf8'), choices);
  assert.equal(readFileSync(join(dir, 'visual-development.json'), 'utf8'), concept);
  assert.equal(persistedVisualReleaseProblem(dir), null);
  await ensureEditionDiagrams(dir, mixed, false, async () => { throw new Error('unused author'); }, {
    topic: t, day, writerKey, call: () => async () => { throw new Error('unchanged card compatibility must remain cached'); },
  });
  rmSync(join(dir, 'visual-development.json'));
  await assert.rejects(ensureEditionDiagrams(dir, mixed, false, async () => { throw new Error('unused author'); }, {
    topic: t, day, writerKey, call: () => async () => { throw new Error('missing saved concept must not prompt a legacy title review'); },
  }), /lost its complete source concept/);
}));
const body = [{ assetRef: 'og-0', voiceover: narration, onScreen: { title: 'Documented guide' },
  motion: { who: 'Guide', what: 'Controller instructions', how: narration, impact: 'The guide specifies instructions.', status: 'Documented instructions', kind: 'flow' as const } }];
function bindingCall(prompts: string[] = []): FieldSupportCall {
  return async (prompt, validate) => {
    prompts.push(prompt);
    const cues = visualCueOptions(narration);
    const value = prompt.startsWith('SOURCE VISUAL NARRATION BINDING')
      ? { cueIds: [cues.find(c => c.wordIndex === 0)!.id, cues.find(c => c.phrase.startsWith('The guide specifies'))!.id] }
      : review(prompt);
    assert.equal(validate(value as never), null); return value as never;
  };
}
test('final visual planner consumes fixed reviewed concept fields and invalidates unchanged-narration cache after concept changes', () => temporary(async parent => {
  const dir = join(parent, topic().id); mkdirSync(dir);
  writeFileSync(join(dir, 'topic.json'), JSON.stringify(topic()));
  const first = await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: validCall() });
  const prompts: string[] = [];
  const plans = await ensureVisualPlans(dir, body, [], bindingCall(prompts), undefined, false, writerKey);
  assert.equal(plans[0]!.sourceConceptHash, first.concepts[0]!.contentHash);
  assert.equal(plans[0]!.intent, draft.intent); assert.deepEqual(plans[0]!.labels, draft.labels);
  assert.deepEqual(prompts.map(p => p.split('\n')[0]), ['SOURCE VISUAL NARRATION BINDING', 'AUTHORED FIELD SOURCE REVIEW']);
  assert.match(prompts[1]!, /lockedCues/); assert.match(prompts[1]!, /no execution measurements/);
  await ensureVisualPlans(dir, body, [], async () => { throw new Error('unchanged final cache makes no calls'); }, undefined, false, writerKey);
  // A new reviewed development run keeps source/narration/settings unchanged and changes only
  // its authored concept. This new content must not inherit the old cue/source review.
  rmSync(join(dir, 'visual-development.json'));
  const revised = await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: async (prompt, validate, task) => {
    if (!prompt.startsWith('SOURCE VISUAL CONCEPT')) return validCall()(prompt, validate, task);
    const value = { ...selection(), intent: 'The guide specifies' }; assert.equal(validate(value as never), null); return value as never;
  } });
  const nextPrompts: string[] = [];
  const final = await ensureVisualPlans(dir, body, [], bindingCall(nextPrompts), undefined, false, writerKey);
  assert.equal(nextPrompts.length, 2); assert.equal(final[0]!.intent, 'The guide specifies');
  assert.equal(final[0]!.sourceConceptHash, revised.concepts[0]!.contentHash);
  assert.notEqual(final[0]!.sourceConceptHash, plans[0]!.sourceConceptHash);
}));

test('a source-reviewed concept cannot replace failed narration alignment or silently become a fallback', () => temporary(async parent => {
  const dir = join(parent, topic().id); mkdirSync(dir);
  writeFileSync(join(dir, 'topic.json'), JSON.stringify(topic()));
  await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: validCall() });
  await assert.rejects(ensureVisualPlans(dir, body, [], (async () => ({ cueIds: ['made-up', 'c1'] })) as FieldSupportCall, undefined, false, writerKey), /narration binding failed.*distinct supplied cue/);
  assert.equal(existsSync(join(dir, 'visual-plans.json')), false);
  await assert.rejects(ensureVisualPlans(dir, body, [], async (prompt, validate, task) => {
    if (prompt.startsWith('SOURCE VISUAL NARRATION BINDING')) return bindingCall()(prompt, validate, task);
    if (prompt.startsWith('AUTHORED FIELD SOURCE REPAIR')) return { edits: [{ id: 'intent', text: 'Changed concept after SVG was authored' }] } as never;
    return review(prompt, true) as never;
  }, undefined, false, writerKey), /Source concept fields are locked/);
  assert.equal(existsSync(join(dir, 'visual-plans.json')), false);
  assert.equal(readSourceVisualConcept(dir, topic(), 0, { day, writerKey })!.intent, draft.intent, 'failed final alignment preserves independent concept bytes');
  await assert.rejects(ensureVisualPlans(dir, [{ ...body[0]!, sourceAccount: { version: 1, claims, sourceUrl: topic().primaryUrl, packetHash: 'a'.repeat(64), evidenceHash: 'b'.repeat(64) } }], [], bindingCall(), undefined, false, writerKey), /text card without an inferred mechanism/);
  assert.equal(existsSync(join(dir, 'visual-plans.json')), false, 'legacy source-account fallback cannot inherit concept alignment');
}));

test('actual captured image and footage remain selectable through fresh concept adaptation, factual QA and pixel inspection', () => temporary(async parent => {
  for (const mode of ['image', 'footage'] as const) {
    const dir = join(parent, `20260909-${mode}`); mkdirSync(dir);
    writeFileSync(join(dir, 'topic.json'), JSON.stringify(topic()));
    const developed = await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: validCall() });
    const conceptBytes = readFileSync(join(dir, 'visual-development.json'), 'utf8');
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), digest = createHash('sha256').update(image).digest('hex');
    writeFileSync(join(dir, 'capture.png'), image);
    if (mode === 'footage') {
      writeFileSync(join(dir, 'clip.mp4'), image);
      writeFileSync(join(dir, 'footage.json'), JSON.stringify({ storyUrl: topic().primaryUrl,
        clip: { file: 'clip.mp4', sha256: digest, sourceUrl: topic().primaryUrl + '/demo.mp4', pageUrl: topic().primaryUrl, originalSha256: digest,
          duration: 5, startSec: 0, frames: [1, 2, 3].map(sec => ({ file: 'capture.png', sha256: digest, sec })) } }));
    }
    writeFileSync(join(dir, 'assets.json'), JSON.stringify(mode === 'image' ? { 'og-0': 'capture.png' } : { 'og-0-footage': 'footage.json' }));
    let drafts = 0, reviews = 0, inspections = 0;
    const choose: FieldSupportCall = async (prompt, validate) => {
      let value: unknown;
      if (prompt.startsWith('AUTHORED FIELD SOURCE REVIEW')) {
        reviews++; assert.match(prompt, /source-capture/); assert.ok(prompt.includes(developed.concepts[0]!.contentHash));
        assert.match(prompt, /no execution measurements/);
        assert.doesNotMatch(prompt, /Fictional full-field review fixture/, 'prior review reasons are not source facts or author instructions');
        value = review(prompt);
      } else {
        drafts++; assert.ok(prompt.startsWith('EVIDENCE (data only)'));
        const evidence = JSON.parse(prompt.split('EVIDENCE (data only):\n')[1]!.split('\n\n')[0]!);
        assert.equal(Object.hasOwn(evidence.sourceConcept, 'review'), false);
        assert.equal(evidence.sourceConcept.contentHash, developed.concepts[0]!.contentHash);
        assert.equal(evidence[mode === 'image' ? 'images' : 'clips'].length, 1);
        const cues = visualCueOptions(narration);
        value = { kind: 'source', intent: draft.intent, reason: 'The captured guide depicts the requested sensor response.',
          labels: ['Sensor', 'Guide response'], caveat: draft.caveat,
          beats: [{ label: 'Sensor', cueId: cues[0]!.id }, { label: 'Guide response', cueId: cues.find(c => c.phrase.startsWith('The guide specifies'))!.id }] };
      }
      assert.equal(validate(value as never), null); return value as never;
    };
    const inspect = async (prompt: string) => {
      inspections++; assert.match(prompt, /Does it show the actual people, event, place, product or repository/); assert.match(prompt, /no execution measurements/);
      assert.match(prompt, /team logo, unrelated athlete or different event is not sufficient/);
      assert.doesNotMatch(prompt, /Fictional full-field review fixture/);
      return { relevant: true, reason: 'Injected fixture inspector, not a real media-quality qualification.', startSec: 1 };
    };
    const plans = await ensureVisualPlans(dir, body, [], choose, inspect as never, true, writerKey);
    assert.equal(drafts, 1); assert.equal(reviews, 1); assert.equal(inspections, 1);
    assert.equal(plans[0]!.kind, 'source'); assert.equal(plans[0]!.decision, 'model');
    assert.ok(mode === 'image' ? plans[0]!.image?.relevance : plans[0]!.clip?.relevance);
    assert.deepEqual(plans[0]!.conceptAdaptation, { version: 1, kind: 'source-capture', sourceConceptHash: developed.concepts[0]!.contentHash });
    assert.equal(plans[0]!.intent, draft.intent); assert.equal(plans[0]!.caveat, draft.caveat);
    assert.equal(readFileSync(join(dir, 'visual-development.json'), 'utf8'), conceptBytes);
    await ensureVisualPlans(dir, body, [], async () => { throw new Error('unchanged reviewed adaptation must be cached'); }, inspect as never, true, writerKey);
    assert.equal(inspections, 1);
    rmSync(join(dir, 'visual-plans.json'));
    await assert.rejects(ensureVisualPlans(dir, body, [], choose, (async () => ({ relevant: false, reason: 'Unrelated capture.' })) as never, true, writerKey), /source capture relevance unverified/);
    assert.equal(existsSync(join(dir, 'visual-plans.json')), false, 'asset presence plus field approval cannot bypass actual capture inspection');
  }
}));

test('source adaptation is denied without captures and cannot rewrite concept intent or caveat', () => temporary(async parent => {
  const dir = join(parent, topic().id); mkdirSync(dir);
  writeFileSync(join(dir, 'topic.json'), JSON.stringify(topic()));
  await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: validCall() });
  let inspections = 0;
  const inspect = async () => { inspections++; return { relevant: true, reason: 'must never be used' }; };
  await assert.rejects(ensureVisualPlans(dir, body, [], (async () => ({ ...draft, kind: 'source' })) as FieldSupportCall, inspect as never, true, writerKey), /only cueIds/);
  assert.equal(inspections, 0);
  writeFileSync(join(dir, 'capture.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  writeFileSync(join(dir, 'assets.json'), JSON.stringify({ 'og-0': 'capture.png' }));
  const cues = visualCueOptions(narration);
  for (const changed of [{ intent: 'Proven controller results' }, { caveat: '' }]) {
    await assert.rejects(ensureVisualPlans(dir, body, [], (async () => ({ ...draft, ...changed, kind: 'source',
      cues: [cues[0]!.phrase, cues.find(c => c.phrase.startsWith('The guide specifies'))!.phrase] })) as FieldSupportCall, inspect as never, true, writerKey), /preserve its exact intent and caveat/);
  }
  assert.equal(inspections, 0, 'invented adaptation is rejected before pixel inspection');
}));

test('selected explanation rebinds its original three-label concept once instead of relabelling a two-label source adaptation', () => temporary(async parent => {
  const dir = join(parent, topic().id); mkdirSync(dir);
  const t = topic(), threeClaims = [...claims, 'The guide documents a conditional rule.'];
  t.stories![0]!.verifiedClaims = threeClaims;
  const original = { ...draft, labels: [...draft.labels, 'Documented rule'] }, spoken = threeClaims.join(' ');
  const segments = [{ ...body[0]!, voiceover: spoken, motion: { ...body[0]!.motion, how: spoken } }];
  const reviewAll = (prompt: string) => ({ fields: review(prompt).fields.map((row: object) => ({ ...row, claimIds: [1, 2, 3] })) });
  writeFileSync(join(dir, 'topic.json'), JSON.stringify(t));
  await ensureSourceVisualDevelopment(dir, t, { day, writerKey, call: async (prompt, validate) => {
    const value = prompt.startsWith('SOURCE VISUAL CONCEPT') ? selection(original, [1, 2, 3]) : reviewAll(prompt);
    assert.equal(validate(value as never), null); return value as never;
  } });
  const conceptBytes = readFileSync(join(dir, 'visual-development.json'), 'utf8');
  writeFileSync(join(dir, 'capture.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  writeFileSync(join(dir, 'assets.json'), JSON.stringify({ 'og-0': 'capture.png' }));
  const cueOptions = visualCueOptions(spoken), selectedCues = ['The guide asks', 'The guide specifies', 'The guide documents'].map(prefix => cueOptions.find(cue => cue.phrase.startsWith(prefix))!);
  const inspector = async () => ({ relevant: true, reason: 'Fixture-only capture inspector.' });
  const sourcePlans = await ensureVisualPlans(dir, segments, [], async (prompt, validate) => {
    const value = prompt.startsWith('AUTHORED FIELD SOURCE REVIEW') ? reviewAll(prompt)
      : { kind: 'source', intent: draft.intent, reason: 'The guide capture accompanies the instructions.', labels: ['Sensor', 'Response'], caveat: draft.caveat, cues: selectedCues.slice(0, 2).map(cue => cue.phrase) };
    assert.equal(validate(value as never), null); return value as never;
  }, inspector as never, true, writerKey);
  assert.equal(sourcePlans[0]!.labels.length, 2);
  // Minimal reviewed-art fixture exercises real choice and cue orchestration, not SVG quality.
  const diagrams: StoryDiagram[] = [{ svg: `<svg>${original.labels.map((label, i) => `<g data-step="${i + 1}"><text>${label}</text></g>`).join('')}</svg>`,
    label: 'Guide', reading: 'Read the documented instructions.', legend: [], review: { status: 'passed', sha256: 'fixture-only', reason: 'Fixture, not an actual phone render.' } }];
  const candidates = ensureVisualCandidates(dir, segments, diagrams, true);
  assert.equal(candidates.stories[0]!.recommended.id, 'explanation');
  assert.throws(() => applyVisualChoices(dir, candidates, sourcePlans, diagrams, false), VisualAlignmentRequired);
  const chosen = readVisualChoices(dir);
  assert.equal(chosen.stories['0']!.candidateId, 'explanation');
  let rebinds = 0, calls = 0;
  const aligned = await applyVisualChoicesWithAlignment(dir, candidates, sourcePlans, diagrams, false, async indices => {
    rebinds++; assert.deepEqual(indices, [0]); assert.deepEqual(readVisualChoices(dir), chosen);
    return ensureVisualPlans(dir, segments, diagrams, async (prompt, validate) => {
      calls++;
      const value = prompt.startsWith('SOURCE VISUAL NARRATION BINDING') ? { cueIds: selectedCues.map(cue => cue.id) } : reviewAll(prompt);
      assert.equal(validate(value as never), null); return value as never;
    }, inspector as never, true, writerKey, { conceptOnlyStories: indices });
  });
  assert.equal(rebinds, 1); assert.equal(calls, 2);
  assert.equal(aligned.plans[0]!.kind, 'diagram'); assert.deepEqual(aligned.plans[0]!.labels, original.labels);
  assert.equal(aligned.plans[0]!.cues.length, 3); assert.equal(aligned.plans[0]!.conceptAdaptation, undefined);
  assert.equal(aligned.plans[0]!.image, undefined); assert.equal(aligned.plans[0]!.clip, undefined);
  assert.equal(readFileSync(join(dir, 'visual-development.json'), 'utf8'), conceptBytes);
  const resumed = await ensureVisualPlans(dir, segments, diagrams, async () => { throw new Error('same selected explanation must reuse its exact reviewed binding'); }, inspector as never, true, writerKey, { conceptOnlyStories: [0] });
  await applyVisualChoicesWithAlignment(dir, candidates, resumed, diagrams, false, async () => { throw new Error('unchanged concept explanation must remain usable'); });
  let failedRebinds = 0;
  await assert.rejects(applyVisualChoicesWithAlignment(dir, candidates, sourcePlans, diagrams, false, async () => { failedRebinds++; throw new Error('Original parent deadline exhausted'); }), /Original parent deadline exhausted/);
  assert.equal(failedRebinds, 1); assert.deepEqual(readVisualChoices(dir), chosen);
  assert.equal(readFileSync(join(dir, 'visual-development.json'), 'utf8'), conceptBytes);
}));

test('selected source image preserves reviewed fields; a different own-image gets exact bounded source and pixel QA, including real orchestration media failure', () => temporary(async parent => {
  const dir = join(parent, topic().id); mkdirSync(dir);
  writeFileSync(join(dir, 'topic.json'), JSON.stringify(topic()));
  await ensureSourceVisualDevelopment(dir, topic(), { day, writerKey, call: validCall() });
  const conceptBytes = readFileSync(join(dir, 'visual-development.json'), 'utf8');
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(100, 1)]);
  writeFileSync(join(dir, 'capture.png'), png);
  writeFileSync(join(dir, 'assets.json'), JSON.stringify({ 'og-0': 'capture.png' }));
  const cues = visualCueOptions(narration), cueText = [cues[0]!.phrase, cues.find(cue => cue.phrase.startsWith('The guide specifies'))!.phrase];
  const sourceCall: FieldSupportCall = async (prompt, validate) => {
    const value = prompt.startsWith('AUTHORED FIELD SOURCE REVIEW') ? review(prompt) : { kind: 'source', intent: draft.intent,
      reason: 'The guide image accompanies the documented instructions.', labels: ['Sensor', 'Guide response'], caveat: draft.caveat, cues: cueText };
    assert.equal(validate(value as never), null); return value as never;
  };
  const inspect = async () => ({ relevant: true, reason: 'Injected capture relevance fixture.' });
  const initial = await ensureVisualPlans(dir, body, [], sourceCall, inspect as never, true, writerKey);
  const diagrams: StoryDiagram[] = [{ svg: '', label: '', reading: '', legend: [] }];
  writeFileSync(join(dir, 'diagrams.json'), JSON.stringify(diagrams));
  let candidates = ensureVisualCandidates(dir, body, diagrams, true);
  lockVisualChoices(dir, candidates, { '0': 'image' }, 'user');
  const same = applyVisualChoices(dir, candidates, initial, diagrams, true);
  assert.deepEqual(same.plans[0], initial[0], 'selected matching source must retain exact reviewed words, caveat, cues and concept linkage');
  const image = candidates.stories[0]!.candidates.find(candidate => candidate.id === 'image')!;
  const originalSelection = { index: 0, candidateId: 'image' as const, file: image.file!, sha256: image.sha256!, sourceUrl: image.sourceUrl };
  await ensureVisualPlans(dir, body, [], async () => { throw new Error('selection of same reviewed image must make no new calls'); }, inspect as never, true, writerKey, { sourceImages: [originalSelection] });

  const ownBytes = solidPng(640, 480);
  await storeOwnImage(dir, 0, body, ownBytes.toString('base64'));
  candidates = ensureVisualCandidates(dir, body, diagrams, true);
  lockVisualChoices(dir, candidates, { '0': 'own-image' }, 'user');
  const choiceBytes = readFileSync(join(dir, 'visual-choices.json'), 'utf8');
  let rebound = 0, draftCalls = 0, criticCalls = 0, pixelCalls = 0;
  let selected: import('./visual-plan.js').SelectedVisualImage[] = [];
  const changed = await applyVisualChoicesWithAlignment(dir, candidates, initial, diagrams, true, async (indices, sourceImages) => {
    rebound++; assert.deepEqual(indices, []); selected = sourceImages;
    assert.equal(sourceImages.length, 1); assert.equal(sourceImages[0]!.candidateId, 'own-image');
    return ensureVisualPlans(dir, body, [], async (prompt, validate, task) => {
      if (prompt.startsWith('AUTHORED FIELD SOURCE REVIEW')) criticCalls++;
      else {
        draftCalls++; const evidence = JSON.parse(prompt.split('EVIDENCE (data only):\n')[1]!.split('\n\n')[0]!);
        assert.equal(evidence.images.length, 1); assert.equal(evidence.images[0].file, sourceImages[0]!.file);
        assert.deepEqual(evidence.clips, []); assert.equal(evidence.requiredSourceImage.sha256, sourceImages[0]!.sha256);
      }
      return sourceCall(prompt, validate, task);
    }, (async (_prompt: string, files: string[]) => { pixelCalls++; assert.deepEqual(files, [join(dir, sourceImages[0]!.file)]); return inspect(); }) as never, true, writerKey, { sourceImages });
  });
  assert.equal(rebound, 1); assert.equal(draftCalls, 1); assert.equal(criticCalls, 1); assert.equal(pixelCalls, 1);
  assert.equal(changed.plans[0]!.image!.file, selected[0]!.file); assert.equal(changed.plans[0]!.image!.sha256, selected[0]!.sha256);
  assert.equal(changed.plans[0]!.intent, draft.intent); assert.equal(changed.plans[0]!.caveat, draft.caveat);
  assert.deepEqual(changed.plans[0]!.cues, cueText); assert.ok(changed.plans[0]!.sourceConceptHash && changed.plans[0]!.conceptAdaptation);
  assert.equal(readFileSync(join(dir, 'visual-choices.json'), 'utf8'), choiceBytes);
  await ensureVisualPlans(dir, body, [], async () => { throw new Error('same selected own-image must reuse review'); }, inspect as never, true, writerKey, { sourceImages: selected });

  const candidateBytes = readFileSync(join(dir, 'visual-candidates.json'), 'utf8');
  const planBytes = readFileSync(join(dir, 'visual-plans.json'), 'utf8');
  // The one-shot choice callback also handles a real inspector rejection before media exists.
  rmSync(join(dir, 'visual-plans.json'));
  let rejectedRebinds = 0;
  await assert.rejects(applyVisualChoicesWithAlignment(dir, candidates, initial, diagrams, true, async (_indices, sourceImages) => {
    rejectedRebinds++; return ensureVisualPlans(dir, body, [], sourceCall, (async () => ({ relevant: false, reason: 'Selected picture does not depict the guide.' })) as never, true, writerKey, { sourceImages });
  }), VisualChoiceRequired);
  assert.equal(rejectedRebinds, 1); assert.equal(readVisualChoices(dir).stories['0'], undefined);
  assert.ok(readdirSync(dir).some(file => file.startsWith('visual-choice-failure-0-')));
  writeFileSync(join(dir, 'visual-candidates.json'), candidateBytes);
  writeFileSync(join(dir, 'visual-choices.json'), choiceBytes);
  writeFileSync(join(dir, 'visual-plans.json'), planBytes);

  const child = `
    import assert from 'node:assert/strict'; import { mock } from 'node:test';
    import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
    const dir=${JSON.stringify(dir)}, topic=${JSON.stringify(topic())}, body=${JSON.stringify(body)};
    let mediaCalls=0; globalThis.fetch=async()=>{throw new Error('Unexpected external request');};
    mock.module(${JSON.stringify(new URL('./visual-media.ts', import.meta.url).href)}, { namedExports: {
      ensureVisualMedia: async()=>{mediaCalls++; throw new Error('Injected rendered-phone QA rejection');}, visualMediaProblem:()=>null
    }});
    const personalization=await import(${JSON.stringify(new URL('../personalization.ts', import.meta.url).href)});
    mock.module(${JSON.stringify(new URL('../personalization.ts', import.meta.url).href)}, { namedExports: { ...personalization, readPersonalization:()=>({...personalization.readPersonalization(dir),recommendationsAuto:false}) }});
    const {VisualChoiceRequired}=await import(${JSON.stringify(new URL('./visual-choice.ts', import.meta.url).href)});
    const {ensureEditionDiagrams}=await import(${JSON.stringify(new URL('./story-diagram.ts', import.meta.url).href)});
    const choices=readFileSync(dir+'/visual-choices.json','utf8'), concepts=readFileSync(dir+'/visual-development.json','utf8');
    const candidates=readFileSync(dir+'/visual-candidates.json','utf8'), plans=readFileSync(dir+'/visual-plans.json','utf8');
    for (const mode of ['auto-media','required-media','required-initial-review']) {
      writeFileSync(dir+'/visual-choices.json',choices); writeFileSync(dir+'/visual-candidates.json',candidates); writeFileSync(dir+'/visual-plans.json',plans);
      process.env.HARNESS_VISUAL_CHOICE=mode.startsWith('required')?'require':'auto';
      if(mode==='required-initial-review')rmSync(dir+'/visual-plans.json');
      let modelCalls=0;
      await assert.rejects(ensureEditionDiagrams(dir,body,true,async()=>{throw new Error('Unused SVG author');}, {
        topic,day:${JSON.stringify(day)},writerKey:${JSON.stringify(writerKey)},call:()=>async()=>{modelCalls++;throw new Error('Injected selected image draft rejection');},vision:async()=>{throw new Error('Unnecessary pixel request');}
      }), mode.startsWith('required')?VisualChoiceRequired:/Selected source visual failed media QA: Injected rendered-phone QA rejection/);
      assert.equal(modelCalls,mode==='required-initial-review'?1:0);
      assert.equal(JSON.parse(readFileSync(dir+'/visual-choices.json','utf8')).stories['0'],undefined);
      const history=readdirSync(dir).filter(file=>file.startsWith('visual-choice-failure-0-')).map(file=>JSON.parse(readFileSync(dir+'/'+file,'utf8')));
      assert.ok(history.some(item=>JSON.stringify(item.choice)===JSON.stringify(JSON.parse(choices).stories['0'])&&item.reason.includes(mode==='required-initial-review'?'draft rejection':'rendered-phone QA rejection')));
      assert.equal(readFileSync(dir+'/visual-development.json','utf8'),concepts); assert.equal(existsSync(dir+'/visual-results.json'),false);
    }
    assert.equal(mediaCalls,2);
    console.log('ACTUAL_SELECTED_IMAGE_FAILURE_REOPENS_CHOOSER');
  `;
  const output = execFileSync(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', child], { encoding: 'utf8', timeout: 20_000 });
  assert.match(output, /ACTUAL_SELECTED_IMAGE_FAILURE_REOPENS_CHOOSER/);
  let forbiddenCalls = 0;
  const forbidden: FieldSupportCall = async () => { forbiddenCalls++; throw new Error('No inference permitted for changed source bytes'); };
  await assert.rejects(ensureVisualPlans(dir, body, [], forbidden, inspect as never, false, writerKey, { sourceImages: selected }), /needs a model that can review images/);
  await assert.rejects(ensureVisualPlans(dir, body, [], forbidden, inspect as never, true, writerKey, { sourceImages: [{ ...selected[0]!, sourceUrl: 'https://example.com/different-story' }] }), /different source story/);
  writeFileSync(join(dir, selected[0]!.file), png);
  await assert.rejects(ensureVisualPlans(dir, body, [], forbidden, inspect as never, true, writerKey, { sourceImages: selected }), /bytes are missing or changed/);
  assert.equal(forbiddenCalls, 0); assert.equal(readVisualChoices(dir).stories['0'], undefined);
  assert.equal(readFileSync(join(dir, 'visual-development.json'), 'utf8'), conceptBytes);
}));

for (const decoder of [2, SOURCE_VISUAL_DEVELOPMENT_VERSION]) test(`explicit decoder ${decoder} recovery preserves accepted siblings and repairs only the missing visual once`, () => temporary(async dir => {
  const selected = topic(3), hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  await ensureSourceVisualDevelopment(dir, selected, { day, writerKey, call: validCall() });
  const path = join(dir, 'visual-development.json'), saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.inputHash = hash({ protocol: { visualDevelopment: decoder, fieldSupport: FIELD_SUPPORT_VERSION, sourceSupport: SOURCE_SUPPORT_VERSION }, day, writerKey, topic: selected });
  saved.status = 'partial'; saved.concepts = saved.concepts.filter((row: { topicId: string }) => row.topicId !== 'topic-2');
  for (const c of saved.concepts) { c.inputHash = saved.inputHash; const { contentHash: _old, ...receipt } = c; c.contentHash = hash(receipt); }
  saved.failures = [{ topicId: 'topic-2', sourceUrl: selected.stories![1]!.primaryUrl, error: 'Codex CLI failed after retry: labels[0] has 23 UTF-16 code units; maximum 22. Return a complete concept preserving source qualifications within the existing limits.' }];
  writeFileSync(path, JSON.stringify(saved)); const before = readFileSync(path), expectedFileSha256 = createHash('sha256').update(before).digest('hex');
  const calls: string[] = [];
  const result = await ensureSourceVisualDevelopment(dir, selected, { day, writerKey, retainedRecovery: { expectedFileSha256, authorizationHash: 'a'.repeat(64) }, call: async (prompt, validate, task) => { calls.push(task!.topicIds.join(',')); return validCall()(prompt, validate, task); } });
  assert.equal(result.status, 'ready'); assert.deepEqual(calls, ['topic-2', 'topic-2']);
  assert.ok(readFileSync(join(dir, 'visual-development-attempts', `${expectedFileSha256}.json`)).equals(before));
  for (const index of [0, 2]) {
    const old = saved.concepts.find((row: { topicId: string }) => row.topicId === `topic-${index + 1}`);
    const current = readSourceVisualConcept(dir, selected, index, { day, writerKey })!;
    const { inputHash: _oldInput, contentHash: _oldHash, ...oldFields } = old;
    const { inputHash: _newInput, contentHash: _newHash, ...newFields } = current;
    assert.deepEqual(newFields, oldFields);
  }
  await ensureSourceVisualDevelopment(dir, selected, { day, writerKey, call: async () => { throw new Error('Accepted siblings must not call again'); } });
  await assert.rejects(ensureSourceVisualDevelopment(dir, selected, { day, writerKey, retainedRecovery: { expectedFileSha256, authorizationHash: 'a'.repeat(64) }, call: validCall() }), /already consumed/);
}));

test('historical visual recovery never waives a completed factual rejection', () => temporary(async dir => {
  const selected = topic(2); await ensureSourceVisualDevelopment(dir, selected, { day, writerKey, call: validCall() });
  const path = join(dir, 'visual-development.json'), saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.status = 'partial'; saved.concepts.pop(); saved.failures = [{ topicId: 'topic-2', sourceUrl: selected.stories![1]!.primaryUrl, error: 'Unsupported visual source claim' }];
  writeFileSync(path, JSON.stringify(saved)); const original = readFileSync(path);
  await assert.rejects(ensureSourceVisualDevelopment(dir, selected, { day, writerKey, retainedRecovery: { expectedFileSha256: createHash('sha256').update(original).digest('hex'), authorizationHash: 'a'.repeat(64) }, call: async () => { throw new Error('No inference'); } }), /never a factual rejection/);
  assert.ok(readFileSync(path).equals(original)); assert.equal(existsSync(join(dir, 'visual-development-recovery.json')), false);
}));

test('interrupted historical visual recovery consumes its one retry and keeps original accepted fields', () => temporary(async dir => {
  const selected = topic(2), hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  await ensureSourceVisualDevelopment(dir, selected, { day, writerKey, call: validCall() });
  const path = join(dir, 'visual-development.json'), saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.inputHash = hash({ protocol: { visualDevelopment: 2, fieldSupport: FIELD_SUPPORT_VERSION, sourceSupport: SOURCE_SUPPORT_VERSION }, day, writerKey, topic: selected });
  saved.status = 'partial'; saved.concepts.pop();
  for (const c of saved.concepts) { c.inputHash = saved.inputHash; const { contentHash: _old, ...receipt } = c; c.contentHash = hash(receipt); }
  saved.failures = [{ topicId: 'topic-2', sourceUrl: selected.stories![1]!.primaryUrl, error: 'Codex CLI failed after retry: labels[0] has 23 UTF-16 code units; maximum 22. Return a complete concept preserving source qualifications within the existing limits.' }];
  writeFileSync(path, JSON.stringify(saved)); const original = readFileSync(path);
  let calls = 0;
  const failed = await ensureSourceVisualDevelopment(dir, selected, { day, writerKey, retainedRecovery: { expectedFileSha256: createHash('sha256').update(original).digest('hex'), authorizationHash: 'a'.repeat(64) }, call: async () => { calls++; throw new Error('Injected interrupted transport'); } });
  assert.equal(failed.status, 'partial'); assert.equal(calls, 1); assert.equal(failed.concepts.length, 1);
  await assert.rejects(ensureSourceVisualDevelopment(dir, selected, { day, writerKey, call: async () => { calls++; throw new Error('Must not call'); } }), /already consumed/);
  assert.equal(calls, 1); assert.deepEqual(failed.concepts[0]!.review, saved.concepts[0].review);
}));

test('a locked actual source photo skips unused SVG generation but still requires its source and narration review', () => temporary(async temporaryDir => {
  const dir=join(temporaryDir,'20260909-guides');mkdirSync(dir);
  const selected=topic();const body=[{assetRef:'og-0',voiceover:claims.join(' '),onScreen:{title:'Controller guide'},motion:{kind:'flow' as const,who:'Controller',what:'Sensor',how:'Read the sensor',impact:'Specified response',status:'Documented instructions'}}];
  writeFileSync(join(dir,'topic.json'),JSON.stringify(selected));writeFileSync(join(dir,'script.json'),JSON.stringify({body}));
  writeFileSync(join(dir,'source.png'),Buffer.from([137,80,78,71,13,10,26,10]));writeFileSync(join(dir,'assets.json'),JSON.stringify({'og-0':'source.png'}));
  await ensureSourceVisualDevelopment(dir,selected,{day,writerKey,call:validCall()});
  lockVisualChoices(dir,ensureVisualCandidates(dir,body,[],true),{'0':'image'},'user');
  let authors=0,alignments=0;
  const author=async()=>{authors++;throw new Error('Unused illustration must not run');};
  const context={writerKey,day,topic:selected,call:(_stage:'visual')=>async<T>():Promise<T>=>{alignments++;throw new Error('Injected required photo alignment failure');}};
  await assert.rejects(ensureEditionDiagrams(dir,body,true,author,context),/Injected required photo alignment failure/);
  assert.equal(authors,0);assert.equal(alignments,1);assert.equal(readVisualChoices(dir).stories['0'],undefined);
  const failure=JSON.parse(readFileSync(join(dir,readdirSync(dir).find(name=>name.startsWith('visual-choice-failure-'))!),'utf8'));assert.equal(failure.choice.candidateId,'image');
  assert.ok(readdirSync(dir).some(name=>name.startsWith('visual-choice-failure-')),'The failed photo QA stays visible; no silent source-card substitute');
  const diagrams=JSON.parse(readFileSync(join(dir,'diagrams.json'),'utf8'));assert.equal(diagrams[0].svg,'');
}));


test('authorized photo revision cannot reuse a former snapshot or mislabel failed photo review as failed snapshot', () => temporary(async temporaryDir => {
  const dir=join(temporaryDir,'20260909-guides');mkdirSync(dir);const selected=topic();
  const body=[{assetRef:'og-0',voiceover:claims.join(' '),onScreen:{title:'Controller guide'},motion:{kind:'flow' as const,who:'Controller',what:'Sensor',how:'Read the sensor',impact:'Specified response',status:'Documented instructions'}}];
  const script={body};writeFileSync(join(dir,'topic.json'),JSON.stringify(selected));writeFileSync(join(dir,'script.json'),JSON.stringify(script));
  writeFileSync(join(dir,'companion-writing-receipt.json'),JSON.stringify(preparedScriptReceipt(selected,writerKey,script as never)));
  writeFileSync(join(dir,'source.png'),Buffer.from([137,80,78,71,13,10,26,10]));writeFileSync(join(dir,'assets.json'),JSON.stringify({'og-0':'source.png'}));
  await ensureSourceVisualDevelopment(dir,selected,{day,writerKey,call:validCall()});
  lockVisualChoices(dir,ensureVisualCandidates(dir,body,[],true),{'0':'snapshot'},'user');
  let authors=0,alignments=0,guards=0;
  const context={writerKey,day,topic:selected,journal:{kind:'approved-media-only',visualRecovery:{}},assertUnchanged:()=>{guards++;},visualRevision:{identity:'a'.repeat(64),choices:{'0':'image' as const}},call:(_stage:'visual')=>async<T>():Promise<T>=>{alignments++;throw new Error('Required image alignment failed');}};
  await assert.rejects(ensureEditionDiagrams(dir,body,true,async()=>{authors++;throw new Error('Unused SVG request');},context),/Required image alignment failed/);
  assert.equal(authors,0);assert.equal(alignments,1);assert.ok(guards>0);
  const failure=JSON.parse(readFileSync(join(dir,readdirSync(dir).find(name=>name.startsWith('visual-choice-failure-'))!),'utf8'));assert.equal(failure.choice.candidateId,'image');
  assert.equal(readVisualChoices(dir).stories['0'],undefined);assert.deepEqual(JSON.parse(readFileSync(join(dir,'script.json'),'utf8')),script);
}));

test('mixed presentation revision authors the requested diagram and never spends on the selected photo SVG', () => temporary(async temporaryDir => {
  const dir=join(temporaryDir,'20260909-guides');mkdirSync(dir);const selected=topic(2);
  const body=[0,1].map(i=>({assetRef:`og-${i}`,voiceover:claims.join(' '),onScreen:{title:`Controller guide ${i+1}`},motion:{kind:'flow' as const,who:'Controller',what:'Sensor',how:'Read the sensor',impact:'Specified response',status:'Documented instructions'}}));
  const script={body};writeFileSync(join(dir,'topic.json'),JSON.stringify(selected));writeFileSync(join(dir,'script.json'),JSON.stringify(script));
  writeFileSync(join(dir,'companion-writing-receipt.json'),JSON.stringify(preparedScriptReceipt(selected,writerKey,script as never)));
  writeFileSync(join(dir,'source.png'),Buffer.from([137,80,78,71,13,10,26,10]));writeFileSync(join(dir,'assets.json'),JSON.stringify({'og-0':'source.png','og-1':'source.png'}));
  await ensureSourceVisualDevelopment(dir,selected,{day,writerKey,call:validCall()});
  lockVisualChoices(dir,ensureVisualCandidates(dir,body,[],true),{'0':'snapshot','1':'snapshot'},'user');
  const authored:number[]=[];const context={writerKey,day,topic:selected,journal:{kind:'approved-media-only',visualRecovery:{}},assertUnchanged:()=>{},visualRevision:{identity:'a'.repeat(64),choices:{'0':'image' as const,'1':'explanation' as const}},call:(_stage:'visual')=>async<T>():Promise<T>=>{throw new Error('No later call before artwork');}};
  await assert.rejects(ensureEditionDiagrams(dir,body,true,async(_story,n)=>{authored.push(n);throw new Error('Requested diagram author reached');},context),/Requested diagram author reached/);
  assert.deepEqual(authored,[2]);assert.ok(readdirSync(dir).some(name=>name.startsWith('diagram-generation-failed-')));
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'script.json'),'utf8')),script);
}));
