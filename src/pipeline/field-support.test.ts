import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureSourceSupportedFields, FIELD_SUPPORT_VERSION, type AuthoredField, type FieldReview, type FieldReviewAudit } from './field-support.js';
import { preparedModelTask, type PreparedModelTask } from './writing-task.js';
import { createSourceSupportContext, SOURCE_SUPPORT_VERSION } from './source-support.js';
import { SourceReviewDisputeError } from './review-dispute.js';
import { jsonOutputContract } from '../llm/json-output-contract.js';
import { codexNativeSchema } from '../llm/codex.js';

const claims = ['The authors report nearly 80% success in simulation.', 'The study is a preprint.'];
const task = preparedModelTask({ role: 'script', capability: 'script-draft', taskId: 'card', topicIds: ['topic-2'], protocol: 1, evidence: claims });
const base = [{ id: 'title', text: 'Drones learn in simulation' }, { id: 'status', text: 'Not field-deployed or clinically validated' }];
const options = { task, sourceContext: createSourceSupportContext('2026-09-09', 'https://example.org/paper', [{ url: 'https://example.org/paper', publishedAt: '2026-09-08' }]),
  context: { narration: 'The authors report a simulation.', limits: { status: 60 } }, validateFinal: (fields: readonly AuthoredField[]) => fields.some(field => field.text.length > 60) ? 'status/title maximum60 characters' : null };
const review = (fields: readonly AuthoredField[], bad: string[] = []): FieldReview => ({ fields: fields.map(field => ({ id: field.id, supported: !bad.includes(field.id), claimIds: field.text ? [1] : [], reason: bad.includes(field.id) ? 'Simulation does not establish absence of field deployment.' : 'The source establishes this scoped fact.' })) });
const promptFields = (prompt: string): AuthoredField[] => JSON.parse(prompt.split('\nAUTHORED_FIELDS: ')[1]!.split('\n')[0]!);

test('field date metadata preserves each source clock through repair without supplying event evidence', async () => {
  const fields = [{ id: 'status', text: 'Available today, per the source.' }];
  const seen: string[] = [];
  const result = await ensureSourceSupportedFields(fields, claims, async <T>(prompt: string) => {
    seen.push(prompt);
    assert.deepEqual(JSON.parse(prompt.match(/^SOURCE_DATE_ALIGNMENT: (.*)$/m)![1]!), [{ sourceId: 1, publishedDay: '2026-09-08', daysBeforeEdition: 1 }]);
    assert.match(prompt, /never event evidence/);
    if (seen.length === 2) return { edits: [{ id: 'status', text: 'The source reports availability.' }] } as T;
    assert.match(prompt, /trailing source credit does not turn unscoped today/);
    return review(promptFields(prompt), seen.length === 1 ? ['status'] : []) as T;
  }, options);
  assert.equal(seen.length, 3);
  assert.equal(result.fields[0]!.text, 'The source reports availability.');
  assert.equal(fields[0]!.text, 'Available today, per the source.');
});

test('edition field dates stay grouped by source context instead of sharing one publication clock', async () => {
  const contexts = [options.sourceContext,
    createSourceSupportContext('2026-09-09', 'https://second.example/report', [{ url: 'https://second.example/report', publishedAt: '2026-09-09' }]),
    createSourceSupportContext('2026-09-09', 'https://unknown.example/report', [{ url: 'https://unknown.example/report' }])];
  let calls = 0;
  await ensureSourceSupportedFields(base, claims, async <T>(prompt: string) => {
    calls++;
    assert.ok(!/^SOURCE_DATE_ALIGNMENT:/m.test(prompt));
    assert.deepEqual(JSON.parse(prompt.match(/^SOURCE_DATE_ALIGNMENTS: (.*)$/m)![1]!), contexts.map((source, index) => ({
      contextId: index + 1, primaryUrl: source.primaryUrl,
      dates: [{ sourceId: 1, publishedDay: index === 0 ? '2026-09-08' : index === 1 ? '2026-09-09' : null, daysBeforeEdition: index === 0 ? 1 : index === 1 ? 0 : null }],
    })));
    assert.deepEqual(JSON.parse(prompt.match(/^SOURCE_CONTEXTS: (.*)$/m)![1]!), contexts);
    return review(base) as T;
  }, { ...options, sourceContext: undefined, sourceContexts: contexts });
  assert.equal(calls, 1);
});

