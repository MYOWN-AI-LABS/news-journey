import assert from "node:assert/strict";
import test from "node:test";
import type { HarvestItem, Topic, TopicStory } from "../types.js";
import type { CatalogFamily } from "../sources/catalog.js";
import type { NewsletterData } from "./newsletter-html.js";
import type { SelectionReportRow } from "./user-ranking.js";
import {
  completeSlateIssue,
  assertNewsletterCache,
  assertNewsletterLength,
  newsletterCacheIdentity,
  newsletterVideoId,
  completeSupportingIssue,
  newsletterFeedNames,
  otherDeskCandidates,
  rankedRadarCandidates,
  renderedNewsletterOutputs,
  type Issue,
  type NewsletterHarvestSnapshot,
  type NewsletterSelectionReport,
} from "./newsletter.js";

const stories = [
  { headline: "Lead board expands service", summary: "The lead summary.", weight: "lead", primaryUrl: "https://lead.example.org/story" },
  { headline: "Second board funds homes", summary: "The housing summary.", weight: "standard", primaryUrl: "https://housing.example.org/story" },
  { headline: "Third board opens transit", summary: "The transit summary.", weight: "quick", primaryUrl: "https://transit.example.org/story" },
] satisfies Pick<TopicStory, "headline" | "summary" | "weight" | "primaryUrl">[];

const issue = (items: Issue["items"] = []): Issue => ({
  subject: "Example civic briefing",
  lead: { title: stories[0].headline, body: stories[0].summary, sourceName: "Lead Board", sourceUrl: stories[0].primaryUrl },
  items,
  radar: [],
  signals: [],
});

const data = (value: Issue): NewsletterData => ({
  publisher: { name: "Example Editor", publication: "Example Civic Signal", audience: "Local leaders", tone: "Direct" },
  issue: value,
  issueNo: 1,
  date: "2026-09-11",
  dateLong: "September 11, 2026",
  video: null,
  coveredWeek: [],
});

