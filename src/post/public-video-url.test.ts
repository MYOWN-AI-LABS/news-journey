import assert from "node:assert/strict";
import test from "node:test";
import type { VideoMeta } from "../types.js";
import { publicVideoUrl } from "./public-video-url.js";

const meta: VideoMeta = {
  id: "20260817-example-topic",
  status: "approved",
  headline: "Example topic",
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  posts: {},
};

test("accepts one path placeholder on a public HTTPS host", async () => {
  assert.equal(await publicVideoUrl(meta, { PUBLIC_VIDEO_URL_TEMPLATE: "https://media.example.com/videos/{id}.mp4" }), "https://media.example.com/videos/20260817-example-topic.mp4");
  assert.equal(await publicVideoUrl(meta, { PUBLIC_VIDEO_URL_TEMPLATE: "https://192.0.78.8/videos/{id}.mp4" }), "https://192.0.78.8/videos/20260817-example-topic.mp4");
});

for (const template of [
  "http://media.example.com/{id}.mp4",
  "https://localhost/{id}.mp4",
  "https://127.0.0.1/{id}.mp4",
  "https://10.0.0.8/{id}.mp4",
  "https://192.168.1.9/{id}.mp4",
  "https://192.0.0.8/{id}.mp4",
  "https://192.0.2.8/{id}.mp4",
  "https://local/{id}.mp4",
  "https://printer/{id}.mp4",
  "https://host.internal/{id}.mp4",
  "https://localhost./{id}.mp4",
  "https://printer./{id}.mp4",
  "https://host.internal./{id}.mp4",
  "https://[::]/{id}.mp4",
  "https://[::1]/{id}.mp4",
  "https://[::ffff:10.0.0.1]/{id}.mp4",
  "https://[fd00::1]/{id}.mp4",
  "https://[fe80::1]/{id}.mp4",
  "https://[2001:db8::1]/{id}.mp4",
  "https://198.51.100.8/{id}.mp4",
  "https://203.0.113.8/{id}.mp4",
  "https://media.example.com/video.mp4?id={id}",
  "https://media.example.com/video.mp4#{id}",
  "https://user:pass@media.example.com/{id}.mp4",
]) {
  test(`rejects unsafe template: ${template}`, async () => {
    await assert.rejects(() => publicVideoUrl(meta, { PUBLIC_VIDEO_URL_TEMPLATE: template }));
  });
}

test("rejects zero and duplicate placeholders", async () => {
  await assert.rejects(() => publicVideoUrl(meta, { PUBLIC_VIDEO_URL_TEMPLATE: "https://media.example.com/video.mp4" }));
  await assert.rejects(() => publicVideoUrl(meta, { PUBLIC_VIDEO_URL_TEMPLATE: "https://media.example.com/{id}/{id}.mp4" }));
  await assert.rejects(() => publicVideoUrl(meta, { PUBLIC_VIDEO_URL_TEMPLATE: "https://media.example.com/{id}/%7Bid%7D.mp4" }));
});
