import { assertProDistribution } from '../release-profile.js';
import { uvCommand } from "../platform.js";
import { assetPath } from "../workspaces.js";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { join } from "node:path";
import type { AvatarConfig, Timestamps, VideoMeta } from "../types.js";
import { portableCommand } from "../platform.js";
import { CONFIG_DIR, ROOT, loadConfig, readJson, videoDir, writeJson, log } from "../util.js";

const UPLOAD_URL = "https://upload.heygen.com/v1/asset";
const GENERATE_URL = "https://api.heygen.com/v3/videos";
const STATUS_URL = "https://api.heygen.com/v1/video_status.get";
const HEDRA_BASE = "https://api.hedra.com/web-app/public";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function remotionFfmpeg(args: string[]) {
  const spec = portableCommand("npx", ["remotion", "ffmpeg", ...args]);
  return spawnSync(spec.command, spec.args, { cwd: ROOT, stdio: "ignore" });
}

function avatarConfig(): AvatarConfig | null {
  return existsSync(join(CONFIG_DIR, "avatar.json")) ? loadConfig<AvatarConfig>("avatar") : null;
}

/** Should the avatar stage run for this configuration? Cards mode / missing setup → no. */
export function avatarEnabled(cfg: AvatarConfig | null): cfg is AvatarConfig {
  return !!cfg && cfg.mode !== "cards";
}

