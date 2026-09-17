import { existsSync, readFileSync } from 'node:fs';
import { atomicJson, contained } from '../workspaces.js';
import { releaseLock } from '../release-lock.js';
import { beginParentWork, parentModelHooks, reserveParentTool, roleHash, type ParentWorkScope, type ParentWorkState } from '../llm/role-router.js';
import type { ModelInvocationHooks } from '../llm/model.js';
import type { PreparedModelTask } from './writing-task.js';
import { captureNewsletterEvidence, inspectNewsletterEvidenceCoverage, newsletterEvidenceSources, newsletterEvidenceSentences, selectNewsletterEvidence, validateNewsletterEvidencePacket, NEWSLETTER_EVIDENCE_VERSION, type CaptureLimits, type EvidenceSource, type EvidenceTopic, type EvidenceWordRange, type NewsletterCapture, type NewsletterEvidenceCoverage, type SourceUnitPacket } from './newsletter-evidence.js';

export const WRITING_PREPARATION_VERSION = 8;
export interface WritingPreparationRequest {
  /** This immutable package scope starts BEFORE research. Enrichment must not create a new one. */
  parent: ParentWorkScope;
  day: string; briefHash: string; settingsHash: string;
  /** Original selected claim/capture identity, if it may change within the same package scope. */
  selectedEvidenceHash?: string;
  topics: EvidenceTopic[];
  targets: { video: EvidenceWordRange; newsletter: EvidenceWordRange };
  fixedVideoWords?: number;
}
export interface WritingPreparationCall { deadline: number; hooks: ModelInvocationHooks; taskId: string; task: PreparedModelTask }
export interface WritingPreparationAdapters {
  /** Existing modelJson caller, with this deadline and hooks on EVERY physical retry. */
  judge<T>(prompt: string, validate: (value: T) => string | null, context: WritingPreparationCall): Promise<T>;
  /** One physical fetch only. Retry decisions belong to this preparation, not the adapter. */
  capture?(source: EvidenceSource, limits: CaptureLimits): Promise<NewsletterCapture>;
}
export interface WritingExecutionPlan {
  version: 1; identity: string; evidenceHash: string;
  targets: WritingPreparationRequest['targets']; fixedVideoWords: number;
  mode: 'bounded-prose'; sourceSupportIsFallible: true; finalReviewRequired: true;
  topics: Array<EvidenceTopic & { verifiedClaims: string[]; packets: SourceUnitPacket[]; videoTarget: EvidenceWordRange; newsletterTarget: EvidenceWordRange }>;
}
export interface PreparationTrace { taskId: string; action: 'capture' | 'select'; outcome: string; at: number; sourceUrl: string; packetHash?: string; failed?: boolean }
export type WritingPreparationResult = {
  status: 'ready'; plan: WritingExecutionPlan; cached: boolean; parent: ParentWorkState; trace: PreparationTrace[];
} | {
  status: 'needs-evidence'; identity: string; reason: string;
  failureKind: 'model-task' | 'source-capture' | 'budget' | 'insufficient-evidence';
  coverage: { video: NewsletterEvidenceCoverage; newsletter: NewsletterEvidenceCoverage };
  nextResearch: { task: 'enrich-verified-evidence'; topicIds: string[]; sourceUrls: string[] };
  parent: ParentWorkState; trace: PreparationTrace[];
};
/** Keep a provider/worker failure distinct from missing source material in the executive journey.
 * Technical details stay in the saved trace; no model error becomes a claim about the user's topics. */
