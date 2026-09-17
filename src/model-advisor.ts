import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { arch, cpus, platform, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { CODE_ROOT, atomicJson, contained, read } from './workspaces.js';
import { releaseLock } from './release-lock.js';
import { roleQualificationStatus, EVIDENCE_SOURCE_CONTRACT, EVIDENCE_SELECTION_CONTRACT } from './llm/role-state.js';
import { parseLlmfitReport, canonicalOllamaName, officialOllamaCatalogMapping, type OfficialOllamaCatalogMapping, type LlmfitReport, type LlmfitSystem } from './model-recommend.js';
import { parseOllamaTags, readLocalModelIdentity } from './llm/local-models.js';
import { inspectInstalledAlias, validInstalledAliasProof, type InstalledModelAliasProof } from './llm/local-model-alias.js';
import { hasMeasuredModelIdentity, modelIdentityKey, sameModelIdentity, type ModelIdentity } from './llm/model-identity.js';

const VERSION = '1.1.15';
const PINNED_ARCHIVES: Record<string, string> = {
  'darwin/arm64': '6207b32a3fa97778a21afed7bbf5f33c569bda35202e04a27b4989880687e6d7',
  'darwin/x64': 'aadb97d706d3b03fb2c4573b0cfb8f421943023beb6617fea1229b033dfc6d4e',
  'linux/arm64': 'd78cfcbc4d1905a02a7c79aef445b20d19020c37ab47baa83ee7bc687b4bcd13',
  'linux/x64': '4ba3519adf8f861af548554272193ad1ae45bd7e72db3879456b2e76d65a6100',
};
export interface AdvisorCandidate {
  name: string; digest: string | null; sizeGb: number | null;
  /** Catalog lookup only; it cannot authorize a plan without the checked official manifest. */
  catalogMapping?: OfficialOllamaCatalogMapping;
  fit: { level: string; memoryGb: number | null; estimatedTps: number | null; contextTokens: number | null; catalogModel: string | null; runtime: string | null; quantization: string | null };
}
export interface AdvisorReceipt {
  version: 1; id: string; actor: string; status: 'running' | 'done' | 'failed'; startedAt: string; finishedAt?: string;
  contextTokens: number; baseUrl: string; analyzer: string; hardware: LlmfitSystem | null; hardwareFingerprint: string | null;
  candidates: AdvisorCandidate[]; error?: string;
  taskFit?: { fitsMemory: boolean; reason: string };
  taskChecks?: Record<'research' | 'writer', { qualified: boolean; checkedAt: string | null; reason: string }>;
  check?: { route: string; identity: ModelIdentity; checkedAt: string; message: string; plan?: AdvisorPlan; planError?: string; catalogProof?: OfficialManifestProof; aliasProof?: InstalledModelAliasProof };
}
interface OfficialManifestProof { version: 1; registryUrl: string; catalogModel: string; installedName: string; digest: string; checkedAt: string; manifestText: string }
export interface AdvisorPlan { model: string; contextTokens: number; quantization: string; format: 'gguf'; kvQuant: 'fp16'; memoryGb: number; availableGb: number; memoryPool: 'unified' | 'gpu' | 'ram'; fits: boolean; checkedAt: string; method: 'llmfit-quant-context-estimate' }
export type AdvisorRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>;

/** No user configuration, dashboard, benchmark, model download, or inherited service credentials. */
export const runAdvisorTool: AdvisorRunner = async (command, args, timeoutMs) => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-model-advisor-'));
  const env: NodeJS.ProcessEnv = { HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'), XDG_CACHE_HOME: join(dir, 'cache'), LLMFIT_BENCH_STORE: join(dir, 'bench'), OLLAMA_HOST: 'http://127.0.0.1:11434' };
  for (const key of ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
  try { return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd: dir, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, settled = false;
    const stop = () => { if (!child.pid) return; if (process.platform === 'win32') { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); killer.on('error', () => child.kill('SIGKILL')); } else try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); stop(); child.stdout.destroy(); child.stderr.destroy(); reject(error); };
    const timer = setTimeout(() => fail(new Error('Local advisor exceeded its time limit. Retry when this computer is less busy.')), timeoutMs);
    const receive = (data: Buffer, error = false) => { bytes += data.length; if (bytes > 8 * 1024 * 1024) return fail(new Error('Local advisor output exceeded 8 MiB.')); if (error) stderr = (stderr + data).slice(-2000); else stdout += data; };
    child.stdout.on('data', data => receive(data)); child.stderr.on('data', data => receive(data, true));
    child.on('error', fail);
    child.on('close', code => { if (settled) return; settled = true; clearTimeout(timer); stop(); code === 0 ? resolve(stdout) : reject(new Error(`Local advisor exited ${code}: ${stderr.slice(-400)}`)); });
  }); } finally { rmSync(dir, { recursive: true, force: true }); }
};

