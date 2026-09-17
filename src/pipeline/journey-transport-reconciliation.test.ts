import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { roleHash, beginParentWork, reserveParentModelAttempt } from '../llm/role-router.js';
import { reconcileJourneyCliSchemaTransport } from './journey-transport-reconciliation.js';

test('schema recovery preserves accepted newsletter and consumed work, permits only one explicit exact-state transition', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-schema-reconcile-')), id = '20260915-example';
  const dir = join(root, 'workdir/videos', id); mkdirSync(dir, { recursive: true });
  const parentIdentity = 'a'.repeat(64);
  const script = { status: 'held', writes: 1, origin: 'model', candidates: [], reviews: [], failures: ['script writer unavailable: Codex CLI failed after retry: missing publish metadata'] };
  const artifacts = { newsletter: { status: 'accepted', writes: 1, candidates: [{ unchanged: 'accepted newsletter' }], reviews: [{ unchanged: 'original source review' }], failures: [] }, script };
  const checkpoint = { version: 1, identityHash: 'b'.repeat(64), artifacts, contentHash: roleHash(artifacts) };
  const cp = join(dir, 'journey-editorial-checkpoint.json');
  writeFileSync(cp, JSON.stringify(checkpoint)); writeFileSync(join(dir, 'writing-request.json'), JSON.stringify({ parentIdentity }));
  const parent = { root, parentId: id, parentIdentity, limits: { maxPhysicalCalls: 8, totalSeconds: 1800 }, now: () => 1000 };
  for (const attempt of [1, 2]) reserveParentModelAttempt(parent, 'failed-script', { provider: 'codex', model: 'fixed-model', attempt, rescue: false, promptBytes: 100 });
  const originalBudget = beginParentWork(parent);
  const options = { intent: 'retry-undelivered-cli-schema' as const, expectedCheckpointHash: roleHash(checkpoint), parentIdentity };
  try {
    assert.throws(() => reconcileJourneyCliSchemaTransport(root, id, { ...options, expectedCheckpointHash: 'c'.repeat(64) }), /changed/);
    assert.throws(() => reconcileJourneyCliSchemaTransport(root, id, { ...options, intent: 'automatic retry' as never }), /explicit intent/);
    const receipt = reconcileJourneyCliSchemaTransport(root, id, options);
    const after = JSON.parse(readFileSync(cp, 'utf8'));
    assert.deepEqual(receipt.originalCheckpoint, checkpoint); assert.deepEqual(after.artifacts.newsletter, artifacts.newsletter);
    assert.deepEqual(after.artifacts.script, { ...script, status: 'repair' });
    assert.equal(after.identityHash, checkpoint.identityHash); assert.equal(after.contentHash, roleHash(after.artifacts));
    assert.deepEqual(beginParentWork(parent), originalBudget); assert.equal(originalBudget.physicalAttempts, 2);
    assert.equal(readdirSync(dir).filter(name => name.startsWith('journey-editorial-transport-reconciliation-')).length, 1);
    assert.throws(() => reconcileJourneyCliSchemaTransport(root, id, options), /changed/);
    assert.throws(() => reconcileJourneyCliSchemaTransport(root, id, { ...options, expectedCheckpointHash: roleHash(after) }), /exact first/);
    assert.deepEqual(JSON.parse(readFileSync(cp, 'utf8')), after);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
