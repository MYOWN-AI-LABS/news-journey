import { STATE_DIR } from "../util.js";
import { profilePath } from "../workspaces.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, log } from "../util.js";
/** Recorded observations only; the collector does not assign story-ranking weights. */
export interface SignalObservation {
  platform: "gdelt" | "hn" | "github" | "linkedin" | "instagram" | "x" | "reddit";
  scope: "public_heat" | "owned_performance";
  method: "api" | "browser" | "feed" | "manual";
  confidence: number;
  sampleSize?: number;
  sampleCap?: number;
  metrics: Record<string, number>;
  evidenceLabel: string;
  state: "observed" | "unavailable" | "rate_limited" | "ambiguous" | "not_supported" | "capped";
  query?: string;
  observedAt?: string;
}

export interface SignalsConfig {
  reddit: { enabled: boolean };
  linkedin: { enabled: boolean };
  x: { enabled: boolean };
  /** Per-provider wall-clock budget; a provider that exceeds it is cut off as `unavailable`. */
  providerBudgetMs: number;
  cacheHours: number;
}
const DEFAULTS: SignalsConfig = {
  reddit: { enabled: true },        // feed method — safe everywhere
  linkedin: { enabled: false },     // needs a signed-in external LinkedIn profile
  x: { enabled: false },            // needs a signed-in external X profile
  providerBudgetMs: 150_000,
  cacheHours: 6,
};
export function signalsConfig(): SignalsConfig {
  try { return { ...DEFAULTS, ...loadConfig<Partial<SignalsConfig>>("signals") }; } catch { return DEFAULTS; }
}

const ROOT = new URL("../..", import.meta.url).pathname;
const CACHE_PATH = join(STATE_DIR, "social-heat-cache.json");
type Cache = Record<string, { obs: SignalObservation; at: string }>;
const loadCache = (): Cache => { try { return existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : {}; } catch { return {}; } };
const saveCache = (c: Cache) => { mkdirSync(dirname(CACHE_PATH), { recursive: true }); writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2)); };

const now = () => new Date().toISOString();
const unavailable = (platform: SignalObservation["platform"], method: SignalObservation["method"], why: string, query: string): SignalObservation => ({
  platform, scope: "public_heat", method, confidence: 0, metrics: {},
  evidenceLabel: `no reading (${why})`, state: "unavailable", query, observedAt: now(),
});

/* ── reddit: search RSS ──────────────────────────────────────────────────── */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

