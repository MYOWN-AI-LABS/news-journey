import { admitLocalContext, LOCAL_CONTEXT_ADMISSION_VERSION, type LocalContextAdmission } from './local-token-count.js';
import { privateLocalEvaluation } from '../local-evaluation.js';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicJson, contained, safeId, CODE_ROOT } from '../workspaces.js';
import { DATA_ROOT } from '../util.js';
import { releaseLock, waitForReleaseLock } from '../release-lock.js';
import { modelJson, modelVisionJson, resolveModelRuntime, type ModelConfig, type ModelRuntime, type ModelInvocationHooks, type ModelAttempt } from './model.js';
import { isLocalRuntime } from './qualification-state.js';
import { hasMeasuredModelIdentity, modelIdentityKey, type ModelIdentity } from './model-identity.js';
import { readLocalModelIdentity, writerCanReadImages } from './local-models.js';
import { MAX_JSON_OUTPUT_SCHEMA_BYTES } from './json-output-contract.js';
import { roleQualificationStatus, type EditorialRole, type RoleCapability } from './role-state.js';
import { hasGeneralCriticOutputAudit, isGeneralCriticCalibrationTask } from './critic-qualification.js';
export { roleQualificationStatus, type EditorialRole, type RoleCapability, type RoleQualification } from './role-state.js';

export interface LocalRoleRoute {
  provider: 'ollama' | 'opencode'; model: string; baseUrl?: string; contextTokens?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'max'; timeoutSeconds?: number;
}
export interface RoleRoutingConfig {
  version: 1; enabled: boolean;
  roles?: Partial<Record<EditorialRole, LocalRoleRoute>>;
  /** Alternatives are considered only with a current pass for this exact role and contract. */
  candidates?: LocalRoleRoute[];
  limits: { maxPhysicalCalls: number; totalSeconds: number; maxToolCalls?: number };
}
export const ROLE_ROUTING_VERSION = 1;
export const roleHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const roles: EditorialRole[] = ['research', 'writer', 'critic'];
const capabilities: RoleCapability[] = ['source-id-selection', 'claim-id-selection', 'factual-critique', 'topic-research', 'source-evidence-selection', 'source-evidence-review', 'bounded-prose'];
function read<T>(path: string, fallback: T): T { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : fallback; }

export function readRoleRouting(root: string): RoleRoutingConfig | null {
  const config = read<RoleRoutingConfig | null>(contained(root, 'config/role-routing.json'), null);
  if (!config) return null;
  if (config.version !== 1 || typeof config.enabled !== 'boolean') throw new Error('Invalid local role configuration version or enabled flag');
  if (!config.enabled) return null;
  checkLimits(config.limits);
  if (config.roles && (typeof config.roles !== 'object' || Array.isArray(config.roles) || Object.keys(config.roles).some(role => !roles.includes(role as EditorialRole)))) throw new Error('Invalid local editorial roles');
  if (config.candidates && (!Array.isArray(config.candidates) || config.candidates.length > 8)) throw new Error('At most eight local role alternatives may be configured');
  return config;
}
function checkLimits(limits: RoleRoutingConfig['limits']): void {
  if (!limits || !Number.isSafeInteger(limits.maxPhysicalCalls) || limits.maxPhysicalCalls < 1 || limits.maxPhysicalCalls > 100 || !Number.isSafeInteger(limits.totalSeconds) || limits.totalSeconds < 1 || limits.totalSeconds > 1800) throw new Error('Local role limits need 1–100 physical attempts and 1–1800 total seconds');
  if (limits.maxToolCalls !== undefined && (!Number.isSafeInteger(limits.maxToolCalls) || limits.maxToolCalls < 0 || limits.maxToolCalls > 32)) throw new Error('Parent tool allowance must be 0–32 actual calls');
}

