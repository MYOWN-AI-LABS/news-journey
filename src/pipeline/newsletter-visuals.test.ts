import assert from "node:assert/strict";
import test from "node:test";
import { newsletterVisual } from "./newsletter-visuals.js";
import type { NewsletterMotionStory } from "./newsletter-html.js";

/**
 * Regression for the 2026-09-09 political newsletter, which printed "Visual review: failed", the
 * before/after repair frames and the raw review JSON beside story 1. Review verdicts are production
 * diagnostics and stay in diagram-phone-review.json / visual-results.json; the customer figure
 * carries the artwork, its title, its caveat and its source link — nothing else.
 */
test("a customer newsletter figure never carries review verdicts, repair frames or QA JSON", () => {
  const story: NewsletterMotionStory = {
    n: 1, title: "9/11 records surface", url: "https://news.example.com/records", status: "Reported",
    kind: "flow", who: "Agencies", what: "Records", how: "Disclosure", impact: "Scrutiny",
    diagram: {
      svg: `<svg class="tm-story-svg tm-svg-authored" data-visual-primitive="authored-1" viewBox="0 0 720 340" role="img" aria-labelledby="tm-visual-1"><title id="tm-visual-1">A factual mechanism</title><rect class="tm-sc-node" x="20" y="60" width="100" height="70"/></svg>`,
      label: "MECHANISM", reading: "Read top to bottom.", legend: [{ kind: "source", label: "input" }],
      review: { status: "failed", sha256: "c6649a61c00f1e532e6c8985d0bcb45bb2f0a3a89be3817755b34222ecedc46b", reason: "essential qualifiers are dropped", before: "diagram-1-before-320.png", after: "diagram-1-after-320.png" },
    },
  };
  const html = newsletterVisual(story, "2026-09-09");
  assert.match(html, /<figure class="topic-motion" data-story-index="1"/);
  assert.match(html, /9\/11 records surface/);
  assert.match(html, /Story source/);
  for (const leak of [/Visual review/, /<details/, /<pre/, /repair/i, /c6649a61/, /qualifiers are dropped/, /"status"/]) assert.doesNotMatch(html, leak);
});
