import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_ROOT, createWorkspace } from '../workspaces.js';
import { countInstalledLocalTokens } from './local-token-count.js';
import type { ModelIdentity } from './model-identity.js';
import type { ModelAttempt, ModelConfig } from './model.js';
import type { ParentWorkScope, RoleAdapters } from './role-router.js';

// Real production modelJson is exercised against a replaced fetch only. Its usage receipts
// belong to a disposable workspace, never the operator's selected workspace.
const identityDir = mkdtempSync(join(tmpdir(), 'prepared-vision-identity-'));
const prior = { HARNESS_WORKSPACE: process.env.HARNESS_WORKSPACE, HARNESS_IDENTITY_FILE: process.env.HARNESS_IDENTITY_FILE, HARNESS_TOKEN: process.env.HARNESS_TOKEN };
delete process.env.HARNESS_WORKSPACE; delete process.env.HARNESS_TOKEN;
process.env.HARNESS_IDENTITY_FILE = join(identityDir, 'identity.json');
const slug = `prepared-vision-${process.pid}`, workspace = createWorkspace(slug, false, CODE_ROOT);
process.env.HARNESS_WORKSPACE = slug;
const { createPreparedVisionDispatch } = await import('./prepared-role-dispatch.js');
const { beginParentWork, roleHash } = await import('./role-router.js');
const { preparedModelTask } = await import('../pipeline/writing-task.js');
after(() => {
  rmSync(workspace, { recursive: true, force: true }); rmSync(identityDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
const primary: ModelConfig = { provider: 'openai-compatible', timeoutSeconds: 5, rescue: { enabled: true }, providers: { openaiCompatible: { model: 'chosen-vision', baseUrl: 'https://vision.example/v1' } } };
const metadata = preparedModelTask({ role: 'source-review', capability: 'source-review', taskId: 'diagram-phone-review', topicIds: ['topic-1'], protocol: 1, evidence: ['The source reports simulated flight.'], candidate: 'Exact figure labels.' });
const valid = (value: { passed: boolean }) => value?.passed === true ? null : 'Return passed:true for this injected structural fixture';
const attempt: ModelAttempt = { provider: 'openai-compatible', model: 'chosen-vision', baseUrl: 'https://vision.example/v1', attempt: 1, rescue: false, promptBytes: 100 };
// A 1x1 PNG with intact chunk CRCs. Production image admission decodes the file, so the
// earlier fixture bytes (bad IDAT checksum) could never earn an image reserve.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
// Local image context is only admitted for the verified installed local route, measured by the
// bundled tokenizer. Detect that exact component: installed manifest + tokenizer helper. This
// reads local files only; no Ollama or OpenCode server is contacted anywhere in this file.
const localModel = 'qwen3.5-harness-16k:4b';
const localManifest = join(process.env.OLLAMA_MODELS ?? join(homedir(), '.ollama/models'), 'manifests/registry.ollama.ai/library', ...localModel.split(':'));
const localDigest = existsSync(localManifest) ? createHash('sha256').update(readFileSync(localManifest)).digest('hex') : null;
const localRuntimeVersion = (provider: string) => provider === 'ollama' ? '0.34.0' : 'OpenCode 1.18.25; Ollama 0.34.0';
const localIdentity = (provider: string, model: string, baseUrl: string, reasoningEffort?: string): ModelIdentity => ({
  provider, model, baseUrl, digest: localDigest ?? 'a'.repeat(64), format: 'gguf',
  context: { mode: provider === 'ollama' ? 'requested' : 'installed-model-default', tokens: 8192, proof: provider === 'ollama' ? 'request' : 'model-parameter' },
  reasoningEffort, hardwareFingerprint: 'b'.repeat(64), runtimeVersion: localRuntimeVersion(provider), protocolVersion: 1,
});
const missingLocalImageReserve = (() => {
  if (!localDigest) return `installed Ollama model ${localModel} (no manifest under ~/.ollama/models)`;
  const dir = mkdtempSync(join(tmpdir(), 'prepared-vision-probe-'));
  try {
    const probe = join(dir, 'pixel.png'); writeFileSync(probe, png);
    const measured = countInstalledLocalTokens('Probe.', localIdentity('ollama', localModel, 'http://127.0.0.1:11434/v1', 'none'), { images: [probe] });
    return measured.count?.method === 'installed-gguf-qwen35-text' ? null : measured.unavailable ?? 'a verified local image reserve';
  } finally { rmSync(dir, { recursive: true, force: true }); }
})();
function localFixtureAdapters(events: string[], capable = true): RoleAdapters {
  return {
    inspect: async runtime => ({ fitsMemory: true, identity: {
      ...localIdentity(runtime.provider, runtime.model!, runtime.baseUrl!, runtime.reasoningEffort),
    } }),
    canReadImages: async () => capable,
    enter: async () => { events.push('enter'); }, leave: async () => { events.push('leave'); },
    invoke: async request => {
      events.push('invoke'); assert.ok(request.images?.length); assert.equal(request.config.rescue?.enabled, false);
      const provider = request.config.provider, model = provider === 'ollama' ? request.config.providers.ollama!.model : request.config.providers.opencode!.model;
      request.hooks.beforeAttempt!({ provider, model, baseUrl: 'http://127.0.0.1:11434/v1', attempt: 1, rescue: false, promptBytes: Buffer.byteLength(request.prompt) });
      return { passed: true } as any;
    },
  };
}
function fixture(maxPhysicalCalls = 4) {
  const root = mkdtempSync(join(tmpdir(), 'prepared-vision-parent-')), image = join(root, 'figure.png');
  const bytes = png;
  writeFileSync(image, bytes);
  const parent: ParentWorkScope = { root, parentId: 'edition-1', parentIdentity: roleHash('unchanged request'), limits: { totalSeconds: 120, maxPhysicalCalls, maxToolCalls: 0 } };
  return { root, image, bytes, parent, options: { root, parent, primary, policy: null, env: {}, briefHash: roleHash('source briefing') }, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('actual production vision transport charges both schema attempts to one parent and sends exact selected image bytes', async () => {
  const f = fixture(), originalFetch = globalThis.fetch, requests: any[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://vision.example/v1/chat/completions'); assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal); const request = JSON.parse(String(init?.body)); requests.push(request);
      assert.equal(request.model, 'chosen-vision');
      assert.equal(request.messages[0].content[1].image_url.url, `data:image/png;base64,${f.bytes.toString('base64')}`);
      assert.equal(beginParentWork(f.parent).physicalAttempts, requests.length, 'reserve before physical HTTP');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: requests.length === 2 }) } }] }), { status: 200 });
    };
    assert.deepEqual(await createPreparedVisionDispatch(f.options)('Check the complete figure.', [f.image], valid, metadata), { passed: true });
    assert.equal(requests.length, 2); assert.equal(beginParentWork(f.parent).physicalAttempts, 2);
    assert.equal(beginParentWork(f.parent).toolAttempts, 0);
    assert.match(requests[1].messages[0].content[0].text, /Validation error:/);
    assert.ok(requests[1].messages[0].content[0].text.startsWith('Check the complete figure.'));
    assert.ok(!requests[1].messages[0].content[0].text.includes('Previous invalid response'));
    const receipts = readFileSync(join(workspace, 'state/model-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(receipts.slice(-2).every(row => row.provider === 'openai-compatible' && row.model === 'chosen-vision'));
  } finally { globalThis.fetch = originalFetch; f.close(); }
});

