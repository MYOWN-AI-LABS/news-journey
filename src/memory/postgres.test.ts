import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PostgresMemoryStore, type PostgresMemoryClient, type PostgresMemoryPool } from './postgres.js';
import { coverageRequestIdentity } from './validation.js';
import type { CoverageRecord, MemoryRecord, MemoryScope, MemoryWrite, StoredStory } from './types.js';
import type { StoryEventPacket } from './story-identity.js';

// These fixtures exercise adapter transactions and parameter binding. They are deliberately not
// advertised as a PostgreSQL emulator or proof that a deployed login enforces the SQL policies.
type Row = Record<string, unknown>;
type Call = { sql: string; values: unknown[] };
class Client implements PostgresMemoryClient {
  calls: Call[] = []; released: Array<Error | boolean | undefined> = []; unsafe = false; forced = true;
  constructor(readonly respond: (call: Call) => Row[] | Promise<Row[]> = () => []) {}
  async query<T extends Row = Row>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number | null }> {
    const call = { sql, values: structuredClone(values) }; this.calls.push(call);
    let rows: Row[];
    if (sql.startsWith('SELECT EXISTS')) rows = [{ unsafe: this.unsafe }];
    else if (sql.includes('relforcerowsecurity')) rows = ['records', 'record_versions', 'stories', 'coverage', 'retention_refs', 'journal'].map(name => ({ name, enabled: true, forced: this.forced }));
    else if (sql.startsWith('SELECT version')) rows = [{ version: 1 }];
    else {
      rows = await this.respond(call);
      if (!rows.length && sql === 'SELECT value FROM harness_memory.stories WHERE workspace_id=$1 AND publication_id=$2 AND id=$3') rows = [{ value: story }];
    }
    return { rows: rows as T[], rowCount: rows.length };
  }
  release(error?: Error | boolean): void { this.released.push(error); }
}
class Pool implements PostgresMemoryPool { connections = 0; constructor(readonly client: Client) {} async connect(): Promise<Client> { this.connections++; return this.client; } }
const scope: MemoryScope = { workspaceId: 'workspace-A', publicationId: 'sports', actorId: 'editor' };
const write: MemoryWrite = { key: 'tone', kind: 'semantic', text: 'Use clear sports coverage.', status: 'approved', evidenceRefs: ['explicit-setting'], tags: ['tone'], effectiveAt: 100, expiresAt: null, expectedRevision: null };
const record: MemoryRecord = { ...write, revision: 1, createdAt: 100, approvedBy: 'editor' };
delete (record as unknown as Record<string, unknown>).expectedRevision;
const coverage: CoverageRecord = { idempotencyKey: 'send-1', storyId: 'story-1', runId: 'run-1', kind: 'story', status: 'reserved', updatedAt: 100, expiresAt: 200 };
const story: StoredStory = { id: 'story-1', event: { version: 1, primaryUrl: 'https://example.com/story', claims: [], revisions: [] }, canonicalUrls: ['https://example.com/story'], entities: ['Team A'], sourceHashes: [], observedAt: 100 };
const statements = (client: Client) => client.calls.map(call => call.sql);
function reviewedStory(id: string, url: string): StoredStory {
  const claim = 'Team A won the regional match on 2026-09-10.';
  const supported = (value: string) => ({ value, support: [{ sourceHash: 'a'.repeat(64), claimId: 1, quote: claim }] });
  const event: StoryEventPacket = { version: 1, primaryUrl: url, claims: [claim], revisions: [{ url, role: 'primary', status: 200, sha256: 'a'.repeat(64), textSha256: 'b'.repeat(64), observedAt: '2026-09-11T00:00:00.000Z' }],
    identity: { entity: supported('Team A'), action: supported('won'), object: supported('regional match'), eventDate: supported('2026-09-10'), review: { method: 'human-verified', reference: 'fixture-reviewed-identity' } } };
  return { ...story, id, event, canonicalUrls: [url] };
}

