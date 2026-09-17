import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advisorCandidates, advisorHardwareFingerprint, advisorRoleFit, checkAdvisorModel, readModelAdvisor, runAdvisorTool, scanModelAdvisor, type AdvisorRunner } from './model-advisor.js';
import { parseLlmfitReport } from './model-recommend.js';
import { inspectInstalledAlias, validInstalledAliasProof } from './llm/local-model-alias.js';
import { atomicJson } from './workspaces.js';

const report = { system: { cpu_name: 'Fixture CPU', cpu_cores: 8, total_ram_gb: 16, backend: 'Metal', unified_memory: true, gpus: [{ name: 'Fixture GPU', count: 1, vram_gb: 16, backend: 'Metal' }] }, models: [{ name: 'Fixture/Writer-7B', ollama_name: 'writer:7b', installed: true, category: 'General', fit_level: 'Good', effective_context_length: 8192, memory_required_gb: 6, memory_available_gb: 16, estimated_tps: 12, score: 90, score_components: { quality: 80 }, capability_ids: [] }] };
const digest = 'a'.repeat(64);
const metadata = (changedDigest = digest) => (async (url: string | URL | Request) => Response.json(String(url).endsWith('/api/tags') ? { models: [{ name: 'writer:7b', digest: changedDigest, size: 4e9 }, { name: 'remote:cloud', digest }, { name: 'innocent:7b', digest, remote_host: 'https://ollama.com' }] } : String(url).endsWith('/api/show') ? { capabilities: ['completion'], parameters: 'num_ctx 8192' } : { version: '0.12.0' })) as typeof fetch;
const hardware = advisorHardwareFingerprint(parseLlmfitReport(JSON.stringify(report)).system)!;

