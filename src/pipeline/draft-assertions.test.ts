import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonOutputContract } from '../llm/json-output-contract.js';
import { buildDraftAssertionsPrompt, validateDraftAssertions, reviewDraftAssertions, validateDraftAssertionReceipt,
  draftAnchorSpans, DRAFT_ASSERTIONS_VERSION, type DraftAssertionsResponse } from './draft-assertions.js';
import { preparedModelTask, assertPreparedModelTask, type PreparedModelTask } from './writing-task.js';
import type { SourceSupportCall } from './source-support.js';

const text = 'The skill produces short responses. The documentation asks for short responses.';
const answer = (): DraftAssertionsResponse => ({ sentences: [
  { id: 1, assertedStatus: 'achieved-behavior', exclusionStatus: 'none', temporalFraming: 'none', anchorIds: [1], reason: 'Injected classification of the asserted operation, not measured model accuracy.' },
  { id: 2, assertedStatus: 'documented-intent', exclusionStatus: 'none', temporalFraming: 'none', anchorIds: [1], reason: 'Injected classification of the explicit instruction, not semantic acceptance.' },
] });
const injected = (value = answer()): SourceSupportCall => async <T>(_prompt: string, validate: (value: T) => string | null) => {
  assert.equal(validate(value as T), null); return value as T;
};

test('draft-only prompt preserves the complete paragraph and separates actual assertion from evidence sufficiency', () => {
  const prompt = buildDraftAssertionsPrompt(text);
  const sentences = JSON.parse(prompt.match(/^DRAFT_SENTENCES: (.*)$/m)![1]!);
  assert.deepEqual(sentences, [{ id: 1, spans: [{ id: 1, text: 'The skill produces short responses. ' }] }, { id: 2, spans: [{ id: 1, text: 'The documentation asks for short responses.' }] }]);
  assert.equal(sentences.flatMap((row: any) => row.spans.map((span: any) => span.text)).join(''), text);
  assert.doesNotMatch(prompt, /PINNED_CLAIMS:|SOURCE_CONTEXT:|RESTRICTION_INDEX:|supported":/);
  assert.match(prompt, /Do not invent an implicit/);
  assert.match(prompt, /a neutral file location cannot erase an operational promise/);
  assert.match(prompt, /cannot reject a documented API capability or a real reported result as unsupported/);
  assert.equal(DRAFT_ASSERTIONS_VERSION, 8);
});

test('draft decoding contract requires every classification field without source evidence or a default verdict', async () => {
  let calls = 0;
  await reviewDraftAssertions(text, async <T>(prompt: string, validate: (value: T) => string | null) => {
    calls++;
    const contract = jsonOutputContract(validate); assert.ok(contract);
    const schema = contract.schema as any, rows = schema.properties.sentences, fields = rows.items.properties;
    assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, ['sentences']);
    assert.equal(rows.minItems, 2); assert.equal(rows.maxItems, 2);
    assert.deepEqual(fields.id.enum, [1, 2]); assert.equal(fields.anchorIds.maxItems, 2);
    assert.equal(fields.reason.maxLength, 500);
    assert.deepEqual([...rows.items.required].sort(), ['id', 'assertedStatus', 'exclusionStatus', 'temporalFraming', 'anchorIds', 'reason'].sort());
    assert.ok(fields.assertedStatus.enum.includes('uncertain')); assert.ok(fields.exclusionStatus.enum.includes('evidence-limit'));
    assert.doesNotMatch(JSON.stringify(schema), /default|sourceIds|sourceContext|The skill/);
    assert.equal(prompt, buildDraftAssertionsPrompt(text), 'No schema or source is appended to the complete draft-only prompt');
    const invalid = answer(); invalid.sentences[1]!.id = 1;
    assert.notEqual(validate(invalid as T), null, 'Unique coverage remains a validator obligation');
    assert.equal(validate(answer() as T), null); return answer() as T;
  });
  assert.equal(calls, 1, 'A schema adds no separate model call');
});

