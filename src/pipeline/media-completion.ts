/** Bounded final-media recovery. The accepted text survives transport/media failures. */
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { activeRoot, atomicJson, contained, safeId } from '../workspaces.js';
import { CONFIG_DIR, readJson, videoDir } from '../util.js';
import { resolveFreeTtsEngine, resolveFreeVoice } from '../platform.js';
import { roleHash } from '../llm/role-router.js';
import { candidatePreflightCorrection, grokImageAdapterCorrection, finalMediaFileFindings, reviewFinalMedia, type CandidatePreflightCorrection, type FinalMediaReview } from './final-media-qc.js';
import type { packageWritingContext } from './writing-context.js';
import type { AvatarConfig, RenderProps, Script, Topic, VideoMeta } from '../types.js';
import { selectedSourceSnapshots } from './visual-choice.js';
type Context = Awaited<ReturnType<typeof packageWritingContext>>;
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
interface RenderReceipt { version: number; hash: string; narration?: { hash: string; settings: string } }

function narrationHash(dir: string): string | null {
  const names = ['script.json', 'topic.json', 'audio.wav', 'audio-qc.json', 'timestamps.json'];
  if (names.some(name => !existsSync(contained(dir, name)))) return null;
  for (const optional of ['cast.json', 'avatar.mp4', 'voice-receipt.json']) if (existsSync(contained(dir, optional))) names.push(optional);
  const qc = readJson<{ lines?: { path: string }[] }>(join(dir, 'audio-qc.json'));
  for (const line of qc.lines ?? []) for (const name of ['audio.wav', 'audio-qc.json', 'timestamps.json', 'line.txt']) names.push(`${line.path}/${name}`);
  if (names.some(name => !existsSync(contained(dir, name)))) return null;
  return roleHash([...new Set(names)].sort().map(name => [name, sha(contained(dir, name))]));
}
function narrationSettings(dir: string, configDir = CONFIG_DIR): string {
  const edition = readJson<{ edition?: string }>(join(dir, 'meta.json'), {}).edition ?? 'daily-roundup';
  return roleHash({ voice: selectedNarrationVoice(configDir), files: ['pipeline.json', 'avatar.json', 'cast.json', `editions/${edition}.json`].map(name => {
    const path = contained(configDir, name); return [name, existsSync(path) ? sha(path) : null];
  }) });
}
function selectedNarrationVoice(configDir = CONFIG_DIR): { engine: string; voice: string } {
  const cfg = readJson<{ ttsEngine: 'kokoro' | 'edge'; voice: string }>(join(configDir, 'pipeline.json'));
  const avatar = readJson<AvatarConfig | null>(join(configDir, 'avatar.json'), null), provider = avatar?.voiceProvider;
  const engine = provider === 'voicebox' || provider === 'elevenlabs' || provider === 'resemble' ? provider : resolveFreeTtsEngine(cfg.ttsEngine);
  const voice = engine === 'voicebox' ? avatar?.voicebox?.profile ?? '' : engine === 'elevenlabs' ? avatar?.elevenlabs.voiceId ?? ''
    : engine === 'resemble' ? avatar?.resemble?.voiceUuid ?? process.env.RESEMBLE_VOICE_UUID ?? '' : resolveFreeVoice(engine === 'edge' ? 'edge' : 'kokoro', cfg.voice);
  return { engine, voice };
}
function narrationPasses(dir: string, configDir = CONFIG_DIR): boolean {
  try {
    const script = readJson<Script>(join(dir, 'script.json')), topic = readJson<Topic>(join(dir, 'topic.json'));
    const props = readJson<RenderProps>(join(dir, 'props.json'));
    const qc = readJson<{ method: string; engine: string; voice: string }>(join(dir, 'audio-qc.json'));
    if (qc.method !== 'raw-asr-cast-concatenation') {
      const selected = selectedNarrationVoice(configDir);
      if (qc.engine !== selected.engine || qc.voice !== selected.voice) return false;
    }
    return !finalMediaFileFindings(dir, topic, script, props).some(finding => finding.target === 'audio');
  } catch { return false; }
}

