import {mkdtempSync,writeFileSync,rmSync,readFileSync,existsSync,chmodSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,delimiter} from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from 'node:child_process';
import test, { after } from "node:test";
import { CODE_ROOT, createWorkspace } from "../workspaces.js";
import type { ModelConfig } from "./model.js";
import { withJsonOutputContract, jsonOutputContract, type JsonOutputSchema } from './json-output-contract.js';

// Model call/recovery receipts must never enter the operator's active workspace.
const testIdentity = mkdtempSync(join(tmpdir(), 'model-test-identity-'));
const priorWorkspace = process.env.HARNESS_WORKSPACE, priorIdentity = process.env.HARNESS_IDENTITY_FILE, priorToken = process.env.HARNESS_TOKEN;
delete process.env.HARNESS_WORKSPACE; delete process.env.HARNESS_TOKEN;
process.env.HARNESS_IDENTITY_FILE = join(testIdentity, 'identity.json');
const testSlug = 'model-test-' + process.pid, testRoot = createWorkspace(testSlug, false, CODE_ROOT);
process.env.HARNESS_WORKSPACE = testSlug;
const { claudeResult, extractJson, parseModelJson, invokeModelText, invokeClaudeWebText, modelJson, modelVisionJson, resolveModelRuntime, remainingHostedRescueCalls, modelCanReadImages } = await import('./model.js');
const rescueBudgetDir = join(testRoot, 'state/model-rescue');
after(() => {
  rmSync(testRoot, { recursive: true, force: true }); rmSync(testIdentity, { recursive: true, force: true });
  for (const [key, value] of Object.entries({ HARNESS_WORKSPACE: priorWorkspace, HARNESS_IDENTITY_FILE: priorIdentity, HARNESS_TOKEN: priorToken })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const config: ModelConfig = {
  provider: "claude",
  timeoutSeconds: 5,
  providers: {
    claude: { command: "claude" },
    zai: { baseUrl: "https://api.z.ai/api/paas/v4", model: "glm-5.1" },
    grok: { baseUrl: "https://api.x.ai/v1", model: "grok-4.5" },
    gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.6-flash" },
    ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:7b" },
    openaiCompatible: { baseUrl: "http://127.0.0.1:9999/v1", model: "example-model", reasoningEffort: "none" },
  },
};

test('local failures hand validated work and images to bounded CLI rescue while every new task starts locally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-rescue-')), audit = join(dir, 'audit.jsonl');
  const previousPath = process.env.PATH, previousHome = process.env.CODEX_HOME;
  process.env.PATH = dir + delimiter + (previousPath || ''); process.env.CODEX_HOME = dir;
  const scripts = ['rescue-codex', 'rescue-claude'];
  for (const name of scripts) {
    writeFileSync(join(dir, name + '.js'), `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{
fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify({name:${JSON.stringify(name)},args,prompt})+'\\n');
if(prompt.includes('all unavailable')||(${JSON.stringify(name)}==='rescue-codex'&&prompt.includes('codex unavailable'))){console.error('fixture login or quota unavailable');process.exitCode=1;return;}
const answer=JSON.stringify({ok:true});if(${JSON.stringify(name)}==='rescue-codex'){fs.writeFileSync(args[args.indexOf('--output-last-message')+1],answer);console.log(JSON.stringify({type:'turn.completed',usage:{}}));}else console.log(JSON.stringify({result:answer}));});
`);
    chmodSync(join(dir, name + '.js'), 0o700); writeFileSync(join(dir, name + '.cmd'), `@echo off\r\nset "dp0=%~dp0"\r\n"${process.execPath}" "%dp0%/${name}.js" %*\r\n`);
  }
  const counts = new Map<string, number>(), bodies: any[] = [];
  let removedDuringCall = false, removedAfterRescue = false;
  const server = createServer((request, response) => {
    const path = request.url!; counts.set(path, (counts.get(path) || 0) + 1);
    let body = ''; request.on('data', b => body += b); request.on('end', () => {
      if (path.endsWith('/api/show')) {
        if (path.includes('missing') || path.includes('removed-during-call') && removedDuringCall || path.includes('removed-after-rescue') && removedAfterRescue) { response.writeHead(404); return response.end('{"error":"model not found"}'); }
        if (path.includes('metadata-unavailable')) { response.writeHead(503); return response.end('{}'); }
        return response.end('{"capabilities":["completion"]}');
      }
      bodies.push(JSON.parse(body));
      if (path.includes('removed-during-call')) { removedDuringCall = true; response.writeHead(404); return response.end('{"error":"model not found"}'); }
      if (path.includes('timeout')) return;
      if (path.includes('unavailable')) { response.writeHead(503); return response.end('fixture unavailable'); }
      if (path.includes('stream-error')) { response.write(JSON.stringify({ message: { content: '{"ok"' }, done: false }) + '\n'); return response.end(JSON.stringify({ error: 'model runner crashed' }) + '\n'); }
      if (path.endsWith('/api/chat')) { // Ollama's native streaming reply: one JSON object per line, thinking kept apart from the answer
        response.write(JSON.stringify({ message: { content: '', thinking: 'weighing {"ok":true}' }, done: false }) + '\n');
        return response.end(JSON.stringify({ message: { content: '{"ok":false}' }, done: false }) + '\n' + JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 12, eval_count: 5 }) + '\n');
      }
      response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":false}' } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const settings: ModelConfig = { provider: 'ollama', timeoutSeconds: 1, rescue: { enabled: true, localTimeoutSeconds: 1, maxCallsPerDay: 10 }, providers: {
    ollama: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'local-fixture' },
    codex: { command: process.platform === 'win32' ? scripts[0] : join(dir, scripts[0] + '.js'), model: 'rescue-fixture-model' },
    claude: { command: process.platform === 'win32' ? scripts[1] : join(dir, scripts[1] + '.js') },
  } };
  const env = (path: string) => ({ AI_CONTENT_MODEL_PROVIDER: 'ollama', AI_CONTENT_MODEL_NAME: 'must-stay-local', AI_CONTENT_MODEL_BASE_URL: `http://127.0.0.1:${port}/${path}/v1` });
  const valid = (value: { ok: boolean }) => value.ok === true ? null : 'script too long: 247 words, limit 225';
  const auditRows = () => existsSync(audit) ? readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  try {
    await assert.rejects(modelJson('Missing selected model', valid, settings, env('missing')), /Selected Ollama model "must-stay-local" was not found/);
    await assert.rejects(invokeModelText('Ollama metadata unavailable', settings, env('metadata-unavailable')), /Could not verify.*HTTP 503/);
    assert.equal(counts.get('/missing/api/chat'), undefined);
    assert.equal(counts.get('/metadata-unavailable/api/chat'), undefined);
    assert.equal(auditRows().length, 0, 'an unavailable selected model must not send any source material to rescue agents');
    await assert.rejects(modelJson('Removed after a successful preflight', valid, settings, env('removed-during-call')), /was not found/);
    assert.equal(counts.get('/removed-during-call/api/show'), 2, 'removal during the cache window forces a fresh check before handover');
    assert.equal(counts.get('/removed-during-call/api/chat'), 1);
    assert.equal(auditRows().length, 0, 'a model removed during inference must not cause hosted substitution');
    bodies.length = 0;
    assert.deepEqual(await modelJson('Keep the source facts', valid, settings, env('invalid')), { ok: true });
    assert.equal(counts.get('/invalid/api/chat'), 2);
    // Ollama goes through its own chat API with the context window set: /v1 ignores num_ctx and loads at 4096 tokens.
    assert.equal(bodies[0].options.num_ctx, 16384); assert.equal(bodies[0].stream, true); assert.equal(bodies[0].model, 'must-stay-local');
    assert.equal(bodies[0].format, 'json');
    await invokeModelText('Plain text request', { ...settings, rescue: { enabled: false } }, env('text'));
    assert.equal(bodies.at(-1).format, undefined, 'ordinary text is not constrained to JSON');
    await modelJson('Cloud JSON request', undefined, { ...settings, rescue: { enabled: false } }, { ...env('cloud'), AI_CONTENT_MODEL_NAME: 'gpt-oss:120b-cloud' });
    assert.equal(bodies.at(-1).format, undefined, 'Ollama cloud does not support structured output');
    const first = auditRows()[0]; assert.match(first.prompt, /Keep the source facts/); assert.match(first.prompt, /Validation error:/); assert.match(first.prompt, /script too long: 247/);
    assert.ok(!first.prompt.includes('{"ok":false}'), 'optional rescue receives the full task and feedback, not the malformed local answer');
    assert.ok(first.args.includes('rescue-fixture-model')); assert.ok(!first.args.includes('must-stay-local')); assert.ok(first.args.includes('features.shell_tool=false'));
    await modelJson('Next step in this draft', valid, settings, env('invalid')); assert.equal(counts.get('/invalid/api/chat'), 4, 'a successful rescue must never pin later tasks to the hosted writer');
    await modelJson('First stage before removal', valid, settings, env('removed-after-rescue'));
    const afterFirstRescue = auditRows().length;
    removedAfterRescue = true;
    await assert.rejects(modelJson('Next stage after removal', valid, settings, env('removed-after-rescue')), /was not found/);
    assert.equal(auditRows().length, afterFirstRescue, 'each new task rechecks availability before sending another stage');
    assert.equal(counts.get('/removed-after-rescue/api/chat'), 2, 'the first stage retried locally; the second stage stopped at metadata');
    assert.deepEqual(await modelJson('codex unavailable', valid, settings, env('unavailable')), { ok: true });
    const claude = auditRows().at(-1); assert.equal(claude.name, 'rescue-claude'); assert.ok(claude.args.includes('--strict-mcp-config')); assert.equal(claude.args[claude.args.indexOf('--tools') + 1], '');
    const picture = join(dir, 'frame.png'); writeFileSync(picture, Buffer.from('89504e470d0a1a0a', 'hex'));
    await modelVisionJson('Review actual pixels', [picture], valid, settings, env('vision')); assert.ok(auditRows().at(-1).args.includes(picture));
    await modelJson('A stalled local request', valid, settings, env('timeout')); assert.equal(counts.get('/timeout/api/chat'), 1);
    await assert.rejects(modelJson('all unavailable', valid, settings, env('all-unavailable')), /Local generation and agent rescue failed/);
    const before = auditRows().length;
    await assert.rejects(modelJson('Local only', valid, { ...settings, rescue: { enabled: false } }, env('opt-out')), /failed after retry/);
    // a beta tester, Sep 10: a local model past its deadline said only "This operation was aborted". It now says who and how long, and the call is recorded.
    await assert.rejects(modelJson('Local only and slow', valid, { ...settings, rescue: { enabled: false } }, env('timeout-alone')), /Ollama must-stay-local did not answer within 1 s\. Local models that think before answering/);
    const calls = readFileSync(join(testRoot, 'state/model-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.at(-1).status, 'timeout'); assert.equal(calls.at(-1).model, 'must-stay-local');
    await assert.rejects(modelJson('Crashes mid-reply', valid, { ...settings, rescue: { enabled: false } }, env('stream-error')), /Ollama must-stay-local: model runner crashed/);
    assert.equal(auditRows().length, before);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(rescueBudgetDir, { recursive: true, force: true });
  }
});

test('hosted rescue has a durable workspace daily cap across corrections, failed calls, retries and concurrent workers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rescue-budget-')), audit = join(dir, 'calls.jsonl');
  for (const name of ['codex', 'claude']) {
    const script = `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{
fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify({provider:${JSON.stringify(name)},prompt})+'\\n');
if(prompt.includes('hosted failure')){console.error('fixture account unavailable');process.exitCode=1;return;}
if(prompt.includes('hosted timeout')&&${JSON.stringify(name)}==='codex'){setInterval(()=>{},1000);return;}
const answer=JSON.stringify({ok:!prompt.includes('hosted invalid')});
if(${JSON.stringify(name)}==='codex'){fs.writeFileSync(args[args.indexOf('--output-last-message')+1],answer);console.log(JSON.stringify({type:'turn.completed',usage:{}}));}else console.log(JSON.stringify({result:answer}));});
`;
    writeFileSync(join(dir, `${name}.js`), script); chmodSync(join(dir, `${name}.js`), 0o700);
    writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\nset "dp0=%~dp0"\r\n"${process.execPath}" "%dp0%/${name}.js" %*\r\n`);
  }
  let localCalls = 0;
  const server = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      if (request.url === '/api/show') return response.end('{"capabilities":["completion"]}');
      localCalls++;
      response.end(JSON.stringify({ message: { content: '{"ok":false}' }, done: true }) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const settings: ModelConfig = { provider: 'ollama', timeoutSeconds: 1, rescue: { enabled: true, localTimeoutSeconds: 1 }, providers: {
    ollama: { baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, model: 'budget-local' },
    codex: { command: join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex.js'), model: 'budget-hosted' },
    claude: { command: join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude.js'), model: 'budget-hosted' },
  } };
  const valid = (value: { ok: boolean }) => value.ok ? null : 'fixture output invalid';
  const auditRows = () => existsSync(audit) ? readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const clearBudget = () => { rmSync(rescueBudgetDir, { recursive: true, force: true }); rmSync(audit, { force: true }); };
  const child = (prompt: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const script = `import {modelJson} from ${JSON.stringify(new URL('./model.js', import.meta.url).href)};
try {await modelJson(${JSON.stringify(prompt)},value=>value.ok?null:'fixture output invalid',${JSON.stringify(settings)},{});console.log('child completed');}catch(error){console.error(error.message);process.exitCode=1;}`;
    const worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: CODE_ROOT, env: { ...process.env } });
    let output = ''; worker.stdout.on('data', data => output += data); worker.stderr.on('data', data => output += data);
    worker.on('error', reject); worker.on('close', code => resolve({ code, output }));
  });
  try {
    clearBudget();
    assert.equal(remainingHostedRescueCalls(settings), 2);
    for (const invalid of [-1, 11, 1.5, Infinity, NaN]) assert.throws(() => remainingHostedRescueCalls({ ...settings, rescue: { enabled: true, maxCallsPerDay: invalid } }), /whole number/);
    assert.equal(remainingHostedRescueCalls({ ...settings, rescue: { enabled: false } }), 0);
    assert.equal(await modelCanReadImages(settings, {}), true);
    await modelJson('first stage', valid, settings, {});
    assert.equal(remainingHostedRescueCalls(settings), 1);
    const second = await child('second stage after worker restart'); assert.equal(second.code, 0, second.output);
    const exhausted = await child('retry after worker restart'); assert.equal(exhausted.code, 1); assert.match(exhausted.output, /allowance exhausted/);
    assert.equal(localCalls, 6, 'all three tasks attempted their local JSON request and correction');
    assert.equal(auditRows().length, 2);
    assert.equal(remainingHostedRescueCalls(settings), 0);
    assert.equal(remainingHostedRescueCalls(settings, new Date(Date.now() + 86400000)), 2, 'daily allowance is stored under an explicit Eastern calendar date');
    assert.equal(await modelCanReadImages(settings, {}), false, 'an exhausted fallback cannot advertise image review for a text-only local writer');
    await modelJson('explicit hosted selection', valid, { ...settings, provider: 'codex' }, {});
    assert.equal(auditRows().length, 3, 'an explicitly selected hosted writer is outside the automatic rescue allowance');
    assert.equal(remainingHostedRescueCalls(settings), 0);

    clearBudget();
    await assert.rejects(modelJson('hosted invalid', valid, settings, {}), /allowance exhausted/);
    assert.deepEqual(auditRows().map(row => row.provider), ['codex', 'codex'], 'both corrective calls count; Claude cannot exceed the cap');
    assert.equal(remainingHostedRescueCalls(settings), 0);
    clearBudget();
    await assert.rejects(modelJson('hosted failure', valid, settings, {}), /Local generation and agent rescue failed/);
    assert.deepEqual(auditRows().map(row => row.provider), ['codex', 'claude']);
    assert.equal(remainingHostedRescueCalls(settings), 0, 'failed account attempts are not refunded');
    clearBudget();
    await modelJson('hosted timeout', valid, settings, {});
    assert.deepEqual(auditRows().map(row => row.provider), ['codex', 'claude']);
    assert.equal(remainingHostedRescueCalls(settings), 0, 'timed out requests are not refunded');
    clearBudget();
    await assert.rejects(modelJson('deadline already elapsed', valid, settings, {}, [], true, Date.now() - 1), /time ceiling/);
    assert.equal(auditRows().length, 0); assert.equal(remainingHostedRescueCalls(settings), 2, 'no allowance is consumed without a request');
    await assert.rejects(modelJson('zero allowance', valid, { ...settings, rescue: { enabled: true, maxCallsPerDay: 0 } }, {}), /allowance exhausted/);
    assert.equal(auditRows().length, 0);

    clearBudget();
    const concurrent = await Promise.all(Array.from({ length: 5 }, (_, i) => child(`concurrent stage ${i}`)));
    assert.equal(auditRows().length, 2, JSON.stringify(concurrent));
    assert.equal(concurrent.filter(result => result.code === 0).length, 2);
    assert.equal(remainingHostedRescueCalls(settings), 0, 'parallel processes share the same cap');
    const nextRetry = await child('another retry'); assert.match(nextRetry.output, /allowance exhausted/); assert.equal(auditRows().length, 2);
    writeFileSync(join(rescueBudgetDir, readdirSync(rescueBudgetDir).find(name => name.endsWith('.json'))!), '{"version":1,"attempts":"damaged"}');
    assert.throws(() => remainingHostedRescueCalls(settings), /allowance could not be verified/);
    await assert.rejects(modelJson('retry with damaged allowance receipt', valid, settings, {}), /allowance could not be verified/);
    assert.equal(auditRows().length, 2, 'damaged accounting must fail closed instead of resetting the allowance');
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    clearBudget(); rmSync(dir, { recursive: true, force: true });
  }
});

test('model byte limits include thinking, incomplete stream lines and error bodies without extra attempts or rescue', async () => {
  const original = globalThis.fetch;
  let generated = 0, cancelled = 0;
  let variant = 'unterminated';
  globalThis.fetch = (async (url: any) => {
    if (String(url).endsWith('/api/show')) return Response.json({ capabilities: ['completion'] });
    generated++;
    const block = variant === 'thinking' ? JSON.stringify({ message: { thinking: 'x'.repeat(65500) } }) + '\n' : 'x'.repeat(65536);
    return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode(block)); }, cancel() { cancelled++; } }), { status: variant === 'error' ? 503 : 200 });
  }) as typeof fetch;
  const settings: ModelConfig = { provider: 'ollama', timeoutSeconds: 2, rescue: { enabled: true, maxCallsPerDay: 2 }, providers: { ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'byte-limit-fixture:7b' }, codex: { command: 'must-never-launch' } } };
  try {
    const allowance = remainingHostedRescueCalls(settings);
    for (variant of ['unterminated', 'thinking', 'error']) {
      await assert.rejects(modelJson('Bounded source task', undefined, settings, {}), /4 MiB byte limit/);
    }
    for (variant of ['compatible', 'error']) await assert.rejects(modelJson('Bounded source task', undefined, { provider: 'openai-compatible', providers: { openaiCompatible: { model: 'fixture', baseUrl: 'https://fixture.example/v1' } } }, {}), /4 MiB byte limit/);
    assert.equal(generated, 5); assert.equal(cancelled, 5); assert.equal(remainingHostedRescueCalls(settings), allowance);
  } finally { globalThis.fetch = original; }
});

test('compatible inference refuses redirect destinations before forwarding source content', async () => {
  let originalRequests = 0, redirectedRequests = 0;
  const target = createServer((_request, response) => { redirectedRequests++; response.end('{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}'); });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const server = createServer((_request, response) => { originalRequests++; response.writeHead(307, { location: `http://127.0.0.1:${(target.address() as any).port}/chat/completions` }); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const settings: ModelConfig = { provider: 'openai-compatible', timeoutSeconds: 2, providers: { openaiCompatible: { model: 'redirect-fixture', baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` } } };
    await assert.rejects(modelJson('Private source material stays at the selected endpoint', undefined, settings, {}), /fetch failed/);
    assert.equal(originalRequests, 1); assert.equal(redirectedRequests, 0);
  } finally { await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]); }
});