test('changed image bytes before a corrective attempt stop before another reservation or network call', async () => {
  const f = fixture(), originalFetch = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; writeFileSync(f.image, Buffer.concat([f.bytes, Buffer.from('changed')])); return new Response(JSON.stringify({ choices: [{ message: { content: '{"passed":false}' } }] })); };
    await assert.rejects(createPreparedVisionDispatch(f.options)('Check figure.', [f.image], valid, metadata), /image changed before its model attempt/);
    assert.equal(calls, 1); assert.equal(beginParentWork(f.parent).physicalAttempts, 1);
  } finally { globalThis.fetch = originalFetch; f.close(); }
});

test('caller mutation cannot drop an image from a retry under the original complete-image identity', async () => {
  const f = fixture(), originalFetch = globalThis.fetch, second = join(f.root, 'second.png');
  writeFileSync(second, Buffer.concat([f.bytes, Buffer.from('second image bytes')]));
  const images = [f.image, second]; let calls = 0;
  try {
    globalThis.fetch = async (_url, init) => {
      calls++; const parts = JSON.parse(String(init?.body)).messages[0].content;
      assert.equal(parts.filter((part: any) => part.type === 'image_url').length, 2, 'the complete original image sequence is immutable');
      if (calls === 1) images.pop();
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ passed: calls === 2 }) } }] }));
    };
    await createPreparedVisionDispatch(f.options)('Inspect both images.', images, valid, metadata);
    assert.equal(calls, 2); assert.equal(beginParentWork(f.parent).physicalAttempts, 2);
  } finally { globalThis.fetch = originalFetch; f.close(); }
});

