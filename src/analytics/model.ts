import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const ANALYTICS_PLATFORMS = ["linkedin", "instagram", "youtube", "x", "threads", "tiktok"] as const;
export type AnalyticsPlatform = (typeof ANALYTICS_PLATFORMS)[number];
// The combined creator export is a ranked account surface, not the per-post analytics source
// the operator approved. Keep its historical snapshots append-only, but never promote them into a report.
const REJECTED_ANALYTICS_SOURCES = new Set(["linkedin-creator-analytics-export"]);
// The browser collector (collectLinkedIn) already reads this exact post's own analytics view
// automatically — this note is the manual recovery step for when THAT fails (e.g. not signed in),
// not a description of the ordinary path. Combined Content exports are rejected either way.
const LINKEDIN_DIRECT_POST_FALLBACK = "If automated collection keeps failing, read this exact post's own View analytics / impressions view directly in the verified signed-in session; combined Content exports are rejected.";

export type MetricValues = Partial<{
  impressions: number;
  reach: number;
  views: number;
  reactions: number;
  likes: number;
  comments: number;
  shares: number;
  reposts: number;
  quotes: number;
  saves: number;
  bookmarks: number;
  clicks: number;
  followersGained: number;
  subscribersGained: number;
  accountSubscribers: number;
  avgWatchTimeSeconds: number;
  totalWatchTimeSeconds: number;
  videoDurationSeconds: number;
}>;

export interface PostReceipt {
  platform: AnalyticsPlatform;
  id: string;
  url: string | null;
  postedAt: string | null;
}

export interface NewsletterPublication {
  key: string;
  date: string;
  weekStart: string;
  editionId: string;
  editionTitle: string;
  headline: string;
  contentId: string;
  newsletterUrl: string | null;
  archiveUrl: string;
  posts: Partial<Record<AnalyticsPlatform, PostReceipt>>;
}

export type SnapshotStatus = "collected" | "partial" | "unavailable" | "error";

export interface AnalyticsSnapshot {
  schemaVersion: 1;
  runId: string;
  capturedAt: string;
  newsletterKey: string;
  newsletterDate: string;
  editionId: string;
  contentId: string;
  platform: AnalyticsPlatform;
  postId: string;
  url: string | null;
  source: string;
  status: SnapshotStatus;
  metrics: MetricValues;
  note?: string;
}

export interface AnalyticsStore {
  schemaVersion: 1;
  snapshots: AnalyticsSnapshot[];
}

export function isAcceptedAnalyticsSnapshot(snapshot: Pick<AnalyticsSnapshot, "source">): boolean {
  return !REJECTED_ANALYTICS_SOURCES.has(snapshot.source);
}

export interface ChannelView {
  platform: AnalyticsPlatform;
  receipt: PostReceipt | null;
  status: SnapshotStatus | "missing" | "stale";
  collectorStatus: SnapshotStatus | "not-run";
  metrics: MetricValues;
  source: string | null;
  capturedAt: string | null;
  note: string | null;
  exposure: number | null;
  exposureLabel: "impressions" | "reach" | "views" | null;
  interactions: number;
  engagementRate: number | null;
  delta: MetricValues;
}

export interface NewsletterAnalyticsView {
  publication: NewsletterPublication;
  channels: ChannelView[];
}

export interface WeekAnalyticsView {
  weekStart: string;
  weekEnd: string;
  newsletters: NewsletterAnalyticsView[];
  expectedSurfaces: number;
  measuredSurfaces: number;
  staleSurfaces: number;
  unavailableSurfaces: number;
  errorSurfaces: number;
}

