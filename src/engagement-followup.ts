import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { activeRoot, atomicJson, authorize, CODE_ROOT, contained, read, safeId } from './workspaces.js';
import { assertProDistribution } from './release-profile.js';
import { releaseLock } from './release-lock.js';
import { collectEngagement, engagementState } from './engagement.js';

const channels = ['x', 'youtube', 'linkedin', 'instagram', 'threads', 'reddit', 'tiktok'] as const;
type Channel = typeof channels[number];
type Step = { platform: Channel; postId: string; url: string; status: 'pending' | 'collecting' | 'complete' | 'manual' | 'failed'; more?: boolean; error?: string };
type Run = { id: string; videoId: string; actor: string; fingerprint: string; headline: string; createdAt: string; updatedAt: string; status: 'running' | 'complete' | 'partial'; steps: Step[] };
const busy = new Set<string>();
const now = () => new Date().toISOString();
const runPath = (root: string, id: string) => contained(root, 'state/engagement-followups', safeId(id) + '.json');

export function followUpState(root: string) {
  const dir = contained(root, 'state/engagement-followups');
  const runs = (existsSync(dir) ? readdirSync(dir) : []).filter(n => /^[\w-]+\.json$/.test(n))
    .map(n => read<Run>(contained(dir, n), null!)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const latest = runs[0];
  return { runs: runs.slice(0, 50), status: runs.length ? 'runs-recorded' : 'not-run', automaticSchedule: false,
    lastCollectionAt: latest?.updatedAt ?? null,
    needsAttention: !latest || latest.status !== 'complete' || Date.now() - Date.parse(latest.updatedAt) > 86400000,
    delivery: 'Collection only. Inspect engagement items and delivery receipts; a completed run does not mean replies were sent.',
    linkedinContacts: 'Manual comment capture is available. Connection requests and direct-message follow-ups are not integrated.' };
}

/** One recorded publication, explicit channels, reusable run ID. Collection can never approve/send. */
export async function runEngagementFollowUp(data: Record<string, unknown>, codeRoot = CODE_ROOT): Promise<Record<string, unknown>> {
  assertProDistribution('Audience follow-ups', codeRoot);
  const root = activeRoot(), actor = authorize('manage', { root });
  if (Object.keys(data).some(k => !['videoId', 'platforms', 'runId'].includes(k))) throw new Error('Unknown follow-up field');
  const videoId = safeId(String(data.videoId || '')), runId = safeId(String(data.runId || ''));
  if (!Array.isArray(data.platforms) || !data.platforms.length || data.platforms.length > channels.length || data.platforms.some(p => !channels.includes(p as Channel))) throw new Error('Choose recorded follow-up channels');
  const platforms = [...new Set(data.platforms as Channel[])].sort();
  if (busy.has(root)) throw new Error('Busy: follow-up collection is already running');
  const unlock = releaseLock(root, 'engagement-followup'); busy.add(root);
  try {
    const metaPath = contained(root, 'workdir/videos', videoId, 'meta.json');
    const meta = read<any>(metaPath, null);
    if (!meta) throw new Error('Unknown publication package');
    const steps: Step[] = platforms.map(platform => {
      authorize('manage', { root, edition: meta.edition || 'daily-roundup', platform });
      const post = meta.posts?.[platform];
      if (!post?.id || !post.url) throw new Error(`No recorded ${platform} post for this package`);
      const url = new URL(post.url);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid recorded post URL');
      return { platform, postId: String(post.id), url: url.href, status: 'pending' };
    });
    const fingerprint = createHash('sha256').update(JSON.stringify({ videoId, steps })).digest('hex');
    const file = runPath(root, runId), prior = read<Run | null>(file, null);
    if (prior && (prior.fingerprint !== fingerprint || prior.actor !== actor.id)) throw new Error('Conflict: follow-up run belongs to another request, actor or post receipt');
    const run: Run = prior || { id: runId, videoId, actor: actor.id, fingerprint, headline: String(meta.headline || videoId), createdAt: now(), updatedAt: now(), status: 'running', steps };
    const save = () => { run.updatedAt = now(); atomicJson(file, run); };
    run.status = 'running'; save();
    for (const step of run.steps) {
      if (['complete', 'manual'].includes(step.status)) continue;
      if (!['x', 'youtube'].includes(step.platform)) { step.status = 'manual'; save(); continue; }
      step.status = 'collecting'; delete step.error; save();
      try {
        const current = read<any>(metaPath, null)?.posts?.[step.platform];
        if (String(current?.id) !== step.postId || new URL(current.url).href !== step.url) throw new Error('Publication receipt changed; review the new post before collection');
        const result = await collectEngagement(root, videoId, step.platform, step.postId);
        step.more = result.more === true; step.status = 'complete';
      } catch (error) {
        let message = String((error as Error).message);
        for (const [key, value] of Object.entries(process.env)) if (/TOKEN|SECRET|KEY|PASSWORD/.test(key) && value && value.length >= 4) message = message.split(value).join('[redacted]');
        step.status = 'failed'; step.error = message.slice(0, 500);
      }
      save();
    }
    run.status = run.steps.some(s => s.status !== 'complete' || s.more) ? 'partial' : 'complete'; save();
    const pending = engagementState(root).items.filter(i => i.videoId === videoId && run.steps.some(s => s.platform === i.platform && s.postId === i.postId) && !['sent', 'dismissed'].includes(i.status));
    return { run, reviewItems: pending.map(i => ({ itemId: i.id, platform: i.platform, status: i.status, category: i.category, url: i.url })),
      handoffs: run.steps.filter(s => s.status === 'manual').map(s => ({ platform: s.platform, postId: s.postId, url: s.url, action: 'Read the actual discussion in the authorized channel session; capture exact comments and observed reactors, then review and deliver public replies.' })),
      collectionComplete: run.status === 'complete',
      replyDelivery: 'Inspect individual receipts; this collection run cannot verify delivery.',
      message: `${run.status === 'complete' ? 'Collection complete' : 'Collection needs attention'}: ${pending.length} visible responses await review. This collection run did not draft, approve or send replies.`, automaticSchedule: false };
  } finally { busy.delete(root); unlock(); }
}
