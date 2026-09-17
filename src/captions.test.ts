import { test } from "node:test";
import assert from "node:assert/strict";
import { captionGroup } from "./captions.js";

test('sentence-initial It stays with its own sentence, including quoted endings', () => {
  for (const ending of ['atrophy.', 'atrophy.”', 'atrophy.)']) {
    const words = `muscle loss in spinal muscular ${ending} It is approved for adults.`.split(' ').map((w, i) => ({ w, start: i, end: i + 0.5 }));
    assert.deepEqual(captionGroup(words, 5).words.map(w => w.w), ['muscular', ending]);
    assert.deepEqual(captionGroup(words, 6).words.map(w => w.w), ['It', 'is', 'approved', 'for']);
    assert.deepEqual(captionGroup(words, 10).words.map(w => w.w), ['adults.']);
  }
});