export function writingPreparationFailureMessage(result: Extract<WritingPreparationResult, { status: 'needs-evidence' }>, range: EvidenceWordRange, output: 'newsletter' | 'video script' = 'newsletter'): string {
  if (result.failureKind === 'model-task') return 'Your selected model could not finish checking the source material. Check its availability or choose another model, then start a new preview. Your topics, sources and previous results are kept.';
  if (result.failureKind === 'budget') return 'This preview reached its saved time or attempt limit before the source checks finished. Start a new preview when your selected model is available. Your topics, sources and previous results are kept.';
  if (result.failureKind === 'source-capture') return 'A selected source could not be read completely. Check that source or choose another trusted page for the same topic, then retry. Your entries and saved progress are kept.';
  return `The source checks did not find enough relevant detail for the selected ${range.min}–${range.max}-word ${output}. Add a detailed trusted source for these topics, then retry. Your topics and saved progress are kept.`;
}
interface SourceAttempt {
  topicId: string; source: EvidenceSource; status: 'reserved' | 'captured' | 'failed' | 'selected';
  capture?: NewsletterCapture; packet?: SourceUnitPacket; selections: number;
}
interface Checkpoint {
  version: 1; identity: string; attempts: SourceAttempt[]; trace: PreparationTrace[];
  ready?: { plan: WritingExecutionPlan; hash: string };
}
const hex = (value: string) => /^[a-f0-9]{64}$/.test(value);
const plain = (value: string) => typeof value === 'string' && !!value.trim() && !/[<>\x00-\x1f]/.test(value);
function validateRequest(request: WritingPreparationRequest): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.day) || !hex(request.briefHash) || !hex(request.settingsHash) || request.selectedEvidenceHash !== undefined && !hex(request.selectedEvidenceHash)) throw new Error('Writing preparation needs an exact date, brief and writer/settings identity');
  if (request.topics.length < 1 || request.topics.length > 8 || new Set(request.topics.map(topic => topic.id)).size !== request.topics.length) throw new Error('Writing preparation needs 1–8 distinct selected topics');
  for (const topic of request.topics) {
    if (!plain(topic.id) || topic.id.length > 120 || !plain(topic.headline) || topic.headline.length > 300) throw new Error('Writing preparation needs bounded explicit topic titles and identities');
    newsletterEvidenceSources(topic);
  }
  for (const range of Object.values(request.targets)) if (!range || !Number.isSafeInteger(range.min) || !Number.isSafeInteger(range.max) || range.min < request.topics.length || range.max < range.min || range.max > 1300) throw new Error('Writing preparation must preserve finite original output word ranges');
  if (!Number.isSafeInteger(request.fixedVideoWords ?? 0) || (request.fixedVideoWords ?? 0) < 0 || (request.fixedVideoWords ?? 0) >= request.targets.video.min - request.topics.length) throw new Error('Video framing must leave room for every selected topic');
}
function canSelect(attempt: SourceAttempt): boolean {
  if (!['captured', 'selected'].includes(attempt.status) || attempt.selections >= 2) return false;
  if (!attempt.packet) return true;
  if (attempt.packet.unsupportedCandidate.length) return false;
  // There is nothing to expand when every source sentence is already retained.
  const selected = new Set(attempt.packet.units.flatMap(unit => unit.sourceSentenceIds));
  return newsletterEvidenceSentences(attempt.packet.capture.text).some(sentence => !selected.has(sentence.id));
}
function accepted(state: Checkpoint): SourceUnitPacket[] { return state.attempts.flatMap(attempt => attempt.status === 'selected' && attempt.packet ? [attempt.packet] : []); }
function coverage(request: WritingPreparationRequest, packets: SourceUnitPacket[]) {
  const fixed = request.fixedVideoWords ?? 0;
  return {
    video: inspectNewsletterEvidenceCoverage(request.topics, packets, { min: request.targets.video.min - fixed, max: request.targets.video.max - fixed }),
    newsletter: inspectNewsletterEvidenceCoverage(request.topics, packets, request.targets.newsletter),
  };
}
function complete(request: WritingPreparationRequest, packets: SourceUnitPacket[]): boolean {
  const measured = coverage(request, packets);
  return measured.video.status === 'evidence-capacity-ready' && measured.newsletter.status === 'evidence-capacity-ready'
    && request.topics.every(topic => packets.some(packet => packet.topicId === topic.id && packet.capture.role === 'primary' && packet.units.length));
}
function makePlan(request: WritingPreparationRequest, identity: string, packets: SourceUnitPacket[]): WritingExecutionPlan {
  const measured = coverage(request, packets);
  return { version: 1, identity, evidenceHash: roleHash(packets), targets: request.targets, fixedVideoWords: request.fixedVideoWords ?? 0,
    mode: 'bounded-prose', sourceSupportIsFallible: true, finalReviewRequired: true,
    topics: request.topics.map((topic, i) => ({ ...topic, verifiedClaims: packets.filter(packet => packet.topicId === topic.id).flatMap(packet => packet.units.map(unit => unit.text)), packets: packets.filter(packet => packet.topicId === topic.id), videoTarget: measured.video.topics[i]!.target, newsletterTarget: measured.newsletter.topics[i]!.target })) };
}
function validateCheckpoint(state: Checkpoint, request: WritingPreparationRequest, identity: string): void {
  if (state.version !== 1 || state.identity !== identity || !Array.isArray(state.attempts) || state.attempts.length > 8 || !Array.isArray(state.trace) || state.trace.length > 64) throw new Error('Writing preparation checkpoint identity or bounds changed');
  const keys = new Set<string>();
  for (const attempt of state.attempts) {
    const topic = request.topics.find(topic => topic.id === attempt.topicId);
    const key = `${attempt.topicId}:${attempt.source.url}`;
    if (!topic || !newsletterEvidenceSources(topic).some(source => source.url === attempt.source.url && source.role === attempt.source.role) || keys.has(key) || state.attempts.filter(row => row.topicId === attempt.topicId).length > 2 || !Number.isSafeInteger(attempt.selections) || attempt.selections < 0 || attempt.selections > 2 || !['reserved', 'captured', 'failed', 'selected'].includes(attempt.status)) throw new Error('Writing preparation checkpoint contains an unselected or repeated source');
    keys.add(key);
    if (attempt.capture && (attempt.capture.url !== attempt.source.url || attempt.capture.role !== attempt.source.role)) throw new Error('Writing preparation capture attribution changed');
    if (attempt.packet) {
      validateNewsletterEvidencePacket(attempt.packet);
      if (attempt.packet.topicId !== topic.id || roleHash(attempt.packet.capture) !== roleHash(attempt.capture)) throw new Error('Writing preparation packet belongs to a different topic or capture');
    }
    if (attempt.status === 'selected' && !attempt.packet) throw new Error('Writing preparation lost its selected source packet');
  }
  for (const topic of request.topics) validateAggregate(accepted(state).filter(packet => packet.topicId === topic.id));
  coverage(request, accepted(state));
}
function validateAggregate(packets: SourceUnitPacket[]): void {
  const units = packets.flatMap(packet => packet.units);
  if (units.length > 24 || units.map(unit => unit.text).join(' ').length > 6000) throw new Error('Combined topic evidence exceeds 24 complete sentences or 6000 characters; dependency groups cannot be sliced');
}

