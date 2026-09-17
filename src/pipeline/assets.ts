import { withPublicPage } from "../sources/public-page.js";
import { gatherSourceFootage } from "./source-footage.js";
import { contained } from "../workspaces.js";
import { publicResponse, safePublicUrl } from "../sources/public-apis.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as cheerio from "cheerio";
import type { AssetManifest, Script, Topic, VideoMeta } from "../types.js";
import { fetchWithTimeout, readJson, videoDir, writeJson, log } from "../util.js";

/** Every asset is optional: any failure logs and returns null so a 404 never kills a run. */
async function tryFetch<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    log(`asset ${label} skipped: ${(e as Error).message}`);
    return null;
  }
}

async function downloadTo(url: string, path: string): Promise<string> {
  const res = await publicResponse(safePublicUrl(url, "Source image"), {"User-Agent":"Content-Harness/0.2"}, 15_000);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error("suspiciously small file");
  writeFileSync(path, buf);
  return path;
}

async function fetchOgImage(pageUrl: string, dest: string): Promise<string> {
  const res = await publicResponse(safePublicUrl(pageUrl, "Story source"), {"User-Agent":"Content-Harness/0.2"}, 15_000);
  if (!res.ok) throw new Error(`${res.status} for ${pageUrl}`);
  const $ = cheerio.load(await res.text());
  const og =
    $('meta[property="og:image"]').attr("content") ?? $('meta[name="twitter:image"]').attr("content");
  if (!og) throw new Error("no og:image");
  return downloadTo(new URL(og, pageUrl).toString(), dest);
}

async function screenshotRepo(repoUrl: string, dest: string): Promise<string> {
  return withPublicPage(repoUrl,async page=>{
    await page.screenshot({path:dest,clip:{x:0,y:0,width:1280,height:720}});
    return dest;
  });
}

async function fetchStarHistory(fullName: string, dest: string): Promise<string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetchWithTimeout(`https://api.github.com/repos/${fullName}`, { headers });
  if (!res.ok) throw new Error(`GH repo api ${res.status}`);
  const repo = (await res.json()) as { stargazers_count: number; created_at: string };
  // One API observation is one dated value, never a fabricated growth curve.
  const points = [{date:new Date().toISOString().slice(0,10),count:repo.stargazers_count}];
  writeFileSync(dest, JSON.stringify(points, null, 2));
  return dest;
}

/** Roundup: one asset per story — og:image of the story URL, falling back to a repo screenshot. */
async function gatherRoundupAssets(topic: Topic, assetsDir: string, manifest: AssetManifest): Promise<void> {
  for (const story of topic.stories ?? []) {
    if (!/^[\w-]+$/.test(story.assetRef)) throw new Error("Invalid story asset reference");
    const footage = await tryFetch(`${story.assetRef}-footage`, () => gatherSourceFootage(join(assetsDir,".."), story.assetRef, story.primaryUrl, story.repo?.url));
    if (footage) manifest[`${story.assetRef}-footage`] = footage;
    const dest = contained(assetsDir, `${story.assetRef}.png`);
    let got = await tryFetch(story.assetRef, () => fetchOgImage(story.primaryUrl, dest));
    if (!got && story.repo) {
      got = await tryFetch(`${story.assetRef}-shot`, () => screenshotRepo(story.repo!.url, dest));
    }
    if (got) manifest[story.assetRef] = `assets/${story.assetRef}.png`;
  }
}

export async function gatherAssets(id: string): Promise<AssetManifest> {
  const dir = videoDir(id);
  const assetsDir = contained(dir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const topic = readJson<Topic>(join(dir, "topic.json"));
  const script = readJson<Script>(join(dir, "script.json"));
  const manifest: AssetManifest = {};

  if (topic.kind === "roundup" && topic.stories?.length) {
    await gatherRoundupAssets(topic, assetsDir, manifest);
    writeJson(join(dir, "assets.json"), manifest);
    const meta = readJson<VideoMeta>(join(dir, "meta.json"));
    meta.status = "assets_ready";
    meta.updatedAt = new Date().toISOString();
    writeJson(join(dir, "meta.json"), meta);
    log(`Assets gathered (roundup): ${Object.keys(manifest).join(", ") || "(none — text-only fallback)"}`);
    return manifest;
  }

  const footage = await tryFetch("og-0-footage", () => gatherSourceFootage(dir,"og-0",topic.primaryUrl,topic.repo?.url));
  if (footage) manifest["og-0-footage"] = footage;
  // og:image of the primary URL → "og-0"
  const og = await tryFetch("og-0", () => fetchOgImage(topic.primaryUrl, join(assetsDir, "og-0.png")));
  if (og) manifest["og-0"] = "assets/og-0.png";

  if (topic.repo) {
    const shot = await tryFetch("repo-shot", () => screenshotRepo(topic.repo!.url, join(assetsDir, "shot-repo.png")));
    if (shot) manifest["repo-shot"] = "assets/shot-repo.png";
    const stars = await tryFetch("stars", () => fetchStarHistory(topic.repo!.fullName, join(assetsDir, "stars.json")));
    if (stars) manifest["stars"] = "assets/stars.json";
  }

  // favicon of primary domain
  const domain = new URL(topic.primaryUrl).hostname;
  const fav = await tryFetch("favicon", () =>
    downloadTo(`https://www.google.com/s2/favicons?sz=128&domain=${domain}`, join(assetsDir, "favicon.png"))
  );
  if (fav) manifest["favicon"] = "assets/favicon.png";

  // any assetRefs the script asked for that map to og images of alternate urls
  for (const [i, seg] of script.body.entries()) {
    if (seg.assetRef && !manifest[seg.assetRef] && seg.assetRef.startsWith("og-") && seg.assetRef !== "og-0") {
      const alt = topic.alternates[parseInt(seg.assetRef.slice(3), 10) - 1];
      if (alt) {
        const got = await tryFetch(seg.assetRef, () =>
          fetchOgImage(alt.primaryUrl, join(assetsDir, `${seg.assetRef}.png`))
        );
        if (got) manifest[seg.assetRef!] = `assets/${seg.assetRef}.png`;
      }
    }
    void i;
  }

  writeJson(join(dir, "assets.json"), manifest);
  const meta = readJson<VideoMeta>(join(dir, "meta.json"));
  meta.status = "assets_ready";
  meta.updatedAt = new Date().toISOString();
  writeJson(join(dir, "meta.json"), meta);
  log(`Assets gathered: ${Object.keys(manifest).join(", ") || "(none — text-only fallback)"}`);
  return manifest;
}