/** Use the reviewed project tool; a same-named arbitrary package on PATH is not provenance. */
export function advisorTool(codeRoot = CODE_ROOT): string | null {
  const dir = contained(codeRoot, 'workdir/tools/llmfit', 'v' + VERSION), binary = join(dir, process.platform === 'win32' ? 'llmfit.exe' : 'llmfit');
  const receipt = read<any>(join(dir, 'provenance.json'), null);
  if (!existsSync(binary) || receipt?.repository !== 'https://github.com/AlexsJones/llmfit' || receipt.version !== VERSION || receipt.platform !== platform() || receipt.arch !== arch()) return null;
  if (lstatSync(dir).isSymbolicLink() || lstatSync(binary).isSymbolicLink() || !lstatSync(binary).isFile() || receipt.archiveSha256 !== PINNED_ARCHIVES[platform() + '/' + arch()] || createHash('sha256').update(readFileSync(binary)).digest('hex') !== receipt.binarySha256) throw new Error('The local analyzer no longer matches its verified setup receipt. Set it up again.');
  return binary;
}

export function advisorHardwareFingerprint(system: LlmfitSystem): string | null {
  if (!system.cpuCores || !system.gpus || system.gpus.some(gpu => !gpu.name || gpu.name === 'unknown' || gpu.vramGb === null)) return null;
  return createHash('sha256').update(JSON.stringify({ platform: platform(), arch: arch(), cpu: system.cpuName, cores: system.cpuCores, memory: system.totalRamGb, backend: system.backend, gpus: system.gpus })).digest('hex');
}

/** Call only at an explicit scan/test boundary, never from request-time state polling. */
export async function currentHardwareSnapshot(runner: AdvisorRunner = runAdvisorTool, tool = advisorTool()): Promise<{ fingerprint: string | null; system: LlmfitSystem | null }> {
  if (!tool) return { fingerprint: null, system: null };
  const value = JSON.parse(await runner(tool, ['--no-dashboard', 'system', '--json'], 15000));
  const system = parseLlmfitReport(JSON.stringify({ system: value.system ?? value, models: [] })).system;
  return { fingerprint: advisorHardwareFingerprint(system), system };
}
export async function currentHardwareFingerprint(runner: AdvisorRunner = runAdvisorTool, tool = advisorTool()): Promise<string | null> {
  return (await currentHardwareSnapshot(runner, tool)).fingerprint;
}

