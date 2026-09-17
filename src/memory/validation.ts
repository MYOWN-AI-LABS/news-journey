import { createHash } from 'node:crypto';
import { validateStoryEventPacket } from './story-identity.js';
import type { CoverageQuery, CoverageRecord, CoverageStatus, CoverageTransition, MemoryQuery, MemoryRecord, MemoryScope, MemoryWrite, PublicationReceipt, StoredStory, StoryQuery } from './types.js';

export const canonicalMemoryJson = (value: unknown): string => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const memoryHash = (value: unknown): string => createHash('sha256').update(canonicalMemoryJson(value)).digest('hex');

const kinds = ['working', 'semantic', 'episodic', 'procedural'];
const statuses: CoverageStatus[] = ['draft', 'reserved', 'submitted-unconfirmed', 'published', 'retracted', 'cancelled'];
function fail(message: string): never { throw new Error(`Memory: ${message}`); }
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('invalid or unexpected record fields');
}
function text(value: unknown, name: string, max = 200): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(`invalid ${name}`);
}
export function validateRetentionKey(value: unknown): asserts value is string { text(value, 'reference key'); }
export function validateMemoryTime(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 8640000000000000) fail('invalid timestamp');
}
function strings(value: unknown, name: string, max: number, width = 200): asserts value is string[] {
  if (!Array.isArray(value) || value.length > max || new Set(value).size !== value.length) fail(`invalid ${name}`);
  value.forEach(item => text(item, name, width));
}
function bounded(value: unknown, max: number): void { if (Buffer.byteLength(JSON.stringify(value)) > max) fail('record exceeds byte limit'); }
function url(value: unknown): void {
  text(value, 'source URL', 2048);
  try { const parsed = new URL(value); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('invalid source URL'); }
  catch { fail('invalid source URL'); }
}
function count(value: unknown, max: number): void { if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) fail('invalid retrieval bound'); }
export function validateScope(value: MemoryScope): void {
  object(value, ['workspaceId', 'publicationId', 'actorId']);
  for (const key of ['workspaceId', 'publicationId', 'actorId']) text(value[key], key, 160);
}
export function validateMemoryWrite(value: MemoryWrite, now: number): void {
  object(value, ['key', 'kind', 'text', 'status', 'evidenceRefs', 'tags', 'effectiveAt', 'expiresAt', 'verificationRef', 'expectedRevision']);
  validateMemoryTime(now); text(value.key, 'key', 160); text(value.text, 'text', 16000);
  if (!kinds.includes(value.kind) || !['proposed', 'approved', 'retired'].includes(value.status)) fail('invalid kind or approval status');
  if (value.expectedRevision !== null && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1)) fail('invalid expected revision');
  validateMemoryTime(value.effectiveAt); if (value.expiresAt !== null) { validateMemoryTime(value.expiresAt); if (value.expiresAt <= value.effectiveAt) fail('expiry must follow effective time'); }
  strings(value.evidenceRefs, 'evidence references', 32, 2048); strings(value.tags, 'tags', 20, 100);
  if (value.verificationRef !== undefined) text(value.verificationRef, 'verification reference', 2048);
  if (value.status === 'approved' && ['episodic', 'procedural'].includes(value.kind) && (!value.verificationRef || !value.evidenceRefs.length)) fail('approved lessons and procedures need evidence and verification');
  bounded(value, 32768);
}
export function memoryContentIdentity(value: MemoryWrite | MemoryRecord): string {
  return createHash('sha256').update(JSON.stringify([value.key, value.kind, value.text, value.status, value.evidenceRefs, value.tags, value.effectiveAt, value.expiresAt, value.verificationRef ?? null])).digest('hex');
}
export function memoryRecord(value: MemoryWrite, previous: MemoryRecord | null, scope: MemoryScope, now: number): MemoryRecord {
  validateScope(scope); validateMemoryWrite(value, now);
  if (previous && memoryContentIdentity(value) === memoryContentIdentity(previous)
    && (value.expectedRevision === previous.revision || value.expectedRevision === previous.revision - 1 || previous.revision === 1 && value.expectedRevision === null)) return structuredClone(previous);
  if (value.expectedRevision !== (previous?.revision ?? null)) fail('revision conflict; current memory was changed');
  if (previous && value.kind !== previous.kind) fail('a memory key cannot change kind');
  const { expectedRevision: _, ...record } = structuredClone(value);
  return { ...record, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now,
    ...(value.status === 'approved' ? { approvedBy: scope.actorId } : value.status === 'retired' && previous?.approvedBy ? { approvedBy: previous.approvedBy } : {}) };
}
export function validateMemoryQuery(value: MemoryQuery): void {
  object(value, ['kinds', 'keys', 'tags', 'now', 'limit', 'maxBytes']); strings(value.kinds, 'kinds', 4);
  if (!value.kinds.length || value.kinds.some(kind => !kinds.includes(kind))) fail('invalid recall kinds');
  if (value.keys !== undefined) strings(value.keys, 'keys', 50, 160);
  if (value.tags !== undefined) strings(value.tags, 'tags', 20, 100);
  validateMemoryTime(value.now); count(value.limit, 50); count(value.maxBytes, 65536);
}
/** Whole records only. A byte ceiling never clips facts or qualifier text. */
export function boundRecall(records: MemoryRecord[], query: MemoryQuery): MemoryRecord[] {
  validateMemoryQuery(query); const out: MemoryRecord[] = []; let bytes = 2;
  for (const record of records) {
    if (out.length >= query.limit) break;
    if (record.status !== 'approved' || record.effectiveAt > query.now || record.expiresAt !== null && record.expiresAt <= query.now || !query.kinds.includes(record.kind)
      || query.keys && !query.keys.includes(record.key) || query.tags && !record.tags.some(tag => query.tags!.includes(tag))) continue;
    const length = Buffer.byteLength(JSON.stringify(record)) + (out.length ? 1 : 0);
    if (bytes + length > query.maxBytes) continue;
    bytes += length; out.push(structuredClone(record));
  }
  return out;
}
export function validateStoredStory(value: StoredStory): void {
  object(value, ['id', 'event', 'canonicalUrls', 'entities', 'sourceHashes', 'observedAt']);
  text(value.id, 'story id', 160); validateStoryEventPacket(value.event); validateMemoryTime(value.observedAt);
  strings(value.canonicalUrls, 'canonical URLs', 16, 2048); value.canonicalUrls.forEach(url);
  strings(value.entities, 'entities', 32, 200); strings(value.sourceHashes, 'source hashes', 32, 64);
  if (value.sourceHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) fail('invalid source hash'); bounded(value, 65536);
}
export function storyContentIdentity(value: StoredStory): string {
  const { observedAt: _, ...content } = value; return memoryHash(content);
}
export function storyIdentityLookup(value: StoredStory): string | null {
  const identity = value.event.identity;
  return identity ? memoryHash(['entity', 'action', 'object', 'eventDate', 'version', 'eventId'].map(field => identity[field as keyof typeof identity] && 'value' in identity[field as keyof typeof identity]! ? (identity[field as keyof typeof identity] as { value: string }).value : null)) : null;
}
export function storyLookupEntity(value: string): string { return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' '); }
export function validateStoryQuery(value: StoryQuery): void {
  object(value, ['canonicalUrls', 'entities', 'since', 'limit']);
  if (value.canonicalUrls !== undefined) { strings(value.canonicalUrls, 'canonical URLs', 16, 2048); value.canonicalUrls.forEach(url); }
  if (value.entities !== undefined) strings(value.entities, 'entities', 32, 200);
  validateMemoryTime(value.since); count(value.limit, 50);
}
function receipt(value: PublicationReceipt, now: number): void {
  object(value, ['provider', 'remoteId', 'confirmedAt', 'url']); text(value.provider, 'receipt provider', 100); text(value.remoteId, 'remote receipt id', 512);
  validateMemoryTime(value.confirmedAt); if (value.confirmedAt > now) fail('publication receipt is in the future'); if (value.url !== undefined) url(value.url);
}
export function validateCoverageRecord(value: CoverageRecord): void {
  object(value, ['idempotencyKey', 'storyId', 'runId', 'kind', 'status', 'updatedAt', 'expiresAt', 'receipt', 'resolution']);
  text(value.idempotencyKey, 'idempotency key', 160); text(value.storyId, 'story id', 160); text(value.runId, 'run id', 160);
  if (!['story', 'mention'].includes(value.kind) || !['draft', 'reserved'].includes(value.status) || (value.receipt !== undefined || value.resolution !== undefined)) fail('new coverage must be draft or reserved without a publication receipt');
  validateMemoryTime(value.updatedAt);
  if (value.expiresAt !== null) { validateMemoryTime(value.expiresAt); if (value.expiresAt <= value.updatedAt) fail('reservation expiry must be in the future'); }
  if (value.status === 'reserved' && value.expiresAt === null) fail('a reservation needs a finite expiry');
}
export function coverageRequestIdentity(value: CoverageRecord): string {
  const { updatedAt: _, ...immutable } = value; return memoryHash(immutable);
}
export function validateCoverageQuery(value: CoverageQuery): void {
  object(value, ['storyIds', 'statuses', 'since', 'limit']);
  if (value.storyIds !== undefined) strings(value.storyIds, 'story ids', 50, 160);
  if (value.statuses !== undefined) { strings(value.statuses, 'coverage statuses', 6); if (value.statuses.some(status => !statuses.includes(status))) fail('invalid coverage status'); }
  validateMemoryTime(value.since); count(value.limit, 100);
}
export function validateCoverageTransition(value: CoverageTransition): void {
  object(value, ['idempotencyKey', 'expectedStatus', 'status', 'now', 'receipt', 'resolution']); text(value.idempotencyKey, 'idempotency key', 160); validateMemoryTime(value.now);
  if (!statuses.includes(value.expectedStatus) || !statuses.includes(value.status)) fail('invalid coverage transition status');
  if (value.resolution !== undefined) {
    object(value.resolution, ['kind', 'reference']); text(value.resolution.reference, 'reconciliation reference', 2048);
    if (value.resolution.kind !== 'confirmed-not-submitted' || value.status !== 'cancelled' || value.expectedStatus !== 'submitted-unconfirmed') fail('invalid reconciliation proof');
  }
  if (value.receipt !== undefined) receipt(value.receipt, value.now);
  if (value.status === 'published' && !value.receipt) fail('published coverage requires a confirmed provider receipt');
  if (value.status !== 'published' && value.receipt) fail('a publication receipt is only accepted with confirmed publication');
}
export function coverageAcquired(value: CoverageRecord, now: number): boolean {
  return ['draft', 'reserved'].includes(value.status) && (value.expiresAt === null || value.expiresAt > now);
}
export function coverageTransition(value: CoverageRecord, change: CoverageTransition, now = Date.now()): CoverageRecord {
  validateCoverageTransition(change); validateMemoryTime(now);
  if (change.now > now) fail('coverage transition timestamp is in the future');
  if (value.idempotencyKey !== change.idempotencyKey) fail('coverage identity mismatch');
  // A repeated acknowledged transition is idempotent, including a repeated confirmation.
  if (value.status === change.status) {
    if (change.receipt && canonicalMemoryJson(change.receipt) !== canonicalMemoryJson(value.receipt)) fail('publication receipt changed on retry');
    if (canonicalMemoryJson(change.resolution) !== canonicalMemoryJson(value.resolution)) fail('reconciliation proof changed on retry');
    return structuredClone(value);
  }
  if (value.status !== change.expectedStatus || change.now < value.updatedAt) fail('coverage transition conflict');
  const allowed: Record<CoverageStatus, CoverageStatus[]> = { draft: ['reserved', 'cancelled'], reserved: ['submitted-unconfirmed', 'published', 'cancelled'], 'submitted-unconfirmed': ['published', 'cancelled'], published: ['retracted'], retracted: [], cancelled: [] };
  if (!allowed[value.status].includes(change.status)) fail('unsafe coverage transition');
  if (value.status === 'submitted-unconfirmed' && change.status === 'cancelled' && !change.resolution) fail('ambiguous submission needs explicit reconciliation proof');
  if (['reserved', 'submitted-unconfirmed'].includes(change.status) && (value.expiresAt === null || value.expiresAt <= now)) fail('reservation has expired; it cannot authorize a submission');
  if (change.receipt && change.receipt.confirmedAt < value.updatedAt) fail('publication receipt predates the recorded attempt');
  return { ...structuredClone(value), status: change.status, updatedAt: change.now,
    expiresAt: ['submitted-unconfirmed', 'published', 'retracted'].includes(change.status) ? null : value.expiresAt,
    ...(change.receipt ? { receipt: structuredClone(change.receipt) } : {}),
    ...(change.resolution ? { resolution: structuredClone(change.resolution) } : {}) };
}
