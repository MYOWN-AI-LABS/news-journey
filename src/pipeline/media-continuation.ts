/** An explicitly authorized media-only continuation. Original editorial allowances are immutable. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { atomicJson, authorize, contained, safeId } from '../workspaces.js';
import { releaseLock, waitForReleaseLock } from '../release-lock.js';
import { roleHash, type ParentWorkScope } from '../llm/role-router.js';
import { resolveModelRuntime, type ModelConfig } from '../llm/model.js';
import { createPreparedRoleDispatch, createPreparedVisionDispatch, type PreparedDispatchAdapters, type PreparedVisionAdapters } from '../llm/prepared-role-dispatch.js';
import { SCRIPT_FIRST_EDITORIAL_VERSION, type DailyEditorialCheckpoint, type DailyEditorialInput } from './daily-editorial.js';
import { reviewedJourneyScript } from './narration.js';
import { assertPreparedModelTask, type PreparedModelTask } from './writing-task.js';
import type { Script, Topic } from '../types.js';
import type { Issue } from './newsletter.js';
import type { packageWritingContext } from './writing-context.js';
import { readSourceVisualConcept } from './visual-development.js';
import { inspectVisualPresentationRevision, beginVisualPresentationRevision, assertVisualPresentationRevision, inspectExpiredMediaReview, assertRetainedMediaReview, type VisualPresentationRevision, type CompletionState, type FinalReviewRecovery, type MediaReviewRecoveryContext } from './media-completion.js';
import { sealEditorialContinuation, assertEditorialContinuationSeal } from './journey-editorial-continuation.js';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const files = ['writing-request.json', 'topic.json', 'script.json', 'journey-editorial-input.json', 'journey-editorial-checkpoint.json', 'journey-editorial-issue.json', 'journey-editorial-receipt.json', 'companion-writing-receipt.json'] as const;
const journalPath = (root: string, id: string) => contained(root, 'workdir/videos', safeId(id), 'media-continuation.json');
const budgetPath = (root: string, id: string, parent: string) => contained(root, 'state/role-tasks', safeId(id), roleHash({ version: 1, parent }), 'budget.json');
function bytesHash(root: string, path: string): string {
  const actual = realpathSync(path), rel = relative(realpathSync(root), actual);
  assert.ok(rel && !rel.startsWith('..'), 'Media continuation input escapes its workspace');
  return sha(readFileSync(actual));
}
interface Budget { version: 1; identity: string; deadline: number; deadlinePolicy?: 'operation-only'; maxPhysicalCalls: number; attempts: unknown[]; maxToolCalls: number; tools: unknown[] }
interface JournalBody {
  version: 1; kind: 'approved-media-only'; authorization: 'explicit-user'; packageId: string; authorizedAt: number; deadline: null; deadlinePolicy: 'operation-only';
  workspaceHash: string; authorizedBy: string; edition: string;
  writerKeyHash: string; original: { parentIdentity: string; budgetHash: string; deadline: number; maxPhysicalCalls: number; physicalAttempts: number; maxToolCalls: number; toolAttempts: number };
  approvedFiles: Record<string, string>; settingsFiles: Record<string, string>;
  finalReviewRecovery?: FinalReviewRecovery;
  editorialPredecessor?: ReturnType<typeof sealEditorialContinuation>;
  visualRecovery?: { version: 1; sourceDevelopmentHash: string; originalDiagrams: unknown[]; originalPhoneReview: unknown[] };
  limits: { totalSeconds: number; maxPhysicalCalls: number; maxToolCalls: number };
}
export interface MediaContinuationJournal extends JournalBody { identity: string }
export interface MediaContinuationApproval {
  intent: 'continue-approved-media'; expectedWriterKey: string; expectedScriptHash: string;
  expectedNewsletterHash: string; expectedOriginalBudgetHash: string; deadlinePolicy: 'operation-only';
}
type Context = Awaited<ReturnType<typeof packageWritingContext>>;

function configHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = contained(dir, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Media continuation requires contained configuration files, without symbolic-link aliases');
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.json') && relative(root, path) !== 'config/watchdog.json') out[relative(root, path)] = bytesHash(root, path);
    }
  };
  visit(contained(root, 'config'));
  for (const name of ['.env', 'CONTENT.md', 'state/personal-profile.json', 'state/journey-brief.json']) {
    const path = contained(root, name);
    if (existsSync(path)) out[name] = bytesHash(root, path);
  }
  return out;
}

function access(root: string, id: string, allowCompletedRead = false) {
  const dir = contained(root, 'workdir/videos', safeId(id));
  const meta = read<any>(contained(dir, 'meta.json'));
  assert.ok(meta?.id === id && typeof meta.createdBy === 'string', 'Media continuation requires its exact authored package');
  const edition = safeId(meta.edition || 'daily-roundup');
  const actor = authorize('produce', { root, edition, author: meta.createdBy });
  assert.equal(actor.id, meta.createdBy, 'Media continuation belongs to another author');
  const allowed = ['scripted', 'assets_ready', 'awaiting_visual_choice', 'voiced', 'avatar_generated', 'rendered', 'failed:assets', 'failed:visuals', 'failed:voice', 'failed:avatar', 'failed:render', 'failed:final-media-qc', 'failed:newsletter-media', ...(allowCompletedRead ? ['pending_review'] : [])];
  const deliveryLog = contained(dir, 'delivery-events.jsonl');
  assert.ok(allowed.includes(meta.status) && !meta.reviewHold && !meta.rejectReason && !meta.approvedBy && !meta.explicitApproval
    && !Object.keys(meta.posts ?? {}).length && !Object.keys(meta.delivery ?? {}).length
    && !readdirSync(dir).some(name => name.startsWith('.delivery-'))
    && (!existsSync(deliveryLog) || statSync(deliveryLog).size === 0), 'Media continuation is held: package is rejected, awaiting editorial review, approved, posted, or has delivery activity');
  const workspace = contained(root, 'workspace.json');
  const workspaceHash = roleHash({ root: realpathSync(root), workspace: existsSync(workspace) ? read<any>(workspace).id : null });
  return { actor, edition, workspaceHash, status: meta.status as string };
}

function accepted(root: string, id: string, env: NodeJS.ProcessEnv) {
  const dir = contained(root, 'workdir/videos', safeId(id));
  const request = read<any>(contained(dir, 'writing-request.json'));
  const topic = read<Topic>(contained(dir, 'topic.json')), script = read<Script>(contained(dir, 'script.json'));
  const issue = read<Issue>(contained(dir, 'journey-editorial-issue.json'));
  const source = read<{ input: DailyEditorialInput; hash: string }>(contained(dir, 'journey-editorial-input.json'));
  const checkpoint = read<DailyEditorialCheckpoint>(contained(dir, 'journey-editorial-checkpoint.json'));
  const receipt = read<any>(contained(dir, 'companion-writing-receipt.json')), editorial = read<any>(contained(dir, 'journey-editorial-receipt.json'));
  assert.ok(topic.id === id && request.outputs === 'edition' && request.preparedHash === roleHash(topic)
    && digest(request.parentIdentity) && request.originalHash === roleHash(request.original)
    && request.settingsSnapshot?.hash === roleHash(request.settingsSnapshot?.settings), 'Media continuation requires the unchanged prepared edition');
  assert.ok(receipt.version === 3 && receipt.reviewProtocol === 'daily-editorial' && receipt.editorialVersion === SCRIPT_FIRST_EDITORIAL_VERSION
    && receipt.topicHash === roleHash(topic) && receipt.scriptHash === roleHash(script) && receipt.checkpointHash === roleHash(checkpoint)
    && source.hash === roleHash(source.input) && receipt.inputHash === source.hash
    && Object.keys(checkpoint.artifacts).sort().join(',') === 'newsletter,script' && checkpoint.contentHash === roleHash(checkpoint.artifacts), 'Media continuation requires exact accepted script evidence');
  const written = checkpoint.artifacts.script, formatted = checkpoint.artifacts.newsletter;
  const candidate = written.candidates.at(-1) as unknown as Script, review = written.reviews.at(-1);
  assert.ok(written.status === 'accepted' && review?.output.verdict === 'supported' && review.candidateHash === roleHash(candidate)
    && formatted.status === 'accepted' && formatted.reviews.length === 0 && formatted.formatting?.version === 1
    && formatted.formatting.checks === 'shape-length-formatting' && formatted.formatting.approvedScriptHash === roleHash(candidate)
    && formatted.formatting.candidateHash === roleHash(formatted.candidates.at(-1)), 'Both script approval and script-derived newsletter formatting must already pass');
  assert.equal(roleHash(script), roleHash(reviewedJourneyScript(candidate, source.input.stories.map(story => story.primaryUrl))), 'Accepted narration changed');
  assert.ok(editorial.editorialVersion === SCRIPT_FIRST_EDITORIAL_VERSION && editorial.parentIdentity === request.parentIdentity
    && editorial.writerKey === receipt.writerKey && editorial.inputHash === source.hash && editorial.checkpointHash === roleHash(checkpoint)
    && editorial.issueHash === roleHash(issue) && editorial.scriptHash === roleHash(script), 'Accepted newsletter receipt does not match the saved issue');
  const identity = JSON.parse(receipt.writerKey), settings = request.settingsSnapshot.settings;
  assert.ok(identity.settingsHash === request.settingsSnapshot.hash && identity.memoryHash === request.memory?.hash
    && roleHash(identity.config) === roleHash({ ...settings.model, rescue: { enabled: false } })
    && roleHash(identity.rolePolicy) === roleHash(settings.rolePolicy) && roleHash(identity.runtime) === roleHash(settings.runtime), 'Saved writer identity changed');
  const model = read<ModelConfig>(contained(root, 'config/model.json'));
  assert.equal(roleHash(model), roleHash(settings.model), 'Selected model settings changed since script approval');
  const runtime = resolveModelRuntime(model, env);
  assert.equal(roleHash({ ...runtime, apiKey: undefined }), roleHash(identity.runtime), 'Selected model runtime changed since script approval');
  assert.ok(!identity.rolePolicy, 'Media continuation currently requires the single selected model, without a separate role-model policy');
  return { dir, request, topic, script, issue, source, writerKey: receipt.writerKey as string, model };
}

function assertNoVisualRejection(dir: string): void {
  assert.ok(!readdirSync(dir).some(name => /^(?:diagram-source-rejected-|visual-choice-failure-)/.test(name)),
    'Visual continuation cannot waive a recorded source or selected-visual rejection');
  for (const name of ['diagrams.json', 'diagram-phone-review.json']) {
    if (!existsSync(contained(dir, name))) continue;
    const rows = read<any[]>(contained(dir, name));
    assert.ok(Array.isArray(rows) && rows.every(row => (name === 'diagrams.json' ? row?.review?.status : row?.status) !== 'failed'),
      'Visual continuation cannot waive a completed rejected visual');
  }
  const candidates = contained(dir, 'visual-candidates.json');
  if (existsSync(candidates)) assert.ok(!read<any>(candidates)?.stories?.some((story: any) => story.candidates?.some((row: any) => row.failed)),
    'Visual continuation cannot waive a rejected visual candidate');
}
function visualSources(input: ReturnType<typeof accepted>): string {
  const saved = read<any>(contained(input.dir, 'visual-development.json'));
  assert.ok(saved.status === 'ready' && Array.isArray(saved.failures) && !saved.failures.length
    && saved.concepts?.length === input.script.body.length && input.topic.stories?.length === input.script.body.length,
    'Visual continuation requires complete accepted source concepts');
  input.script.body.forEach((_, index) => assert.ok(readSourceVisualConcept(input.dir, input.topic, index,
    { day: input.source.input.day, writerKey: input.writerKey, retainedDecoderVersion: 2 }), 'Visual continuation requires every accepted source concept'));
  return sha(readFileSync(contained(input.dir, 'visual-development.json')));
}
function recoverableVisualFailure(input: ReturnType<typeof accepted>): NonNullable<JournalBody['visualRecovery']> {
  const sourceDevelopmentHash = visualSources(input);
  assertNoVisualRejection(input.dir);
  const diagrams = read<any[]>(contained(input.dir, 'diagrams.json')), reviews = read<any[]>(contained(input.dir, 'diagram-phone-review.json'));
  assert.ok(Array.isArray(diagrams) && diagrams.length === input.script.body.length && Array.isArray(reviews) && reviews.length === diagrams.length
    && reviews.some(row => row?.status === 'unverified')
    && reviews.every((row, index) => row && digest(row.sha256) && roleHash(row) === roleHash(diagrams[index]?.review)
      && (row.status === 'passed' || row.status === 'unverified' && typeof row.reason === 'string'
        && /timed out|timeout|(?:parent|original).*(?:deadline|time ceiling)/i.test(row.reason))),
    'Visual continuation requires exact unverified timeout evidence, not a rejected or unknown visual hold');
  return { version: 1, sourceDevelopmentHash, originalDiagrams: diagrams, originalPhoneReview: reviews };
}

function originalBudget(root: string, id: string, parent: string): Budget {
  const budget = read<Budget>(budgetPath(root, id, parent));
  assert.ok(budget.version === 1 && budget.identity === roleHash({ version: 1, parent }) && Number.isFinite(budget.deadline)
    && Number.isSafeInteger(budget.maxPhysicalCalls) && budget.maxPhysicalCalls >= 1 && budget.maxPhysicalCalls <= 100 && Array.isArray(budget.attempts) && budget.attempts.length <= budget.maxPhysicalCalls
    && budget.attempts.every((value: any) => value && typeof value.task === 'string' && Number.isFinite(value.at) && typeof value.provider === 'string' && typeof value.model === 'string' && Number.isSafeInteger(value.promptBytes) && value.promptBytes >= 0)
    && Number.isSafeInteger(budget.maxToolCalls) && budget.maxToolCalls >= 0 && budget.maxToolCalls <= 32 && Array.isArray(budget.tools) && budget.tools.length <= budget.maxToolCalls
    && budget.tools.every((value: any) => value && typeof value.task === 'string' && typeof value.tool === 'string' && Number.isFinite(value.at)), 'Original allowance is invalid; continuation cannot repair or replace it');
  return budget;
}

/** Call only for explicit authorization of this exact already accepted package. Never automatic. */
export function authorizeMediaContinuation(root: string, id: string, approval: MediaContinuationApproval, options: { now?: () => number; env?: NodeJS.ProcessEnv } = {}): MediaContinuationJournal {
  root = realpathSync(root); safeId(id);
  assert.ok(approval.intent === 'continue-approved-media' && approval.deadlinePolicy === 'operation-only', 'Media continuation needs explicit authorization; operation timeouts and remaining call counts apply');
  const permission = access(root, id);
  const unlock = releaseLock(root, `media-continuation-${roleHash(id).slice(0, 16)}`);
  let unlockBudget: (() => void) | undefined;
  try {
    unlockBudget = waitForReleaseLock(root, 'local-role-budget');
    const path = journalPath(root, id);
    assert.ok(!existsSync(path), 'Media continuation is already authorized; resume its existing journal without renewing its time or counts');
    const input = accepted(root, id, options.env ?? process.env), original = originalBudget(root, id, input.request.parentIdentity);
    const visualRecovery = permission.status === 'failed:visuals' ? recoverableVisualFailure(input) : undefined;
    const completionPath = contained(input.dir, 'media-completion.json');
    const finalReviewRecovery = existsSync(completionPath) ? inspectExpiredMediaReview(input.dir, root, input.request.parentIdentity, input.writerKey) : undefined;
    const originalHash = bytesHash(root, budgetPath(root, id, input.request.parentIdentity)), now = (options.now ?? Date.now)();
    assert.ok(Number.isSafeInteger(now) && now >= original.deadline, 'Only an expired editorial time window may receive a separately authorized media continuation');
    assert.ok(approval.expectedWriterKey === input.writerKey && approval.expectedScriptHash === roleHash(input.script)
      && approval.expectedNewsletterHash === roleHash(input.issue) && approval.expectedOriginalBudgetHash === originalHash, 'Media continuation approval does not match the exact saved package and original allowance');
    const editorialPredecessor = sealEditorialContinuation(root, id);
    const remainingCalls = original.maxPhysicalCalls - original.attempts.length - (editorialPredecessor?.physicalAttempts ?? 0);
    const remainingTools = original.maxToolCalls - original.tools.length - (editorialPredecessor?.toolAttempts ?? 0);
    assert.ok(remainingCalls > 0 && remainingTools > 0, 'No originally authorized model/tool allowance remains for final media checks');
    const body: JournalBody = { version: 1, kind: 'approved-media-only', authorization: 'explicit-user', packageId: id, authorizedAt: now, deadline: null, deadlinePolicy: 'operation-only',
      workspaceHash: permission.workspaceHash, authorizedBy: permission.actor.id, edition: permission.edition,
      writerKeyHash: roleHash(input.writerKey), original: { parentIdentity: input.request.parentIdentity, budgetHash: originalHash, deadline: original.deadline, maxPhysicalCalls: original.maxPhysicalCalls, physicalAttempts: original.attempts.length, maxToolCalls: original.maxToolCalls, toolAttempts: original.tools.length },
      approvedFiles: Object.fromEntries(files.map(name => [name, bytesHash(root, contained(input.dir, name))])), settingsFiles: configHashes(root),
      ...(visualRecovery ? { visualRecovery } : {}), ...(finalReviewRecovery ? { finalReviewRecovery } : {}), ...(editorialPredecessor ? { editorialPredecessor } : {}),
      limits: { totalSeconds: 1800, maxPhysicalCalls: remainingCalls, maxToolCalls: remainingTools } };
    const journal = { ...body, identity: roleHash(body) };
    if (finalReviewRecovery) {
      const archive = contained(input.dir, 'media-continuation-evidence', `${finalReviewRecovery.originalCompletionHash}.json`);
      mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
      if (!existsSync(archive)) writeFileSync(archive, readFileSync(completionPath), { flag: 'wx', mode: 0o600 });
      assert.equal(bytesHash(root, archive), finalReviewRecovery.originalCompletionHash, 'Original final-media archive changed');
    }
    // Reserve the one authorization first. A crash between these two writes is held, never
    // treated as permission to create another deadline or silently initialize another budget.
    writeFileSync(path, JSON.stringify(journal, null, 2), { flag: 'wx', mode: 0o600 });
    const next = budgetPath(root, id, journal.identity); mkdirSync(dirname(next), { recursive: true, mode: 0o700 });
    writeFileSync(next, JSON.stringify({ version: 1, identity: roleHash({ version: 1, parent: journal.identity }), deadline: Number.MAX_SAFE_INTEGER, deadlinePolicy: 'operation-only',
      maxPhysicalCalls: remainingCalls, attempts: [], maxToolCalls: remainingTools, tools: [] }, null, 2), { flag: 'wx', mode: 0o600 });
    if (finalReviewRecovery) {
      assert.equal(bytesHash(root, completionPath), finalReviewRecovery.originalCompletionHash, 'Original final-media attempts changed during authorization');
      const state = read<CompletionState>(completionPath);
      atomicJson(completionPath, { ...state, parent: journal.identity, continuation: { identity: journal.identity, priorCompletionHash: finalReviewRecovery.originalCompletionHash, priorAttempts: finalReviewRecovery.attempts } });
    }
    return journal;
  } finally { unlockBudget?.(); unlock(); }
}

