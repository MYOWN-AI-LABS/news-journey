import { existsSync, readdirSync } from 'node:fs';
import { atomicJson, contained } from './workspaces.js';
import { readJson } from './util.js';
import { readPersonalization } from './personalization.js';

/**
 * The Journey's two modes (Saaket, 2026-09-17): "Human in the loop" (default) waits for the person's story and
 * visual choices and their approval; "Automated" follows the recommendations, and after the first N approved
 * editions approves and publishes each green preview to the enabled channels. Two things never loosen: the
 * rights gate (a review-only source photograph is never published) and the fact budget (no repair adds a claim).
 * The mode lives in config/automation.json so it is available to Free and Pro alike and leaves
 * config/pipeline.json's "autonomy": "review" untouched.
 */
export interface AutomationSettings { mode: 'review' | 'auto'; autoApproveAfter: number }
const DEFAULT_AUTOMATION: AutomationSettings = { mode: 'review', autoApproveAfter: 3 };

function validateAutomation(value: unknown): AutomationSettings {
  const row = value as Partial<AutomationSettings> | null;
  if (!row || typeof row !== 'object' || !['review', 'auto'].includes(String(row.mode))
    || !Number.isInteger(row.autoApproveAfter) || (row.autoApproveAfter as number) < 0 || (row.autoApproveAfter as number) > 100
    || Object.keys(row).some(key => !['mode', 'autoApproveAfter'].includes(key))) throw new Error('Choose "Human in the loop" or "Automated", and a number of approved editions from 0 to 100 before automated approval starts');
  return { mode: row.mode as AutomationSettings['mode'], autoApproveAfter: row.autoApproveAfter as number };
}
export function saveAutomationSettings(root: string, value: unknown): AutomationSettings {
  const settings = validateAutomation(value);
  atomicJson(contained(root, 'config/automation.json'), settings); return settings;
}
/** A missing or garbled file means review mode: automation never switches itself on. */
export function readAutomationSettings(root: string): AutomationSettings {
  try { return validateAutomation(readJson(contained(root, 'config/automation.json'), DEFAULT_AUTOMATION)); } catch { return { ...DEFAULT_AUTOMATION }; }
}
export const automationAuto = (root: string): boolean => readAutomationSettings(root).mode === 'auto';

/** The Journey passes HARNESS_STORY_CHOICE=require; manual ranking also asks. Automated mode takes the recommendation. */
export function storyChoiceRequired(root: string, rankingMode: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return (rankingMode === 'manual' || env.HARNESS_STORY_CHOICE === 'require') && !automationAuto(root);
}
/** The Journey passes HARNESS_VISUAL_CHOICE=require; recommendationsAuto (Pro) or Automated mode takes the recommendation. */
export function visualChoiceRequired(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HARNESS_VISUAL_CHOICE === 'require' && !readPersonalization(root).recommendationsAuto && !automationAuto(root);
}

/** Editions a person (or automation) has approved in this workspace: the counter behind "after the first N". */
export function approvedEditionCount(root: string): number {
  const dir = contained(root, 'workdir/videos');
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const id of readdirSync(dir)) {
    const meta = readJson<{ status?: string; approvedBy?: unknown } | null>(contained(dir, id, 'meta.json'), null);
    if (meta && (typeof meta.approvedBy === 'string' && meta.approvedBy || ['approved', 'posted'].includes(String(meta.status)))) count++;
  }
  return count;
}

export interface AutomatedReleaseStep { step: 'receipts' | 'threshold' | 'approve' | 'newsletter' | 'post' | 'link'; status: 'done' | 'skipped' | 'failed'; detail: string }
export interface AutomatedReleaseReceipt {
  version: 1; id: string; at: string; outcome: 'published' | 'approved' | 'held';
  approvedEditions: number; autoApproveAfter: number; steps: AutomatedReleaseStep[]; reason?: string;
}
export interface AutomatedReleaseDeps {
  approve: (id: string) => void;
  publishNewsletter: (date: string, editionId?: string) => Promise<string>;
  postApproved: (opts: { id: string }) => Promise<void>;
  linkVideoIntoNewsletter: (opts: { date: string; editionId?: string; videoUrl: string }) => Promise<unknown>;
  releaseProblem: (dir: string) => string | null;
  uncleared: (dir: string) => number[];
}
async function defaultDeps(): Promise<AutomatedReleaseDeps> {
  const [queue, newsletter, post, link, diagrams, choice] = await Promise.all([
    import('./review/queue.js'), import('./publish/publishNewsletter.js'), import('./post/index.js'), import('./publish/linkVideoIntoNewsletter.js'),
    import('./pipeline/story-diagram.js'), import('./pipeline/visual-choice.js')]);
  return { approve: id => queue.approve(id), publishNewsletter: newsletter.publishNewsletter, postApproved: post.postApproved,
    linkVideoIntoNewsletter: link.linkVideoIntoNewsletter, releaseProblem: diagrams.persistedVisualReleaseProblem, uncleared: choice.unclearedVisualStories };
}

/**
 * Automated release of one completed preview. Every gate that a person's approval applies still applies; the
 * outcome and each step are written beside the package as a receipt, and a refusal leaves the package at
 * pending_review with the reason for the person to see.
 */
