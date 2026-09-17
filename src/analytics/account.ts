import { profilePath } from "../workspaces.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "playwright";
import { closeSharedProfile, launchSharedProfile } from "../post/browser-profile.js";

const LI_SERIES_ID = process.env.LINKEDIN_NEWSLETTER_ID || "";
const LI_PROFILE_DIR = profilePath("linkedin-newsletter", join(homedir(), ".content-harness", "browser-profiles", "linkedin-newsletter"), "AI_CONTENT_NEWSLETTER_BROWSER_PROFILE_DIR");
const X_PROFILE_DIR = profilePath("x", join(homedir(), ".content-harness", "browser-profiles", "x"), "AI_CONTENT_X_BROWSER_PROFILE_DIR");
const X_HANDLE = process.env.X_HANDLE || "";

export interface AccountMetrics {
  subscribers?: number;
  subscribersGained7d?: number;
  impressions7d?: number;
  articleViews7d?: number;
}

export interface AccountSnapshot {
  schemaVersion: 1;
  platform: "linkedin" | "x";
  scope: "newsletter-subscribers" | "profile-followers";
  capturedAt: string;
  source: string;
  status: "collected" | "unavailable" | "error";
  metrics: AccountMetrics;
  note?: string;
}

function safeMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw.slice(0, 500);
}

export function parseLinkedInNewsletterLandingText(text: string): { subscribers: number | null; subscribersGained7d: number | null } {
  const subscribers = text.match(/(\d[\d,]*)\s+subscribers\b/i)?.[1];
  const gained = text.match(/(\d[\d,]*)\s+new subscribers\b/i)?.[1];
  return {
    subscribers: subscribers ? Number(subscribers.replace(/,/g, "")) : null,
    subscribersGained7d: gained ? Number(gained.replace(/,/g, "")) : null,
  };
}

export function parseLinkedInNewsletterAnalyticsText(text: string): { impressions7d: number | null; articleViews7d: number | null } {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const valueBefore = (label: string): number | null => {
    const idx = lines.indexOf(label);
    if (idx <= 0) return null;
    const raw = Number(lines[idx - 1].replace(/,/g, ""));
    return Number.isFinite(raw) ? raw : null;
  };
  return { impressions7d: valueBefore("Impressions"), articleViews7d: valueBefore("Article views") };
}