test('vision schema correction cannot refill an exhausted parent physical allowance', async () => {
  const f = fixture(1), originalFetch = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"passed":false}' } }] })); };
    const call = createPreparedVisionDispatch(f.options);
    await assert.rejects(call('Check figure.', [f.image], valid, metadata), /physical attempt allowance/);
    await assert.rejects(call('Retry same figure.', [f.image], valid, metadata), /physical attempt allowance/);
    assert.equal(calls, 1); assert.equal(beginParentWork(f.parent).physicalAttempts, 1);
  } finally { globalThis.fetch = originalFetch; f.close(); }
});

test('text-only local or explicit secondary critic routes cannot silently use the selected cloud vision provider', async () => {
  const f = fixture(); let calls = 0;
  const adapters = { hostRoot: f.root, local: localFixtureAdapters([], false), primary: async <T>() => { calls++; return { passed: true } as T; } };
  try {
    for (const model of [
      { provider: 'ollama', providers: { ollama: { model: 'local:4b', baseUrl: 'http://127.0.0.1:11434/v1', contextTokens: 8192 } } },
      { provider: 'opencode', providers: { opencode: { model: 'ollama/local:4b' } } },
    ] as ModelConfig[]) await assert.rejects(createPreparedVisionDispatch({ ...f.options, primary: model }, adapters)('Inspect.', [f.image], valid, metadata), /does not advertise image review/);
    await assert.rejects(createPreparedVisionDispatch({ ...f.options, policy: { version: 1, enabled: true, limits: f.parent.limits, roles: { critic: { provider: 'ollama', model: 'local:4b', contextTokens: 8192 } } } }, adapters)('Inspect.', [f.image], valid, metadata), /no measured image-review route/);
    const policy = { version: 1 as const, enabled: true as const, limits: f.parent.limits, roles: { critic: { provider: 'ollama' as const, model: 'local:4b', contextTokens: 8192 } } };
    const locked = createPreparedVisionDispatch({ ...f.options, policy }, adapters);
    delete (policy.roles as { critic?: unknown }).critic;
    await assert.rejects(locked('Inspect after caller policy mutation.', [f.image], valid, metadata), /no measured image-review route/);
    assert.equal(calls, 0); assert.equal(beginParentWork(f.parent).physicalAttempts, 0);
  } finally { f.close(); }
});

test('vision rejects absent metadata wrong roles oversized packets and changed parent limits before transport', async () => {
  const f = fixture(); let calls = 0;
  try {
    const adapters = { primary: async <T>() => { calls++; return { passed: true } as T; } }, call = createPreparedVisionDispatch(f.options, adapters);
    await assert.rejects(call('Inspect.', [f.image], valid), /explicit task metadata/);
    await assert.rejects(call('Inspect.', [f.image], valid, { ...metadata, role: 'script', capability: 'script-draft' }), /explicit source-review/);
    await assert.rejects(call('x'.repeat(24001), [f.image], valid, metadata), /complete bounded source context/);
    await assert.rejects(call('Inspect.', Array(7).fill(f.image), valid, metadata), /one to six/);
    writeFileSync(f.image, Buffer.alloc(10 * 1024 * 1024 + 1));
    await assert.rejects(call('Inspect.', [f.image], valid, metadata), /bounded file size/);
    assert.throws(() => createPreparedVisionDispatch({ ...f.options, policy: { version: 1, enabled: true, limits: { ...f.parent.limits, maxPhysicalCalls: 8 } } }, adapters), /original parent allowance/);
    assert.equal(calls, 0); assert.equal(beginParentWork(f.parent).physicalAttempts, 0);
  } finally { f.close(); }
});

