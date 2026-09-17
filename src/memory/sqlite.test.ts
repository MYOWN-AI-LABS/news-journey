import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SqliteMemoryStore } from './sqlite.js';
import type { CoverageRecord, MemoryScope, MemoryWrite, StoredStory } from './types.js';

const scope: MemoryScope = { workspaceId: 'workspace-a', publicationId: 'sports', actorId: 'operator' };
const story = (id = 'match-1'): StoredStory => ({ id, event: { version: 1, primaryUrl: `https://example.com/${id}`, claims: [], revisions: [] }, canonicalUrls: [`https://example.com/${id}?date=2026-09-14`], entities: ['Example United'], sourceHashes: ['a'.repeat(64)], observedAt: 1000 });
function reviewedStory(id: string, changed: { hash?: string; day?: string } = {}): StoredStory {
  const day = changed.day ?? '2026-09-14', sourceHash = changed.hash ?? 'a'.repeat(64), claim = `Example United played Lakeside on ${day}.`;
  const support = (value: string) => ({ value, support: [{ sourceHash, claimId: 1, quote: claim }] });
  return { id, canonicalUrls: ['https://example.com/match'], entities: ['Example United'], sourceHashes: [sourceHash], observedAt: 1000,
    event: { version: 1, primaryUrl: 'https://example.com/match', claims: [claim], revisions: [{ url: 'https://example.com/match', role: 'primary', status: 200, sha256: sourceHash, textSha256: 'b'.repeat(64), observedAt: '2026-09-14T00:00:00Z' }],
      identity: { entity: support('Example United'), action: support('played'), object: support('Lakeside'), eventDate: support(day), review: { method: 'human-verified', reference: 'fixture-source-review' } } } };
}

