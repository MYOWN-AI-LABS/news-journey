/** Citation transport correction only. This never clears a source finding or accepts prose. */
import { createHash } from 'node:crypto';
import type { DailyEditorialCheckpoint, DailyEditorialInput, DailyEditorialReview } from './daily-editorial.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function reconcileTruncatedReviewCitation(input: DailyEditorialInput, original: DailyEditorialReview) {
  if (original?.verdict !== 'changes-required' || !Array.isArray(original.findings) || !original.findings.length || original.findings.length > 8) throw new Error('Citation correction only retains an existing changes-required verdict');
  const review = structuredClone(original), corrections: { finding: number; evidence: number; sourceId: string; originalQuote: string; completeQuote: string; sourceTextHash: string }[] = [];
  for (const [i, finding] of review.findings.entries()) {
    const story = input.stories.find(row => row.id === finding.storyId);
    if (!story || !Array.isArray(finding.evidence)) throw new Error('Citation correction needs an owned source finding');
    for (const [j, evidence] of finding.evidence.entries()) {
      const source = story.sources.find(row => row.id === evidence?.sourceId);
      if (!source || typeof evidence.quote !== 'string' || !evidence.quote) throw new Error('Citation source ownership changed');
      if (source.text.includes(evidence.quote)) continue;
      // Only the existing exact prefix with a substituted final period may be
      // completed. No fuzzy search, paraphrase, removed condition or new quote.
      if (evidence.quote.length < 80 || !/[^.]\.$/.test(evidence.quote)) throw new Error('Invalid citation is not a bounded exact sentence prefix');
      const prefix = evidence.quote.slice(0, -1);
      const matches = source.text.split(/\r?\n/).flatMap(line => [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(line)].map(row => row.segment.trim()))
        .filter(sentence => sentence.startsWith(`${prefix} `) && sentence.length > evidence.quote.length && sentence.length <= 3000 && /[.!?]["'’”)]*$/.test(sentence));
      if (matches.length !== 1 || !source.text.includes(matches[0]!)) throw new Error('Citation has no unique complete owned source sentence');
      corrections.push({ finding: i, evidence: j, sourceId: source.id, originalQuote: evidence.quote, completeQuote: matches[0]!, sourceTextHash: source.textSha256 });
      evidence.quote = matches[0]!;
    }
  }
  if (corrections.length !== 1) throw new Error('This reconciliation requires exactly one unique truncated citation');
  return { version: 1 as const, originalReviewHash: hash(original), correctedReviewHash: hash(review), inputHash: hash(input), corrections, review };
}

/** A failed reviewer transport may expose its rejecting verdict, but never restore a spent write. */
export function assertCitationRecoveryCandidate(checkpoint: DailyEditorialCheckpoint) {
  const state = checkpoint.artifacts?.script, newsletter = checkpoint.artifacts?.newsletter;
  if (checkpoint.version !== 1 || checkpoint.contentHash !== hash(checkpoint.artifacts) || state?.status !== 'held'
    || state.origin !== 'model' || state.writes !== 1 || state.candidates.length !== 1 || state.reviews.length
    || !state.reviewRecovery || state.citationRecovery || state.lengthRecovery || state.factualRecovery
    || state.invalidReview?.kind !== 'validation' || state.invalidReview.candidateHash !== hash(state.candidates[0])
    || state.failures.length < 2 || state.invalidReview.errorHash !== createHash('sha256').update(state.failures.at(-1)!).digest('hex')
    || newsletter?.status !== 'new' || newsletter.writes || newsletter.candidates.length || newsletter.reviews.length) {
    throw new Error('Citation recovery requires the exact held invalid-review candidate and its original unused repair');
  }
}