function officialFixture() {
  const root = mkdtempSync(join(tmpdir(), 'advisor-official-'));
  const manifestText = JSON.stringify({ schemaVersion: 2, config: { digest: 'sha256:' + 'b'.repeat(64) }, layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:' + 'c'.repeat(64), size: 6500000000 }] });
  const installedDigest = createHash('sha256').update(manifestText).digest('hex');
  let quantization = 'Q4_K_M', manifestCalls = 0, offline = false, returnedManifest = manifestText;
  const runner: AdvisorRunner = async (_command, args) => args.includes('--version') ? 'llmfit 1.1.15' : args.includes('plan') ? JSON.stringify({ model_name: 'Qwen/Qwen3.5-9B', context: Number(args[args.indexOf('--context') + 1]), quantization, kv_quant: 'fp16', minimum: { vram_gb: 6.6 }, current: { run_mode: 'Gpu', fit_level: 'Good' } }) : JSON.stringify({ ...report, system: { ...report.system, available_ram_gb: 12 }, models: [{ ...report.models[0], name: 'Qwen/Qwen3.5-9B', ollama_name: null, runtime: 'MLX', best_quant: 'mlx-8bit', effective_context_length: Number(args[args.indexOf('--max-context') + 1]) }] });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://registry.ollama.ai/')) {
      manifestCalls++; assert.equal(url, 'https://registry.ollama.ai/v2/library/qwen3.5/manifests/9b-q4_K_M'); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
      if (offline) throw new Error('Registry offline'); return new Response(returnedManifest);
    }
    return Response.json(url.endsWith('/api/tags') ? { models: [{ name: 'qwen3.5:9b-q4_K_M', digest: installedDigest }] } : url.endsWith('/api/show') ? { capabilities: ['completion', 'thinking'], details: { format: 'gguf', quantization_level: quantization } } : { version: '0.34.0' });
  }) as typeof fetch;
  const deps = { runner, tool: 'fixture-llmfit', fetcher, hardwareFingerprint: hardware };
  return { root, installedDigest, manifestText, deps, scan: () => scanModelAdvisor(root, 'owner', { contextTokens: 16384 }, deps), count: () => manifestCalls,
    setQuantization: (value: string) => { quantization = value; }, setOffline: () => { offline = true; }, setManifest: (value: string) => { returnedManifest = value; }, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('official quantized tag requires exact manifest proof and a separate GGUF context plan; unchanged proof works offline', async () => {
  const f = officialFixture(); try {
    const scan = await f.scan(); assert.equal(scan.candidates[0]!.name, 'qwen3.5:9b-q4_K_M');
    assert.equal(scan.candidates[0]!.fit.level, 'not estimated'); assert.equal(scan.candidates[0]!.fit.memoryGb, null); assert.equal(scan.candidates[0]!.fit.runtime, null);
    const checked = await checkAdvisorModel(f.root, 'owner', { scanId: scan.id, route: 'ollama:qwen3.5:9b-q4_K_M', reasoningEffort: 'none' }, f.deps);
    assert.equal(checked.check!.identity.model, 'qwen3.5:9b-q4_K_M'); assert.equal(checked.check!.identity.digest, f.installedDigest); assert.equal(checked.check!.identity.reasoningEffort, 'none');
    assert.equal(checked.check!.catalogProof!.manifestText, f.manifestText); assert.equal(checked.check!.plan!.memoryGb, 6.6); assert.equal(checked.check!.plan!.contextTokens, 16384);
    assert.equal(advisorRoleFit(f.root, checked.check!.identity, checked.hardware).fitsMemory, true); assert.equal(f.count(), 1);
    f.setOffline(); const again = await checkAdvisorModel(f.root, 'owner', { scanId: scan.id, route: checked.check!.route, reasoningEffort: 'none' }, f.deps);
    assert.equal(f.count(), 1); assert.equal(advisorRoleFit(f.root, again.check!.identity, again.hardware).fitsMemory, true);
    assert.equal(advisorRoleFit(f.root, { ...again.check!.identity, reasoningEffort: undefined }, again.hardware).fitsMemory, false);
    assert.equal(advisorRoleFit(f.root, { ...again.check!.identity, context: { mode: 'requested', tokens: 8192, proof: 'request' } }, again.hardware).fitsMemory, false);
    for (const mutate of [(row: any) => delete row.check.catalogProof, (row: any) => row.check.catalogProof.manifestText += ' ', (row: any) => delete row.candidates[0].catalogMapping]) {
      const row = structuredClone(again); mutate(row); atomicJson(join(f.root, 'state/model-advisor.json'), row);
      assert.equal(advisorRoleFit(f.root, again.check!.identity, again.hardware).fitsMemory, false);
    }
  } finally { f.close(); }
});

test('wrong installed quantization, official digest mismatch and oversized manifest cannot authorize a plan', async () => {
  for (const error of ['quantization', 'digest', 'size']) {
    const f = officialFixture(); try {
      const scan = await f.scan();
      if (error === 'quantization') f.setQuantization('Q8_0');
      if (error === 'digest') f.setManifest(f.manifestText + ' ');
      if (error === 'size') f.setManifest('x'.repeat(65537));
      const checked = await checkAdvisorModel(f.root, 'owner', { scanId: scan.id, route: 'ollama:qwen3.5:9b-q4_K_M', reasoningEffort: 'none' }, f.deps);
      assert.equal(checked.check!.plan, undefined); assert.match(checked.check!.planError!, /quantization|digest|64 KiB/);
      assert.equal(advisorRoleFit(f.root, checked.check!.identity, checked.hardware).fitsMemory, false);
      if (error === 'quantization') assert.equal(f.count(), 0);
    } finally { f.close(); }
  }
});

test('checks inherit only an exact unambiguous saved model mode; explicit default clears rather than inheriting none', async () => {
  const f = officialFixture(); try {
    const scan = await f.scan();
    atomicJson(join(f.root, 'config/model.json'), { provider: 'ollama', providers: { ollama: { model: 'qwen3.5:9b-q4_K_M', reasoningEffort: 'none' } } });
    const request = { scanId: scan.id, route: 'ollama:qwen3.5:9b-q4_K_M' };
    const inherited = await checkAdvisorModel(f.root, 'owner', request, f.deps); assert.equal(inherited.check!.identity.reasoningEffort, 'none');
    const defaulted = await checkAdvisorModel(f.root, 'owner', { ...request, reasoningEffort: 'default' }, f.deps); assert.equal(defaulted.check!.identity.reasoningEffort, undefined);
    atomicJson(join(f.root, 'config/role-routing.json'), { version: 1, enabled: true, roles: { writer: { provider: 'ollama', model: 'qwen3.5:9b-q4_K_M', reasoningEffort: 'high' } } });
    await assert.rejects(checkAdvisorModel(f.root, 'owner', request, f.deps), /different reasoning modes/);
    const explicit = await checkAdvisorModel(f.root, 'owner', { ...request, reasoningEffort: 'none' }, f.deps); assert.equal(explicit.check!.identity.reasoningEffort, 'none');
    atomicJson(join(f.root, 'config/model.json'), { provider: 'ollama', providers: { ollama: { model: 'another:9b', reasoningEffort: 'none' } } });
    atomicJson(join(f.root, 'config/role-routing.json'), { version: 1, enabled: false });
    const unrelated = await checkAdvisorModel(f.root, 'owner', request, f.deps); assert.equal(unrelated.check!.identity.reasoningEffort, undefined);
    await assert.rejects(checkAdvisorModel(f.root, 'owner', { ...request, reasoningEffort: 'invented-mode' }, f.deps), /supported reasoning effort/);
  } finally { f.close(); }
});

test('explicit scan records fit separately, and passive actor-scoped reads launch no work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisor-')); const calls: string[][] = [];
  const runner: AdvisorRunner = async (_command, args) => { calls.push(args); return args.includes('--version') ? 'llmfit 1.1.15\n' : JSON.stringify(report); };
  try {
    assert.equal(readModelAdvisor(root, 'owner'), null); assert.equal(calls.length, 0);
    const saved = await scanModelAdvisor(root, 'owner', { contextTokens: 8192 }, { runner, tool: 'fixture-llmfit', fetcher: metadata() });
    assert.equal(saved.status, 'done'); assert.equal(saved.candidates.length, 1); assert.equal(saved.candidates[0].fit.level, 'Good'); assert.equal(saved.check, undefined);
    assert.deepEqual(calls[1], ['--no-dashboard', '--max-context', '8192', 'fit', '--json', '--sort', 'score', '--limit', '2000']);
    for (let n = 0; n < 5; n++) assert.equal(readModelAdvisor(root, 'owner')!.id, saved.id);
    assert.equal(calls.length, 2); assert.equal(readModelAdvisor(root, 'another-actor'), null);
    assert.ok(!JSON.stringify(saved).includes('passed')); assert.equal(saved.hardwareFingerprint, hardware);
    const checked = await checkAdvisorModel(root, 'owner', { scanId: saved.id, route: 'ollama:writer:7b' }, { fetcher: metadata(), hardwareFingerprint: hardware });
    assert.equal(checked.check!.identity.context.tokens, 8192); assert.match(checked.check!.message, /quality has not been established/);
    const before = readFileSync(join(root, 'state/model-advisor.json'), 'utf8');
    await assert.rejects(checkAdvisorModel(root, 'owner', { scanId: saved.id, route: 'ollama:writer:7b' }, { fetcher: metadata('b'.repeat(64)), hardwareFingerprint: hardware }), /changed after the scan/);
    assert.equal(readFileSync(join(root, 'state/model-advisor.json'), 'utf8'), before);
    await assert.rejects(checkAdvisorModel(root, 'another-actor', { scanId: saved.id, route: 'ollama:writer:7b' }), /Scan this computer/);
    await assert.rejects(checkAdvisorModel(root, 'owner', { scanId: saved.id, route: 'opencode:opencode/example-free' }), /installed writer/);
    await assert.rejects(checkAdvisorModel(root, 'owner', { scanId: saved.id, route: 'ollama:writer:7b' }, { hardwareFingerprint: 'b'.repeat(64) }), /Hardware identity/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing analyzer keeps installed choices unestimated; failed scan preserves a clear receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisor-missing-'));
  try {
    const saved = await scanModelAdvisor(root, 'owner', {}, { tool: null, fetcher: metadata() });
    assert.equal(saved.hardwareFingerprint, null); assert.equal(saved.candidates[0].fit.level, 'not estimated');
    assert.match(saved.analyzer, /not installed/);
    await assert.rejects(scanModelAdvisor(root, 'owner', {}, { tool: null, fetcher: (async () => new Response('{}', { status: 503 })) as typeof fetch }), /Start Ollama/);
    assert.equal(readModelAdvisor(root, 'owner')!.status, 'failed'); assert.ok(readModelAdvisor(root, 'owner')!.error);
    await assert.rejects(scanModelAdvisor(root, 'owner', { contextTokens: 9999 }, { tool: null }), /context estimate/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changed context or catalog tags never borrow another model fit', () => {
  const parsed = parseLlmfitReport(JSON.stringify(report));
  const installed = [{ name: 'writer:7b', digest, sizeGb: 4, modifiedAt: null }, { name: 'writer-custom:7b', digest, sizeGb: 4, modifiedAt: null }];
  assert.equal(advisorCandidates(parsed, installed, 8192)[1].fit.level, 'not estimated');
  assert.ok(advisorCandidates(parsed, installed, 16384).every(row => row.fit.contextTokens === null));
});


test('analyzer process has no inherited secrets or home configuration and is bounded', async () => {
  const key = 'HARNESS_ADVISOR_FIXTURE_SECRET', prior = process.env[key]; process.env[key] = 'must-not-leak';
  try {
    const value = JSON.parse(await runAdvisorTool(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({secret:process.env.HARNESS_ADVISOR_FIXTURE_SECRET,home:require("node:fs").realpathSync(process.env.HOME),cwd:process.cwd(),ollama:process.env.OLLAMA_HOST}))'], 5000));
    assert.equal(value.secret, undefined); assert.equal(value.home, value.cwd); assert.match(value.home, /harness-model-advisor-/);
    assert.equal(value.ollama, 'http://127.0.0.1:11434');
    const { existsSync } = await import('node:fs'); assert.equal(existsSync(value.home), false);
    await assert.rejects(runAdvisorTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 40), /time limit/);
    await assert.rejects(runAdvisorTool(process.execPath, ['-e', 'process.stdout.write("x".repeat(9*1024*1024));setInterval(()=>{},1000)'], 5000), /8 MiB/);
    await assert.rejects(runAdvisorTool(process.execPath, ['-e', 'process.stderr.write("fixture failure");process.exit(3)'], 5000), /exited 3: fixture failure/);
  } finally { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; }
});

test('scan age and malformed dates cannot authorize a later model choice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisor-age-'));
  try {
    const saved = await scanModelAdvisor(root, 'owner', {}, { tool: null, fetcher: metadata() });
    for (const finishedAt of ['not-a-date', new Date(Date.now()-31*60*1000).toISOString(), new Date(Date.now()+60000).toISOString()]) {
      writeFileSync(join(root, 'state/model-advisor.json'), JSON.stringify({ ...saved, finishedAt }));
      await assert.rejects(checkAdvisorModel(root, 'owner', { scanId: saved.id, route: 'ollama:writer:7b' }), /30 minutes/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('only a fresh exact GGUF quantization/context plan authorizes a local role', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisor-role-fit-'));
  const calls: string[][] = [];
  const measured = { ...report, system: { ...report.system, available_ram_gb: 10 } };
  const runner: AdvisorRunner = async (_command, args) => { calls.push(args); return args.includes('--version') ? 'llmfit 1.1.15' : args.includes('plan') ? JSON.stringify({ model_name: 'Fixture/Writer-7B', context: 8192, quantization: 'Q4_K_M', kv_quant: 'fp16', minimum: { vram_gb: 6 }, current: { run_mode: 'Gpu', fit_level: 'Good' } }) : JSON.stringify(measured); };
  const fetcher = (async (url: string | URL | Request) => String(url).endsWith('/api/show') ? Response.json({ capabilities: ['completion'], parameters: 'num_ctx 8192', details: { format: 'gguf', quantization_level: 'Q4_K_M' } }) : metadata()(url)) as typeof fetch;
  try {
    const scan = await scanModelAdvisor(root, 'owner', {}, { runner, tool: 'fixture', fetcher });
    const checked = await checkAdvisorModel(root, 'owner', { scanId: scan.id, route: 'ollama:writer:7b' }, { runner, tool: 'fixture', fetcher, hardwareFingerprint: hardware });
    const identity = checked.check!.identity, good = readFileSync(join(root, 'state/model-advisor.json'), 'utf8');
    assert.equal(advisorRoleFit(root, identity).fitsMemory, true);
    assert.equal(advisorRoleFit(root, identity, { ...checked.hardware!, availableRamGb: 1 }).fitsMemory, false, 'same hardware with less current memory must refuse weight loading');
    assert.deepEqual(calls.at(-1), ['--no-dashboard', 'plan', 'Fixture/Writer-7B', '--context', '8192', '--quant', 'Q4_K_M', '--kv-quant', 'fp16', '--json']);
    for (const mutate of [
      (row: any) => delete row.check.plan,
      (row: any) => row.check.plan.quantization = 'mlx-4bit',
      (row: any) => row.check.plan.contextTokens = 16384,
      (row: any) => row.check.plan.availableGb = 6,
      (row: any) => row.check.plan.checkedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      (row: any) => row.finishedAt = 'future',
      (row: any) => row.check.plan.checkedAt = new Date(Date.now()+10000).toISOString(),
      (row: any) => row.candidates[0].digest = 'b'.repeat(64),
    ]) { const row = JSON.parse(good); mutate(row); writeFileSync(join(root, 'state/model-advisor.json'), JSON.stringify(row)); assert.equal(advisorRoleFit(root, identity).fitsMemory, false); }
    writeFileSync(join(root, 'state/model-advisor.json'), good);
    assert.equal(advisorRoleFit(root, { ...identity, quantization: 'Q8_0' }).fitsMemory, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('research and writer plans survive other model and context checks without sharing identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisor-many-'));
  const reportFor = (context: number) => ({ ...report, system: { ...report.system, available_ram_gb: 12 }, models: ['writer:7b', 'research:4b'].map(name => ({ ...report.models[0], name: 'Fixture/' + name, ollama_name: name, effective_context_length: context })) });
  const runner: AdvisorRunner = async (_command, args) => args.includes('--version') ? 'llmfit 1.1.15' : args.includes('plan') ? JSON.stringify({ model_name: args[args.indexOf('plan')+1], context: Number(args[args.indexOf('--context')+1]), quantization: 'Q4_K_M', kv_quant: 'fp16', minimum: { vram_gb: 5 }, current: { run_mode: 'Gpu', fit_level: 'Good' } }) : JSON.stringify(reportFor(Number(args[args.indexOf('--max-context')+1])));
  const fetcher = (async (url: string | URL | Request) => Response.json(String(url).endsWith('/api/tags') ? { models: [{ name: 'writer:7b', digest }, { name: 'research:4b', digest: 'b'.repeat(64) }] } : String(url).endsWith('/api/show') ? { capabilities: ['completion'], details: { format: 'gguf', quantization_level: 'Q4_K_M' } } : { version: '0.12.0' })) as typeof fetch;
  try {
    const scan = await scanModelAdvisor(root, 'owner', {}, { runner, tool: 'fixture', fetcher });
    const first = await checkAdvisorModel(root, 'owner', { scanId: scan.id, route: 'ollama:writer:7b' }, { runner, tool: 'fixture', fetcher, hardwareFingerprint: hardware });
    const second = await checkAdvisorModel(root, 'owner', { scanId: scan.id, route: 'ollama:research:4b' }, { runner, tool: 'fixture', fetcher, hardwareFingerprint: hardware });
    assert.equal(advisorRoleFit(root, first.check!.identity, first.hardware).fitsMemory, true);
    assert.equal(advisorRoleFit(root, second.check!.identity, second.hardware).fitsMemory, true);
    const scan16 = await scanModelAdvisor(root, 'owner', { contextTokens: 16384 }, { runner, tool: 'fixture', fetcher });
    const third = await checkAdvisorModel(root, 'owner', { scanId: scan16.id, route: 'ollama:writer:7b' }, { runner, tool: 'fixture', fetcher, hardwareFingerprint: hardware });
    assert.equal(third.check!.identity.context.tokens, 16384);
    for (const row of [first, second, third]) assert.equal(advisorRoleFit(root, row.check!.identity, row.hardware).fitsMemory, true);
    assert.equal(advisorRoleFit(root, { ...first.check!.identity, digest: 'c'.repeat(64) }, first.hardware).fitsMemory, false);
    assert.equal(Object.keys(JSON.parse(readFileSync(join(root, 'state/model-advisor-checks.json'), 'utf8'))).length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function aliasFixture(changedLayer?: string) {
  const root = mkdtempSync(join(tmpdir(), 'advisor-alias-')), modelRoot = join(root, 'models');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const baseName = 'qwen3.5:4b', aliasName = 'qwen3.5-test-16k:4b';
  const config = { model_format: 'gguf', model_family: 'qwen35', model_type: '4.7B', file_type: 'Q4_K_M', renderer: 'qwen3.5', parser: 'qwen3.5' };
  const layer = (kind: string, id: string) => ({ mediaType: 'application/vnd.ollama.image.' + kind, digest: 'sha256:' + id.repeat(64), size: 100 });
  const make = (name: string, alias: boolean) => {
    const configText = JSON.stringify({ ...config, ...(!alias ? { rootfs: { type: 'layers', diff_ids: [] } } : {}) });
    const layers = [layer('model', 'a'), layer('projector', 'b'), layer('template', 'c'), layer('params', alias ? 'e' : 'd')];
    if (alias && changedLayer) layers.find(row => row.mediaType.endsWith('.' + changedLayer))!.digest = 'sha256:' + 'f'.repeat(64);
    const manifestText = JSON.stringify({ schemaVersion: 2, config: { digest: 'sha256:' + hash(configText), size: Buffer.byteLength(configText) }, layers });
    const [model, tag] = name.split(':');
    mkdirSync(join(modelRoot, 'manifests/registry.ollama.ai/library', model!), { recursive: true }); mkdirSync(join(modelRoot, 'blobs'), { recursive: true });
    writeFileSync(join(modelRoot, 'manifests/registry.ollama.ai/library', model!, tag!), manifestText);
    writeFileSync(join(modelRoot, 'blobs', 'sha256-' + hash(configText)), configText);
    return { manifestText, digest: hash(manifestText) };
  };
  const base = make(baseName, false), alias = make(aliasName, true);
  const runner: AdvisorRunner = async (_command, args) => args.includes('--version') ? 'llmfit 1.1.15' : args.includes('plan') ? JSON.stringify({ model_name: 'Qwen/Qwen3.5-4B', context: Number(args[args.indexOf('--context') + 1]), quantization: 'Q4_K_M', kv_quant: 'fp16', minimum: { vram_gb: 4.2 }, current: { run_mode: 'Gpu', fit_level: 'Good' } }) : JSON.stringify({ ...report, system: { ...report.system, available_ram_gb: 8 }, models: [{ ...report.models[0], name: 'Qwen/Qwen3.5-4B', ollama_name: null, effective_context_length: 16384 }] });
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://')) { assert.equal(url, 'https://registry.ollama.ai/v2/library/qwen3.5/manifests/4b'); return new Response(base.manifestText); }
    return Response.json(url.endsWith('/api/tags') ? { models: [{ name: baseName, digest: base.digest }, { name: aliasName, digest: alias.digest }] } : url.endsWith('/api/show') ? { capabilities: ['completion', 'vision'], parameters: 'num_ctx 16384', details: { format: 'gguf', quantization_level: 'Q4_K_M' } } : { version: '0.34.0' });
  }) as typeof fetch;
  const deps = { runner, tool: 'fixture-llmfit', fetcher, hardwareFingerprint: hardware, modelRoot, openCodeVersion: '1.18.25' };
  return { root, modelRoot, baseName, aliasName, base, alias, deps, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('parameter-only local aliases retain exact weights/projector/template and require official base proof for each local route', async () => {
  for (const provider of ['ollama', 'opencode']) {
    const f = aliasFixture(); try {
      const scan = await scanModelAdvisor(f.root, 'owner', { contextTokens: 16384 }, f.deps);
      assert.equal(scan.candidates.find(row => row.name === f.aliasName)!.fit.catalogModel, null);
      const route = provider === 'ollama' ? 'ollama:' + f.aliasName : 'opencode:ollama/' + f.aliasName;
      const checked = await checkAdvisorModel(f.root, 'owner', { scanId: scan.id, route, reasoningEffort: 'none' }, f.deps);
      assert.equal(checked.check!.planError, undefined); assert.equal(checked.check!.plan!.model, 'Qwen/Qwen3.5-4B');
      assert.equal(checked.check!.identity.digest, f.alias.digest); assert.equal(checked.check!.identity.context.tokens, 16384);
      assert.equal(checked.check!.catalogProof!.digest, f.base.digest); assert.equal(checked.check!.aliasProof!.baseName, f.baseName);
      assert.equal(advisorRoleFit(f.root, checked.check!.identity, checked.hardware).fitsMemory, true);
      assert.ok(inspectInstalledAlias(checked.check!.identity, [{ name: f.baseName, digest: f.base.digest }], f.modelRoot));
      for (const mutate of [(row: any) => delete row.check.aliasProof, (row: any) => row.check.aliasProof.baseName = 'other:4b', (row: any) => row.check.aliasProof.manifestText += ' ', (row: any) => row.check.aliasProof.configText += ' ', (row: any) => delete row.check.catalogProof]) {
        const row = structuredClone(checked); mutate(row); atomicJson(join(f.root, 'state/model-advisor.json'), row);
        assert.equal(advisorRoleFit(f.root, checked.check!.identity, checked.hardware).fitsMemory, false);
      }
      assert.equal(validInstalledAliasProof(checked.check!.aliasProof, { ...checked.check!.identity, quantization: 'Q8_0' }), false);
      assert.equal(validInstalledAliasProof(checked.check!.aliasProof, { ...checked.check!.identity, model: 'wrong:4b' }), false);
    } finally { f.close(); }
  }
});

test('changed weight, projector or prompt-template layers cannot borrow an official memory plan', async () => {
  for (const layer of ['model', 'projector', 'template']) {
    const f = aliasFixture(layer); try {
      const scan = await scanModelAdvisor(f.root, 'owner', { contextTokens: 16384 }, f.deps);
      const checked = await checkAdvisorModel(f.root, 'owner', { scanId: scan.id, route: 'ollama:' + f.aliasName, reasoningEffort: 'none' }, f.deps);
      assert.equal(checked.check!.plan, undefined); assert.match(checked.check!.planError!, /no verified identical/);
      assert.equal(advisorRoleFit(f.root, checked.check!.identity, checked.hardware).fitsMemory, false);
    } finally { f.close(); }
  }
});
