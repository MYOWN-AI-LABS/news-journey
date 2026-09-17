/** Explicit recovery of a failed editorial operation, never a new edition or refunded budget. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { load } from 'cheerio';
import { readableWebText, pagePublicationDate } from '../sources/web-discovery.js';
import { authorize, contained, safeId } from '../workspaces.js';
import { releaseLock, waitForReleaseLock } from '../release-lock.js';
import { beginParentWork, roleHash, type ParentWorkScope } from '../llm/role-router.js';
import { resolveModelRuntime, type ModelConfig } from '../llm/model.js';
import { createPreparedRoleDispatch, type PreparedDispatchAdapters } from '../llm/prepared-role-dispatch.js';
import { applyMemoryGuidance } from '../memory/context.js';
import { assertPreparedModelTask } from './writing-task.js';
import { assertInvalidReviewRecoveryCandidate, type DailyEditorialCheckpoint, type DailyEditorialInput, type DailyReviewRecovery, type DailyLengthRecovery, type DailyFactualRecovery, type DailyCitationRecovery, type DailyEditorialReview } from './daily-editorial.js';
import { assertExhaustedLengthRecoveryCandidate } from './editorial-length-recovery.js';
import { assertCitationRecoveryCandidate, reconcileTruncatedReviewCitation } from './reviewer-citation-reconciliation.js';
import { assertTargetedFactualRepairCandidate } from './editorial-factual-repair.js';
import type { packageWritingContext } from './writing-context.js';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const read = <T = any>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const budgetPath = (root: string, id: string, parent: string) => contained(root, 'state/role-tasks', safeId(id), roleHash({ version: 1, parent }), 'budget.json');
const journalPath = (root: string, id: string) => contained(root, 'workdir/videos', safeId(id), 'editorial-continuation.json');
const citationPath = (root: string, id: string) => contained(root, 'workdir/videos', safeId(id), 'editorial-citation-reconciliation.json');
const factualPath = (root: string, id: string) => contained(root, 'workdir/videos', safeId(id), 'editorial-factual-repair.json');
const fileHash = (root: string, path: string) => {
  const rel = relative(realpathSync(root), realpathSync(path));
  assert.ok(rel && !rel.startsWith('..'), 'Editorial continuation file escapes its workspace');
  return sha(readFileSync(path));
};
interface Budget { version: 1; identity: string; deadline: number; deadlinePolicy?: string; maxPhysicalCalls: number; attempts: unknown[]; maxToolCalls: number; tools: unknown[] }
type Intent = 'retry-invalid-review-response' | 'repair-exhausted-script-length';
export interface EditorialContinuationJournal {
  version: 1; intent: Intent; identity: string; authorizedAt: number; authorizedBy: string; workspace: string; packageId: string;
  originalParent: string; originalBudgetHash: string; originalBudget: Budget;
  originalCheckpoint: DailyEditorialCheckpoint; checkpointHash: string; candidateHash: string; inputHash: string; reviewerHash: string;
  writerKey: string; files: Record<string, string>; limits: { totalSeconds: number; maxPhysicalCalls: number; maxToolCalls: number };
}
function inventory(root: string, id: string) {
  const out: Record<string, string> = {}, dir = contained(root, 'workdir/videos', id);
  const add = (path: string) => { if (existsSync(path)) out[relative(root, path)] = fileHash(root, path); };
  const visit = (path: string) => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Editorial continuation disallows symbolic-link aliases');
      const child = contained(path, entry.name); if (entry.isDirectory()) visit(child); else add(child);
    }
  };
  visit(contained(root, 'config')); visit(contained(dir, 'journey-editorial-sources'));
  for (const name of ['.env', 'CONTENT.md', 'workspace.json', 'state/personal-profile.json', 'state/journey-brief.json']) add(contained(root, name));
  for (const name of ['writing-request.json', 'topic.json', 'journey-editorial-input.json']) add(contained(dir, name));
  return out;
}
function access(root: string, id: string) {
  const dir = contained(root, 'workdir/videos', id), meta = read(contained(dir, 'meta.json'));
  const deliveryLog = contained(dir, 'delivery-events.jsonl');
  assert.ok(meta.id === id && typeof meta.createdBy === 'string' && !meta.reviewHold && !meta.rejectReason && !meta.approvedBy && !meta.explicitApproval
    && ['failed:script', 'scripted', 'assets_ready', 'awaiting_visual_choice', 'failed:visuals'].includes(meta.status)
    && !Object.keys(meta.posts ?? {}).length && !Object.keys(meta.delivery ?? {}).length
    && !readdirSync(dir).some(name => name.startsWith('.delivery-')) && (!existsSync(deliveryLog) || statSync(deliveryLog).size === 0), 'Editorial recovery cannot override a delivery, approval or review hold');
  const actor = authorize('produce', { root, edition: meta.edition || 'daily-roundup', author: meta.createdBy });
  assert.equal(actor.id, meta.createdBy, 'Editorial recovery belongs to its original author');
  return { dir, meta, actor };
}
function budget(root: string, id: string, parent: string): Budget {
  const value = read<Budget>(budgetPath(root, id, parent));
  assert.ok(value.version === 1 && value.identity === roleHash({ version: 1, parent }) && Number.isFinite(value.deadline)
    && Number.isSafeInteger(value.maxPhysicalCalls) && value.maxPhysicalCalls > 0 && value.maxPhysicalCalls <= 100
    && Number.isSafeInteger(value.maxToolCalls) && value.maxToolCalls >= 0 && value.maxToolCalls <= 32
    && Array.isArray(value.attempts) && value.attempts.length <= value.maxPhysicalCalls
    && Array.isArray(value.tools) && value.tools.length <= value.maxToolCalls, 'Editorial recovery requires the existing valid allowance');
  return value;
}
function inputs(root: string, id: string, env: NodeJS.ProcessEnv) {
  const { dir, meta, actor } = access(root, id), request = read(contained(dir, 'writing-request.json'));
  const checkpoint = read<DailyEditorialCheckpoint>(contained(dir, 'journey-editorial-checkpoint.json'));
  const source = read<{ input: DailyEditorialInput; hash: string }>(contained(dir, 'journey-editorial-input.json'));
  const topic = read(contained(dir, 'topic.json')), settings = request.settingsSnapshot?.settings;
  assert.ok(request.outputs === 'edition' && request.preparedHash === roleHash(topic) && request.originalHash === roleHash(request.original)
    && settings?.dailyEditorialVersion === 7 && !settings.rolePolicy && request.settingsSnapshot.hash === roleHash(settings)
    && source.hash === roleHash(source.input), 'Editorial recovery needs the exact script-first request and complete source input');
  assert.equal(request.parentIdentity, roleHash({ version: 7, id, original: request.original, settings }), 'Original request parent identity changed');
  assert.equal(source.input.stories.length, topic.stories?.length, 'Original source slate changed');
  for (const [index, story] of source.input.stories.entries()) {
    assert.ok(story.id === `topic-${index + 1}` && story.primaryUrl === topic.stories[index].primaryUrl
      && story.headline === topic.stories[index].headline && story.sources.length, 'Source capture belongs to another selected story');
    for (const captured of story.sources) {
      assert.match(captured.id, new RegExp(`^topic-${index + 1}-source-\\d+$`)); assert.match(captured.rawSha256, /^[a-f0-9]{64}$/);
      const receipt = read(contained(dir, 'journey-editorial-sources', `${captured.id}.json`));
      const rawPath = contained(dir, 'journey-editorial-sources', `${captured.rawSha256}.raw`), raw = readFileSync(rawPath), html = raw.toString('utf8'), $ = load(html);
      assert.equal(roleHash(receipt.source), roleHash(captured), 'Original source receipt changed');
      assert.equal(fileHash(root, rawPath), captured.rawSha256, 'Original source bytes changed');
      assert.equal(readableWebText(html), captured.text, 'Complete captured source text changed');
      assert.equal(sha(captured.text), captured.textSha256, 'Source text hash changed');
      assert.equal(captured.publishedAt ?? null, pagePublicationDate($), 'Source publication metadata changed');
    }
  }
  const model = read<ModelConfig>(contained(root, 'config/model.json')), runtime = resolveModelRuntime(model, env);
  assert.equal(roleHash(model), roleHash(settings.model), 'Selected model configuration changed');
  assert.equal(roleHash({ ...runtime, apiKey: undefined }), roleHash(settings.runtime), 'Selected model runtime changed');
  const writerKey = JSON.stringify({ config: { ...model, rescue: { enabled: false } }, rolePolicy: settings.rolePolicy,
    runtime: { ...runtime, apiKey: undefined }, settingsHash: request.settingsSnapshot.hash, memoryHash: request.memory.hash });
  const reviewer = { provider: runtime.provider, model: runtime.model!, runtimeHash: roleHash({ writerKey, runtime: { ...runtime, apiKey: undefined } }) };
  return { dir, meta, actor, request, checkpoint, source, topic, model, writerKey, reviewer };
}

/** Read-only readiness check; does not authorize, create a budget or call a model. */
export function inspectEditorialContinuationEligibility(root: string, id: string, intent: Intent, env: NodeJS.ProcessEnv = process.env) {
  root = realpathSync(root); safeId(id);
  const input = inputs(root, id, env);
  if (intent === 'retry-invalid-review-response') assertInvalidReviewRecoveryCandidate(input.checkpoint);
  else if (intent === 'repair-exhausted-script-length') assertExhaustedLengthRecoveryCandidate(input.checkpoint);
  else throw new Error('Unknown editorial recovery scope');
  const old = budget(root, id, input.request.parentIdentity);
  return { checkpointHash: roleHash(input.checkpoint), originalBudgetHash: fileHash(root, budgetPath(root, id, input.request.parentIdentity)),
    remainingPhysical: old.maxPhysicalCalls - old.attempts.length, remainingTools: old.maxToolCalls - old.tools.length,
    model: input.reviewer.model, sources: input.source.input.stories.reduce((n, story) => n + story.sources.length, 0) };
}