test('one whole-field review sees all claims/context and returns exact supported fields', async () => {
  const fields = [{ id: 'title', text: 'Reported simulation result' }, { id: 'caveat', text: '', allowEmpty: true }]; let calls = 0;
  const answer = await ensureSourceSupportedFields(fields, claims, async <T>(prompt: string, validate: (value: T) => string | null, descriptor?: PreparedModelTask) => {
    calls++; assert.equal(descriptor?.role, 'source-review'); assert.match(prompt, /PINNED_CLAIMS/); assert.match(prompt, /2026-09-08/);
    assert.equal(descriptor!.protocolHash, preparedModelTask({ role: 'source-review', capability: 'source-review', taskId: 'expected', topicIds: ['topic-2'],
      protocol: { version: FIELD_SUPPORT_VERSION, sourceSupport: SOURCE_SUPPORT_VERSION, operation: 'initial-review' }, evidence: null }).protocolHash);
    assert.match(prompt, /does not establish not-peer-reviewed/); assert.match(prompt, /unscoped today into a quotation/i);
    const value = review(promptFields(prompt)) as T; assert.equal(validate(value), null); return value;
  }, options);
  assert.equal(calls, 1); assert.deepEqual(answer.fields, fields);
});

test('unsupported absence is repaired once and final exact values receive a fresh critic review', async () => {
  const descriptors: PreparedModelTask[] = [], before = structuredClone(base); let calls = 0;
  const answer = await ensureSourceSupportedFields(base, claims, async <T>(prompt: string, validate: (value: T) => string | null, descriptor?: PreparedModelTask) => {
    descriptors.push(descriptor!); calls++;
    const value = (calls === 1 ? review(base, ['status']) : calls === 2 ? { edits: [{ id: 'status', text: 'Reported simulation; preprint' }] } : review(promptFields(prompt))) as T;
    if (calls === 3) { assert.equal(promptFields(prompt)[0]!.text, before[0]!.text); assert.equal(promptFields(prompt)[1]!.text, 'Reported simulation; preprint'); }
    assert.equal(validate(value), null); return value;
  }, options);
  assert.deepEqual(descriptors.map(row => row.role), ['source-review', 'source-repair', 'source-review']);
  assert.notEqual(descriptors[0]!.candidateHash, descriptors[2]!.candidateHash);
  assert.deepEqual(base, before); assert.equal(answer.fields[0]!.text, before[0]!.text); assert.equal(calls, 3);
});

test('omitted duplicate wrong IDs invalid citations and truthy booleans fail closed', async () => {
  for (const change of [
    (value: any) => { value.fields.pop(); },
    (value: any) => { value.fields[1].id = 'title'; },
    (value: any) => { value.fields[1].id = 'invented'; },
    (value: any) => { value.fields[0].claimIds = [3]; },
    (value: any) => { value.fields[0].supported = 'true'; },
    (value: any) => { value.extra = 'unrequested'; },
  ]) {
    let calls = 0; const value = review(base); change(value);
    await assert.rejects(ensureSourceSupportedFields(base, claims, async <T>() => { calls++; return value as T; }, options));
    assert.equal(calls, 1);
  }
});

test('an echoed empty text key on a review row is dropped; any other extra key still fails closed', async () => {
  const fields = [{ id: 'title', text: 'Drones learn in simulation' }, { id: 'reason', text: 'Source excerpt: nearly 80% success.' }]; let calls = 0;
  const answer = await ensureSourceSupportedFields(fields, claims, async <T>(prompt: string, validate: (value: T) => string | null) => {
    calls++; const value: any = review(promptFields(prompt)); value.fields[1].text = ''; assert.equal(validate(value as T), null); return value as T;
  }, options);
  assert.equal(calls, 1); assert.deepEqual(answer.fields, fields);
  let extra = 0; const bad: any = review(fields); bad.fields[1].text = 'rewritten';
  await assert.rejects(ensureSourceSupportedFields(fields, claims, async <T>() => { extra++; return bad as T; }, options), /malformed field ID/);
  assert.equal(extra, 1);
});

test('repair cannot change a supported field or add IDs URLs or ignore structural bounds', async () => {
  for (const edits of [
    [{ id: 'title', text: 'Changed locked field' }],
    [{ id: 'status', text: 'Reported result' }, { id: 'title', text: 'Another change' }],
    [{ id: 'status', text: 'https://attacker.example/' }],
    [{ id: 'status', text: 'A'.repeat(61) }],
  ]) {
    let calls = 0;
    await assert.rejects(ensureSourceSupportedFields(base, claims, async <T>() => (++calls === 1 ? review(base, ['status']) : { edits }) as T, options));
    assert.equal(calls, 2);
  }
});