test('every sentence has exactly one valid ID and no source citations or extra review fields', () => {
  assert.equal(validateDraftAssertions(answer(), text), null);
  for (const mutate of [
    (value: any) => { value.sentences.pop(); },
    (value: any) => { value.sentences[1].id = 1; },
    (value: any) => { value.sentences[1].id = 3; },
    (value: any) => { value.sentences[0].id = 1.5; },
    (value: any) => { value.sourceSupport = true; },
    (value: any) => { value.sentences[0].claimIds = [1]; },
    (value: any) => { value.sentences[0].assertedStatus = 'supported'; },
    (value: any) => { delete value.sentences[0].exclusionStatus; },
    (value: any) => { value.sentences[0].exclusionStatus = 'probably-absent'; },
    (value: any) => { delete value.sentences[0].temporalFraming; },
    (value: any) => { value.sentences[0].temporalFraming = 'today'; },
    (value: any) => { value.sentences[0].reason = 'x'.repeat(501); },
    (value: any) => { value.sentences[0].reason = 'Two\nlines'; },
  ]) { const value = answer(); mutate(value); assert.notEqual(validateDraftAssertions(value, text), null); }
});

test('anchors select distinct real integer span IDs from their own sentence without copied text', () => {
  for (const anchorIds of [[], ['documentation asks'], [1, 1], [1, 2, 3], [0], [2], [1.5], [null], [true], ['1']]) {
    const value = answer(); value.sentences[0]!.anchorIds = anchorIds as number[];
    assert.match(validateDraftAssertions(value, text)!, /sentence 1 anchorIds.*valid IDs: 1/);
  }
  const unicode = 'The team describes café outputs as “prévu”.';
  const value = { sentences: [{ id: 1, assertedStatus: 'attributed-assertion', exclusionStatus: 'none', temporalFraming: 'none', anchorIds: [1], reason: 'The source description is explicitly attributed.' }] };
  assert.equal(validateDraftAssertions(value, unicode), null);
  assert.notEqual(validateDraftAssertions({ sentences: [{ ...value.sentences[0], anchors: ['café'] }] }, unicode), null, 'Copied-text protocol is not silently accepted');
});

test('mechanical spans preserve all bytes, whitespace, emoji boundaries and qualifiers without semantic selection', () => {
  for (const value of ['', 'x'.repeat(161), 'x'.repeat(159) + '😀' + 'z'.repeat(165), '  café\tprévu\n'.repeat(35) + ' only if approved, never otherwise.  ', 'a'.repeat(6000)]) {
    const spans = draftAnchorSpans(value);
    assert.equal(spans.map(span => span.text).join(''), value);
    assert.deepEqual(spans.map(span => span.id), spans.map((_, i) => i + 1));
    for (const span of spans) {
      assert.ok(span.text.length > 0 && span.text.length <= 160);
      assert.doesNotMatch(span.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u, 'A valid surrogate pair cannot be split');
    }
  }
  const paragraph = '  The interface ' + 'retains its complete documented context '.repeat(8) + 'only if approved, never otherwise.  The exception remains.  ';
  const rows = JSON.parse(buildDraftAssertionsPrompt(paragraph).match(/^DRAFT_SENTENCES: (.*)$/m)![1]!);
  assert.equal(rows.flatMap((row: any) => row.spans.map((span: any) => span.text)).join(''), paragraph);
  assert.match(rows[0].spans.map((span: any) => span.text).join(''), /only if approved, never otherwise/);
});

test('long observed-copy failure becomes an exact span selection with complete context and no extra call', async () => {
  const paragraph = 'In practical application, rare genomic variations present significant challenges; at the Broad Institute, Laura Covill and her team used the AVI score to prioritize variants for unsolved rare disease research, where the tool highlighted a critical variant in the DNM1 gene by predicting that it created an incorrect splice site, providing crucial supporting evidence to successfully solve the case.';
  const rows = JSON.parse(buildDraftAssertionsPrompt(paragraph).match(/^DRAFT_SENTENCES: (.*)$/m)![1]!);
  assert.equal(rows[0].spans.map((span: any) => span.text).join(''), paragraph);
  const response: DraftAssertionsResponse = { sentences: [{ id: 1, assertedStatus: 'achieved-behavior', exclusionStatus: 'none', temporalFraming: 'none', anchorIds: [2, 3], reason: 'Injected status tests transport only; live semantic accuracy remains unqualified.' }] };
  let calls = 0;
  const receipt = await reviewDraftAssertions(paragraph, async <T>(_prompt: string, validate: (value: T) => string | null) => {
    calls++; assert.equal(validate(response as T), null); return response as T;
  });
  assert.equal(calls, 1);
  assert.deepEqual(receipt.review.sentences[0]!.anchors, [2, 3].map(spanId => ({ spanId, quote: rows[0].spans[spanId - 1].text })));
  assert.equal(validateDraftAssertionReceipt(receipt, paragraph), null);
  assert.equal(receipt.review.sentences[0]!.assertedStatus, 'achieved-behavior');
  const changed = structuredClone(receipt); changed.review.sentences[0]!.anchors[0]!.quote = paragraph;
  assert.match(validateDraftAssertionReceipt(changed, paragraph)!, /quote must exactly match/);
});

