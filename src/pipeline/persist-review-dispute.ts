import { constants, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicJson, contained, safeId } from '../workspaces.js';
import { createSourceReviewDispute, SourceReviewDisputeError } from './review-dispute.js';

/** A repeated Journey click cannot spend another writing attempt on an unresolved hold.
 * Scan immutable evidence, not an editable latest pointer; sibling stages remain independent. */
export function assertNoUnresolvedReviewDispute(root: string, parentId: string, stage: 'newsletter' | 'script'): void {
  safeId(parentId);
  const directory = contained(root, 'state/review-disputes', parentId);
  if (!existsSync(directory)) return;
  const files = readdirSync(directory).filter(file => /^[a-f0-9]{64}\.json$/.test(file));
  if (files.length > 4096) throw new Error('Review dispute history requires inspection before further writing');
  for (const name of files) {
    const path = contained(root, 'state/review-disputes', parentId, name);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: string; try { bytes = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
    if (createHash('sha256').update(bytes).digest('hex') + '.json' !== name) throw new Error('Saved review dispute changed; writing remains on hold');
    const saved = JSON.parse(bytes);
    if (saved.version !== 1 || saved.status !== 'disputed' || saved.parentId !== parentId || !['newsletter', 'script'].includes(saved.stage)) throw new Error('Invalid saved review hold; writing remains on hold');
    if (saved.stage === stage) throw new Error(`Source review remains disputed. Independent adjudication is required before retrying ${stage}; no new writing attempt was started. Preserved review evidence: ${path}`);
  }
}

/** Preserve a review hold before pipeline orchestration reduces errors to display strings.
 * This writes evidence, never acceptance, and never renews the parent's budget. */
export function persistSourceReviewDispute(error: unknown, options: {
  root: string; parentId: string; parentIdentity: string; stage: 'newsletter' | 'script';
}): never {
  if (!(error instanceof SourceReviewDisputeError)) throw error;
  safeId(options.parentId);
  if (!/^[a-f0-9]{64}$/.test(options.parentIdentity)) throw new Error('Review dispute needs the original parent identity', { cause: error });
  const d = error.dispute;
  const rebuilt = createSourceReviewDispute(d.candidate.text, d.claims.map(row => row.text), d.review,
    { stage: d.stage, sourceContext: d.sourceContext, task: d.task, presentation: d.presentation });
  if (!rebuilt || JSON.stringify(rebuilt) !== JSON.stringify(d)) throw new Error('Review dispute evidence changed before saving', { cause: error });
  const envelope = { version: 1, status: 'disputed', parentId: options.parentId, parentIdentity: options.parentIdentity,
    stage: options.stage, dispute: d };
  const bytes = JSON.stringify(envelope, null, 2) + '\n';
  const receiptHash = createHash('sha256').update(bytes).digest('hex');
  const directory = contained(options.root, 'state/review-disputes', options.parentId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = contained(options.root, 'state/review-disputes', options.parentId, receiptHash + '.json');
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
  } catch (writeError) {
    if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (readFileSync(fd, 'utf8') !== bytes) throw new Error('Saved review dispute changed; original evidence cannot be overwritten'); }
    finally { closeSync(fd); }
  }
  atomicJson(contained(options.root, 'state/review-disputes', options.parentId, `${options.stage}-latest.json`),
    { version: 1, status: 'disputed', receipt: path, receiptHash, identityHash: d.identityHash });
  error.message += ` Preserved review evidence: ${path}`;
  throw error;
}
