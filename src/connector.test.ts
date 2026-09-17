import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { parse } from 'jsonc-parser';
import { parse as yamlParse } from 'yaml';
import TOML from '@iarna/toml';
import { CODE_ROOT, atomicJson, read } from './workspaces.js';
import { createControlServer } from './control.js';
import { configureHost, restoreHost, HOSTS, connectionPath, loadConnection, connectorCards, recordToolCall } from './connector-hosts.js';
import { configureConnection, verifyConnection, disconnectConnection, installPiTools, embeddedConnector, selfServeConnection } from './connector-local.js';
import { callHarnessTool, harnessApi, TOOL_DEFINITIONS, pendingConfirmations } from './connector-tools.js';
import { createRemoteApp, HarnessOAuth, remoteOrigin } from './connector-remote.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { releaseProfile } from './release-profile.js';
import { conversationState, realtimeSession } from './connector-voice.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const owner = 'a'.repeat(64), viewer = 'b'.repeat(64), reviewer = 'c'.repeat(64);
const identityFile = join(homedir(), '.content-harness', 'identity.json');
function fixture() {
  mkdirSync(join(CODE_ROOT, 'workspaces'), { recursive: true });
  const root = mkdtempSync(join(CODE_ROOT, 'workspaces/connector-test-')), workspace = basename(root);
  cpSync(join(CODE_ROOT, 'config'), join(root, 'config'), { recursive: true });
  for (const d of ['state', 'workdir/videos', 'workdir/newsletters', 'workdir/harvest']) mkdirSync(join(root, d), { recursive: true });
  atomicJson(join(root, 'workspace.json'), { id: workspace, name: 'Connector fixture' }); atomicJson(join(root, 'desks.json'), {});
  atomicJson(join(root, 'members.json'), [{ id: 'author', role: 'owner', tokenHash: sha(owner) }, { id: 'reader', role: 'viewer', tokenHash: sha(viewer) }, { id: 'reviewer', role: 'reviewer', desks: ['news'], tokenHash: sha(reviewer) }]);
  // A real stdio connector child inherits only the MCP default environment (HOME/PATH), never
  // HARNESS_TOKEN, so it resolves the owner token from the identity file exactly as a workspace
  // created by createWorkspace does. Register this fixture workspace the same way, and unregister it.
  const identityKey = sha(resolve(root));
  atomicJson(identityFile, { ...read<Record<string, string>>(identityFile, {}), [identityKey]: owner });
  return { root, workspace, cleanup: () => {
    const identities = read<Record<string, string>>(identityFile, {}); delete identities[identityKey]; atomicJson(identityFile, identities);
    rmSync(root, { recursive: true, force: true });
  } };
}
async function control() {
  const f = fixture(), calls: any[] = [];
  const server = createControlServer({ mutate: async (_root, token, input) => { calls.push({ token, input }); return { prepared: true }; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  return { ...f, base, calls, api: harnessApi(base, f.workspace, owner), server, close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.cleanup(); } };
}

test('ten local MCP configurations preserve unrelated settings, back up bytes, restore narrowly and reject edited entries', () => {
  const f = fixture(), home = mkdtempSync(join(tmpdir(), 'harness-home-'));
  try {
    assert.equal(HOSTS.length, 14);
    for (const host of HOSTS.filter(h => 'path' in h)) {
      if (!('path' in host)) continue;
      const file = join('project' in host ? f.root : home, host.path); mkdirSync(dirname(file), { recursive: true });
      const raw = host.kind === 'toml' ? '# model and credential stay\nmodel = "chosen"\ncredential = "test-secret"\n[mcp_servers.other]\ncommand = "other"\n' : host.kind === 'yaml' ? '# model and credential stay\nmodel: chosen\ncredential: test-secret\nmcp_servers:\n  other:\n    command: other\n' : '// keep this comment\n{"model":"chosen","credential":"test-secret","unrelated":{"enabled":true}}\n';
      writeFileSync(file, raw);
      const receipt = configureHost(host.id, f.root, f.root, 'content-harness-check', process.execPath, ['C:\\path with spaces\\connect.mjs', '--workspace', f.workspace], home);
      const decode = (s: string): any => host.kind === 'toml' ? TOML.parse(s) : host.kind === 'yaml' ? yamlParse(s) : parse(s);
      const configured = readFileSync(file, 'utf8'); assert.equal(decode(configured).model, 'chosen'); assert.equal(decode(configured).credential, 'test-secret');
      if (host.kind !== 'json5') assert.match(configured, /model and credential stay|keep this comment/); assert.equal(read<any>(receipt.backup, {}).raw, raw);
      writeFileSync(file, configured.replace('chosen', 'updated-by-user'));
      restoreHost(receipt); const restored = readFileSync(file, 'utf8'); assert.equal(decode(restored).model, 'updated-by-user'); assert.equal(decode(restored).credential, 'test-secret'); assert.doesNotMatch(restored, /content-harness-check/);
    }
    const clawFile = join(home, '.openclaw/openclaw.json'); writeFileSync(clawFile, "{ model: 'chosen', credential: 'test-secret', mcp: { servers: {} } }");
    const claw = configureHost('openclaw', f.root, f.root, 'json5-check', 'node', [], home); restoreHost(claw); assert.equal(JSON.parse(readFileSync(clawFile, 'utf8')).credential, 'test-secret');
    const receipt = configureHost('cursor', f.root, f.root, 'edited', 'node', [], home);
    writeFileSync(receipt.file, readFileSync(receipt.file, 'utf8').replace('"node"', '"operator-command"'));
    assert.throws(() => restoreHost(receipt), /edited/); assert.match(readFileSync(receipt.file, 'utf8'), /operator-command/);
  } finally { f.cleanup(); rmSync(home, { recursive: true, force: true }); }
});

test('real stdio tool call uses embedded HTTP, never exposes credentials, and disconnect revokes a running connection', async () => {
  const f = fixture();
  try {
    const c = await configureConnection(f.root, 'claude', owner);
    const configuration = readFileSync(join(c.plugin!, '.mcp.json'), 'utf8'); assert.doesNotMatch(configuration, new RegExp(owner));
    const result = await verifyConnection(f.root, c); assert.equal(result.tool, 'harness_status');
    assert.match(connectorCards(f.root, CODE_ROOT, owner).find(c => c.id === 'claude')!.status, /host connection pending/);
    recordToolCall(f.root, c.id, 'Native fixture', 'harness_status'); await verifyConnection(f.root, c);
    assert.equal(connectorCards(f.root, CODE_ROOT, owner).find(c => c.id === 'claude')!.status, 'connected');
    await disconnectConnection(f.root, 'claude', owner); assert.throws(() => loadConnection(f.root, c.id), /Unauthorized/);
    const pi = await configureConnection(f.root, 'pi', owner), tools: any[] = [], hooks: any = {};
    await installPiTools({ registerTool: (tool: any) => tools.push(tool), on: (event: string, fn: any) => { hooks[event] = fn; } }, f.root, pi.id);
    try { assert.equal(tools.length, Object.keys(TOOL_DEFINITIONS).length); const result = await tools.find(t => t.name === 'harness_status').execute('one', {}); assert.match(result.content[0].text, /Connector fixture/); assert.doesNotMatch(result.content[0].text, new RegExp(owner)); }
    finally { hooks.session_shutdown(); }
  } finally { f.cleanup(); }
});

test('agent setup preserves model and voice binding and rejects credentials, access changes and duplicate mutations', async () => {
  const c = await control(), ctx = { root: c.root, token: owner, api: c.api, connection: 'setup-agent' };
  try {
    const setup = await callHarnessTool(ctx, 'harness_setup', {}); assert.match(setup.guidance.instructions, /saved use case/);
    const settings = { operation: 'publication', publication: 'Example Brief', audience: 'Leaders', topics: 'Evidence' };
    await assert.rejects(callHarnessTool(ctx, 'harness_configure', { settings: { ...settings, apiKey: 'not-allowed' }, requestId: 'setup-private' }));
    await assert.rejects(callHarnessTool(ctx, 'harness_configure', { settings: { ...settings, modelUrl: 'https://attacker.example.org/v1' }, requestId: 'setup-redirect' }), /local browser/);
    await assert.rejects(callHarnessTool(ctx, 'harness_configure', { settings: { operation: 'channels', selected: ['youtube'] }, requestId: 'setup-channels' }));
    await assert.rejects(callHarnessTool(ctx, 'harness_configure', { settings: { operation: 'media', mode: 'cards', voiceProvider: 'voicebox', voiceProfile: 'Someone else' }, requestId: 'setup-voice' }), /authorized local voice/);
    const first = await callHarnessTool(ctx, 'harness_configure', { settings, requestId: 'setup-idempotent' });
    const second = await callHarnessTool(ctx, 'harness_configure', { settings, requestId: 'setup-idempotent' });
    assert.equal(first.job, second.job); assert.equal(c.calls.length, 1); assert.equal(c.calls[0].input.data.preserveModel, true);
    await assert.rejects(callHarnessTool({ ...ctx, token: viewer, api: harnessApi(c.base, c.workspace, viewer) }, 'harness_configure', { settings, requestId: 'viewer-setup' }), /Forbidden/);
  } finally { await c.close(); }
});

test('named tools enforce workspace roles, idempotency, immutable review and no model-supplied execution', async () => {
  const c = await control();
  const ctx = { root: c.root, token: owner, api: c.api, connection: 'test-agent' };
  try {
    await assert.rejects(callHarnessTool(ctx, 'shell', { command: 'echo unsafe' }), /Unknown/);
    await assert.rejects(callHarnessTool(ctx, 'harness_setup', { workspace: 'other' }), /unrecognized/i);
    await assert.rejects(callHarnessTool(ctx, 'harness_request_confirmation', { action: { operation: 'execute-shell' }, requestId: 'malicious-key' }));
    const readCtx = { ...ctx, token: viewer, api: harnessApi(c.base, c.workspace, viewer) };
    await assert.rejects(callHarnessTool(readCtx, 'harness_draft', { edition: 'daily-roundup', requestId: 'viewer-request' }), /Forbidden/);
    const draft = { edition: 'daily-roundup', requestId: 'draft-idempotent' };
    const first = await callHarnessTool(ctx, 'harness_draft', draft), second = await callHarnessTool(ctx, 'harness_draft', draft); assert.equal(first.job, second.job); assert.equal(c.calls.length, 1);
    await assert.rejects(callHarnessTool(ctx, 'harness_draft', { ...draft, edition: 'example-topic' }), /already used/);
    const request = { action: { operation: 'member-disable', memberId: 'reader' }, requestId: 'human-review-once' };
    await callHarnessTool(ctx, 'harness_request_confirmation', request); await callHarnessTool(ctx, 'harness_request_confirmation', request);
    const queue = pendingConfirmations(c.root); assert.equal(queue.length, 1); assert.equal(c.calls.length, 1);
    const url = c.base + '/v1/connectors/review?workspace=' + c.workspace, body = JSON.stringify({ id: queue[0].id, expectedHash: queue[0].hash, allow: true });
    const headers = { authorization: 'Bearer ' + owner, 'content-type': 'application/json' };
    assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 403);
    const confirmed = await fetch(url, { method: 'POST', headers: { ...headers, origin: c.base, 'x-harness-human': 'click' }, body }); assert.equal(confirmed.status, 200); assert.ok((await confirmed.json()).job);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: c.base, 'x-harness-human': 'click' }, body })).status, 409);
    assert.equal(c.calls.length, 2);
    const members = read<any[]>(join(c.root, 'members.json'), []); members[0].disabled = true; atomicJson(join(c.root, 'members.json'), members);
    await assert.rejects(callHarnessTool(ctx, 'harness_status', {}), /Unauthorized/);
  } finally { await c.close(); }
});

