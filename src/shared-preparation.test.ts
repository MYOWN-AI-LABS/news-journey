import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import test, { mock } from 'node:test';
import { sharedPreparation } from './shared-preparation.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shared-preparation-'));
  for (const name of ['start.mjs', 'package-lock.json', 'tts/pyproject.toml', 'tts/uv.lock']) {
    mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), name);
  }
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state/parent-budget.json'), '{"physicalCalls":3,"deadline":"unchanged"}');
  writeFileSync(join(root, 'state/quick-preview.json'), '{"id":"original-preview","requestHash":"original-request"}');
  return root;
}
async function worker(root: string, fail = false) {
  const module = new URL('./shared-preparation.ts', import.meta.url).href;
  const code = `import {sharedPreparation} from ${JSON.stringify(module)};
    try { await sharedPreparation(${JSON.stringify(root)}, async () => {process.send('preparing');await new Promise(r=>setTimeout(r,180));${fail ? "throw new Error('fixture preparation failed');" : ''}},2000); process.send('complete'); }
    catch(e){process.send({error:e.message});process.exitCode=1;} finally {process.disconnect();}`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const closed = once(child, 'close');
  assert.equal((await once(child, 'message'))[0], 'preparing');
  return { child, closed };
}

test('overlapping processes reuse one completed prerequisite run and preserve workspace receipts and budgets', async () => {
  const root = fixture(), owner = await worker(root);
  const budget = readFileSync(join(root, 'state/parent-budget.json'), 'utf8'), preview = readFileSync(join(root, 'state/quick-preview.json'), 'utf8');
  let installs = 0;
  try {
    await sharedPreparation(root, async () => { installs++; }, 2000);
    assert.equal(installs, 0); assert.equal((await owner.closed)[0], 0);
    assert.equal(JSON.parse(readFileSync(join(root, 'state/shared-preparation.json'), 'utf8')).status, 'complete');
    assert.equal(existsSync(join(root, 'state/.prepare.lock')), false);
    assert.equal(readFileSync(join(root, 'state/parent-budget.json'), 'utf8'), budget);
    assert.equal(readFileSync(join(root, 'state/quick-preview.json'), 'utf8'), preview);
    await sharedPreparation(root, async () => { installs++; }, 2000);
    assert.equal(installs, 1, 'A later independent request does not treat the receipt as permanent readiness');
  } finally { owner.child.kill(); rmSync(root, { recursive: true, force: true }); }
});

test('same-process overlapping callers coalesce instead of using the reentrant lock to install twice', async () => {
  const root = fixture(); let installs = 0;
  try {
    const prepare = async () => { installs++; await pause(40); };
    await Promise.all([sharedPreparation(root, prepare), sharedPreparation(root, prepare), sharedPreparation(root, prepare)]);
    assert.equal(installs, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a bounded waiter neither cancels the owner nor steals its live lock', async () => {
  const root = fixture(), owner = await worker(root); let installs = 0;
  try {
    await assert.rejects(sharedPreparation(root, async () => { installs++; }, 20), /bounded wait/);
    assert.equal(installs, 0);
    assert.equal(JSON.parse(readFileSync(join(root, 'state/.prepare.lock'), 'utf8')).pid, owner.child.pid);
    assert.equal((await owner.closed)[0], 0);
  } finally { owner.child.kill(); rmSync(root, { recursive: true, force: true }); }
});

test('an overlapping failed preparation is retained and cannot trigger a competing reinstall', async () => {
  const root = fixture(), owner = await worker(root, true); let installs = 0;
  try {
    await assert.rejects(sharedPreparation(root, async () => { installs++; }, 2000), /shared.*preparation failed/);
    assert.equal(installs, 0); assert.equal((await owner.closed)[0], 1);
    assert.equal(JSON.parse(readFileSync(join(root, 'state/shared-preparation.json'), 'utf8')).status, 'failed');
  } finally { owner.child.kill(); rmSync(root, { recursive: true, force: true }); }
});

test('changed prerequisite inputs invalidate completion rather than being reused', async () => {
  const root = fixture();
  try {
    await assert.rejects(sharedPreparation(root, async () => { writeFileSync(join(root, 'tts/uv.lock'), 'changed dependency lock'); }), /inputs changed during/);
    assert.equal(JSON.parse(readFileSync(join(root, 'state/shared-preparation.json'), 'utf8')).status, 'failed');
    assert.equal(existsSync(join(root, 'state/.prepare.lock')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid lock ownership is not erased and no setup callback runs', async () => {
  const root = fixture(); let installs = 0;
  try {
    writeFileSync(join(root, 'state/.prepare.lock'), '{"pid":0}');
    await assert.rejects(sharedPreparation(root, async () => { installs++; }), /Invalid release lock/);
    assert.equal(installs, 0); assert.equal(readFileSync(join(root, 'state/.prepare.lock'), 'utf8'), '{"pid":0}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an old worker without a shared receipt finishes before one fresh verification starts', async () => {
  const root = fixture(), lock = join(root, 'state/.prepare.lock');
  const code = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(lock)},JSON.stringify({pid:process.pid}),{flag:'wx'});process.send('preparing');setTimeout(()=>{fs.unlinkSync(${JSON.stringify(lock)});process.disconnect()},120);`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), closed = once(child, 'close');
  await once(child, 'message');
  let installs = 0;
  try {
    await sharedPreparation(root, async () => {
      installs++;
      assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid);
    }, 2000);
    assert.equal(installs, 1); assert.equal((await closed)[0], 0);
  } finally { child.kill(); rmSync(root, { recursive: true, force: true }); }
});

test('a dead incomplete owner is held rather than risking a concurrent orphaned installer', async () => {
  const root = fixture(), owner = await worker(root); let installs = 0;
  owner.child.kill('SIGKILL'); await owner.closed;
  try {
    await assert.rejects(sharedPreparation(root, async () => { installs++; }, 2000), /stopped without a completion receipt/);
    assert.equal(installs, 0);
    assert.equal(JSON.parse(readFileSync(join(root, 'state/shared-preparation.json'), 'utf8')).status, 'running');
    assert.equal(JSON.parse(readFileSync(join(root, 'state/.prepare.lock'), 'utf8')).pid, owner.child.pid);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an owner completing between receipt read and PID check can be reused without reinstalling', async () => {
  const root = fixture(); let installs = 0;
  await sharedPreparation(root, async () => {});
  const file = join(root, 'state/shared-preparation.json'), completed = JSON.parse(readFileSync(file, 'utf8'));
  const running = { ...completed, status: 'running', pid: 424242 }; delete running.finishedAt;
  writeFileSync(file, JSON.stringify(running));
  const kill = mock.method(process, 'kill', (pid: number) => {
    assert.equal(pid, 424242);
    writeFileSync(file, JSON.stringify({ ...completed, pid }));
    throw Object.assign(new Error('Owner exited'), { code: 'ESRCH' });
  });
  try {
    await sharedPreparation(root, async () => { installs++; });
    assert.equal(installs, 0); assert.equal(kill.mock.calls.length, 1);
  } finally { kill.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});