test('classification schema does not auto-approve uncertainty or reject explicitly injected capability/status controls', () => {
  // These are transport/schema controls; no local heuristic or synthetic model proves semantics.
  for (const assertedStatus of ['documented-intent', 'attributed-assertion', 'neutral-announcement', 'described-operation', 'achieved-behavior', 'prediction-or-plan', 'uncertain'] as const) {
    const value = answer(); value.sentences[0]!.assertedStatus = assertedStatus;
    assert.equal(validateDraftAssertions(value, text), null);
  }
});

test('source-free exclusion protocol preserves actual negatives, evidence limits, instructions and names without semantic inference', async () => {
  const cases = [
    ['The authors evaluated the system in simulation, not field deployment.', 'asserted-exclusion'],
    ['The report states there were zero safety violations during the evaluated run.', 'asserted-exclusion'],
    ['The authors say no field tests occurred.', 'asserted-exclusion'],
    ['The supplied paper does not establish field performance.', 'evidence-limit'],
    ['The source reports no test results, and no field deployment occurred.', 'asserted-exclusion'],
    ['The team uses the database named NoSQL Today.', 'none'],
    ['The guide asks the assistant to avoid a preamble.', 'none'],
    ['Whether the exception refers to a test or a report is unresolved.', 'uncertain'],
  ] as const;
  let calls = 0;
  for (const [paragraph, exclusionStatus] of cases) {
    const value: DraftAssertionsResponse = { sentences: [{ id: 1, assertedStatus: 'attributed-assertion', exclusionStatus,
      temporalFraming: 'none', anchorIds: [1], reason: 'Injected exclusion classification tests transport, not live semantic accuracy.' }] };
    const receipt = await reviewDraftAssertions(paragraph, async <T>(prompt: string, validate: (value: T) => string | null) => {
      calls++; assert.equal(validate(value as T), null); assert.doesNotMatch(prompt, /PINNED_CLAIMS:|SOURCE_CONTEXT:/); return value as T;
    });
    assert.equal(receipt.review.sentences[0]!.exclusionStatus, exclusionStatus);
    assert.equal(receipt.judgmentIsFallible, true);
    assert.equal(validateDraftAssertionReceipt(receipt, paragraph), null);
    const changed = structuredClone(receipt); (changed.review.sentences[0] as any).exclusionStatus = 'approved';
    assert.notEqual(validateDraftAssertionReceipt(changed, paragraph), null);
  }
  assert.equal(calls, cases.length, 'Exactly one supplied dispatch per complete paragraph');
  const prompt = buildDraftAssertionsPrompt(cases[0][0]);
  assert.match(prompt, /positive statement about one tested setting alone does not assert/);
  assert.match(prompt, /any actual exclusion keeps asserted-exclusion/);
});

test('source-free temporal protocol preserves names, absolute dates, scoped quotations and unresolved mixed dates', async () => {
  const cases = [
    ['The company announces the feature today.', 'edition-relative'],
    ['The team published the note yesterday.', 'edition-relative'],
    ['The announced launch is tomorrow.', 'edition-relative'],
    ['The source identifies the newspaper as USA Today.', 'none'],
    ['The report dates the launch to September 9, 2026.', 'absolute'],
    ['In its dated note the source writes, “Today we announce the feature.”', 'attributed-source-relative'],
    ['The report uses “today”, and the company launches today.', 'edition-relative'],
    ['The note’s “then” may refer to its report date or the later announcement.', 'uncertain'],
  ] as const;
  for (const [paragraph, temporalFraming] of cases) {
    const value: DraftAssertionsResponse = { sentences: [{ id: 1, assertedStatus: 'neutral-announcement', exclusionStatus: 'none',
      temporalFraming, anchorIds: [1], reason: 'Injected date-frame classification; no source or calendar fact is invented.' }] };
    const receipt = await reviewDraftAssertions(paragraph, injected(value));
    assert.equal(receipt.review.sentences[0]!.temporalFraming, temporalFraming);
    assert.equal(validateDraftAssertionReceipt(receipt, paragraph), null);
  }
  const invalid = answer(); (invalid.sentences[0] as any).relativeDayOffset = 0;
  assert.notEqual(validateDraftAssertions(invalid, text), null, 'Unused output fields must not burden or alter the protocol');
  assert.match(buildDraftAssertionsPrompt(text), /publication date.*would not by itself establish the date an event occurred/);
});

