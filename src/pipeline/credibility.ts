import { STATE_DIR } from "../util.js";
// Corroboration + source legitimacy, used to score candidate stories before the LLM picks.
//
// WHAT THIS IS NOT: a count of LinkedIn / Instagram / X shares. Those numbers are not obtainable —
// LinkedIn retired its share-count endpoint and has no public search, Instagram's Graph API only
// reads your own account, X search is paid, and Reddit's API is closed to self-serve. Any
// "shared 400 times on LinkedIn" figure would be invented, which editorial rule #1 forbids
// outright. So this measures the signal actually underneath that question — HOW MANY INDEPENDENT
// OUTLETS COVERED THE STORY — via GDELT, which is free, keyless, and indexes global news.
//
// Two independent checks, deliberately not collapsed into one number:
//   corroboration — optional coverage breadth, never proof of factual support or independence.
//   sourceTier    — provenance. A vendor's own announcement outranks a write-up of it, and an
//                   unrecognised domain is never allowed to lead on its own.
// Established provenance and broad coverage still require the same source-level factual review.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "../util.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const CACHE_PATH = join(STATE_DIR, "corroboration.json");
const CACHE_TTL_H = 18; // one production day — a story's coverage breadth does not move hourly

export type Tier = "primary" | "established" | "community" | "unknown";

/** Provenance tiers. `primary` = the party that did the thing is announcing it, or the artifact
 *  itself (paper, repo). `established` = outlets with mastheads and corrections policies.
 *  `community` = high-signal but individual voices. Anything unlisted is `unknown` — not
 *  presumed false, but not allowed to carry a story alone. */
const TIERS: { tier: Tier; weight: number; hosts: RegExp }[] = [
  {
    tier: "primary", weight: 1.0,
    hosts: /(^|\.)(openai\.com|anthropic\.com|deepmind\.google|blog\.google|ai\.meta\.com|microsoft\.com|nvidia\.com|apple\.com|aws\.amazon\.com|huggingface\.co|arxiv\.org|github\.com|mistral\.ai|deepseek\.com|moonshot\.cn|qwen\.ai|x\.ai|cohere\.com|databricks\.com|scale\.com)$/i,
  },
  {
    tier: "established", weight: 0.9,
    hosts: /(^|\.)(bbc\.co\.uk|bbc\.com|theguardian\.com|apnews\.com|ap\.org|nbcnews\.com|nbcsports\.com|cbsnews\.com|abcnews\.go\.com|abc\.net\.au|news\.sky\.com|skysports\.com|espn\.com|npr\.org|independent\.co\.uk|france24\.com|dw\.com|techcrunch\.com|theverge\.com|arstechnica\.com|wired\.com|reuters\.com|bloomberg\.com|ft\.com|wsj\.com|nytimes\.com|theinformation\.com|semianalysis\.com|ieee\.org|nature\.com|science\.org|technologyreview\.com|cnbc\.com|axios\.com|theregister\.com)$/i,
  },
  {
    tier: "community", weight: 0.8,
    hosts: /(^|\.)(news\.ycombinator\.com|simonwillison\.net|latent\.space|interconnects\.ai|thesequence\.substack\.com|magazine\.sebastianraschka\.com|importai\.substack\.com|lastweekin\.ai|bensbites\.com)$/i,
  },
];

export function sourceTier(url: string): { tier: Tier; weight: number } {
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return { tier: "unknown", weight: 0.6 }; }
  for (const t of TIERS) if (t.hosts.test(host)) return { tier: t.tier, weight: t.weight };
  return { tier: "unknown", weight: 0.6 };
}

type CacheEntry = {
  domains: number; articles: number; at: string;
  clusters?: number; capped?: boolean; state?: GdeltState;
  /** Failure entries cache the miss briefly so an outage doesn't hammer GDELT, without letting a
   *  2-hour blip look like "unchecked" for a whole day. */
  fail?: boolean;
};
function loadCache(path = CACHE_PATH): Record<string, CacheEntry> {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, CacheEntry>; } catch { return {}; }
}
function saveCache(c: Record<string, CacheEntry>, path = CACHE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(c, null, 2));
}

