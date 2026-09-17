export interface SourceAlignmentText { id: number; text: string }
export interface SourceSentenceAlignment { sentenceId: number; exactClaimIds: number[] }

function checkRows(rows: readonly SourceAlignmentText[], name: string, max: number): void {
  if (!Array.isArray(rows) || !rows.length || rows.length > max) throw new Error(`Source alignment needs 1–${max} ${name} records`);
  const ids = new Set<number>();
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || ids.has(row.id)) throw new Error(`Source alignment ${name} IDs must be unique positive integers`);
    ids.add(row.id);
    if (typeof row.text !== 'string' || !row.text.trim() || row.text.length > 6500) throw new Error(`Source alignment ${name} text must be nonempty and bounded`);
  }
}

function isWholeSentence(text: string): boolean {
  // This is a structural bound, not a grammatical or factual judgment. Unpunctuated
  // fragments and multiple complete sentences do not receive this lookup hint.
  if (!/[.!?]["'’”\])}]*$/.test(text)) return false;
  return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
    .filter(part => part.segment.trim()).length === 1;
}

/** Lookup aid only: equal text does not establish entailment, source truth or originality.
 * Every sentence still needs its complete paragraph and all claims reviewed for attribution,
 * conditions, negation and references. Absence of a match says nothing about a paraphrase.
 * The caller supplies the complete code-numbered paragraph and original claim namespace.
 * Only boundary whitespace is trimmed; internal bytes, case, punctuation and order stay exact.
 */
export function alignSourceSentences(sentences: readonly SourceAlignmentText[], claims: readonly SourceAlignmentText[]): SourceSentenceAlignment[] {
  checkRows(sentences, 'sentence', 32);
  checkRows(claims, 'claim', 24);
  const wholeClaims = new Map<string, number[]>();
  for (const claim of claims) {
    const text = claim.text.trim();
    if (!isWholeSentence(text)) continue;
    const ids = wholeClaims.get(text) ?? [];
    ids.push(claim.id);
    wholeClaims.set(text, ids);
  }
  return sentences.map(sentence => ({ sentenceId: sentence.id,
    exactClaimIds: isWholeSentence(sentence.text.trim()) ? [...(wholeClaims.get(sentence.text.trim()) ?? [])] : [],
  }));
}
