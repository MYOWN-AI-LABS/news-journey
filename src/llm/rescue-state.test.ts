import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson } from '../workspaces.js';
import { hostedRescueAllowance } from './rescue-state.js';

test('rescue allowance reads the requested workspace and Eastern calendar date without initializing state', () => {
  const root = mkdtempSync(join(tmpdir(), 'rescue-allowance-')), first = join(root, 'first'), second = join(root, 'second');
  mkdirSync(first); mkdirSync(second);
  const config = { rescue: { enabled: true } }, now = new Date('2026-09-14T01:00:00Z');
  try {
    assert.deepEqual(hostedRescueAllowance(first, config, now), { limit: 2, remaining: 2, day: '2026-09-13' });
    assert.equal(existsSync(join(first, 'state')), false, 'a capability/state read must not initialize workspace state');
    atomicJson(join(first, 'state/model-rescue/2026-09-13.json'), { version: 1, day: '2026-09-13', attempts: ['a', 'b'].map(id => ({ id, provider: 'codex', reservedAt: now.toISOString(), model: 'fixture' })) });
    assert.equal(hostedRescueAllowance(first, config, now).remaining, 0);
    assert.equal(hostedRescueAllowance(second, config, now).remaining, 2, 'another workspace must not inherit usage');
    assert.equal(hostedRescueAllowance(first, config, new Date('2026-09-14T04:00:00Z')).remaining, 2);
    assert.deepEqual(hostedRescueAllowance(first, { rescue: { enabled: false } }, now), { limit: 0, remaining: 0, day: '2026-09-13' });
    atomicJson(join(first, 'state/model-rescue/2026-09-13.json'), { version: 1, day: '2026-09-13', attempts: 'damaged' });
    assert.throws(() => hostedRescueAllowance(first, config, now), /allowance could not be verified/);
    assert.equal(hostedRescueAllowance(second, config, now).remaining, 2, 'a damaged workspace receipt does not affect other workspaces');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
