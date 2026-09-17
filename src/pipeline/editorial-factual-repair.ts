/** A source-review finding may change only its exact owned sentence, never the whole draft. */
import { createHash } from 'node:crypto';
import type { DailyEditorialCheckpoint, DailyEditorialInput, DailyEditorialReview, DailyScriptFormat } from './daily-editorial.js';
import { withJsonOutputContract } from '../llm/json-output-contract.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: unknown, names: string[]) => object(value) && Object.keys(value).sort().join(',') === names.slice().sort().join(',');
const sentences = (text: string) => [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].map(row => row.segment.trim()).filter(Boolean);
export interface EditorialFactualPatchPlan {
  version: 1; candidateHash: string; reviewHash: string; inputHash: string;
  patches: { storyId: string; excerpt: string; reason: string; evidence: { sourceId: string; quote: string }[]; maxWords: number }[];
}
export interface EditorialFactualReplacements { replacements: { storyId: string; excerpt: string; replacement: string }[] }

export function prepareEditorialFactualPatch(input: DailyEditorialInput, candidate: unknown, review: DailyEditorialReview, format: DailyScriptFormat): EditorialFactualPatchPlan | null {
  if (!format.newsletterCopy || format.validate(candidate) || review.verdict !== 'changes-required' || !review.findings.length || review.findings.length > 8
    || review.reviewedStoryIds.length !== input.stories.length || new Set(review.reviewedStoryIds).size !== input.stories.length || review.reviewedStoryIds.some(id => !input.stories.some(story => story.id === id))) return null;
  const copy = format.newsletterCopy(candidate), patches: EditorialFactualPatchPlan['patches'] = [];
  for (const finding of review.findings) {
    const row = copy.find(section => section.storyId === finding.storyId), story = input.stories.find(story => story.id === finding.storyId);
    // The factual reviewer must identify a complete, unique sentence in its own copy,
    // and cite actual owned source text. Ambiguous locations cannot become a patch.
    if (!row || !story || !finding.candidateExcerpt || !finding.evidence.length || row.text.split(finding.candidateExcerpt).length !== 2
      || !sentences(row.text).includes(finding.candidateExcerpt) || finding.evidence.some(evidence => {
        const source = story.sources.find(source => source.id === evidence.sourceId); return !source || !evidence.quote || !source.text.includes(evidence.quote);
      }) || patches.some(patch => patch.storyId === finding.storyId && patch.excerpt === finding.candidateExcerpt)) return null;
    patches.push({ storyId: finding.storyId, excerpt: finding.candidateExcerpt, reason: finding.reason, evidence: structuredClone(finding.evidence),
      maxWords: Math.min(100, Math.max(30, words(finding.candidateExcerpt) + 30)) });
  }
  return { version: 1, candidateHash: hash(candidate), reviewHash: hash(review), inputHash: hash(input), patches };
}

export function assertTargetedFactualRepairCandidate(checkpoint: DailyEditorialCheckpoint, input: DailyEditorialInput, reviewerHash: string): void {
  const state = checkpoint.artifacts?.script, newsletter = checkpoint.artifacts?.newsletter;
  if (checkpoint.version !== 1 || checkpoint.contentHash !== hash(checkpoint.artifacts) || !state || state.status !== 'held' || state.origin !== 'model'
    || state.writes !== 2 || state.candidates.length !== 3 || state.reviews.length !== 1 || state.reviewRecovery || (state as unknown as Record<string, unknown>).factualRecovery
    || state.lengthRecovery?.status !== 'finished' || state.lengthRecovery.candidateHash !== hash(state.candidates[2])
    || state.reviews[0]!.candidateHash !== hash(state.candidates[2]) || hash(state.reviews[0]!.reviewer) !== reviewerHash
    || state.reviews[0]!.output.verdict !== 'changes-required' || !state.reviews[0]!.output.findings.length
    || !newsletter || newsletter.status !== 'new' || newsletter.writes || newsletter.candidates.length || newsletter.reviews.length) {
    throw new Error('Targeted factual recovery requires the exact reviewed length-repair candidate and no previous factual recovery');
  }
  const current = state.candidates[2] as unknown as { editorialCopy?: { storyId: string; text: string }[] };
  if (!Array.isArray(current.editorialCopy)) throw new Error('Targeted factual recovery requires complete owned editorial copy');
  const copy = structuredClone(current.editorialCopy);
  const minimal = { validate: () => null, newsletterCopy: () => copy } as unknown as DailyScriptFormat;
  if (!prepareEditorialFactualPatch(input, current, state.reviews[0]!.output, minimal)) throw new Error('Targeted factual recovery lacks an exact owned sentence and quoted source finding');
}