test('physical attempt hooks count JSON corrections and stop before inference or hosted rescue', async () => {
  const original = globalThis.fetch;
  let physical = 0; const attempts: Array<{ attempt: number; promptBytes: number }> = [];
  globalThis.fetch = (async (url: any) => {
    if (String(url).endsWith('/api/show')) return new Response(JSON.stringify({ capabilities: ['completion'] }));
    physical++;
    return new Response(JSON.stringify({ message: { content: physical === 1 ? '{}' : '{"ok":true}' }, done: true }) + '\n');
  }) as typeof fetch;
  const settings: ModelConfig = { provider: 'ollama', timeoutSeconds: 2, rescue: { enabled: true, maxCallsPerDay: 2 }, providers: { ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'hook-fixture:7b' }, codex: { command: 'must-never-launch' } } };
  try {
    assert.deepEqual(await modelJson('Select IDs', (value: { ok: boolean }) => value.ok ? null : 'need ok', settings, {}, [], true, undefined, { beforeAttempt: attempt => { attempts.push(attempt); } }), { ok: true });
    assert.equal(physical, 2); assert.deepEqual(attempts.map(row => row.attempt), [1, 2]); assert.ok(attempts[1]!.promptBytes > attempts[0]!.promptBytes);
    const allowance = remainingHostedRescueCalls(settings);
    await assert.rejects(modelJson('Caller denied', undefined, settings, {}, [], true, undefined, { beforeAttempt: () => { throw new Error('parent allowance exhausted'); } }), /parent allowance exhausted/);
    assert.equal(physical, 2); assert.equal(remainingHostedRescueCalls(settings), allowance);
    await assert.rejects(modelJson('Expired after hook', undefined, settings, {}, [], true, Date.now() + 10, { beforeAttempt: () => { const end = Date.now() + 20; while (Date.now() < end) {} } }), /time ceiling/);
    assert.equal(physical, 2);
  } finally { globalThis.fetch = original; }
});

