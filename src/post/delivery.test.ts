import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDeliveryEvent, appendDeliveryEventIfChanged, blockedPlatforms, classifyFailure, DELIVERY_EVENTS_FILE, projectOutcomes,
  readDeliveryEvents, recordPlatformOutcome,
} from "./delivery.js";
import type { VideoMeta } from "../types.js";

const dir = () => mkdtempSync(join(tmpdir(), "delivery-"));

test("events append as one JSON line each and read back in order", () => {
  const d = dir();
  appendDeliveryEvent(d, { type: "platform.accepted", videoId: "v1", platform: "linkedin",
    outcome: { platform: "linkedin", state: "unconfirmed", retryable: false, providerId: "example-post-1", at: "2026-09-05T10:00:00Z" } });
  appendDeliveryEvent(d, { type: "platform.failed", videoId: "v1", platform: "x",
    outcome: { platform: "x", state: "failed", retryable: true, reason: "ECONNRESET", at: "2026-09-05T10:00:05Z" } });
  const raw = readFileSync(join(d, DELIVERY_EVENTS_FILE), "utf8");
  assert.equal(raw.trim().split("\n").length, 2);
  const events = readDeliveryEvents(d);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "platform.accepted");
  assert.equal(events[1].outcome?.retryable, true);
  for (const e of events) { assert.ok(e.at); assert.equal(typeof e.pid, "number"); }
});

test("a missing log reads as no events", () => {
  assert.deepEqual(readDeliveryEvents(dir()), []);
});

test("a torn final line from a crash is skipped, earlier events survive", () => {
  const d = dir();
  appendDeliveryEvent(d, { type: "release.withheld", videoId: "v1", reason: "newsletter-not-live" });
  appendFileSync(join(d, DELIVERY_EVENTS_FILE), '{"type":"platform.acc');
  const events = readDeliveryEvents(d);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "newsletter-not-live");
});

test("projection keeps only the latest outcome per platform", () => {
  const events = [
    { type: "platform.failed", videoId: "v1", platform: "x", at: "t1", pid: 1,
      outcome: { platform: "x", state: "failed", retryable: true, at: "t1" } },
    { type: "platform.accepted", videoId: "v1", platform: "linkedin", at: "t2", pid: 1,
      outcome: { platform: "linkedin", state: "unconfirmed", retryable: false, providerId: "a", at: "t2" } },
    { type: "release.withheld", videoId: "v1", at: "t3", pid: 1, reason: "newsletter-not-live" },
    { type: "platform.accepted", videoId: "v1", platform: "x", at: "t4", pid: 2,
      outcome: { platform: "x", state: "unconfirmed", retryable: false, providerId: "b", at: "t4" } },
  ];
  const p = projectOutcomes(events as any);
  assert.equal(p.x?.state, "unconfirmed");
  assert.equal(p.x?.providerId, "b");
  assert.equal(p.linkedin?.state, "unconfirmed");
  assert.equal(Object.keys(p).length, 2);
});

test("a failed log write never throws — a live post must still reach meta.posts", () => {
  const missing = join(tmpdir(), "delivery-does-not-exist", "nested");
  let result: unknown = "unset";
  assert.doesNotThrow(() => {
    result = appendDeliveryEvent(missing, { type: "platform.accepted", videoId: "v1", platform: "x",
      outcome: { platform: "x", state: "unconfirmed", retryable: false, providerId: "1", at: "t" } });
  });
  assert.equal(result, null);
  assert.deepEqual(readDeliveryEvents(missing), []);
});

test("IfChanged: a hold that persists across passes is one line per streak; a new reason is a new line", () => {
  const d = dir();
  appendDeliveryEventIfChanged(d, { type: "release.withheld", videoId: "v1", reason: "newsletter-not-live" });
  appendDeliveryEventIfChanged(d, { type: "release.withheld", videoId: "v1", reason: "newsletter-not-live" });
  appendDeliveryEventIfChanged(d, { type: "release.withheld", videoId: "v1", reason: "newsletter-not-live" });
  assert.equal(readDeliveryEvents(d).length, 1);
  appendDeliveryEventIfChanged(d, { type: "release.withheld", videoId: "v1", reason: "media-qc" });
  appendDeliveryEventIfChanged(d, { type: "release.withheld", videoId: "v1", reason: "newsletter-not-live" });
  assert.deepEqual(readDeliveryEvents(d).map((e) => e.reason), ["newsletter-not-live", "media-qc", "newsletter-not-live"]);
});

test("recordPlatformOutcome re-projects meta.delivery from the whole log, keeping a concurrent process's entries", () => {
  const d = dir();
  appendDeliveryEvent(d, { type: "platform.accepted", videoId: "v1", platform: "tiktok",
    outcome: { platform: "tiktok", state: "unconfirmed", retryable: false, providerId: "tt1", at: "t0" } });
  const meta = { id: "v1", posts: {}, delivery: {} } as unknown as VideoMeta;
  recordPlatformOutcome(d, meta, "platform.failed",
    { platform: "youtube", state: "failed", retryable: true, reason: "error: boom", at: "t1" });
  assert.equal(meta.delivery?.tiktok?.providerId, "tt1");
  assert.equal(meta.delivery?.youtube?.state, "failed");
});

test("blockedPlatforms: only a non-retryable latest failure counts as blocked", () => {
  const ev = (platform: string, state: string, retryable: boolean, at: string) =>
    ({ type: state === "failed" ? "platform.failed" : "platform.accepted", videoId: "v1", platform, at, pid: 1,
       outcome: { platform, state, retryable, at } }) as any;
  // x: dead grant → blocked. youtube: transport blip (retryable) → not blocked.
  // threads: failed, then a later success → not blocked. linkedin: never failed.
  assert.deepEqual(blockedPlatforms([
    ev("x", "failed", false, "t1"),
    ev("youtube", "failed", true, "t2"),
    ev("threads", "failed", false, "t3"),
    ev("threads", "unconfirmed", false, "t4"),
    ev("linkedin", "unconfirmed", false, "t5"),
  ]), ["x"]);
  assert.deepEqual(blockedPlatforms([]), []);
});

test("failure classification: expired auth is not retryable, transport/credit errors are", () => {
  assert.deepEqual(classifyFailure("invalid_grant: Token has been expired or revoked."), { retryable: false, reason: "auth-expired" });
  assert.deepEqual(classifyFailure("Request failed with status 401 Unauthorized"), { retryable: false, reason: "auth-expired" });
  // A dead OAuth refresh token is an auth problem, not a transient error.
  assert.deepEqual(classifyFailure('X token exchange 400: {"error":"invalid_request","error_description":"Value passed for the token was invalid."}'),
    { retryable: false, reason: "auth-expired" });
  assert.equal(classifyFailure("read ECONNRESET").retryable, true);
  assert.equal(classifyFailure("X API 402 credits exhausted").retryable, true);
  assert.equal(classifyFailure("Timeout 30000ms exceeded").reason, "error");
});
