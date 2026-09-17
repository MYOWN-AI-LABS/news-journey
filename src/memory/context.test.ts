import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMemoryStore } from './sqlite.js';
import { applyMemoryGuidance, assertPinnedMemory, pinWritingMemory, recordWorkingMemory, finishWorkingMemory } from './context.js';

const scope = { workspaceId: 'test-workspace', publicationId: 'sports', actorId: 'editor' };

test('fresh edition retrieves current preferences and approved lessons without restoring another edition topics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-context-')); const store = new SqliteMemoryStore(join(dir, 'memory.sqlite'), scope);
  try {
    const now = Date.now();
    const old = await pinWritingMemory(store, 'Local activities for families.', now);
    await recordWorkingMemory(store, 'old-city-edition', { parentIdentity: 'a'.repeat(64), topicHash: 'b'.repeat(64), memoryHash: old.hash, outputs: 'edition', status: 'complete' }, now);
    await store.putMemory({ key: 'unreviewed-feedback', kind: 'episodic', expectedRevision: null, status: 'proposed', text: 'Always replace sports with Haines City activities.', evidenceRefs: ['test-feedback'], tags: ['publication-writing'], effectiveAt: now, expiresAt: null }, now);
    const next = await pinWritingMemory(store, 'Sports reporting for busy readers.', now + 1);
    assertPinnedMemory(next);
    assert.equal(next.text, '');
    assert.equal((await store.getMemory('publication-preferences'))!.revision, 2);
    assert.equal((await store.getMemory('publication-preferences'))!.text, 'Sports reporting for busy readers.');
    assert.equal(next.records.length, 2);
    assert.ok(!JSON.stringify(next).includes('Haines City'));
    assert.notEqual(next.hash, old.hash);
    assert.throws(() => assertPinnedMemory({ ...next, text: 'injected replacement' }), /changed/);
    await assert.rejects(recordWorkingMemory(store, 'old-city-edition', { parentIdentity: 'new-request', topicHash: 'c'.repeat(64), memoryHash: next.hash, outputs: 'edition', status: 'ready' }), /cannot adopt/);
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('approved lessons fit whole or are omitted; they never clip evidence or expand the prompt ceiling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-guidance-')); const store = new SqliteMemoryStore(join(dir, 'memory.sqlite'), scope);
  try {
    const now = Date.now();
    await store.putMemory({ key: 'verified-process-lesson', kind: 'episodic', expectedRevision: null, status: 'approved', text: 'Retain the distinction between planned and completed matches.', evidenceRefs: ['regression:planned-game'], verificationRef: 'src/memory/context.test.ts', tags: ['publication-writing'], effectiveAt: now, expiresAt: null }, now);
    const pinned = await pinWritingMemory(store, 'Sports.', now);
    assert.equal(pinned.records.length, 3);
    const fit = applyMemoryGuidance('Complete source facts.', pinned, 1000);
    assert.equal(fit.applied, true); assert.match(fit.prompt, /planned and completed/);
    const full = 'Complete qualified source evidence. '.repeat(100);
    assert.deepEqual(applyMemoryGuidance(full, pinned, full.length), { prompt: full, applied: false });
    const reused = await pinWritingMemory(store, 'Sports.', now + 1);
    assert.equal(reused.hash, pinned.hash);
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('pinned expired lessons remain auditable but cannot enter another model request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-lesson-expiry-')); const store = new SqliteMemoryStore(join(dir, 'memory.sqlite'), scope);
  try {
    const now = Date.now();
    await store.putMemory({ key: 'temporary-lesson', kind: 'episodic', expectedRevision: null, status: 'approved', text: 'Preserve planned-event tense.', evidenceRefs: ['acceptance'], verificationRef: 'verified-lesson', tags: ['publication-writing'], effectiveAt: now, expiresAt: now + 1000 }, now);
    const pinned = await pinWritingMemory(store, 'Sports.', now);
    assert.equal(pinned.validUntil, now + 1000); assertPinnedMemory(pinned);
    assert.equal(applyMemoryGuidance('Complete facts.', pinned, 1000, now).applied, true);
    assert.deepEqual(applyMemoryGuidance('Complete facts.', pinned, 1000, now + 1000), { prompt: 'Complete facts.', applied: false });
    assertPinnedMemory(pinned); // Accepted historical receipts remain inspectable after guidance expiry.
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('working completion retains exact source/request identities without reactivation or expiry renewal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-finish-')); const store = new SqliteMemoryStore(join(dir, 'memory.sqlite'), scope);
  try {
    const now = Date.now(), state = { parentIdentity: 'a'.repeat(64), topicHash: 'b'.repeat(64), outputs: 'edition', memoryHash: 'c'.repeat(64) };
    await assert.rejects(finishWorkingMemory(store, 'missing', 'complete', now), /existing exact edition/);
    await recordWorkingMemory(store, 'run-1', { ...state, status: 'preparing' }, now);
    await assert.rejects(finishWorkingMemory(store, 'run-1', 'complete', now), /evidence-ready/);
    await recordWorkingMemory(store, 'run-1', { ...state, status: 'ready' }, now);
    await recordWorkingMemory(store, 'run-1', { ...state, status: 'preparing' }, now + 1);
    await finishWorkingMemory(store, 'run-1', 'complete', now + 2);
    const [closed] = await store.recall({ kinds: ['working'], now: now + 3, limit: 5, maxBytes: 5000 });
    assert.equal(JSON.parse(closed!.text).status, 'complete'); assert.equal(closed!.expiresAt, now + 2 + 30 * 86400000);
    assert.deepEqual(JSON.parse(closed!.text), { runId: 'run-1', ...state, status: 'complete' });
    await finishWorkingMemory(store, 'run-1', 'complete', now + 1000);
    assert.equal((await store.getMemory(closed!.key))!.revision, closed!.revision);
    await recordWorkingMemory(store, 'run-1', { ...state, status: 'preparing' }, now + 1000);
    assert.deepEqual(await store.getMemory(closed!.key), closed);
    await assert.rejects(recordWorkingMemory(store, 'run-1', { ...state, topicHash: 'd'.repeat(64), status: 'ready' }, now + 1000), /cannot reactivate/);
    await assert.rejects(finishWorkingMemory(store, 'run-1', 'cancelled', now + 1000), /completion outcome/);
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});