async function redditHeat(query: string): Promise<SignalObservation> {
  const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(`"${query}"`)}&sort=new&t=week`;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)(
      "curl", ["-sL", "--max-time", "15", "-A", UA, "-w", "\n%{http_code}", url],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const nl = stdout.lastIndexOf("\n");
    const status = Number(stdout.slice(nl + 1).trim());
    const xml = stdout.slice(0, nl);
    if (status === 429) return { ...unavailable("reddit", "feed", "rate limited", query), state: "rate_limited" };
    if (status !== 200 || !/<feed[\s>]/.test(xml)) return unavailable("reddit", "feed", `HTTP ${status}`, query);
    const entries = xml.match(/<entry>/g)?.length ?? 0;
    const subs = new Set([...xml.matchAll(/<category term="([^"]+)"/g)].map((m) => m[1].trim()).filter((s) => s && s !== "reddit.com"));
    // Sample cap: Reddit's search feed returns at most ~25 entries per page and we read one page.
    return {
      platform: "reddit", scope: "public_heat", method: "feed",
      confidence: entries > 0 ? 0.65 : 0.5, // an observed zero is still an observation, held looser
      sampleSize: entries, sampleCap: 25,
      metrics: { posts: entries, subreddits: subs.size, activity: entries + subs.size * 2 },
      evidenceLabel: `${entries} post${entries === 1 ? "" : "s"} across ${subs.size} subreddit${subs.size === 1 ? "" : "s"} observed in newest week of Reddit search (first page)`,
      state: "observed", query, observedAt: now(),
    };
  } catch (e) {
    return unavailable("reddit", "feed", (e as Error).message.slice(0, 60), query);
  }
}

/* ── linkedin + x: browser samplers ──────────────────────────────────────── */

const LAUNCH_ARGS = ["--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble"];

async function withBrowser<T>(profile: string, budgetMs: number, fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
  const { chromium } = await import("playwright");
  const configured = profile.startsWith("x-")
    ? process.env.AI_CONTENT_X_BROWSER_PROFILE_DIR?.trim()
    : process.env.AI_CONTENT_NEWSLETTER_BROWSER_PROFILE_DIR?.trim();
  const profileDir = profilePath(profile, configured || join(homedir(), ".content-harness", "browser-profiles", profile));
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false, channel: "chrome", viewport: { width: 1380, height: 1000 }, args: LAUNCH_ARGS,
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    return await Promise.race([
      fn(page),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`provider budget ${budgetMs}ms exceeded`)), budgetMs)),
    ]);
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function linkedinHeatBatch(queries: string[], budgetMs: number): Promise<SignalObservation[]> {
  return withBrowser("linkedin-newsletter", budgetMs, async (page) => {
    const out: SignalObservation[] = [];
    for (const query of queries) {
      await page.goto(`https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}`, { waitUntil: "domcontentloaded" });
      // LinkedIn client-redirects AFTER domcontentloaded, which destroyed the evaluate's execution
      // context on the first live run. Wait for the results container itself, not just time.
      await page.waitForTimeout(7_000);
      if (/\/login|\/authwall|\/uas\/login|checkpoint/.test(page.url())) {
        out.push(unavailable("linkedin", "browser", "not logged in / challenge", query));
        continue; // record and move on — never attempt to defeat the wall
      }
      await page.waitForSelector("div[componentkey]", { timeout: 15_000 }).catch(() => {});
      for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 2200); await page.waitForTimeout(1400); }
      const r = await page.evaluate(`(() => {
        const byKey = new Map();
        for (const el of document.querySelectorAll('div[componentkey]')) {
          const raw = el.innerText || "";
          if (!raw.startsWith("Feed post")) continue;
          const key = (el.getAttribute("componentkey") || "").replace(/^expanded/, "").replace(/FeedType_FLAGSHIP_SEARCH$/, "");
          if (!key || byKey.has(key)) continue;
          const ageTok = raw.match(/\\b(\\d+)\\s*(m|h|d|w|mo)\\b/);
          const ageHours = ageTok ? (({ m: 1/60, h: 1, d: 24, w: 168, mo: 720 })[ageTok[2]] || 0) * Number(ageTok[1]) : null;
          const nums = (raw.match(/\\b\\d[\\d,]*\\b/g) || []).map((s) => Number(s.replace(/,/g, "")));
          byKey.set(key, { ageHours, reactions: nums.length ? Math.max(...nums) : 0 });
        }
        const posts = [...byKey.values()];
        return {
          posts: posts.length,
          fresh: posts.filter((p) => p.ageHours !== null && p.ageHours <= 72).length,
          reactions: posts.reduce((a, p) => a + p.reactions, 0),
        };
      })()`) as { posts: number; fresh: number; reactions: number };
      out.push({
        platform: "linkedin", scope: "public_heat", method: "browser",
        confidence: 0.5, sampleSize: r.posts, sampleCap: 75,
        metrics: { posts: r.posts, posts72h: r.fresh, reactions: r.reactions, activity: r.fresh * 3 + Math.log10(r.reactions + 1) * 2 },
        evidenceLabel: `${r.posts} posts (${r.fresh} in 72h, ${r.reactions} visible reactions) observed in first ~75 LinkedIn content-search results`,
        state: "observed", query, observedAt: now(),
      });
    }
    return out;
  });
}

async function xHeatBatch(queries: string[], budgetMs: number): Promise<SignalObservation[]> {
  return withBrowser("x", budgetMs, async (page) => {
    const out: SignalObservation[] = [];
    for (const query of queries) {
      await page.goto(`https://x.com/search?q=${encodeURIComponent(`"${query}"`)}&f=live`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(6_500);
      if (/\/login|\/account\/access|\/i\/flow/.test(page.url())) {
        out.push(unavailable("x", "browser", "not logged in / challenge", query));
        continue;
      }
      for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 2000); await page.waitForTimeout(1300); }
      const r = await page.evaluate(`(() => {
        const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
        let engagement = 0;
        for (const a of arts) {
          // The whole action row carries one aria-label: "N replies, N reposts, N likes, N views".
          const row = a.querySelector('[role="group"][aria-label]');
          const label = row ? row.getAttribute("aria-label") || "" : "";
          for (const m of label.matchAll(/(\\d[\\d,]*)\\s+(repl|repost|like)/gi)) engagement += Number(m[1].replace(/,/g, ""));
        }
        return { posts: arts.length, engagement };
      })()`) as { posts: number; engagement: number };
      if (r.posts === 0 && (await page.locator("text=/Something went wrong|Try again/i").count()) > 0) {
        out.push(unavailable("x", "browser", "search error page", query));
        continue;
      }
      out.push({
        platform: "x", scope: "public_heat", method: "browser",
        confidence: 0.5, sampleSize: r.posts, sampleCap: 20,
        metrics: { posts: r.posts, engagement: r.engagement, activity: r.posts + Math.log10(r.engagement + 1) * 2 },
        evidenceLabel: `${r.posts} posts (${r.engagement} visible reply/repost/like) observed in first screenfuls of X live search`,
        state: "observed", query, observedAt: now(),
      });
    }
    return out;
  });
}