export interface MediaVisualRevisionApproval {
  intent: 'revise-selected-visuals'; expectedJournalIdentity: string; expectedScriptHash: string;
  expectedNewsletterHash: string; expectedBudgetHash: string;
  choices: Record<string, 'image' | 'explanation'>;
}
interface VisualRevisionBody {
  version: 1; kind: 'selected-visual-revision'; authorization: 'explicit-user'; parent: string; packageId: string;
  authorizedAt: number; authorizedBy: string; workspaceHash: string; writerKeyHash: string;
  choices: Record<string, 'image' | 'explanation'>; sourceDevelopmentHash: string;
  sourceFiles: Record<string, string>; retainedNarration: Record<string, string>; imageFiles: Record<string, string>;
  archive: { path: string; files: Record<string, string> };
  spent: { physicalAttempts: number; toolAttempts: number; attemptsHash: string; toolsHash: string };
  presentation: VisualPresentationRevision;
}
export interface MediaVisualRevision extends VisualRevisionBody { identity: string }
const visualRevisionPath = (root: string, id: string) => contained(root, 'workdir/videos', safeId(id), 'media-visual-revision.json');
const retainedVisualFiles = ['meta.json', 'visual-choices.json', 'visual-candidates.json', 'diagrams.json', 'diagram-phone-review.json', 'visual-plans.json', 'visual-results.json', 'newsletter-visuals.json'];
function presentHashes(root: string, dir: string, names: string[]): Record<string, string> {
  return Object.fromEntries(names.filter(name => existsSync(contained(dir, name))).sort().map(name => [name, bytesHash(root, contained(dir, name))]));
}
function capturedVisualFiles(root: string, input: ReturnType<typeof accepted>): Record<string, string> {
  const names = ['journey-editorial-input.json', 'visual-development.json'];
  for (const story of input.source.input.stories) for (const source of story.sources) {
    const receipt = `journey-editorial-sources/${safeId(source.id)}.json`, raw = `journey-editorial-sources/${source.rawSha256}.raw`;
    assert.ok(digest(source.rawSha256) && digest(source.textSha256), 'Visual revision requires exact source hashes');
    assert.equal(roleHash(read<any>(contained(input.dir, receipt)).source), roleHash(source), 'Captured visual source receipt changed');
    assert.equal(bytesHash(root, contained(input.dir, raw)), source.rawSha256, 'Captured visual source bytes changed');
    assert.equal(sha(source.text), source.textSha256, 'Captured visual source text changed');
    names.push(receipt, raw);
  }
  return presentHashes(root, input.dir, [...new Set(names)]);
}
function retainedNarrationFiles(root: string, dir: string): Record<string, string> {
  if (!existsSync(contained(dir, 'audio.wav'))) return {};
  const qc = read<any>(contained(dir, 'audio-qc.json'));
  assert.ok(qc.status === 'pass' && Array.isArray(qc.blocking) && !qc.blocking.length, 'Visual revision cannot retain failed narration as accepted audio');
  const names = ['audio.wav', 'audio-qc.json', 'timestamps.json'];
  for (const name of names) assert.ok(existsSync(contained(dir, name)), 'Visual revision requires complete retained narration');
  for (const name of ['cast.json', 'avatar.mp4', 'voice-receipt.json']) if (existsSync(contained(dir, name))) names.push(name);
  for (const line of qc.lines ?? []) for (const name of ['audio.wav', 'audio-qc.json', 'timestamps.json', 'line.txt']) {
    const path = `${line.path}/${name}`; assert.ok(existsSync(contained(dir, path)), 'Retained narration line is missing'); names.push(path);
  }
  return presentHashes(root, dir, [...new Set(names)]);
}
function assertVisualRevision(root: string, id: string, journal: MediaContinuationJournal, input: ReturnType<typeof accepted>, revision: MediaVisualRevision, finalChoices = false): void {
  const { identity, ...body } = revision;
  assert.ok(revision.version === 1 && revision.kind === 'selected-visual-revision' && revision.authorization === 'explicit-user'
    && identity === roleHash(body) && revision.parent === journal.identity && revision.packageId === id
    && revision.authorizedBy === journal.authorizedBy && revision.workspaceHash === journal.workspaceHash && revision.writerKeyHash === journal.writerKeyHash,
    'Visual revision authorization changed');
  assert.equal(roleHash(read<MediaVisualRevision>(visualRevisionPath(root, id))), roleHash(revision), 'Visual revision changed during work');
  assert.equal(visualSources(input), revision.sourceDevelopmentHash, 'Visual revision source concepts changed');
  assertNoVisualRejection(input.dir);
  for (const hashes of [revision.sourceFiles, revision.retainedNarration, revision.imageFiles]) {
    for (const [name, hash] of Object.entries(hashes)) assert.equal(bytesHash(root, contained(input.dir, name)), hash, `Visual revision retained ${name} changed`);
  }
  for (const [name, hash] of Object.entries(revision.archive.files)) assert.equal(bytesHash(root, contained(input.dir, revision.archive.path, name)), hash, 'Visual revision archive changed');
  const budget = originalBudget(root, id, journal.identity);
  assert.ok(budget.attempts.length >= revision.spent.physicalAttempts && budget.tools.length >= revision.spent.toolAttempts
    && roleHash(budget.attempts.slice(0, revision.spent.physicalAttempts)) === revision.spent.attemptsHash
    && roleHash(budget.tools.slice(0, revision.spent.toolAttempts)) === revision.spent.toolsHash, 'Visual revision cannot reset prior model/tool spending');
  assertVisualPresentationRevision(id, journal.identity, revision.identity, revision.presentation, { root });
  const choicesPath = contained(input.dir, 'visual-choices.json');
  if (finalChoices || existsSync(choicesPath) && bytesHash(root, choicesPath) !== revision.archive.files['visual-choices.json']) {
    const choices = read<any>(choicesPath), originalChoices = revision.archive.files['visual-choices.json'] ? read<any>(contained(input.dir, revision.archive.path, 'visual-choices.json')) : { stories: {} }, catalog = read<any>(contained(input.dir, 'visual-candidates.json'));
    assert.ok(choices.version === 1 && choices.videoId === id && choices.stories && typeof choices.stories === 'object'
      && Object.keys(choices.stories).every(index => Object.hasOwn(revision.choices, index))
      && (!finalChoices || Object.keys(choices.stories).length === Object.keys(revision.choices).length), 'Visual revision choices must cover the requested stories');
    for (const [index, requested] of Object.entries(revision.choices)) {
      const choice = choices.stories[index];
      // While a requested explanation is being authored, its exact old selection
      // may remain visible. Final review cannot run until every target is locked.
      if (!finalChoices && !choice && requested === 'explanation' && !originalChoices.stories[index]) continue;
      if (!finalChoices && originalChoices.stories[index] && roleHash(choice) === roleHash(originalChoices.stories[index])) continue;
      const candidate = catalog.stories?.find((row: any) => row.index === Number(index))?.candidates?.find((row: any) => row.id === requested);
      assert.ok(choice?.candidateId === requested && candidate?.available && !candidate.failed && choice.candidateHash === candidate.hash,
        'Visual revision cannot substitute a card, unreviewed explanation or different image');
      if (requested === 'image') assert.ok(candidate.file && revision.imageFiles[candidate.file] === candidate.sha256, 'Visual revision selected image changed');
    }
  }
}

