import { modelJson, modelVisionJson, resolveModelRuntime, type ModelConfig, type ModelInvocationHooks } from './model.js';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isLocalRuntime } from './qualification-state.js';
import { beginParentWork, parentModelHooks, productionRoleAdapters, roleHash, runLocalRoleTask, type EditorialRole, type ParentWorkScope, type RoleAdapters, type RoleCapability, type RoleRoutingConfig } from './role-router.js';
import { assertPreparedModelTask, type PreparedModelTask, type PreparedTaskRole } from '../pipeline/writing-task.js';
import { jsonOutputContract } from './json-output-contract.js';

const roles: Record<Exclude<PreparedTaskRole, 'media-review'>, EditorialRole> = {
  research: 'research', 'evidence-select': 'research', 'evidence-review': 'critic',
  'newsletter-draft': 'writer', 'source-review': 'critic', 'source-repair': 'writer', script: 'writer',
};
const capabilities: Record<Exclude<PreparedTaskRole, 'media-review'>, RoleCapability> = {
  research: 'topic-research', 'evidence-select': 'source-evidence-selection', 'evidence-review': 'source-evidence-review',
  'newsletter-draft': 'bounded-prose', 'source-review': 'factual-critique', 'source-repair': 'bounded-prose', script: 'bounded-prose',
};
export interface PreparedDispatchOptions {
  root: string; parent: ParentWorkScope; primary: ModelConfig; policy: RoleRoutingConfig | null;
  briefHash: string; env?: NodeJS.ProcessEnv;
}
export interface PreparedDispatchAdapters {
  local?: RoleAdapters;
  hostRoot?: string;
  primary?<T>(request: { prompt: string; config: ModelConfig; env: NodeJS.ProcessEnv; deadline: number; hooks: ModelInvocationHooks }, validate: (value: T) => string | null): Promise<T>;
}

/** Explicit per-task routes share the original parent. Unspecified roles keep the selected
 * primary; an alternative model is never a rescue for a failed call. Local execution always
 * uses measured identity, the host lock, current RAM admission and bounded unload. */
export function createPreparedRoleDispatch(options: PreparedDispatchOptions, adapters: PreparedDispatchAdapters = {}) {
  if (options.root !== options.parent.root || !/^[a-f0-9]{64}$/.test(options.briefHash)) throw new Error('Prepared roles require the original workspace, parent and brief');
  if (options.policy && (options.policy.version !== 1 || options.policy.enabled !== true || roleHash(options.policy.limits) !== roleHash(options.parent.limits))) throw new Error('Prepared role policy cannot change the original parent allowance');
  const primary = structuredClone({ ...options.primary, rescue: { enabled: false } });
  const policy = options.policy ? structuredClone(options.policy) : null;
  const env = { ...(options.env ?? process.env) };
  const runtime = resolveModelRuntime(primary, env);
  const localPrimary = ['ollama', 'opencode'].includes(runtime.provider) && isLocalRuntime(runtime.provider, runtime.baseUrl, runtime.model?.toLowerCase());
  const localAdapters = adapters.local ?? productionRoleAdapters(options.root);
  return async <T>(prompt: string, validate: (value: T) => string | null, descriptor?: PreparedModelTask): Promise<T> => {
    assertPreparedModelTask(descriptor);
    if (descriptor.role === 'media-review') throw new Error('Media alignment requires the actual-image vision dispatch');
    const outputContract = jsonOutputContract(validate);
    const role = roles[descriptor.role];
    // The immutable descriptor and exact prompt identify a child; neither may replace its
    // siblings' receipts, change a topic or obtain a fresh parent deadline.
    const taskId = `prepared-${roleHash({ descriptor, prompt, ...(outputContract ? { outputContractHash: outputContract.hash } : {}) }).slice(0, 40)}`;
    if (policy?.roles?.[role] || localPrimary) {
      const localPolicy: RoleRoutingConfig = { version: 1, enabled: true, limits: options.parent.limits,
        ...(policy?.roles?.[role] ? { roles: { [role]: policy.roles[role] } } : {}) };
      const result = await runLocalRoleTask({ root: options.root, ...(adapters.hostRoot ? { hostRoot: adapters.hostRoot } : {}),
        parentId: options.parent.parentId, parentIdentity: options.parent.parentIdentity,
        taskId, topicId: descriptor.topicIds.length === 1 ? `topic-${roleHash(descriptor.topicIds[0]).slice(0, 24)}` : `slate-${roleHash(descriptor.topicIds).slice(0, 24)}`,
        briefHash: options.briefHash, evidenceHash: roleHash({ evidence: descriptor.evidenceHash, candidate: descriptor.candidateHash, topics: descriptor.topicIds }),
        contractHash: roleHash({ protocol: descriptor.protocolHash, capability: descriptor.capability, ...(outputContract ? { outputContractHash: outputContract.hash } : {}) }),
        role, capability: capabilities[descriptor.role], prompt, validate, primary, policy: localPolicy, env }, localAdapters);
      return result.value;
    }
    const parent = beginParentWork(options.parent);
    if ((options.parent.now ?? Date.now)() >= parent.deadline) throw new Error('Prepared model work reached its original parent deadline');
    const baseHooks = parentModelHooks(options.parent, taskId);
    let attempts = 0;
    const hooks: ModelInvocationHooks = { beforeAttempt: attempt => {
      if (attempt.rescue || attempt.provider !== runtime.provider || attempt.model !== runtime.model || attempt.baseUrl !== runtime.baseUrl || attempt.region !== runtime.region) throw new Error('Prepared task attempted an unselected provider or model');
      baseHooks.beforeAttempt?.(attempt); attempts++;
    } };
    const value = adapters.primary ? await adapters.primary({ prompt, config: primary, env, deadline: parent.deadline, hooks }, validate)
      : await modelJson(prompt, validate, primary, env, [], true, parent.deadline, hooks);
    if (!attempts) throw new Error('Prepared model transport returned without reserving an actual attempt');
    if ((options.parent.now ?? Date.now)() >= parent.deadline) throw new Error('Prepared model result arrived after its original parent deadline');
    const problem = validate(value); if (problem) throw new Error(problem);
    return value;
  };
}

