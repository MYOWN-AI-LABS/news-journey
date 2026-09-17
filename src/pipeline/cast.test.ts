import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { castProblem, castReadiness, dialogueInstructions, dialogueProblem, readCast, saveCast, type Cast } from "./cast.js";
import { castLines, mergeLineStamps } from "./voice-cast.js";
import type { Script } from "../types.js";

const consent = { grantedBy: "owner", at: "2026-09-09T20:00:00.000Z", statement: "I consent to my voice presenting this publication's videos." };
const host = { id: "jordan", role: "host", name: "Jordan", voice: { engine: "kokoro" as const, id: "af_heart" }, consent };
const expert = { id: "sam", role: "expert", name: "Sam", voice: { engine: "kokoro" as const, id: "am_adam" }, consent };
const conversation: Cast = { version: 1, format: "conversation", members: [host, expert], updatedAt: null };

test("a cast presents only with stable roles, distinct approved voices and consent for every member", () => {
  assert.equal(castProblem(conversation), null);
  assert.equal(castProblem({ ...conversation, members: [host] }), "conversation needs two or three presenters; 1 configured");
  assert.match(castProblem({ ...conversation, members: [host, { ...expert, voice: host.voice }] })!, /different voice/);
  assert.match(castProblem({ ...conversation, members: [host, { ...expert, consent: { ...consent, statement: "" } }] })!, /no consent record/);
  assert.match(castProblem({ ...conversation, members: [host, { ...expert, role: "moderator" }] })!, /uses host, expert/);
  assert.match(castProblem({ ...conversation, members: [host, { ...host, id: "jordan" }] })!, /distinct id/);
  assert.match(castProblem({ ...conversation, members: [host, { ...expert, voice: { engine: "kokoro", id: "not_a_voice" } }] })!, /unknown built-in voice/);
  const panel: Cast = { version: 1, format: "panel", members: [{ ...host, role: "moderator" }, { ...expert, role: "speaker" }, { id: "lee", role: "speaker", name: "Lee", voice: { engine: "voicebox", id: "lee-approved" }, consent }], updatedAt: null };
  assert.equal(castProblem(panel), null);
  assert.match(castProblem({ ...panel, members: panel.members.slice(0, 2) })!, /needs 2 speakers/);
  const pitch: Cast = { ...panel, format: "pitch", members: [{ ...host, role: "problem" }, { ...expert, role: "solution" }, { ...panel.members[2]!, role: "proof" }] };
  assert.equal(castProblem(pitch), null);
  assert.deepEqual(castReadiness(conversation), { conversation: true, panel: false, pitch: false });
  assert.deepEqual(castReadiness(pitch), { conversation: false, panel: false, pitch: true });
  assert.equal(castProblem({ version: 1, format: "narrator", members: [], updatedAt: null }), null, "the narrator needs no cast");
});

test("saving validates the whole cast, records consent timestamps and reads back defensively", () => {
  const root = mkdtempSync(join(tmpdir(), "cast-"));
  try {
    mkdirSync(join(root, "config"));
    assert.throws(() => saveCast(root, { format: "conversation", members: [host] }, "owner"), /two or three presenters/);
    const saved = saveCast(root, { format: "conversation", members: [{ ...host, consent: { statement: consent.statement } }, expert] }, "owner");
    assert.equal(saved.members[0]!.consent.grantedBy, "owner"); assert.ok(saved.members[0]!.consent.at);
    assert.equal(readCast(root).format, "conversation"); assert.equal(readCast(root).members.length, 2);
    assert.equal(saveCast(root, { format: "narrator", members: [] }, "owner").format, "narrator");
    assert.deepEqual(readCast("/nonexistent"), { version: 1, format: "narrator", members: [], updatedAt: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a dialogue script assigns every line to one presenter, needs interaction, and keeps voiceover identical to its lines", () => {
  const seg = (lines: { speaker: string; text: string }[]) => ({ voiceover: lines.map(l => l.text).join(" "), scene: "news_card" as const, onScreen: { title: "T" }, lines, motion: { kind: "flow" as const, who: "a", what: "b", how: "c", impact: "d", status: "e" } });
  const script = { hook: "Welcome.", cta: "Read the sources.", fullVoiceoverText: "", publish: { title: "t", linkedinPost: "p", description: "" }, body: [seg([{ speaker: "jordan", text: "Sam, what changed?" }, { speaker: "sam", text: "The council released the records." }])] } as unknown as Script;
  assert.equal(dialogueProblem(script, conversation), null);
  assert.match(dialogueInstructions(conversation), /jordan = Jordan, host; sam = Sam, expert/);
  assert.equal(dialogueInstructions({ ...conversation, format: "narrator" }), "");
  assert.match(dialogueProblem({ ...script, body: [seg([{ speaker: "jordan", text: "One." }, { speaker: "jordan", text: "Two." }])] } as Script, conversation)!, /one presenter only/);
  assert.match(dialogueProblem({ ...script, body: [seg([{ speaker: "jordan", text: "One." }, { speaker: "ghost", text: "Two." }])] } as Script, conversation)!, /unknown presenter "ghost"/);
  const drifted = { ...script, body: [{ ...script.body[0]!, voiceover: "Different words entirely." }] } as Script;
  assert.match(dialogueProblem(drifted, conversation)!, /voiceover must equal its lines/);
  assert.match(dialogueProblem({ ...script, body: [seg([{ speaker: "jordan", text: "Sam: what changed?" }, { speaker: "sam", text: "Records." }])] } as Script, conversation)!, /embeds a speaker label/);
  const pitch: Cast = { version: 1, format: "pitch", members: [{ ...host, role: "problem" }, { ...expert, role: "solution" }, { id: "lee", role: "proof", name: "Lee", voice: { engine: "kokoro", id: "bm_george" }, consent }], updatedAt: null };
  assert.match(dialogueProblem(script, pitch)!, /needs the proof presenter to speak/);
  // Narration order and speaker spans: hook and cta by the first member, each line by its own member.
  const lines = castLines(script, conversation);
  assert.deepEqual(lines.map(l => l.speaker.id), ["jordan", "jordan", "sam", "jordan"]);
  const merged = mergeLineStamps(lines.map((l, i) => ({ ...l, stamps: { durationSec: 2, engine: i === 2 ? "voicebox" as const : "kokoro" as const, words: [{ w: l.text.split(" ")[0]!, start: 0.1, end: 0.5 }] } })));
  assert.equal(merged.durationSec, 8); assert.equal(merged.words[3]!.start, 6.1); assert.equal(merged.lines![2]!.speaker, "sam"); assert.equal(merged.lines![2]!.startSec, 4); assert.equal(merged.lines![2]!.engine, "voicebox");
  assert.equal(merged.engine, "kokoro", "mixed engines fall back to the free engine label; each line keeps its own");
});
