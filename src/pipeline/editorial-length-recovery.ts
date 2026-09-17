/** Narrow length repair: keep valid narration/presentation and add only source-reviewed copy.
 * This is a drafting tool, never factual approval or a renewed writing allowance. */
import { createHash } from 'node:crypto';
import type { DailyEditorialCheckpoint, DailyScriptFormat } from './daily-editorial.js';
import { withJsonOutputContract } from '../llm/json-output-contract.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const count = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: unknown, names: string[]) => object(value) && Object.keys(value).sort().join(',') === names.slice().sort().join(',');
const lengthOnly = (message: string) => /^(?:script failed after its one repair: )?(?:Complete editorialCopy has \d+ words; required \d+–\d+, separately from spoken narration|script too (?:short|long): \d+ spoken words \(need \d+-\d+\)\.[\s\S]*|script has \d+ words; required \d+–\d+)$/.test(message);

export interface EditorialCopyExpansion {
  version: 1; candidateHash: string; beforeWords: number; range: { min: number; max: number };
  sections: { storyId: string; min: number; max: number }[];
}
export interface EditorialCopyAdditions { additions: { storyId: string; text: string }[] }

/** Only a known, exhausted length hold without a factual verdict is eligible. */
export function assertExhaustedLengthRecoveryCandidate(checkpoint: DailyEditorialCheckpoint): void {
  const state = checkpoint.artifacts?.script, newsletter = checkpoint.artifacts?.newsletter;
  if (checkpoint.version !== 1 || checkpoint.contentHash !== hash(checkpoint.artifacts)
    || !/^[a-f0-9]{64}$/.test(checkpoint.identityHash) || !state || state.status !== 'held' || state.origin !== 'model'
    || state.writes !== 2 || state.candidates.length !== 2 || state.reviews.length || state.reviewRecovery || state.invalidReview
    || (state as unknown as Record<string, unknown>).lengthRecovery || state.failures.length < 2 || !state.failures.every(lengthOnly)
    || !newsletter || newsletter.status !== 'new' || newsletter.writes !== 0 || newsletter.candidates.length || newsletter.reviews.length) {
    throw new Error('Length recovery requires the exact exhausted length-only candidates, no factual verdict and no previous recovery');
  }
}

/** Eligibility includes all existing shape/word/presentation gates: the sole failure must
 * be short editorialCopy. A valid earlier candidate can therefore retain its narration. */
export function prepareEditorialCopyExpansion(candidate: unknown, format: DailyScriptFormat | undefined, range: { min: number; max: number }): EditorialCopyExpansion | null {
  if (!format?.newsletterCopy || !format.validateShape || format.validateShape(candidate)) return null;
  if (!Number.isSafeInteger(range.min) || !Number.isSafeInteger(range.max) || range.min < 1 || range.max < range.min) return null;
  const sections = format.newsletterCopy(candidate), beforeWords = count(sections.map(row => row.text).join(' '));
  if (!sections.length || sections.length > 8 || new Set(sections.map(row => row.storyId)).size !== sections.length || beforeWords >= range.min || beforeWords < Math.ceil(range.min * 0.75)) return null;
  if (format.validate(candidate) !== `Complete editorialCopy has ${beforeWords} words; required ${range.min}–${range.max}, separately from spoken narration`) return null;
  // Work inside the requested range rather than ask the model to guess the minimum.
  // Each row receives an explicit, jointly achievable band like the production script bands.
  const headroom = range.max - range.min;
  const totalMin = range.min - beforeWords + Math.min(60, Math.floor(headroom / 5));
  const totalMax = Math.min(range.max - beforeWords, totalMin + Math.min(60, Math.floor(headroom / 5)));
  if (Math.floor(totalMin / sections.length) < 12) return null; // Do not solicit filler fragments.
  return { version: 1, candidateHash: hash(candidate), beforeWords, range: { ...range }, sections: sections.map((row, index) => ({
    storyId: row.storyId, min: Math.floor(totalMin / sections.length) + (index < totalMin % sections.length ? 1 : 0),
    max: Math.floor(totalMax / sections.length) + (index < totalMax % sections.length ? 1 : 0),
  })) };
}

export function editorialCopyAdditionsValidator(plan: EditorialCopyExpansion) {
  return withJsonOutputContract<EditorialCopyAdditions>(value => {
    if (!keys(value, ['additions']) || !Array.isArray(value.additions) || value.additions.length !== plan.sections.length) return 'Return only one owned addition per planned story';
    for (const [i, row] of value.additions.entries()) {
      const slot = plan.sections[i]!;
      if (!keys(row, ['storyId', 'text']) || row.storyId !== slot.storyId || typeof row.text !== 'string' || !row.text.trim()
        || row.text.length > 12000 || /[<>\x00-\x09\x0b-\x1f]|https?:\/\/|www\./i.test(row.text)
        || !/[.!?]["'’”)]*$/.test(row.text.trim())) return 'Additions need complete plain prose in exact story order without URLs';
      const words = count(row.text);
      if (words < slot.min || words > slot.max) return `Addition ${slot.storyId} has ${words} words; required ${slot.min}–${slot.max}. Count only its text field.`;
    }
    return null;
  }, { type: 'object', additionalProperties: false, required: ['additions'], properties: { additions: {
    type: 'array', minItems: plan.sections.length, maxItems: plan.sections.length, items: { type: 'object', additionalProperties: false,
      required: ['storyId', 'text'], properties: { storyId: { type: 'string', enum: plan.sections.map(row => row.storyId) }, text: { type: 'string', minLength: 1, maxLength: 12000 } } },
  } } });
}

export function applyEditorialCopyExpansion<T>(candidate: T, plan: EditorialCopyExpansion, additions: EditorialCopyAdditions, format: DailyScriptFormat): T {
  if (hash(candidate) !== plan.candidateHash || hash(prepareEditorialCopyExpansion(candidate, format, plan.range)) !== hash(plan)) throw new Error('Copy expansion candidate or length plan changed');
  const problem = editorialCopyAdditionsValidator(plan)(additions); if (problem) throw new Error(problem);
  const draft = structuredClone(candidate) as T & { editorialCopy: { storyId: string; text: string }[] };
  draft.editorialCopy = format.newsletterCopy!(candidate).map((row, i) => ({ ...row, text: `${row.text}\n\n${additions.additions[i]!.text.trim()}` }));
  const checked = format.validate(draft); if (checked) throw new Error(checked);
  return draft;
}

export function editorialCopyExpansionPrompt(plan: EditorialCopyExpansion): string {
  return `The saved script already has valid spoken narration and presentation. Keep those fields and every existing editorialCopy sentence unchanged. Return ONLY {additions:[{storyId,text}]} in the planned story order. Code appends each text as a paragraph to its OWN story; you cannot rewrite narration, hook, intro, CTA, motion, publication fields or previous prose.\nEach paragraph must add useful nonrepetitive detail supported by that story's complete captured sources, preserving attribution and conditions. Do not summarize the existing paragraph again, add editorial filler or invent facts to reach length. If a source cannot support the addition, do not manufacture it. All resulting copy still requires the script factual reviewer.\nCODE-CALCULATED ADDITION WORD BANDS (count whitespace-separated words in text only):\n${JSON.stringify(plan.sections)}\nCurrent editorial copy: ${plan.beforeWords} words. Requested total remains ${plan.range.min}–${plan.range.max}. All bands together fit that original range.`;
}
