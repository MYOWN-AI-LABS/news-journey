import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { DAILY_EDITORIAL_VERSION, SCRIPT_FIRST_EDITORIAL_VERSION, type DailyEditorialInput } from './daily-editorial.js';
import type { Topic, TopicStory } from '../types.js';
import { activeRoot, contained, atomicJson } from '../workspaces.js';
import { readJson, loadConfig, videoDir } from '../util.js';

/** Journey review path. `"script"` keeps the production Daily Signal draft path (script.ts + visual director);
 * anything else keeps the harness-side port of Daily Signal editorial/visual policy (script-first hold, field-supported concepts). */
export function journeyReviewPortEnabled(config: { journeyReview?: unknown } = readJson<{ journeyReview?: unknown }>(join(activeRoot(), 'config', 'pipeline.json'), {})): boolean {
  return config.journeyReview !== 'script';
}
import { publisher, publisherBrief } from '../publisher.js';
import { bandForStoryCount, defaultNewsletterWords, effectiveVideoWordBudget, NEWSLETTER_LENGTHS, readPersonalization, type Personalization } from '../personalization.js';
import { readPersonalProfile, personalWritingGuidance, PERSONAL_GUIDANCE_VERSION } from '../personal-profile.js';
import { configuredModelRuntime, type ModelConfig } from '../llm/model.js';
import { beginParentWork, reserveParentTool, readRoleRouting, roleHash, type ParentWorkScope } from '../llm/role-router.js';
import { editionForVideo } from './edition.js';
import { publicationIntro, reviewedJourneyScript } from './narration.js';
import { prepareWriting, writingPreparationFailureMessage, type WritingPreparationRequest } from './writing-preparation.js';
import { researchTopics, researchCapturePlan, TOPIC_RESEARCH_VERSION, type TopicResearchAdapters } from '../sources/topic-research.js';
import { STAGED_SCRIPT_VERSION, type DraftCall } from './script.js';
import { releaseLock } from '../release-lock.js';
import { createPreparedRoleDispatch, createPreparedVisionDispatch } from '../llm/prepared-role-dispatch.js';
import { assertPreparedModelTask } from './writing-task.js';
import { JSON_OUTPUT_CONTRACT_VERSION } from '../llm/json-output-contract.js';
import { newsletterClaimEvidence } from './newsletter-evidence.js';
import { SOURCE_SUPPORT_VERSION } from './source-support.js';
import { FIELD_SUPPORT_VERSION } from './field-support.js';
import { withPublicationMemory, storedStory, checkStoryCoverage, type StoryCoverageDecision } from '../memory/runtime.js';
import { applyMemoryGuidance, assertPinnedMemory, pinWritingMemory, recordWorkingMemory, MEMORY_CONTEXT_VERSION, type PinnedMemoryContext } from '../memory/context.js';
import { identifyStoryEvent, storyEventFromTopicStory, storyEventHash, STORY_IDENTITY_VERSION } from '../memory/story-identity.js';

/** Newsletter artwork and the save timestamp do not change editorial work. Legacy snapshots
 * retain only these two historical slots so exact existing parent identities remain readable. */
export function writingPersonalizationIdentity(current: Personalization, previous?: unknown): Omit<Personalization, 'newsletterImages' | 'updatedAt'> & Partial<Pick<Personalization, 'newsletterImages' | 'updatedAt'>> {
  const excluded = new Set(['newsletterImages', 'updatedAt']);
  const identity: Record<string, unknown> = {};
  // Preserve legacy property order too: the existing role hash is over exact JSON bytes.
  if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
    for (const key of Object.keys(previous)) {
      if (excluded.has(key)) identity[key] = (previous as Record<string, unknown>)[key];
      else if (Object.hasOwn(current, key)) identity[key] = (current as unknown as Record<string, unknown>)[key];
    }
  }
  for (const [key, value] of Object.entries(current)) if (!excluded.has(key)) identity[key] = value;
  return identity as ReturnType<typeof writingPersonalizationIdentity>;
}

