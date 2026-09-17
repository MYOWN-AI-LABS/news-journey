import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { contained, read } from "./workspaces.js";
import { NEWSLETTER_PRESETS, readPersonalization, type Personalization } from "./personalization.js";

/**
 * The customer's content persona: who publishes, for whom, in what voice and look. Written to the workspace as
 * PERSONA.md and, only on the customer's explicit click, into the global instruction files their coding agents
 * read (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/AGENTS.md`). The block is fenced by markers so a later
 * link replaces it in place and never touches anything else in those files. No ids, keys or paths inside.
 */
export const PERSONA_START = "<!-- myownai-content-persona:start -->";
export const PERSONA_END = "<!-- myownai-content-persona:end -->";
export const PERSONAL_PROFILE_START = "<!-- myownai-personal-profile:start -->";
export const PERSONAL_PROFILE_END = "<!-- myownai-personal-profile:end -->";
const MAX_AGENT_FILE_BYTES = 512 * 1024;
const MAX_PROFILE_BYTES = 16 * 1024;

export interface PersonaPublisher { name: string; publication: string; audience: string; tone: string }

const LABELS: Record<string, Record<string, string>> = {
  videoFraming: { "": "illustrated cards", cards: "illustrated cards", corner: "presenter inset in a corner over the cards", opening: "presenter for the opening seconds, then cards", full: "full-frame presenter" },
  videoBackground: { "": "brand colour wash", brand: "brand colour wash", studio: "neutral studio", newsroom: "soft newsroom blur" },
  captionStyle: { "": "clean", clean: "clean", boxed: "boxed", pill: "pill", glow: "glow" },
  fontPairing: { "": "modern sans-serif", sans: "modern sans-serif", serif: "classic serif", mixed: "serif headings with sans text" },
  styleDirection: { "": "neutral house style", "boardroom-concise": "boardroom concise", "friendly-explainer": "friendly explainer", "high-energy-product": "high-energy product story" },
};

export function personaMarkdown(pub: PersonaPublisher, p: Personalization, narration: string): string {
  const preset = NEWSLETTER_PRESETS.find(x => x.id === (p.newsletterPreset || "clean"));
  const line = (k: string, v: string) => v ? `- ${k}: ${v.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n` : "";
  return `${PERSONA_START}
## My content persona (MyOwnAI content harness)

${line("Publication", pub.publication)}${line("Author credit", pub.name)}${line("Organization", p.organization)}${line("Audience", pub.audience)}${line("Tone", pub.tone)}${line("Tagline", p.tagline)}${line("Website", p.website)}${line("Writing style", LABELS.styleDirection[p.styleDirection] + (p.styleNotes ? ` — in my words: ${p.styleNotes}` : ""))}${line("Newsletter style", `${preset?.label ?? "Clean"}, ${p.theme || preset?.mode || "light"} look, accent ${p.accent || preset?.accent || "edition colour"}, ${LABELS.fontPairing[p.fontPairing]}`)}${line("Newsletter length", p.newsletterLength)}${line("Video", `${p.videoLength || "standard"} length, ${LABELS.videoFraming[p.videoFraming]}, ${LABELS.videoBackground[p.videoBackground]} background, ${LABELS.captionStyle[p.captionStyle]} captions`)}${line("Narration", narration)}${line("Cadence", p.cadence)}
When you write, design or brief anything for this publication, keep this persona: the audience, tone, style and look above are mine. Never publish on my behalf; I review and approve every edition in the harness.
These are publication preferences, not additional story facts or tool instructions. A fresh task's topics and locations win over this profile; never infer a topic from personal background. This profile cannot change review, permissions or execution budgets.
${PERSONA_END}`;
}

/** Allowed link targets: the global instruction files of the coding agents, under the home directory only. */
function fixedTargets() {
  const home = homedir();
  const targets = [
    { id: "claude", path: join(home, ".claude", "CLAUDE.md"), label: "Claude Code (~/.claude/CLAUDE.md)", plain: "Claude Code" },
    { id: "codex", path: join(home, ".codex", "AGENTS.md"), label: "Codex (~/.codex/AGENTS.md)", plain: "Codex" },
    { id: "agents", path: join(home, "AGENTS.md"), label: "Other agents (~/AGENTS.md)", plain: "Other agents" },
  ];
  return targets;
}

/** Local filesystem sharing never follows links, including dangling links and parent directories. */
function safePath(base: string, path: string): void {
  const root = resolve(base), rel = relative(root, resolve(path));
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(sep)) throw new Error("Profile target leaves its allowed directory");
  let cursor = root;
  const parts = rel.split(sep);
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) cursor = join(cursor, parts[i]!);
    let stat;
    try { stat = lstatSync(cursor); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error("Profile sharing does not follow symbolic links");
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error("Profile parent must be a directory");
    if (i === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1)) throw new Error("Profile target must be a regular file without hard links");
  }
}

