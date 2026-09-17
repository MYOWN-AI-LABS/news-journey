import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { AccountSnapshot } from "./account.js";
import {
  findLinkedInAnalyticsHref,
  insightValues,
  matchThreadsMediaRows,
  parseIsoDuration,
  parseLinkedInPostSummaryText,
  parseXActionRowAriaLabel,
  parseXPostAnalyticsText,
  threadsShortcode,
} from "./collectors.js";
import {
  ANALYTICS_PLATFORMS,
  buildWeekView,
  dashboardWeekOptions,
  discoverNewsletterPublications,
  isAcceptedAnalyticsSnapshot,
  type AnalyticsSnapshot,
  type NewsletterPublication,
  weekStartFor,
} from "./model.js";
import { renderAnalyticsDashboard, renderAnalyticsReport } from "./render.js";

function publication(): NewsletterPublication {
  return {
    key: "2026-08-30-special-extra",
    date: "2026-08-30",
    weekStart: "2026-08-24",
    editionId: "special-extra",
    editionTitle: "The Daily Signal — Extra № 32",
    headline: "AI Locks Benchmarks as Quantum Leaves GPS",
    contentId: "20260830-special-extra-ai-locks-benchmarks-as-quantum",
    newsletterUrl: "https://www.linkedin.com/pulse/example",
    archiveUrl: "https://example.com/issues/2026-08-30-special-extra.html",
    posts: {
      instagram: { platform: "instagram", id: "ig-1", url: "https://instagram.example/ig-1", postedAt: "2026-08-30T14:00:00Z" },
      youtube: { platform: "youtube", id: "yt-1", url: "https://youtube.example/yt-1", postedAt: "2026-08-30T14:00:00Z" },
    },
  };
}

function snap(overrides: Partial<AnalyticsSnapshot>): AnalyticsSnapshot {
  return {
    schemaVersion: 1,
    runId: "run",
    capturedAt: "2026-08-31T12:00:00Z",
    newsletterKey: "2026-08-30-special-extra",
    newsletterDate: "2026-08-30",
    editionId: "special-extra",
    contentId: "20260830-special-extra-ai-locks-benchmarks-as-quantum",
    platform: "instagram",
    postId: "ig-1",
    url: "https://instagram.example/ig-1",
    source: "instagram-graph",
    status: "collected",
    metrics: { reach: 100, likes: 10, comments: 2 },
    ...overrides,
  };
}

test("weekStartFor anchors Monday through Sunday to the same reporting week", () => {
  assert.equal(weekStartFor("2026-08-24"), "2026-08-24");
  assert.equal(weekStartFor("2026-08-30"), "2026-08-24");
  assert.equal(weekStartFor("2026-08-31"), "2026-08-31");
});

test("dashboard week options always preserve an explicitly requested older or empty week", () => {
  const recent = Array.from({ length: 20 }, (_, index) => `2026-${String(index + 1).padStart(2, "0")}-01`).reverse();
  assert.equal(dashboardWeekOptions(recent, "2024-01-01")[0], "2024-01-01");
  assert.equal(dashboardWeekOptions(recent, recent[5]).filter((week) => week === recent[5]).length, 1);
  assert.equal(dashboardWeekOptions(recent, "2024-01-01").length, 16);
});



test("newsletter discovery binds issue, source video, publish marker, archive, and every exact post receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "analytics-catalog-"));
  mkdirSync(join(root, "workdir", "newsletters"), { recursive: true });
  mkdirSync(join(root, "workdir", "videos", "video-1"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "pipeline.json"), JSON.stringify({ siteUrl: "https://archive.example" }));
  writeFileSync(join(root, "workdir", "newsletters", "2026-08-30-special-extra.json"), JSON.stringify({
    sourceVideoId: "video-1",
    editionTitle: "Extra № 32",
    video: { headline: "Newsletter headline" },
  }));
  writeFileSync(join(root, "workdir", "newsletters", ".published-2026-08-30-special-extra"), JSON.stringify({ url: "https://www.linkedin.com/pulse/exact" }));
  writeFileSync(join(root, "workdir", "videos", "video-1", "meta.json"), JSON.stringify({
    edition: "special-extra",
    headline: "Feed headline",
    posts: Object.fromEntries(ANALYTICS_PLATFORMS.map((platform) => [platform, { id: `${platform}-id`, url: `https://${platform}.example/post`, postedAt: "2026-08-30T14:00:00Z" }])),
  }));

  const catalog = discoverNewsletterPublications(root);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].contentId, "video-1");
  assert.equal(catalog[0].newsletterUrl, "https://www.linkedin.com/pulse/exact");
  assert.equal(catalog[0].archiveUrl, "https://archive.example/issues/2026-08-30-special-extra.html");
  assert.equal(Object.keys(catalog[0].posts).length, 6);
  assert.equal(catalog[0].posts.tiktok?.id, "tiktok-id");
});

