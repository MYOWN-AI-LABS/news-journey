import assert from "node:assert/strict";
import test from "node:test";
import { requiredTopicUrls } from "./index.js";

test("topic gate returns unique non-empty source URLs", () => {
  assert.deepEqual(requiredTopicUrls({ primaryUrl: "https://example.com/a", stories: [
    { n: 1, headline: "A", summary: "A", weight: "lead", primaryUrl: "https://example.com/a", suggestedScene: "news_card", assetRef: "a", repo: null, principalEntity: "Acme", area: "other", verticals: ["other"] },
    { n: 2, headline: "B", summary: "B", weight: "standard", primaryUrl: "https://example.com/b", suggestedScene: "news_card", assetRef: "b", repo: null, principalEntity: "Beta", area: "other", verticals: ["other"] },
  ] }), ["https://example.com/a", "https://example.com/b"]);
});

test("topic gate rejects missing source evidence", () => {
  assert.throws(() => requiredTopicUrls({ primaryUrl: "", stories: [] }), /no source URLs/);
});
