import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, contained, read, safeId } from "./workspaces.js";
export interface Attribution { id: string; contentId: string; platform: string; destination: string; createdAt: string }
const PLATFORMS = ["linkedin", "youtube", "instagram", "x", "threads", "tiktok", "reddit"];
function store(root: string): string { return contained(root, "state/attribution-links.json"); }
export function createAttribution(root: string, contentId: string, platform: string, destination: string): Attribution {
  safeId(contentId);
  if (!PLATFORMS.includes(platform)) throw new Error("Unknown channel");
  const url = new URL(destination);
  const config = read<{ siteUrl?: string; attribution?: { allowedOrigins?: string[] } }>(contained(root, "config/pipeline.json"), {});
  const allowed = new Set([...(config.attribution?.allowedOrigins ?? []), ...(config.siteUrl ? [new URL(config.siteUrl).origin] : [])]);
  if (url.protocol !== "https:" || url.username || url.password || !allowed.has(url.origin)) throw new Error("Attribution destination must be an explicitly configured publication origin");
  const meta = read<{ id?: string }>(contained(root, "workdir/videos", contentId, "meta.json"), {});
  if (meta.id !== contentId) throw new Error("Unknown content package");
  const id = createHash("sha256").update(`${contentId}\0${platform}`).digest("hex").slice(0, 24);
  const rows = read<Record<string, Attribution>>(store(root), {});
  if (rows[id]) {
    if (rows[id].destination !== url.href) throw new Error("Existing attribution link is immutable");
    return rows[id];
  }
  const link = { id, contentId, platform, destination: url.href, createdAt: new Date().toISOString() };
  rows[id] = link; atomicJson(store(root), rows); return link;
}
export function resolveAttribution(root: string, id: string): Attribution | null {
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  return read<Record<string, Attribution>>(store(root), {})[id] ?? null;
}
export function recordClick(root: string, link: Attribution): void {
  const path = contained(root, "state/attribution-clicks.jsonl");
  mkdirSync(join(root, "state"), { recursive: true });
  // Raw redirect requests, not unique people. No IP, cookie, referrer or user-agent is stored.
  appendFileSync(path, JSON.stringify({ linkId: link.id, contentId: link.contentId, platform: link.platform, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
}
export function attributionCounts(root: string): Record<string, number> {
  const path = contained(root, "state/attribution-clicks.jsonl");
  const counts: Record<string, number> = {};
  if (!existsSync(path)) return counts;
  for (const line of readFileSync(path, "utf8").split("\n")) try { const row = JSON.parse(line); if (/^[a-f0-9]{24}$/.test(row.linkId)) counts[row.linkId] = (counts[row.linkId] ?? 0) + 1; } catch { /* torn final line */ }
  return counts;
}
