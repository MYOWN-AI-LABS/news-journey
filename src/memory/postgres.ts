import { randomUUID } from 'node:crypto';
import type { CoverageQuery, CoverageRecord, CoverageTransition, MemoryMaintenanceResult, MemoryQuery, MemoryRecord, MemoryScope, MemoryStore, MemoryWrite, StoredStory, StoryQuery } from './types.js';
import { boundRecall, coverageAcquired, coverageRequestIdentity, coverageTransition, memoryHash, memoryRecord, storyContentIdentity, storyIdentityLookup, storyLookupEntity, validateCoverageQuery, validateCoverageRecord, validateCoverageTransition, validateMemoryQuery, validateMemoryTime, validateMemoryWrite, validateRetentionKey, validateScope, validateStoredStory, validateStoryQuery } from './validation.js';
import { compareStoryEvents } from './story-identity.js';

/** Compatible with a caller-owned pg Pool. Configure TLS, connect/query timeouts and credentials
 * in the authenticated service; this adapter neither provisions nor chooses a hosted database. */
export interface PostgresMemoryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
  release(error?: Error | boolean): void;
}
export interface PostgresMemoryPool { connect(): Promise<PostgresMemoryClient> }
type ValueRow<T> = { value: T } & Record<string, unknown>;
const tables = ['records', 'record_versions', 'stories', 'coverage', 'retention_refs', 'journal'];
const fingerprint = memoryHash;
const copy = <T>(value: T): T => structuredClone(value);

/** Scope is supplied by the authenticated service, never a request body/model. Per-operation
 * authorization remains the service's responsibility. Custom PostgreSQL scope settings are
 * defense in depth, not authentication for clients that possess the service's SQL credential. */
