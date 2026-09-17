import { spawn, type ChildProcess } from 'node:child_process';

/** Finite operation limits remain active even when the optional Journey watchdog is off. */
export const MEDIA_PROCESS_LIMITS = { narration: 20 * 60_000, render: 30 * 60_000, transform: 5 * 60_000, frame: 60_000 } as const;
const TERMINATION_GRACE_MS = 2_000;
const COMPLETION_GRACE_MS = 1_000;
type Registration = { child: ChildProcess; detached: boolean; terminationGraceMs?: number; onTerminate?: (reason: Error) => void };
const owned = new Set<Registration>();
let shutdown: Promise<void> | undefined;
let signalsInstalled = false;
function validateGrace(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 15_000)) throw new Error('Invalid subprocess termination grace');
}

async function signalTree(row: Registration, signal: NodeJS.Signals): Promise<void> {
  if (!row.child.pid) return;
  if (process.platform !== 'win32' && row.detached) {
    try { process.kill(-row.child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  } else if (process.platform === 'win32') {
    // /T is essential: uv/npx may only be the launcher of the actual media worker.
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(row.child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { killer.kill('SIGKILL'); reject(new Error('Windows process-tree termination timed out')); }, 1_000);
      killer.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Windows process-tree termination exit ${code}`)); });
      killer.once('error', error => { clearTimeout(timer); reject(error); });
    });
  } else row.child.kill(signal);
}

function alive(row: Registration): boolean {
  if (!row.child.pid) return false;
  if (process.platform === 'win32' || !row.detached) return row.child.exitCode === null && row.child.signalCode === null;
  try { process.kill(-row.child.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Only ChildProcess objects spawned by this process may enter this registry. Never load saved PIDs. */
export function registerManagedChild(child: ChildProcess, options: { detached: boolean; terminationGraceMs?: number; onTerminate?: (reason: Error) => void }): () => void {
  validateGrace(options.terminationGraceMs);
  if (shutdown) { child.kill('SIGKILL'); throw new Error('Worker is shutting down; a new subprocess cannot start'); }
  const row = { child, ...options }; owned.add(row);
  if (!signalsInstalled) { process.on('SIGTERM', onTerm); process.on('SIGINT', onInt); signalsInstalled = true; }
  return () => {
    owned.delete(row);
    if (!owned.size && signalsInstalled) { process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); signalsInstalled = false; }
  };
}

async function stopRows(rows: Registration[], reason: Error): Promise<void> {
  rows = rows.filter(alive); // A completed Windows PID must not be sent to taskkill (or reused later).
  const errors: unknown[] = [];
  for (const row of rows) { try { row.onTerminate?.(reason); } catch (error) { errors.push(error); } }
  const term = await Promise.allSettled(rows.map(row => signalTree(row, 'SIGTERM')));
  const deadline = Date.now() + Math.max(TERMINATION_GRACE_MS, ...rows.map(row => row.terminationGraceMs ?? TERMINATION_GRACE_MS));
  while (rows.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  // The launcher may already have exited while an ignoring descendant is still alive.
  const kill = await Promise.allSettled(rows.map((row, i) => alive(row) || term[i]?.status === 'rejected' ? signalTree(row, 'SIGKILL') : Promise.resolve()));
  for (const result of kill) if (result.status === 'rejected') errors.push(result.reason);
  const killedBy = Date.now() + 1_000;
  while (rows.some(alive) && Date.now() < killedBy) await new Promise(resolve => setTimeout(resolve, Math.min(25, killedBy - Date.now())));
  if (errors.length || rows.some(alive)) throw new Error('Owned subprocess tree did not stop after TERM/KILL; keep this job held to prevent overlapping recovery', { cause: errors[0] });
}

/** Stop only the exact live ChildProcess previously registered by this server. */
export async function stopManagedChild(child: ChildProcess, detached: boolean, reason = new Error('Owned worker stopped by its watchdog')): Promise<void> {
  const row = [...owned].find(item => item.child === child && item.detached === detached);
  if (!row) throw new Error('Cannot stop an unregistered subprocess; saved PIDs are not process ownership');
  await stopRows([row], reason);
}

export async function terminateManagedChildren(reason = new Error('Worker interrupted; completed content is preserved')): Promise<void> {
  await stopRows([...owned], reason);
}

function signalShutdown(signal: 'SIGTERM' | 'SIGINT'): void {
  if (shutdown) return;
  shutdown = terminateManagedChildren(new Error(`Worker received ${signal}; subprocess output is not accepted`));
  void shutdown.finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
}
const onTerm = () => signalShutdown('SIGTERM');
const onInt = () => signalShutdown('SIGINT');

export class ManagedProcessTimeoutError extends Error {
  readonly code = 'MEDIA_PROCESS_TIMEOUT';
  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`${operation} timed out after ${Math.ceil(timeoutMs / 1000)} seconds; the owned subprocess tree was stopped. Completed content is preserved.`);
    this.name = 'ManagedProcessTimeoutError';
  }
}

export interface ManagedProcessOptions {
  operation: string; timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv;
  stdio?: 'inherit' | 'pipe' | 'ignore'; signal?: AbortSignal; maxOutputBytes?: number;
  terminationGraceMs?: number;
  /** Probes such as ffmpeg -i intentionally return 1. Signals/timeouts always reject. */
  rejectNonZero?: boolean;
}
export interface ManagedProcessResult { stdout: string; stderr: string; code: number }

/** A timed-out/aborted process can never be accepted, even if its signal handler exits zero. */
export function runManagedProcess(command: string, args: string[], options: ManagedProcessOptions): Promise<ManagedProcessResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) throw new Error('Subprocess requires a finite positive timeout');
  validateGrace(options.terminationGraceMs);
  if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error(`${options.operation} cancelled before starting`));
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const output = options.stdio ?? 'inherit';
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, detached, windowsHide: true, stdio: ['ignore', output, output] });
    let failure: Error | undefined, cleanup: Promise<void> | undefined, settled = false;
    let stdout = '', stderr = '', bytes = 0;
    const row: Registration = { child, detached, terminationGraceMs: options.terminationGraceMs };
    const unregister = registerManagedChild(child, { detached, terminationGraceMs: options.terminationGraceMs, onTerminate: reason => { failure ??= reason; } });
    const stop = (error: Error) => {
      failure ??= error;
      if (!cleanup) {
        cleanup = stopRows([row], error);
        // An OS refusing termination must hold the operation rather than leave this promise
        // pending forever waiting for a close event that may never arrive.
        void cleanup.catch(cleanupError => { failure = cleanupError as Error; void finish(failure); });
      }
    };
    const timer = setTimeout(() => stop(new ManagedProcessTimeoutError(options.operation, options.timeoutMs)), options.timeoutMs);
    const abort = () => stop(options.signal?.reason instanceof Error ? options.signal.reason : new Error(`${options.operation} cancelled`));
    options.signal?.addEventListener('abort', abort, { once: true });
    const capture = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 2 * 1024 * 1024)) { stop(new Error(`${options.operation} exceeded its subprocess output limit`)); return; }
      if (kind === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout?.on('data', chunk => capture('stdout', chunk));
    child.stderr?.on('data', chunk => capture('stderr', chunk));
    const finish = async (error?: Error, code = 0) => {
      if (settled) return; settled = true;
      // The signal handler owns final exit while it drains *all* child groups. Rejecting a
      // top-level awaited job here could exit Node early and strand another detached child.
      if (shutdown) { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); await shutdown.catch(() => {}); return; }
      try {
        // With inherited stdio, close reports the launcher exit before a helper such as
        // caffeinate has observed it and exited. Allow natural teardown, without accepting
        // output while the owned group is alive or stopping its timeout/cancellation guard.
        const drainBy = Date.now() + COMPLETION_GRACE_MS;
        while (!cleanup && !shutdown && alive(row) && Date.now() < drainBy) {
          await new Promise(resolve => setTimeout(resolve, Math.min(25, drainBy - Date.now())));
        }
        // Ordinary completion must not strand descendants launched by a wrapper either.
        if (!cleanup && !shutdown && alive(row)) {
          failure ??= new Error(`${options.operation} launcher exited while owned descendants remained; its output is not accepted`);
          cleanup = stopRows([row], failure);
        }
        if (cleanup) await cleanup;
      } catch (cleanupError) { failure ??= cleanupError as Error; }
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      // A signal callback may have started shutdown during the awaited drain.
      const pendingShutdown = shutdown as Promise<void> | undefined;
      if (pendingShutdown) { await pendingShutdown.catch(() => {}); return; }
      unregister();
      if (failure || error) reject(Object.assign(failure ?? error!, { stdout, stderr })); else resolve({ stdout, stderr, code });
    };
    child.once('error', error => void finish(error));
    child.once('close', (code, signal) => void finish(code !== null && (code === 0 || options.rejectNonZero === false) ? undefined : new Error(`${options.operation} subprocess exit ${code ?? signal}${stderr.trim() ? `: ${stderr.trim().slice(-1000)}` : ''}`), code ?? 0));
    // Handle abort racing the listener registration without ever accepting its output.
    if (options.signal?.aborted) abort();
  });
}
