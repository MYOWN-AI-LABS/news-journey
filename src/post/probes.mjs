import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Deliberately SHORT — no "(KHTML, like Gecko) Chrome/xxx Safari/xxx" token. Meta properties
// (Instagram embeds, Threads permalinks) serve a JS app shell to anything that looks like a real
// Chrome, and that shell renders identically for a real post and a fabricated id — so a
// browser-realistic UA silently destroys this script's ability to tell live from deleted. Every
// probe below was control-tested against a fabricated id under THIS UA. Do not "modernize" it.
export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const LIVE = "live", DEAD = "dead", UNVERIFIABLE = "unverifiable";

export async function get(url, { headers = {}, timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, ...headers }, redirect: "follow", signal: ctl.signal });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { status: 0, body: "", error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(t);
  }
}

/** Instagram branches its embed response on User-Agent, and the difference decides whether this
 *  check works at all:
 *    short UA (no "Chrome/..." token) -> 134KB lightweight embed WITH the media payload
 *    full Chrome UA                   -> 602KB JS app shell, byte-identical for a real and a
 *                                        fabricated shortcode (zero discriminating power)
 *  IG assumes a real Chrome will run the JS and hydrate, so it ships the shell. Sending the
 *  browser-realistic UA here reports every healthy reel as deleted. Keep this UA short. */
export const IG_EMBED_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
/** LinkedIn is the mirror image of Meta: its public post page only carries the real post id when
 *  the request looks like a genuine Chrome. Under the short UA it serves a fallback that echoes
 *  the id from the URL, so fabricated posts verify as live. */
