import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { atomicJson, contained, read, safeId } from '../workspaces.js';
import { waitForReleaseLock } from '../release-lock.js';
import { createSourceSupportContext, SOURCE_SUPPORT_VERSION, sourceSupportOutputSchema, sourceSupportPrompt, type SourceSupportReview } from '../pipeline/source-support.js';
import { jsonOutputContract, withJsonOutputContract } from './json-output-contract.js';
import { hasMeasuredModelIdentity, sameModelIdentity, type ModelIdentity } from './model-identity.js';
import type { ModelConfig } from './model.js';
import type { LocalRoleTask, LocalRoleRoute, RoleAdapters, ParentWorkScope } from './role-router.js';
import type { RoleQualification } from './role-state.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const GENERAL_CRITIC_CALIBRATION_VERSION = 2;
const scope = 'General source-support verdict and citation controls only: current full-mode protocol, four draft sentences, four claims, exact output schema. Free-text reasons are retained, not semantically certified. No specialist, retrieval, prose, visual, held-out generalization or publication qualification.';
interface Control {
  id: string; claims: string[]; text: string; expected: { supported: boolean; claimIds: number[]; alternativeClaimIds?: number[][] }[];
  sourceContext?: ReturnType<typeof createSourceSupportContext>;
}
const controls: readonly Control[] = [
  { id: 'exact-reordered', claims: ['The league scheduled the final for January 30.', 'Each club may register twelve players.',
    'The Saturday round contains four games.', 'The top four teams advance to the semifinals.'],
    text: 'The Saturday round contains four games. The league scheduled the final for January 30. The top four teams advance to the semifinals. Each club may register twelve players.',
    expected: [{ supported: true, claimIds: [3] }, { supported: true, claimIds: [1] }, { supported: true, claimIds: [4] }, { supported: true, claimIds: [2] }] },
  { id: 'paraphrase-and-inventions', claims: ['The archive opened its reading room on June 4.', 'The archive has six reading desks.',
    'Visitors must book before arrival.', 'The archive announcement supplies no visitor count.'],
    text: 'The reading room opened on June 4, according to the archive. The archive offers sixty reading desks. Visitors need an advance booking. The archive received two hundred visitors on opening day.',
    expected: [{ supported: true, claimIds: [1] }, { supported: false, claimIds: [2] }, { supported: true, claimIds: [3] },
      // Claim 1 supplies the opening-day context; claim 4 explicitly limits attendance
      // evidence. A rejection may legitimately reference either or both.
      { supported: false, claimIds: [4], alternativeClaimIds: [[1], [1, 4]] }] },
  { id: 'qualifier-and-plan', claims: ['The lab reported eighty percent accuracy only on its synthetic test set.',
    'The lab plans a physical hardware trial for October.', 'The report identifies the test set as synthetic.', 'The report gives no estimate of operating costs.'],
    text: 'The lab achieved eighty percent accuracy in ordinary customer use. The lab completed its physical hardware trial in October. The test set is synthetic, according to the report. Operating costs are not quantified in the report.',
    expected: [
      // Claims 1 and 3 both identify the synthetic setting. Requiring one preferred
      // citation recreates the false evidence-association failures this suite measures.
      { supported: false, claimIds: [1], alternativeClaimIds: [[3], [1, 3]] },
      { supported: false, claimIds: [2] },
      { supported: true, claimIds: [3], alternativeClaimIds: [[1], [1, 3]] },
      { supported: true, claimIds: [4] },
    ] },
  { id: 'date-and-source-silence', claims: ['The council opened the hall on September 12.', 'The council report identifies three indoor courts.',
    'The council report contains no video link.', 'The council report describes an October 1 registration deadline.'],
    text: 'The council report identifies three indoor courts. The council opened the hall on September 14. No video recording of the opening exists anywhere. Registration closes on October 1, according to the council report.',
    expected: [{ supported: true, claimIds: [2] }, { supported: false, claimIds: [1] }, { supported: false, claimIds: [3] }, { supported: true, claimIds: [4] }],
    sourceContext: createSourceSupportContext('2026-09-14', 'https://fixtures.example/council', [{ url: 'https://fixtures.example/council', publishedAt: '2026-09-13' }]) },
];

