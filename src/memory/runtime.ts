import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { activeRoot, contained, currentActor, read, safeId } from '../workspaces.js';
import type { TopicStory } from '../types.js';
import { SqliteMemoryStore } from './sqlite.js';
import { canonicalStoryUrl, compareStoryEvents, storyEventFromTopicStory, storyEventHash } from './story-identity.js';
import { validateCoverageTransition } from './validation.js';
import type { CoverageRecord, MemoryStore, PublicationReceipt, StoredStory } from './types.js';

export const MEMORY_WORKFLOW_VERSION = 1;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export { canonicalStoryUrl } from './story-identity.js';

export function memoryPublicationId(root: string): string {
  const config = read<{ publicationId?: string }>(contained(root, 'config/memory.json'), {});
  return safeId(config.publicationId ?? 'default');
}

/** The trusted local workspace path and authenticated actor own scope, never the model. */
export async function withPublicationMemory<T>(fn: (store: MemoryStore) => Promise<T>, root = activeRoot()): Promise<T> {
  const actor = currentActor(root);
  const store = new SqliteMemoryStore(contained(root, 'state/memory/memory.sqlite'), {
    workspaceId: hash(realpathSync(root)), publicationId: memoryPublicationId(root), actorId: actor.id,
  });
  try { return await fn(store); } finally { await store.close(); }
}

export function storedStory(story: TopicStory, now = Date.now()): StoredStory {
  const event = storyEventFromTopicStory(story);
  return { id: storyEventHash(event), event, canonicalUrls: [...new Set([story.primaryUrl, ...(story.claimEvidence ?? []).map(row => row.url)].map(canonicalStoryUrl))],
    entities: story.principalEntity?.trim() ? [story.principalEntity.trim().toLowerCase()] : [],
    sourceHashes: [...new Set((story.claimEvidence ?? []).flatMap(row => row.textSha256 ? [row.textSha256] : []))], observedAt: now };
}

export interface StoryCoverageDecision { url: string; decision: string; reason: string; priorStoryId?: string; priorRunId?: string; receiptUrl?: string }
export async function checkStoryCoverage(stories: TopicStory[], runId: string, lookbackDays = 30, root = activeRoot()): Promise<StoryCoverageDecision[]> {
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 365) throw new Error('Coverage lookback must be 1–365 days');
  if (stories.length > 8) throw new Error('Compare at most eight complete story packets per edition');
  const now = Date.now();
  return withPublicationMemory(async store => {
    const results: StoryCoverageDecision[] = [];
    for (const story of stories) {
      const candidate = storedStory(story, now);
      await store.putStory(candidate);
      const possible = await store.findStories({ canonicalUrls: candidate.canonicalUrls, entities: candidate.entities, since: now - lookbackDays * 86400000, limit: 20 });
      const coverage = await store.coverage({ storyIds: possible.map(row => row.id), statuses: ['published'], since: now - lookbackDays * 86400000, limit: 100 });
      let decision: StoryCoverageDecision = { url: story.primaryUrl, decision: 'uncertain', reason: 'No verified published event match; this story remains eligible.' };
      for (const prior of possible) {
        const published = coverage.find(row => row.storyId === prior.id && row.runId !== runId && row.kind === 'story' && row.receipt);
        if (!published) continue;
        const comparison = compareStoryEvents(candidate.event, prior.event);
        const row = { url: story.primaryUrl, decision: comparison.decision, reason: comparison.reason, priorStoryId: prior.id, priorRunId: published.runId, receiptUrl: published.receipt?.url };
        if (comparison.decision === 'same_event') { decision = row; break; }
        decision = row;
      }
      results.push(decision);
    }
    // Audit decisions are experiences, not automatically approved lessons for later prompts.
    const key = `story-decisions-${hash({ runId, stories: stories.map(story => storyEventHash(storyEventFromTopicStory(story))), results }).slice(0, 48)}`;
    if (!await store.getMemory(key)) await store.putMemory({ key, kind: 'episodic', expectedRevision: null, text: JSON.stringify({ runId, decisions: results }), status: 'proposed', evidenceRefs: stories.map(story => storyEventHash(storyEventFromTopicStory(story))), tags: [runId ? `run-${hash(runId).slice(0, 48)}` : 'selection', 'story-identity'], effectiveAt: now, expiresAt: now + 30 * 86400000 }, now);
    return results;
  }, root);
}

