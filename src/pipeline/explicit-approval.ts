import { newsletterKeyFor } from '../newsletter-key.js';
export { newsletterKeyFor } from '../newsletter-key.js';
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VideoMeta } from "../types.js";
import { WORKDIR, videoDir } from "../util.js";
import type { NewsletterData } from "./newsletter-html.js";
import { renderLinkedInEdition } from "./newsletter-linkedin.js";

export type ExplicitApproval = NonNullable<VideoMeta["explicitApproval"]>;
export type ExplicitApprovalHashes = Omit<ExplicitApproval, "approvedAt">;

export function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path: string): string {
  if (!existsSync(path)) throw new Error(`Explicit approval input is missing: ${path}`);
  return sha256Bytes(readFileSync(path));
}

export function newsletterPathsFor(meta: Pick<VideoMeta, "id" | "edition">): {
  data: string;
  html: string;
  linkedinHtml: string;
} {
  const key = newsletterKeyFor(meta);
  const root = join(WORKDIR, "newsletters");
  return {
    data: join(root, `${key}.json`),
    html: join(root, `${key}.html`),
    linkedinHtml: join(root, `${key}.linkedin.html`),
  };
}

/** Hash every artifact whose editorial/media identity the operator reviewed. Newsletter fields are
 * optional for video-only approvals, but when present they remain mandatory on every later check. */
export function currentExplicitApprovalHashes(
  meta: Pick<VideoMeta, "id" | "edition">,
  newsletterDataOverride?: string,
): ExplicitApprovalHashes {
  const dir = videoDir(meta.id);
  const newsletter = newsletterPathsFor(meta);
  const hashes: ExplicitApprovalHashes = {
    topicSha256: sha256File(join(dir, "topic.json")),
    scriptSha256: sha256File(join(dir, "script.json")),
    videoSha256: sha256File(join(dir, "final.mp4")),
  };
  if (existsSync(newsletter.html)) hashes.newsletterHtmlSha256 = sha256File(newsletter.html);
  if (existsSync(newsletter.linkedinHtml)) hashes.newsletterLinkedinHtmlSha256 = sha256File(newsletter.linkedinHtml);
  if (newsletterDataOverride !== undefined) hashes.newsletterDataSha256 = sha256Bytes(newsletterDataOverride);
  else if (existsSync(newsletter.data)) hashes.newsletterDataSha256 = sha256File(newsletter.data);
  return hashes;
}

export function explicitApprovalMatches(
  approval: ExplicitApproval | undefined,
  current: ExplicitApprovalHashes,
): boolean {
  if (!approval) return false;
  const recorded = Object.entries(approval).filter(([key]) => key !== "approvedAt");
  return recorded.length === Object.keys(current).length && recorded.length > 0 && recorded.every(([key, value]) => current[key as keyof ExplicitApprovalHashes] === value);
}

/** The canonical reverse-link is the only allowed post-approval newsletter derivative. Prove it
 * by reversing exactly two generated fields and reproducing both approved hashes, while also
 * requiring the current LinkedIn HTML to be the deterministic render of the current JSON. */
export function linkedNewsletterDerivativeMatches(input: {
  meta: Pick<VideoMeta, "id" | "headline" | "posts">;
  approval: ExplicitApproval;
  current: ExplicitApprovalHashes;
  newsletterData: NewsletterData;
  linkedinHtml: string;
}): boolean {
  const { meta, approval, current, newsletterData, linkedinHtml } = input;
  if (Object.keys(approval).filter((k) => k !== "approvedAt").sort().join() !== Object.keys(current).sort().join()) return false;
  for (const [key, value] of Object.entries(approval)) {
    if (["approvedAt", "newsletterDataSha256", "newsletterLinkedinHtmlSha256"].includes(key)) continue;
    if (current[key as keyof ExplicitApprovalHashes] !== value) return false;
  }

  const receipt = meta.posts.linkedin?.url;
  const video = newsletterData.video;
  if (!receipt || !/^https:\/\/www\.linkedin\.com\//i.test(receipt)) return false;
  if (newsletterData.sourceVideoId !== meta.id || video?.id !== meta.id) return false;
  if (video.videoUrl !== receipt || video.posted !== true) return false;
  if (renderLinkedInEdition(newsletterData) !== linkedinHtml) return false;

  // Two pre-post states are legitimate, and the reverse-link produces the same result from either:
  //   • the local placeholder, when the media was already usable at approval, and
  //   • null, when `todaysVideo()` found no usable media yet — the approved issue simply
  //     carried no video block, and link-video attached the first one.
  // Only the placeholder was reconstructed before, so every issue approved ahead of its render
  // failed this check AFTER LinkedIn posted, voiding approval and permanently locking out every
  // platform that had not posted yet (2026-08-13: TikTok could not be backfilled).
  const candidates: NewsletterData["video"][] = [
    { ...video, videoUrl: `http://localhost:4777/media/${meta.id}.mp4`, posted: false },
    null,
  ];
  return candidates.some((candidate) => {
    const approvedData = structuredClone(newsletterData);
    approvedData.video = candidate;
    const approvedDataRaw = `${JSON.stringify(approvedData, null, 2)}\n`;
    return sha256Bytes(approvedDataRaw) === approval.newsletterDataSha256
      && sha256Bytes(renderLinkedInEdition(approvedData)) === approval.newsletterLinkedinHtmlSha256;
  });
}

export function releaseExplicitReview<T extends { reviewVideo?: unknown }>(
  meta: VideoMeta,
  newsletterData: T | undefined,
  hashes: ExplicitApprovalHashes,
  approvedAt: string,
): { meta: VideoMeta; newsletterData?: T } {
  const releasedMeta: VideoMeta = {
    ...meta,
    status: "approved",
    updatedAt: approvedAt,
    explicitApproval: { approvedAt, ...hashes },
  };
  delete releasedMeta.reviewHold;
  if (!newsletterData) return { meta: releasedMeta };
  const releasedData = structuredClone(newsletterData);
  delete releasedData.reviewVideo;
  return { meta: releasedMeta, newsletterData: releasedData };
}

export function assertExplicitApprovalCurrent(meta: VideoMeta): ExplicitApproval {
  if (!["approved", "posted"].includes(meta.status)) throw new Error(`${meta.id}: package is not approved for release`);
  if (!meta.explicitApproval) throw new Error(`${meta.id}: no explicit user approval is recorded`);
  const current = currentExplicitApprovalHashes(meta);
  if (explicitApprovalMatches(meta.explicitApproval, current)) return meta.explicitApproval;
  const newsletter = newsletterPathsFor(meta);
  const derivativeMatches = existsSync(newsletter.data) && existsSync(newsletter.linkedinHtml)
    && linkedNewsletterDerivativeMatches({
      meta,
      approval: meta.explicitApproval,
      current,
      newsletterData: JSON.parse(readFileSync(newsletter.data, "utf8")) as NewsletterData,
      linkedinHtml: readFileSync(newsletter.linkedinHtml, "utf8"),
    });
  if (!derivativeMatches) throw new Error(`${meta.id}: approved artifact hashes changed; explicit approval is no longer valid`);
  return meta.explicitApproval;
}