export async function currentOpenCodeVersion(runner: AdvisorRunner = runAdvisorTool): Promise<string> {
  const version = (await runner('opencode', ['--version'], 5000)).trim();
  if (!/^(?:opencode\s+)?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error('OpenCode did not return an exact version. Check its local installation.');
  return version;
}

export function advisorCandidates(report: LlmfitReport | null, installed: ReturnType<typeof parseOllamaTags>, contextTokens: number): AdvisorCandidate[] {
  return installed.filter(model => !model.remote && !/(?:[:-])cloud$/i.test(model.name)).map(model => {
    const match = report?.models.filter(row => row.ollamaName && canonicalOllamaName(row.ollamaName) === canonicalOllamaName(model.name) && row.effectiveContextTokens === contextTokens).sort((a, b) => b.score - a.score)[0];
    const mapped = !match ? report?.models.find(row => row.effectiveContextTokens === contextTokens && officialOllamaCatalogMapping(row.name, model.name)) : undefined;
    const catalogMapping = officialOllamaCatalogMapping(match?.name ?? mapped?.name ?? '', model.name) ?? undefined;
    return { name: model.name, digest: model.digest, sizeGb: model.sizeGb, ...(catalogMapping ? { catalogMapping } : {}), fit: { level: match?.fitLevel ?? 'not estimated', memoryGb: match?.memoryRequiredGb ?? null, estimatedTps: match?.estimatedTps ?? null, contextTokens: match?.effectiveContextTokens ?? null, catalogModel: match?.name ?? mapped?.name ?? null, runtime: match?.runtime ?? null, quantization: match?.quantization ?? null } };
  });
}

const effortValues = ['none', 'low', 'medium', 'high', 'max'] as const;
function checkedEffort(root: string, provider: string, model: string, baseUrl: string, explicit: unknown): string | undefined {
  const normalize = (value: unknown): string | undefined => {
    if (value === undefined || value === 'default') return undefined;
    if (typeof value !== 'string' || !(effortValues as readonly string[]).includes(value)) throw new Error('Choose a supported reasoning effort or default before checking this model.');
    return value;
  };
  if (explicit !== undefined) return normalize(explicit);
  const modes = new Set<string>();
  const config = read<any>(contained(root, 'config/model.json'), null), roles = read<any>(contained(root, 'config/role-routing.json'), null);
  const add = (route: any) => {
    if (route?.provider !== provider || route.model !== model || (route.baseUrl ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, '') !== baseUrl.replace(/\/$/, '')) return;
    modes.add(normalize(route.reasoningEffort) ?? 'default');
  };
  if (config?.provider === provider) add({ ...config.providers?.[provider], provider });
  if (roles?.version === 1 && roles.enabled === true && roles.roles && typeof roles.roles === 'object') for (const route of Object.values(roles.roles)) add(route);
  if (modes.size > 1) throw new Error('Saved routes use different reasoning modes for this model. Choose an explicit reasoning effort or default for this check.');
  return normalize([...modes][0]);
}

function validManifestProof(proof: OfficialManifestProof | undefined, mapping: OfficialOllamaCatalogMapping, identity: ModelIdentity): boolean {
  if (!proof || proof.version !== 1 || proof.registryUrl !== mapping.registryUrl || proof.catalogModel !== mapping.catalogModel || proof.installedName !== mapping.installedName || proof.digest !== identity.digest || typeof proof.manifestText !== 'string' || Buffer.byteLength(proof.manifestText) > 65536 || !Number.isFinite(Date.parse(proof.checkedAt)) || Date.parse(proof.checkedAt) <= 0 || Date.parse(proof.checkedAt) > Date.now()) return false;
  if (mapping.quantization && mapping.quantization !== identity.quantization) return false;
  if (createHash('sha256').update(proof.manifestText).digest('hex') !== identity.digest?.replace(/^sha256:/, '')) return false;
  try {
    const manifest = JSON.parse(proof.manifestText);
    return manifest.schemaVersion === 2 && /^sha256:[a-f0-9]{64}$/.test(manifest.config?.digest) && Array.isArray(manifest.layers)
      && manifest.layers.some((layer: any) => layer?.mediaType === 'application/vnd.ollama.image.model' && /^sha256:[a-f0-9]{64}$/.test(layer.digest) && Number.isSafeInteger(layer.size) && layer.size > 0);
  } catch { return false; }
}

async function checkOfficialManifest(root: string, mapping: OfficialOllamaCatalogMapping, identity: ModelIdentity, fetcher: typeof fetch): Promise<OfficialManifestProof> {
  if (mapping.quantization && mapping.quantization !== identity.quantization) throw new Error('Installed quantization does not match the exact official tag; scan the selected variant again.');
  const cached = [read<AdvisorReceipt | null>(contained(root, 'state/model-advisor.json'), null), ...Object.values(read<Record<string, AdvisorReceipt>>(contained(root, 'state/model-advisor-checks.json'), {}))]
    .map(row => row?.check?.catalogProof).find(proof => validManifestProof(proof, mapping, identity));
  if (cached) return cached;
  const response = await fetcher(mapping.registryUrl, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' } });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('The exact official model manifest could not be verified; no memory plan was authorized.'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (let part = await reader.read(); !part.done; part = await reader.read()) { size += part.value.length; if (size > 65536) throw new Error('Official model manifest exceeds 64 KiB.'); chunks.push(part.value); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const proof: OfficialManifestProof = { version: 1, ...mapping, digest: identity.digest!, checkedAt: new Date().toISOString(), manifestText: Buffer.concat(chunks).toString('utf8') };
  if (!validManifestProof(proof, mapping, identity)) throw new Error('The official manifest does not match this exact installed model digest and quantization.');
  return proof;
}

export function readModelAdvisor(root: string, actor: string): AdvisorReceipt | null {
  const value = read<AdvisorReceipt | null>(contained(root, 'state/model-advisor.json'), null);
  if (value?.version !== 1 || value.actor !== actor) return null;
  if (!value.check) return value;
  return { ...value, taskFit: advisorRoleFit(root, value.check.identity), taskChecks: { research: roleQualificationStatus(root, value.check.identity, 'research', 'source-id-selection', EVIDENCE_SOURCE_CONTRACT), writer: roleQualificationStatus(root, value.check.identity, 'writer', 'claim-id-selection', EVIDENCE_SELECTION_CONTRACT) } };
}

/** Explicit worker action only. State reads never invoke this function or the analyzer. */
export async function scanModelAdvisor(root: string, actor: string, input: { contextTokens?: unknown }, deps: { runner?: AdvisorRunner; tool?: string | null; fetcher?: typeof fetch } = {}): Promise<AdvisorReceipt> {
  const contextTokens = input.contextTokens === undefined ? 8192 : Number(input.contextTokens);
  if (![4096, 8192, 16384, 32768].includes(contextTokens)) throw new Error('Choose a 4K, 8K, 16K or 32K context estimate.');
  const unlock = releaseLock(root, 'model-advisor');
  const receipt: AdvisorReceipt = { version: 1, id: randomUUID(), actor, status: 'running', startedAt: new Date().toISOString(), contextTokens, baseUrl: 'http://127.0.0.1:11434/v1', analyzer: 'Checking this computer', hardware: null, hardwareFingerprint: null, candidates: [] };
  const save = () => atomicJson(contained(root, 'state/model-advisor.json'), receipt);
  save();
  try {
    const runner = deps.runner ?? runAdvisorTool, tool = deps.tool === undefined ? advisorTool() : deps.tool;
    let report: LlmfitReport | null = null;
    if (tool) {
      const version = (await runner(tool, ['--version'], 5000)).trim();
      if (version !== 'llmfit ' + VERSION) throw new Error('Local analyzer version does not match the verified setup.');
      report = parseLlmfitReport(await runner(tool, ['--no-dashboard', '--max-context', String(contextTokens), 'fit', '--json', '--sort', 'score', '--limit', '2000'], 90000));
      receipt.analyzer = `llmfit ${VERSION} · hardware estimate only`; receipt.hardware = report.system; receipt.hardwareFingerprint = advisorHardwareFingerprint(report.system);
    } else {
      receipt.analyzer = 'Optional llmfit analyzer is not installed; hardware fit is not estimated.';
      receipt.hardware = { cpuName: cpus()[0]?.model || 'unknown', cpuCores: cpus().length, totalRamGb: Math.round(totalmem() / 1024 ** 3), backend: 'not detected', unifiedMemory: false };
    }
    const fetcher = deps.fetcher ?? fetch;
    const response = await fetcher('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2500), redirect: 'error' });
    if (!response.ok) throw new Error('Start Ollama on this computer, then scan again.');
    if (!response.body) throw new Error('Ollama returned no installed model inventory.');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (let part = await reader.read(); !part.done; part = await reader.read()) { size += part.value.length; if (size > 262144) throw new Error('Installed model inventory exceeds 256 KiB.'); chunks.push(part.value); } }
    catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const text = Buffer.concat(chunks).toString('utf8');
    receipt.candidates = advisorCandidates(report, parseOllamaTags(JSON.parse(text)), contextTokens);
    receipt.status = 'done'; receipt.finishedAt = new Date().toISOString(); save(); return receipt;
  } catch (error) { receipt.status = 'failed'; receipt.error = (error as Error).message; receipt.finishedAt = new Date().toISOString(); save(); throw error; }
  finally { unlock(); }
}

export async function checkAdvisorModel(root: string, actor: string, input: { scanId?: unknown; route?: unknown; reasoningEffort?: unknown }, deps: { runner?: AdvisorRunner; fetcher?: typeof fetch; openCodeVersion?: string; hardwareFingerprint?: string | null; hardware?: LlmfitSystem; tool?: string | null; modelRoot?: string } = {}): Promise<AdvisorReceipt> {
  const unlock = releaseLock(root, 'model-advisor');
  try {
  const receipt = readModelAdvisor(root, actor);
  if (!receipt || receipt.id !== input.scanId || receipt.status !== 'done') throw new Error('Scan this computer again before checking a writer.');
  if (!receipt.finishedAt || !Number.isFinite(Date.parse(receipt.finishedAt)) || Date.parse(receipt.finishedAt) > Date.now() || Date.now() - Date.parse(receipt.finishedAt) > 30 * 60 * 1000) throw new Error('This hardware scan is older than 30 minutes. Scan again before checking a writer.');
  const route = String(input.route ?? ''), provider = route.startsWith('opencode:ollama/') ? 'opencode' : route.startsWith('ollama:') ? 'ollama' : null;
  const model = provider === 'opencode' ? route.slice(9) : route.slice(7), name = provider === 'opencode' ? model.slice(7) : model;
  if (!provider || !receipt.candidates.some(candidate => candidate.name === name)) throw new Error('Choose an installed writer from this scan.');
  const reasoningEffort = checkedEffort(root, provider, model, receipt.baseUrl, input.reasoningEffort);
  const snapshot = deps.hardwareFingerprint === undefined ? await currentHardwareSnapshot(deps.runner) : { fingerprint: deps.hardwareFingerprint, system: deps.hardware ?? receipt.hardware };
  const hardwareFingerprint = snapshot.fingerprint;
  if (receipt.hardwareFingerprint && receipt.hardwareFingerprint !== hardwareFingerprint) throw new Error('Hardware identity changed or is unavailable. Scan this computer again.');
  receipt.hardware = snapshot.system;
  const openCodeVersion = provider === 'opencode' ? deps.openCodeVersion ?? await currentOpenCodeVersion(deps.runner) : undefined;
  const identity = await readLocalModelIdentity(provider, model, receipt.baseUrl, { contextTokens: provider === 'ollama' ? receipt.contextTokens : undefined, reasoningEffort, runtimeVersion: openCodeVersion, hardwareFingerprint: hardwareFingerprint ?? '' }, deps.fetcher);
  const previous = receipt.candidates.find(candidate => candidate.name === name)!;
  if (!identity.digest || previous.digest !== identity.digest) throw new Error('This installed model changed after the scan. Scan again before using it.');
  receipt.check = { route, identity, checkedAt: new Date().toISOString(), message: hasMeasuredModelIdentity(identity) ? 'This exact model is available. Task quality has not been established by this connection check.' : 'This model is available, but its complete runtime identity or actual context is unknown. Task quality is not established.' };
  const tool = deps.tool === undefined ? advisorTool() : deps.tool;
  if (tool && identity.format === 'gguf' && /^(?:Q[2-8]_(?:K(?:_[SML])?|[01])|IQ[1-4]_[A-Z0-9_]+|F16|BF16|F32)$/.test(identity.quantization || '') && identity.context.tokens) {
    try {
      // An alias is eligible only when its installed manifest preserves every weight,
      // projector and template layer of an independently verified official base.
      if (!previous.fit.catalogModel || previous.catalogMapping && !officialOllamaCatalogMapping(previous.fit.catalogModel, name)) {
        const bases = receipt.candidates.filter(candidate => candidate.name !== name && candidate.catalogMapping && candidate.fit.catalogModel
          && JSON.stringify(officialOllamaCatalogMapping(candidate.fit.catalogModel, candidate.name)) === JSON.stringify(candidate.catalogMapping));
        const alias = inspectInstalledAlias(identity, bases, deps.modelRoot);
        const base = alias && bases.find(candidate => candidate.name === alias.baseName && candidate.digest === alias.baseDigest);
        if (!alias || !base?.catalogMapping || !base.fit.catalogModel) throw new Error('This local alias has no verified identical official model, projector and template layers.');
        const baseIdentity = { ...identity, model: provider === 'opencode' ? 'ollama/' + alias.baseName : alias.baseName, digest: alias.baseDigest };
        receipt.check.catalogProof = await checkOfficialManifest(root, base.catalogMapping, baseIdentity, deps.fetcher ?? fetch);
        receipt.check.aliasProof = alias;
        previous.catalogMapping = base.catalogMapping;
        previous.fit.catalogModel = base.fit.catalogModel;
      } else if (previous.catalogMapping) {
        const mapping = officialOllamaCatalogMapping(previous.fit.catalogModel!, name);
        if (!mapping || JSON.stringify(mapping) !== JSON.stringify(previous.catalogMapping)) throw new Error('Saved official catalog mapping changed; scan this model again.');
        receipt.check.catalogProof = await checkOfficialManifest(root, mapping, identity, deps.fetcher ?? fetch);
      }
      if (!previous.fit.catalogModel) throw new Error('An exact catalog model is required for a memory plan.');
      const plan = JSON.parse(await (deps.runner ?? runAdvisorTool)(tool, ['--no-dashboard', 'plan', previous.fit.catalogModel, '--context', String(identity.context.tokens), '--quant', identity.quantization!, '--kv-quant', 'fp16', '--json'], 15000));
      if (plan.model_name !== previous.fit.catalogModel || plan.context !== identity.context.tokens || plan.quantization !== identity.quantization || plan.kv_quant !== 'fp16') throw new Error('Analyzer plan identity did not match the selected model, quantization and context.');
      const gpu = String(plan.current?.run_mode).toLowerCase() === 'gpu';
      const memoryGb = gpu ? plan.minimum?.vram_gb : plan.minimum?.ram_gb;
      const availableGb = receipt.hardware?.unifiedMemory || !gpu ? receipt.hardware?.availableRamGb : receipt.hardware?.availableGpuGb;
      if (!Number.isFinite(memoryGb) || memoryGb <= 0 || !Number.isFinite(availableGb) || availableGb! <= 0) throw new Error('Current available memory or this runtime plan is unknown.');
      receipt.check.plan = { model: plan.model_name, contextTokens: plan.context, quantization: plan.quantization, format: 'gguf', kvQuant: 'fp16', memoryGb, availableGb: availableGb!, memoryPool: receipt.hardware?.unifiedMemory ? 'unified' : gpu ? 'gpu' : 'ram', fits: ['good', 'perfect'].includes(String(plan.current?.fit_level).toLowerCase()) && memoryGb <= availableGb! * .85, checkedAt: new Date().toISOString(), method: 'llmfit-quant-context-estimate' };
    } catch (error) { receipt.check.planError = (error as Error).message; }
  } else receipt.check.planError = 'An exact installed GGUF quantization, catalog model and actual context are required for a memory plan.';
  atomicJson(contained(root, 'state/model-advisor.json'), receipt);
  // Each role may use a different model or context. Keep exact checked scan snapshots,
  // rather than letting the latest dropdown choice replace another model's eligibility.
  const checksPath = contained(root, 'state/model-advisor-checks.json');
  const previousChecks = read<Record<string, AdvisorReceipt>>(checksPath, {});
  const checks = Object.fromEntries(Object.entries(previousChecks).filter(([, row]) => row?.version === 1 && row.check && Number.isFinite(Date.parse(row.check.checkedAt)) && Date.parse(row.check.checkedAt) <= Date.now() && Date.now() - Date.parse(row.check.checkedAt) <= 30 * 60 * 1000).sort((a, b) => Date.parse(b[1].check!.checkedAt) - Date.parse(a[1].check!.checkedAt)).slice(0, 49));
  const { taskFit: _fit, taskChecks: _tasks, ...checkedSnapshot } = receipt;
  checks[modelIdentityKey(identity)] = checkedSnapshot; atomicJson(checksPath, checks);
  return receipt;
  } finally { unlock(); }
}

/** Read-side only. A broad catalog/MLX fit can never authorize a local Ollama role. */
export function advisorRoleFit(root: string, identity: ModelIdentity, currentHardware?: LlmfitSystem | null): { fitsMemory: boolean; reason: string } {
  const latest = read<AdvisorReceipt | null>(contained(root, 'state/model-advisor.json'), null);
  const checks = read<Record<string, AdvisorReceipt>>(contained(root, 'state/model-advisor-checks.json'), {});
  const scan = sameModelIdentity(latest?.check?.identity, identity) ? latest : checks[modelIdentityKey(identity)];
  const check = scan?.check, plan = check?.plan;
  const fresh = (value?: string) => !!value && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() && Date.now() - Date.parse(value) <= 30 * 60 * 1000;
  const name = identity.provider === 'opencode' ? identity.model.replace(/^ollama\//, '') : identity.model;
  const candidate = scan?.candidates?.find(row => row.name === name && row.digest === identity.digest);
  const mapping = candidate?.catalogMapping;
  const expectedMapping = candidate?.fit.catalogModel ? officialOllamaCatalogMapping(candidate.fit.catalogModel, name) : null;
  const alias = check?.aliasProof;
  const aliasMapping = alias && candidate?.fit.catalogModel ? officialOllamaCatalogMapping(candidate.fit.catalogModel, alias.baseName) : null;
  const officialProof = alias ? validInstalledAliasProof(alias, identity) && !!mapping && !!aliasMapping
    && JSON.stringify(mapping) === JSON.stringify(aliasMapping)
    && validManifestProof(check?.catalogProof, mapping, { ...identity, model: identity.provider === 'opencode' ? 'ollama/' + alias.baseName : alias.baseName, digest: alias.baseDigest })
    : expectedMapping ? !!mapping && JSON.stringify(mapping) === JSON.stringify(expectedMapping) && validManifestProof(check?.catalogProof, mapping, identity) : !mapping;
  const currentAvailable = currentHardware ? plan?.memoryPool === 'gpu' ? currentHardware.availableGpuGb : currentHardware.availableRamGb : plan?.availableGb;
  const fitsMemory = !!scan && scan.version === 1 && scan.status === 'done' && fresh(scan.finishedAt) && fresh(check?.checkedAt) && fresh(plan?.checkedAt)
    && sameModelIdentity(check?.identity, identity) && scan.hardwareFingerprint === identity.hardwareFingerprint && scan.baseUrl === identity.baseUrl && !!candidate && officialProof
    && !!plan && plan.method === 'llmfit-quant-context-estimate' && plan.model === candidate.fit.catalogModel && plan.format === identity.format && identity.format === 'gguf'
    && plan.quantization === identity.quantization && plan.contextTokens === identity.context.tokens && plan.kvQuant === 'fp16'
    && ['unified', 'gpu', 'ram'].includes(plan.memoryPool) && (!currentHardware || advisorHardwareFingerprint(currentHardware) === identity.hardwareFingerprint)
    && plan.fits === true && Number.isFinite(plan.memoryGb) && plan.memoryGb > 0 && Number.isFinite(plan.availableGb) && plan.memoryGb <= plan.availableGb * .85 && Number.isFinite(currentAvailable) && plan.memoryGb <= currentAvailable! * .85;
  return { fitsMemory, reason: fitsMemory ? 'Current quantization and context have a bounded memory estimate; task quality is checked separately.' : check?.planError || 'Scan and check this exact model again for a current quantization and context memory estimate before running its task test.' };
}