/** Reduce a headline to the ENTITY other outlets would also name.
 *
 *  An exact-phrase search on a full headline finds almost nothing, because headlines are written
 *  per-outlet: querying "Kimi-K3 on HuggingFace" verbatim returned 0 domains while the same story
 *  had 49 outlets carrying it. What every outlet DOES share is the subject — the model name, the
 *  company, the artifact. So keep the distinctive tokens (capitalised words, anything containing a
 *  digit, e.g. "K3") and drop generic filler, then AND them together unquoted. */
const STOP = new Set(["the","a","an","and","or","of","to","in","on","for","with","its","is","are","be",
  "new","now","how","why","what","this","that","from","after","before","into","over","under","may",
  "will","can","could","would","says","said","launches","announces","introducing","introduces",
  "ai","llm","model","models","open","source","using","use","get","gets","goes","first","more",
  // Distribution VENUES, not story subjects. "Kimi-K3 on HuggingFace" is a story about Kimi K3;
  // ANDing "HuggingFace" into the query excludes every outlet that covered the model without
  // naming where it was hosted — which was most of them (0 domains vs 49).
  "huggingface","github","arxiv","youtube","reddit","twitter","substack","hn"]);

export function queryPhrase(title: string): string {
  const raw = title
    .replace(/^(exclusive|opinion|analysis|report|breaking|watch|video|here's|heres)\b[:\s-]*/i, "")
    // Strip a trailing " — Outlet Name". REQUIRES whitespace both sides: with \s* this matched the
    // hyphen INSIDE a hyphenated token and truncated the query ("Kimi-K3 on HuggingFace" -> "Kimi").
    .replace(/\s+[-–—|]\s+[^-–—|]{0,40}$/, "")
    .replace(/["""'']/g, "");

  const tokens = raw.split(/[\s\-–—:,.()\/]+/).filter(Boolean);
  const distinctive = tokens.filter((t) => {
    const bare = t.replace(/[^\w]/g, "");
    if (!bare) return false;
    if (STOP.has(bare.toLowerCase())) return false;
    // A bare digit is kept: version numbers ARE the distinguishing part of "Claude 5" / "GPT 5".
    // Requiring length >= 2 dropped the "5", left "Claude" alone below the threshold, and the
    // whole query degraded to generic words ("rules context engineering").
    if (/^\d+$/.test(bare)) return true;
    if (bare.length < 2) return false;
    return /[A-Z]/.test(bare) || /\d/.test(bare); // proper nouns and version-ish tokens (K3, GPT5)
  });
  // Pad with plain content words when the headline has too few proper nouns to be specific
  // (e.g. an all-lowercase title), preserving original word order.
  // These terms are ANDed by GDELT, so every extra one narrows the match. Two proper nouns
  // ("Kimi K3", "Claude 5") already identify a story; a third only excludes outlets that phrased
  // it differently. Pad to three ONLY when there aren't two distinctive tokens to begin with.
  const filler = tokens.filter((t) => t.length > 3 && !STOP.has(t.toLowerCase()) && !distinctive.includes(t));
  const chosen = distinctive.length >= 2
    ? distinctive.slice(0, 2)
    : [...new Set([...distinctive, ...filler])].slice(0, 3);
  return chosen.join(" ").trim();
}


export type GdeltState = "observed" | "unavailable" | "rate_limited" | "ambiguous" | "capped";

export interface GdeltEvidence {
  state: GdeltState;
  /** Distinct REGISTRABLE domains (news.yahoo.com and finance.yahoo.com are one domain). */
  domainCount: number | null;
  articleCount: number | null;
  /** Near-duplicate titles clustered — syndicated copies of one write-up are ONE story cluster,
   *  so a wire story reprinted 40× cannot masquerade as 40 independent reports. */
  storyClusterCount: number | null;
  /** True when the API hit its result cap — every count is then a lower bound. */
  lowerBound: boolean;
  query: string;
  observedAt: string;
}

const GDELT_MAX = 75;

/** eTLD+1, approximately: keeps the last two labels, or three when the middle label is a common
 *  second-level registry (co.uk, com.au, …). Not a full public-suffix list — for counting distinct
 *  news publishers the common cases are what matter, and a rare miss only splits one publisher
 *  into two, which errs toward MORE apparent corroboration on multi-host publishers, not less. */
const SECOND_LEVEL = /^(co|com|net|org|ac|gov|edu)\.(uk|au|nz|jp|in|za|br|kr|il|id)$/i;
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  return SECOND_LEVEL.test(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

/** Greedy near-duplicate clustering on title token sets (Jaccard ≥ 0.6). Headlines of the same
 *  syndicated story share almost all tokens; independent write-ups phrase differently. */
export function clusterTitles(titles: string[]): number {
  const sets = titles.map((t) => new Set(
    t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2)
  ));
  const reps: Set<string>[] = [];
  for (const s of sets) {
    if (s.size === 0) continue;
    const dup = reps.some((r) => {
      let inter = 0;
      for (const w of s) if (r.has(w)) inter++;
      return inter / (r.size + s.size - inter) >= 0.6;
    });
    if (!dup) reps.push(s);
  }
  return reps.length;
}

const EVIDENCE_TTL_H = CACHE_TTL_H; // successful lookups: one production day
const FAILURE_TTL_H = 2;            // failures retry sooner — an outage should not stick for 18h

export const GDELT_BATCH_BUDGET_MS = 60_000;
interface GdeltOptions { deadline?: number; request?: typeof fetch; signal?: AbortSignal; backoffMs?: number }
/** The timer covers headers, body and retries; cancellation releases a stalled response reader. */
async function beforeDeadline<T>(deadline: number, operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  if (Date.now() >= deadline || parent?.aborted) throw new Error('Optional coverage deadline reached');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, rejectAbort: ((error: Error) => void) | undefined;
  const abort = () => { controller.abort(); rejectAbort?.(new Error('Optional coverage deadline reached')); };
  const expired = new Promise<never>((_, reject) => { rejectAbort = reject; timer = setTimeout(abort, Math.max(1, deadline - Date.now())); });
  parent?.addEventListener('abort', abort, { once: true });
  try {
    const result = await Promise.race([operation(controller.signal), expired]);
    if (Date.now() >= deadline) { controller.abort(); throw new Error('Optional coverage deadline reached'); }
    return result;
  }
  finally { if (timer) clearTimeout(timer); parent?.removeEventListener('abort', abort); }
}
async function coverageText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel('Optional coverage deadline reached').catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  try {
    if (signal.aborted) { cancel(); throw new Error('Optional coverage deadline reached'); }
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('Optional coverage deadline reached');
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) { cancel(); throw new Error('Optional coverage response too large'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
async function coveragePause(ms: number, deadline: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await beforeDeadline(deadline, abortSignal => new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); abortSignal.removeEventListener('abort', cancelled); resolve(); };
    const cancelled = () => { clearTimeout(timer); abortSignal.removeEventListener('abort', cancelled); reject(new Error('Optional coverage deadline reached')); };
    const timer = setTimeout(finish, ms); abortSignal.addEventListener('abort', cancelled, { once: true });
  }), signal);
}
export async function gdeltEvidence(title: string, opts: GdeltOptions = {}): Promise<GdeltEvidence> {
  const phrase = queryPhrase(title), deadline = Math.min(opts.deadline ?? Infinity, Date.now() + GDELT_BATCH_BUDGET_MS);
  const base: Omit<GdeltEvidence, "state"> = {
    domainCount: null, articleCount: null, storyClusterCount: null,
    lowerBound: false, query: phrase, observedAt: new Date().toISOString(),
  };
  if (phrase.split(/\s+/).filter(Boolean).length < 2) return { ...base, state: "ambiguous" };
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(phrase)}&mode=artlist&maxrecords=${GDELT_MAX}&format=json&timespan=3d`;
  let limited = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { response, text } = await beforeDeadline(Math.min(deadline, Date.now() + 25_000), async signal => {
        const response = await (opts.request ?? fetch)(url, { signal, redirect: "error" });
        return { response, text: await coverageText(response, signal) };
      }, opts.signal);
      if (response.status === 429 || /limit requests/i.test(text)) {
        limited = true;
        if (attempt < 2) await coveragePause((opts.backoffMs ?? 15_000) * (attempt + 1), deadline, opts.signal);
        continue;
      }
      if (!response.ok || !text.trim().startsWith("{")) return { ...base, state: "unavailable" };
      const parsed = JSON.parse(text) as { articles?: { domain?: string; title?: string }[] };
      if (!Array.isArray(parsed.articles)) return { ...base, state: "unavailable" };
      const articles = parsed.articles;
      if (articles.some(row => !row || typeof row.domain !== 'string' || !row.domain.trim() || typeof row.title !== 'string')) return { ...base, state: "unavailable" };
      const domains = new Set(articles.map(a => registrableDomain(a.domain!)));
      const capped = articles.length >= GDELT_MAX;
      return { ...base, state: capped ? "capped" : "observed", domainCount: domains.size, articleCount: articles.length,
        storyClusterCount: clusterTitles(articles.map(a => a.title!)), lowerBound: capped };
    } catch { return { ...base, state: limited ? "rate_limited" : "unavailable" }; }
  }
  log("credibility: GDELT rate-limited within the shared optional budget — leaving coverage unknown");
  return { ...base, state: "rate_limited" };
}

export interface Corroboration {
  domains: number | null;   // null = not checked / lookup failed. NOT zero.
  articles: number | null;
  /** Heuristic headline clusters; this does not establish independent reporting. */
  clusters: number | null;
  /** Counts are lower bounds (API result cap reached). */
  lowerBound: boolean;
  state: GdeltState;
  tier: Tier;
  /** Multiplier applied to a candidate's rank score. */
  weight: number;
  label: string;            // shown to the LLM so it can exercise judgement too
}

/** Breadth multiplier. Deliberately gentle: corroboration informs ranking, it does not decide
 *  truth, and a genuine scoop legitimately starts at one outlet. The asymmetry that matters is at
 *  the bottom — an UNKNOWN domain that no one else is carrying gets pushed down hard, because that
 *  is the actual shape of a fabricated or content-farm story. */
function breadthWeight(domains: number | null, tier: Tier): number {
  if (domains === null) return 1.0;                       // unchecked: stay neutral
  if (domains >= 25) return 1.25;
  if (domains >= 10) return 1.15;
  if (domains >= 4) return 1.05;
  if (domains >= 1) return 1.0;
  // Nobody else is carrying it.
  return tier === "primary" ? 1.0 : tier === "unknown" ? 0.55 : 0.9;
}

/** Check a shortlist. GDELT allows one request per 5s, so this is sequential and paced — call it
 *  on the top candidates, never on the full 80-item harvest (that would be ~7 minutes). */
export async function checkCorroboration(
  items: { title: string; url: string }[],
  opts: { pauseMs?: number; lookup?: typeof gdeltEvidence; cachePath?: string; budgetMs?: number } = {}
): Promise<Corroboration[]> {
  // One 60-second allowance covers the entire shortlist, including pacing, fetch bodies and
  // rate-limit retries. Missing coverage stays unknown; established sources still proceed.
  const pause = opts.pauseMs ?? 8000;
  const cachePath = opts.cachePath ?? CACHE_PATH;
  const cache = loadCache(cachePath);
  const now = Date.now(), budget = opts.budgetMs ?? GDELT_BATCH_BUDGET_MS;
  if (!Number.isFinite(budget) || budget < 1 || budget > GDELT_BATCH_BUDGET_MS || !Number.isFinite(pause) || pause < 0) throw new Error('Optional coverage needs a bounded deadline and nonnegative pacing');
  const deadline = now + budget;
  const out: Corroboration[] = [];
  let looked = 0, cached = 0, skipped = 0;
  let rateLimited = false;

  for (const it of items) {
    const { tier, weight: tierWeight } = sourceTier(it.url);
    // Cache keys are VERSIONED by query algorithm + window: when queryPhrase() or the timespan
    // changes, stale entries computed under the old algorithm must not satisfy new lookups.
    const key = `v2:3d:${queryPhrase(it.title).toLowerCase()}`;
    const hit = cache[key];
    let ev: GdeltEvidence | null = null;

    const ttlH = hit?.fail ? FAILURE_TTL_H : EVIDENCE_TTL_H; // failures retry sooner
    if (hit && now - new Date(hit.at).getTime() < ttlH * 3600_000) {
      cached++;
      ev = hit.fail
        ? { state: hit.state ?? "unavailable", domainCount: null, articleCount: null, storyClusterCount: null, lowerBound: false, query: key, observedAt: hit.at }
        : { state: hit.state ?? "observed", domainCount: hit.domains, articleCount: hit.articles, storyClusterCount: hit.clusters ?? null, lowerBound: !!hit.capped, query: key, observedAt: hit.at };
    } else if (rateLimited || Date.now() >= deadline) {
      skipped++;
      ev = { state: rateLimited ? "rate_limited" : "unavailable", domainCount: null, articleCount: null, storyClusterCount: null, lowerBound: false, query: queryPhrase(it.title), observedAt: new Date().toISOString() };
    } else {
      let attempted = false;
      try {
        if (looked > 0) await coveragePause(pause, deadline);
        attempted = true; looked++;
        ev = await beforeDeadline(deadline, signal => (opts.lookup ?? gdeltEvidence)(it.title, { deadline, signal }));
      } catch { ev = { state: "unavailable", domainCount: null, articleCount: null, storyClusterCount: null, lowerBound: false, query: queryPhrase(it.title), observedAt: new Date().toISOString() }; }
      if (ev.state === "rate_limited") { rateLimited = true; log("credibility: service rate-limited; remaining uncached candidates retain unknown coverage"); }
      if (!attempted) skipped++;
      if (attempted) cache[key] = ev.domainCount === null
        ? { fail: true, state: ev.state, domains: 0, articles: 0, at: ev.observedAt }
        : { state: ev.state, domains: ev.domainCount, articles: ev.articleCount ?? 0, clusters: ev.storyClusterCount ?? undefined, capped: ev.lowerBound || undefined, at: ev.observedAt };
    }

    const domains = ev.domainCount;
    // GDELT failure stays NEUTRAL on breadth — but provenance still applies. "We could not check
    // coverage" never excuses an unknown domain from the tier weighting.
    const weight = tierWeight * breadthWeight(domains, tier);
    const ge = domains !== null && ev.lowerBound ? "≥" : "";
    out.push({
      domains,
      articles: ev.articleCount,
      clusters: ev.storyClusterCount,
      lowerBound: ev.lowerBound,
      state: ev.state,
      tier,
      weight,
      label: domains === null
        ? `${tier}, corroboration unchecked (${ev.state})`
        : `${tier}, ${ge}${domains} outlet${domains === 1 ? "" : "s"} / ${ge}${ev.storyClusterCount} headline cluster${ev.storyClusterCount === 1 ? "" : "s"}`,
    });
  }

  saveCache(cache, cachePath);
  log(`credibility: ${items.length} candidates (${looked} fresh GDELT lookups, ${cached} cached, ${skipped} deferred after rate limit or optional deadline)`);
  return out;
}
