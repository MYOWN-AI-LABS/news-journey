import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagedProcessTimeoutError, registerManagedChild, runManagedProcess, stopManagedChild } from './managed-process.js';

const root = process.cwd();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate: () => boolean, milliseconds = 4_000) {
  const end = Date.now() + milliseconds;
  while (!predicate() && Date.now() < end) await delay(20);
  assert.ok(predicate(), 'Expected process state did not arrive before test deadline');
}

test('successful media operation returns bounded output and releases its long timeout', async () => {
  const result = await runManagedProcess(process.execPath, ['-e', 'process.stdout.write("complete");process.stderr.write("diagnostic")'], { operation: 'fixture', timeoutMs: 30 * 60_000, stdio: 'pipe' });
  assert.deepEqual(result, { stdout: 'complete', stderr: 'diagnostic', code: 0 });
  const program = `import {runManagedProcess} from './src/managed-process.ts';await runManagedProcess(process.execPath,['-e','process.exit(0)'],{operation:'fixture',timeoutMs:1800000,stdio:'pipe'});`;
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { cwd: root, timeout: 5_000 });
});

test('a completed launcher waits for natural descendant teardown before accepting its output', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-completion-')), pidFile = join(dir, 'helper.pid');
  let pid = 0;
  try {
    const helper = 'setTimeout(()=>process.exit(0),150)';
    const launcher = `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const helper=spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(helper.pid));process.stdout.write('render complete');helper.unref();`;
    const result = await runManagedProcess(process.execPath, ['-e', launcher], { operation: 'completed render fixture', timeoutMs: 5000, stdio: 'pipe' });
    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(result.stdout, 'render complete');
    assert.equal(result.code, 0);
    assert.equal(alive(pid), false, 'completion is accepted only after the exact owned helper exits');
  } finally { if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('macOS caffeinate renderer wrapper can finish with inherited stdio', { skip: process.platform !== 'darwin' }, async () => {
  const result = await runManagedProcess('caffeinate', ['-i', process.execPath, '-e', ''], { operation: 'caffeinate fixture', timeoutMs: 5000, stdio: 'inherit' });
  assert.equal(result.code, 0);
});

test('a successful launcher cannot leave an ignoring descendant or bypass its original timeout', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-orphan-'));
  try {
    for (const timeoutMs of [5000, 200]) {
      const pidFile = join(dir, `${timeoutMs}.pid`);
      const helper = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
      const launcher = `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const helper=spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(helper.pid));helper.unref();`;
      let pid = 0;
      try {
        await assert.rejects(runManagedProcess(process.execPath, ['-e', launcher], { operation: 'orphan fixture', timeoutMs, stdio: 'pipe' }), timeoutMs === 200 ? ManagedProcessTimeoutError : /owned descendants remained/);
        pid = Number(readFileSync(pidFile, 'utf8'));
        await until(() => !alive(pid));
      } finally { if (!pid && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8')); if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a timeout remains failure even when the child handles TERM by exiting zero', async () => {
  await assert.rejects(runManagedProcess(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'], { operation: 'Narration fixture', timeoutMs: 300, stdio: 'pipe' }), error => {
    assert.ok(error instanceof ManagedProcessTimeoutError); assert.equal(error.operation, 'Narration fixture'); return true;
  });
});

test('hung launcher and ignoring descendant are killed without killing an unrelated process', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-media-'));
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  let pid = 0;
  try {
    const childCode = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const parentCode = `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});writeFileSync(${JSON.stringify(join(dir, 'child.pid'))},String(child.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
    const run = runManagedProcess(process.execPath, ['-e', parentCode], { operation: 'hung fixture', timeoutMs: 400, stdio: 'pipe' });
    await until(() => existsSync(join(dir, 'child.pid'))); pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
    await assert.rejects(run, ManagedProcessTimeoutError);
    await until(() => !alive(pid));
    assert.ok(unrelated.pid && alive(unrelated.pid));
  } finally { unrelated.kill('SIGKILL'); if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('aborted work never starts and an in-flight cancellation stops its process', async () => {
  const before = new AbortController(); before.abort(new Error('cancelled before spawn'));
  await assert.rejects(runManagedProcess('not-a-real-executable', [], { operation: 'fixture', timeoutMs: 1000, signal: before.signal }), /cancelled before spawn/);
  const during = new AbortController();
  const run = runManagedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { operation: 'fixture', timeoutMs: 10_000, signal: during.signal, stdio: 'pipe' });
  during.abort(new Error('cancelled in flight')); await assert.rejects(run, /cancelled in flight/);
});

test('spawn failures and output overflow retain errors and settle without leaked timers', async () => {
  await assert.rejects(runManagedProcess('not-a-real-executable', [], { operation: 'fixture', timeoutMs: 1000 }), /ENOENT/);
  await assert.rejects(runManagedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000));setInterval(()=>{},1000)'], { operation: 'fixture', timeoutMs: 10_000, stdio: 'pipe', maxOutputBytes: 100 }), /output limit/);
  assert.throws(() => runManagedProcess(process.execPath, [], { operation: 'fixture', timeoutMs: Infinity }), /finite positive timeout/);
  await assert.rejects(runManagedProcess(process.execPath, ['-e', 'process.stdout.write("package-123");process.stderr.write("Stage voice failed");process.exit(2)'], { operation: 'fixture', timeoutMs: 1000, stdio: 'pipe' }), error => {
    assert.equal((error as Error & { stdout: string }).stdout, 'package-123');
    assert.equal((error as Error & { stderr: string }).stderr, 'Stage voice failed'); return true;
  });
  const probe = await runManagedProcess(process.execPath, ['-e', 'process.stderr.write("Duration: 00:00:05.00");process.exit(1)'], { operation: 'probe', timeoutMs: 1000, stdio: 'pipe', rejectNonZero: false });
  assert.equal(probe.code, 1); assert.match(probe.stderr, /Duration/);
});

test('worker TERM drains a detached managed media group before worker exit', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-worker-'));
  const pidFile = join(dir, 'media.pid');
  const media = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const program = `import {runManagedProcess} from './src/managed-process.ts';await runManagedProcess(process.execPath,['-e',${JSON.stringify(media)}],{operation:'fixture',timeoutMs:1800000,stdio:'pipe'});`;
  const worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { cwd: root, stdio: 'ignore' });
  let pid = 0;
  try {
    const closed = new Promise<number | null>(resolve => worker.once('exit', code => resolve(code)));
    await until(() => existsSync(pidFile)); pid = Number(readFileSync(pidFile, 'utf8')); worker.kill('SIGTERM');
    assert.equal(await closed, 143); await until(() => !alive(pid));
  } finally { worker.kill('SIGKILL'); if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('targeted watchdog stop drains nested CLI and media groups using their registered grace; unowned processes are refused', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-nested-')), pidFile = join(dir, 'media.pid');
  const media = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const cli = `import {runManagedProcess} from './src/managed-process.ts';await runManagedProcess(process.execPath,['-e',${JSON.stringify(media)}],{operation:'media',timeoutMs:1800000,stdio:'pipe'});`;
  const workerProgram = `import {runManagedProcess} from './src/managed-process.ts';await runManagedProcess(process.execPath,['--import','tsx','--input-type=module','-e',${JSON.stringify(cli)}],{operation:'cli',timeoutMs:1800000,terminationGraceMs:5000,stdio:'pipe'});`;
  const worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', workerProgram], { cwd: root, detached: true, stdio: 'ignore' });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const unregister = registerManagedChild(worker, { detached: true, terminationGraceMs: 10_000 });
  let pid = 0;
  try {
    await assert.rejects(stopManagedChild(unrelated, false), /unregistered subprocess/); assert.ok(unrelated.pid && alive(unrelated.pid));
    await until(() => existsSync(pidFile)); pid = Number(readFileSync(pidFile, 'utf8'));
    await stopManagedChild(worker, true); await until(() => !alive(pid));
    assert.equal(worker.exitCode, 143); assert.ok(unrelated.pid && alive(unrelated.pid));
  } finally { unregister(); worker.kill('SIGKILL'); unrelated.kill('SIGKILL'); if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});
