import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CODE_ROOT, atomicJson } from './workspaces.js';
import { workerAction } from './control.js';
import { executivePermission, executiveState } from './executive-actions.js';

test('watchdog settings default off, require manager authorization, persist hours and reject invalid inputs', async () => {
  mkdirSync(join(CODE_ROOT, 'workspaces'), { recursive: true });
  const root = mkdtempSync(join(CODE_ROOT, 'workspaces/watchdog-settings-'));
  const owner = 'a'.repeat(64), viewer = 'b'.repeat(64);
  cpSync(join(CODE_ROOT, 'config'), join(root, 'config'), { recursive: true });
  rmSync(join(root, 'config/watchdog.json'), { force: true });
  for (const directory of ['state', 'workdir/videos', 'workdir/newsletters', 'workdir/harvest']) mkdirSync(join(root, directory), { recursive: true });
  atomicJson(join(root, 'workspace.json'), { id: basename(root), name: 'Watchdog settings test' });
  atomicJson(join(root, 'desks.json'), {});
  atomicJson(join(root, 'members.json'), [[owner, 'owner'], [viewer, 'viewer']].map(([token, role]) => ({ id: role, role, tokenHash: createHash('sha256').update(token).digest('hex') })));
  const action = (data: Record<string, unknown>, token = owner) => workerAction(root, token, { action: 'journey', operation: 'watchdog', data });
  try {
    assert.equal(executivePermission('watchdog'), 'manage');
    assert.deepEqual(executiveState(root, 'owner').watchdog, { enabled: false, intervalHours: 2 });
    await assert.rejects(action({ enabled: true, intervalHours: 2 }, viewer), /Forbidden/);
    const saved = await action({ enabled: true, intervalHours: 2.5 });
    assert.deepEqual(saved.watchdog, { enabled: true, intervalHours: 2.5 });
    assert.match(String(saved.message), /every 2.5 hours/);
    const file = join(root, 'config/watchdog.json');
    const acceptedBytes = readFileSync(file, 'utf8');
    for (const input of [{ enabled: 'false', intervalHours: 2 }, { enabled: true, intervalHours: 0 }, { enabled: true, intervalHours: 169 }, { enabled: true, intervalHours: '2' }]) {
      await assert.rejects(action(input));
      assert.equal(readFileSync(file, 'utf8'), acceptedBytes, 'invalid settings cannot replace the saved policy');
    }
    await action({ enabled: false, intervalHours: 2.5 });
    assert.deepEqual(executiveState(root, 'owner').watchdog, { enabled: false, intervalHours: 2.5 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
