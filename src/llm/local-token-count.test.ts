import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { admitLocalContext, countInstalledLocalTokens } from './local-token-count.js';
import type { ModelIdentity } from './model-identity.js';

const identity: ModelIdentity = { provider: 'ollama', model: 'qwen2.5-coder:7b', baseUrl: 'http://127.0.0.1:11434/v1',
  digest: 'dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364', format: 'gguf', quantization: 'Q4_K_M',
  context: { mode: 'requested', tokens: 32768, proof: 'request' }, reasoningEffort: 'none', runtimeVersion: '0.34.0', protocolVersion: 1, hardwareFingerprint: 'offline-replay' };
const python = process.env.HARNESS_TOKENIZER_TEST_PYTHON;
const options = { python, script: resolve('scripts/local-token-count.py') };
const manifest = join(homedir(), '.ollama/models/manifests/registry.ollama.ai/library/qwen2.5-coder/7b');
const installed = !!python && existsSync(manifest) && createHash('sha256').update(readFileSync(manifest)).digest('hex') === identity.digest;

test('unknown runtime keeps the conservative bound and original output reserve', () => {
  const unknown = { ...identity, model: 'missing-local-model', digest: '0'.repeat(64) };
  const small = admitLocalContext('Facts from the supplied article.', unknown, 131072, options);
  assert.equal(small.method, 'conservative-utf8-bytes'); assert.equal(small.outputReservedTokens, 4096);
  assert.equal(small.envelopeReservedTokens, 256); assert.equal(small.reservedTokens, 4352);
  assert.throws(() => admitLocalContext('x'.repeat(28673), unknown, 131072, options), /proven context allowance/);
});

test('schema and CLI envelope count against context even when exact tokenizer is unavailable', () => {
  const unknown = { ...identity, provider: 'opencode', model: 'ollama/missing', runtimeVersion: 'unknown', context: { ...identity.context, tokens: 8192 } };
  const small = admitLocalContext('Facts.', unknown, 131072, { ...options, extraInputTokens: 200 });
  assert.equal(small.envelope, 'estimated-opencode-runtime');
  assert.equal(small.envelopeReservedTokens, 2048); assert.equal(small.schemaReservedTokens, 200);
  assert.equal(small.reservedTokens, 6344);
  assert.throws(() => admitLocalContext('Facts.', unknown, 131072, { ...options, extraInputTokens: 2048 }), /context allowance/);
  assert.throws(() => admitLocalContext('Facts.', unknown, 131072, { ...options, extraInputTokens: -1 }), /schema reserve/);
  assert.throws(() => admitLocalContext('Facts.', unknown, 131072, { ...options, images: ['/missing.png'] }), /image context cannot be admitted/);
});

const qwen35: ModelIdentity = { ...identity, model: 'qwen3.5-harness-16k:4b', digest: 'bae64a0a06284f403c2929b1024dad7627296e5d29628f332afb7c53ad695a09', context: { mode: 'installed-model-default', tokens: 16384, proof: 'model-parameter' } };
const qwen35Manifest = join(homedir(), '.ollama/models/manifests/registry.ollama.ai/library/qwen3.5-harness-16k/4b');
const installed35 = !!python && existsSync(qwen35Manifest) && createHash('sha256').update(readFileSync(qwen35Manifest)).digest('hex') === qwen35.digest;

test('installed Qwen3.5 measures text, with distinct Ollama and OpenCode envelope reserves', { skip: !installed35 }, () => {
  const prompt = 'Hello, world! नमस्ते தமிழ் 1234';
  const direct = admitLocalContext(prompt, qwen35, 131072, options);
  assert.equal(direct.inputUnits, 15); assert.equal(direct.method, 'measured-text-with-reserves');
  assert.equal(direct.tokenizer?.method, 'installed-gguf-qwen35-text');
  assert.equal(direct.tokenizer?.templateSha256, 'a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715');
  assert.equal(direct.envelopeReservedTokens, 256);
  const cli = admitLocalContext(prompt, { ...qwen35, provider: 'opencode', model: 'ollama/' + qwen35.model, runtimeVersion: 'OpenCode 1.18.25; Ollama 0.34.0' }, 131072, options);
  assert.equal(cli.inputUnits, direct.inputUnits); assert.equal(cli.envelopeReservedTokens, 2048);
  assert.equal(cli.envelope, 'estimated-opencode-runtime');
  assert.equal(cli.reservedTokens, 6144);
  assert.equal(countInstalledLocalTokens(prompt, { ...qwen35, digest: '0'.repeat(64) }, options).count, undefined);
});

