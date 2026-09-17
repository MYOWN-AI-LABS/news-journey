import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectLiveEditorialSources, type LiveEditorialSourceRequest } from './live-editorial-sources.js';
import type { publicResponse } from '../sources/public-apis.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const date = (offset = 0) => new Date(Date.now() + offset).toISOString();
const prose = (topic = 'football', seed = 'north', n = 10) => Array.from({ length: n }, (_, i) => `The ${seed} ${topic} club described match ${i + 1} arrangements in its published statement, with entry remaining subject to the specified conditions.`).join(' ');
const page = (text: string, published: string | null = date(), extra = '') => `<html><head>${published ? `<meta property="article:published_time" content="${published}">` : ''}${extra}</head><body><article><h1>Example club update</h1><p>${text}</p></article></body></html>`;
function setup(t: { after(fn: () => void): void }, overrides: Partial<LiveEditorialSourceRequest> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'live-editorial-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, runId: 'fresh-edition', topics: ['football'], selectCount: 1, minArticleWords: 50, ...overrides };
}
const requester = (pages: Record<string, string | Response>, calls: string[] = []): typeof publicResponse => async (url, headers, timeout, bytes, method) => {
  calls.push(url); assert.equal(method, 'GET'); assert.ok(timeout > 0 && timeout <= 30000); assert.ok(bytes! <= 5000000);
  assert.ok(headers['User-Agent']);
  const value = pages[url]; if (value === undefined) throw new Error('Source unavailable');
  return typeof value === 'string' ? new Response(value, { headers: { 'content-type': 'text/html' } }) : value;
};

test('fresh explicit slate stores exact raw/full-text hashes and source dates without inherited topics', async t => {
  const request = setup(t, { urls: ['https://sports.example/story'] });
  mkdirSync(join(request.root, 'config')); writeFileSync(join(request.root, 'config/sources.json'), JSON.stringify({ topics: ['Haines City', 'Orlando', 'Tampa'] }));
  const body = page(prose(), date(-3600000)), calls: string[] = [];
  const result = await collectLiveEditorialSources(request, { request: requester({ [request.urls![0]]: body }, calls) });
  assert.equal(result.status, 'complete'); assert.equal(result.publicationReady, false); assert.equal(result.evidenceSelectionStillRequired, true);
  assert.deepEqual(result.topics, ['football']); assert.deepEqual(calls, request.urls);
  const source = result.selected[0]!;
  assert.equal(readFileSync(source.rawPath, 'utf8'), body); assert.equal(source.capture.sha256, hash(body));
  assert.equal(source.capture.textSha256, hash(source.capture.text)); assert.ok(source.capture.text.endsWith('specified conditions.'));
  assert.deepEqual(JSON.parse(readFileSync(source.capturePath, 'utf8')), source.capture);
  assert.deepEqual(JSON.parse(readFileSync(result.manifestPath, 'utf8')), result);
  assert.equal(source.dateBasis, 'article'); assert.notEqual(source.publishedAt, source.capture.observedAt);
  assert.deepEqual(await collectLiveEditorialSources(request, { request: requester({}) }), result, 'complete capture reuse makes no network request');
  assert.equal(readFileSync(source.rawPath, 'utf8'), body);
});

test('stale, future, unavailable, insufficient and unrelated sources are replaced from the same candidate queue', async t => {
  const urls = Array.from({ length: 6 }, (_, i) => `https://sports.example/${i}`), request = setup(t, { urls });
  const result = await collectLiveEditorialSources(request, { request: requester({
    [urls[0]]: page(prose(), date(-100 * 3600000)), [urls[1]]: page(prose(), date(3600000)),
    [urls[2]]: new Response('Gone', { status: 404 }), [urls[3]]: page('Football fixture details.'),
    [urls[4]]: page(prose('gardening')), [urls[5]]: page(prose()),
  }) });
  assert.equal(result.status, 'complete'); assert.equal(result.selected[0]!.url, urls[5]); assert.equal(result.rejections.length, 5);
  assert.match(result.rejections.map(row => row.reason).join('\n'), /stale or in the future[\s\S]*Inadequate[\s\S]*supplied topics/);
});

