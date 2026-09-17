import type { Script, ScriptSegment, Topic } from '../types.js';
import { countWords, hookProblem, stagedCardProblem } from './script.js';
import { spokenScriptText } from './narration.js';
import { ensureSourceSupportedFields, FIELD_SUPPORT_VERSION, type AuthoredField, type FieldSupportCall } from './field-support.js';
import { createSourceSupportContext, preflightSourceSupportReview, reviewSourceSupport, SOURCE_SUPPORT_VERSION } from './source-support.js';
import { preparedModelTask } from './writing-task.js';
import { reviewFactualObligations } from './factual-obligations.js';

export const POST_SCRIPT_SUPPORT_VERSION = 2;
export const FIXED_SCRIPT_CTA = 'Subscribe for sourced reporting.';
export interface PostScriptSupportOptions {
  topic: Topic; day: string; writerKey: string;
  /** Existing script, word-budget and exact presenter-line validators remain authoritative. */
  validateFinal(script: Script): string | null;
}

const plain = (text: unknown, max: number): text is string => typeof text === 'string' && !!text.trim() && text.length <= max && !/[<>\x00-\x08]|https?:\/\/|www\./i.test(text);
function segmentFields(segment: ScriptSegment): AuthoredField[] {
  if (segment.sourceAccount || segment.diagram) throw new Error('A generated script cannot supply a source-account or preapproved artwork');
  if (!segment.motion) throw new Error('Every script scene needs its bounded source-supported motion brief');
  const card = stagedCardProblem({ title: segment.onScreen?.title, motion: segment.motion });
  if (card) throw new Error(card);
  if (segment.onScreen.stat !== undefined && (!plain(segment.onScreen.stat, 60) || countWords(segment.onScreen.stat) > 6)) throw new Error('Screen stat must contain at most six plain words and 60 characters');
  if (segment.onScreen.sub !== undefined && !plain(segment.onScreen.sub, 250)) throw new Error('Screen subtext must be bounded plain source-supported text');
  return [{ id: 'title', text: segment.onScreen.title },
    ...(segment.onScreen.stat === undefined ? [] : [{ id: 'stat', text: segment.onScreen.stat }]),
    ...(segment.onScreen.sub === undefined ? [] : [{ id: 'sub', text: segment.onScreen.sub }]),
    ...(['who', 'what', 'how', 'impact', 'status', 'kind'] as const).map(key => ({ id: `motion.${key}`, text: segment.motion![key] }))];
}

/** Shared factual gate for existing single-story and presenter scripts. Narration is reviewed
 * without rewriting dialogue. Only bounded display/publication fields may be repaired once.
 * All work uses the caller's original typed dispatcher, never a new provider or parent. */
