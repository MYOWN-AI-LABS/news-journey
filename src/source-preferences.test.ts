import assert from "node:assert/strict";
import test from "node:test";
import type { HarvestItem } from "./types.js";
import { editorialBrief, filterExcludedTopics, getEnabledSources, matchesAnyTopic } from "./source-preferences.js";

const item = (title: string): HarvestItem => ({
  id: title,
  source: "hn",
  title,
  url: `https://example.com/${encodeURIComponent(title)}`,
  score: 1,
  publishedAt: null,
  repo: null,
  summary: "",
});

test("source selection defaults to all adapters and rejects an empty selection", () => {
  assert.deepEqual([...getEnabledSources({})], ["hn", "githubTrending", "rss"]);
  assert.deepEqual([...getEnabledSources({ enabledSources: ["publicApis"] })], ["publicApis"]);
  assert.throws(() => getEnabledSources({ enabledSources: [] }), /At least one source/);
  assert.throws(() => getEnabledSources({ enabledSources: ["unknown" as never] }), /Unknown enabled source/);
});

test("topic matching uses term boundaries and exclusions are deterministic", () => {
  assert.equal(matchesAnyTopic("New AI inference runtime", ["AI"]), true);
  assert.equal(matchesAnyTopic("Maintainers said it shipped", ["AI"]), false);
  assert.deepEqual(
    filterExcludedTopics([item("AI inference runtime"), item("Database release")], { excludedTopics: ["AI"] }).map((entry) => entry.title),
    ["Database release"]
  );
});

test("editorial brief carries the operator's topic choices into ranking", () => {
  const brief = editorialBrief({
    preferredTopics: ["edge computing"],
    excludedTopics: ["cryptocurrency"],
    selectionNotes: "Favor primary sources.",
  });
  assert.match(brief, /edge computing/);
  assert.match(brief, /cryptocurrency/);
  assert.match(brief, /Favor primary sources/);
});
