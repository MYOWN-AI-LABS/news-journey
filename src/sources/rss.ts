import Parser from "rss-parser";
import type { HarvestItem } from "../types.js";
import { sha1, log } from "../util.js";
import { publicResponse, safePublicUrl } from "./public-apis.js";

export interface Feed {
  name: string;
  url: string;
  newsletter?: boolean;
}

const parser = new Parser();

// Some feeds (AJMC) entity-escape their own CDATA markers instead of emitting a real CDATA
// section, so the parser hands back literal "<![CDATA[...]]>" text rather than unwrapping it.
export function stripLiteralCdata(s: string): string {
  const m = s.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return m ? m[1] : s;
}

// Some feeds (FiercePharma/FierceHealthcare) wrap <title> in a nested <a href="..."> instead of
// plain text, so the XML parser hands back a {a: [{_: "...", $: {...}}]} object instead of a
// string. Drill into the first string value found rather than dropping the title entirely.
export function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    if (typeof (v as Record<string, unknown>)._ === "string") return (v as Record<string, string>)._;
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      if (key === "$") continue;
      const t = textOf(Array.isArray(val) ? val[0] : val);
      if (t) return t;
    }
  }
  return "";
}

// Some feeds (FiercePharma/FierceHealthcare) ship pubDate as "MMM D, YYYY h:mma" with no space
// before am/pm, which Date can't parse at all — every item from that feed would otherwise be
// silently dropped as undated rather than merely unusually formatted.
export function parseFeedDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  let d = new Date(raw);
  if (Number.isNaN(d.getTime())) d = new Date(raw.replace(/(\d)(am|pm)\b/i, "$1 $2"));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Older operator files used bare feed URLs; normalize them at the shared intake boundary. */
export function normalizeFeeds(feeds: (Feed | string)[]): Feed[] {
  if (!Array.isArray(feeds)) throw new Error("RSS sources must be a list of feed URLs or {name,url} entries");
  return feeds.map(feed => {
    const value = typeof feed === "string" ? { url: feed, name: new URL(feed).hostname } : feed;
    const url = new URL(safePublicUrl(value?.url, "RSS feed"));
    return { ...value, name: value.name?.trim() || url.hostname, url: url.href };
  });
}
export async function fetchRss(input: (Feed | string)[], windowHours = 72, download: typeof publicResponse = publicResponse): Promise<HarvestItem[]> {
  const feeds = normalizeFeeds(input);
  const cutoff = Date.now() - windowHours * 3600_000;
  const results = await Promise.allSettled(
    feeds.map(async (feed) => {
      // Recheck at every refresh: a previously verified feed can change its DNS or redirect target.
      // rss-parser owns XML parsing only; the shared transport pins public DNS and bounds the body.
      const response = await download(feed.url, { "User-Agent": "Content-Harness/0.2", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }, 15_000, 5_000_000);
      if (!response.ok) throw new Error(`RSS HTTP ${response.status}; redirects are not followed`);
      const parsed = await parser.parseString(await response.text());
      return (parsed.items ?? [])
        .filter((it) => {
          const d = (parseFeedDate(it.isoDate) ?? parseFeedDate(it.pubDate));
          return d ? d.getTime() > cutoff : false;
        })
        .slice(0, 10)
        .map((it): HarvestItem => {
          const publishedDate = (parseFeedDate(it.isoDate) ?? parseFeedDate(it.pubDate));
          const published = publishedDate ? publishedDate.toISOString() : null;
          let url = it.link ?? feed.url;
          // Reddit's RSS <link> points at the DISCUSSION THREAD, not the story — citing that would
          // put reddit.com URLs into a newsletter that promises primary sources. The outbound story
          // URL is in the entry body as the "[link]" anchor; use it, and keep the thread URL only
          // for self-posts (where the thread IS the content).
          if (/reddit\.com/.test(feed.url)) {
            const m = (it.content ?? "").match(/href="(https?:\/\/[^"]+)"\s*>\s*\[link\]/);
            // …but NOT for media posts (i.redd.it / v.redd.it screenshots): an image can't be
            // verified as a source, so the discussion thread is the more honest citation there.
            if (m && !/reddit\.com|redd\.it/.test(m[1])) url = m[1];
          }
          // Score = recency, newest → 100. The old flat 100 (chosen so RSS competes with HN/stars
          // in the top-80 cut) made every item in a feed TIE, so the within-feed percentile fell to
          // feed order — arbitrary, not merit. Since compactItems() ranks each source against
          // itself, only the ORDER within a feed matters here, and freshness is the honest default
          // for a news briefing. Items without a date sink to the window floor rather than winning
          // ties they didn't earn.
          const ageH = publishedDate ? (Date.now() - publishedDate.getTime()) / 3600_000 : windowHours;
          const score = Math.round(100 - 40 * Math.min(1, Math.max(0, ageH / windowHours)));
          return {
            id: sha1(url),
            source: `rss:${feed.name}`,
            origin: (() => { try { return new URL(feed.url).hostname; } catch { return undefined; } })(),
            title: stripLiteralCdata(textOf(it.title) || "(untitled)"),
            url,
            score,
            publishedAt: published,
            repo: null,
            summary: stripLiteralCdata(textOf(it.content ?? it.contentSnippet ?? "")).replace(/<[^>]+>/g, "").slice(0, 500),
          };
        });
    })
  );
  const items: HarvestItem[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else log(`RSS ${feeds[i].name} failed: ${r.reason?.message ?? r.reason}`);
  });
  log(`RSS: ${items.length} recent items from ${feeds.length} feeds`);
  return items;
}