interface CitationAuthorization {
  version: 1; intent: 'reconcile-truncated-review-citation'; parent: string; authorizedBy: string; authorizedAt: number;
  checkpointHash: string; originalCheckpoint: DailyEditorialCheckpoint; inputHash: string; reviewerHash: string;
  rawFile: string; rawHash: string; originalReview: DailyEditorialReview; identity: string;
}
function citationResponse(root: string, input: ReturnType<typeof inputs>, checkpoint: DailyEditorialCheckpoint, rawFile: string) {
  assertCitationRecoveryCandidate(checkpoint);
  assert.match(rawFile, /^[a-f0-9-]{36}\.json$/, 'Citation recovery needs the original retained output filename');
  const path = contained(root, 'state/model-output-failures', rawFile), raw = read(path);
  const lastFailure = checkpoint.artifacts.script.failures.at(-1)!;
  assert.ok(lastFailure.endsWith(`Rejected output retained at ${path}`), 'Only the final retained invalid response may be reconciled');
  assert.ok(raw.version === 1 && raw.provider === input.reviewer.provider && raw.model === input.reviewer.model && raw.attempt === 2 && raw.rescue === false
    && ['Finding evidence must reference the owned captured sources', 'Reviewer evidence quote or source ownership is invalid'].includes(raw.problem), 'Retained output is not the diagnosed reviewer response');
  for (const packet of [raw.prompt, raw.response]) assert.ok(packet && packet.truncated === false && typeof packet.text === 'string'
    && Buffer.byteLength(packet.text) === packet.bytes && sha(packet.text) === packet.sha256, 'Raw reviewer prompt or response changed');
  const exactCandidate = `\nCANDIDATE:\n${JSON.stringify(checkpoint.artifacts.script.candidates[0])}\nCOMPLETE CAPTURED EVIDENCE AND BRIEF:\n${JSON.stringify(input.source.input)}`;
  assert.ok(raw.prompt.text.startsWith('Independently assess the complete script') && raw.prompt.text.includes(exactCandidate), 'Retained reviewer prompt belongs to different sources or candidate');
  const review = JSON.parse(raw.response.text) as DailyEditorialReview;
  reconcileTruncatedReviewCitation(input.source.input, review);
  return { rawHash: fileHash(root, path), originalReview: review };
}
/** Explicit citation transport correction; preserves the rejecting verdict and consumes only
 * the original unused script repair on the same remaining-only continuation. */
