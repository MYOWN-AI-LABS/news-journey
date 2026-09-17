import { load } from 'cheerio';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { evidenceDates, verifiedWebSources, isActivitiesBrief, sourceDay, sourceSearchQueries, interleaveResults, newsSearchUrls, sourceExcerpts, selectedSourceExcerpts, searchPublicSourceUrls, readWebSource, readableWebText, pagePublicationDate } from './sources/web-discovery.js';
import { normalizeUrl } from './util.js';
import { coverage, coverageProblem } from './sources/coverage.js';
import type { HarvestItem } from './types.js';

test('source capture hashes complete response bytes and marks clipped extracted text', async () => {
  const text = 'The original report preserves its stated dates, limitations and source attribution. '.repeat(3).trim();
  const html = `<html><head><meta name="date" content="2026-09-14T00:00:00Z"></head><body><nav>Unrelated</nav><article>${text}</article></body></html>`;
  let calls = 0;
  const page = await readWebSource('https://news.example.org/source', async (url, headers, timeout, cap) => {
    calls++; assert.equal(url, 'https://news.example.org/source'); assert.equal(timeout, 15000); assert.equal(cap, 3_000_000);
    return new Response(html);
  });
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  assert.equal(calls, 1); assert.equal(page.text, text); assert.equal(page.sha256, hash(html)); assert.equal(page.textSha256, hash(text));
  assert.equal(page.bytes, Buffer.byteLength(html)); assert.equal(page.complete, true); assert.equal(page.truncated, false);
  assert.ok(Number.isFinite(Date.parse(page.observedAt))); assert.equal(page.publishedAt, '2026-09-14T00:00:00.000Z');
  const full = 'Complete fact. '.repeat(5000).trim();
  const clipped = await readWebSource('https://news.example.org/long', async () => new Response(`<article>${full}</article>`));
  assert.equal(clipped.text.length, 60000); assert.equal(clipped.complete, false); assert.equal(clipped.truncated, true);
  assert.equal(clipped.textSha256, hash(full)); assert.notEqual(clipped.textSha256, hash(clipped.text));
  await assert.rejects(readWebSource('https://news.example.org/error', async () => new Response(html, { status: 503 })), /HTTP 503/);
  await assert.rejects(readWebSource('https://news.example.org/partial', async () => new Response(html, { status: 206 })), /incomplete/);
  await assert.rejects(readWebSource('https://news.example.org/partial', async () => new Response(html, { headers: { 'Content-Range': 'bytes 0-100/900' } })), /incomplete/);
  await assert.rejects(readWebSource('https://news.example.org/oversized', async () => new Response('x'.repeat(3_000_001))), /exceeds 3000000 bytes/);
});

test('research publication metadata rejects rolled calendar dates and never substitutes capture time', async () => {
  for (const [value, expected] of [
    ['2024-02-29T19:20:30-04:00', '2024-02-29T23:20:30.000Z'],
    ['2026-09-08', '2026-09-08T00:00:00.000Z'],
    ['2026-02-30', null], ['2025-02-29T12:00:00Z', null], ['2026-09-08T24:00:00Z', null], ['today', null], ['', null],
  ] as const) {
    const html = `<head><meta property="article:published_time" content="${value}"></head><article>${'The report preserves its source facts and explicitly stated limitations. '.repeat(3)}</article>`;
    const page = await readWebSource('https://news.example.org/dates', async () => new Response(html));
    assert.equal(page.publishedAt, expected);
    assert.equal(page.sha256, createHash('sha256').update(html).digest('hex'));
    assert.ok(Number.isFinite(Date.parse(page.observedAt)));
  }
});

