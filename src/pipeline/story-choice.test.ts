import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TopicStory } from "../types.js";
import { applyStoryChoice, lockStoryChoice, lockedStories, readStoryChoice, storyChoiceView, storyKey, writeStoryChoice } from "./story-choice.js";

const story = (n: number, entity: string, weight: TopicStory["weight"] = "standard"): TopicStory => ({
  n, headline: `Story ${n}`, summary: `What happened ${n}`, weight, primaryUrl: `https://news.example.org/${n}`, repo: null, assetRef: `og-${n - 1}`,
  suggestedScene: "news_card", principalEntity: entity, area: "other", verticals: ["other"],
});
const evidence = { compositeScore: 70, scoreBreakdown: { heat: 60, provenance: 78, freshness: 90, channelRank: 50 }, outletsCovering: 9, credibility: "established", publishedAt: null, sourceHost: "news.example.org" };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "story-choice-"));
  const recommended = [story(1, "City council", "lead"), story(2, "Transit agency"), story(3, "Housing board")];
  const alternates = [story(4, "Election office"), story(5, "City council")];
  writeFileSync(join(dir, "topic.json"), JSON.stringify({ id: "20260101-roundup-x", kind: "roundup", headline: "Day", angle: "", sourceItems: ["i1", "i2", "i3"], primaryUrl: recommended[0].primaryUrl, repo: null, alternates: [], stories: recommended }));
  const entries = [...recommended.map((s) => ({ key: storyKey(s), role: "recommended" as const, story: s, sourceItemIds: ["i" + s.n], evidence })), ...alternates.map((s) => ({ key: storyKey(s), role: "alternate" as const, story: s, sourceItemIds: ["i" + s.n], evidence }))];
  writeStoryChoice(dir, { minStories: 3, maxStories: 4, recommendedLead: entries[0].key, entries }, false);
  return { dir, keys: entries.map((e) => e.key) };
}

