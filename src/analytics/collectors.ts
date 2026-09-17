import { publicMetrics } from "./public-metrics.js";
import { profilePath } from "../workspaces.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { google } from "googleapis";
import type { Page } from "playwright";
import { googleClient } from "../auth/google.js";
import { instagramAccess } from "../auth/instagram.js";
import { threadsAccess } from "../auth/threads.js";
import { tiktokAccess } from "../auth/tiktok.js";
import { xAccess } from "../auth/x.js";
import { closeSharedProfile, launchSharedProfile } from "../post/browser-profile.js";
import { log } from "../util.js";
import type {
  AnalyticsPlatform,
  AnalyticsSnapshot,
  MetricValues,
  NewsletterPublication,
  PostReceipt,
  SnapshotStatus,
} from "./model.js";

interface Target {
  publication: NewsletterPublication;
  receipt: PostReceipt;
}

interface CollectionContext {
  runId: string;
  capturedAt: string;
}

interface HttpResult {
  ok: boolean;
  status: number;
  body: unknown;
}

function targetsFor(publications: NewsletterPublication[], platform: AnalyticsPlatform): Target[] {
  return publications.flatMap((publication) => {
    const receipt = publication.posts[platform];
    return receipt ? [{ publication, receipt }] : [];
  });
}

function safeMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replace(/access_token=[^&\s]+/gi, "access_token=REDACTED")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer REDACTED")
    .slice(0, 500);
}

function snapshot(
  context: CollectionContext,
  target: Target,
  source: string,
  status: SnapshotStatus,
  metrics: MetricValues = {},
  note?: string,
): AnalyticsSnapshot {
  return {
    schemaVersion: 1,
    runId: context.runId,
    capturedAt: context.capturedAt,
    newsletterKey: target.publication.key,
    newsletterDate: target.publication.date,
    editionId: target.publication.editionId,
    contentId: target.publication.contentId,
    platform: target.receipt.platform,
    postId: target.receipt.id,
    url: target.receipt.url,
    source,
    status,
    metrics,
    ...(note ? { note } : {}),
  };
}

function unavailable(context: CollectionContext, targets: Target[], source: string, note: string): AnalyticsSnapshot[] {
  return targets.map((target) => snapshot(context, target, source, "unavailable", {}, note));
}

async function jsonRequest(url: string, init?: RequestInit): Promise<HttpResult> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const raw = await response.text();
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { message: raw.slice(0, 300) };
  }
  return { ok: response.ok, status: response.status, body };
}

function apiError(result: HttpResult): string {
  const body = result.body as { error?: { message?: string }; message?: string; detail?: string } | null;
  return safeMessage(`${result.status}: ${body?.error?.message ?? body?.message ?? body?.detail ?? "request failed"}`);
}

export function insightValues(body: unknown): MetricValues {
  const result: MetricValues = {};
  if (!body || typeof body !== "object") return result;
  const data = (body as { data?: unknown[] }).data;
  if (!Array.isArray(data)) return result;
  const aliases: Record<string, keyof MetricValues> = {
    impressions: "impressions",
    reach: "reach",
    views: "views",
    likes: "likes",
    reactions: "reactions",
    comments: "comments",
    replies: "comments",
    shares: "shares",
    reposts: "reposts",
    quotes: "quotes",
    saved: "saves",
    saves: "saves",
    link_clicks: "clicks",
    follows: "followersGained",
    ig_reels_avg_watch_time: "avgWatchTimeSeconds",
    ig_reels_video_view_total_time: "totalWatchTimeSeconds",
  };
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const row = item as { name?: unknown; values?: { value?: unknown }[]; total_value?: { value?: unknown } };
    if (typeof row.name !== "string" || !aliases[row.name]) continue;
    const value = row.total_value?.value ?? row.values?.[0]?.value;
    if (typeof value === "number" && Number.isFinite(value)) {
      // Meta reports both Reels watch-time insights in milliseconds; the normalized schema uses
      // seconds so it remains comparable with YouTube/TikTok duration fields.
      const normalized = row.name === "ig_reels_avg_watch_time" || row.name === "ig_reels_video_view_total_time"
        ? value / 1000
        : value;
      result[aliases[row.name]] = normalized;
    }
  }
  return result;
}