export async function automatedRelease(root: string, id: string, deps?: Partial<AutomatedReleaseDeps>): Promise<AutomatedReleaseReceipt> {
  const settings = readAutomationSettings(root);
  const d: AutomatedReleaseDeps = { ...(await defaultDeps()), ...deps };
  const dir = contained(root, 'workdir/videos', id);
  const steps: AutomatedReleaseStep[] = [];
  const approvedEditions = approvedEditionCount(root);
  const receipt = (outcome: AutomatedReleaseReceipt['outcome'], reason?: string): AutomatedReleaseReceipt => {
    const record: AutomatedReleaseReceipt = { version: 1, id, at: new Date().toISOString(), outcome, approvedEditions, autoApproveAfter: settings.autoApproveAfter, steps, ...(reason ? { reason } : {}) };
    atomicJson(contained(root, 'state/automation-releases', `${id}.json`), record);
    return record;
  };
  // 1. Receipts: the script judge, the transcript check, the artwork release gate and the rights gate.
  const scriptQc = readJson<{ ok?: boolean } | null>(contained(dir, 'script-qc.json'), null);
  const audioQc = readJson<{ status?: string } | null>(contained(dir, 'audio-qc.json'), null);
  const problems: string[] = [];
  if (scriptQc && scriptQc.ok !== true) problems.push('the script judge left blocking findings');
  if (!audioQc || audioQc.status !== 'pass') problems.push('the narration transcript check did not pass');
  const artwork = d.releaseProblem(dir); if (artwork) problems.push(artwork);
  const uncleared = d.uncleared(dir); if (uncleared.length) problems.push(`story ${uncleared.map(i => i + 1).join(', ')} shows a source photograph whose rights are not established`);
  if (problems.length) { steps.push({ step: 'receipts', status: 'failed', detail: problems.join('; ') }); return receipt('held', `Not approved automatically: ${problems.join('; ')}. Review the preview yourself.`); }
  steps.push({ step: 'receipts', status: 'done', detail: 'script judge ok, transcript pass, artwork released, rights clear' });
  // 2. Threshold: the person approves the first N editions themselves.
  if (approvedEditions < settings.autoApproveAfter) {
    steps.push({ step: 'threshold', status: 'skipped', detail: `${approvedEditions} approved so far; automated approval starts after ${settings.autoApproveAfter}` });
    return receipt('held', `Automated approval starts after ${settings.autoApproveAfter} approved edition(s); ${approvedEditions} so far. Approve this preview yourself.`);
  }
  steps.push({ step: 'threshold', status: 'done', detail: `${approvedEditions} approved editions ≥ ${settings.autoApproveAfter}` });
  // 3. Approve with every existing gate (rejected diagram, rights, exact media hashes, two-person desks).
  try { d.approve(id); steps.push({ step: 'approve', status: 'done', detail: 'approved' }); }
  catch (error) { steps.push({ step: 'approve', status: 'failed', detail: (error as Error).message.slice(0, 600) }); return receipt('held', `Not approved automatically: ${(error as Error).message.slice(0, 600)}`); }
  // 4. Publish in the Journey's own order: newsletter, then the video to the enabled channels, then the link back.
  const meta = readJson<{ edition?: string; posts?: Record<string, { url?: string }> }>(contained(dir, 'meta.json'), {});
  const { newsletterKeyFor } = await import('./pipeline/explicit-approval.js');
  const date = newsletterKeyFor(meta as never).slice(0, 10), edition = meta.edition || 'daily-roundup', editionId = edition === 'daily-roundup' ? undefined : edition;
  let published = false;
  try { const url = await d.publishNewsletter(date, editionId); steps.push({ step: 'newsletter', status: 'done', detail: String(url) }); published = true; }
  catch (error) { steps.push({ step: 'newsletter', status: 'failed', detail: (error as Error).message.slice(0, 600) }); }
  try { await d.postApproved({ id }); const after = readJson<{ posts?: Record<string, unknown> }>(contained(dir, 'meta.json'), {}); const platforms = Object.keys(after.posts ?? {});
    steps.push({ step: 'post', status: platforms.length ? 'done' : 'skipped', detail: platforms.length ? `receipts for ${platforms.join(', ')}` : 'no enabled channel accepted a post; see the delivery holds' }); if (platforms.length) published = true; }
  catch (error) { steps.push({ step: 'post', status: 'failed', detail: (error as Error).message.slice(0, 600) }); }
  const videoUrl = readJson<{ posts?: Record<string, { url?: string }> }>(contained(dir, 'meta.json'), {}).posts?.linkedin?.url;
  if (videoUrl) { try { await d.linkVideoIntoNewsletter({ date, editionId, videoUrl }); steps.push({ step: 'link', status: 'done', detail: videoUrl }); } catch (error) { steps.push({ step: 'link', status: 'failed', detail: (error as Error).message.slice(0, 600) }); } }
  else steps.push({ step: 'link', status: 'skipped', detail: 'no LinkedIn video post to link' });
  return receipt(published ? 'published' : 'approved');
}

export function automationState(root: string): AutomationSettings & { approvedEditions: number; lastRelease: AutomatedReleaseReceipt | null } {
  const dir = contained(root, 'state/automation-releases');
  let last: AutomatedReleaseReceipt | null = null;
  if (existsSync(dir)) for (const name of readdirSync(dir)) {
    const record = readJson<AutomatedReleaseReceipt | null>(contained(dir, name), null);
    if (record?.at && (!last || record.at > last.at)) last = record;
  }
  return { ...readAutomationSettings(root), approvedEditions: approvedEditionCount(root), lastRelease: last };
}