test('OAuth PKCE over real HTTP rejects incorrect verifier/resource, code replay, revoked/expired grants and UI exposure', async () => {
  const c = await control(), origin = 'https://harness.example.org', oauth = new HarnessOAuth(c.root, origin, c.base, c.workspace);
  const app = createRemoteApp(oauth), server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = 'http://127.0.0.1:' + address.port;
  const headers = { host: 'harness.example.org', 'content-type': 'application/json' };
  // Node fetch normalizes Host to the URL. Model the tunnel's real Host header with node:http.
  const fetch = (url: string, options: any = {}): Promise<Response> => new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method || 'GET', headers: options.headers }, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as any })));
    }); req.on('error', reject); req.end(options.body?.toString());
  });
  const verifier = 'v'.repeat(64), challenge = createHash('sha256').update(verifier).digest('base64url');
  try {
    assert.throws(() => remoteOrigin('http://localhost:3000')); assert.throws(() => remoteOrigin('https://unstable.trycloudflare.com'));
    assert.equal((await fetch(base + '/journey', { headers })).status, 404);
    assert.equal((await fetch(base + '/v1/state', { headers })).status, 404);
    assert.equal((await fetch(base + '/mcp', { method: 'POST', headers, body: '{}' })).status, 401);
    assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { ...headers, authorization: 'Bearer ' + owner }, body: '{}' })).status, 401);
    const reg = await fetch(base + '/register', { method: 'POST', headers, body: JSON.stringify({ client_name: 'Test cloud client', redirect_uris: ['https://client.example.org/callback'], token_endpoint_auth_method: 'none' }) }); assert.equal(reg.status, 201); const client = await reg.json();
    const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: origin + '/mcp', scope: 'harness:read harness:prepare', state: 'original-state' });
    const auth = await fetch(base + '/authorize?' + params, { headers, redirect: 'manual' }); assert.equal(auth.status, 302); assert.ok(auth.headers.get('location')?.startsWith(c.base));
    const pending = oauth.pending({ id: 'author', role: 'owner' }); assert.equal(pending.length, 1);
    const consent = oauth.consent(pending[0].id, owner, pending[0].hash, true), redirect = new URL(consent.redirect); assert.equal(redirect.searchParams.get('state'), 'original-state');
    const exchange = (v: string, resource = origin + '/mcp') => fetch(base + '/token', { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code: redirect.searchParams.get('code')!, code_verifier: v, resource }) });
    assert.equal((await exchange('wrong')).status, 400); assert.equal((await exchange(verifier, origin + '/other')).status, 400);
    const exchanged = await exchange(verifier); assert.equal(exchanged.status, 200); const token = (await exchanged.json()).access_token; assert.notEqual(token, owner);
    assert.equal((await exchange(verifier)).status, 400);
    const remoteHeaders = { ...headers, authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream' };
    const rpc = (body: unknown) => fetch(base + '/mcp', { method: 'POST', headers: remoteHeaders, body: JSON.stringify(body) });
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Test cloud client', version: '1' } } }); assert.equal(init.status, 200);
    const tool = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'harness_status', arguments: {} } }); assert.equal(tool.status, 200); const output = await tool.json(); assert.match(output.result.content[0].text, /Connector fixture/); assert.doesNotMatch(JSON.stringify(output), new RegExp(owner));
    assert.equal(oauth.grants({ id: 'author', role: 'owner' })[0].lastCall?.tool, 'harness_status');
    const grant = oauth.grant(token); atomicJson(join(c.root, 'state/connectors/oauth/grants', grant.id + '.json'), { ...grant, expiresAt: 1 });
    assert.equal((await rpc({})).status, 401); atomicJson(join(c.root, 'state/connectors/oauth/grants', grant.id + '.json'), grant);
    atomicJson(join(c.root, 'state/connectors/oauth/grants', grant.id + '.json'), { ...grant, scopes: ['harness:read'] });
    assert.equal((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'harness_sources', arguments: {} } })).status, 200);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'harness_request_confirmation', arguments: { requestId: 'forbidden-cloud', action: { operation: 'member-disable', memberId: 'reader' } } } })).status, 403);
    const bound = oauth.toolContext(token);
    oauth.revoke(grant.id); assert.equal((await rpc({})).status, 401);
    await assert.rejects(callHarnessTool(bound, 'harness_request_confirmation', { requestId: 'revoked-cloud', action: { operation: 'member-disable', memberId: 'reader' } }), /revoked/);
    assert.equal(pendingConfirmations(c.root).length, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await c.close(); }
});