export type WritingOutputs = 'video' | 'edition';
const STORY_HISTORY_VERSION = 1;
interface PinnedStoryHistory { version: 1; topicHash: string; checkedAt: number; decisions: StoryCoverageDecision[]; hash: string }
interface WritingRequest { original: Topic; originalHash: string; preparedHash?: string; parentIdentity?: string; outputs?: WritingOutputs; memory?: PinnedMemoryContext; storyHistory?: PinnedStoryHistory; settingsSnapshot?: { settings: unknown; hash: string } }
function assertStoryHistory(value: PinnedStoryHistory, topic: Topic): void {
  const { hash, ...body } = value;
  const stories = topic.stories ?? [];
  if (Object.keys(value).some(key => !['version', 'topicHash', 'checkedAt', 'decisions', 'hash'].includes(key))
    || value.version !== STORY_HISTORY_VERSION || value.topicHash !== roleHash(topic) || roleHash(body) !== hash
    || !Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0 || value.checkedAt > Date.now()
    || !Array.isArray(value.decisions) || value.decisions.length !== stories.length
    || value.decisions.some((decision, index) => !decision || Object.keys(decision).some(key => !['url', 'decision', 'reason', 'priorStoryId', 'priorRunId', 'receiptUrl'].includes(key))
      || decision.url !== stories[index]!.primaryUrl || !['same_event', 'different_event', 'new_development', 'uncertain'].includes(decision.decision)
      || typeof decision.reason !== 'string' || !decision.reason.trim() || decision.reason.length > 2000
      || ['priorStoryId', 'priorRunId', 'receiptUrl'].some(key => decision[key as keyof StoryCoverageDecision] !== undefined && (typeof decision[key as keyof StoryCoverageDecision] !== 'string' || !decision[key as keyof StoryCoverageDecision]!.trim()))
      || decision.decision === 'same_event' && (!decision.priorStoryId || !decision.priorRunId))) {
    throw new Error('Saved story-history review changed or belongs to different source evidence; start a new package.');
  }
}

export function writingOutputs(saved?: Pick<WritingRequest, 'outputs'> | null, requested?: WritingOutputs): WritingOutputs {
  if (requested !== undefined && !['video', 'edition'].includes(requested)) throw new Error('Writing output scope must be video or edition');
  if (saved?.outputs !== undefined && !['video', 'edition'].includes(saved.outputs)) throw new Error('Saved writing output scope changed');
  if (saved?.outputs && requested && saved.outputs !== requested) throw new Error('The requested outputs changed. Start a new package; the original budget cannot be renewed.');
  return requested ?? saved?.outputs ?? 'video';
}
/** A single source may support several scenes. This metadata is not a factual claim packet;
 * the same live capture and independent selection review must still establish its claims. */
