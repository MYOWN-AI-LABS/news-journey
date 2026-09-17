/** Explicit, audited recovery from the first CLI call that did not receive its bound schema. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, contained, safeId } from '../workspaces.js';
import { releaseLock } from '../release-lock.js';
import { roleHash, type ParentWorkScope } from '../llm/role-router.js';
import { assertInvalidReviewRecoveryCandidate, type DailyEditorialCheckpoint, type DailyEditorialInput, type DailyEditorialRoute, type DailyReviewRecovery } from './daily-editorial.js';

export function reconcileJourneyCliSchemaTransport(root: string, packageId: string, options: {
  intent: 'retry-undelivered-cli-schema'; expectedCheckpointHash: string; parentIdentity: string;
}) {
  safeId(packageId);
  if (options.intent !== 'retry-undelivered-cli-schema' || !/^[a-f0-9]{64}$/.test(options.expectedCheckpointHash)
    || !/^[a-f0-9]{64}$/.test(options.parentIdentity)) throw new Error('Schema transport reconciliation needs explicit intent and exact prior identities');
  const unlock = releaseLock(root, `journey-editorial-${roleHash(packageId).slice(0, 20)}`);
  try {
    const dir = contained(root, 'workdir/videos', packageId), path = join(dir, 'journey-editorial-checkpoint.json');
    const original = JSON.parse(readFileSync(path, 'utf8')) as DailyEditorialCheckpoint;
    const request = JSON.parse(readFileSync(join(dir, 'writing-request.json'), 'utf8'));
    if (request.parentIdentity !== options.parentIdentity || roleHash(original) !== options.expectedCheckpointHash
      || original.contentHash !== roleHash(original.artifacts)) throw new Error('Schema reconciliation checkpoint or original parent changed');
    const script = original.artifacts.script;
    if (original.artifacts.newsletter.status !== 'accepted' || script.status !== 'held' || script.writes !== 1
      || script.candidates.length !== 0 || script.reviews.length !== 0
      || script.failures.at(-1) !== 'script writer unavailable: Codex CLI failed after retry: missing publish metadata') {
      throw new Error('Only the exact first undelivered-schema failure can use the remaining original script repair');
    }
    const checkpoint = structuredClone(original);
    checkpoint.artifacts.script.status = 'repair';
    checkpoint.contentHash = roleHash(checkpoint.artifacts);
    const receipt = { version: 1, transport: 'cli-json-schema-prompt-v1', intent: options.intent,
      packageId, parentIdentity: options.parentIdentity, beforeCheckpointHash: options.expectedCheckpointHash,
      afterCheckpointHash: roleHash(checkpoint), at: new Date().toISOString(),
      reason: 'The bound output schema was not delivered to the CLI. Deliver it on the one remaining original script write; retain newsletter approval, all failures, writes, physical calls and the original deadline.',
      originalCheckpoint: original };
    // The immutable before-state receipt is durable before the single state transition.
    writeFileSync(join(dir, `journey-editorial-transport-reconciliation-${options.expectedCheckpointHash}.json`), JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
    atomicJson(path, checkpoint);
    return receipt;
  } finally { unlock(); }
}


interface ReviewRecoveryBudget {
  version: 1; identity: string; deadline: number; maxPhysicalCalls: number; maxToolCalls: number;
  attempts: unknown[]; tools: unknown[];
}
interface ReviewRecoveryAuthorization {
  version: 1; intent: 'retry-invalid-review-response'; packageId: string; parentIdentity: string;
  checkpointHash: string; candidateHash: string; inputHash: string; reviewerHash: string; requestHash: string;
  originalCheckpoint: DailyEditorialCheckpoint; originalBudget: ReviewRecoveryBudget;
}
function readRecoveryBudget(parent: ParentWorkScope, prior?: ReviewRecoveryBudget): ReviewRecoveryBudget {
  const identity = roleHash({ version: 1, parent: parent.parentIdentity });
  // Read only: absent receipts never start a fresh allowance during reconciliation.
  const value = JSON.parse(readFileSync(contained(parent.root, 'state/role-tasks', parent.parentId, identity, 'budget.json'), 'utf8')) as ReviewRecoveryBudget;
  const now = (parent.now ?? Date.now)();
  if (value.version !== 1 || value.identity !== identity || value.maxPhysicalCalls !== parent.limits.maxPhysicalCalls
    || value.maxToolCalls !== (parent.limits.maxToolCalls ?? 8) || !Number.isFinite(value.deadline) || now >= value.deadline
    || !Array.isArray(value.attempts) || value.attempts.length >= value.maxPhysicalCalls || !Array.isArray(value.tools) || value.tools.length > value.maxToolCalls) throw new Error('Review recovery requires the existing unexpired parent and remaining physical allowance');
  if (prior && (value.deadline !== prior.deadline || value.maxPhysicalCalls !== prior.maxPhysicalCalls || value.maxToolCalls !== prior.maxToolCalls
    || value.attempts.length < prior.attempts.length || value.tools.length < prior.tools.length
    || roleHash(value.attempts.slice(0, prior.attempts.length)) !== roleHash(prior.attempts)
    || roleHash(value.tools.slice(0, prior.tools.length)) !== roleHash(prior.tools))) throw new Error('Review recovery parent history, limits or deadline changed');
  return value;
}

/** Explicit one-time authorization only; never edits the candidate, verdict or parent ledger. */
export function reconcileJourneyInvalidReviewResponse(root: string, packageId: string, options: {
  intent: 'retry-invalid-review-response'; expectedCheckpointHash: string;
  input: DailyEditorialInput; reviewer: DailyEditorialRoute['identity']; parent: ParentWorkScope;
}) {
  safeId(packageId);
  if (options.intent !== 'retry-invalid-review-response' || !/^[a-f0-9]{64}$/.test(options.expectedCheckpointHash)
    || options.parent.root !== root || options.parent.parentId !== packageId || !/^[a-f0-9]{64}$/.test(options.parent.parentIdentity)) throw new Error('Review recovery needs explicit intent and the exact original parent');
  const unlock = releaseLock(root, `journey-editorial-${roleHash(packageId).slice(0, 20)}`);
  try {
    const dir = contained(root, 'workdir/videos', packageId);
    const checkpoint = JSON.parse(readFileSync(join(dir, 'journey-editorial-checkpoint.json'), 'utf8')) as DailyEditorialCheckpoint;
    const request = JSON.parse(readFileSync(join(dir, 'writing-request.json'), 'utf8'));
    const savedInput = JSON.parse(readFileSync(join(dir, 'journey-editorial-input.json'), 'utf8'));
    if (roleHash(checkpoint) !== options.expectedCheckpointHash || request.parentIdentity !== options.parent.parentIdentity
      || savedInput.hash !== roleHash(savedInput.input) || savedInput.hash !== roleHash(options.input)) throw new Error('Review recovery checkpoint, source input or request identity changed');
    const candidate = assertInvalidReviewRecoveryCandidate(checkpoint);
    const authorization: ReviewRecoveryAuthorization = { version: 1, intent: options.intent, packageId,
      parentIdentity: options.parent.parentIdentity, checkpointHash: options.expectedCheckpointHash, candidateHash: roleHash(candidate),
      inputHash: roleHash(options.input), reviewerHash: roleHash(options.reviewer), requestHash: roleHash(request),
      originalCheckpoint: checkpoint, originalBudget: readRecoveryBudget(options.parent) };
    writeFileSync(join(dir, 'journey-review-transport-recovery.json'), JSON.stringify(authorization), { mode: 0o600, flag: 'wx' });
    return authorization;
  } finally { unlock(); }
}

