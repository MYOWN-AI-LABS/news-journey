import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { activeRoot, atomicJson, contained, read } from './workspaces.js';
import { watchdogConfigurationHash } from './watchdog-config.js';

export interface StageHeartbeat {
  id: string; parent?: string; pid: number; stage: string; packageId?: string; configurationHash?: string;
  status: 'running' | 'complete' | 'failed'; startedAt: number; progressAt: number; heartbeatAt: number;
}
const context = new AsyncLocalStorage<StageHeartbeat>();
export function watchdogDirectory(root: string, runId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid watchdog run identity');
  return contained(root, 'state/watchdog-runs', runId);
}
/** Heartbeats prove liveness only. Start/completion receipts separately record real progress. */
export async function watchStage<T>(stage: string, action: () => Promise<T>, packageId?: string): Promise<T> {
  const runId = process.env.HARNESS_WATCHDOG_RUN;
  if (!runId) return action();
  const dir = watchdogDirectory(activeRoot(), runId), parent = context.getStore();
  const row: StageHeartbeat = { id: randomUUID(), parent: parent?.id, pid: process.pid, stage: stage.slice(0, 100),
    packageId: packageId ?? parent?.packageId, configurationHash: parent?.configurationHash ?? (packageId ? watchdogConfigurationHash(activeRoot()) : undefined),
    status: 'running', startedAt: Date.now(), progressAt: Date.now(), heartbeatAt: Date.now() };
  const save = () => atomicJson(contained(dir, row.id + '.json'), row);
  save();
  const timer = setInterval(() => { row.heartbeatAt = Date.now(); try { save(); } catch { /* The supervisor treats stale/missing receipts as a hold. */ } }, 5_000);
  timer.unref();
  try { const result = await context.run(row, action); row.status = 'complete'; return result; }
  catch (error) { row.status = 'failed'; throw error; }
  finally {
    clearInterval(timer); row.progressAt = row.heartbeatAt = Date.now(); save();
    if (parent) { parent.progressAt = Date.now(); atomicJson(contained(dir, parent.id + '.json'), parent); }
  }
}
export function readStageHeartbeats(root: string, runId: string): StageHeartbeat[] {
  const dir = watchdogDirectory(root, runId);
  let files: string[];
  try { files = readdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (files.length > 5000) throw new Error('Too many watchdog stage receipts; inspect this run');
  return files.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => {
    const row = read<StageHeartbeat | null>(contained(dir, name), null);
    if (!row || row.id + '.json' !== name || !['running', 'complete', 'failed'].includes(row.status)
      || ![row.startedAt, row.progressAt, row.heartbeatAt].every(Number.isFinite)) throw new Error('Invalid watchdog stage receipt');
    return row;
  });
}
export function stalledStage(rows: StageHeartbeat[], now: number, intervalMs: number, startedAt: number): string | null {
  const running = rows.filter(row => row.status === 'running');
  const parents = new Set(running.map(row => row.parent));
  // The outer worker stays alive while a CLI child runs; its generic heartbeat is not pipeline progress.
  const specific = running.filter(row => row.stage !== 'journey-action');
  const leaves = (specific.length ? specific : running).filter(row => !parents.has(row.id));
  const stuck = leaves.find(row => now - row.progressAt >= intervalMs);
  if (stuck) return `${stuck.stage}: ${now - stuck.heartbeatAt > 15_000 ? 'heartbeat stopped' : 'worker alive but no progress'}`;
  if (!rows.length && now - startedAt >= intervalMs) return 'Worker did not record a stage heartbeat';
  return null;
}