test('source extraction retains article-internal headers and footer qualifications', async () => {
  const page = await readWebSource('https://news.example.org/study', async () => new Response('<body><header>Account menu</header><article><header>Preliminary simulation study.</header><p>The team tested a virtual route using simulated sensors and a constrained mathematical representation of the site, according to the report.</p><footer>These are simulations, not physical trials.</footer></article><footer>Site navigation</footer></body>'));
  assert.ok(page.text.startsWith('Preliminary simulation study.\nThe team'));
  assert.ok(page.text.endsWith('These are simulations, not physical trials.'));
  assert.ok(!page.text.includes('Account menu') && !page.text.includes('Site navigation'));
  assert.equal(page.complete, true); assert.equal(page.status, 200);
});

test('readable source text preserves generic block boundaries without turning HTML indentation into source breaks', () => {
  const html = '<article><header><div>Reporter Name</div><div>Share Mail Copy link</div></header><p>The study\n  reports <strong>simulated</strong> results\n only.</p><p>The interface labels its button "Copy link"; this sentence describes the interface.</p><footer>No physical\n trials were conducted.</footer></article>';
  assert.equal(readableWebText(html), 'Reporter Name\nShare Mail Copy link\nThe study reports simulated results only.\nThe interface labels its button "Copy link"; this sentence describes the interface.\nNo physical trials were conducted.');
  assert.equal(readableWebText('<main><p>An inline <em>qualification</em> stays with its statement.</p><div>Another block contains a complete factual statement.</div></main>'), 'An inline qualification stays with its statement.\nAnother block contains a complete factual statement.');
  assert.equal(readableWebText('<article><p>The first game begins on <time datetime="2026-10-03">October 3</time> at 9 a.m., subject to venue confirmation.</p></article>'), 'The first game begins on October 3 at 9 a.m., subject to venue confirmation.');
});

test('local news discovery selects exact code-owned excerpts and real external article links', () => {
  const links = newsSearchUrls('<a class="news_fbwcard" href="https://news.example.org/article">Report</a><a class="title" href="https://news.example.org/article">Duplicate</a><a class="title" href="https://www.bing.com/account">Login</a><a class="title" href="https://127.0.0.1/private">Private</a><a href="https://ads.example.org">Advertisement</a>');
  assert.deepEqual(links, ['https://news.example.org/article']);
  const pages = Array.from({ length: 3 }, (_, i) => ({ url: `https://news.example.org/report-${i}`, text: `Sports report ${i}: the team's final match ended with a narrow victory after an overtime goal.`, publishedAt: '2026-09-14T00:00:00Z' }));
  const excerpts = sourceExcerpts(pages, ['Sports']);
  const picked = { sources: excerpts.map(e => ({ excerptId: e.id, title: 'Final match result reported', eventDate: null, location: null })) };
  const selected = selectedSourceExcerpts(picked, excerpts, pages, 'Current sports news', '2026-09-14');
  assert.deepEqual(selected.map(s => s.evidence), pages.map(p => p.text));
  assert.deepEqual(selected.map(s => s.url), pages.map(p => p.url));
  assert.throws(() => selectedSourceExcerpts({ sources: picked.sources.map(s => ({ ...s, excerptId: '99:1' })) }, excerpts, pages, 'sports', '2026-09-14'), /supplied sources/);
  assert.throws(() => selectedSourceExcerpts({ sources: [picked.sources[0], picked.sources[0], picked.sources[2]] }, excerpts, pages, 'sports', '2026-09-14'), /unique fetched URL/);
  assert.throws(() => selectedSourceExcerpts(picked, excerpts, pages.map(p => ({ ...p, text: 'Changed source page' })), 'sports', '2026-09-14'), /exact excerpt/);
  assert.ok(sourceExcerpts([{ ...pages[0], text: 'x'.repeat(25000) }], []).every(e => e.text.length <= 750));
});