/** Explicit presentation revision only: reuse the exact existing child ledger and retained writing. */
export function authorizeMediaVisualRevision(root: string, id: string, approval: MediaVisualRevisionApproval, options: { now?: () => number; env?: NodeJS.ProcessEnv } = {}): MediaVisualRevision {
  root = realpathSync(root); safeId(id);
  assert.equal(approval.intent, 'revise-selected-visuals', 'Visual revision requires an explicit requested presentation');
  const unlock = releaseLock(root, `media-continuation-${roleHash(id).slice(0, 16)}`);
  let unlockBudget: (() => void) | undefined;
  try {
    unlockBudget = waitForReleaseLock(root, 'local-role-budget');
    assert.ok(!existsSync(visualRevisionPath(root, id)), 'Visual revision is already authorized; reuse its existing spending and receipt');
    const context = openMediaContinuation(root, id, options), journal = context.journal, permission = access(root, id, true);
    const input = accepted(root, id, options.env ?? process.env), budget = originalBudget(root, id, journal.identity);
    assert.ok(approval.expectedJournalIdentity === journal.identity && approval.expectedScriptHash === roleHash(input.script)
      && approval.expectedNewsletterHash === roleHash(input.issue) && approval.expectedBudgetHash === bytesHash(root, budgetPath(root, id, journal.identity)),
      'Visual revision does not match the exact accepted package and spent allowance');
    assert.ok(budget.attempts.length < budget.maxPhysicalCalls && budget.tools.length < budget.maxToolCalls, 'No existing media allowance remains for visual revision');
    assert.ok(Object.keys(approval.choices).length === input.script.body.length && input.script.body.every((_, i) => ['image', 'explanation'].includes(approval.choices[String(i)])),
      'Visual revision requires an image or explanation for every existing story');
    const sourceDevelopmentHash = visualSources(input); assertNoVisualRejection(input.dir);
    const imageFiles: Record<string, string> = {}, catalog = read<any>(contained(input.dir, 'visual-candidates.json'));
    for (const [index, choice] of Object.entries(approval.choices)) if (choice === 'image') {
      const candidate = catalog.stories?.find((row: any) => row.index === Number(index))?.candidates?.find((row: any) => row.id === 'image');
      assert.ok(candidate?.available && !candidate.failed && candidate.file && digest(candidate.sha256), 'Requested source image is unavailable');
      assert.equal(bytesHash(root, contained(input.dir, candidate.file)), candidate.sha256, 'Requested source image bytes changed'); imageFiles[candidate.file] = candidate.sha256;
    }
    const oldFiles = presentHashes(root, input.dir, retainedVisualFiles), archivePath = `visual-revision-evidence/${roleHash(oldFiles)}`;
    for (const [name, hash] of Object.entries(oldFiles)) {
      const target = contained(input.dir, archivePath, name); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (!existsSync(target)) writeFileSync(target, readFileSync(contained(input.dir, name)), { flag: 'wx', mode: 0o600 });
      assert.equal(bytesHash(root, target), hash, 'Visual revision archive collision');
    }
    const body: VisualRevisionBody = { version: 1, kind: 'selected-visual-revision', authorization: 'explicit-user', parent: journal.identity, packageId: id,
      authorizedAt: (options.now ?? Date.now)(), authorizedBy: permission.actor.id, workspaceHash: permission.workspaceHash, writerKeyHash: journal.writerKeyHash,
      choices: structuredClone(approval.choices), sourceDevelopmentHash, sourceFiles: capturedVisualFiles(root, input), retainedNarration: retainedNarrationFiles(root, input.dir), imageFiles,
      archive: { path: archivePath, files: oldFiles }, spent: { physicalAttempts: budget.attempts.length, toolAttempts: budget.tools.length, attemptsHash: roleHash(budget.attempts), toolsHash: roleHash(budget.tools) },
      presentation: inspectVisualPresentationRevision(id, journal.identity, { root }) };
    const revision = { ...body, identity: roleHash(body) };
    writeFileSync(visualRevisionPath(root, id), JSON.stringify(revision, null, 2), { flag: 'wx', mode: 0o600 });
    beginVisualPresentationRevision(id, journal.identity, revision.identity, revision.presentation.archiveHash, { root });
    // This explicit request reopens only presentation. It neither approves old media
    // nor changes the accepted words, selected narrator, original journal or ledger.
    const metaPath = contained(input.dir, 'meta.json'), meta = read<any>(metaPath);
    atomicJson(metaPath, { ...meta, status: 'assets_ready' });
    openMediaContinuation(root, id, options).assertUnchanged();
    return revision;
  } finally { unlockBudget?.(); unlock(); }
}

