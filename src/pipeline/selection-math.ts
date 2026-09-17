// The Daily Signal's selection arithmetic, ported to the harness (production ai-content-engine rank.ts, 2026-09).
// Pure on purpose — no util/model imports — so it is testable without resolving a workspace.
import type { HarvestItem } from "../types.js";
import { canonicalEntityForText, isVendorPromotionalText } from "./selection-policy.js";

/** Bump when the channels, weights or report shape change, so reports made under different rules are never compared as one. */
export const SELECTION_POLICY_ID = "harness-channel-percentile-v1";

/** What an operator may say about their sources (config/sources.json → "ranking"); nothing shipped names a publisher. */
export interface RankingConfig {
  /** RSS hosts that are community-curated aggregators (a forum, a link site), ranked with each other. */
  communityFeeds?: string[];
  /** Sources (RSS host or source id) that are vendors: their promotional items are dropped, their research stays. */
  vendorSources?: string[];
}

export type RankingChannel =
  | "community:hn"
  | "community:github-momentum"
  | "community:github-established"
  | "community:feed"
  | "published:rss"
  | "published:web"
  | "published:api";

export type RankedCandidate = {
  id: string; source: string; title: string; url: string; summary: string; publishedAt?: string | null;
  channel: RankingChannel; rawScore: number; rawMetric: string; channelScore: number;
  /** The 0–100 figure the model sees: the channel percentile, replaced by the composite for the scored leaders. */
  score: number;
  velocity: number | null; velocityPlatform: "hn" | "github" | null;
};

// An RSS item's source id carries the operator's feed NAME ("rss:Example Vendor"), not a host; `origin` is the feed URL's
// real hostname (sources/rss.ts), so a host the operator lists matches however the feed is named.
const host = (h: string) => h.replace(/^rss:/, "").toLowerCase().replace(/^www\./, "");
const listed = (it: { source: string; origin?: string }, list: string[] = []) => list.some((entry) => {
  const e = entry.toLowerCase().replace(/^www\./, "");
  return e.length > 0 && [it.source, ...(it.origin ? [it.origin] : [])].some((h) => h.toLowerCase() === e || host(h) === e || host(h).endsWith("." + e));
});

/** Comparable evidence channels: HN points, GitHub stars today vs lifetime stars, community aggregators, published
 *  feeds (recency score) and public APIs (their own mapped score) never share a pool — their units differ. */
export function rankingChannel(it: HarvestItem, cfg: RankingConfig = {}): RankingChannel {
  if (it.source === "hn") return "community:hn";
  if (it.source.startsWith("gh-")) return (it.repo as { starsToday?: number } | null)?.starsToday === undefined ? "community:github-established" : "community:github-momentum";
  if (it.source.startsWith("public-api:")) return "published:api";
  if (it.source.startsWith("web:")) return "published:web";
  if (listed(it, cfg.communityFeeds)) return "community:feed";
  return "published:rss";
}

/** Inclusive percentile inside a channel: strongest 100, weakest 0, ties share their midpoint, a singleton is neutral 50. */
export function channelPercentile(value: number, pool: number[]): number {
  if (pool.length <= 1) return 50;
  const below = pool.filter((v) => v < value).length;
  const equal = pool.filter((v) => v === value).length;
  return Math.round(100 * (below + (equal - 1) / 2) / (pool.length - 1));
}

const RAW_METRIC: Record<RankingChannel, string> = {
  "community:hn": "hn-points", "community:github-momentum": "github-stars-today", "community:github-established": "github-stars-total",
  "community:feed": "source-recency-score", "published:rss": "source-recency-score", "published:web": "unscored-source", "published:api": "source-api-score",
};