test('local source search falls back to RSS after a news transport failure without changing the query', async () => {
  const calls: string[] = [], query = 'current events in sports sports news 2026';
  const sources = await searchPublicSourceUrls(query, false, async url => {
    calls.push(url);
    assert.equal(new URL(url).searchParams.get('q'), query);
    if (url.includes('/news/search')) throw new Error('fixture news timeout');
    return new Response('<rss><channel><item><link>https://sports.example.org/report</link></item></channel></rss>');
  });
  assert.deepEqual(sources, ['https://sports.example.org/report']); assert.equal(calls.length, 2);
  calls.length = 0;
  assert.deepEqual(await searchPublicSourceUrls(query, false, async url => { calls.push(url); return new Response('<a class="title" href="https://sports.example.org/current">Article</a>'); }), ['https://sports.example.org/current']);
  assert.equal(calls.length, 1, 'successful news search does not make an extra RSS request');
});

test('bounded activity excerpts retain upcoming full dates behind long topic-heavy calendar text', () => {
  const today = '2026-09-14', brief = 'Upcoming activities in Haines City, Orlando and Tampa.';
  const topics = ['Haines City activities', 'Orlando activities', 'Tampa activities', 'Family activities', 'Arts culture', 'Outdoor recreation'];
  const intro = 'Haines City Orlando Tampa family activities arts culture outdoor recreation. '.repeat(45);
  const pages = ['Haines City', 'Orlando', 'Tampa'].map((location, i) => ({ url: `https://events.example.org/${i}`, text: intro + `${location}: Painting workshop on September 16, 2026 at the public library. Adults and children may attend a guided session.`, publishedAt: null }));
  const excerpts = sourceExcerpts(pages, topics, brief, today);
  const selected = pages.map((page, i) => ({ excerptId: excerpts.find(e => e.url === page.url && evidenceDates(e.text).includes('2026-09-16'))!.id, title: 'Community painting workshop', eventDate: '2026-09-16', location: ['Haines City', 'Orlando', 'Tampa'][i] }));
  assert.equal(selectedSourceExcerpts({ sources: selected }, excerpts, pages, brief, today).length, 3);
  assert.equal(excerpts.length, 9); assert.ok(excerpts.every(e => e.text.length <= 1000));
  const archived = pages.map(page => ({ ...page, text: page.text.replace('September 16, 2026', 'September 16, 2024') }));
  assert.throws(() => selectedSourceExcerpts({ sources: selected }, sourceExcerpts(archived, topics, brief, today), archived, brief, today), /full event date/);
});

test('verified sports reporting survives umbrella-topic checks and is not treated as an upcoming event', () => {
  const sources = ['Formula One race result', 'Formula Three championship', 'La Vuelta cycling report'].map((title, i) => ({
    url: `https://example.org/report/${i}`, title,
    evidence: `${title}: the winner crossed the finish line on 13/09/2026 after a close contest.`,
    eventDate: '2026-09-13', location: 'Madrid',
  }));
  const pages = sources.map(s => ({ url: s.url, text: s.evidence, publishedAt: '2026-09-13T20:00:00Z' }));
  const verified = verifiedWebSources({ sources }, pages, 'Current sports news.', '2026-09-13');
  assert.ok(verified.every(s => s.eventDate === null && s.location === null));
  const items: HarvestItem[] = verified.map((s, i) => ({ id: String(i), url: s.url, title: s.title, summary: s.evidence, source: 'web:example.org', publishedAt: s.publishedAt, score: 0, repo: null }));
  assert.equal(coverage(items, ['Sports news']).matching, 0);
  assert.equal(coverageProblem(coverage(items, ['Sports news'], verified), ['Sports news']), null);
  assert.equal(coverage(items.slice(0, 2), ['Sports news'], verified).matching, 2, 'a failed fetch cannot count as a retained source');
  assert.equal(coverage(items.map(s => ({ ...s, summary: 'Changed page content' })), ['Sports news'], verified).matching, 0, 'a URL alone is insufficient');
});