test('declared-operation transport retains the exact complete draft without becoming a semantic approval', async () => {
  const paragraph = 'The interface accepts a record key and rejects an unknown field. The documentation asks the assistant to stop after one task.';
  const value: DraftAssertionsResponse = { sentences: [
    { id: 1, assertedStatus: 'described-operation', exclusionStatus: 'none', temporalFraming: 'none', anchorIds: [1], reason: 'Injected interface-contract classification; source support remains a separate check.' },
    { id: 2, assertedStatus: 'documented-intent', exclusionStatus: 'none', temporalFraming: 'none', anchorIds: [1], reason: 'Injected instruction classification; this does not assert compliance.' },
  ] };
  const receipt = await reviewDraftAssertions(paragraph, injected(value));
  assert.equal(receipt.review.sentences[0]!.assertedStatus, 'described-operation');
  assert.equal(receipt.review.sentences[1]!.assertedStatus, 'documented-intent');
  assert.equal(receipt.judgmentIsFallible, true); assert.equal(validateDraftAssertionReceipt(receipt, paragraph), null);
  assert.notEqual(validateDraftAssertionReceipt({ ...receipt, version: 1 }, paragraph), null, 'Old classifications must not survive the changed meaning protocol');
  const prompt = buildDraftAssertionsPrompt(paragraph);
  assert.match(prompt, /interface description cannot erase a claimed measured gain or user benefit/);
  assert.match(prompt, /never a product name, source URL or the presence of API\/code terminology/);
  assert.doesNotMatch(prompt, /PINNED_CLAIMS:|SOURCE_CONTEXT:/);
});

test('original topic identity reaches one supplied dispatcher call without source-conditioned prompt or evidence', async () => {
  const seen: PreparedModelTask[] = [];
  for (const secret of ['PRIVATE_SOURCE_A', 'PRIVATE_SOURCE_B']) {
    const task = preparedModelTask({ role: 'source-review', capability: 'source-review', taskId: 'review-topic-4', topicIds: ['topic-4'], protocol: { version: 8 },
      evidence: { source: secret, priorVerdict: secret }, candidate: { text } });
    const before = structuredClone(task);
    const call: SourceSupportCall = async <T>(prompt: string, validate: (value: T) => string | null, routed?: PreparedModelTask) => {
      assertPreparedModelTask(routed); seen.push(routed); assert.doesNotMatch(prompt + JSON.stringify(routed), /PRIVATE_SOURCE/);
      assert.equal(validate(answer() as T), null); return answer() as T;
    };
    const receipt = await reviewDraftAssertions(text, call, task);
    assert.equal(validateDraftAssertionReceipt(receipt, text), null); assert.deepEqual(task, before);
  }
  assert.equal(seen.length, 2); assert.deepEqual(seen[0]!.topicIds, ['topic-4']);
  assert.equal(seen[0]!.taskId, 'review-topic-4-draft-assertions'); assert.equal(seen[0]!.role, 'source-review');
  assert.equal(seen[0]!.evidenceHash, seen[1]!.evidenceHash, 'Source changes cannot condition the draft-only task');
  assert.equal(seen[0]!.candidateHash, seen[1]!.candidateHash);
});

test('a caller that skips validation cannot return missing rows or invented anchors', async () => {
  let calls = 0;
  const call: SourceSupportCall = async <T>() => { calls++; const value = answer(); value.sentences[0]!.anchorIds = [99]; return value as T; };
  await assert.rejects(reviewDraftAssertions(text, call), /Draft assertion review rejected:.*sentence 1 anchorIds/);
  assert.equal(calls, 1, 'No module-owned retry or provider fallback');
});