/** The candidate list: every item gets its channel percentile; the strongest `keep` go forward (80, as in production). */
export function rankCandidatesByChannel(fresh: HarvestItem[], cfg: RankingConfig = {}, keep = 80): RankedCandidate[] {
  const groups = new Map<RankingChannel, HarvestItem[]>();
  for (const it of fresh) {
    const k = rankingChannel(it, cfg);
    const g = groups.get(k);
    if (g) g.push(it); else groups.set(k, [it]);
  }
  const scored: RankedCandidate[] = [];
  for (const [channel, items] of groups) {
    const pool = items.map((it) => it.score);
    for (const it of items) {
      const channelScore = channelPercentile(it.score, pool);
      scored.push({
        id: it.id, source: it.source, title: it.title, url: it.url, summary: it.summary.slice(0, 200), publishedAt: it.publishedAt,
        channel, rawScore: it.score, rawMetric: RAW_METRIC[channel], channelScore, score: channelScore,
        // HN points and GitHub stars are separate community metrics with separate histories — never one pool.
        velocity: it.source === "hn" || it.source.startsWith("gh-") ? it.score : null,
        velocityPlatform: it.source === "hn" ? "hn" : it.source.startsWith("gh-") ? "github" : null,
      });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, keep);
}

/** Vendor research stays eligible; an operator-configured vendor's customer-adoption marketing does not. */
export function isVendorPromotion(it: { source: string; origin?: string; title: string; summary: string }, cfg: RankingConfig = {}): boolean {
  return listed(it, cfg.vendorSources) && isVendorPromotionalText(`${it.title} ${it.summary}`);
}

/**
 * The final slate: the model's recommended stories that survived verification, back-filled from its verified
 * alternates (in order) up to the number it recommended — skipping an alternate whose principal entity is already on
 * the slate. Below `min` is an error, never a short issue. Alternates left over are what a person may swap in.
 */
export function assembleSlate<T extends { principalEntity: string }>(keptRecommended: T[], keptAlternates: T[], recommendedCount: number, min: number, max: number): { slate: T[]; spare: T[] } {
  const target = Math.min(max, Math.max(min, recommendedCount));
  const slate = keptRecommended.slice(0, max);
  const entity = (s: T) => canonicalEntityForText(s.principalEntity); // the same rule as the model validators
  const spare: T[] = [];
  for (const alt of keptAlternates) {
    if (slate.length < target && !slate.some((s) => entity(s) === entity(alt))) slate.push(alt);
    else spare.push(alt);
  }
  if (slate.length < min) throw new Error(`Only ${slate.length} stories have readable sources after back-filling; ${min} required. Re-run harvest or widen the configured sources.`);
  return { slate, spare };
}

/** One row per candidate the model saw: evidence, score, and whether and how it was chosen. No prompts, no secrets. */
export interface SelectionReportRow {
  candidateOrder: number; candidateId: string; headline: string; primaryUrl: string; source: string; channel: RankingChannel;
  rawScore: number; rawMetric: string; channelScore: number; compositeScore: number | null;
  scoreBreakdown: { heat: number; provenance: number; freshness: number; channelRank: number } | null;
  outletsCovering: number | null; credibility: string | null; heatEvidence: string[]; publishedAt: string | null;
  role: "recommended" | "alternate" | "replacement" | null; selectedOrder: number | null; verification: { kept: boolean; reason?: string } | null;
}

export type ScoredCandidate = RankedCandidate & {
  credibility?: string; outletsCovering?: number | null; heatEvidence?: string[];
  scoreBreakdown?: { heat: number; provenance: number; freshness: number; channelRank: number };
};

export type PickedCandidate = { role: "recommended" | "alternate" | "replacement"; order: number; verification: { kept: boolean; reason?: string } | null };

export function selectionReportRows(candidates: ScoredCandidate[], picked: Map<string, PickedCandidate>): SelectionReportRow[] {
  return candidates.map((c, i) => {
    const p = picked.get(c.id);
    const b = c.scoreBreakdown;
    return {
      candidateOrder: i + 1, candidateId: c.id, headline: c.title, primaryUrl: c.url, source: c.source, channel: c.channel,
      rawScore: c.rawScore, rawMetric: c.rawMetric, channelScore: c.channelScore,
      compositeScore: b ? c.score : null,
      scoreBreakdown: b ? { heat: b.heat, provenance: b.provenance, freshness: b.freshness, channelRank: b.channelRank } : null,
      outletsCovering: c.outletsCovering ?? null, credibility: c.credibility ?? null, heatEvidence: c.heatEvidence ?? [], publishedAt: c.publishedAt ?? null,
      role: p?.role ?? null, selectedOrder: p?.order ?? null, verification: p?.verification ?? null,
    };
  });
}