/** Missing/changed selected cards invalidate only their render, never the accepted words. */
export function renderedSnapshotsMatch(dir: string): boolean {
  try {
    const snapshots = selectedSourceSnapshots(dir), props = readJson<Partial<RenderProps>>(join(dir, 'props.json'));
    for (const [i, expected] of snapshots) {
      if (!props.segments?.[i] || props.segments[i].assetFile !== null || roleHash(props.segments[i].sourceSnapshot ?? null) !== roleHash(expected)) return false;
    }
    return !(props.segments ?? []).some((segment, i) => segment.sourceSnapshot && !snapshots.has(i));
  } catch { return false; }
}

export function renderedMediaHash(dir: string): string | null {
  const required = ['script.json', 'topic.json', 'audio.wav', 'audio-qc.json', 'timestamps.json', 'props.json', 'final.mp4', 'assets.json'];
  if (required.some(name => !existsSync(contained(dir, name)))) return null;
  const assets = readJson<Record<string, string>>(join(dir, 'assets.json'));
  const names = [...new Set([...required, ...Object.values(assets), ...(existsSync(join(dir, 'avatar.mp4')) ? ['avatar.mp4'] : [])])].sort();
  if (names.some(name => !existsSync(contained(dir, name)))) return null;
  return roleHash(names.map(name => [name, sha(contained(dir, name))]));
}
export function rememberRenderedMedia(id: string): void {
  const dir = videoDir(id), hash = renderedMediaHash(dir);
  if (!hash) throw new Error('Rendered package is missing required media or transcript receipts');
  const audio = narrationPasses(dir) ? narrationHash(dir) : null;
  atomicJson(join(dir, 'rendered-media.json'), { version: 1, hash, ...(audio ? { narration: { hash: audio, settings: narrationSettings(dir) } } : {}) });
}
export function canReuseRenderedMedia(id: string, assertLegacySettingsUnchanged?: () => void): boolean {
  const dir = videoDir(id), saved = readJson<RenderReceipt | null>(join(dir, 'rendered-media.json'), null);
  return saved?.version === 1 && saved.hash === renderedMediaHash(dir) && renderedSnapshotsMatch(dir) && canReuseNarration(id, assertLegacySettingsUnchanged);
}

/** Keep exact checked narration/presenter when only visuals need rendering. Historical
 * receipts require the caller's bound continuation to prove unchanged configuration. */
export function canReuseNarration(id: string, assertLegacySettingsUnchanged?: () => void): boolean {
  try {
    const dir = videoDir(id), saved = readJson<RenderReceipt | null>(join(dir, 'rendered-media.json'), null);
    if (saved?.version !== 1 || !narrationPasses(dir)) return false;
    if (saved.narration) return saved.narration.hash === narrationHash(dir) && saved.narration.settings === narrationSettings(dir);
    if (!assertLegacySettingsUnchanged || saved.hash !== renderedMediaHash(dir)) return false;
    assertLegacySettingsUnchanged();
    return true;
  } catch { return false; }
}

/** Preserve the previous render and its exact receipts before a replacement changes props. */
export function preserveRenderedAttempt(id: string, options: { root?: string } = {}): void {
  const dir = contained(options.root ?? activeRoot(), 'workdir/videos', safeId(id));
  if (!existsSync(join(dir, 'final.mp4'))) return;
  const names = ['final.mp4', 'props.json', 'rendered-media.json', 'media-completion.json', 'final-media-qc/latest.json']
    .filter(name => existsSync(contained(dir, name)));
  const manifest = names.map(name => [name, sha(contained(dir, name))] as const);
  const out = contained(dir, 'render-attempts', roleHash(manifest)); mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const [name, hash] of manifest) {
    const target = contained(out, name.replaceAll('/', '__'));
    if (!existsSync(target)) copyFileSync(contained(dir, name), target, constants.COPYFILE_EXCL);
    if (sha(target) !== hash) throw new Error('Previous render evidence changed; replacement is held');
  }
  atomicJson(join(out, 'manifest.json'), { version: 1, files: Object.fromEntries(manifest) });
}