export const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
export function curlGet(url, ua = UA, timeout = 25) {
  try {
    return execFileSync("curl", ["-sL", "-m", String(timeout), "-A", ua, url],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch { return ""; }
}

export function createProbes(ROOT, options = {}) {
const request = options.get || get;
const curl = options.curlGet || curlGet;
function token(name) {
  const p = join(ROOT, "state/tokens", `${name}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// A probe returns {state, detail}. Control results (real vs fabricated ID) are noted per-probe so
// the next person can re-derive whether the check still discriminates.
const PROBES = {
  // control: real shorts id -> 200, "aaaaaaaaaaa" -> 400
  async youtube(post) {
    const r = await request(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(post.url)}`);
    if (r.status === 200) return { state: LIVE, detail: "oembed 200" };
    if (r.status === 400 || r.status === 401 || r.status === 404)
      return { state: DEAD, detail: `oembed ${r.status} — private, deleted, or never published` };
    return { state: UNVERIFIABLE, detail: `oembed ${r.status}${r.error ? ` (${r.error})` : ""}` };
  },

  // control: real video id -> 200, fabricated -> 400. Also the ONLY cheap way to catch a video
  // that published as "Only me", which is TikTok's silent default for unaudited API clients.
  async tiktok(post) {
    const r = await request(`https://www.tiktok.com/oembed?url=${encodeURIComponent(post.url)}`);
    if (r.status === 200) return { state: LIVE, detail: "oembed 200 (public)" };
    if (r.status === 400 || r.status === 404)
      return { state: DEAD, detail: `oembed ${r.status} — private ("Only me"), under review, or removed` };
    return { state: UNVERIFIABLE, detail: `oembed ${r.status}${r.error ? ` (${r.error})` : ""}` };
  },

  // control: real status -> 200, fabricated -> 404
  async x(post) {
    const r = await request(`https://publish.twitter.com/oembed?omit_script=true&url=${encodeURIComponent(post.url)}`);
    if (r.status === 200) {
      let body; try { body = JSON.parse(r.body); } catch { /* inconclusive */ }
      if (body?.author_url && typeof body.html === "string" && new RegExp(`/status/${post.id}(?:[?"\\s/<]|$)`).test(body.html)) return { state: LIVE, detail: "provider embed contains exact post and author" };
      return { state: UNVERIFIABLE, detail: "embed response has no exact post payload" };
    }
    if (r.status === 404) return { state: DEAD, detail: "404 — deleted or never posted" };
    return { state: UNVERIFIABLE, detail: `${r.status}${r.error ? ` (${r.error})` : ""}` };
  },

  // Two eras of records, two probes. Posts made through the Graph API stored a NUMERIC media id;
  // posts made earlier via browser automation stored a SHORTCODE. Graph cannot resolve a shortcode
  // — it 400s exactly like a deleted media, so routing everything through Graph reports a dozen
  // perfectly healthy reels as dead. Discriminate on id shape first.
  async instagram(post) {
    if (!/^\d+$/.test(String(post.id))) {
      // control: real shortcode embed carries the owner handle + display_url; fabricated carries
      // neither (both 200, and both echo the shortcode back, so neither status nor the shortcode
      // itself is evidence).
      const handle = post.url.match(/instagram\.com\/([^/]+)\/reel/)?.[1];
      const body = curl(`https://www.instagram.com/reel/${post.id}/embed/captioned/`, IG_EMBED_UA);
      if (!body) return { state: UNVERIFIABLE, detail: "embed fetch failed (curl)" };
      const hit = (handle && body.includes(handle)) || body.includes("display_url");
      return hit
        ? { state: LIVE, detail: "embed carries owner/media payload" }
        : { state: DEAD, detail: "embed has no media payload — deleted or never published" };
    }
    const t = token("instagram");
    const tok = t?.access_token || t?.token || t?.accessToken;
    if (!tok) return { state: UNVERIFIABLE, detail: "no instagram token on disk" };
    const r = await request(`https://graph.instagram.com/${post.id}?fields=id,permalink,media_type&access_token=${tok}`);
    if (r.status === 200) {
      let permalink;
      try { permalink = JSON.parse(r.body).permalink; } catch { /* keep going — liveness already proven */ }
      // The ledger stores /reel/<media-id>/, which is NOT a working share link. Surface the real
      // shortcode permalink so the dashboard can link somewhere a human can actually open.
      const mismatch = permalink && !post.url.includes(permalink.split("/reel/")[1]?.replace("/", ""));
      return { state: LIVE, detail: mismatch ? `live — real permalink ${permalink}` : "live", permalink };
    }
    if (r.status === 400) return { state: DEAD, detail: "graph 400 — media id does not exist" };
    return { state: UNVERIFIABLE, detail: `graph ${r.status}${r.error ? ` (${r.error})` : ""}` };
  },

  // reddit.com/*.json, old.reddit and api.reddit are all 403 to non-browser clients; embed.reddit
  // answers. Matching on the post id does NOT work — the error shell reflects the id straight back
  // from the URL, so a fabricated id "passes". Match on words from the post's own title slug
  // instead: control gives 15 hits for the real post and 0 for a fabricated one.
  async reddit(post) {
    const sub = post.url.match(/\/r\/([^/]+)\//)?.[1] || "test";
    const slug = post.url.match(/\/comments\/[^/]+\/([^/]+)/)?.[1] || "";
    const words = [...new Set(slug.split("_").filter((w) => w.length >= 6))].slice(0, 4);
    const r = await request(`https://embed.reddit.com/r/${sub}/comments/${post.id}/`);
    if (r.status !== 200) return { state: UNVERIFIABLE, detail: `embed ${r.status}${r.error ? ` (${r.error})` : ""}` };
    if (!words.length) return { state: UNVERIFIABLE, detail: "no title slug in URL to match against" };
    const hits = words.filter((w) => r.body.toLowerCase().includes(w.toLowerCase()));
    return hits.length
      ? { state: LIVE, detail: `embed carries post title (${hits.length}/${words.length} slug words)` }
      : { state: DEAD, detail: "embed has no post content — removed or never created" };
  },

  // control: real post -> canonical "post/<id>" appears in HTML; fabricated -> absent (both 200,
  // so status is useless here).
  async threads(post) {
    const r = await request(post.url);
    if (r.status === 200 && r.body.includes(`post/${post.id}`)) return { state: LIVE, detail: "canonical post id present" };
    if (r.status === 200) return { state: DEAD, detail: "200 but canonical post id absent — post does not exist" };
    return { state: UNVERIFIABLE, detail: `${r.status}${r.error ? ` (${r.error})` : ""}` };
  },

  // NO WORKING READ PATH — reports unverifiable by design, not by oversight. Everything tried:
  //   GET /v2/ugcPosts     403 for real AND fabricated (token is w_member_social — write only)
  //   GET /rest/posts      426, GET /v2/shares + /v2/socialActions  403 (same scope wall)
  //   public /feed/update/ login-walled; its fallback page echoes the post id straight out of the
  //                        URL, so a FABRICATED post verifies as "live" — control-tested, fails.
  // A probe that passes made-up ids is worse than no probe: it manufactures confidence. To make
  // LinkedIn verifiable, either add the r_member_social scope (requires LinkedIn partner review)
  // or check it through the logged-in browser profile — see docs/platform-automation-status.md.
  // NOTE: this does not mean LinkedIn POSTING is broken; writes work fine and are the one path
  // with a working delete (see retractWhatWeCan in publish-qc.ts).
  async linkedin() {
    return { state: UNVERIFIABLE, detail: "no read scope + login-walled public page (see comment)" };
  },
};

return PROBES;
}