function shape(value: SourceSupportReview): string | null {
  if (!value || Object.keys(value).join(',') !== 'sentences' || !Array.isArray(value.sentences) || value.sentences.length !== 4) return 'Return exactly four sentence rows';
  const seen = new Set<number>();
  for (const row of value.sentences) {
    if (!row || Object.keys(row).sort().join(',') !== 'claimIds,id,reason,supported' || !Number.isSafeInteger(row.id) || row.id < 1 || row.id > 4 || seen.has(row.id)) return 'Sentence IDs must cover 1–4 exactly once';
    seen.add(row.id);
    if (typeof row.supported !== 'boolean' || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 500) return 'Each verdict needs a bounded reason';
    if (!Array.isArray(row.claimIds) || row.claimIds.length > 4 || new Set(row.claimIds).size !== row.claimIds.length || row.claimIds.some(id => !Number.isSafeInteger(id) || id < 1 || id > 4) || row.supported && !row.claimIds.length) return 'Use valid claim IDs; approvals need evidence';
  }
  return null;
}
export const generalCriticValidator = withJsonOutputContract(shape, sourceSupportOutputSchema([1, 2, 3, 4], 4));
export const GENERAL_CRITIC_CONTRACT = hash({ protocol: hash({ version: SOURCE_SUPPORT_VERSION, mode: 'full' }), capability: 'source-review', outputContractHash: jsonOutputContract(generalCriticValidator)!.hash });
const suiteHash = hash({ version: GENERAL_CRITIC_CALIBRATION_VERSION, contract: GENERAL_CRITIC_CONTRACT, controls });
export const generalCriticControlPlan = () => controls.map(control => ({ id: control.id, prompt: sourceSupportPrompt(control.text, control.claims, undefined, control.sourceContext),
  evidenceHash: hash(control), contractHash: GENERAL_CRITIC_CONTRACT, suiteHash, scope }));

export interface CriticCalibrationScore { falseApprovals: number; falseRejections: number; wrongAssociations: number; incomplete: number; passed: boolean }
export function scoreGeneralCriticControl(caseId: string, value: unknown): CriticCalibrationScore {
  const control = controls.find(row => row.id === caseId); if (!control) throw new Error('Unknown frozen critic calibration case');
  const score: CriticCalibrationScore = { falseApprovals: 0, falseRejections: 0, wrongAssociations: 0, incomplete: 0, passed: false };
  if (shape(value as SourceSupportReview)) { score.incomplete = 1; return score; }
  for (const row of (value as SourceSupportReview).sentences) {
    const expected = control.expected[row.id - 1]!;
    if (row.supported !== expected.supported) { if (row.supported) score.falseApprovals++; else score.falseRejections++; }
    // Empty evidence is legal for a rejection. Overlapping claims can provide multiple
    // valid evidence sets; unrelated extras cannot inherit their acceptance.
    const accepted = [expected.claimIds, ...(expected.alternativeClaimIds ?? [])];
    if ((row.supported || row.claimIds.length) && !accepted.some(ids => JSON.stringify([...row.claimIds].sort((a, b) => a - b)) === JSON.stringify(ids))) score.wrongAssociations++;
  }
  score.passed = !score.falseApprovals && !score.falseRejections && !score.wrongAssociations;
  return score;
}

/** This exception can run only a frozen calibration payload; arbitrary production prompts
 * cannot opt out of critic qualification. It gives the result no acceptance authority. */
type CalibrationPayload = Pick<LocalRoleTask<unknown>, 'parentId' | 'taskId' | 'topicId' | 'role' | 'capability' | 'contractHash' | 'briefHash' | 'evidenceHash' | 'prompt'>;
function matchesCalibrationPayload(task: CalibrationPayload): boolean {
  if (!task.parentId.startsWith('critic-check-') || task.role !== 'critic' || task.capability !== 'factual-critique' || task.contractHash !== GENERAL_CRITIC_CONTRACT || task.briefHash !== suiteHash) return false;
  return generalCriticControlPlan().some(control => task.taskId === `critic-${control.id}` && task.topicId === control.id && task.evidenceHash === control.evidenceHash && task.prompt === control.prompt);
}
export function isGeneralCriticCalibrationTask<T>(task: CalibrationPayload & Pick<LocalRoleTask<T>, 'validate'>): boolean {
  return matchesCalibrationPayload(task) && jsonOutputContract(task.validate)?.hash === jsonOutputContract(generalCriticValidator)!.hash;
}