export interface CompletionState {
  version: 1; parent: string; continuation?: { identity: string; priorCompletionHash: string; priorAttempts: number }; attempts: { status: 'started' | 'finished'; result?: FinalMediaReview }[];
  preflightCorrection?: CandidatePreflightCorrection;
  adapterCorrection?: CandidatePreflightCorrection;
  visualRevision?: VisualPresentationRevision & { identity: string };
  repairs: { review: string; targets: string[]; status: 'started' | 'finished'; snapshot?: {
    before: string; after?: string; narration: string; settings: string; choices: string;
  } }[];
}
export interface FinalReviewRecovery {
  version: 1; originalCompletionHash: string; mediaHash: string; receiptHash: string;
  attempts: number; evidence: Record<string, string>;
}
export interface MediaReviewRecoveryContext {
  mediaReviewRecovery?: { identity: string; receipt: FinalReviewRecovery; assertUnchanged(): void };
  mediaVisualRevision?: { identity: string; receipt: VisualPresentationRevision; assertUnchanged(): void };
}
export interface VisualPresentationRevision {
  version: 1; archivePath: string; archiveHash: string; priorAttempts: number; priorRepairs: number;
  evidence: Record<string, string>;
}
/** Inspect before explicit authorization. Old results are evidence, never discarded allowances. */
export function inspectVisualPresentationRevision(id: string, parent: string, options: { root?: string } = {}): VisualPresentationRevision {
  const dir = contained(options.root ?? activeRoot(), 'workdir/videos', safeId(id)), path = contained(dir, 'media-completion.json');
  const bytes = existsSync(path) ? readFileSync(path) : Buffer.from(JSON.stringify({ version: 1, parent, attempts: [], repairs: [] }, null, 2));
  const state = JSON.parse(bytes.toString()) as CompletionState;
  if (state.version !== 1 || state.parent !== parent || state.visualRevision || !Array.isArray(state.attempts) || state.attempts.length >= 9
      || state.attempts.some(row => row.status !== 'finished' || !row.result) || !Array.isArray(state.repairs)
      || state.repairs.some(row => row.status !== 'finished')) throw new Error('Visual revision requires completed, unmodified prior operations and remaining attempts');
  const evidence: Record<string, string> = {};
  for (const row of state.attempts) {
    const review = row.result!;
    if (!/^final-media-qc\/[a-f0-9]{16}-[a-f0-9-]+$/.test(review.evidencePath)) throw new Error('Visual revision needs the retained final-review evidence');
    const saved = readJson<FinalMediaReview & { frames: { path: string }[] }>(contained(dir, review.evidencePath, 'result.json'));
    const { frames, ...savedReview } = saved;
    if (roleHash(savedReview) !== roleHash(review)) throw new Error('Prior visual review differs from its receipt');
    for (const name of ['inputs.json', 'result.json', 'review-request.json', 'review-response.json']) {
      const relative = `${review.evidencePath}/${name}`;
      if (existsSync(contained(dir, relative))) evidence[relative] = sha(contained(dir, relative));
    }
    for (const frame of frames ?? []) evidence[frame.path] = sha(contained(dir, frame.path));
  }
  const archiveHash = createHash('sha256').update(bytes).digest('hex');
  return { version: 1, archivePath: `visual-revision-evidence/${archiveHash}.json`, archiveHash, priorAttempts: state.attempts.length, priorRepairs: state.repairs.length, evidence };
}