test('an empty optional caveat is allowed as repair and reviewed, but required fields cannot be emptied', async () => {
  const fields = [{ id: 'caveat', text: 'Not peer-reviewed', allowEmpty: true }]; let calls = 0;
  const result = await ensureSourceSupportedFields(fields, claims, async <T>(prompt: string) => (++calls === 1 ? review(fields, ['caveat']) : calls === 2 ? { edits: [{ id: 'caveat', text: '' }] } : review(promptFields(prompt))) as T, options);
  assert.equal(result.fields[0]!.text, ''); assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(ensureSourceSupportedFields(base, claims, async <T>() => (++calls === 1 ? review(base, ['status']) : { edits: [{ id: 'status', text: '' }] }) as T, options), /empty\/text constraints/);
});

test('a late final rejection does not trigger a second repair or accept provisional fields', async () => {
  let calls = 0;
  await assert.rejects(ensureSourceSupportedFields(base, claims, async <T>(prompt: string) => (++calls === 1 ? review(base, ['status']) : calls === 2 ? { edits: [{ id: 'status', text: 'Not peer-reviewed' }] } : review(promptFields(prompt), ['status'])) as T, options), /failed after one repair/);
  assert.equal(calls, 3);
});

test('missing evidence and oversized full context consume no model calls', async () => {
  let calls = 0; const call = async <T>() => { calls++; return {} as T; };
  await assert.rejects(ensureSourceSupportedFields(base, [], call, options), /verified source claims/);
  await assert.rejects(ensureSourceSupportedFields(base, claims, call, { ...options, context: 'x'.repeat(20001) }), /bounded packet/);
  assert.equal(calls, 0);
});

test('caller deadline/cost errors propagate unchanged with no helper retry', async () => {
  let calls = 0; const stop = new Error('Original parent exhausted its physical allowance');
  await assert.rejects(ensureSourceSupportedFields(base, claims, async <T>() => { calls++; throw stop; }, options), error => error === stop);
  assert.equal(calls, 1);
});

test('an exact copied field with the wrong contextual referent holds without rewriting or approving any field', async () => {
  const facts = ['The Harbor team won its regional tournament.', 'It won the tournament.'];
  const fields = [{ id: 'title', text: 'The Harbor team won its regional tournament.' }, { id: 'result', text: 'It won the tournament.' }];
  const context = { heading: 'The Ridge team', narration: 'This card describes Ridge, not Harbor.' };
  const original: FieldReview = { fields: [
    { id: 'title', supported: true, claimIds: [1], reason: 'The named source team is retained.' },
    { id: 'result', supported: false, claimIds: [2], reason: 'The pronoun now refers to Ridge in the supplied presentation; the source refers to Harbor.' },
  ] };
  const before = structuredClone(original); let calls = 0; const audits: FieldReviewAudit[] = [];
  await assert.rejects(ensureSourceSupportedFields(fields, facts, async <T>(_prompt: string, validate: (value: T) => string | null) => {
    calls++; assert.equal(validate(original as T), null); return original as T;
  }, { task, context, validateFinal: () => null, onReview: audit => {
    audits.push(structuredClone(audit));
    audit.review.fields[1]!.supported = true; // Callback receives a copy; it cannot approve the actual rejected field.
  } }), error => {
    assert.ok(error instanceof SourceReviewDisputeError);
    assert.equal(audits.length, 1, 'Validated rejecting review is retained before the dispute throws');
    assert.deepEqual(audits[0]!.review, before); assert.deepEqual(audits[0]!.fields, fields);
    assert.deepEqual(audits[0]!.claims, facts); assert.deepEqual(audits[0]!.context, context);
    assert.equal(error.dispute.candidate.text, fields[1]!.text);
    assert.deepEqual(error.dispute.presentation?.fields, fields);
    assert.deepEqual(error.dispute.presentation?.review, before);
    assert.deepEqual(error.dispute.presentation?.context, context);
    assert.deepEqual(error.dispute.claims.map(row => row.text), facts); return true;
  });
  assert.equal(calls, 1, 'No repair or same-critic retry follows a dispute'); assert.deepEqual(original, before);
});

test('field citation mismatches preserve positive original rows and stop before a correction call', async () => {
  const fields = [{ id: 'status', text: claims[1]! }];
  const original: FieldReview = { fields: [{ id: 'status', supported: true, claimIds: [1], reason: 'Wrong valid claim ID.' }] };
  let calls = 0;
  await assert.rejects(ensureSourceSupportedFields(fields, claims, async <T>() => { calls++; return original as T; }, options), error => {
    assert.ok(error instanceof SourceReviewDisputeError); assert.equal(error.dispute.findings[0]!.kind, 'citation-mismatch');
    assert.deepEqual(error.dispute.presentation?.review, original); return true;
  });
  assert.equal(calls, 1); assert.deepEqual(original.fields[0]!.claimIds, [1]);
});