export function parseXFollowerLinkText(text: string): number | null {
  const match = text.match(/^(\d[\d,]*)\s+Followers?$/i);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

function snapshot(
  platform: AccountSnapshot["platform"],
  scope: AccountSnapshot["scope"],
  source: string,
  status: AccountSnapshot["status"],
  metrics: AccountMetrics,
  note?: string,
): AccountSnapshot {
  return {
    schemaVersion: 1,
    platform,
    scope,
    capturedAt: new Date().toISOString(),
    source,
    status,
    metrics,
    ...(note ? { note } : {}),
  };
}

export async function collectLinkedInAccount(): Promise<AccountSnapshot> {
  const SOURCE = "linkedin-newsletter-browser-analytics";
  if (!/^\d+$/.test(LI_SERIES_ID)) return snapshot("linkedin", "newsletter-subscribers", SOURCE, "unavailable", {}, "Configure LINKEDIN_NEWSLETTER_ID");
  let ctx: Awaited<ReturnType<typeof launchSharedProfile>>;
  try {
    ctx = await launchSharedProfile(LI_PROFILE_DIR, { viewport: { width: 1400, height: 1000 }, attempts: 12 });
  } catch (error) {
    return snapshot("linkedin", "newsletter-subscribers", SOURCE, "unavailable", {}, safeMessage(error));
  }
  try {
    const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`https://www.linkedin.com/newsletters/${LI_SERIES_ID}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6_000);
    if (/\/login|\/authwall|\/uas\/login|checkpoint/.test(page.url())) {
      return snapshot("linkedin", "newsletter-subscribers", SOURCE, "unavailable", {}, "LinkedIn publish profile isn't signed in.");
    }
    const landingText = await page.evaluate(() => document.body.innerText) as string;
    const landing = parseLinkedInNewsletterLandingText(landingText);

    await page.goto(`https://www.linkedin.com/analytics/newsletter/urn:li:fsd_contentSeries:${LI_SERIES_ID}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6_000);
    const analyticsText = await page.evaluate(() => document.body.innerText) as string;
    const analytics = parseLinkedInNewsletterAnalyticsText(analyticsText);

    const metrics: AccountMetrics = {
      ...(landing.subscribers !== null ? { subscribers: landing.subscribers } : {}),
      ...(landing.subscribersGained7d !== null ? { subscribersGained7d: landing.subscribersGained7d } : {}),
      ...(analytics.impressions7d !== null ? { impressions7d: analytics.impressions7d } : {}),
      ...(analytics.articleViews7d !== null ? { articleViews7d: analytics.articleViews7d } : {}),
    };
    if (!Object.keys(metrics).length) {
      return snapshot("linkedin", "newsletter-subscribers", SOURCE, "error", {}, "LinkedIn newsletter pages returned no recognizable subscriber metrics.");
    }
    return snapshot("linkedin", "newsletter-subscribers", SOURCE, "collected", metrics);
  } catch (error) {
    return snapshot("linkedin", "newsletter-subscribers", SOURCE, "error", {}, safeMessage(error));
  } finally {
    await closeSharedProfile(ctx);
  }
}

export async function collectXAccount(): Promise<AccountSnapshot> {
  const SOURCE = "x-profile-browser-analytics";
  if (!/^[A-Za-z0-9_]+$/.test(X_HANDLE)) return snapshot("x", "profile-followers", SOURCE, "unavailable", {}, "Configure X_HANDLE");
  let ctx: Awaited<ReturnType<typeof launchSharedProfile>>;
  try {
    ctx = await launchSharedProfile(X_PROFILE_DIR, { viewport: { width: 1400, height: 1000 }, attempts: 1 });
  } catch (error) {
    return snapshot("x", "profile-followers", SOURCE, "unavailable", {}, safeMessage(error));
  }
  try {
    const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`https://x.com/${X_HANDLE}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5_000);
    if (/\/i\/flow\/login|\/login|\/i\/jf\/onboarding/.test(page.url())) {
      return snapshot("x", "profile-followers", SOURCE, "unavailable", {}, "X post-browser profile isn't signed in.");
    }
    const followerText = await page.evaluate(() => {
      const link = document.querySelector('a[href*="/verified_followers"]') as HTMLElement | null;
      return link?.textContent?.trim() ?? "";
    }) as string;
    const followers = parseXFollowerLinkText(followerText);
    if (followers === null) {
      return snapshot("x", "profile-followers", SOURCE, "error", {}, `X profile page returned no recognizable follower count (raw: "${followerText}").`);
    }
    return snapshot("x", "profile-followers", SOURCE, "collected", { subscribers: followers });
  } catch (error) {
    return snapshot("x", "profile-followers", SOURCE, "error", {}, safeMessage(error));
  } finally {
    await closeSharedProfile(ctx);
  }
}

export interface AccountStore {
  schemaVersion: 1;
  snapshots: AccountSnapshot[];
}

export function accountStorePath(root: string): string {
  return join(root, "state", "account-snapshots.json");
}

export function loadAccountStore(root: string): AccountStore {
  const path = accountStorePath(root);
  if (!existsSync(path)) return { schemaVersion: 1, snapshots: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AccountStore;
    return { schemaVersion: 1, snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [] };
  } catch {
    return { schemaVersion: 1, snapshots: [] };
  }
}

export function appendAccountSnapshots(root: string, additions: AccountSnapshot[]): AccountStore {
  const store = loadAccountStore(root);
  store.snapshots.push(...additions);
  store.snapshots.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const path = accountStorePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
  return store;
}

/** Latest collected snapshot per platform — what the dashboard renders. */
export function latestAccountSnapshots(store: AccountStore): AccountSnapshot[] {
  const byPlatform = new Map<string, AccountSnapshot>();
  for (const snap of store.snapshots) {
    if (snap.status !== "collected") continue;
    const existing = byPlatform.get(snap.platform);
    if (!existing || snap.capturedAt > existing.capturedAt) byPlatform.set(snap.platform, snap);
  }
  return [...byPlatform.values()];
}
