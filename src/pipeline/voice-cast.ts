import { MEDIA_PROCESS_LIMITS, runManagedProcess } from "../managed-process.js";
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { uvCommand, portableCommand, resolveFreeTtsEngine } from "../platform.js";
import type { Script, Timestamps } from "../types.js";
import { ROOT, readJson, writeJson, log } from "../util.js";
import { EDGE_EQUIVALENT, type Cast, type CastMember } from "./cast.js";
import { contained } from '../workspaces.js';

/**
 * Multi-presenter narration on the existing local engines: each line is synthesized and aligned with
 * its own member's approved voice, the takes are concatenated, and the word stamps are offset into
 * one timeline with a speaker span per line. A member's voice that does not render holds the package
 * (`voice.ts` fails the stage); no other voice is ever substituted for a presenter.
 */
export interface LineTake { speaker: CastMember; text: string; stamps: Timestamps }

/** Pure: offsets each take's words into one timeline and records who spoke when. */
export function mergeLineStamps(takes: LineTake[]): Timestamps {
  const words: Timestamps["words"] = [], lines: NonNullable<Timestamps["lines"]> = [];
  let offset = 0;
  for (const take of takes) {
    for (const w of take.stamps.words) words.push({ ...w, start: round(w.start + offset), end: round(w.end + offset) });
    lines.push({ speaker: take.speaker.id, name: take.speaker.name, role: take.speaker.role, startSec: round(offset), endSec: round(offset + take.stamps.durationSec), engine: take.stamps.engine });
    offset += take.stamps.durationSec;
  }
  const engines = [...new Set(takes.map(t => t.stamps.engine))];
  return { durationSec: round(offset), engine: engines.length === 1 ? engines[0]! : "kokoro", words, lines };
}
const round = (n: number) => Math.round(n * 1000) / 1000;

/** The spoken sequence: hook by the first member, each segment's lines, cta by the first member. */
export function castLines(script: Script, cast: Cast): { speaker: CastMember; text: string }[] {
  const lead = cast.members[0]!;
  const byId = new Map(cast.members.map(m => [m.id, m]));
  const out: { speaker: CastMember; text: string }[] = [{ speaker: lead, text: script.hook }, ...(script.intro ? [{ speaker: lead, text: script.intro }] : [])];
  for (const seg of script.body) for (const line of seg.lines ?? []) {
    const member = byId.get(line.speaker);
    if (!member) throw new Error(`Line names an unknown presenter "${line.speaker}"; hold this draft`);
    out.push({ speaker: member, text: line.text });
  }
  out.push({ speaker: lead, text: script.cta });
  return out.filter(l => l.text.trim());
}

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Re-read each exact take; a merged receipt must never conceal a failed or swapped presenter. */
function castTranscriptProof(dir: string, script: Script, cast: Cast) {
  const sequence = castLines(script, cast), normalize = (text: string) => text.trim().replace(/\s+/g, ' ');
  assert.equal(normalize(sequence.map(line => line.text).join(' ')), normalize(script.fullVoiceoverText), 'Cast audio sequence differs from the saved narration');
  let offset = 0;
  const heardWords: { w: string; start: number; end: number }[] = [], warnings: unknown[] = [];
  const lines = sequence.map((line, i) => {
    const prefix = `voice-lines/${String(i + 1).padStart(3, '0')}`;
    const bytes = (name: string) => readFileSync(contained(dir, prefix, name));
    const qcBytes = bytes('audio-qc.json'), qc = JSON.parse(qcBytes.toString()) as Record<string, any>;
    const stampsBytes = bytes('timestamps.json'), stamps = JSON.parse(stampsBytes.toString()) as Timestamps;
    assert.ok(qc.version === 1 && qc.status === 'pass' && qc.method === 'raw-asr-script-comparison'
      && Array.isArray(qc.blocking) && qc.blocking.length === 0 && Array.isArray(qc.heardWords) && qc.heardWords.length
      && qc.engine === line.speaker.voice.engine && qc.voice === line.speaker.voice.id && stamps.engine === line.speaker.voice.engine
      && qc.requestedText === line.text.trim() && qc.scriptSha256 === digest(line.text.trim())
      && qc.audioSha256 === digest(bytes('audio.wav')) && bytes('line.txt').toString() === line.text
      && Number.isFinite(stamps.durationSec) && stamps.durationSec > 0,
    `AUDIO QC HOLD: cast line ${i + 1} does not match its exact script, approved voice and audio`);
    for (const word of qc.heardWords) {
      assert.ok(typeof word.w === 'string' && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end >= word.start, 'Cast transcript has invalid word timing');
      heardWords.push({ w: word.w, start: round(offset + word.start), end: round(offset + word.end) });
    }
    warnings.push(...(Array.isArray(qc.changes) ? qc.changes.map(detail => ({ line: i + 1, detail })) : []));
    offset += stamps.durationSec;
    return { path: prefix, speaker: line.speaker.id, engine: qc.engine, voice: qc.voice, textSha256: digest(line.text), audioSha256: qc.audioSha256, receiptSha256: digest(qcBytes), timestampsSha256: digest(stampsBytes) };
  });
  return { castSha256: digest(JSON.stringify(cast)), lines, heardWords, warnings };
}