async function collectInstagram(context: CollectionContext, targets: Target[]): Promise<AnalyticsSnapshot[]> {
  if (!targets.length) return [];
  let access: Awaited<ReturnType<typeof instagramAccess>>;
  try {
    access = await instagramAccess();
  } catch (error) {
    return unavailable(context, targets, "instagram-graph", safeMessage(error));
  }
  return Promise.all(targets.map(async (target) => {
    try {
      const base = `https://graph.instagram.com/v23.0/${encodeURIComponent(target.receipt.id)}`;
      const token = encodeURIComponent(access.token);
      const [media, insights] = await Promise.all([
        jsonRequest(`${base}?fields=like_count,comments_count,permalink,timestamp,media_type&access_token=${token}`),
        jsonRequest(`${base}/insights?metric=reach,views,total_interactions,likes,comments,saved,shares,ig_reels_avg_watch_time,ig_reels_video_view_total_time&access_token=${token}`),
      ]);
      const mediaBody = media.body as { like_count?: number; comments_count?: number };
      const metrics: MetricValues = {
        ...(typeof mediaBody?.like_count === "number" ? { likes: mediaBody.like_count } : {}),
        ...(typeof mediaBody?.comments_count === "number" ? { comments: mediaBody.comments_count } : {}),
        ...insightValues(insights.body),
      };
      if (!media.ok && !insights.ok) return snapshot(context, target, "instagram-graph", "error", {}, `${apiError(media)}; insights ${apiError(insights)}`);
      const status = media.ok && insights.ok ? "collected" : "partial";
      const note = status === "partial" ? `Partial Instagram response: media=${media.status}, insights=${insights.status}` : undefined;
      return snapshot(context, target, "instagram-graph", status, metrics, note);
    } catch (error) {
      return snapshot(context, target, "instagram-graph", "error", {}, safeMessage(error));
    }
  }));
}

async function collectYouTube(context: CollectionContext, targets: Target[]): Promise<AnalyticsSnapshot[]> {
  if (!targets.length) return [];
  try {
    const youtube = google.youtube({ version: "v3", auth: googleClient() });
    const byId = new Map<string, MetricValues>();
    for (let offset = 0; offset < targets.length; offset += 50) {
      const batch = targets.slice(offset, offset + 50);
      const response = await youtube.videos.list({
        part: ["statistics", "contentDetails"],
        id: batch.map((target) => target.receipt.id),
      });
      for (const video of response.data.items ?? []) {
        if (!video.id) continue;
        const duration = parseIsoDuration(video.contentDetails?.duration ?? null);
        const views = optionalNumber(video.statistics?.viewCount);
        const likes = optionalNumber(video.statistics?.likeCount);
        const comments = optionalNumber(video.statistics?.commentCount);
        byId.set(video.id, {
          ...(views === null ? {} : { views }),
          ...(likes === null ? {} : { likes }),
          ...(comments === null ? {} : { comments }),
          ...(duration === null ? {} : { videoDurationSeconds: duration }),
        });
      }
    }
    return targets.map((target) => {
      const metrics = byId.get(target.receipt.id);
      return metrics
        ? snapshot(context, target, "youtube-data-api", "collected", metrics)
        : snapshot(context, target, "youtube-data-api", "error", {}, "YouTube returned no matching video for this receipt ID.");
    });
  } catch (error) {
    const note = safeMessage(error).includes("Insufficient Permission")
      ? "YouTube token lacks a read scope; run npm run auth:google once, then rerun analytics:weekly."
      : safeMessage(error);
    return unavailable(context, targets, "youtube-data-api", note);
  }
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseIsoDuration(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!match) return null;
  return numberValue(match[1]) * 86400 + numberValue(match[2]) * 3600 + numberValue(match[3]) * 60 + numberValue(match[4]);
}

