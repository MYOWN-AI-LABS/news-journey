import assert from 'node:assert/strict';
import test from 'node:test';
import { hasMeasuredModelIdentity, sameModelIdentity, modelIdentityKey, type ModelIdentity } from './model-identity.js';
import { readLocalModelIdentity, parseOllamaTags, assertLocalOllamaAvailable } from './local-models.js';

const identity: ModelIdentity = { provider: 'ollama', model: 'writer:7b', baseUrl: 'http://127.0.0.1:11434/v1', digest: 'a'.repeat(64), context: { mode: 'requested', tokens: 8192, proof: 'request' }, runtimeVersion: '0.12.0', hardwareFingerprint: 'b'.repeat(64), protocolVersion: 1 };
test('only exact measured runtime identity can carry a current qualification', () => {
  assert.ok(hasMeasuredModelIdentity(identity)); assert.ok(sameModelIdentity(identity, structuredClone(identity)));
  for (const change of [{ digest: 'c'.repeat(64) }, { model: 'writer:14b' }, { provider: 'opencode' }, { runtimeVersion: '0.13.0' }, { hardwareFingerprint: 'c'.repeat(64) }, { context: { ...identity.context, tokens: 16384 } }]) {
    assert.notEqual(modelIdentityKey(identity), modelIdentityKey({ ...identity, ...change })); assert.equal(sameModelIdentity(identity, { ...identity, ...change }), false);
  }
  for (const change of [{ digest: null }, { runtimeVersion: null }, { hardwareFingerprint: '' }, { protocolVersion: 0 }, { context: { ...identity.context, tokens: null, proof: 'unknown' as const } }]) assert.equal(hasMeasuredModelIdentity({ ...identity, ...change }), false);
});

test('local metadata pins digest and actual context without requesting inference', async () => {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; calls.push(path); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    return Response.json(path === '/api/tags' ? { models: [{ name: 'writer:7b', digest: 'sha256:' + 'a'.repeat(64) }] } : path === '/api/show' ? { capabilities: ['completion'], parameters: 'num_ctx 4096\ntemperature 0.2' } : { version: '0.12.0' });
  }) as typeof fetch;
  const direct = await readLocalModelIdentity('ollama', 'writer:7b', identity.baseUrl, { contextTokens: 8192, hardwareFingerprint: identity.hardwareFingerprint }, fetcher);
  assert.deepEqual(direct, identity);
  const openCode = await readLocalModelIdentity('opencode', 'ollama/writer:7b', identity.baseUrl, { contextTokens: 16384, runtimeVersion: '1.4.0', hardwareFingerprint: identity.hardwareFingerprint }, fetcher);
  assert.deepEqual(openCode.context, { mode: 'installed-model-default', tokens: 4096, proof: 'model-parameter' });
  assert.equal(openCode.runtimeVersion, 'OpenCode 1.4.0; Ollama 0.12.0');
  assert.ok(calls.every(path => ['/api/tags', '/api/show', '/api/version'].includes(path)));
  assert.equal(parseOllamaTags({ models: [{ name: 'writer:7b', digest: 'fake' }] })[0].digest, null);
});

test('missing context remains unknown and unsafe or oversized metadata fails closed', async () => {
  const fetcher = (async (url: string | URL | Request) => Response.json(String(url).endsWith('/api/tags') ? { models: [{ name: 'writer:7b', digest: 'a'.repeat(64) }] } : String(url).endsWith('/api/show') ? { capabilities: ['completion'] } : { version: '0.12.0' })) as typeof fetch;
  const unknown = await readLocalModelIdentity('opencode', 'ollama/writer:7b', identity.baseUrl, { runtimeVersion: '1.4.0', hardwareFingerprint: identity.hardwareFingerprint }, fetcher);
  assert.equal(unknown.context.tokens, null); assert.equal(hasMeasuredModelIdentity(unknown), false);
  let calls = 0; const blocked = (async () => { calls++; throw new Error('must not call'); }) as typeof fetch;
  for (const [model, endpoint] of [['writer:cloud', identity.baseUrl], ['writer:7b', 'https://gpu.example/v1']]) await assert.rejects(readLocalModelIdentity('ollama', model, endpoint, { hardwareFingerprint: '' }, blocked), /installed local/);
  assert.equal(calls, 0);
  await assert.rejects(readLocalModelIdentity('ollama', 'writer:7b', identity.baseUrl, { hardwareFingerprint: '' }, (async () => new Response('x'.repeat(262145))) as typeof fetch), /256 KiB/);
});


test('OpenCode needs both exact runtime versions, never an unknown placeholder', async () => {
  const fetcher = (async (url: string | URL | Request) => Response.json(String(url).endsWith('/api/tags') ? { models: [{ name: 'writer:7b', digest: 'a'.repeat(64) }] } : String(url).endsWith('/api/show') ? { capabilities: ['completion'], parameters: 'num_ctx 8192' } : {})) as typeof fetch;
  const result = await readLocalModelIdentity('opencode', 'ollama/writer:7b', identity.baseUrl, { runtimeVersion: '1.4.0', hardwareFingerprint: identity.hardwareFingerprint }, fetcher);
  assert.equal(result.runtimeVersion, null); assert.equal(hasMeasuredModelIdentity(result), false);
});


test('cloud aliases cannot masquerade as local models through a benign tag name', async () => {
  const remote = { name: 'writer:7b', digest: 'a'.repeat(64), remote_host: 'https://ollama.com', remote_model: 'hosted-writer' };
  assert.equal(parseOllamaTags({ models: [remote] })[0].remote, true);
  for (const origin of ['tags', 'show']) {
    const fetcher = (async (url: string | URL | Request) => Response.json(String(url).endsWith('/api/tags') ? { models: [origin === 'tags' ? remote : { name: remote.name, digest: remote.digest }] } : String(url).endsWith('/api/show') ? { capabilities: ['completion'], parameters: 'num_ctx 8192', ...(origin === 'show' ? { remote_host: remote.remote_host } : {}) } : { version: '0.12.0' })) as typeof fetch;
    await assert.rejects(readLocalModelIdentity('ollama', remote.name, identity.baseUrl, { contextTokens: 8192, hardwareFingerprint: identity.hardwareFingerprint }, fetcher), /remote alias/);
  }
  await assert.rejects(assertLocalOllamaAvailable(identity.baseUrl, remote.name, 0, (async () => Response.json({ capabilities: ['completion'], remote_model: 'hosted-writer' })) as typeof fetch), /remote alias/);
});
