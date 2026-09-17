import { existsSync, readFileSync } from 'node:fs';
import { contained } from '../workspaces.js';

export interface HostedRescueConfig { rescue?: { enabled?: boolean; maxCallsPerDay?: number } }
export interface RescueBudget {
  version: 1;
  day: string;
  attempts: Array<{ id: string; reservedAt: string; provider: 'codex' | 'claude'; model: string | null }>;
}

export function rescueLimit(config: HostedRescueConfig): number {
  if (config.rescue?.enabled !== true) return 0;
  const limit = config.rescue.maxCallsPerDay ?? 2;
  if (!Number.isInteger(limit) || limit < 0 || limit > 10) throw new Error('Hosted rescue limit must be a whole number from 0 to 10 calls per day.');
  return limit;
}

export function readRescueBudget(root: string, day: string): RescueBudget {
  const path = contained(root, 'state', 'model-rescue', `${day}.json`);
  if (!existsSync(path)) return { version: 1, day, attempts: [] };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as RescueBudget;
    if (value.version !== 1 || value.day !== day || !Array.isArray(value.attempts) || value.attempts.some(attempt => !attempt || typeof attempt.id !== 'string' || typeof attempt.reservedAt !== 'string' || !['codex', 'claude'].includes(attempt.provider))) throw new Error('invalid receipt');
    return value;
  } catch {
    throw new Error('Hosted rescue allowance could not be verified. Inspect this workspace’s saved model-rescue receipt before retrying. No hosted rescue was started.');
  }
}

/** Read only and explicitly workspace scoped, including when a server serves several workspaces. */
export function hostedRescueAllowance(root: string, config: HostedRescueConfig, now = new Date()): { limit: number; remaining: number; day: string } {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const limit = rescueLimit(config);
  return { limit, remaining: limit ? Math.max(0, limit - readRescueBudget(root, day).attempts.length) : 0, day };
}
