import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QUALIFICATION_SLATE, qualifyModel, summarizeQualification, type QualificationCall } from "./qualification.js";
import { isLocalRuntime, localQualification, readQualifications } from "./qualification-state.js";
import { effectiveVideoWordBudget } from '../personalization.js';
import { releaseProfile } from '../release-profile.js';
import { syntheticPassingFactualResponse } from '../pipeline/factual-obligations.test-fixture.js';

/** A writer that answers each stage correctly, with a knob to break one stage the way the September 9 local models did. */
function writer(overrides: { scriptWords?: number; area?: string; duplicateUrl?: boolean } = {}): QualificationCall {
  const motion = { kind: "flow", who: "The council", what: "Records release", how: "A 6–3 vote ordered release", impact: "Responder health data becomes public", status: "Some records remain sealed" };
  const sentence = "The council voted six to three to release the responder health records after the March plant fire and the county health office said its review takes weeks.";
  // Unique filler words keep every cue phrase unique in its narration, as a real script would.
  const voiceover = (target: number) => { const out = sentence.split(" "); let n = 0; while (out.length < target) out.push(`detail${++n}`); return out.join(" ").replace(/[.!?]$/, '') + '.'; };
  return (async (prompt: string, validate: (parsed: any) => string | null) => {
    const focused = syntheticPassingFactualResponse(prompt);
    if (focused !== undefined) { assert.equal(validate(focused), null); return focused; }
    let value: unknown;
    if (prompt.startsWith('AUTHORED FIELD SOURCE REVIEW')) value = { fields: (JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!) as { id: string }[]).map(row => ({ id: row.id, supported: true, claimIds: [1], reason: 'Injected structural qualification review; no real factual quality claim.' })) };
    else if (prompt.startsWith('SOURCE SUPPORT REVIEW')) value = { sentences: (JSON.parse(prompt.match(/DRAFT_SENTENCES: (.*)/)![1]!) as { id: number }[]).map(row => ({ id: row.id, supported: true, claimIds: [1], reason: 'Simulated direct source support.' })) };
    else if (prompt.includes("CANDIDATES:")) value = { stories: QUALIFICATION_SLATE.map((c, i) => ({ headline: c.headline, primaryUrl: overrides.duplicateUrl ? QUALIFICATION_SLATE[0].primaryUrl : c.primaryUrl, principalEntity: ["City council", "Router library", "University lab"][i], area: overrides.area ?? "general", verticals: ["general"], weight: i === 0 ? "lead" : "standard", suggestedScene: "news_card" })) };
    else if (prompt.includes("You are the publication visual director")) value = { kind: "diagram", intent: "How the records release unfolded", reason: "The vote and the sealed records are a sequence.", labels: ["Council vote", "Sealed records"], cues: ["The council voted", "county health office"], caveat: "Some records remain sealed" };
    else if (prompt.includes('STAGED ROUNDUP: FRAMING')) value = { hook: 'Three stories worth understanding.', cta: 'Subscribe for sourced reporting.' };
    else if (prompt.includes('FOCUSED TEXT EDIT')) {
      // The deliberately out-of-budget writer repeats its rejected text instead of repairing it.
      // Exercise the real no-progress/repetition gate, without turning a failed writer into a pass.
      value = { replacement: JSON.parse(prompt.match(/REPLACE: (.*)/)![1]!) || JSON.parse(prompt.match(/LOCKED_BEFORE: (.*)/)![1]!) };
    }
    else if (prompt.includes('STAGED ROUNDUP: NARRATION')) {
      const { min, max } = JSON.parse(prompt.match(/NARRATION_TARGET: (.*)/)![1]!);
      const target = overrides.scriptWords ? Math.floor((overrides.scriptWords - 8) * (prompt.includes('The council voted 6–3') ? 0.4445 : 0.2778)) : Math.round((min + max) / 2);
      value = { voiceover: voiceover(target) };
    }
    else if (prompt.includes('STAGED ROUNDUP: CARD')) value = { title: 'Records release process', motion };
    else if (prompt.includes('STAGED ROUNDUP: PUBLISH')) value = { title: 'Records, routers and a preprint', linkedinPost: 'Today’s sourced roundup.', description: 'Three sourced stories.', hashtags: [] };
    else throw new Error('Unexpected qualification task');
    const problem = validate(value);
    if (problem) throw new Error(`failed after retry: ${problem}`);
    return value;
  }) as QualificationCall;
}

