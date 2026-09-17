import { join } from "node:path";
import { ADAPTERS } from "./adapter.js";
import { appendDeliveryEvent, readDeliveryEvents } from "./delivery.js";
import { allVideos } from "../review/queue.js";
import { authorize } from "../workspaces.js";
import { readJson, videoDir } from "../util.js";
import type { Platform, VideoMeta } from "../types.js";
import { assertAcceptedPlatformMemory, confirmPublicationMemory } from '../memory/publication.js';

export async function verifyPosts(id?: string) {
  authorize("read");
  const targets = id ? [readJson<VideoMeta>(join(videoDir(id), "meta.json"))] : allVideos();
  const results = [];
  for (const meta of targets) for (const [platform, post] of Object.entries(meta.posts ?? {})) {
    if (!post || !Object.hasOwn(ADAPTERS, platform)) continue;
    const p = platform as Platform;
    let result;
    try { result = await ADAPTERS[p].verify(post); }
    catch (error) { result = { state: "unverifiable", detail: (error as Error).message }; }
    if (result.state === "live") {
      const prior = readDeliveryEvents(videoDir(meta.id)).filter((e) => e.platform === p).at(-1);
      if (prior?.type !== "platform.verified" || prior.outcome?.providerId !== post.id) appendDeliveryEvent(videoDir(meta.id), {
        type: "platform.verified", videoId: meta.id, platform: p,
        outcome: { platform: p, state: "confirmed", retryable: false, providerId: post.id, url: post.url, at: new Date().toISOString() },
      });
      try {
        assertAcceptedPlatformMemory(meta, p, post);
        await confirmPublicationMemory(meta.id, { provider: p, remoteId: post.id, url: post.url, confirmedAt: Date.now() });
      }
      catch (error) {
        // Verification may inspect legacy posts, but cannot invent an approved source packet
        // or a durable submission. Report the gap while preserving the actual provider result.
        results.push({ videoId: meta.id, platform, ...result, memory: 'unconfirmed', memoryReason: (error as Error).message });
        continue;
      }
    }
    results.push({ videoId: meta.id, platform, ...result });
  }
  return results;
}
