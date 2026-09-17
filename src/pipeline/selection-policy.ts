import type { SelectionAreas, StorySelectionEvidence } from "../types.js";

/** Operator vocabulary and source-evidence validation shared by content workflows. */

/** Evidence-maturity vocabulary. Fixed: these describe HOW a claim is established, not what it is about. */
export const MATURITY = [
  "peer-reviewed",
  "preprint",
  "published-report",
  "established-news-reporting",
  "official-technical-release",
  "repository",
  "announcement",
] as const;

/** Used when the operator has not configured areas — every story lands in one bucket. */
export const DEFAULT_AREA = "general";
/** Used when the operator has not configured verticals. */
export const DEFAULT_VERTICAL = "general";

/**
 * Resolve the client's configured areas/verticals, always leaving a usable vocabulary.
 *
 * An operator who configures nothing still gets a working pipeline — one area, one vertical — rather
 * than a validation error on every story. Configuring areas is how you get a focused publication;
 * not configuring them is how you get a general one. Both are legitimate.
 */
export function resolveSelectionAreas(areas?: SelectionAreas): Required<SelectionAreas> {
  const clean = (values: string[] | undefined, fallback: string): string[] => {
    const kept = (values ?? []).map((value) => value.trim()).filter(Boolean);
    return kept.length > 0 ? kept : [fallback];
  };
  return {
    mission: areas?.mission?.trim() || "Find the strongest verifiable stories from the configured sources.",
    focusAreas: clean(areas?.focusAreas, DEFAULT_AREA),
    verticals: clean(areas?.verticals, DEFAULT_VERTICAL),
  };
}

/**
 * The policy block interpolated into every selection prompt.
 *
 * The mission and the vocabularies are the operator's; the evidence rules are not. Keeping both in
 * ONE string matters: the classification the model returns is validated against exactly the
 * vocabulary this text showed it, so the two can never drift.
 */
export function selectionPolicy(areas?: SelectionAreas): string {
  const { mission, focusAreas, verticals } = resolveSelectionAreas(areas);
  return `SELECTION POLICY
MISSION: ${mission}

FOCUS AREAS — classify every story into exactly one of: ${focusAreas.join(", ")}.
IMPACT VERTICALS — tag every story with one or more of: ${verticals.join(", ")}.
Use ONLY these values. If a story does not fit the configured areas, do not stretch it to fit —
leave it unselected and pick a story that does.
${classificationCatchAll(focusAreas) ? `For an uncertain focus label use "${classificationCatchAll(focusAreas)}"; never invent a new label.` : ""}
${classificationCatchAll(verticals) ? `For an uncertain impact label use "${classificationCatchAll(verticals)}"; never invent a new label.` : ""}
An uncertain label is not evidence that a story is relevant: the mission and source checks still apply.

EVIDENCE RULES:
- Follow the operator's explicit story order and priorities. Never add private ranking weights or source preferences.
- Preserve separate events involving the same company or topic. Shared keywords or organizations are not duplicates.
- Never invent votes, stars, discussion counts, peer review or other source facts.
- Verify what the captured sources actually establish before writing. Unreadable or unverifiable stories need replacement before writing.
- Topic labels do not substitute for source evidence.`;
}

const PROMOTIONAL_TEXT_RE =
  /\b(case stud(?:y|ies)|customer stor(?:y|ies)|customer spotlight|success stor(?:y|ies)|builds? [a-z ]{0,20}capabilities for|boost(?:s|ing)? productivity|improv(?:e|es|ing) work quality|client service)\b/i;

/**
 * Does this read as vendor marketing rather than a technical result?
 *
 * Text-only on purpose. The engine paired this with a hardcoded list of vendor hostnames, which is
 * exactly the kind of subject-specific knowledge a harness must not ship: the list ages, and it
 * encodes one operator's idea of who the vendors are. An operator who wants host-level exclusions
 * has `editorial.excludedTopics` and their own source configuration.
 */
export function isVendorPromotionalText(text: string): boolean {
  return PROMOTIONAL_TEXT_RE.test(text);
}

/**
 * Collapse a principal entity to a comparable key so slate diversity is not bypassed by a product
 * name — "the Foo team" and "Foo Corp" are one entity for the one-story-per-entity rule.
 *
 * Deliberately mechanical rather than a lookup table of known aliases: a table would need to know
 * the operator's subject area, and would silently stop working the moment they changed it.
 */
export function canonicalEntityForText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|group|team|labs?|research|technologies|technology|the|of|and)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .join("-");
}

/** A vocabulary entry is a short label a model can classify against — never a sentence. */
export const VOCABULARY_LABEL_MAX = 40;
export function vocabularyLabelProblem(label: unknown): string | null {
  if (typeof label !== "string" || !label.trim()) return "a category must be a short label";
  const value = label.trim();
  if (value.length > VOCABULARY_LABEL_MAX) return `"${value.slice(0, 30)}…" is too long for a category (up to ${VOCABULARY_LABEL_MAX} characters)`;
  if (/[.\n]/.test(value)) return `"${value.slice(0, 30)}…" reads as a sentence, not a category`;
  return null;
}
/** Keep only valid labels, trimmed and unique, with the catch-all last. */
export function vocabularyLabels(values: unknown[], catchAll = "other"): string[] {
  const kept = [...new Set(values.filter(v => typeof v === "string").map(v => (v as string).trim()).filter(v => v && v !== catchAll && !vocabularyLabelProblem(v)))];
  return [...kept, catchAll];
}