export function beginVisualPresentationRevision(id: string, parent: string, identity: string, expectedArchiveHash: string, options: { root?: string } = {}): VisualPresentationRevision {
  if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error('Visual revision needs its explicit authorization identity');
  const receipt = inspectVisualPresentationRevision(id, parent, options);
  if (receipt.archiveHash !== expectedArchiveHash) throw new Error('Previous presentation changed before authorization');
  const dir = contained(options.root ?? activeRoot(), 'workdir/videos', safeId(id)), path = contained(dir, 'media-completion.json');
  const bytes = existsSync(path) ? readFileSync(path) : Buffer.from(JSON.stringify({ version: 1, parent, attempts: [], repairs: [] }, null, 2));
  const state = JSON.parse(bytes.toString()) as CompletionState, archive = contained(dir, receipt.archivePath);
  preserveRenderedAttempt(id, options);
  mkdirSync(contained(dir, 'visual-revision-evidence'), { recursive: true, mode: 0o700 });
  writeFileSync(archive, bytes, { flag: 'wx', mode: 0o600 });
  const { continuation, preflightCorrection, adapterCorrection, ...retained } = state;
  atomicJson(path, { ...retained, visualRevision: { ...receipt, identity } });
  assertVisualPresentationRevision(id, parent, identity, receipt, options);
  return receipt;
}

export function assertVisualPresentationRevision(id: string, parent: string, identity: string, receipt: VisualPresentationRevision, options: { root?: string } = {}): void {
  const dir = contained(options.root ?? activeRoot(), 'workdir/videos', safeId(id));
  const archive = contained(dir, receipt.archivePath), current = readJson<CompletionState>(contained(dir, 'media-completion.json'));
  if (receipt.version !== 1 || receipt.archivePath !== `visual-revision-evidence/${receipt.archiveHash}.json` || sha(archive) !== receipt.archiveHash
      || current.parent !== parent || current.continuation || current.preflightCorrection || current.adapterCorrection
      || roleHash(current.visualRevision) !== roleHash({ ...receipt, identity })) throw new Error('Visual presentation authorization or original archive changed');
  const prior = readJson<CompletionState>(archive);
  if (prior.parent !== parent || prior.attempts.length !== receipt.priorAttempts || prior.repairs.length !== receipt.priorRepairs
      || current.attempts.length < receipt.priorAttempts || current.attempts.length > 9
      || roleHash(current.attempts.slice(0, receipt.priorAttempts)) !== roleHash(prior.attempts)
      || roleHash(current.repairs.slice(0, receipt.priorRepairs)) !== roleHash(prior.repairs)) throw new Error('Visual revision cannot erase or refund previous attempts');
  for (const [path, hash] of Object.entries(receipt.evidence)) if (sha(contained(dir, path)) !== hash) throw new Error('Historical visual review evidence changed');
}

/** Only expired preflight checks without a provider call or content finding qualify.
 * Every old verdict and its input receipt must still describe the exact saved media. */