const memory = (key: string, extra: Partial<MemoryWrite> = {}): MemoryWrite => ({ key, kind: 'semantic', text: 'Prefer source-backed sports coverage.', status: 'approved', evidenceRefs: ['operator-preference'], tags: ['style'], effectiveAt: 900, expiresAt: null, expectedRevision: null, ...extra });
const reservation = (key: string, extra: Partial<CoverageRecord> = {}): CoverageRecord => ({ idempotencyKey: key, storyId: 'match-1', runId: key, kind: 'story', status: 'reserved', updatedAt: 1000, expiresAt: 2000, ...extra });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'memory-sqlite-')), path = join(root, 'memory.sqlite'); let now = 1000;
  const store = new SqliteMemoryStore(path, scope, { now: () => now });
  return { root, path, store, time: (value: number) => { now = value; }, open: (other = scope) => new SqliteMemoryStore(path, other, { now: () => now }), close: async () => { await store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('SQLite reopens durable revisions and recalls only bounded approved effective memory', async () => {
  const f = fixture(); try {
    const first = await f.store.putMemory(memory('style'), 1000);
    assert.equal(first.approvedBy, 'operator'); assert.equal(first.revision, 1);
    assert.deepEqual(await f.store.putMemory(memory('style'), 1001), first, 'same creation retry cannot append a revision');
    await f.store.putMemory(memory('future', { effectiveAt: 2000 }), 1000);
    await f.store.putMemory(memory('expired', { expiresAt: 1000 }), 1000);
    await f.store.putMemory(memory('proposal', { status: 'proposed' }), 1000);
    await f.store.putMemory(memory('large', { text: 'é'.repeat(500), effectiveAt: 950 }), 1000);
    const query = { kinds: ['semantic' as const], now: 1000, limit: 10, maxBytes: 700 };
    assert.deepEqual((await f.store.recall(query)).map(row => row.key), ['style']);
    const second = await f.store.putMemory(memory('style', { expectedRevision: 1, text: 'Include exact match dates.' }), 1002);
    assert.equal(second.revision, 2); assert.equal(second.createdAt, 1000);
    await assert.rejects(f.store.putMemory(memory('style', { expectedRevision: 1, text: 'Unrelated stale update.' }), 1003), /revision conflict/);
    await f.store.close(); const reopened = f.open();
    try { assert.deepEqual(await reopened.getMemory('style'), second); assert.equal((await reopened.getMemory('proposal'))?.status, 'proposed'); }
    finally { await reopened.close(); }
    const db = new DatabaseSync(f.path);
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_revisions WHERE key=?').get('style')?.n, 2);
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal'); assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1); db.close();
  } finally { await f.close(); }
});

test('workspace and publication scope isolate lookup, references and authorized deletion', async () => {
  const f = fixture(), otherWorkspace = f.open({ ...scope, workspaceId: 'workspace-b' }), otherPublication = f.open({ ...scope, publicationId: 'science' });
  try {
    await f.store.putMemory(memory('only-a'), 1000); await f.store.putStory(story());
    await otherWorkspace.putMemory(memory('only-b'), 1000); await otherPublication.putMemory(memory('only-c'), 1000);
    assert.equal(await otherWorkspace.getMemory('only-a'), null); assert.equal(await otherPublication.getMemory('only-a'), null);
    assert.deepEqual(await otherWorkspace.findStories({ entities: ['Example United'], since: 0, limit: 10 }), []);
    await assert.rejects(otherWorkspace.reserveCoverage(reservation('cross-scope')), /exact scope/);
    await assert.rejects(otherWorkspace.addRetentionReference('only-a', 'review'), /FOREIGN KEY/);
    await f.store.addRetentionReference('only-a', 'acceptance'); await f.store.reserveCoverage(reservation('publish-a'));
    await f.store.deleteScope();
    assert.equal(await f.store.getMemory('only-a'), null); assert.deepEqual(await f.store.coverage({ since: 0, limit: 10 }), []);
    assert.deepEqual(await f.store.findStories({ since: 0, limit: 10 }), []);
    assert.equal((await otherWorkspace.getMemory('only-b'))?.key, 'only-b'); assert.equal((await otherPublication.getMemory('only-c'))?.key, 'only-c');
    const db = new DatabaseSync(f.path); assert.equal(db.prepare('SELECT count(*) AS n FROM memory_journal WHERE workspace=? AND publication=?').get('workspace-a', 'sports')?.n, 0); db.close();
  } finally { await otherWorkspace.close(); await otherPublication.close(); await f.close(); }
});

test('canonical URLs retrieve distinct events without collapsing dates, and immutable source revisions reject overwrite', async () => {
  const f = fixture(); try {
    await f.store.putStory(story()); await f.store.putStory(story('match-2'));
    await f.store.putStory({ ...story(), observedAt: 1100 });
    assert.equal((await f.store.findStories({ canonicalUrls: story().canonicalUrls, since: 0, limit: 10 }))[0]?.observedAt, 1000);
    assert.equal((await f.store.findStories({ entities: ['example united'], since: 0, limit: 10 })).length, 2);
    assert.deepEqual(await f.store.findStories({ canonicalUrls: ['https://example.com/match-1?date=2026-09-15'], since: 0, limit: 10 }), []);
    await assert.rejects(f.store.putStory({ ...story(), sourceHashes: ['b'.repeat(64)] }), /immutable id/);
    assert.deepEqual((await f.store.findStories({ canonicalUrls: story().canonicalUrls, since: 0, limit: 1 }))[0]?.sourceHashes, ['a'.repeat(64)]);
  } finally { await f.close(); }
});

test('draft and mention are not full-story coverage, and idempotent reservations cannot renew or mutate', async () => {
  const f = fixture(); try {
    await f.store.putStory(story());
    await f.store.reserveCoverage(reservation('draft', { status: 'draft' }));
    assert.equal((await f.store.reserveCoverage(reservation('full'))).acquired, true);
    assert.equal((await f.store.reserveCoverage(reservation('another'))).acquired, false);
    assert.equal((await f.store.reserveCoverage(reservation('mention', { kind: 'mention' }))).acquired, true);
    await assert.rejects(f.store.transitionCoverage({ idempotencyKey: 'draft', expectedStatus: 'draft', status: 'reserved', now: 1000 }), /Another run/);
    f.time(1100); const held = await f.store.reserveCoverage(reservation('full', { updatedAt: 1100 }));
    assert.equal(held.record.updatedAt, 1000);
    await assert.rejects(f.store.reserveCoverage(reservation('full', { expiresAt: 3000 })), /idempotency key/);
    f.time(2100);
    assert.equal((await f.store.reserveCoverage(reservation('full'))).acquired, false, 'old request timestamp cannot revive expiry');
    await assert.rejects(f.store.transitionCoverage({ idempotencyKey: 'full', expectedStatus: 'reserved', status: 'submitted-unconfirmed', now: 1100 }), /expired/);
    assert.equal((await f.store.reserveCoverage(reservation('new-run', { updatedAt: 2100, expiresAt: 3000 }))).acquired, true);
  } finally { await f.close(); }
});

test('submitted-unconfirmed persists across expiry/reopen and only an explicit reconciliation can release it', async () => {
  const f = fixture(); try {
    await f.store.putStory(story()); await f.store.reserveCoverage(reservation('ambiguous'));
    const submitted = await f.store.transitionCoverage({ idempotencyKey: 'ambiguous', expectedStatus: 'reserved', status: 'submitted-unconfirmed', now: 1000 });
    assert.equal(submitted.expiresAt, null); f.time(5000); await f.store.maintain(5000);
    const reopened = f.open(); try {
      assert.equal((await reopened.reserveCoverage(reservation('retry', { updatedAt: 5000, expiresAt: 6000 }))).acquired, false);
      await assert.rejects(reopened.transitionCoverage({ idempotencyKey: 'ambiguous', expectedStatus: 'submitted-unconfirmed', status: 'cancelled', now: 5000 }), /reconciliation/);
      const change = { idempotencyKey: 'ambiguous', expectedStatus: 'submitted-unconfirmed' as const, status: 'cancelled' as const, now: 5000, resolution: { kind: 'confirmed-not-submitted' as const, reference: 'provider-query:no-attempt-123' } };
      const cancelled = await reopened.transitionCoverage(change); assert.deepEqual(cancelled.resolution, change.resolution);
      assert.deepEqual(await reopened.transitionCoverage(change), cancelled);
      assert.equal((await reopened.reserveCoverage(reservation('after-reconcile', { updatedAt: 5000, expiresAt: 6000 }))).acquired, true);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test('publication requires a receipt, stays covered until retracted, and replay cannot resend', async () => {
  const f = fixture(); try {
    await f.store.putStory(story()); await f.store.reserveCoverage(reservation('publication'));
    await assert.rejects(f.store.transitionCoverage({ idempotencyKey: 'publication', expectedStatus: 'reserved', status: 'published', now: 1000 }), /confirmed provider receipt/);
    const change = { idempotencyKey: 'publication', expectedStatus: 'reserved' as const, status: 'published' as const, now: 1000, receipt: { provider: 'fixture', remoteId: 'post-1', confirmedAt: 1000, url: 'https://example.com/post-1' } };
    const published = await f.store.transitionCoverage(change); assert.equal(published.expiresAt, null);
    assert.deepEqual(await f.store.transitionCoverage(change), published);
    assert.equal((await f.store.reserveCoverage(reservation('publication'))).acquired, false);
    f.time(10000); assert.equal((await f.store.reserveCoverage(reservation('next-run', { updatedAt: 10000, expiresAt: 11000 }))).acquired, false);
    await assert.rejects(f.store.transitionCoverage({ ...change, receipt: { ...change.receipt, remoteId: 'changed' } }), /receipt changed/);
    const retracted = await f.store.transitionCoverage({ idempotencyKey: 'publication', expectedStatus: 'published', status: 'retracted', now: 10000 });
    assert.deepEqual(retracted.receipt, change.receipt);
    assert.equal((await f.store.reserveCoverage(reservation('new-coverage', { updatedAt: 10000, expiresAt: 11000 }))).acquired, true);
  } finally { await f.close(); }
});

test('referenced expired lessons retire once; removing retention deletes text and revisions', async () => {
  const f = fixture(); try {
    await f.store.putMemory(memory('lesson', { kind: 'episodic', text: 'Retained incident evidence.', verificationRef: 'verified-test', expiresAt: 1200 }), 1000);
    await f.store.putMemory(memory('disposable', { text: 'DELETE-EXPIRED-TEXT', expiresAt: 1200 }), 1000);
    await f.store.addRetentionReference('lesson', 'acceptance-1');
    assert.deepEqual(await f.store.maintain(1200), { retired: 1, deleted: 1, retainedByReference: 1 });
    assert.equal((await f.store.getMemory('lesson'))?.revision, 2);
    assert.deepEqual(await f.store.maintain(1300), { retired: 0, deleted: 0, retainedByReference: 1 });
    assert.deepEqual(await f.store.recall({ kinds: ['episodic'], now: 1300, limit: 10, maxBytes: 2000 }), []);
    await f.store.removeRetentionReference('lesson', 'acceptance-1'); assert.equal((await f.store.maintain(1400)).deleted, 1);
    const db = new DatabaseSync(f.path);
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_revisions').get()?.n, 0);
    assert.ok(!JSON.stringify(db.prepare('SELECT payload FROM memory_journal').all()).includes('DELETE-EXPIRED-TEXT'));
    db.close();
  } finally { await f.close(); }
});

test('four real processes atomically compete across distinct packets of the same verified event', async () => {
  const f = fixture(); try {
    for (let i = 0; i < 4; i++) await f.store.putStory(reviewedStory(`packet-${i}`)); await f.store.close();
    const moduleUrl = new URL('./sqlite.ts', import.meta.url).href;
    const children = Array.from({ length: 4 }, (_, i) => {
      const code = `import {SqliteMemoryStore} from ${JSON.stringify(moduleUrl)};const s=new SqliteMemoryStore(${JSON.stringify(f.path)},${JSON.stringify(scope)},{now:()=>1000});console.log('READY');for await(const _ of process.stdin){};const r=await s.reserveCoverage(${JSON.stringify(reservation(`worker-${i}`, { storyId: `packet-${i}` }))});console.log(JSON.stringify(r));await s.close();`;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errors = ''; let readyResolve!: () => void; const ready = new Promise<void>(resolve => { readyResolve = resolve; });
      child.stdout.on('data', value => { output += value; if (output.includes('READY\n')) readyResolve(); }); child.stderr.on('data', value => { errors += value; });
      const done = new Promise<any>((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output.trim().split('\n').at(-1)!)) : reject(new Error(errors))); });
      return { child, ready, done };
    });
    await Promise.all(children.map(c => c.ready)); children.forEach(c => c.child.stdin.end());
    const results = await Promise.all(children.map(c => c.done));
    assert.equal(results.filter(result => result.acquired).length, 1); assert.equal(new Set(results.map(result => result.record.idempotencyKey)).size, 1);
    const reopened = f.open(); try { assert.equal((await reopened.coverage({ statuses: ['reserved'], since: 0, limit: 10 })).length, 1); } finally { await reopened.close(); }
  } finally { await f.close(); }
});


test('lookup similarity alone does not block changed source content or a different match date', async () => {
  const f = fixture(); try {
    await f.store.putStory(reviewedStory('first')); await f.store.reserveCoverage(reservation('first-run', { storyId: 'first' }));
    await f.store.putStory(reviewedStory('recaptured'));
    assert.equal((await f.store.reserveCoverage(reservation('same-event', { storyId: 'recaptured' }))).acquired, false);
    await f.store.putStory(reviewedStory('changed-source', { hash: 'c'.repeat(64) }));
    assert.equal((await f.store.reserveCoverage(reservation('possible-development', { storyId: 'changed-source' }))).acquired, true);
    await f.store.putStory(reviewedStory('next-match', { day: '2026-09-15' }));
    assert.equal((await f.store.reserveCoverage(reservation('different-date', { storyId: 'next-match' }))).acquired, true);
    await f.store.putStory({ ...story('unknown'), canonicalUrls: ['https://example.com/match'] });
    assert.equal((await f.store.reserveCoverage(reservation('uncertain-identity', { storyId: 'unknown' }))).acquired, true);
  } finally { await f.close(); }
});


test('activation uses current lease liveness even when its recorded event time is earlier', async () => {
  const f = fixture(); try {
    await f.store.putStory(story());
    await f.store.reserveCoverage(reservation('old-lease', { expiresAt: 2000 }));
    await f.store.reserveCoverage(reservation('draft-later', { status: 'draft', expiresAt: 4000 }));
    f.time(2500);
    const activated = await f.store.transitionCoverage({ idempotencyKey: 'draft-later', expectedStatus: 'draft', status: 'reserved', now: 1100 });
    assert.equal(activated.status, 'reserved'); assert.equal(activated.expiresAt, 4000);
    assert.equal((await f.store.reserveCoverage(reservation('next-run', { updatedAt: 2500, expiresAt: 3500 }))).acquired, false);
  } finally { await f.close(); }
});
