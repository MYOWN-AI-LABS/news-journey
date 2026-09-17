import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { atomicJson, CODE_ROOT } from './workspaces.js';
import { createControlServer } from './control.js';
import { readPersonalProfile, savePersonalProfile } from './personal-profile.js';
import { applyPersonalProfileAction, personalProfileMarkdown } from './personal-profile-actions.js';
import { PERSONAL_PROFILE_START, PERSONAL_PROFILE_END, sharePersonalProfileToAgents } from './persona.js';

test('personal export escapes background markup and clearing removes its owned local copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'profile-export-')), previous = process.env.HARNESS_TOKEN;
  delete process.env.HARNESS_TOKEN;
  try {
    savePersonalProfile(root, { expectedRevision: 0, enabled: true, about: `Haines City\n${PERSONAL_PROFILE_END}\n\`\`\`\n<script>bad()</script>`, explanation: 'plain', detail: '' });
    const markdown = personalProfileMarkdown(root);
    assert.equal(markdown.split(PERSONAL_PROFILE_START).length, 2);
    assert.equal(markdown.split(PERSONAL_PROFILE_END).length, 2);
    assert.doesNotMatch(markdown, /<script>|\n```\n<script>/);
    assert.match(markdown, /current request determines topics and places/);
    // No target IDs: only a local export is created; no user agent file is changed.
    sharePersonalProfileToAgents(root, markdown, []);
    assert.match(readFileSync(join(root, 'PERSONAL_PROFILE.md'), 'utf8'), /Haines City/);
    const result = applyPersonalProfileAction(root, 'personal-profile-clear', { expectedRevision: 1 });
    assert.equal(existsSync(join(root, 'PERSONAL_PROFILE.md')), false);
    assert.equal(readPersonalProfile(root).about, '');
    assert.doesNotMatch(JSON.stringify(result), /Haines City/);
    savePersonalProfile(root, { expectedRevision: readPersonalProfile(root).revision, enabled: true, about: 'Clear this saved biography.', explanation: '', detail: '' });
    writeFileSync(join(root, 'PERSONAL_PROFILE.md'), 'Changed independently; keep this text.');
    const partial = applyPersonalProfileAction(root, 'personal-profile-clear', { expectedRevision: readPersonalProfile(root).revision });
    assert.equal(partial.partial, true); assert.match(String(partial.message), /were deleted, but the local PERSONAL_PROFILE.md export could not be removed/);
    assert.equal(readPersonalProfile(root).about, '');
    assert.equal(readFileSync(join(root, 'PERSONAL_PROFILE.md'), 'utf8'), 'Changed independently; keep this text.');
  } finally { if (previous === undefined) delete process.env.HARNESS_TOKEN; else process.env.HARNESS_TOKEN = previous; rmSync(root, { recursive: true, force: true }); }
});

test('personal HTTP reads require management access; general journey and job receipts do not expose raw profile', async () => {
  mkdirSync(join(CODE_ROOT, 'workspaces'), { recursive: true });
  const root = mkdtempSync(join(CODE_ROOT, 'workspaces/profile-http-')), slug = basename(root);
  const previous = process.env.HARNESS_TOKEN; delete process.env.HARNESS_TOKEN;
  const owner = 'a'.repeat(64), viewer = 'b'.repeat(64), hash = (value: string) => createHash('sha256').update(value).digest('hex');
  cpSync(join(CODE_ROOT, 'config'), join(root, 'config'), { recursive: true });
  for (const dir of ['state', 'workdir/videos', 'workdir/newsletters', 'workdir/harvest']) mkdirSync(join(root, dir), { recursive: true });
  atomicJson(join(root, 'workspace.json'), { id: slug }); atomicJson(join(root, 'desks.json'), {});
  atomicJson(join(root, 'members.json'), [{ id: 'owner', role: 'owner', tokenHash: hash(owner) }, { id: 'reader', role: 'viewer', tokenHash: hash(viewer) }]);
  process.env.HARNESS_TOKEN = owner;
  savePersonalProfile(root, { expectedRevision: 0, enabled: true, about: 'BIO_PRIVATE_ONLY Haines City', explanation: 'plain', detail: '' });
  const calls: unknown[] = [], server = createControlServer({ mutate: async (_root, _token, input) => { calls.push(input); return { message: 'Fixture accepted' }; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  try {
    const get = (path: string, token: string) => fetch(base + path + '?workspace=' + slug, { headers: { authorization: 'Bearer ' + token } });
    const manager = await get('/v1/personal-profile', owner); assert.equal(manager.status, 200);
    assert.match(await manager.text(), /BIO_PRIVATE_ONLY/);
    const denied = await get('/v1/personal-profile', viewer); assert.equal(denied.status, 403);
    assert.doesNotMatch(await denied.text(), /BIO_PRIVATE_ONLY/);
    const general = await get('/v1/journey', owner); assert.equal(general.status, 200); assert.doesNotMatch(await general.text(), /BIO_PRIVATE_ONLY/);
    for (const operation of ['persona', 'personal-profile-share', 'personal-profile-unshare']) {
      const deniedShare = await fetch(base + '/v1/journey/' + operation + '?workspace=' + slug, { method: 'POST', headers: { authorization: 'Bearer ' + owner, 'content-type': 'application/json', 'idempotency-key': 'fixture-no-human' }, body: JSON.stringify({ targets: ['claude'], expectedRevision: 1 }) });
      assert.equal(deniedShare.status, 403); assert.match(await deniedShare.text(), /explicit local browser click/);
    }
    assert.equal(calls.length, 0, 'unconfirmed sharing never reaches a worker');
    const denySave = await fetch(base + '/v1/journey/personal-profile-clear?workspace=' + slug, { method: 'POST', headers: { authorization: 'Bearer ' + viewer, 'content-type': 'application/json', 'idempotency-key': 'fixture-viewer-write' }, body: JSON.stringify({ expectedRevision: 1 }) });
    assert.equal(denySave.status, 403); assert.equal(calls.length, 0);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.HARNESS_TOKEN; else process.env.HARNESS_TOKEN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