test('Postgres binds an immutable authenticated scope with LOCAL settings and every read predicate', async () => {
  const input = { ...scope, publicationId: "sports'; SELECT secret; --" }, client = new Client(); const store = new PostgresMemoryStore(new Pool(client), input);
  input.workspaceId = 'workspace-B'; input.actorId = 'other';
  await store.coverage({ since: 0, statuses: ['published'], limit: 5 });
  const local = client.calls.find(call => call.sql.includes('set_config'))!;
  assert.deepEqual(local.values, ['workspace-A', "sports'; SELECT secret; --", 'editor']);
  assert.match(local.sql, /harness\.workspace_id'.*true/);
  const query = client.calls.find(call => call.sql.startsWith('SELECT value FROM harness_memory.coverage'))!;
  assert.match(query.sql, /workspace_id=\$1 AND publication_id=\$2/);
  assert.deepEqual(query.values.slice(0, 2), local.values.slice(0, 2));
  assert.ok(client.calls.every(call => !call.sql.includes('SELECT secret')));
  assert.equal(statements(client).at(-1), 'COMMIT'); assert.equal(client.released.length, 1);
});

test('Postgres refuses privileged roles and missing forced RLS before any memory read', async () => {
  for (const mode of ['role', 'policy']) {
    const client = new Client(); if (mode === 'role') client.unsafe = true; else client.forced = false;
    const store = new PostgresMemoryStore(new Pool(client), scope);
    await assert.rejects(store.coverage({ since: 0, limit: 5 }), mode === 'role' ? /nonowner/ : /forced row security/);
    assert.ok(!statements(client).some(sql => sql.startsWith('SELECT value FROM')));
    assert.equal(statements(client).at(-1), 'ROLLBACK'); assert.equal(client.released.length, 1);
    const roleCheck = client.calls.find(call => call.sql.startsWith('SELECT EXISTS'))!.sql;
    assert.match(roleCheck, /pg_has_role\(current_user,r\.oid,'MEMBER'\)/);
    assert.match(roleCheck, /pg_has_role\(current_user,n\.nspowner,'MEMBER'\)/);
  }
});

test('Postgres exact memory-write retries do not mint a revision or journal, while getMemory can show a proposed record', async () => {
  const proposed = { ...record, status: 'proposed' as const };
  const client = new Client(call => call.sql.startsWith('SELECT value FROM harness_memory.records') ? [{ value: call.sql.includes('FOR UPDATE') ? record : proposed }] : []);
  const store = new PostgresMemoryStore(new Pool(client), scope);
  assert.deepEqual(await store.putMemory(write, 200), record);
  assert.ok(!statements(client).some(sql => sql.startsWith('INSERT INTO')));
  assert.deepEqual(await store.getMemory('tone'), proposed);
  assert.deepEqual(await store.recall({ kinds: ['semantic'], now: 200, limit: 5, maxBytes: 1000 }), []);
});

test('Postgres memory revisions and journal commit atomically; failed rollback discards the connection', async () => {
  const client = new Client(call => {
    if (call.sql.startsWith('INSERT INTO harness_memory.journal')) throw new Error('journal unavailable');
    if (call.sql === 'ROLLBACK') throw new Error('connection broken'); return [];
  });
  await assert.rejects(new PostgresMemoryStore(new Pool(client), scope).putMemory(write, 100), /journal unavailable/);
  assert.ok(statements(client).some(sql => sql.startsWith('INSERT INTO harness_memory.records')));
  assert.ok(!statements(client).includes('COMMIT')); assert.equal(statements(client).at(-1), 'ROLLBACK');
  assert.deepEqual(client.released, [true]);
  const conflict = new Client(call => call.sql.startsWith('SELECT value FROM harness_memory.records') ? [{ value: record }] : []);
  await assert.rejects(new PostgresMemoryStore(new Pool(conflict), scope).putMemory({ ...write, text: 'A different preference.' }, 200), /revision conflict/);
  assert.ok(!statements(conflict).some(sql => sql.startsWith('INSERT INTO harness_memory.records')));
});

test('Postgres recall keeps full approved/effective records within byte limits and cannot recall old working state', async () => {
  const future = { ...record, key: 'future', effectiveAt: 500 }, stale = { ...record, key: 'old-cities', kind: 'working', expiresAt: 100 };
  const client = new Client(call => call.sql.startsWith('SELECT value FROM harness_memory.records') ? [{ value: future }, { value: stale }, { value: record }] : []);
  const store = new PostgresMemoryStore(new Pool(client), scope);
  assert.deepEqual(await store.recall({ kinds: ['semantic'], now: 200, limit: 5, maxBytes: 1000 }), [record]);
  assert.deepEqual(await store.recall({ kinds: ['semantic'], now: 200, limit: 5, maxBytes: 10 }), []);
  const query = client.calls.find(call => call.sql.startsWith('SELECT value FROM harness_memory.records'))!;
  assert.match(query.sql, /status='approved'/); assert.match(query.sql, /expires_at > \$3/); assert.match(query.sql, /LIMIT \$7/);
});

test('Postgres story re-observation is idempotent, changed evidence requires new ID, and entity retrieval is normalized', async () => {
  const jsonbOrder = JSON.parse(JSON.stringify(story, (_, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
  const client = new Client(call => call.sql.startsWith('SELECT value FROM harness_memory.stories') && call.sql.includes('id=$3') ? [{ value: jsonbOrder }] : []);
  const store = new PostgresMemoryStore(new Pool(client), scope);
  await store.putStory({ ...story, observedAt: 300 });
  assert.ok(!statements(client).some(sql => sql.startsWith('INSERT INTO')));
  await assert.rejects(store.putStory({ ...story, sourceHashes: ['a'.repeat(64)] }), /immutable/);
  await store.findStories({ entities: [' TEAM   A '], since: 0, limit: 4 });
  const query = client.calls.find(call => call.sql.includes('lookup_entities &&'))!;
  assert.deepEqual(query.values[4], ['team a']); assert.match(query.sql, /LIMIT \$6/);
});

test('Postgres locks and compares distinct source packets for the same reviewed event without treating a changed fact as duplicate', async () => {
  const current = reviewedStory('current', 'https://example.com/current'), prior = reviewedStory('prior', 'https://example.org/prior');
  const priorCoverage = { ...coverage, idempotencyKey: 'prior-send', storyId: 'prior' };
  let candidate = prior;
  const client = new Client(call => call.sql === 'SELECT value FROM harness_memory.stories WHERE workspace_id=$1 AND publication_id=$2 AND id=$3' ? [{ value: current }]
    : call.sql.startsWith('SELECT c.value,s.value AS story') ? [{ value: priorCoverage, story: candidate }] : []);
  const store = new PostgresMemoryStore(new Pool(client), scope, () => 150);
  assert.deepEqual(await store.reserveCoverage({ ...coverage, storyId: 'current' }), { acquired: false, record: priorCoverage });
  candidate = { ...prior, event: { ...prior.event, claims: [...prior.event.claims, 'The match used a new format.'] } };
  assert.equal((await store.reserveCoverage({ ...coverage, storyId: 'current' })).acquired, true);
  const query = client.calls.find(call => call.sql.startsWith('SELECT c.value,s.value AS story'))!;
  assert.match(query.sql, /s\.workspace_id=c\.workspace_id AND s\.publication_id=c\.publication_id/);
  assert.match(query.sql, /c\.kind=\$3/); assert.match(query.sql, /LIMIT 101/);
});

test('Postgres refuses an incomplete oversized semantic reservation check instead of silently treating unchecked candidates as different', async () => {
  const current = reviewedStory('current', 'https://example.com/current');
  const different = reviewedStory('different', 'https://example.org/different'); different.event.claims.push('The match used a new format.');
  const client = new Client(call => call.sql === 'SELECT value FROM harness_memory.stories WHERE workspace_id=$1 AND publication_id=$2 AND id=$3' ? [{ value: current }]
    : call.sql.startsWith('SELECT c.value,s.value AS story') ? Array.from({ length: 101 }, () => ({ value: coverage, story: different })) : []);
  await assert.rejects(new PostgresMemoryStore(new Pool(client), scope, () => 150).reserveCoverage({ ...coverage, storyId: 'current' }), /bounded candidate/);
  assert.ok(!statements(client).some(sql => sql.startsWith('INSERT INTO harness_memory.coverage')));
});

test('Postgres same-key publication retry never renews or erases submitted or confirmed coverage', async () => {
  for (const status of ['submitted-unconfirmed', 'published'] as const) {
    const existing = { ...coverage, status, expiresAt: null, updatedAt: 150, ...(status === 'published' ? { receipt: { provider: 'site', remoteId: 'remote-1', confirmedAt: 150 } } : {}) };
    const client = new Client(call => call.sql.startsWith('SELECT value,request_identity') ? [{ value: existing, request_identity: coverageRequestIdentity(coverage) }] : []);
    const store = new PostgresMemoryStore(new Pool(client), scope, () => 160);
    assert.deepEqual(await store.reserveCoverage({ ...coverage, updatedAt: 160 }), { acquired: false, record: existing });
    await assert.rejects(store.reserveCoverage({ ...coverage, expiresAt: 400 }), /different request/);
    assert.ok(!statements(client).some(sql => sql.startsWith('INSERT INTO harness_memory.coverage')));
  }
});

test('Postgres reservation conflicts preserve unknown delivery, distinguish mention and full story, and serialize writers', async () => {
  const unconfirmed = { ...coverage, status: 'submitted-unconfirmed', expiresAt: null };
  const client = new Client(call => call.sql.includes("status IN ('submitted-unconfirmed','published')") && call.values[3] === 'story' ? [{ value: unconfirmed }] : []);
  const store = new PostgresMemoryStore(new Pool(client), scope, () => 500);
  const later = { ...coverage, idempotencyKey: 'send-2', updatedAt: 500, expiresAt: 600 };
  assert.deepEqual(await store.reserveCoverage(later), { acquired: false, record: unconfirmed });
  assert.equal((await store.reserveCoverage({ ...later, kind: 'mention' })).acquired, true);
  const insert = client.calls.find(call => call.sql.startsWith('INSERT INTO harness_memory.coverage'))!;
  assert.equal(JSON.parse(insert.values[4] as string).kind, 'mention');
  assert.ok(statements(client).findIndex(sql => sql.includes('pg_advisory_xact_lock')) < statements(client).findIndex(sql => sql.startsWith('SELECT value,request_identity')));
  assert.ok(!statements(client).some(sql => /DELETE.*coverage/.test(sql)));
});

test('Postgres uses trusted current time for same-key retry, fresh reservation and submission instead of caller timestamps', async () => {
  const old = new Client(call => call.sql.startsWith('SELECT value,request_identity') ? [{ value: coverage, request_identity: coverageRequestIdentity(coverage) }]
    : call.sql.startsWith('SELECT value FROM harness_memory.coverage') ? [{ value: coverage }] : []);
  const store = new PostgresMemoryStore(new Pool(old), scope, () => 500);
  assert.deepEqual(await store.reserveCoverage(coverage), { acquired: false, record: coverage });
  await assert.rejects(store.transitionCoverage({ idempotencyKey: 'send-1', expectedStatus: 'reserved', status: 'submitted-unconfirmed', now: 150 }), /expired/);
  assert.ok(!statements(old).some(sql => sql.startsWith('UPDATE harness_memory.coverage')));
  const fresh = new Client();
  await assert.rejects(new PostgresMemoryStore(new Pool(fresh), scope, () => 500).reserveCoverage(coverage), /already expired/);
  assert.ok(!statements(fresh).some(sql => sql.startsWith('INSERT INTO harness_memory.coverage')));
});

test('Postgres permits separate drafts, rejects future reservations and rechecks conflicts before confirming coverage', async () => {
  const published = { ...coverage, idempotencyKey: 'prior-send', status: 'published', expiresAt: null, receipt: { provider: 'site', remoteId: 'prior', confirmedAt: 140 } };
  const client = new Client(call => call.sql.endsWith('FOR UPDATE') && call.sql.startsWith('SELECT value FROM harness_memory.coverage') ? [{ value: coverage }]
    : call.sql.includes("status IN ('submitted-unconfirmed','published')") ? [{ value: published }] : []);
  const store = new PostgresMemoryStore(new Pool(client), scope, () => 150);
  assert.equal((await store.reserveCoverage({ ...coverage, idempotencyKey: 'draft-1', status: 'draft', expiresAt: null })).acquired, true);
  await assert.rejects(store.reserveCoverage({ ...coverage, updatedAt: 500, expiresAt: 600 }), /future/);
  await assert.rejects(store.transitionCoverage({ idempotencyKey: 'send-1', expectedStatus: 'reserved', status: 'published', now: 150, receipt: { provider: 'site', remoteId: 'new', confirmedAt: 150 } }), /active coverage/);
  assert.ok(!statements(client).some(sql => sql.startsWith('UPDATE harness_memory.coverage')));
});

test('Postgres transition validates provider receipt, preserves original reservation identity, and journals only committed changes', async () => {
  const unconfirmed: CoverageRecord = { ...coverage, status: 'submitted-unconfirmed', updatedAt: 120, expiresAt: null };
  const client = new Client(call => call.sql.startsWith('SELECT value FROM harness_memory.coverage') && call.sql.endsWith('FOR UPDATE') ? [{ value: unconfirmed }] : []);
  const pool = new Pool(client), store = new PostgresMemoryStore(pool, scope);
  await assert.rejects(store.transitionCoverage({ idempotencyKey: 'send-1', expectedStatus: 'submitted-unconfirmed', status: 'published', now: 130 }), /receipt/);
  assert.equal(pool.connections, 0);
  await assert.rejects(store.transitionCoverage({ idempotencyKey: 'send-1', expectedStatus: 'submitted-unconfirmed', status: 'cancelled', now: 130 }), /reconcil|unsafe/);
  const receipt = { provider: 'site', remoteId: 'remote-1', confirmedAt: 130 };
  const next = await store.transitionCoverage({ idempotencyKey: 'send-1', expectedStatus: 'submitted-unconfirmed', status: 'published', receipt, now: 130 });
  assert.equal(next.status, 'published'); assert.deepEqual(next.receipt, receipt);
  const update = client.calls.find(call => call.sql.startsWith('UPDATE harness_memory.coverage'))!;
  assert.ok(!update.sql.includes('request_identity=')); assert.equal(next.expiresAt, null);
});

test('Postgres releases an ambiguous external attempt only with explicit retained reconciliation proof', async () => {
  const unconfirmed = { ...coverage, status: 'submitted-unconfirmed' as const, updatedAt: 120, expiresAt: null };
  const client = new Client(call => call.sql.startsWith('SELECT value FROM harness_memory.coverage') && call.sql.endsWith('FOR UPDATE') ? [{ value: unconfirmed }] : []);
  const store = new PostgresMemoryStore(new Pool(client), scope, () => 600);
  const resolution = { kind: 'confirmed-not-submitted' as const, reference: 'provider-reconciliation/remote-1' };
  const next = await store.transitionCoverage({ idempotencyKey: 'send-1', expectedStatus: 'submitted-unconfirmed', status: 'cancelled', now: 600, resolution });
  assert.equal(next.status, 'cancelled'); assert.deepEqual(next.resolution, resolution);
  const update = client.calls.find(call => call.sql.startsWith('UPDATE harness_memory.coverage'))!;
  assert.deepEqual(JSON.parse(update.values[3] as string).resolution, resolution);
});

test('Postgres maintenance preserves referenced evidence, retires it once, and leaves all coverage untouched', async () => {
  const retired = { ...record, key: 'already-retired', status: 'retired', expiresAt: 200 };
  const client = new Client(call => call.sql.startsWith('SELECT r.value') ? [{ value: { ...record, expiresAt: 200 }, retained: true }, { value: retired, retained: true }, { value: { ...record, key: 'disposable', expiresAt: 200 }, retained: false }] : []);
  const store = new PostgresMemoryStore(new Pool(client), scope);
  assert.deepEqual(await store.maintain(300), { retired: 1, deleted: 1, retainedByReference: 2 });
  const changes = client.calls.filter(call => call.sql.startsWith('UPDATE harness_memory.records'));
  assert.equal(changes.length, 1); assert.equal(JSON.parse(changes[0]!.values[3] as string).revision, 2);
  assert.ok(!statements(client).some(sql => /(?:DELETE|UPDATE).*harness_memory\.(?:coverage|stories)/.test(sql)));
});

test('Postgres authorized scope deletion removes dependent rows with scope predicates, and close does not stop the service pool', async () => {
  const client = new Client(), pool = new Pool(client), store = new PostgresMemoryStore(pool, scope);
  await store.deleteScope();
  const deletes = client.calls.filter(call => call.sql.startsWith('DELETE'));
  assert.deepEqual(deletes.map(call => call.sql.match(/harness_memory\.(\w+)/)![1]), ['retention_refs', 'coverage', 'stories', 'records', 'journal']);
  deletes.forEach(call => { assert.match(call.sql, /workspace_id=\$1 AND publication_id=\$2/); assert.deepEqual(call.values, ['workspace-A', 'sports']); });
  await store.close(); await assert.rejects(store.coverage({ since: 0, limit: 2 }), /closed/); assert.equal(pool.connections, 1);
});

test('Postgres migration declares forced scoped policies, composite identity constraints and no application ownership privileges', () => {
  const sql = readFileSync(new URL('../../docs/sql/memory-postgres.sql', import.meta.url), 'utf8');
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  for (const table of ['records', 'record_versions', 'stories', 'coverage', 'retention_refs', 'journal']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS harness_memory\\.${table} \\(`));
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/); assert.match(sql, /FORCE ROW LEVEL SECURITY/); assert.match(sql, /WITH CHECK/);
  for (const key of ['workspace_id', 'publication_id', 'actor_id']) assert.ok(sql.includes(`current_setting(''harness.${key}''`));
  assert.match(sql, /NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, publication_id, story_id\)/);
  assert.match(sql, /GRANT SELECT, INSERT, DELETE ON harness_memory.retention_refs, harness_memory.journal/);
  assert.ok(!/GRANT[^;]*(?:TRUNCATE|CREATE|ALL PRIVILEGES)/.test(sql));
  assert.match(sql, /submitted-unconfirmed/); assert.match(sql, /IS TRUE/); assert.match(sql, /Hosted acceptance still required/);
});