/** Records the real adapter's requested mode; OpenCode can be unconstrained while still
 * carrying this exact application validator. Requested constraints never prove enforcement. */
export function hasGeneralCriticOutputAudit(attempt: { outputContractHash?: string; outputSchemaBytes?: number; outputMode?: string }): boolean {
  const expected = jsonOutputContract(generalCriticValidator)!;
  return attempt.outputContractHash === expected.hash && attempt.outputSchemaBytes === expected.bytes
    && ['json-schema', 'json-object', 'unconstrained'].includes(attempt.outputMode ?? '');
}

export interface GeneralCriticQualification extends RoleQualification {
  qualificationProtocol: 2; parentId: string; parentIdentity: string; scope: string; suiteHash: string;
  scores: { caseId: string; score: CriticCalibrationScore }[]; error?: string;
}

/** Caller supplies the already-authorized parent; calibration cannot quietly create a new
 * allowance. Measured runtime and physical attempts use the ordinary local host lifecycle. */
export async function qualifyGeneralCritic(options: { root: string; hostRoot?: string; parent: ParentWorkScope; primary: ModelConfig; route: LocalRoleRoute;
  identity: ModelIdentity; adapters?: RoleAdapters }): Promise<GeneralCriticQualification> {
  const { beginParentWork, runLocalRoleTask, productionRoleAdapters, localRoleConfig } = await import('./role-router.js');
  if (options.parent.root !== options.root || !options.parent.parentId.startsWith('critic-check-') || !hasMeasuredModelIdentity(options.identity)) throw new Error('Critic calibration requires an explicit critic-check parent and measured local identity');
  safeId(options.parent.parentId);
  const adapters = options.adapters ?? productionRoleAdapters(options.root), clock = adapters.now ?? Date.now;
  // Validate transport ownership before creating a parent or spending metadata time.
  // Tests may supply an isolated invoker; the real transport belongs to DATA_ROOT.
  if (!adapters.invoke) {
    const { DATA_ROOT } = await import('../util.js');
    if (realpathSync(options.root) !== realpathSync(DATA_ROOT)) throw new Error('Critic calibration must run in the active workspace; select it before starting the worker');
  }
  const state = beginParentWork(options.parent);
  if (state.remainingPhysical < controls.length || state.deadline <= clock()) throw new Error('Critic calibration needs four remaining physical calls inside its unchanged parent deadline');
  const measured = await adapters.inspect(localRoleConfig(options.primary, options.route).runtime, state.deadline);
  if (!sameModelIdentity(measured.identity, options.identity) || !measured.fitsMemory) throw new Error('Critic calibration identity or memory fit changed before starting');
  const record: GeneralCriticQualification = { version: 1, qualificationProtocol: 2, parentId: options.parent.parentId, parentIdentity: options.parent.parentIdentity, role: 'critic', capability: 'factual-critique',
    contractHash: GENERAL_CRITIC_CONTRACT, identity: structuredClone(options.identity), passed: false, checkedAt: new Date(clock()).toISOString(), evidence: [], scores: [], scope, suiteHash };
  try {
    for (const control of generalCriticControlPlan()) {
      const result = await runLocalRoleTask({ root: options.root, hostRoot: options.hostRoot, parentId: options.parent.parentId, parentIdentity: options.parent.parentIdentity,
        taskId: `critic-${control.id}`, topicId: control.id, role: 'critic', capability: 'factual-critique', contractHash: GENERAL_CRITIC_CONTRACT,
        briefHash: suiteHash, evidenceHash: control.evidenceHash, prompt: control.prompt, validate: generalCriticValidator,
        primary: options.primary, policy: { version: 1, enabled: true, roles: { critic: options.route }, limits: options.parent.limits }, env: {},
      }, { ...adapters, inspect: async (runtime, deadline) => { const value = await adapters.inspect(runtime, deadline);
        if (!sameModelIdentity(value.identity, options.identity)) throw new Error('Critic model identity changed during calibration'); return value; } });
      const path = contained(options.root, 'state/role-tasks', options.parent.parentId, hash({ version: 1, parent: options.parent.parentIdentity }), `critic-${control.id}.json`);
      record.evidence.push(relative(options.root, path));
      const score = scoreGeneralCriticControl(control.id, result.value); record.scores.push({ caseId: control.id, score });
      if (!score.passed) throw new Error(`Critic calibration failed ${control.id}: ${JSON.stringify(score)}`);
    }
    record.passed = true;
  } catch (error) { record.error = (error as Error).message; }
  record.checkedAt = new Date(clock()).toISOString();
  if (record.passed && !measuredGeneralCriticEvidence(options.root, record, clock())) {
    record.passed = false;
    record.error = 'Critic calibration responses passed, but their saved runtime, decoder or original-parent evidence did not verify.';
  }
  const unlock = waitForReleaseLock(options.root, 'model-role-qualification');
  try {
    const path = contained(options.root, 'state/model-role-qualification.json'), previous = read<RoleQualification[]>(path, []);
    if (!Array.isArray(previous)) throw new Error('Existing role qualification history is invalid; not overwritten');
    atomicJson(path, [...previous, record]);
    atomicJson(contained(options.root, 'state/role-tasks', record.parentId, 'qualification.json'), record);
  } finally { unlock(); }
  return record;
}

