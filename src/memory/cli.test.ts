import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const codeRoot = fileURLToPath(new URL('../../', import.meta.url));
const now = Date.UTC(2026, 8, 14, 15);
const ownerToken = 'a'.repeat(64), viewerToken = 'b'.repeat(64);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function fixture() {
  mkdirSync(join(codeRoot, 'workspaces'), { recursive: true });
  const root = mkdtempSync(join(codeRoot, 'workspaces/test-memory-cli-'));
  const slug = root.split(/[\\/]/).at(-1)!;
  const save = (path: string, value: unknown) => {
    const target = join(root, path); mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, JSON.stringify(value));
  };
  save('workspace.json', { id: slug });
  save('members.json', [{ id: 'fixture-owner', role: 'owner', tokenHash: sha(ownerToken) }, { id: 'fixture-viewer', role: 'viewer', tokenHash: sha(viewerToken) }]);
  save('config/memory.json', { publicationId: 'sports' });
  mkdirSync(join(root, 'tmp'));
  const guard = join(root, 'no-external-io.mjs');
  writeFileSync(guard, `
    import http from 'node:http'; import https from 'node:https';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const deny = () => { throw new Error('External I/O is forbidden in the memory CLI fixture'); };
    globalThis.fetch = deny; globalThis.WebSocket = class { constructor() { deny(); } };
    http.request = deny; http.get = deny; https.request = deny; https.get = deny;
    childProcess.spawn = deny; childProcess.spawnSync = deny;
    childProcess.exec = deny; childProcess.execSync = deny;
    childProcess.execFile = deny; childProcess.execFileSync = deny;
    syncBuiltinESMExports();
    const now = Number(process.env.MEMORY_FIXTURE_NOW); Date.now = () => now;
  `);
  const run = (args: string[], options: { viewer?: boolean; at?: number; fail?: RegExp } = {}) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    const result = spawnSync(process.execPath, ['--import', guard, '--import', 'tsx', 'src/cli.ts', 'memory', ...args], {
      cwd: codeRoot, encoding: 'utf8', timeout: 20000, maxBuffer: 256 * 1024,
      env: { ...env, HOME: root, TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
        HARNESS_WORKSPACE: slug, HARNESS_TOKEN: options.viewer ? viewerToken : ownerToken,
        HARNESS_IDENTITY_FILE: join(root, 'identity.json'), MEMORY_FIXTURE_NOW: String(options.at ?? now) },
    });
    assert.equal(result.error, undefined);
    const text = result.stdout + result.stderr;
    if (options.fail) { assert.notEqual(result.status, 0); assert.match(text, options.fail); }
    else assert.equal(result.status, 0, text);
    assert.doesNotMatch(text, /External I\/O is forbidden/);
    return result.stdout.trim();
  };
  return { root, save, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const propose = ['propose', 'tense-rule', '--text', 'Keep scheduled events in future tense.', '--evidence', 'fixture:source-and-regression'];

test('actual memory CLI proposes, approves with exact expiry, isolates scope and retires guidance', () => {
  const f = fixture(), other = fixture();
  try {
    assert.match(f.run(propose), /not used in writing until reviewed/);
    const proposed = JSON.parse(f.run(['get', 'tense-rule']));
    assert.equal(proposed.status, 'proposed'); assert.equal(proposed.revision, 1);
    assert.equal(proposed.text, propose[3]);
    assert.deepEqual(proposed.evidenceRefs, ['fixture:source-and-regression']);
    assert.deepEqual(JSON.parse(f.run(['status'])).active, []);
    assert.match(f.run(['approve', 'tense-rule', '--verification', 'fixture:reviewed-test', '--expires-in-days', '1']), /Approved/);
    const approved = JSON.parse(f.run(['get', 'tense-rule']));
    assert.equal(approved.status, 'approved'); assert.equal(approved.revision, 2);
    assert.equal(approved.approvedBy, 'fixture-owner');
    assert.equal(approved.verificationRef, 'fixture:reviewed-test');
    assert.equal(approved.expiresAt, now + 86400000);
    assert.deepEqual(JSON.parse(f.run(['status'])).active.map((row: { key: string }) => row.key), ['tense-rule']);
    assert.equal(JSON.parse(other.run(['get', 'tense-rule'])), null, 'Other workspace cannot see the same key');
    f.save('config/memory.json', { publicationId: 'science' });
    assert.equal(JSON.parse(f.run(['get', 'tense-rule'])), null, 'Another publication cannot see the same key');
    f.save('config/memory.json', { publicationId: 'sports' });
    assert.deepEqual(JSON.parse(f.run(['status'], { at: now + 86400001 })).active, []);
    assert.equal(JSON.parse(f.run(['get', 'tense-rule'], { at: now + 86400001 })).status, 'approved', 'Expiry excludes recall without silently rewriting audit history');
    f.run(['retire', 'tense-rule'], { at: now + 86400002 });
    const retired = JSON.parse(f.run(['get', 'tense-rule'], { at: now + 86400002 }));
    assert.equal(retired.status, 'retired'); assert.equal(retired.revision, 3);
    assert.deepEqual(JSON.parse(f.run(['status'], { at: now + 86400002 })).active, []);
  } finally { f.cleanup(); other.cleanup(); }
});

test('actual memory CLI rejects invalid approval expiry without changing the proposal', () => {
  const f = fixture();
  try {
    f.run(propose);
    const original = JSON.parse(f.run(['get', 'tense-rule']));
    for (const days of ['0', '-1', '366', '1.5', 'NaN', 'Infinity']) {
      f.run(['approve', 'tense-rule', '--verification', 'fixture:test', '--expires-in-days', days], { fail: /expiry of 1–365 days/ });
      assert.deepEqual(JSON.parse(f.run(['get', 'tense-rule'])), original);
    }
  } finally { f.cleanup(); }
});

test('actual viewer CLI can inspect scoped memory but cannot approve or manage it', () => {
  const f = fixture();
  try {
    f.run(propose);
    const original = JSON.parse(f.run(['get', 'tense-rule'], { viewer: true }));
    assert.equal(original.status, 'proposed');
    const db = join(f.root, 'state/memory/memory.sqlite'), before = sha(readFileSync(db));
    for (const args of [propose, ['approve', 'tense-rule', '--verification', 'fixture:test'], ['retire', 'tense-rule'], ['maintain'], ['clear', 'sports']]) {
      f.run(args, { viewer: true, fail: /Forbidden: viewer cannot (?:approve|manage)/ });
      assert.equal(sha(readFileSync(db)), before, 'Authorization failure must not mutate storage');
    }
    assert.deepEqual(JSON.parse(f.run(['get', 'tense-rule'], { viewer: true })), original);
  } finally { f.cleanup(); }
});

test('actual memory explain requires the exact saved packet and rejects arbitrary paths', () => {
  const f = fixture(), other = fixture();
  try {
    f.run(['explain', '20260914-missing'], { fail: /no exact prepared story packet/ });
    f.save('workdir/videos/20260914-current/topic.json', { id: '20260914-old', stories: [{ primaryUrl: 'https://example.org/old' }] });
    f.run(['explain', '20260914-current'], { fail: /no exact prepared story packet/ });
    f.run(['explain', '../20260914-current'], { fail: /Invalid identifier/ });
    f.run(['explain', join(other.root, 'private-topic.json')], { fail: /Invalid identifier/ });
    other.save('private-topic.json', { id: '20260914-linked', stories: [{ summary: 'PRIVATE_SENTINEL_MUST_NOT_BE_READ' }] });
    mkdirSync(join(f.root, 'workdir/videos/20260914-linked'), { recursive: true });
    symlinkSync(join(other.root, 'private-topic.json'), join(f.root, 'workdir/videos/20260914-linked/topic.json'));
    f.run(['explain', '20260914-linked'], { fail: /Symlink leaves workspace/ });
    assert.equal(JSON.parse(f.run(['status'])).coverage.length, 0);
  } finally { f.cleanup(); other.cleanup(); }
});