test("a three-story slate renders every story even when the writer omitted supporting items", () => {
  const completed = completeSlateIssue(issue(), stories);
  assert.equal(completed.items.length, 2);
  const outputs = renderedNewsletterOutputs(data(completed));
  for (const output of Object.values(outputs)) {
    for (const story of stories) assert.match(output, new RegExp(story.primaryUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("a one-story slate never emits an empty supporting-story heading", () => {
  const outputs = renderedNewsletterOutputs(data(completeSlateIssue(issue(), stories.slice(0, 1))));
  for (const output of Object.values(outputs)) assert.doesNotMatch(output, /Worth your time|Also this edition/);
});

test("customer newsletter outputs never render a localhost video URL", () => {
  const local = data(completeSlateIssue(issue(), stories));
  local.video = {
    id: "20260911-example",
    headline: "Example briefing",
    durationSec: 90,
    videoUrl: "http://localhost:4777/media/20260911-example.mp4",
    posted: true,
  };
  const outputs = renderedNewsletterOutputs(local);
  for (const output of Object.values(outputs)) {
    assert.doesNotMatch(output, /localhost|127\.0\.0\.1/);
    assert.match(output, /video available after publishing/i);
  }
});

test('rerender rejects unbound old prose rather than adopting the sole current package', () => {
  const topic = { id: '20260911-sports', kind: 'roundup', stories } as unknown as Topic;
  const old = data(issue());
  const before = structuredClone(old);
  assert.throws(() => assertNewsletterCache(old, topic), /no matching source video identity/);
  assert.deepEqual(old, before, 'the old prose and links remain untouched');
  assert.throws(() => newsletterVideoId([topic.id], undefined, '20260911-old-cities'), /not an eligible package/);
});

test('a cached Quick issue cannot satisfy Deep by counting headings, links or supporting sections', () => {
  const short = issue([{ name: 'Supporting topic', url: 'https://support.example.org/story', line: Array(100).fill('detail').join(' ') }]);
  short.lead.body = Array(200).fill('fact').join(' ');
  short.subject = Array(400).fill('headline').join(' ');
  short.radar = [{ repo: 'Example project', url: 'https://github.com/example/project', line: Array(500).fill('radar').join(' ') }];
  short.signals = [{ source: 'Example source', url: 'https://signal.example.org/', line: Array(500).fill('signal').join(' ') }];
  const before = structuredClone(short);
  assert.doesNotThrow(() => assertNewsletterLength(short, { min: 250, max: 400 }));
  assert.throws(() => assertNewsletterLength(short, { min: 900, max: 1300 }), /has 300 words.*900–1300.*Generate the newsletter again/);
  assert.deepEqual(short, before, 'length rejection preserves the existing issue');
  const deep = structuredClone(short); deep.lead.body = Array(800).fill('fact').join(' ');
  assert.doesNotThrow(() => assertNewsletterLength(deep, { min: 900, max: 1300 }));
  deep.lead.body += ' ' + Array(401).fill('extra').join(' ');
  assert.throws(() => assertNewsletterLength(deep, { min: 900, max: 1300 }), /has 1301 words.*900–1300/);
});

test('rerender keeps exact reviewed prose and rejects changed facts, prose or citation order', () => {
  const topic = { id: '20260911-sports', kind: 'roundup', stories } as unknown as Topic;
  const prose = completeSlateIssue(issue(), stories);
  const cached = { ...data(prose), ...newsletterCacheIdentity(topic, prose) };
  const before = structuredClone(cached);
  assert.doesNotThrow(() => assertNewsletterCache(cached, topic));
  assert.deepEqual(cached, before, 'validation never fills missing items or rewrites links');
  assert.throws(() => assertNewsletterCache({ ...cached, sourceStoryHash: undefined }, topic), /never bound/);
  const changedTopic = structuredClone(topic);
  changedTopic.stories![0]!.summary = 'A different source fact.';
  assert.throws(() => assertNewsletterCache(cached, changedTopic), /source stories changed/);
  const changedProse = structuredClone(cached);
  changedProse.issue.lead.body = 'Unsupported efficiency gains.';
  assert.throws(() => assertNewsletterCache(changedProse, topic), /prose changed/);
  const reordered = structuredClone(cached);
  reordered.issue.items.reverse();
  Object.assign(reordered, newsletterCacheIdentity(topic, reordered.issue));
  assert.throws(() => assertNewsletterCache(reordered, topic), /citations differ/);
});

const harvestItem = (id: string, source: HarvestItem["source"], title: string, url: string, summary: string): HarvestItem => ({
  id, source, title, url, summary, score: 80, publishedAt: "2026-09-11T10:00:00.000Z", repo: null,
});

const reportRow = (candidateOrder: number, item: HarvestItem, verification: SelectionReportRow["verification"] = null): SelectionReportRow => ({
  candidateOrder, candidateId: item.id, headline: item.title, primaryUrl: item.url, source: item.source, channel: "published:rss",
  rawScore: item.score, rawMetric: "source-recency-score", channelScore: 80, compositeScore: null,
  scoreBreakdown: null, outletsCovering: null,
  credibility: null, heatEvidence: [], publishedAt: item.publishedAt, role: null, selectedOrder: null, verification,
});

test("ranked multi-day radar and other desks render only harvested example-domain fixtures", () => {
  const selected = harvestItem("selected", "rss:Example Civic", "Selected civic story", "https://civic.example.org/selected", "Already in the slate.");
  const currentTrend = harvestItem("current", "rss:Example Civic", "Current ranked story", "https://civic.example.org/current", "Current candidate summary.");
  const olderTrend = harvestItem("older", "rss:Example Research", "Older ranked story", "https://research.example.org/older", "Older candidate summary.");
  const newsletterItem = harvestItem("newsletter", "rss:Example Beat Newsletter", "Newsletter dispatch", "https://newsletter.example.org/dispatch", "Newsletter summary.");
  const snapshots: NewsletterHarvestSnapshot[] = [
    { day: "2026-09-11", fetchedAt: "2026-09-11T11:00:00.000Z", items: [selected, currentTrend, newsletterItem] },
    { day: "2026-09-10", fetchedAt: "2026-09-10T11:00:00.000Z", items: [olderTrend] },
  ];
  const reports: NewsletterSelectionReport[] = [
    { contentDay: "2026-09-11", stories: [{ primaryUrl: selected.url }], candidates: [reportRow(1, selected, { kept: true }), reportRow(2, currentTrend, { kept: true })] },
    { contentDay: "2026-09-10", stories: [], candidates: [reportRow(1, olderTrend, { kept: true })] },
  ];
  const catalog: CatalogFamily[] = [{
    id: "example-civic", name: "Example civic", keywords: ["civic"],
    feeds: [{ name: "Example Beat Newsletter", url: "https://newsletter.example.org/feed", covers: "civic", newsletter: true }],
  }];
  const radar = rankedRadarCandidates(reports, snapshots, [selected.url]);
  assert.deepEqual(radar.map((row) => row.url), [currentTrend.url, olderTrend.url]);
  assert.ok(radar.every((row) => row.line.length <= 240));
  const feedNames = newsletterFeedNames([], catalog, ["civic"]);
  const signals = otherDeskCandidates(
    snapshots.filter((snapshot) => snapshot.day === "2026-09-11"),
    feedNames,
    [{ source: "Example Housing Desk", title: "Housing desk update", summary: "Other edition summary.", url: "https://housing.example.org/update" }],
    [selected.url, ...radar.map((row) => row.url)],
  );
  assert.ok(signals.every((row) => row.line.length <= 320));
  const cached = { ...completeSlateIssue(issue(), stories), radar: radar.map((row) => ({ ...row, line: "x".repeat(1_000) })), signals: signals.map((row) => ({ ...row, line: "x".repeat(1_000) })) };
  const completed = completeSupportingIssue(cached, radar, signals);
  assert.ok(completed.radar.every((row) => row.line.length <= 240));
  assert.ok(completed.signals.every((row) => row.line.length <= 320));
  const outputs = renderedNewsletterOutputs(data(completed));
  for (const output of Object.values(outputs)) {
    assert.match(output, /Trending, not yet covered/);
    assert.match(output, /From the other desks/);
    for (const url of [...radar.map((row) => row.url), ...signals.map((row) => row.url)]) assert.match(output, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("radar and other-desks headings are omitted when no verified fixture items remain", () => {
  const dead = harvestItem("dead", "rss:Example Civic", "Dead candidate", "https://dead.example.org/story", "Not eligible.");
  const report: NewsletterSelectionReport = {
    contentDay: "2026-09-11", stories: [], candidates: [reportRow(1, dead, { kept: false, reason: "dead source" })],
  };
  const snapshot: NewsletterHarvestSnapshot = { day: "2026-09-11", fetchedAt: "2026-09-11T11:00:00.000Z", items: [dead] };
  const radar = rankedRadarCandidates([report], [snapshot], []);
  const signals = otherDeskCandidates([snapshot], [], [], []);
  assert.deepEqual(radar, []); assert.deepEqual(signals, []);
  const outputs = renderedNewsletterOutputs(data(completeSupportingIssue(completeSlateIssue(issue(), stories), radar, signals)));
  for (const output of Object.values(outputs)) assert.doesNotMatch(output, /Trending, not yet covered|From the other desks/);
});
