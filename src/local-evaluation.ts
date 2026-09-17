/** Explicit, non-publishable local model experiments; never a model qualification. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelConfig } from './llm/model.js';
export const LOCAL_EVALUATION_FILE = 'private-local-evaluation.json';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface PrivateLocalEvaluation {
  version: 1; mode: 'unqualified-local-evaluation'; parentId: string; modelConfigHash: string;
  sourceReplayManifestHash: string; createdBy: string; createdAt: string;
  publicationAllowed: false; qualificationClaimed: false;
}
export function assertEvaluationAction(root: string, action: string): void {
  if (['approve', 'publish'].includes(action) && existsSync(join(root, 'state', LOCAL_EVALUATION_FILE))) throw new Error('Private local model evaluation cannot be approved or published; its unqualified reviews are evaluation evidence only.');
}
export function privateLocalEvaluation(root: string, parentId: string, primary: ModelConfig): { hash: string; receipt: PrivateLocalEvaluation } | null {
  const path = join(root, 'state', LOCAL_EVALUATION_FILE);
  if (!existsSync(path)) return null;
  const receipt = JSON.parse(readFileSync(path, 'utf8')) as PrivateLocalEvaluation;
  const fail = () => { throw new Error('Private local evaluation does not match its isolated package, model or disabled publication settings'); };
  if (receipt.version !== 1 || receipt.mode !== 'unqualified-local-evaluation' || receipt.parentId !== parentId || receipt.publicationAllowed !== false || receipt.qualificationClaimed !== false || !receipt.createdBy || !Number.isFinite(Date.parse(receipt.createdAt))) return fail();
  if (primary.provider !== 'ollama' || primary.rescue?.enabled !== false || receipt.modelConfigHash !== hash(primary)) return fail();
  const savedConfig = JSON.parse(readFileSync(join(root, 'config/model.json'), 'utf8'));
  if (hash(savedConfig) !== receipt.modelConfigHash) return fail();
  const pipeline = JSON.parse(readFileSync(join(root, 'config/pipeline.json'), 'utf8'));
  const platforms = JSON.parse(readFileSync(join(root, 'config/platforms.json'), 'utf8'));
  if (pipeline.autonomy !== 'review' || Object.values(platforms).some((value: any) => value?.enabled)) return fail();
  const packageReceipt = JSON.parse(readFileSync(join(root, 'workdir/videos', parentId, LOCAL_EVALUATION_FILE), 'utf8'));
  const replay = JSON.parse(readFileSync(join(root, 'workdir/videos', parentId, 'journey-editorial-replay.json'), 'utf8'));
  if (hash(packageReceipt) !== hash(receipt) || !/^[a-f0-9]{64}$/.test(receipt.sourceReplayManifestHash) || replay.manifestHash !== receipt.sourceReplayManifestHash) return fail();
  return { hash: hash(receipt), receipt };
}
