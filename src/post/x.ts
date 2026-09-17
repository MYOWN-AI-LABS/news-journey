import { NotSubmittedError, submissionFailure } from "./attempt.js";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Script, PostResult, VideoMeta } from "../types.js";
import { xAccess } from "../auth/x.js";
import { fetchWithTimeout, readJson, videoDir, log } from "../util.js";

const API = "https://api.x.com/2";
const CHUNK = 4 * 1024 * 1024; // 4MB append segments

/** Chunked v2 media upload (initialize → append → finalize → poll), then POST /2/tweets. */
export async function postX(meta: VideoMeta): Promise<PostResult> {
  let submissionStarted = false;
  try {
  const token = await xAccess();
  const dir = videoDir(meta.id);
  const script = readJson<Script>(join(dir, "script.json"));
  const file = join(dir, "final.mp4");
  const totalBytes = statSync(file).size;
  const auth = { Authorization: `Bearer ${token}` };

  // 1. Initialize
  const init = await fetchWithTimeout(`${API}/media/upload/initialize`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ media_type: "video/mp4", total_bytes: totalBytes, media_category: "tweet_video" }),
  });
  if (!init.ok) throw new Error(`X media init ${init.status}: ${await init.text()}`);
  const mediaId = ((await init.json()) as { data: { id: string } }).data.id;

  // 2. Append chunks
  const buf = readFileSync(file);
  for (let i = 0, seg = 0; i < totalBytes; i += CHUNK, seg++) {
    const form = new FormData();
    form.set("segment_index", String(seg));
    form.set("media", new Blob([buf.subarray(i, Math.min(i + CHUNK, totalBytes))]));
    const app = await fetchWithTimeout(`${API}/media/upload/${mediaId}/append`, { method: "POST", headers: auth, body: form });
    if (!app.ok) throw new Error(`X media append seg ${seg} ${app.status}: ${await app.text()}`);
  }

  // 3. Finalize + poll processing
  const fin = await fetchWithTimeout(`${API}/media/upload/${mediaId}/finalize`, { method: "POST", headers: auth });
  if (!fin.ok) throw new Error(`X media finalize ${fin.status}: ${await fin.text()}`);
  const deadline = Date.now() + 300_000;
  for (;;) {
    const st = await fetchWithTimeout(`${API}/media/upload?media_id=${mediaId}&command=STATUS`, { headers: auth });
    const info = ((await st.json()) as { data?: { processing_info?: { state: string; check_after_secs?: number; error?: { message?: string } } } }).data;
    const p = info?.processing_info;
    if (!p || p.state === "succeeded") break;
    if (p.state === "failed") throw new Error(`X media processing failed: ${p.error?.message ?? "unknown"}`);
    if (Date.now() > deadline) throw new Error("X media processing timed out after 5 min");
    await new Promise((r) => setTimeout(r, (p.check_after_secs ?? 5) * 1000));
  }

  // 4. Tweet (280-char budget: title + shortened hashtag set)
  const text = `${script.publish.title}\n\n${script.publish.hashtags.slice(0, 4).join(" ")}`.slice(0, 280);
  submissionStarted = true;
  const tw = await fetchWithTimeout(`${API}/tweets`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ text, media: { media_ids: [mediaId] } }),
  });
  if (!tw.ok) { const error = new Error(`X tweet create ${tw.status}: ${await tw.text()}`); throw submissionFailure(tw.status, error); }
  const tweetId = ((await tw.json()) as { data: { id: string } }).data.id;

  log(`X posted: ${tweetId}`);
  return {
    platform: "x",
    receiptOrigin: "provider-response",
    id: tweetId,
    url: `https://x.com/i/status/${tweetId}`,
    postedAt: new Date().toISOString(),
  };

  } catch (error) { if (!submissionStarted) throw new NotSubmittedError(error); throw error; }
}