test('edition derivative fields retain distinct complete source restrictions and identities without extra positive claim credit', async () => {
  const context = createSourceSupportContext('2026-09-09', 'https://second.example/report', [{ url: 'https://second.example/report', publishedAt: null,
    sha256: 'a'.repeat(64), textSha256: 'b'.repeat(64), restrictions: [{ sourceSentenceId: 43, text: 'The timestamp must be strictly newer than the stored timestamp.' }] }]);
  const mutableClaims = [...claims]; let evidenceHash = '';
  const result = await ensureSourceSupportedFields([{ id: 'title', text: 'A reported simulation' }], mutableClaims, async <T>(prompt: string, validate: (value: T) => string | null, descriptor?: PreparedModelTask) => {
    const contexts = JSON.parse(prompt.match(/^SOURCE_CONTEXTS: (.*)$/m)![1]!);
    assert.equal(contexts.length, 2); assert.equal(contexts[0].sources[0].publishedAt, '2026-09-08');
    assert.equal(contexts[1].sources[0].publishedAt, null); assert.match(contexts[1].sources[0].restrictions[0].text, /strictly newer/);
    assert.equal(JSON.parse(prompt.match(/^PINNED_CLAIMS: (.*)$/m)![1]!).length, 2);
    evidenceHash = descriptor!.evidenceHash;
    mutableClaims.push('A malicious new claim cannot join the existing review.');
    assert.match(validate({ fields: [{ id: 'title', supported: true, claimIds: [3], reason: 'New input claim.' }] } as T)!, /valid pinned-claim/);
    return review(promptFields(prompt)) as T;
  }, { ...options, sourceContext: undefined, sourceContexts: [options.sourceContext, context] });
  assert.equal(result.fields[0].text, 'A reported simulation'); assert.match(evidenceHash, /^[a-f0-9]{64}$/);
  let calls = 0;
  await assert.rejects(ensureSourceSupportedFields(base, claims, async <T>() => { calls++; return {} as T; }, { ...options, sourceContexts: [context] }), /one source context/);
  assert.equal(calls, 0);
});


test('complete field reviewer carries owned IDs and bounded citations/reasons without changing acceptance or call count', async () => {
  const fields = [{ id: 'label.1', text: 'Reported simulation' }, { id: 'caveat', text: '', allowEmpty: true }];
  let calls = 0;
  const result = await ensureSourceSupportedFields(fields, claims, async <T>(prompt: string, validate: (value: T) => string | null) => {
    calls++;
    for (const claim of claims) assert.ok(prompt.includes(claim));
    assert.match(prompt, /2026-09-08/);
    const contract = jsonOutputContract(validate)!;
    assert.ok(contract); assert.equal(codexNativeSchema(contract), contract.schema);
    assert.deepEqual(contract.schema, { type: 'object', additionalProperties: false, required: ['fields'], properties: {
      fields: { type: 'array', minItems: 2, maxItems: 2, items: {
        type: 'object', additionalProperties: false, required: ['id', 'supported', 'claimIds', 'reason'], properties: {
          id: { type: 'string', enum: ['label.1', 'caveat'] }, supported: { type: 'boolean' },
          claimIds: { type: 'array', minItems: 0, maxItems: 2, items: { type: 'integer', enum: [1, 2] } },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
        },
      } },
    } });
    const valid = review(fields);
    assert.equal(validate(valid as T), null);
    assert.match(validate({ fields: [valid.fields[0]] } as T)!, /every supplied field/);
    assert.match(validate({ fields: [valid.fields[0], valid.fields[0]] } as T)!, /duplicate/);
    assert.match(validate({ fields: [{ ...valid.fields[0], id: 'other' }, valid.fields[1]] } as T)!, /unknown/);
    assert.match(validate({ fields: [{ ...valid.fields[0], claimIds: [3] }, valid.fields[1]] } as T)!, /valid pinned-claim/);
    assert.match(validate({ fields: [{ ...valid.fields[0], reason: 'x'.repeat(501) }, valid.fields[1]] } as T)!, /concise reason/);
    assert.match(validate({ fields: [{ ...valid.fields[0], claimIds: [] }, valid.fields[1]] } as T)!, /valid pinned-claim/);
    return valid as T;
  }, options);
  assert.equal(calls, 1); assert.deepEqual(result.fields, fields);
});