export interface PreparedVisionAdapters {
  local?: RoleAdapters;
  hostRoot?: string;
  primary?<T>(request: { prompt: string; images: string[]; imageHashes: string[]; config: ModelConfig; env: NodeJS.ProcessEnv; deadline: number; hooks: ModelInvocationHooks }, validate: (value: T) => string | null): Promise<T>;
}
/** Explicit vision path. Text role routing is unchanged; unsupported local image routes fail
 * before inference rather than bypassing the local identity, fit, RAM and host-lock gates. */
export function createPreparedVisionDispatch(options: PreparedDispatchOptions, adapters: PreparedVisionAdapters = {}) {
  if (options.root !== options.parent.root || !/^[a-f0-9]{64}$/.test(options.briefHash)) throw new Error('Prepared vision requires the original workspace, parent and brief');
  if (options.policy && (options.policy.version !== 1 || !options.policy.enabled || roleHash(options.policy.limits) !== roleHash(options.parent.limits))) throw new Error('Prepared vision cannot change the original parent allowance');
  const primary = structuredClone({ ...options.primary, rescue: { enabled: false } });
  const policy = options.policy ? structuredClone(options.policy) : null;
  const env = { ...(options.env ?? process.env) }, runtime = resolveModelRuntime(primary, env);
  const localPrimary = ['ollama', 'opencode'].includes(runtime.provider) && isLocalRuntime(runtime.provider, runtime.baseUrl, runtime.model?.toLowerCase());
  return async <T>(prompt: string, images: string[], validate: (value: T) => string | null, descriptor?: PreparedModelTask, bounds?: { maxPromptBytes: number }): Promise<T> => {
    images = [...images]; // Caller mutations cannot change a retry's count or ordering.
    assertPreparedModelTask(descriptor);
    if (!['source-review', 'media-review'].includes(descriptor.role)) throw new Error('Prepared vision requires an explicit source-review or media-review task');
    if (bounds && (Object.keys(bounds).join(',') !== 'maxPromptBytes' || !Number.isSafeInteger(bounds.maxPromptBytes) || bounds.maxPromptBytes < 1 || bounds.maxPromptBytes > 131072 || descriptor.taskId !== 'final-media-review' || descriptor.role !== 'media-review')) throw new Error('Extended vision packet is only available to the bounded approved-script media review');
    const maxPromptBytes = bounds?.maxPromptBytes ?? 24000;
    if (Buffer.byteLength(prompt) > maxPromptBytes) throw new Error('Prepared vision exceeds its complete bounded source context');
    if (!localPrimary && runtime.contextTokens && Buffer.byteLength(prompt) + 4096 > runtime.contextTokens) throw new Error('Complete final-media evidence and output reserve do not fit the selected model context');
    if (policy?.roles?.critic) throw new Error('An explicit secondary local critic has no measured image-review route; it cannot silently use the primary image model');
    if (runtime.provider === 'bedrock' && runtime.supportsImages !== true) throw new Error('The selected Bedrock model has no configured image capability; no image model was called.');
    if (!images.length || images.length > 6) throw new Error('Prepared vision needs one to six actual images');
    const imageHash = (path: string) => {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('Prepared vision image exceeds its bounded file size');
      return createHash('sha256').update(readFileSync(path)).digest('hex');
    };
    const imageHashes = images.map(imageHash);
    const outputContract = jsonOutputContract(validate);
    const taskId = `prepared-vision-${roleHash({ descriptor, prompt, imageHashes, ...(outputContract ? { outputContractHash: outputContract.hash } : {}) }).slice(0, 40)}`;
    if (localPrimary) {
      // Same selected writer, actual image bytes, ordinary validator and original parent.
      // Reuse the measured local context/RAM/host lock lifecycle, never the cloud path.
      const result = await runLocalRoleTask({ root: options.root, ...(adapters.hostRoot ? { hostRoot: adapters.hostRoot } : {}),
        parentId: options.parent.parentId, parentIdentity: options.parent.parentIdentity, taskId,
        topicId: `vision-${roleHash(descriptor.topicIds).slice(0, 24)}`, briefHash: options.briefHash,
        evidenceHash: roleHash({ descriptor, imageHashes }),
        contractHash: roleHash({ protocol: descriptor.protocolHash, capability: descriptor.capability, ...(outputContract ? { outputContractHash: outputContract.hash } : {}) }),
        role: 'critic', capability: 'factual-critique', prompt, images, maxPromptBytes, validate, primary,
        policy: { version: 1, enabled: true, limits: options.parent.limits }, env }, adapters.local ?? productionRoleAdapters(options.root));
      return result.value;
    }
    const parent = beginParentWork(options.parent), clock = options.parent.now ?? Date.now;
    if (clock() >= parent.deadline) throw new Error('Prepared vision reached its original parent deadline');
    const base = parentModelHooks(options.parent, taskId); let attempts = 0;
    const hooks: ModelInvocationHooks = { beforeAttempt: attempt => {
      if (attempt.rescue || attempt.provider !== runtime.provider || attempt.model !== runtime.model || attempt.baseUrl !== runtime.baseUrl || attempt.region !== runtime.region) throw new Error('Prepared vision attempted an unselected provider or model');
      // The physical request includes the decoder contract and any correction feedback.
      // Checking only the original caller prompt lets a retry exceed the selected context.
      const physicalBytes = attempt.promptBytes + (attempt.outputMode === 'prompt-schema' ? 0 : attempt.outputSchemaBytes ?? 0);
      if (physicalBytes > maxPromptBytes) throw new Error('Prepared vision physical prompt/schema exceeds its complete bounded source context');
      if (runtime.contextTokens && physicalBytes + 4096 > runtime.contextTokens) throw new Error('Complete final-media physical prompt/schema and output reserve do not fit the selected model context');
      // Every retry binds the same actual bytes, never a replaced file at the same path.
      images.forEach((path, i) => { if (imageHash(path) !== imageHashes[i]) throw new Error('Prepared vision image changed before its model attempt'); });
      base.beforeAttempt?.(attempt); attempts++;
    } };
    const value = adapters.primary ? await adapters.primary({ prompt, images: [...images], imageHashes: [...imageHashes], config: primary, env, deadline: parent.deadline, hooks }, validate)
      : await modelVisionJson(prompt, images, validate, primary, env, parent.deadline, hooks);
    if (!attempts) throw new Error('Prepared vision returned without reserving an actual attempt');
    if (clock() >= parent.deadline) throw new Error('Prepared vision result arrived after its original parent deadline');
    const problem = validate(value); if (problem) throw new Error(problem); return value;
  };
}