export async function reviewCompletedScript(input: Script, options: PostScriptSupportOptions, call: FieldSupportCall): Promise<Script> {
  const topic = structuredClone(options.topic), stories = topic.stories;
  if (!stories?.length || stories.length > 8 || topic.kind !== 'roundup' && stories.length !== 1) throw new Error('Script source verification needs the exact prepared source stories');
  const contexts = stories.map((story, index) => {
    if (!story.verifiedClaims?.length || story.verifiedClaims.length > 24 || story.verifiedClaims.some(claim => typeof claim !== 'string' || !claim.trim())
      || !story.claimEvidence?.some(source => source.role === 'primary' && source.url === story.primaryUrl && source.status === 200 && /^[a-f0-9]{64}$/.test(source.sha256 ?? '') && /^[a-f0-9]{64}$/.test(source.textSha256 ?? '')))
      throw new Error(`Story ${index + 1} needs captured and reviewed source claims before script verification`);
    return createSourceSupportContext(options.day, story.primaryUrl, story.claimEvidence);
  });
  if (!Array.isArray(input.body) || topic.kind === 'roundup' && input.body.length !== stories.length
    || topic.kind !== 'roundup' && (input.body.length < 2 || input.body.length > 4)) throw new Error('Script segments must preserve the selected story order or the single story\'s two-to-four scenes');
  const script = structuredClone(input); script.cta = FIXED_SCRIPT_CTA;
  script.body = script.body.map((segment, index) => {
    segmentFields(segment);
    const story = stories[topic.kind === 'roundup' ? index : 0]!;
    return { voiceover: segment.voiceover, scene: segment.scene, assetRef: story.assetRef,
      onScreen: { title: segment.onScreen.title, ...(segment.onScreen.stat === undefined ? {} : { stat: segment.onScreen.stat }), ...(segment.onScreen.sub === undefined ? {} : { sub: segment.onScreen.sub }) },
      motion: { ...segment.motion! }, ...(segment.lines ? { lines: structuredClone(segment.lines) } : {}) };
  });
  script.fullVoiceoverText = spokenScriptText(script);
  const initialProblem = options.validateFinal(script); if (initialProblem) throw new Error(initialProblem);
  const task = (operation: string, index: number, evidence: unknown, candidate: unknown) => preparedModelTask({ role: 'source-review', capability: 'source-review',
    taskId: `complete-script-${operation}-${index + 1}`, topicIds: [topic.kind === 'roundup' ? `topic-${index + 1}` : 'topic-1'],
    protocol: { version: POST_SCRIPT_SUPPORT_VERSION, sourceSupport: SOURCE_SUPPORT_VERSION, fieldSupport: FIELD_SUPPORT_VERSION, operation }, evidence: { writerKey: options.writerKey, evidence }, candidate });
  const acceptedNarration = stories.map((_, index) => (topic.kind === 'roundup' ? [script.body[index]!] : script.body).map(segment => segment.voiceover).join(' '));
  for (const [index, story] of stories.entries()) {
    const narrationOptions = { mode: 'short-batches' as const, sourceContext: contexts[index],
      task: task('narration', index, { story, context: contexts[index] }, acceptedNarration[index]) };
    preflightSourceSupportReview(acceptedNarration[index]!, story.verifiedClaims!, narrationOptions);
    const focused = await reviewFactualObligations(acceptedNarration[index]!, story.verifiedClaims!, call, narrationOptions);
    if (focused.failures.length) throw new Error(`Script narration factual obligations failed: ${focused.failures.map(row => `${row.sentenceId}: ${row.reason}`).join('; ')}. Dialogue and source qualifiers were kept unchanged.`);
    const review = await reviewSourceSupport(acceptedNarration[index]!, story.verifiedClaims!, call, { ...narrationOptions, draftAssertions: focused.draftAssertions });
    const unsupported = review.sentences.filter(sentence => !sentence.supported);
    if (unsupported.length) throw new Error(`Script narration is unsupported: ${unsupported.map(sentence => `${sentence.id}: ${sentence.reason}`).join('; ')}. Dialogue and source qualifiers were kept unchanged.`);
  }
  for (const [index, segment] of script.body.entries()) {
    const sourceIndex = topic.kind === 'roundup' ? index : 0, story = stories[sourceIndex]!, fields = segmentFields(segment);
    const assemble = (rows: readonly AuthoredField[]): ScriptSegment => {
      const values = Object.fromEntries(rows.map(row => [row.id, row.text]));
      return { ...segment, onScreen: { title: values.title!, ...(values.stat === undefined ? {} : { stat: values.stat }), ...(values.sub === undefined ? {} : { sub: values.sub }) },
        motion: { who: values['motion.who']!, what: values['motion.what']!, how: values['motion.how']!, impact: values['motion.impact']!, status: values['motion.status']!, kind: values['motion.kind'] as NonNullable<ScriptSegment['motion']>['kind'] } };
    };
    const validate = (rows: readonly AuthoredField[]) => {
      try { segmentFields(assemble(rows)); return null; } catch (error) { return (error as Error).message; }
    };
    const reviewed = await ensureSourceSupportedFields(fields, story.verifiedClaims!, call, { task: task(`screen-${index + 1}`, sourceIndex, { story, context: contexts[sourceIndex] }, segment),
      sourceContext: contexts[sourceIndex], context: { completeStoryNarration: acceptedNarration[sourceIndex], lockedSpeakerLines: segment.lines, representationFields: ['motion.kind'],
        limits: { title: '8words/90characters', stat: '6words/60characters', sub: 250, motion: 250 } }, validateFinal: validate });
    script.body[index] = assemble(reviewed.fields);
  }
  const publish = script.publish, hookWords = countWords(script.hook);
  const fields: AuthoredField[] = [{ id: 'hook', text: script.hook }, { id: 'title', text: publish?.title }, { id: 'description', text: publish?.description }, { id: 'linkedinPost', text: publish?.linkedinPost },
    ...(Array.isArray(publish?.hashtags) ? publish.hashtags.map((text, index) => ({ id: `hashtag.${index + 1}`, text })) : [])];
  const assemble = (rows: readonly AuthoredField[]): Script => {
    const values = Object.fromEntries(rows.map(row => [row.id, row.text]));
    const revised = { ...script, hook: values.hook!, publish: { title: values.title!, description: values.description!, linkedinPost: values.linkedinPost!, hashtags: (publish.hashtags ?? []).map((_, index) => values[`hashtag.${index + 1}`]!) } };
    revised.fullVoiceoverText = spokenScriptText(revised); return revised;
  };
  const validate = (rows: readonly AuthoredField[]): string | null => {
    const revised = assemble(rows), value = revised.publish;
    if (!plain(value.title, 95) || !plain(value.description, 3000) || !plain(value.linkedinPost, 3000)) return 'Publication text needs bounded nonempty source-supported fields without URLs';
    if (!Array.isArray(publish.hashtags) || publish.hashtags.length > 5 || value.hashtags.some(tag => !plain(tag, 60))) return 'Publication hashtags need at most five bounded source-supported labels';
    return hookProblem(revised.hook) ?? (countWords(revised.hook) !== hookWords ? 'Hook repair must preserve its original word count and locked narration budget' : null) ?? options.validateFinal(revised);
  };
  const reviewed = await ensureSourceSupportedFields(fields, acceptedNarration, call, {
    task: preparedModelTask({ role: 'source-review', capability: 'source-review', taskId: 'complete-script-publication', topicIds: stories.map((_, index) => `topic-${index + 1}`),
      protocol: { version: POST_SCRIPT_SUPPORT_VERSION, sourceSupport: SOURCE_SUPPORT_VERSION, fieldSupport: FIELD_SUPPORT_VERSION, operation: 'derivative-publication' }, evidence: { acceptedNarration, contexts, writerKey: options.writerKey }, candidate: fields }),
    sourceContexts: contexts, context: { evidenceScope: 'Numbered evidence blocks are the exact accepted narration of each story, not new source facts. Add nothing beyond these blocks; all original source restrictions still apply.',
      sourceByClaim: stories.map((story, index) => ({ claimId: index + 1, primaryUrl: story.primaryUrl })), lockedCta: FIXED_SCRIPT_CTA,
      limits: { hookWords, title: 95, description: 3000, linkedinPost: 3000, hashtag: 60 } }, validateFinal: validate,
  });
  const final = assemble(reviewed.fields);
  const sources = [...new Set(stories.map(story => story.primaryUrl))].join('\n');
  final.publish.description += '\n\nSources:\n' + sources; final.publish.linkedinPost += '\n\nSources:\n' + sources;
  const problem = options.validateFinal(final); if (problem) throw new Error(problem);
  return final;
}
