import { NotSubmittedError, submissionFailure } from "./attempt.js";
import { join } from "node:path";
import type { Script, PostResult, VideoMeta } from "../types.js";
import { threadsAccess } from "../auth/threads.js";
import { publicVideoUrl } from "./public-video-url.js";
import { fetchWithTimeout, readJson, videoDir, log } from "../util.js";

const GRAPH = "https://graph.threads.net/v1.0";

/** Container → poll → publish (same shape as the IG Reels flow, Threads endpoints). */
export async function postThreads(meta: VideoMeta): Promise<PostResult> {
  let submissionStarted = false;
  try {
  const { token, userId } = threadsAccess();
  const dir = videoDir(meta.id);
  const script = readJson<Script>(join(dir, "script.json"));

  const videoUrl = await publicVideoUrl(meta);
  const text = `${script.publish.title}\n\n${script.publish.hashtags.slice(0, 5).join(" ")}`.slice(0, 500);

  // 1. Create the media container
  const create = await fetchWithTimeout(`${GRAPH}/${userId}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ media_type: "VIDEO", video_url: videoUrl, text, access_token: token }),
  });
  if (!create.ok) throw new Error(`Threads container create failed with HTTP ${create.status}`);
  const containerId = ((await create.json()) as { id: string }).id;

  // 2. Poll until processed (timeout 5 min)
  const deadline = Date.now() + 300_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000));
    const st = await fetchWithTimeout(`${GRAPH}/${containerId}?fields=status,error_message&access_token=${token}`);
    const status = (await st.json()) as { status: string; error_message?: string };
    log(`Threads container ${containerId}: ${status.status}`);
    if (status.status === "FINISHED") break;
    if (status.status === "ERROR") throw new Error(`Threads processing failed: ${status.error_message ?? "unknown"}`);
    if (Date.now() > deadline) throw new Error("Threads container processing timed out after 5 min");
  }

  // 3. Publish
  submissionStarted = true;
  const pub = await fetchWithTimeout(`${GRAPH}/${userId}/threads_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: containerId, access_token: token }),
  });
  if (!pub.ok) throw submissionFailure(pub.status, new Error(`Threads publish failed with HTTP ${pub.status}`));
  const postId = ((await pub.json()) as { id: string }).id;

  // Resolve the public permalink so the post is linkable in meta.json / metrics like every other
  // platform (publish returns only an id). Best-effort — a missing permalink never fails the post.
  let url: string | undefined;
  try {
    const perma = await fetchWithTimeout(`${GRAPH}/${postId}?fields=permalink&access_token=${token}`);
    if (perma.ok) url = ((await perma.json()) as { permalink?: string }).permalink;
  } catch {
    /* permalink is cosmetic — the post is already live */
  }

  log(`Threads posted: ${url ?? postId}`);
  return { platform: "threads", receiptOrigin: "provider-response", id: postId, url, postedAt: new Date().toISOString() };

  } catch (error) { if (!submissionStarted) throw new NotSubmittedError(error); throw error; }
}
