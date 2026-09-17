import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSourceReviewDispute, SourceReviewDisputeError } from './review-dispute.js';
import { assertNoUnresolvedReviewDispute, persistSourceReviewDispute } from './persist-review-dispute.js';
import { ensureSourceSupportedFields } from './field-support.js';
import { preparedModelTask } from './writing-task.js';

const claim = 'Both clubs appoint a scorekeeper and a separate official operates the clock.';
function dispute() {
  return new SourceReviewDisputeError(createSourceReviewDispute(claim, [claim], {
    sentences: [{ id: 1, supported: false, claimIds: [], reason: 'No official is identified.' }],
  }, { stage: 'general' })!);
}
test('production dispute persists exact candidate and review once, without replacing or approving them', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-dispute-'));
  const options = { root, parentId: 'test-parent', parentIdentity: 'a'.repeat(64), stage: 'newsletter' as const };
  try {
    const first = dispute();
    assert.throws(() => persistSourceReviewDispute(first, options), error => error === first && /Preserved review evidence/.test(first.message));
    const dir = join(root, 'state/review-disputes/test-parent');
    const pointer = JSON.parse(readFileSync(join(dir, 'newsletter-latest.json'), 'utf8'));
    const bytes = readFileSync(pointer.receipt, 'utf8');
    const receipt = JSON.parse(bytes);
    assert.equal(receipt.dispute.candidate.text, claim);
    assert.equal(receipt.dispute.review.sentences[0].supported, false);
    assert.equal(receipt.status, 'disputed');
    assert.throws(() => assertNoUnresolvedReviewDispute(root, 'test-parent', 'newsletter'), /no new writing attempt/);
    assert.doesNotThrow(() => assertNoUnresolvedReviewDispute(root, 'test-parent', 'script'));
    assert.doesNotThrow(() => assertNoUnresolvedReviewDispute(root, 'other-parent', 'newsletter'));
    assert.throws(() => persistSourceReviewDispute(dispute(), options), SourceReviewDisputeError);
    assert.equal(readFileSync(pointer.receipt, 'utf8'), bytes);
    assert.equal(readdirSync(dir).length, 2);
    writeFileSync(pointer.receipt, '{}');
    assert.throws(() => persistSourceReviewDispute(dispute(), options), /original evidence cannot be overwritten/);
    assert.equal(readFileSync(pointer.receipt, 'utf8'), '{}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('dispute persistence preserves unrelated exceptions and refuses evidence outside the workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-dispute-')), outside = mkdtempSync(join(tmpdir(), 'review-dispute-other-'));
  const options = { root, parentId: 'test-parent', parentIdentity: 'a'.repeat(64), stage: 'script' as const };
  try {
    const original = new Error('Original transport failure');
    assert.throws(() => persistSourceReviewDispute(original, options), error => error === original);
    symlinkSync(outside, join(root, 'state'));
    assert.throws(() => persistSourceReviewDispute(dispute(), options), /Symlink leaves workspace/);
    assert.deepEqual(readdirSync(outside), []);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
test('changed derived hashes or findings cannot be saved under the original dispute identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-dispute-'));
  try {
    for (const mutate of [(d: ReturnType<typeof dispute>['dispute']) => { d.candidate.sha256 = 'b'.repeat(64); },
      (d: ReturnType<typeof dispute>['dispute']) => { d.findings[0]!.reason = 'Changed finding'; }]) {
      const changed = structuredClone(dispute().dispute); mutate(changed);
      assert.throws(() => persistSourceReviewDispute(new SourceReviewDisputeError(changed), {
        root, parentId: 'test-parent', parentIdentity: 'a'.repeat(64), stage: 'script',
      }), /evidence changed before saving/);
    }
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('an exact-source field rejection is preserved without automatic acceptance, repair or critic retry', async () => {
  let calls = 0;
  const input = [{ id: 'explanation', text: claim }, { id: 'label', text: 'Match officials' }];
  const task = preparedModelTask({ role: 'source-review', capability: 'source-review', taskId: 'field-regression', topicIds: ['sports'], protocol: { version: 1 }, evidence: { claims: [claim] } });
  await assert.rejects(ensureSourceSupportedFields(input, [claim], async <T>(_prompt: string, validate: (value: T) => string | null) => {
    calls++;
    const value = { fields: input.map(field => ({ id: field.id, supported: field.id !== 'explanation', claimIds: field.id === 'explanation' ? [] : [1], reason: 'The source does not name a clock official.' })) } as T;
    assert.equal(validate(value), null);
    return value;
  }, { task, context: { narration: claim }, validateFinal: () => null }), (error: unknown) => {
    assert.ok(error instanceof SourceReviewDisputeError);
    assert.equal(error.dispute.review.sentences[0]!.supported, false);
    assert.deepEqual(error.dispute.review.sentences[0]!.claimIds, []);
    assert.deepEqual(error.dispute.presentation?.fields, input);
    return true;
  });
  assert.equal(calls, 1);
});