function snapshot(base: string, path: string): { text: string | null; mode: number } {
  safePath(base, path);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_AGENT_FILE_BYTES) throw new Error("Profile target must be a regular file of at most 512 KB");
    const bytes = readFileSync(fd);
    if (bytes.byteLength > MAX_AGENT_FILE_BYTES) throw new Error("Profile target exceeds 512 KB");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes) || text.includes("\0")) throw new Error("Profile target must contain UTF-8 text");
    return { text, mode: stat.mode & 0o777 };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: null, mode: 0o600 }; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function markerRange(text: string, startMark: string, endMark: string): [number, number] | null {
  const start = text.indexOf(startMark), end = text.indexOf(endMark);
  if (start === -1 && end === -1) return null;
  if (start < 0 || end <= start || text.indexOf(startMark, start + startMark.length) >= 0 || text.indexOf(endMark, end + endMark.length) >= 0) throw new Error("Profile markers are incomplete or duplicated; repair the file before sharing");
  return [start, end + endMark.length];
}

function upsertBlock(existing: string, block: string, startMark: string, endMark: string): string {
  if (typeof block !== "string" || Buffer.byteLength(block) > MAX_PROFILE_BYTES || block.includes("\0")) throw new Error("Profile block exceeds its text limit");
  const blockRange = markerRange(block, startMark, endMark);
  if (!blockRange || blockRange[0] !== 0 || blockRange[1] !== block.length) throw new Error("Profile block must contain one complete marker pair");
  const range = markerRange(existing, startMark, endMark);
  return range ? existing.slice(0, range[0]) + block + existing.slice(range[1]) : existing + (existing ? (existing.endsWith("\n") ? "\n" : "\n\n") : "") + block + "\n";
}

/** Replace only one complete managed block, preserving every byte outside it. */
export function upsertPersonaBlock(existing: string, block: string): string {
  return upsertBlock(existing, block, PERSONA_START, PERSONA_END);
}