async function collectX(context: CollectionContext, targets: Target[]): Promise<AnalyticsSnapshot[]> {
  if (!targets.length) return [];
  try {
    const token = await xAccess();
    const byId = new Map<string, MetricValues>();
    for (let offset = 0; offset < targets.length; offset += 100) {
      const ids = targets.slice(offset, offset + 100).map((target) => target.receipt.id);
      const url = `https://api.x.com/2/tweets?ids=${ids.map(encodeURIComponent).join(",")}&tweet.fields=public_metrics`;
      const response = await jsonRequest(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        // Fall back on ANY API failure, not just the documented 402 credits case — verified
        // 2026-09-03 that a broken OAuth refresh token (400 at token exchange, caught below) can
        // block the API path entirely while the browser session itself is perfectly signed in
        // (x-post-chrome's profile page still resolves "13 Followers" with no re-auth needed).
        // Same "API first, browser fallback" shape X posting already uses (src/post/index.ts falls
        // back to x-browser.ts on the identical 402); here the fallback is just less picky about why.
        log(`X API request failed (${apiError(response)}) — falling back to the per-post browser analytics view.`);
        return collectXBrowser(context, targets);
      }
      const rows = (response.body as { data?: { id?: string; public_metrics?: Record<string, number> }[] }).data ?? [];
      for (const row of rows) {
        if (!row.id) continue;
        const metrics = row.public_metrics ?? {};
        byId.set(row.id, {
          impressions: numberValue(metrics.impression_count),
          likes: numberValue(metrics.like_count),
          comments: numberValue(metrics.reply_count),
          reposts: numberValue(metrics.retweet_count),
          quotes: numberValue(metrics.quote_count),
          bookmarks: numberValue(metrics.bookmark_count),
        });
      }
    }
    return targets.map((target) => {
      const metrics = byId.get(target.receipt.id);
      return metrics
        ? snapshot(context, target, "x-api", "collected", metrics)
        : snapshot(context, target, "x-api", "error", {}, "X returned no matching post for this receipt ID.");
    });
  } catch (error) {
    // xAccess() itself throws here on a broken/expired refresh token (the real 2026-09-03 case: a
    // 400 at the token-exchange endpoint, well before any tweets request). Same reasoning as the
    // 402 fallback above — the browser session doesn't depend on this token at all.
    log(`X API access failed (${safeMessage(error)}) — falling back to the per-post browser analytics view.`);
    try {
      return await collectXBrowser(context, targets);
    } catch (browserError) {
      return unavailable(context, targets, "x-api", `${safeMessage(error)}; browser fallback also failed: ${safeMessage(browserError)}`);
    }
  }
}

// X per-post browser fallback — verified live 2026-09-02 against
// https://x.com/SVf4data/status/2095135723703742940:
//  - `<status url>/analytics` is a deterministic URL (no discovery step, unlike LinkedIn) and
//    renders a "Post Analytics" panel over the timeline. Its innerText carries the video's
//    "Unique views" AND "Views" as two adjacent label/value pairs — the two must be told apart or
//    Unique views gets silently over-written into Views; `parseXPostAnalyticsText` consumes
//    "Unique views" without storing it, exactly to keep the two separated.
//  - Impressions is the one metric this panel gives that the tweet page itself does not.
//  - Reply/repost/like counts are read from the tweet page's own action row aria-label instead
//    (same selector already proven live in social.ts's xHeatBatch — reused here, not re-derived).
const X_ANALYTICS_LABELS: [string, keyof MetricValues | null][] = [
  ["Impressions", "impressions"],
  ["Unique views", null],
  ["Views", "views"],
];

