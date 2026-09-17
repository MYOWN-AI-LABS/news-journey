import { createHash, randomUUID } from "node:crypto";
import { uvCommand } from "../platform.js";
import { MEDIA_PROCESS_LIMITS, runManagedProcess } from "../managed-process.js";
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AvatarConfig, Script, Timestamps, VideoMeta } from "../types.js";
import { portableCommand, resolveFreeTtsEngine, resolveFreeVoice } from "../platform.js";
import { CONFIG_DIR, ROOT, loadConfig, readJson, videoDir, writeJson, log } from "../util.js";
import { editionForVideo } from "./edition.js";

interface PipelineConfig {
  voice: string;
  ttsEngine: "kokoro" | "edge";
}

/** Speed the rendered audio.wav up by `factor` (ffmpeg atempo) and scale timestamps.json's word
 *  stamps + duration by 1/factor, so the sped-up audio, captions, and video stay in sync. Whisper
 *  alignment MUST already have run on the ORIGINAL audio (faster audio = different word boundaries). */
async function applySpeedFactor(dir: string, factor: number): Promise<void> {
  const audio = join(dir, "audio.wav");
  const tmp = join(dir, `audio.fast-${randomUUID()}.wav`);
  // Use Remotion's bundled FFmpeg on every OS; portableCommand handles Windows' npx.cmd shim.
  const spec = portableCommand("npx", ["remotion", "ffmpeg", "-y", "-i", audio, "-filter:a", `atempo=${factor}`, tmp]);
  await runManagedProcess(spec.command, spec.args, { operation: 'Narration pacing', timeoutMs: MEDIA_PROCESS_LIMITS.transform, cwd: ROOT });
  renameSync(tmp, audio);
  const s = 1 / factor;
  const r = (n: number) => Math.round(n * s * 1000) / 1000;
  const stamps = readJson<Timestamps>(join(dir, "timestamps.json"));
  stamps.durationSec = r(stamps.durationSec);
  stamps.words = stamps.words.map((w) => ({ ...w, start: r(w.start), end: r(w.end) }));
  if (stamps.lines) stamps.lines = stamps.lines.map((l) => ({ ...l, startSec: r(l.startSec), endSec: r(l.endSec) }));
  writeJson(join(dir, "timestamps.json"), stamps);
  // audio.wav was just replaced with the sped-up take. A previously-built audio.m4a (the newsletter
  // briefing player's source) is NOT regenerated unless missing, so drop it here — it would otherwise
  // play the OLD audio against the new scaled captions. It rebuilds fresh on next newsletter run.
  const m4a = join(dir, "audio.m4a");
  if (existsSync(m4a)) rmSync(m4a);
}

/** Raw ASR must describe these exact synthesis bytes, before caption alignment/pacing.
 * Transcript warnings do not become a human-listening requirement for private previews. */
export function assertNarrationTranscriptQc(dir: string, requested: string, engine: string, voice: string): Record<string, unknown> {
  const qc = readJson<Record<string, unknown>>(join(dir, 'audio-qc.json'));
  const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  if (qc.version !== 1 || qc.status !== 'pass' || qc.method !== 'raw-asr-script-comparison'
      || !Array.isArray(qc.blocking) || qc.blocking.length || !Array.isArray(qc.heardWords) || !qc.heardWords.length
      || qc.engine !== engine || qc.voice !== voice || qc.requestedText !== requested.trim()
      || qc.scriptSha256 !== digest(requested.trim()) || qc.audioSha256 !== digest(readFileSync(join(dir, 'audio.wav')))) {
    throw new Error('AUDIO QC HOLD: transcript receipt does not pass for this exact requested script, selected voice and audio. Preserve the candidate and inspect audio-qc.json.');
  }
  return qc;
}

