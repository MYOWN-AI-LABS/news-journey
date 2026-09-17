/** Explicitly injected positive responses for unrelated routing, cache and length tests.
 * This is not a critic, does not assess prose, and must never be used by production dispatch.
 * Real failures, controls and schema validation have their own focused-review tests and replays.
 */
export function syntheticPassingFactualResponse(prompt: string): unknown | undefined {
  if (!prompt.startsWith('FACTUAL CONDITIONS REVIEW') && !prompt.startsWith('FACTUAL MODALITY AND DATE REVIEW') && !prompt.startsWith('DRAFT ASSERTIONS REVIEW')) return undefined;
  const get = <T>(name: string): T => {
    const line = prompt.split('\n').find(row => row.startsWith(`${name}: `));
    if (!line) throw new Error(`Synthetic factual fixture needs ${name}`);
    return JSON.parse(line.slice(name.length + 2)) as T;
  };
  type TextRow = { id: number; text?: string; spans?: Array<{ id: number; text: string }> };
  const sentences = get<TextRow[]>('DRAFT_SENTENCES');
  if (prompt.startsWith('DRAFT ASSERTIONS REVIEW')) return { sentences: sentences.map(sentence => ({ id: sentence.id, assertedStatus: 'achieved-behavior',
    exclusionStatus: 'none', temporalFraming: 'none',
    ...(sentence.spans ? { anchorIds: [sentence.spans[0]!.id] } : { anchors: [sentence.text!.slice(0, 160)] }),
    reason: 'Injected draft-reading decision; no semantic accuracy claim.' })) };
  const claims = get<TextRow[]>('PINNED_CLAIMS');
  if (prompt.startsWith('FACTUAL CONDITIONS REVIEW')) return {
    claimUses: claims.map(claim => ({ id: claim.id, sentenceIds: sentences.map(sentence => sentence.id),
      ...(claim.spans ? { scope: 'preserved', scopeSentenceIds: sentences.map(sentence => sentence.id), anchorIds: [claim.spans[0]!.id],
        reason: 'Injected scope decision; no semantic accuracy claim.' } : {}) })),
    unusedClaimIds: [],
    restrictions: get<Array<{ id: number }>>('RESTRICTION_INDEX').map(row => ({ id: row.id, claimIds: [], sentenceIds: [],
      disposition: 'irrelevant', reason: 'Injected fixture decision; no semantic accuracy claim.' })),
  };
  const context = get<{ sources: unknown[] } | null>('SOURCE_CONTEXT');
  const reviewedIds = prompt.includes('\nREVIEW_SENTENCE_IDS: ') ? get<number[]>('REVIEW_SENTENCE_IDS') : sentences.map(sentence => sentence.id);
  return { sentences: sentences.filter(sentence => reviewedIds.includes(sentence.id)).map(sentence => ({ id: sentence.id, claimIds: [claims[0]!.id], sourceIds: context?.sources.length ? [1] : [],
    basis: 'reported-observation', assertedStatus: 'achieved-behavior', temporalStatus: 'neutral',
    exclusionBasis: 'none',
    anchors: [claims[0]!.spans ? { claimId: claims[0]!.id, spanId: claims[0]!.spans[0]!.id } : { claimId: claims[0]!.id, quote: claims[0]!.text!.slice(0, 160) }],
    reason: 'Injected fixture decision; no semantic accuracy claim.' })) };
}
