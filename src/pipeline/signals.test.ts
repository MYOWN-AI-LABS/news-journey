import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COMPONENT_WEIGHTS, HEAT_WEIGHTS, NEUTRAL,
  shrink, percentileIn, rankWithHistory, freshnessScore, compose,
} from "./signals.js";
import { registrableDomain, clusterTitles } from "./credibility.js";

test("unavailable signals are exactly neutral, never zero", () => {
  assert.equal(shrink(0, 0), NEUTRAL);      // zero confidence: even a rock-bottom percentile is neutral
  assert.equal(shrink(100, 0), NEUTRAL);
  const c = compose({ heatParts: {}, provenance: NEUTRAL, freshness: NEUTRAL, editorial: NEUTRAL });
  assert.equal(c.heat, NEUTRAL);            // no platforms observed → heat itself is neutral
  assert.ok(c.total > 0, "missing evidence must not zero the score");
});

test("a single observation is neutral, not best-or-worst", () => {
  assert.equal(percentileIn(42, [42]), NEUTRAL);
  assert.equal(percentileIn(42, []), NEUTRAL);
});

test("shrinkage pulls toward 50 in proportion to confidence", () => {
  assert.equal(shrink(100, 1), 100);
  assert.equal(shrink(100, 0.5), 75);
  assert.equal(shrink(0, 0.5), 25);
});

test("history is used only after 20 observations", () => {
  const batch = [1, 2, 3, 100];
  const shortHist = { "x.activity": [1, 2, 3] };
  const longHist = { "x.activity": Array.from({ length: 25 }, (_, i) => i) }; // 0..24
  assert.equal(rankWithHistory("x", "activity", 100, batch, shortHist), percentileIn(100, batch));
  assert.equal(rankWithHistory("x", "activity", 100, batch, longHist), percentileIn(100, longHist["x.activity"]));
});

test("public heat is the largest component and weights sum to 1", () => {
  const w = Object.values(COMPONENT_WEIGHTS);
  assert.ok(COMPONENT_WEIGHTS.heat >= Math.max(...w));
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const hw = Object.values(HEAT_WEIGHTS) as number[];
  assert.ok(Math.abs(hw.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("one extreme platform cannot run the composite to the rail", () => {
  // gdelt maxed, every other platform absent (neutral): heat = 30% at 100 + 70% at 50 = 65.
  const c = compose({ heatParts: { gdelt: 100 }, provenance: NEUTRAL, freshness: NEUTRAL, editorial: NEUTRAL });
  assert.equal(c.heat, 65);
  assert.ok(c.total <= 60, `total ${c.total} should stay well inside the bounds`);
  // and the composite is bounded by construction:
  const max = compose({ heatParts: { gdelt: 100, reddit: 100, hn: 100, github: 100, linkedin: 100, x: 100 }, provenance: 100, freshness: 100, editorial: 100 });
  assert.equal(max.total, 100);
});

test("freshness: undated is neutral, fresh is high, stale floors at 0", () => {
  assert.equal(freshnessScore(null), NEUTRAL);
  assert.ok(freshnessScore(new Date().toISOString()) >= 98);
  assert.equal(freshnessScore(new Date(Date.now() - 100 * 3600_000).toISOString()), 0);
});

test("registrable domains collapse subdomains, keep second-level registries", () => {
  assert.equal(registrableDomain("news.yahoo.com"), "yahoo.com");
  assert.equal(registrableDomain("www.theverge.com"), "theverge.com");
  assert.equal(registrableDomain("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("finance.example.com.au"), "example.com.au");
});

test("syndication clusters: identical wire copy is ONE story", () => {
  assert.equal(clusterTitles([
    "Anthropic launches Claude 6 with new safety features",
    "Anthropic Launches Claude 6 With New Safety Features",   // same wire story, case-shifted
    "Anthropic launches Claude 6, with new safety features",  // punctuation variant
  ]), 1);
  assert.equal(clusterTitles([
    "Anthropic launches Claude 6 with new safety features",
    "Quantum startup raises record round for photonic chips",
    "NVIDIA opens robotics world model to researchers",
  ]), 3);
});

test('no evidence label ever claims "shared N times"', () => {
  // The phrasing itself is the contract: samples are observations, not platform-wide counts.
  // Comments are stripped first — credibility.ts QUOTES the banned phrase while banning it.
  for (const f of ["../sources/social.ts", "./rank.ts", "./credibility.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8")
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    assert.ok(!/shared \$?\{?[\dN]/i.test(src), `${f} must not phrase samples as share counts`);
  }
});