export function inspectExpiredMediaReview(dir: string, root: string, parent: string, writerKey: string): FinalReviewRecovery {
  const path = contained(dir, 'media-completion.json'), state = readJson<CompletionState>(path);
  const fail = () => { throw new Error('Final-media continuation requires unchanged deadline-only preflight evidence without a model or content verdict'); };
  if (state.version !== 1 || state.parent !== parent || state.continuation || !Array.isArray(state.attempts)
      || !state.attempts.length || state.attempts.length >= 9 || !Array.isArray(state.repairs) || state.repairs.length) fail();
  const evidence: Record<string, string> = {}, inputHash = state.attempts[0]?.result?.inputHash;
  if (!inputHash || !/^[a-f0-9]{64}$/.test(inputHash)) fail();
  for (const row of state.attempts) {
    const r = row.result;
    if (row.status !== 'finished' || !r || r.version !== 1 || r.ok !== false || r.failureKind !== 'infrastructure'
        || r.inputHash !== inputHash || r.audioListeningApproved !== false || r.publicationReady !== false
        || !Array.isArray(r.repairTargets) || r.repairTargets.length || r.reviewer?.parentIdentity !== parent || r.reviewer.writerKey !== writerKey
        || !Array.isArray(r.reviewer.attempts) || r.reviewer.attempts.length || !Array.isArray(r.findings) || r.findings.length !== 1
        || r.findings[0].severity !== 'blocking' || r.findings[0].kind !== 'infrastructure' || r.findings[0].target !== 'render'
        || r.findings[0].detail !== 'Technical review unavailable: Local role parent reached its total time ceiling') fail();
    const review = r!;
    if (!/^final-media-qc\/[a-f0-9]{16}-[a-f0-9-]+$/.test(review.evidencePath)) fail();
    const inputName = `${review.evidencePath}/inputs.json`, resultName = `${review.evidencePath}/result.json`;
    const inputs = readJson<any>(contained(dir, inputName)), saved = readJson<any>(contained(dir, resultName));
    const { frames, ...savedResult } = saved;
    if (roleHash(inputs) !== inputHash || inputs.parent !== parent || inputs.writerKey !== writerKey
        || inputs.expectedDurationSec !== readJson<any>(contained(dir, 'meta.json')).durationSec
        || roleHash(savedResult) !== roleHash(review) || !Array.isArray(frames) || frames.length
        || existsSync(contained(dir, review.evidencePath, 'review-request.json')) || existsSync(contained(dir, review.evidencePath, 'review-response.json'))
        || !inputs.files || !Object.keys(inputs.files).length) fail();
    for (const [name, expected] of Object.entries(inputs.files)) if (sha(contained(dir, name)) !== expected) fail();
    evidence[inputName] = sha(contained(dir, inputName)); evidence[resultName] = sha(contained(dir, resultName));
  }
  const mediaHash = renderedMediaHash(dir), receipt = readJson<RenderReceipt>(contained(dir, 'rendered-media.json'));
  if (!mediaHash || receipt.version !== 1 || receipt.hash !== mediaHash || !renderedSnapshotsMatch(dir)
      || !narrationPasses(dir, contained(root, 'config')) || !receipt.narration
      || receipt.narration.hash !== narrationHash(dir) || receipt.narration.settings !== narrationSettings(dir, contained(root, 'config'))) fail();
  return { version: 1, originalCompletionHash: sha(path), mediaHash: mediaHash!, receiptHash: sha(contained(dir, 'rendered-media.json')), attempts: state.attempts.length, evidence };
}

/** The archive and prefix remain immutable after parent adoption; the new check appends. */
export function assertRetainedMediaReview(dir: string, identity: string, receipt: FinalReviewRecovery): void {
  const archive = contained(dir, 'media-continuation-evidence', `${receipt.originalCompletionHash}.json`);
  if (sha(archive) !== receipt.originalCompletionHash || renderedMediaHash(dir) !== receipt.mediaHash
      || sha(contained(dir, 'rendered-media.json')) !== receipt.receiptHash) throw new Error('Retained final-media evidence changed; continuation is held');
  for (const [name, hash] of Object.entries(receipt.evidence)) if (sha(contained(dir, name)) !== hash) throw new Error('Original final-media review evidence changed');
  const original = readJson<CompletionState>(archive), current = readJson<CompletionState>(contained(dir, 'media-completion.json'));
  const corrected = current.attempts?.[receipt.attempts];
  const correction = corrected?.status === 'finished' && corrected.result?.reviewer.parentIdentity === identity
    ? candidatePreflightCorrection(dir, corrected.result) : undefined;
  if (current.preflightCorrection && (!correction || roleHash(current.preflightCorrection) !== roleHash(correction))) {
    throw new Error('The recorded catalog preflight correction no longer matches its exact evidence');
  }
  const adapterRow = current.attempts?.[receipt.attempts + (current.preflightCorrection ? 1 : 0)];
  const adapterCorrection = adapterRow?.status === 'finished' && adapterRow.result?.reviewer.parentIdentity === identity
    ? grokImageAdapterCorrection(dir, adapterRow.result) : undefined;
  if (current.adapterCorrection && (!adapterCorrection || roleHash(current.adapterCorrection) !== roleHash(adapterCorrection))) throw new Error('The authorized image adapter correction no longer matches its exact evidence');
  if (current.parent !== identity || roleHash(current.continuation) !== roleHash({ identity, priorCompletionHash: receipt.originalCompletionHash, priorAttempts: receipt.attempts })
      || !Array.isArray(current.attempts) || current.attempts.length < receipt.attempts || current.attempts.length > receipt.attempts + 1 + (current.preflightCorrection ? 1 : 0) + (current.adapterCorrection ? 1 : 0)
      || roleHash(current.attempts.slice(0, receipt.attempts)) !== roleHash(original.attempts) || roleHash(current.repairs) !== roleHash(original.repairs)) {
    throw new Error('Original final-media attempt or repair allowance changed; continuation is held');
  }
}