export class PostgresMemoryStore implements MemoryStore {
  readonly scope: Readonly<MemoryScope>;
  private closed = false;
  constructor(private readonly pool: PostgresMemoryPool, scope: MemoryScope, private readonly clock: () => number = Date.now) {
    validateScope(scope); this.scope = Object.freeze({ ...scope });
  }
  private get params(): string[] { return [this.scope.workspaceId, this.scope.publicationId]; }
  private async transaction<T>(write: boolean, work: (client: PostgresMemoryClient) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Memory store is closed');
    const client = await this.pool.connect(); let begun = false, broken = false;
    try {
      if (this.closed) throw new Error('Memory store is closed');
      await client.query('BEGIN'); begun = true;
      await client.query("SELECT set_config('harness.workspace_id',$1,true), set_config('harness.publication_id',$2,true), set_config('harness.actor_id',$3,true), set_config('search_path','pg_catalog,harness_memory',true), set_config('statement_timeout','5000',true), set_config('lock_timeout','2000',true), set_config('idle_in_transaction_session_timeout','10000',true)", [...this.params, this.scope.actorId]);
      const role = await client.query<{ unsafe: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_roles r WHERE (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb)
          AND (r.rolname = current_user OR pg_has_role(current_user,r.oid,'MEMBER'))
        UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='harness_memory' AND c.relkind='r'
          AND pg_has_role(current_user,c.relowner,'MEMBER')
        UNION ALL SELECT 1 FROM pg_namespace n WHERE n.nspname='harness_memory' AND pg_has_role(current_user,n.nspowner,'MEMBER')
      ) AS unsafe`);
      if (role.rows.length !== 1 || role.rows[0]!.unsafe !== false) throw new Error('Memory database login must be nonowner without privileged role membership or RLS bypass');
      const policies = await client.query<{ name: string; enabled: boolean; forced: boolean }>(`SELECT c.relname AS name,c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='harness_memory' AND c.relname=ANY($1::text[]) AND c.relkind='r'`, [tables]);
      if (policies.rows.length !== tables.length || tables.some(name => !policies.rows.some(row => row.name === name && row.enabled === true && row.forced === true))) throw new Error('Memory tables require enabled and forced row security');
      const migration = await client.query<{ version: number }>('SELECT version FROM harness_memory.schema_migrations ORDER BY version');
      if (migration.rows.length !== 1 || migration.rows[0]!.version !== 1) throw new Error('Unsupported memory database schema version');
      if (write) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(this.params)]);
      const result = await work(client); await client.query('COMMIT'); begun = false; return copy(result);
    } catch (error) {
      if (begun) try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken || undefined); }
  }
  private async journal(client: PostgresMemoryClient, operation: string, details: unknown, now: number): Promise<void> {
    await client.query('INSERT INTO harness_memory.journal(workspace_id,publication_id,id,actor_id,operation,at_ms,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [...this.params, randomUUID(), this.scope.actorId, operation, now, JSON.stringify(details)]);
  }
  async putMemory(value: MemoryWrite, now: number): Promise<MemoryRecord> {
    validateMemoryWrite(value, now); value = copy(value);
    return this.transaction(true, async client => {
      const previous = await client.query<ValueRow<MemoryRecord>>('SELECT value FROM harness_memory.records WHERE workspace_id=$1 AND publication_id=$2 AND key=$3 FOR UPDATE', [...this.params, value.key]);
      const next = memoryRecord(value, previous.rows[0]?.value ?? null, this.scope, now);
      if (previous.rows[0]?.value.revision === next.revision) return next;
      await client.query('INSERT INTO harness_memory.records(workspace_id,publication_id,key,value) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(workspace_id,publication_id,key) DO UPDATE SET value=excluded.value', [...this.params, next.key, JSON.stringify(next)]);
      await client.query('INSERT INTO harness_memory.record_versions(workspace_id,publication_id,key,revision,value) VALUES($1,$2,$3,$4,$5::jsonb)', [...this.params, next.key, next.revision, JSON.stringify(next)]);
      await this.journal(client, 'memory-write', { key: next.key, revision: next.revision, status: next.status, contentHash: fingerprint(next) }, now); return next;
    });
  }
  async getMemory(key: string): Promise<MemoryRecord | null> {
    validateRetentionKey(key);
    return this.transaction(false, async client => {
      const found = await client.query<ValueRow<MemoryRecord>>('SELECT value FROM harness_memory.records WHERE workspace_id=$1 AND publication_id=$2 AND key=$3', [...this.params, key]);
      return found.rows[0]?.value ?? null;
    });
  }
  async recall(query: MemoryQuery): Promise<MemoryRecord[]> {
    validateMemoryQuery(query); query = copy(query);
    return this.transaction(false, async client => {
      const result = await client.query<ValueRow<MemoryRecord>>(`SELECT value FROM harness_memory.records WHERE workspace_id=$1 AND publication_id=$2
        AND status='approved' AND effective_at <= $3 AND (expires_at IS NULL OR expires_at > $3)
        AND kind=ANY($4::text[]) AND ($5::text[] IS NULL OR key=ANY($5::text[]))
        AND ($6::text[] IS NULL OR value->'tags' ?| $6::text[]) ORDER BY effective_at DESC,key LIMIT $7`, [...this.params, query.now, query.kinds, query.keys ?? null, query.tags ?? null, query.limit]);
      return boundRecall(result.rows.map(row => row.value), query);
    });
  }
  async putStory(story: StoredStory): Promise<void> {
    validateStoredStory(story); story = copy(story);
    await this.transaction(true, async client => {
      const existing = await client.query<ValueRow<StoredStory>>('SELECT value FROM harness_memory.stories WHERE workspace_id=$1 AND publication_id=$2 AND id=$3 FOR UPDATE', [...this.params, story.id]);
      if (existing.rows.length) { if (storyContentIdentity(existing.rows[0]!.value) !== storyContentIdentity(story)) throw new Error('Story identity is immutable; save a new source revision'); return; }
      await client.query('INSERT INTO harness_memory.stories(workspace_id,publication_id,id,value,lookup_entities,identity_lookup) VALUES($1,$2,$3,$4::jsonb,$5::text[],$6)', [...this.params, story.id, JSON.stringify(story), story.entities.map(storyLookupEntity), storyIdentityLookup(story)]);
      await this.journal(client, 'story-write', { id: story.id, sourceHashes: story.sourceHashes }, story.observedAt);
    });
  }
  async findStories(query: StoryQuery): Promise<StoredStory[]> {
    validateStoryQuery(query); query = copy(query);
    return this.transaction(false, async client => {
      const result = await client.query<ValueRow<StoredStory>>(`SELECT value FROM harness_memory.stories WHERE workspace_id=$1 AND publication_id=$2 AND observed_at >= $3
        AND (($4::text[] IS NULL AND $5::text[] IS NULL) OR value->'canonicalUrls' ?| $4::text[] OR lookup_entities && $5::text[])
        ORDER BY observed_at DESC,id LIMIT $6`, [...this.params, query.since, query.canonicalUrls ?? null, query.entities?.map(storyLookupEntity) ?? null, query.limit]);
      return result.rows.map(row => row.value);
    });
  }
  private async coverageConflict(client: PostgresMemoryClient, record: CoverageRecord, now: number): Promise<CoverageRecord | null> {
    const found = await client.query<ValueRow<StoredStory>>('SELECT value FROM harness_memory.stories WHERE workspace_id=$1 AND publication_id=$2 AND id=$3', [...this.params, record.storyId]);
    if (found.rows.length !== 1) throw new Error('Coverage requires a story in this exact scope');
    const stored = found.rows[0]!.value; validateStoredStory(stored);
    const exact = await client.query<ValueRow<CoverageRecord>>(`SELECT value FROM harness_memory.coverage WHERE workspace_id=$1 AND publication_id=$2 AND story_id=$3 AND kind=$4 AND idempotency_key <> $5
      AND (status IN ('submitted-unconfirmed','published') OR (status='reserved' AND (expires_at IS NULL OR expires_at > $6))) ORDER BY updated_at DESC,idempotency_key LIMIT 1`, [...this.params, record.storyId, record.kind, record.idempotencyKey, now]);
    if (exact.rows.length) return exact.rows[0]!.value;
    const lookup = storyIdentityLookup(stored); if (lookup === null) return null;
    const candidates = await client.query<ValueRow<CoverageRecord> & { story: StoredStory }>(`SELECT c.value,s.value AS story FROM harness_memory.coverage c JOIN harness_memory.stories s
      ON s.workspace_id=c.workspace_id AND s.publication_id=c.publication_id AND s.id=c.story_id
      WHERE c.workspace_id=$1 AND c.publication_id=$2 AND c.kind=$3 AND s.identity_lookup=$4 AND c.story_id<>$5
      AND (c.status IN ('submitted-unconfirmed','published') OR (c.status='reserved' AND (c.expires_at IS NULL OR c.expires_at > $6)))
      ORDER BY c.updated_at DESC,c.idempotency_key LIMIT 101`, [...this.params, record.kind, lookup, record.storyId, now]);
    for (const candidate of candidates.rows.slice(0, 100)) if (compareStoryEvents(stored.event, candidate.story.event).decision === 'same_event') return candidate.value;
    if (candidates.rows.length > 100) throw new Error('Coverage comparison exceeds its bounded candidate allowance; review the related history');
    return null;
  }
  async reserveCoverage(record: CoverageRecord): Promise<{ acquired: boolean; record: CoverageRecord }> {
    validateCoverageRecord(record); record = copy(record);
    return this.transaction(true, async client => {
      const now = this.clock(); validateMemoryTime(now);
      if (record.updatedAt > now) throw new Error('Coverage timestamp cannot be in the future');
      const identity = coverageRequestIdentity(record);
      const existing = await client.query<ValueRow<CoverageRecord> & { request_identity: string }>('SELECT value,request_identity FROM harness_memory.coverage WHERE workspace_id=$1 AND publication_id=$2 AND idempotency_key=$3 FOR UPDATE', [...this.params, record.idempotencyKey]);
      if (existing.rows.length) {
        if (existing.rows[0]!.request_identity !== identity) throw new Error('Coverage idempotency key is bound to a different request');
        return { acquired: coverageAcquired(existing.rows[0]!.value, now), record: existing.rows[0]!.value };
      }
      if (record.expiresAt !== null && record.expiresAt <= now) throw new Error('New coverage reservation is already expired');
      if (record.status === 'reserved') {
        const conflict = await this.coverageConflict(client, record, now);
        if (conflict) return { acquired: false, record: conflict };
      } else {
        const found = await client.query('SELECT value FROM harness_memory.stories WHERE workspace_id=$1 AND publication_id=$2 AND id=$3', [...this.params, record.storyId]);
        if (found.rows.length !== 1) throw new Error('Coverage requires a story in this exact scope');
      }
      await client.query('INSERT INTO harness_memory.coverage(workspace_id,publication_id,idempotency_key,request_identity,value) VALUES($1,$2,$3,$4,$5::jsonb)', [...this.params, record.idempotencyKey, identity, JSON.stringify(record)]);
      await this.journal(client, 'coverage-reserve', { idempotencyKey: record.idempotencyKey, storyId: record.storyId, kind: record.kind, status: record.status }, record.updatedAt);
      return { acquired: coverageAcquired(record, now), record };
    });
  }
  async transitionCoverage(change: CoverageTransition): Promise<CoverageRecord> {
    validateCoverageTransition(change); change = copy(change);
    return this.transaction(true, async client => {
      const found = await client.query<ValueRow<CoverageRecord>>('SELECT value FROM harness_memory.coverage WHERE workspace_id=$1 AND publication_id=$2 AND idempotency_key=$3 FOR UPDATE', [...this.params, change.idempotencyKey]);
      if (!found.rows.length) throw new Error('Unknown coverage attempt');
      const now = this.clock(); validateMemoryTime(now);
      const next = coverageTransition(found.rows[0]!.value, change, now);
      if (fingerprint(next) === fingerprint(found.rows[0]!.value)) return next;
      if (['reserved', 'submitted-unconfirmed', 'published'].includes(next.status)) {
        if (await this.coverageConflict(client, next, now)) throw new Error('Story already has active coverage of this kind');
      }
      await client.query('UPDATE harness_memory.coverage SET value=$4::jsonb WHERE workspace_id=$1 AND publication_id=$2 AND idempotency_key=$3', [...this.params, change.idempotencyKey, JSON.stringify(next)]);
      await this.journal(client, 'coverage-transition', { idempotencyKey: next.idempotencyKey, previousStatus: found.rows[0]!.value.status, status: next.status, receipt: next.receipt ?? null }, change.now); return next;
    });
  }
  async coverage(query: CoverageQuery): Promise<CoverageRecord[]> {
    validateCoverageQuery(query); query = copy(query);
    return this.transaction(false, async client => {
      const result = await client.query<ValueRow<CoverageRecord>>(`SELECT value FROM harness_memory.coverage WHERE workspace_id=$1 AND publication_id=$2 AND updated_at >= $3
        AND ($4::text[] IS NULL OR story_id=ANY($4::text[])) AND ($5::text[] IS NULL OR status=ANY($5::text[])) ORDER BY updated_at DESC,idempotency_key LIMIT $6`, [...this.params, query.since, query.storyIds ?? null, query.statuses ?? null, query.limit]);
      return result.rows.map(row => row.value);
    });
  }
  async addRetentionReference(recordKey: string, ownerKey: string): Promise<void> {
    validateRetentionKey(recordKey); validateRetentionKey(ownerKey);
    await this.transaction(true, async client => { await client.query('INSERT INTO harness_memory.retention_refs(workspace_id,publication_id,record_key,owner_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [...this.params, recordKey, ownerKey]); });
  }
  async removeRetentionReference(recordKey: string, ownerKey: string): Promise<void> {
    validateRetentionKey(recordKey); validateRetentionKey(ownerKey);
    await this.transaction(true, async client => { await client.query('DELETE FROM harness_memory.retention_refs WHERE workspace_id=$1 AND publication_id=$2 AND record_key=$3 AND owner_key=$4', [...this.params, recordKey, ownerKey]); });
  }
  async maintain(now: number): Promise<MemoryMaintenanceResult> {
    validateMemoryTime(now);
    return this.transaction(true, async client => {
      const expired = await client.query<ValueRow<MemoryRecord> & { retained: boolean }>(`SELECT r.value,EXISTS(SELECT 1 FROM harness_memory.retention_refs f WHERE f.workspace_id=r.workspace_id AND f.publication_id=r.publication_id AND f.record_key=r.key) AS retained
        FROM harness_memory.records r WHERE r.workspace_id=$1 AND r.publication_id=$2 AND r.expires_at <= $3 ORDER BY retained ASC,(r.status='retired') ASC,r.key LIMIT 500 FOR UPDATE`, [...this.params, now]);
      const result = { retired: 0, deleted: 0, retainedByReference: 0 };
      for (const row of expired.rows) {
        if (row.retained) {
          result.retainedByReference++;
          if (row.value.status !== 'retired') {
            const next = { ...row.value, status: 'retired', revision: row.value.revision + 1 };
            await client.query('UPDATE harness_memory.records SET value=$4::jsonb WHERE workspace_id=$1 AND publication_id=$2 AND key=$3', [...this.params, row.value.key, JSON.stringify(next)]); result.retired++;
            await client.query('INSERT INTO harness_memory.record_versions(workspace_id,publication_id,key,revision,value) VALUES($1,$2,$3,$4,$5::jsonb)', [...this.params, next.key, next.revision, JSON.stringify(next)]);
          }
        } else { await client.query('DELETE FROM harness_memory.records WHERE workspace_id=$1 AND publication_id=$2 AND key=$3', [...this.params, row.value.key]); result.deleted++; }
      }
      await this.journal(client, 'memory-maintenance', result, now); return result;
    });
  }
  async deleteScope(): Promise<void> {
    await this.transaction(true, async client => {
      for (const table of ['retention_refs', 'coverage', 'stories', 'records', 'journal']) await client.query(`DELETE FROM harness_memory.${table} WHERE workspace_id=$1 AND publication_id=$2`, this.params);
    });
  }
  /** Pool lifetime belongs to the service; closing one scoped adapter must not stop other tenants. */
  async close(): Promise<void> { this.closed = true; }
}