test('remote and cloud-tagged Ollama failures do not trigger local rescue', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return new Response('fixture remote unavailable', { status: 503 }); }) as typeof fetch;
  try {
    for (const [baseUrl, model] of [['https://ollama.example/v1', 'remote-model'], ['http://127.0.0.1:11434/v1', 'model-cloud'], ['http://127.0.0.1:11434/v1', 'model-CLOUD']]) {
      const settings: ModelConfig = { ...config, provider: 'ollama', rescue: { enabled: true }, providers: { ...config.providers, codex: { command: 'must-never-launch-codex' }, claude: { command: 'must-never-launch-claude' }, ollama: { baseUrl, model } } };
      await assert.rejects(modelJson('remote failure', undefined, settings, {}), /fixture remote unavailable/);
      assert.equal(remainingHostedRescueCalls(settings), 2);
      assert.equal(await modelCanReadImages(settings, {}), false, 'local fallback cannot advertise image review for a remote runtime');
    }
    assert.equal(requests, 5, 'remote generations run once each; two loopback metadata capability checks do not invoke rescue');
  } finally { globalThis.fetch = original; }
});

test("thinking text never donates braces to the parsed answer", () => {
  assert.equal(extractJson('<think>maybe {"ok":false} or [1]</think>\n{"ok":true}'), '{"ok":true}');
});

test('an unescaped quoted phrase inside a string value is escaped without changing any field; a quote before a comma still rejects', () => {
  const raw = '```json\n{\n  "subject": "x",\n  "lead": {\n    "body": "Boehly called it "an honour" to serve, and left.",\n    "sourceUrl": "https://example.org/a"\n  },\n  "items": []\n}\n```';
  assert.deepEqual(parseModelJson(raw), { subject: 'x', lead: { body: 'Boehly called it "an honour" to serve, and left.', sourceUrl: 'https://example.org/a' }, items: [] });
  assert.throws(() => parseModelJson('{"body": "He said "hi", then left"}'));
});

test('model JSON notation recovery preserves data and rejects executable expressions and non-finite numbers', () => {
  assert.deepEqual(parseModelJson("```json\n{stories: [{area: 'other', verticals: ['residents',],},],}\n```"), { stories: [{ area: 'other', verticals: ['residents'] }] });
  assert.deepEqual(parseModelJson('{"area":"politics","primaryUrl":"https://example.org/source"}'), { area: 'politics', primaryUrl: 'https://example.org/source' });
  assert.throws(() => parseModelJson('{score: Infinity}'), /non-finite/);
  assert.throws(() => parseModelJson('{score: NaN}'), /non-finite/);
  assert.throws(() => parseModelJson('{"score":1e400}'), /non-finite/);
  assert.throws(() => parseModelJson('{"scores":[{"value":-1e400}]}'), /non-finite/);
  assert.throws(() => parseModelJson(String.raw`{path: "C:\models\qwen", formula: "\Delta energy"}`), /unsupported escape/);
  assert.deepEqual(parseModelJson(String.raw`{path: 'C:\\models\\qwen'}`), { path: String.raw`C:\models\qwen` });
  assert.throws(() => parseModelJson('{value: process.exit()}'));
  assert.throws(() => parseModelJson('{"stories": [{"area": "other"}'));
});

test('a complete answer missing only its final closers is closed; cut strings and mismatched closers still fail', () => {
  assert.deepEqual(parseModelJson('{"fields":[{"id":"reason","supported":true,"claimIds":[1],"reason":"x"}]'), { fields: [{ id: 'reason', supported: true, claimIds: [1], reason: 'x' }] });
  assert.deepEqual(parseModelJson('{"edits":[{"id":"kind","text":"diagram"}]'), { edits: [{ id: 'kind', text: 'diagram' }] });
  assert.throws(() => parseModelJson('{"a":{"b":[1,2'), /invalid end of input|Unbalanced/);
  assert.throws(() => parseModelJson('{"fields":[{"id":"reason","reason":"cut mid str'));
  assert.throws(() => parseModelJson('{"a":1]'));
  assert.throws(() => parseModelJson(String.raw`{"path":"C:\q"`));
});

test("model resolver supports all named and generic model providers", () => {
  assert.equal(resolveModelRuntime(config, {}).provider, "claude");
  const claudeHome = mkdtempSync(join(tmpdir(), 'harness-claude-settings-'));
  writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ model: 'claude-fable-5-1[1m]' }));
  assert.equal(resolveModelRuntime(config, { CLAUDE_CONFIG_DIR: claudeHome }).model, 'claude-fable-5-1[1m]', 'the Claude CLI saved default is pinned like Codex');
  assert.equal(resolveModelRuntime(config, { CLAUDE_CONFIG_DIR: claudeHome, AI_CONTENT_MODEL_NAME: 'claude-sonnet-5' }).model, 'claude-sonnet-5', 'an explicit pin still wins');
  assert.equal(resolveModelRuntime(config, { CLAUDE_CONFIG_DIR: join(claudeHome, 'missing') }).model, undefined, 'no saved default pins nothing');
  assert.equal(resolveModelRuntime(config, { AI_CONTENT_MODEL_PROVIDER: "codex" }).command, "codex");
  assert.equal(resolveModelRuntime(config, { AI_CONTENT_MODEL_PROVIDER: "zai", ZAI_API_KEY: "test" }).baseUrl, "https://api.z.ai/api/paas/v4");
  assert.equal(resolveModelRuntime(config, { AI_CONTENT_MODEL_PROVIDER: "grok", XAI_API_KEY: "test" }).model, "grok-4.5");
  assert.equal(resolveModelRuntime(config, { AI_CONTENT_MODEL_PROVIDER: "gemini", GEMINI_API_KEY: "test" }).baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(resolveModelRuntime(config, { AI_CONTENT_MODEL_PROVIDER: "ollama" }).apiKey, "ollama");
  assert.equal(resolveModelRuntime(config, { AI_CONTENT_MODEL_PROVIDER: "openai-compatible" }).model, "example-model");
  assert.throws(() => resolveModelRuntime(config, { AI_CONTENT_MODEL_PROVIDER: "zai" }), /ZAI_API_KEY/);
  assert.equal(resolveModelRuntime(config, { AI_CONTENT_MODEL_PROVIDER: "grok" }).command, "grok");
  const grokCli = resolveModelRuntime({
    ...config,
    provider: "grok",
    timeoutSeconds: 300,
    providers: { ...config.providers, grok: { command: "grok", model: "grok-4.5" } },
  }, {});
  assert.equal(grokCli.provider, "grok");
  assert.equal(grokCli.command, "grok");
  assert.equal(grokCli.model, "grok-4.5");
  assert.equal(grokCli.apiKey, undefined);
  assert.match(grokCli.label, /Grok CLI/);
  assert.equal(grokCli.timeoutMs, 900_000);
  const grokCliExplicit = resolveModelRuntime({
    ...config,
    provider: "grok",
    timeoutSeconds: 120,
    providers: { ...config.providers, grok: { command: "grok", model: "grok-4.5" } },
  }, {});
  assert.equal(grokCliExplicit.timeoutMs, 120_000);
  // Even legacy Grok config without a command must use the CLI.

  assert.throws(() => resolveModelRuntime(config, { AI_CONTENT_MODEL_PROVIDER: "gemini" }), /GEMINI_API_KEY/);
  const local = resolveModelRuntime({ ...config, provider: 'opencode', providers: { opencode: { model: 'ollama/qwen2.5:7b' } } }, {});
  assert.equal(local.provider, 'opencode'); assert.equal(local.model, 'ollama/qwen2.5:7b'); assert.equal(local.contextTokens, undefined, 'OpenCode metadata does not enforce an Ollama num_ctx');
  assert.equal(local.baseUrl, 'http://127.0.0.1:11434/v1'); assert.equal(local.command, 'opencode');
  assert.equal(local.reasoningEffort, 'none', 'local OpenCode identity includes its enforced nonthinking request');
  const native = resolveModelRuntime({ ...config, provider: 'opencode', providers: { opencode: { model: 'opencode/example-free' } } }, {});
  assert.equal(native.baseUrl, undefined); assert.equal(native.apiKey, undefined);
  assert.equal(native.reasoningEffort, undefined, 'native free provider behavior remains unchanged');
  assert.throws(() => resolveModelRuntime({ ...config, provider: 'opencode' }, {}), /exact/);
  assert.throws(() => resolveModelRuntime(config, { AI_CONTENT_MODEL_PROVIDER: 'opencode', AI_CONTENT_MODEL_NAME: 'qwen2.5:7b' }), /exact/);
  assert.throws(() => resolveModelRuntime(config, { AI_CONTENT_MODEL_PROVIDER: 'opencode', AI_CONTENT_MODEL_NAME: 'ollama/qwen2.5:7b', AI_CONTENT_MODEL_BASE_URL: 'https://wrong.example/v1' }), /URL override/);
});