/** Explicit repair authorization after a verified adapter correction; not an automatic retry. */
export function authorizeImageAdapterCorrection(id: string, context: Context & MediaReviewRecoveryContext, expectedReviewHash: string): void {
  assertMediaRepairAllowed(id);
  const recovery = context.mediaReviewRecovery;
  if (!recovery) throw new Error('Image adapter recovery needs the existing authorized media continuation');
  const state = completionState(id, context.parent.parentIdentity, recovery), previous = state.attempts.at(-1);
  if (!state.continuation || state.adapterCorrection || state.attempts.length !== state.continuation.priorAttempts + 1 + (state.preflightCorrection ? 1 : 0)
      || previous?.status !== 'finished' || !previous.result || roleHash(previous.result) !== expectedReviewHash) throw new Error('Image adapter recovery does not match the exact spent operation');
  const correction = grokImageAdapterCorrection(videoDir(id), previous.result);
  if (!correction) throw new Error('Only the recorded local CLI image rejection can receive this adapter correction');
  state.adapterCorrection = correction; atomicJson(join(videoDir(id), 'media-completion.json'), state); recovery.assertUnchanged();
}
function completionState(id: string, parent: string, recovery?: MediaReviewRecoveryContext['mediaReviewRecovery']): CompletionState {
  const state = readJson<CompletionState>(join(videoDir(id), 'media-completion.json'), { version: 1, parent, attempts: [], repairs: [] });
  if (state.version !== 1 || state.parent !== parent || !Array.isArray(state.attempts) || state.attempts.length > 9 || !Array.isArray(state.repairs) || state.repairs.length > 2) throw new Error('Final-media recovery receipt changed; original allowance is retained');
  if (state.continuation) {
    if (!recovery || recovery.identity !== parent) throw new Error('Final-media continuation needs its exact authorized context');
    recovery.assertUnchanged();
  }
  if (state.repairs.some(row => row.status !== 'finished')) throw new Error('A reserved media repair was interrupted. Reconcile its saved artifacts before resuming; no new repair was purchased.');
  return state;
}
export function assertMediaRepairAllowed(id: string): void {
  const dir = videoDir(id), meta = readJson<Partial<VideoMeta>>(join(dir, 'meta.json'), {}), deliveryLog = join(dir, 'delivery-events.jsonl');
  if (meta.reviewHold || meta.rejectReason || meta.approvedBy || meta.explicitApproval || Object.keys(meta.posts ?? {}).length || Object.keys(meta.delivery ?? {}).length
      || ['rejected', 'approved', 'posted'].includes(meta.status ?? '') || readdirSync(dir).some(name => name.startsWith('.delivery-'))
      || existsSync(deliveryLog) && statSync(deliveryLog).size > 0) {
    throw new Error('Media repair is held by the saved review or publication decision; accepted artifacts are unchanged');
  }
}

/** One already-authorized render correction, recorded against its actual failed
 * review before execution. It cannot waive audio/source failures or refill repairs. */
