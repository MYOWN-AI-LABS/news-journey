import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverFeeds, feedLinksIn, feedShape } from "./feed-discovery.js";
import { coverage, coverageProblem, readHarvest, topicWords } from "./coverage.js";
import { matchCatalog, readCatalog } from "./catalog.js";
import type { HarvestItem } from "../types.js";

const rss = (n: number, title = "Civic feed") => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${"<item><title>x</title></item>".repeat(n)}</channel></rss>`;
const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom feed</title><entry><title>a</title></entry></feed>`;

test("a pasted site finds its declared feed, a pasted feed is kept, and nothing private or credentialed is fetched", async () => {
  const html = `<html><head><link rel="alternate" type="application/rss+xml" title="News" href="/news/feed"><link rel=stylesheet href=/x.css><link type="application/atom+xml" rel="alternate" href="http://insecure.example.org/atom"></head></html>`;
  assert.deepEqual(feedLinksIn(html, "https://city.example.org/page"), ["https://city.example.org/news/feed"]);
  assert.equal(feedShape(rss(3)).items, 3); assert.equal(feedShape(rss(3)).title, "Civic feed"); assert.equal(feedShape(atom).isFeed, true); assert.equal(feedShape("<html><head><title>x</title></head></html>").isFeed, false);
  const fetched: string[] = [];
  const fetcher = async (url: string) => { fetched.push(url); if (url === "https://city.example.org/") return html; if (url === "https://city.example.org/news/feed") return rss(4, "City news"); if (url === "https://kff.example.org/feed/") return rss(10); if (url === "https://empty.example.org/") return "<html></html>"; throw new Error("HTTP 404"); };
  const found = await discoverFeeds(["city.example.org", "https://kff.example.org/feed/", "https://empty.example.org/", "https://user:pw@x.example.org/", "http://127.0.0.1/feed", "https://one.example.org", "https://two.example.org"], fetcher);
  assert.equal(found.length, 5, "at most five trusted sources per brief");
  assert.deepEqual(found[0], { input: "city.example.org", url: "https://city.example.org/news/feed", title: "City news", items: 4, reason: null });
  assert.equal(found[1].url, "https://kff.example.org/feed/"); assert.equal(found[1].items, 10);
  assert.equal(found[2].url, null); assert.match(found[2].reason!, /No feed was found/);
  assert.equal(found[3].url, null); assert.match(found[3].reason!, /credentials/);
  assert.equal(found[4].url, null); assert.match(found[4].reason!, /HTTPS|private/);
  assert.ok(fetched.every(u => u.startsWith("https://")), "only HTTPS candidates are ever fetched");
  // a beta tester, Sep 10: names, empty feeds and refused sites are reported in plain words, never offered or silently kept.
  const plain = await discoverFeeds(["HUD Newsroom", "https://quiet.example.gov/feed", "https://refused.example.gov/", "https://moved.example.gov/"], async url => {
    if (url === "https://quiet.example.gov/feed") return rss(0); if (url === "https://refused.example.gov/") throw new Error("Public API HTTP 403; redirects are not followed"); throw new Error("Public API HTTP 301; redirects are not followed");
  });
  assert.deepEqual(plain.map(d => d.url), [null, null, null, null], "no failed or empty feed is offered");
  assert.match(plain[0].reason!, /looks like a name/); assert.match(plain[1].reason!, /no items/); assert.match(plain[2].reason!, /refused automated reading \(HTTP 403\)/); assert.match(plain[3].reason!, /redirects to another page/);
  assert.ok(plain.every(d => !/Public API/.test(d.reason!)), "transport wording never reaches the person");
  // A site that links its feed in the page (no alternate link) is still found; other sites' links are not followed.
  assert.deepEqual(feedLinksIn(`<html><a href="/rss/all/">RSS</a><a href="https://other.example.org/feed">x</a><a href="/about">about</a></html>`, "https://news.example.org/"), ["https://news.example.org/rss/all/"]);
});

test("coverage counts topic mentions before generation and stops a brief its sources do not cover", () => {
  const item = (title: string, source: string): HarvestItem => ({ id: title, source: source as HarvestItem["source"], title, url: "https://x.example.org/" + title, score: 0, publishedAt: null, repo: null, summary: "" });
  assert.deepEqual(topicWords(["city housing", "transit", "public health"]), ["city", "housing", "transit", "public", "health"]);
  const items = [item("Council votes on housing bond", "rss"), item("Transit fares rise", "rss"), item("Router library 2.4", "gh-trending"), item("Health department report", "rss")];
  const c = coverage(items, ["city housing", "transit", "public health"]);
  assert.equal(c.total, 4); assert.equal(c.matching, 3); assert.deepEqual(c.bySource, { rss: 3, "gh-trending": 1 });
  assert.equal(coverageProblem(c, ["city housing", "transit", "public health"]), null);
  // Only zero readable coverage holds; one or two matches continue to a shorter edition, not a hold (Sep 17, "no halting ever").
  assert.equal(coverageProblem(coverage(items.slice(0, 1), ["city housing"]), ["city housing"]), null, "a single matching item is enough to continue");
  assert.match(coverageProblem(coverage(items.slice(2), ["city housing"]), ["city housing"])!, /none match your topics/);
  assert.match(coverageProblem(coverage([], ["x"]), ["x"])!, /returned nothing/);
  const dir = mkdtempSync(join(tmpdir(), "harvest-")); try { mkdirSync(join(dir, "h")); writeFileSync(join(dir, "h/2026-09-10.json"), JSON.stringify({ fetchedAt: "", items })); assert.equal(readHarvest(join(dir, "h"), "2026-09-10").length, 4); assert.deepEqual(readHarvest(join(dir, "h"), "2026-09-11"), []); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the civic catalogue matches civic topics only and every entry is a verified HTTPS feed", () => {
  const families = readCatalog(process.cwd());
  assert.ok(families.some(f => f.id === "civic-government"));
  assert.deepEqual(matchCatalog(families, ["city housing", "transit"]).map(f => f.id), ["civic-government"]);
  assert.deepEqual(matchCatalog(families, ["developer tools", "open source"]), []);
  // Jordan's brief (Sep 11): a health beat with no sites of its own gets readable health news, not only journal DOIs.
  assert.deepEqual(matchCatalog(families, ["Clinical AI evidence", "Safe AI adoption"]).map(f => f.id), ["health-medicine"]);
  for (const f of families) for (const feed of f.feeds) assert.match(feed.url, /^https:\/\//);
});