function visualTask(task: PreparedModelTask, choices: Record<string, 'image' | 'explanation'>, topicIds: string[], vision: boolean): boolean {
  if (vision) return task.role === 'source-review' && task.capability === 'source-review' && task.taskId === 'visual-image-review'
    && roleHash([...task.topicIds].sort()) === roleHash([...topicIds].sort());
  if (task.topicIds.length !== 1) return false;
  const index = topicIds.indexOf(task.topicIds[0]); if (index < 0 || !choices[String(index)]) return false;
  const n = index + 1;
  if (choices[String(index)] === 'explanation' && task.role === 'script' && task.capability === 'script-draft' && task.taskId === `diagram-author-${n}`) return true;
  if (choices[String(index)] === 'explanation' && task.role === 'source-review' && task.capability === 'source-review'
    && new RegExp(`^diagram-${n}-diagram-fields-\\d+-fields-(?:initial|final)-review$`).test(task.taskId)) return true;
  if (task.role === 'script' && task.capability === 'script-draft' && [`visual-story-${n}`, `visual-story-${n}-concept-binding`].includes(task.taskId)) return true;
  if (task.role === 'script' && task.capability === 'script-edit' && new RegExp(`^visual-story-${n}-label-\\d+$`).test(task.taskId)) return true;
  if (task.role === 'source-review' && task.capability === 'source-review' && [`visual-story-${n}-fields-initial-review`, `visual-story-${n}-fields-final-review`].includes(task.taskId)) return true;
  return task.role === 'source-repair' && task.capability === 'source-repair' && task.taskId === `visual-story-${n}-fields-repair`;
}