test('unselected provider or rescue and a transport without hooks cannot acquire vision acceptance', async () => {
  const f = fixture();
  try {
    for (const changed of [{ ...attempt, model: 'another-model' }, { ...attempt, rescue: true }, { ...attempt, baseUrl: 'https://another.example/v1' }, { ...attempt, region: 'unselected-region' }]) {
      const call = createPreparedVisionDispatch(f.options, { primary: async <T>(request: any) => { request.hooks.beforeAttempt(changed); return { passed: true } as T; } });
      await assert.rejects(call('Inspect.', [f.image], valid, metadata), /unselected provider or model/);
    }
    const noHook = createPreparedVisionDispatch(f.options, { primary: async <T>() => ({ passed: true }) as T });
    await assert.rejects(noHook('Inspect.', [f.image], valid, metadata), /without reserving an actual attempt/);
    assert.equal(beginParentWork(f.parent).physicalAttempts, 0);
  } finally { f.close(); }
});

test('approved-script final media packets have scoped bounds and check the physical schema and every correction before reservation', async () => {
  const f = fixture(), originalFetch = globalThis.fetch; let calls = 0;
  const finalTask = { ...metadata, role: 'media-review' as const, capability: 'frame-alignment' as const, taskId: 'final-media-review' };
  try {
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"passed":true}' } }] })); };
    const call = createPreparedVisionDispatch(f.options);
    await assert.rejects(call('x'.repeat(25000), [f.image], valid, metadata, { maxPromptBytes: 131072 }), /only available/);
    await assert.rejects(call('Inspect.', [f.image], valid, finalTask, { maxPromptBytes: 131073 }), /only available/);
    assert.deepEqual(await call('x'.repeat(25000), [f.image], valid, finalTask, { maxPromptBytes: 131072 }), { passed: true });
    assert.equal(calls, 1);
    const physical = createPreparedVisionDispatch(f.options, { primary: async <T>(request: any) => {
      request.hooks.beforeAttempt({ ...attempt, promptBytes: 23000, outputMode: 'json-schema', outputSchemaBytes: 1500 });
      throw new Error('Must stop before transport');
    } });
    await assert.rejects(physical('Small caller prompt.', [f.image], valid, metadata), /physical prompt\/schema exceeds/);
    assert.equal(beginParentWork(f.parent).physicalAttempts, 1);
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"passed":false}' } }] })); };
    await assert.rejects(call('x'.repeat(23950), [f.image], valid, metadata), /physical prompt\/schema exceeds/);
    assert.equal(calls, 2, 'correction is held before a second HTTP call');
    assert.equal(beginParentWork(f.parent).physicalAttempts, 2);
  } finally { globalThis.fetch = originalFetch; f.close(); }
});

test('configured context and Bedrock image capability cannot be bypassed by larger final-media bounds', async () => {
  const f = fixture(); let calls = 0;
  try {
    const adapters = { primary: async <T>(request: any) => {
      calls++; request.hooks.beforeAttempt({ ...attempt, provider: 'ollama', promptBytes: 3900, outputSchemaBytes: 250, outputMode: 'json-schema' }); return { passed: true } as T;
    } };
    const small: ModelConfig = { ...primary, provider: 'ollama', providers: { ollama: { ...primary.providers.openaiCompatible!, contextTokens: 8192 } } };
    await assert.rejects(createPreparedVisionDispatch({ ...f.options, primary: small }, adapters)('A bounded source.', [f.image], valid, { ...metadata, role: 'media-review', capability: 'frame-alignment', taskId: 'final-media-review' }, { maxPromptBytes: 131072 }), /physical prompt\/schema and output reserve/);
    assert.equal(beginParentWork(f.parent).physicalAttempts, 0);
    const bedrock: ModelConfig = { provider: 'bedrock', providers: { bedrock: { model: 'selected-model', region: 'us-east-1', supportsImages: false } } };
    await assert.rejects(createPreparedVisionDispatch({ ...f.options, primary: bedrock }, adapters)('Inspect.', [f.image], valid, metadata), /no configured image capability/);
    assert.equal(calls, 1, 'Bedrock capability hold occurs before the transport');
    assert.equal(beginParentWork(f.parent).physicalAttempts, 0);
  } finally { f.close(); }
});

