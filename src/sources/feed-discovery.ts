import { publicResponse, safePublicUrl } from "./public-apis.js";

/**
 * "Sites or feeds you already trust": a person pastes a site address, the harness finds its feed.
 * A feed URL is kept as is; an HTML page is searched for its alternate-feed links, then the common
 * feed paths are tried. Every candidate is fetched through the same bounded public fetch as the
 * public APIs (HTTPS only, no private hosts, no redirects, size and time limits) and must decode as
 * RSS or Atom with at least one item before it is offered.
 */
export interface DiscoveredFeed { input: string; url: string | null; title: string | null; items: number; reason: string | null }
export type FeedFetcher = (url: string) => Promise<string>;

const HEADERS = { Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5", "User-Agent": "Content-Harness/0.3 feed discovery" };
const COMMON_PATHS = ["/feed/", "/feed", "/rss/", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml"];
export const MAX_TRUSTED_SOURCES = 5;

export const defaultFeedFetcher: FeedFetcher = async url => (await publicResponse(url, HEADERS, 15000, 2_000_000)).text();

export function feedShape(text: string): { isFeed: boolean; items: number; title: string | null } {
  const head = text.slice(0, 4000);
  const isFeed = /<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(head) && !/<html[\s>]/i.test(head.slice(0, 600));
  const items = isFeed ? (text.match(/<item[\s>]|<entry[\s>]/gi) || []).length : 0;
  const title = isFeed ? (text.match(/<title[^>]*>(?:<!\[CDATA\[)?([^<\]]{1,120})/i)?.[1]?.trim() ?? null) : null;
  return { isFeed, items, title };
}

/**
 * Feed links an HTML page offers, as absolute HTTPS URLs: declared alternate links first, then same-site links whose path
 * reads as a feed (Route Fifty links "/rss/all/" from its footer and declares no alternate link).
 */
export function feedLinksIn(html: string, base: string): string[] {
  const links: string[] = [], anchors: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
    const rel = attr("rel")?.toLowerCase() || "", type = attr("type")?.toLowerCase() || "", href = attr("href");
    if (!href || !/\balternate\b/.test(rel) || !/(rss|atom)\+xml/.test(type)) continue;
    try { links.push(safePublicUrl(href, "Feed link", base)); } catch { /* non-https or private: skip */ }
  }
  const origin = new URL(base).origin;
  for (const [, href] of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    try { const url = safePublicUrl(href, "Feed link", base); if (new URL(url).origin === origin && /\/(rss|feeds?|atom)(\/|\.xml|\.rss|$)|\.(rss|atom)$|\/[\w-]*rss[\w-]*\.xml$/i.test(new URL(url).pathname)) anchors.push(url); } catch { /* skip */ }
  }
  return [...new Set([...links, ...anchors])];
}

/** A reason the person can act on; transport wording ("Public API HTTP 403; redirects are not followed") never reaches them. */
export function plainFeedReason(error: unknown): string {
  const message = String((error as Error)?.message ?? error), status = message.match(/HTTP (\d{3})/)?.[1];
  if (status?.startsWith("3")) return `The address redirects to another page (HTTP ${status}). Open it in your browser and paste the address it lands on, or the feed address itself.`;
  if (status && ["401", "403", "429"].includes(status)) return `The site refused automated reading (HTTP ${status}). Paste its feed address if it publishes one.`;
  if (status) return `The site answered with an error (HTTP ${status}).`;
  if ((error as Error)?.name === "TimeoutError" || /aborted|timed? ?out/i.test(message)) return "The site did not answer within 15 seconds.";
  if (/ENOTFOUND|EAI_AGAIN/.test(message) || (error as { code?: string })?.code === "ENOTFOUND") return "No site was found at this address.";
  if (/private or local/.test(message)) return "This address points to a private or local network, which the harness never reads. Paste the site's public address.";
  return message;
}

export async function discoverFeeds(inputs: string[], fetcher: FeedFetcher = defaultFeedFetcher): Promise<DiscoveredFeed[]> {
  const results: DiscoveredFeed[] = [];
  for (const input of inputs.slice(0, MAX_TRUSTED_SOURCES)) {
    let url: string;
    // "HUD Newsroom" is a name, not an address; the harness never guesses a URL for it.
    if (/\s/.test(input) || !/[.:]/.test(input)) { results.push({ input, url: null, title: null, items: 0, reason: `This looks like a name. Paste the site's web address instead, for example https://www.example.gov/news.` }); continue; }
    try { url = safePublicUrl(/^https?:\/\//i.test(input) ? input : "https://" + input, "Trusted source"); }
    catch (error) { results.push({ input, url: null, title: null, items: 0, reason: (error as Error).message }); continue; }
    try {
      const text = await fetcher(url);
      const shape = feedShape(text);
      if (shape.isFeed && shape.items > 0) { results.push({ input, url, title: shape.title, items: shape.items, reason: null }); continue; }
      if (shape.isFeed) { results.push({ input, url: null, title: shape.title, items: 0, reason: "The feed has no items right now. Paste a feed that is publishing, or try again later." }); continue; } // an empty feed is not offered
      const origin = new URL(url).origin;
      const candidates = [...feedLinksIn(text, url), ...COMMON_PATHS.map(p => origin + p)].filter((c, i, all) => all.indexOf(c) === i).slice(0, 8);
      let found: DiscoveredFeed | null = null;
      for (const candidate of candidates) {
        try { const s = feedShape(await fetcher(candidate)); if (s.isFeed && s.items > 0) { found = { input, url: candidate, title: s.title, items: s.items, reason: null }; break; } }
        catch { /* try the next candidate */ }
      }
      results.push(found ?? { input, url: null, title: null, items: 0, reason: "No feed was found on this site. Paste the feed address itself if the site publishes one." });
    } catch (error) { results.push({ input, url: null, title: null, items: 0, reason: plainFeedReason(error) }); }
  }
  return results;
}
