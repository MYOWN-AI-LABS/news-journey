import assert from "node:assert/strict";
import test from "node:test";
import { assertLocalOllamaAvailable, ollamaPreflight, localModelsSnapshot, ollamaOrigin, parseOllamaTags, readLocalModelIdentity, writerCanReadImages } from "./local-models.js";
import { sameModelIdentity } from "./model-identity.js";

test("local availability checks resolve the requested alias through metadata, cache success, and leave cloud transports alone", async () => {
  let calls = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), "http://127.0.0.1:19991/ollama/api/show");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal instanceof AbortSignal);
    // No exact /api/tags comparison: Ollama can resolve a name without :latest or a custom alias itself.
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "my-qwen" });
    return new Response(JSON.stringify({ capabilities: ["completion"] }));
  }) as typeof fetch;
  await Promise.all([assertLocalOllamaAvailable("http://127.0.0.1:19991/ollama/v1", "my-qwen", 20000, fetcher), assertLocalOllamaAvailable("http://127.0.0.1:19991/ollama/v1", "my-qwen", 20000, fetcher)]);
  await assertLocalOllamaAvailable("http://127.0.0.1:19991/ollama/v1", "my-qwen", 20000, fetcher);
  assert.equal(calls, 1, "concurrent and recent successful metadata checks are reused");
  await assertLocalOllamaAvailable("http://127.0.0.1:19991/ollama/v1", "my-qwen", 0, fetcher);
  assert.equal(calls, 2, "a forced check bypasses a completed success");
  const forbidden = (async () => { throw new Error("Cloud transport must not request local model metadata"); }) as typeof fetch;
  for (const model of ["gpt-oss:120b-cloud", "qwen:cloud"]) await assertLocalOllamaAvailable("http://127.0.0.1:19991/v1", model, 0, forbidden);
  await assertLocalOllamaAvailable("https://ollama.example.org/v1", "qwen", 0, forbidden);
});

test("missing, unavailable, and malformed local metadata fail clearly and can be retried immediately", async () => {
  const base = "http://localhost:19990/v1";
  for (const [status, expected] of [[404, /not found.*HTTP 404/], [503, /Could not verify.*HTTP 503/]] as const) {
    await assert.rejects(assertLocalOllamaAvailable(base, "qwen", 20000, (async () => new Response('{}', { status })) as typeof fetch), expected);
  }
  for (const body of ["not JSON", "null", "[]", "{}", '{"error":"unavailable","capabilities":[]}']) {
    await assert.rejects(assertLocalOllamaAvailable(base, "qwen", 20000, (async () => new Response(body)) as typeof fetch), /invalid metadata/);
  }
  await assert.rejects(assertLocalOllamaAvailable(base, "qwen", 20000, (async () => { throw new TypeError("fetch failed"); }) as typeof fetch), /could not be reached.*Start Ollama.*Hosted rescue was not started/);
  let calls = 0;
  await assertLocalOllamaAvailable(base, "qwen", 20000, (async () => { calls++; return new Response('{"details":{"family":"qwen2"}}'); }) as typeof fetch);
  assert.equal(calls, 1, "neither failures nor older Ollama metadata prevent a retry after installation/restart");
});

test("only a loopback Ollama is listed, tags are parsed defensively, and the snapshot refreshes in the background", async () => {
  assert.equal(ollamaOrigin("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434");
  assert.equal(ollamaOrigin("http://localhost:11434/v1"), "http://localhost:11434");
  assert.equal(ollamaOrigin("https://ollama.example.com/v1"), null);
  assert.equal(ollamaOrigin("not a url"), null);
  assert.deepEqual(parseOllamaTags({ models: [{ name: "qwen3:8b", size: 5.2e9, modified_at: "2026-09-09T00:00:00Z" }, { name: "bad name with spaces" }, { name: 7 }, { name: "llama3.2" }] }), [
    { name: "llama3.2", sizeGb: null, modifiedAt: null, digest: null }, { name: "qwen3:8b", sizeGb: 5.2, modifiedAt: "2026-09-09T00:00:00Z", digest: null },
  ]);
  assert.deepEqual(parseOllamaTags(null), []); assert.deepEqual(parseOllamaTags({ models: "x" }), []);
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response(JSON.stringify({ models: [{ name: "qwen3:8b", size: 5e9 }] }), { status: 200 }); }) as unknown as typeof fetch;
  const first = localModelsSnapshot("http://127.0.0.1:19999/v1", 0, fetcher);
  assert.equal(first.available, null, "the first read reports checking; the fetch runs in the background");
  await new Promise(r => setTimeout(r, 20));
  const second = localModelsSnapshot("http://127.0.0.1:19999/v1", 60000, fetcher);
  assert.equal(second.available, true); assert.deepEqual(second.models.map(m => m.name), ["qwen3:8b"]); assert.equal(calls, 1);
  const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  localModelsSnapshot("http://localhost:19998/v1", 0, down); await new Promise(r => setTimeout(r, 20));
  const offline = localModelsSnapshot("http://localhost:19998/v1", 60000, down);
  assert.equal(offline.available, false); assert.match(offline.error!, /not running/);
  assert.equal(localModelsSnapshot("https://api.example.com/v1").available, false);
});