/** Preserve the selected primary settings; explicit roles never inherit another role's env overrides. */
export function localRoleConfig(primary: ModelConfig, route: LocalRoleRoute): { config: ModelConfig; runtime: ModelRuntime } {
  if (!route || !['ollama', 'opencode'].includes(route.provider) || typeof route.model !== 'string' || !route.model.trim()) throw new Error('A local role must select an exact Ollama or OpenCode model');
  if (route.timeoutSeconds !== undefined && (!Number.isSafeInteger(route.timeoutSeconds) || route.timeoutSeconds < 1 || route.timeoutSeconds > 300)) throw new Error('Local role request timeout must be 1–300 seconds');
  if (route.provider === 'opencode' && (route.baseUrl !== undefined && route.baseUrl !== 'http://127.0.0.1:11434/v1' || route.contextTokens !== undefined || route.reasoningEffort !== undefined)) throw new Error('OpenCode roles use the isolated Ollama route and its proven installed context; HTTP context/effort overrides are unsupported');
  const config: ModelConfig = { ...primary, provider: route.provider, timeoutSeconds: route.timeoutSeconds ?? primary.timeoutSeconds ?? 90, rescue: { enabled: false }, providers: { ...primary.providers } };
  if (route.provider === 'ollama') {
    const defaults = primary.provider === 'ollama' && primary.providers.ollama?.model === route.model ? primary.providers.ollama : undefined;
    config.providers.ollama = { ...defaults, baseUrl: route.baseUrl ?? defaults?.baseUrl ?? 'http://127.0.0.1:11434/v1', model: route.model, ...(route.contextTokens !== undefined ? { contextTokens: route.contextTokens } : {}), ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) };
  }
  else config.providers.opencode = { command: primary.providers.opencode?.command, model: route.model };
  const runtime = resolveModelRuntime(config, {});
  if (!isLocalRuntime(runtime.provider, runtime.baseUrl, runtime.model?.toLowerCase()) || !['ollama', 'opencode'].includes(runtime.provider)) throw new Error('This role is local only; remote Ollama, cloud tags and native cloud clients are not eligible');
  return { config, runtime };
}
function primaryRoute(primary: ModelConfig, env: NodeJS.ProcessEnv): LocalRoleRoute | null {
  const runtime = resolveModelRuntime(primary, env);
  if (!['ollama', 'opencode'].includes(runtime.provider) || !isLocalRuntime(runtime.provider, runtime.baseUrl, runtime.model?.toLowerCase())) return null;
  return { provider: runtime.provider as LocalRoleRoute['provider'], model: runtime.model!, ...(runtime.provider === 'ollama' ? { baseUrl: runtime.baseUrl, contextTokens: runtime.contextTokens, reasoningEffort: runtime.reasoningEffort } : {}), timeoutSeconds: Math.min(300, runtime.timeoutMs / 1000) };
}