/* ── orchestrator ────────────────────────────────────────────────────────── */

/** One heat observation per platform per query. Cached 6h; failures are recorded per-platform and
 *  never throw — the pipeline continues on whatever was observed. */
export async function collectSocialHeat(queries: string[]): Promise<Map<string, SignalObservation[]>> {
  const cfg = signalsConfig();
  const cache = loadCache();
  const byQuery = new Map<string, SignalObservation[]>(queries.map((q) => [q, []]));
  const fresh = (key: string) => cache[key] && Date.now() - new Date(cache[key].at).getTime() < cfg.cacheHours * 3600_000;
  const put = (q: string, obs: SignalObservation) => {
    byQuery.get(q)!.push(obs);
    if (obs.state === "observed") cache[`${obs.platform}:${q}`] = { obs, at: now() };
  };

  // Reddit: cheap feed fetches, sequential with a polite gap (its RSS rate-limits readily).
  if (cfg.reddit.enabled) {
    for (const q of queries) {
      const key = `reddit:${q}`;
      if (fresh(key)) { byQuery.get(q)!.push(cache[key].obs); continue; }
      put(q, await redditHeat(q));
      await new Promise((r) => setTimeout(r, 8_000));
    }
  }

  // Browser providers: one launch per provider for the whole batch, serial, budgeted.
  for (const [name, enabled, run] of [
    ["linkedin", cfg.linkedin.enabled, linkedinHeatBatch],
    ["x", cfg.x.enabled, xHeatBatch],
  ] as const) {
    if (!enabled) continue;
    const misses = queries.filter((q) => !fresh(`${name}:${q}`));
    for (const q of queries.filter((q) => fresh(`${name}:${q}`))) byQuery.get(q)!.push(cache[`${name}:${q}`].obs);
    if (!misses.length) continue;
    try {
      const obs = await run(misses, cfg.providerBudgetMs);
      obs.forEach((o, i) => put(misses[i], o));
    } catch (e) {
      log(`social: ${name} collection failed (${(e as Error).message.slice(0, 80)}) — recorded unavailable, pipeline continues`);
      for (const q of misses) byQuery.get(q)!.push(unavailable(name, "browser", "provider failed or over budget", q));
    }
  }

  // Instagram: permanently not_supported for public heat — recorded so the audit trail says WHY
  // the platform is absent rather than silently omitting it.
  for (const q of queries) {
    byQuery.get(q)!.push({
      platform: "instagram", scope: "public_heat", method: "api", confidence: 0, metrics: {},
      evidenceLabel: "no public story-search signal exists; Instagram contributes owned-post analytics only",
      state: "not_supported", query: q, observedAt: now(),
    });
  }

  saveCache(cache);
  return byQuery;
}
