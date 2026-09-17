import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CODE_ROOT, atomicJson } from './workspaces.js';
import { installedPack, runWorkflowPack, workflowBrief } from './workflow-packs.js';

test('both pack workflows reach exact human review; entitlement, stale input and interrupted jobs fail closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-pack-')), token = 'd'.repeat(64), { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const payload = { version: 1, issuer: 'myownai-labs', subject: 'example-team', plan: 'pro', packs: ['executive-briefing', 'audience-engagement'], issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60000 };
  const license = (p: any) => atomicJson(join(root, 'state/pro-entitlement.json'), { payload: p, signature: sign(null, Buffer.from(JSON.stringify(p)), privateKey).toString('base64') });
  try {
    atomicJson(join(root, 'workspace.json'), { id: 'example-team' }); atomicJson(join(root, 'members.json'), [{ id: 'owner', role: 'owner', tokenHash: createHash('sha256').update(token).digest('hex') }]);
    atomicJson(join(root, 'config/pro-issuer.json'), { publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }); if (process.env.HARNESS_TEST_PACK_DIR) cpSync(process.env.HARNESS_TEST_PACK_DIR, join(root, 'packs'), { recursive: true });
    else for (const id of payload.packs) atomicJson(join(root, 'packs', id, 'pack.json'), { id, version: 1, title: 'Test fixture', instructions: 'Inspect the prepared output.', reviewChecklist: ['Check evidence.'] }); license(payload);
    assert.match(workflowBrief(root, 'executive-briefing', root), new RegExp(installedPack(root, 'executive-briefing', root).instructions.slice(0, 20)));
    const ctx = { root, token, connection: 'test', api: async () => ({}) }, calls: any[] = [];
    let status = 'running';
    const tool = async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === 'harness_draft' || name === 'harness_suggest_reply') return { job: 'e'.repeat(64) };
      if (name === 'harness_status') return args.job ? { status, result: { id: '20260908-example' } } : { hash: 'f'.repeat(64) };
      if (name === 'harness_engagement') return { items: [{ id: '1'.repeat(64), videoId: '20260908-example', platform: 'youtube', reply: 'A sourced answer.', status: 'drafted', hash: 'f'.repeat(64) }] };
      if (name === 'harness_request_confirmation') return { status: 'pending', request: '2'.repeat(64) };
      return {};
    };
    const briefing = { pack: 'executive-briefing', edition: 'daily-roundup', requestId: 'briefing-once' };
    assert.equal((await runWorkflowPack(ctx, briefing, tool, root)).status, 'preparing'); status = 'done';
    const result = await runWorkflowPack(ctx, briefing, tool, root); assert.equal(result.status, 'review'); assert.equal(result.review.status, 'pending'); assert.equal(calls.filter(c => c.name === 'harness_draft').length, 1);
    const count = calls.length; assert.equal((await runWorkflowPack(ctx, briefing, tool, root)).review.status, 'unavailable'); assert.equal(calls.length, count);
    assert.equal(calls.find(c => c.name === 'harness_draft').args.workflowPack, 'executive-briefing');
    atomicJson(join(root, 'state/connector-review', '2'.repeat(64) + '.json'), { status: 'denied' });
    assert.equal((await runWorkflowPack(ctx, briefing, tool, root)).review.status, 'denied');
    const engagement = { pack: 'audience-engagement', videoId: '20260908-example', platform: 'youtube', itemId: '1'.repeat(64), requestId: 'engagement-once' };
    assert.equal((await runWorkflowPack(ctx, engagement, tool, root)).status, 'review'); assert.equal(calls.at(-1).args.action.operation, 'engagement-approve');
    assert.ok(calls.every(c => !['approve', 'publish', 'send'].includes(c.name)));
    await assert.rejects(runWorkflowPack(ctx, { ...briefing, edition: 'another' }, tool, root), /Conflict/);
    status = 'interrupted'; await assert.rejects(runWorkflowPack(ctx, { ...briefing, requestId: 'interrupted-once' }, tool, root), /No automatic replay/);
    const n = calls.filter(c => c.name === 'harness_draft').length; await assert.rejects(runWorkflowPack(ctx, { ...briefing, requestId: 'interrupted-once' }, tool, root)); assert.equal(calls.filter(c => c.name === 'harness_draft').length, n);
    license({ ...payload, subject: 'wrong-workspace' }); assert.throws(() => installedPack(root, 'executive-briefing', root), /workspace/);
    license({ ...payload, expiresAt: 1 }); assert.throws(() => installedPack(root, 'audience-engagement', root), /expired/);
    atomicJson(join(root, 'state/pro-entitlement.json'), { payload, signature: Buffer.alloc(64).toString('base64') }); assert.throws(() => installedPack(root, 'executive-briefing', root), /signature/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
