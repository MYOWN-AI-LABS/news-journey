import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForReleaseLock } from './release-lock.js';

async function owner(path: string, holdMs: number) {
  const code = `const fs=require('node:fs');const p=${JSON.stringify(path)};fs.writeFileSync(p,JSON.stringify({pid:process.pid}),{flag:'wx'});process.send('ready');setTimeout(()=>{fs.unlinkSync(p);process.disconnect()},${holdMs});`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const closed = once(child, 'close');
  await once(child, 'message');
  return { child, closed };
}

test('bookkeeping reservation waits for a live worker to release its short lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-handoff-'));
  mkdirSync(join(root, 'state'));
  const path = join(root, 'state/.budget.lock');
  const other = await owner(path, 60);
  try {
    const unlock = waitForReleaseLock(root, 'budget');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid);
    unlock();
    assert.equal(existsSync(path), false);
    assert.equal((await other.closed)[0], 0);
  } finally { other.child.kill(); rmSync(root, { recursive: true, force: true }); }
});

test('bounded contention never removes another live worker lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-busy-'));
  mkdirSync(join(root, 'state'));
  const path = join(root, 'state/.budget.lock');
  const other = await owner(path, 250);
  try {
    assert.throws(() => waitForReleaseLock(root, 'budget', 20), /Busy:/);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, other.child.pid);
    assert.equal((await other.closed)[0], 0);
  } finally { other.child.kill(); rmSync(root, { recursive: true, force: true }); }
});

test('invalid ownership is not treated as transient contention', () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-invalid-'));
  mkdirSync(join(root, 'state'));
  const path = join(root, 'state/.budget.lock');
  writeFileSync(path, '{"pid":0}');
  try {
    assert.throws(() => waitForReleaseLock(root, 'budget'), /Invalid release lock/);
    assert.equal(readFileSync(path, 'utf8'), '{"pid":0}');
    assert.throws(() => waitForReleaseLock(root, 'budget', 1001), /1–1000/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
