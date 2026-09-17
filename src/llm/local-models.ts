/**
 * The models a local Ollama has downloaded, read from its own /api/tags. No pipeline or model imports:
 * the journey state consults this on every 1.8 s poll, so the answer is a cached snapshot that refreshes
 * in the background (the first poll after start says "checking", the next one has the list).
 */
import { MODEL_IDENTITY_VERSION, type ModelIdentity } from './model-identity.js';
export interface LocalModel { name: string; sizeGb: number | null; modifiedAt: string | null; digest: string | null; remote?: boolean; remoteHost?: string; remoteModel?: string }
export interface LocalModelsSnapshot { available: boolean | null; models: LocalModel[]; error: string | null; checkedAt: string | null }
export interface WriterImageCapability { provider: string; model?: string; baseUrl?: string; rescueEnabled?: boolean }

const LOOPBACK = ["127.0.0.1", "localhost", "::1", "[::1]"];
const cache = new Map<string, { at: number; refreshing: boolean; value: LocalModelsSnapshot }>();
const imageCache = new Map<string, { at: number; value: boolean }>();
const availabilityCache = new Map<string, { at: number; pending: boolean; check: Promise<void> }>();
const IMAGE_WRITERS = new Set(["claude", "codex", "gemini", "grok", "zai"]);

/** Bound actual bytes even when metadata omits or lies about content-length. */
async function boundedMetadata(response: Response): Promise<any> {
  if (!response.body) throw new Error('Local model metadata has no body.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try { for (let part = await reader.read(); !part.done; part = await reader.read()) { bytes += part.value.length; if (bytes > 262144) throw new Error('Local model metadata exceeds 256 KiB.'); chunks.push(part.value); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The Ollama server origin for a configured OpenAI-compatible base URL, or null when it is not on this computer. */
export function ollamaOrigin(baseUrl: string): string | null {
  try { const url = new URL(baseUrl || "http://127.0.0.1:11434/v1"); return LOOPBACK.includes(url.hostname) ? url.origin : null; } catch { return null; }
}

/** Confirm the selected local model before sending content or considering rescue. Metadata never loads weights. */
export async function assertLocalOllamaAvailable(baseUrl: string, model: string, ttlMs = 20000, fetcher: typeof fetch = fetch, apiKey?: string): Promise<void> {
  const origin = ollamaOrigin(baseUrl);
  // Explicit cloud registrations and remote Ollama endpoints retain their own authentication/transport checks.
  if (!origin || /(?:[:\-])cloud$/i.test(model)) return;
  const endpoint = (baseUrl || origin).replace(/\/$/, "").replace(/\/v1$/, "") + "/api/show";
  const key = JSON.stringify([endpoint, model, apiKey ?? ""]), prior = availabilityCache.get(key);
  if (prior && (prior.pending || Date.now() - prior.at < ttlMs)) return prior.check;
  const entry = { at: 0, pending: true, check: Promise.resolve() };
  entry.check = (async () => {
    let response: Response;
    const signal = AbortSignal.timeout(2500);
    try {
      response = await fetcher(endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ model }), signal, redirect: "error" });
    } catch {
      throw new Error(`Ollama at ${origin} ${signal.aborted ? "did not answer its metadata check within 2.5 seconds" : "could not be reached"} for model "${model}". Start Ollama or check its saved endpoint, then retry. Hosted rescue was not started.`);
    }
    if (!response.ok) await response.body?.cancel();
    if (response.status === 404) throw new Error(`Selected Ollama model "${model}" was not found (HTTP 404). Choose an installed model or download this model, then retry. Hosted rescue was not started.`);
    if (!response.ok) throw new Error(`Could not verify selected Ollama model "${model}" (HTTP ${response.status}). Retry when Ollama can confirm model availability. Hosted rescue was not started.`);
    let value: unknown;
    try { value = await boundedMetadata(response); } catch { /* malformed metadata is not proof the requested model exists */ }
    const metadata = value as { capabilities?: unknown; details?: unknown; model_info?: unknown; modelfile?: unknown; error?: unknown; remote_host?: unknown; remote_model?: unknown } | null;
    if (metadata?.remote_host || metadata?.remote_model) throw new Error(`Selected Ollama model "${model}" is a remote alias, not a local writer. Choose an explicitly identified cloud route or an installed local model. No content or hosted rescue was sent.`);
    const object = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (!object(metadata) || metadata?.error || !(Array.isArray(metadata?.capabilities) || object(metadata?.details) || object(metadata?.model_info) || typeof metadata?.modelfile === "string")) {
      throw new Error(`Ollama returned invalid metadata for selected model "${model}". Check its saved endpoint and retry. Hosted rescue was not started.`);
    }
  })().then(() => { entry.at = Date.now(); entry.pending = false; }, error => {
    // A download or server restart must be retryable immediately; cache only successful checks.
    if (availabilityCache.get(key) === entry) availabilityCache.delete(key);
    throw error;
  });
  availabilityCache.set(key, entry);
  return entry.check;
}

