import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, contained, read, safeId } from './workspaces.js';
import { readStageHeartbeats, stalledStage, type StageHeartbeat } from './watchdog-progress.js';
import { watchdogConfigurationHash } from './watchdog-config.js';
export { watchdogConfigurationHash } from './watchdog-config.js';

export interface WatchdogSettings { enabled: boolean; intervalHours: number }
export function saveWatchdogSettings(root: string, value: unknown): WatchdogSettings {
  const settings = validateSettings(value);
  atomicJson(contained(root, 'config/watchdog.json'), settings); return settings;
}
function validateSettings(value: unknown): WatchdogSettings {
  const row = value as WatchdogSettings;
  if (!row || typeof row.enabled !== 'boolean' || typeof row.intervalHours !== 'number'
    || !Number.isFinite(row.intervalHours) || row.intervalHours < 0.01 || row.intervalHours > 168
    || Object.keys(row).some(key => !['enabled', 'intervalHours'].includes(key))) throw new Error('Choose watchdog on/off and an interval between 0.01 and 168 hours');
  return { enabled: row.enabled, intervalHours: row.intervalHours };
}
export function readWatchdogSettings(root: string): WatchdogSettings {
  return validateSettings(read(contained(root, 'config/watchdog.json'), { enabled: false, intervalHours: 2 }));
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface WatchdogRecovery { packageId: string; key: string; input: Record<string, unknown> }
/** Catch-up follows the exact saved package, as the established production runner does.
 * Never replay setup, select a new story, release review, publish, or grant a new allowance. */
export function watchdogRecovery(root: string, rows: StageHeartbeat[], actorId: string, configurationHash: string, now = Date.now()): WatchdogRecovery {
  if (watchdogConfigurationHash(root) !== configurationHash) throw new Error('Settings changed; automatic recovery is held');
  const ids = [...new Set(rows.flatMap(row => row.packageId ? [safeId(row.packageId)] : []))];
  if (ids.length !== 1) throw new Error('No single saved package to recover; completed work is kept');
  const packageId = ids[0]!, dir = contained(root, 'workdir/videos', packageId);
  const meta = read<any>(join(dir, 'meta.json'), null), request = read<any>(join(dir, 'writing-request.json'), null);
  const script = read<any>(join(dir, 'script.json'), null), receipt = read<any>(join(dir, 'companion-writing-receipt.json'), null);
  if (!meta || meta.id !== packageId || meta.createdBy !== actorId || meta.reviewHold
    || !['scripted', 'assets_ready', 'voiced', 'rendered', 'failed:assets', 'failed:voice', 'failed:avatar', 'failed:render', 'failed:final-media-qc', 'failed:newsletter-media'].includes(meta.status)
    || Object.keys(meta.posts ?? {}).length || readdirSync(dir).some(name => /^\.delivery-/.test(name))) throw new Error('Package is held, awaiting your choice, released, or owned by another author');
  if (!script || !receipt || ![2, 3].includes(receipt.version) || receipt.scriptHash !== hash(script)
    || !request || !/^[a-f0-9]{64}$/.test(request.parentIdentity)) throw new Error('A verified script checkpoint is required for automatic recovery');
  const identity = hash({ version: 1, parent: request.parentIdentity });
  const budget = read<any>(contained(root, 'state/role-tasks', packageId, identity, 'budget.json'), null);
  if (!budget || budget.identity !== identity || !Number.isFinite(budget.deadline) || budget.deadline <= now
    || !Number.isSafeInteger(budget.maxPhysicalCalls) || budget.maxPhysicalCalls < 1 || budget.maxPhysicalCalls > 1000
    || !Number.isSafeInteger(budget.maxToolCalls) || budget.maxToolCalls < 1 || budget.maxToolCalls > 32
    || !Array.isArray(budget.attempts) || budget.attempts.length >= budget.maxPhysicalCalls
    || !Array.isArray(budget.tools) || budget.tools.length >= budget.maxToolCalls) throw new Error('Original time or call allowance is unavailable; automatic recovery cannot renew it');
  const checkpoint = read<any>(join(dir, 'journey-editorial-checkpoint.json'), null);
  if (receipt.version === 3 && (!checkpoint || checkpoint.artifacts?.script?.status !== 'accepted'
    || checkpoint.artifacts?.newsletter?.status !== 'accepted' || receipt.checkpointHash !== hash(checkpoint))) throw new Error('Editorial review is held or its checkpoint changed');
  const provenance = read<any>(contained(root, 'state/pack-provenance', packageId + '.json'), null);
  const edition = meta.edition || 'daily-roundup'; safeId(edition);
  const key = hash({ packageId, parentIdentity: request.parentIdentity, scriptHash: receipt.scriptHash, configurationHash });
  return { packageId, key, input: { action: 'journey', operation: 'draft', data: { resume: packageId, edition, ...(provenance?.id ? { workflowPack: provenance.id } : {}) } } };
}
export interface WatchedAttempt<T> { result: Promise<T>; stop: () => Promise<void>; pid?: number }
export class WorkerInterruptedError extends Error {}
export interface WatchdogUpdate { pid?: number; watchdog?: Record<string, unknown> }
export async function runWatchdog<T>(root: string, actorId: string, input: Record<string, unknown>,
  launch: (input: Record<string, unknown>, runId: string) => WatchedAttempt<T>,
  update?: (value: WatchdogUpdate) => void,
  options: { pollMs?: number; now?: () => number; settings?: () => WatchdogSettings } = {}): Promise<T> {
  const now = options.now ?? Date.now, settings = options.settings ?? (() => readWatchdogSettings(root));
  const configurationHash = watchdogConfigurationHash(root), runId = randomUUID(), startedAt = now();
  const recordPath = contained(root, 'state/watchdog-runs', runId, 'run.json');
  const record: Record<string, unknown> = { runId, operation: input.operation, actor: actorId, configurationHash, startedAt, status: 'running', recoveries: 0 };
  const save = () => { atomicJson(recordPath, record); update?.({ watchdog: { runId, status: record.status, stage: record.stage, reason: record.reason, recoveries: record.recoveries } }); };
  save();
  let request = input;
  let attemptRunId = runId;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cfg = settings(), launchedAt = now(); // Validate before a process is launched.
    const worker = launch(request, attemptRunId); update?.({ pid: worker.pid });
    let stopping = false, intervalMs = cfg.intervalHours * 3_600_000, nextAt = launchedAt + intervalMs;
    let lastEnabled = cfg.enabled;
    let fail!: (error: Error) => void;
    const alarm = new Promise<never>((_, reject) => { fail = reject; });
    const timer = setInterval(() => {
      if (stopping) return;
      try {
        const cfg = settings(), nextInterval = cfg.intervalHours * 3_600_000;
        if (nextInterval !== intervalMs || cfg.enabled !== lastEnabled) { intervalMs = nextInterval; nextAt = now() + intervalMs; lastEnabled = cfg.enabled; }
        if (!cfg.enabled || now() < nextAt) return;
        nextAt = now() + intervalMs;
        const rows = readStageHeartbeats(root, attemptRunId), reason = stalledStage(rows, now(), intervalMs, launchedAt);
        record.lastCheckedAt = now();
        if (!reason) { save(); return; }
        stopping = true; record.status = 'stopping'; record.stage = reason; save();
        void worker.stop().then(() => fail(new WorkerInterruptedError(reason)), error => fail(error));
      } catch (error) { stopping = true; void worker.stop().then(() => fail(error as Error), fail); }
    }, options.pollMs ?? 1000);
    timer.unref();
    try {
      const result = await Promise.race([worker.result, alarm]);
      if (stopping) { await worker.stop(); throw new WorkerInterruptedError(String(record.stage)); }
      record.status = 'complete'; record.finishedAt = now(); save(); return result;
    } catch (error) {
      clearInterval(timer);
      // A model/content validation failure is not a transport crash and must not enter catch-up.
      if (!(error instanceof WorkerInterruptedError) || !settings().enabled || attempt > 0) {
        record.status = 'held'; record.reason = String((error as Error).message).slice(0, 1000); save(); throw error;
      }
      await worker.stop();
      try {
        const rows = readStageHeartbeats(root, attemptRunId);
        const pins = [...new Set(rows.filter(row => row.packageId).map(row => row.configurationHash))];
        if (pins.length !== 1 || !pins[0]) throw new Error('No unchanged package configuration checkpoint');
        const recovery = watchdogRecovery(root, rows, actorId, pins[0], now());
        const marker = contained(root, 'state/watchdog-recoveries', recovery.key + '.json');
        mkdirSync(contained(root, 'state/watchdog-recoveries'), { recursive: true });
        const fd = openSync(marker, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify({ runId, packageId: recovery.packageId, at: now(), reason: (error as Error).message })); } finally { closeSync(fd); }
        request = recovery.input; record.status = 'recovering'; record.recoveries = 1; attemptRunId = randomUUID(); record.recoveryRunId = attemptRunId; save();
      } catch (held) {
        record.status = 'held'; record.reason = (held as NodeJS.ErrnoException).code === 'EEXIST' ? 'Automatic recovery was already used for this checkpoint' : (held as Error).message;
        save(); throw new Error(`${(error as Error).message}. ${record.reason}`);
      }
    } finally { clearInterval(timer); }
  }
  throw new Error('Watchdog recovery exhausted');
}
