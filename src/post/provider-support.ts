import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Platform, PostResult, VideoMeta } from "../types.js";
import { contained } from "../workspaces.js";
import { DATA_ROOT, videoDir } from "../util.js";
import { createProbes, type ProbeResult } from "./probes.mjs";
import { projectOutcomes, readDeliveryEvents } from "./delivery.js";

const HOSTS: Record<Platform, string[]> = {
  linkedin: ["linkedin.com"], youtube: ["youtube.com", "youtu.be"], instagram: ["instagram.com"],
  x: ["x.com", "twitter.com"], threads: ["threads.com", "threads.net"], tiktok: ["tiktok.com"], reddit: ["reddit.com"],
};
export function validateAcceptedReceipt(platform: Platform, post: PostResult): void {
  if (!post || post.platform !== platform || typeof post.id !== "string" || !post.id.trim()) throw new Error("Provider accepted response has no valid matching receipt; independently verify before retrying");
}
export function validateReceipt(platform: Platform, post: Pick<PostResult, "id" | "url">): void {
  const url = new URL(post.url ?? "");
  if (!post.id || !/^[a-zA-Z0-9:_-]+$/.test(post.id) || url.protocol !== "https:" || url.username || url.password || url.port || !HOSTS[platform]?.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) throw new Error("Invalid provider receipt");
}
export function validatePost(meta: VideoMeta): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!meta.id || !["approved", "posted"].includes(meta.status)) issues.push("Package is not approved");
  for (const name of ["topic.json", "script.json", "final.mp4"]) if (!existsSync(join(videoDir(meta.id), name))) issues.push(`Missing ${name}`);
  return { valid: issues.length === 0, issues };
}
export async function verifyReceipt(platform: Platform, post: PostResult): Promise<ProbeResult> {
  validateReceipt(platform, post);
  return createProbes(DATA_ROOT)[platform]({ id: post.id, url: post.url! });
}
export function credentialFingerprint(platform: string, provider?: string, root = DATA_ROOT): string {
  const h = createHash("sha256");
  for (const path of [...new Set([platform, provider].filter(Boolean))].map((p) => join(root, "state/tokens", `${p}.json`)).concat(join(root, ".env"))) {
    try { h.update(readFileSync(path)); } catch { h.update("missing"); }
  }
  return h.digest("hex");
}
export function retryDecision(meta: VideoMeta, platform: Platform, capabilities: { auth: string; authProvider?: string }, explicit = false, root = DATA_ROOT): { retry: boolean; reason?: string } {
  const outcome = projectOutcomes(readDeliveryEvents(contained(root, "workdir/videos", meta.id)))[platform];
  if (explicit || !outcome || outcome.state !== "failed" || outcome.retryable || capabilities.auth === "oauth-then-browser") return { retry: true };
  const fingerprint = credentialFingerprint(platform, capabilities.authProvider, root);
  if (!outcome.credentialFingerprint || fingerprint !== outcome.credentialFingerprint) return { retry: true };
  return { retry: false, reason: outcome.reason ?? "Provider requires credential repair" };
}
