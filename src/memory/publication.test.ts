import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PostResult, VideoMeta } from '../types.js';
import { assertAcceptedPlatformMemory, assertNewsletterSubmissionReceipt, newsletterSubmissionBinding, recordAcceptedPlatformMemory } from './publication.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('profile discovery cannot label an older receipt as the newly approved artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-platform-receipt-'));
  const meta = { id: '20260914-sports', explicitApproval: { topicSha256: sha('topic'), scriptSha256: sha('script'), videoSha256: sha('video') } } as VideoMeta;
  const post: PostResult = { id: 'provider-123', url: 'https://example.org/post/123', platform: 'x', postedAt: new Date().toISOString(), receiptOrigin: 'profile-discovery' };
  try {
    assert.equal(recordAcceptedPlatformMemory(meta, 'x', post, root), false);
    assert.throws(() => assertAcceptedPlatformMemory(meta, 'x', post, root), /no exact package-bound/);
    assert.equal(recordAcceptedPlatformMemory(meta, 'x', { ...post, receiptOrigin: undefined }, root), false);
    assert.equal(recordAcceptedPlatformMemory(meta, 'x', { ...post, receiptOrigin: 'provider-response' }, root), true);
    assert.doesNotThrow(() => assertAcceptedPlatformMemory(meta, 'x', post, root));
    assert.equal(recordAcceptedPlatformMemory(meta, 'x', post, root), true, 'discovery may only reuse an existing exact receipt');
    assert.throws(() => assertAcceptedPlatformMemory(meta, 'x', { ...post, id: 'older-live-post' }, root), /no exact package-bound/);
    for (const key of ['topicSha256', 'scriptSha256', 'videoSha256']) {
      const changed = { ...meta, explicitApproval: { ...meta.explicitApproval!, [key]: sha('changed') } };
      assert.equal(recordAcceptedPlatformMemory(changed, 'x', post, root), false);
      assert.throws(() => assertAcceptedPlatformMemory(changed, 'x', post, root), /no exact package-bound/);
      assert.doesNotThrow(() => assertAcceptedPlatformMemory(meta, 'x', post, root), 'failed adoption must preserve original receipt');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same-title and legacy live articles cannot confirm a different approved story packet', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-newsletter-receipt-'));
  const meta = { id: '20260914-sports', edition: 'daily-roundup', explicitApproval: { topicSha256: sha('topic'), newsletterDataSha256: sha('data'), newsletterLinkedinHtmlSha256: sha('html') } } as VideoMeta;
  const url = 'https://www.linkedin.com/pulse/current-sports';
  try {
    mkdirSync(join(root, 'workdir/newsletters'), { recursive: true });
    const save = (value: unknown) => writeFileSync(join(root, 'workdir/newsletters/.published-2026-09-14'), JSON.stringify(value));
    save({ url, subject: 'Sports daily', at: new Date().toISOString() });
    assert.throws(() => assertNewsletterSubmissionReceipt(meta, url, root), /no exact package-bound/);
    const marker = { url, memoryBinding: newsletterSubmissionBinding(meta) };
    save(marker);
    assert.doesNotThrow(() => assertNewsletterSubmissionReceipt(meta, url, root));
    assert.throws(() => assertNewsletterSubmissionReceipt(meta, url + '-older', root), /no exact package-bound/);
    for (const key of ['sourceVideoId', 'topicSha256', 'newsletterDataSha256', 'newsletterLinkedinHtmlSha256']) {
      save({ ...marker, memoryBinding: { ...marker.memoryBinding, [key]: key === 'sourceVideoId' ? '20260914-cities' : sha('changed') } });
      assert.throws(() => assertNewsletterSubmissionReceipt(meta, url, root), /no exact package-bound/, key);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('even approved unchanged newsletter bytes must name the exact source package', () => {
  const code = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(join(code, 'workspaces'), { recursive: true });
  const workspace = mkdtempSync(join(code, 'workspaces/test-newsletter-memory-'));
  const slug = workspace.split('/').at(-1)!, token = 'b'.repeat(64);
  try {
    writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({ id: slug }));
    writeFileSync(join(workspace, 'members.json'), JSON.stringify([{ id: 'fixture-owner', role: 'owner', tokenHash: sha(token) }]));
    const program = `
      import assert from 'node:assert/strict';
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { currentExplicitApprovalHashes } from ${JSON.stringify(new URL('../pipeline/explicit-approval.ts', import.meta.url).href)};
      import { assertApprovedNewsletterPackage } from ${JSON.stringify(new URL('./publication.ts', import.meta.url).href)};
      const root = ${JSON.stringify(workspace)}, id = '20260914-sports';
      const dir = join(root, 'workdir/videos', id), news = join(root, 'workdir/newsletters');
      mkdirSync(dir, { recursive: true }); mkdirSync(news, { recursive: true });
      for (const file of ['topic.json', 'script.json', 'final.mp4']) writeFileSync(join(dir, file), file);
      writeFileSync(join(news, '2026-09-14.linkedin.html'), '<p>Approved fixture</p>');
      const meta = { id, edition: 'daily-roundup', status: 'approved', posts: {} };
      function approve(data) {
        writeFileSync(join(news, '2026-09-14.json'), JSON.stringify(data));
        meta.explicitApproval = { approvedAt: new Date().toISOString(), ...currentExplicitApprovalHashes(meta) };
      }
      for (const bad of [{ sourceVideoId: '20260914-cities' }, { video: { id } }, { sourceVideoId: id, video: { id: '20260914-cities' } }]) {
        approve(bad);
        assert.throws(() => assertApprovedNewsletterPackage(meta), /source identity/);
      }
      approve({ sourceVideoId: id, video: null });
      assert.doesNotThrow(() => assertApprovedNewsletterPackage(meta));
      assert.throws(() => assertApprovedNewsletterPackage(meta, '2026-09-13'), /not bound/);
      writeFileSync(join(news, '2026-09-14.linkedin.html'), '<p>Changed after approval</p>');
      assert.throws(() => assertApprovedNewsletterPackage(meta), /artifact hashes changed/);
      process.stdout.write('EXACT_NEWSLETTER_BINDING_PASSED');
    `;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { cwd: code, encoding: 'utf8', timeout: 20000, env: { ...env, HARNESS_WORKSPACE: slug, HARNESS_TOKEN: token } });
    assert.match(output, /EXACT_NEWSLETTER_BINDING_PASSED/);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
