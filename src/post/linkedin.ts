import { NotSubmittedError, submissionFailure } from "./attempt.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Script, PostResult, VideoMeta } from "../types.js";
import { linkedinAccess } from "../auth/linkedin.js";
import { newsletterLiveStatus } from "../pipeline/newsletter-live.js";
import { fetchWithTimeout, loadConfig, readJson, todayStamp, videoDir, log } from "../util.js";

const API = "https://api.linkedin.com/v2";

/** Legacy assets + ugcPosts flow — the one available on the self-serve "Share on LinkedIn" product. */
export async function postLinkedIn(meta: VideoMeta): Promise<PostResult> {
  let submissionStarted = false;
  try {
  const { token, personUrn } = linkedinAccess();
  const dir = videoDir(meta.id);
  const script = readJson<Script>(join(dir, "script.json"));
  const videoBuf = readFileSync(join(dir, "final.mp4"));

  // 1. Register the upload
  const reg = await fetchWithTimeout(`${API}/assets?action=registerUpload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Restli-Protocol-Version": "2.0.0" },
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: ["urn:li:digitalmediaRecipe:feedshare-video"],
        owner: personUrn,
        serviceRelationships: [{ relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" }],
      },
    }),
  });
  if (!reg.ok) throw new Error(`LinkedIn registerUpload ${reg.status}: ${await reg.text()}`);
  const regData = (await reg.json()) as {
    value: {
      asset: string;
      uploadMechanism: Record<string, { uploadUrl: string }>;
    };
  };
  const uploadUrl = Object.values(regData.value.uploadMechanism)[0].uploadUrl;
  const asset = regData.value.asset;

  // 2. Upload the binary
  const up = await fetchWithTimeout(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: videoBuf,
  }, 180_000);
  if (!up.ok && up.status !== 201) throw new Error(`LinkedIn binary upload ${up.status}`);

  // 3. Create the post — RULE: the video links to TODAY'S SPECIFIC issue permalink, not the
  // generic series URL (which shows the previous issue until the new one is live → stale link).
  // The script bakes in the series URL at produce time; swap it for the resolved /pulse/ permalink
  // now that the issue is published (the coordination gate already guaranteed it's live). If it
  // can't be resolved for any reason, the series URL stays as a safe fallback.
  let postBody = script.publish.linkedinPost;
  const seriesUrl = loadConfig<{ newsletterUrl?: string }>("pipeline").newsletterUrl;
  if (seriesUrl) {
    // Key on the video's content day and use only the permalink returned by exact live verification.
    const vday = /^\d{8}/.test(meta.id) ? `${meta.id.slice(0, 4)}-${meta.id.slice(4, 6)}-${meta.id.slice(6, 8)}` : todayStamp();
    const issueUrl = (await newsletterLiveStatus(vday, meta.edition)).issueUrl;
    if (issueUrl) {
      postBody = postBody.split(seriesUrl).join(issueUrl);
      log(`live verification passed - linking to this issue's permalink: ${issueUrl}`);
    } else {
      const { notify } = await import("../review/notify.js");
      notify("LinkedIn post blocked - no verified issue", `${meta.id}: publish and verify the exact issue before posting.`);
      throw new Error(`REFUSING to post ${meta.id}: no exact live issue match. Publish the newsletter, then run npm run post.`);
    }
  }
  const text = `${postBody}\n\n${script.publish.hashtags.join(" ")}`;
  submissionStarted = true;
  const post = await fetchWithTimeout(`${API}/ugcPosts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Restli-Protocol-Version": "2.0.0" },
    body: JSON.stringify({
      author: personUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: "VIDEO",
          media: [{ status: "READY", media: asset, title: { text: script.publish.title } }],
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    }),
  });
  if (!post.ok) throw submissionFailure(post.status, new Error(`LinkedIn ugcPosts ${post.status}: ${await post.text()}`));
  const postId = post.headers.get("x-restli-id") ?? ((await post.json()) as { id: string }).id;

  log(`LinkedIn posted: ${postId}`);
  return { platform: "linkedin", receiptOrigin: "provider-response", id: postId, url: `https://www.linkedin.com/feed/update/${postId}`, postedAt: new Date().toISOString() };

  } catch (error) { if (!submissionStarted) throw new NotSubmittedError(error); throw error; }
}
