import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTopicCoverage, coverage, type CoverageAudit } from './coverage.js';
import { jsonOutputContract } from '../llm/json-output-contract.js';
import type { HarvestItem } from '../types.js';
const items = ['Formula One race result', 'Leeds win four one', 'Tennis final champion'].map((title, i) => ({ id: String(i), title, summary: title + ' reported today.', url: `https://example.org/${i}`, source: 'rss:example.org', publishedAt: null, score: 0, repo: null } as HarvestItem));
test('broad topic coverage accepts owned relevant headlines without requiring the topic label', async () => {
  assert.equal(coverage(items, ['Sports']).matching, 0);
  let calls = 0;
  const result = await assessTopicCoverage(items, ['Sports'], 'Three current sports stories', async <T>(_prompt: string, validate: (value: T) => string | null) => {
    calls++;
    const output = { matches: items.map((item, i) => ({ itemId: `item-${i + 1}`, excerptId: `item-${i + 1}-title-1`, reason: 'This reports a sports competition.' })) } as T;
    assert.equal(validate(output), null);
    return output;
  });
  assert.equal(calls, 1); assert.equal(result.coverage.matching, 3);
});
test('topic selection rejects invented IDs, borrowed excerpts, and repeated items', async () => {
  await assessTopicCoverage(items, ['Current affairs'], 'Current affairs', async <T>(_prompt: string, validate: (value: T) => string | null) => {
    for (const output of [
      { matches: [{ itemId: 'item-9', excerptId: 'item-1-title-1', reason: 'Unknown' }] },
      { matches: [{ itemId: 'item-1', excerptId: 'item-2-title-1', reason: 'Wrong article' }] },
      { matches: Array(2).fill({ itemId: 'item-1', excerptId: 'item-1-title-1', reason: 'Duplicated' }) },
    ]) assert.ok(validate(output as T));
    return { matches: [] } as T;
  }).then(result => assert.equal(result.coverage.matching, 0));
});
test('repeated URLs cannot manufacture three relevant stories', async () => {
  const result = await assessTopicCoverage([items[0]!, items[0]!, items[0]!], ['Sports'], 'Sports', async <T>(_prompt: string, validate: (value: T) => string | null) => {
    const output = { matches: [{ itemId: 'item-1', excerptId: 'item-1-title-1', reason: 'Sports result' }] };
    assert.equal(validate(output as T), null); return output as T;
  });
  assert.equal(result.coverage.matching, 1);
});


test('source coverage sends exact ID schema and preserves Unicode source evidence without model quotation', async () => {
  const changed = structuredClone(items);
  changed[0]!.title = 'Club’s “provisional” win — confirmation pending';
  const audits: CoverageAudit[] = [];
  const result = await assessTopicCoverage(changed, ['Sports'], 'Sports coverage', async <T>(prompt: string, validate: (value: T) => string | null) => {
    const contract = jsonOutputContract(validate); assert.ok(contract);
    assert.deepEqual(contract.schema.properties!.matches!.items!.required, ['itemId', 'excerptId', 'reason']);
    assert.deepEqual(contract.schema.properties!.matches!.items!.properties!.itemId!.enum, ['item-1', 'item-2', 'item-3']);
    assert.match(prompt, /Do not rewrite excerpts/);
    const value = { matches: [{ itemId: 'item-1', excerptId: 'item-1-title-1', reason: 'A sports result with an explicit qualification.' }] } as T;
    assert.equal(validate(value), null); return value;
  }, attempt => audits.push(attempt));
  assert.equal(result.assessments[0]!.excerpt, changed[0]!.title);
  assert.equal(audits.length, 1); assert.equal(audits[0]!.problem, null);
});

test('invalid source selection records exact failed response and returns actionable bounded repair feedback', async () => {
  const audits: CoverageAudit[] = [];
  await assessTopicCoverage(items, ['Sports'], 'Sports', async <T>(_prompt: string, validate: (value: T) => string | null) => {
    const wrong = { matches: [{ itemId: 'item-1', excerptId: 'item-2-title-1', reason: 'Sports result' }] } as T;
    assert.match(validate(wrong)!, /excerptId must belong to item-1/);
    assert.deepEqual(audits[0]!.response, wrong);
    assert.equal(audits[0]!.articles[0]!.title, items[0]!.title);
    assert.match(validate({ matches: [{ itemId: 'item-1', excerptId: 'item-1-title-1', reason: 'x'.repeat(501) }] } as T)!, /1–500/);
    assert.match(validate({ matches: [{ itemId: 'item-1', excerpt: 'paraphrased result', reason: 'Sports' }] } as T)!, /rather than writing quotes/);
    const value = { matches: [] } as T; assert.equal(validate(value), null); return value;
  }, attempt => audits.push(attempt));
  assert.equal(audits.length, 4);
});