const coverageKey = (runId: string, storyId: string) => hash({ version: MEMORY_WORKFLOW_VERSION, runId, storyId, kind: 'story' });
export async function reserveStoryPublication(stories: TopicStory[], runId: string, root = activeRoot()): Promise<void> {
  safeId(runId); if (!stories.length || stories.length > 8) throw new Error('Publication needs one to eight exact prepared stories');
  const now = Date.now();
  await withPublicationMemory(async store => {
    const acquired: CoverageRecord[] = [];
    try {
      for (const story of stories) {
        const row = storedStory(story, now); await store.putStory(row);
        const key = coverageKey(runId, row.id);
        const prior = (await store.coverage({ storyIds: [row.id], since: 0, limit: 100 })).find(record => record.idempotencyKey === key);
        if (prior) {
          if (prior.runId !== runId || prior.storyId !== row.id) throw new Error('Publication reservation belongs to a different packet or run');
          if (['published', 'submitted-unconfirmed'].includes(prior.status) || prior.status === 'reserved' && prior.expiresAt !== null && prior.expiresAt > now) continue;
          throw new Error('The original publication reservation expired or was cancelled; review a new delivery attempt rather than renewing its saved lease.');
        }
        const reservation = await store.reserveCoverage({ idempotencyKey: key, storyId: row.id, runId, kind: 'story', status: 'reserved', updatedAt: now, expiresAt: now + 3600000 });
        if (!reservation.acquired || reservation.record.idempotencyKey !== key || reservation.record.storyId !== row.id || reservation.record.runId !== runId) {
          throw new Error(`This exact event already has a different publication reservation (${reservation.record.runId}); retain its original packet and resolve that delivery before a new attempt.`);
        }
        acquired.push(reservation.record);
      }
    } catch (error) {
      // No submission happens inside this function. Roll back only this call's newly acquired
      // leases; existing and ambiguous attempts are never cancelled or renewed.
      const cleanupErrors: string[] = [];
      for (const row of acquired) {
        try {
          const current = (await store.coverage({ storyIds: [row.storyId], since: 0, limit: 100 })).find(item => item.idempotencyKey === row.idempotencyKey);
          if (current?.status === 'reserved') await store.transitionCoverage({ idempotencyKey: row.idempotencyKey, expectedStatus: 'reserved', status: 'cancelled', now: Date.now() });
        } catch (cleanup) { cleanupErrors.push((cleanup as Error).message); }
      }
      if (cleanupErrors.length) throw new Error(`${(error as Error).message}; partial reservation cleanup needs review: ${cleanupErrors.join('; ')}`, { cause: error });
      throw error;
    }
  }, root);
}

export async function markStorySubmission(stories: TopicStory[], runId: string, root = activeRoot()): Promise<void> {
  await reserveStoryPublication(stories, runId, root);
  await withPublicationMemory(async store => {
    const now = Date.now();
    for (const story of stories) {
      const idempotencyKey = coverageKey(runId, storedStory(story, now).id);
      const records = await store.coverage({ storyIds: [storedStory(story, now).id], since: 0, limit: 100 });
      const row = records.find(record => record.idempotencyKey === idempotencyKey);
      if (!row || row.storyId !== storedStory(story, now).id || row.runId !== runId || !['reserved', 'submitted-unconfirmed', 'published'].includes(row.status)) throw new Error('Submission has no exact active packet reservation');
      if (row.status === 'reserved') await store.transitionCoverage({ idempotencyKey, expectedStatus: 'reserved', status: 'submitted-unconfirmed', now });
    }
  }, root);
}

/** Call only after the existing independent live-delivery check succeeds. */
export async function confirmStoryPublication(stories: TopicStory[], runId: string, receipt: PublicationReceipt, root = activeRoot()): Promise<void> {
  safeId(runId); if (!stories.length || stories.length > 8) throw new Error('Confirmation needs one to eight exact prepared stories');
  await withPublicationMemory(async store => {
    const now = Date.now();
    for (const story of stories) {
      const storyId = storedStory(story, now).id, idempotencyKey = coverageKey(runId, storyId);
      validateCoverageTransition({ idempotencyKey, expectedStatus: 'submitted-unconfirmed', status: 'published', receipt, now });
      const rows = await store.coverage({ storyIds: [storyId], since: 0, limit: 100 });
      const row = rows.find(record => record.idempotencyKey === idempotencyKey);
      if (row?.status === 'published') continue;
      if (row?.status !== 'submitted-unconfirmed') throw new Error('Confirmed delivery has no matching durable submission');
      await store.transitionCoverage({ idempotencyKey, expectedStatus: row.status, status: 'published', receipt, now });
    }
  }, root);
}
