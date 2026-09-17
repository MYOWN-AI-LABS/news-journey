import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { atomicJson } from '../workspaces.js';
import type { ModelAttempt, ModelConfig, ModelRuntime } from './model.js';
import type { ModelIdentity } from './model-identity.js';
import { beginParentWork, reserveParentModelAttempt, localRoleConfig, resolveLocalRole, roleHash, roleQualificationStatus, runLocalRoleTask, type LocalRoleTask, type RoleAdapters, type RoleRoutingConfig, type ParentWorkScope } from './role-router.js';
import { MAX_JSON_OUTPUT_SCHEMA_BYTES } from './json-output-contract.js';

const primary: ModelConfig = { provider: 'ollama', timeoutSeconds: 90, rescue: { enabled: true, maxCallsPerDay: 2 }, providers: { ollama: { model: 'writer:7b', baseUrl: 'http://127.0.0.1:11434/v1', contextTokens: 8192 } } };
const policy: RoleRoutingConfig = { version: 1, enabled: true, limits: { totalSeconds: 120, maxPhysicalCalls: 4 }, roles: { writer: { provider: 'ollama', model: 'writer:7b', contextTokens: 8192 }, research: { provider: 'ollama', model: 'research:3b', contextTokens: 8192 } } };
test('operation-only production survives human pauses without renewing physical allowance or changing legacy deadlines', () => {
  const root = mkdtempSync(join(tmpdir(), 'operation-only-parent-')); let now = 1000;
  const scope: ParentWorkScope = { root, parentId: 'edition', parentIdentity: roleHash('operation-only'), limits: { totalSeconds: 1800, maxPhysicalCalls: 1, maxToolCalls: 1 }, deadlinePolicy: 'operation-only', now: () => now };
  try {
    assert.equal(beginParentWork(scope).deadline, Number.MAX_SAFE_INTEGER);
    now += 24 * 3600_000;
    reserveParentModelAttempt(scope, 'media-review', { provider: 'codex', model: 'fixture', promptBytes: 10, attempt: 1, rescue: false });
    assert.equal(beginParentWork(scope).remainingPhysical, 0);
    assert.throws(() => reserveParentModelAttempt(scope, 'media-review', { provider: 'codex', model: 'fixture', promptBytes: 10, attempt: 1, rescue: false }), /exhausted/);
    const legacy = { ...scope, parentId: 'legacy', parentIdentity: roleHash('legacy'), deadlinePolicy: undefined };
    const initial = beginParentWork(legacy);
    now += 2 * 3600_000;
    assert.equal(beginParentWork({ ...legacy, deadlinePolicy: 'operation-only' }).deadline, initial.deadline, 'new defaults cannot rewrite a historical deadline');
    assert.throws(() => reserveParentModelAttempt({ ...legacy, deadlinePolicy: 'operation-only' }, 'media-review', { provider: 'codex', model: 'fixture', promptBytes: 10, attempt: 1, rescue: false }), /time ceiling/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
const identity = (runtime: ModelRuntime): ModelIdentity => ({ protocolVersion: 1, provider: runtime.provider, model: runtime.model!, baseUrl: runtime.baseUrl!, digest: 'a'.repeat(64), context: { mode: 'requested', tokens: 8192, proof: 'request' }, runtimeVersion: '0.fixture', hardwareFingerprint: 'b'.repeat(64) });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'local-role-'));
  const task: LocalRoleTask<{ ids: number[] }> = { root, hostRoot: root, parentId: 'edition-1', parentIdentity: roleHash('request'), taskId: 'writer-1', topicId: 'topic-1', briefHash: roleHash('sports'), evidenceHash: roleHash('verified facts'), contractHash: roleHash('select ids'), role: 'writer', capability: 'claim-id-selection', prompt: 'Return only the selected IDs for this topic.', validate: value => JSON.stringify(value) === '{"ids":[1]}' ? null : 'need ids 1', primary, policy, env: {} };
  let calls = 0, inspections = 0;
  const adapters: RoleAdapters = {
    inspect: async runtime => { inspections++; return { identity: identity(runtime), fitsMemory: true }; },
    invoke: async <T>(request: any, _validate: (value: T) => string | null): Promise<T> => {
      calls++; const runtime = localRoleConfig(request.config, { provider: request.config.provider, ...request.config.providers[request.config.provider] }).runtime;
      request.hooks.beforeAttempt({ provider: runtime.provider, model: runtime.model, baseUrl: runtime.baseUrl, attempt: 1, rescue: false, promptBytes: Buffer.byteLength(request.prompt) });
      return { ids: [1] } as T;
    },
  };
  return { root, task, adapters, calls: () => calls, inspections: () => inspections, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('explicit local roles preserve the primary configuration and ignore stale model environment', async () => {
  const f = fixture(); try {
    const saved = JSON.stringify(primary);
    const route = await resolveLocalRole(f.root, primary, policy, 'research', 'source-id-selection', roleHash('contract'), f.adapters, { AI_CONTENT_MODEL_PROVIDER: 'grok', AI_CONTENT_MODEL_NAME: 'cloud-model' });
    assert.equal(route.runtime.model, 'research:3b'); assert.equal(route.config.rescue?.enabled, false);
    assert.equal(route.qualified, false); assert.equal(JSON.stringify(primary), saved);
    for (const route of [
      { provider: 'ollama' as const, model: 'model:cloud' },
      { provider: 'ollama' as const, model: 'model', baseUrl: 'https://remote.example/v1' },
      { provider: 'opencode' as const, model: 'opencode/example-free' },
    ]) assert.throws(() => localRoleConfig(primary, route), /local only/);
  } finally { f.close(); }
});

test('parent ledger preserves requested decoder metadata without changing old attempts or renewing allowances', () => {
  const f = fixture(); try {
    let now = 1000;
    const scope: ParentWorkScope = { root: f.root, parentId: f.task.parentId, parentIdentity: f.task.parentIdentity, limits: policy.limits, now: () => now };
    const initial = beginParentWork(scope);
    const plain: ModelAttempt = { provider: 'ollama', model: 'writer:7b', attempt: 1, rescue: false, promptBytes: 12000 };
    reserveParentModelAttempt(scope, 'ordinary', plain);
    now += 100;
    reserveParentModelAttempt(scope, 'schema-request', { ...plain, outputContractHash: 'a'.repeat(64), outputSchemaBytes: MAX_JSON_OUTPUT_SCHEMA_BYTES, outputMode: 'json-schema' });
    reserveParentModelAttempt(scope, 'unsupported-transport', { ...plain, outputContractHash: 'b'.repeat(64), outputSchemaBytes: 100, outputMode: 'unconstrained' });
    const path = join(f.root, 'state/role-tasks', scope.parentId, roleHash({ version: 1, parent: scope.parentIdentity }), 'budget.json');
    const budget = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(budget.attempts[0], { task: 'ordinary', at: 1000, provider: 'ollama', model: 'writer:7b', promptBytes: 12000 });
    assert.deepEqual(budget.attempts[1], { task: 'schema-request', at: 1100, provider: 'ollama', model: 'writer:7b', promptBytes: 12000, outputContractHash: 'a'.repeat(64), outputSchemaBytes: 8192, outputMode: 'json-schema' });
    assert.equal(budget.attempts[2].outputMode, 'unconstrained', 'attached schema does not imply an unsupported transport requested enforcement');
    assert.equal(Object.hasOwn(budget.attempts[1], 'schema'), false);
    assert.equal(Object.hasOwn(budget.attempts[1], 'enforced'), false);
    const resumed = beginParentWork(scope);
    assert.equal(resumed.deadline, initial.deadline);
    assert.equal(resumed.physicalAttempts, 3); assert.equal(resumed.remainingPhysical, 1);
    assert.equal(resumed.remainingTools, initial.remainingTools);
  } finally { f.close(); }
});

test('malformed decoder audit metadata cannot reserve or reset a saved parent', () => {
  const f = fixture(); try {
    const scope: ParentWorkScope = { root: f.root, parentId: f.task.parentId, parentIdentity: f.task.parentIdentity, limits: policy.limits, now: () => 1000 };
    const initial = beginParentWork(scope);
    const plain: ModelAttempt = { provider: 'ollama', model: 'writer:7b', attempt: 1, rescue: false, promptBytes: 100 };
    const valid = { ...plain, outputContractHash: 'c'.repeat(64), outputSchemaBytes: 1, outputMode: 'json-schema' as const };
    for (const attempt of [
      { ...plain, outputContractHash: 'c'.repeat(64) }, { ...valid, outputContractHash: 'wrong' },
      { ...valid, outputSchemaBytes: 0 }, { ...valid, outputSchemaBytes: 1.5 },
      { ...valid, outputSchemaBytes: MAX_JSON_OUTPUT_SCHEMA_BYTES + 1 }, { ...valid, outputMode: 'enforced' },
    ]) assert.throws(() => reserveParentModelAttempt(scope, 'bad', attempt as ModelAttempt), /Invalid physical model attempt/);
    assert.deepEqual(beginParentWork(scope), initial);
    reserveParentModelAttempt(scope, 'valid', valid);
    const path = join(f.root, 'state/role-tasks', scope.parentId, roleHash({ version: 1, parent: scope.parentIdentity }), 'budget.json');
    const corrupted = JSON.parse(readFileSync(path, 'utf8')); delete corrupted.attempts[0].outputSchemaBytes;
    atomicJson(path, corrupted);
    const before = readFileSync(path, 'utf8');
    assert.throws(() => beginParentWork(scope), /allowance is invalid; it cannot be reset/);
    assert.equal(readFileSync(path, 'utf8'), before, 'invalid saved allowance is left intact');
  } finally { f.close(); }
});

test('whole-writer qualification never promotes a critic; exact current role identity and contract are required', async () => {
  const f = fixture(); try {
    const runtime = localRoleConfig(primary, policy.roles!.writer!).runtime, measured = identity(runtime), contractHash = roleHash('critic-v1');
    const criticPolicy = { ...policy, roles: { ...policy.roles, critic: policy.roles!.writer } };
    atomicJson(join(f.root, 'state/model-qualification.json'), { qualified: true });
    await assert.rejects(resolveLocalRole(f.root, primary, criticPolicy, 'critic', 'factual-critique', contractHash, f.adapters, {}), /No independent qualification protocol/);
    const record = { version: 1, identity: measured, role: 'critic', capability: 'factual-critique', contractHash, passed: true, checkedAt: '2026-09-14T00:00:00Z', evidence: ['fixtures/factual-errors.json'] };
    atomicJson(join(f.root, 'state/model-role-qualification.json'), [record]);
    await assert.rejects(resolveLocalRole(f.root, primary, criticPolicy, 'critic', 'factual-critique', contractHash, f.adapters, {}), /No independent qualification protocol/);
    for (const changed of [{ ...measured, digest: 'c'.repeat(64) }, { ...measured, hardwareFingerprint: 'd'.repeat(64) }, { ...measured, context: { ...measured.context, tokens: 16384 } }]) assert.equal(roleQualificationStatus(f.root, changed, 'critic', 'factual-critique', contractHash).qualified, false);
    assert.equal(roleQualificationStatus(f.root, measured, 'critic', 'factual-critique', roleHash('changed')).qualified, false);
  } finally { f.close(); }
});

test('resume checks current digest, brief, facts, topic and output bytes; successful siblings survive failed topics', async () => {
  const f = fixture(); try {
    await runLocalRoleTask(f.task, f.adapters);
    assert.equal((await runLocalRoleTask(f.task, f.adapters)).reused, true); assert.equal(f.calls(), 1); assert.equal(f.inspections(), 2);
    const fail = { ...f.adapters, invoke: async <T>(request: any, validate: (value: T) => string | null) => { await f.adapters.invoke!(request, validate); throw new Error('topic two failed'); } };
    await assert.rejects(runLocalRoleTask({ ...f.task, taskId: 'writer-2', topicId: 'topic-2' }, fail), /topic two failed/);
    assert.equal((await runLocalRoleTask(f.task, f.adapters)).reused, true);
    await runLocalRoleTask({ ...f.task, briefHash: roleHash('new brief') }, f.adapters); assert.equal(f.calls(), 3);
    await runLocalRoleTask({ ...f.task, evidenceHash: roleHash('new facts') }, f.adapters); assert.equal(f.calls(), 4);
    const changedModel = { ...f.adapters, inspect: async (runtime: ModelRuntime) => ({ identity: { ...identity(runtime), digest: 'c'.repeat(64) }, fitsMemory: true }) };
    await assert.rejects(runLocalRoleTask(f.task, changedModel), /exhausted its physical attempt allowance/);
    assert.equal(f.calls(), 5, 'adapter entered but no fifth physical attempt was allowed');
    const parent = join(f.root, 'state/role-tasks/edition-1', readdirSync(join(f.root, 'state/role-tasks/edition-1'))[0]!);
    const budget = JSON.parse(readFileSync(join(parent, 'budget.json'), 'utf8')); assert.equal(budget.attempts.length, 4);
    assert.ok(readdirSync(parent).filter(name => name.startsWith('writer-2-')).length >= 1);
  } finally { f.close(); }
});

test('changed cached output is regenerated, and changed limits do not reset an existing parent allowance', async () => {
  const f = fixture(); try {
    await runLocalRoleTask(f.task, f.adapters);
    const parent = join(f.root, 'state/role-tasks/edition-1', readdirSync(join(f.root, 'state/role-tasks/edition-1'))[0]!);
    const path = join(parent, 'writer-1.json'), cached = JSON.parse(readFileSync(path, 'utf8'));
    cached.value = { ids: [7] }; atomicJson(path, cached);
    assert.equal((await runLocalRoleTask(f.task, f.adapters)).reused, false);
    await assert.rejects(runLocalRoleTask({ ...f.task, policy: { ...policy, limits: { ...policy.limits, maxPhysicalCalls: 5 } } }, f.adapters), /allowance is invalid/);
  } finally { f.close(); }
});

test('parent deadline survives retry, physical corrections reserve separately, and oversized packets make no inference', async () => {
  const f = fixture(); try {
    let now = 1000;
    const adapters: RoleAdapters = { ...f.adapters, now: () => now, invoke: async <T>(request: any, validate: (value: T) => string | null): Promise<T> => {
      await f.adapters.invoke!(request, validate); await f.adapters.invoke!(request, validate); return { ids: [1] } as T;
    } };
    await runLocalRoleTask(f.task, adapters); assert.equal(f.calls(), 2);
    now += 120001;
    await assert.rejects(runLocalRoleTask({ ...f.task, taskId: 'next' }, adapters), /total time ceiling/);
    await assert.rejects(runLocalRoleTask({ ...f.task, parentId: 'oversized', prompt: 'x'.repeat(5000) }, f.adapters), /proven context allowance/);
    assert.equal(f.calls(), 2);
  } finally { f.close(); }
});

test('same-host task calls serialize in-process and cleanup completes before a second model starts', async () => {
  const f = fixture(); try {
    let active = 0, maxActive = 0; const events: string[] = [];
    const adapters: RoleAdapters = { ...f.adapters,
      enter: async runtime => { active++; maxActive = Math.max(maxActive, active); events.push('enter:' + runtime.model); },
      invoke: async <T>(request: any, validate: (value: T) => string | null) => { await new Promise(resolve => setTimeout(resolve, 20)); return f.adapters.invoke!<T>(request, validate); },
      leave: async runtime => { events.push('leave:' + runtime.model); active--; },
    };
    await Promise.all([runLocalRoleTask(f.task, adapters), runLocalRoleTask({ ...f.task, taskId: 'research-1', role: 'research', capability: 'source-id-selection' }, adapters)]);
    assert.equal(maxActive, 1); assert.deepEqual(events, ['enter:writer:7b', 'leave:writer:7b', 'enter:research:3b', 'leave:research:3b']);
  } finally { f.close(); }
});

test('unknown context, changed request context, insufficient memory and hidden transport substitution fail closed', async () => {
  const f = fixture(); try {
    for (const inspect of [
      async (runtime: ModelRuntime) => ({ identity: { ...identity(runtime), digest: null }, fitsMemory: true }),
      async (runtime: ModelRuntime) => ({ identity: { ...identity(runtime), context: { mode: 'installed-model-default' as const, tokens: null, proof: 'unknown' as const } }, fitsMemory: true }),
      async (runtime: ModelRuntime) => ({ identity: { ...identity(runtime), context: { mode: 'requested' as const, tokens: 16384, proof: 'request' as const } }, fitsMemory: true }),
      async (runtime: ModelRuntime) => ({ identity: identity(runtime), fitsMemory: false }),
    ]) await assert.rejects(runLocalRoleTask(f.task, { ...f.adapters, inspect }));
    assert.equal(f.calls(), 0);
    await assert.rejects(runLocalRoleTask(f.task, { ...f.adapters, invoke: async (request: any) => { request.hooks.beforeAttempt({ provider: 'codex', model: 'other', rescue: true, attempt: 1, promptBytes: 100 }); return { ids: [1] } as any; } }), /different runtime/);
  } finally { f.close(); }
});

test('separate workers and a later retry share one durable physical allowance', async () => {
  const f = fixture(); try {
    const task = { ...f.task, policy: { ...policy, limits: { totalSeconds: 120, maxPhysicalCalls: 1 } } };
    const source = `import {appendFileSync} from 'node:fs';
import {runLocalRoleTask} from ${JSON.stringify(new URL('./role-router.js', import.meta.url).href)};
const task=JSON.parse(process.argv[1]);task.validate=()=>null;
const adapters={inspect:async runtime=>({identity:{protocolVersion:1,provider:runtime.provider,model:runtime.model,baseUrl:runtime.baseUrl,digest:'a'.repeat(64),context:{mode:'requested',tokens:8192,proof:'request'},runtimeVersion:'fixture',hardwareFingerprint:'b'.repeat(64)},fitsMemory:true}),invoke:async request=>{const runtime=request.config.providers.ollama;request.hooks.beforeAttempt({provider:'ollama',model:runtime.model,baseUrl:runtime.baseUrl,attempt:1,rescue:false,promptBytes:Buffer.byteLength(request.prompt)});appendFileSync(task.root+'/physical.jsonl','actual fixture request\\n');await new Promise(resolve=>setTimeout(resolve,30));throw new Error('fixture failed after actual request');}};
try{await runLocalRoleTask(task,adapters);console.log('unexpected success');}catch(error){console.log(error.message);}`;
    const run = (taskId: string) => new Promise<string>((resolve, reject) => execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, JSON.stringify({ ...task, taskId })], { timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const output = await Promise.all([run('worker-1'), run('worker-2')]);
    assert.ok(output.some(value => value.includes('fixture failed after actual request')));
    assert.match(await run('worker-3'), /exhausted its physical attempt allowance/);
    assert.equal(readFileSync(join(f.root, 'physical.jsonl'), 'utf8').trim().split('\n').length, 1);
  } finally { f.close(); }
});