export interface RoleRuntimeInspection { identity: ModelIdentity; fitsMemory: boolean; reason?: string }
export interface RoleTransportRequest { prompt: string; images?: string[]; config: ModelConfig; deadline: number; hooks: ModelInvocationHooks }
export interface RoleAdapters {
  /** Fresh metadata on every task, including resume. Must not load weights. */
  inspect(runtime: ModelRuntime, deadline?: number): Promise<RoleRuntimeInspection>;
  /** Called under the host lock, before/after the actual task. No parallel weight loading. */
  enter?(runtime: ModelRuntime, deadline: number): Promise<void>;
  leave?(runtime: ModelRuntime, deadline: number): Promise<void>;
  canReadImages?(runtime: ModelRuntime): Promise<boolean>;
  invoke?<T>(request: RoleTransportRequest, validate: (value: T) => string | null): Promise<T>;
  now?: () => number;
}
interface ResolvedRole { config: ModelConfig; runtime: ModelRuntime; identity: ModelIdentity; qualified: boolean; selectedBy: 'explicit' | 'primary' | 'qualification' }
export async function resolveLocalRole(root: string, primary: ModelConfig, policy: RoleRoutingConfig, role: EditorialRole, capability: RoleCapability, contractHash: string, adapters: RoleAdapters, env: NodeJS.ProcessEnv = process.env, deadline?: number): Promise<ResolvedRole> {
  return resolveLocalRoleInternal(root, primary, policy, role, capability, contractHash, adapters, env, deadline);
}
async function resolveLocalRoleInternal(root: string, primary: ModelConfig, policy: RoleRoutingConfig, role: EditorialRole, capability: RoleCapability, contractHash: string, adapters: RoleAdapters, env: NodeJS.ProcessEnv, deadline?: number, calibration = false): Promise<ResolvedRole> {
  if (!roles.includes(role) || !capabilities.includes(capability) || !digest(contractHash)) throw new Error('Invalid editorial role, capability or task contract');
  const critic = capability === 'factual-critique' || capability === 'source-evidence-review';
  if (critic && role !== 'critic') throw new Error('Factual critique belongs to the critic role');
  const explicit = policy.roles?.[role], primaryChoice = explicit ? null : primaryRoute(primary, env);
  const choices = explicit ? [{ route: explicit, selectedBy: 'explicit' as const }] : [
    ...(primaryChoice ? [{ route: primaryChoice, selectedBy: 'primary' as const }] : []),
    ...(policy.candidates ?? []).map(route => ({ route, selectedBy: 'qualification' as const })),
  ];
  const reasons: string[] = [];
  for (const choice of choices) {
    try {
      const selected = localRoleConfig(primary, choice.route);
      const inspection = await adapters.inspect(selected.runtime, deadline);
      const identity = inspection.identity;
      if (!hasMeasuredModelIdentity(identity) || identity.provider !== selected.runtime.provider || identity.model !== selected.runtime.model || identity.baseUrl !== selected.runtime.baseUrl || (identity.reasoningEffort ?? 'default') !== (selected.runtime.reasoningEffort ?? 'default')) throw new Error('Current model digest, actual context, runtime and hardware identity must be measured before this local task');
      if (selected.runtime.provider === 'ollama') {
        const requested = selected.runtime.contextTokens ?? (/-32k(:|$)/.test(selected.runtime.model!) ? null : 16384);
        if (requested !== null && (identity.context.tokens !== requested || identity.context.proof !== 'request')) throw new Error('Measured context does not match the exact Ollama request');
      }
      if (!inspection.fitsMemory) throw new Error(inspection.reason || 'This exact model/context does not fit the current memory allowance');
      const status = roleQualificationStatus(root, identity, role, capability, contractHash);
      // The operator's selected primary may draft and review its own preview. This is
      // an attempted, fully validated review, not a qualification or publishing grant.
      // A different explicit/automatically selected critic still needs measured qualification.
      if ((choice.selectedBy === 'qualification' || critic && choice.selectedBy !== 'primary' && !calibration) && !status.qualified) throw new Error(status.reason);
      return { ...selected, identity, qualified: status.qualified, selectedBy: choice.selectedBy };
    } catch (error) { reasons.push((error as Error).message); if (explicit) throw error; }
  }
  throw new Error(`No eligible local ${role}: ${reasons.join('; ') || 'select an installed local role model'}`);
}

