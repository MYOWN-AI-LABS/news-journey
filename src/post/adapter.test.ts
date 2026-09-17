import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS, lanesFor, PLATFORM_ORDER } from "./adapter.js";
import type { Platform } from "../types.js";

const ALL: Platform[] = ["youtube", "instagram", "linkedin", "x", "threads", "tiktok", "reddit"];

test("every platform has an adapter with capabilities and a publish function", () => {
  for (const p of ALL) {
    const a = ADAPTERS[p];
    assert.ok(a, `${p} has no adapter`);
    assert.equal(a.platform, p);
    assert.equal(typeof a.publish, "function");
    assert.ok(["api", "x-browser", "shared-browser", "tiktok-api"].includes(a.capabilities.concurrencyGroup), p);
  }
});

test("lanes derived from concurrency groups equal the previous hand-written lanes", () => {
  // The literal LANES that src/post/index.ts carried before adapters existed. The shared browser
  // profile lane MUST stay serial and MUST stay separate from X's own profile.
  assert.deepEqual(lanesFor(PLATFORM_ORDER), [
    ["linkedin", "youtube", "instagram"],
    ["x"],
    ["threads", "reddit"],
    ["tiktok"],
  ]);
});

test("lanesFor respects the caller's order and drops platforms it is not given", () => {
  assert.deepEqual(lanesFor(["x", "reddit", "youtube"]), [["x"], ["reddit"], ["youtube"]]);
  assert.deepEqual(lanesFor([]), []);
});

test("the two shared-browser-profile platforms share exactly one lane", () => {
  const groups = new Set(["threads", "reddit"].map((p) => ADAPTERS[p as Platform].capabilities.concurrencyGroup));
  assert.deepEqual([...groups], ["shared-browser"]);
  assert.equal(ADAPTERS.x.capabilities.concurrencyGroup, "x-browser");
});

test("OAuth re-consent command maps to the real provider, not the platform name", () => {
  assert.equal(ADAPTERS.youtube.capabilities.authProvider, "google");
  assert.equal(ADAPTERS.instagram.capabilities.authProvider, "meta");
  assert.equal(ADAPTERS.threads.capabilities.authProvider, "meta");
  assert.equal(ADAPTERS.linkedin.capabilities.authProvider, "linkedin");
});
