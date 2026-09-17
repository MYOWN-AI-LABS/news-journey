import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewEvidenceSelection, type ReviewSourceSentence } from './evidence-selection-review.js';
import { newsletterEvidenceSentences, selectNewsletterEvidence, validateNewsletterEvidencePacket, type NewsletterCapture } from './newsletter-evidence.js';
import { countEvidenceWords } from './evidence-allocation.js';
import { beginParentWork, parentModelHooks, roleHash } from '../llm/role-router.js';

// Fictional source. Methods/results and their limits appear AFTER a short headline summary,
// mirroring the coverage gap without copying a real article or promising reviewer accuracy.
const topic = { id: 'estuary-study', headline: 'Estuary Research Lab publishes a flood forecasting benchmark study' };
const sourceText = [
  'Home News Share The fictional Estuary Research Lab announces its latest study.',
  'Estuary Research Lab published a benchmark study of a flood forecasting model.',
  'The model combines satellite rainfall measurements with river gauge records to predict water levels at the next observation interval.',
  'The study evaluated eighty four river basins using eighteen hundred historical flood events, with separate basins held out for testing.',
  'On the held out basins, the model recorded a twenty six percent lower median absolute error than the named seasonal baseline.',
  'That comparison used archived observations and does not establish performance in a prospective warning service.',
  'The authors did not report an operational deployment or an independently conducted replication of the benchmark.',
  'All benchmark basins were in temperate regions, and the study did not evaluate tropical catchments or unmonitored rivers.',
  'Training used records ending before the test period, and no observations from the held out basins were used to fit the model.',
  'A public demonstration asks visitors to enter a river name and click the sample forecast button.',
  'Subscribe to the laboratory mailing list for product announcements and partnership opportunities.',
].join(' ');
const sentences = newsletterEvidenceSentences(sourceText);
const initial = { selectedIds: [1, 2], requiredIds: [], unsupportedCandidate: [] };
const finalSelection = { selectedIds: [2, 3, 4, 5], requiredIds: [6, 7, 8, 9], unsupportedCandidate: [] };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const capture: NewsletterCapture = { url: 'https://fixtures.example.com/estuary-study', role: 'primary', status: 200, text: sourceText, sha256: sha(sourceText), textSha256: sha(sourceText), observedAt: '2026-09-14T12:00:00Z', bytes: Buffer.byteLength(sourceText) };
type Judge = Parameters<typeof reviewEvidenceSelection>[3];

function checked(value: unknown): Judge {
  return async <T>(_prompt: string, validate: (value: T) => string | null) => { assert.equal(validate(value as T), null); return value as T; };
}