test('RSS uses the shared public transport, preserves raw feed, and a fresh feed cannot conceal an old article', async t => {
  const feed = 'https://sports.example/feed', old = 'https://sports.example/a-old', next = 'https://sports.example/b-next';
  const xml = `<rss version="2.0"><channel><title>Club updates</title><link>https://sports.example</link><description>Updates</description>${[old, next].map(url => `<item><title>Football update</title><link>${url}</link><pubDate>${date()}</pubDate><description>Football rules</description></item>`).join('')}</channel></rss>`;
  const request = setup(t, { feeds: [feed, feed], urls: [next] });
  const result = await collectLiveEditorialSources(request, { request: requester({ [feed]: xml, [old]: page(prose(), date(-100 * 3600000)), [next]: page(prose(), null) }) });
  assert.equal(result.status, 'complete'); assert.equal(result.selected[0]!.dateBasis, 'feed'); assert.ok(result.selected[0]!.feedPublishedAt);
  assert.equal(result.selected[0]!.capture.publishedAt, null, 'observation remains distinct from feed publication metadata');
  assert.equal(result.requests, 2, 'duplicate feed is fetched once; explicit URL retains its feed date');
  const second = await collectLiveEditorialSources({ ...request, runId: 'feed-replacement', urls: [] }, { request: requester({ [feed]: xml, [old]: page(prose(), date(-100 * 3600000)), [next]: page(prose('football', 'south'), null) }) });
  assert.equal(second.selected[0]!.url, next); assert.match(second.rejections[0]!.reason, /stale/);
  assert.equal(readFileSync(join(request.root, 'workdir/live-editorial-sources/feed-replacement', `feed-${hash(feed).slice(0, 20)}.raw`), 'utf8'), xml);
});

test('missing or conflicting article dates are not invented and article JSON-LD datePublished is supported', async t => {
  const urls = ['https://news.example/a', 'https://news.example/b', 'https://news.example/c'];
  const metadata = `<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'NewsArticle', datePublished: date() }] })}</script>`;
  const result = await collectLiveEditorialSources(setup(t, { urls }), { request: requester({
    [urls[0]]: page(prose(), null), [urls[1]]: page(prose(), date(-2 * 86400000), metadata), [urls[2]]: page(prose(), null, metadata),
  }) });
  assert.equal(result.status, 'complete'); assert.equal(result.selected[0]!.url, urls[2]); assert.equal(result.selected[0]!.dateBasis, 'article');
  assert.match(result.rejections[0]!.reason, /No reliable/); assert.match(result.rejections[1]!.reason, /conflicting/);
});

test('whole-article capacity holds preserve complete text and try smaller replacements without truncating conditions', async t => {
  const urls = ['https://sports.example/a', 'https://sports.example/b'];
  const result = await collectLiveEditorialSources(setup(t, { urls, maxPacketChars: 2000 }), { request: requester({ [urls[0]]: page(prose('football', 'north', 30)), [urls[1]]: page(prose('football', 'south', 5)) }) });
  assert.equal(result.status, 'complete'); assert.equal(result.selected[0]!.url, urls[1]); assert.match(result.rejections[0]!.reason, /capacity/);
  const capture = JSON.parse(readFileSync(join(result.manifestPath, '..', `article-${hash(urls[0]).slice(0, 20)}.capture.json`), 'utf8'));
  assert.ok(capture.text.includes('match 30 arrangements')); assert.ok(capture.text.endsWith('specified conditions.'));
});

test('collection adds complete distinct sources to reach an evidence-word floor and does not count syndicated copies twice', async t => {
  const urls = ['https://sports.example/a', 'https://sports.example/b', 'https://sports.example/c'];
  const a = page(prose('football', 'north', 5)), c = page(prose('football', 'south', 5));
  const result = await collectLiveEditorialSources(setup(t, { urls, minEvidenceWords: 200 }), { request: requester({ [urls[0]]: a, [urls[1]]: a, [urls[2]]: c }) });
  assert.equal(result.status, 'complete'); assert.equal(result.selected.length, 2); assert.ok(result.evidenceWords >= 200);
  assert.match(result.rejections[0]!.reason, /Same complete source text/);
});

test('bounded candidate exhaustion returns saved incomplete progress instead of fabricating missing evidence', async t => {
  const urls = ['https://sports.example/a', 'https://sports.example/b'];
  const calls: string[] = [], result = await collectLiveEditorialSources(setup(t, { urls, maxCandidates: 1 }), { request: requester({}, calls) });
  assert.equal(result.status, 'incomplete'); assert.equal(calls.length, 1); assert.equal(result.selected.length, 0);
  assert.match(result.reason!, /0\/1/); assert.equal(JSON.parse(readFileSync(result.manifestPath, 'utf8')).status, 'incomplete');
});

