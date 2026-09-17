import test from "node:test";
import assert from "node:assert/strict";
import { fetchRss, normalizeFeeds, parseFeedDate, textOf } from "./rss.js";

test("ExampleTester's healthcare feed shapes preserve exact titles, dates and readable summaries", async () => {
  const today = new Date();
  const uncommon = `${today.toLocaleString("en-US", { month: "short" })} ${today.getDate()}, ${today.getFullYear()} 10:17am`;
  assert.ok(parseFeedDate(uncommon));
  assert.equal(parseFeedDate("not a date"), null);
  assert.equal(textOf({ a: [{ $: { href: "https://wrong.example" }, _: "Real headline" }] }), "Real headline");
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Healthcare</title><link>https://health.example</link><description>News</description>
  <item><title><a href="https://wrong.example">Real headline</a></title><link>https://health.example/story-one</link><pubDate>${uncommon}</pubDate><description>Evidence first</description></item>
  <item><title>&lt;![CDATA[An evidence update]]&gt;</title><link>https://health.example/story-two</link><pubDate>${today.toUTCString()}</pubDate><description>&lt;![CDATA[Useful &lt;b&gt;results&lt;/b&gt;]]&gt;</description></item>
  <item><title>Unusable date</title><link>https://health.example/old</link><pubDate>unknown</pubDate></item></channel></rss>`;
    const url = "https://health.example/feed";
    const items = await fetchRss([url], 96, async (target, headers, timeoutMs, maxBytes) => {
      assert.equal(target, url);
      assert.equal(timeoutMs, 15_000);
      assert.equal(maxBytes, 5_000_000);
      assert.match(headers['User-Agent'], /Content-Harness/);
      return new Response(xml, { headers: { 'content-type': 'application/rss+xml' } });
    });
    assert.equal(items.length, 2);
    assert.deepEqual(items.map(i => i.title), ["Real headline", "An evidence update"]);
    assert.equal(items[1].summary, "Useful results");
    assert.equal(items[0].url, "https://health.example/story-one");
    assert.ok(items.every(i => i.publishedAt && !Number.isNaN(Date.parse(i.publishedAt))));
    assert.equal(normalizeFeeds([{ name: "Named feed", url }])[0].name, "Named feed");
    assert.throws(() => normalizeFeeds(["file:///secret"]));
});

test("RSS refresh rejects private, credentialed and non-HTTPS feeds before transport", async () => {
  let calls = 0;
  const download = async () => { calls++; throw new Error("Unsafe feed reached transport"); };
  for (const url of [
    "http://news.example/feed", "https://127.0.0.1/feed", "https://127.1/feed",
    "https://[::1]/feed", "https://[::ffff:127.0.0.1]/feed", "https://169.254.169.254/feed",
    "https://10.0.0.1/feed", "https://news.internal/feed", "https://user:secret@news.example/feed", "file:///secret",
  ]) await assert.rejects(fetchRss([url], 72, download), /HTTPS|private or local|credentials/);
  assert.equal(calls, 0);
});

test("RSS refresh holds failed public-DNS, redirect and oversized responses without a parser retry", async () => {
  const url = "https://news.example/feed";
  let calls = 0;
  for (const problem of ["Public API DNS resolved to a private or local address", "Public API HTTP 302; redirects are not followed", "Public response exceeds 5000000 bytes"]) {
    assert.deepEqual(await fetchRss([url], 72, async () => { calls++; throw new Error(problem); }), []);
  }
  assert.deepEqual(await fetchRss([url], 72, async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  }), []);
  assert.equal(calls, 4);
});