type OutputRequestAudit = Pick<ModelAttempt, 'promptHash' | 'outputContractHash' | 'outputSchemaBytes' | 'outputMode' | 'outputTokenLimit'>;
interface ParentBudget { version: 1; identity: string; deadline: number; deadlinePolicy?: 'fixed' | 'operation-only'; maxPhysicalCalls: number; attempts: Array<{ task: string; at: number; provider: string; model: string; promptBytes: number } & OutputRequestAudit>; maxToolCalls?: number; tools?: Array<{ task: string; tool: string; at: number }> }
export interface ParentWorkScope { root: string; parentId: string; parentIdentity: string; limits: RoleRoutingConfig['limits']; deadlinePolicy?: 'fixed' | 'operation-only'; now?: () => number }
export interface ParentWorkState { deadline: number; physicalAttempts: number; toolAttempts: number; remainingPhysical: number; remainingTools: number }
export interface RoleTaskReceipt<T = unknown> {
  version: 1; parentId: string; taskId: string; topicId: string; identity: string; role: EditorialRole; capability: RoleCapability;
  model: ModelIdentity; selectedBy: ResolvedRole['selectedBy']; qualified: boolean;
  contractHash: string; briefHash: string; evidenceHash: string; promptHash: string;
  status: 'running' | 'complete' | 'failed'; startedAt: number; completedAt?: number; physicalAttempts: number;
  contextChecks?: LocalContextAdmission[];
  imageHashes?: string[];
  value?: T; valueHash?: string; error?: string;
  evaluationOnly?: true; evaluationReceiptHash?: string;
}
export interface LocalRoleTask<T> {
  root: string; hostRoot?: string; parentId: string; parentIdentity: string; taskId: string; topicId: string;
  briefHash: string; evidenceHash: string; contractHash: string; role: EditorialRole; capability: RoleCapability;
  /** Only this task's topic data, never a prior conversation or another topic's prose. */
  prompt: string; validate: (value: T) => string | null;
  images?: string[];
  maxPromptBytes?: number;
  primary: ModelConfig; policy: RoleRoutingConfig; env?: NodeJS.ProcessEnv;
}
const queues = new Map<string, Promise<void>>();
async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  let finish!: () => void;
  const current = new Promise<void>(resolve => { finish = resolve; });
  const pending = prior.catch(() => {}).then(() => current);
  queues.set(key, pending);
  await prior.catch(() => {});
  try { return await fn(); } finally { finish(); if (queues.get(key) === pending) queues.delete(key); }
}
function validOutputRequestAudit(value: OutputRequestAudit): boolean {
  if (value.outputTokenLimit !== undefined && (!Number.isSafeInteger(value.outputTokenLimit) || value.outputTokenLimit < 1 || value.outputTokenLimit > 4096)) return false;
  if (value.promptHash !== undefined && !digest(value.promptHash)) return false;
  if (value.outputContractHash === undefined && value.outputSchemaBytes === undefined && value.outputMode === undefined) return true;
  return digest(value.outputContractHash) && Number.isSafeInteger(value.outputSchemaBytes) && value.outputSchemaBytes! > 0 && value.outputSchemaBytes! <= MAX_JSON_OUTPUT_SCHEMA_BYTES && ['json-schema', 'json-object', 'prompt-schema', 'unconstrained'].includes(value.outputMode ?? '');
}
function budgetRead(path: string, identity: string, limits: RoleRoutingConfig['limits'], now: number, deadlinePolicy?: ParentWorkScope['deadlinePolicy']): ParentBudget {
  // A public production package survives a human pause. Individual operations remain timed;
  // physical/tool reservations still cap total work. Existing timed runs retain their exact deadline.
  const budget = read<ParentBudget>(path, { version: 1, identity, deadline: deadlinePolicy === 'operation-only' ? Number.MAX_SAFE_INTEGER : now + limits.totalSeconds * 1000,
    ...(deadlinePolicy ? { deadlinePolicy } : {}), maxPhysicalCalls: limits.maxPhysicalCalls, attempts: [], maxToolCalls: limits.maxToolCalls ?? 8, tools: [] });
  if (budget.deadlinePolicy !== undefined && !['fixed', 'operation-only'].includes(budget.deadlinePolicy)
    || budget.deadlinePolicy === 'operation-only' && budget.deadline !== Number.MAX_SAFE_INTEGER) throw new Error('Saved parent deadline policy changed');
  if (budget.version !== 1 || budget.identity !== identity || budget.maxPhysicalCalls !== limits.maxPhysicalCalls || !Number.isFinite(budget.deadline) || !Array.isArray(budget.attempts) || budget.attempts.length > budget.maxPhysicalCalls || budget.attempts.some(row => !row || typeof row.task !== 'string' || !Number.isFinite(row.at) || typeof row.model !== 'string' || !Number.isSafeInteger(row.promptBytes) || !validOutputRequestAudit(row))) throw new Error('Saved local task allowance is invalid; it cannot be reset by retrying');
  // Older receipts retain their attempts/deadline and gain no retrospective tool allowance.
  if (budget.maxToolCalls === undefined && budget.tools === undefined) { budget.maxToolCalls = 0; budget.tools = []; }
  if (!Number.isSafeInteger(budget.maxToolCalls) || budget.maxToolCalls! < 0 || budget.maxToolCalls! > 32 || !Array.isArray(budget.tools) || budget.tools.length > budget.maxToolCalls! || budget.tools.some(row => !row || typeof row.task !== 'string' || typeof row.tool !== 'string' || !Number.isFinite(row.at)) || budget.maxToolCalls !== (limits.maxToolCalls ?? 8) && budget.maxToolCalls !== 0) throw new Error('Saved parent tool allowance is invalid; it cannot be reset by retrying');
  return budget;
}
function parentBudgetChange(scope: ParentWorkScope, change?: (budget: ParentBudget, now: number) => void): ParentWorkState {
  safeId(scope.parentId); checkLimits(scope.limits); if (!digest(scope.parentIdentity)) throw new Error('Parent work needs an immutable request identity');
  const identity = roleHash({ version: 1, parent: scope.parentIdentity }), path = contained(scope.root, 'state/role-tasks', scope.parentId, identity, 'budget.json');
  const unlock = waitForReleaseLock(scope.root, 'local-role-budget');
  try {
    const now = (scope.now ?? Date.now)(), budget = budgetRead(path, identity, scope.limits, now, scope.deadlinePolicy);
    if (change && now >= budget.deadline) throw new Error('Local role parent reached its total time ceiling');
    change?.(budget, now); atomicJson(path, budget);
    return { deadline: budget.deadline, physicalAttempts: budget.attempts.length, toolAttempts: budget.tools!.length, remainingPhysical: budget.maxPhysicalCalls - budget.attempts.length, remainingTools: budget.maxToolCalls! - budget.tools!.length };
  } finally { unlock(); }
}
/** Starts once before retrieval; re-reading never renews the deadline or refunds a failed attempt. */
export function beginParentWork(scope: ParentWorkScope): ParentWorkState { return parentBudgetChange(scope); }
export function reserveParentTool(scope: ParentWorkScope, taskId: string, tool: string): ParentWorkState {
  safeId(taskId); safeId(tool);
  return parentBudgetChange(scope, (budget, now) => {
    if (budget.tools!.length >= budget.maxToolCalls!) throw new Error('Parent exhausted its bounded tool allowance');
    budget.tools!.push({ task: taskId, tool, at: now });
  });
}
export function reserveParentModelAttempt(scope: ParentWorkScope, taskId: string, attempt: ModelAttempt): ParentWorkState {
  safeId(taskId);
  if (typeof attempt.provider !== 'string' || !Number.isSafeInteger(attempt.promptBytes) || attempt.promptBytes < 0 || !validOutputRequestAudit(attempt)) throw new Error('Invalid physical model attempt');
  return parentBudgetChange(scope, (budget, now) => {
    if (budget.attempts.length >= budget.maxPhysicalCalls) throw new Error('Local role parent exhausted its physical attempt allowance');
    // Requested decoder mode is audit metadata, never proof of enforcement or approval.
    budget.attempts.push({ task: taskId, at: now, provider: attempt.provider, model: attempt.model ?? 'configured CLI model', promptBytes: attempt.promptBytes, ...(attempt.promptHash ? { promptHash: attempt.promptHash } : {}), ...(attempt.outputTokenLimit ? { outputTokenLimit: attempt.outputTokenLimit } : {}),
      ...(attempt.outputContractHash === undefined ? {} : { outputContractHash: attempt.outputContractHash, outputSchemaBytes: attempt.outputSchemaBytes, outputMode: attempt.outputMode }) });
  });
}
export function parentModelHooks(scope: ParentWorkScope, taskId: string): ModelInvocationHooks { return { beforeAttempt: attempt => { reserveParentModelAttempt(scope, taskId, attempt); } }; }
/** The default is the existing isolated transport. Each actual adapter attempt reserves durably. */
export async function runLocalRoleTask<T>(task: LocalRoleTask<T>, adapters: RoleAdapters): Promise<{ value: T; receipt: RoleTaskReceipt<T>; reused: boolean }> {
  safeId(task.parentId); safeId(task.taskId); safeId(task.topicId); checkLimits(task.policy.limits);
  for (const value of [task.parentIdentity, task.briefHash, task.evidenceHash, task.contractHash]) if (!digest(value)) throw new Error('Local task needs exact parent, brief, evidence and contract identities');
  if (!task.policy.enabled || task.policy.version !== 1) throw new Error('Local editorial roles are not enabled');
  const packetLimit = task.maxPromptBytes ?? 131072;
  if (!Number.isSafeInteger(packetLimit) || packetLimit < 1 || packetLimit > 131072) throw new Error('Local task packet limit must remain within 128 KiB');
  const images = task.images ? [...task.images] : [];
  if (task.images && (!images.length || images.length > 6 || task.role !== 'critic')) throw new Error('Local vision needs one to six actual images and an explicit review task');
  const imageHash = (path: string) => {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > 8_000_000) throw new Error('Local vision image exceeds its bounded file size');
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  };
  const imageHashes = images.map(imageHash);
  const root = realpathSync(task.root), hostRoot = realpathSync(task.hostRoot ?? CODE_ROOT), now = adapters.now ?? Date.now;
  if (!adapters.invoke && root !== realpathSync(DATA_ROOT)) throw new Error('Local role worker workspace does not match its loaded model transport');
  const parentIdentity = roleHash({ version: 1, parent: task.parentIdentity });
  const parentPath = contained(root, 'state/role-tasks', task.parentId, parentIdentity, 'budget.json');
  const receiptPath = contained(root, 'state/role-tasks', task.parentId, parentIdentity, `${task.taskId}.json`);
  // Persist the aggregate deadline before queueing/metadata; waiting and worker restarts do not reset it.
  const releaseBudget = waitForReleaseLock(root, 'local-role-budget');
  let initial: ParentBudget;
  try { initial = budgetRead(parentPath, parentIdentity, task.policy.limits, now()); atomicJson(parentPath, initial); } finally { releaseBudget(); }
  return serial(resolve(hostRoot), async () => {
    const unlock = releaseLock(hostRoot, 'local-role-host');
    try {
      if (now() >= initial.deadline) throw new Error('Local role parent reached its total time ceiling');
      // A calibration exception is restricted to code-owned synthetic prompts and an
      // explicit critic-check parent. No caller boolean can bypass production admission.
      const calibration = isGeneralCriticCalibrationTask(task);
      const evaluation = privateLocalEvaluation(root, task.parentId, task.primary);
      if (evaluation && (Object.keys(task.policy.roles ?? {}).length || task.policy.candidates?.length)) throw new Error('Private local evaluation permits only its pinned primary model; role overrides and alternative candidates are disabled');
      const selected = await resolveLocalRoleInternal(root, task.primary, task.policy, task.role, task.capability, task.contractHash, adapters, task.env ?? process.env, initial.deadline, calibration || !!evaluation);
      if (images.length && !await (adapters.canReadImages ?? writerCanReadImages)(selected.runtime)) throw new Error('The selected local model does not advertise image review; no image model was called');
      const contextOptions = () => ({ timeoutMs: initial.deadline - now(), ...(images.length ? { images } : {}) });
      const initialContext = admitLocalContext(task.prompt, selected.identity, packetLimit, contextOptions());
      const identity = roleHash({ contextAdmissionVersion: LOCAL_CONTEXT_ADMISSION_VERSION, parentIdentity, brief: task.briefHash, evidence: task.evidenceHash, contract: task.contractHash, topic: task.topicId, role: task.role, capability: task.capability, model: modelIdentityKey(selected.identity), prompt: task.prompt, ...(images.length ? { imageHashes } : {}), settings: selected.config, qualified: selected.qualified, ...(evaluation ? { evaluationReceiptHash: evaluation.hash } : {}) });
      const saved = read<RoleTaskReceipt<T> | null>(receiptPath, null);
      if (saved?.version === 1 && saved.status === 'complete' && saved.identity === identity && saved.valueHash === roleHash(saved.value) && !task.validate(saved.value as T)) return { value: saved.value as T, receipt: saved, reused: true };
      const receipt: RoleTaskReceipt<T> = { version: 1, parentId: task.parentId, taskId: task.taskId, topicId: task.topicId, identity, role: task.role, capability: task.capability, contractHash: task.contractHash, briefHash: task.briefHash, evidenceHash: task.evidenceHash, promptHash: roleHash(task.prompt), model: selected.identity, selectedBy: selected.selectedBy, qualified: selected.qualified, status: 'running', startedAt: now(), physicalAttempts: 0, contextChecks: [initialContext], ...(images.length ? { imageHashes } : {}), ...(evaluation ? { evaluationOnly: true as const, evaluationReceiptHash: evaluation.hash } : {}) };
      // Each identity retains its own failure and completion receipt, including previous retries.
      const historyPath = contained(root, 'state/role-tasks', task.parentId, parentIdentity, `${task.taskId}-${identity}-${receipt.startedAt}.json`);
      const save = () => { atomicJson(historyPath, receipt); atomicJson(receiptPath, receipt); };
      save();
      let entered = false;
      try {
        if (now() >= initial.deadline) throw new Error('Local role parent reached its total time ceiling during metadata checks');
        await adapters.enter?.(selected.runtime, initial.deadline);
        entered = true;
        const hooks: ModelInvocationHooks = { ...(selected.runtime.provider === 'ollama' ? { outputTokenLimit: 4096 } : {}), beforeAttempt: (attempt, physicalPrompt) => {
          if (evaluation && privateLocalEvaluation(root, task.parentId, task.primary)?.hash !== evaluation.hash) throw new Error('Private evaluation settings changed before inference');
          if (attempt.rescue || attempt.provider !== selected.runtime.provider || attempt.model !== selected.runtime.model || attempt.baseUrl !== selected.runtime.baseUrl) throw new Error('Local role transport attempted a different runtime');
          if (calibration && !hasGeneralCriticOutputAudit(attempt)) throw new Error('Critic calibration transport must record the exact requested output schema and mode');
          images.forEach((path, i) => { if (imageHash(path) !== imageHashes[i]) throw new Error('Local vision image changed before its model attempt'); });
          if (physicalPrompt !== undefined) {
            if (selected.runtime.provider === 'ollama' && attempt.outputTokenLimit !== 4096) throw new Error('Local role transport omitted its reserved completion token ceiling');
            if (Buffer.byteLength(physicalPrompt) !== attempt.promptBytes || attempt.promptHash !== createHash('sha256').update(physicalPrompt).digest('hex')) throw new Error('Local role physical prompt differs from its attempt receipt');
            receipt.contextChecks!.push(admitLocalContext(physicalPrompt, selected.identity, packetLimit, { ...contextOptions(), extraInputTokens: attempt.outputMode === 'prompt-schema' ? 0 : attempt.outputSchemaBytes ?? 0 }));
            save();
          } else if (attempt.promptBytes > Math.min(packetLimit, selected.identity.context.tokens! - 4096)) {
            throw new Error('Local role corrective packet needs its complete actual prompt for exact token admission');
          }
          reserveParentModelAttempt({ root, parentId: task.parentId, parentIdentity: task.parentIdentity, limits: task.policy.limits, now }, task.taskId, attempt);
          receipt.physicalAttempts++; save();
        } };
        const request = { prompt: task.prompt, ...(images.length ? { images: [...images] } : {}), config: selected.config, deadline: initial.deadline, hooks };
        const value = adapters.invoke ? await adapters.invoke<T>(request, task.validate)
          : images.length ? await modelVisionJson<T>(task.prompt, images, task.validate, selected.config, {}, initial.deadline, hooks)
          : await modelJson<T>(task.prompt, task.validate, selected.config, {}, [], true, initial.deadline, hooks);
        images.forEach((path, i) => { if (imageHash(path) !== imageHashes[i]) throw new Error('Local vision image changed during its model review'); });
        const problem = task.validate(value); if (problem) throw new Error(problem);
        if (now() >= initial.deadline) throw new Error('Local role result arrived after its parent time ceiling');
        if (!receipt.physicalAttempts) throw new Error('Local role transport returned without reserving an actual attempt');
        if (entered) { entered = false; await adapters.leave?.(selected.runtime, initial.deadline); }
        receipt.value = value; receipt.valueHash = roleHash(value); receipt.status = 'complete'; receipt.completedAt = now(); save();
        return { value, receipt, reused: false };
      } catch (error) {
        let failure = error as Error;
        if (entered) { entered = false; try { await adapters.leave?.(selected.runtime, initial.deadline); } catch (cleanup) { failure = new Error(`${failure.message}; local model cleanup also failed: ${(cleanup as Error).message}`); } }
        receipt.status = 'failed'; receipt.error = failure.message; receipt.completedAt = now(); save(); throw failure;
      }
    } finally { unlock(); }
  });
}

