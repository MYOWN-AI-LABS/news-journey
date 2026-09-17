import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Topic, TopicStory } from '../types.js';
import { activeRoot, contained, read, safeId } from '../workspaces.js';
import { checkStoryCoverage, type StoryCoverageDecision } from '../memory/runtime.js';

export interface CrossPipelineResult {
  repeats: Array<{ url: string; foundIn: string; coveredAt?: string; eventVerified: true }>;
  decisions: StoryCoverageDecision[];
  pass: boolean;
}

/** A shared URL/title/entity retrieves candidates; only supported published event identity excludes.
 * Draft files and unconfirmed delivery are not published history. Missing evidence stays eligible. */
export async function crossPipelineCheck(candidateUrls: string[], currentDay: string, currentId: string,
  lookbackDays = 30, candidateStories?: TopicStory[]): Promise<CrossPipelineResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(currentDay)) throw new Error('Story comparison needs an edition day');
  let stories = candidateStories;
  if (!stories && currentId) {
    safeId(currentId);
    const path = contained(activeRoot(), 'workdir/videos', currentId, 'topic.json');
    if (existsSync(path)) stories = read<Topic>(path, {} as Topic).stories;
  }
  const selected = new Set(candidateUrls);
  const packets = (stories ?? []).filter(story => selected.has(story.primaryUrl));
  const decisions = packets.length ? await checkStoryCoverage(packets, currentId, lookbackDays) : [];
  for (const url of candidateUrls) if (!decisions.some(row => row.url === url)) decisions.push({ url, decision: 'uncertain', reason: 'URL or harvest metadata alone does not establish the same story; retain for sourcing.' });
  const repeats = decisions.filter(row => row.decision === 'same_event').map(row => ({ url: row.url,
    foundIn: `published edition ${row.priorRunId}`, eventVerified: true as const }));
  return { repeats, decisions, pass: repeats.length === 0 };
}
