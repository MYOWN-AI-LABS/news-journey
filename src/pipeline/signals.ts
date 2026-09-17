import { STATE_DIR } from "../util.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SignalPlatform = "gdelt" | "hn" | "github" | "linkedin" | "instagram" | "x" | "reddit";

export interface SignalObservation {
  platform: SignalPlatform;
  scope: "public_heat" | "owned_performance";
  method: "api" | "browser" | "feed" | "manual";
  /** 0..1 — how much this reading is allowed to move the score away from neutral. */
  confidence: number;
  sampleSize?: number;
  /** The collector stopped looking after this many results — values are lower bounds. */
  sampleCap?: number;
  metrics: Record<string, number>;
  /** Human-honest description, e.g. "6 posts observed in first 75 LinkedIn search results". */
  evidenceLabel: string;
  /** observed = real reading; everything else is a reason the reading is absent and stays neutral. */
  state: "observed" | "unavailable" | "rate_limited" | "ambiguous" | "not_supported" | "capped";
  query?: string;
  observedAt?: string;
}

/* ── component weights ─────────────────────────────────────────────────────────
   Public heat is deliberately the largest component: the daily brief's job is to lead with what
   the field is actually talking about. Provenance stops an unsourced viral rumour from winning on
   heat alone; freshness stops a three-day-old consensus story from beating today's news; the
   editorial percentile preserves the within-source merit ordering the harvest already computes. */
export const COMPONENT_WEIGHTS = { heat: 0.50, provenance: 0.25, freshness: 0.15, editorial: 0.10 } as const;

/** Heat sub-weights (fractions of the heat component). Instagram is absent by design: it offers no
 *  defensible public story-search signal, so it contributes owned-post analytics only. */
export const HEAT_WEIGHTS: Partial<Record<SignalPlatform, number>> = {
  gdelt: 0.30,
  reddit: 0.20,
  // HN points and GitHub stars are separate metrics with separate histories (production 2026-09): never one pool.
  hn: 0.10,
  github: 0.10,
  linkedin: 0.15,
  x: 0.15,
};

export const NEUTRAL = 50;

/** Shrink a percentile toward neutral by confidence: adjusted = 50 + c·(p − 50).
 *  A missing/blocked/unsupported signal (c = 0, or no observation at all) is EXACTLY neutral —
 *  never zero, because "we could not look" must not impersonate "nobody cared". */
export function shrink(percentile: number, confidence: number): number {
  const p = Math.max(0, Math.min(100, percentile));
  const c = Math.max(0, Math.min(1, confidence));
  return NEUTRAL + c * (p - NEUTRAL);
}

/** Percentile of `value` within `pool` (0..100). A single observation has no pool to rank against,
 *  so it is neutral at 50 rather than arbitrarily best (100) or worst (0). */
export function percentileIn(value: number, pool: number[]): number {
  const others = pool.filter((v) => Number.isFinite(v));
  if (others.length <= 1) return NEUTRAL;
  const below = others.filter((v) => v < value).length;
  const equal = others.filter((v) => v === value).length;
  return Math.round(((below + equal / 2) / others.length) * 100);
}

/* ── observation history ───────────────────────────────────────────────────────
   Batch percentiles are noisy when the batch is small, so once a platform has ≥20 historical
   readings we rank against history instead. Until then: current-batch percentile (per the plan). */
const ROOT = new URL("../..", import.meta.url).pathname;
const HISTORY_PATH = join(STATE_DIR, "signal-history.json");
const HISTORY_MIN = 20;
const HISTORY_MAX = 400; // per platform·metric — enough for a stable distribution, bounded on disk

type History = Record<string, number[]>; // "platform.metric" -> past values

export function loadHistory(path = HISTORY_PATH): History {
  try { return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as History) : {}; } catch { return {}; }
}
export function saveHistory(h: History, path = HISTORY_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  for (const k of Object.keys(h)) h[k] = h[k].slice(-HISTORY_MAX);
  writeFileSync(path, JSON.stringify(h, null, 2));
}
export function rankWithHistory(platform: string, metric: string, value: number, batchPool: number[], h: History): number {
  const hist = h[`${platform}.${metric}`] ?? [];
  return hist.length >= HISTORY_MIN ? percentileIn(value, hist) : percentileIn(value, batchPool);
}

/* ── composite ────────────────────────────────────────────────────────────── */

export interface ComponentScore {
  total: number; // 0..100, bounded by construction (weighted average of bounded parts)
  heat: number;
  provenance: number;
  freshness: number;
  editorial: number;
  /** Per-platform adjusted heat contributions, for the audit trail the model sees. */
  heatParts: Partial<Record<SignalPlatform, number>>;
}

/** Provenance tier → 0..100 component. Mirrors credibility.ts tiers; kept as an explicit map so
 *  the scoring is auditable in one place. */
export const PROVENANCE_SCORE: Record<string, number> = { primary: 100, established: 78, community: 62, unknown: 30 };

/** Freshness: 100 at 0h decaying linearly to 0 at `windowHours`. Undated → neutral 50. */
export function freshnessScore(publishedAt: string | null | undefined, windowHours = 48): number {
  if (!publishedAt) return NEUTRAL;
  const ageH = (Date.now() - new Date(publishedAt).getTime()) / 3600_000;
  if (!Number.isFinite(ageH)) return NEUTRAL;
  return Math.round(Math.max(0, Math.min(100, 100 * (1 - ageH / windowHours))));
}

export function compose(parts: {
  heatParts: Partial<Record<SignalPlatform, number>>; // already shrunk, 0..100, neutral when absent
  provenance: number;
  freshness: number;
  editorial: number;
}): ComponentScore {
  // Weighted heat: platforms with no observation contribute NEUTRAL at their full weight, so a
  // story observed on one extreme platform cannot run the whole heat component to the rail.
  let heat = 0;
  for (const [platform, w] of Object.entries(HEAT_WEIGHTS) as [SignalPlatform, number][]) {
    heat += w * (parts.heatParts[platform] ?? NEUTRAL);
  }
  heat = Math.round(heat);
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  const heatC = clamp(heat), prov = clamp(parts.provenance), fresh = clamp(parts.freshness), ed = clamp(parts.editorial);
  const total = Math.round(
    COMPONENT_WEIGHTS.heat * heatC +
    COMPONENT_WEIGHTS.provenance * prov +
    COMPONENT_WEIGHTS.freshness * fresh +
    COMPONENT_WEIGHTS.editorial * ed
  );
  return { total, heat: heatC, provenance: prov, freshness: fresh, editorial: ed, heatParts: parts.heatParts };
}
