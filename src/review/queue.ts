import { assertExplicitApprovalCurrent, currentExplicitApprovalHashes, newsletterPathsFor, releaseExplicitReview, sha256File } from "../pipeline/explicit-approval.js";
import { releaseLock } from "../release-lock.js";
import { persistedVisualReleaseProblem } from "../pipeline/story-diagram.js";
import { unclearedVisualStories } from "../pipeline/visual-choice.js";
import { authorize } from "../workspaces.js";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Script, VideoMeta } from "../types.js";
import { openExternal } from "../platform.js";
import { updateEntry } from "../state/ledger.js";
import { VIDEOS_DIR, readJson, videoDir, writeJson, log } from "../util.js";
import { appendDeliveryEvent } from "../post/delivery.js";

export function allVideos(): VideoMeta[] {
  if (!existsSync(VIDEOS_DIR)) return [];
  return readdirSync(VIDEOS_DIR)
    .map((id) => join(VIDEOS_DIR, id, "meta.json"))
    .filter(existsSync)
    .map((p) => readJson<VideoMeta>(p))
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

export function byStatus(status: VideoMeta["status"]): VideoMeta[] {
  return allVideos().filter((m) => m.status === status);
}

function setStatus(id: string, status: VideoMeta["status"], patch: Partial<VideoMeta> = {}): void {
  const metaPath = join(videoDir(id), "meta.json");
  const meta = readJson<VideoMeta>(metaPath);
  Object.assign(meta, patch, { status, updatedAt: new Date().toISOString() });
  writeJson(metaPath, meta);
}

export function listPending(): void {
  const pending = byStatus("pending_review");
  if (pending.length === 0) {
    console.log("No drafts pending review.");
    return;
  }
  for (const m of pending) {
    console.log(`${m.id}\n  "${m.headline}"  ${m.durationSec ?? "?"}s  created ${m.createdAt}`);
    console.log(`  → npm run preview ${m.id}\n`);
  }
}

export async function preview(id: string): Promise<void> {
  const dir = videoDir(id);
  const videoPath = join(dir, "final.mp4");
  const script = readJson<Script>(join(dir, "script.json"));
  console.log(`\n=== ${id} ===`);
  console.log(`Title:       ${script.publish.title}`);
  console.log(`Description: ${script.publish.description}`);
  console.log(`Hashtags:    ${script.publish.hashtags.join(" ")}`);
  console.log(`LinkedIn:    ${script.publish.linkedinPost}\n`);
  if (existsSync(videoPath)) {
    openExternal(videoPath, (error) => log(`preview open failed: ${error.message}`));
  } else {
    console.log("(no final.mp4 yet)");
  }
}

export function approve(id: string, editTitle?: string): void {
  const unlock = releaseLock();
  try { approveLocked(id, editTitle); } finally { unlock(); }
}

function approveLocked(id: string, editTitle?: string): void {
  const approvalMeta = readJson<VideoMeta>(join(videoDir(id), "meta.json"));
  const approvalActor = authorize("approve", { edition: approvalMeta.edition ?? "daily-roundup", author: approvalMeta.createdBy });
  // Approval reads saved verdicts only; a package produced before the release gate existed (or
  // repaired around it) still cannot be approved with a rejected diagram.
  const visualProblem = persistedVisualReleaseProblem(videoDir(id));
  if (visualProblem) throw new Error(visualProblem);
  const uncleared = unclearedVisualStories(videoDir(id));
  if (uncleared.length) throw new Error(`Story ${uncleared.map(i => i + 1).join(", ")} shows a photo captured from its source, and its rights are not established, so this package cannot be approved. Create a new preview and choose the News snapshot, the Explanation or your own image for ${uncleared.length > 1 ? "those stories" : "that story"}.`);
  if (editTitle) {
    const scriptPath = join(videoDir(id), "script.json");
    const script = readJson<Script>(scriptPath);
    script.publish.title = editTitle;
    writeJson(scriptPath, script);
  }
  const metaPath = join(videoDir(id), "meta.json");
  const meta = readJson<VideoMeta>(metaPath);
  const newsletterPaths = newsletterPathsFor(meta);
  const originalNewsletter = existsSync(newsletterPaths.data)
    ? readFileSync(newsletterPaths.data, "utf8")
    : undefined;
  const newsletterData = originalNewsletter
    ? JSON.parse(originalNewsletter) as { reviewVideo?: { videoId?: string; sha256?: string; byteLength?: number } }
    : undefined;

  if (newsletterData?.reviewVideo) {
    const finalPath = join(videoDir(id), "final.mp4");
    const reviewVideo = newsletterData.reviewVideo;
    const finalSha256 = sha256File(finalPath);
    if (reviewVideo.videoId !== id || reviewVideo.sha256 !== finalSha256 || reviewVideo.byteLength !== statSync(finalPath).size) {
      throw new Error(`${id}: newsletter review media does not match the exact final.mp4; approval refused`);
    }
  }

  const releasedNewsletter = newsletterData ? structuredClone(newsletterData) : undefined;
  if (releasedNewsletter) delete releasedNewsletter.reviewVideo;
  const releasedNewsletterRaw = releasedNewsletter
    ? `${JSON.stringify(releasedNewsletter, null, 2)}\n`
    : undefined;
  const approvedAt = new Date().toISOString();
  const hashes = currentExplicitApprovalHashes(meta, releasedNewsletterRaw);
  const released = releaseExplicitReview(meta, newsletterData, hashes, approvedAt);
  released.meta.approvedBy = approvalActor;
  const releasedMetaRaw = `${JSON.stringify(released.meta, null, 2)}\n`;

  const atomicWrite = (path: string, raw: string): void => {
    const tmp = `${path}.${process.pid}.approval.tmp`;
    writeFileSync(tmp, raw);
    renameSync(tmp, path);
  };
  let newsletterWritten = false;
  try {
    if (releasedNewsletterRaw && releasedNewsletterRaw !== originalNewsletter) {
      atomicWrite(newsletterPaths.data, releasedNewsletterRaw);
      newsletterWritten = true;
    }
    atomicWrite(metaPath, releasedMetaRaw);
  } catch (e) {
    if (newsletterWritten && originalNewsletter !== undefined) atomicWrite(newsletterPaths.data, originalNewsletter);
    throw e;
  }

  assertExplicitApprovalCurrent(readJson<VideoMeta>(metaPath));
  // Append-only record of the release decision (src/post/delivery.ts). Fires on every bind — a
  // re-bind after the newsletter linkback (see postApproved) is a real event worth seeing, since
  // the 2026-08-25 approval livelock was exactly a chain of invisible re-binds.
  appendDeliveryEvent(videoDir(id), {
    type: "release.approved", videoId: id,
    detail: { previousStatus: meta.status, videoSha256: hashes.videoSha256, scriptSha256: hashes.scriptSha256 },
  });
  log(`${id} explicitly approved with exact topic/script/video/newsletter hashes — run: npm run post`);
}

export function reject(id: string, reason?: string): void {
  const unlock = releaseLock(); try { rejectLocked(id, reason); } finally { unlock(); }
}
function rejectLocked(id: string, reason?: string): void {
  const target = readJson<VideoMeta>(join(videoDir(id), "meta.json"));
  authorize("approve", { edition: target.edition ?? "daily-roundup", author: target.createdBy });
  setStatus(id, "rejected", { rejectReason: reason, explicitApproval: undefined, approvedBy: undefined, reviewHold: { reason: reason ?? "Rejected by reviewer", requestedAt: new Date().toISOString() } });
  updateEntry(id, { status: "rejected" });
  log(`${id} rejected${reason ? `: ${reason}` : ""} (topic stays in ledger so it won't be re-picked)`);
}
