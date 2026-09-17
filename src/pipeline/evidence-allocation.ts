/** Lexical capacity allocation, not a guarantee of entailment or finished prose. Source verification,
 * complete qualifier groups, final word counts and editorial review remain the caller's gates. */
export const EVIDENCE_ALLOCATION_VERSION = 2;
export interface EvidenceAllocationRange { min: number; max: number }
export interface EvidenceAllocationTopic {
  topicId: string;
  weight: 'lead' | 'standard' | 'quick';
  /** Already verified and de-duplicated across the whole edition by the caller's evidence ledger.
   * Equal counts are valid; counts alone cannot establish whether two sources repeat a fact. */
  availableWords: number;
}
export interface EvidenceAllocatedTopic extends EvidenceAllocationTopic { target: EvidenceAllocationRange }
export type EvidenceAllocation = {
  status: 'ready';
  requested: EvidenceAllocationRange;
  availableWords: number;
  allocated: EvidenceAllocationRange;
  topics: EvidenceAllocatedTopic[];
  /** Different from the previous unconstrained weighted section ranges. */
  changed: boolean;
} | {
  status: 'needs-evidence';
  requested: EvidenceAllocationRange;
  availableWords: number;
  minimumAdditionalWords: number;
  missingTopicIds: string[];
  /** A bounded research request, not approved writing ranges or newly credited source words. */
  additionalWords: Array<{ topicId: string; words: number }>;
};
const weights = { lead: 8, standard: 5, quick: 3 } as const;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** Credit each exact/canonically syndicated evidence unit once across the edition, in original
 * topic/unit order. Normalization is for identity only; count the first source's original words.
 * This does not deduplicate paraphrases or establish that a unit is relevant or source-verified. */
export function countEvidenceWords(groups: readonly (readonly string[])[]): number[] {
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > 8 || groups.some(group => !Array.isArray(group) || group.some(text => typeof text !== 'string'))) throw new Error('Evidence counting needs1–8 groups of verified source strings');
  const seen = new Set<string>();
  return groups.map((group: readonly string[]) => group.reduce((total: number, text: string) => {
    const key = text.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) return total;
    seen.add(key);
    return total + text.trim().split(/\s+/).length;
  }, 0));
}

/** Hamilton remainder ordering is stable in original topic order; integer arithmetic avoids
 * floating-point tie changes. A capped topic leaves the remaining allocation to other topics. */
function fill(total: number, caps: readonly number[], shares: readonly number[], floor = 1): number[] {
  const values = caps.map(() => floor);
  let remaining = total - sum(values);
  while (remaining > 0) {
    const active = caps.map((cap, i) => i).filter(i => values[i]! < caps[i]!);
    if (!active.length) throw new Error('Evidence allocation exhausted its verified capacity');
    const weight = sum(active.map(i => shares[i]!));
    const saturated = active.filter(i => remaining * shares[i]! >= (caps[i]! - values[i]!) * weight);
    if (saturated.length) {
      for (const i of saturated) { remaining -= caps[i]! - values[i]!; values[i] = caps[i]!; }
      continue;
    }
    const amount = remaining;
    for (const i of active) { const extra = Math.floor(amount * shares[i]! / weight); values[i]! += extra; remaining -= extra; }
    const order = active.sort((a, b) => (amount * shares[b]! % weight) - (amount * shares[a]! % weight) || a - b);
    for (const i of order.slice(0, remaining)) values[i]!++;
    remaining = 0;
  }
  return values;
}

/** Redistribute a feasible edition's unchanged minimum instead of asking a sparse topic to pad.
 * Weight tiers express allocation preference only, never a reason to discard available facts.
 * Evidence limits required minimums. The original upper allowance leaves room for grammatical
 * paraphrase and attribution; it is optional space, never an additional fact or padding target. */
export function allocateEvidenceWords(topics: readonly EvidenceAllocationTopic[], requested: EvidenceAllocationRange): EvidenceAllocation {
  if (topics.length < 1 || topics.length > 8 || topics.some(topic => !topic || typeof topic.topicId !== 'string' || !topic.topicId.trim() || topic.topicId.length > 160) || new Set(topics.map(topic => topic.topicId)).size !== topics.length) throw new Error('Evidence allocation needs1–8 distinct code-owned topics');
  if (!requested || !Number.isSafeInteger(requested.min) || !Number.isSafeInteger(requested.max) || requested.min < topics.length || requested.max < requested.min || requested.max > 1300) throw new Error('Evidence allocation needs the unchanged finite word range covering every topic, at most1300 words');
  if (topics.some(topic => !Object.hasOwn(weights, topic.weight) || !Number.isSafeInteger(topic.availableWords) || topic.availableWords < 0)) throw new Error('Evidence allocation needs valid weights and nonnegative integer verified word counts');
  const availableWords = sum(topics.map(topic => topic.availableWords));
  if (!Number.isSafeInteger(availableWords)) throw new Error('Evidence word count exceeds a safe integer');
  const shares = topics.map(topic => weights[topic.weight]), missingTopicIds = topics.filter(topic => !topic.availableWords).map(topic => topic.topicId);
  if (availableWords < requested.min || missingTopicIds.length) {
    const minimumAdditionalWords = Math.max(requested.min - availableWords, missingTopicIds.length);
    const extras = fill(minimumAdditionalWords - missingTopicIds.length, topics.map(() => minimumAdditionalWords), shares, 0);
    return { status: 'needs-evidence', requested: { ...requested }, availableWords, minimumAdditionalWords, missingTopicIds,
      additionalWords: topics.map((topic, i) => ({ topicId: topic.topicId, words: extras[i]! + Number(topic.availableWords === 0) })) };
  }
  const caps = topics.map(topic => Math.min(requested.max, topic.availableWords));
  const minimums = fill(requested.min, caps, shares);
  const maximum = requested.max;
  // Allocate remaining headroom on top of the approved minima: independently rounding max
  // can otherwise move a word away from a topic when total size increases (Alabama paradox).
  const extra = fill(maximum - requested.min, topics.map(() => maximum - requested.min), minimums, 0);
  const unconstrainedMin = fill(requested.min, topics.map(() => requested.max), shares);
  const unconstrainedExtra = fill(requested.max - requested.min, topics.map(() => requested.max), shares, 0);
  const rows = topics.map((topic, i) => ({ ...topic, target: { min: minimums[i]!, max: minimums[i]! + extra[i]! } }));
  return { status: 'ready', requested: { ...requested }, availableWords, allocated: { min: requested.min, max: maximum }, topics: rows,
    changed: rows.some((row, i) => row.target.min !== unconstrainedMin[i] || row.target.max !== unconstrainedMin[i]! + unconstrainedExtra[i]!) };
}
