import { NotSubmittedError } from "./attempt.js";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { google } from "googleapis";
import type { Script, PostResult, VideoMeta } from "../types.js";
import { googleClient } from "../auth/google.js";
import { readJson, videoDir, log } from "../util.js";

export async function postYouTube(meta: VideoMeta): Promise<PostResult> {
  let submissionStarted = false;
  try {
  const auth = googleClient();
  const yt = google.youtube({ version: "v3", auth });
  const dir = videoDir(meta.id);
  const script = readJson<Script>(join(dir, "script.json"));

  const title = script.publish.title.includes("#Shorts")
    ? script.publish.title
    : `${script.publish.title} #Shorts`.slice(0, 100);

  submissionStarted = true;
  const res = await yt.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title,
        description: `${script.publish.description}\n\n${script.publish.hashtags.join(" ")}`,
        categoryId: "28", // Science & Technology
        tags: script.publish.hashtags.map((h) => h.replace("#", "")),
      },
      status: {
        privacyStatus: (["private", "unlisted", "public"].includes(process.env.YOUTUBE_PRIVACY_STATUS ?? "private")
          ? process.env.YOUTUBE_PRIVACY_STATUS
          : "private") as "private" | "unlisted" | "public",
        selfDeclaredMadeForKids: false,
      },
    },
    media: { body: createReadStream(join(dir, "final.mp4")) },
  });

  const videoId = res.data.id!;
  const actualPrivacy = res.data.status?.privacyStatus;
  const note =
    actualPrivacy !== "public"
      ? `uploaded (${actualPrivacy} — API project audit likely pending)`
      : undefined;
  log(`YouTube uploaded: ${videoId}${note ? ` — ${note}` : ""}`);
  return {
    platform: "youtube",
    receiptOrigin: "provider-response",
    id: videoId,
    url: `https://youtube.com/shorts/${videoId}`,
    note,
    postedAt: new Date().toISOString(),
  };

  } catch (error) { if (!submissionStarted) throw new NotSubmittedError(error); throw error; }
}
