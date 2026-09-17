import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSourceReviewDispute, assertSourceReviewUndisputed, adjudicateSourceReviewDispute, resolveSourceReviewDispute, SourceReviewDisputeError } from './review-dispute.js';
import { createSourceSupportContext, ensureSourceSupportedText, reviewSourceSupport, type SourceSupportCall, type SourceSupportReview } from './source-support.js';
import { syntheticPassingFactualResponse } from './factual-obligations.test-fixture.js';
import { preparedScriptReceipt, assertPreparedScriptReceipt } from './writing-context.js';
import type { Topic } from '../types.js';

interface Replay {
  provenance: { resultSha256: string; inputSha256: string; independentAuditModel: null; originalIncomplete: string };
  claims: string[];
  draft: string;
  recordedReviews: SourceSupportReview['sentences'];
  expectedFalseRejections: number[];
  expectedWrongEvidenceApprovals: { sentenceId: number; reportedClaimIds: number[]; exactClaimIds: number[] }[];
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/harbor-league-review-disputes.json', import.meta.url), 'utf8')) as Replay;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const isDispute = (error: unknown): error is SourceReviewDisputeError => error instanceof SourceReviewDisputeError && error.code === 'SOURCE_REVIEW_DISPUTED';

test('the committed historical replay preserves the complete source-faithful candidate and incomplete-review provenance', () => {
  assert.equal(fixture.draft, fixture.claims.join(' '));
  assert.equal(fixture.draft.split(/\s+/).length, 414);
  assert.equal(fixture.claims.length, 16);
  assert.equal(fixture.recordedReviews.length, 12, 'The unreturned fourth batch is not fabricated');
  assert.match(fixture.provenance.resultSha256, /^[a-f0-9]{64}$/);
  assert.match(fixture.provenance.inputSha256, /^[a-f0-9]{64}$/);
  assert.equal(fixture.provenance.independentAuditModel, null, 'Historic audit cannot be relabeled Astra');
  assert.match(fixture.provenance.originalIncomplete, /timed out/);
});

test('replay identifies all five false rejections and three wrong-ID approvals without changing the critic or candidate', () => {
  const review = { sentences: structuredClone(fixture.recordedReviews) };
  const before = structuredClone(review);
  const receipt = createSourceReviewDispute(fixture.draft, fixture.claims, review, { stage: 'general' });
  assert.ok(receipt);
  assert.equal(receipt.status, 'disputed');
  assert.equal(receipt.candidate.text, fixture.draft);
  assert.equal(receipt.candidate.sha256, hash(fixture.draft));
  assert.deepEqual(receipt.claims, fixture.claims.map((text, i) => ({ id: i + 1, text })));
  assert.deepEqual(receipt.review, before);
  assert.deepEqual(review, before);
  assert.deepEqual(receipt.findings.filter(row => row.kind === 'exact-source-rejection').map(row => row.sentenceId), fixture.expectedFalseRejections);
  assert.deepEqual(receipt.findings.filter(row => row.kind === 'citation-mismatch').map(row => ({ sentenceId: row.sentenceId,
    reportedClaimIds: row.citedClaimIds, exactClaimIds: row.exactClaimIds })), fixture.expectedWrongEvidenceApprovals);
  assert.equal(receipt.findings.length, 8);
  for (const finding of receipt.findings) {
    const original = fixture.recordedReviews.find(row => row.id === finding.sentenceId)!;
    assert.equal(finding.sentence, fixture.claims[finding.sentenceId - 1]);
    assert.equal(finding.reason, original.reason);
    assert.deepEqual(finding.citedClaimIds, original.claimIds);
  }
  assert.throws(() => assertSourceReviewUndisputed(fixture.draft, fixture.claims, review, { stage: 'general' }), isDispute);
});

test('valid but incorrect supporting IDs are disputed even when every supplied critic verdict is positive', () => {
  const wrongIds = new Set(fixture.expectedWrongEvidenceApprovals.map(row => row.sentenceId));
  const review = { sentences: fixture.recordedReviews.filter(row => wrongIds.has(row.id)) };
  assert.ok(review.sentences.every(row => row.supported));
  const result = createSourceReviewDispute(fixture.draft, fixture.claims, review, { stage: 'general' });
  assert.ok(result);
  assert.equal(result.findings.length, 3);
  assert.ok(result.findings.every(row => row.kind === 'citation-mismatch'));
  assert.deepEqual(result.review, review, 'Do not silently replace the original citations with convenient correct IDs');
});

test('reordered claim IDs are associated by exact text and never assumed equal to sentence IDs', () => {
  const claims = [...fixture.claims].reverse();
  const general = { sentences: [{ id: 5, supported: false, claimIds: [], reason: 'Injected denial of the games claim.' }] };
  const result = createSourceReviewDispute(fixture.draft, claims, general, { stage: 'general' });
  assert.ok(result);
  assert.deepEqual(result.findings[0]!.exactClaimIds, [12]);
  const correct = { sentences: [{ id: 5, supported: true, claimIds: [12], reason: 'The actual reordered games claim.' }] };
  assert.equal(createSourceReviewDispute(fixture.draft, claims, correct, { stage: 'general' }), null);
});

test('absence of an exact match cannot decide support for a faithful paraphrase or overlapping invented benefit', () => {
  const claims = ['The city council scheduled four games for Saturday.'];
  for (const text of ['Four games are scheduled for Saturday by the city council.', 'The city council scheduled four games for Saturday to improve attendance.']) {
    for (const supported of [true, false]) {
      const review = { sentences: [{ id: 1, supported, claimIds: supported ? [1] : [], reason: 'Injected semantic verdict for separate review.' }] };
      assert.equal(createSourceReviewDispute(text, claims, review, { stage: 'general' }), null,
        'A null dispute receipt is neither entailment nor approval; semantic review is still required');
    }
  }
});

test('one matching duplicate claim is sufficient citation alignment but does not grant factual acceptance', () => {
  const text = 'The league scheduled four games.';
  const review = { sentences: [{ id: 1, supported: true, claimIds: [2], reason: 'The second identical source claim.' }] };
  assert.equal(createSourceReviewDispute(text, [text, text], review, { stage: 'general' }), null);
});

test('the general review boundary holds an exact-source contradiction after one call without same-critic retry', async () => {
  const text = fixture.claims[4]!;
  let calls = 0;
  const call: SourceSupportCall = async <T>(_prompt: string, validate: (value: T) => string | null) => {
    calls++;
    const review = { sentences: [{ ...fixture.recordedReviews[4]!, id: 1 }] };
    assert.equal(validate(review as T), null, 'Unsupported rows with empty IDs remain schema-legal');
    return review as T;
  };
  await assert.rejects(reviewSourceSupport(text, [text], call, { mode: 'short-batches' }), error => {
    assert.ok(isDispute(error));
    assert.equal(error.dispute.review.sentences[0]!.supported, false);
    assert.deepEqual(error.dispute.review.sentences[0]!.claimIds, fixture.recordedReviews[4]!.claimIds);
    return true;
  });
  assert.equal(calls, 1, 'The same critic is not called again to resolve its own dispute');
});

test('missing citation IDs on an approval remain a validation failure, distinct from valid wrong evidence IDs', async () => {
  const text = fixture.claims[4]!;
  let calls = 0;
  await assert.rejects(reviewSourceSupport(text, [text], async <T>(_prompt: string, validate: (value: T) => string | null) => {
    calls++;
    const review = { sentences: [{ id: 1, supported: true, claimIds: [], reason: 'Injected empty approval citation.' }] };
    assert.notEqual(validate(review as T), null);
    return review as T;
  }), error => {
    assert.ok(error instanceof Error);
    assert.ok(!isDispute(error));
    assert.match(error.message, /claim|support/i);
    return true;
  });
  assert.equal(calls, 1);
});

test('an exact-source contradiction stops before acceptance, same-critic retry or repair', async () => {
  const text = fixture.claims[4]!;
  const calls: string[] = [];
  let finalChecks = 0;
  const call: SourceSupportCall = async <T>(prompt: string, validate: (value: T) => string | null) => {
    calls.push(prompt.split('\n')[0]!);
    const focused = syntheticPassingFactualResponse(prompt);
    const response = focused ?? { sentences: [{ ...fixture.recordedReviews[4]!, id: 1 }] };
    assert.equal(validate(response as T), null);
    return response as T;
  };
  await assert.rejects(ensureSourceSupportedText(text, [text], call, () => { finalChecks++; return null; }), isDispute);
  assert.deepEqual(calls, ['DRAFT ASSERTIONS REVIEW', 'FACTUAL CONDITIONS REVIEW', 'FACTUAL MODALITY AND DATE REVIEW', 'SOURCE SUPPORT REVIEW']);
  assert.equal(finalChecks, 0, 'A disputed draft never reaches final acceptance');
  assert.ok(!calls.includes('SOURCE SUPPORT REPAIR'));
});

test('an exact copied claim never bypasses a specialist finding about a missing external condition', async () => {
  const text = 'The store accepts an equal event time.';
  const url = 'https://fixtures.example.com/store';
  const context = createSourceSupportContext('2026-09-14', url, [{ url, publishedAt: '2026-09-13',
    sha256: 'a'.repeat(64), textSha256: 'b'.repeat(64),
    restrictions: [{ sourceSentenceId: 43, text: 'Persistence requires an event time strictly later than the stored time.' }] }]);
  const calls: string[] = [];
  const call: SourceSupportCall = async <T>(prompt: string, validate: (value: T) => string | null) => {
    calls.push(prompt.split('\n')[0]!);
    const response = syntheticPassingFactualResponse(prompt) as any;
    assert.ok(response, 'The focused failure stops before general review and repairs');
    if (prompt.startsWith('FACTUAL CONDITIONS REVIEW')) response.restrictions[0] = {
      id: 1, claimIds: [1], sentenceIds: [1], disposition: 'conflict', reason: 'Equal time does not retain the source persistence condition.',
    };
    assert.equal(validate(response as T), null);
    return response as T;
  };
  await assert.rejects(ensureSourceSupportedText(text, [text], call, undefined, undefined, { sourceContext: context }), error => {
    assert.ok(isDispute(error), String(error));
    assert.equal(error.dispute.stage, 'specialist');
    assert.deepEqual(error.dispute.sourceContext, context);
    assert.match(error.dispute.findings[0]!.reason, /Restriction 1 conflict/);
    assert.equal(error.dispute.review.factualObligations?.conditions.restrictions[0]!.disposition, 'conflict');
    return true;
  });
  assert.equal(calls.length, 3);
  assert.ok(!calls.includes('SOURCE SUPPORT REPAIR'));
});

test('an exact copied relative date stays blocked when the source day and edition day differ', async () => {
  const text = 'The league opens its new sports hall today with seating for eight hundred spectators.';
  const url = 'https://fixtures.example.com/dated-announcement';
  const context = createSourceSupportContext('2026-09-14', url, [{ url, publishedAt: '2026-09-13' }]);
  const calls: string[] = [];
  const call: SourceSupportCall = async <T>(prompt: string, validate: (value: T) => string | null) => {
    calls.push(prompt.split('\n')[0]!);
    const response = syntheticPassingFactualResponse(prompt) as any;
    assert.ok(response);
    if (prompt.startsWith('DRAFT ASSERTIONS REVIEW')) response.sentences[0].temporalFraming = 'edition-relative';
    if (prompt.startsWith('FACTUAL MODALITY AND DATE REVIEW')) response.sentences[0].temporalStatus = 'source-anchored';
    assert.equal(validate(response as T), null);
    return response as T;
  };
  await assert.rejects(ensureSourceSupportedText(text, [text], call, undefined, undefined, { sourceContext: context }), error => {
    assert.ok(isDispute(error), String(error));
    assert.equal(error.dispute.stage, 'specialist');
    assert.match(error.dispute.findings[0]!.reason, /Copied relative clock conflicts/);
    assert.deepEqual(error.dispute.sourceContext, context);
    return true;
  });
  assert.equal(calls.length, 3);
});


test('legacy resolution helpers cannot dismiss historical disputes or correct their citation IDs', () => {
  const review = { sentences: structuredClone(fixture.recordedReviews) }, before = structuredClone(review);
  const dispute = createSourceReviewDispute(fixture.draft, fixture.claims, review, { stage: 'general' })!;
  const adjudication = adjudicateSourceReviewDispute(dispute);
  assert.equal(adjudication.status, 'hold');
  assert.deepEqual(adjudication.findings, dispute.findings);
  assert.ok(!('reconciledReview' in adjudication));
  assert.throws(() => resolveSourceReviewDispute(fixture.draft, fixture.claims, review, { stage: 'general' }), isDispute);
  assert.deepEqual(review, before);
});

test('adjudication holds exact copies that still carry edition-relative today/yesterday/tomorrow', () => {
  const claim = 'Today, the source announces a catalogue that predicts molecular changes.';
  const review = { sentences: [{ id: 1, supported: false, claimIds: [], reason: 'Today relocates the announcement.' }] };
  const context = createSourceSupportContext('2026-09-09', 'https://research.example.org/announcement', [
    { url: 'https://research.example.org/announcement', publishedAt: '2026-09-08' },
  ]);
  const dispute = createSourceReviewDispute(claim, [claim], review, { stage: 'general', sourceContext: context })!;
  assert.ok(dispute);
  const adjudication = adjudicateSourceReviewDispute(dispute);
  assert.equal(adjudication.status, 'hold');
  assert.throws(() => resolveSourceReviewDispute(claim, [claim], review, { stage: 'general', sourceContext: context }), isDispute);
});

test('a middle-batch dispute preserves every returned original row and stops before later batches', async () => {
  const claims = Array.from({ length: 12 }, (_, i) => `The notice lists fixture item ${i + 1}.`), text = claims.join(' ');
  const returned: SourceSupportReview['sentences'] = []; let calls = 0;
  await assert.rejects(reviewSourceSupport(text, claims, async <T>(_prompt: string, validate: (value: T) => string | null) => {
    const start = calls++ * 4;
    const rows = claims.slice(start, start + 4).map((_, i) => ({ id: start + i + 1, supported: !(start === 4 && i === 0), claimIds: start === 4 && i === 0 ? [] : [start + i + 1], reason: start === 4 && i === 0 ? 'The claim is literal but attributed to the wrong event in this paragraph.' : 'The fixture claim supports this sentence.' }));
    returned.push(...structuredClone(rows)); const value = { sentences: rows };
    assert.equal(validate(value as T), null); return value as T;
  }, { mode: 'short-batches' }), error => {
    assert.ok(isDispute(error)); assert.equal(calls, 2);
    assert.deepEqual(error.dispute.review.sentences, returned);
    assert.equal(error.dispute.review.sentences.length, 8, 'The final unreturned batch is never invented');
    assert.equal(error.dispute.candidate.text, text); assert.deepEqual(error.dispute.claims.map(row => row.text), claims);
    assert.equal(error.dispute.findings[0]!.sentenceId, 5); return true;
  });
  assert.equal(calls, 2);
});

test('a positive review with valid but wrong citation IDs holds instead of being silently corrected', async () => {
  const claims = ['The league scheduled four games.', 'The council scheduled one meeting.'];
  const review = { sentences: [{ id: 1, supported: true, claimIds: [2], reason: 'Incorrect supplied citation.' }] };
  const before = structuredClone(review); let calls = 0;
  await assert.rejects(reviewSourceSupport(claims[0]!, claims, async <T>() => { calls++; return review as T; }), error => {
    assert.ok(isDispute(error)); assert.deepEqual(error.dispute.review, before);
    assert.deepEqual(error.dispute.findings[0]!.citedClaimIds, [2]); assert.deepEqual(error.dispute.findings[0]!.exactClaimIds, [1]); return true;
  });
  assert.equal(calls, 1); assert.deepEqual(review, before);
});

test('source17 field4 acceptance receipts cannot qualify under restored dispute guards', () => {
  const topic = { id: '20260915-dispute-cache', kind: 'news', headline: 'A fixture notice', stories: [{ verifiedClaims: ['The plan needs approval.'] }] } as Topic;
  const script = { body: [{ voiceover: 'The plan needs approval.' }] }, writerKey = 'unchanged-selected-writer';
  const current = preparedScriptReceipt(topic, writerKey, script);
  assert.equal(current.sourceSupportVersion, 18); assert.equal(current.fieldSupportVersion, 5);
  const historical = { ...current, sourceSupportVersion: 17, fieldSupportVersion: 4 };
  assert.throws(() => assertPreparedScriptReceipt(historical, topic, writerKey, script), /not bound/);
  assert.doesNotThrow(() => assertPreparedScriptReceipt(current, topic, writerKey, script));
  assert.equal(historical.sourceSupportVersion, 17, 'The saved historical receipt is not rewritten');
});
