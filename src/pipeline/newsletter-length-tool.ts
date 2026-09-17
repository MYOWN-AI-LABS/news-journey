import { createHash } from 'node:crypto';
import type { DailyNewsletterDraft } from './daily-editorial.js';
import { withJsonOutputContract } from '../llm/json-output-contract.js';

export const NEWSLETTER_LENGTH_TOOL_VERSION = 1;
type Bounds = { min: number; max: number };
interface Unit { id: number; text: string; words: number }
export interface NewsletterLengthPlan {
  version: 1; candidateHash: string; bounds: Bounds; originalWords: number;
  sections: { storyId: string; units: Unit[] }[];
}
export interface NewsletterLengthChoice {
  sections: { storyId: string; requiredIds: number[]; rankedIds: number[] }[];
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const exact = (value: unknown, keys: string[]) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/** Quote blocks and explicit backward references stay together. This is a conservative
 * mechanical boundary, not a claim that all semantic dependencies can be detected in code. */
function completeUnits(text: string): Unit[] {
  const blocks: string[] = []; let pending = '', curlyDepth = 0, straightOpen = false;
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)) {
    pending += segment;
    for (const char of segment) {
      if (char === '“') curlyDepth++;
      else if (char === '”') curlyDepth--;
      else if (char === '"') straightOpen = !straightOpen;
      if (curlyDepth < 0) throw new Error('Candidate has an unmatched quotation; length selection cannot split it');
    }
    if (curlyDepth || straightOpen) continue;
    const block = pending.trim(); pending = '';
    if (!block) continue;
    if (blocks.length && (/^[“\"]/.test(block) || /^(?:He|She|It|They|His|Her|Their|This|That|These|Those|Such|However|But|And|Also|The MP|The minister)\b/i.test(block))) blocks[blocks.length - 1] += ' ' + block;
    else blocks.push(block);
  }
  if (pending.trim() || curlyDepth || straightOpen) throw new Error('Candidate has an incomplete quotation; preserve it for a normal editorial repair');
  return blocks.map((text, i) => ({ id: i + 1, text, words: words(text) }));
}

export function prepareNewsletterLengthPlan(candidate: DailyNewsletterDraft, bounds: Bounds): NewsletterLengthPlan {
  if (!exact(candidate, ['sections']) || !Array.isArray(candidate.sections) || !candidate.sections.length
    || candidate.sections.length > 8 || !Number.isSafeInteger(bounds.min) || !Number.isSafeInteger(bounds.max)
    || bounds.min < 1 || bounds.max < bounds.min || bounds.max > 1300) throw new Error('Length tool needs a complete candidate and unchanged bounded word target');
  const seen = new Set<string>();
  const sections = candidate.sections.map(row => {
    if (!exact(row, ['storyId', 'text']) || typeof row.storyId !== 'string' || !/^[\w-]{1,80}$/.test(row.storyId) || seen.has(row.storyId)
      || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 12000) throw new Error('Length tool requires exact owned candidate sections');
    seen.add(row.storyId);
    const units = completeUnits(row.text);
    if (!units.length || units.length > 128) throw new Error('Candidate exceeds the bounded complete-unit inventory');
    return { storyId: row.storyId, units };
  });
  const originalWords = sections.reduce((n, row) => n + row.units.reduce((sum, unit) => sum + unit.words, 0), 0);
  if (originalWords <= bounds.max) throw new Error('Whole-unit reduction applies only to an overlong candidate');
  return { version: 1, candidateHash: hash(candidate), bounds: { ...bounds }, originalWords, sections };
}

/** The model chooses semantic importance; code counts and assembles. Every required unit is
 * retained, and a source-conditioned lead is never silently removed to make space. */
export function applyNewsletterLengthChoice(plan: NewsletterLengthPlan, choice: NewsletterLengthChoice) {
  if (!exact(choice, ['sections']) || !Array.isArray(choice.sections) || choice.sections.length !== plan.sections.length) throw new Error('Return one length-selection section per original story');
  const required: { story: number; unit: Unit }[] = [], optional: { story: number; unit: Unit; score: number }[] = [];
  for (const [i, section] of plan.sections.entries()) {
    const selected = choice.sections[i];
    if (!exact(selected, ['storyId', 'requiredIds', 'rankedIds']) || selected.storyId !== section.storyId
      || !Array.isArray(selected.requiredIds) || !Array.isArray(selected.rankedIds)) throw new Error('Keep the original story order and exact length-selection fields');
    const ids = section.units.map(unit => unit.id);
    for (const values of [selected.requiredIds, selected.rankedIds]) if (new Set(values).size !== values.length || values.some(id => !Number.isSafeInteger(id) || !ids.includes(id))) throw new Error('Length selection contains duplicate or unowned candidate IDs');
    if (selected.rankedIds.length !== ids.length) throw new Error('Rank every candidate unit exactly once; code computes the budget');
    const mustKeep = new Set([ids[0], ...selected.requiredIds]);
    for (const unit of section.units) {
      if (mustKeep.has(unit.id)) required.push({ story: i, unit });
      else optional.push({ story: i, unit, score: (ids.length - selected.rankedIds.indexOf(unit.id)) ** 2 });
    }
  }
  const requiredWords = required.reduce((n, row) => n + row.unit.words, 0);
  if (requiredWords > plan.bounds.max) throw new Error(`Required complete units total ${requiredWords} words, above ${plan.bounds.max}; no condition was silently removed`);
  // The word dimension is bounded by1300. Required units cannot be traded for score.
  type State = { score: number; selected: number[] };
  const dp: (State | undefined)[] = Array(plan.bounds.max - requiredWords + 1);
  dp[0] = { score: 0, selected: [] };
  for (const [i, row] of optional.entries()) for (let count = dp.length - 1; count >= row.unit.words; count--) {
    const prev = dp[count - row.unit.words]; if (!prev) continue;
    const score = prev.score + row.score;
    if (!dp[count] || score > dp[count]!.score) dp[count] = { score, selected: [...prev.selected, i] };
  }
  let best: State | undefined, count = -1;
  for (let n = Math.max(0, plan.bounds.min - requiredWords); n < dp.length; n++) if (dp[n] && (!best || dp[n]!.score > best.score)) { best = dp[n]; count = n; }
  if (!best) throw new Error('No whole-unit selection meets the original range while retaining required conditions');
  const keep = [...required, ...best.selected.map(i => optional[i]!)];
  const selectedSections = plan.sections.map((section, i) => ({ storyId: section.storyId, units: keep.filter(row => row.story === i).map(row => row.unit).sort((a,b) => a.id-b.id) }));
  const draft: DailyNewsletterDraft = { sections: selectedSections.map(row => ({ storyId: row.storyId, text: row.units.map(unit => unit.text).join(' ') })) };
  const finalWords = draft.sections.reduce((n, row) => n + words(row.text), 0);
  if (finalWords !== requiredWords + count || finalWords < plan.bounds.min || finalWords > plan.bounds.max) throw new Error('Length-tool assembly word invariant failed');
  return { draft, receipt: { version: NEWSLETTER_LENGTH_TOOL_VERSION, status: 'pending-full-source-review' as const,
    candidateHash: plan.candidateHash, planHash: hash(plan), choice: structuredClone(choice), choiceHash: hash(choice), draftHash: hash(draft), bounds: { ...plan.bounds }, requiredWords, finalWords,
    sections: selectedSections.map(row => ({ storyId: row.storyId, selectedIds: row.units.map(unit => unit.id), words: row.units.reduce((n,u) => n+u.words,0) })) } };
}

export function newsletterLengthChoiceValidator(plan: NewsletterLengthPlan) {
  const ids = [...new Set(plan.sections.flatMap(row => row.units.map(unit => unit.id)))];
  return withJsonOutputContract<NewsletterLengthChoice>(value => {
    try { applyNewsletterLengthChoice(plan, value); return null; } catch (error) { return (error as Error).message; }
  }, { type: 'object', additionalProperties: false, required: ['sections'], properties: { sections: {
    type: 'array', minItems: plan.sections.length, maxItems: plan.sections.length, items: { type: 'object', additionalProperties: false,
      required: ['storyId', 'requiredIds', 'rankedIds'], properties: {
        storyId: { type: 'string', enum: plan.sections.map(row => row.storyId) },
        requiredIds: { type: 'array', maxItems: 128, items: { type: 'integer', enum: ids } },
        rankedIds: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'integer', enum: ids } },
      } },
  } } });
}

export function newsletterLengthChoicePrompt(plan: NewsletterLengthPlan) {
  return `The complete newsletter is ${plan.originalWords} words; its unchanged target is ${plan.bounds.min}–${plan.bounds.max}. Use the length-selection tool instead of writing prose again. Return only {sections:[{storyId,requiredIds,rankedIds}]} in original story order. IDs identify immutable complete sentences or quote blocks from the previous candidate. Rank EVERY unit ID exactly once, most essential first. Required IDs retain essential qualifications, negations, uncertainty, attribution, disagreements, temporal conditions and dependencies of the central story; those units cannot be removed by the tool. The first unit of each story is always retained. Do not mark background or anecdotes required unless needed for factual context. Code will choose the highest-priority combination within the exact word budget, preserving complete selected units in their original order. You do not need to add word counts or rewrite text. If essential units cannot fit, keep them required; the tool must hold instead of silently discarding conditions. The final assembled candidate receives a fresh complete-source factual review; ranking and exact copying do not grant factual approval.\nCANDIDATE-OWNED UNITS WITH EXACT COUNTS:\n${JSON.stringify(plan)}`;
}
