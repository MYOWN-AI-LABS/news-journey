import { load } from "cheerio";
import type { MetricValues } from "./model.js";

/** Only a payload carrying the exact provider ID/shortcode can supply post metrics. */
export function parsePublicMetrics(html: string, platform: "threads" | "tiktok", id: string): MetricValues | null {
  const $ = load(html);
  const roots: unknown[] = [];
  $("script[type='application/json'], script#__UNIVERSAL_DATA_FOR_REHYDRATION__, script#SIGI_STATE").each((_i, el) => { try { roots.push(JSON.parse($(el).text())); } catch { /* non-JSON script */ } });
  const stack = [...roots]; let visited = 0;
  // ponytail: bounded traversal of provider JSON; switch to a named schema when it stabilizes.
  while (stack.length && visited++ < 100000) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) { stack.push(...node); continue; }
    const row = node as Record<string, unknown>;
    const matches = [row.id, row.code, row.pk, row.shortcode].some((value) => String(value ?? "") === id);
    if (matches) {
      const values = (platform === "tiktok" ? row.stats ?? row.statsV2 : row) as Record<string, unknown> | undefined;
      const aliases: Record<string, keyof MetricValues> = platform === "tiktok"
        ? { playCount: "views", diggCount: "likes", commentCount: "comments", shareCount: "shares", collectCount: "saves" }
        : { view_count: "views", like_count: "likes", reply_count: "comments", repost_count: "reposts", quote_count: "quotes", reshare_count: "shares" };
      const metrics: MetricValues = {};
      for (const [key, metric] of Object.entries(aliases)) {
        const raw = values?.[key];
        if ((typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw))) && Number.isFinite(Number(raw)) && Number(raw) >= 0) metrics[metric] = Number(raw);
      }
      if (Object.keys(metrics).length) return metrics;
    }
    stack.push(...Object.values(row));
  }
  return null;
}
export async function publicMetrics(platform: "threads" | "tiktok", id: string, url: string | null): Promise<{ metrics: MetricValues | null; note: string }> {
  if (!url) return { metrics: null, note: "No exact post URL recorded" };
  const parsed = new URL(url);
  const hosts = platform === "threads" ? ["threads.com", "threads.net"] : ["tiktok.com"];
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !hosts.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) return { metrics: null, note: "Invalid post URL" };
  try {
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }, signal: AbortSignal.timeout(20000), redirect: "error" });
    if (!response.ok) return { metrics: null, note: `Exact-post page returned HTTP ${response.status}` };
    const html = await response.text();
    if (html.length > 8_000_000) return { metrics: null, note: "Provider page exceeded the collection limit" };
    const metrics = parsePublicMetrics(html, platform, id);
    return { metrics, note: metrics ? "Public post counters; private impressions and audience reach are not included" : "Exact-post page exposes no matching counters; owner analytics access remains unavailable" };
  } catch (e) { return { metrics: null, note: (e as Error).message.slice(0, 250) }; }
}