test('OpenCode dispatch preserves exact model, supports verified local vision, and never rescues native calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-routing-test-')), audit = join(dir, 'calls.jsonl'), cli = join(dir, 'opencode-route.js');
  const priorFetch = globalThis.fetch, priorPath = process.env.PATH;
  writeFileSync(cli, `#!/usr/bin/env node
const fs=require('node:fs');let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
 fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify({args:process.argv.slice(2),prompt})+'\\n');
 if(prompt==='FAIL'){console.error('native failure');process.exitCode=2;return;}
 const p={messageID:'msg-1',sessionID:'session-1'},out=(type,part)=>console.log(JSON.stringify({type,sessionID:'session-1',part:{...p,...part}}));
 out('step_start',{type:'step-start'});out('text',{id:'text-1',type:'text',text:'{"written":true}',time:{start:1,end:2}});out('step_finish',{type:'step-finish',reason:'stop',tokens:{input:2,output:3,total:5},cost:0});
});
`);
  chmodSync(cli, 0o700); writeFileSync(join(dir, 'opencode-route.cmd'), `@echo off\r\nset "dp0=%~dp0"\r\n"${process.execPath}" "%dp0%/opencode-route.js" %*\r\n`);
  if (process.platform === 'win32') process.env.PATH = dir + delimiter + priorPath;
  let status = 200, vision = false;
  const metadata: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input: any, options: any) => {
    metadata.push({ url: String(input), body: JSON.parse(options.body) });
    return new Response(JSON.stringify(status === 200 ? { capabilities: ['completion', ...(vision ? ['vision'] : [])] } : { error: 'missing model' }), { status });
  }) as typeof fetch;
  const settings: ModelConfig = { provider: 'opencode', timeoutSeconds: 5, rescue: { enabled: false }, providers: { opencode: { command: process.platform === 'win32' ? 'opencode-route' : cli, model: 'ollama/qwen2.5:7b' } } };
  const calls = () => existsSync(audit) ? readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  try {
    assert.deepEqual(await modelJson('local text', undefined, settings, {}), { written: true });
    assert.deepEqual(metadata, [{ url: 'http://127.0.0.1:11434/api/show', body: { model: 'qwen2.5:7b' } }]);
    assert.equal(calls()[0].args[calls()[0].args.indexOf('--model') + 1], 'ollama/qwen2.5:7b');
    const native: ModelConfig = { ...settings, rescue: { enabled: true, maxCallsPerDay: 2 }, providers: { opencode: { ...settings.providers.opencode, model: 'opencode/example-free' }, codex: { command: 'must-not-run-codex' }, claude: { command: 'must-not-run-claude' } } };
    const beforeMetadata = metadata.length;
    assert.deepEqual(await modelJson('native text', undefined, native, {}), { written: true });
    assert.equal(metadata.length, beforeMetadata, 'native route never probes Ollama');
    await assert.rejects(invokeModelText('FAIL', native, {}), /native failure/);
    assert.equal(calls().length, 3, 'native failure started only its selected OpenCode call');
    assert.equal(await modelCanReadImages(native, {}), false, 'native free text adapter never promises image review');
    const picture = join(dir, 'image.png'); writeFileSync(picture, Buffer.from('89504e470d0a1a0a', 'hex'));
    await assert.rejects(modelVisionJson('inspect', [picture], undefined, native, {}), /accepts text only/);
    assert.equal(calls().length, 3, 'image request never starts text-only CLI');
    await assert.rejects(modelVisionJson('inspect', [picture], undefined, settings, {}), /does not advertise local vision/);
    assert.equal(calls().length, 3, 'text-only local model is rejected before image CLI execution');
    vision = true;
    assert.deepEqual(await modelVisionJson('inspect', [picture], undefined, settings, {}), { written: true });
    assert.equal(calls().length, 4);
    assert.equal(calls()[3].args[calls()[3].args.indexOf('--model') + 1], settings.providers.opencode!.model);
    assert.ok(calls()[3].args.includes('--file')); assert.equal(calls()[3].args.includes(picture), false, 'only the captured private image copy is attached');
    status = 404;
    await assert.rejects(modelJson('missing local', undefined, { ...settings, rescue: native.rescue }, {}), /not found.*Hosted rescue was not started/);
    assert.equal(calls().length, 4, 'missing local model cannot start CLI or hosted fallback');
    status = 200;
    const { brandModelJson } = await import('../brand-copy.js');
    writeFileSync(join(testRoot, 'config/model.json'), JSON.stringify(settings));
    assert.deepEqual(await brandModelJson(testRoot, 'opencode:ollama/qwen2.5:3b', 'suggest', () => null), { written: true });
    assert.equal(calls().at(-1).args[calls().at(-1).args.indexOf('--model') + 1], 'ollama/qwen2.5:3b');
    assert.equal(JSON.parse(readFileSync(join(testRoot, 'config/model.json'), 'utf8')).providers.opencode.model, 'ollama/qwen2.5:7b', 'suggestion does not overwrite saved writer');
    const { saveWriter } = await import('../onboarding.js');
    saveWriter(testRoot, 'opencode', 'opencode/example-free', '', false);
    saveWriter(testRoot, 'opencode', '', '');
    assert.equal(JSON.parse(readFileSync(join(testRoot, 'config/model.json'), 'utf8')).providers.opencode.model, 'opencode/example-free', 'bare Advanced provider retains exact saved route');
    assert.throws(() => saveWriter(testRoot, 'opencode', 'opencode/paid', ''), /unsupported/);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex writes text, retries validated JSON, attaches images and fails closed without loading workspace tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-writer-test-"));
  const priorEnv = { ...process.env }, cli = join(dir, "codex.js"), audit = join(dir, "audit.json");
  writeFileSync(join(dir, "config.toml"), 'model="saved-test-model"\nmodel_reasoning_effort="low"\n[mcp_servers.forbidden]\ncommand="must-not-run"\n');
  writeFileSync(cli, `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
 fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify({args,prompt,cwd:process.cwd(),hasKey:!!(process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY)}));
 if(prompt==='TIMEOUT'){
  const worker=require('node:child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
  fs.writeFileSync(${JSON.stringify(join(dir, 'worker.pid'))},String(worker.pid));setInterval(()=>{},1000);return;
 }
 if(prompt==='NOFINAL')return;
 const answer=prompt.includes('RETRY')&&!prompt.includes('Validation error:')?'invalid answer':JSON.stringify({ok:true});
 fs.writeFileSync(get('--output-last-message'),answer);
 console.log(JSON.stringify({type:'item.completed',item:{text:'This chatter is not the answer'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:4}}));
 if(prompt==='FAIL'){console.error('fixture authentication failure');process.exitCode=2;}
});

`);
  chmodSync(cli, 0o700);
  writeFileSync(join(dir, 'codex.cmd'), `@echo off\r\nset "dp0=%~dp0"\r\n"${process.execPath}" "%dp0%/codex.js" %*\r\n`);
  process.env.CODEX_HOME = dir; process.env.PATH = dir + delimiter + process.env.PATH;
  process.env.OPENAI_API_KEY = 'must-not-cross'; process.env.CODEX_API_KEY = 'must-not-cross';
  const settings: ModelConfig = { provider: 'codex', timeoutSeconds: 5, providers: {codex: {command: process.platform === 'win32' ? 'codex' : cli}} };
  try {
    assert.equal(await invokeModelText('text', settings, {}), '{"ok":true}');
    assert.deepEqual(await modelJson('RETRY', undefined, settings, {}), {ok:true});
    let recorded = JSON.parse(readFileSync(audit,'utf8'));
    assert.match(recorded.prompt,/Validation error: No JSON found in model output/);
    assert.ok(!recorded.prompt.includes('invalid answer'));
    assert.ok(recorded.args.includes('--ignore-user-config')); assert.ok(recorded.args.includes('--ephemeral'));
    assert.ok(recorded.args.includes('features.shell_tool=false')); assert.ok(recorded.args.includes('features.plugins=false')); assert.ok(recorded.args.includes('features.hooks=false'));
    assert.ok(recorded.args.includes('saved-test-model')); assert.equal(recorded.hasKey,false);
    assert.equal(existsSync(recorded.cwd),false);
    const picture=join(dir,'image.png');writeFileSync(picture,Buffer.from('89504e470d0a1a0a','hex'));
    assert.deepEqual(await modelVisionJson('Inspect the attached image',[picture],undefined,settings,{}),{ok:true});
    recorded=JSON.parse(readFileSync(audit,'utf8')); assert.ok(recorded.args.includes(picture));
    await assert.rejects(invokeModelText('FAIL',settings,{}),/exit 2.*fixture authentication failure/);
    await assert.rejects(invokeModelText('NOFINAL',settings,{}),/no final message/);
    await assert.rejects(invokeModelText('TIMEOUT',{...settings,timeoutSeconds:1},{}),/timed out after 1s/);
    const pid=Number(readFileSync(join(dir,'worker.pid'),'utf8'));
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.throws(()=>process.kill(pid,0),/ESRCH/);
  } finally {
    for (const key of ['CODEX_HOME','PATH','OPENAI_API_KEY','CODEX_API_KEY']) {
      if(priorEnv[key]===undefined)delete process.env[key];else process.env[key]=priorEnv[key];
    }
    rmSync(dir,{recursive:true,force:true});
  }
});

