import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateEvidenceWords, countEvidenceWords, type EvidenceAllocationTopic, type EvidenceAllocationRange } from './evidence-allocation.js';

const topics = (counts: number[], kinds: EvidenceAllocationTopic['weight'][] = ['lead', 'standard', 'quick', 'quick']): EvidenceAllocationTopic[] => counts.map((availableWords, i) => ({ topicId: `topic-${i + 1}`, weight: kinds[i] ?? 'quick', availableWords }));
function ready(rows: EvidenceAllocationTopic[], range: EvidenceAllocationRange = { min: 900, max: 1300 }) {
  const result = allocateEvidenceWords(rows, range); assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('Expected ready allocation');
  assert.deepEqual(result.requested, range);
  assert.deepEqual(result.topics.map(row => row.topicId), rows.map(row => row.topicId));
  assert.equal(result.topics.reduce((sum, row) => sum + row.target.min, 0), range.min);
  assert.equal(result.topics.reduce((sum, row) => sum + row.target.max, 0), result.allocated.max);
  assert.equal(result.allocated.max, range.max);
  for (const row of result.topics) { assert.ok(row.target.min >= 1); assert.ok(row.target.max >= row.target.min); assert.ok(row.target.min <= row.availableWords); }
  return result;
}

test('actual Quasar evidence redistributes the sparse standard share without changing Deep or topic order', () => {
  const rows = topics([443, 193, 190, 321]), before = structuredClone(rows);
  const result = ready(rows);
  assert.deepEqual(result.topics.map(row => row.target.min), [403, 193, 152, 152]);
  assert.ok(result.topics.every(row => row.target.max > row.target.min));
  assert.equal(result.availableWords, 1147); assert.equal(result.allocated.max, 1300);
  assert.equal(result.changed, true);
  assert.deepEqual(rows, before); assert.deepEqual(allocateEvidenceWords(rows, result.requested), result);
});

test('original rich fictional sports evidence retains all three topics at unchanged900-word minimum', () => {
  const result = ready(topics([414, 314, 319], ['lead', 'standard', 'standard']));
  assert.deepEqual(result.topics.map(row => row.target.min), [400, 250, 250]);
  assert.deepEqual(result.topics.map(row => row.target.max), [578, 361, 361]);
  assert.equal(result.allocated.max, 1300);
});

test('a small lead never blocks an otherwise feasible total or discards another topic facts', () => {
  const result = ready(topics([100, 450, 450], ['lead', 'standard', 'quick']));
  assert.equal(result.topics[0]!.target.min, 100);
  assert.equal(result.allocated.max, 1300);
  assert.equal(result.topics[2]!.target.min, 350);
  const small = ready(topics([23, 31], ['lead', 'standard']), { min: 40, max: 60 });
  assert.deepEqual(small.topics.map(row => row.target), [{ min: 23, max: 35 }, { min: 17, max: 25 }]);
});

test('one empty topic cannot borrow another topic facts even with ample overall capacity', () => {
  const result = allocateEvidenceWords(topics([900, 0, 600]), { min: 900, max: 1300 });
  assert.equal(result.status, 'needs-evidence');
  if (result.status !== 'needs-evidence') throw new Error('Empty topic must require its own evidence');
  assert.equal(result.minimumAdditionalWords, 1); assert.deepEqual(result.missingTopicIds, ['topic-2']);
  assert.deepEqual(result.additionalWords, [{ topicId: 'topic-1', words: 0 }, { topicId: 'topic-2', words: 1 }, { topicId: 'topic-3', words: 0 }]);
  assert.ok(!('topics' in result));
});

test('insufficient source capacity returns the exact deficit and no approved writing range', () => {
  const result = allocateEvidenceWords(topics([443, 193, 100, 100]), { min: 900, max: 1300 });
  assert.equal(result.status, 'needs-evidence');
  if (result.status !== 'needs-evidence') throw new Error('Expected more evidence');
  assert.equal(result.availableWords, 836); assert.equal(result.minimumAdditionalWords, 64);
  assert.equal(result.additionalWords.reduce((sum, row) => sum + row.words, 0), 64);
  assert.deepEqual(result.requested, { min: 900, max: 1300 });
});

test('sparse and empty topics have one shared exact enrichment deficit, not rigid per-topic inflation', () => {
  const result = allocateEvidenceWords(topics([0, 5, 0]), { min: 100, max: 110 });
  assert.equal(result.status, 'needs-evidence');
  if (result.status !== 'needs-evidence') throw new Error('Expected more evidence');
  assert.equal(result.minimumAdditionalWords, 95);
  assert.equal(result.additionalWords.reduce((sum, row) => sum + row.words, 0), 95);
  assert.ok(result.additionalWords[0]!.words >= 1 && result.additionalWords[2]!.words >= 1);
});

test('caller-deduplicated source credit is conserved; equal independent counts are not deduplicated again', () => {
  const repeatedSource = topics([500, 0, 500]); // Caller assigned repeated source text to first topic only.
  assert.equal(allocateEvidenceWords(repeatedSource, { min: 900, max: 1300 }).status, 'needs-evidence');
  const independent = ready(topics([400, 400, 400], ['standard', 'standard', 'standard']));
  assert.equal(independent.availableWords, 1200);
  const duplicateId = topics([500, 500, 500]); duplicateId[1]!.topicId = duplicateId[0]!.topicId;
  assert.throws(() => allocateEvidenceWords(duplicateId, { min: 900, max: 1300 }), /distinct/);
});

