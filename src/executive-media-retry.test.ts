import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { workerAction } from './control.js';
import { quickPreviewRetryKey } from './executive-actions.js';
import { atomicJson, CODE_ROOT } from './workspaces.js';

test('every failed media stage retries its exact owned package before setup, collection or any network call', async () => {
  const root = mkdtempSync(join(CODE_ROOT, 'workspaces/media-retry-check-'));
  const token = 'a'.repeat(64), description = 'Report current sports stories for the existing publication.';
  const data = { description, model: 'codex', voiceProvider: 'kokoro' };
  const requestHash = createHash('sha256').update(JSON.stringify({ description, provider: 'codex', voice: 'kokoro' })).digest('hex');
  const oldNodeOptions = process.env.NODE_OPTIONS;
  try {
    cpSync(join(CODE_ROOT, 'config'), join(root, 'config'), { recursive: true });
    for (const path of ['state', 'workdir/videos', 'workdir/newsletters', 'workdir/harvest']) mkdirSync(join(root, path), { recursive: true });
    atomicJson(join(root, 'workspace.json'), { id: basename(root), name: 'Media retry test' });
    atomicJson(join(root, 'members.json'), [{ id: 'owner', role: 'owner', tokenHash: createHash('sha256').update(token).digest('hex') }]);
    atomicJson(join(root, 'desks.json'), {});
    atomicJson(join(root, 'state/onboarding.json'), { configuredAt: '2026-01-01T00:00:00.000Z' });
    atomicJson(join(root, 'config/avatar.json'), { mode: 'cards', voiceProvider: 'kokoro' });
    const modelAttempt = join(root, 'model-attempt.txt'), fakeWriter = join(root, 'forbidden-writer.mjs');
    writeFileSync(fakeWriter, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(modelAttempt)},'unexpected writer');process.exit(2);`, { mode: 0o700 });
    atomicJson(join(root, 'config/model.json'), { provider: 'codex', providers: { codex: { command: fakeWriter, model: 'fixture-model' } }, rescue: { enabled: false } });
    const denied = join(root, 'network-attempt.txt'), preload = join(root, 'deny-network.mjs');
    writeFileSync(preload, `import {writeFileSync} from 'node:fs'; globalThis.fetch=async()=>{writeFileSync(${JSON.stringify(denied)},'unexpected collection');throw new Error('TEST_NETWORK_FORBIDDEN');};`);
    process.env.NODE_OPTIONS = `${oldNodeOptions ?? ''} --import=${preload}`.trim();
    const action = (payload = data) => workerAction(root, token, { action: 'journey', operation: 'quick-preview', data: payload });
    for (const stage of ['script', 'newsletter', 'visuals', 'assets', 'voice', 'avatar', 'render', 'final-media-qc', 'newsletter-media']) {
      const id = `20260101-retained-${stage}`, dir = join(root, 'workdir/videos', id);
      mkdirSync(dir);
      atomicJson(join(dir, 'meta.json'), { id, status: `failed:${stage}`, edition: 'daily-roundup', createdBy: 'owner', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: new Date().toISOString(), posts: {} });
      // No topic exists: the real produce --resume command must reject this exact ID
      // before writing/research. A fresh-draft fallback would hit the denied network.
      const receipt = { status: 'failed', step: 3, id, actor: 'owner', requestHash, resumeConfigurationHash: quickPreviewRetryKey(root), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      atomicJson(join(root, 'state/quick-preview.json'), receipt);
      const packages = readdirSync(join(root, 'workdir/videos')).sort();
      const configHash = quickPreviewRetryKey(root);
      await assert.rejects(action({ ...data, description: 'An unrelated new description about politics and government.' }), /earlier brief or changed settings/);
      assert.deepEqual(JSON.parse(readFileSync(join(root, 'state/quick-preview.json'), 'utf8')), receipt);
      await assert.rejects(action(), new RegExp(`Cannot resume ${id}: no such package`));
      const after = JSON.parse(readFileSync(join(root, 'state/quick-preview.json'), 'utf8'));
      assert.equal(after.id, id); assert.equal(after.status, 'failed'); assert.equal(after.resumeConfigurationHash, receipt.resumeConfigurationHash);
      assert.match(after.error, new RegExp(`Cannot resume ${id}`));
      assert.deepEqual(readdirSync(join(root, 'workdir/videos')).sort(), packages);
      assert.equal(quickPreviewRetryKey(root), configHash);
      assert.equal(existsSync(join(root, 'state/onboarding-backups')), false);
      assert.equal(existsSync(join(root, 'state/model-calls.jsonl')), false);
      assert.equal(existsSync(modelAttempt), false);
      assert.equal(existsSync(denied), false);
    }
  } finally {
    if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldNodeOptions;
    rmSync(root, { recursive: true, force: true });
  }
});