test("weekly view keeps the last measured data visible when a newer collection attempt is unavailable", () => {
  const view = buildWeekView([publication()], [
    snap({ capturedAt: "2026-08-24T12:00:00Z", metrics: { reach: 80, likes: 8, comments: 1 } }),
    snap({ capturedAt: "2026-08-31T11:00:00Z", metrics: { reach: 100, likes: 10, comments: 2 } }),
    snap({ capturedAt: "2026-08-31T12:00:00Z", status: "unavailable", metrics: {}, note: "permission missing" }),
  ], "2026-08-24");
  const instagram = view.newsletters[0].channels.find((channel) => channel.platform === "instagram")!;
  assert.equal(instagram.status, "stale");
  assert.equal(instagram.collectorStatus, "unavailable");
  assert.equal(instagram.exposure, 100);
  assert.equal(instagram.delta.reach, 20);
  assert.equal(instagram.engagementRate, 0.12);
  assert.equal(view.measuredSurfaces, 1);
  assert.equal(view.expectedSurfaces, 2);
});

test("weekly view rejects combined LinkedIn Content-export rows as exact-post analytics", () => {
  const item = publication();
  item.posts.linkedin = {
    platform: "linkedin",
    id: "urn:li:ugcPost:7497670290231967744",
    url: "https://www.linkedin.com/feed/update/urn:li:ugcPost:7497670290231967744",
    postedAt: "2026-08-30T14:00:00Z",
  };
  const view = buildWeekView([item], [snap({
    platform: "linkedin",
    postId: item.posts.linkedin.id,
    url: item.posts.linkedin.url,
    source: "linkedin-creator-analytics-export",
    metrics: { impressions: 99, reactions: 2 },
  })], "2026-08-24");
  const linkedin = view.newsletters[0].channels.find((channel) => channel.platform === "linkedin")!;
  assert.equal(linkedin.status, "unavailable");
  assert.equal(linkedin.source, null);
  assert.deepEqual(linkedin.metrics, {});
  assert.match(linkedin.note ?? "", /exact post's own View analytics/);
  assert.equal(view.measuredSurfaces, 0);
  assert.equal(isAcceptedAnalyticsSnapshot({ source: "linkedin-creator-analytics-export" }), false);
  assert.equal(isAcceptedAnalyticsSnapshot({ source: "linkedin-post-browser-analytics" }), true);
});

test("weekly view preserves the latest accepted LinkedIn failure reason", () => {
  const item = publication();
  item.posts.linkedin = {
    platform: "linkedin",
    id: "urn:li:ugcPost:7497670290231967744",
    url: "https://www.linkedin.com/feed/update/urn:li:ugcPost:7497670290231967744",
    postedAt: "2026-08-30T14:00:00Z",
  };
  const view = buildWeekView([item], [snap({
    platform: "linkedin",
    postId: item.posts.linkedin.id,
    url: item.posts.linkedin.url,
    source: "linkedin-post-browser-analytics",
    status: "error",
    metrics: {},
    note: "LinkedIn returned HTTP 429 for the exact post.",
  })], "2026-08-24");
  const linkedin = view.newsletters[0].channels.find((channel) => channel.platform === "linkedin")!;
  assert.equal(linkedin.status, "error");
  assert.equal(linkedin.source, "linkedin-post-browser-analytics");
  assert.match(linkedin.note ?? "", /HTTP 429/);
  assert.match(linkedin.note ?? "", /exact post's own View analytics/);
});

test("weekly view appends the direct-post fallback to partial and stale LinkedIn failures", () => {
  const item = publication();
  item.posts.linkedin = {
    platform: "linkedin",
    id: "urn:li:ugcPost:7497670290231967744",
    url: "https://www.linkedin.com/feed/update/urn:li:ugcPost:7497670290231967744",
    postedAt: "2026-08-30T14:00:00Z",
  };
  const partialView = buildWeekView([item], [snap({
    platform: "linkedin",
    postId: item.posts.linkedin.id,
    url: item.posts.linkedin.url,
    source: "linkedin-post-browser-analytics",
    status: "partial",
    metrics: { impressions: 10 },
    note: "Unavailable metrics: COMMENT:429",
  })], "2026-08-24");
  const partial = partialView.newsletters[0].channels.find((channel) => channel.platform === "linkedin")!;
  assert.equal(partial.status, "partial");
  assert.match(partial.note ?? "", /COMMENT:429/);
  assert.match(partial.note ?? "", /exact post's own View analytics/);

  const staleView = buildWeekView([item], [
    snap({
      platform: "linkedin",
      postId: item.posts.linkedin.id,
      url: item.posts.linkedin.url,
      source: "linkedin-post-browser-analytics",
      capturedAt: "2026-08-30T12:00:00Z",
      metrics: { impressions: 10 },
    }),
    snap({
      platform: "linkedin",
      postId: item.posts.linkedin.id,
      url: item.posts.linkedin.url,
      source: "linkedin-post-browser-analytics",
      capturedAt: "2026-08-31T12:00:00Z",
      status: "error",
      metrics: {},
      note: "LinkedIn returned HTTP 429 for the exact post.",
    }),
  ], "2026-08-24");
  const stale = staleView.newsletters[0].channels.find((channel) => channel.platform === "linkedin")!;
  assert.equal(stale.status, "stale");
  assert.match(stale.note ?? "", /HTTP 429/);
  assert.match(stale.note ?? "", /exact post's own View analytics/);
});

test("snapshot deltas preserve downward platform reconciliations", () => {
  const view = buildWeekView([publication()], [
    snap({ capturedAt: "2026-08-24T12:00:00Z", metrics: { reach: 100, likes: 10 } }),
    snap({ capturedAt: "2026-08-31T12:00:00Z", metrics: { reach: 95, likes: 9 } }),
  ], "2026-08-24");
  const instagram = view.newsletters[0].channels.find((channel) => channel.platform === "instagram")!;
  assert.equal(instagram.delta.reach, -5);
  assert.equal(instagram.delta.likes, -1);
});

test("Meta insight normalization preserves zeroes and converts watch milliseconds to seconds", () => {
  assert.deepEqual(insightValues({ data: [
    { name: "reach", values: [{ value: 6 }] },
    { name: "likes", values: [{ value: 0 }] },
    { name: "ig_reels_avg_watch_time", values: [{ value: 3250 }] },
  ] }), { reach: 6, likes: 0, avgWatchTimeSeconds: 3.25 });
});

test("ISO duration parser handles short and long videos", () => {
  assert.equal(parseIsoDuration("PT1M31S"), 91);
  assert.equal(parseIsoDuration("PT2H3M4.5S"), 7384.5);
  assert.equal(parseIsoDuration("bad"), null);
});

// Fixture is the EXACT innerText captured live 2026-09-02 from
// linkedin.com/analytics/post-summary/urn:li:activity:7500901282426204160/ — not invented. It
// mixes two label/value orderings in one document (see collectors.ts's comment above
// parseLinkedInPostSummaryText), which is exactly what this test guards against regressing.
const LINKEDIN_POST_SUMMARY_FIXTURE = `Discovery

66

Impressions

In-network (followers and connections)

24%

Out-of-network

76%

55

Members reached

Video performance

19

Video views

Watch time

1m 9s

Average watch time

3s

Profile activity

0

Profile viewers from this post

0

Followers gained from this post

Engagement

1

Social engagements

Reactions

1

Comments

0

Reposts

0

Saves

0

Sends on LinkedIn

0

Top demographics`;

test("LinkedIn post-summary parser reads both label/value orderings in the same page without cross-contamination", () => {
  const metrics = parseLinkedInPostSummaryText(LINKEDIN_POST_SUMMARY_FIXTURE);
  assert.deepEqual(metrics, {
    impressions: 66,
    reach: 55,
    views: 19,
    avgWatchTimeSeconds: 69,
    followersGained: 0,
    reactions: 1,
    comments: 0,
    reposts: 0,
    saves: 0,
    shares: 0,
  });
});

test("LinkedIn analytics link discovery takes the per-post summary href and never the rejected combined export", () => {
  const found = findLinkedInAnalyticsHref([
    { href: "https://www.linkedin.com/analytics/creator/content/", text: "Post impressions16,249" },
    { href: "https://www.linkedin.com/analytics/post-summary/urn:li:activity:7500901282426204160/", text: "66 impressionsView analyticsView analytics" },
  ]);
  assert.equal(found, "https://www.linkedin.com/analytics/post-summary/urn:li:activity:7500901282426204160/");
  assert.equal(findLinkedInAnalyticsHref([{ href: "https://www.linkedin.com/analytics/creator/content/", text: "x" }]), null);
});

// Fixture is the EXACT innerText captured live 2026-09-02 from
// x.com/SVf4data/status/2095135723703742940/analytics.
const X_POST_ANALYTICS_FIXTURE = `Post Analytics
0
0
0
Impressions
33
Engagements
0
Detail expands
0
Profile visits
0
Video
Metrics for the video you shared
Unique views
6
Views
9
Audience retention`;

test("X post-analytics parser separates video Unique views from total Views instead of overwriting one with the other", () => {
  assert.deepEqual(parseXPostAnalyticsText(X_POST_ANALYTICS_FIXTURE), { impressions: 33, views: 9 });
});

test("X action-row aria-label parses reply/repost/like counts by kind, not just a summed total", () => {
  assert.deepEqual(
    parseXActionRowAriaLabel("4 replies, 12 reposts, 88 likes, 3 bookmarks, 500 views"),
    { comments: 4, reposts: 12, likes: 88 },
  );
  assert.deepEqual(parseXActionRowAriaLabel(""), {});
});

test("Threads browser permalinks resolve to the shortcode used to find the API media object", () => {
  assert.equal(threadsShortcode("https://www.threads.com/@myownaai/post/DcqxrDRipZr"), "DcqxrDRipZr");
  assert.equal(threadsShortcode("DcqxrDRipZr"), "DcqxrDRipZr");
  assert.equal(threadsShortcode("123456789"), "123456789");
  assert.deepEqual([...matchThreadsMediaRows(
    [{ id: "DcqxrDRipZr", url: "https://www.threads.com/@myownaai/post/DcqxrDRipZr" }],
    [{ id: "987654321", permalink: "https://www.threads.net/@myownaai/post/DcqxrDRipZr" }],
  )], [["DcqxrDRipZr", "987654321"]]);
});

test("overall analytics and top-posts sections accumulate interactions across channels but never sum exposure across them", () => {
  const item = publication();
  item.posts.x = { platform: "x", id: "x-1", url: "https://x.example/x-1", postedAt: "2026-08-30T14:00:00Z" };
  const view = buildWeekView([item], [
    snap({ metrics: { reach: 100, likes: 10, comments: 2 } }), // instagram, from publication()'s default post
    snap({ platform: "x", postId: "x-1", url: "https://x.example/x-1", source: "x-post-browser-analytics", metrics: { impressions: 50, likes: 3, comments: 1 } }),
  ], "2026-08-24");
  const html = renderAnalyticsDashboard([view], "2026-08-31T12:00:00Z", "2026-08-24");
  assert.match(html, /Channel activity — trailing 30 days/);
  assert.match(html, /Top posts, accumulated/);
  // Instagram's reach (100) and X's impressions (50) must appear as SEPARATE labeled figures, never
  // combined into one number like "150" — that would violate the channel-native-denominator rule.
  assert.match(html, /Instagram 100 reach/);
  assert.match(html, /X 50 impressions/);
  assert.doesNotMatch(html, />150<|>150 /);
  // Interactions ARE summed: instagram (10+2=12) + x (3+1=4) = 16 total for this one post.
  assert.match(html, /16 interactions total/);
  // Top posts and each newsletter must be REAL <details> drill-downs, not flat static lists —
  // Operator, 2026-09-03: "top posts should be a drop down" / "drill down into each newsletter should
  // be a drop down."
  assert.match(html, /<details class="disclosure"><summary>[\s\S]*Top posts, accumulated/);
  assert.match(html, /<details class="newsletter-card">/);
});

test("channel activity grid shows all 6 platforms even when only 2 have a real account-level collector", () => {
  // Operator, 2026-09-03: "the dashboard is poorly built, showing only 2 accounts and not all 6
  // accounts" / "instagram has views and analytics for every post" / "same with you tube." Only
  // LinkedIn and X have a dedicated account.ts collector; Instagram/YouTube/Threads/TikTok must
  // still render — Instagram/YouTube from their real per-post rollup, Threads/TikTok with the
  // actual collector-unavailable reason, never silently absent.
  const item = publication(); // instagram + youtube posts by default
  item.posts.threads = { platform: "threads", id: "th-1", url: "https://threads.example/th-1", postedAt: "2026-08-30T14:00:00Z" };
  const view = buildWeekView([item], [
    snap({ metrics: { reach: 200, likes: 5 } }), // instagram
    snap({ platform: "youtube", postId: "yt-1", url: "https://youtube.example/yt-1", source: "youtube-data-api", metrics: { views: 300 } }),
    snap({ platform: "threads", postId: "th-1", url: "https://threads.example/th-1", source: "threads-insights", status: "unavailable", metrics: {}, note: "No Threads tokens — run: npm run auth:threads" }),
  ], "2026-08-24");
  const accountSnapshots: AccountSnapshot[] = [
    { schemaVersion: 1, platform: "linkedin", scope: "newsletter-subscribers", capturedAt: "2026-08-31T00:00:00Z", source: "linkedin-newsletter-browser-analytics", status: "collected", metrics: { subscribers: 410, subscribersGained7d: 5 } },
    { schemaVersion: 1, platform: "x", scope: "profile-followers", capturedAt: "2026-08-31T00:00:00Z", source: "x-profile-browser-analytics", status: "collected", metrics: { subscribers: 13 } },
  ];
  const html = renderAnalyticsDashboard([view], "2026-08-31T12:00:00Z", "2026-08-24", accountSnapshots);
  for (const platform of ["LinkedIn", "Instagram", "YouTube", "X", "Threads", "TikTok"]) {
    assert.match(html, new RegExp(`<strong>${platform}</strong>`), `${platform} card missing from the channel activity grid`);
  }
  assert.match(html, /<div class="platform-summary__number">410<\/div>/); // LinkedIn real subscriber count
  assert.match(html, /<div class="platform-summary__number">13<\/div>/); // X real follower count
  assert.match(html, /<div class="platform-summary__number">200<\/div>\s*<div class="platform-summary__label">reach · 30d total from posts<\/div>/); // Instagram: per-post rollup, not blank
  assert.match(html, /<div class="platform-summary__number">300<\/div>\s*<div class="platform-summary__label">views · 30d total from posts<\/div>/); // YouTube: per-post rollup, not blank
  assert.match(html, /No Threads tokens/); // Threads: the real reason, not a bare dash with no explanation
});

test("executive summary compares the current week against the prior week on the SAME platform metric, never blended", () => {
  const currentItem = publication();
  const priorItem = { ...publication(), key: "2026-08-23-special-extra", date: "2026-08-23", weekStart: "2026-08-17" };
  const current = buildWeekView([currentItem], [snap({ capturedAt: "2026-08-31T00:00:00Z", metrics: { reach: 200, likes: 20, comments: 5 } })], "2026-08-24");
  const prior = buildWeekView([priorItem], [snap({ newsletterKey: priorItem.key, capturedAt: "2026-08-24T00:00:00Z", metrics: { reach: 100, likes: 5, comments: 2 } })], "2026-08-17");
  const html = renderAnalyticsDashboard([current, prior], "2026-08-31T12:00:00Z", "2026-08-24");
  assert.match(html, /What changed this week/);
  // reach doubled (100->200) = +100.0%
  assert.match(html, /\+100\.0% exposure vs prior week/);
  // interactions: current 25 (20+5) vs prior 7 (5+2) = +257.1%
  assert.match(html, /\+257\.1% vs prior week/);
});

test("dashboard and report render a newsletter-first six-channel matrix with exact destination links", () => {
  const view = buildWeekView([publication()], [snap({})], "2026-08-24");
  const html = renderAnalyticsDashboard([view], "2026-08-31T12:00:00Z", "2026-08-24");
  const report = renderAnalyticsReport(view, "2026-08-31T12:00:00Z");
  assert.match(html, /Every newsletter, every channel/);
  assert.match(html, /https:\/\/instagram\.example\/ig-1/);
  for (const platform of ["LinkedIn", "Instagram", "YouTube", "X", "Threads", "TikTok"]) assert.match(html, new RegExp(`>${platform}(?:<|\\s)`));
  assert.doesNotMatch(html, /<table/i);
  assert.match(report, /content ID `20260830-special-extra-ai-locks-benchmarks-as-quantum`/);
  assert.match(report, /\| Instagram \| ig-1 \|/);
  assert.match(report, /\| YouTube \| yt-1 \| unavailable \| — \| — \|/);
  assert.match(html, /<b>—<\/b> interactions/);
  assert.doesNotMatch(html, /[ \t]+\n/);
});
