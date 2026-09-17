import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { CODE_ROOT, atomicJson, read } from './workspaces.js';
import { createControlServer } from './control.js';
import { callHarnessTool, harnessApi } from './connector-tools.js';

test('Free LinkedIn work uses the configured writer, saves actor-owned review drafts and deduplicates accepted jobs', async () => {
  mkdirSync(join(CODE_ROOT, 'workspaces'), { recursive: true });
  const root = mkdtempSync(join(CODE_ROOT, 'workspaces/linkedin-integration-')), workspace = basename(root);
  const owner = 'a'.repeat(64), viewer = 'b'.repeat(64);
  cpSync(join(CODE_ROOT, 'config'), join(root, 'config'), { recursive: true });
  atomicJson(join(root, 'workspace.json'), { id: workspace, name: 'LinkedIn test' });
  atomicJson(join(root, 'desks.json'), {});
  atomicJson(join(root, 'members.json'), [[owner, 'owner'], [viewer, 'viewer']].map(([token, role]) => ({ id: role, role, tokenHash: createHash('sha256').update(token).digest('hex') })));
  const text = 'The pilot reduced duplicate entries.';
  const expected = { mode: 'post', title: 'An operational lesson', text, alternatives: [], reviewNotes: ['Review the pilot evidence before sharing.'], sourceUrls: [], claims: [{ text, kind: 'supplied', evidenceQuote: text }] };
  let calls = 0;
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); calls++;
    assert.match(JSON.stringify(input.messages), /untrusted quoted material/);
    assert.equal(input.tools, undefined);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(expected) } }] }));
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const m = model.address(); assert.ok(m && typeof m !== 'string');
  atomicJson(join(root, 'config/model.json'), { provider: 'openai-compatible', timeoutSeconds: 10, rescue: { enabled: false }, providers: { openaiCompatible: { baseUrl: `http://127.0.0.1:${m.port}/v1`, model: 'fixture' } } });
  const server = createControlServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const api = harnessApi(base, workspace, owner), readApi = harnessApi(base, workspace, viewer);
  const ctx = { root, token: owner, api, connection: 'linkedin-test' };
  try {
    const input = { mode: 'post', text };
    const first = await callHarnessTool(ctx, 'harness_linkedin_workbench', { input, requestId: 'draft-one' });
    const repeated = await callHarnessTool(ctx, 'harness_linkedin_workbench', { input, requestId: 'draft-one' });
    assert.equal(first.job, repeated.job);
    let job: any;
    for (let i = 0; i < 100; i++) { job = await api('/v1/journey/jobs/' + first.job); if (job.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(job.status, 'done', job.error);
    assert.equal(calls, 1);
    assert.equal(job.result.status, 'review-required');
    assert.equal(job.result.result.text, text);
    assert.match(job.result.fingerprint, /^[a-f0-9]{64}$/);
    const saved = await api('/v1/linkedin'); assert.equal(saved.length, 1);
    assert.equal((await api('/v1/linkedin?receipt=' + saved[0].receiptId)).result.text, text);
    assert.deepEqual(await readApi('/v1/linkedin'), []);
    await assert.rejects(readApi('/v1/linkedin?receipt=' + saved[0].receiptId), /Unknown LinkedIn draft/);
    await assert.rejects(readApi('/v1/journey/jobs/' + first.job), /Unknown action/);
    await assert.rejects(callHarnessTool({ ...ctx, token: viewer, api: readApi }, 'harness_linkedin_workbench', { input, requestId: 'viewer-one' }), /Forbidden/);
    await assert.rejects(callHarnessTool(ctx, 'harness_linkedin_workbench', { input: { ...input, send: true }, requestId: 'cannot-send' }));
    await assert.rejects(callHarnessTool(ctx, 'harness_linkedin_workbench', { input: { mode: 'outreach', text }, requestId: 'cannot-outreach' }));
    const file = read<any>(join(root, 'workdir/linkedin', saved[0].receiptId + '.json'), {});
    assert.equal(file.actor, 'owner');
    assert.equal(file.input.text, text);
    assert.equal(file.approvedAt, undefined);
    const settings = await api('/v1/journey/linkedin-reader-settings', { apiKey: 'apify_fixture_key_only' }, 'save-key-one');
    for (let i = 0; i < 50; i++) { job = await api('/v1/journey/jobs/' + settings.job); if (job.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(job.status, 'done', job.error);
    assert.doesNotMatch(JSON.stringify(job), /apify_fixture_key_only/);
    assert.match(readFileSync(join(root, '.env'), 'utf8'), /APIFY_TOKEN=/);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