test('unsafe URLs and escaped workspace paths never reach transport', async t => {
  let calls = 0; const download: typeof publicResponse = async () => { calls++; throw new Error('Unexpected request'); };
  const request = setup(t);
  for (const url of ['https://127.0.0.1/secret', 'http://news.example/article', 'https://user:secret@news.example/article']) await assert.rejects(collectLiveEditorialSources({ ...request, urls: [url] }, { request: download }), /HTTPS|private|credentials/);
  await assert.rejects(collectLiveEditorialSources({ ...request, runId: '../escape', urls: ['https://news.example/article'] }, { request: download }), /identifier/);
  const other = setup(t).root; mkdirSync(join(request.root, 'workdir')); symlinkSync(other, join(request.root, 'workdir/live-editorial-sources'));
  await assert.rejects(collectLiveEditorialSources({ ...request, urls: ['https://news.example/article'] }, { request: download }), /Symlink/);
  assert.equal(calls, 0);
});

test('a late response consumes the original deadline, remains captured and cannot trigger another candidate', async t => {
  const start = Date.now(); let clock = start, calls = 0;
  const request = setup(t, { urls: ['https://news.example/a', 'https://news.example/b'], deadlineMs: 1000 });
  const result = await collectLiveEditorialSources(request, { now: () => clock, request: async () => { calls++; clock += 1001; return new Response(page(prose())); } });
  assert.equal(calls, 1); assert.equal(result.status, 'incomplete'); assert.equal(result.selected.length, 0);
  assert.equal(result.deadlineAt, new Date(start + 1000).toISOString()); assert.equal(result.requests, 1);
  await assert.rejects(collectLiveEditorialSources(request, { request: requester({}) }), /did not complete/);
});

test('verified complete reuse rejects changed input, stale publication and tampered raw or extracted text', async t => {
  const url = 'https://sports.example/article', request = setup(t, { urls: [url] });
  const result = await collectLiveEditorialSources(request, { request: requester({ [url]: page(prose()) }) });
  await assert.rejects(collectLiveEditorialSources({ ...request, topics: ['politics'] }, { request: requester({}) }), /inputs/);
  await assert.rejects(collectLiveEditorialSources(request, { now: () => Date.now() + 100 * 3600000, request: requester({}) }), /no longer fresh/);
  const rawPath = result.selected[0]!.rawPath, original = readFileSync(rawPath);
  writeFileSync(rawPath, 'altered source');
  await assert.rejects(collectLiveEditorialSources(request, { request: requester({}) }), /raw source/);
  writeFileSync(rawPath, original);
  const capturePath = result.selected[0]!.capturePath, capture = JSON.parse(readFileSync(capturePath, 'utf8'));
  writeFileSync(capturePath, JSON.stringify({ ...capture, text: 'invented content' }));
  await assert.rejects(collectLiveEditorialSources(request, { request: requester({}) }), /capture changed/);
});

test('headlines, RSS snippets and article footers alone cannot establish body relevance', async t => {
  const url = 'https://sports.example/article';
  const html = page(prose('gardening')).replace('Example club update', 'Football update').replace('</article>', '<footer>More football reports</footer></article>');
  const result = await collectLiveEditorialSources(setup(t, { urls: [url] }), { request: requester({ [url]: html }) });
  assert.equal(result.status, 'incomplete'); assert.match(result.rejections[0]!.reason, /supplied topics/);
});

test('a full short slate can replace one whole article to meet the original evidence floor', async t => {
  const urls = ['https://sports.example/a', 'https://sports.example/b', 'https://sports.example/c'];
  const result = await collectLiveEditorialSources(setup(t, { urls, selectCount: 2, maxSelected: 2, minEvidenceWords: 300 }), { request: requester({
    [urls[0]]: page(prose('football', 'north', 5)), [urls[1]]: page(prose('football', 'south', 5)), [urls[2]]: page(prose('football', 'east', 12)),
  }) });
  assert.equal(result.status, 'complete'); assert.equal(result.selected.length, 2); assert.ok(result.evidenceWords >= 300);
  assert.ok(result.selected.some(source => source.url === urls[2])); assert.match(result.rejections[0]!.reason, /Replaced this whole article/);
  const preserved = JSON.parse(readFileSync(join(result.manifestPath, '..', `article-${hash(urls[0]).slice(0, 20)}.capture.json`), 'utf8'));
  assert.ok(preserved.text.includes('north football club')); assert.ok(preserved.text.endsWith('specified conditions.'));
});
