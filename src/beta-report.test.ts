import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
// @ts-expect-error plain ESM script, no declaration file
import { redact } from "../ops/redact.mjs";

/** A tester's report goes to a shared branch: it must never carry a home path, a token-shaped string or an id. */
test("beta report redaction removes home paths, hex tokens, uuids and key-shaped values", () => {
  const home = homedir();
  const text = `Error at ${home}/Documents/x — token=abc123def secret: hunter2 sk-ABCDEFGHIJKLMNOP ` +
    "c6649a61c00f1e532e6c8985d0bcb45bb2f0a3a89be3817755b34222ecedc46b af3cbc18-a188-4f11-8c38-16a4ce40f721 C:\\Users\\ExampleTester\\harness";
  const out = redact(text);
  assert.doesNotMatch(out, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(out, /~\/Documents\/x/);
  assert.doesNotMatch(out, /abc123def|hunter2|ABCDEFGHIJKLMNOP|c6649a61|af3cbc18|ExampleTester/);
  assert.match(out, /\[hex64\]/); assert.match(out, /\[uuid\]/); assert.match(out, /token=\[redacted\]/);
});