/** First entity that appears twice in a slate, or null when every story is a different one. */
export function duplicatePrincipalEntity(stories: Array<{ principalEntity: string }>): string | null {
  const entities = stories.map((story) => canonicalEntityForText(story.principalEntity));
  return entities.find((entity, index) => entity && entities.indexOf(entity) !== index) ?? null;
}

/** Validate a story's classification against the OPERATOR'S vocabulary. Returns a corrective message. */
function classificationLabelKey(value: string): string {
  return value.trim().replace(/[_\-\u2010-\u2015\s]+/g, " ").toLowerCase();
}

/** Only an explicitly configured catch-all may recover an unknown category. */
function classificationCatchAll(allowed: string[]): string | undefined {
  for (const label of ["other", "general"]) {
    const matches = [...new Set(allowed.filter(value => classificationLabelKey(value) === label))];
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

const classifiedObjects = new WeakSet<object>();

export function selectionClassificationProblem(
  story: { principalEntity?: string; area?: string; verticals?: string[]; classificationNotes?: string[] },
  areas?: SelectionAreas,
): string | null {
  const { focusAreas, verticals } = resolveSelectionAreas(areas);
  if (!story || typeof story !== "object") return "every story needs a classification object";
  // Recovery notes come from this validator, never from model-supplied JSON.
  if (!classifiedObjects.has(story)) { delete story.classificationNotes; classifiedObjects.add(story); }
  const canonical = (value: unknown, allowed: string[]) => {
    if (typeof value !== 'string') return undefined;
    if (allowed.includes(value)) return value;
    const key = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();
    const matches = [...new Set(allowed.filter(label => key(label) === key(value)))];
    return matches.length === 1 ? matches[0] : undefined;
  };
  // The catch-all is named in the correction, so a model that reached for "politics" in a civic vocabulary recovers on its one retry.
  const fallback = (allowed: string[]) => allowed.includes("other") ? `; use "other" when none fits` : "";
  if (typeof story.principalEntity !== "string" || !story.principalEntity.trim()) return "every story needs principalEntity";
  const recover = (value: unknown, allowed: string[], field: string) => {
    const exact = canonical(value, allowed);
    if (exact) return exact;
    if (typeof value === "string") {
      const matches = [...new Set(allowed.filter(label => classificationLabelKey(label) === classificationLabelKey(value)))];
      if (matches.length === 1) return matches[0];
      // Ambiguous configuration cannot be hidden by a catch-all.
      if (matches.length > 1) return undefined;
    }
    const catchAll = classificationCatchAll(allowed);
    if (catchAll) {
      const original = typeof value === "string" ? JSON.stringify(value.slice(0, 80)) : "missing or malformed label";
      (story.classificationNotes ??= []).push(`${field}: ${original} assigned to configured catch-all ${JSON.stringify(catchAll)}`);
    }
    return catchAll;
  };
  const area = recover(story.area, focusAreas, "area");
  if (!area) {
    return `invalid area "${story.area}" — use one of: ${focusAreas.join(", ")}${fallback(focusAreas)}`;
  }
  story.area = area;
  const inputVerticals: unknown[] = Array.isArray(story.verticals) && story.verticals.length ? story.verticals : [story.verticals];
  if (inputVerticals[0] === undefined && !classificationCatchAll(verticals)) {
    return `every story needs at least one vertical from: ${verticals.join(", ")}`;
  }
  const resolvedVerticals = inputVerticals.map(vertical => recover(vertical, verticals, "vertical"));
  const invalid = resolvedVerticals.findIndex(vertical => !vertical);
  if (invalid >= 0) return `invalid vertical "${inputVerticals[invalid]}" — use one of: ${verticals.join(", ")}${fallback(verticals)}`;
  story.verticals = [...new Set(resolvedVerticals as string[])];
  return null;
}

/**
 * Validate the evidence block.
 *
 * The split between `communityInterest` and `maturity` is the whole point: merging them lets a model
 * present "lots of discussion" as though it were "peer reviewed". `not-provided` must carry null
 * evidence rather than a plausible sentence, because a sentence there is an invented metric.
 */
export function selectionEvidenceProblem(
  evidence: StorySelectionEvidence | undefined,
  options: { preprintOnly?: boolean } = {},
): string | null {
  if (!evidence?.communityInterest || !evidence?.maturity) {
    return "every story needs selectionEvidence with separate communityInterest and maturity";
  }
  const community = evidence.communityInterest;
  if (!(["observed", "not-provided"] as const).includes(community.status)) {
    return `invalid communityInterest status: ${community.status}`;
  }
  if (community.status === "observed" && !community.evidence?.trim()) {
    return "observed communityInterest needs source-backed evidence";
  }
  if (community.status === "not-provided" && community.evidence !== null) {
    return "not-provided communityInterest must use null evidence, not a description";
  }
  if (!MATURITY.includes(evidence.maturity.status)) return `invalid maturity: ${evidence.maturity.status}`;
  if (!evidence.maturity.evidence?.trim()) return "maturity needs source-backed evidence";
  if (options.preprintOnly && evidence.maturity.status !== "preprint") {
    return "a preprint-only candidate must be labeled preprint, not peer-reviewed";
  }
  if (options.preprintOnly && community.status !== "not-provided") {
    return "a preprint-only candidate provides no community-interest evidence";
  }
  return null;
}