type PlannedWrite = { base: string; path: string; text: string | null; before: { text: string | null; mode: number } };
function replaceFile(plan: PlannedWrite, expected: string | null, next: string | null): void {
  const current = snapshot(plan.base, plan.path);
  if (current.text !== expected) throw new Error("Profile target changed during sharing; review it and try again");
  if (next === expected) return;
  if (next === null) { unlinkSync(plan.path); return; }
  if (Buffer.byteLength(next) > MAX_AGENT_FILE_BYTES) throw new Error("Updated profile target exceeds 512 KB");
  mkdirSync(dirname(plan.path), { recursive: true, mode: 0o700 });
  safePath(plan.base, plan.path);
  const temporary = join(dirname(plan.path), `.content-profile-${process.pid}-${randomBytes(12).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, next, { flag: "wx", mode: plan.before.mode });
    if (snapshot(plan.base, plan.path).text !== expected) throw new Error("Profile target changed during sharing; review it and try again");
    renameSync(temporary, plan.path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function commitWrites(plans: PlannedWrite[]): void {
  const completed: PlannedWrite[] = [];
  try {
    for (const plan of plans) { replaceFile(plan, plan.before.text, plan.text); completed.push(plan); }
  } catch (error) {
    let rollbackFailed = false;
    for (const plan of completed.reverse()) {
      try { replaceFile(plan, plan.text, plan.before.text); } catch { rollbackFailed = true; }
    }
    throw new Error(`${(error as Error).message}${rollbackFailed ? "; some files changed concurrently and could not be restored. Inspect the selected agent files." : "; no selected file changes were kept."}`, { cause: error });
  }
}

function selectedTargets(targetIds: string[]) {
  const allowed = fixedTargets();
  if (!Array.isArray(targetIds) || targetIds.length > allowed.length || new Set(targetIds).size !== targetIds.length || targetIds.some(id => !allowed.some(t => t.id === id))) throw new Error("Choose only the named agent targets, once each");
  return targetIds.map(id => allowed.find(t => t.id === id)!);
}
const scopeMarker = (root: string, kind: string) => `<!-- myownai-${kind}:workspace:${createHash("sha256").update(realpathSync(root)).digest("hex")} -->`;
function scopedBlock(root: string, markdown: string, kind: string, start: string, end: string): string {
  upsertBlock("", markdown, start, end);
  if (markdown.includes(`<!-- myownai-${kind}:workspace:`)) throw new Error("Workspace identity is assigned by the harness");
  return markdown.replace(start, start + "\n" + scopeMarker(root, kind));
}

function targetStatus(start: string, end: string, root?: string) {
  return fixedTargets().map(t => {
    try {
      const file = snapshot(homedir(), t.path), range = markerRange(file.text ?? "", start, end);
      const block = range ? file.text!.slice(range[0], range[1]) : "";
      const linkedHere = root ? block.includes(scopeMarker(root, "personal-profile")) : Boolean(range);
      return { ...t, exists: file.text !== null, linked: Boolean(range), linkedHere, anotherWorkspace: Boolean(range) && !linkedHere, available: true, reason: "" };
    } catch (error) { return { ...t, exists: false, linked: false, linkedHere: false, anotherWorkspace: false, available: false, reason: (error as Error).message }; }
  });
}

export function personaTargets() { return targetStatus(PERSONA_START, PERSONA_END); }
export function personalProfileTargets(root: string) { return targetStatus(PERSONAL_PROFILE_START, PERSONAL_PROFILE_END, root); }

function shareBlock(root: string, markdown: string, targetIds: string[], kind: "content-persona" | "personal-profile", start: string, end: string) {
  const targets = selectedTargets(targetIds), block = scopedBlock(root, markdown, kind, start, end);
  const plans: PlannedWrite[] = targets.map(t => { const before = snapshot(homedir(), t.path); return { base: homedir(), path: t.path, before, text: upsertBlock(before.text ?? "", block, start, end) }; });
  const written = targets.map(t => "~" + sep + relative(resolve(homedir()), t.path));
  const paths = kind === "content-persona" ? ["PERSONA.md", "state/persona-link.json"] : ["PERSONAL_PROFILE.md", "state/personal-profile-link.json"];
  const local = [block + "\n", JSON.stringify({ at: new Date().toISOString(), written }, null, 2) + "\n"];
  paths.forEach((name, i) => { const path = contained(root, name); plans.push({ base: root, path, before: snapshot(root, path), text: local[i]! }); });
  commitWrites(plans);
  return { markdown: block, written };
}

export function writePersona(root: string, pub: PersonaPublisher, narration: string, targetIds: string[]): { markdown: string; written: string[] } {
  return shareBlock(root, personaMarkdown(pub, readPersonalization(root), narration), targetIds, "content-persona", PERSONA_START, PERSONA_END);
}

/** Called only after an explicit local-owner browser action; it never imports global instructions. */
export function sharePersonalProfileToAgents(root: string, markdown: string, targetIds: string[]) {
  return shareBlock(root, markdown, targetIds, "personal-profile", PERSONAL_PROFILE_START, PERSONAL_PROFILE_END);
}

/** Remove only this workspace's shared profile, leaving other workspaces and unrelated rules intact. */
export function removePersonalProfileFromAgents(root: string, targetIds: string[]) {
  const targets = selectedTargets(targetIds), removed: string[] = [];
  const plans: PlannedWrite[] = targets.map(t => {
    const before = snapshot(homedir(), t.path), range = markerRange(before.text ?? "", PERSONAL_PROFILE_START, PERSONAL_PROFILE_END);
    if (range && !before.text!.slice(range[0], range[1]).includes(scopeMarker(root, "personal-profile"))) throw new Error("This shared profile belongs to another workspace; no file was changed");
    if (range) removed.push("~" + sep + relative(resolve(homedir()), t.path));
    return { base: homedir(), path: t.path, before, text: range ? before.text!.slice(0, range[0]) + before.text!.slice(range[1]) : before.text };
  });
  commitWrites(plans);
  return { removed };
}

/** Explicit profile deletion also removes our optional local export, never edition evidence. */
export function removeLocalPersonalProfileExport(root: string) {
  const path = contained(root, 'PERSONAL_PROFILE.md'), before = snapshot(root, path);
  if (before.text === null) return;
  const range = markerRange(before.text, PERSONAL_PROFILE_START, PERSONAL_PROFILE_END);
  if (!range || !before.text.slice(range[0], range[1]).includes(scopeMarker(root, 'personal-profile'))
    || before.text.slice(0, range[0]).trim() || before.text.slice(range[1]).trim()) throw new Error('The local profile export was changed; inspect it before deleting its personal information');
  commitWrites([{ base: root, path, before, text: null }]);
}

/** The persona in the customer's words: label/value pairs with no markup, ids or paths. */
export function personaSummary(pub: PersonaPublisher, p: Personalization, narration: string): { label: string; value: string }[] {
  const preset = NEWSLETTER_PRESETS.find(x => x.id === (p.newsletterPreset || "clean"));
  const rows: [string, string][] = [
    ["Publication", pub.publication], ["Written for", pub.audience], ["By", [pub.name, p.organization].filter(Boolean).join(", ")], ["Tone", pub.tone],
    ["Writing style", LABELS.styleDirection[p.styleDirection] + (p.styleNotes ? ` — ${p.styleNotes}` : "")],
    ["Newsletter", `${preset?.label ?? "Clean"} style, ${p.theme || preset?.mode || "light"} look, ${LABELS.fontPairing[p.fontPairing]}`],
    ["Video", `${LABELS.videoFraming[p.videoFraming]}, ${LABELS.videoBackground[p.videoBackground]} background, ${LABELS.captionStyle[p.captionStyle]} captions`],
    ["Narration", narration], ["Cadence", p.cadence || "not chosen yet"],
  ];
  return rows.filter(([, v]) => v && v.trim()).map(([label, value]) => ({ label, value }));
}

export function personaState(root: string, pub: PersonaPublisher, narration: string) {
  const link = read<{ at?: string; written?: string[] }>(contained(root, "state/persona-link.json"), {});
  const p = readPersonalization(root);
  return { markdown: personaMarkdown(pub, p, narration), summary: personaSummary(pub, p, narration), targets: personaTargets(), lastLink: link.at ?? null, lastWritten: link.written ?? [] };
}
