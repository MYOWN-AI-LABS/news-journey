import { releaseProfile } from '../release-profile.js';
import { atomicJson, contained, read } from "../workspaces.js";
import type { Script } from "../types.js";

/**
 * The bounded multi-presenter proof (plan: "Multi-presenter proof"). "Interactive video" here means
 * people interacting with each other on screen — a two-person conversation, a three-person panel
 * story, or a product pitch split across up to three speakers. Every participant has a stable role,
 * an approved voice, an optional approved portrait and an explicit consent record; every script line
 * belongs to exactly one member. Branching, live avatars and audience participation are out of scope.
 */
export const CAST_FORMATS = ["narrator", "conversation", "panel", "pitch"] as const;
export type CastFormat = (typeof CAST_FORMATS)[number];
export const ROLES: Record<Exclude<CastFormat, "narrator">, string[]> = {
  conversation: ["host", "expert"],
  panel: ["moderator", "speaker", "speaker"],
  pitch: ["problem", "solution", "proof"],
};
export const KOKORO_VOICES = ["af_heart", "af_bella", "af_sarah", "am_adam", "am_michael", "bf_emma", "bm_george"] as const;
/**
 * Named equivalents for an explicitly selected Edge voice path. This lookup does not authorize
 * a provider switch: approved local cast voices remain local and fail if unsupported on the host.
 */
export const EDGE_EQUIVALENT: Record<(typeof KOKORO_VOICES)[number], string> = {
  af_heart: "en-US-AriaNeural", af_bella: "en-US-JennyNeural", af_sarah: "en-US-MichelleNeural",
  am_adam: "en-US-GuyNeural", am_michael: "en-US-ChristopherNeural", bf_emma: "en-GB-SoniaNeural", bm_george: "en-GB-RyanNeural",
};

export interface CastMember {
  id: string;
  role: string;
  name: string;
  voice: { engine: "kokoro" | "voicebox"; id: string };
  /** Workspace-relative approved portrait; optional — cards mode draws a name chip when absent. */
  portraitFile?: string;
  consent: { grantedBy: string; at: string; statement: string };
}
export interface Cast { version: 1; format: CastFormat; members: CastMember[]; updatedAt: string | null }
export const EMPTY_CAST: Cast = { version: 1, format: "narrator", members: [], updatedAt: null };

export function readCast(root: string): Cast {
  if (releaseProfile().edition === "free") return { ...EMPTY_CAST, members: [] };
  let saved: Partial<Cast> = {};
  try { saved = read<Partial<Cast>>(contained(root, "config/cast.json"), {}); } catch { saved = {}; }
  return { version: 1, format: CAST_FORMATS.includes(saved.format as CastFormat) ? (saved.format as CastFormat) : "narrator", members: Array.isArray(saved.members) ? saved.members.filter(isMember) : [], updatedAt: typeof saved.updatedAt === "string" ? saved.updatedAt : null };
}
function isMember(m: unknown): m is CastMember {
  const x = m as CastMember;
  return !!x && typeof x.id === "string" && typeof x.role === "string" && typeof x.name === "string" && !!x.voice && ["kokoro", "voicebox"].includes(x.voice.engine) && typeof x.voice.id === "string" && !!x.consent && typeof x.consent.statement === "string";
}

/** Why this cast cannot present in `format`; null when it can. Narrator needs no cast. */
export function castProblem(cast: Cast, format: CastFormat = cast.format): string | null {
  if (format === "narrator") return null;
  const needed = ROLES[format];
  const members = cast.members;
  if (members.length < 2 || members.length > 3) return `${format} needs two or three presenters; ${members.length} configured`;
  const ids = new Set(members.map(m => m.id));
  if (ids.size !== members.length) return "every presenter needs a distinct id";
  for (const m of members) {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(m.id)) return `presenter id "${m.id}" must be lowercase letters, digits and dashes`;
    if (!m.name.trim()) return `presenter ${m.id} needs a name`;
    if (!needed.includes(m.role)) return `presenter ${m.id} has role "${m.role}"; ${format} uses ${[...new Set(needed)].join(", ")}`;
    if (!m.voice.id.trim()) return `presenter ${m.id} needs an approved voice`;
    if (m.voice.engine === "kokoro" && !(KOKORO_VOICES as readonly string[]).includes(m.voice.id)) return `presenter ${m.id}: unknown built-in voice "${m.voice.id}"`;
    if (!m.consent.statement.trim() || !m.consent.grantedBy.trim() || !m.consent.at) return `presenter ${m.id} has no consent record`;
  }
  const voices = new Set(members.map(m => `${m.voice.engine}:${m.voice.id}`));
  if (voices.size !== members.length) return "each presenter needs a different voice so identities cannot swap";
  const roles = members.map(m => m.role);
  for (const role of new Set(needed)) {
    const required = needed.filter(r => r === role).length, have = roles.filter(r => r === role).length;
    if (have < required) return `${format} needs ${required === 1 ? "a" : required} ${role}${required > 1 ? "s" : ""}`;
    if (required === 1 && have > 1) return `${format} allows one ${role}`;
  }
  return null;
}

