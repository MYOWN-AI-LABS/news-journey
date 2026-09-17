import { certainlyNotSubmitted } from "./attempt.js";
import { validatePost, verifyReceipt } from "./provider-support.js";
import type { ProbeResult } from "./probes.mjs";
import type { NewsletterPublication, AnalyticsSnapshot } from "../analytics/model.js";
/**
 * Provider adapter contract (distribution kernel, Stage 1). Each destination declares how its work
 * must be serialized and how it authenticates, instead of that knowledge living in comments beside
 * a flat function map. Every `publish` body below is the exact poster (and API→browser fallback)
 * that existed before this file; only the shape around it changed. Publication POLICY — newsletter
 * first, exact-issue liveness, repeat and media gates — stays ABOVE the adapters in
 * postApproved(), never inside them.
 */
import type { Platform, PostResult, VideoMeta } from "../types.js";
import { log } from "../util.js";

/** A browser can open one persistent profile in one process at a time, so destinations that share
 *  a configured browser profile must run serially in one lane. API-only destinations have no such
 *  constraint. Lane membership is derived from this value (see lanesFor). */
export type ConcurrencyGroup = "api" | "x-browser" | "shared-browser" | "tiktok-api";

export type AuthMode = "oauth" | "oauth-then-browser";

export interface ProviderCapabilities {
  auth: AuthMode;
  /** Which `npm run auth:<x>` re-consents the OAuth grant — the provider is not always the platform
   *  (youtube is google, instagram/threads are meta). Absent = no OAuth grant to refresh. */
  authProvider?: string;
  concurrencyGroup: ConcurrencyGroup;
}

export interface ProviderAdapter {
  platform: Platform;
  capabilities: ProviderCapabilities;
  publish(meta: VideoMeta): Promise<PostResult>;
  validate(meta: VideoMeta): { valid: boolean; issues: string[] };
  verify(post: PostResult): Promise<ProbeResult>;
  collectMetrics(publications: NewsletterPublication[]): Promise<AnalyticsSnapshot[]>;
}

/** Deterministic destination order; independent lanes still run concurrently. */
export const PLATFORM_ORDER: Platform[] = ["linkedin", "youtube", "instagram", "x", "threads", "reddit", "tiktok"];

const DESTINATIONS: Record<Platform, Pick<ProviderAdapter, "platform" | "capabilities" | "publish">> = {
  linkedin: {
    platform: "linkedin",
    capabilities: { auth: "oauth", authProvider: "linkedin", concurrencyGroup: "api" },
    publish: async (m) => (await import("./linkedin.js")).postLinkedIn(m),
  },
  youtube: {
    platform: "youtube",
    capabilities: { auth: "oauth", authProvider: "google", concurrencyGroup: "api" },
    publish: async (m) => (await import("./youtube.js")).postYouTube(m),
  },
  instagram: {
    platform: "instagram",
    capabilities: { auth: "oauth", authProvider: "meta", concurrencyGroup: "api" },
    publish: async (m) => (await import("./instagram.js")).postInstagram(m),
  },
  // API first; fall back to the browser composer only on a known pre-submission API failure. A 402-only fallback left a
  // dead refresh token ("token exchange 400 ... token was invalid") failing every post while the
  // token-free browser composer sat unused; the failure is still recorded, and the log names the
  // re-auth command when the error is an auth problem.
  x: {
    platform: "x",
    capabilities: { auth: "oauth-then-browser", concurrencyGroup: "x-browser" },
    publish: async (m) => {
      try {
        return await (await import("./x.js")).postX(m);
      } catch (e) {
        if (!certainlyNotSubmitted(e)) throw e;
        const msg = (e as Error).message;
        log(`X API failed (${msg.slice(0, 120)}) — falling back to browser composer.${/token exchange|invalid_grant|401/i.test(msg) ? " API needs re-auth: npm run auth:x" : ""}`);
        return (await import("./x-browser.js")).postXBrowser(m);
      }
    },
  },
  // Use the API when configured; otherwise use the explicitly configured browser profile.
  threads: {
    platform: "threads",
    capabilities: { auth: "oauth-then-browser", authProvider: "meta", concurrencyGroup: "shared-browser" },
    publish: async (m) => {
      try {
        return await (await import("./threads.js")).postThreads(m);
      } catch (e) {
        if (!/no threads tokens|THREADS_APP_ID|not connected/i.test((e as Error).message)) throw e;
        log("Threads API unavailable (no Meta app credentials); using the browser composer.");
        return (await import("./threads-browser.js")).postThreadsBrowser(m);
      }
    },
  },
  reddit: {
    platform: "reddit",
    capabilities: { auth: "oauth-then-browser", concurrencyGroup: "shared-browser" },
    publish: async (m) => {
      try {
        return await (await import("./reddit.js")).postReddit(m);
      } catch (e) {
        if (!/no reddit tokens|REDDIT_CLIENT_ID/i.test((e as Error).message)) throw e;
        log("Reddit API unavailable (no app credentials — Reddit closed self-serve app creation); using the browser composer.");
        return (await import("./reddit-browser.js")).postRedditBrowser(m);
      }
    },
  },
  // API only in the harness (browser posting disabled; unaudited apps default to SELF_ONLY). It has
  // no browser-profile constraint, so it keeps its own lane rather than waiting behind the API lane.
  tiktok: {
    platform: "tiktok",
    capabilities: { auth: "oauth", concurrencyGroup: "tiktok-api" },
    publish: async (m) => (await import("./tiktok.js")).postTikTok(m),
  },
};

export const ADAPTERS = Object.fromEntries(Object.entries(DESTINATIONS).map(([key, adapter]) => [key, {
  ...adapter,
  validate: validatePost,
  verify: (post: PostResult) => verifyReceipt(adapter.platform, post),
  collectMetrics: async (publications: NewsletterPublication[]) => (await import("../analytics/collectors.js")).collectPlatform(publications, adapter.platform),
}])) as Record<Platform, ProviderAdapter>;

/** Group `order` into concurrent lanes by concurrency group, first appearance first; platforms
 *  inside a lane keep their relative order and run serially. With PLATFORM_ORDER this reproduces
 *  the previous hand-written lanes exactly (asserted in adapter.test.ts). */
export function lanesFor(order: Platform[]): Platform[][] {
  const lanes = new Map<ConcurrencyGroup, Platform[]>();
  for (const p of order) {
    const group = ADAPTERS[p].capabilities.concurrencyGroup;
    if (!lanes.has(group)) lanes.set(group, []);
    lanes.get(group)!.push(p);
  }
  return [...lanes.values()];
}
