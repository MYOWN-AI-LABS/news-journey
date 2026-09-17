import test from 'node:test';
import assert from 'node:assert/strict';
import { followUpOnce } from './engagement-followup.mjs';

test('runner waits for the matching job and reports partial/manual work as nonzero', async () => {
  const original = globalThis.fetch, calls = [], token = 'a'.repeat(64), jobId = 'b'.repeat(64);
  const input = { base: 'http://127.0.0.1:4791', token, workspace: 'sample', videoId: 'publication', platforms: ['linkedin'], runId: 'follow-up', requestId: 'request-one', pollMs: 1 };
  let status = 'running';
  globalThis.fetch = async (url, options) => {
    calls.push([new URL(url).pathname, options.method]);
    assert.equal(new URL(url).searchParams.get('workspace'), 'sample');
    assert.equal(options.headers.authorization, 'Bearer ' + token);
    if (options.method === 'POST') return Response.json({ job: jobId });
    if (status === 'running') { status = 'done'; return Response.json({ status: 'running' }); }
    return Response.json({ status, result: { run: { id: 'follow-up', videoId: 'publication', status: 'partial' }, handoffs: [{ platform: 'linkedin' }], message: 'Manual channel requires attention.' } });
  };
  try {
    const result = await followUpOnce(input);
    assert.equal(result.exitCode, 2); assert.equal(calls.length, 3); assert.equal(result.handoffs.length, 1);
    status = 'failed'; await assert.rejects(followUpOnce(input), /job failed/);
    status = 'interrupted'; await assert.rejects(followUpOnce(input), /job interrupted/);
    assert.ok(calls.every(([path]) => path === '/v1/journey/engagement-followup' || path === '/v1/journey/jobs/' + jobId));
    const before = calls.length; await assert.rejects(followUpOnce({ ...input, base: 'https://example.com' }), /loopback/); assert.equal(calls.length, before);
  } finally { globalThis.fetch = original; }
});

test('no completion from an unrelated or missing receipt', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => Response.json(options.method === 'POST' ? { job: 'b'.repeat(64) } : { status: 'done', result: { run: { id: 'another-run', videoId: 'publication', status: 'complete' } } });
  try { await assert.rejects(followUpOnce({ base: 'http://localhost:4791', token: 'a'.repeat(64), workspace: 'sample', videoId: 'publication', platforms: ['x'], runId: 'follow-up', requestId: 'request-two' }), /matching follow-up/); }
  finally { globalThis.fetch = original; }
});