type LooseJson = Record<string, unknown>;

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function addDays(day: string, count: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function weekStartFor(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  const dow = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return date.toISOString().slice(0, 10);
}

function inferredEditionId(key: string): string {
  return key.length === 10 ? "daily-roundup" : key.slice(11);
}

function markerUrl(newsletterDir: string, key: string): string | null {
  const marker = readJson<{ url?: string }>(join(newsletterDir, `.published-${key}`), {});
  return typeof marker.url === "string" && marker.url.startsWith("https://") ? marker.url : null;
}

function asReceipt(platform: AnalyticsPlatform, value: unknown, fallbackDate: string): PostReceipt | null {
  if (!value || typeof value !== "object") return null;
  const post = value as { id?: unknown; url?: unknown; postedAt?: unknown };
  if (typeof post.id !== "string" || !post.id) return null;
  return {
    platform,
    id: post.id,
    url: typeof post.url === "string" ? post.url : null,
    postedAt: typeof post.postedAt === "string" ? post.postedAt : `${fallbackDate}T12:00:00Z`,
  };
}

export function discoverNewsletterPublications(root: string): NewsletterPublication[] {
  const newsletterDir = join(root, "workdir", "newsletters");
  const videosDir = join(root, "workdir", "videos");
  if (!existsSync(newsletterDir)) return [];
  const pipeline = readJson<{ siteUrl?: string }>(join(root, "config", "pipeline.json"), {});
  const siteUrl = (pipeline.siteUrl ?? "").replace(/\/$/, "");

  const publications: NewsletterPublication[] = [];
  for (const filename of readdirSync(newsletterDir).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}(?:-[a-z0-9-]+)?\.json$/.test(filename)) continue;
    const path = join(newsletterDir, filename);
    const issue = readJson<{
      sourceVideoId?: string;
      editionId?: string;
      editionTitle?: string;
      issue?: { subject?: string };
      video?: { headline?: string };
    }>(path, {});
    if (!issue.sourceVideoId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(issue.sourceVideoId)) continue;

    const meta = readJson<{
      headline?: string;
      edition?: string;
      createdAt?: string;
      posts?: Record<string, unknown>;
    }>(join(videosDir, issue.sourceVideoId, "meta.json"), {});
    const key = basename(filename, ".json");
    const date = key.slice(0, 10);
    const posts: Partial<Record<AnalyticsPlatform, PostReceipt>> = {};
    for (const platform of ANALYTICS_PLATFORMS) {
      const receipt = asReceipt(platform, meta.posts?.[platform], date);
      if (receipt) posts[platform] = receipt;
    }

    publications.push({
      key,
      date,
      weekStart: weekStartFor(date),
      editionId: meta.edition ?? issue.editionId ?? inferredEditionId(key),
      editionTitle: issue.editionTitle ?? meta.edition ?? inferredEditionId(key),
      headline: meta.headline ?? issue.video?.headline ?? issue.issue?.subject ?? issue.sourceVideoId,
      contentId: issue.sourceVideoId,
      newsletterUrl: markerUrl(newsletterDir, key),
      archiveUrl: siteUrl ? `${siteUrl}/issues/${key}.html` : "",
      posts,
    });
  }
  return publications.sort((a, b) => a.key.localeCompare(b.key));
}

export function analyticsStorePath(root: string): string {
  return join(root, "state", "analytics-snapshots.json");
}

export function loadAnalyticsStore(root: string): AnalyticsStore {
  const store = readJson<AnalyticsStore>(analyticsStorePath(root), { schemaVersion: 1, snapshots: [] });
  return {
    schemaVersion: 1,
    snapshots: Array.isArray(store.snapshots) ? store.snapshots : [],
  };
}

export function saveAnalyticsStore(root: string, store: AnalyticsStore): void {
  const path = analyticsStorePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
}

export function appendSnapshots(root: string, additions: AnalyticsSnapshot[]): AnalyticsStore {
  const store = loadAnalyticsStore(root);
  const seen = new Set(store.snapshots.map((s) => `${s.runId}::${s.newsletterKey}::${s.platform}`));
  for (const snapshot of additions) {
    const key = `${snapshot.runId}::${snapshot.newsletterKey}::${snapshot.platform}`;
    if (seen.has(key)) continue;
    seen.add(key);
    store.snapshots.push(snapshot);
  }
  store.snapshots.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  saveAnalyticsStore(root, store);
  return store;
}