test('vision uses the original deadline for both late results and subsequent attempts', async () => {
  const f = fixture(); let now = Date.now(), calls = 0; f.parent.now = () => now;
  try {
    const deadline = beginParentWork(f.parent).deadline;
    const call = createPreparedVisionDispatch(f.options, { primary: async <T>(request: any) => {
      calls++; assert.equal(request.deadline, deadline); assert.equal(request.config.rescue.enabled, false);
      request.hooks.beforeAttempt(attempt); now = deadline + 1; return { passed: true } as T;
    } });
    await assert.rejects(call('Inspect.', [f.image], valid, metadata), /after its original parent deadline/);
    await assert.rejects(call('Retry.', [f.image], valid, metadata), /original parent deadline/);
    assert.equal(calls, 1); assert.equal(beginParentWork(f.parent).physicalAttempts, 1);
  } finally { f.close(); }
});

test('selected local vision uses the ordinary measured lifecycle, original budget and unchanged image bytes', async t => {
  // Production admits local image context only against the installed tokenizer's verified image
  // reserve, so this lifecycle cannot be measured without that component actually installed.
  if (missingLocalImageReserve) return t.skip(`Local image context needs a verified image reserve from the installed local tokenizer: ${missingLocalImageReserve}`);
  for (const provider of ['ollama', 'opencode'] as const) {
    const f = fixture(), events: string[] = [];
    const settings: ModelConfig = { provider, timeoutSeconds: 90, rescue: { enabled: false }, providers: {
      ollama: { model: localModel, baseUrl: 'http://127.0.0.1:11434/v1', contextTokens: 8192, reasoningEffort: 'none' }, opencode: { model: 'ollama/' + localModel },
    } };
    try {
      const local = localFixtureAdapters(events);
      const call = createPreparedVisionDispatch({ ...f.options, primary: settings }, { hostRoot: f.root, local });
      assert.deepEqual(await call('Inspect this selected photo against the approved script.', [f.image], valid, metadata), { passed: true });
      assert.deepEqual(events, ['enter', 'invoke', 'leave']);
      assert.equal(beginParentWork(f.parent).physicalAttempts, 1);
      await call('Inspect this selected photo against the approved script.', [f.image], valid, metadata);
      assert.equal(beginParentWork(f.parent).physicalAttempts, 1, 'unchanged image review can reuse its own validated receipt');
      const changed = createPreparedVisionDispatch({ ...f.options, primary: settings }, { hostRoot: f.root, local: { ...local, invoke: async request => {
        writeFileSync(f.image, Buffer.concat([f.bytes, Buffer.from('changed')])); return local.invoke!(request, valid) as any;
      } } });
      await assert.rejects(changed('A new task with a changed frame.', [f.image], valid, metadata), /image changed before its model attempt/);
      assert.equal(beginParentWork(f.parent).physicalAttempts, 1, 'changed frame is rejected before reservation');
      assert.equal(events.at(-1), 'leave');
      writeFileSync(f.image, f.bytes);
      const wrong = createPreparedVisionDispatch({ ...f.options, primary: settings }, { hostRoot: f.root, local: { ...local, invoke: async request => {
        request.hooks.beforeAttempt!({ ...attempt, provider, model: 'wrong-model', baseUrl: 'http://127.0.0.1:11434/v1' }); return { passed: true } as any;
      } } });
      await assert.rejects(wrong('No model substitution.', [f.image], valid, metadata), /different runtime/);
      assert.equal(beginParentWork(f.parent).physicalAttempts, 1);
      // 8 KiB of separated tokens: over the measured allowance left by the output, envelope and image reserves.
      await assert.rejects(call('x '.repeat(4096), [f.image], valid, metadata), /context allowance/);
      assert.equal(beginParentWork(f.parent).physicalAttempts, 1);
    } finally { f.close(); }
  }
});