/** Recompute control scores from actual saved response JSON. A passed flag, model label,
 * arbitrary evidence path or a different schema cannot promote the critic. Filesystem
 * integrity remains the trust boundary; these hashes are not provider signatures. */
export function measuredGeneralCriticEvidence(root: string, record: RoleQualification, now: number): boolean {
  if (record.qualificationProtocol !== 2 || record.role !== 'critic' || record.capability !== 'factual-critique' || record.contractHash !== GENERAL_CRITIC_CONTRACT
    || typeof record.parentId !== 'string' || !record.parentId.startsWith('critic-check-') || record.evidence?.length !== controls.length || new Set(record.evidence).size !== controls.length) return false;
  const checked = Date.parse(record.checkedAt);
  const originalParent = (record as Partial<GeneralCriticQualification>).parentIdentity;
  if (!Number.isFinite(checked) || checked <= 0 || checked > now || !digest(originalParent)) return false;
  const budgetIdentity = hash({ version: 1, parent: originalParent });
  try {
    safeId(record.parentId);
    for (const [index, control] of generalCriticControlPlan().entries()) {
      const file = contained(root, record.evidence[index]!), parts = relative(contained(root, 'state/role-tasks', record.parentId), file).split(sep);
      if (parts.length !== 2 || parts[0] !== budgetIdentity || parts[1] !== `critic-${control.id}.json`) return false;
      const task = JSON.parse(readFileSync(file, 'utf8'));
      if (!matchesCalibrationPayload({ ...task, prompt: control.prompt }) || task.version !== 1 || task.status !== 'complete' || task.parentId !== record.parentId
        || !sameModelIdentity(task.model, record.identity) || task.promptHash !== hash(control.prompt) || task.valueHash !== hash(task.value) || !digest(task.identity)
        || !Number.isSafeInteger(task.physicalAttempts) || task.physicalAttempts < 1 || task.physicalAttempts > 2
        || !Number.isFinite(task.startedAt) || !Number.isFinite(task.completedAt) || task.startedAt <= 0 || task.completedAt < task.startedAt || task.completedAt > checked) return false;
      const budget = JSON.parse(readFileSync(contained(root, 'state/role-tasks', record.parentId, parts[0]!, 'budget.json'), 'utf8'));
      if (budget.identity !== parts[0] || !Array.isArray(budget.attempts) || !Number.isSafeInteger(budget.maxPhysicalCalls) || budget.maxPhysicalCalls < 1 || budget.maxPhysicalCalls > 100
        || budget.attempts.length > budget.maxPhysicalCalls || !Number.isFinite(budget.deadline) || task.completedAt >= budget.deadline) return false;
      const attempts = budget.attempts.filter((row: { task?: string }) => row.task === task.taskId);
      if (attempts.length !== task.physicalAttempts || attempts.some((row: { provider?: string; model?: string; at?: number; outputContractHash?: string; outputSchemaBytes?: number; outputMode?: string }) => row.provider !== record.identity.provider
        || row.model !== record.identity.model || !Number.isFinite(row.at) || row.at! < task.startedAt || row.at! > task.completedAt
        || !hasGeneralCriticOutputAudit(row))) return false;
      if (!scoreGeneralCriticControl(control.id, task.value).passed) return false;
    }
    return true;
  } catch { return false; }
}