export function selectedWritingStories(topic: Topic): TopicStory[] {
  if (topic.kind === 'roundup') {
    if (!topic.stories?.length) throw new Error('A roundup must retain its selected stories before source preparation');
    return structuredClone(topic.stories);
  }
  if (topic.stories?.length) {
    if (topic.stories.length !== 1 || topic.stories[0]!.primaryUrl !== topic.primaryUrl) throw new Error('A single-source topic must retain exactly its original source');
    return structuredClone(topic.stories);
  }
  return [{ n: 1, headline: topic.headline, summary: topic.angle, weight: 'lead', primaryUrl: topic.primaryUrl,
    repo: topic.repo, assetRef: 'og-0', suggestedScene: topic.kind === 'repo' ? 'repo_card' : 'news_card', principalEntity: '', area: '', verticals: [],
    classificationNotes: ['Direct source input; no entity or editorial classification was inferred.'] }];
}
export function writingNewsletterTarget(outputs: WritingOutputs, selectedCount: number, video: { min: number; max: number }, length?: readonly number[], fixedVideoWords = 0) {
  if (outputs === 'video') return { min: video.min - fixedVideoWords, max: video.max - fixedVideoWords };
  if (length) return bandForStoryCount({ min: length[0]!, max: length[1]! }, selectedCount); // the one scaling rule (review finding)
  const [min, max] = defaultNewsletterWords(selectedCount);
  return { min, max };
}
export function assertWritingRequestIdentity(saved: WritingRequest | null, parentIdentity: string): void {
  if (saved && saved.parentIdentity !== parentIdentity) throw new Error('Writing settings changed after this package began. Start a new package; retrying cannot reset its saved time or model allowance.');
}
export interface LegacyPreparedScriptReceipt { version: 2; sourceSupportVersion: number; fieldSupportVersion: number; scriptReviewVersion: number; topicHash: string; writerKey: string; scriptHash: string }
export interface JourneyPreparedScriptReceipt { version: 3; reviewProtocol: 'daily-editorial'; editorialVersion: number; topicHash: string; writerKey: string; scriptHash: string; checkpointHash: string; inputHash: string }
export type PreparedScriptReceipt = LegacyPreparedScriptReceipt | JourneyPreparedScriptReceipt;
export function preparedScriptReceipt(topic: Topic, writerKey: string, script: unknown): LegacyPreparedScriptReceipt {
  return { version: 2, sourceSupportVersion: SOURCE_SUPPORT_VERSION, fieldSupportVersion: FIELD_SUPPORT_VERSION,
    scriptReviewVersion: STAGED_SCRIPT_VERSION, topicHash: roleHash(topic), writerKey, scriptHash: roleHash(script) };
}
export function assertPreparedScriptReceipt(receipt: PreparedScriptReceipt | null, topic: Topic, writerKey: string, script: unknown): void {
  if (receipt?.version === 3) {
    const checkpoint = readJson<import('./daily-editorial.js').DailyEditorialCheckpoint | null>(join(videoDir(topic.id), 'journey-editorial-checkpoint.json'), null);
    const source = readJson<{ input: DailyEditorialInput } | null>(join(videoDir(topic.id), 'journey-editorial-input.json'), null);
    if (receipt.reviewProtocol !== 'daily-editorial' || ![DAILY_EDITORIAL_VERSION, SCRIPT_FIRST_EDITORIAL_VERSION].includes(receipt.editorialVersion) || receipt.topicHash !== roleHash(topic) || receipt.writerKey !== writerKey || receipt.scriptHash !== roleHash(script) || !checkpoint || receipt.checkpointHash !== roleHash(checkpoint) || !source || receipt.inputHash !== roleHash(source.input) || Object.keys(checkpoint.artifacts).sort().join(',') !== 'newsletter,script' || checkpoint.contentHash !== roleHash(checkpoint.artifacts)) throw new Error('The saved Journey script lacks its exact whole-source editorial review');
    const scriptState = checkpoint.artifacts.script, newsletterState = checkpoint.artifacts.newsletter;
    const factual = (state: typeof scriptState) => state.status === 'accepted' && state.reviews.at(-1)?.output.verdict === 'supported' && state.reviews.at(-1)?.candidateHash === roleHash(state.candidates.at(-1));
    if (!factual(scriptState)) throw new Error('The saved Journey script lacks its exact factual review');
    if (receipt.editorialVersion === DAILY_EDITORIAL_VERSION ? !factual(newsletterState)
      : newsletterState.status !== 'accepted' || newsletterState.reviews.length > 0 || newsletterState.formatting?.version !== 1
        || newsletterState.formatting.checks !== 'shape-length-formatting' || newsletterState.formatting.approvedScriptHash !== roleHash(scriptState.candidates.at(-1))
        || newsletterState.formatting.candidateHash !== roleHash(newsletterState.candidates.at(-1))) throw new Error('The newsletter is not bound to the approved script and its required checks');
    const reviewed = checkpoint.artifacts.script.candidates.at(-1) as unknown as import('../types.js').Script;
    if (roleHash(script) !== roleHash(reviewedJourneyScript(reviewed, source.input.stories.map(story => story.primaryUrl)))) throw new Error('The final Journey script differs from its reviewed candidate');
    return;
  }
  if (!receipt || roleHash(receipt) !== roleHash(preparedScriptReceipt(topic, writerKey, script))) throw new Error('The saved video script is not bound to this prepared newsletter and writer. Start a new package for this request; completed media has been kept.');
}
export function originalWritingTopic(current: Topic, saved?: WritingRequest | null): Topic {
  if (!saved) return current;
  if (roleHash(saved.original) !== saved.originalHash || ![saved.originalHash, saved.preparedHash].includes(roleHash(current))) throw new Error('The selected package changed after writing began; use a new package for the changed request');
  return saved.original;
}

