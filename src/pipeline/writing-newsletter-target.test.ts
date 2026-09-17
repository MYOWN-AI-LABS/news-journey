import test from 'node:test';
import assert from 'node:assert/strict';
import { writingNewsletterTarget } from './writing-context.js';

test('the default newsletter band scales with the selected story count; an explicit length is honoured as chosen', () => {
  const video = { min: 200, max: 225 };
  assert.deepEqual(writingNewsletterTarget('edition', 3, video), { min: 900, max: 1300 });
  assert.deepEqual(writingNewsletterTarget('edition', 1, video), { min: 300, max: 433 });
  assert.deepEqual(writingNewsletterTarget('edition', 4, video), { min: 1200, max: 1733 });
  assert.deepEqual(writingNewsletterTarget('edition', 1, video, [250, 400]), { min: 250, max: 400 });
  assert.deepEqual(writingNewsletterTarget('video', 1, video, undefined, 12), { min: 188, max: 213 });
});
