import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activeRoot, atomicJson, authorize, contained, read, safeId } from "./workspaces.js";
import { releaseLock } from "./release-lock.js";
import type { VideoMeta } from "./types.js";

export function packageFingerprint(root: string, id: string): string {
  safeId(id);
  const dir = contained(root, "workdir/videos", id);
  const meta = read<VideoMeta | null>(contained(root, "workdir/videos", id, "meta.json"), null);
  if (!meta || meta.id !== id) throw new Error("Unknown package");
  const h = createHash("sha256");
  for (const name of ["topic.json", "script.json", "final.mp4"]) {
    const path = contained(root, "workdir/videos", id, name);
    if (!existsSync(path)) throw new Error(`Package incomplete: ${name} — this package stopped at "${meta.status}" before ${name === "final.mp4" ? "its video was rendered" : name === "script.json" ? "its script was written" : "its stories were chosen"}, so there is nothing to review yet. Create a new preview, or retry the draft in Advanced settings.`);
    h.update(name).update("\0").update(createHash("sha256").update(readFileSync(path)).digest());
  }
  if (/^\d{8}/.test(id)) {
    const day = `${id.slice(0,4)}-${id.slice(4,6)}-${id.slice(6,8)}`;
    const key = meta.edition && meta.edition !== "daily-roundup" ? `${day}-${safeId(meta.edition)}` : day;
    for (const suffix of [".json", ".html", ".linkedin.html"]) {
      const path = contained(root, "workdir/newsletters", key + suffix);
      h.update(key + suffix).update("\0");
      if (existsSync(path)) h.update(createHash("sha256").update(readFileSync(path)).digest());
      else h.update("absent");
    }
  }
  return h.digest("hex");
}
export async function applyControlAction(input: { action: string; id: string; expectedHash?: string; reason?: string; platform?: string }): Promise<Record<string, unknown>> {
  const root = activeRoot(); const id = safeId(input.id);
  const path = contained(root, "workdir/videos", id, "meta.json");
  const meta = read<VideoMeta | null>(path, null);
  if (!meta || meta.id !== id) throw new Error("Unknown package");
  const action = input.action === "retry" ? "publish" : "approve";
  const actor = authorize(action, { edition: meta.edition ?? "daily-roundup", author: meta.createdBy, platform: input.platform });
  const unlock = releaseLock(root);
  try {
    if (input.action === "approve") {
      if (!/^[a-f0-9]{64}$/.test(input.expectedHash ?? "") || packageFingerprint(root, id) !== input.expectedHash) throw new Error("Conflict: package changed; review its current hash");
      const { approve } = await import("./review/queue.js");
      approve(id);
      return { approved: true, id, actor };
    }
    if (input.action === "hold") {
      if (!input.reason || input.reason.length > 500) throw new Error("Hold requires a reason of 1–500 characters");
      const current = read<VideoMeta>(path, meta);
      Object.assign(current, { status: "pending_review", reviewHold: { requestedAt: new Date().toISOString(), reason: input.reason }, updatedAt: new Date().toISOString() });
      atomicJson(path, current);
      const { appendDeliveryEvent } = await import("./post/delivery.js");
      appendDeliveryEvent(contained(root, "workdir/videos", id), { type: "release.withheld", videoId: id, reason: input.reason });
      return { held: true, id, actor };
    }
    if (input.action === "retry") {
      const { ADAPTERS } = await import("./post/adapter.js");
      if (!input.platform || !Object.hasOwn(ADAPTERS, input.platform)) throw new Error("Unknown destination");
      const { postApproved } = await import("./post/index.js");
      await postApproved({ id, only: input.platform, retryBlocked: true });
      const after = read<VideoMeta>(path, meta);
      return { id, platform: input.platform, posted: Boolean(after.posts?.[input.platform as keyof typeof after.posts]), actor };
    }
    throw new Error("Unknown action");
  } finally { unlock(); }
}