function numericMetrics(input: unknown): MetricValues {
  if (!input || typeof input !== "object") return {};
  const source = input as Record<string, unknown>;
  const output: MetricValues = {};
  const aliases: Record<string, keyof MetricValues> = {
    impressions: "impressions",
    reach: "reach",
    views: "views",
    reactions: "reactions",
    likes: "likes",
    comments: "comments",
    shares: "shares",
    saves: "saves",
    subsGained: "subscribersGained",
    subscribers_at_date: "accountSubscribers",
    avgViewDurationSec: "avgWatchTimeSeconds",
  };
  for (const [sourceKey, targetKey] of Object.entries(aliases)) {
    const value = source[sourceKey];
    if (typeof value === "number" && Number.isFinite(value)) output[targetKey] = value;
  }
  return output;
}

/** Convert the previous hand-entered metrics file into normalized fallback snapshots without
 * rewriting it. Account subscriber totals remain explicitly account-level and are never credited
 * to a post as subscriber growth. */
export function loadLegacyManualSnapshots(root: string, catalog: NewsletterPublication[]): AnalyticsSnapshot[] {
  const manual = readJson<{ posts?: LooseJson[] }>(join(root, "state", "metrics.json"), {});
  const byContentId = new Map(catalog.map((publication) => [publication.contentId, publication]));
  const snapshots: AnalyticsSnapshot[] = [];
  for (const item of manual.posts ?? []) {
    const id = typeof item.id === "string" ? item.id : null;
    const platform = typeof item.platform === "string" && ANALYTICS_PLATFORMS.includes(item.platform as AnalyticsPlatform)
      ? item.platform as AnalyticsPlatform
      : null;
    const publication = id ? byContentId.get(id) : null;
    if (!id || !platform || !publication) continue;
    const metrics = numericMetrics(item.metrics);
    if (!Object.keys(metrics).length) continue;
    const receipt = publication.posts[platform];
    snapshots.push({
      schemaVersion: 1,
      runId: `legacy-manual-${String(item.recordedAt ?? item.postedAt ?? publication.date)}`,
      capturedAt: String(item.recordedAt ?? item.postedAt ?? `${publication.date}T12:00:00Z`),
      newsletterKey: publication.key,
      newsletterDate: publication.date,
      editionId: publication.editionId,
      contentId: publication.contentId,
      platform,
      postId: receipt?.id ?? id,
      url: receipt?.url ?? (typeof item.url === "string" ? item.url : null),
      source: "manual-legacy",
      status: "collected",
      metrics,
      note: "Legacy hand-entered snapshot; account subscriber totals are context, not post attribution.",
    });
  }
  return snapshots;
}

export function exposureMetric(metrics: MetricValues): { label: "impressions" | "reach" | "views"; value: number } | null {
  if (typeof metrics.impressions === "number") return { label: "impressions", value: metrics.impressions };
  if (typeof metrics.reach === "number") return { label: "reach", value: metrics.reach };
  if (typeof metrics.views === "number") return { label: "views", value: metrics.views };
  return null;
}

export function interactionCount(metrics: MetricValues): number {
  return (metrics.reactions ?? 0)
    + (metrics.likes ?? 0)
    + (metrics.comments ?? 0)
    + (metrics.shares ?? 0)
    + (metrics.reposts ?? 0)
    + (metrics.quotes ?? 0)
    + (metrics.saves ?? 0);
}

function metricDelta(current: MetricValues, prior: MetricValues): MetricValues {
  const delta: MetricValues = {};
  for (const key of Object.keys(current) as (keyof MetricValues)[]) {
    if (typeof current[key] === "number" && typeof prior[key] === "number") {
      // Native platforms occasionally revise lifetime counters downward after spam filtering or
      // reconciliation. Preserve that signal instead of silently turning it into zero growth.
      delta[key] = current[key]! - prior[key]!;
    }
  }
  return delta;
}

