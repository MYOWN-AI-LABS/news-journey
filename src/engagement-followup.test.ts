import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { CODE_ROOT, atomicJson } from './workspaces.js';
import { runEngagementFollowUp, followUpState } from './engagement-followup.js';
import { engagementState } from './engagement.js';
import { TOOL_DEFINITIONS, callHarnessTool } from './connector-tools.js';

test('follow-ups resume exact posts, deduplicate, isolate workspaces, report manual/failure coverage and never send', async () => {
  mkdirSync(join(CODE_ROOT, 'workspaces'), { recursive: true });
  const root = mkdtempSync(join(CODE_ROOT, 'workspaces/follow-up-'));
  const other = mkdtempSync(join(CODE_ROOT, 'workspaces/follow-up-'));
  const free = mkdtempSync(join(tmpdir(), 'follow-up-free-'));
  const saved = { workspace: process.env.HARNESS_WORKSPACE, token: process.env.HARNESS_TOKEN, fetch: globalThis.fetch };
  const token = 'd'.repeat(64), viewer = 'e'.repeat(64);
  for (const path of [root, other]) {
    cpSync(join(CODE_ROOT, 'config'), join(path, 'config'), { recursive: true });
    atomicJson(join(path, 'workspace.json'), { id: basename(path) });
    atomicJson(join(path, 'members.json'), [[token, 'owner'], [viewer, 'viewer']].map(([value, role]) => ({ id: role, role, desks: [], tokenHash: createHash('sha256').update(value).digest('hex') })));
    atomicJson(join(path, 'state/tokens/x.json'), { accessToken: 'fixture-token' });
  }
  process.env.HARNESS_WORKSPACE = basename(root); process.env.HARNESS_TOKEN = token;
  const meta = { id: '20260913-example', headline: 'Current publication facts', posts: { x: { id: '123', url: 'https://x.com/i/status/123' }, linkedin: { id: '456', url: 'https://www.linkedin.com/feed/update/456' } } };
  atomicJson(join(root, 'workdir/videos', meta.id, 'meta.json'), meta);
  const input = { videoId: meta.id, platforms: ['linkedin', 'x'], runId: 'review-one' };
  let requests = 0, fail = true;
  globalThis.fetch = (async (url: any, options: any = {}) => {
    requests++; assert.equal(options.method, 'GET', 'workflow must never send');
    assert.equal(new URL(String(url)).origin, 'https://api.x.com');
    if (fail) throw new Error('Read access unavailable');
    if (String(url).includes('/users/me')) return Response.json({ data: { id: '42' } });
    if (String(url).includes('/tweets/123')) return Response.json({ data: { author_id: '42' } });
    return Response.json({ data: [{ id: '789', author_id: '55', text: 'How does this work?', conversation_id: '123', referenced_tweets: [{ type: 'replied_to', id: '123' }] }], meta: {} });
  }) as typeof fetch;
  try {
    assert.equal(followUpState(root).status, 'not-run');
    const first: any = await runEngagementFollowUp(input);
    assert.equal(first.run.status, 'partial');
    assert.match(first.run.steps.find((s: any) => s.platform === 'x').error, /Read access unavailable/);
    assert.equal(first.run.steps.find((s: any) => s.platform === 'linkedin').status, 'manual');
    fail = false;
    const resumed: any = await runEngagementFollowUp(input);
    assert.equal(resumed.run.headline, meta.headline);
    assert.equal(resumed.run.steps.find((s: any) => s.platform === 'x').status, 'complete');
    assert.equal(resumed.run.status, 'partial', 'manual channel must never count as collected');
    assert.equal(resumed.reviewItems.length, 1);
    const count = requests; await runEngagementFollowUp(input); assert.equal(requests, count, 'completed collection must not replay');
    await runEngagementFollowUp({ ...input, runId: 'review-two' });
    assert.equal(engagementState(root).total, 1, 'later collection deduplicates the same comment');
    assert.equal(engagementState(root).items[0].status, 'new');
    assert.equal(engagementState(root).items[0].reply, undefined);
    await assert.rejects(runEngagementFollowUp({ ...input, platforms: ['x'] }), /Conflict/);
    atomicJson(join(root, 'workdir/videos', meta.id, 'meta.json'), { ...meta, posts: { ...meta.posts, x: { id: '999', url: 'https://x.com/i/status/999' } } });
    await assert.rejects(runEngagementFollowUp(input), /Conflict/);
    process.env.HARNESS_TOKEN = viewer;
    await assert.rejects(runEngagementFollowUp(input), /Forbidden/);
    process.env.HARNESS_TOKEN = token; process.env.HARNESS_WORKSPACE = basename(other);
    assert.equal(followUpState(other).runs.length, 0); assert.equal(engagementState(other).total, 0);
    await assert.rejects(runEngagementFollowUp(input), /Unknown publication/);
    atomicJson(join(free, 'config/distribution.json'), { edition: 'free', evaluation: true });
    const before = requests;
    await assert.rejects(runEngagementFollowUp(input, free), /planned Pro/);
    assert.equal(requests, before, 'Free refuses before any provider request');
    assert.equal(JSON.parse(readFileSync(join(root, 'state/engagement-followups/review-one.json'), 'utf8')).status, 'partial');
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.workspace === undefined) delete process.env.HARNESS_WORKSPACE; else process.env.HARNESS_WORKSPACE = saved.workspace;
    if (saved.token === undefined) delete process.env.HARNESS_TOKEN; else process.env.HARNESS_TOKEN = saved.token;
    for (const path of [root, other, free]) rmSync(path, { recursive: true, force: true });
  }
});

test('agent follow-up tool uses the named collection hook and rejects send/config fields', async () => {
  const args = { videoId: 'recorded-post', platforms: ['x'], runId: 'review-one', requestId: 'request-one' };
  assert.throws(() => TOOL_DEFINITIONS.harness_follow_up.schema.parse({ ...args, send: true }));
  let called: any;
  const root = mkdtempSync(join(tmpdir(), 'follow-up-tool-')), token = 'f'.repeat(64);
  atomicJson(join(root, 'workspace.json'), { id: basename(root) });
  atomicJson(join(root, 'members.json'), [{ id: 'owner', role: 'owner', tokenHash: createHash('sha256').update(token).digest('hex') }]);
  try {
    const result = await callHarnessTool({ root, connection: 'fixture', token, origin: 'http://127.0.0.1:4791', api: async (...request: any[]) => { called = request; return { job: 'queued' }; } } as any, 'harness_follow_up', args);
    assert.equal(called[0], '/v1/journey/engagement-followup');
    assert.deepEqual(called[1], { videoId: args.videoId, platforms: args.platforms, runId: args.runId });
    assert.equal(result.job, 'queued');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
