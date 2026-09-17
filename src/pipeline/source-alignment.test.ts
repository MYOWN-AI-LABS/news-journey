import assert from 'node:assert/strict';
import test from 'node:test';
import { alignSourceSentences } from './source-alignment.js';

test('alignment preserves separate sentence/claim IDs and trims only boundaries', () => {
  const sentences = [{ id: 11, text: '  Games begin at 9 a.m. on Court A.\n' }, { id: 12, text: 'Venues remain provisional.' }];
  const claims = [{ id: 7, text: '\nGames begin at 9 a.m. on Court A. ' }, { id: 2, text: 'Venues remain provisional.' }];
  const before = JSON.stringify({ sentences, claims });
  assert.deepEqual(alignSourceSentences(sentences, claims), [{ sentenceId: 11, exactClaimIds: [7] }, { sentenceId: 12, exactClaimIds: [2] }]);
  assert.equal(JSON.stringify({ sentences, claims }), before);
});

test('an exact fact with a qualifier elsewhere is only a lookup hint, including under negating context', () => {
  const claims = [{ id: 1, text: 'The route took 12 seconds.' }, { id: 2, text: 'This result came from a simulation, not a road test.' }];
  const paragraph = [{ id: 1, text: 'The report was false.' }, { id: 2, text: 'The route took 12 seconds.' }, { id: 3, text: 'Drivers can therefore expect faster journeys.' }];
  const aligned = alignSourceSentences(paragraph, claims);
  assert.deepEqual(aligned, [{ sentenceId: 1, exactClaimIds: [] }, { sentenceId: 2, exactClaimIds: [1] }, { sentenceId: 3, exactClaimIds: [] }]);
  assert.ok(aligned.every(row => Object.keys(row).sort().join(',') === 'exactClaimIds,sentenceId'));
  // The matching row cannot approve this paragraph or claim that the omitted simulation
  // qualifier is preserved. Those decisions deliberately do not exist in this API.
});

test('substrings, fragments, concatenations and authored connective text never match', () => {
  const claims = [{ id: 1, text: 'The course is 10 kilometres, subject to final approval.' }, { id: 2, text: 'Registration opens Monday.' }, { id: 3, text: 'The race starts Sunday.' }, { id: 4, text: 'At the finish line' }, { id: 5, text: 'Registration opens Monday. The race starts Sunday.' }];
  assert.deepEqual(alignSourceSentences([
    { id: 1, text: 'The course is 10 kilometres.' },
    { id: 2, text: 'At the finish line' },
    { id: 3, text: 'Registration opens Monday. The race starts Sunday.' },
    { id: 4, text: 'Therefore, registration opens Monday.' },
  ], claims).map(row => row.exactClaimIds), [[], [], [], []]);
});

test('case, numeric, punctuation, Unicode and internal whitespace changes are not normalized', () => {
  const claim = { id: 1, text: 'The café reported 12 entries.' };
  const variants = ['the café reported 12 entries.', 'The café reported 13 entries.', 'The café reported 12 entries!', 'The cafe\u0301 reported 12 entries.', 'The café  reported 12 entries.'];
  assert.deepEqual(alignSourceSentences(variants.map((text, i) => ({ id: i + 1, text })), [claim]).map(row => row.exactClaimIds), variants.map(() => []));
});

test('duplicate claim text retains every distinct source ID; duplicate IDs are rejected', () => {
  const text = 'The results remain provisional.';
  assert.deepEqual(alignSourceSentences([{ id: 1, text }], [{ id: 3, text }, { id: 8, text }]), [{ sentenceId: 1, exactClaimIds: [3, 8] }]);
  assert.throws(() => alignSourceSentences([{ id: 1, text }], [{ id: 3, text }, { id: 3, text }]), /claim IDs must be unique/);
  assert.throws(() => alignSourceSentences([{ id: 1, text }, { id: 1, text }], [{ id: 3, text }]), /sentence IDs must be unique/);
  assert.throws(() => alignSourceSentences([{ id: 0, text }], [{ id: 3, text }]), /sentence IDs must be unique positive/);
});

test('the lookup bounds its full input and never silently clips records', () => {
  const row = { id: 1, text: 'A complete source sentence.' };
  assert.throws(() => alignSourceSentences(Array.from({ length: 33 }, (_, i) => ({ ...row, id: i + 1 })), [row]), /1–32 sentence/);
  assert.throws(() => alignSourceSentences([row], Array.from({ length: 25 }, (_, i) => ({ ...row, id: i + 1 }))), /1–24 claim/);
  assert.throws(() => alignSourceSentences([row], [{ ...row, text: 'x'.repeat(6501) }]), /bounded/);
});
