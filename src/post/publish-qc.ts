import { readFileSync } from "node:fs";
import { runManagedProcess } from "../managed-process.js";
import { join } from "node:path";
import type { VideoMeta } from "../types.js";
import { portableCommand } from "../platform.js";
import { ROOT, videoDir } from "../util.js";

export interface PublishQcOptions { deadline?: number; beforeTool?(name: string): void }
async function remotionFfmpeg(args: string[], options: PublishQcOptions = {}) {
  options.beforeTool?.('ffmpeg-technical-check');
  const timeout = options.deadline === undefined ? 120000 : Math.min(120000, options.deadline - Date.now());
  if (timeout <= 0) throw new Error('Technical media QC reached the original parent deadline');
  const spec = portableCommand("npx", ["remotion", "ffmpeg", ...args]);
  return runManagedProcess(spec.command, spec.args, { operation: 'Technical media check', cwd: ROOT, stdio: 'pipe', timeoutMs: timeout, rejectNonZero: false });
}

function hasFaststart(path: string): boolean {
  const buf = readFileSync(path);
  let offset = 0;
  for (let i = 0; i < 8 && offset + 8 <= buf.length; i++) {
    const size = buf.readUInt32BE(offset);
    const tag = buf.toString("ascii", offset + 4, offset + 8);
    if (tag === "moov") return true;
    if (tag === "mdat") return false;
    if (size < 8) return false;
    offset += size;
  }
  return false;
}

/** Decode every video and audio frame. Explicit raw/PCM output prevents stream-copy checks from
 * accepting corrupt encoded media and avoids relying on the null muxer's default encoders. */
async function decodesClean(path: string, options: PublishQcOptions): Promise<{ ok: boolean; detail: string }> {
  const r = await remotionFfmpeg([
    "-v", "error", "-i", path,
    "-map", "0:v:0", "-map", "0:a:0", "-c:v", "rawvideo", "-c:a", "pcm_s16le", "-f", "null", "-",
  ], options);
  const stderr = (r.stderr || "").trim();
  return { ok: decodeCompleted(r.code, stderr), detail: stderr.slice(0, 500) };
}

export function decodeCompleted(status: number | null, stderr: string): boolean {
  const wrapperNoise = [/^\((?:node|npm)[:\s][^)]*\)\s*(?:\[[^\]]+\]\s*)?(?:Experimental)?Warning:/i, /^\(Use `node --trace-warnings/i, /^npm (?:warn|notice)\b/i, /^\s*$/];
  return status === 0 && stderr.split('\n').every(line => wrapperNoise.some(pattern => pattern.test(line.trim())));
}

async function probeDurationSec(path: string, options: PublishQcOptions): Promise<number | null> {
  const r = await remotionFfmpeg(["-i", path], options);
  const m = (r.stderr || "").match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export interface PublishQCResult {
  pass: boolean;
  issues: string[];
}

export async function publishQC(meta: VideoMeta, options: PublishQcOptions = {}): Promise<PublishQCResult> {
  const issues: string[] = [];
  const finalPath = join(videoDir(meta.id), "final.mp4");

  if (!hasFaststart(finalPath)) {
    issues.push("final.mp4 is NOT faststart (moov after mdat) — may fail to open in QuickTime/mobile players even though it decodes.");
  }

  const decode = await decodesClean(finalPath, options);
  if (!decode.ok) {
    issues.push(`final.mp4 failed a clean decode-through: ${decode.detail || "non-zero exit, no stderr detail"}`);
  }

  const dur = await probeDurationSec(finalPath, options);
  if (dur === null) {
    issues.push("could not read final.mp4's duration at all — likely corrupt or truncated.");
  } else if (meta.durationSec && Math.abs(dur - meta.durationSec) > 5) {
    issues.push(`duration mismatch: final.mp4 is ${dur.toFixed(1)}s but meta.json expects ~${meta.durationSec}s.`);
  }

  return { pass: issues.length === 0, issues };
}
