import assert from "node:assert/strict";
import test from "node:test";
import { ClaimVerificationError, captureForClaims, claimPinningPrompt, pinVerifiedClaims, validatePinnedClaims, type ClaimCapture } from "./pin-claims.js";
import { verifyCandidates } from "./verify-at-selection.js";
import { createHash } from "node:crypto";
import https from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

const story = { headline: "Example Labs Revises Its Safety Rules", summary: "Example Labs asked regulators for stronger safeguards.", principalEntity: "Example Labs" };
const cap = (text: string, role: ClaimCapture["role"] = "primary"): ClaimCapture =>
  ({ url: "https://news.example.com/story", role, status: 200, sha256: "abc", observedAt: "2026-01-01T00:00:00Z", text });

test("a story whose sources support nothing concrete is DROPPED", async () => {
  const d = await pinVerifiedClaims(story, [cap("The outlet reported something unrelated.")], async () => ({ claims: [], unsupported: ["Example Labs asked for stronger safeguards"] }));
  assert.equal(d.keep, false);
  assert.match(d.why, /support no concrete claim/);
});

test("supported claims are pinned verbatim and the story is kept", async () => {
  const d = await pinVerifiedClaims(story, [cap("Example Labs told regulators the draft rules do not go far enough, the outlet reported on 1 January.")],
    async () => ({ claims: ["Example Labs told regulators that the draft rules do not go far enough.", "The outlet reported the request on 1 January."], unsupported: [] }));
  assert.equal(d.keep, true);
  assert.equal(d.claims.length, 2);
  assert.equal(d.evidence[0]!.sha256, "abc");
});

test('supported body claims cannot excuse an unsupported candidate headline or summary', async () => {
  const candidate = { headline: 'Lab proves physical-hardware breakthrough', summary: 'A deployed accelerator improves real devices.' };
  const decision = await pinVerifiedClaims(candidate, [cap('The lab reported a simulation only. No physical hardware was measured.')], async () => ({
    claims: ['The lab reported a simulation only.', 'No physical hardware was measured.'],
    unsupported: ['The candidate claims a physical-hardware breakthrough and deployed benefits.'],
  }));
  assert.equal(decision.keep, false);
  assert.equal(decision.claims.length, 2, 'retain the diagnostic evidence without keeping the unsafe candidate');
  assert.match(decision.why, /candidate headline or summary.*unsupported/);
});

test("judge outage stops selection and retains the original failure and source receipt", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => logs.push(line));
  const cause = new Error("transport unavailable");
  const capture = cap("Captured source text must not be logged.");
  await assert.rejects(pinVerifiedClaims(story, [capture], async () => { throw cause; }), (error: unknown) => {
    assert.ok(error instanceof ClaimVerificationError);
    assert.equal(error.cause, cause);
    assert.match(error.message, /transport unavailable.*Retry story selection/);
    assert.deepEqual(error.receipt, {
      status: "failed", retryable: true, failure: "judge-unavailable", headline: story.headline, reason: cause.message,
      evidence: [{ url: capture.url, role: capture.role, status: capture.status, sha256: capture.sha256, observedAt: capture.observedAt }],
    });
    const receiptLog = logs.find(line => line.includes("pin-claims: "))!;
    assert.deepEqual(JSON.parse(receiptLog.slice(receiptLog.indexOf("pin-claims: ") + "pin-claims: ".length)), error.receipt);
    assert.doesNotMatch(receiptLog, /Captured source text/);
    return true;
  });
});

test("no capturable text at all is a drop, not a judge call", async () => {
  let called = false;
  const d = await pinVerifiedClaims(story, [cap("")], async () => { called = true; return { claims: ["x".repeat(20)], unsupported: [] }; });
  assert.equal(called, false);
  assert.equal(d.keep, false);
});