test('shared evidence counting credits canonical syndicated units only at their first occurrence', () => {
  const groups = [
    ['The league announced four provisional games.', 'The league announced four provisional games.', 'Ａ new venue remains provisional.'],
    ['  THE LEAGUE\nANNOUNCED four provisional games. ', 'A new venue remains provisional.', 'The cup rules remain unchanged.'],
    ['The cup rules remain unchanged.', '  ', 'Games begin at noon.'],
  ];
  const original = structuredClone(groups);
  assert.deepEqual(countEvidenceWords(groups), [11, 5, 4]);
  assert.deepEqual(groups, original);
  const syndicated = countEvidenceWords([['A source fact.'], ['A SOURCE FACT.'], ['A separate fact.']]);
  assert.deepEqual(syndicated, [3, 0, 3]);
  const result = allocateEvidenceWords(topics(syndicated), { min: 6, max: 8 });
  assert.equal(result.status, 'needs-evidence');
  if (result.status === 'needs-evidence') assert.deepEqual(result.missingTopicIds, ['topic-2']);
});

test('shared evidence counter keeps original word counts and does not infer paraphrase identity', () => {
  assert.deepEqual(countEvidenceWords([['The plan is provisional.'], ['The provisional plan is announced.'], []]), [4, 5, 0]);
  assert.throws(() => countEvidenceWords([['fact'], [null]] as unknown as string[][]), /source strings/);
  assert.throws(() => countEvidenceWords([]), /source strings/);
});

test('ample evidence preserves weighted minima and bounds the original global maximum', () => {
  const result = ready(topics([2000, 2000, 2000, 2000]));
  assert.equal(result.allocated.max, 1300);
  assert.deepEqual(result.topics.map(row => row.target), [{ min: 378, max: 546 }, { min: 237, max: 342 }, { min: 143, max: 207 }, { min: 142, max: 205 }]);
});

test('actual V9 evidence keeps its900-word minimum but leaves room for attribution and reported prose', () => {
  const result = ready(topics([343, 194, 85, 317]));
  assert.deepEqual(result.topics.map(row => row.target), [
    { min: 343, max: 495 }, { min: 194, max: 280 }, { min: 85, max: 123 }, { min: 278, max: 402 },
  ]);
  assert.equal(result.availableWords, 939);
  assert.deepEqual(result.allocated, { min: 900, max: 1300 });
  assert.equal(allocateEvidenceWords(topics([343, 194, 85, 277]), { min: 900, max: 1300 }).status, 'needs-evidence', 'upper room cannot authorize sparse source material');
});

test('exact fixed total, single topic and one-word presence boundaries stay feasible', () => {
  const fixed = ready(topics([443, 193, 190, 321]), { min: 900, max: 900 });
  assert.ok(fixed.topics.every(row => row.target.min === row.target.max));
  assert.deepEqual(ready(topics([1500]), { min: 900, max: 1300 }).topics[0]!.target, { min: 900, max: 1300 });
  const tiny = ready(topics([1, 100, 1]), { min: 3, max: 3 });
  assert.deepEqual(tiny.topics.map(row => row.target), [{ min: 1, max: 1 }, { min: 1, max: 1 }, { min: 1, max: 1 }]);
});

test('invalid counts, weights, topic identity and global ranges fail before allocation', () => {
  for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => allocateEvidenceWords(topics([value, 300, 300]), { min: 900, max: 1300 }), /integer/);
  assert.throws(() => allocateEvidenceWords(topics([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]), { min: 900, max: 1300 }), /safe integer/);
  assert.throws(() => allocateEvidenceWords([], { min: 900, max: 1300 }), /distinct/);
  assert.throws(() => allocateEvidenceWords(topics(Array(9).fill(200)), { min: 900, max: 1300 }), /distinct/);
  assert.throws(() => allocateEvidenceWords([{ topicId: 'x', weight: 'made-up', availableWords: 900 }] as unknown as EvidenceAllocationTopic[], { min: 900, max: 1300 }), /weights/);
  for (const range of [{ min: 2, max: 1000 }, { min: 901, max: 900 }, { min: 900, max: 1301 }, { min: 900.5, max: 1300 }]) assert.throws(() => allocateEvidenceWords(topics([400, 400, 400]), range), /unchanged finite/);
});

test('deterministic varied capacity cases conserve all words and never let weights cause false failure', () => {
  let state = 907;
  const next = () => (state = (state * 48271) % 2147483647);
  for (let trial = 0; trial < 300; trial++) {
    const length = 1 + next() % 8, counts = Array.from({ length }, () => 1 + next() % 650);
    const available = counts.reduce((sum, n) => sum + n, 0), min = Math.min(900, available), max = Math.min(1300, min + next() % 401);
    const rows = topics(counts, Array.from({ length }, () => (['lead', 'standard', 'quick'] as const)[next() % 3]!));
    const result = ready(rows, { min, max });
    assert.deepEqual(allocateEvidenceWords(rows, { min, max }), result);
  }
});
