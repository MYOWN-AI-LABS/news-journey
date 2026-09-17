import { fetchWithTimeout, log } from "../util.js";

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 90_000];

export async function linkedInVideoUrl(ugcPostUrn: string): Promise<string> {
  let lastErr = "";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const wait = RETRY_DELAYS_MS[attempt - 1];
      log(`LinkedIn embed not ready for ${ugcPostUrn} (${lastErr}) — still processing; retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      return await resolveOnce(ugcPostUrn);
    } catch (e) {
      lastErr = (e as Error).message;
      // Only "not ready yet" conditions are worth retrying — a malformed urn or a non-video post
      // will never become resolvable, so failing fast on those keeps the error honest.
      if (!/ embed fetch (404|403|429)|No video sources|Empty video source/.test(lastErr)) throw e;
    }
  }
  throw new Error(`${lastErr} — still not embeddable after ${RETRY_DELAYS_MS.length} retries (~3.3 min)`);
}

async function resolveOnce(ugcPostUrn: string): Promise<string> {
  const res = await fetchWithTimeout(
    `https://www.linkedin.com/embed/feed/update/${encodeURIComponent(ugcPostUrn)}`,
    { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" } }
  );
  if (!res.ok) throw new Error(`LinkedIn embed fetch ${res.status} for ${ugcPostUrn}`);
  const html = await res.text();
  const m = html.match(/data-sources="([^"]+)"/);
  if (!m) throw new Error(`No video sources in LinkedIn embed for ${ugcPostUrn} — post missing or not a video`);
  const sources = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as { src: string; "data-bitrate"?: number }[];
  if (!sources.length) throw new Error(`Empty video source list in LinkedIn embed for ${ugcPostUrn}`);
  const best = sources.sort((a, b) => (b["data-bitrate"] ?? 0) - (a["data-bitrate"] ?? 0))[0];
  log(`LinkedIn-hosted video resolved for ${ugcPostUrn} (${sources.length} renditions, best bitrate ${best["data-bitrate"]})`);
  return best.src;
}
