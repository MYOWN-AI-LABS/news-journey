import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { VisualAlignmentRequired, VisualChoiceRequired, applyVisualChoices, ensureVisualCandidates, failChosenCandidate, lockVisualChoices, pendingVisualChoice, readVisualChoices, selectedSourceSnapshots, snapshotStories, storeOwnImage, unclearedVisualStories, recommendVisual } from "./visual-choice.js";
import type { StoryDiagram, Topic } from "../types.js";
import type { VisualPlan } from "./visual-plan.js";
import { critiqueAtPhoneScale, persistedVisualReleaseProblem } from "./story-diagram.js";
import { diagramSourceReceipt } from './diagram-source-support.js';
import { solidPng } from "./test-png.js";
import { createSourceSupportContext } from './source-support.js';
import { preparedScriptReceipt } from './writing-context.js';

/**
 * The pinned political-news regression from the 2026-09-09 Daily Political Beat: a story about
 * institutions and public health after the attacks had a relevant news image captured from its
 * source, yet the director chose a flow diagram whose 320px review failed (review c6649a…46b) and the
 * package still reached review. Fictional text below mirrors that shape; no private capture is used.
 */
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(96, 9)]);
// A person's own image is decoded and fitted before it is stored, so it must be a real picture (640×480 here).
const OWN_PNG = solidPng(640, 480);
const REVIEW = { status: "failed" as const, sha256: "c6649a61c00f1e532e6c8985d0bcb45bb2f0a3a89be3817755b34222ecedc46b", reason: "Both compositions avoid headline/caption overlap, but essential qualifiers are dropped: “asbestos found near Ground Zero for months,” “days after the attacks,” “including the EPA,” and “thousands” are not shown. The 320px version is also overly compressed." };
const QUALIFIERS = ["Asbestos was found near Ground Zero for months", "Records were released days after the attacks", "Agencies including the EPA are named", "Thousands of responders were affected"];

function fixture(): { dir: string; body: any[]; diagrams: StoryDiagram[]; plans: VisualPlan[] } {
  const dir = mkdtempSync(join(tmpdir(), "20260909-visual-choice-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets/og-0.png"), PNG);
  writeFileSync(join(dir, "assets.json"), JSON.stringify({ "og-0": "assets/og-0.png" }));
  writeFileSync(join(dir, "topic.json"), JSON.stringify({ id: "20260909-fixture", kind: "roundup", headline: "Fixture", stories: [
    { n: 1, headline: "Records surface as institutions face scrutiny", assetRef: "og-0", primaryUrl: "https://news.example.org/records", area: "politics and public affairs", verticals: ["government"], verifiedClaims: QUALIFIERS },
    { n: 2, headline: "How the new inference chip routes data", assetRef: "og-1", primaryUrl: "https://tech.example.org/chip", area: "hardware", verticals: ["compute"], verifiedClaims: [] },
  ] }));
  const body = [
    { onScreen: { title: "Records surface as institutions face scrutiny" }, assetRef: "og-0", voiceover: "Records surfaced.", motion: { kind: "flow", who: "Agencies", what: "Records", how: "Disclosure", impact: "Scrutiny", status: "Reported; under review" } },
    { onScreen: { title: "How the new inference chip routes data" }, assetRef: "og-1", voiceover: "Data moves.", motion: { kind: "flow", who: "Chip", what: "Data", how: "Routing", impact: "Speed", status: "Vendor claim" } },
  ];
  const svg = `<svg class="tm-story-svg tm-svg-authored" data-visual-primitive="authored-1" viewBox="0 0 720 340"><title>t</title><rect class="tm-sc-node" x="1" y="1" width="1" height="1"/></svg>`;
  const diagrams: StoryDiagram[] = [{ svg, label: "L", reading: "R", legend: [], review: REVIEW }, { svg, label: "L", reading: "R", legend: [], review: { status: "passed", sha256: "0e87ce60", reason: "Readable." } }];
  const plan = (i: number): VisualPlan => ({ version: 1, kind: "diagram", intent: body[i].onScreen.title, reason: "director", labels: ["a", "b"], cues: [], caveat: "", sourceUrl: "", decision: "model", timing: { method: "unmatched", starts: [], duration: 6 } });
  return { dir, body, diagrams, plans: [plan(0), plan(1)] };
}