export function parseXPostAnalyticsText(text: string): MetricValues {
  // preferAfter: X's panel is consistently label-then-value ("Impressions\n33"), unlike
  // LinkedIn's mixed stat-tile/list-row layout — and unlike LinkedIn, X has a real ambiguous case
  // (the tweet's own leading "0 0 0" reply/repost/like counts sit directly before "Impressions",
  // so a before-first preference silently grabs the wrong zero instead of the real 33).
  return parseLabeledMetrics(text, X_ANALYTICS_LABELS, true);
}

export function parseXActionRowAriaLabel(ariaLabel: string): MetricValues {
  const metrics: MetricValues = {};
  for (const match of ariaLabel.matchAll(/(\d[\d,]*)\s+(repl(?:y|ies)|repost|like)/gi)) {
    const value = numberValue(match[1].replace(/,/g, ""));
    const kind = match[2].toLowerCase();
    if (kind.startsWith("repl")) metrics.comments = value;
    else if (kind === "repost") metrics.reposts = value;
    else if (kind === "like") metrics.likes = value;
  }
  return metrics;
}

const X_PROFILE_DIR = profilePath("x", join(homedir(), ".content-harness", "browser-profiles", "x"), "AI_CONTENT_X_BROWSER_PROFILE_DIR");

async function collectXBrowser(context: CollectionContext, targets: Target[]): Promise<AnalyticsSnapshot[]> {
  const SOURCE = "x-post-browser-analytics";
  let ctx: Awaited<ReturnType<typeof launchSharedProfile>>;
  try {
    // x-post-chrome is engine-owned and dedicated (src/post/x-browser.ts), so — same as that
    // poster — this deliberately takes no shared browser lock; there is no other holder to wait on.
    ctx = await launchSharedProfile(X_PROFILE_DIR, { viewport: { width: 1400, height: 1000 }, attempts: 1 });
  } catch (error) {
    return unavailable(context, targets, SOURCE, safeMessage(error));
  }
  const results: AnalyticsSnapshot[] = [];
  try {
    const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
    for (const target of targets) {
      try {
        if (!target.receipt.url) {
          results.push(snapshot(context, target, SOURCE, "unavailable", {}, "No post URL on this receipt to read analytics from."));
          continue;
        }
        await page.goto(target.receipt.url, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(5_000);
        if (/\/i\/flow\/login|\/login|\/i\/jf\/onboarding/.test(page.url())) {
          results.push(snapshot(context, target, SOURCE, "unavailable", {}, "X post-browser profile isn't signed in."));
          continue;
        }
        const actionRowAria = await page.evaluate(() => {
          const row = document.querySelector('article[data-testid="tweet"] [role="group"][aria-label]');
          return row?.getAttribute("aria-label") ?? "";
        }) as string;
        const actionMetrics = actionRowAria ? parseXActionRowAriaLabel(actionRowAria) : {};

        await page.goto(`${target.receipt.url.replace(/\/$/, "")}/analytics`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(5_000);
        const text = await page.evaluate(() => document.body.innerText) as string;
        const analyticsMetrics = /Post Analytics/.test(text) ? parseXPostAnalyticsText(text) : {};

        const metrics = { ...actionMetrics, ...analyticsMetrics };
        if (!Object.keys(metrics).length) {
          results.push(snapshot(context, target, SOURCE, "error", {}, "X returned no recognizable metrics from the post page or its analytics view."));
          continue;
        }
        results.push(snapshot(context, target, SOURCE, "collected", metrics));
      } catch (error) {
        results.push(snapshot(context, target, SOURCE, "error", {}, safeMessage(error)));
      }
    }
  } finally {
    await closeSharedProfile(ctx);
  }
  return results;
}

// LinkedIn per-post analytics uses the operator's authenticated browser session.
// Follow the post's own analytics link; the activity ID may differ from the post ID.
// Never infer that ID or follow the account-level creator export for per-post metrics.
//  2. The post-summary page's innerText mixes two label/value orderings in the same document:
//     stat tiles (Impressions, Members reached, Video views, Average watch time, Followers gained)
//     print VALUE then LABEL; the engagement breakdown list (Reactions, Comments, Reposts, Saves,
//     Sends on LinkedIn) prints LABEL then VALUE. `parseLinkedInPostSummaryText` checks both
//     neighbors and consumes whichever one is an unclaimed number, which resolves cleanly without
//     hardcoding per-section order (self-check: Reactions+Comments+Reposts+Saves+Sends summed to
//     the page's own "Social engagements" rollup on the verification post).
const LINKEDIN_LABELS: [string, keyof MetricValues | null][] = [
  ["Impressions", "impressions"],
  ["Members reached", "reach"],
  ["Video views", "views"],
  ["Average watch time", "avgWatchTimeSeconds"],
  ["Followers gained from this post", "followersGained"],
  ["Reactions", "reactions"],
  ["Comments", "comments"],
  ["Reposts", "reposts"],
  ["Saves", "saves"],
  ["Sends on LinkedIn", "shares"],
];

/** "1m 9s" / "45s" / "1h 2m" → seconds; a bare number/percent parses as-is. */
function parseMetricToken(token: string): number | null {
  const duration = token.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/i);
  if (duration && (duration[1] || duration[2] || duration[3])) {
    return numberValue(duration[1]) * 3600 + numberValue(duration[2]) * 60 + numberValue(duration[3]);
  }
  const plain = Number(token.replace(/,/g, "").replace(/%$/, ""));
  return Number.isFinite(plain) ? plain : null;
}

/** Shared by every "innerText scraped from a stats page" parser below. A label's number can sit
 *  either immediately before it (a stat tile: value on top, caption below) or immediately after
 *  (a list row: label first, count second) — real pages mix both in one document. `preferAfter`
 *  sets which neighbor wins when BOTH are valid numbers (ambiguous only when an unrelated number
 *  happens to sit on the other side, e.g. X's leading reply/repost/like "0 0 0" landing right
 *  before "Impressions" — fixed 2026-09-02 after that exact case shipped a wrong `impressions: 0`
 *  in a first draft). `used` prevents one token from being claimed by two different labels. */
function parseLabeledMetrics(
  text: string,
  labels: [string, keyof MetricValues | null][],
  preferAfter: boolean,
): MetricValues {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const used = new Set<number>();
  const metrics: MetricValues = {};
  for (const [label, field] of labels) {
    const idx = lines.indexOf(label);
    if (idx === -1) continue;
    const beforeIdx = idx - 1;
    const afterIdx = idx + 1;
    const beforeValue = beforeIdx >= 0 && !used.has(beforeIdx) ? parseMetricToken(lines[beforeIdx]) : null;
    const afterValue = afterIdx < lines.length && !used.has(afterIdx) ? parseMetricToken(lines[afterIdx]) : null;
    const [primary, primaryIdx, secondary, secondaryIdx] = preferAfter
      ? [afterValue, afterIdx, beforeValue, beforeIdx]
      : [beforeValue, beforeIdx, afterValue, afterIdx];
    if (primary !== null) {
      used.add(primaryIdx);
      if (field) metrics[field] = primary;
    } else if (secondary !== null) {
      used.add(secondaryIdx);
      if (field) metrics[field] = secondary;
    }
  }
  return metrics;
}

export function parseLinkedInPostSummaryText(text: string): MetricValues {
  return parseLabeledMetrics(text, LINKEDIN_LABELS, false);
}

/** The feed permalink renders the per-post analytics link twice (bare + "expanded..." variant,
 *  same as the search-results dedup in social.ts) — take the first post-summary href and reject
 *  the combined creator export outright so it can never be mistaken for the accepted source. */
export function findLinkedInAnalyticsHref(links: { href: string; text: string }[]): string | null {
  const match = links.find((link) => /\/analytics\/post-summary\//.test(link.href));
  return match?.href ?? null;
}

const LI_PROFILE_DIR = profilePath("linkedin-newsletter", join(homedir(), ".content-harness", "browser-profiles", "linkedin-newsletter"), "AI_CONTENT_NEWSLETTER_BROWSER_PROFILE_DIR");

async function collectLinkedIn(context: CollectionContext, targets: Target[]): Promise<AnalyticsSnapshot[]> {
  if (!targets.length) return [];
  const SOURCE = "linkedin-post-browser-analytics";
  let ctx: Awaited<ReturnType<typeof launchSharedProfile>>;
  try {
    ctx = await launchSharedProfile(LI_PROFILE_DIR, { viewport: { width: 1400, height: 1000 }, attempts: 12 });
  } catch (error) {
    return unavailable(context, targets, SOURCE, safeMessage(error));
  }
  const results: AnalyticsSnapshot[] = [];
  try {
    const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
    for (const target of targets) {
      try {
        await page.goto(`https://www.linkedin.com/feed/update/${encodeURIComponent(target.receipt.id)}/`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(6_000);
        if (/\/login|\/authwall|\/uas\/login|checkpoint/.test(page.url())) {
          results.push(snapshot(context, target, SOURCE, "unavailable", {}, "LinkedIn publish profile isn't signed in."));
          continue;
        }
        const links = await page.evaluate(() => {
          const out: { href: string; text: string }[] = [];
          for (const el of Array.from(document.querySelectorAll("a[href]"))) {
            const href = el.getAttribute("href") || "";
            const text = (el.textContent || "").trim();
            if (/analytic/i.test(href)) out.push({ href, text });
          }
          return out;
        }) as { href: string; text: string }[];
        const analyticsHref = findLinkedInAnalyticsHref(links);
        if (!analyticsHref) {
          results.push(snapshot(context, target, SOURCE, "unavailable", {}, "No per-post analytics link found on the feed permalink — LinkedIn may not have finished indexing this post yet."));
          continue;
        }
        const analyticsUrl = analyticsHref.startsWith("http") ? analyticsHref : `https://www.linkedin.com${analyticsHref}`;
        await page.goto(analyticsUrl, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(6_000);
        const text = await page.evaluate(() => document.body.innerText) as string;
        const metrics = parseLinkedInPostSummaryText(text);
        if (!Object.keys(metrics).length) {
          results.push(snapshot(context, target, SOURCE, "error", {}, "LinkedIn post-summary page returned no recognizable metrics."));
          continue;
        }
        results.push(snapshot(context, target, SOURCE, "collected", metrics));
      } catch (error) {
        results.push(snapshot(context, target, SOURCE, "error", {}, safeMessage(error)));
      }
    }
  } finally {
    await closeSharedProfile(ctx);
  }
  return results;
}

export function threadsShortcode(value: string): string {
  return value.match(/\/post\/([\w-]+)/)?.[1] ?? value;
}

export function matchThreadsMediaRows(
  receipts: { id: string; url: string | null }[],
  rows: { id?: unknown; permalink?: unknown }[],
): Map<string, string> {
  const expected = new Map(receipts.map((receipt) => [threadsShortcode(receipt.url ?? receipt.id), receipt.id]));
  const matched = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.permalink !== "string") continue;
    const receiptId = expected.get(threadsShortcode(row.permalink));
    if (receiptId) matched.set(receiptId, row.id);
  }
  return matched;
}

async function resolveThreadsMediaIds(
  token: string,
  userId: string,
  targets: Target[],
): Promise<{ ids: Map<string, string>; failure?: { status: SnapshotStatus; note: string } }> {
  const ids = new Map<string, string>();
  const browserTargets = targets.filter((target) => {
    if (/^\d+$/.test(target.receipt.id)) {
      ids.set(target.receipt.id, target.receipt.id);
      return false;
    }
    return true;
  });
  if (!browserTargets.length) return { ids };

  let next: string | null = `https://graph.threads.net/v1.0/${encodeURIComponent(userId)}/threads?fields=id,permalink&limit=100&access_token=${encodeURIComponent(token)}`;
  for (let page = 0; page < 10 && next && ids.size < targets.length; page++) {
    const response = await jsonRequest(next);
    if (!response.ok) {
      return {
        ids,
        failure: {
          status: response.status === 401 || response.status === 403 ? "unavailable" : "error",
          note: `Threads receipt-to-media resolution failed: ${apiError(response)}`,
        },
      };
    }
    const body = response.body as {
      data?: { id?: unknown; permalink?: unknown }[];
      paging?: { next?: unknown };
    };
    for (const [receiptId, mediaId] of matchThreadsMediaRows(browserTargets.map((target) => target.receipt), body.data ?? [])) {
      ids.set(receiptId, mediaId);
    }
    const candidate = typeof body.paging?.next === "string" ? body.paging.next : null;
    next = candidate?.startsWith("https://graph.threads.net/") ? candidate : null;
  }
  return { ids };
}

async function collectThreads(context: CollectionContext, targets: Target[]): Promise<AnalyticsSnapshot[]> {
  if (!targets.length) return [];
  let access: ReturnType<typeof threadsAccess>;
  try {
    access = threadsAccess();
  } catch (error) {
    // "run npm run auth:threads" is misleading right now: THREADS_APP_ID/SECRET are unset (no Meta
    // app exists), so the OAuth flow that command starts cannot succeed yet — same real blocker
    // src/post/threads.ts already names honestly on its own API-first attempt. There is no browser
    // fallback here yet (unlike LinkedIn/X, above): it would need the SHARED mcp-chrome profile,
    // which stays reserved for whichever run currently holds it rather than being claimed opportunistically.
    const results: AnalyticsSnapshot[] = [];
    for (const target of targets) {
      const result = await publicMetrics("threads", threadsShortcode(target.receipt.url ?? target.receipt.id), target.receipt.url);
      results.push(snapshot(context, target, "threads-public-post-counters", result.metrics ? "partial" : "unavailable", result.metrics ?? {}, `${safeMessage(error)}; ${result.note}`));
    }
    return results;
  }
  let resolved: Awaited<ReturnType<typeof resolveThreadsMediaIds>>;
  try {
    resolved = await resolveThreadsMediaIds(access.token, access.userId, targets);
  } catch (error) {
    resolved = { ids: new Map(), failure: { status: "error", note: safeMessage(error) } };
  }
  return Promise.all(targets.map(async (target) => {
    try {
      const mediaId = resolved.ids.get(target.receipt.id);
      if (!mediaId) {
        return snapshot(
          context,
          target,
          "threads-insights",
          resolved.failure?.status ?? "error",
          {},
          resolved.failure?.note ?? `Threads media ID not found for browser receipt shortcode ${threadsShortcode(target.receipt.url ?? target.receipt.id)}.`,
        );
      }
      const url = `https://graph.threads.net/v1.0/${encodeURIComponent(mediaId)}/insights?metric=views,likes,replies,reposts,quotes,shares&access_token=${encodeURIComponent(access.token)}`;
      const response = await jsonRequest(url);
      if (!response.ok) return snapshot(context, target, "threads-insights", response.status === 401 || response.status === 403 ? "unavailable" : "error", {}, apiError(response));
      return snapshot(context, target, "threads-insights", "collected", insightValues(response.body));
    } catch (error) {
      return snapshot(context, target, "threads-insights", "error", {}, safeMessage(error));
    }
  }));
}

async function collectTikTok(context: CollectionContext, targets: Target[]): Promise<AnalyticsSnapshot[]> {
  if (!targets.length) return [];
  let token: string;
  try {
    token = await tiktokAccess();
  } catch (error) {
    // Same honesty fix as Threads above: TIKTOK_CLIENT_KEY/SECRET are unset (no TikTok for
    // Developers app exists), so "run npm run auth:tiktok" cannot currently succeed — matching
    // src/post/tiktok.ts's own error naming. No browser fallback yet; see the Threads note above.
    const results: AnalyticsSnapshot[] = [];
    for (const target of targets) {
      const result = await publicMetrics("tiktok", target.receipt.id, target.receipt.url);
      results.push(snapshot(context, target, "tiktok-public-post-counters", result.metrics ? "partial" : "unavailable", result.metrics ?? {}, `${safeMessage(error)}; ${result.note}`));
    }
    return results;
  }
  const byId = new Map<string, MetricValues>();
  try {
    for (let offset = 0; offset < targets.length; offset += 20) {
      const batch = targets.slice(offset, offset + 20);
      const response = await jsonRequest(
        "https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count,duration",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ filters: { video_ids: batch.map((target) => target.receipt.id) } }),
        },
      );
      if (!response.ok) return unavailable(context, targets, "tiktok-display-api", apiError(response));
      const body = response.body as { data?: { videos?: Record<string, unknown>[] }; error?: { code?: string; message?: string } };
      if (body.error?.code && body.error.code !== "ok") return unavailable(context, targets, "tiktok-display-api", `${body.error.code}: ${body.error.message ?? "TikTok query failed"}`);
      for (const video of body.data?.videos ?? []) {
        if (typeof video.id !== "string") continue;
        byId.set(video.id, {
          views: numberValue(video.view_count),
          likes: numberValue(video.like_count),
          comments: numberValue(video.comment_count),
          shares: numberValue(video.share_count),
          videoDurationSeconds: numberValue(video.duration),
        });
      }
    }
  } catch (error) {
    return unavailable(context, targets, "tiktok-display-api", safeMessage(error));
  }
  return targets.map((target) => {
    const metrics = byId.get(target.receipt.id);
    return metrics
      ? snapshot(context, target, "tiktok-display-api", "collected", metrics)
      : snapshot(context, target, "tiktok-display-api", "error", {}, "TikTok returned no matching video for this receipt ID.");
  });
}