test('voice handshake keeps key server-side, config separate and raw audio absent', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, '.env'), 'OPENAI_REALTIME_API_KEY=fixture-voice-key\n');
    const publication = readFileSync(join(f.root, 'config/model.json'), 'utf8'); let captured: any;
    const fetcher: typeof fetch = async (url, options) => { captured = { url, options }; return new Response('v=0\r\nanswer'); };
    if (releaseProfile().edition === 'free') {
      await assert.rejects(realtimeSession(f.root, 'v=0\r\noffer', fetcher), /unavailable in this Free package/);
      assert.equal(captured, undefined, 'Free refuses before contacting the voice provider');
      assert.equal(readFileSync(join(f.root, 'config/model.json'), 'utf8'), publication);
      assert.equal(conversationState(f.root).audioStorage, 'none');
      return;
    }
    const result = await realtimeSession(f.root, 'v=0\r\noffer', fetcher); assert.equal(result.sdp, 'v=0\r\nanswer');
    assert.equal(captured.options.headers.authorization, 'Bearer fixture-voice-key'); assert.doesNotMatch(JSON.stringify(result), /fixture-voice-key/);
    const session = JSON.parse(captured.options.body.get('session')); assert.equal(session.audio.input.turn_detection.interrupt_response, true); assert.equal(session.tools.length, Object.keys(TOOL_DEFINITIONS).length);
    assert.equal(readFileSync(join(f.root, 'config/model.json'), 'utf8'), publication); assert.equal(conversationState(f.root).audioStorage, 'none');
    await assert.rejects(realtimeSession(f.root, 'invalid', fetcher), /Invalid/);
    await assert.rejects(realtimeSession(f.root, 'v=0', async () => new Response('', { status: 401 })), /HTTP 401/);
  } finally { f.cleanup(); }
});