/** Bounded adaptive research: gather primaries, then at most one selected corroborating source
 * per deficient topic. Four rounds cover at most two selections per source; retries and expansions
 * cannot exceed the existing two-source/eight-capture caps or create a new parent allowance. The same durable parent ledger also pays for later writing and repairs.
 * Ready means sufficient source text to attempt bounded prose, not a semantic or publication pass.
 */
export async function prepareWriting(request: WritingPreparationRequest, adapters: WritingPreparationAdapters): Promise<WritingPreparationResult> {
  validateRequest(request);
  const identity = roleHash({ version: WRITING_PREPARATION_VERSION, evidenceVersion: NEWSLETTER_EVIDENCE_VERSION, parent: request.parent.parentIdentity, day: request.day, briefHash: request.briefHash, settingsHash: request.settingsHash, selectedEvidenceHash: request.selectedEvidenceHash, topics: request.topics, targets: request.targets, fixedVideoWords: request.fixedVideoWords ?? 0 });
  const path = contained(request.parent.root, 'state/writing-preparation', request.parent.parentId, `${identity}.json`);
  const unlock = releaseLock(request.parent.root, `writing-preparation-${roleHash(request.parent.parentId).slice(0, 16)}`);
  const now = request.parent.now ?? Date.now;
  try {
    let parent = beginParentWork(request.parent);
    const state: Checkpoint = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, identity, attempts: [], trace: [] };
    validateCheckpoint(state, request, identity);
    const save = () => atomicJson(path, state);
    const trace = (taskId: string, source: EvidenceSource, action: PreparationTrace['action'], outcome: string, packetHash?: string, failed = false) => { state.trace.push({ taskId, sourceUrl: source.url, action, outcome: outcome.slice(0, 500), at: now(), ...(packetHash ? { packetHash } : {}), ...(failed ? { failed: true } : {}) }); save(); };
    if (state.ready) {
      const rebuilt = makePlan(request, identity, accepted(state));
      if (state.ready.hash !== roleHash(state.ready.plan) || roleHash(rebuilt) !== state.ready.hash || !complete(request, accepted(state))) throw new Error('Saved writing preparation is no longer bound to these exact sources and output lengths');
      return { status: 'ready', plan: rebuilt, cached: true, parent, trace: state.trace };
    }
    let reason = 'Selected sources do not yet provide enough relevant evidence for the requested lengths';
    for (let round = 0; round < 4 && !complete(request, accepted(state)); round++) {
      for (let i = 0; i < request.topics.length && !complete(request, accepted(state)); i++) {
        const topic = request.topics[i]!, measured = coverage(request, accepted(state));
        const topicReady = !measured.video.topics[i]!.minimumAdditionalWords && !measured.newsletter.topics[i]!.minimumAdditionalWords && accepted(state).some(packet => packet.topicId === topic.id && packet.capture.role === 'primary' && packet.units.length);
        if (topicReady) continue;
        const prior = state.attempts.filter(attempt => attempt.topicId === topic.id);
        const next = newsletterEvidenceSources(topic, prior.map(attempt => attempt.source.url))[0];
        // Gather all primaries first, then prefer a selected corroborating page over asking
        // the same source for more words. Later rounds may expand either complete packet.
        let attempt = round === 1 && next && prior.some(attempt => attempt.status === 'selected')
          ? undefined : prior.find(canSelect);
        const source = attempt?.source ?? next;
        if (!source || !attempt && (prior.length >= 2 || state.attempts.length >= 8)) continue;
        const taskId = `prepare-${i + 1}-${attempt ? prior.indexOf(attempt) + 1 : prior.length + 1}`;
        parent = beginParentWork(request.parent);
        if (now() >= parent.deadline || !parent.remainingPhysical || !attempt && !parent.remainingTools) { reason = 'The saved parent time, model or tool allowance is exhausted; no new evidence work was started'; break; }
        if (!attempt) {
          attempt = { topicId: topic.id, source, status: 'reserved', selections: 0 }; state.attempts.push(attempt); save();
          try {
            parent = reserveParentTool(request.parent, taskId, 'source-capture');
            const remaining = parent.deadline - now();
            if (remaining <= 0) throw new Error('Parent deadline reached after the source reservation');
            attempt.capture = await (adapters.capture ?? captureNewsletterEvidence)(source, { timeoutMs: Math.min(30_000, remaining), maxBytes: 250_000 });
            if (attempt.capture.url !== source.url || attempt.capture.role !== source.role) throw new Error('Source capture returned a different URL or role');
            if (now() >= parent.deadline) throw new Error('Source capture exceeded the parent deadline');
            attempt.status = attempt.capture.failure ? 'failed' : 'captured';
            trace(taskId, source, 'capture', attempt.capture.failure ?? 'captured', undefined, !!attempt.capture.failure);
          } catch (error) { attempt.status = 'failed'; trace(taskId, source, 'capture', (error as Error).message, undefined, true); }
        }
        if (!['captured', 'selected'].includes(attempt.status) || !attempt.capture) continue;
        while (canSelect(attempt)) {
          parent = beginParentWork(request.parent);
          if (now() >= parent.deadline || !parent.remainingPhysical) break;
          const otherPackets = accepted(state).filter(packet => packet !== attempt.packet), withoutThis = coverage(request, otherPackets);
          const minimumWords = Math.max(withoutThis.video.topics[i]!.minimumAdditionalWords, withoutThis.newsletter.topics[i]!.minimumAdditionalWords);
          const priorSentenceIds = attempt.packet?.units.flatMap(unit => unit.sourceSentenceIds) ?? [];
          attempt.selections++; save();
          try {
            const packet = await selectNewsletterEvidence(topic, attempt.capture, (prompt, validate, task) => {
              if (!task) throw new Error('Evidence work requires its explicit selection or review task');
              return adapters.judge(prompt, validate, { deadline: parent.deadline, hooks: parentModelHooks(request.parent, taskId), taskId, task });
            }, { minimumWords, priorSentenceIds });
            if (now() >= parent.deadline) throw new Error('Source selection exceeded the parent deadline');
            validateAggregate([...otherPackets.filter(packet => packet.topicId === topic.id), packet]);
            attempt.packet = packet; attempt.status = 'selected'; trace(taskId, source, 'select', packet.units.length ? 'exact source packet accepted; semantic judgment remains fallible' : 'no supported topical evidence selected', packet.packetHash);
            const after = coverage(request, accepted(state));
            if (round === 0 || !after.video.topics[i]!.minimumAdditionalWords && !after.newsletter.topics[i]!.minimumAdditionalWords || packet.unsupportedCandidate.length) break;
          } catch (error) { trace(taskId, source, 'select', (error as Error).message, undefined, true); }
        }
      }
    }
    parent = beginParentWork(request.parent);
    if (complete(request, accepted(state))) {
      const plan = makePlan(request, identity, accepted(state)); state.ready = { plan, hash: roleHash(plan) }; save();
      return { status: 'ready', plan, cached: false, parent, trace: state.trace };
    }
    save();
    const measured = coverage(request, accepted(state)), deficient = request.topics.filter((_, i) => measured.video.topics[i]!.minimumAdditionalWords || measured.newsletter.topics[i]!.minimumAdditionalWords || !accepted(state).some(packet => packet.topicId === request.topics[i]!.id && packet.capture.role === 'primary' && packet.units.length));
    const lastByTask = new Map<string, PreparationTrace>();
    for (const event of state.trace) lastByTask.set(event.taskId, event);
    const failures = [...lastByTask.values()].filter(event => event.failed);
    const pendingCapture = state.attempts.length < 8 && request.topics.some(topic => {
      const attempts = state.attempts.filter(attempt => attempt.topicId === topic.id);
      return attempts.length < 2 && newsletterEvidenceSources(topic, attempts.map(attempt => attempt.source.url)).length > 0;
    });
    const failureKind = now() >= parent.deadline || !parent.remainingPhysical || !parent.remainingTools && pendingCapture ? 'budget'
      : failures.some(event => event.action === 'select') ? 'model-task'
      : failures.some(event => event.action === 'capture') ? 'source-capture' : 'insufficient-evidence';
    return { status: 'needs-evidence', identity, reason, failureKind, coverage: measured, nextResearch: { task: 'enrich-verified-evidence', topicIds: deficient.map(topic => topic.id), sourceUrls: deficient.flatMap(topic => newsletterEvidenceSources(topic, state.attempts.filter(attempt => attempt.topicId === topic.id).map(attempt => attempt.source.url)).map(source => source.url)) }, parent, trace: state.trace };
  } finally { unlock(); }
}