test("a local model is qualified only after two clean attempts inside the ceiling, and the record is durable per profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-"));
  try {
    mkdirSync(join(root, "state"));
    const runtime = { provider: "ollama", model: "qwen3-fixture:8b", baseUrl: "http://127.0.0.1:11434/v1" };
    assert.equal(localQualification(root, runtime.provider, runtime.model, runtime.baseUrl)!.qualified, false);
    assert.match(localQualification(root, runtime.provider, runtime.model, runtime.baseUrl)!.reason, /not been through the editorial check/);
    assert.doesNotMatch(localQualification(root, runtime.provider, runtime.model, runtime.baseUrl)!.reason, /npm run|developer/, 'the executive page names no command');
    const record = await qualifyModel(root, runtime, writer(), { ceilingSeconds: 600 });
    assert.equal(record.qualified, true, summarizeQualification(record)); assert.equal(record.attempts.length, 2); assert.ok(record.attempts.every(a => a.passed));
    assert.equal(record.attempts[0]!.stages.script.words! >= 200 && record.attempts[0]!.stages.script.words! <= 225, true);
    assert.equal(Object.keys(readQualifications(root)).length, 1);
    const status = localQualification(root, runtime.provider, runtime.model, runtime.baseUrl)!;
    assert.equal(status.qualified, false); assert.match(status.reason, /exact model, runtime and context/);
    assert.equal(localQualification(root, "ollama", "another-model:7b", runtime.baseUrl)!.qualified, false, "qualification is per exact model");
    assert.match(summarizeQualification(record), /QUALIFIED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("out-of-budget scripts fail while unknown labels recover through the configured default catch-all", async () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-"));
  try {
    mkdirSync(join(root, "state"));
    const runtime = { provider: "ollama", model: "qwen2.5-coder:7b", baseUrl: "http://127.0.0.1:11434/v1" };
    const long = await qualifyModel(root, runtime, writer({ scriptWords: 290 }));
    assert.equal(long.qualified, false); assert.equal(long.attempts.length, 1, "a failed attempt ends the run; no second full run is billed");
    assert.equal(long.attempts[0]!.stages.classification.ok, true); assert.equal(long.attempts[0]!.stages.script.ok, false);
    assert.match(long.attempts[0]!.stages.script.reason!, /did not improve the measured length/);
    assert.equal(long.attempts[0]!.stages.visualPlan.reason, "not reached");
    assert.match(localQualification(root, runtime.provider, runtime.model, runtime.baseUrl)!.reason, /earlier editorial result/, 'unmatched failed receipts are historical too');
    const misclassified = await qualifyModel(root, { ...runtime, model: "qwen3-opencode:8b" }, writer({ area: "medium" }));
    assert.equal(misclassified.qualified, true); assert.equal(misclassified.attempts[0]!.stages.classification.ok, true);
    await assert.rejects(qualifyModel(root, runtime, writer(), { ceilingSeconds: 0 }), /positive/);
    await assert.rejects(qualifyModel(root, runtime, writer(), { attempts: 0 }), /integer/);
    assert.equal(Object.keys(readQualifications(root)).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('qualification honors saved Standard video length and expires when that choice changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qualify-personalized-'));
  const runtime = { provider: 'ollama', model: 'local-fixture', baseUrl: 'http://127.0.0.1:11434/v1' };
  try {
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config/pipeline.json'), JSON.stringify({ roundup: { wordBudget: { min: 200, max: 225 } } }));
    writeFileSync(join(root, 'config/personalization.json'), JSON.stringify({ videoLength: 'standard' }));
    if (releaseProfile().edition === 'free') {
      assert.deepEqual(effectiveVideoWordBudget(root), { min: 200, max: 225 }, 'Free ignores copied Pro personalization');
      const standard = await qualifyModel(root, runtime, writer());
      assert.equal(standard.qualified, true, summarizeQualification(standard));
      writeFileSync(join(root, 'config/personalization.json'), JSON.stringify({ videoLength: 'deep' }));
      assert.deepEqual(effectiveVideoWordBudget(root), { min: 200, max: 225 });
      const deep = await qualifyModel(root, runtime, writer());
      assert.equal(deep.qualified, true, summarizeQualification(deep));
      assert.equal(deep.key, standard.key, 'ignored personalization cannot change the Free qualification profile');
      return;
    }
    const result = await qualifyModel(root, runtime, writer({ scriptWords: 161 }));
    assert.equal(result.qualified, true, summarizeQualification(result));
    assert.equal(localQualification(root, runtime.provider, runtime.model, runtime.baseUrl)!.qualified, false, "a structural receipt without current model identity cannot imply current readiness");
    writeFileSync(join(root, 'config/personalization.json'), JSON.stringify({ videoLength: 'deep' }));
    assert.equal(localQualification(root, runtime.provider, runtime.model, runtime.baseUrl)!.qualified, false);
    const deep = await qualifyModel(root, runtime, writer({ scriptWords: 161 }));
    assert.equal(deep.qualified, false); assert.match(deep.attempts[0]!.stages.script.reason!, /repeats a sentence/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only Ollama or a loopback OpenAI-compatible endpoint counts as local", () => {
  assert.equal(isLocalRuntime("ollama"), true);
  assert.equal(isLocalRuntime("openai-compatible", "http://127.0.0.1:8000/v1"), true);
  assert.equal(isLocalRuntime("openai-compatible", "http://localhost:8000/v1"), true);
  assert.equal(isLocalRuntime("openai-compatible", "https://api.example.com/v1"), false);
  assert.equal(isLocalRuntime("claude"), false);
  assert.equal(isLocalRuntime("opencode", "http://127.0.0.1:11434/v1", "ollama/qwen2.5:7b"), true);
  assert.equal(isLocalRuntime("opencode", undefined, "ollama/qwen2.5:7b"), true);
  assert.equal(isLocalRuntime("opencode", undefined, "opencode/example-free"), false);
  assert.equal(isLocalRuntime("opencode", undefined, "ollama/example:cloud"), false);
  assert.equal(isLocalRuntime("opencode", "https://remote.example/v1", "ollama/qwen2.5:7b"), false);
  assert.equal(isLocalRuntime("opencode", undefined, ""), false);
  assert.equal(isLocalRuntime("opencode", undefined, "ollama/"), false);
  assert.equal(localQualification("/nonexistent", "claude", "", ""), null);
});

test('duplicate source URLs cannot pass classification under invented distinct entities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qualify-source-'));
  try {
    const result = await qualifyModel(root, { provider: 'ollama', model: 'fixture' }, writer({ duplicateUrl: true }));
    assert.equal(result.qualified, false);
    assert.match(result.attempts[0]!.stages.classification.reason!, /each fixture URL exactly once/);
    assert.equal(result.attempts[0]!.stages.script.reason, 'not reached');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('daily edition budget is used for qualification; explicit edition and personalized choices take precedence', () => {
  const root = mkdtempSync(join(tmpdir(), 'qualify-edition-'));
  try {
    mkdirSync(join(root, 'config/editions'), { recursive: true });
    writeFileSync(join(root, 'config/pipeline.json'), JSON.stringify({ roundup: { wordBudget: { min: 200, max: 225 } } }));
    writeFileSync(join(root, 'config/editions/daily-roundup.json'), JSON.stringify({ wordBudget: { min: 250, max: 300 } }));
    assert.deepEqual(effectiveVideoWordBudget(root), { min: 250, max: 300 });
    assert.deepEqual(effectiveVideoWordBudget(root, null), { min: 200, max: 225 });
    assert.deepEqual(effectiveVideoWordBudget(root, { min: 300, max: 400 }), { min: 300, max: 400 });
    writeFileSync(join(root, 'config/personalization.json'), JSON.stringify({ videoLength: 'standard' }));
    assert.deepEqual(effectiveVideoWordBudget(root, { min: 300, max: 400 }), releaseProfile().edition === 'free' ? { min: 300, max: 400 } : { min: 150, max: 225 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a diagnostic attempt never qualifies, settings changes invalidate success, and stages stop at the deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "qualify-settings-"));
  const runtime = { provider: "ollama", model: "test:8b", baseUrl: "http://127.0.0.1:11434/v1" };
  try {
    const diagnostic = await qualifyModel(root, runtime, writer(), { attempts: 1 });
    assert.equal(diagnostic.qualified, false);
    await qualifyModel(root, runtime, writer());
    assert.equal(localQualification(root, runtime.provider, runtime.model, runtime.baseUrl)!.qualified, false, "a structural receipt without current model identity cannot imply current readiness");
    await qualifyModel(root, { ...runtime, timeoutMs: 90000 }, writer());
    assert.equal(localQualification(root, runtime.provider, runtime.model, runtime.baseUrl, { timeoutMs: 90000 })!.qualified, false);
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config/model.json"), JSON.stringify({ providers: { ollama: { reasoningEffort: "none" } } }));
    assert.equal(localQualification(root, runtime.provider, runtime.model, runtime.baseUrl)!.qualified, false);
    let calls = 0;
    const correct = writer();
    const result = await qualifyModel(root, runtime, async (prompt, validate, deadline) => {
      calls++; assert.ok(deadline! > Date.now());
      await new Promise(resolve => setTimeout(resolve, 30));
      return correct(prompt, validate);
    }, { ceilingSeconds: 0.01 });
    assert.equal(result.qualified, false); assert.equal(calls, 1);
    assert.match(result.attempts[0]!.stages.script.reason!, /ceiling/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Ollama cloud and remote endpoints are not local hardware results", () => {
  assert.equal(isLocalRuntime("ollama", "http://127.0.0.1:11434/v1", "gpt-oss:120b-cloud"), false);
  assert.equal(isLocalRuntime("ollama", "http://127.0.0.1:11434/v1", "example:cloud"), false);
  assert.equal(isLocalRuntime("ollama", "https://ollama.com/v1", "example:8b"), false);
});


test('current pass and failure receipts require the same measured model identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qualification-identity-'));
  const runtime = { provider: 'ollama', model: 'writer:7b', baseUrl: 'http://127.0.0.1:11434/v1' };
  const identity = { ...runtime, digest: 'a'.repeat(64), context: { mode: 'requested' as const, tokens: 8192, proof: 'request' as const }, runtimeVersion: '0.12.0', hardwareFingerprint: 'b'.repeat(64), protocolVersion: 1 };
  try {
    mkdirSync(join(root, 'state'));
    const record = await qualifyModel(root, runtime, writer());
    writeFileSync(join(root, 'state/model-qualification.json'), JSON.stringify({ [record.key]: { ...record, identity } }));
    assert.equal(localQualification(root, runtime.provider, runtime.model, runtime.baseUrl, { identity })!.qualified, true);
    writeFileSync(join(root, 'state/model-qualification.json'), JSON.stringify({ [record.key]: { ...record, identity, version: 6 } }));
    assert.match(localQualification(root, runtime.provider, runtime.model, runtime.baseUrl, { identity })!.reason, /earlier version of the editorial check/);
    writeFileSync(join(root, 'state/model-qualification.json'), JSON.stringify({ [record.key]: { ...record, identity } }));
    assert.match(localQualification(root, runtime.provider, runtime.model, runtime.baseUrl, { identity: { ...identity, digest: 'c'.repeat(64) } })!.reason, /earlier editorial result/);
    writeFileSync(join(root, 'state/model-qualification.json'), JSON.stringify({ [record.key]: { ...record, identity, qualified: false } }));
    assert.match(localQualification(root, runtime.provider, runtime.model, runtime.baseUrl, { identity })!.reason, /did not pass/);
    assert.match(localQualification(root, runtime.provider, runtime.model, runtime.baseUrl, { identity: { ...identity, runtimeVersion: '0.13.0' } })!.reason, /earlier editorial result/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
