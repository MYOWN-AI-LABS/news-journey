import { validDay, safeId } from "../workspaces.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NEWSLETTER_DIR } from "./newsletter.js";
import { loadEdition } from "./edition.js";
import { fetchWithTimeout, loadConfig, readJson, log } from "../util.js";

export type LiveStatus = { status: "live" | "stale" | "unknown"; issueUrl: string | null };

/** Return live only when a public article's title contains the exact normalized expected subject. */
export async function newsletterLiveStatus(day: string, editionId?: string): Promise<LiveStatus> {
  validDay(day); if (editionId) safeId(editionId);
  const { newsletterUrl } = loadConfig<{ newsletterUrl?: string }>("pipeline");
  const resolvedEdition = loadEdition(editionId).editionId;
  const key = resolvedEdition !== "daily-roundup" ? `${day}-${resolvedEdition}` : day;
  const issuePath = join(NEWSLETTER_DIR, `${key}.json`);
  if (!existsSync(issuePath)) return { status: "unknown", issueUrl: null };

  // The current local issue is the sole expected identity. Staged/pushed history must not keep an
  // older public article valid after this issue changes.
  const expectedSubjects = [readJson<{ issue: { subject: string } }>(issuePath).issue.subject.trim()].filter(Boolean);
  if (expectedSubjects.length === 0) return { status: "unknown", issueUrl: null };

  // A marker supplies a candidate permalink, not proof. Fetch it and verify the subject recorded
  // at publication time; old or malformed markers fail closed and fall through to page discovery.
  const publishedMarker = join(NEWSLETTER_DIR, `.published-${key}`);
  if (existsSync(publishedMarker)) {
    try {
      const m = readJson<{ url?: string; subject?: string }>(publishedMarker);
      const matchedSubject = m.subject ? expectedSubjects.find((subject) => markerMatchesExpectedSubject(m.subject!, subject)) : undefined;
      if (m.url && matchedSubject && await verifyIssueLive(m.url, matchedSubject)) {
        log(`newsletter-live: ${key} exact subject verified via publish marker -> ${m.url}`);
        return { status: "live", issueUrl: m.url };
      }
      log(`newsletter-live: ${key} marker lacks exact live subject evidence; checking the public page`);
    } catch { /* malformed marker */ }
  }

  if (!newsletterUrl) return { status: "unknown", issueUrl: null };
  const candidatesWithWords = expectedSubjects.map((subject) => ({ subject, words:
    subject.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/)
      .filter((w) => w.length >= 4 && !["this", "that", "with", "from", "your", "just", "into"].includes(w))
  })).filter((candidate) => candidate.words.length > 0);
  if (candidatesWithWords.length === 0) return { status: "unknown", issueUrl: null };

  try {
    const res = await fetchWithTimeout(newsletterUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15" },
    }, 15000);
    if (!res.ok) return { status: "unknown", issueUrl: null };
    const html = await res.text();
    const slugs = [...new Set(html.match(/pulse\/[a-z0-9-]+/g) ?? [])];
    if (slugs.length === 0) return { status: "unknown", issueUrl: null }; // authwall/empty page — can't conclude staleness
    for (const { subject, words } of candidatesWithWords) {
      for (const slug of slugs) {
        const hits = words.filter((w) => slug.includes(w)).length;
        if (hits >= Math.min(3, words.length)) {
          const issueUrl = `https://www.linkedin.com/${slug}`;
          if (await verifyIssueLive(issueUrl, subject)) {
            log(`newsletter-live: exact subject confirmed -> ${issueUrl}`);
            return { status: "live", issueUrl };
          }
        }
      }
    }
    return { status: "stale", issueUrl: null };
  } catch {
    return { status: "unknown", issueUrl: null };
  }
}

/** Pure classifier for definitive deleted/not-found responses. */
export function isDeletedPage(status: number, html: string): boolean {
  if (status === 404 || status === 410) return true;
  if (status < 200 || status >= 300) return false; // authwall / 5xx / transient → NOT "definitely gone"
  return /article you were looking for was not found|page not found|content isn'?t available|redirecting you to the feed/.test(html.toLowerCase());
}

function normalizeTitle(value: string): string {
  return value.toLowerCase()
    .replace(/&(?:amp|#38);/g, " and ")
    .replace(/&(?:quot|#34);/g, " ")
    .replace(/&(?:apos|#39);/g, " ")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

/** A marker may nominate a subject only when it is the current expected issue subject. */
export function markerMatchesExpectedSubject(markerSubject: string, expectedSubject: string): boolean {
  const marker = normalizeTitle(markerSubject);
  const expected = normalizeTitle(expectedSubject);
  return expected.length >= 8 && marker === expected;
}

/** Positive proof requires the complete normalized expected subject, not partial word overlap. */
export function isLiveArticleTitle(title: string, expectedSubject = ""): boolean {
  const actual = normalizeTitle(title);
  const expected = normalizeTitle(expectedSubject);
  return expected.length >= 8 && actual.includes(expected);
}

export async function verifyIssueLive(issueUrl: string, expectedSubject = ""): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(issueUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15" },
    }, 15000);
    if (!res.ok) { log(`verify-live: ${issueUrl} → HTTP ${res.status} → NOT live`); return false; }
    const html = await res.text();
    if (isDeletedPage(res.status, html)) { log(`verify-live: ${issueUrl} → "article not found" → NOT live`); return false; }
    const title = (html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "") + " " + (html.match(/property="og:title" content="([^"]*)"/)?.[1] ?? "");
    const live = isLiveArticleTitle(title, expectedSubject);
    log(`verify-live: ${issueUrl} → ${live ? "LIVE ✓" : "no positive signal → NOT live"}`);
    return live;
  } catch (e) {
    log(`verify-live: ${issueUrl} → fetch error ${(e as Error).message} → NOT live`);
    return false;
  }
}