export interface CollectionResult {
  runId: string;
  capturedAt: string;
  snapshots: AnalyticsSnapshot[];
}

export async function collectAnalytics(publications: NewsletterPublication[], now = new Date()): Promise<CollectionResult> {
  const capturedAt = now.toISOString();
  const context = { capturedAt, runId: `weekly-${capturedAt}` };
  const collectors = [
    collectLinkedIn(context, targetsFor(publications, "linkedin")),
    collectInstagram(context, targetsFor(publications, "instagram")),
    collectYouTube(context, targetsFor(publications, "youtube")),
    collectX(context, targetsFor(publications, "x")),
    collectThreads(context, targetsFor(publications, "threads")),
    collectTikTok(context, targetsFor(publications, "tiktok")),
  ];
  const snapshots = (await Promise.all(collectors)).flat();
  return { ...context, snapshots };
}

/** The adapter contract uses the same exact-receipt collectors as the scheduled run. */
export async function collectPlatform(publications: NewsletterPublication[], platform: string, now = new Date()): Promise<AnalyticsSnapshot[]> {
  const context = { capturedAt: now.toISOString(), runId: `weekly-${now.toISOString()}` };
  const collectors: Partial<Record<string, (context: CollectionContext, targets: Target[]) => Promise<AnalyticsSnapshot[]>>> = {
    linkedin: collectLinkedIn, instagram: collectInstagram, youtube: collectYouTube, x: collectX, threads: collectThreads, tiktok: collectTikTok,
  };
  const collector = collectors[platform];
  if (!collector) return [];
  return collector(context, targetsFor(publications, platform as AnalyticsPlatform));
}