/** Written only after ffmpeg has successfully concatenated these validated takes. */
export function retainCastTranscriptReceipt(dir: string, script: Script, cast: Cast): Record<string, unknown> {
  const receipt = { version: 1, method: 'raw-asr-cast-concatenation', status: 'pass', ...castTranscriptProof(dir, script, cast),
    requestedText: script.fullVoiceoverText.trim(), scriptSha256: digest(script.fullVoiceoverText.trim()),
    audioSha256: digest(readFileSync(contained(dir, 'audio.wav'))), blocking: [], listeningApproved: false };
  writeJson(contained(dir, 'audio-qc.json'), receipt); return receipt;
}

export function assertCastTranscriptQc(dir: string, script: Script, cast: Cast): Record<string, unknown> {
  const receipt = readJson<Record<string, any>>(contained(dir, 'audio-qc.json')), proof = castTranscriptProof(dir, script, cast);
  assert.ok(receipt.version === 1 && receipt.method === 'raw-asr-cast-concatenation' && receipt.status === 'pass'
    && Array.isArray(receipt.blocking) && !receipt.blocking.length && receipt.listeningApproved === false
    && receipt.requestedText === script.fullVoiceoverText.trim() && receipt.scriptSha256 === digest(script.fullVoiceoverText.trim())
    && receipt.castSha256 === proof.castSha256 && JSON.stringify(receipt.lines) === JSON.stringify(proof.lines)
    && JSON.stringify(receipt.heardWords) === JSON.stringify(proof.heardWords)
    && (receipt.postProcessing?.audioSha256 ?? receipt.audioSha256) === digest(readFileSync(contained(dir, 'audio.wav'))),
  'AUDIO QC HOLD: aggregate cast receipt does not bind the exact line receipts, approved cast and merged audio');
  return receipt;
}

/** Synthesizes every line with its member's voice into `dir/audio.wav` + `dir/timestamps.json`. */
export async function synthesizeCast(dir: string, script: Script, cast: Cast, kokoroFallbackVoice: string): Promise<Timestamps> {
  const takesDir = contained(dir, "voice-lines");
  // Each line owns hash-bound raw takes and a durable correction allowance. Reentry must
  // preserve them; changed text/voice receives a new identity inside the existing ledger.
  mkdirSync(takesDir, { recursive: true });
  const takes: LineTake[] = [];
  for (const [i, line] of castLines(script, cast).entries()) {
    const lineDir = contained(dir, 'voice-lines', String(i + 1).padStart(3, "0"));
    mkdirSync(lineDir, { recursive: true });
    const textPath = join(lineDir, "line.txt");
    writeFileSync(textPath, line.text);
    // Preserve the approved local provider, including on unsupported hosts.
    // Runtime failure holds the draft; it never authorizes a network voice or another identity.
    const approved = line.speaker.voice;
    const engine = approved.engine === "kokoro" ? resolveFreeTtsEngine("kokoro") : approved.engine;
    const voiceId = engine === "edge" ? (EDGE_EQUIVALENT as Record<string, string>)[approved.id] ?? "en-US-AriaNeural" : approved.id;
    log(`TTS (${engine}) line ${i + 1} — ${line.speaker.name} (${line.speaker.role})`);
    await runManagedProcess(uvCommand(), ["run", "--project", join(ROOT, "tts"), join(ROOT, "tts", "synth_and_align.py"), "--text-file", textPath, "--out-dir", lineDir, "--voice", voiceId, "--kokoro-voice", engine === "kokoro" ? approved.id : kokoroFallbackVoice, "--engine", engine], { operation: `Presenter narration line ${i + 1}`, timeoutMs: MEDIA_PROCESS_LIMITS.narration, cwd: ROOT });
    const stamps = readJson<Timestamps>(join(lineDir, "timestamps.json"));
    // A presenter's approved voice must be the voice that rendered; a fallback engine is a swapped identity.
    if (stamps.engine !== engine) throw new Error(`${line.speaker.name}'s approved voice (${engine}) did not render for line ${i + 1}. Hold this draft; never substitute another voice.`);
    takes.push({ speaker: line.speaker, text: line.text, stamps });
  }
  const list = join(takesDir, "concat.txt");
  writeFileSync(list, takes.map((_, i) => `file '${join(takesDir, String(i + 1).padStart(3, "0"), "audio.wav").replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const out = join(dir, `audio.concat-${randomUUID()}.wav`);
  const spec = portableCommand("npx", ["remotion", "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
  await runManagedProcess(spec.command, spec.args, { operation: 'Presenter narration assembly', timeoutMs: MEDIA_PROCESS_LIMITS.transform, cwd: ROOT });
  if (!existsSync(out) || readFileSync(out).length < 1000) throw new Error("Concatenated narration is missing or empty; hold this draft");
  renameSync(out, join(dir, "audio.wav"));
  const merged = mergeLineStamps(takes);
  writeJson(join(dir, "timestamps.json"), merged);
  retainCastTranscriptReceipt(dir, script, cast);
  return merged;
}
