import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson } from './workspaces.js';
import { runWatchdog, saveWatchdogSettings, readWatchdogSettings, watchdogConfigurationHash, watchdogRecovery, WorkerInterruptedError } from './watchdog.js';
import { stalledStage, type StageHeartbeat } from './watchdog-progress.js';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-watchdog-')), id = 'saved-package', dir = join(root, 'workdir/videos', id);
  mkdirSync(dir, { recursive: true });
  const parentIdentity = 'a'.repeat(64), identity = hash({ version: 1, parent: parentIdentity });
  const budgetPath = join(root, 'state/role-tasks', id, identity, 'budget.json');
  atomicJson(budgetPath, { version: 1, identity, deadline: 1e12, maxPhysicalCalls: 8, attempts: [{ task: 'accepted-writing' }], maxToolCalls: 8, tools: [] });
  atomicJson(join(dir, 'meta.json'), { id, createdBy: 'owner', status: 'assets_ready', posts: {} });
  atomicJson(join(dir, 'writing-request.json'), { parentIdentity });
  atomicJson(join(dir, 'script.json'), { text: 'accepted text' });
  atomicJson(join(dir, 'companion-writing-receipt.json'), { version: 2, scriptHash: hash({ text: 'accepted text' }) });
  const row = (): StageHeartbeat => ({ id: randomUUID(), pid: 1234, packageId: id, configurationHash: watchdogConfigurationHash(root), stage: 'render', status: 'running', startedAt: 100, progressAt: 100, heartbeatAt: 100 });
  return { root, id, dir, budgetPath, row, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test('catch-up defaults off; hours are strict and nested edition changes invalidate recovery', () => {
  const f = fixture(); try {
    assert.deepEqual(readWatchdogSettings(f.root), { enabled: false, intervalHours: 2 });
    for (const intervalHours of [0, -1, NaN, Infinity, 169, '2']) assert.throws(() => saveWatchdogSettings(f.root, { enabled: true, intervalHours }));
    const original = watchdogConfigurationHash(f.root);
    saveWatchdogSettings(f.root, { enabled: true, intervalHours: 1 });
    assert.equal(watchdogConfigurationHash(f.root), original, 'watchdog controls do not mutate editorial identity');
    atomicJson(join(f.root, 'config/editions/new.json'), { voice: 'changed' });
    assert.throws(() => watchdogRecovery(f.root, [f.row()], 'owner', original, 1000), /Settings changed/);
  } finally { f.cleanup(); }
});
test('live heartbeats are not progress, and a healthy sibling cannot hide a stalled stage', () => {
  const f = fixture(); try {
    const stuck = { ...f.row(), heartbeatAt: 40_000 }, healthy = { ...f.row(), stage: 'editorial', progressAt: 40_000 };
    assert.match(stalledStage([stuck, healthy], 40_001, 36_000, 0)!, /render: worker alive but no progress/);
    assert.equal(stalledStage([{ ...stuck, progressAt: 39_000 }], 40_001, 36_000, 0), null);
    assert.match(stalledStage([{ ...stuck, heartbeatAt: 1 }], 40_001, 36_000, 0)!, /heartbeat stopped/);
  } finally { f.cleanup(); }
});
test('recovery preserves accepted bytes and original allowances, holds choices/reviews/delivery/expired budgets', () => {
  const f = fixture(); try {
    const config = watchdogConfigurationHash(f.root), budget = readFileSync(f.budgetPath, 'utf8'), script = readFileSync(join(f.dir, 'script.json'), 'utf8');
    const recovery = watchdogRecovery(f.root, [f.row()], 'owner', config, 1000);
    assert.deepEqual(recovery.input, { action: 'journey', operation: 'draft', data: { resume: f.id, edition: 'daily-roundup' } });
    for (const status of ['awaiting_story_choice', 'awaiting_visual_choice', 'pending_review', 'approved', 'posted', 'rejected', 'failed:script', 'unknown']) {
      atomicJson(join(f.dir, 'meta.json'), { id: f.id, createdBy: 'owner', status, posts: {} });
      assert.throws(() => watchdogRecovery(f.root, [f.row()], 'owner', config, 1000), /held/);
    }
    atomicJson(join(f.dir, 'meta.json'), { id: f.id, createdBy: 'owner', status: 'assets_ready', posts: {}, reviewHold: true });
    assert.throws(() => watchdogRecovery(f.root, [f.row()], 'owner', config, 1000), /held/);
    atomicJson(join(f.dir, 'meta.json'), { id: f.id, createdBy: 'owner', status: 'assets_ready', posts: {} });
    assert.throws(() => watchdogRecovery(f.root, [f.row()], 'other-owner', config, 1000), /another author/);
    assert.throws(() => watchdogRecovery(f.root, [f.row()], 'owner', config, 1e12), /allowance/);
    assert.equal(readFileSync(f.budgetPath, 'utf8'), budget); assert.equal(readFileSync(join(f.dir, 'script.json'), 'utf8'), script);
  } finally { f.cleanup(); }
});
const bounded = async <T>(run: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout;
  const ceiling = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('test deadline')), 2000); });
  try { return await Promise.race([run, ceiling]); } finally { clearTimeout(timer!); }
};
test('stalled worker is stopped before one exact-package restart; repeated checkpoint recovery cannot loop', async () => {
  const f = fixture(); let clock = 100, launches = 0, stops = 0;
  const events: string[] = [];
  const launch = (_input: Record<string, unknown>, runId: string) => {
    launches++; events.push('launch');
    const row = f.row(); atomicJson(join(f.root, 'state/watchdog-runs', runId, row.id + '.json'), row);
    if (launches === 2) return { pid: 200, result: Promise.resolve({ id: f.id }), stop: async () => {} };
    return { pid: 100, result: new Promise<{ id: string }>(() => {}), stop: async () => { stops++; events.push('stop'); } };
  };
  try {
    const budget = readFileSync(f.budgetPath, 'utf8');
    const result = await bounded(runWatchdog(f.root, 'owner', { action: 'journey', operation: 'draft' }, launch, undefined,
      { pollMs: 1, now: () => clock += 40_000, settings: () => ({ enabled: true, intervalHours: 0.01 }) }));
    assert.equal(result.id, f.id); assert.equal(launches, 2); assert.ok(stops >= 1); assert.ok(events.indexOf('stop') < events.lastIndexOf('launch'));
    assert.equal(readFileSync(f.budgetPath, 'utf8'), budget);
    const markers = readdirSync(join(f.root, 'state/watchdog-recoveries')); assert.equal(markers.length, 1);
    launches = 0;
    await assert.rejects(bounded(runWatchdog(f.root, 'owner', { action: 'journey', operation: 'draft' }, launch, undefined,
      { pollMs: 1, now: () => clock += 40_000, settings: () => ({ enabled: true, intervalHours: 0.01 }) })), /already used/);
    assert.equal(launches, 1);
  } finally { f.cleanup(); }
});
test('disabled watchdog leaves work alone; content errors never trigger restart; malformed settings launch nothing', async () => {
  const f = fixture(); let calls = 0, stops = 0;
  try {
    const result = await bounded(runWatchdog(f.root, 'owner', {}, () => ({ result: new Promise(resolve => setTimeout(() => resolve('done'), 10)), stop: async () => { stops++; } }), undefined,
      { pollMs: 1, settings: () => ({ enabled: false, intervalHours: 0.01 }), now: () => 100_000 }));
    assert.equal(result, 'done'); assert.equal(stops, 0);
    await assert.rejects(runWatchdog(f.root, 'owner', {}, () => { calls++; return { result: Promise.reject(new Error('Factual review held')), stop: async () => { stops++; } }; }, undefined,
      { settings: () => ({ enabled: true, intervalHours: 0.01 }) }), /Factual review held/);
    assert.equal(calls, 1); assert.equal(stops, 0);
    atomicJson(join(f.root, 'config/watchdog.json'), { enabled: true, intervalHours: 'invalid' });
    await assert.rejects(runWatchdog(f.root, 'owner', {}, () => { calls++; throw new Error('must not launch'); }), /interval/);
    assert.equal(calls, 1);
  } finally { f.cleanup(); }
});
test('a crashed worker is recovered only after cleanup and only with an accepted checkpoint', async () => {
  const f = fixture(); let calls = 0, cleaned = false;
  try {
    await bounded(runWatchdog(f.root, 'owner', {}, (_request, runId) => {
      calls++; const row = f.row(); atomicJson(join(f.root, 'state/watchdog-runs', runId, row.id + '.json'), row);
      if (calls === 2) { assert.equal(cleaned, true); return { result: Promise.resolve('recovered'), stop: async () => {} }; }
      return { result: Promise.reject(new WorkerInterruptedError('worker exited')), stop: async () => { cleaned = true; } };
    }, undefined, { now: () => 1000, settings: () => ({ enabled: true, intervalHours: 2 }) }));
    assert.equal(calls, 2);
  } finally { f.cleanup(); }
});