export function beginSnapshotRenderRepair(id: string, parent: string, assertLegacySettingsUnchanged?: () => void): (() => void) | undefined {
  assertMediaRepairAllowed(id);
  const dir = videoDir(id), path = join(dir, 'media-completion.json'), state = completionState(id, parent);
  if (state.visualRevision && state.attempts.length === state.visualRevision.priorAttempts) {
    if (!assertLegacySettingsUnchanged) throw new Error('Visual presentation replacement requires its authorized context');
    assertLegacySettingsUnchanged();
    return undefined; // Explicit new visual selection, not a repair of an old content verdict.
  }
  const previous = state.attempts.at(-1)?.result;
  if (!previous || previous.ok || previous.failureKind !== 'content' || renderedSnapshotsMatch(dir)) return undefined;
  const blocked = previous.findings.filter(row => row.severity === 'blocking');
  if (!blocked.length || blocked.some(row => row.kind !== 'content' || !['visual', 'render'].includes(row.target))
      || !previous.repairTargets.length || previous.repairTargets.some(target => !['visual', 'render'].includes(target))) {
    throw new Error('Snapshot rendering cannot resolve the recorded non-visual hold; original review is retained');
  }
  if (!canReuseNarration(id, assertLegacySettingsUnchanged)) throw new Error('Snapshot rendering requires exact checked narration and unchanged selected voice');
  if (state.repairs.length >= 2 || state.repairs.some(row => row.review === previous.evidencePath)) throw new Error('Final media still needs correction; the original repair allowance cannot be renewed');
  const before = renderedMediaHash(dir), narration = narrationHash(dir);
  if (!before || !narration) throw new Error('Snapshot rendering requires the complete previous media evidence');
  const repair: CompletionState['repairs'][number] = { review: previous.evidencePath, targets: ['render'], status: 'started',
    snapshot: { before, narration, settings: narrationSettings(dir), choices: roleHash([...selectedSourceSnapshots(dir)]) } };
  state.repairs.push(repair); atomicJson(path, state);
  const index = state.repairs.length - 1, reserved = roleHash(repair);
  return () => {
    assertMediaRepairAllowed(id);
    const current = readJson<CompletionState>(path), row = current.repairs[index], after = renderedMediaHash(dir);
    if (current.parent !== parent || !row || roleHash(row) !== reserved || row.status !== 'started'
        || !after || after === before || narrationHash(dir) !== narration || narrationSettings(dir) !== repair.snapshot!.settings
        || roleHash([...selectedSourceSnapshots(dir)]) !== repair.snapshot!.choices || !renderedSnapshotsMatch(dir)) {
      throw new Error('Snapshot correction did not preserve the exact narration, choices and recorded media repair');
    }
    row.snapshot!.after = after; row.status = 'finished'; atomicJson(path, current);
  };
}
export async function completeMediaReview(id: string, context: Context & MediaReviewRecoveryContext, actions: {
  render: () => Promise<void>; voice: () => Promise<void>;
  visual?: (findings: string[]) => Promise<void>;
  review?: () => Promise<FinalMediaReview>; saveMedia?: () => void;
}): Promise<void> {
  const path = join(videoDir(id), 'media-completion.json');
  const state = completionState(id, context.parent.parentIdentity, context.mediaReviewRecovery);
  const save = () => atomicJson(path, state);
  const recovery = context.mediaReviewRecovery;
  const visualRevision = context.mediaVisualRevision;
  const assertRevision = () => {
    if (!state.visualRevision && !visualRevision) return;
    if (!state.visualRevision || !visualRevision || state.visualRevision.identity !== visualRevision.identity) throw new Error('Visual revision needs its exact authorized context');
    visualRevision.assertUnchanged();
    assertVisualPresentationRevision(id, context.parent.parentIdentity, visualRevision.identity, visualRevision.receipt);
  };
  assertRevision();
  const reviewStart = state.visualRevision?.priorAttempts ?? 0;
  recovery?.assertUnchanged();
  // Versioned deterministic correction: the one authorized model check was never
  // dispatched when the options catalog alone appeared newer than the video.
  // Keep that failed row, reserve at most one new check, and never refill budgets.
  if (recovery && state.continuation && !state.preflightCorrection && state.attempts.length === state.continuation.priorAttempts + 1) {
    const previous = state.attempts.at(-1);
    const correction = previous?.status === 'finished' && previous.result?.reviewer.parentIdentity === context.parent.parentIdentity
      ? candidatePreflightCorrection(videoDir(id), previous.result) : undefined;
    if (correction) { assertMediaRepairAllowed(id); state.preflightCorrection = correction; save(); recovery.assertUnchanged(); }
  }
  const review = actions.review ?? (() => reviewFinalMedia(id, { context }));
  // Successful exact-byte reuse belongs to the review cache, not the retry allowance.
  // If any input changed the reviewer will check it and the new result is recorded below.
  if (state.attempts.length > reviewStart && state.attempts.at(-1)?.result?.ok && canReuseRenderedMedia(id)) {
    const result = await review();
    if (result.ok) return;
    state.attempts.push({ status: 'finished', result }); save();
  }
  while (state.attempts.length < 9) {
    assertRevision();
    recovery?.assertUnchanged();
    const correctedPreflight = !!state.preflightCorrection && !!state.continuation && state.attempts.length === state.continuation.priorAttempts + 1;
    const correctedAdapter = !!state.adapterCorrection && !!state.continuation && state.attempts.length === state.continuation.priorAttempts + 1 + (state.preflightCorrection ? 1 : 0);
    if (state.continuation && state.attempts.length > state.continuation.priorAttempts && !correctedPreflight && !correctedAdapter) throw new Error('The one authorized final-media continuation check is spent; original evidence and allowances are retained');
    const previous = state.attempts.length > reviewStart ? state.attempts.at(-1)?.result : undefined;
    const dir = videoDir(id);
    const completedSnapshot = previous && state.repairs.some(row => row.review === previous.evidencePath && row.status === 'finished' && row.snapshot
      && row.snapshot.after === renderedMediaHash(dir) && row.snapshot.narration === narrationHash(dir) && row.snapshot.settings === narrationSettings(dir)
      && row.snapshot.choices === roleHash([...selectedSourceSnapshots(dir)]) && renderedSnapshotsMatch(dir));
    if (previous && !previous.ok && previous.failureKind === 'content' && !completedSnapshot && !correctedPreflight) {
      if (state.repairs.length >= 2 || state.repairs.some(row => row.review === previous.evidencePath)) throw new Error(`Final media still needs correction: ${previous.findings.filter(row => row.severity === 'blocking').map(row => row.detail).join('; ')}. Text and media remain saved.`);
      const targets = previous.repairTargets;
      const details = previous.findings.filter(row => row.severity === 'blocking').map(row => row.detail);
      // Visual defects must never trigger rewriting an accepted script/newsletter.
      if (targets.includes('visual') && !actions.visual) throw new Error(`Final visual correction required: ${details.join('; ')}. Accepted script and newsletter remain unchanged; review the saved visual choice.`);
      const repair: CompletionState['repairs'][number] = { review: previous.evidencePath, targets, status: 'started' };
      state.repairs.push(repair); save();
      if (targets.length && targets.every(target => target === 'render')) await actions.render();
      else if (targets.length && targets.every(target => target === 'audio' || target === 'render')) { await actions.voice(); await actions.render(); }
      else if (targets.includes('visual')) { await actions.visual!(details); if (targets.includes('audio')) await actions.voice(); await actions.render(); }
      else throw new Error('Final media review returned no actionable media target; approved text is retained.');
      (actions.saveMedia ?? (() => rememberRenderedMedia(id)))();
      repair.status = 'finished'; save();
    }
    const currentAttempts = state.attempts.slice(reviewStart);
    const consecutiveUnavailable = currentAttempts.slice().reverse().findIndex(row => row.result?.failureKind !== 'infrastructure');
    const unavailableCount = consecutiveUnavailable === -1 ? currentAttempts.length : consecutiveUnavailable;
    const authorizedFreshCheck = state.continuation && state.attempts.length === state.continuation.priorAttempts || correctedAdapter;
    if (unavailableCount >= 3 && !authorizedFreshCheck) throw new Error('Final-media reviewer remained unavailable after two retries. The same text and media are saved; the original allowance was not reset.');
    const attempt: CompletionState['attempts'][number] = { status: 'started' }; state.attempts.push(attempt); save();
    const result = await review(); recovery?.assertUnchanged(); assertRevision(); attempt.result = result; attempt.status = 'finished'; save();
    if (result.ok) return;
    if (result.failureKind === 'infrastructure') continue; // Same exact media, never another synthesis/render.
  }
  throw new Error('Final-media recovery reached its bounded attempt limit. Text and media remain saved.');
}