test('installed Qwen3.5 image reserve is hash bound and cannot bypass the context limit', { skip: !installed35 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-token-image-'));
  try {
    const path = join(dir, 'pixel.png');
    writeFileSync(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    const receipt = admitLocalContext('Read this image.', qwen35, 131072, { ...options, images: [path] });
    assert.equal(receipt.imageReservedTokens, 1088);
    assert.equal(receipt.tokenizer?.images?.[0]?.sha256, createHash('sha256').update(readFileSync(path)).digest('hex'));
    assert.throws(() => admitLocalContext('Read this image.', { ...qwen35, context: { ...qwen35.context, tokens: 5300 } }, 131072, { ...options, images: [path] }), /context allowance/);
    writeFileSync(path, 'not an image');
    assert.throws(() => admitLocalContext('Read this image.', qwen35, 131072, { ...options, images: [path] }), /image context cannot be admitted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('actual recorded Qwen initial and repair packets use exact template-bound token counts', { skip: !installed || !process.env.HARNESS_TOKENIZER_REPLAY_DIR }, () => {
  const dir = process.env.HARNESS_TOKENIZER_REPLAY_DIR!;
  const first = readFileSync(join(dir, 'prompt-1.txt'), 'utf8'), repair = readFileSync(join(dir, 'prompt-2.txt'), 'utf8');
  assert.equal(createHash('sha256').update(first).digest('hex'), '780ffaae99a9fa3e5feeab10de988839a46c2acd025915364ef2c5893e1268d2');
  assert.equal(createHash('sha256').update(repair).digest('hex'), '318569582e2ece380ee1a346ee3abf06cc18214e5a6d948994b64bcc7e020080');
  const initial = admitLocalContext(first, identity, 131072, options);
  assert.equal(initial.method, 'exact-installed-tokenizer'); assert.equal(initial.inputUnits, 4394); // Actual saved provider usage.
  const admitted = admitLocalContext(repair, identity, 131072, options);
  assert.equal(admitted.packetBytes, 30873); assert.equal(admitted.inputUnits, 7541);
  assert.equal(admitted.inputUnits + admitted.reservedTokens, 11637);
  assert.equal(admitted.tokenizer?.manifestDigest, identity.digest);
  assert.equal(admitted.tokenizer?.tokenizersVersion, '0.22.2');
  assert.equal(admitted.tokenizer?.transformersVersion, '5.15.0');
  assert.equal(admitted.tokenizer?.metadataSha256, 'd14130bc1f61980da9888547db50af128ed4ac555c13f604218442ac0bb4a3c6');
});

test('exact tokenizer still rejects real token overflow and bounded packet overflow', { skip: !installed }, () => {
  const text = ' 1'.repeat(15000); // Qwen separates each digit and preceding space: more than 28,672 input tokens.
  const measured = countInstalledLocalTokens(text, identity, options);
  assert.ok(measured.count, measured.unavailable); assert.ok(measured.count.inputTokens > 28672);
  assert.throws(() => admitLocalContext(text, identity, 131072, options), /measured input tokens/);
  assert.throws(() => admitLocalContext('a'.repeat(131073), identity, 131072, options), /bounded packet/);
});

test('changed model digest and unverified normalization never gain exact admission', { skip: !installed }, () => {
  assert.match(countInstalledLocalTokens('Facts.', { ...identity, digest: '0'.repeat(64) }, options).unavailable!, /manifest differs/);
  const value = countInstalledLocalTokens('Cafe\u0301.', identity, options);
  assert.equal(value.count, undefined); assert.match(value.unavailable!, /Non-NFC/);
  assert.equal(countInstalledLocalTokens('Facts.', { ...identity, reasoningEffort: 'high' }, options).count, undefined);
  assert.equal(countInstalledLocalTokens('Facts.', { ...identity, runtimeVersion: 'unverified' }, options).count, undefined);
});
