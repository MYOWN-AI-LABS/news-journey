import assert from "node:assert/strict";
import test from "node:test";
import { assertDryRunTopicFile, isDryRun, shouldStopAfterSelection } from "./dry-run.js";

test("dry-run is fail-closed unless explicitly enabled", () => {
  assert.equal(isDryRun({}), false);
  assert.equal(isDryRun({ AI_CONTENT_DRY_RUN: "1" }), true);
  assert.equal(isDryRun({ AI_CONTENT_DRY_RUN: "true" }), true);
  assert.equal(isDryRun({ AI_CONTENT_DRY_RUN: "0" }), false);
});

test("dry-run requires a local topic and stops before generative stages", () => {
  const env = { AI_CONTENT_DRY_RUN: "1" };
  assert.throws(() => assertDryRunTopicFile(undefined, env), /requires --topic-file/);
  assert.doesNotThrow(() => assertDryRunTopicFile("examples/fixtures/example-topic.json", env));
  assert.equal(shouldStopAfterSelection(env), true);
  assert.equal(shouldStopAfterSelection({}), false);
});