test("accepting the recommendations locks the verified slate; the CLI path records the recommendation chose", () => {
  const { dir, keys } = fixture();
  try {
    assert.throws(() => lockedStories(dir), /Waiting for your story choice/);
    const f = lockStoryChoice(dir, { accept: true }, "recommendation");
    assert.deepEqual(f.lock!.keys, keys.slice(0, 3)); assert.equal(f.lock!.lead, keys[0]); assert.equal(f.lock!.chosenBy, "recommendation");
    assert.equal(storyChoiceView(dir)!.stories.length, 5); assert.equal(storyChoiceView(dir)!.locked, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a person swaps a story, picks the lead, and the script is written from exactly those stories", () => {
  const { dir, keys } = fixture();
  try {
    lockStoryChoice(dir, { keys: [keys[1], keys[2], keys[3]], lead: keys[3] }, "user");
    const topic = applyStoryChoice(dir);
    assert.deepEqual(topic.stories!.map((s) => s.headline), ["Story 4", "Story 2", "Story 3"], "lead first, then the person's order");
    assert.deepEqual(topic.stories!.map((s) => s.weight), ["lead", "standard", "standard"], "exactly one lead");
    assert.deepEqual(topic.stories!.map((s) => s.assetRef), ["og-0", "og-1", "og-2"]); assert.deepEqual(topic.stories!.map((s) => s.n), [1, 2, 3]);
    assert.equal(topic.primaryUrl, "https://news.example.org/4"); assert.deepEqual(topic.sourceItems.sort(), ["i2", "i3", "i4"]);
    assert.equal(JSON.parse(readFileSync(join(dir, "topic.json"), "utf8")).stories.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a roundup is retitled after the chosen lead in topic.json and meta.json; a custom title is left alone", () => {
  const { dir, keys } = fixture();
  try {
    const topicPath = join(dir, "topic.json"), metaPath = join(dir, "meta.json");
    const titled = { ...JSON.parse(readFileSync(topicPath, "utf8")), headline: "Roundup 2026-01-01: Story 1" };
    writeFileSync(topicPath, JSON.stringify(titled)); writeFileSync(metaPath, JSON.stringify({ id: titled.id, status: "awaiting_story_choice", headline: titled.headline }));
    lockStoryChoice(dir, { keys: [keys[1], keys[2], keys[3]], lead: keys[3] }, "user");
    assert.equal(applyStoryChoice(dir).headline, "Roundup 2026-01-01: Story 4");
    assert.equal(JSON.parse(readFileSync(topicPath, "utf8")).headline, "Roundup 2026-01-01: Story 4");
    assert.deepEqual(JSON.parse(readFileSync(metaPath, "utf8")), { id: titled.id, status: "awaiting_story_choice", headline: "Roundup 2026-01-01: Story 4" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const custom = fixture();
  try {
    lockStoryChoice(custom.dir, { keys: [custom.keys[1], custom.keys[2], custom.keys[3]], lead: custom.keys[3] }, "user");
    assert.equal(applyStoryChoice(custom.dir).headline, "Day");
  } finally { rmSync(custom.dir, { recursive: true, force: true }); }
});

test("the choice is held to the slate rules and bound to the candidates it was made on", () => {
  const { dir, keys } = fixture();
  try {
    assert.throws(() => lockStoryChoice(dir, { keys: [keys[0], keys[1]] }, "user"), /Choose between 3 and 4 stories \(you chose 2\)/);
    assert.throws(() => lockStoryChoice(dir, { keys: keys.slice(0, 5) }, "user"), /between 3 and 4/);
    assert.throws(() => lockStoryChoice(dir, { keys: [keys[0], keys[1], "not-a-story"] }, "user"), /not one of this package's verified stories/);
    assert.throws(() => lockStoryChoice(dir, { keys: keys.slice(0, 3), lead: keys[3] }, "user"), /lead story must be one of the chosen/);
    lockStoryChoice(dir, { accept: true }, "user");
    // Candidates changed after the lock (a different selection wrote them): the lock no longer applies.
    const f = readStoryChoice(dir)!; f.entries[0].story.headline = "Changed"; writeFileSync(join(dir, "story-choice.json"), JSON.stringify(f));
    assert.throws(() => lockedStories(dir), /changed after they were chosen/);
    // Codex review: the invalid lock is cleared and the panel offers the choice again (it used to stay hidden).
    assert.equal(readStoryChoice(dir)!.lock, undefined); assert.equal(storyChoiceView(dir)!.locked, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("separate source events about the same entity remain selectable", () => {
  const { dir, keys } = fixture();
  try {
    const f = readStoryChoice(dir)!; f.entries[3].story.principalEntity = "the City council team"; writeFileSync(join(dir, "story-choice.json"), JSON.stringify(f));
    const chosen = lockStoryChoice(dir, { keys: [keys[0], keys[1], keys[3]] }, "user");
    assert.equal(chosen.lock!.keys.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("applying the choice records the final slate in the report and returns exactly the URLs to reserve", () => {
  const { dir, keys } = fixture();
  try {
    writeFileSync(join(dir, "selection-report.json"), JSON.stringify({ stories: [{ order: 1, headline: "Story 1" }], candidates: [] }));
    const f = readStoryChoice(dir)!; f.entries.forEach((e) => { e.sourceUrls = [`https://feed.example.org/${e.story.n}`]; }); writeFileSync(join(dir, "story-choice.json"), JSON.stringify(f));
    lockStoryChoice(dir, { keys: [keys[1], keys[2], keys[3]], lead: keys[3] }, "user");
    const applied = applyStoryChoice(dir);
    assert.deepEqual(applied.reservedUrls.sort(), ["https://feed.example.org/2", "https://feed.example.org/3", "https://feed.example.org/4", "https://news.example.org/2", "https://news.example.org/3", "https://news.example.org/4"], "the dropped story 1 is not reserved; the swapped-in story 4 is");
    const report = JSON.parse(readFileSync(join(dir, "selection-report.json"), "utf8"));
    assert.deepEqual(report.stories.map((s: { headline: string }) => s.headline), ["Story 4", "Story 2", "Story 3"]);
    assert.deepEqual(report.recommendedStories, [{ order: 1, headline: "Story 1" }], "the recommendation stays as audit data");
    assert.equal(report.choice.chosenBy, "user");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

 test("selecting the exact same primary source twice is rejected",()=>{
 const {dir,keys}=fixture();try{
  const f=readStoryChoice(dir)!;f.entries[3].story.primaryUrl=f.entries[0].story.primaryUrl;writeFileSync(join(dir,"story-choice.json"),JSON.stringify(f));
  assert.throws(()=>lockStoryChoice(dir,{keys:[keys[0],keys[1],keys[3]]},"user"),/same primary source/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