test('activity sources require actual upcoming dates and requested places in fetched event evidence', () => {
  const today = '2026-09-13', brief = 'Weekly activities in Haines City, Orlando and Tampa.';
  const sources = ['Haines City', 'Orlando', 'Tampa'].map((location, i) => ({ url: `https://example.org/events/${i}`, title: `${location} community art workshop`, evidence: `${location} community art workshop, September 14, 2026 at 10 am. Meet at the library for a guided painting session.`, eventDate: '2026-09-14', location }));
  const pages = sources.map(s => ({ url: s.url, text: 'Event calendar. ' + s.evidence, publishedAt: null }));
  assert.equal(verifiedWebSources({ sources }, pages, brief, today).length, 3);
  const archived = sources.map(s => ({ ...s, evidence: s.evidence.replace('2026', '2024') }));
  assert.throws(() => verifiedWebSources({ sources: archived }, archived.map(s => ({ url: s.url, text: s.evidence, publishedAt: null })), brief, today), /full event date/);
  assert.throws(() => verifiedWebSources({ sources: sources.map(s => ({ ...s, eventDate: '2026-10-01' })) }, pages, brief, today), /next seven days/);
  assert.throws(() => verifiedWebSources({ sources: sources.map(s => ({ ...s, evidence: s.evidence + ' Free admission.' })) }, pages, brief, today), /exact excerpt/);
  assert.throws(() => verifiedWebSources({ sources: [sources[0], sources[0], sources[2]] }, pages, brief, today), /unique fetched URL/);
  assert.throws(() => verifiedWebSources({ sources }, pages, 'Weekly activities in Boston.', today), /named place/);
  assert.equal(isActivitiesBrief(brief), true); assert.equal(isActivitiesBrief('City government budget news'), false);
});

test('date evidence rejects missing years and impossible dates', () => {
  assert.deepEqual(evidenceDates('Sep. 14, 2026; September 14th 2026; 2026-09-14; 09/14/2026'), ['2026-09-14']);
  assert.deepEqual(evidenceDates('September 14; February 30, 2026; 2026-02-30; 13/01/2026'), []);
  assert.equal(sourceDay(new Date('2026-09-14T01:00:00Z')), '2026-09-13');
});

test('public discovery queries retain the brief geography and allocate results across queries', () => {
  const queries = sourceSearchQueries('Activities in Haines City, Orlando and Tampa.', ['Family activities', 'Arts and culture', 'Outdoor recreation'], '2026-09-13');
  assert.equal(queries.length, 3); for (const q of queries) { assert.match(q, /Haines City, Orlando and Tampa/); assert.match(q, /2026-09/); }
  assert.deepEqual(interleaveResults([['a','b','c'],['a','d','e'],['f','g']], 5), ['a','f','b','d','g']);
});

test('different calendar event identifiers stay distinct through ranking and deduplication', () => {
  const first = 'https://example.org/Calendar.aspx?EID=7536&month=9&year=2026&utm_source=feed';
  assert.equal(normalizeUrl(first), normalizeUrl('https://example.org/Calendar.aspx?EID=7536&view=list'));
  assert.notEqual(normalizeUrl(first), normalizeUrl('https://example.org/Calendar.aspx?EID=7556&month=9'));
  assert.equal(normalizeUrl('https://example.org/story?utm_source=x#section'), 'https://example.org/story');
  assert.equal(normalizeUrl('https://example.org/event/?id=1'), normalizeUrl('https://example.org/event?id=1'));
});

test('page publication date prefers article meta, then JSON-LD datePublished, and ignores broken JSON-LD', () => {
  assert.equal(pagePublicationDate(load('<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-09-16T16:57:52.746Z"}</script>')), '2026-09-16T16:57:52.746Z');
  assert.equal(pagePublicationDate(load('<meta property="article:published_time" content="2026-09-15T08:00:00Z"><script type="application/ld+json">{"datePublished":"2026-09-16T16:57:52Z"}</script>')), '2026-09-15T08:00:00.000Z');
  assert.equal(pagePublicationDate(load('<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"NewsArticle","datePublished":"2026-09-14"}]}</script>')), '2026-09-14T00:00:00.000Z');
  assert.equal(pagePublicationDate(load('<script type="application/ld+json">{not json</script><p>Published 2 hours ago</p>')), null);
});
