import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { assertEvaluationAction, privateLocalEvaluation } from '../local-evaluation.js';
import { authorize } from '../workspaces.js';
import { runLocalRoleTask, roleHash, beginParentWork, type LocalRoleTask, type RoleAdapters } from './role-router.js';
import type { ModelConfig } from './model.js';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'private-local-evaluation-'));
  const write = (path: string, value: unknown) => { const p = join(root, path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(value)); };
  const primary: ModelConfig = { provider: 'ollama', timeoutSeconds: 90, rescue: { enabled: false }, providers: { ollama: { model: 'example:7b', baseUrl: 'http://127.0.0.1:11434/v1', contextTokens: 32768 } } };
  const marker = { version: 1, mode: 'unqualified-local-evaluation', parentId: 'comparison-1', modelConfigHash: roleHash(primary), sourceReplayManifestHash: roleHash('sources'), createdBy: 'owner', createdAt: new Date().toISOString(), publicationAllowed: false, qualificationClaimed: false };
  write('config/model.json', primary); write('config/pipeline.json', { autonomy: 'review' }); write('config/platforms.json', { x: { enabled: false } });
  write('state/private-local-evaluation.json', marker); write('workdir/videos/comparison-1/private-local-evaluation.json', marker); write('workdir/videos/comparison-1/journey-editorial-replay.json', { manifestHash: marker.sourceReplayManifestHash });
  const task: LocalRoleTask<{ supported: boolean }> = { root, hostRoot: root, parentId: marker.parentId, parentIdentity: roleHash('parent'), taskId: 'review-1', topicId: 'topic-1', briefHash: roleHash('brief'), evidenceHash: roleHash('evidence'), contractHash: roleHash('actual-unsupported-calibration-scope'), role: 'critic', capability: 'factual-critique', prompt: 'Read all sources, then review this candidate.', validate: value => value?.supported === true ? null : 'unsupported', primary, policy: { version: 1, enabled: true, limits: { totalSeconds: 120, maxPhysicalCalls: 2, maxToolCalls: 0 } }, env: {} };
  let calls = 0;
  const adapters: RoleAdapters = { inspect: async runtime => ({ fitsMemory: true, identity: { protocolVersion: 1, provider: runtime.provider, model: runtime.model!, baseUrl: runtime.baseUrl!, digest: 'a'.repeat(64), context: { mode: 'requested', tokens: 32768, proof: 'request' }, format: 'gguf', quantization: 'Q4_K_M', runtimeVersion: '0.34.0', hardwareFingerprint: 'b'.repeat(64) } }), invoke: async <T>(r: any) => { calls++; r.hooks.beforeAttempt({ provider: 'ollama', model: 'example:7b', baseUrl: 'http://127.0.0.1:11434/v1', attempt: 1, rescue: false, promptBytes: Buffer.byteLength(r.prompt) }); return { supported: true } as T; } };
  return { root, task, primary, write, adapters, calls: () => calls, close: () => rmSync(root, { recursive: true, force: true }) };
}
test('unqualified critic evaluation records actual call without granting qualification or renewing parent', async () => {
  const f = fixture(); try {
    const scope = { root: f.root, parentId: f.task.parentId, parentIdentity: f.task.parentIdentity, limits: f.task.policy.limits };
    const before = beginParentWork(scope), result = await runLocalRoleTask(f.task, f.adapters);
    assert.equal(f.calls(), 1); assert.equal(result.receipt.qualified, false); assert.equal(result.receipt.evaluationOnly, true); assert.equal(result.receipt.physicalAttempts, 1);
    const after = beginParentWork(scope); assert.equal(after.deadline, before.deadline); assert.equal(after.remainingPhysical, 1);
    await runLocalRoleTask(f.task, f.adapters); assert.equal(f.calls(), 1);
    assert.throws(() => authorize('approve', { root: f.root, actor: { id: 'owner', role: 'owner' } }), /cannot be approved or published/);
    assert.throws(() => authorize('publish', { root: f.root, actor: { id: 'owner', role: 'owner' } }), /cannot be approved or published/);
  } finally { f.close(); }
});
test('evaluation refuses a different model/package, enabled destination, changed marker and unmeasured fit', async () => {
  const f = fixture(); try {
    assert.throws(() => privateLocalEvaluation(f.root, 'other-package', f.primary));
    await assert.rejects(runLocalRoleTask({ ...f.task, policy: { ...f.task.policy, roles: { critic: { provider: 'ollama', model: 'other:4b', contextTokens: 32768 } } } }, f.adapters), /pinned primary model/); assert.equal(f.calls(), 0);
    assert.throws(() => privateLocalEvaluation(f.root, f.task.parentId, { ...f.primary, timeoutSeconds: 91 }));
    f.write('config/platforms.json', { x: { enabled: true } }); await assert.rejects(runLocalRoleTask(f.task, f.adapters), /Private local evaluation/); assert.equal(f.calls(), 0);
    f.write('config/platforms.json', { x: { enabled: false } });
    await assert.rejects(runLocalRoleTask(f.task, { ...f.adapters, inspect: async runtime => ({ ...(await f.adapters.inspect(runtime)), fitsMemory: false, reason: 'memory does not fit' }) }), /memory does not fit/); assert.equal(f.calls(), 0);
    f.write('state/private-local-evaluation.json', {}); assert.throws(() => assertEvaluationAction(f.root, 'publish'), /cannot be approved or published/);
  } finally { f.close(); }
});
test('selected primary can attempt production review without a private marker; context bounds still apply', async () => {
  const f = fixture(); try {
    const marker = JSON.parse(readFileSync(join(f.root, 'state/private-local-evaluation.json'), 'utf8'));
    rmSync(join(f.root, 'state/private-local-evaluation.json'));
    const result = await runLocalRoleTask(f.task, f.adapters);
    assert.equal(result.receipt.selectedBy, 'primary'); assert.equal(result.receipt.qualified, false);
    assert.equal(result.receipt.evaluationOnly, undefined); assert.equal(f.calls(), 1);
    f.write('state/private-local-evaluation.json', marker);
    await assert.rejects(runLocalRoleTask({ ...f.task, prompt: 'x'.repeat(32768) }, f.adapters), /context allowance/); assert.equal(f.calls(), 1);
  } finally { f.close(); }
});
