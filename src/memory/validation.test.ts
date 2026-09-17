import assert from 'node:assert/strict';
import test from 'node:test';
import { boundRecall, canonicalMemoryJson, coverageRequestIdentity, coverageTransition, memoryRecord, storyContentIdentity, validateCoverageRecord, validateMemoryQuery, validateMemoryWrite, validateScope } from './validation.js';
import type { CoverageRecord, MemoryRecord, MemoryWrite, StoredStory } from './types.js';
const scope = { workspaceId: 'a', publicationId: 'sports', actorId: 'owner' };
const write = (extra: Partial<MemoryWrite> = {}): MemoryWrite => ({ key: 'style', kind: 'semantic', text: 'Keep conditions with their facts.', status: 'approved', evidenceRefs: ['operator'], tags: ['style'], effectiveAt: 100, expiresAt: null, expectedRevision: null, ...extra });
const held: CoverageRecord = { idempotencyKey: 'one', storyId: 'event', runId: 'run', kind: 'story', status: 'reserved', updatedAt: 100, expiresAt: 200 };

test('approval cannot promote unverified procedures/lessons or injected scope/record fields', () => {
  assert.throws(() => validateMemoryWrite(write({ kind: 'procedural' }), 100), /evidence and verification/);
  assert.throws(() => validateMemoryWrite(write({ kind: 'episodic', verificationRef: 'test', evidenceRefs: [] }), 100), /evidence and verification/);
  assert.throws(() => validateScope({ ...scope, admin: true } as any), /unexpected/);
  assert.throws(() => validateMemoryWrite({ ...write(), approvedBy: 'model' } as any, 100), /unexpected/);
  const record = memoryRecord(write(), null, scope, 100); assert.equal(record.approvedBy, 'owner');
  assert.throws(() => memoryRecord(write({ kind: 'working', expectedRevision: 1 }), record, scope, 101), /cannot change kind/);
});

test('same write retries are idempotent while old distinct edits conflict', () => {
  const first = memoryRecord(write(), null, scope, 100);
  assert.deepEqual(memoryRecord(write(), first, scope, 101), first);
  const changed = write({ text: 'A corrected preference.', expectedRevision: 1 });
  const second = memoryRecord(changed, first, scope, 102);
  assert.equal(second.revision, 2); assert.deepEqual(memoryRecord(changed, second, scope, 103), second);
  assert.throws(() => memoryRecord(write({ text: 'Competing change.', expectedRevision: 1 }), second, scope, 104), /revision conflict/);
  assert.throws(() => memoryRecord(write({ text: second.text, expectedRevision: 900 }), second, scope, 105), /revision conflict/);
});

test('recall bounds count complete UTF8 JSON records and never truncate qualifiers', () => {
  const approved = memoryRecord(write({ text: 'é condition: only simulated.' }), null, scope, 100);
  const size = Buffer.byteLength(JSON.stringify([approved]));
  assert.deepEqual(boundRecall([approved], { kinds: ['semantic'], now: 100, limit: 1, maxBytes: size - 1 }), []);
  assert.deepEqual(boundRecall([approved], { kinds: ['semantic'], now: 100, limit: 1, maxBytes: size }), [approved]);
  const stale: MemoryRecord = { ...approved, expiresAt: 100 };
  assert.deepEqual(boundRecall([stale, { ...approved, effectiveAt: 101 }, { ...approved, status: 'proposed' }], { kinds: ['semantic'], now: 100, limit: 10, maxBytes: 4096 }), []);
  assert.throws(() => validateMemoryQuery({ kinds: ['semantic'], now: 100, limit: 10000, maxBytes: 10000000 }), /bound/);
});

test('canonical identities survive JSONB key order without changing exact source text', () => {
  const value: StoredStory = { id: 'one', event: { version: 1, primaryUrl: 'https://example.com/event', claims: [], revisions: [] }, canonicalUrls: ['https://example.com/event'], entities: ['Lab'], sourceHashes: ['a'.repeat(64)], observedAt: 100 };
  const reordered = JSON.parse(canonicalMemoryJson(value)); reordered.observedAt = 200;
  assert.equal(storyContentIdentity(value), storyContentIdentity(reordered));
  assert.equal(coverageRequestIdentity(held), coverageRequestIdentity(JSON.parse(canonicalMemoryJson({ ...held, updatedAt: 150 }))));
  assert.notEqual(storyContentIdentity(value), storyContentIdentity({ ...value, entities: ['lab'] }));
});

test('trusted-clock transitions refuse backdated expired submissions but permit late confirmed receipts', () => {
  assert.throws(() => coverageTransition(held, { idempotencyKey: 'one', expectedStatus: 'reserved', status: 'submitted-unconfirmed', now: 150 }, 300), /expired/);
  assert.throws(() => coverageTransition(held, { idempotencyKey: 'one', expectedStatus: 'reserved', status: 'submitted-unconfirmed', now: 301 }, 300), /future/);
  const published = coverageTransition(held, { idempotencyKey: 'one', expectedStatus: 'reserved', status: 'published', now: 300, receipt: { provider: 'test', remoteId: 'confirmed-1', confirmedAt: 250 } }, 300);
  assert.equal(published.status, 'published'); assert.equal(published.expiresAt, null);
  assert.throws(() => validateCoverageRecord({ ...held, status: 'published' }), /new coverage/);
});

test('unconfirmed delivery never expires and cancellation requires unchanged reconciliation proof', () => {
  const uncertain = coverageTransition(held, { idempotencyKey: 'one', expectedStatus: 'reserved', status: 'submitted-unconfirmed', now: 150 }, 150);
  assert.equal(uncertain.expiresAt, null);
  assert.throws(() => coverageTransition(uncertain, { idempotencyKey: 'one', expectedStatus: 'submitted-unconfirmed', status: 'cancelled', now: 10000 }, 10000), /reconciliation/);
  const change = { idempotencyKey: 'one', expectedStatus: 'submitted-unconfirmed' as const, status: 'cancelled' as const, now: 10000, resolution: { kind: 'confirmed-not-submitted' as const, reference: 'remote-query-no-send' } };
  const cancelled = coverageTransition(uncertain, change, 10000);
  assert.deepEqual(coverageTransition(cancelled, change, 10001), cancelled);
  assert.throws(() => coverageTransition(cancelled, { ...change, resolution: undefined }, 10001), /proof changed/);
});
