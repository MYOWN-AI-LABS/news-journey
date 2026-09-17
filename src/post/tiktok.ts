import { NotSubmittedError } from "./attempt.js";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Script, PostResult, VideoMeta } from "../types.js";
import { tiktokAccess } from "../auth/tiktok.js";
import { fetchWithTimeout, readJson, videoDir, log } from "../util.js";

const API = "https://open.tiktokapis.com/v2";

// The private beta is hard-pinned to private visibility. Public posting is not a release option.
const PRIVACY = "SELF_ONLY";

/** Direct Post via FILE_UPLOAD (init → PUT bytes → poll publish status). */
export async function postTikTok(meta: VideoMeta): Promise<PostResult> {
  let submissionStarted = false;
  try {
  const token = await tiktokAccess();
  const dir = videoDir(meta.id);
  const script = readJson<Script>(join(dir, "script.json"));
  const file = join(dir, "final.mp4");
  const size = statSync(file).size;

  // 1. Init (single-chunk upload — our shorts are well under the 64MB single-chunk cap)
  submissionStarted = true;
  const init = await fetchWithTimeout(`${API}/post/publish/video/init/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      post_info: {
        title: `${script.publish.title} ${script.publish.hashtags.slice(0, 4).join(" ")}`.slice(0, 2200),
        privacy_level: PRIVACY,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 },
    }),
  });
  const initBody = (await init.json()) as { data?: { publish_id: string; upload_url: string }; error?: { code: string; message: string } };
  if (!init.ok || initBody.error?.code !== "ok") throw new Error(`TikTok init ${init.status}: ${initBody.error?.message ?? JSON.stringify(initBody)}`);
  const { publish_id, upload_url } = initBody.data!;

  // 2. Upload the bytes
  const buf = readFileSync(file);
  const up = await fetchWithTimeout(upload_url, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
      "Content-Range": `bytes 0-${size - 1}/${size}`,
    },
    body: buf,
  });
  if (!up.ok) throw new Error(`TikTok upload ${up.status}: ${await up.text()}`);

  // 3. Poll publish status (timeout 5 min)
  const deadline = Date.now() + 300_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000));
    const st = await fetchWithTimeout(`${API}/post/publish/status/fetch/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ publish_id }),
    });
    const s = (await st.json()) as { data?: { status: string; fail_reason?: string; publicaly_available_post_id?: string[] } };
    const status = s.data?.status ?? "UNKNOWN";
    log(`TikTok publish ${publish_id}: ${status}`);
    if (status === "PUBLISH_COMPLETE") {
      const postId = s.data?.publicaly_available_post_id?.[0];
      const note = PRIVACY === "SELF_ONLY" ? "posted SELF_ONLY (app unaudited — visible only to you)" : undefined;
      log(`TikTok posted: ${postId ?? publish_id}${note ? ` — ${note}` : ""}`);
      return {
        platform: "tiktok",
        receiptOrigin: "provider-response",
        id: postId ?? publish_id,
        url: postId ? `https://www.tiktok.com/@_/video/${postId}` : undefined,
        note,
        postedAt: new Date().toISOString(),
      };
    }
    if (status === "FAILED") throw new Error(`TikTok publish failed: ${s.data?.fail_reason ?? "unknown"}`);
    if (Date.now() > deadline) throw new Error("TikTok publish timed out after 5 min");
  }

  } catch (error) { if (!submissionStarted) throw new NotSubmittedError(error); throw error; }
}