export function parseOllamaTags(body: unknown): LocalModel[] {
  const models = (body as { models?: unknown[] } | null)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map(m => m as { name?: unknown; size?: unknown; modified_at?: unknown; digest?: unknown; remote_host?: unknown; remote_model?: unknown })
    .filter(m => typeof m.name === "string" && /^[\w.\/-]+(?::[\w.-]+)?$/.test(m.name) && m.name.length <= 120)
    .map(m => ({ name: m.name as string, sizeGb: typeof m.size === "number" && m.size > 0 ? Math.round(m.size / 1e8) / 10 : null, modifiedAt: typeof m.modified_at === "string" ? m.modified_at : null, digest: typeof m.digest === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(m.digest) ? m.digest.replace(/^sha256:/, '') : null, ...(m.remote_host || m.remote_model ? { remote: true, ...(typeof m.remote_host === 'string' ? { remoteHost: m.remote_host } : {}), ...(typeof m.remote_model === 'string' ? { remoteModel: m.remote_model } : {}) } : {}) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 50);
}

/** Whether the selected writer can inspect pixels. Ollama advertises this per model via /api/show. */
export async function writerCanReadImages(writer: WriterImageCapability, ttlMs = 60000, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (writer.rescueEnabled || IMAGE_WRITERS.has(writer.provider)) return true;
  const model = writer.provider === "ollama" ? writer.model
    : writer.provider === "opencode" && writer.model?.startsWith("ollama/") ? writer.model.slice(7) : undefined;
  if (!model || writer.provider === "opencode" && /(?:[:\-])cloud$/i.test(model)) return false;
  const origin = ollamaOrigin(writer.baseUrl ?? "");
  if (!origin) return false;
  const key = `${writer.provider}\n${origin}\n${model}`, prior = imageCache.get(key);
  if (prior && Date.now() - prior.at < ttlMs) return prior.value;
  let value = false;
  try {
    const response = await fetcher(origin + "/api/show", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(1500), redirect: "error" });
    if (!response.ok) await response.body?.cancel();
    const metadata = response.ok ? await boundedMetadata(response) as { capabilities?: unknown; remote_host?: unknown; remote_model?: unknown } : null;
    value = (writer.provider !== "opencode" || !metadata?.remote_host && !metadata?.remote_model)
      && Array.isArray(metadata?.capabilities) && metadata.capabilities.includes("vision");
  } catch { /* unavailable or malformed means vision is not safe to assume */ }
  imageCache.set(key, { at: Date.now(), value });
  return value;
}

/** Synchronous snapshot; kicks off a bounded refresh when older than `ttlMs`. */
export function localModelsSnapshot(baseUrl: string, ttlMs = 20000, fetcher: typeof fetch = fetch): LocalModelsSnapshot {
  const origin = ollamaOrigin(baseUrl);
  if (!origin) return { available: false, models: [], error: "The Ollama endpoint is not on this computer.", checkedAt: null };
  let entry = cache.get(origin);
  if (!entry) { entry = { at: 0, refreshing: false, value: { available: null, models: [], error: null, checkedAt: null } }; cache.set(origin, entry); }
  if (!entry.refreshing && Date.now() - entry.at >= ttlMs) {
    entry.refreshing = true;
    void (async () => {
      try {
        const response = await fetcher(origin + "/api/tags", { signal: AbortSignal.timeout(1500), redirect: "error" });
        if (!response.ok) { await response.body?.cancel(); throw new Error("HTTP " + response.status); }
        entry!.value = { available: true, models: parseOllamaTags(await boundedMetadata(response)), error: null, checkedAt: new Date().toISOString() };
      } catch {
        entry!.value = { available: false, models: [], error: "Ollama is not running on this computer.", checkedAt: new Date().toISOString() };
      } finally { entry!.at = Date.now(); entry!.refreshing = false; }
    })();
  }
  return entry.value;
}

/** Bounded metadata-only check; never loads weights or starts inference. */
export async function ollamaPreflight(baseUrl: string, model: string, fetcher: typeof fetch = fetch): Promise<string> {
  const origin = ollamaOrigin(baseUrl);
  const cloud = /(?:[:\-])cloud$/.test(model) || !origin;
  const location = cloud ? "Cloud inference: source material leaves this computer; account access and usage limits apply." : "Local inference: speed depends on available memory and other running jobs.";
  if (!origin) return location;
  try {
    const response = await fetcher(origin + "/api/show", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(2500), redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); return `${location} Model metadata unavailable (HTTP ${response.status}).`; }
    const value = await boundedMetadata(response) as { capabilities?: string[]; details?: { family?: string } };
    if (!Array.isArray(value.capabilities)) return `${location} Thinking capability is unknown.`;
    if (!value.capabilities.includes("thinking")) return `${location} Ollama does not advertise thinking for this model.`;
    return `${location} Ollama advertises thinking, which can add substantial time. ${value.details?.family === "gptoss" ? "This family uses low/medium/high reasoning effort; thinking cannot be disabled." : "For models supporting a thinking toggle, reasoningEffort set to none sends think:false; qualify that exact setting separately."}`;
  } catch { return `${location} Thinking capability could not be checked; no inference was started by this check.`; }
}

