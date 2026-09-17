/** Constrained use of the original script repair: only explicitly reviewed fields may change. */
import { createHash } from 'node:crypto';
import type { DailyEditorialInput, DailyEditorialReview, DailyScriptFormat } from './daily-editorial.js';
import { withJsonOutputContract } from '../llm/json-output-contract.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sentences = (text: string) => [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].map(row => row.segment.trim());
type Location = { kind: 'hook' } | { kind: 'title'; index: number } | { kind: 'copy' | 'voiceover'; index: number; excerpt: string };
export interface ScriptFieldRepairPlan {
  version: 1; candidateHash: string; inputHash: string; reviewHash: string;
  fields: { id: string; storyId: string; location: Location; original: string; reason: string; evidence: { sourceId: string; quote: string }[]; maxWords: number; maxCharacters: number }[];
}
interface Candidate { hook: string; body: { onScreen: { title: string }; voiceover?: string }[]; editorialCopy: { storyId: string; text: string }[] }
export function prepareScriptFieldRepair(input: DailyEditorialInput, candidate: unknown, review: DailyEditorialReview, format: DailyScriptFormat): ScriptFieldRepairPlan | null {
  if (format.validate(candidate) || review.verdict !== 'changes-required' || !review.findings.length || review.findings.length > 8) return null;
  const c = candidate as Candidate;
  if (!Array.isArray(c.body) || !Array.isArray(c.editorialCopy) || typeof c.hook !== 'string') return null;
  const fields: ScriptFieldRepairPlan['fields'] = [];
  for (const finding of review.findings) {
    const story = input.stories.find(row => row.id === finding.storyId), index = input.stories.indexOf(story!);
    if (!story || !finding.candidateExcerpt || !finding.evidence.length || finding.evidence.some(e => !story.sources.some(s => s.id === e.sourceId && s.text.includes(e.quote)))) return null;
    const excerpt = finding.candidateExcerpt, locations: Location[] = [];
    if (c.hook === excerpt) locations.push({ kind: 'hook' });
    if (c.body[index]?.onScreen.title === excerpt) locations.push({ kind: 'title', index });
    const voiceover = c.body[index]?.voiceover;
    if (voiceover && voiceover.split(excerpt).length === 2 && sentences(voiceover).includes(excerpt)) locations.push({ kind: 'voiceover', index, excerpt });
    const copyIndex = c.editorialCopy.findIndex(row => row.storyId === story.id), copy = c.editorialCopy[copyIndex];
    if (copy && copy.text.split(excerpt).length === 2 && sentences(copy.text).includes(excerpt)) locations.push({ kind: 'copy', index: copyIndex, excerpt });
    if (locations.length !== 1 || fields.some(field => hash(field.location) === hash(locations[0]))) return null;
    const location = locations[0]!;
    fields.push({ id: `field_${fields.length + 1}`, storyId: story.id, location, original: excerpt, reason: finding.reason, evidence: structuredClone(finding.evidence),
      maxWords: location.kind === 'hook' ? 14 : location.kind === 'title' ? 8 : Math.min(100, excerpt.trim().split(/\s+/).length + 30),
      maxCharacters: location.kind === 'hook' ? 120 : location.kind === 'title' ? 90 : 1500 });
  }
  return { version: 1, candidateHash: hash(candidate), inputHash: hash(input), reviewHash: hash(review), fields };
}
export interface ScriptFieldReplacements { replacements: { id: string; text: string }[] }
export function scriptFieldRepairValidator(plan: ScriptFieldRepairPlan) {
  return withJsonOutputContract<ScriptFieldReplacements>(value => {
    if (!value || typeof value !== 'object' || Object.keys(value).join(',') !== 'replacements' || !Array.isArray(value.replacements) || value.replacements.length !== plan.fields.length) return 'Return only the exact requested replacement slots';
    for (const [i, row] of value.replacements.entries()) {
      const field = plan.fields[i]!;
      if (!row || Object.keys(row).sort().join(',') !== 'id,text' || row.id !== field.id || typeof row.text !== 'string' || !row.text.trim() || row.text !== row.text.trim()
        || row.text === field.original || row.text.length > field.maxCharacters || row.text.split(/\s+/).length > field.maxWords
        || /[<>\x00-\x1f]|https?:\/\/|www\./i.test(row.text)) return 'Replacement must fit its exact owned field and original presentation limits';
      if (['copy', 'voiceover'].includes(field.location.kind) && (!/[.!?]["'’”)]*$/.test(row.text) || sentences(row.text).length !== 1)) return 'Replace a reviewed sentence with exactly one complete sentence';
    }
    return null;
  }, { type: 'object', additionalProperties: false, required: ['replacements'], properties: { replacements: { type: 'array', minItems: plan.fields.length, maxItems: plan.fields.length,
    items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { type: 'string', enum: plan.fields.map(row => row.id) }, text: { type: 'string', minLength: 1, maxLength: 1500 } } } } } });
}
export function applyScriptFieldRepair<T>(candidate: T, plan: ScriptFieldRepairPlan, replacements: ScriptFieldReplacements, format: DailyScriptFormat): T {
  if (hash(candidate) !== plan.candidateHash) throw new Error('Reviewed field repair candidate changed');
  const invalid = scriptFieldRepairValidator(plan)(replacements); if (invalid) throw new Error(invalid);
  const draft = structuredClone(candidate) as T & Candidate;
  for (const [i, field] of plan.fields.entries()) {
    const text = replacements.replacements[i]!.text, location = field.location;
    if (location.kind === 'hook') { if (draft.hook !== field.original) throw new Error('Hook changed'); draft.hook = text; }
    else if (location.kind === 'title') { if (draft.body[location.index]?.onScreen.title !== field.original) throw new Error('Title changed'); draft.body[location.index]!.onScreen.title = text; }
    else if (location.kind === 'voiceover') { const row = draft.body[location.index]; if (!row?.voiceover || row.voiceover.split(field.original).length !== 2) throw new Error('Owned narration sentence changed or ambiguous'); row.voiceover = row.voiceover.replace(field.original, () => text); }
    else { const row = draft.editorialCopy[location.index]; if (!row || row.text.split(field.original).length !== 2) throw new Error('Owned sentence changed or ambiguous'); row.text = row.text.replace(field.original, () => text); }
  }
  const problem = format.validate(draft); if (problem) throw new Error(problem);
  return draft;
}
export function scriptFieldRepairPrompt(plan: ScriptFieldRepairPlan): string {
  return `Use the ORIGINAL one script repair to correct only the listed factual-review findings. Return {replacements:[{id,text}]} in slot order. The code keeps every other field and sentence unchanged and checks both original word ranges. Preserve attribution, uncertainty and source dates. A publication date does not establish an event date. Attribute admissions to the actual named speaker when the evidence supports that, never to a system or tool. Titles and hook remain concise source-backed prose. Narration and editorial replacements are one complete sentence each. No new facts, broader rewriting or filler. The complete resulting script must still pass the same factual reviewer.\nOWNED REPAIR SLOTS:\n${JSON.stringify(plan.fields)}`;
}
