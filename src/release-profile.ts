import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_ROOT } from './workspaces.js';

/** Distribution defaults belong to the code package, never to a customer's workspace. */
export function releaseProfile(codeRoot = CODE_ROOT): { edition: 'development' | 'free'; evaluation: boolean } {
  const path = join(codeRoot, 'config/distribution.json');
  if (!existsSync(path)) return { edition: 'development', evaluation: false };
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value?.edition !== 'free' || typeof value.evaluation !== 'boolean') throw new Error('Invalid distribution profile');
  return value;
}

export function assertProDistribution(feature: string, codeRoot = CODE_ROOT) {
  if (releaseProfile(codeRoot).edition === 'free') throw new Error(`${feature} belongs to the planned Pro release and is unavailable in this Free package. No payment is enabled.`);
}

export function assertPublicDelivery(codeRoot = CODE_ROOT) {
  if (releaseProfile(codeRoot).evaluation) throw new Error('Private evaluation: external publication is disabled. Review the local newsletter and video.');
}
