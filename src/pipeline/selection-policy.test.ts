// Run: npx tsx --test src/pipeline/selection-policy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalEntityForText,
  duplicatePrincipalEntity,
  isVendorPromotionalText,
  resolveSelectionAreas,
  selectionClassificationProblem,
  selectionEvidenceProblem,
  selectionPolicy,
} from "./selection-policy.js";

const AREAS = {
  mission: "Cover clinical imaging research.",
  focusAreas: ["imaging", "diagnostics"],
  verticals: ["health", "research"],
};

test('classification canonicalizes harmless label formatting without accepting unknown or ambiguous labels', () => {
  const story = { principalEntity: 'Example', area: ' IMAGING ', verticals: [' Health '] };
  assert.equal(selectionClassificationProblem(story, AREAS), null);
  assert.deepEqual(story, { principalEntity: 'Example', area: 'imaging', verticals: ['health'] });
  for (const vertical of ['', null, 'unknown']) assert.match(selectionClassificationProblem({ ...story, verticals: [vertical as string] }, AREAS)!, /invalid vertical/);
  assert.match(selectionClassificationProblem({ ...story, area: ' ImAgInG ' }, { ...AREAS, focusAreas: ['imaging', 'IMAGING'] })!, /invalid area/);
  assert.match(selectionClassificationProblem({ ...story, area: 'unknown' }, AREAS)!, /invalid area/);
  // a beta tester: an unknown category must recover locally when the operator supplied a catch-all.
  const civic = { mission: "Cover local government.", focusAreas: ["housing", "transit", "other"], verticals: ["residents", "other"] };
  const recovered = { ...story, area: 'politics', verticals: ['voters'], classificationNotes: ['fake model note'] };
  assert.equal(selectionClassificationProblem(recovered, civic), null);
  assert.equal(recovered.area, 'other'); assert.deepEqual(recovered.verticals, ['other']);
  assert.equal(recovered.classificationNotes.length, 2); assert.match(recovered.classificationNotes[0]!, /politics.*catch-all/);
  assert.equal(selectionClassificationProblem(recovered, civic), null);
  assert.equal(recovered.classificationNotes.length, 2, 'revalidation does not duplicate notes');
  assert.doesNotMatch(selectionClassificationProblem({ ...story, area: 'unknown' }, AREAS)!, /when none fits/, 'no catch-all offered where the vocabulary has none');
});

test('classifier repairs local-model label shapes without changing a strict vocabulary or accepting missing entities', () => {
  const civic = { focusAreas: ['public health', 'other'], verticals: ['residents', 'other'] };
  const formatted = { principalEntity: 'Council', area: 'PUBLIC_HEALTH', verticals: [' Residents ', 'RESIDENTS'] };
  assert.equal(selectionClassificationProblem(formatted, civic), null);
  assert.equal(formatted.area, 'public health'); assert.deepEqual(formatted.verticals, ['residents']);
  const missing = { principalEntity: 'Council' };
  assert.equal(selectionClassificationProblem(missing, civic), null);
  assert.match(selectionClassificationProblem({ area: 'politics' }, civic)!, /principalEntity/);
  assert.match(selectionClassificationProblem({ principalEntity: 'Council', area: 'AI_POLICY', verticals: ['residents'] }, { ...civic, focusAreas: ['AI Policy', 'AI-Policy', 'other'] })!, /invalid area/);
  assert.deepEqual(civic.focusAreas, ['public health', 'other']);
});

test("the operator's mission and vocabulary reach the prompt verbatim", () => {
  const policy = selectionPolicy(AREAS);
  assert.match(policy, /MISSION: Cover clinical imaging research\./);
  assert.match(policy, /exactly one of: imaging, diagnostics/);
  assert.match(policy, /one or more of: health, research/);
});

/**
 * The point of the harness: nothing about one operator's beat may survive in the shipped code. If a
 * previous operator's subject leaks into the default policy, every other operator's stories are
 * ranked against the wrong mission — silently, because the output still looks well-formed.
 */
test("no subject area is baked in when the operator configures nothing", () => {
  const policy = selectionPolicy(undefined);
  for (const leaked of ["edge", "physical ai", "space", "quantum", "biotech", "retail", "federal"]) {
    assert.ok(
      !new RegExp(`\\b${leaked}\\b`, "i").test(policy),
      `default policy must not mention "${leaked}"`
    );
  }
});

