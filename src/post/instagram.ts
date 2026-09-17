import { NotSubmittedError, submissionFailure } from "./attempt.js";
import { join } from "node:path";
import type { Script, PostResult, VideoMeta } from "../types.js";
import { instagramAccess } from "../auth/instagram.js";
import { publicVideoUrl } from "./public-video-url.js";
import { fetchWithTimeout, readJson, videoDir, log } from "../util.js";

// Instagram API with Instagram Login uses graph.instagram.com (not graph.facebook.com);
// the same /media → poll → /media_publish Reels flow, keyed on the /me app-scoped id.
const GRAPH = "https://graph.instagram.com/v23.0";

export async function postInstagram(meta: VideoMeta): Promise<PostResult> {
  let submissionStarted = false;
  try {
  const { token, igUserId } = await instagramAccess();
  const dir = videoDir(meta.id);
  const script = readJson<Script>(join(dir, "script.json"));

  // Resolve a prior LinkedIn video receipt or the explicitly configured public URL template.
  const videoUrl = await publicVideoUrl(meta);
  const caption = `${script.publish.description}\n\n${script.publish.hashtags.join(" ")}`.slice(0, 2200);

  // 1. Create the media container
  const create = await fetchWithTimeout(`${GRAPH}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      media_type: "REELS",
      video_url: videoUrl,
      caption,
      share_to_feed: "true",
      access_token: token,
    }),
  });
  if (!create.ok) throw new Error(`IG media create failed with HTTP ${create.status}`);
  const containerId = ((await create.json()) as { id: string }).id;

  // 2. Poll the container until Instagram finishes fetching/processing (timeout 5 min)
  const deadline = Date.now() + 300_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000));
    const st = await fetchWithTimeout(
      `${GRAPH}/${containerId}?fields=status_code,status&access_token=${token}`
    );
    const status = (await st.json()) as { status_code: string; status?: string };
    log(`IG container ${containerId}: ${status.status_code}`);
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR") throw new Error(`IG processing failed: ${status.status ?? "unknown"}`);
    if (Date.now() > deadline) throw new Error("IG container processing timed out after 5 min");
  }

  // 3. Publish
  submissionStarted = true;
  const pub = await fetchWithTimeout(`${GRAPH}/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: containerId, access_token: token }),
  });
  if (!pub.ok) throw submissionFailure(pub.status, new Error(`IG media_publish failed with HTTP ${pub.status}`));
  const mediaId = ((await pub.json()) as { id: string }).id;

  // media_publish returns a numeric media id, and `/reel/<media-id>/` is NOT a working share link
  // — it returns HTTP 200 (so it looks fine in any status check) but does not open the reel for a
  // human. The real permalink uses a shortcode and only comes back from a follow-up Graph read.
  // Fall back to the constructed form if that read fails: a suboptimal URL beats losing the record
  // of a reel we just published.
  let url = `https://www.instagram.com/reel/${mediaId}/`;
  try {
    const info = await fetchWithTimeout(`${GRAPH}/${mediaId}?fields=permalink&access_token=${token}`);
    if (info.ok) {
      const { permalink } = (await info.json()) as { permalink?: string };
      if (permalink) url = permalink;
      else log(`Instagram: no permalink field for ${mediaId} — storing constructed URL`);
    } else {
      log(`Instagram: permalink lookup ${info.status} for ${mediaId} — storing constructed URL`);
    }
  } catch (e) {
    log(`Instagram: permalink lookup failed (${(e as Error).message}) — storing constructed URL`);
  }
  log(`Instagram posted: ${url}`);
  return { platform: "instagram", receiptOrigin: "provider-response", id: mediaId, url, postedAt: new Date().toISOString() };

  } catch (error) { if (!submissionStarted) throw new NotSubmittedError(error); throw error; }
}