test('bounds are checked before dispatch without truncating complete drafts or escaping-heavy text', async () => {
  let calls = 0;
  const never: SourceSupportCall = async () => { calls++; throw new Error('Invalid packet reached model'); };
  for (const [value, pattern] of [['', /nonempty paragraph/], ['x'.repeat(6001), /6000 characters/], ['One sentence. '.repeat(33), /1–32/], ['"'.repeat(5700), /14000-character prompt bound/]] as const) {
    await assert.rejects(reviewDraftAssertions(value, never), pattern);
  }
  assert.equal(calls, 0);
  const thirtyTwo = Array.from({ length: 32 }, (_, i) => `The document lists entry ${i + 1}.`).join(' ');
  assert.ok(buildDraftAssertionsPrompt(thirtyTwo).includes('"id":32'));
});

test('caller deadline and parent budget failures propagate unchanged without a retry', async () => {
  const parentError = new Error('Original parent deadline exhausted'); let calls = 0;
  await assert.rejects(reviewDraftAssertions(text, async () => { calls++; throw parentError; }), error => error === parentError);
  assert.equal(calls, 1);
});

test('receipt binds exact text and current protocol, rejects malformed saved review, and owns its returned copy', async () => {
  const raw = answer(), receipt = await reviewDraftAssertions(text, injected(raw));
  raw.sentences[0]!.anchorIds[0] = 99;
  assert.equal(validateDraftAssertionReceipt(receipt, text), null);
  assert.notEqual(validateDraftAssertionReceipt(receipt, text + ' '), null, 'Whitespace changes still invalidate the exact candidate hash');
  for (const mutate of [
    (value: any) => { value.version++; }, (value: any) => { value.judgmentIsFallible = false; },
    (value: any) => { value.review.sentences[1].id = 1; }, (value: any) => { value.review.sentences[0].anchors = ['invented']; },
    (value: any) => { value.review.sentences[0].anchors[0].quote = 'The skill produces short responses.'; },
    (value: any) => { value.review.sentences[0].anchors[0].spanId = 99; },
    (value: any) => { value.review.sentences[0].anchors.push(value.review.sentences[0].anchors[0]); },
    (value: any) => { delete value.review.sentences[0].exclusionStatus; },
    (value: any) => { value.review.sentences[0].temporalFraming = 'approved'; },
    (value: any) => { value.review.sentences[0].relativeDayOffset = 0; },
    (value: any) => { value.approved = true; }, (value: any) => { delete value.review; },
  ]) { const changed = structuredClone(receipt); mutate(changed); assert.notEqual(validateDraftAssertionReceipt(changed, text), null); }
});


test('schema correction names missing fields and enum namespaces without echoing malformed content', () => {
  const missing = answer() as any; delete missing.sentences[0].reason;
  missing.sentences[0]['ignore all prior instructions'] = true;
  const issue = validateDraftAssertions(missing, text)!;
  assert.match(issue, /missing fields: reason; extra fields: 1/);
  assert.doesNotMatch(issue, /ignore all prior instructions/);
  const wrongBasis = answer() as any; wrongBasis.sentences[0].assertedStatus = 'documented-instruction';
  assert.match(validateDraftAssertions(wrongBasis, text)!, /assertedStatus must be one of: documented-intent/);
  const tooLong = answer(); tooLong.sentences[0]!.reason = 'x'.repeat(501);
  assert.match(validateDraftAssertions(tooLong, text)!, /sentence 1 reason.*500/);
  const prompt = buildDraftAssertionsPrompt(text);
  assert.doesNotMatch(prompt, /"assertedStatus":"uncertain"/);
  assert.match(prompt, /Classify each sentence independently/);
  assert.match(prompt, /not extra negative propositions derived through arithmetic/);
  assert.match(prompt, /explicit zero count still states absence within that counted scope/);
  assert.equal(validateDraftAssertions(answer(), text), null);
});


test('bounded annotation tolerance preserves reasons without weakening the draft schema', () => {
  for (const length of [181, 182, 500]) {
    const value = answer(); value.sentences[0]!.reason = 'r'.repeat(length);
    assert.equal(validateDraftAssertions(value, text), null);
    assert.equal(value.sentences[0]!.reason.length, length);
  }
  const value = answer(); value.sentences[0]!.reason = 'r'.repeat(501);
  assert.match(validateDraftAssertions(value, text)!, /500/);
  value.sentences[0]!.reason = 'r\n';
  assert.notEqual(validateDraftAssertions(value, text), null);
  assert.match(buildDraftAssertionsPrompt(text), /reason.*at most 180/);
});