/** Called under the ordinary Journey lock; the daily workflow persists consumption before inference. */
export function readJourneyReviewRecovery(root: string, packageId: string, input: DailyEditorialInput,
  reviewer: DailyEditorialRoute['identity'], parent: ParentWorkScope): DailyReviewRecovery | undefined {
  safeId(packageId);
  const dir = contained(root, 'workdir/videos', packageId), path = join(dir, 'journey-review-transport-recovery.json');
  if (!existsSync(path)) return undefined;
  const authorization = JSON.parse(readFileSync(path, 'utf8')) as ReviewRecoveryAuthorization;
  const authorizationHash = roleHash(authorization);
  const checkpoint = JSON.parse(readFileSync(join(dir, 'journey-editorial-checkpoint.json'), 'utf8')) as DailyEditorialCheckpoint;
  const request = JSON.parse(readFileSync(join(dir, 'writing-request.json'), 'utf8'));
  if (authorization.version !== 1 || authorization.intent !== 'retry-invalid-review-response' || authorization.packageId !== packageId
    || parent.root !== root || parent.parentId !== packageId || authorization.parentIdentity !== parent.parentIdentity
    || request.parentIdentity !== parent.parentIdentity || authorization.requestHash !== roleHash(request)
    || authorization.inputHash !== roleHash(input) || authorization.reviewerHash !== roleHash(reviewer)
    || authorization.checkpointHash !== roleHash(authorization.originalCheckpoint)
    || authorization.candidateHash !== roleHash(assertInvalidReviewRecoveryCandidate(authorization.originalCheckpoint))) throw new Error('Review recovery authorization, source or selected reviewer changed');
  if (checkpoint.artifacts.script.reviewRecovery) {
    if (checkpoint.artifacts.script.reviewRecovery.authorizationHash !== authorizationHash) throw new Error('Consumed review recovery receipt changed');
    return undefined; // Accepted caches may reuse; interrupted/held states remain held by the workflow.
  }
  if (roleHash(checkpoint) !== authorization.checkpointHash) throw new Error('Review recovery checkpoint changed before consumption');
  const assertCurrentParent = () => { readRecoveryBudget(parent, authorization.originalBudget); };
  assertCurrentParent();
  return { authorizationHash, checkpointHash: authorization.checkpointHash, candidateHash: authorization.candidateHash,
    inputHash: authorization.inputHash, reviewerHash: authorization.reviewerHash, parentIdentity: parent.parentIdentity, assertCurrentParent };
}
