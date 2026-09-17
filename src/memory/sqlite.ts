import { DatabaseSync } from 'node:sqlite';
import { compareStoryEvents } from './story-identity.js';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { CoverageQuery, CoverageRecord, CoverageTransition, MemoryMaintenanceResult, MemoryQuery, MemoryRecord, MemoryScope, MemoryStore, MemoryWrite, StoredStory, StoryQuery } from './types.js';
import { boundRecall, coverageAcquired, coverageRequestIdentity, coverageTransition, memoryRecord, storyContentIdentity, storyLookupEntity, storyIdentityLookup, memoryHash, canonicalMemoryJson, validateCoverageQuery, validateCoverageRecord, validateCoverageTransition, validateMemoryQuery, validateMemoryTime, validateMemoryWrite, validateRetentionKey, validateScope, validateStoredStory, validateStoryQuery } from './validation.js';

const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(',');
const decode = <T>(row: Record<string, unknown> | undefined): T | null => row ? JSON.parse(String(row.payload)) as T : null;
/** Local, single-host persistence. The authenticated caller supplies the database path and scope;
 * neither is model data. Methods share the hosted async contract; transactions are short/synchronous. */
export class SqliteMemoryStore implements MemoryStore {
  readonly scope: Readonly<MemoryScope>;
  private readonly db: DatabaseSync;
  private closed = false;
  private readonly now: () => number;
  constructor(databasePath: string, scope: MemoryScope, options: { now?: () => number } = {}) {
    validateScope(scope); this.now = options.now ?? Date.now;
    if (!isAbsolute(databasePath) || existsSync(databasePath) && (lstatSync(databasePath).isSymbolicLink() || !lstatSync(databasePath).isFile())) throw new Error('Memory database needs an absolute regular local file');
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.scope = Object.freeze(structuredClone(scope));
    this.db = new DatabaseSync(databasePath);
    try {
      chmodSync(databasePath, 0o600);
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
      const mode = this.db.prepare('PRAGMA journal_mode=WAL').get();
      if (mode?.journal_mode !== 'wal') throw new Error('Memory requires a local SQLite WAL database');
      this.transaction(() => {
        const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
        if (![0, 1].includes(version)) throw new Error('Unsupported memory schema version; do not overwrite this database');
        if (!version) {
          this.db.exec(`
            CREATE TABLE scopes (workspace TEXT NOT NULL, publication TEXT NOT NULL, PRIMARY KEY(workspace,publication)) STRICT;
            CREATE TABLE memories (workspace TEXT NOT NULL, publication TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, effective_at INTEGER NOT NULL, expires_at INTEGER, payload TEXT NOT NULL,
              PRIMARY KEY(workspace,publication,key), FOREIGN KEY(workspace,publication) REFERENCES scopes ON DELETE CASCADE) STRICT;
            CREATE INDEX memory_recall ON memories(workspace,publication,status,kind,effective_at);
            CREATE TABLE memory_revisions (workspace TEXT NOT NULL, publication TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
              PRIMARY KEY(workspace,publication,key,revision), FOREIGN KEY(workspace,publication,key) REFERENCES memories ON DELETE CASCADE) STRICT;
            CREATE TABLE memory_refs (workspace TEXT NOT NULL, publication TEXT NOT NULL, key TEXT NOT NULL, owner TEXT NOT NULL,
              PRIMARY KEY(workspace,publication,key,owner), FOREIGN KEY(workspace,publication,key) REFERENCES memories ON DELETE CASCADE) STRICT;
            CREATE TABLE stories (workspace TEXT NOT NULL, publication TEXT NOT NULL, id TEXT NOT NULL, content_id TEXT NOT NULL, identity_lookup TEXT, observed_at INTEGER NOT NULL, payload TEXT NOT NULL,
              PRIMARY KEY(workspace,publication,id), FOREIGN KEY(workspace,publication) REFERENCES scopes ON DELETE CASCADE) STRICT;
            CREATE INDEX story_identity_lookup ON stories(workspace,publication,identity_lookup);
            CREATE TABLE story_urls (workspace TEXT NOT NULL, publication TEXT NOT NULL, story_id TEXT NOT NULL, url TEXT NOT NULL,
              PRIMARY KEY(workspace,publication,story_id,url), FOREIGN KEY(workspace,publication,story_id) REFERENCES stories ON DELETE CASCADE) STRICT;
            CREATE INDEX story_url_lookup ON story_urls(workspace,publication,url);
            CREATE TABLE story_entities (workspace TEXT NOT NULL, publication TEXT NOT NULL, story_id TEXT NOT NULL, entity TEXT NOT NULL,
              PRIMARY KEY(workspace,publication,story_id,entity), FOREIGN KEY(workspace,publication,story_id) REFERENCES stories ON DELETE CASCADE) STRICT;
            CREATE INDEX story_entity_lookup ON story_entities(workspace,publication,entity);
            CREATE TABLE coverage (workspace TEXT NOT NULL, publication TEXT NOT NULL, key TEXT NOT NULL, story_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER, request_identity TEXT NOT NULL, payload TEXT NOT NULL,
              PRIMARY KEY(workspace,publication,key), FOREIGN KEY(workspace,publication,story_id) REFERENCES stories(workspace,publication,id) ON DELETE CASCADE) STRICT;
            CREATE INDEX coverage_conflict ON coverage(workspace,publication,story_id,kind,status,expires_at);
            CREATE TABLE memory_journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, publication TEXT NOT NULL, category TEXT NOT NULL, entity TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL,
              FOREIGN KEY(workspace,publication) REFERENCES scopes ON DELETE CASCADE) STRICT;
            PRAGMA user_version=1;
          `);
        }
        this.db.prepare('INSERT OR IGNORE INTO scopes VALUES (?,?)').run(...this.bind());
      });
    } catch (error) { this.db.close(); this.closed = true; throw error; }
  }
  private bind(): [string, string] { return [this.scope.workspaceId, this.scope.publicationId]; }
  private active(): void { if (this.closed) throw new Error('Memory store is closed'); }
  private transaction<T>(fn: () => T): T {
    this.active(); this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private journal(category: string, entity: string, at: number, value: unknown): void {
    if (category.startsWith('memory-')) { const row = value as MemoryRecord; value = { key: row.key, revision: row.revision, status: row.status, sha256: memoryHash(row) }; }
    this.db.prepare('INSERT INTO memory_journal(workspace,publication,category,entity,at,payload) VALUES (?,?,?,?,?,?)').run(...this.bind(), category, entity, at, JSON.stringify(value));
  }
  private saveMemory(record: MemoryRecord): void {
    this.db.prepare(`INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace,publication,key) DO UPDATE SET revision=excluded.revision,kind=excluded.kind,status=excluded.status,effective_at=excluded.effective_at,expires_at=excluded.expires_at,payload=excluded.payload`)
      .run(...this.bind(), record.key, record.revision, record.kind, record.status, record.effectiveAt, record.expiresAt, JSON.stringify(record));
    this.db.prepare('INSERT INTO memory_revisions VALUES (?,?,?,?,?)').run(...this.bind(), record.key, record.revision, JSON.stringify(record));
  }
  async putMemory(value: MemoryWrite, now: number): Promise<MemoryRecord> {
    validateMemoryWrite(value, now);
    return this.transaction(() => {
      const previous = decode<MemoryRecord>(this.db.prepare('SELECT payload FROM memories WHERE workspace=? AND publication=? AND key=?').get(...this.bind(), value.key));
      const record = memoryRecord(value, previous, this.scope, now); if (record.revision === previous?.revision) return record; this.saveMemory(record); this.journal('memory-write', record.key, now, record); return structuredClone(record);
    });
  }
  async getMemory(key: string): Promise<MemoryRecord | null> {
    this.active(); validateRetentionKey(key);
    return decode<MemoryRecord>(this.db.prepare('SELECT payload FROM memories WHERE workspace=? AND publication=? AND key=?').get(...this.bind(), key));
  }
  async recall(query: MemoryQuery): Promise<MemoryRecord[]> {
    this.active(); validateMemoryQuery(query);
    if (query.keys?.length === 0 || query.tags?.length === 0) return [];
    const args: Array<string | number> = [...this.bind(), query.now, query.now, ...query.kinds];
    let where = `workspace=? AND publication=? AND status='approved' AND effective_at<=? AND (expires_at IS NULL OR expires_at>?) AND kind IN (${placeholders(query.kinds)})`;
    if (query.keys) { where += ` AND key IN (${placeholders(query.keys)})`; args.push(...query.keys); }
    if (query.tags) { where += ` AND EXISTS (SELECT 1 FROM json_each(memories.payload,'$.tags') WHERE value IN (${placeholders(query.tags)}))`; args.push(...query.tags); }
    const rows = this.db.prepare(`SELECT payload FROM memories WHERE ${where} ORDER BY effective_at DESC,key ASC LIMIT ?`).all(...args, query.limit);
    return boundRecall(rows.map(row => decode<MemoryRecord>(row)!), query);
  }
  async putStory(story: StoredStory): Promise<void> {
    validateStoredStory(story);
    this.transaction(() => {
      const existing = this.db.prepare('SELECT content_id FROM stories WHERE workspace=? AND publication=? AND id=?').get(...this.bind(), story.id);
      const identity = storyContentIdentity(story);
      if (existing) { if (existing.content_id !== identity) throw new Error('Story content revision changed at an immutable id'); return; }
      this.db.prepare('INSERT INTO stories VALUES (?,?,?,?,?,?,?)').run(...this.bind(), story.id, identity, storyIdentityLookup(story), story.observedAt, JSON.stringify(story));
      for (const url of story.canonicalUrls) this.db.prepare('INSERT INTO story_urls VALUES (?,?,?,?)').run(...this.bind(), story.id, url);
      for (const entity of new Set(story.entities.map(storyLookupEntity))) this.db.prepare('INSERT INTO story_entities VALUES (?,?,?,?)').run(...this.bind(), story.id, entity);
      this.journal('story-observed', story.id, story.observedAt, story);
    });
  }
  async findStories(query: StoryQuery): Promise<StoredStory[]> {
    this.active(); validateStoryQuery(query);
    const args: Array<string | number> = [...this.bind(), query.since], matches: string[] = [];
    if (query.canonicalUrls?.length) { matches.push(`EXISTS (SELECT 1 FROM story_urls u WHERE u.workspace=s.workspace AND u.publication=s.publication AND u.story_id=s.id AND u.url IN (${placeholders(query.canonicalUrls)}))`); args.push(...query.canonicalUrls); }
    if (query.entities?.length) { matches.push(`EXISTS (SELECT 1 FROM story_entities e WHERE e.workspace=s.workspace AND e.publication=s.publication AND e.story_id=s.id AND e.entity IN (${placeholders(query.entities)}))`); args.push(...query.entities.map(storyLookupEntity)); }
    if ((query.canonicalUrls || query.entities) && !matches.length) return [];
    return this.db.prepare(`SELECT payload FROM stories s WHERE s.workspace=? AND s.publication=? AND s.observed_at>=? ${matches.length ? `AND (${matches.join(' OR ')})` : ''} ORDER BY observed_at DESC,id ASC LIMIT ?`).all(...args, query.limit).map(row => decode<StoredStory>(row)!);
  }
  private conflict(storyId: string, kind: string, now: number, except = ''): CoverageRecord | null {
    const active = "c.workspace=? AND c.publication=? AND c.kind=? AND c.key<>? AND (c.status IN ('submitted-unconfirmed','published') OR c.status='reserved' AND c.expires_at>?)";
    const args = [...this.bind(), kind, except, now];
    const exact = decode<CoverageRecord>(this.db.prepare(`SELECT c.payload FROM coverage c WHERE ${active} AND c.story_id=? ORDER BY c.updated_at,c.key LIMIT 1`).get(...args, storyId));
    if (exact) return exact;
    const current = decode<StoredStory>(this.db.prepare('SELECT payload FROM stories WHERE workspace=? AND publication=? AND id=?').get(...this.bind(), storyId));
    if (!current || !storyIdentityLookup(current)) return null;
    const candidates = this.db.prepare(`SELECT c.payload, s.payload AS story FROM coverage c JOIN stories s ON s.workspace=c.workspace AND s.publication=c.publication AND s.id=c.story_id WHERE ${active} AND s.identity_lookup=? ORDER BY c.updated_at,c.key LIMIT 101`).all(...args, storyIdentityLookup(current));
    for (const candidate of candidates.slice(0, 100)) {
      const prior = JSON.parse(String(candidate.story)) as StoredStory;
      if (compareStoryEvents(current.event, prior.event).decision === 'same_event') return decode<CoverageRecord>(candidate);
    }
    if (candidates.length > 100) throw new Error('Coverage identity check exceeds its bounded candidate limit; no reservation acquired');
    return null;
  }
  private saveCoverage(record: CoverageRecord): void {
    this.db.prepare('UPDATE coverage SET status=?,updated_at=?,expires_at=?,payload=? WHERE workspace=? AND publication=? AND key=?').run(record.status, record.updatedAt, record.expiresAt, JSON.stringify(record), ...this.bind(), record.idempotencyKey);
  }
  async reserveCoverage(record: CoverageRecord): Promise<{ acquired: boolean; record: CoverageRecord }> {
    validateCoverageRecord(record);
    return this.transaction(() => {
      const now = this.now(); validateMemoryTime(now); if (record.updatedAt > now) throw new Error('Reservation timestamp is in the future');
      const existing = this.db.prepare('SELECT request_identity,payload FROM coverage WHERE workspace=? AND publication=? AND key=?').get(...this.bind(), record.idempotencyKey);
      if (existing) {
        if (existing.request_identity !== coverageRequestIdentity(record)) throw new Error('Coverage idempotency key cannot change its original request');
        const current = decode<CoverageRecord>(existing)!; return { acquired: coverageAcquired(current, now), record: current };
      }
      if (record.expiresAt !== null && record.expiresAt <= now) throw new Error('An expired request cannot acquire a reservation');
      if (!this.db.prepare('SELECT 1 FROM stories WHERE workspace=? AND publication=? AND id=?').get(...this.bind(), record.storyId)) throw new Error('Coverage requires a story in this exact scope');
      const conflict = record.status === 'reserved' ? this.conflict(record.storyId, record.kind, now) : null;
      if (conflict) return { acquired: false, record: conflict };
      this.db.prepare('INSERT INTO coverage VALUES (?,?,?,?,?,?,?,?,?,?)').run(...this.bind(), record.idempotencyKey, record.storyId, record.kind, record.status, record.updatedAt, record.expiresAt, coverageRequestIdentity(record), JSON.stringify(record));
      this.journal('coverage-reserved', record.idempotencyKey, record.updatedAt, record);
      return { acquired: true, record: structuredClone(record) };
    });
  }
  async transitionCoverage(change: CoverageTransition): Promise<CoverageRecord> {
    validateCoverageTransition(change);
    return this.transaction(() => {
      const record = decode<CoverageRecord>(this.db.prepare('SELECT payload FROM coverage WHERE workspace=? AND publication=? AND key=?').get(...this.bind(), change.idempotencyKey));
      if (!record) throw new Error('Coverage transition requires an existing scoped reservation');
      const now = this.now();
      const next = coverageTransition(record, change, now);
      if (canonicalMemoryJson(next) === canonicalMemoryJson(record)) return next;
      if (['reserved', 'submitted-unconfirmed', 'published'].includes(next.status) && this.conflict(next.storyId, next.kind, now, next.idempotencyKey)) throw new Error('Another run holds coverage for this story and kind');
      this.saveCoverage(next); this.journal('coverage-transition', next.idempotencyKey, change.now, { change, record: next }); return next;
    });
  }
  async coverage(query: CoverageQuery): Promise<CoverageRecord[]> {
    this.active(); validateCoverageQuery(query);
    if (query.storyIds?.length === 0 || query.statuses?.length === 0) return [];
    const args: Array<string | number> = [...this.bind(), query.since]; let where = 'workspace=? AND publication=? AND updated_at>=?';
    if (query.storyIds) { where += ` AND story_id IN (${placeholders(query.storyIds)})`; args.push(...query.storyIds); }
    if (query.statuses) { where += ` AND status IN (${placeholders(query.statuses)})`; args.push(...query.statuses); }
    return this.db.prepare(`SELECT payload FROM coverage WHERE ${where} ORDER BY updated_at DESC,key ASC LIMIT ?`).all(...args, query.limit).map(row => decode<CoverageRecord>(row)!);
  }
  async addRetentionReference(recordKey: string, ownerKey: string): Promise<void> {
    validateRetentionKey(recordKey); validateRetentionKey(ownerKey);
    this.transaction(() => { this.db.prepare('INSERT OR IGNORE INTO memory_refs VALUES (?,?,?,?)').run(...this.bind(), recordKey, ownerKey); });
  }
  async removeRetentionReference(recordKey: string, ownerKey: string): Promise<void> {
    validateRetentionKey(recordKey); validateRetentionKey(ownerKey);
    this.transaction(() => { this.db.prepare('DELETE FROM memory_refs WHERE workspace=? AND publication=? AND key=? AND owner=?').run(...this.bind(), recordKey, ownerKey); });
  }
  async maintain(now: number): Promise<MemoryMaintenanceResult> {
    validateMemoryTime(now);
    return this.transaction(() => {
      const result = { retired: 0, deleted: 0, retainedByReference: 0 };
      const rows = this.db.prepare(`SELECT payload FROM memories WHERE workspace=? AND publication=? AND expires_at IS NOT NULL AND expires_at<=? ORDER BY EXISTS(SELECT 1 FROM memory_refs r WHERE r.workspace=memories.workspace AND r.publication=memories.publication AND r.key=memories.key),status='retired',expires_at,key LIMIT 500`).all(...this.bind(), now);
      for (const row of rows) {
        const memory = decode<MemoryRecord>(row)!;
        const referenced = this.db.prepare('SELECT 1 FROM memory_refs WHERE workspace=? AND publication=? AND key=? LIMIT 1').get(...this.bind(), memory.key);
        if (referenced) {
          result.retainedByReference++;
          if (memory.status !== 'retired') { const retired = { ...memory, status: 'retired' as const, revision: memory.revision + 1 }; this.saveMemory(retired); this.journal('memory-retired', memory.key, now, retired); result.retired++; }
        } else { this.db.prepare('DELETE FROM memories WHERE workspace=? AND publication=? AND key=?').run(...this.bind(), memory.key); result.deleted++; }
      }
      return result;
    });
  }
  async deleteScope(): Promise<void> {
    this.transaction(() => { this.db.prepare('DELETE FROM scopes WHERE workspace=? AND publication=?').run(...this.bind()); });
  }
  async close(): Promise<void> { if (!this.closed) { this.db.close(); this.closed = true; } }
}
