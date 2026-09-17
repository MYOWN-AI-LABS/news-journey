import test from 'node:test';
import assert from 'node:assert/strict';
import { journeyReviewPortEnabled } from './writing-context.js';

test('the ported Daily Signal editorial/visual stack is off for "script" and on otherwise', () => {
  assert.equal(journeyReviewPortEnabled({ journeyReview: 'script' }), false);
  assert.equal(journeyReviewPortEnabled({ journeyReview: 'daily-signal-port' }), true);
  assert.equal(journeyReviewPortEnabled({}), true);
});
