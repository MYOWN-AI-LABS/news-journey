import type { StoryEventPacket } from './story-identity.js';

/** Constructed by the authenticated service/worker, never from model output. */
export interface MemoryScope { workspaceId: string; publicationId: string; actorId: string }
export type MemoryKind = 'working' | 'semantic' | 'episodic' | 'procedural';
export interface MemoryRecord {
  key: string; kind: MemoryKind; revision: number; text: string;
  status: 'proposed' | 'approved' | 'retired';
  evidenceRefs: string[]; tags: string[];
  createdAt: number; effectiveAt: number; expiresAt: number | null;
  /** A tested procedure or approved lesson must identify its verification. */
  verificationRef?: string;
  approvedBy?: string;
}
export interface MemoryWrite extends Omit<MemoryRecord, 'revision' | 'createdAt' | 'approvedBy'> {
  expectedRevision: number | null;
}
export interface MemoryQuery {
  kinds: MemoryKind[]; keys?: string[]; tags?: string[];
  now: number; limit: number; maxBytes: number;
}
export interface StoredStory {
  id: string; event: StoryEventPacket; canonicalUrls: string[]; entities: string[];
  sourceHashes: string[]; observedAt: number;
}
export interface StoryQuery { canonicalUrls?: string[]; entities?: string[]; since: number; limit: number }
export type CoverageStatus = 'draft' | 'reserved' | 'submitted-unconfirmed' | 'published' | 'retracted' | 'cancelled';
export interface PublicationReceipt {
  provider: string; remoteId: string; confirmedAt: number; url?: string;
}
export interface CoverageRecord {
  idempotencyKey: string; storyId: string; runId: string; kind: 'story' | 'mention';
  status: CoverageStatus; updatedAt: number; expiresAt: number | null;
  receipt?: PublicationReceipt;
  resolution?: { kind: 'confirmed-not-submitted'; reference: string };
}
export interface CoverageQuery { storyIds?: string[]; statuses?: CoverageStatus[]; since: number; limit: number }
export interface CoverageTransition {
  idempotencyKey: string; expectedStatus: CoverageStatus; status: CoverageStatus;
  now: number; receipt?: PublicationReceipt;
  resolution?: { kind: 'confirmed-not-submitted'; reference: string };
}
export interface MemoryMaintenanceResult { retired: number; deleted: number; retainedByReference: number }
/** Local and hosted adapters share behavior; storage choice does not change editorial rules. */
export interface MemoryStore {
  readonly scope: Readonly<MemoryScope>;
  putMemory(value: MemoryWrite, now: number): Promise<MemoryRecord>;
  getMemory(key: string): Promise<MemoryRecord | null>;
  recall(query: MemoryQuery): Promise<MemoryRecord[]>;
  putStory(story: StoredStory): Promise<void>;
  findStories(query: StoryQuery): Promise<StoredStory[]>;
  reserveCoverage(record: CoverageRecord): Promise<{ acquired: boolean; record: CoverageRecord }>;
  transitionCoverage(change: CoverageTransition): Promise<CoverageRecord>;
  coverage(query: CoverageQuery): Promise<CoverageRecord[]>;
  /** References protect retained lessons/acceptance evidence from routine expiry. */
  addRetentionReference(recordKey: string, ownerKey: string): Promise<void>;
  removeRetentionReference(recordKey: string, ownerKey: string): Promise<void>;
  maintain(now: number): Promise<MemoryMaintenanceResult>;
  /** Authorized account deletion overrides retention references and removes dependent records. */
  deleteScope(): Promise<void>;
  close(): Promise<void>;
}