/** Production lifecycle reuses the advisor's measured identity, then refreshes metadata before use.
 * No service creation, downloads, parallel inference or implicit hosted rescue. */
export function productionRoleAdapters(root: string): RoleAdapters {
  let selectedIdentity: ModelIdentity | undefined;
  const metadata = async (runtime: ModelRuntime, path: string, body?: object, deadline?: number): Promise<any> => {
    const left = deadline === undefined ? 3000 : Math.min(3000, deadline - Date.now());
    if (left <= 0) throw new Error('Local role lifecycle reached its time ceiling');
    const endpoint = runtime.baseUrl!.replace(/\/$/, '').replace(/\/v1$/, '');
    const response = await fetch(endpoint + path, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(left) });
    if (!response.ok || !response.body) throw new Error(`Local role lifecycle failed (HTTP ${response.status})`);
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (let item = await reader.read(); !item.done; item = await reader.read()) { size += item.value.length; if (size > 262144) throw new Error('Local role lifecycle metadata exceeds 256 KiB'); chunks.push(item.value); } }
    catch (error) { await reader.cancel().catch(() => {}); throw error; }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const name = (runtime: ModelRuntime) => runtime.provider === 'opencode' ? runtime.model!.slice('ollama/'.length) : runtime.model!;
  const namesMatch = (a: string, b: string) => a === b || a === b + ':latest' || a + ':latest' === b;
  return {
    inspect: async (runtime, deadline) => {
      // The three bounded metadata operations can take 25 s in total. Reserve that room first.
      if (deadline !== undefined && deadline - Date.now() < 26000) throw new Error('Local role parent has insufficient time for fresh hardware and model metadata');
      const { currentHardwareSnapshot, currentOpenCodeVersion, runAdvisorTool, advisorRoleFit } = await import('../model-advisor.js');
      const snapshot = await currentHardwareSnapshot(), hardwareFingerprint = snapshot.fingerprint;
      if (!hardwareFingerprint || !snapshot.system) throw new Error('Run the local model advisor to measure this computer before enabling editorial roles');
      let runtimeVersion: string | undefined;
      if (runtime.provider === 'opencode') {
        runtimeVersion = runtime.command === 'opencode' ? await currentOpenCodeVersion() : (await runAdvisorTool(runtime.command!, ['--version'], 5000)).trim();
        if (!/^(?:opencode\s+)?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(runtimeVersion)) throw new Error('The selected OpenCode command did not return an exact runtime version');
      }
      const contextTokens = runtime.provider === 'ollama' ? runtime.contextTokens ?? (/-32k(:|$)/.test(runtime.model!) ? undefined : 16384) : undefined;
      const identity = await readLocalModelIdentity(runtime.provider as 'ollama' | 'opencode', runtime.model!, runtime.baseUrl!, { contextTokens, reasoningEffort: runtime.reasoningEffort, runtimeVersion, hardwareFingerprint });
      const fit = advisorRoleFit(root, identity, snapshot.system);
      selectedIdentity = fit.fitsMemory ? identity : undefined;
      return { identity, ...fit };
    },
    enter: async (runtime, deadline) => {
      if (deadline - Date.now() < 16000) throw new Error('Local role parent has insufficient time for a fresh memory-capacity check');
      const { currentHardwareSnapshot, advisorRoleFit } = await import('../model-advisor.js');
      const snapshot = await currentHardwareSnapshot();
      if (!selectedIdentity || !snapshot.system || selectedIdentity.provider !== runtime.provider || selectedIdentity.model !== runtime.model || snapshot.fingerprint !== selectedIdentity.hardwareFingerprint) throw new Error('Local hardware changed before loading the selected model');
      const fit = advisorRoleFit(root, selectedIdentity, snapshot.system);
      if (!fit.fitsMemory) throw new Error(fit.reason);
      const state = await metadata(runtime, '/api/ps', undefined, deadline);
      // A loaded model may still be finishing a timed-out request, even when its name matches.
      // Start from empty and verify empty after cleanup; do not take over another client's model.
      if (!Array.isArray(state.models) || state.models.length) throw new Error('A local model is already loaded. Finish that task and unload it before starting these sequential editorial roles');
    },
    leave: async runtime => {
      // Cleanup has its own finite 6 s ceiling even after the generation deadline has expired.
      const deadline = Date.now() + 6000;
      await metadata(runtime, '/api/generate', { model: name(runtime), keep_alive: 0 }, deadline);
      const state = await metadata(runtime, '/api/ps', undefined, deadline);
      if (!Array.isArray(state.models) || state.models.some((row: { name?: string }) => row.name && namesMatch(row.name, name(runtime)))) throw new Error('The completed local model is still loaded; the next role will wait for memory to be released');
    },
  };
}