export function editorialFactualReplacementsValidator(plan: EditorialFactualPatchPlan) {
  return withJsonOutputContract<EditorialFactualReplacements>(value => {
    if (!keys(value, ['replacements']) || !Array.isArray(value.replacements) || value.replacements.length !== plan.patches.length) return 'Return only the exact planned sentence replacements';
    for (const [i, row] of value.replacements.entries()) {
      const patch = plan.patches[i]!;
      if (!keys(row, ['storyId', 'excerpt', 'replacement']) || row.storyId !== patch.storyId || row.excerpt !== patch.excerpt
        || typeof row.replacement !== 'string' || row.replacement.trim() !== row.replacement || !row.replacement || row.replacement.length > 3000
        || /[<>\x00-\x1f]|https?:\/\/|www\./i.test(row.replacement) || !/[.!?]["'’”)]*$/.test(row.replacement)
        || sentences(row.replacement).length !== 1 || row.replacement === patch.excerpt || words(row.replacement) > patch.maxWords) return 'Replace only the identified owned sentence with one bounded complete source-supported sentence';
    }
    return null;
  }, { type: 'object', additionalProperties: false, required: ['replacements'], properties: { replacements: { type: 'array', minItems: plan.patches.length, maxItems: plan.patches.length,
    items: { type: 'object', additionalProperties: false, required: ['storyId', 'excerpt', 'replacement'], properties: {
      storyId: { type: 'string', enum: [...new Set(plan.patches.map(row => row.storyId))] }, excerpt: { type: 'string', minLength: 1, maxLength: 3000 }, replacement: { type: 'string', minLength: 1, maxLength: 3000 },
    } } } } });
}

export function applyEditorialFactualPatch<T>(candidate: T, plan: EditorialFactualPatchPlan, replacements: EditorialFactualReplacements, format: DailyScriptFormat): T {
  if (hash(candidate) !== plan.candidateHash) throw new Error('Factual patch candidate changed');
  const invalid = editorialFactualReplacementsValidator(plan)(replacements); if (invalid) throw new Error(invalid);
  const draft = structuredClone(candidate) as T & { editorialCopy: { storyId: string; text: string }[] };
  for (const patch of replacements.replacements) {
    const row = draft.editorialCopy.find(row => row.storyId === patch.storyId);
    if (!row || row.text.split(patch.excerpt).length !== 2) throw new Error('Factual patch location changed or is ambiguous');
    row.text = row.text.replace(patch.excerpt, () => patch.replacement);
  }
  const invalidDraft = format.validate(draft); if (invalidDraft) throw new Error(invalidDraft);
  return draft;
}
export function editorialFactualPatchPrompt(plan: EditorialFactualPatchPlan): string {
  return `Correct only the exact sentences identified by the script factual reviewer. Return {replacements:[{storyId,excerpt,replacement}]} in the planned order. Preserve the exact storyId and excerpt; supply one complete replacement sentence supported by that story's quoted and complete captured source. Retain attribution and conditions. Contact or a plan to share something does not prove its receipt or completion. No new claims, filler or changes elsewhere. Code preserves all narration, presentation and other editorial wording and enforces the original word ranges. The complete resulting script still requires the same factual reviewer.\nEXACT OWNED REVIEW FINDINGS:\n${JSON.stringify(plan.patches)}`;
}