function channelView(publication: NewsletterPublication, platform: AnalyticsPlatform, snapshots: AnalyticsSnapshot[]): ChannelView {
  const receipt = publication.posts[platform] ?? null;
  if (!receipt) {
    return {
      platform,
      receipt: null,
      status: "missing",
      collectorStatus: "not-run",
      metrics: {},
      source: null,
      capturedAt: null,
      note: "No confirmed post receipt for this newsletter and channel.",
      exposure: null,
      exposureLabel: null,
      interactions: 0,
      engagementRate: null,
      delta: {},
    };
  }

  const attempts = snapshots
    .filter((s) => s.newsletterKey === publication.key
      && s.platform === platform
      && s.postId === receipt.id
      && isAcceptedAnalyticsSnapshot(s))
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  const latestAttempt = attempts[0];
  const successful = attempts.filter((s) => (s.status === "collected" || s.status === "partial") && Object.keys(s.metrics).length);
  const latestData = successful[0];
  const priorData = successful[1];
  if (!latestData) {
    const baseNote = latestAttempt?.note ?? (platform === "linkedin"
      ? "LinkedIn is not measured yet."
      : "No metric snapshot has been collected yet.");
    const unavailableNote = failureNote(platform, baseNote);
    return {
      platform,
      receipt,
      status: latestAttempt?.status ?? "unavailable",
      collectorStatus: latestAttempt?.status ?? "not-run",
      metrics: {},
      source: latestAttempt?.source ?? null,
      capturedAt: latestAttempt?.capturedAt ?? null,
      note: unavailableNote,
      exposure: null,
      exposureLabel: null,
      interactions: 0,
      engagementRate: null,
      delta: {},
    };
  }

  const exposure = exposureMetric(latestData.metrics);
  const interactions = interactionCount(latestData.metrics);
  const collectionRegressed = !!latestAttempt && latestAttempt.capturedAt > latestData.capturedAt
    && latestAttempt.status !== "collected" && latestAttempt.status !== "partial";
  const latestNote = collectionRegressed
    ? latestAttempt?.note ?? "Latest collection attempt failed; showing the last measured snapshot."
    : latestData.note ?? null;
  const note = collectionRegressed || latestData.status === "partial"
    ? failureNote(platform, latestNote ?? "Latest collection attempt did not return complete metrics.")
    : latestNote;
  return {
    platform,
    receipt,
    status: collectionRegressed ? "stale" : latestData.status,
    collectorStatus: latestAttempt?.status ?? latestData.status,
    metrics: latestData.metrics,
    source: latestData.source,
    capturedAt: latestData.capturedAt,
    note,
    exposure: exposure?.value ?? null,
    exposureLabel: exposure?.label ?? null,
    interactions,
    engagementRate: exposure && exposure.value > 0 ? interactions / exposure.value : null,
    delta: priorData ? metricDelta(latestData.metrics, priorData.metrics) : {},
  };
}

function failureNote(platform: AnalyticsPlatform, note: string): string {
  if (platform !== "linkedin") return note;
  if (note.includes("exact post's own") && note.includes("combined Content exports")) return note;
  return `${note} ${LINKEDIN_DIRECT_POST_FALLBACK}`;
}

export function buildWeekView(catalog: NewsletterPublication[], snapshots: AnalyticsSnapshot[], weekStart: string): WeekAnalyticsView {
  const newsletters = catalog
    .filter((publication) => publication.weekStart === weekStart)
    .map((publication) => ({
      publication,
      channels: ANALYTICS_PLATFORMS.map((platform) => channelView(publication, platform, snapshots)),
    }));
  const cells = newsletters.flatMap((newsletter) => newsletter.channels).filter((channel) => channel.receipt);
  return {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    newsletters,
    expectedSurfaces: cells.length,
    measuredSurfaces: cells.filter((channel) => channel.status === "collected" || channel.status === "partial" || channel.status === "stale").length,
    staleSurfaces: cells.filter((channel) => channel.status === "stale").length,
    unavailableSurfaces: cells.filter((channel) => channel.status === "unavailable").length,
    errorSurfaces: cells.filter((channel) => channel.status === "error").length,
  };
}

export function availableWeeks(catalog: NewsletterPublication[]): string[] {
  return [...new Set(catalog.map((publication) => publication.weekStart))].sort().reverse();
}

export function dashboardWeekOptions(available: string[], selected: string, limit = 16): string[] {
  return [selected, ...available.filter((week) => week !== selected)].slice(0, limit);
}

export function defaultCompletedWeek(catalog: NewsletterPublication[], today: string): string {
  const currentWeek = weekStartFor(today);
  return availableWeeks(catalog).find((week) => week < currentWeek) ?? currentWeek;
}