/** Saves a validated cast. Consent timestamps are set on save when missing; nothing else is inferred. */
export function saveCast(root: string, input: { format?: unknown; members?: unknown }, actor: string): Cast {
  const format = CAST_FORMATS.includes(input.format as CastFormat) ? (input.format as CastFormat) : "narrator";
  const members = (Array.isArray(input.members) ? input.members : []).map((raw: any) => ({
    id: String(raw?.id ?? "").trim().toLowerCase(), role: String(raw?.role ?? "").trim(), name: String(raw?.name ?? "").trim().slice(0, 80),
    voice: { engine: raw?.voice?.engine === "voicebox" ? "voicebox" as const : "kokoro" as const, id: String(raw?.voice?.id ?? "").trim().slice(0, 120) },
    ...(typeof raw?.portraitFile === "string" && /^assets\/portrait-[a-z0-9-]+\.(png|jpg)$/.test(raw.portraitFile) ? { portraitFile: raw.portraitFile } : {}),
    consent: { grantedBy: String(raw?.consent?.grantedBy ?? actor).trim().slice(0, 120), at: typeof raw?.consent?.at === "string" ? raw.consent.at : new Date().toISOString(), statement: String(raw?.consent?.statement ?? "").trim().slice(0, 500) },
  }));
  const cast: Cast = { version: 1, format, members, updatedAt: new Date().toISOString() };
  const problem = castProblem(cast);
  if (problem) throw new Error(problem);
  atomicJson(contained(root, "config/cast.json"), cast);
  return cast;
}

/** Which presenter formats this workspace can select now. */
export function castReadiness(cast: Cast): Record<Exclude<CastFormat, "narrator">, boolean> {
  return { conversation: castProblem(cast, "conversation") === null, panel: castProblem(cast, "panel") === null, pitch: castProblem(cast, "pitch") === null };
}

/** Prompt block for a dialogue script: every spoken line carries exactly one presenter id. */
export function dialogueInstructions(cast: Cast): string {
  if (cast.format === "narrator" || !cast.members.length) return "";
  const shape = cast.format === "conversation" ? "a short exchange of turns between the host and the expert" : cast.format === "panel" ? "the moderator framing each story and the two speakers telling different parts of it" : "the problem, the solution and the proof each carried by its own speaker";
  return `\nPRESENTERS (${cast.format}): ${cast.members.map(m => `${m.id} = ${m.name}, ${m.role}`).join("; ")}.
Write each body segment as ${shape}. In every body segment include "lines": [{"speaker":"<presenter id>","text":"..."}] with at least two different presenters per segment, and set that segment's "voiceover" to the lines' texts joined by single spaces, in order. The hook and cta are spoken by ${cast.members[0]!.id}. Never invent a presenter, never let one presenter speak as another, and keep every claim inside the supplied story facts.`;
}

/** The dialogue schema gate, applied with the ordinary script validators when a cast presents. */
export function dialogueProblem(script: Script, cast: Cast): string | null {
  if (cast.format === "narrator" || !cast.members.length) return null;
  const ids = new Set(cast.members.map(m => m.id));
  const byRole = (role: string) => cast.members.filter(m => m.role === role).map(m => m.id);
  const spoke = new Set<string>();
  for (const [i, seg] of script.body.entries()) {
    const lines = seg.lines;
    if (!Array.isArray(lines) || lines.length < 2) return `segment ${i + 1} needs "lines" with at least two presenter turns`;
    for (const [k, line] of lines.entries()) {
      if (!line || typeof line.speaker !== "string" || !ids.has(line.speaker)) return `segment ${i + 1} line ${k + 1} names an unknown presenter "${line?.speaker}"`;
      if (typeof line.text !== "string" || !line.text.trim()) return `segment ${i + 1} line ${k + 1} is empty`;
      if (/^\s*[A-Z][\w .'-]{0,30}:\s/.test(line.text) && cast.members.some(m => line.text.trim().toLowerCase().startsWith(m.name.toLowerCase() + ":"))) return `segment ${i + 1} line ${k + 1} embeds a speaker label in its text; use "speaker" only`;
      spoke.add(line.speaker);
    }
    if (new Set(lines.map(l => l.speaker)).size < 2) return `segment ${i + 1} is spoken by one presenter only; ${cast.format} needs interaction`;
    const joined = lines.map(l => l.text.trim()).join(" ").replace(/\s+/g, " ");
    if (joined !== seg.voiceover.trim().replace(/\s+/g, " ")) return `segment ${i + 1} voiceover must equal its lines joined in order`;
  }
  if (cast.format === "pitch") for (const role of ["problem", "solution", "proof"]) if (!byRole(role).some(id => spoke.has(id))) return `pitch needs the ${role} presenter to speak at least once`;
  if (cast.format === "panel" && byRole("speaker").filter(id => spoke.has(id)).length < 2) return "panel needs both speakers to speak";
  return null;
}