async function heygen(url: string, init: RequestInit, key: string): Promise<any> {
  const res = await fetch(url, { ...init, headers: { "X-Api-Key": key, ...(init.headers ?? {}) } });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HeyGen ${url} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  // HeyGen wraps errors as { code, message } or { error }. Surface them verbatim.
  if (!res.ok || json.error || (typeof json.code === "number" && json.code !== 100)) {
    throw new Error(`HeyGen ${url} error (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

async function heygenAvatar(id: string, dir: string, cfg: AvatarConfig, audioPath: string): Promise<string> {
  const key = process.env.HEYGEN_API_KEY?.trim();
  if (!key) throw new Error("HEYGEN_API_KEY not set (.env) — required for HeyGen avatar mode");
  if (!cfg.heygen.avatarId) throw new Error("config/avatar.json heygen.avatarId is empty");

  // 1. Upload our audio so HeyGen lip-syncs to it (not its own TTS).
  log(`avatar(heygen): uploading audio for ${id}...`);
  const uploaded = await heygen(
    UPLOAD_URL,
    { method: "POST", headers: { "Content-Type": "audio/x-wav" }, body: readFileSync(audioPath) }, // HeyGen requires x-wav (rejects audio/wav)
    key
  );
  const audioAssetId: string | undefined = uploaded.data?.id ?? uploaded.data?.asset_id;
  if (!audioAssetId) throw new Error(`HeyGen upload returned no asset id: ${JSON.stringify(uploaded).slice(0, 200)}`);

  // 2. Kick off generation via the v3 Avatar IV Photo-Avatar engine. It accepts our uploaded audio to
  //    drive lip-sync (audio_asset_id, mutually exclusive with script/TTS); aspect_ratio + resolution
  //    replace the old v2 pixel dimensions; the 10-min audio ceiling removes Hedra's ~30s cap.
  const engine = cfg.heygen.engine ?? "avatar_iv";
  const resolution = cfg.heygen.resolution ?? "1080p";
  log(`avatar(heygen): requesting generation (avatar ${cfg.heygen.avatarId}, ${engine} ${cfg.heygen.ratio} ${resolution})...`);
  const gen = await heygen(
    GENERATE_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "avatar",
        avatar_id: cfg.heygen.avatarId,
        audio_asset_id: audioAssetId,
        aspect_ratio: cfg.heygen.ratio,
        resolution,
        title: id,
        engine: { type: engine },
        ...(cfg.heygen.expressiveness ? { expressiveness: cfg.heygen.expressiveness } : {}),
        ...(cfg.heygen.motionPrompt ? { motion_prompt: cfg.heygen.motionPrompt } : {}),
        background: { type: "color", value: cfg.heygen.background },
      }),
    },
    key
  );
  const videoId: string | undefined = gen.data?.video_id;
  if (!videoId) throw new Error(`HeyGen generate returned no video_id: ${JSON.stringify(gen).slice(0, 200)}`);

  // 3. Poll until completed.
  const deadline = Date.now() + cfg.heygen.maxPollMinutes * 60_000;
  let videoUrl: string | undefined;
  while (Date.now() < deadline) {
    await sleep(cfg.heygen.pollSeconds * 1000);
    const st = await heygen(`${STATUS_URL}?video_id=${videoId}`, { method: "GET" }, key);
    const status: string = st.data?.status;
    if (status === "completed") {
      videoUrl = st.data?.video_url;
      break;
    }
    if (status === "failed") {
      throw new Error(`HeyGen generation failed: ${JSON.stringify(st.data?.error ?? st.data).slice(0, 300)}`);
    }
    log(`avatar(heygen): ${videoId} ${status}...`);
  }
  if (!videoUrl) throw new Error(`HeyGen generation timed out after ${cfg.heygen.maxPollMinutes}min`);

  // 4. Download avatar.mp4 next to the audio.
  log(`avatar(heygen): downloading result for ${id}...`);
  const outPath = join(dir, "avatar.mp4");
  const dl = await fetch(videoUrl);
  if (!dl.ok || !dl.body) throw new Error(`avatar download failed: HTTP ${dl.status}`);
  await streamPipeline(Readable.fromWeb(dl.body as any), createWriteStream(outPath));
  if (!existsSync(outPath)) throw new Error("avatar download completed but avatar.mp4 missing");
  return outPath;
}

async function hedraApi(path: string, init: RequestInit, key: string): Promise<any> {
  const res = await fetch(`${HEDRA_BASE}${path}`, { ...init, headers: { "X-API-Key": key, ...(init.headers ?? {}) } });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* upload endpoints may return empty/non-JSON */ }
  if (!res.ok) throw new Error(`Hedra ${path} error (${res.status}): ${(text || "").slice(0, 300)}`);
  return json;
}

/** Create a Hedra asset then upload the file bytes; returns the asset id. */
async function hedraCreateAndUpload(
  filePath: string, name: string, type: "image" | "audio", mime: string, key: string
): Promise<string> {
  const created = await hedraApi(
    "/assets",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, type }) },
    key
  );
  const assetId: string | undefined = created.id ?? created.asset_id ?? created.data?.id;
  if (!assetId) throw new Error(`Hedra create-asset (${type}) returned no id: ${JSON.stringify(created).slice(0, 200)}`);
  const form = new FormData();
  form.append("file", new Blob([readFileSync(filePath)], { type: mime }), name);
  await hedraApi(`/assets/${assetId}/upload`, { method: "POST", body: form }, key); // fetch sets the multipart boundary
  return assetId;
}

async function hedraAvatar(id: string, dir: string, cfg: AvatarConfig, audioPath: string): Promise<string> {
  const key = process.env.HEDRA_API_KEY?.trim();
  if (!key) throw new Error("HEDRA_API_KEY not set (.env) — required for Hedra avatar mode");
  if (!cfg.hedra) throw new Error("config/avatar.json hedra block missing");
  const srcImage = assetPath(cfg.hedra.sourceImage);
  if (!existsSync(srcImage)) throw new Error(`Hedra sourceImage not found: ${cfg.hedra.sourceImage}`);

  const stamps = readJson<Timestamps>(join(dir, "timestamps.json"));
  // Optionally cap the generation to the first N seconds (a short, cheap "opening" avatar that then
  // DISAPPEARS in the render). Trim the audio so Hedra only bills for that window.
  const introSec = cfg.hedra.introSeconds && cfg.hedra.introSeconds > 0 ? cfg.hedra.introSeconds : null;
  let uploadAudio = audioPath;
  let durationMs = Math.ceil(stamps.durationSec * 1000);
  if (introSec) {
    const trimmed = join(dir, "audio.intro.wav");
    const r = remotionFfmpeg(["-y", "-i", audioPath, "-t", String(introSec), trimmed]);
    if (r.status !== 0 || !existsSync(trimmed)) throw new Error(`avatar(hedra): failed to trim audio to ${introSec}s`);
    uploadAudio = trimmed;
    durationMs = Math.ceil(introSec * 1000);
  }

  // 1. Upload our audio + the portrait as Hedra assets.
  log(`avatar(hedra): uploading ${introSec ? `first ${introSec}s of ` : ""}audio + portrait for ${id}...`);
  const audioId = await hedraCreateAndUpload(uploadAudio, "audio.wav", "audio", "audio/wav", key);
  const imageId = await hedraCreateAndUpload(srcImage, "portrait.png", "image", "image/png", key);

  // 2. Kick off Character-3 generation (lip-syncs the portrait to our audio).
  log(`avatar(hedra): requesting generation (model ${cfg.hedra.modelId}, ${cfg.hedra.aspectRatio} ${cfg.hedra.resolution})...`);
  const gen = await hedraApi(
    "/generations",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "video",
        ai_model_id: cfg.hedra.modelId,
        start_keyframe_id: imageId,
        audio_id: audioId,
        generated_video_inputs: {
          text_prompt: "",
          aspect_ratio: cfg.hedra.aspectRatio,
          resolution: cfg.hedra.resolution,
          duration_ms: durationMs,
        },
      }),
    },
    key
  );
  const genId: string | undefined = gen.id ?? gen.generation_id ?? gen.data?.id;
  if (!genId) throw new Error(`Hedra generate returned no id: ${JSON.stringify(gen).slice(0, 200)}`);

  // 3. Poll until complete.
  const deadline = Date.now() + cfg.hedra.maxPollMinutes * 60_000;
  let downloadUrl: string | undefined;
  while (Date.now() < deadline) {
    await sleep(cfg.hedra.pollSeconds * 1000);
    const st = await hedraApi(`/generations/${genId}/status`, { method: "GET" }, key);
    const status: string = st.status;
    if (status === "complete") {
      downloadUrl = st.download_url ?? st.url;
      break;
    }
    if (status === "error") {
      throw new Error(`Hedra generation error: ${st.error_message ?? JSON.stringify(st).slice(0, 300)}`);
    }
    log(`avatar(hedra): ${genId} ${status} (${Math.round((st.progress ?? 0) * 100)}%)...`);
  }
  if (!downloadUrl) throw new Error(`Hedra generation timed out after ${cfg.hedra.maxPollMinutes}min`);

  // 4. Download avatar.mp4 next to the audio.
  log(`avatar(hedra): downloading result for ${id}...`);
  const outPath = join(dir, "avatar.mp4");
  const dl = await fetch(downloadUrl);
  if (!dl.ok || !dl.body) throw new Error(`Hedra download failed: HTTP ${dl.status}`);
  await streamPipeline(Readable.fromWeb(dl.body as any), createWriteStream(outPath));
  if (!existsSync(outPath)) throw new Error("Hedra download completed but avatar.mp4 missing");
  return outPath;
}

async function falApi(url: string, init: RequestInit, key: string): Promise<any> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Key ${key}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { throw new Error(`fal ${url} non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`fal ${url} error (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

/** Upload a local file to fal storage; returns the public file_url (Kling/OmniHuman reject data URIs). */
async function falUpload(filePath: string, contentType: string, fileName: string, key: string): Promise<string> {
  const init = await falApi(
    "https://rest.alpha.fal.ai/storage/upload/initiate",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content_type: contentType, file_name: fileName }) },
    key
  );
  if (!init.upload_url || !init.file_url) throw new Error(`fal storage initiate returned no urls: ${JSON.stringify(init).slice(0, 200)}`);
  const put = await fetch(init.upload_url, { method: "PUT", headers: { "Content-Type": contentType }, body: readFileSync(filePath) });
  if (!put.ok) throw new Error(`fal storage PUT failed: HTTP ${put.status}`);
  return init.file_url as string;
}

/** The active provider's intro cap in seconds (short cheap opening inset that then disappears), or null. */
function introSecondsFor(cfg: AvatarConfig): number | null {
  const p = cfg.avatarProvider ?? "heygen";
  const s =
    p === "fal" ? cfg.fal?.introSeconds
    : p === "hedra" ? cfg.hedra?.introSeconds
    : p === "heygem" ? cfg.heygem?.introSeconds
    : undefined;
  return s && s > 0 ? s : null;
}

// ---------------------------------------------------------------------------
// Duix.Heygem (open-source, self-hosted — github.com/GuijiAI/HeyGem.ai)
// ---------------------------------------------------------------------------

async function heygemApi(base: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch {
    throw new Error(`HeyGem ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || (typeof json.code === "number" && json.code !== 10000)) {
    throw new Error(`HeyGem ${path} error (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

/** Stage a local file into the HeyGem data volume at relPath (mounted-dir copy, or scp). */
function heygemPut(cfg: NonNullable<AvatarConfig["heygem"]>, local: string, relPath: string): void {
  if (cfg.dataDir) {
    const dest = join(cfg.dataDir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(local, dest);
    return;
  }
  if (cfg.ssh && cfg.remoteDataDir) {
    const remote = `${cfg.remoteDataDir}/${relPath}`;
    spawnSync("ssh", [cfg.ssh, "mkdir", "-p", dirname(remote)], { stdio: "ignore" });
    const r = spawnSync("scp", ["-q", local, `${cfg.ssh}:${remote}`], { stdio: "ignore" });
    if (r.status !== 0) throw new Error(`heygem: scp to ${cfg.ssh}:${remote} failed (status ${r.status})`);
    return;
  }
  throw new Error("config/avatar.json heygem needs dataDir (mounted volume) or ssh + remoteDataDir");
}

/** Fetch a result file back out of the HeyGem data volume. */
function heygemGet(cfg: NonNullable<AvatarConfig["heygem"]>, relPath: string, local: string): void {
  if (cfg.dataDir) {
    const src = join(cfg.dataDir, relPath);
    if (!existsSync(src)) throw new Error(`heygem: result missing in data volume: ${src}`);
    copyFileSync(src, local);
    return;
  }
  const r = spawnSync("scp", ["-q", `${cfg.ssh}:${cfg.remoteDataDir}/${relPath}`, local], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`heygem: scp result ${relPath} failed (status ${r.status})`);
}

async function heygemAvatar(id: string, dir: string, cfg: AvatarConfig, audioPath: string): Promise<string> {
  const hg = cfg.heygem;
  if (!hg) throw new Error("config/avatar.json heygem block missing");
  const base = (process.env.HEYGEM_BASE_URL ?? hg.baseUrl)?.trim()?.replace(/\/$/, "");
  if (!base) throw new Error("HEYGEM_BASE_URL not set (.env) and heygem.baseUrl empty — where is the face2face service?");
  const srcVideo = assetPath(hg.sourceVideo);
  if (!existsSync(srcVideo)) throw new Error(`heygem sourceVideo not found: ${hg.sourceVideo}`);

  // Optionally trim to the first N seconds (opening inset; the render drops it after N sec).
  const introSec = introSecondsFor(cfg);
  let uploadAudio = audioPath;
  if (introSec) {
    const trimmed = join(dir, "audio.intro.wav");
    const r = remotionFfmpeg(["-y", "-i", audioPath, "-t", String(introSec), trimmed]);
    if (r.status !== 0 || !existsSync(trimmed)) throw new Error(`avatar(heygem): failed to trim audio to ${introSec}s`);
    uploadAudio = trimmed;
  }

  // 1. Stage audio + reference video into the service's data volume (its API takes volume-relative
  //    paths — there is no HTTP upload endpoint).
  const code = randomUUID();
  const audioRel = `temp/${code}.wav`;
  const videoRel = `temp/${code}-src.mp4`;
  log(`avatar(heygem): staging ${introSec ? `first ${introSec}s of ` : ""}audio + source video for ${id} → ${base}...`);
  heygemPut(hg, uploadAudio, audioRel);
  heygemPut(hg, srcVideo, videoRel);

  // 2. Submit the lip-sync job.
  log(`avatar(heygem): submitting job ${code}...`);
  await heygemApi(base, "/easy/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio_url: audioRel,
      video_url: videoRel,
      code,
      chaofen: hg.chaofen ?? 0,
      watermark_switch: 0,
      pn: 1,
    }),
  });

  // 3. Poll /easy/query until done (status 1=processing, 2=complete, 3=failed).
  const deadline = Date.now() + hg.maxPollMinutes * 60_000;
  let resultRel: string | undefined;
  while (Date.now() < deadline) {
    await sleep(hg.pollSeconds * 1000);
    const st = await heygemApi(base, `/easy/query?code=${code}`, { method: "GET" });
    const status: number = st.data?.status;
    if (status === 2) {
      resultRel = st.data?.result;
      break;
    }
    if (status === 3) throw new Error(`HeyGem generation failed: ${st.data?.msg ?? JSON.stringify(st.data).slice(0, 300)}`);
    log(`avatar(heygem): ${code} processing (${st.data?.progress ?? 0}%)...`);
  }
  if (!resultRel) throw new Error(`HeyGem generation timed out after ${hg.maxPollMinutes}min`);

  // 4. Copy avatar.mp4 back out of the data volume.
  log(`avatar(heygem): fetching result ${resultRel} for ${id}...`);
  const outPath = join(dir, "avatar.mp4");
  heygemGet(hg, resultRel.replace(/^\//, ""), outPath);
  if (!existsSync(outPath)) throw new Error("HeyGem result fetched but avatar.mp4 missing");
  return outPath;
}

/** fal.ai avatar provider: animate cfg.fal.sourceImage lip-synced to OUR audio.wav via the configured
 *  model (cfg.fal.model — Kling AI Avatar v2 default, or OmniHuman 1.5). Image + audio are uploaded to
 *  fal storage (these models reject data URIs). Optionally caps to cfg.fal.introSeconds. Returns the
 *  downloaded avatar.mp4 path. */
async function falAvatar(id: string, dir: string, cfg: AvatarConfig, audioPath: string): Promise<string> {
  const key = (process.env.FAL_KEY ?? process.env.FAL_API_KEY)?.trim();
  if (!key) throw new Error("FAL_KEY not set (.env) — required for fal avatar mode");
  if (!cfg.fal) throw new Error("config/avatar.json fal block missing");
  const model = cfg.fal.model ?? "fal-ai/kling-video/ai-avatar/v2/standard";
  const srcImage = assetPath(cfg.fal.sourceImage);
  if (!existsSync(srcImage)) throw new Error(`fal sourceImage not found: ${cfg.fal.sourceImage}`);

  // Optionally trim to the first N seconds (cheap opening avatar; the render drops it after N sec).
  const introSec = introSecondsFor(cfg);
  let uploadAudio = audioPath;
  if (introSec) {
    const trimmed = join(dir, "audio.intro.wav");
    const r = remotionFfmpeg(["-y", "-i", audioPath, "-t", String(introSec), trimmed]);
    if (r.status !== 0 || !existsSync(trimmed)) throw new Error(`avatar(fal): failed to trim audio to ${introSec}s`);
    uploadAudio = trimmed;
  }

  // 1. Upload image + audio to fal storage.
  log(`avatar(fal): uploading ${introSec ? `first ${introSec}s of ` : ""}audio + portrait for ${id} (${model})...`);
  const imageUrl = await falUpload(srcImage, "image/png", "portrait.png", key);
  const audioUrl = await falUpload(uploadAudio, "audio/wav", "audio.wav", key);

  // 2. Submit to the configured model.
  const submit = await falApi(
    `https://queue.fal.run/${model}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image_url: imageUrl, audio_url: audioUrl, prompt: cfg.fal.prompt }) },
    key
  );
  const statusUrl: string | undefined = submit.status_url;
  const responseUrl: string | undefined = submit.response_url;
  if (!statusUrl || !responseUrl) throw new Error(`fal submit returned no status/response url: ${JSON.stringify(submit).slice(0, 200)}`);

  // 3. Poll until COMPLETED.
  const deadline = Date.now() + cfg.fal.maxPollMinutes * 60_000;
  let done = false;
  while (Date.now() < deadline) {
    await sleep(cfg.fal.pollSeconds * 1000);
    const st = await falApi(statusUrl, { method: "GET" }, key);
    if (st.status === "COMPLETED") { done = true; break; }
    if (st.status && st.status !== "IN_QUEUE" && st.status !== "IN_PROGRESS") {
      throw new Error(`fal generation ${st.status}: ${JSON.stringify(st).slice(0, 300)}`);
    }
    log(`avatar(fal): ${id} ${st.status}...`);
  }
  if (!done) throw new Error(`fal generation timed out after ${cfg.fal.maxPollMinutes}min`);

  // 4. Fetch the result + download avatar.mp4.
  const result = await falApi(responseUrl, { method: "GET" }, key);
  const videoUrl: string | undefined = result.video?.url;
  if (!videoUrl) throw new Error(`fal result had no video url: ${JSON.stringify(result).slice(0, 200)}`);
  log(`avatar(fal): downloading result for ${id}...`);
  const outPath = join(dir, "avatar.mp4");
  const dl = await fetch(videoUrl);
  if (!dl.ok || !dl.body) throw new Error(`fal download failed: HTTP ${dl.status}`);
  await streamPipeline(Readable.fromWeb(dl.body as any), createWriteStream(outPath));
  if (!existsSync(outPath)) throw new Error("fal download completed but avatar.mp4 missing");
  return outPath;
}

export async function avatar(id: string): Promise<string | null> {
  const dir = videoDir(id);
  const cfg = avatarConfig();
  if (!avatarEnabled(cfg)) {
    log(`avatar: mode is "cards" (or no avatar.json) — skipping for ${id}`);
    return null;
  }

  assertProDistribution("Presenter generation");
  const audioPath = join(dir, "audio.wav");
  if (!existsSync(audioPath)) throw new Error(`audio.wav missing for ${id} — run the voice stage first`);

  const provider = cfg.avatarProvider ?? "heygen";
  log(`avatar: provider=${provider}, mode=${cfg.mode} for ${id}`);

  const introSecQc = introSecondsFor(cfg);
  const introArg = introSecQc ? ["--expected-dur", String(introSecQc)] : [];
  const runQC = (out: string) => spawnSync(uvCommand(),
    ["run", "--project", join(ROOT, "tts"), "python", join(ROOT, "tts/avatar_frame_check.py"), "--avatar", out,
     "--timestamps", join(dir, "timestamps.json"), "--out", join(dir, "avatar-qc.json"), ...introArg],
    { cwd: ROOT, encoding: "utf8" });

  const MAX_ATTEMPTS = 2;
  let outPath = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    outPath = provider === "hedra"
      ? await hedraAvatar(id, dir, cfg, audioPath)
      : provider === "fal"
      ? await falAvatar(id, dir, cfg, audioPath)
      : provider === "heygem"
      ? await heygemAvatar(id, dir, cfg, audioPath)
      : await heygenAvatar(id, dir, cfg, audioPath);
    const qc = runQC(outPath);
    if (qc.status === 0) {
      log(`avatar: QC passed for ${id}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      break;
    }
    let reasons = qc.stderr?.slice(0, 200) ?? "qc failed";
    let sourceProblem = false;
    try {
      const r = readJson<{ failReasons?: string[]; darkAnomaly?: boolean }>(join(dir, "avatar-qc.json"));
      reasons = (r.failReasons ?? []).join("; ") || reasons;
      sourceProblem = r.darkAnomaly === true; // bad sourceImage → re-gen reproduces it
    } catch { /* keep stderr reasons */ }
    rmSync(outPath, { force: true });
    if (attempt < MAX_ATTEMPTS && !sourceProblem) {
      log(`avatar: QC FAILED (${reasons}) — retrying generation (attempt ${attempt + 1}/${MAX_ATTEMPTS}) for ${id}`);
      continue;
    }
    const why = sourceProblem
      ? `${reasons} — source-level: fix config/avatar.json hedra.sourceImage (a retry reproduces it)`
      : `${reasons} (after ${attempt} attempt${attempt > 1 ? "s" : ""})`;
    log(`avatar: QC FAILED — dropping avatar, falling back to cards for ${id}: ${why}`);
    const { notify } = await import("../review/notify.js");
    notify("Example Signal — avatar QC failed", `Avatar dropped (cards fallback): ${why}`);
    return null;
  }

  // Sanity: avatar length should track the audio we sent.
  const stamps = readJson<Timestamps>(join(dir, "timestamps.json"));
  const meta = readJson<VideoMeta>(join(dir, "meta.json"));
  meta.status = "avatar_generated";
  meta.updatedAt = new Date().toISOString();
  writeJson(join(dir, "meta.json"), meta);
  log(`avatar: ready → ${outPath} (~${stamps.durationSec}s, ${provider}, mode ${cfg.mode})`);
  return outPath;
}