test('local queue preserves independent review, refuses stale artifacts and unauthorized cancellation', async () => {
  const c = await control(), ctx = { root: c.root, token: owner, api: c.api, connection: 'review-test' };
  try {
    atomicJson(join(c.root, 'desks.json'), { news: { editions: ['daily-roundup'], channels: ['youtube'], twoPersonRule: true } });
    const id = '20260908-review', meta = { id, edition: 'daily-roundup', createdBy: 'author', status: 'pending_review' };
    atomicJson(join(c.root, 'workdir/videos', id, 'meta.json'), meta);
    for (const file of ['topic.json', 'script.json', 'final.mp4']) writeFileSync(join(c.root, 'workdir/videos', id, file), 'fixture bytes');
    const current = await c.api('/v1/packages/' + id);
    await callHarnessTool(ctx, 'harness_request_confirmation', { requestId: 'independent-review', action: { operation: 'approve', id, expectedHash: current.hash } });
    const req = pendingConfirmations(c.root)[0];
    const click = (token: string, allow = true) => fetch(c.base + '/v1/connectors/review?workspace=' + c.workspace, { method: 'POST', headers: { authorization: 'Bearer ' + token, origin: c.base, 'x-harness-human': 'click', 'content-type': 'application/json' }, body: JSON.stringify({ id: req.id, expectedHash: req.hash, allow }) });
    assert.equal((await click(viewer, false)).status, 403); assert.equal(pendingConfirmations(c.root).length, 1);
    assert.match(JSON.stringify(await (await click(owner)).json()), /Independent reviewer/); assert.equal(c.calls.length, 0);
    assert.equal((await click(reviewer)).status, 200); assert.equal(c.calls.length, 1); assert.equal(c.calls[0].token, reviewer);
    await callHarnessTool(ctx, 'harness_request_confirmation', { requestId: 'stale-review-test', action: { operation: 'approve', id, expectedHash: current.hash } });
    atomicJson(join(c.root, 'workdir/videos', id, 'script.json'), { text: 'Changed after review' });
    const stale = pendingConfirmations(c.root)[0];
    const response = await fetch(c.base + '/v1/connectors/review?workspace=' + c.workspace, { method: 'POST', headers: { authorization: 'Bearer ' + reviewer, origin: c.base, 'x-harness-human': 'click', 'content-type': 'application/json' }, body: JSON.stringify({ id: stale.id, expectedHash: stale.hash, allow: true }) });
    assert.equal(response.status, 409); assert.equal(c.calls.length, 1);
    const other = fixture(); try { await assert.rejects(harnessApi(c.base, other.workspace, 'f'.repeat(64))('/v1/state'), /Unauthorized/); } finally { other.cleanup(); }
  } finally { await c.close(); }
});