/** Fresh, bounded metadata only. No chat/generate endpoint, model load, or provider substitution. */
export async function readLocalModelIdentity(provider: 'ollama' | 'opencode', model: string, baseUrl: string, options: {
  contextTokens?: number; reasoningEffort?: string; runtimeVersion?: string; hardwareFingerprint: string;
}, fetcher: typeof fetch = fetch): Promise<ModelIdentity> {
  const name = provider === 'opencode' ? model.replace(/^ollama\//, '') : model;
  const origin = ollamaOrigin(baseUrl);
  if (!origin || !/^[\w.\/-]+(?::[\w.-]+)?$/.test(name) || /(?:[:-])cloud$/i.test(name) || provider === 'opencode' && (!model.startsWith('ollama/') || origin !== 'http://127.0.0.1:11434')) throw new Error('Choose an installed local Ollama model for this check.');
  if (provider === 'opencode' && options.reasoningEffort !== undefined && options.reasoningEffort !== 'none') throw new Error('OpenCode local writing uses reasoning effort none; a different requested setting is unsupported.');
  const target = new URL(baseUrl || origin);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error('Local model endpoint must not contain credentials or query parameters.');
  const endpoint = target.href.replace(/\/$/, '').replace(/\/v1$/, '');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  const json = async (path: string, body?: object): Promise<any> => {
    const response = await fetcher(endpoint + path, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Local model metadata unavailable (HTTP ${response.status}).`); }
    return boundedMetadata(response);
  };
  try {
    const [tags, show, version] = await Promise.all([json('/api/tags'), json('/api/show', { model: name }), json('/api/version')]);
    if (!show || typeof show !== 'object' || show.error || !Array.isArray(show.capabilities) || !show.capabilities.includes('completion')) throw new Error('This installed model does not advertise text completion.');
    if (show.remote_host || show.remote_model) throw new Error('This model is a remote alias, not an installed local writer. Choose a local model.');
    const installed = parseOllamaTags(tags).find(row => row.name === name || !name.includes(':') && row.name === name + ':latest');
    if (installed?.remote) throw new Error('This model inventory identifies a remote alias. Choose an installed local writer.');
    const parameter = typeof show.parameters === 'string' ? Number(show.parameters.match(/^\s*num_ctx\s+(\d+)\s*$/m)?.[1]) : show.parameters?.num_ctx;
    const explicit = provider === 'ollama' && Number.isSafeInteger(options.contextTokens) && options.contextTokens! > 0;
    const pinned = Number.isSafeInteger(parameter) && parameter > 0;
    return {
      provider, model, baseUrl, digest: installed?.digest ?? null,
      ...(typeof show.details?.format === 'string' ? { format: show.details.format } : {}),
      ...(typeof show.details?.quantization_level === 'string' ? { quantization: show.details.quantization_level } : {}),
      context: explicit ? { mode: 'requested', tokens: options.contextTokens!, proof: 'request' } : { mode: 'installed-model-default', tokens: pinned ? parameter : null, proof: pinned ? 'model-parameter' : 'unknown' },
      ...(provider === 'opencode' ? { reasoningEffort: 'none' } : options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      runtimeVersion: typeof version?.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version.version) ? provider === 'opencode' ? options.runtimeVersion && /^(?:opencode\s+)?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(options.runtimeVersion) ? `OpenCode ${options.runtimeVersion.replace(/^opencode\s+/, '')}; Ollama ${version.version}` : null : version.version : null,
      protocolVersion: MODEL_IDENTITY_VERSION, hardwareFingerprint: options.hardwareFingerprint,
    };
  } finally { clearTimeout(timer); controller.abort(); }
}