export function authorizeEditorialCitationRecovery(root: string, id: string, approval: {
  intent: 'reconcile-truncated-review-citation'; expectedCheckpointHash: string; rawFile: string; expectedRawHash: string;
}, options: { env?: NodeJS.ProcessEnv } = {}) {
  root = realpathSync(root); safeId(id);
  const unlock = releaseLock(root, `journey-editorial-${roleHash(id).slice(0, 20)}`);
  try {
    assert.equal(approval.intent, 'reconcile-truncated-review-citation');
    assert.ok(!existsSync(citationPath(root, id)), 'Citation recovery is already authorized or consumed');
    const state = openEditorialContinuation(root, id, options), input = inputs(root, id, options.env ?? process.env);
    assert.equal(state.journal.intent, 'retry-invalid-review-response');
    assert.equal(roleHash(input.checkpoint), approval.expectedCheckpointHash, 'Invalid reviewer checkpoint changed');
    const response = citationResponse(root, input, input.checkpoint, approval.rawFile);
    assert.equal(response.rawHash, approval.expectedRawHash, 'Retained reviewer bytes changed before authorization');
    const body = { version: 1 as const, intent: approval.intent, parent: state.journal.identity, authorizedBy: input.actor.id, authorizedAt: Date.now(),
      checkpointHash: roleHash(input.checkpoint), originalCheckpoint: input.checkpoint, inputHash: input.source.hash, reviewerHash: roleHash(input.reviewer), rawFile: approval.rawFile, ...response };
    const receipt: CitationAuthorization = { ...body, identity: roleHash(body) };
    writeFileSync(citationPath(root, id), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
    return receipt;
  } finally { unlock(); }
}

interface FactualAuthorization {
  version: 1; intent: 'repair-rejected-editorial-field'; parent: string; authorizedBy: string; authorizedAt: number;
  checkpointHash: string; originalCheckpoint: DailyEditorialCheckpoint; inputHash: string; reviewerHash: string; identity: string;
}
/** A distinct diagnosed factual defect may receive one sentence repair on the SAME child.
 * The rejected review, prior repair and physical reservations are never removed or renewed. */
export function authorizeEditorialFactualRepair(root: string, id: string, approval: { intent: 'repair-rejected-editorial-field'; expectedCheckpointHash: string }, options: { env?: NodeJS.ProcessEnv } = {}) {
  root = realpathSync(root); safeId(id);
  const unlock = releaseLock(root, `journey-editorial-${roleHash(id).slice(0, 20)}`);
  try {
    assert.equal(approval.intent, 'repair-rejected-editorial-field', 'Factual repair needs explicit scope');
    assert.ok(!existsSync(factualPath(root, id)), 'The one factual field repair is already authorized or consumed');
    const state = openEditorialContinuation(root, id, options), input = inputs(root, id, options.env ?? process.env);
    assert.equal(state.journal.intent, 'repair-exhausted-script-length', 'Only the diagnosed length-recovery candidate can use this targeted factual repair');
    assert.equal(roleHash(input.checkpoint), approval.expectedCheckpointHash, 'Rejected factual checkpoint changed');
    assertTargetedFactualRepairCandidate(input.checkpoint, input.source.input, roleHash(input.reviewer));
    const body = { version: 1 as const, intent: approval.intent, parent: state.journal.identity, authorizedBy: input.actor.id, authorizedAt: Date.now(),
      checkpointHash: roleHash(input.checkpoint), originalCheckpoint: input.checkpoint, inputHash: input.source.hash, reviewerHash: roleHash(input.reviewer) };
    const receipt: FactualAuthorization = { ...body, identity: roleHash(body) };
    writeFileSync(factualPath(root, id), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
    return receipt;
  } finally { unlock(); }
}

/** One explicit authorization; the original state and budget are embedded unchanged. */
export function authorizeEditorialContinuation(root: string, id: string, approval: {
  intent: Intent; expectedCheckpointHash: string; expectedOriginalBudgetHash: string;
}, options: { now?: () => number; env?: NodeJS.ProcessEnv } = {}) {
  root = realpathSync(root); safeId(id);
  const unlock = releaseLock(root, `editorial-continuation-${roleHash(id).slice(0, 16)}`);
  let unlockBudget: (() => void) | undefined;
  try {
    unlockBudget = waitForReleaseLock(root, 'local-role-budget');
    const path = journalPath(root, id); assert.ok(!existsSync(path), 'Editorial continuation already exists; do not renew it');
    const input = inputs(root, id, options.env ?? process.env);
    assert.equal(input.meta.status, 'failed:script', 'Only the held script operation can receive editorial recovery');
    assert.equal(roleHash(input.checkpoint), approval.expectedCheckpointHash, 'Editorial checkpoint changed before authorization');
    if (approval.intent === 'repair-exhausted-script-length') assertExhaustedLengthRecoveryCandidate(input.checkpoint);
    const candidate = approval.intent === 'retry-invalid-review-response' ? assertInvalidReviewRecoveryCandidate(input.checkpoint)
      : approval.intent === 'repair-exhausted-script-length' ? input.checkpoint.artifacts.script.candidates.at(-1) : undefined;
    assert.ok(candidate, 'Editorial recovery requires an explicit recognized failure scope');
    const old = budget(root, id, input.request.parentIdentity), oldHash = fileHash(root, budgetPath(root, id, input.request.parentIdentity));
    const now = (options.now ?? Date.now)();
    assert.ok(now >= old.deadline && old.deadlinePolicy !== 'operation-only', 'This recovery applies only to an expired historical deadline');
    assert.equal(oldHash, approval.expectedOriginalBudgetHash, 'Original editorial budget changed');
    const limits = { totalSeconds: 1800, maxPhysicalCalls: old.maxPhysicalCalls - old.attempts.length, maxToolCalls: old.maxToolCalls - old.tools.length };
    assert.ok(limits.maxPhysicalCalls > 0, 'No physical allowance remains');
    const body = { version: 1 as const, intent: approval.intent, authorizedAt: now, authorizedBy: input.actor.id, workspace: root, packageId: id,
      originalParent: input.request.parentIdentity, originalBudgetHash: oldHash, originalBudget: old,
      originalCheckpoint: input.checkpoint, checkpointHash: roleHash(input.checkpoint), candidateHash: roleHash(candidate), inputHash: input.source.hash,
      reviewerHash: roleHash(input.reviewer), writerKey: input.writerKey, files: inventory(root, id), limits };
    const journal: EditorialContinuationJournal = { ...body, identity: roleHash(body) };
    writeFileSync(path, JSON.stringify(journal, null, 2), { flag: 'wx', mode: 0o600 });
    const next = budgetPath(root, id, journal.identity); mkdirSync(dirname(next), { recursive: true, mode: 0o700 });
    writeFileSync(next, JSON.stringify({ version: 1, identity: roleHash({ version: 1, parent: journal.identity }), deadline: Number.MAX_SAFE_INTEGER, deadlinePolicy: 'operation-only', ...limits, attempts: [], tools: [] }), { flag: 'wx', mode: 0o600 });
    return journal;
  } finally { unlockBudget?.(); unlock(); }
}

export function openEditorialContinuation(root: string, id: string, options: { now?: () => number; env?: NodeJS.ProcessEnv; adapters?: PreparedDispatchAdapters } = {}) {
  root = realpathSync(root); safeId(id);
  const journal = read<EditorialContinuationJournal>(journalPath(root, id)), { identity, ...body } = journal;
  assert.ok(journal.version === 1 && identity === roleHash(body) && journal.workspace === root && journal.packageId === id
    && journal.checkpointHash === roleHash(journal.originalCheckpoint), 'Editorial recovery journal changed');
  const input = inputs(root, id, options.env ?? process.env);
  const citation = existsSync(citationPath(root, id)) ? read<CitationAuthorization>(citationPath(root, id)) : undefined;
  if (citation) {
    const { identity: receiptIdentity, ...receiptBody } = citation;
    assert.ok(citation.version === 1 && citation.intent === 'reconcile-truncated-review-citation' && receiptIdentity === roleHash(receiptBody)
      && journal.intent === 'retry-invalid-review-response' && citation.parent === identity && citation.authorizedBy === input.actor.id
      && citation.checkpointHash === roleHash(citation.originalCheckpoint) && citation.inputHash === input.source.hash
      && citation.reviewerHash === roleHash(input.reviewer), 'Citation recovery authorization changed');
    const response = citationResponse(root, input, citation.originalCheckpoint, citation.rawFile);
    assert.equal(response.rawHash, citation.rawHash, 'Original invalid reviewer output changed');
    assert.equal(roleHash(response.originalReview), roleHash(citation.originalReview), 'Original reviewer findings changed');
  }
  const factual = existsSync(factualPath(root, id)) ? read<FactualAuthorization>(factualPath(root, id)) : undefined;
  if (factual) {
    const { identity: factualIdentity, ...factualBody } = factual;
    assert.ok(factual.version === 1 && factual.intent === 'repair-rejected-editorial-field' && factualIdentity === roleHash(factualBody)
      && factual.parent === identity && factual.authorizedBy === input.actor.id && factual.checkpointHash === roleHash(factual.originalCheckpoint)
      && factual.inputHash === input.source.hash && factual.reviewerHash === roleHash(input.reviewer), 'Factual repair authorization changed');
    assertTargetedFactualRepairCandidate(factual.originalCheckpoint, input.source.input, factual.reviewerHash);
  }
  assert.equal(journal.originalParent, input.request.parentIdentity, 'Editorial original parent changed');
  assert.equal(roleHash(journal.originalBudget), roleHash(budget(root, id, journal.originalParent)), 'Editorial original allowance changed');
  assert.ok(journal.limits.maxPhysicalCalls === journal.originalBudget.maxPhysicalCalls - journal.originalBudget.attempts.length
    && journal.limits.maxToolCalls === journal.originalBudget.maxToolCalls - journal.originalBudget.tools.length, 'Editorial recovery cannot enlarge remaining allowance');
  const assertUnchanged = () => {
    const current = access(root, id);
    assert.equal(current.actor.id, journal.authorizedBy, 'Editorial recovery author changed');
    assert.equal(roleHash(read(journalPath(root, id))), roleHash(journal), 'Editorial recovery authorization changed');
    assert.equal(fileHash(root, budgetPath(root, id, journal.originalParent)), journal.originalBudgetHash, 'Original editorial allowance changed');
    assert.equal(roleHash(inventory(root, id)), roleHash(journal.files), 'Editorial source, settings or selected voice changed');
    assert.equal(input.writerKey, journal.writerKey, 'Editorial recovery model identity changed');
    const checkpoint = read<DailyEditorialCheckpoint>(contained(input.dir, 'journey-editorial-checkpoint.json'));
    const before = journal.originalCheckpoint.artifacts.script, currentScript = checkpoint.artifacts.script;
    assert.ok(checkpoint.identityHash === journal.originalCheckpoint.identityHash && checkpoint.contentHash === roleHash(checkpoint.artifacts)
      && (currentScript.writes === before.writes || !!citation && !!currentScript.citationRecovery && before.writes === 1 && currentScript.writes === 2) && roleHash(currentScript.candidates.slice(0, before.candidates.length)) === roleHash(before.candidates)
      && roleHash(currentScript.failures.slice(0, before.failures.length)) === roleHash(before.failures), 'Editorial recovery cannot replace original candidates, failures or writing counts');
    const consumed = currentScript.reviewRecovery ?? currentScript.lengthRecovery;
    if (consumed) assert.equal(consumed.authorizationHash, identity, 'Consumed editorial recovery authorization changed');
    if (citation) {
      assert.equal(roleHash(read(citationPath(root, id))), roleHash(citation), 'Citation authorization changed during work');
      assert.equal(fileHash(root, contained(root, 'state/model-output-failures', citation.rawFile)), citation.rawHash, 'Retained reviewer bytes changed during work');
      const beforeCorrection = citation.originalCheckpoint.artifacts.script;
      assert.ok(roleHash(currentScript.candidates.slice(0, beforeCorrection.candidates.length)) === roleHash(beforeCorrection.candidates)
        && roleHash(currentScript.failures.slice(0, beforeCorrection.failures.length)) === roleHash(beforeCorrection.failures), 'Citation recovery cannot erase the rejected response or candidate');
      if (currentScript.citationRecovery) {
        const receipt = currentScript.citationRecovery;
        assert.ok(receipt.authorizationHash === citation.identity && receipt.rawHash === citation.rawHash && receipt.checkpointHash === citation.checkpointHash
          && roleHash(receipt.originalReview) === roleHash(citation.originalReview) && currentScript.writes === 2, 'Original repair consumption changed');
      } else assert.equal(roleHash(checkpoint), citation.checkpointHash, 'Citation checkpoint changed before consumption');
    }
    if (factual) {
      assert.equal(roleHash(read(factualPath(root, id))), roleHash(factual), 'Factual repair authorization changed during work');
      const beforeRepair = factual.originalCheckpoint.artifacts.script;
      assert.ok(roleHash(currentScript.candidates.slice(0, beforeRepair.candidates.length)) === roleHash(beforeRepair.candidates)
        && roleHash(currentScript.reviews.slice(0, beforeRepair.reviews.length)) === roleHash(beforeRepair.reviews)
        && roleHash(currentScript.failures.slice(0, beforeRepair.failures.length)) === roleHash(beforeRepair.failures), 'Factual recovery cannot erase its rejected candidate, verdict or failures');
      if (currentScript.factualRecovery) assert.equal(currentScript.factualRecovery.authorizationHash, factual.identity, 'Consumed factual repair changed');
      else assert.equal(roleHash(checkpoint), factual.checkpointHash, 'Factual checkpoint changed before recovery consumption');
    }
    assert.ok(!existsSync(contained(input.dir, 'editorial-continuation-seal.json')) && !existsSync(contained(input.dir, 'media-continuation.json')), 'Editorial continuation was sealed for media; no more editorial spending');
    const child = budget(root, id, identity);
    assert.ok(child.deadline === Number.MAX_SAFE_INTEGER && child.deadlinePolicy === 'operation-only'
      && child.maxPhysicalCalls === journal.limits.maxPhysicalCalls && child.maxToolCalls === journal.limits.maxToolCalls, 'Editorial continuation limits changed');
  };
  assertUnchanged();
  const child: ParentWorkScope = { root, parentId: id, parentIdentity: identity, limits: journal.limits, deadlinePolicy: 'operation-only',
    now: () => { assertUnchanged(); return (options.now ?? Date.now)(); } };
  const dispatch = createPreparedRoleDispatch({ root, parent: child, primary: input.model, policy: null, env: options.env ?? process.env, briefHash: roleHash(input.source.input.brief) }, options.adapters);
  const context: Awaited<ReturnType<typeof packageWritingContext>> = {
    topic: input.topic, writerKey: input.writerKey, dailyEditorial: input.source.input,
    // Accepted receipts retain the original request identity. Only dispatch owns the child budget.
    parent: { root, parentId: id, parentIdentity: journal.originalParent, limits: { totalSeconds: 1800, maxPhysicalCalls: journal.originalBudget.maxPhysicalCalls, maxToolCalls: journal.originalBudget.maxToolCalls } },
    call: stage => async (prompt, validate, task) => {
      assertUnchanged(); assertPreparedModelTask(task);
      const allowed = stage === 'newsletter' && task.role === 'source-review' && /^daily-editorial-script-review-/.test(task.taskId)
        || stage === 'script' && task.role === 'newsletter-draft' && /^daily-editorial-newsletter-/.test(task.taskId)
        || stage === 'script' && journal.intent === 'repair-exhausted-script-length' && task.role === 'script' && task.taskId === 'daily-editorial-script-authorized-length-repair'
        || stage === 'script' && !!factual && task.role === 'script' && task.taskId === 'daily-editorial-script-authorized-factual-patch'
        || stage === 'script' && !!citation && task.role === 'script' && task.taskId === 'daily-editorial-script-original-field-repair-2';
      let visualAllowed = false;
      if (stage === 'visual') {
        const checkpoint = read<DailyEditorialCheckpoint>(contained(input.dir, 'journey-editorial-checkpoint.json'));
        assert.ok(checkpoint.artifacts.script.status === 'accepted' && checkpoint.artifacts.newsletter.status === 'accepted', 'Retained visual recovery needs accepted writing first');
        const recovery = read(contained(input.dir, 'visual-development-recovery.json'));
        const archivePath = contained(input.dir, 'visual-development-attempts', `${recovery.originalHash}.json`);
        assert.ok(recovery.version === 1 && recovery.authorizationHash === identity && fileHash(root, archivePath) === recovery.originalHash
          && Array.isArray(recovery.targets) && recovery.targets.length > 0 && recovery.targets.length < input.topic.stories.length,
          'Visual recovery must retain its exact original failed evidence and accepted siblings');
        const before = read(archivePath);
        assert.deepEqual(recovery.targets, before.failures.map((row: { topicId: string }) => row.topicId), 'Visual recovery targets changed');
        visualAllowed = task.topicIds.length === 1 && recovery.targets.includes(task.topicIds[0])
          && (task.role === 'script' && ['script-draft'].includes(task.capability) && [`source-visual-${task.topicIds[0]}`, `source-visual-format-${task.topicIds[0]}`].includes(task.taskId)
            || ['source-review', 'source-repair'].includes(task.role) && task.taskId.startsWith(`source-visual-${task.topicIds[0]}-fields-`));
      }
      assert.ok(allowed || visualAllowed, 'Editorial continuation task is outside the explicitly authorized review, length repair, retained visual or formatting scope');
      const guided = applyMemoryGuidance(prompt, input.request.memory);
      return dispatch(guided.prompt, validate, { ...task, taskId: `${stage}:${task.taskId}` });
    },
    vision: async () => { throw new Error('Editorial continuation cannot review media before accepted writing'); },
  };
  const reviewRecovery: DailyReviewRecovery | undefined = journal.intent === 'retry-invalid-review-response' && !input.checkpoint.artifacts.script.reviewRecovery ? {
    authorizationHash: identity, checkpointHash: journal.checkpointHash, candidateHash: journal.candidateHash,
    inputHash: journal.inputHash, reviewerHash: journal.reviewerHash, parentIdentity: journal.originalParent, assertCurrentParent: () => { assertUnchanged(); beginParentWork(child); },
  } : undefined;
  const lengthRecovery: DailyLengthRecovery | undefined = journal.intent === 'repair-exhausted-script-length' && !input.checkpoint.artifacts.script.lengthRecovery ? {
    authorizationHash: identity, checkpointHash: journal.checkpointHash, inputHash: journal.inputHash,
    writerHash: journal.reviewerHash, reviewerHash: journal.reviewerHash, parentIdentity: journal.originalParent,
    assertCurrentParent: () => { assertUnchanged(); beginParentWork(child); },
  } : undefined;
  const factualRecovery: DailyFactualRecovery | undefined = factual && !input.checkpoint.artifacts.script.factualRecovery ? {
    authorizationHash: factual.identity, checkpointHash: factual.checkpointHash, inputHash: factual.inputHash,
    writerHash: factual.reviewerHash, reviewerHash: factual.reviewerHash, parentIdentity: journal.originalParent,
    assertCurrentParent: () => { assertUnchanged(); beginParentWork(child); },
  } : undefined;
  const citationRecovery: DailyCitationRecovery | undefined = citation && !input.checkpoint.artifacts.script.citationRecovery ? {
    authorizationHash: citation.identity, checkpointHash: citation.checkpointHash, inputHash: citation.inputHash,
    writerHash: citation.reviewerHash, reviewerHash: citation.reviewerHash, parentIdentity: journal.originalParent,
    rawHash: citation.rawHash, originalReview: citation.originalReview,
    assertCurrentParent: () => { assertUnchanged(); beginParentWork(child); },
  } : undefined;
  return { context, child, journal, reviewRecovery, lengthRecovery, factualRecovery, citationRecovery, assertUnchanged };
}

/** Called under the media authorization budget lock; freezes predecessor spending exactly once. */
export function sealEditorialContinuation(root: string, id: string): { identity: string; budgetHash: string; physicalAttempts: number; toolAttempts: number } | undefined {
  if (!existsSync(journalPath(root, id))) return undefined;
  const journal = read<EditorialContinuationJournal>(journalPath(root, id));
  const path = contained(root, 'workdir/videos', id, 'editorial-continuation-seal.json');
  if (existsSync(path)) {
    const seal = read(path); assert.equal(fileHash(root, budgetPath(root, id, seal.identity)), seal.budgetHash, 'Sealed editorial spending changed'); return seal;
  }
  const state = openEditorialContinuation(root, id); state.assertUnchanged();
  const child = budget(root, id, journal.identity);
  const seal = { identity: journal.identity, budgetHash: fileHash(root, budgetPath(root, id, journal.identity)), physicalAttempts: child.attempts.length, toolAttempts: child.tools.length };
  writeFileSync(path, JSON.stringify(seal), { flag: 'wx', mode: 0o600 });
  return seal;
}
export function assertEditorialContinuationSeal(root: string, id: string, expected: ReturnType<typeof sealEditorialContinuation>) {
  if (!expected) { assert.ok(!existsSync(journalPath(root, id)), 'Unexpected editorial predecessor would duplicate allowances'); return; }
  const current = read(contained(root, 'workdir/videos', id, 'editorial-continuation-seal.json'));
  assert.equal(roleHash(current), roleHash(expected), 'Editorial predecessor seal changed');
  assert.equal(fileHash(root, budgetPath(root, id, expected.identity)), expected.budgetHash, 'Sealed editorial spending changed');
}