test('disconnect cancels a queued local setup and an in-progress cloud start', async () => {
  const c = await control();
  const envPath = process.env.PATH;
  const bin = join(c.root, 'bin'); mkdirSync(bin); writeFileSync(join(bin, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'), 'fixture');
  process.env.PATH = bin + (process.platform === 'win32' ? ';' : ':') + envPath;
  const { connectorController } = await import('./connector-control.js'); const controller = connectorController(CODE_ROOT);
  try {
    const setup = configureConnection(c.root, 'claude', owner);
    await disconnectConnection(c.root, 'claude', owner);
    await assert.rejects(setup, /cancelled/);
    const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening'); const address = portProbe.address(); assert.ok(address && typeof address !== 'string'); const port = address.port; await new Promise<void>(r => portProbe.close(() => r()));
    atomicJson(join(c.root, 'state/connectors/remote.json'), { origin: 'https://harness.example.org', tunnelId: '12345678-1234-4234-8234-123456789abc', credentialsFile: join(c.root, 'unused.json'), port });
    const start = controller.handle('/v1/connectors/remote/start', 'POST', c.root, owner, c.base, {}, true);
    await controller.handle('/v1/connectors/remote/stop', 'POST', c.root, owner, c.base, {}, true);
    await assert.rejects(start, /cancelled/);
    assert.equal((await controller.handle('/v1/connectors', 'GET', c.root, owner, c.base, {}, false)).remote.running, false);
  } finally { process.env.PATH = envPath; controller.close(); await c.close(); }
});

test('human confirmation rejects proposals from a revoked connector or changed requester membership', async () => {
  const c = await control();
  try {
    atomicJson(join(c.root, 'desks.json'), { news: { editions: ['daily-roundup'], channels: ['youtube'], twoPersonRule: true } });
    const id = '20260908-revocation'; atomicJson(join(c.root, 'workdir/videos', id, 'meta.json'), { id, edition: 'daily-roundup', createdBy: 'author', status: 'pending_review' });
    for (const f of ['topic.json','script.json','final.mp4']) writeFileSync(join(c.root, 'workdir/videos', id, f), 'fixture bytes');
    const { hash } = await c.api('/v1/packages/' + id), conn = await configureConnection(c.root, 'claude', owner);
    const ctx = { root: c.root, token: owner, api: c.api, connection: conn.id, origin: { kind: 'local' as const, id: conn.id, generation: conn.generation } };
    const review = async (requestId: string, context: any) => { await callHarnessTool(context, 'harness_request_confirmation', { requestId, action: { operation: 'approve', id, expectedHash: hash } }); return pendingConfirmations(c.root).find(r => r.status === 'pending' && r.origin?.kind === context.origin?.kind)!; };
    const click = (r: any) => fetch(c.base + '/v1/connectors/review?workspace=' + c.workspace, { method: 'POST', headers: { authorization: 'Bearer ' + reviewer, origin: c.base, 'x-harness-human': 'click', 'content-type': 'application/json' }, body: JSON.stringify({ id: r.id, expectedHash: r.hash, allow: true }) });
    const old = await embeddedConnector(c.root, conn.id, conn.generation);
    const request = await review('revoked-local-origin', ctx); await disconnectConnection(c.root, 'claude', owner);
    assert.equal((await click(request)).status, 401); assert.equal(c.calls.length, 0);
    await configureConnection(c.root, 'claude', owner);
    assert.equal((await click(request)).status, 401);
    try { await assert.rejects(callHarnessTool(old.context, 'harness_status', {}), /Unauthorized/); } finally { old.close(); }
    const memberRequest = await review('revoked-member-origin', { ...ctx, origin: undefined });
    const list = read<any[]>(join(c.root, 'members.json'), []); list[0].disabled = true; atomicJson(join(c.root, 'members.json'), list);
    assert.equal((await click(memberRequest)).status, 403); assert.equal(c.calls.length, 0);
  } finally { await c.close(); }
});

test('model-visible results and errors redact workspace credentials and credential-bearing URLs', async () => {
  const f = await control();
  try {
    writeFileSync(join(f.root, '.env'), 'OPENAI_REALTIME_API_KEY=fixture-secret-voice-key\nSECOND_SECRET="line1\nline2"\nTHIRD_API_KEY=true\n');
    const ctx = { root: f.root, token: owner, connection: 'redaction', api: async () => ({ enabled: true, multiline: 'line1\nline2', key: 'fixture-secret-voice-key', ownerToken: owner, url: 'https://user:pass@example.org/data?api_key=example-secret' }) };
    const result = JSON.stringify(await callHarnessTool(ctx, 'harness_setup', {}));
    assert.equal(JSON.parse(result).enabled, true); assert.equal(JSON.parse(result).multiline, '[redacted]');
    assert.doesNotMatch(result, /fixture-secret-voice-key|user:pass|example-secret/); assert.doesNotMatch(result, new RegExp(owner));
    await assert.rejects(callHarnessTool({ ...ctx, api: async () => { throw new Error('failed: fixture-secret-voice-key'); } }, 'harness_status', {}), /failed: \[redacted\]/);
    assert.match(readFileSync(join(f.root, '.env'), 'utf8'), /fixture-secret-voice-key/);
    const sourceFile = join(f.root, 'config/sources.json'), sources = read<any>(sourceFile, {});
    sources.rss = ['https://provider.example/feed?key=private-feed&client_secret=private-client&refresh_token=private-refresh']; atomicJson(sourceFile, sources);
    const setup = JSON.stringify(await callHarnessTool({ ...ctx, api: f.api }, 'harness_setup', {}));
    assert.doesNotMatch(setup, /private-feed|private-client|private-refresh/);
    assert.match(readFileSync(sourceFile, 'utf8'), /private-feed/);
  } finally { await f.close(); }
});

test('the repository plugin binds itself on first launch and serves a real harness tool call over stdio', async () => {
  const f = fixture();
  try {
    // The marketplaces point at the one plugin directory, and its Claude MCP entry launches the self-binding server.
    const claudeMarket = JSON.parse(readFileSync(join(CODE_ROOT, '.claude-plugin/marketplace.json'), 'utf8')), codexMarket = JSON.parse(readFileSync(join(CODE_ROOT, '.agents/plugins/marketplace.json'), 'utf8'));
    assert.equal(claudeMarket.plugins[0].source, './plugins/content-harness'); assert.equal(codexMarket.plugins[0].source.path, './plugins/content-harness');
    assert.ok(existsSync(join(CODE_ROOT, 'plugins/content-harness/.claude-plugin/plugin.json')) && existsSync(join(CODE_ROOT, 'plugins/content-harness/skills/content-harness/SKILL.md')));
    assert.deepEqual(JSON.parse(readFileSync(join(CODE_ROOT, 'plugins/content-harness/.mcp.json'), 'utf8')).mcpServers['content-harness'].args, ['${CLAUDE_PLUGIN_ROOT}/bin/serve.mjs']);
    for (const file of readFileSync(join(CODE_ROOT, 'plugins/content-harness/bin/serve.mjs'), 'utf8').split('\n')) assert.doesNotMatch(file, /[a-f0-9]{64}/);
    // First launch binds; a second launch reuses the same connection and generation; no agent settings file is touched.
    const first = selfServeConnection(f.root, 'claude', owner), again = selfServeConnection(f.root, 'claude', owner);
    assert.equal(first.selfServe, true); assert.equal(again.id, first.id); assert.equal(again.generation, first.generation); assert.equal(first.config, undefined); assert.equal(first.plugin, undefined);
    const client = new Client({ name: 'Plugin fixture', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(CODE_ROOT, 'plugins/content-harness/bin/serve.mjs')], env: { ...process.env, CONTENT_HARNESS_ROOT: CODE_ROOT, CLAUDE_PLUGIN_ROOT: join(CODE_ROOT, 'plugins/content-harness'), HARNESS_WORKSPACE: f.workspace, HARNESS_TOKEN: owner }, stderr: 'pipe' });
    let diagnostic = ''; transport.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
    try {
      await client.connect(transport, { timeout: 30000 });
      const tools = await client.listTools(); assert.equal(tools.tools.length, Object.keys(TOOL_DEFINITIONS).length);
      const result: any = await client.callTool({ name: 'harness_status', arguments: {} }, undefined, { timeout: 30000 });
      assert.equal(result.isError, undefined, diagnostic); assert.match(result.content[0].text, /Connector fixture/); assert.doesNotMatch(result.content[0].text, new RegExp(owner));
    } finally { await client.close(); await transport.close(); }
    assert.equal(loadConnection(f.root, first.id).proof?.client, 'Plugin fixture');
    await disconnectConnection(f.root, 'claude', owner); assert.throws(() => loadConnection(f.root, first.id), /Unauthorized/);
  } finally { f.cleanup(); }
});
