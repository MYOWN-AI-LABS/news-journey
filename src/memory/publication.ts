import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Platform, PostResult, Topic, TopicStory, VideoMeta } from '../types.js';
import { activeRoot, atomicJson, contained, read, safeId } from '../workspaces.js';
import { confirmStoryPublication, markStorySubmission, reserveStoryPublication } from './runtime.js';
import type { PublicationReceipt } from './types.js';
import { assertExplicitApprovalCurrent, newsletterKeyFor, newsletterPathsFor } from '../pipeline/explicit-approval.js';

/** A live title is meaningful only for the newsletter bound to this exact approved package. */
export function assertApprovedNewsletterPackage(meta: VideoMeta, key = newsletterKeyFor(meta)): void {
  assertExplicitApprovalCurrent(meta);
  if (newsletterKeyFor(meta) !== key || !meta.explicitApproval?.newsletterDataSha256 || !meta.explicitApproval.newsletterLinkedinHtmlSha256) {
    throw new Error('Newsletter is not bound to this exact approved package');
  }
  const data = read<{ sourceVideoId?: string; video?: { id?: string } | null }>(newsletterPathsFor(meta).data, {});
  if (data.sourceVideoId !== meta.id || data.video && data.video.id !== meta.id) {
    throw new Error('Newsletter source identity does not match the approved package');
  }
}

export function newsletterSubmissionBinding(meta: VideoMeta) {
  const approval = meta.explicitApproval;
  if (![approval?.topicSha256, approval?.newsletterDataSha256, approval?.newsletterLinkedinHtmlSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
    throw new Error('Newsletter submission needs its exact approved artifact hashes');
  }
  return { version: 1, sourceVideoId: meta.id, topicSha256: approval!.topicSha256,
    newsletterDataSha256: approval!.newsletterDataSha256, newsletterLinkedinHtmlSha256: approval!.newsletterLinkedinHtmlSha256 };
}

/** Discovery by title alone must never confirm a different edition's source evidence. */
export function assertNewsletterSubmissionReceipt(meta: VideoMeta, issueUrl: string, root = activeRoot()): void {
  const marker = read<{ url?: string; memoryBinding?: Record<string, unknown> }>(contained(root, 'workdir/newsletters', `.published-${newsletterKeyFor(meta)}`), {});
  const binding = newsletterSubmissionBinding(meta);
  if (marker.url !== issueUrl || !marker.memoryBinding || Object.keys(marker.memoryBinding).length !== Object.keys(binding).length
    || Object.entries(binding).some(([key, value]) => marker.memoryBinding![key] !== value)) {
    throw new Error('Live newsletter has no exact package-bound submission receipt; title-only or legacy evidence needs reviewed reconciliation');
  }
}

function platformSubmissionBinding(meta: VideoMeta) {
  const approval = meta.explicitApproval;
  if (![approval?.topicSha256, approval?.scriptSha256, approval?.videoSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) throw new Error('Platform submission needs the exact approved topic, script and video');
  return { version: 1, sourceVideoId: meta.id, topicSha256: approval!.topicSha256, scriptSha256: approval!.scriptSha256, videoSha256: approval!.videoSha256 };
}

/** Write only after the provider returns a validated accepted result. It is not proof of live delivery. */
export function recordAcceptedPlatformMemory(meta: VideoMeta, platform: Platform, post: PostResult, root = activeRoot()): boolean {
  safeId(meta.id); safeId(platform);
  if (post.receiptOrigin !== 'provider-response') {
    try { assertAcceptedPlatformMemory(meta, platform, post, root); return true; }
    catch { return false; } // A title/profile match must not acquire a new artifact identity.
  }
  atomicJson(contained(root, 'workdir/videos', meta.id, `.memory-delivery-${platform}.json`), {
    platform, remoteId: post.id, url: post.url ?? null, binding: platformSubmissionBinding(meta),
  });
  return true;
}

export function assertAcceptedPlatformMemory(meta: VideoMeta, platform: Platform, post: PostResult, root = activeRoot()): void {
  safeId(meta.id); safeId(platform);
  const record = read<{ platform?: string; remoteId?: string; url?: string | null; binding?: Record<string, unknown> }>(contained(root, 'workdir/videos', meta.id, `.memory-delivery-${platform}.json`), {});
  const binding = platformSubmissionBinding(meta);
  if (record.platform !== platform || record.remoteId !== post.id || record.url !== (post.url ?? null) || !record.binding
    || Object.keys(record.binding).length !== Object.keys(binding).length || Object.entries(binding).some(([key, value]) => record.binding![key] !== value)) {
    throw new Error('Live post has no exact package-bound accepted submission; legacy receipts need reviewed reconciliation');
  }
}

/** Source bytes must still be those approved for the delivery being recorded. */
export function approvedPublicationStories(id: string, root = activeRoot()): TopicStory[] {
  safeId(id);
  const dir = contained(root, 'workdir/videos', id), topicPath = contained(dir, 'topic.json');
  const meta = read<VideoMeta | null>(contained(dir, 'meta.json'), null);
  if (!meta || meta.id !== id || !existsSync(topicPath)) throw new Error('Publication memory requires the exact saved package');
  const bytes = readFileSync(topicPath);
  if (!meta.explicitApproval?.topicSha256 || createHash('sha256').update(bytes).digest('hex') !== meta.explicitApproval.topicSha256) throw new Error('Publication memory cannot adopt missing or changed approval evidence');
  const topic = JSON.parse(bytes.toString()) as Topic;
  if (topic.id !== id || !Array.isArray(topic.stories) || topic.stories.length < 1 || topic.stories.length > 8) throw new Error('Publication memory requires the exact prepared story packet; legacy output needs reviewed migration');
  return topic.stories;
}

export async function reservePublicationMemory(id: string, root = activeRoot()): Promise<void> {
  await reserveStoryPublication(approvedPublicationStories(id, root), id, root);
}
export async function markPublicationMemorySubmitted(id: string, root = activeRoot()): Promise<void> {
  await markStorySubmission(approvedPublicationStories(id, root), id, root);
}
export async function confirmPublicationMemory(id: string, receipt: PublicationReceipt, root = activeRoot()): Promise<void> {
  await confirmStoryPublication(approvedPublicationStories(id, root), id, receipt, root);
}
