import { createHash } from 'node:crypto';
import { alignSourceSentences } from './source-alignment.js';
import type { SourceSupportContext, SourceSupportReview } from './source-support.js';
import type { PreparedModelTask } from './writing-task.js';

export interface SourceReviewDispute {
  version: 1;
  status: 'disputed';
  candidate: { text: string; sha256: string };
  claims: { id: number; text: string }[];
  claimsHash: string;
  sourceContext?: SourceSupportContext;
  contextHash: string;
  review: SourceSupportReview;
  reviewHash: string;
  findings: { sentenceId: number; kind: 'exact-source-rejection' | 'citation-mismatch'; sentence: string;
    exactClaimIds: number[]; citedClaimIds: number[]; reason: string }[];
  stage: 'specialist' | 'general';
  task?: PreparedModelTask;
  taskHash: string;
  /** Complete authored-field presentation when the disputed sentence is a field. */
  presentation?: { fieldId: string; fields: unknown; review: unknown; context: unknown; sourceContexts: unknown };
  identityHash: string;
}
export interface SourceReviewDisputeOptions {
  stage: SourceReviewDispute['stage'];
  sourceContext?: SourceSupportContext;
  task?: PreparedModelTask;
  presentation?: SourceReviewDispute['presentation'];
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** A consistency check on a critic, never an entailment check or permission to publish.
 * Inspect each completed batch outside the model's retry validator. A partial review can
 * establish a dispute, but cannot establish acceptance. Preserve the full evidence packet.
 */
export function createSourceReviewDispute(text: string, claims: readonly string[], review: SourceSupportReview,
  options: SourceReviewDisputeOptions): SourceReviewDispute | null {
  if (!text.trim() || text.length > 6000 || JSON.stringify(claims).length > 6500) throw new Error('Review dispute requires the complete bounded draft and claims');
  if (!['specialist', 'general'].includes(options.stage)) throw new Error('Review dispute requires the original review stage');
  if (options.presentation && JSON.stringify(options.presentation).length > 60000) throw new Error('Review dispute presentation exceeds its complete evidence bound');
  const sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].map((part, index) => ({ id: index + 1, text: part.segment.trim() }));
  const facts = claims.map((text, index) => ({ id: index + 1, text }));
  const aligned = alignSourceSentences(sentences, facts);
  if (!Array.isArray(review.sentences)) throw new Error('Review dispute needs original critic rows');
  const seen = new Set<number>();
  const findings: SourceReviewDispute['findings'] = [];
  for (const row of review.sentences) {
    if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || row.id > sentences.length || seen.has(row.id)
      || typeof row.supported !== 'boolean' || typeof row.reason !== 'string' || !row.reason.trim()
      || !Array.isArray(row.claimIds) || new Set(row.claimIds).size !== row.claimIds.length
      || row.claimIds.some(id => !Number.isSafeInteger(id) || id < 1 || id > facts.length)) throw new Error('Review dispute needs valid original critic rows and evidence IDs');
    seen.add(row.id);
    const exactClaimIds = aligned[row.id - 1]!.exactClaimIds;
    if (!exactClaimIds.length) continue; // A paraphrase is not a defect.
    const kind = !row.supported ? 'exact-source-rejection'
      : !row.claimIds.some(id => exactClaimIds.includes(id)) ? 'citation-mismatch' : null;
    if (kind) findings.push({ sentenceId: row.id, kind, sentence: sentences[row.id - 1]!.text,
      exactClaimIds, citedClaimIds: [...row.claimIds], reason: row.reason });
  }
  if (!findings.length) return null;
  const snapshot = structuredClone({ version: 1 as const, status: 'disputed' as const,
    candidate: { text, sha256: createHash('sha256').update(text).digest('hex') }, claims: facts, claimsHash: hash(facts),
    ...(options.sourceContext ? { sourceContext: options.sourceContext } : {}), contextHash: hash(options.sourceContext ?? null),
    review, reviewHash: hash(review), findings, stage: options.stage,
    ...(options.task ? { task: options.task } : {}), taskHash: hash(options.task ?? null),
    ...(options.presentation ? { presentation: options.presentation } : {}) });
  return freeze({ ...snapshot, identityHash: hash(snapshot) });
}

export class SourceReviewDisputeError extends Error {
  readonly code = 'SOURCE_REVIEW_DISPUTED' as const;
  constructor(readonly dispute: SourceReviewDispute) {
    super(`Source review disputed for sentence IDs ${dispute.findings.map(row => row.sentenceId).join(', ')}. The critic's finding conflicts with exact source evidence. Independent adjudication is required; no automatic rewrite or factual approval is authorized. Evidence ${dispute.identityHash}.`);
    this.name = 'SourceReviewDisputeError';
  }
}

/** Do not pass this check as a modelJson validator: a dispute must never retry the critic. */
export function assertSourceReviewUndisputed(text: string, claims: readonly string[], review: SourceSupportReview,
  options: SourceReviewDisputeOptions): void {
  const dispute = createSourceReviewDispute(text, claims, review, options);
  if (dispute) throw new SourceReviewDisputeError(dispute);
}


export type SourceReviewAdjudication = { status: 'hold'; reason: string; findings: SourceReviewDispute['findings'] };

/** Exact text alignment establishes a conflict worth adjudicating, never factual approval.
 * An external adjudicator must consider the complete presentation and source conditions.
 * Retain this exported entry point for old callers, but it cannot rewrite critic verdicts.
 */
export function adjudicateSourceReviewDispute(dispute: SourceReviewDispute): SourceReviewAdjudication {
  if (dispute.status !== 'disputed' || !dispute.findings.length) throw new Error('Adjudication needs a disputed receipt with findings');
  return { status: 'hold', reason: 'Independent adjudication of the complete candidate, critic and source context is required. Exact matching alone cannot approve a fact or replace citation IDs.', findings: dispute.findings };
}

/** Compatibility wrapper: disputed reviews stop outside model validators and repair loops. */
export function resolveSourceReviewDispute(text: string, claims: readonly string[], review: SourceSupportReview,
  options: SourceReviewDisputeOptions): SourceSupportReview {
  assertSourceReviewUndisputed(text, claims, review, options);
  return review;
}