/** Research and writing preparation share one parent. Reusing a captured artifact makes no
 * second HTTP request; its original full-byte receipt remains intact. Preparation still charges
 * its bounded source-adapter use, so reuse cannot refill the caller's tool allowance. */
export async function prepareResearchedWriting(request: WritingPreparationRequest, adapters: TopicResearchAdapters) {
  const research = await researchTopics(request, adapters);
  const captured = researchCapturePlan(request.topics, research);
  return prepareWriting({ ...request, topics: captured.topics,
    selectedEvidenceHash: roleHash({ original: request.selectedEvidenceHash, research: research.identity, captures: captured.captures }) }, {
    judge: adapters.judge,
    capture: async source => {
      const matches = captured.captures.filter(row => row.capture.url === source.url && row.capture.role === source.role);
      if (matches.length !== 1) throw new Error('Prepared source has no unique previously captured research artifact. Fresh retrieval is disabled.');
      return structuredClone(matches[0]!.capture);
    },
  });
}

/** One immutable request identity covers source preparation and both writing jobs. New evidence
 * changes child checkpoints, never the parent allowance. Ready checkpoints survive human review. */
export async function packageWritingContext(id: string, requestedOutputs?: WritingOutputs): Promise<{ topic: Topic; parent: ParentWorkScope; call: (stage: 'newsletter' | 'script' | 'visual') => DraftCall; vision: ReturnType<typeof createPreparedVisionDispatch>; writerKey: string; dailyEditorial?: DailyEditorialInput }> {
  const root = activeRoot(), dir = videoDir(id), requestPath = join(dir, 'writing-request.json');
  if (existsSync(join(dir, 'journey-rescue-adoption.json'))) return (await import('./journey-rescue-adoption.js')).adoptedJourneyWritingContext(id, requestedOutputs);
  const unlock = releaseLock(root, `writing-context-${roleHash(id).slice(0, 16)}`);
  try {
    const saved = readJson<WritingRequest | null>(requestPath, null);
    const outputs = writingOutputs(saved, requestedOutputs);
    const current = readJson<Topic>(join(dir, 'topic.json'));
    const original = originalWritingTopic(current, saved);
    const personalization = readPersonalization(root), edition = editionForVideo(id);
    const personalGuidance = { version: PERSONAL_GUIDANCE_VERSION, text: personalWritingGuidance(readPersonalProfile(root)) };
    const config = loadConfig<ModelConfig>('model');
    const runtime = configuredModelRuntime();
    const { readCast } = await import('./cast.js');
    const cast = readCast(root);
    const rolePolicy = readRoleRouting(root);
    const useDailyEditorial = journeyReviewPortEnabled() && outputs === 'edition' && cast.format === 'narrator' && original.kind === 'roundup' && !rolePolicy?.roles?.writer && !rolePolicy?.roles?.critic;
    const previousSettings = saved?.settingsSnapshot?.settings as { dailyEditorialVersion?: number; personalization?: unknown } | undefined;
    const savedEditorialVersion = previousSettings?.dailyEditorialVersion;
    const personalizationIdentity = writingPersonalizationIdentity(personalization, previousSettings?.personalization);
    const settings = { dailyEditorialVersion: useDailyEditorial ? savedEditorialVersion ?? SCRIPT_FIRST_EDITORIAL_VERSION : null, outputs, personalGuidance, jsonOutputContractVersion: JSON_OUTPUT_CONTRACT_VERSION, memoryVersion: MEMORY_CONTEXT_VERSION, storyHistoryVersion: STORY_HISTORY_VERSION, storyIdentityVersion: STORY_IDENTITY_VERSION, researchVersion: TOPIC_RESEARCH_VERSION, sourceSupportVersion: SOURCE_SUPPORT_VERSION, fieldSupportVersion: FIELD_SUPPORT_VERSION, scriptReviewVersion: STAGED_SCRIPT_VERSION, edition, personalization: personalizationIdentity, publisher: publisher(), model: config, rolePolicy, runtime: { ...runtime, apiKey: undefined }, cast,
      useCase: readJson(contained(root, 'state/use-case.json'), null), journey: readJson(contained(root, 'state/journey-brief.json'), null) };
    const parent: ParentWorkScope = { root, parentId: id, parentIdentity: roleHash({ version: 7, id, original, settings }),
      deadlinePolicy: rolePolicy ? 'fixed' : 'operation-only',
      limits: rolePolicy?.limits ?? { totalSeconds: 1800, maxPhysicalCalls: 96, maxToolCalls: 24 } };
    assertWritingRequestIdentity(saved, parent.parentIdentity);
    const request: WritingRequest = saved ?? { original, originalHash: roleHash(original), parentIdentity: parent.parentIdentity, outputs };
    // The parent identity was checked above. This receipt preserves the exact editorial
    // settings; artwork visibility and bookkeeping timestamps never renew work.
    if (request.settingsSnapshot) {
      if (request.settingsSnapshot.hash !== roleHash(request.settingsSnapshot.settings) || request.settingsSnapshot.hash !== roleHash(settings)) throw new Error('The saved writing settings snapshot changed');
    } else request.settingsSnapshot = { settings: structuredClone(settings), hash: roleHash(settings) };
    beginParentWork(parent);
    atomicJson(requestPath, request);
    if (!request.memory) {
      reserveParentTool(parent, 'publication-memory', 'memory-retrieval');
      request.memory = await withPublicationMemory(store => pinWritingMemory(store, publisherBrief(), Date.now(), personalGuidance.text), root);
      atomicJson(requestPath, request);
    }
    assertPinnedMemory(request.memory);
    const memory = request.memory;
    await withPublicationMemory(store => recordWorkingMemory(store, id, { parentIdentity: parent.parentIdentity, topicHash: roleHash(original), outputs, status: 'preparing', memoryHash: memory.hash }), root);
    if (!saved) atomicJson(requestPath, request);
    // Repairs use the selected provider only. A bounded task cannot silently buy a second writer.
    const boundedConfig = { ...config, rescue: { enabled: false } };
    const dispatch = createPreparedRoleDispatch({ root, parent, primary: boundedConfig, env: process.env, policy: rolePolicy, briefHash: roleHash(publisherBrief()) });
    const vision = createPreparedVisionDispatch({ root, parent, primary: boundedConfig, env: process.env, policy: rolePolicy, briefHash: roleHash(publisherBrief()) });
    const call = (stage: 'newsletter' | 'script' | 'visual'): DraftCall => (prompt, validate, task) => {
      assertPreparedModelTask(task);
      const guided = applyMemoryGuidance(prompt, memory);
      return dispatch(guided.prompt, validate, { ...task, taskId: `${stage}:${task.taskId}` });
    };
    const writerKey = JSON.stringify({ config: boundedConfig, rolePolicy, runtime: { ...runtime, apiKey: undefined }, settingsHash: roleHash(settings), memoryHash: memory.hash });
    let topic = original;
    let dailyEditorial: DailyEditorialInput | undefined;
    {
      const selected = selectedWritingStories(original);
      const length = personalization.newsletterLength ? NEWSLETTER_LENGTHS[personalization.newsletterLength].words : undefined;
      const video = effectiveVideoWordBudget(root, edition.wordBudget, original.kind === 'roundup');
      const intro = cast.format === 'narrator' ? publicationIntro(edition, publisher().publication) : '';
      const fixedVideoWords = intro.trim().split(/\s+/).filter(Boolean).length;
      const newsletter = writingNewsletterTarget(outputs, selected.length, video, length, fixedVideoWords);
      if (useDailyEditorial) {
        dailyEditorial = await (await import('./journey-editorial.js')).captureJourneyEditorialInput(original, parent);
        topic = { ...original, stories: selected };
      } else if (!journeyReviewPortEnabled() && selected.every(story => story.verifiedClaims?.length && story.claimEvidence?.length)) {
        // Daily Signal shape: the claims pinned at selection (verify-at-selection) are the whole fact budget; there is no
        // second research and evidence-selection pass. (Run 8, Sep 17: that pass answered "no supported topical evidence"
        // for the packet that had yielded 20 claims the night before, and held the package.)
        topic = { ...original, stories: selected };
      } else {
      const result = await prepareResearchedWriting({ parent, day: `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`, briefHash: roleHash(publisherBrief()), settingsHash: roleHash(settings), selectedEvidenceHash: roleHash(selected),
        topics: selected.map((story, index) => ({ id: `topic-${index + 1}`, headline: story.headline, weight: story.weight, primaryUrl: story.primaryUrl,
          corroboratingUrls: story.claimEvidence?.filter(row => row.role === 'corroborating').map(row => row.url) })),
        targets: { video, newsletter }, fixedVideoWords }, {
        judge: (prompt, validate, context) => dispatch(prompt, validate, context.task),
      });
      if (result.status !== 'ready') throw new Error(writingPreparationFailureMessage(result, outputs === 'video' ? video : newsletter, outputs === 'video' ? 'video script' : 'newsletter'));
      topic = { ...original, stories: selected.map((story, index) => {
        const prepared = result.plan.topics[index]!;
        if (prepared.id !== `topic-${index + 1}` || prepared.primaryUrl !== story.primaryUrl || prepared.headline !== story.headline) throw new Error('Prepared evidence changed the selected story identity');
        return { ...story, verifiedClaims: prepared.verifiedClaims,
          claimEvidence: prepared.packets.map(newsletterClaimEvidence) };
      }) };
      }
      for (const [index, story] of topic.stories!.entries()) {
        const savedEvent = saved?.preparedHash === roleHash(current) ? current.stories?.[index]?.storyEvent : undefined;
        if (savedEvent) {
          const retained = storyEventFromTopicStory({ ...story, storyEvent: savedEvent });
          if (storyEventHash(retained) === storyEventHash(savedEvent)) { story.storyEvent = retained; continue; }
        }
        const packet = storyEventFromTopicStory(story);
        const identified = await identifyStoryEvent(packet, (prompt, validate, task) => {
          assertPreparedModelTask(task);
          return dispatch(prompt, validate, { ...task, taskId: `story-identity:${task.taskId}` });
        }, { topicId: `topic-${index + 1}`, modelIdentity: `routing-config:${roleHash({ boundedConfig, rolePolicy })}` });
        story.storyEvent = identified.packet;
      }
      if (request.storyHistory) assertStoryHistory(request.storyHistory, topic);
      else {
        reserveParentTool(parent, 'story-history', 'memory-history');
        const decisions = await checkStoryCoverage(topic.stories!, id, 30, root);
        const body = { version: STORY_HISTORY_VERSION as 1, topicHash: roleHash(topic), checkedAt: Date.now(), decisions };
        request.storyHistory = { ...body, hash: roleHash(body) };
        assertStoryHistory(request.storyHistory, topic);
      }
      // Persist the exact prepared packet and history decision even when a confirmed repeat
      // pauses this edition. Retry must not re-identify stories or buy another history lookup.
      atomicJson(requestPath, { ...request, preparedHash: roleHash(topic) });
      atomicJson(join(dir, 'topic.json'), topic);
      const repeated = request.storyHistory.decisions.find(decision => decision.decision === 'same_event');
      if (repeated) throw new Error(`This exact event was already confirmed published in ${repeated.priorRunId}. ${repeated.reason} Select a new development in a new package; the selected topics have been kept.`);
      await withPublicationMemory(async store => {
        for (const story of topic.stories!) await store.putStory(storedStory(story));
        await recordWorkingMemory(store, id, { parentIdentity: parent.parentIdentity, topicHash: roleHash(topic), outputs, status: 'ready', memoryHash: memory.hash });
      }, root);
    }
    return { topic, parent, call, vision, writerKey, ...(dailyEditorial ? { dailyEditorial } : {}) };
  } finally { unlock(); }
}
