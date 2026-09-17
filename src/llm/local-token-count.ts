import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelIdentity } from './model-identity.js';

export const LOCAL_CONTEXT_ADMISSION_VERSION = 3;
export const LOCAL_OUTPUT_TOKEN_RESERVE = 4096;
export const LOCAL_TEXT_ENVELOPE_RESERVE = 256;
export const LOCAL_OPENCODE_ENVELOPE_RESERVE = 2048;
export interface LocalImageReserve { sha256: string; bytes: number; width: number; height: number; reservedTokens: number }
export interface ExactLocalTokenCount {
  version: 1; method: 'installed-gguf-qwen2-chatml' | 'installed-gguf-qwen35-text'; promptHash: string; promptBytes: number; inputTokens: number;
  renderedPromptHash: string; manifestDigest: string; modelLayerDigest: string; metadataSha256: string;
  metadataBytes: number; templateSha256: string; tokenizerJsonSha256: string;
  tokenizersVersion: string; transformersVersion: string; normalization: 'input-already-NFC';
  images?: LocalImageReserve[];
}
export interface LocalContextAdmission {
  version: 3; method: 'exact-installed-tokenizer' | 'measured-text-with-reserves' | 'conservative-utf8-bytes'; promptHash: string;
  inputUnits: number; reservedTokens: number; contextTokens: number; packetBytes: number;
  outputReservedTokens: number; envelopeReservedTokens: number; schemaReservedTokens: number; imageReservedTokens: number;
  envelope: 'verified-qwen2-chatml' | 'estimated-ollama-template' | 'estimated-opencode-runtime';
  tokenizer?: ExactLocalTokenCount; tokenizerUnavailable?: string;
}
export interface LocalTokenOptions { python?: string; script?: string; modelRoot?: string; timeoutMs?: number; images?: string[]; extraInputTokens?: number }
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A bounded local tokenizer process, never a model server or remote API. */
export function countInstalledLocalTokens(prompt: string, identity: ModelIdentity, options: LocalTokenOptions = {}): { count?: ExactLocalTokenCount; unavailable?: string } {
  const direct = identity.provider === 'ollama' && identity.runtimeVersion === '0.34.0';
  const cli = identity.provider === 'opencode' && identity.runtimeVersion === 'OpenCode 1.18.25; Ollama 0.34.0' && identity.model.startsWith('ollama/');
  if ((!direct && !cli) || identity.format !== 'gguf' || !hash(identity.digest) || identity.reasoningEffort !== 'none'
    || !['http://127.0.0.1:11434/v1', 'http://localhost:11434/v1'].includes(identity.baseUrl)) return { unavailable: 'Installed tokenizer supports the verified Ollama 0.34.0 or OpenCode 1.18.25 local route with thinking disabled' };
  const root = options.modelRoot ?? process.env.OLLAMA_MODELS ?? join(homedir(), '.ollama/models');
  const match = (cli ? identity.model.slice('ollama/'.length) : identity.model).match(/^(?:([A-Za-z0-9._-]+)\/)?([A-Za-z0-9._-]+)(?::([A-Za-z0-9._-]+))?$/);
  if (!match) return { unavailable: 'Installed model name needs a supported local manifest path' };
  const manifest = join(root, 'manifests/registry.ollama.ai', match[1] ?? 'library', match[2]!, match[3] ?? 'latest');
  if (!existsSync(manifest)) return { unavailable: 'Installed model manifest is unavailable' };
  if (sha(readFileSync(manifest)) !== identity.digest) return { unavailable: 'Installed manifest differs from measured runtime digest' };
  const localPython = join(codeRoot, 'tts/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = options.python ?? (existsSync(localPython) ? localPython : 'python3');
  const script = options.script ?? join(codeRoot, 'scripts/local-token-count.py');
  if (!existsSync(script)) return { unavailable: 'Installed tokenizer helper is unavailable' };
  const images = options.images ?? [];
  if (images.length > 6) return { unavailable: 'At most six image inputs can be reserved' };
  let imageHashes: string[];
  try { imageHashes = images.map(path => { const stat = lstatSync(path); if (!stat.isFile() || stat.size < 1 || stat.size > 8_000_000) throw new Error('Image must be a bounded regular file'); return sha(readFileSync(path)); }); }
  catch { return { unavailable: 'Image must be a bounded regular file' }; }
  const result = spawnSync(python, [realpathSync(script)], { input: JSON.stringify({ manifest, modelRoot: root, digest: identity.digest, prompt, images }), encoding: 'utf8',
    timeout: Math.min(10000, Math.max(1, options.timeoutMs ?? 10000)), maxBuffer: 65536,
    env: { ...process.env, USE_TORCH: '0', USE_TF: '0', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' } });
  let value: any;
  try { value = JSON.parse(result.stdout || '{}'); } catch { return { unavailable: 'Local tokenizer returned invalid diagnostics' }; }
  if (result.status !== 0 || result.error) return { unavailable: typeof value.error === 'string' ? value.error.slice(0, 300) : 'Local tokenizer dependency or bounded execution unavailable' };
  if (value.version !== 1 || !['installed-gguf-qwen2-chatml', 'installed-gguf-qwen35-text'].includes(value.method) || value.promptHash !== sha(prompt) || value.promptBytes !== Buffer.byteLength(prompt)
    || value.manifestDigest !== identity.digest || !Number.isSafeInteger(value.inputTokens) || value.inputTokens < 1 || value.inputTokens > 200000
    || !hash(value.renderedPromptHash) || !hash(value.metadataSha256) || !hash(value.templateSha256) || !hash(value.tokenizerJsonSha256)
    || value.tokenizersVersion !== '0.22.2' || value.transformersVersion !== '5.15.0'
    || value.normalization !== 'input-already-NFC') return { unavailable: 'Local tokenizer receipt does not match this exact request and model' };
  if (!Array.isArray(value.images) || value.images.length !== images.length || value.images.some((row: LocalImageReserve, index: number) => !row || row.sha256 !== imageHashes[index] || !Number.isSafeInteger(row.reservedTokens) || row.reservedTokens < 1088 || !Number.isSafeInteger(row.width) || !Number.isSafeInteger(row.height) || row.width < 1 || row.height < 1 || row.width > 16384 || row.height > 16384 || row.width * row.height > 16777216 || row.reservedTokens !== Math.max(1024, Math.ceil(row.width / 32) * Math.ceil(row.height / 32) * 4) + 64)) return { unavailable: 'Local tokenizer image reserve does not match the supplied image inputs' };
  try { if (images.some((path, index) => sha(readFileSync(path)) !== imageHashes[index])) return { unavailable: 'Image changed during context admission' }; }
  catch { return { unavailable: 'Image changed during context admission' }; }
  return { count: value as ExactLocalTokenCount };
}

/** Every physical correction is checked again; caller supplies its complete actual prompt. */
export function admitLocalContext(prompt: string, identity: ModelIdentity, packetLimit: number, options: Parameters<typeof countInstalledLocalTokens>[2] = {}): LocalContextAdmission {
  const bytes = Buffer.byteLength(prompt), context = identity.context.tokens;
  if (!Number.isSafeInteger(context) || context! <= LOCAL_OUTPUT_TOKEN_RESERVE || bytes > packetLimit) throw new Error('Local role packet exceeds its bounded packet or proven context allowance');
  const result = countInstalledLocalTokens(prompt, identity, options);
  const schema = options.extraInputTokens ?? 0;
  if (!Number.isSafeInteger(schema) || schema < 0 || schema > 131072) throw new Error('Local schema reserve must be a bounded nonnegative integer');
  if (options.images?.length && (!result.count || result.count.method !== 'installed-gguf-qwen35-text')) throw new Error(`Local image context cannot be admitted without a verified image reserve; ${result.unavailable ?? 'unsupported image tokenizer profile'}`);
  const units = result.count?.inputTokens ?? bytes;
  const exactEnvelope = identity.provider === 'ollama' && result.count?.method === 'installed-gguf-qwen2-chatml';
  const envelopeReserve = identity.provider === 'opencode' ? LOCAL_OPENCODE_ENVELOPE_RESERVE : exactEnvelope ? 0 : LOCAL_TEXT_ENVELOPE_RESERVE;
  const imageReserve = result.count?.images?.reduce((sum, row) => sum + row.reservedTokens, 0) ?? 0;
  const reserved = LOCAL_OUTPUT_TOKEN_RESERVE + envelopeReserve + schema + imageReserve;
  if (units + reserved > context!) throw new Error(`Local role packet exceeds its proven context allowance (${units} ${result.count ? 'measured input tokens' : 'conservative UTF-8 bytes'} + ${reserved} reserved tokens > ${context})${result.unavailable ? `; ${result.unavailable}` : ''}`);
  return { version: LOCAL_CONTEXT_ADMISSION_VERSION, method: result.count ? exactEnvelope ? 'exact-installed-tokenizer' : 'measured-text-with-reserves' : 'conservative-utf8-bytes',
    promptHash: sha(prompt), inputUnits: units, reservedTokens: reserved, contextTokens: context!, packetBytes: bytes,
    outputReservedTokens: LOCAL_OUTPUT_TOKEN_RESERVE, envelopeReservedTokens: envelopeReserve, schemaReservedTokens: schema, imageReservedTokens: imageReserve,
    envelope: identity.provider === 'opencode' ? 'estimated-opencode-runtime' : exactEnvelope ? 'verified-qwen2-chatml' : 'estimated-ollama-template',
    ...(result.count ? { tokenizer: result.count } : { tokenizerUnavailable: result.unavailable }) };
}
