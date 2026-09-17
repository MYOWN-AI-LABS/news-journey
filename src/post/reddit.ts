import { NotSubmittedError, submissionFailure } from "./attempt.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Script, PostResult, VideoMeta } from "../types.js";
import { redditAccess, REDDIT_USER_AGENT } from "../auth/reddit.js";
import { fetchWithTimeout, readJson, videoDir, log } from "../util.js";

const API = "https://oauth.reddit.com";
const SUBREDDIT = process.env.REDDIT_SUBREDDIT || "test";

interface AssetLease {
  args: { action: string; fields: { name: string; value: string }[] };
  asset: { asset_id: string; websocket_url: string };
}

/** Request an S3 upload lease for one asset, then upload the bytes directly to S3.
 *  Returns the final public asset URL (https, matches Reddit's own scheme). */
async function uploadAsset(token: string, filepath: string, mimetype: string, bytes: Buffer): Promise<{ url: string; websocketUrl: string }> {
  const lease = await fetchWithTimeout(`${API}/api/media/asset.json`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": REDDIT_USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ filepath, mimetype }),
  });
  if (!lease.ok) throw new Error(`Reddit asset lease ${lease.status}: ${await lease.text()}`);
  const { args, asset } = (await lease.json()) as AssetLease;

  const form = new FormData();
  for (const f of args.fields) form.set(f.name, f.value);
  form.set("file", new Blob([new Uint8Array(bytes)]), filepath);
  // Reddit's lease action URL is protocol-relative ("//reddit-uploaded-media.s3-accelerate...").
  const uploadUrl = args.action.startsWith("//") ? `https:${args.action}` : args.action;
  const up = await fetchWithTimeout(uploadUrl, { method: "POST", body: form });
  if (!up.ok) throw new Error(`Reddit S3 upload ${up.status}: ${await up.text()}`);

  const key = args.fields.find((f) => f.name === "key")?.value;
  if (!key) throw new Error("Reddit asset lease missing S3 key");
  return { url: `${uploadUrl}/${key}`, websocketUrl: asset.websocket_url };
}

/** Wait for Reddit's processing websocket to confirm the post went live, returning its permalink. */
function waitForSubmitSuccess(websocketUrl: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(websocketUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Reddit submit websocket timed out after " + timeoutMs / 1000 + "s"));
    }, timeoutMs);
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string; payload?: { redirect?: string; failedReason?: string } };
        if (msg.type === "success" && msg.payload?.redirect) {
          clearTimeout(timer);
          ws.close();
          resolve(msg.payload.redirect);
        } else if (msg.type === "failed") {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`Reddit submit failed: ${msg.payload?.failedReason ?? "unknown"}`));
        }
      } catch {
        /* non-JSON keepalive frame — ignore */
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Reddit submit websocket error"));
    });
  });
}

/** Upload video and poster assets, submit to the explicitly configured subreddit, and wait for processing. */
export async function postReddit(meta: VideoMeta): Promise<PostResult> {
  let submissionStarted = false;
  try {
  const token = await redditAccess();
  const dir = videoDir(meta.id);
  const script = readJson<Script>(join(dir, "script.json"));
  const videoBytes = readFileSync(join(dir, "final.mp4"));

  // Prefer an existing poster/cover asset from this video's own assets; og-0.png is the pipeline's
  // standard first-story image and exists for every produced video.
  let posterBytes: Buffer;
  try {
    posterBytes = readFileSync(join(dir, "assets", "og-0.png"));
  } catch {
    throw new Error(`Reddit post needs a poster image but ${dir}/assets/og-0.png is missing`);
  }

  log("Reddit: uploading poster image…");
  const poster = await uploadAsset(token, "poster.png", "image/png", posterBytes);
  log("Reddit: uploading video…");
  const video = await uploadAsset(token, "final.mp4", "video/mp4", videoBytes);

  const title = script.publish.title.slice(0, 300);
  submissionStarted = true;
  const submit = await fetchWithTimeout(`${API}/api/submit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": REDDIT_USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      sr: SUBREDDIT,
      kind: "video",
      title,
      url: video.url,
      video_poster_url: poster.url,
      api_type: "json",
      resubmit: "true",
      sendreplies: "true",
      nsfw: "false",
      spoiler: "false",
    }),
  });
  if (!submit.ok) throw submissionFailure(submit.status, new Error(`Reddit submit ${submit.status}: ${await submit.text()}`));
  const submitBody = (await submit.json()) as { json?: { errors?: [string, string][]; data?: { websocket_url?: string } } };
  if (submitBody.json?.errors?.length) throw new Error(`Reddit submit rejected: ${JSON.stringify(submitBody.json.errors)}`);

  // The submit response can carry its own websocket_url; fall back to the video upload's.
  const wsUrl = submitBody.json?.data?.websocket_url ?? video.websocketUrl;
  log("Reddit: waiting for post processing to complete…");
  const permalink = await waitForSubmitSuccess(wsUrl);
  const fullUrl = permalink.startsWith("http") ? permalink : `https://www.reddit.com${permalink}`;
  const id = fullUrl.match(/comments\/([a-z0-9]+)\//)?.[1] ?? fullUrl;

  log(`Reddit posted: ${fullUrl}`);
  return { platform: "reddit", receiptOrigin: "provider-response", id, url: fullUrl, postedAt: new Date().toISOString() };

  } catch (error) { if (!submissionStarted) throw new NotSubmittedError(error); throw error; }
}