/** No source retrieval, editorial execution or new writing is reachable through this context. */
export function openMediaContinuation(root: string, id: string, options: { now?: () => number; env?: NodeJS.ProcessEnv; vision?: PreparedVisionAdapters; text?: PreparedDispatchAdapters } = {}): Context & MediaReviewRecoveryContext & { journal: MediaContinuationJournal; issue: Issue; visualRevision?: MediaVisualRevision; mediaVisualRevision?: { identity: string; receipt: VisualPresentationRevision; assertUnchanged(): void }; assertUnchanged(): void } {
  root = realpathSync(root); safeId(id);
  const permission = access(root, id, true);
  const journal = read<MediaContinuationJournal>(journalPath(root, id)), { identity, ...body } = journal;
  assert.ok(journal.version === 1 && journal.kind === 'approved-media-only' && journal.authorization === 'explicit-user' && journal.packageId === id && identity === roleHash(body)
    && journal.workspaceHash === permission.workspaceHash && journal.authorizedBy === permission.actor.id && journal.edition === permission.edition
    && journal.deadline === null && journal.deadlinePolicy === 'operation-only'
    && journal.limits.maxPhysicalCalls === journal.original.maxPhysicalCalls - journal.original.physicalAttempts - (journal.editorialPredecessor?.physicalAttempts ?? 0)
    && journal.limits.maxToolCalls === journal.original.maxToolCalls - journal.original.toolAttempts - (journal.editorialPredecessor?.toolAttempts ?? 0), 'Media continuation journal changed');
  const input = accepted(root, id, options.env ?? process.env);
  const visualRevision = existsSync(visualRevisionPath(root, id)) ? read<MediaVisualRevision>(visualRevisionPath(root, id)) : undefined;
  assert.ok(permission.status !== 'failed:visuals' || journal.visualRecovery, 'Visual failure needs its exact retained recovery evidence');
  const assertUnchanged = () => {
    const current = access(root, id, true);
    assert.ok(current.workspaceHash === journal.workspaceHash && current.actor.id === journal.authorizedBy && current.edition === journal.edition, 'Media continuation workspace, author or edition changed');
    assert.equal(roleHash({ ...resolveModelRuntime(input.model, options.env ?? process.env), apiKey: undefined }), roleHash(JSON.parse(input.writerKey).runtime), 'Selected model runtime changed during media continuation');
    assert.equal(bytesHash(root, budgetPath(root, id, journal.original.parentIdentity)), journal.original.budgetHash, 'Original editorial allowance changed; continuation is held');
    assertEditorialContinuationSeal(root, id, journal.editorialPredecessor);
    assert.equal(roleHash(read<MediaContinuationJournal>(journalPath(root, id))), roleHash(journal), 'Media authorization changed during continuation');
    for (const name of files) assert.equal(bytesHash(root, contained(input.dir, name)), journal.approvedFiles[name], `Approved ${name} changed; media cannot rewrite accepted content`);
    assert.equal(roleHash(configHashes(root)), roleHash(journal.settingsFiles), 'Saved model, voice or design settings changed during media continuation');
    assert.equal(roleHash(input.writerKey), journal.writerKeyHash, 'Media continuation writer identity changed');
    if (visualRevision) assertVisualRevision(root, id, journal, input, visualRevision);
    else if (journal.finalReviewRecovery) assertRetainedMediaReview(input.dir, identity, journal.finalReviewRecovery);
    if (journal.visualRecovery) {
      assert.equal(visualSources(input), journal.visualRecovery.sourceDevelopmentHash, 'Accepted visual source evidence changed during continuation');
      assertNoVisualRejection(input.dir);
    }
    const budget = originalBudget(root, id, journal.identity);
    assert.ok(budget.deadline === Number.MAX_SAFE_INTEGER && budget.deadlinePolicy === 'operation-only' && budget.maxPhysicalCalls === journal.limits.maxPhysicalCalls && budget.maxToolCalls === journal.limits.maxToolCalls, 'Media continuation allowance cannot be renewed or enlarged');
  };
  assertUnchanged();
  const assertMediaWork = () => {
    assertUnchanged();
    const current = access(root, id, true);
    // The explicit revision already pins every requested visual. An older chooser
    // pause must not prevent authoring its still-missing explanation; ordinary
    // continuations still wait for a choice, and failed/completed reviews stay held.
    assert.ok(!['failed:visuals', 'pending_review'].includes(current.status)
      && (current.status !== 'awaiting_visual_choice' || !!visualRevision), 'Media continuation is waiting for your visual choice or completed review; no new model or tool work may run');
  };
  const parent: ParentWorkScope = { root, parentId: id, parentIdentity: journal.identity, limits: journal.limits, deadlinePolicy: 'operation-only',
    now: () => { assertMediaWork(); return (options.now ?? Date.now)(); } };
  const dispatch = createPreparedVisionDispatch({ root, parent, primary: { ...input.model, rescue: { enabled: false } }, policy: null, briefHash: roleHash(input.source.input.brief), env: options.env ?? process.env }, options.vision);
  const textDispatch = createPreparedRoleDispatch({ root, parent, primary: { ...input.model, rescue: { enabled: false } }, policy: null, briefHash: roleHash(input.source.input.brief), env: options.env ?? process.env }, options.text);
  const topicIds = input.source.input.stories.map(story => story.id);
  const allowedTask = (task?: PreparedModelTask) => {
    assertPreparedModelTask(task);
    if (visualRevision && visualTask(task, visualRevision.choices, topicIds, true)) return;
    assert.ok(task.role === 'media-review' && task.capability === 'frame-alignment' && task.taskId === 'final-media-review', 'Media continuation allows only final alignment with the already approved script; writing and source review remain closed');
    if (visualRevision) assertVisualRevision(root, id, journal, input, visualRevision, true);
  };
  return { ...(visualRevision ? { visualRevision, mediaVisualRevision: { identity: visualRevision.identity, receipt: visualRevision.presentation, assertUnchanged } } : {}), ...(!visualRevision && journal.finalReviewRecovery ? { mediaReviewRecovery: { identity, receipt: journal.finalReviewRecovery, assertUnchanged } } : {}), journal, issue: input.issue, topic: input.topic, parent, writerKey: input.writerKey, assertUnchanged,
    call: stage => async (prompt, validate, task) => {
      if (!visualRevision || stage !== 'visual') throw new Error('Media continuation cannot write, format, research or fact-review content');
      assertMediaWork(); assertPreparedModelTask(task);
      assert.ok(visualTask(task, visualRevision.choices, topicIds, false), 'Visual revision permits only the requested visual authoring and alignment tasks');
      const value = await textDispatch(prompt, validate, task); assertUnchanged(); return value;
    },
    vision: (prompt, images, validate, task, bounds) => { assertMediaWork(); allowedTask(task); return dispatch(prompt, images, validate, task, bounds); } };
}
