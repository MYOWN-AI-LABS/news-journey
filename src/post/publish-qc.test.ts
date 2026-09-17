import assert from "node:assert/strict";
import test from "node:test";
import { decodeCompleted } from "./publish-qc.js";

test("media decode passes only on a clean zero exit", () => {
  assert.equal(decodeCompleted(0, ""), true);
  assert.equal(decodeCompleted(1, "decode error"), false);
  assert.equal(decodeCompleted(0, "corrupt frame"), false);
  assert.equal(decodeCompleted(null, ""), false);
});


test('Node/npm wrapper notices do not turn a clean decode into a corrupt-video finding', () => {
 assert.equal(decodeCompleted(0, '(node:51278) Warning: NO_COLOR is ignored\nnpm notice update available'), true);
 assert.equal(decodeCompleted(0, '(node:51278) Warning: NO_COLOR is ignored\nInvalid data found when processing input'), false);
});
