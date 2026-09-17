import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreparedRoleDispatch, type PreparedDispatchAdapters } from './prepared-role-dispatch.js';
import { beginParentWork, roleHash, type ParentWorkScope, type RoleRoutingConfig } from './role-router.js';
import { resolveModelRuntime, type ModelConfig } from './model.js';
import { preparedModelTask, type PreparedTaskRole, type PreparedTaskCapability } from '../pipeline/writing-task.js';
import { withJsonOutputContract, jsonOutputContract, type JsonOutputSchema } from './json-output-contract.js';

const primary: ModelConfig = { provider: 'openai-compatible', timeoutSeconds: 90, rescue: { enabled: true },
  providers: { openaiCompatible: { baseUrl: 'https://provider.example/v1', model: 'selected-primary' } } };
const metadata = (role: PreparedTaskRole, capability: PreparedTaskCapability, topic = 'sports', candidate?: string) => preparedModelTask({
  role, capability, taskId: `${role}-1`, topicIds: [topic], protocol: { version: 1, capability }, evidence: { topic, facts: ['fixture facts'] }, candidate,
});
const valid = (value: { ok: boolean }) => value?.ok === true ? null : 'invalid result';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prepared-routing-'));
  const parent: ParentWorkScope = { root, parentId: 'edition-1', parentIdentity: roleHash('original request'), limits: { totalSeconds: 120, maxPhysicalCalls: 12, maxToolCalls: 0 } };
  const policy: RoleRoutingConfig = { version: 1, enabled: true, limits: parent.limits, roles: {
    research: { provider: 'ollama', model: 'research:3b', contextTokens: 8192 },
    writer: { provider: 'ollama', model: 'writer:9b', contextTokens: 8192 },
  } };
  const events: string[] = [];
  const invoke = async <T,>(request: any): Promise<T> => {
    const runtime = resolveModelRuntime(request.config, request.env ?? {});
    assert.equal(request.config.rescue.enabled, false);
    events.push(`invoke:${runtime.model}`);
    request.hooks.beforeAttempt({ provider: runtime.provider, model: runtime.model, baseUrl: runtime.baseUrl, attempt: 1, rescue: false, promptBytes: Buffer.byteLength(request.prompt) });
    return { ok: true } as T;
  };
  const adapters: PreparedDispatchAdapters = { hostRoot: root, primary: invoke, local: {
    inspect: async runtime => ({ fitsMemory: true, identity: { provider: runtime.provider, model: runtime.model!, baseUrl: runtime.baseUrl!,
      digest: 'a'.repeat(64), context: { mode: 'requested', tokens: 8192, proof: 'request' }, reasoningEffort: runtime.reasoningEffort,
      hardwareFingerprint: 'b'.repeat(64), runtimeVersion: 'fixture-1', protocolVersion: 1 } }),
    enter: async runtime => { events.push(`enter:${runtime.model}`); }, leave: async runtime => { events.push(`leave:${runtime.model}`); }, invoke,
  } };
  return { root, parent, policy, events, adapters, options: { root, parent, primary, policy, env: {}, briefHash: roleHash('sports') }, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('prepared research, drafting, review and writer repair use explicit routes and one shared allowance', async () => {
  const f = fixture(); try {
    const call = createPreparedRoleDispatch(f.options, f.adapters);
    await call('research', valid, metadata('research', 'query-plan'));
    await call('draft', valid, metadata('newsletter-draft', 'newsletter-draft'));
    await call('review', valid, metadata('source-review', 'source-review', 'sports', 'draft'));
    await call('repair', valid, metadata('source-repair', 'source-repair', 'sports', 'draft'));
    await call('re-review', valid, metadata('source-review', 'source-review', 'sports', 'repaired'));
    assert.deepEqual(f.events, ['enter:research:3b', 'invoke:research:3b', 'leave:research:3b',
      'enter:writer:9b', 'invoke:writer:9b', 'leave:writer:9b', 'invoke:selected-primary',
      'enter:writer:9b', 'invoke:writer:9b', 'leave:writer:9b', 'invoke:selected-primary']);
    assert.equal(beginParentWork(f.parent).physicalAttempts, 5);
  } finally { f.close(); }
});

test('role errors never invoke a fallback, and local critics cannot borrow ID qualification', async () => {
  const f = fixture(); try {
    const policy = { ...f.policy, roles: { ...f.policy.roles, critic: f.policy.roles!.writer } };
    const call = createPreparedRoleDispatch({ ...f.options, policy }, f.adapters);
    await assert.rejects(call('review', valid, metadata('source-review', 'source-review')), /No independent qualification protocol/);
    await assert.rejects(call('source review', valid, metadata('evidence-review', 'evidence-review')), /No independent qualification protocol/);
    assert.deepEqual(f.events, []);
    assert.equal(beginParentWork(f.parent).physicalAttempts, 0);
    const lowRam = createPreparedRoleDispatch(f.options, { ...f.adapters, local: { ...f.adapters.local!, inspect: async runtime => ({ ...(await f.adapters.local!.inspect(runtime)), fitsMemory: false, reason: 'Insufficient current RAM' }) } });
    await assert.rejects(lowRam('draft', valid, metadata('newsletter-draft', 'newsletter-draft')), /Insufficient current RAM/);
    assert.deepEqual(f.events, []);
  } finally { f.close(); }
});

test('missing task metadata, changed limits and unexpected runtime fail without buying another call', async () => {
  const f = fixture(); try {
    assert.throws(() => createPreparedRoleDispatch({ ...f.options, policy: { ...f.policy, limits: { ...f.policy.limits, maxPhysicalCalls: 13 } } }, f.adapters), /original parent allowance/);
    const call = createPreparedRoleDispatch(f.options, f.adapters);
    await assert.rejects(call('source-review words in prompt are not routing authority', valid), /explicit task metadata/);
    await assert.rejects(call('Inspect actual rendered frames.', valid, metadata('media-review', 'frame-alignment')), /actual-image vision dispatch/);
    const wrong = createPreparedRoleDispatch({ ...f.options, policy: null }, { ...f.adapters, primary: async request => {
      request.hooks.beforeAttempt!({ provider: 'grok', model: 'unselected', baseUrl: 'https://api.x.ai/v1', rescue: false, attempt: 1, promptBytes: 1 });
      throw new Error('should not reach');
    } });
    await assert.rejects(wrong('draft', valid, metadata('newsletter-draft', 'newsletter-draft')), /unselected provider/);
    assert.equal(beginParentWork(f.parent).physicalAttempts, 0);
  } finally { f.close(); }
});

test('local cache identity includes candidate, topic and protocol; failed local tasks still unload', async () => {
  const f = fixture(); try {
    const call = createPreparedRoleDispatch(f.options, f.adapters);
    const descriptor = metadata('source-repair', 'source-repair', 'sports', 'first draft');
    await call('repair', valid, descriptor);
    await call('repair', valid, descriptor);
    assert.equal(beginParentWork(f.parent).physicalAttempts, 1);
    await call('repair', valid, metadata('source-repair', 'source-repair', 'sports', 'second draft'));
    await call('repair', valid, metadata('source-repair', 'source-repair', 'science', 'second draft'));
    await call('repair', valid, { ...descriptor, protocolHash: roleHash('new protocol') });
    assert.equal(beginParentWork(f.parent).physicalAttempts, 4);
    const fail = createPreparedRoleDispatch(f.options, { ...f.adapters, local: { ...f.adapters.local!, invoke: async (request, validate) => {
      await f.adapters.local!.invoke!(request, validate); throw new Error('model unavailable');
    } } });
    await assert.rejects(fail('failed repair', valid, descriptor), /model unavailable/);
    assert.equal(f.events.at(-1), 'leave:writer:9b');
    assert.equal(beginParentWork(f.parent).physicalAttempts, 5);
    assert.ok(!f.events.includes('invoke:selected-primary'));
  } finally { f.close(); }
});

test('primary corrections charge separately and cannot accept output after the original deadline', async () => {
  const f = fixture(); try {
    let now = 1000; f.parent.now = () => now;
    const call = createPreparedRoleDispatch({ ...f.options, policy: null }, { ...f.adapters, primary: async <T,>(request: any, validate: (value: T) => string | null) => {
      await f.adapters.primary!(request, validate); const value = await f.adapters.primary!(request, validate);
      now += 120001; return value;
    } });
    await assert.rejects(call('draft', valid, metadata('newsletter-draft', 'newsletter-draft')), /after its original parent deadline/);
    assert.equal(beginParentWork(f.parent).physicalAttempts, 2);
    await assert.rejects(call('retry', valid, metadata('newsletter-draft', 'newsletter-draft')), /original parent deadline/);
    assert.equal(beginParentWork(f.parent).physicalAttempts, 2);
  } finally { f.close(); }
});

test('local child cache and contract identity bind the exact decoder schema while preserving one parent', async () => {
  const f = fixture(); try {
    const schema: JsonOutputSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    const first = withJsonOutputContract(valid, schema), second = withJsonOutputContract(valid, schema, { strict: false });
    const seen: string[] = [];
    const call = createPreparedRoleDispatch(f.options, { ...f.adapters, local: { ...f.adapters.local!, invoke: async (request, validate) => {
      seen.push(jsonOutputContract(validate)!.hash); return f.adapters.local!.invoke!(request, validate);
    } } });
    const descriptor = metadata('source-repair', 'source-repair', 'sports', 'same candidate');
    await call('same complete prompt', first, descriptor); await call('same complete prompt', first, descriptor);
    assert.equal(beginParentWork(f.parent).physicalAttempts, 1);
    await call('same complete prompt', second, descriptor);
    assert.equal(beginParentWork(f.parent).physicalAttempts, 2, 'changed decoding cannot inherit an earlier receipt');
    assert.deepEqual(seen, [jsonOutputContract(first)!.hash, jsonOutputContract(second)!.hash]);
    assert.equal(beginParentWork(f.parent).remainingPhysical, 10);
  } finally { f.close(); }
});

test('the selected local primary can run the current script factual validator without private evaluation or a second model', async () => {
  const f = fixture();
  try {
    const { reviewValidator, SCRIPT_FIRST_EDITORIAL_VERSION } = await import('../pipeline/daily-editorial.js');
    const input = { day: '2026-01-01', brief: 'A structural source review fixture.', stories: [{ id: 'story-1', headline: 'Reported result', primaryUrl: 'https://example.org/result', sources: [{ id: 'source-1', url: 'https://example.org/result', text: 'The final score was two to one.', textSha256: roleHash('source'), rawSha256: roleHash('raw'), capturedAt: '2026-01-01T12:00:00Z', publishedAt: null }] }] };
    const draft = { text: 'The final score was two to one.' };
    const validator = reviewValidator(input, draft, 'script');
    const descriptor = preparedModelTask({ role: 'source-review', capability: 'source-review', taskId: 'daily-editorial-script-review-1', topicIds: ['story-1'], protocol: { version: SCRIPT_FIRST_EDITORIAL_VERSION }, evidence: input, candidate: draft });
    const selected: ModelConfig = { provider: 'ollama', timeoutSeconds: 90, rescue: { enabled: false }, providers: { ollama: { model: 'writer:9b', baseUrl: 'http://127.0.0.1:11434/v1', contextTokens: 8192 } } };
    let value: any = { verdict: 'supported', reviewedStoryIds: ['story-1'], findings: [] };
    const call = createPreparedRoleDispatch({ ...f.options, primary: selected, policy: null }, { ...f.adapters, local: { ...f.adapters.local!, invoke: async (request, validate) => {
      await f.adapters.local!.invoke!(request, validate); return value;
    } } });
    assert.deepEqual(await call('Review the complete script against its own captured sources.', validator, descriptor), value);
    assert.deepEqual(f.events, ['enter:writer:9b', 'invoke:writer:9b', 'leave:writer:9b']);
    assert.equal(beginParentWork(f.parent).physicalAttempts, 1);
    value = { verdict: 'changes-required', reviewedStoryIds: ['story-1'], findings: [{ storyId: 'story-1', kind: 'unsupported', candidateExcerpt: draft.text, evidence: [{ sourceId: 'source-1', quote: 'An invented supporting quote.' }], reason: 'A false rejection.' }] };
    await assert.rejects(call('A second structural review packet.', validator, descriptor), /exact|quote|owned|captured|source/i);
    assert.equal(beginParentWork(f.parent).physicalAttempts, 2, 'invalid reviewer output is charged, never accepted');
    assert.equal(f.events.at(-1), 'leave:writer:9b');
  } finally { f.close(); }
});