test('rendered source snapshots carry the exact locked attribution and reject changed captions', () => {
  const { dir, body, diagrams } = fixture();
  try {
    const topic = JSON.parse(readFileSync(join(dir, 'topic.json'), 'utf8')); topic.id = basename(dir);
    writeFileSync(join(dir, 'topic.json'), JSON.stringify(topic));
    const candidates = ensureVisualCandidates(dir, body, diagrams, true);
    lockVisualChoices(dir, candidates, { '0': 'snapshot', '1': 'explanation' }, 'user');
    const candidate = candidates.stories[0].candidates.find(c => c.id === 'snapshot')!;
    const originalCaption = candidate.caption;
    assert.deepEqual([...selectedSourceSnapshots(dir)], [[0, { caption: candidate.caption, publisher: 'news.example.org', sourceUrl: candidate.sourceUrl }]]);
    assert.equal(body[0].onScreen.title, 'Records surface as institutions face scrutiny', 'presentation binding does not rewrite accepted script fields');
    candidate.caption = 'A different headline — news.example.org';
    writeFileSync(join(dir, 'visual-candidates.json'), JSON.stringify(candidates));
    assert.throws(() => selectedSourceSnapshots(dir), VisualChoiceRequired, 'a stored hash alone cannot approve changed displayed words');
    const copied = { ...readVisualChoices(dir), videoId: 'different-package' };
    writeFileSync(join(dir, 'visual-choices.json'), JSON.stringify(copied));
    candidate.caption = originalCaption;
    candidates.videoId = 'different-package';
    writeFileSync(join(dir, 'visual-candidates.json'), JSON.stringify(candidates));
    assert.throws(() => selectedSourceSnapshots(dir), VisualChoiceRequired, 'a copied matching pair cannot select a card for a different package');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("political news is offered its source image first; the rejected diagram is listed but unavailable, with the qualifiers preserved", () => {
  const { dir, body, diagrams } = fixture();
  try {
    const candidates = ensureVisualCandidates(dir, body, diagrams, true);
    const political = candidates.stories[0]!, technical = candidates.stories[1]!;
    assert.equal(political.beat, "news"); assert.equal(technical.beat, "technical");
    assert.deepEqual(political.candidates.map(c => c.id), ["image", "snapshot", "explanation"]);
    assert.equal(political.recommended.id, "image");
    assert.match(political.recommended.reason, /reporting image/);
    const image = political.candidates[0]!, explanation = political.candidates[2]!;
    assert.equal(image.available, true); assert.equal(image.rights, "review-only"); assert.match(image.why, /Rights are not established/);
    assert.equal(explanation.available, false); assert.match(explanation.why, /including the EPA/); assert.equal(explanation.reviewStatus, "failed");
    for (const q of QUALIFIERS) assert.ok(image.context.includes(q), "qualifiers stay attached to the visual: " + q);
    assert.equal(political.candidates[1]!.rights, "attributed"); assert.equal(political.candidates[1]!.file, undefined, "the snapshot is a text card, never the source image relabelled");
    assert.equal(technical.recommended.id, "explanation", "a reviewed mechanism diagram is the right visual for a how-it-works story");
    assert.equal(technical.candidates[0]!.available, false, "no capture for og-1");
    // The candidate gate mirrors the release gate: an unverified review counts only under the operator's critic opt-out.
    const unverified: StoryDiagram[] = [diagrams[0]!, { ...diagrams[1]!, review: { status: "unverified", sha256: "x", reason: "Phone review is disabled." } }];
    const previous = process.env.AI_CONTENT_DIAGRAM_CRITIC;
    try {
      delete process.env.AI_CONTENT_DIAGRAM_CRITIC;
      assert.equal(ensureVisualCandidates(dir, body, unverified, true).stories[1]!.candidates[2]!.available, false);
      process.env.AI_CONTENT_DIAGRAM_CRITIC = "off";
      assert.equal(ensureVisualCandidates(dir, body, unverified, true).stories[1]!.candidates[2]!.available, true);
    } finally { if (previous === undefined) delete process.env.AI_CONTENT_DIAGRAM_CRITIC; else process.env.AI_CONTENT_DIAGRAM_CRITIC = previous; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an explanation not yet authored is offered as a request; an authored passed diagram fulfils it, a failed one reopens the choice', () => {
  const { dir, body, diagrams, plans } = fixture();
  try {
    const empty: StoryDiagram = { svg: '', label: '', reading: '', legend: [] };
    const before = ensureVisualCandidates(dir, body, [empty, empty], true);
    const request = before.stories[0]!.candidates.find(c => c.id === 'explanation')!;
    assert.equal(request.available, true); assert.equal(request.pending, true); assert.match(request.why, /Not drawn yet/);
    assert.equal(before.stories[0]!.recommended.id, 'image', 'a request is never the recommendation');
    assert.equal(before.stories[1]!.recommended.id, 'snapshot', 'no photo and no drawn diagram: the card, not an undrawn request');
    lockVisualChoices(dir, before, { '0': 'explanation', '1': 'snapshot' }, 'user');
    assert.equal(readVisualChoices(dir).stories['0']!.pending, true);
    const passed: StoryDiagram = { ...diagrams[1]!, review: { status: 'passed', sha256: 'p', reason: 'Readable.' } };
    const after = ensureVisualCandidates(dir, body, [passed, empty], true);
    const result = applyVisualChoices(dir, after, plans, [passed, empty], true);
    assert.equal(result.plans[0]!.kind, 'diagram');
    const fulfilled = readVisualChoices(dir).stories['0']!;
    assert.equal(fulfilled.candidateId, 'explanation'); assert.equal(fulfilled.chosenBy, 'user'); assert.equal(fulfilled.pending, undefined);
    assert.equal(fulfilled.candidateHash, after.stories[0]!.candidates.find(c => c.id === 'explanation')!.hash, 'the request is rebound to the authored diagram');
    lockVisualChoices(dir, before, { '0': 'explanation' }, 'user');
    const failed = ensureVisualCandidates(dir, body, [diagrams[0]!, empty], true);
    assert.equal(failed.stories[0]!.candidates.find(c => c.id === 'explanation')!.available, false);
    assert.throws(() => applyVisualChoices(dir, failed, plans, [diagrams[0]!, empty], true), VisualChoiceRequired, 'a diagram that failed at phone size reopens the choice with its reason');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sports reporting recommends its captured photo without replacing a locked explanation or bypassing alignment', () => {
  const { dir, body, diagrams, plans } = fixture();
  try {
    const topic = JSON.parse(readFileSync(join(dir, 'topic.json'), 'utf8'));
    const story = topic.stories[0];
    story.headline = 'City wins the final'; story.area = 'sports'; story.verticals = ['football'];
    body[0].onScreen.title = story.headline;
    diagrams[0] = { ...diagrams[0]!, review: { status: 'passed', sha256: 'reviewed', reason: 'Readable supported explanation.' } };
    writeFileSync(join(dir, 'topic.json'), JSON.stringify(topic));
    const candidates = ensureVisualCandidates(dir, body, diagrams, true);
    assert.equal(candidates.stories[0]!.beat, 'news');
    assert.equal(candidates.stories[0]!.recommended.id, 'image');
    assert.match(candidates.stories[0]!.recommended.reason, /still needs source relevance and image review/);
    assert.equal(candidates.stories[1]!.recommended.id, 'explanation', 'the neighboring technical story keeps its explanation');
    lockVisualChoices(dir, candidates, { '0': 'explanation', '1': 'explanation' }, 'user');
    const explicit = applyVisualChoices(dir, candidates, plans, diagrams, false);
    assert.equal(explicit.plans[0]!.kind, 'diagram');
    assert.equal(readVisualChoices(dir).stories['0']!.chosenBy, 'user');
    assert.equal(readVisualChoices(dir).stories['0']!.candidateId, 'explanation', 'automatic recommendations cannot replace an explicit explanation');

    lockVisualChoices(dir, candidates, { '0': 'image' }, 'user');
    plans[0] = { ...plans[0]!, sourceConceptHash: 'a'.repeat(64) };
    assert.throws(() => applyVisualChoices(dir, candidates, plans, diagrams, false), (error: unknown) => {
      assert.ok(error instanceof VisualAlignmentRequired);
      assert.equal(error.sourceImages[0]!.sha256, candidates.stories[0]!.candidates[0]!.sha256);
      return true;
    }, 'a recommended or selected photo still needs its exact capture alignment and review');
    assert.deepEqual(unclearedVisualStories(dir), [0], 'source attribution does not grant publication rights');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sports subjects are recognized from story metadata or title, while unavailable photos fall back to reviewed explanations', () => {
  const { dir, body, diagrams } = fixture();
  try {
    const topic = JSON.parse(readFileSync(join(dir, 'topic.json'), 'utf8'));
    diagrams[0] = { ...diagrams[0]!, review: { status: 'passed', sha256: 'reviewed', reason: 'Readable supported explanation.' } };
    for (const subject of [
      { area: 'sports', verticals: [], headline: 'City wins the final' },
      { area: '', verticals: ['cricket'], headline: 'Visitors win the series' },
      { area: '', verticals: [], headline: 'Tennis final ends in three sets' },
    ]) {
      Object.assign(topic.stories[0], subject);
      writeFileSync(join(dir, 'topic.json'), JSON.stringify(topic));
      assert.equal(ensureVisualCandidates(dir, body, diagrams, true).stories[0]!.recommended.id, 'image');
    }
    writeFileSync(join(dir, 'assets.json'), '{}');
    const noCapture = ensureVisualCandidates(dir, body, diagrams, true);
    assert.equal(noCapture.stories[0]!.recommended.id, 'explanation', 'an available reviewed explanation is preferable to a text-only fallback');
    diagrams[0] = { ...diagrams[0]!, review: REVIEW };
    assert.equal(ensureVisualCandidates(dir, body, diagrams, true).stories[0]!.recommended.id, 'snapshot', 'failed artwork remains unavailable');
    assert.equal(ensureVisualCandidates(dir, body, diagrams, false).stories[0]!.recommended.id, 'snapshot', 'no vision capability is invented');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a text-only writer uses the source's own photo it cannot review; only the diagram stays disabled", async () => {
  const { dir, body, diagrams } = fixture();
  try {
    const reviewable = diagrams.map(d => ({ ...d, review: { status: "passed" as const, sha256: "reviewed", reason: "Readable." } }));
    const candidates = ensureVisualCandidates(dir, body, reviewable, false);
    // Saaket, Sep 17: just push the source image. The source's own photo attaches with attribution; the writer need not look at it.
    const image = candidates.stories[0]!.candidates.find(c => c.id === "image")!;
    assert.equal(image.available, true); assert.match(image.why, /source's own reporting photo/);
    assert.equal(candidates.stories[0]!.recommended.id, "image", "the source photo is the recommendation, not an attributed card");
    const explanation = candidates.stories[0]!.candidates.find(c => c.id === "explanation")!;
    assert.equal(explanation.available, false, "a text-only writer cannot author or review a diagram");
    assert.equal(explanation.why, "Your writer cannot look at images, so this visual cannot be checked. Choose the News snapshot, or turn on the connected-account fallback.");
    await storeOwnImage(dir, 0, body, OWN_PNG.toString("base64"));
    assert.equal(ensureVisualCandidates(dir, body, reviewable, false).stories[0]!.recommended.id, "own-image");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failing a recommended visual immediately recommends the snapshot so accepting recommendations succeeds", () => {
  const { dir, body, diagrams } = fixture();
  try {
    const candidates = ensureVisualCandidates(dir, body, diagrams, true);
    lockVisualChoices(dir, candidates, { "0": candidates.stories[0]!.recommended.id }, "recommendation");
    failChosenCandidate(dir, 0, "Labels unreadable at 320px");
    const after = JSON.parse(readFileSync(join(dir, "visual-candidates.json"), "utf8"));
    assert.equal(after.stories[0].recommended.id, "snapshot");
    assert.doesNotThrow(() => lockVisualChoices(dir, after, { "0": after.stories[0].recommended.id }, "recommendation"));
    assert.equal(readVisualChoices(dir).stories["0"]!.candidateId, "snapshot");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an HTTP 400 image-capability error makes the chosen visual unavailable instead of failed", () => {
  const { dir, body, diagrams } = fixture();
  try {
    const candidates = ensureVisualCandidates(dir, body, diagrams, true);
    lockVisualChoices(dir, candidates, { "0": "image" }, "user");
    failChosenCandidate(dir, 0, 'Ollama qwen3:8b HTTP 400: {"error":"this model does not support multimodal image input or vision"}');
    const after = JSON.parse(readFileSync(join(dir, "visual-candidates.json"), "utf8"));
    const image = after.stories[0].candidates.find((c: any) => c.id === "image");
    assert.equal(image.available, false); assert.equal(image.failed, undefined);
    assert.equal(image.why, "Your writer cannot look at images, so this visual cannot be checked. Choose the News snapshot, or turn on the connected-account fallback.");
    assert.equal(after.stories[0].recommended.id, "snapshot");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a required choice pauses production; a locked choice is hash-bound; tampering voids it; auto mode locks the recommendation", async () => {
  const { dir, body, diagrams, plans } = fixture();
  try {
    // Approval fixtures represent a current reviewed script and exact source/phone receipts.
    // The phone hash is produced by the real function; inspection/rendering alone are injected.
    const topic = JSON.parse(readFileSync(join(dir, 'topic.json'), 'utf8')) as Topic;
    topic.stories![1]!.verifiedClaims = ['The vendor describes routing data between the chip components.'];
    const writerKey = 'visual-choice-fixture', script = { body };
    writeFileSync(join(dir, 'topic.json'), JSON.stringify(topic));
    writeFileSync(join(dir, 'script.json'), JSON.stringify(script));
    writeFileSync(join(dir, 'companion-writing-receipt.json'), JSON.stringify(preparedScriptReceipt(topic, writerKey, script)));
    const sourced = diagrams.map((diagram, index) => ({ ...diagram, sourceReview: diagramSourceReceipt(diagram, {
      claims: topic.stories![index]!.verifiedClaims!, sourceContext: createSourceSupportContext('2026-09-09', topic.stories![index]!.primaryUrl, []), writerKey, presentation: body[index],
    }) }));
    const checked = await critiqueAtPhoneScale(dir, body, sourced,
      async () => { throw new Error('Passing inspection fixture never requests new artwork'); },
      async () => ({ passed: true, reason: 'Injected inspection of the exact current composition.' }) as any, async () => 'unused.png');
    diagrams.splice(0, diagrams.length, ...checked);
    diagrams[0]!.review = { ...checked[0]!.review!, status: 'failed', reason: REVIEW.reason };
    const candidates = ensureVisualCandidates(dir, body, diagrams, true);
    assert.throws(() => applyVisualChoices(dir, candidates, plans, diagrams, true), (e: unknown) => e instanceof VisualChoiceRequired && e.stories.length === 2 && /stories 1, 2/.test((e as Error).message));
    assert.throws(() => lockVisualChoices(dir, candidates, { "0": "explanation" }, "user"), /not available/);
    lockVisualChoices(dir, candidates, { "0": "image", "1": "explanation" }, "user");
    assert.deepEqual(pendingVisualChoice(dir), []);
    // Attribution is not clearance: a locked source photo can be previewed but blocks approval; the explanation does not.
    assert.deepEqual(unclearedVisualStories(dir), [0]);
    const applied = applyVisualChoices(dir, candidates, plans, diagrams, true);
    assert.equal(applied.plans[0]!.kind, "source"); assert.equal(applied.plans[0]!.image?.sha256, candidates.stories[0]!.candidates[0]!.sha256);
    assert.match(applied.plans[0]!.caveat, /rights review needed/); assert.equal(applied.plans[0]!.reason, "Chosen by you.");
    assert.equal(applied.plans[1]!.kind, "diagram");
    assert.deepEqual(applied.plans[0]!.evidence?.claims, candidates.stories[0]!.candidates[0]!.context, "source review uses pinned story context, never renderer-demo evidence");
    plans[0]!.evidence = { narration: "The original narration", mechanism: "Reported mechanism", claims: ["A verified claim"] };
    assert.deepEqual(applyVisualChoices(dir, candidates, plans, diagrams, true).plans[0]!.evidence, plans[0]!.evidence);
    // Tampering with the chosen image changes its hash: the choice is void and production pauses again.
    writeFileSync(join(dir, "assets/og-0.png"), Buffer.concat([PNG, Buffer.from([1])]));
    const refreshed = ensureVisualCandidates(dir, body, diagrams, true);
    assert.deepEqual(pendingVisualChoice(dir), [0]);
    assert.throws(() => applyVisualChoices(dir, refreshed, plans, diagrams, true), VisualChoiceRequired);
    // Without a required choice (developer CLI or "Use recommendations automatically") the recommendation is locked and recorded as such.
    const auto = applyVisualChoices(dir, refreshed, plans, diagrams, false);
    assert.equal(readVisualChoices(dir).stories["0"]!.chosenBy, "recommendation"); assert.equal(auto.plans[0]!.kind, "source"); assert.match(auto.plans[0]!.reason, /^Recommended: /);
    // A chosen visual that fails pixel QA is marked and cannot be chosen again; the story returns to choice.
    failChosenCandidate(dir, 0, "Labels unreadable at 320px");
    const after = ensureVisualCandidates(dir, body, diagrams, true);
    assert.match(after.stories[0]!.candidates[0]!.failed!, /320px/);
    assert.equal(after.stories[0]!.recommended.id, "snapshot", "the recommendation moves to the next honest candidate");
    assert.throws(() => lockVisualChoices(dir, after, { "0": "image" }, "user"), /failed its check/);
    // A user-owned image becomes its own candidate and the recommendation.
    await storeOwnImage(dir, 0, body, OWN_PNG.toString("base64"));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "assets/og-0-own.png.json"), "utf8")), { width: 640, height: 480, resized: false, uploadedBytes: OWN_PNG.length, storedBytes: JSON.parse(readFileSync(join(dir, "assets/og-0-own.png.json"), "utf8")).storedBytes }, "the stored image records its fitted size");
    const own = ensureVisualCandidates(dir, body, diagrams, true);
    assert.equal(own.stories[0]!.candidates.at(-1)!.id, "own-image"); assert.equal(own.stories[0]!.candidates.at(-1)!.rights, "user-owned"); assert.equal(own.stories[0]!.recommended.id, "own-image");
    assert.equal(JSON.parse(readFileSync(join(dir, "assets.json"), "utf8"))["og-0-own"], "assets/og-0-own.png");
    // A snapshot without an image drops the diagram entirely, so a rejected diagram can never ship behind it.
    lockVisualChoices(dir, own, { "0": "snapshot" }, "user");
    assert.deepEqual(unclearedVisualStories(dir), [], "an attributed text card or the person's own image is cleared to approve");
    const snapshot = applyVisualChoices(dir, own, plans, diagrams, true);
    assert.equal(snapshot.plans[0]!.kind, "diagram"); assert.equal(snapshot.diagrams[0]!.svg, "", "a snapshot is the headline card: no image, no diagram");
    await assert.rejects(storeOwnImage(dir, 0, body, Buffer.from("GIF89a").toString("base64")), /PNG or JPEG/);
    await assert.rejects(storeOwnImage(dir, 0, body, PNG.toString("base64")), /could not be read as a PNG/, "a PNG header over junk is not an image");
    await assert.rejects(storeOwnImage(dir, 0, body, solidPng(320, 320).toString("base64")), /at least 480 px wide/, "too small for the video frame");
    // Approval reads the locked choice: a story shown as a snapshot is not judged by its unused, rejected diagram —
    // and a voided choice makes the diagram's verdict count again.
    writeFileSync(join(dir, "diagrams.json"), JSON.stringify(diagrams));
    assert.equal(persistedVisualReleaseProblem(dir), null);
    // An image-backed choice is bound to its bytes: tampering voids it and the diagram's verdict counts again.
    lockVisualChoices(dir, own, { "0": "own-image" }, "user");
    assert.equal(persistedVisualReleaseProblem(dir), null);
    writeFileSync(join(dir, "assets/og-0-own.png"), Buffer.concat([PNG, Buffer.from([2, 3])]));
    const voided = ensureVisualCandidates(dir, body, diagrams, true);
    assert.match(persistedVisualReleaseProblem(dir)!, /Story 1 visual did not pass/);
    // When every candidate has failed, nothing is recommended as choosable and production is not thrown into failed:visuals.
    lockVisualChoices(dir, voided, { "0": "snapshot" }, "user"); failChosenCandidate(dir, 0, "Card unreadable at 320px");
    const afterSnapshot = ensureVisualCandidates(dir, body, diagrams, true);
    assert.equal(afterSnapshot.stories[0]!.recommended.id, "own-image", "the recommendation moves to the last usable candidate");
    lockVisualChoices(dir, afterSnapshot, { "0": "own-image" }, "user"); failChosenCandidate(dir, 0, "Blurry");
    const none = ensureVisualCandidates(dir, body, diagrams, true);
    assert.ok(none.stories[0]!.candidates.every(c => !c.available || c.failed));
    assert.deepEqual(pendingVisualChoice(dir), [], "a story with nothing usable is never reported as pending");
    assert.doesNotThrow(() => applyVisualChoices(dir, none, plans, diagrams, false));
    assert.doesNotThrow(() => applyVisualChoices(dir, none, plans, diagrams, true), "nothing usable means nothing to choose; the director's plan stands and the gate judges it");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a story whose locked choice is the snapshot is reported so the render drops its source image (Civic Signal, 2026-09-10)", () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-stories-"));
  try {
    assert.deepEqual([...snapshotStories(dir)], []);
    writeFileSync(join(dir, "visual-choices.json"), JSON.stringify({ version: 1, videoId: "v", stories: {
      "0": { candidateId: "image", candidateHash: "a", chosenBy: "user", at: "2026-09-10T00:00:00Z" },
      "3": { candidateId: "snapshot", candidateHash: "b", chosenBy: "user", at: "2026-09-10T00:00:00Z" },
    } }));
    assert.deepEqual([...snapshotStories(dir)], [3]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a rendered source photo blocks approval even when the choice metadata is missing or garbled (Codex review)", () => {
  const dir = mkdtempSync(join(tmpdir(), "visual-rights-"));
  try {
    writeFileSync(join(dir, "visual-choices.json"), "{ not json");
    writeFileSync(join(dir, "visual-results.json"), JSON.stringify([{ kind: "source", image: { file: "assets/og-0.png" } }, { kind: "diagram" }]));
    assert.deepEqual(unclearedVisualStories(dir), [0], "what was rendered decides too");
    writeFileSync(join(dir, "visual-results.json"), JSON.stringify([{ kind: "source", image: { file: "assets/og-0-own.png" } }]));
    assert.deepEqual(unclearedVisualStories(dir), [], "the person's own upload is cleared");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("automated mode never recommends a review-only source photograph; it falls to the explanation or the headline card", () => {
  const base = { available: true, sourceUrl: "https://example.org/a", publisher: "example.org", caption: "t", context: [], hash: "h" };
  const photo = { ...base, id: "image" as const, label: "News image", why: "", rights: "review-only" as const, file: "assets/og-0.png", sha256: "a".repeat(64) };
  const card = { ...base, id: "snapshot" as const, label: "News snapshot", why: "", rights: "attributed" as const };
  const diagram = { ...base, id: "explanation" as const, label: "Explanation", why: "", rights: "attributed" as const };
  assert.equal(recommendVisual("news", [photo, card]).id, "image");
  assert.equal(recommendVisual("news", [photo, card], true).id, "snapshot");
  assert.equal(recommendVisual("news", [photo, diagram, card], true).id, "explanation");
  const own = { ...base, id: "own-image" as const, label: "Your image", why: "", rights: "user-owned" as const, file: "assets/og-0-own.png", sha256: "b".repeat(64) };
  assert.equal(recommendVisual("news", [photo, own, card], true).id, "own-image");
});
