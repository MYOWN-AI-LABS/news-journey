import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { atomicJson, contained } from './workspaces.js';
import { releaseLock } from './release-lock.js';

const MAX_WAIT_MS = 30 * 60 * 1000;
const active = new Map<string, Promise<void>>();
interface PreparationReceipt {
  version: 1; id: string; inputHash: string; pid: number;
  status: 'running' | 'complete' | 'failed'; startedAt: string; finishedAt?: string;
}
function inputHash(root: string): string {
  const hash = createHash('sha256').update(JSON.stringify({ version: 1, node: process.version, platform: process.platform, arch: process.arch }));
  for (const file of ['start.mjs', 'package-lock.json', 'tts/pyproject.toml', 'tts/uv.lock']) {
    hash.update(file).update('\0').update(readFileSync(contained(root, file))).update('\0');
  }
  return hash.digest('hex');
}
function receiptAt(root: string): PreparationReceipt | null {
  const file = contained(root, 'state/shared-preparation.json');
  if (!existsSync(file)) return null;
  const row = JSON.parse(readFileSync(file, 'utf8')) as PreparationReceipt;
  if (row.version !== 1 || typeof row.id !== 'string' || !/^[a-f0-9-]{36}$/.test(row.id)
    || !/^[a-f0-9]{64}$/.test(row.inputHash) || !Number.isSafeInteger(row.pid) || row.pid < 1
    || !['running', 'complete', 'failed'].includes(row.status) || !Number.isFinite(Date.parse(row.startedAt))
    || row.status !== 'running' && !Number.isFinite(Date.parse(row.finishedAt ?? ''))) throw new Error('Invalid shared tool preparation receipt; inspect the retained preparation state');
  return row;
}
const timeoutError = () => new Error('Shared narration and video tool preparation exceeded its bounded wait; the other preparation and this preview’s saved state are unchanged');
async function until<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeoutError()), remaining); })]); }
  finally { clearTimeout(timer); }
}

/** Shared prerequisite work only. Callers retain their own workspace/job and model budgets.
 * A completed receipt is reusable only by overlapping callers, never a permanent readiness cache.
 * `prepare` must terminate its subprocess before rejecting or reaching the supplied deadline.
 */
export async function sharedPreparation(root: string, prepare: (remainingMs: number) => Promise<void>, timeoutMs = MAX_WAIT_MS): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS) throw new Error('Preparation timeout must be between 1ms and 30 minutes');
  root = realpathSync(root);
  const deadline = Date.now() + timeoutMs, expected = inputHash(root);
  const previous = active.get(root);
  if (previous) {
    await until(previous, deadline);
    if (inputHash(root) !== expected) throw new Error('Tool preparation inputs changed while waiting; saved preview state is unchanged');
    return;
  }
  const initial = receiptAt(root), initialId = initial?.id;
  let joinedId = initial?.status === 'running' ? initial.id : undefined;
  const work = async () => {
    for (;;) {
      if (Date.now() >= deadline) throw timeoutError();
      const receipt = receiptAt(root);
      if (receipt?.status === 'running') {
        joinedId = receipt.id;
        try { process.kill(receipt.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            // The owner can publish completion and exit between our read and PID check.
            const finished = receiptAt(root);
            if (finished?.id === receipt.id && finished.inputHash === receipt.inputHash && finished.status !== 'running') continue;
            throw new Error('Earlier shared tool preparation stopped without a completion receipt; inspect it before retrying');
          }
          throw error;
        }
      }
      if (receipt && receipt.inputHash === expected && (receipt.id !== initialId || receipt.id === joinedId)) {
        if (receipt.status === 'complete') {
          if (inputHash(root) !== expected) throw new Error('Tool preparation inputs changed while waiting; saved preview state is unchanged');
          return;
        }
        if (receipt.status === 'failed') throw new Error('The shared narration and video tool preparation failed; inspect its original job before retrying');
      }
      let unlock: (() => void) | undefined;
      try { unlock = releaseLock(root, 'prepare'); }
      catch (error) {
        if (!(error instanceof Error) || !(/^Busy:/.test(error.message) || (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
        await pause(Math.min(100, Math.max(1, deadline - Date.now())));
        continue;
      }
      try {
        // A worker may have completed between the read and lock acquisition.
        const latest = receiptAt(root);
        if (latest && latest.inputHash === expected && (latest.id !== initialId || latest.id === joinedId)) {
          if (latest.status === 'complete') {
            if (inputHash(root) !== expected) throw new Error('Tool preparation inputs changed while waiting; saved preview state is unchanged');
            return;
          }
          if (latest.status === 'failed') throw new Error('The shared narration and video tool preparation failed; inspect its original job before retrying');
        }
        if (latest?.status === 'running') throw new Error('Shared tool preparation has no completion receipt; inspect it before retrying');
        if (inputHash(root) !== expected) throw new Error('Tool preparation inputs changed while waiting; saved preview state is unchanged');
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw timeoutError();
        const current: PreparationReceipt = { version: 1, id: randomUUID(), inputHash: expected, pid: process.pid, status: 'running', startedAt: new Date().toISOString() };
        atomicJson(contained(root, 'state/shared-preparation.json'), current);
        try {
          await prepare(remaining);
          if (Date.now() >= deadline) throw timeoutError();
          if (inputHash(root) !== expected) throw new Error('Tool preparation inputs changed during installation');
          atomicJson(contained(root, 'state/shared-preparation.json'), { ...current, status: 'complete', finishedAt: new Date().toISOString() });
          return;
        } catch (error) {
          atomicJson(contained(root, 'state/shared-preparation.json'), { ...current, status: 'failed', finishedAt: new Date().toISOString() });
          throw error;
        }
      } finally { unlock(); }
    }
  };
  const promise = work(); active.set(root, promise);
  try { await promise; }
  finally { if (active.get(root) === promise) active.delete(root); }
}