test("an unconfigured harness still gets a usable vocabulary rather than an error", () => {
  const resolved = resolveSelectionAreas(undefined);
  assert.deepEqual(resolved.focusAreas, ["general"]);
  assert.deepEqual(resolved.verticals, ["general"]);
  assert.ok(resolved.mission.length > 0);
});

test("blank and whitespace entries fall back instead of producing an empty vocabulary", () => {
  const resolved = resolveSelectionAreas({ focusAreas: ["  ", ""], verticals: [] });
  assert.deepEqual(resolved.focusAreas, ["general"]);
  assert.deepEqual(resolved.verticals, ["general"]);
});

test("classification is validated against the OPERATOR'S vocabulary, not a fixed one", () => {
  const ok = { principalEntity: "Acme", area: "imaging", verticals: ["health"] };
  assert.equal(selectionClassificationProblem(ok, AREAS), null);

  // Valid in the engine's hardcoded world, invalid here — which is the whole point.
  const wrong = { principalEntity: "Acme", area: "quantum", verticals: ["health"] };
  assert.match(String(selectionClassificationProblem(wrong, AREAS)), /invalid area "quantum"/);

  const badVertical = { principalEntity: "Acme", area: "imaging", verticals: ["finance"] };
  assert.match(String(selectionClassificationProblem(badVertical, AREAS)), /invalid vertical "finance"/);

  const noEntity = { area: "imaging", verticals: ["health"] };
  assert.match(String(selectionClassificationProblem(noEntity, AREAS)), /principalEntity/);
});

test("one story per principal entity, even when the name is dressed differently", () => {
  assert.equal(canonicalEntityForText("Acme Labs"), canonicalEntityForText("Acme, Inc."));
  const dupe = duplicatePrincipalEntity([
    { principalEntity: "Acme Research" },
    { principalEntity: "Beta Corp" },
    { principalEntity: "Acme Technologies" },
  ]);
  assert.equal(dupe, "acme");
  assert.equal(
    duplicatePrincipalEntity([{ principalEntity: "Acme" }, { principalEntity: "Beta" }]),
    null
  );
});

test("vendor marketing is recognized; a technical release is not", () => {
  assert.ok(isVendorPromotionalText("A customer story: how Acme boosts productivity"));
  assert.ok(isVendorPromotionalText("Case study: improving work quality"));
  assert.ok(!isVendorPromotionalText("Acme releases a 3B parameter model with benchmarks"));
});

test("community interest and maturity must stay separate and source-backed", () => {
  const good = {
    communityInterest: { status: "observed" as const, evidence: "412 points, 180 comments" },
    maturity: { status: "preprint" as const, evidence: "posted to a preprint server, not peer reviewed" },
  };
  assert.equal(selectionEvidenceProblem(good), null);
  assert.match(String(selectionEvidenceProblem(undefined)), /separate communityInterest and maturity/);

  const emptyObserved = { ...good, communityInterest: { status: "observed" as const, evidence: "  " } };
  assert.match(String(selectionEvidenceProblem(emptyObserved)), /needs source-backed evidence/);
});

/**
 * A sentence in an absent-evidence field IS an invented metric — the exact failure the split exists
 * to prevent — so `not-provided` must carry null, not a plausible description.
 */
test("not-provided community interest may not carry a description", () => {
  const invented = {
    communityInterest: { status: "not-provided" as const, evidence: "seems widely discussed" },
    maturity: { status: "repository" as const, evidence: "public repository" },
  };
  assert.match(String(selectionEvidenceProblem(invented)), /must use null evidence/);
});

test("a preprint-only candidate cannot claim peer review or community evidence", () => {
  const overclaim = {
    communityInterest: { status: "not-provided" as const, evidence: null },
    maturity: { status: "peer-reviewed" as const, evidence: "listed on a preprint server" },
  };
  assert.match(String(selectionEvidenceProblem(overclaim, { preprintOnly: true })), /must be labeled preprint/);

  const fine = {
    communityInterest: { status: "not-provided" as const, evidence: null },
    maturity: { status: "preprint" as const, evidence: "preprint server listing" },
  };
  assert.equal(selectionEvidenceProblem(fine, { preprintOnly: true }), null);
});