test("malformed verdicts stop selection with their validator reason and evidence", async () => {
  assert.match(validatePinnedClaims({ claims: "nope" })!, /must be/);
  assert.match(validatePinnedClaims({ claims: ["too short"], unsupported: [] })!, /non-trivial/);
  assert.equal(validatePinnedClaims({ claims: ["Example Labs told regulators the draft is too weak."], unsupported: [] }), null);
  await assert.rejects(pinVerifiedClaims(story, [cap("text")], async () => ({ claims: "bad" } as never)), (error: unknown) => {
    assert.ok(error instanceof ClaimVerificationError);
    assert.equal(error.receipt.failure, "invalid-verdict");
    assert.equal(error.receipt.reason, "response must be {claims: string[], unsupported: string[]}");
    assert.equal(error.receipt.evidence[0]!.sha256, "abc");
    assert.match(error.message, /Retry story selection/);
    return true;
  });
});

test("the real selection flow cannot advance a story when its claim judge fails", async (t) => {
  const body = "<article>Example Labs asked regulators for stronger safeguards.</article>";
  t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 200 }));
  const http = t.mock.method(https, "request", (_url: unknown, _options: unknown, callback: Function) => {
    const req: any = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const response: any = new EventEmitter(); response.statusCode = 200; response.headers = {}; response.resume = () => {};
      callback(response); response.emit("data", Buffer.from(body)); response.emit("end");
    });
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => { http.mock.restore(); syncBuiltinESMExports(); });
  for (const judge of [async () => { throw new Error("judge timed out"); }, async () => ({ claims: "bad" } as never)]) {
    await assert.rejects(verifyCandidates([{ ...story, primaryUrl: cap("").url }], {}, judge), (error: unknown) => {
      assert.ok(error instanceof ClaimVerificationError);
      assert.equal(error.receipt.evidence[0]!.url, cap("").url);
      assert.equal(error.receipt.evidence[0]!.status, 200);
      assert.match(error.receipt.evidence[0]!.sha256!, /^[a-f0-9]{64}$/);
      return true;
    });
  }
});

test("claim capture pins transport limits and hashes only a successful captured page", async () => {
  const body = "<article>A source states a qualified finding.</article>";
  const capture = await captureForClaims("https://news.example.com/story#section", "primary", async (url, headers, timeout, bytes) => {
    assert.equal(url, "https://news.example.com/story"); assert.equal(timeout, 30_000); assert.equal(bytes, 5_000_000);
    assert.match(headers["User-Agent"], /source verification/);
    return new Response(body);
  });
  assert.equal(capture.text, "A source states a qualified finding.");
  assert.equal(capture.sha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(capture.status, 200);
});

test("claim capture refuses unsafe URLs, failed DNS, redirects and oversized or error bodies", async () => {
  let calls = 0;
  for (const url of ["http://news.example/story", "https://127.1/private", "https://[::1]/secret", "https://169.254.169.254/latest", "https://host.internal/story", "https://user:pass@news.example/story", "file:///secret"]) {
    const capture = await captureForClaims(url, "primary", async () => { calls++; return new Response("must never be read"); });
    assert.equal(capture.text, ""); assert.equal(capture.sha256, null);
  }
  assert.equal(calls, 0);
  for (const error of ["Public API DNS resolved to a private or local address", "Public API HTTP 302; redirects are not followed", "Public response exceeds 5000000 bytes"]) {
    const capture = await captureForClaims("https://news.example/story", "primary", async () => { throw new Error(error); });
    assert.equal(capture.text, ""); assert.equal(capture.sha256, null);
    assert.equal(capture.status, error.includes("HTTP 302") ? 302 : null);
  }
  for (const status of [302, 403, 404, 500]) {
    const capture = await captureForClaims("https://news.example/story", "primary", async () => new Response("Error page must not become source evidence.", { status }));
    assert.equal(capture.status, status); assert.equal(capture.text, ""); assert.equal(capture.sha256, null);
  }
});

test("the prompt carries only captures with text and preserves the qualifier rule", () => {
  const p = claimPinningPrompt(story, [cap("PRIMARY BODY"), cap("", "corroborating")]);
  assert.match(p, /PRIMARY BODY/);
  assert.doesNotMatch(p, /CORROBORATING SOURCE/);
  assert.match(p, /Preserve\s+every qualifier/);
});
