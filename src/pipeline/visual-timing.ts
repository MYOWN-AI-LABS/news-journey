import type { WordStamp, Script, Timestamps } from "../types.js";
import { narrationSections } from './narration';

/** Quotes retain word indices; ambiguous or missing cues never masquerade as narration timing. */
const tokens = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? [];
export function cueWordIndex(text: string, phrase: string): number | null {
  const source = text.trim().split(/\s+/);
  const flat = source.flatMap((word, index) => tokens(word).map(token => ({ token, index })));
  const cue = tokens(phrase);
  if (!cue.length) return null;
  const hits = flat.flatMap((_, i) => cue.every((word, k) => flat[i + k]?.token === word) ? [flat[i].index] : []);
  return hits.length === 1 ? hits[0] : null;
}

export interface VisualTiming { method: "narration" | "reading" | "unmatched"; starts: number[]; duration: number; }
export function narrationTiming(voiceover: string, cues: string[], words: WordStamp[], start: number, end: number): VisualTiming {
  const local = words.filter(w => w.start >= start - .001 && w.start < end);
  // Match the transcript itself as well: TTS may split punctuation/contractions differently.
  const transcript = local.map(w => w.w).join(" ");
  const indices = cues.map(cue => cueWordIndex(voiceover, cue) == null ? null : cueWordIndex(transcript, cue));
  const starts = indices.map(i => i == null ? NaN : (local[i]?.start ?? NaN) - start);
  const duration = end - start;
  if (tokens(transcript).join(" ") !== tokens(voiceover).join(" ") || !cues.length || !(duration > 0) || starts.some((t, i) => !Number.isFinite(t) || t < 0 || t >= duration || (i > 0 && t <= starts[i - 1]))) {
    return { method: "unmatched", starts: [], duration };
  }
  return { method: "narration", starts, duration };
}

/** Reading previews precede voice generation. They are explicitly recorded as reading timing. */
export function readingTiming(count: number, duration = 6): VisualTiming {
  return { method: "reading", starts: Array.from({ length: count }, (_, i) => i * (duration - 1.2) / Math.max(1, count)), duration };
}

export function visualBeat(t: number, timing: VisualTiming): number {
  if (timing.method === "unmatched" || !timing.starts.length) return -1; // complete view
  let active = -1;
  timing.starts.forEach((start, i) => { if (t >= start) active = i; });
  return active;
}

export function beatProgress(t: number, timing: VisualTiming): number {
  if (timing.method === "unmatched" || !timing.starts.length) return 1;
  const first = timing.starts[0];
  const last = timing.starts.at(-1)!;
  return Math.max(0, Math.min(1, (t - first) / Math.max(.5, last - first)));
}

/** Map each script section onto its [startSec, endSec] span via the word stamps. */
export function buildSegmentTimes(script: Script, stamps: Timestamps) {
  const sections = narrationSections(script);
  const transcript = stamps.words.flatMap((word, index) => tokens(word.w).map(token => ({ token, index })));
  let offset = 0;
  return sections.map(section => {
    const expected = tokens(section);
    if (!expected.length) return {startSec: stamps.durationSec, endSec: stamps.durationSec};
    const at = transcript.findIndex((_, i) => i >= offset && expected.every((token, j) => transcript[i + j]?.token === token));
    if (at < 0) throw new Error("Narration transcript does not match the script section; regenerate voice before rendering.");
    offset = at + expected.length;
    return {startSec: stamps.words[transcript[at].index].start, endSec: stamps.words[transcript[offset - 1].index].end};
  });
}