test('the second source review recovers omitted method/results and their conditions using the existing parent and exact source bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-coverage-review-'));
  const parent = { root, parentId: 'same-source-review', parentIdentity: roleHash({ topic, capture }), limits: { maxPhysicalCalls: 2, maxToolCalls: 0, totalSeconds: 60 }, now: () => 1000 };
  const originalParent = beginParentWork(parent); let calls = 0;
  try {
    const packet = await selectNewsletterEvidence(topic, capture, async <T>(prompt: string, validate: (value: T) => string | null) => {
      calls++; parentModelHooks(parent, 'select-and-review').beforeAttempt!({ provider: 'ollama', model: 'fictional-reviewer:4b', rescue: false, attempt: 1, promptBytes: Buffer.byteLength(prompt) });
      assert.doesNotMatch(prompt, /EVIDENCE_FLOOR|900[–-]1300/);
      const supplied = JSON.parse(prompt.match(/^SOURCE_SENTENCES: (.*)$/m)![1]!);
      assert.deepEqual(supplied, sentences.map(({ id, text }) => ({ id, text })));
      const value = calls === 1 ? initial : finalSelection;
      if (calls === 2) { assert.match(prompt, /NO word minimum/); assert.match(prompt, /method|results/i); }
      assert.equal(validate(value as T), null); return value as T;
    }, { minimumWords: 900 });
    assert.equal(calls, 2, 'One selector and one reviewer; coverage does not start an unbounded repair loop');
    assert.equal(beginParentWork(parent).deadline, originalParent.deadline);
    assert.equal(beginParentWork(parent).physicalAttempts, 2);
    assert.equal(beginParentWork(parent).toolAttempts, 0);
    validateNewsletterEvidencePacket(packet);
    assert.deepEqual(packet.selectionReview.keepIds, [2]);
    assert.deepEqual(packet.selectionReview.addIds, [3, 4, 5]);
    assert.deepEqual(packet.selectionReview.dropIds, [1]);
    assert.deepEqual(packet.selectionReview.requiredIds, [6, 7, 8, 9]);
    assert.deepEqual(packet.units.flatMap(unit => unit.sourceSentenceIds), [2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(packet.units.map(unit => unit.text), sentences.slice(1, 9).map(sentence => sentence.text));
    assert.ok(packet.units.every(unit => unit.sourceUrl === capture.url && unit.sourceSha256 === capture.sha256 && unit.requires.length === packet.units.length - 1));
    assert.ok(countEvidenceWords([packet.units.map(unit => unit.text)])[0]! < 900, 'A source-word shortfall does not authorize invented evidence');
    assert.equal(packet.supportIsFallible, true); assert.equal(packet.selectionReview.dependencyCompletenessIsFallible, true);
    assert.throws(() => parentModelHooks(parent, 'extra-review').beforeAttempt!({ provider: 'ollama', model: 'fictional-reviewer:4b', rescue: false, attempt: 1, promptBytes: 10 }), /physical attempt allowance/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('code derives omitted initial IDs as dropped and records new topical source IDs without four model-managed lists', async () => {
  const result = await reviewEvidenceSelection(topic, sentences, initial, checked(finalSelection));
  assert.deepEqual(result.selectedIds, [2, 3, 4, 5]);
  assert.deepEqual(result.review.initialIds, [1, 2]);
  assert.deepEqual(result.review.keepIds, [2]); assert.deepEqual(result.review.addIds, [3, 4, 5]); assert.deepEqual(result.review.dropIds, [1]);
  assert.deepEqual([...result.review.keepIds, ...result.review.dropIds].sort((a, b) => a - b), [1, 2]);
});

test('new topical coverage cannot introduce unknown IDs, overlap context or promote an initial dependency', async () => {
  for (const value of [
    { ...finalSelection, selectedIds: [2, 3, 999] },
    { ...finalSelection, selectedIds: [2, 3, 3] },
    { ...finalSelection, requiredIds: [3, 6, 7, 8, 9] },
    { ...finalSelection, replacement: 'The model now prevents all floods.' },
    { ...finalSelection, sourceUrl: 'https://another.example.com/unread' },
  ]) {
    let calls = 0;
    await assert.rejects(reviewEvidenceSelection(topic, sentences, initial, async <T>() => { calls++; return value as T; }), /Source evidence review rejected/);
    assert.equal(calls, 1);
  }
  await assert.rejects(reviewEvidenceSelection(topic, sentences, { selectedIds: [2], requiredIds: [8], unsupportedCandidate: [] }, async <T>() => ({ selectedIds: [2, 8], requiredIds: [], unsupportedCandidate: [] }) as T), /required|dependency|context/);
});

test('source recovery cannot exceed24 complete sentences or add a fragment as a fact', async () => {
  const many: ReviewSourceSentence[] = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, text: `The fictional study reports complete observation number ${i + 1} under the stated test conditions.` }));
  const first = { selectedIds: [1], requiredIds: [], unsupportedCandidate: [] };
  await assert.rejects(reviewEvidenceSelection(topic, many, first, async <T>() => ({ selectedIds: many.slice(0, 24).map(row => row.id), requiredIds: [25], unsupportedCandidate: [] }) as T), /24 complete|24 source|at most24/);
  const fragment = [...sentences, { id: 12, text: 'An incomplete later result without its final qualification' }];
  await assert.rejects(reviewEvidenceSelection(topic, fragment, initial, async <T>() => ({ selectedIds: [2, 12], requiredIds: [], unsupportedCandidate: [] }) as T), /complete plain|complete source/);
});

test('added method facts cannot clear an existing unsupported headline or give rejected evidence positive capacity', async () => {
  const unsupportedCandidate = ['The headline claims a live warning service; this source reports only an archived benchmark.'];
  await assert.rejects(reviewEvidenceSelection(topic, sentences, { ...initial, unsupportedCandidate }, async <T>() => finalSelection as T), /silently clear/);
  await assert.rejects(reviewEvidenceSelection(topic, sentences, initial, async <T>() => ({ ...finalSelection, unsupportedCandidate }) as T), /no positive evidence/);
});