test("writer image capability trusts cloud writers and rescue, while Ollama uses one cached bounded /api/show check", async () => {
  let calls = 0;
  const vision = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), "http://127.0.0.1:19997/api/show");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "llava:7b" });
    return new Response(JSON.stringify({ capabilities: ["completion", "vision"] }), { status: 200 });
  }) as typeof fetch;
  for (const provider of ["claude", "codex", "gemini", "grok", "zai"]) assert.equal(await writerCanReadImages({ provider }), true);
  assert.equal(await writerCanReadImages({ provider: "openai-compatible", rescueEnabled: true }), true);
  assert.equal(await writerCanReadImages({ provider: "ollama", model: "qwen3:8b", rescueEnabled: true }), true);
  assert.equal(await writerCanReadImages({ provider: "openai-compatible" }), false);
  const ollama = { provider: "ollama", model: "llava:7b", baseUrl: "http://127.0.0.1:19997/v1" };
  assert.equal(await writerCanReadImages(ollama, 60000, vision), true);
  assert.equal(await writerCanReadImages(ollama, 60000, vision), true); assert.equal(calls, 1, "the model capability is cached");
  assert.equal(await writerCanReadImages({ ...ollama, provider: 'opencode', model: 'ollama/llava:7b' }, 0, vision), true);
  assert.equal(await writerCanReadImages({ provider: 'opencode', model: 'opencode/example-free' }, 0, vision), false);
  assert.equal(await writerCanReadImages({ provider: 'opencode', model: 'ollama/vision:cloud' }, 0, vision), false);
  const textOnly = (async () => new Response(JSON.stringify({ capabilities: ["completion"] }), { status: 200 })) as typeof fetch;
  assert.equal(await writerCanReadImages({ provider: "ollama", model: "qwen3:8b", baseUrl: "http://127.0.0.1:19996/v1" }, 60000, textOnly), false);
  assert.equal(await writerCanReadImages({ provider: 'opencode', model: 'ollama/qwen3:8b' }, 0, textOnly), false);
  const remote = (async () => new Response(JSON.stringify({ capabilities: ['vision'], remote_model: 'vision' }))) as typeof fetch;
  assert.equal(await writerCanReadImages({ provider: 'opencode', model: 'ollama/vision:4b' }, 0, remote), false);
});

test("preflight reports thinking capability and cloud location without requesting inference", async () => {
  const fetcher = (async (url: string | URL | Request) => {
    assert.match(String(url), /api\/show$/);
    return new Response(JSON.stringify({ capabilities: ["completion", "thinking"], details: { family: "qwen3" } }));
  }) as typeof fetch;
  assert.match(await ollamaPreflight("http://localhost:11434/v1", "qwen3:8b", fetcher), /think:false/);
  assert.match(await ollamaPreflight("http://localhost:11434/v1", "example:cloud", fetcher), /Cloud inference/);
});


test('all passive metadata paths cap actual bytes and cancel oversized streams', async () => {
  let cancelled = 0;
  const oversized = (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(262145)); }, cancel() { cancelled++; } }))) as typeof fetch;
  await assert.rejects(assertLocalOllamaAvailable('http://127.0.0.1:19880/v1', 'writer:7b', 0, oversized), /invalid metadata/);
  assert.equal(await writerCanReadImages({ provider: 'ollama', model: 'writer:7b', baseUrl: 'http://127.0.0.1:19881/v1' }, 0, oversized), false);
  assert.match(await ollamaPreflight('http://127.0.0.1:19882/v1', 'writer:7b', oversized), /could not be checked/);
  localModelsSnapshot('http://127.0.0.1:19883/v1', 0, oversized); await new Promise(r => setTimeout(r, 20));
  assert.equal(localModelsSnapshot('http://127.0.0.1:19883/v1', 60000, oversized).available, false);
  assert.equal(cancelled, 4);
});

test('OpenCode local identity records its effective nonthinking setting and rejects conflicting requests before metadata', async () => {
  let calls = 0;
  const fetcher = (async (url: string | URL | Request) => {
    calls++;
    const path = new URL(String(url)).pathname;
    assert.ok(['/api/tags', '/api/show', '/api/version'].includes(path), 'identity never starts inference');
    const value = path === '/api/tags' ? { models: [{ name: 'writer:4b', digest: 'a'.repeat(64) }] }
      : path === '/api/show' ? { capabilities: ['completion', 'thinking'], parameters: 'num_ctx 8192', details: { format: 'gguf', quantization_level: 'Q4_K_M' } }
      : { version: '0.34.0' };
    return new Response(JSON.stringify(value));
  }) as typeof fetch;
  const options = { hardwareFingerprint: 'b'.repeat(64), runtimeVersion: '1.18.25' };
  const current = await readLocalModelIdentity('opencode', 'ollama/writer:4b', 'http://127.0.0.1:11434/v1', options, fetcher);
  assert.equal(current.reasoningEffort, 'none');
  assert.deepEqual(current.context, { mode: 'installed-model-default', tokens: 8192, proof: 'model-parameter' });
  const explicit = await readLocalModelIdentity('opencode', 'ollama/writer:4b', 'http://127.0.0.1:11434/v1', { ...options, reasoningEffort: 'none' }, fetcher);
  assert.equal(sameModelIdentity(current, explicit), true);
  assert.equal(sameModelIdentity(current, { ...current, reasoningEffort: undefined }), false, 'the old default profile cannot inherit this result');
  const before = calls;
  await assert.rejects(readLocalModelIdentity('opencode', 'ollama/writer:4b', 'http://127.0.0.1:11434/v1', { ...options, reasoningEffort: 'high' }, fetcher), /different requested setting is unsupported/);
  assert.equal(calls, before);
  const direct = await readLocalModelIdentity('ollama', 'writer:4b', 'http://127.0.0.1:11434/v1', { ...options, contextTokens: 4096, reasoningEffort: 'high' }, fetcher);
  assert.equal(direct.reasoningEffort, 'high', 'direct Ollama keeps its separately configured setting');
  assert.deepEqual(direct.context, { mode: 'requested', tokens: 4096, proof: 'request' });
});
