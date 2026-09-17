import test from "node:test";
import assert from "node:assert/strict";
import type { HarvestItem } from "../types.js";
import { assembleSlate, channelPercentile, isVendorPromotion, rankCandidatesByChannel, rankingChannel, selectionReportRows } from "./selection-math.js";

const item = (id: string, source: string, score: number, extra: Partial<HarvestItem> = {}): HarvestItem =>
  ({ id, source: source as HarvestItem["source"], title: "Title " + id, url: `https://news.example.org/${id}`, score, publishedAt: null, repo: null, summary: "Summary " + id, ...extra });

test("each unit is ranked only against its own channel; HN points never meet GitHub stars", () => {
  assert.equal(rankingChannel(item("a", "hn", 900)), "community:hn");
  assert.equal(rankingChannel(item("b", "gh-trending", 40, { repo: { starsToday: 40 } as never })), "community:github-momentum");
  assert.equal(rankingChannel(item("c", "gh-trending", 78000, { repo: {} as never })), "community:github-established");
  assert.equal(rankingChannel(item("d", "public-api:crossref", 0)), "published:api");
  assert.equal(rankingChannel(item("e", "rss:forum.example.org", 80), { communityFeeds: ["forum.example.org"] }), "community:feed");
  assert.equal(rankingChannel(item("f", "rss:www.forum.example.org", 80)), "published:rss", "no community host is shipped");
  // Percentile: strongest 100, weakest 0, ties share the midpoint, a singleton is neutral 50.
  assert.equal(channelPercentile(10, [10]), 50);
  assert.deepEqual([1, 2, 3].map((v) => channelPercentile(v, [1, 2, 3])), [0, 50, 100]);
  assert.equal(channelPercentile(5, [5, 5, 9]), 25);
  const ranked = rankCandidatesByChannel([item("h1", "hn", 900), item("h2", "hn", 10), item("g1", "gh-trending", 78000, { repo: {} as never }), item("g2", "gh-trending", 30, { repo: { starsToday: 30 } as never })]);
  const by = Object.fromEntries(ranked.map((c) => [c.id, c]));
  assert.equal(by.h1.channelScore, 100); assert.equal(by.h2.channelScore, 0);
  assert.equal(by.g1.channelScore, 50, "78,000 lifetime stars alone in its channel is neutral, not a winner over 900 HN points");
  assert.equal(by.g1.rawMetric, "github-stars-total"); assert.equal(by.g2.velocityPlatform, "github"); assert.equal(by.h1.velocityPlatform, "hn");
});

test("vendor promotion is an operator setting, never a shipped list", () => {
  const promo = { source: "rss:vendor.example.com", title: "Customer success story: how Acme scaled with our platform", summary: "Case study" };
  assert.equal(isVendorPromotion(promo), false, "nothing is a vendor unless the operator says so");
  assert.equal(isVendorPromotion(promo, { vendorSources: ["vendor.example.com"] }), true, "a configured vendor's case study is marketing");
  assert.equal(isVendorPromotion({ ...promo, source: "rss:news.example.org" }, { vendorSources: ["vendor.example.com"] }), false, "the same words from a newsroom are reporting");
  assert.equal(isVendorPromotion({ ...promo, title: "Model release: evaluation results on a new benchmark", summary: "Research" }, { vendorSources: ["vendor.example.com"] }), false, "vendor research stays eligible");
  // Codex review: an RSS source id carries the operator's feed NAME; the listed host matches the feed's real origin.
  assert.equal(isVendorPromotion({ ...promo, source: "rss:Example Vendor Blog", origin: "blog.vendor.example.com" }, { vendorSources: ["vendor.example.com"] }), true);
  assert.equal(rankingChannel(item("n", "rss:Example Forum", 80, { origin: "forum.example.org" }), { communityFeeds: ["forum.example.org"] }), "community:feed");
});

test("a dropped pick is back-filled from the next verified alternate; below the minimum still stops", () => {
  const s = (name: string, entity = name) => ({ name, principalEntity: entity });
  // The model recommended four; one did not verify. The first alternate about a NEW entity takes its place.
  const { slate, spare } = assembleSlate([s("a"), s("b"), s("c")], [s("x", "a"), s("y"), s("z")], 4, 3, 5);
  assert.deepEqual(slate.map((x) => x.name), ["a", "b", "c", "y"], "an alternate about an entity already on the slate is skipped");
  assert.deepEqual(spare.map((x) => x.name), ["x", "z"]);
  assert.throws(() => assembleSlate([s("a")], [s("b")], 4, 3, 5), /Only 2 stories have readable sources after back-filling; 3 required/);
  assert.equal(assembleSlate([s("a"), s("b"), s("c"), s("d"), s("e"), s("f")], [], 6, 3, 5).slate.length, 5, "never above the maximum");
  // Codex review: the same canonical entity rule as the model validators, not a lower-cased string.
  assert.deepEqual(assembleSlate([s("a", "Example Corp"), s("b"), s("c")], [s("x", "the Example team"), s("y")], 4, 3, 5).slate.map((x) => x.name), ["a", "b", "c", "y"]);
});

test("the selection report carries every candidate's evidence and marks what was chosen", () => {
  const ranked = rankCandidatesByChannel([item("h1", "hn", 900), item("h2", "hn", 10)]);
  const scored = [{ ...ranked[0], score: 71, credibility: "established, 12 outlets", outletsCovering: 12, heatEvidence: ["gdelt: 12 outlets"], scoreBreakdown: { heat: 70, provenance: 78, freshness: 60, channelRank: 100 } }, ranked[1]];
  const rows = selectionReportRows(scored, new Map([["h1", { role: "recommended", order: 1, verification: { kept: true } }]]));
  assert.equal(rows[0].compositeScore, 71); assert.deepEqual(rows[0].scoreBreakdown, { heat: 70, provenance: 78, freshness: 60, channelRank: 100 });
  assert.equal(rows[0].selectedOrder, 1); assert.equal(rows[0].role, "recommended"); assert.equal(rows[0].outletsCovering, 12);
  assert.equal(rows[1].compositeScore, null, "an unscored tail candidate has only its channel score"); assert.equal(rows[1].selectedOrder, null);
  assert.ok(!JSON.stringify(rows).includes("prompt"));
});