test("base URLs reject embedded credentials and unsupported schemes", () => {
  assert.throws(() => resolveModelRuntime(config, {
    AI_CONTENT_MODEL_PROVIDER: "openai-compatible",
    AI_CONTENT_MODEL_BASE_URL: "https://user:secret@example.com/v1",
  }), /cannot contain credentials/);
  assert.throws(() => resolveModelRuntime(config, {
    AI_CONTENT_MODEL_PROVIDER: "openai-compatible",
    AI_CONTENT_MODEL_BASE_URL: "file:///tmp/model",
  }), /http or https/);
});

test("JSON extraction accepts fenced output and rejects missing JSON", () => {
  assert.equal(extractJson("```json\n{\"ok\":true}\n```"), "{\"ok\":true}");
  assert.throws(() => extractJson("no structured result"), /No JSON/);
});

test("OpenAI-compatible adapter sends chat completions and returns model content", async () => {
  let requestBody = "";
  let authorization = "";
  const server = createServer((request, response) => {
    authorization = String(request.headers.authorization || "");
    request.on("data", (chunk) => (requestBody += chunk));
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind");
  try {
    const output = await invokeModelText("return JSON", config, {
      AI_CONTENT_MODEL_PROVIDER: "openai-compatible",
      AI_CONTENT_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      AI_CONTENT_MODEL_NAME: "mock-model",
      AI_CONTENT_MODEL_API_KEY: "mock-key",
    });
    assert.equal(output, "{\"ok\":true}");
    assert.equal(authorization, "Bearer mock-key");
    assert.equal(JSON.parse(requestBody).model, "mock-model");
    assert.equal(JSON.parse(requestBody).messages[0].content, "return JSON");
    assert.equal(JSON.parse(requestBody).reasoning_effort, "none");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("OpenAI-compatible adapter streams: content deltas joined, reasoning dropped, usage kept, an error event rejects", async () => {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => body += chunk);
    request.on("end", () => {
      bodies.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.write(": keepalive\r\n\r\n");
      response.write('data: {"choices":[{"delta":{"content":"","role":"assistant"},"index":0}]}\r\n\r\n');
      response.write('data: {"choices":[{"delta":{"reasoning":"{\\"ok\\":false} was my first thought"},"index":0}]}\r\n\r\n');
      response.write('data: {"choices":[{"delta":{"content":"{\\"ok\\""},"index":0}]}\r\n\r\n');
      if (request.url!.includes("stream-error")) return response.end('data: {"error":{"message":"upstream worker lost"}}\r\n\r\n');
      if (request.url!.includes("long-thinking")) { // 5 MiB of reasoning deltas the answer never keeps must not trip the 4 MiB answer cap
        const thought = 'data: {"choices":[{"delta":{"reasoning":"' + 'x'.repeat(4096) + '"},"index":0}]}\r\n\r\n';
        for (let n = 0; n < 1300; n++) response.write(thought);
      }
      response.write('data: {"choices":[{"delta":{"content":":true}"},"index":0}]}\r\n\r\n');
      response.write('data: {"choices":[],"usage":{"prompt_tokens":23,"completion_tokens":142,"total_tokens":165}}\r\n\r\n');
      response.end("data: [DONE]\r\n\r\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const env = (path: string) => ({ AI_CONTENT_MODEL_PROVIDER: "openai-compatible", AI_CONTENT_MODEL_BASE_URL: `http://127.0.0.1:${port}/${path}/v1`, AI_CONTENT_MODEL_NAME: "stream-fixture" });
  const ledger = join(testRoot, "state/model-calls.jsonl");
  const rows = () => existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  try {
    const before = rows().length;
    assert.equal(await invokeModelText("return JSON", config, env("ok")), '{"ok":true}');
    assert.equal(bodies[0].stream, true);
    assert.deepEqual(bodies[0].stream_options, { include_usage: true });
    assert.deepEqual(rows().at(-1)?.usage, { prompt_tokens: 23, completion_tokens: 142, total_tokens: 165 });
    assert.equal(rows().length, before + 1);
    await assert.rejects(invokeModelText("return JSON", config, env("stream-error")), /stream-fixture: upstream worker lost/);
    assert.equal(await invokeModelText("return JSON", config, env("long-thinking")), '{"ok":true}', "reasoning deltas are not the answer and do not count toward its 4 MiB cap");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("JSON correction retains the complete task and feedback without echoing the rejected response, with two attempts only", async () => {
  const prompts: string[] = [];
  const invalid = JSON.stringify({ text: "A short draft." });
  let repair = true;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => body += chunk);
    request.on("end", () => {
      prompts.push(JSON.parse(body).messages[0].content);
      const content = repair && prompts.length === 2 ? JSON.stringify({ text: "A corrected draft with enough words." }) : invalid;
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind");
  const env = { AI_CONTENT_MODEL_PROVIDER: "openai-compatible", AI_CONTENT_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1` };
  const validate = (draft: { text: string }) => draft.text.split(/\s+/).length < 6 ? "script too short: need 6 words" : null;
  try {
    assert.equal((await modelJson("Write a sourced draft in JSON", validate, config, env)).text, "A corrected draft with enough words.");
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].startsWith('Write a sourced draft in JSON\n\n'));
    assert.ok(!prompts[1].includes(invalid));
    assert.match(prompts[1], /Validation error: script too short: need 6 words/);
    repair = false;
    await assert.rejects(modelJson("Write a sourced draft in JSON", validate, config, env), /failed after retry: script too short/);
    assert.equal(prompts.length, 4);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('long malformed answers cannot crowd out complete evidence on native or compatible stateless retries, and both attempts charge the same parent', async () => {
  const { beginParentWork, parentModelHooks, roleHash } = await import('./role-router.js');
  const originalFetch = globalThis.fetch;
  const originalPrompt = 'Return every source judgment.\nSOURCE_EVIDENCE:\n' + 'Exact source text with spaces  and Unicode 東京.\n'.repeat(90)
    + 'LATE CONDITION: this result covers only indoor moving targets; do not broaden it.\nEND_COMPLETE_EVIDENCE';
  const invalid = JSON.stringify({ ok: false, malformedAnswer: 'DO_NOT_REPLAY_MALFORMED_REPLY ' + 'x'.repeat(40_000) });
  const feedback = 'sentences [2,5]: anchors.count>2; require at most2 real source span IDs and every original sentence ID';
  try {
    for (const provider of ['ollama', 'openai-compatible'] as const) {
      const requests: any[] = [], attempts: Array<{ attempt: number; promptBytes: number }> = [];
      const baseUrl = 'http://127.0.0.1:49997/v1', model = 'stateless-format-fixture';
      globalThis.fetch = (async (url, init) => {
        if (String(url).endsWith('/api/show')) return new Response('{"capabilities":["completion"]}');
        requests.push(JSON.parse(String(init?.body)));
        const content = requests.length === 1 ? invalid : '{"ok":true}';
        return new Response(provider === 'ollama'
          ? JSON.stringify({ message: { content }, done: true }) + '\n'
          : JSON.stringify({ choices: [{ message: { content } }] }));
      }) as typeof fetch;
      const settings: ModelConfig = { provider, timeoutSeconds: 2, rescue: { enabled: false }, providers: {
        ollama: { model, baseUrl }, openaiCompatible: { model, baseUrl },
      } };
      const parent = { root: testRoot, parentId: 'stateless-format-' + provider, parentIdentity: roleHash({ originalPrompt, provider }),
        limits: { totalSeconds: 60, maxPhysicalCalls: 2, maxToolCalls: 0 } };
      const initial = beginParentWork(parent), hooks = parentModelHooks(parent, 'same-complete-task');
      const value = await modelJson(originalPrompt, (value: { ok: boolean }) => value.ok ? null : feedback,
        settings, {}, [], true, initial.deadline, { beforeAttempt: attempt => { hooks.beforeAttempt!(attempt); attempts.push(attempt); } });
      assert.deepEqual(value, { ok: true }); assert.equal(requests.length, 2);
      const prompts = requests.map(request => request.messages[0].content as string);
      assert.equal(prompts[0], originalPrompt);
      assert.ok(prompts[1]!.startsWith(originalPrompt + '\n\n'), 'the complete source packet remains byte-for-byte at the start');
      assert.ok(prompts[1]!.includes('Validation error: ' + feedback));
      assert.ok(prompts.every(prompt => !prompt.includes('DO_NOT_REPLAY_MALFORMED_REPLY') && !prompt.includes(invalid)));
      assert.ok(prompts[1]!.length - originalPrompt.length < 512, 'retry size depends on concise feedback, not the 40K malformed response');
      assert.deepEqual(attempts.map(attempt => attempt.attempt), [1, 2]);
      assert.deepEqual(attempts.map(attempt => attempt.promptBytes), prompts.map(prompt => Buffer.byteLength(prompt)));
      const final = beginParentWork(parent);
      assert.equal(final.deadline, initial.deadline); assert.equal(final.physicalAttempts, 2); assert.equal(final.remainingPhysical, 0);
      await assert.rejects(modelJson(originalPrompt, undefined, settings, {}, [], true, initial.deadline, parentModelHooks(parent, 'later-task')), /physical attempt allowance/);
      assert.equal(requests.length, 2, 'there is no third generation or implicit rescue after the same parent is spent');
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('a format failure after the original deadline cannot start a fresh retry or refund its physical charge', async () => {
  const { beginParentWork, parentModelHooks, roleHash } = await import('./role-router.js');
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = originalNow(), requests = 0;
  const parent = { root: testRoot, parentId: 'stateless-format-deadline', parentIdentity: roleHash('exact deadline fixture'),
    limits: { totalSeconds: 60, maxPhysicalCalls: 2, maxToolCalls: 0 }, now: () => now };
  const initial = beginParentWork(parent);
  try {
    Date.now = () => now;
    globalThis.fetch = (async () => { requests++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":false}' } }] })); }) as typeof fetch;
    const settings: ModelConfig = { provider: 'openai-compatible', timeoutSeconds: 2, rescue: { enabled: false }, providers: {
      openaiCompatible: { model: 'deadline-fixture', baseUrl: 'http://127.0.0.1:49998/v1' },
    } };
    await assert.rejects(modelJson('Complete source evidence stays pinned.', () => {
      now = initial.deadline; return 'sentences [3]: source span ID is invalid';
    }, settings, {}, [], true, initial.deadline, parentModelHooks(parent, 'first-task')), /time ceiling/);
    const final = beginParentWork(parent);
    assert.equal(requests, 1); assert.equal(final.physicalAttempts, 1); assert.equal(final.deadline, initial.deadline);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});


test("vision passes actual image bytes and parses the CLI final streaming event",async()=>{
  assert.equal(claudeResult('{"type":"system"}\n{"type":"result","result":"ok"}\n',true).result,"ok");
  assert.throws(()=>claudeResult('{"type":"system"}',true),/no final result/);
  const dir=mkdtempSync(join(tmpdir(),"model-vision-")),file=join(dir,"frame.png");
  const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRfoAAAAASUVORK5CYII=","base64");
  writeFileSync(file,bytes);
  let content:any;
  const server=createServer((req,res)=>{let body="";req.on("data",b=>body+=b);req.on("end",()=>{content=JSON.parse(body).messages[0].content;res.end(JSON.stringify({choices:[{message:{content:'{"passed":true}'}}]}));});});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{
    const port=(server.address() as any).port;
    const result=await modelVisionJson<{passed:boolean}>("Inspect this actual image",[file],undefined,config,{AI_CONTENT_MODEL_PROVIDER:"openai-compatible",AI_CONTENT_MODEL_BASE_URL:`http://127.0.0.1:${port}/v1`});
    assert.equal(result.passed,true);assert.equal(content[1].type,"image_url");assert.equal(content[1].image_url.url,"data:image/png;base64,"+bytes.toString("base64"));
  }finally{server.close();rmSync(dir,{recursive:true,force:true});}
});

test("Ollama carries its bearer and a shared deadline prevents a corrective request", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    if (req.url === '/api/show') { req.resume(); return res.end('{"capabilities":["completion"]}'); }
    calls++;
    req.resume(); req.on('end', () => { res.end(JSON.stringify({ message: { content: '{"ok":false}' }, done: true }) + '\n'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const deadline = Date.now() + 200;
    await assert.rejects(modelJson('Return JSON', () => {
      // Simulate validation consuming the rest of the total attempt budget.
      while (Date.now() <= deadline) { /* bounded */ }
      return 'retry';
    }, { ...config, provider: 'ollama' }, { AI_CONTENT_MODEL_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/v1`, AI_CONTENT_MODEL_API_KEY: 'fixture-token' }, [], true, deadline), /ceiling/);
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Compactif JSON calls use its documented native format without imposing it on other compatible endpoints', async () => {
  const original = globalThis.fetch, requests: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const env = { AI_CONTENT_MODEL_PROVIDER: 'openai-compatible', AI_CONTENT_MODEL_BASE_URL: 'https://api.compactif.ai/v1', AI_CONTENT_MODEL_NAME: 'fixture' };
    await modelJson('Return JSON', undefined, config, env);
    assert.deepEqual(requests.at(-1).response_format, { type: 'json_object' });
    await invokeModelText('Write prose', config, env);
    assert.equal(requests.at(-1).response_format, undefined);
    await modelJson('Return JSON', undefined, config, { ...env, AI_CONTENT_MODEL_BASE_URL: 'https://other.example/v1' });
    assert.equal(requests.at(-1).response_format, undefined);
  } finally { globalThis.fetch = original; }
});

test('native and Compactif decoder schemas retain complete prompts, exact retries and semantic validation', async () => {
  const original = globalThis.fetch, requests: any[] = [], attempts: any[] = [];
  let reply = 0;
  const schema: JsonOutputSchema = { type: 'object', additionalProperties: false, required: ['sourceIds', 'reason'], properties: {
    sourceIds: { type: 'array', maxItems: 1, items: { type: 'integer', enum: [1] } }, reason: { type: 'string', minLength: 1, maxLength: 500 },
  } };
  const validator = withJsonOutputContract((value: { sourceIds?: number[]; reason?: string }) => {
    if (!Array.isArray(value.sourceIds)) return 'missing sourceIds; legal source IDs: 1';
    return value.reason === 'supported fixture' ? null : 'unsupported meaning remains rejected';
  }, schema);
  const expected = jsonOutputContract(validator)!;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/api/show')) return new Response('{"capabilities":["completion"]}');
    const body = JSON.parse(String(init?.body)); requests.push(body);
    (schema.properties!.reason as { maxLength: number }).maxLength = 2; // Mutation after dispatch must not change the frozen decoder contract.
    const content = JSON.stringify(++reply % 2 ? { reason: 'malformed answer must not be resent' } : { sourceIds: [1], reason: 'supported fixture' });
    return new Response(String(url).endsWith('/api/chat') ? JSON.stringify({ message: { content }, done: true }) + '\n'
      : JSON.stringify({ choices: [{ message: { content } }] }));
  }) as typeof fetch;
  const prompt = 'ALL ORIGINAL EVIDENCE ' + 'complete source condition '.repeat(500);
  try {
    for (const [provider, baseUrl, mode] of [['ollama', 'http://127.0.0.1:11434/v1', 'native'], ['openai-compatible', 'https://api.compactif.ai/v1', 'compatible']] as const) {
      requests.length = 0; attempts.length = 0;
      const deadline = Date.now() + 20000;
      assert.deepEqual(await modelJson(prompt, validator, { ...config, rescue: { enabled: false } }, {
        AI_CONTENT_MODEL_PROVIDER: provider, AI_CONTENT_MODEL_BASE_URL: baseUrl, AI_CONTENT_MODEL_NAME: 'schema-fixture',
      }, [], true, deadline, { beforeAttempt: attempt => attempts.push(attempt) }), { sourceIds: [1], reason: 'supported fixture' });
      assert.equal(requests.length, 2); assert.equal(attempts.length, 2); assert.deepEqual(attempts.map(row => row.attempt), [1, 2]);
      assert.ok(attempts.every(row => row.rescue === false && row.outputMode === 'json-schema' && row.outputContractHash === expected.hash && row.outputSchemaBytes === expected.bytes));
      assert.equal(requests[0].messages[0].content, prompt); assert.ok(requests[1].messages[0].content.startsWith(prompt + '\n\nValidation error: missing sourceIds'));
      assert.ok(!requests[1].messages[0].content.includes('malformed answer must not be resent'));
      assert.ok(!requests[0].messages[0].content.includes('additionalProperties'), 'decoder schema is not appended to source prose');
      for (const body of requests) if (mode === 'native') { assert.deepEqual(body.format, expected.schema); assert.equal(body.options.num_ctx, 16384); }
      else assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'harness_output', schema: expected.schema, strict: true } });
    }
    requests.length = 0; attempts.length = 0;
    const unsupported = withJsonOutputContract((_value: unknown) => 'unsupported meaning remains rejected', expected.schema, { strict: false });
    await assert.rejects(modelJson(prompt, unsupported, { ...config, rescue: { enabled: false } }, {
      AI_CONTENT_MODEL_PROVIDER: 'openai-compatible', AI_CONTENT_MODEL_BASE_URL: 'https://api.compactif.ai/v1', AI_CONTENT_MODEL_NAME: 'schema-fixture',
    }, [], true, Date.now() + 20000, { beforeAttempt: attempt => attempts.push(attempt) }), /unsupported meaning remains rejected/);
    assert.equal(requests.length, 2); assert.equal(attempts.length, 2); assert.equal(requests[0].response_format.json_schema.strict, false);
    const before = requests.length;
    await assert.rejects(modelJson(prompt, validator, config, {}, [], true, Date.now() - 1), /ceiling/);
    assert.equal(requests.length, before, 'schema cannot renew an exhausted deadline');
  } finally { globalThis.fetch = original; }
});

test('unverified compatible and cloud routes do not acquire native schema claims', async () => {
  const original = globalThis.fetch, requests: any[] = [], attempts: any[] = [];
  const validator = withJsonOutputContract((_value: unknown) => null, { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false });
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/api/show')) return new Response('{"capabilities":["completion"]}');
    requests.push(JSON.parse(String(init?.body)));
    return new Response(String(url).endsWith('/api/chat') ? '{"message":{"content":"{\\"ok\\":true}"},"done":true}\n' : '{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}');
  }) as typeof fetch;
  try {
    for (const [provider, baseUrl, model] of [['openai-compatible', 'https://other.example/v1', 'schema-fixture'], ['ollama', 'http://127.0.0.1:11434/v1', 'gpt-oss:120b-cloud']] as const) {
      await modelJson('Complete original request', validator, { ...config, rescue: { enabled: false } }, {
        AI_CONTENT_MODEL_PROVIDER: provider, AI_CONTENT_MODEL_BASE_URL: baseUrl, AI_CONTENT_MODEL_NAME: model,
      }, [], true, Date.now() + 20000, { beforeAttempt: attempt => attempts.push(attempt) });
      assert.equal(requests.at(-1).format, undefined); assert.equal(requests.at(-1).response_format, undefined);
      assert.equal(attempts.at(-1).outputMode, 'unconstrained');
    }
  } finally { globalThis.fetch = original; }
});

test('a character-bounded decoder schema cannot approve excessive words or UTF-16 length', async () => {
  const original = globalThis.fetch;
  let requests = 0, text = 'word '.repeat(40).trim();
  globalThis.fetch = (async () => { requests++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text }) } }] })); }) as typeof fetch;
  const env = { AI_CONTENT_MODEL_PROVIDER: 'openai-compatible', AI_CONTENT_MODEL_BASE_URL: 'https://api.compactif.ai/v1', AI_CONTENT_MODEL_NAME: 'schema-fixture' };
  const schema: JsonOutputSchema = { type: 'object', properties: { text: { type: 'string', maxLength: 500 } }, required: ['text'], additionalProperties: false };
  try {
    const wordValidator = withJsonOutputContract((value: { text: string }) => value.text.trim().split(/\s+/).length > 35 ? 'replacement exceeds the measured 35-word ceiling' : null, schema);
    await assert.rejects(modelJson('Use the complete supplied evidence within the original word target.', wordValidator, { ...config, rescue: { enabled: false } }, env), /35-word/);
    assert.equal(requests, 2);
    text = '🙂'.repeat(251); assert.equal(text.length, 502); assert.equal([...text].length, 251);
    const lengthValidator = withJsonOutputContract((value: { text: string }) => value.text.length > 500 ? 'reason exceeds 500 UTF-16 units' : null, schema);
    await assert.rejects(modelJson('Keep the full source conditions.', lengthValidator, { ...config, rescue: { enabled: false } }, env), /UTF-16/);
    assert.equal(requests, 4);
  } finally { globalThis.fetch = original; }
});


test("Claude editorial and explicit research use isolated capabilities, limited environment and bounded processes", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-isolation-')), audit = join(dir, 'audit.json'), workerPid = join(dir, 'worker.pid');
  const prior = { ...process.env }, cli = join(dir, 'claude-fixture.js');
  writeFileSync(cli, `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);let prompt='';
process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify({args,prompt,cwd:process.cwd(),home:process.env.HOME,auth:process.env.CLAUDE_CODE_OAUTH_TOKEN,leaked:['HARNESS_TOKEN','GITHUB_TOKEN','OPENAI_API_KEY','NODE_OPTIONS'].filter(k=>process.env[k])}));
if(prompt==='TIMEOUT'){const child=require('node:child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(workerPid)},String(child.pid));setInterval(()=>{},1000);return;}
if(prompt==='OVERSIZE'){process.stdout.write('x'.repeat(2097153));return;}
if(prompt==='FAIL'){console.error('fixture login unavailable');process.exitCode=2;return;}
console.log(JSON.stringify({result:JSON.stringify({ok:true})}));});
`);
  chmodSync(cli, 0o700);
  writeFileSync(join(dir, 'claude-fixture.cmd'), `@echo off\r\nset "dp0=%~dp0"\r\n"${process.execPath}" "%dp0%/claude-fixture.js" %*\r\n`);
  const settings: ModelConfig = { provider: 'claude', timeoutSeconds: 2, providers: { claude: { command: process.platform === 'win32' ? join(dir, 'claude-fixture.cmd') : cli, model: 'fixture-model' } } };
  Object.assign(process.env, { HARNESS_TOKEN: 'private-harness-fixture', GITHUB_TOKEN: 'private-source-fixture', OPENAI_API_KEY: 'private-other-writer-fixture', NODE_OPTIONS: '--trace-warnings', CLAUDE_CODE_OAUTH_TOKEN: 'selected-claude-fixture' });
  const row = () => JSON.parse(readFileSync(audit, 'utf8'));
  const isolated = (tools: string) => {
    const r = row(), value = (key: string) => r.args[r.args.indexOf(key) + 1];
    assert.ok(r.args.includes('--safe-mode')); assert.ok(r.args.includes('--no-session-persistence'));
    assert.ok(r.args.includes('--strict-mcp-config')); assert.deepEqual(JSON.parse(value('--mcp-config')), { mcpServers: {} });
    assert.equal(value('--tools'), tools); assert.equal(JSON.parse(value('--settings')).disableAllHooks, true);
    assert.deepEqual(r.leaked, []); assert.equal(r.auth, 'selected-claude-fixture'); assert.equal(r.home, prior.HOME);
    assert.notEqual(r.cwd, process.cwd()); assert.equal(existsSync(r.cwd), false, 'temporary project is removed');
    assert.equal(value('--model'), 'fixture-model');
  };
  try {
    assert.deepEqual(await modelJson('Editorial source text', undefined, settings, {}), { ok: true }); isolated('');
    assert.deepEqual(await modelJson('Legacy false flag must not grant tools', undefined, settings, {}, [], false), { ok: true }); isolated('');
    assert.equal(await invokeModelText('Plain editorial text', settings, {}), '{"ok":true}'); isolated('');
    assert.equal(await invokeClaudeWebText('Explicit source discovery', settings, {}), '{"ok":true}'); isolated('WebSearch,WebFetch');
    assert.equal(row().args[row().args.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
    await assert.rejects(invokeClaudeWebText('Do not change writer', { ...settings, provider: 'codex' }, {}), /explicitly selected Claude/);
    await assert.rejects(invokeModelText('FAIL', settings, {}), /exit 2.*fixture login unavailable/);
    await assert.rejects(invokeModelText('OVERSIZE', settings, {}), /output exceeded 2 MiB/);
    await assert.rejects(invokeModelText('TIMEOUT', { ...settings, timeoutSeconds: 1 }, {}), /timed out after 1s/);
    const pid = Number(readFileSync(workerPid, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    for (const key of ['HARNESS_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex CLI receives the complete bound Journey schema natively on both attempts before physical accounting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-schema-transport-'));
  const cli = join(dir, 'schema-codex.js'), audit = join(dir, 'stdin.jsonl');
  const { journeyScriptFormat } = await import('../pipeline/journey-editorial.js');
  const topic = { stories: [{ assetRef: 'og-0' }] } as import('../types.js').Topic;
  const schema = journeyScriptFormat(topic, 'This is the publication.', { min: 195, max: 220 }).schema;
  const validate = withJsonOutputContract<{ publish?: { title?: string; description?: string; linkedinPost?: string; hashtags?: string[] } }>(value =>
    value.publish?.title && value.publish?.description && value.publish?.linkedinPost && Array.isArray(value.publish.hashtags) ? null : 'missing publish metadata', schema);
  const contract = jsonOutputContract(validate)!;
  writeFileSync(cli, `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
 const file=args[args.indexOf('--output-schema')+1],schema=args.includes('--output-schema')?JSON.parse(fs.readFileSync(file,'utf8')):null;
 fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify({prompt,schema})+'\\n');
 if(JSON.stringify(schema)!==${JSON.stringify(JSON.stringify(schema))}){console.error('exact complete schema absent from native CLI contract');process.exitCode=2;return;}
 const answer=prompt.includes('Validation error: missing publish metadata')?{publish:{title:'Sourced title',description:'Sourced description',linkedinPost:'Sourced social text',hashtags:['Sports']}}:{publish:{title:'Missing remaining metadata'}};
 fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(answer));console.log(JSON.stringify({type:'turn.completed',usage:{}}));
});`);
  chmodSync(cli, 0o700);
  writeFileSync(join(dir, 'schema-codex.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
  const settings: ModelConfig = { provider: 'codex', timeoutSeconds: 5, rescue: { enabled: false }, providers: { codex: { command: process.platform === 'win32' ? join(dir, 'schema-codex.cmd') : cli, model: 'schema-fixture' } } };
  const attempts: import('./model.js').ModelAttempt[] = [];
  const { createHash } = await import('node:crypto');
  try {
    const value = await modelJson('Write all required production script fields. COMPLETE SOURCE stays intact.', validate, settings, {}, [], true, undefined, { beforeAttempt: row => { attempts.push(row); } });
    assert.equal(value.publish!.linkedinPost, 'Sourced social text');
    const rows = readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 2); assert.equal(attempts.length, 2);
    rows.forEach((row, index) => {
      assert.match(row.prompt, /COMPLETE SOURCE stays intact/);
      assert.ok(!row.prompt.includes('HARNESS_JSON_OUTPUT_SCHEMA_V1'), 'Native schema is sent separately from source prose');
      assert.match(JSON.stringify(row.schema), /"required":\["title","description","linkedinPost","hashtags"\]/);
      assert.equal(attempts[index]!.promptBytes, Buffer.byteLength(row.prompt));
      assert.equal(attempts[index]!.promptHash, createHash('sha256').update(row.prompt).digest('hex'));
      assert.equal(attempts[index]!.outputContractHash, contract.hash); assert.equal(attempts[index]!.outputMode, 'json-schema');
    });
    assert.match(rows[1].prompt, /Validation error: missing publish metadata/);
    assert.ok(!rows[1].prompt.includes('Missing remaining metadata'), 'Malformed response is not reinjected as source context');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex optional-property contracts retain honest prompt-schema mode without changing field semantics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-optional-schema-')), cli = join(dir, 'optional-codex.js'), audit = join(dir, 'wire.json');
  const schema: JsonOutputSchema = { type: 'object', additionalProperties: false, required: ['kind'], properties: {
    kind: { type: 'string', enum: ['diagram'] }, mechanism: { type: 'string', enum: ['assembly'] },
  } };
  const validate = withJsonOutputContract<{ kind: string; mechanism?: string }>(value => value.kind === 'diagram' && value.mechanism === undefined ? null : 'Diagram must omit mechanism', schema);
  writeFileSync(cli, `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify({args,prompt}));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'{"kind":"diagram"}');console.log(JSON.stringify({type:'turn.completed',usage:{}}));});`);
  chmodSync(cli, 0o700); writeFileSync(join(dir, 'optional-codex.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
  const settings: ModelConfig = { provider: 'codex', timeoutSeconds: 5, rescue: { enabled: false }, providers: { codex: { command: process.platform === 'win32' ? join(dir, 'optional-codex.cmd') : cli, model: 'optional-schema-fixture' } } };
  const attempts: import('./model.js').ModelAttempt[] = [];
  try {
    assert.deepEqual(await modelJson('Optional native-incompatible contract fixture.', validate, settings, {}, [], true, undefined, { beforeAttempt: row => { attempts.push(row); } }), { kind: 'diagram' });
    const wire = JSON.parse(readFileSync(audit, 'utf8'));
    assert.ok(!wire.args.includes('--output-schema')); assert.ok(wire.prompt.includes(JSON.stringify(schema)));
    assert.equal(attempts[0]!.outputMode, 'prompt-schema'); assert.equal(attempts[0]!.outputContractHash, jsonOutputContract(validate)!.hash);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex uses its native exact schema and retains malformed reviewer output before one correction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-native-contract-'));
  const cli = join(dir, 'native-codex.js'), audit = join(dir, 'wire.jsonl');
  const schema: JsonOutputSchema = { type: 'object', additionalProperties: false, required: ['verdict', 'reviewedStoryIds', 'findings'], properties: {
    verdict: { type: 'string', enum: ['supported', 'changes-required'] },
    reviewedStoryIds: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'string', enum: ['story-1'] } },
    findings: { type: 'array', maxItems: 1, items: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', maxLength: 22 } } } },
  } };
  const malformed = '{"verdict":"supported","reviewedStoryIds":["story-1"],"findings":[}';
  const valid = { verdict: 'supported', reviewedStoryIds: ['story-1'], findings: [] };
  writeFileSync(cli, `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
 const p=args[args.indexOf('--output-schema')+1];if(!args.includes('--output-schema')){console.error('native schema absent');process.exitCode=2;return;}
 const schema=JSON.parse(fs.readFileSync(p,'utf8'));fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify({prompt,schema,args,schemaMode:fs.statSync(p).mode&511})+'\\n');
 const answer=prompt.includes('Validation error:')?JSON.stringify(${JSON.stringify(valid)}):${JSON.stringify(malformed)};
 fs.writeFileSync(args[args.indexOf('--output-last-message')+1],answer);console.log(JSON.stringify({type:'turn.completed',usage:{output_tokens:20}}));
});`);
  chmodSync(cli, 0o700);
  writeFileSync(join(dir, 'native-codex.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
  const settings: ModelConfig = { provider: 'codex', timeoutSeconds: 5, rescue: { enabled: false }, providers: { codex: { command: process.platform === 'win32' ? join(dir, 'native-codex.cmd') : cli, model: 'native-schema-fixture' } } };
  const validate = withJsonOutputContract<typeof valid>(value => value.verdict === 'supported' && value.reviewedStoryIds?.join() === 'story-1' && value.findings?.length === 0 ? null : 'Incomplete reviewed story ownership', schema);
  const attempts: import('./model.js').ModelAttempt[] = [];
  const { createHash } = await import('node:crypto');
  try {
    assert.deepEqual(await modelJson('NATIVE_REVIEW_FIXTURE complete source conditions stay intact.', validate, settings, {}, [], true, undefined,
      { beforeAttempt: attempt => { attempts.push(attempt); } }), valid);
    const wire = readFileSync(audit, 'utf8').trim().split('\n').map(row => JSON.parse(row));
    assert.equal(wire.length, 2); assert.equal(attempts.length, 2);
    wire.forEach((row, i) => {
      assert.deepEqual(row.schema, schema); assert.equal(attempts[i]!.outputMode, 'json-schema');
      assert.equal(attempts[i]!.outputContractHash, jsonOutputContract(validate)!.hash);
      assert.equal(attempts[i]!.outputSchemaBytes, Buffer.byteLength(JSON.stringify(schema)));
      assert.equal(attempts[i]!.promptBytes, Buffer.byteLength(row.prompt));
      assert.equal(attempts[i]!.promptHash, createHash('sha256').update(row.prompt).digest('hex'));
      assert.ok(!row.prompt.includes('HARNESS_JSON_OUTPUT_SCHEMA_V1'));
      assert.ok(row.prompt.includes('complete source conditions stay intact'));
      if (process.platform !== 'win32') assert.equal(row.schemaMode, 0o600);
      assert.ok(!existsSync(row.args[row.args.indexOf('--output-schema') + 1]), 'Temporary schema is removed after invocation');
    });
    assert.ok(!wire[1].prompt.includes(malformed), 'Malformed output is retained locally, never reinjected into source prose');
    const failureDir = join(testRoot, 'state/model-output-failures');
    const receipts = readdirSync(failureDir).map(file => JSON.parse(readFileSync(join(failureDir, file), 'utf8')))
      .filter(row => row.prompt.text.startsWith('NATIVE_REVIEW_FIXTURE'));
    assert.equal(receipts.length, 1); assert.equal(receipts[0].response.text, malformed);
    assert.equal(receipts[0].response.truncated, false); assert.equal(receipts[0].attempt, 1);
    assert.equal(receipts[0].response.sha256, createHash('sha256').update(malformed).digest('hex'));
    assert.equal(receipts[0].prompt.sha256, attempts[0]!.promptHash);
    assert.deepEqual(receipts[0].outputSchema, schema);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid model JSON remains held after two attempts with typed raw-evidence receipts', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const malformed = '{"ok":true]';
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: malformed } }] })); }) as typeof fetch;
  try {
    await assert.rejects(modelJson('RAW_REJECTION_FIXTURE', undefined,
      { provider: 'openai-compatible', timeoutSeconds: 2, rescue: { enabled: false }, providers: { openaiCompatible: { baseUrl: 'https://fixtures.example/v1', model: 'invalid-json-fixture' } } }, {}), error => {
      assert.equal((error as any).code, 'MODEL_OUTPUT_INVALID'); assert.equal((error as any).kind, 'parse');
      const receipts = (error as any).receipts as string[]; assert.equal(receipts.length, 2);
      for (const [i, file] of receipts.entries()) {
        assert.ok(file.startsWith(join(testRoot, 'state/model-output-failures/')));
        const row = JSON.parse(readFileSync(file, 'utf8')); assert.equal(row.response.text, malformed); assert.equal(row.attempt, i + 1);
      }
      return true;
    });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});


test('bounded local corrections send the reserved completion cap and expose the full physical prompt', async () => {
  const original = globalThis.fetch;
  const bodies: any[] = [], audit: any[] = [], prompts: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).endsWith('/api/show')) return new Response(JSON.stringify({ capabilities: ['completion'] }));
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ message: { content: bodies.length === 1 ? '{}' : '{"ok":true}' }, done: true }) + '\n');
  }) as typeof fetch;
  const config: ModelConfig = { provider: 'ollama', timeoutSeconds: 2, rescue: { enabled: false }, providers: { ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'token-cap-fixture:7b', contextTokens: 32768 } } };
  try {
    await modelJson('Complete original evidence.', (value: { ok: boolean }) => value.ok ? null : 'Need the ok field', config, {}, [], true, undefined,
      { outputTokenLimit: 4096, beforeAttempt: (attempt, physicalPrompt) => { audit.push(attempt); prompts.push(physicalPrompt!); } });
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies.map(body => body.options), [{ temperature: 0.2, num_ctx: 32768, num_predict: 4096 }, { temperature: 0.2, num_ctx: 32768, num_predict: 4096 }]);
    assert.deepEqual(audit.map(row => row.outputTokenLimit), [4096, 4096]);
    assert.deepEqual(prompts, bodies.map(body => body.messages[0].content));
    assert.ok(prompts[1]!.includes('Complete original evidence.') && prompts[1]!.includes('Need the ok field'));
    await assert.rejects(modelJson('No invalid cap', undefined, config, {}, [], true, undefined, { outputTokenLimit: 4097 }), /completion token ceiling/);
    assert.equal(bodies.length, 2);
  } finally { globalThis.fetch = original; }
});

test('a hosted provider that does not answer in time is retried once with the same request; a local model keeps its rescue handoff', async () => {
  const original = globalThis.fetch; let physical = 0; const prompts: string[] = [];
  const hang = (init: any) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))));
  globalThis.fetch = (async (_url: any, init: any) => {
    physical++; prompts.push(String(init?.body ?? ''));
    if (physical === 1) return hang(init);
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }) as typeof fetch;
  const settings: ModelConfig = { provider: 'openai-compatible', timeoutSeconds: 1, rescue: { enabled: false }, providers: { openaiCompatible: { baseUrl: 'https://fixture.example/v1', model: 'hosted-timeout-fixture' } } };
  try {
    assert.deepEqual(await modelJson('Pin claims', (value: { ok: boolean }) => value.ok ? null : 'need ok', settings, { OPENAI_COMPATIBLE_API_KEY: 'fixture' }, [], true), { ok: true });
    assert.equal(physical, 2); assert.equal(prompts[0], prompts[1], 'the retry sends the same request, not a correction');
    physical = 0;
    globalThis.fetch = (async (_url: any, init: any) => { physical++; return hang(init); }) as typeof fetch;
    await assert.rejects(modelJson('Pin claims', undefined, settings, { OPENAI_COMPATIBLE_API_KEY: 'fixture' }, [], true), /did not answer within/);
    assert.equal(physical, 2, 'two silences, then the failure is reported');
  } finally { globalThis.fetch = original; }
});