export async function voice(id: string, engineOverride?: string, speedFactor?: number): Promise<Timestamps> {
  const dir = videoDir(id);
  const script = readJson<Script>(join(dir, "script.json"));
  const cfg = loadConfig<PipelineConfig>("pipeline");

  const avatar = existsSync(join(CONFIG_DIR, "avatar.json"))
    ? loadConfig<AvatarConfig>("avatar")
    : null;
  // provider from avatar.json governs the cloned-voice engines; a CLI override always wins.
  const provider = engineOverride ? null : avatar?.voiceProvider;
  const engine =
    engineOverride ??
    (provider === "voicebox" ? "voicebox" : provider === "elevenlabs" ? "elevenlabs" : provider === "resemble" ? "resemble" : resolveFreeTtsEngine(cfg.ttsEngine));
  // For the clone engines the "--voice" arg carries the voice ID/UUID; secrets ride on env (.env).
  const voiceArg =
    engine === "voicebox" ? avatar?.voicebox?.profile ?? "" : engine === "elevenlabs"
      ? avatar?.elevenlabs.voiceId ?? ""
      : engine === "resemble"
        ? avatar?.resemble?.voiceUuid ?? process.env.RESEMBLE_VOICE_UUID ?? ""
        : resolveFreeVoice(engine === "edge" ? "edge" : "kokoro", cfg.voice);
  const extraEnv: NodeJS.ProcessEnv =
    engine === "elevenlabs" && avatar
      ? {
          ELEVENLABS_MODEL_ID: avatar.elevenlabs.modelId,
          ELEVENLABS_STABILITY: String(avatar.elevenlabs.stability),
          ELEVENLABS_SIMILARITY: String(avatar.elevenlabs.similarityBoost),
          ELEVENLABS_STYLE: String(avatar.elevenlabs.style),
          ELEVENLABS_SPEAKER_BOOST: String(avatar.elevenlabs.speakerBoost),
        }
      : {};

  const textPath = join(dir, "script.txt");
  writeFileSync(textPath, script.fullVoiceoverText);

  // Presenter formats: every line is rendered with its own member's approved voice (voice-cast.ts).
  // The cast is the one the script was written for (kept beside it), never the live workspace config.
  const { EMPTY_CAST } = await import("./cast.js");
  const cast = existsSync(join(dir, "cast.json")) ? readJson<import("./cast.js").Cast>(join(dir, "cast.json")) : EMPTY_CAST;
  const presenting = cast.format !== "narrator" && cast.members.length > 0 && script.body.some((seg) => seg.lines?.length);
  if (presenting) {
    if (engineOverride) log(`voice: --engine ${engineOverride} ignored — this package's presenters render with their approved voices`);
    const { synthesizeCast } = await import("./voice-cast.js");
    await synthesizeCast(dir, script, cast, resolveFreeVoice("kokoro", cfg.voice));
  } else {
  log(`TTS (${engine}) for ${id}...`);
  await runManagedProcess(uvCommand(), [
    "run", "--project", join(ROOT, "tts"), join(ROOT, "tts", "synth_and_align.py"),
    "--text-file", textPath, "--out-dir", dir, "--voice", voiceArg,
    "--kokoro-voice", cfg.voice, // Legacy CLI argument; never changes the selected voice.
    "--engine", engine,
  ], { operation: 'Narration synthesis and alignment', timeoutMs: MEDIA_PROCESS_LIMITS.narration, cwd: ROOT, env: { ...process.env, ...extraEnv } });

  }

  const transcriptQc = presenting
    ? (await import('./voice-cast.js')).assertCastTranscriptQc(dir, script, cast)
    : assertNarrationTranscriptQc(dir, script.fullVoiceoverText, engine, voiceArg);
  let stamps = readJson<Timestamps>(join(dir, "timestamps.json"));
  if (!presenting && ["voicebox", "resemble", "elevenlabs"].includes(engine) && stamps.engine !== engine) {
    throw new Error('Selected voice did not render. Hold this draft; never substitute another voice.');
  }

  // Pacing: speed the narration up (e.g. 1.25x for the special edition) AFTER whisper alignment,
  // then scale every word stamp + duration by 1/factor so captions + video stay perfectly in sync.
  // Factor comes from the explicit param (CLI --speed) or the video's edition (self-discovered).
  const factor = speedFactor ?? editionForVideo(id).speedFactor ?? undefined;
  if (factor && factor !== 1) {
    log(`Pacing: applying ${factor}x (ffmpeg atempo) + scaling timestamps...`);
    await applySpeedFactor(dir, factor);
    stamps = readJson<Timestamps>(join(dir, "timestamps.json"));
    log(`Pacing: new duration ${stamps.durationSec}s`);
  }
  if (transcriptQc) {
    writeJson(join(dir, 'audio-qc.json'), { ...transcriptQc, postProcessing: { speedFactor: factor || 1, audioSha256: createHash('sha256').update(readFileSync(join(dir, 'audio.wav'))).digest('hex') } });
  }
  const voiceReceipt = join(dir, 'voice-receipt.json');
  if (!presenting && engine === 'voicebox' && existsSync(voiceReceipt)) {
    writeJson(voiceReceipt, { ...readJson<Record<string, unknown>>(voiceReceipt), postProcessing: { speedFactor: factor || 1 }, audioSha256: createHash('sha256').update(readFileSync(join(dir, 'audio.wav'))).digest('hex') });
  }

  const {rmSync}=await import("node:fs");
  rmSync(join(dir,"audio.m4a"),{force:true});
  stamps.narrationSha256=createHash("sha256").update(script.fullVoiceoverText).digest("hex");
  writeJson(join(dir,"timestamps.json"),stamps);
  const meta = readJson<VideoMeta>(join(dir, "meta.json"));
  meta.status = "voiced";
  meta.durationSec = stamps.durationSec;
  meta.updatedAt = new Date().toISOString();
  writeJson(join(dir, "meta.json"), meta);
  log(`Voice done: ${stamps.durationSec}s, ${stamps.words.length} word stamps`);
  return stamps;
}
