import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkCorroboration, queryPhrase, sourceTier, gdeltEvidence } from './credibility.js';

test('a rate-limited service is not retried for each story, while cached evidence remains usable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'corroboration-'));
  const cachePath = join(dir, 'cache.json');
  const items = [
    { title: 'Riverdale Council releases public records', url: 'https://example.org/a' },
    { title: 'Eastford Transit launches route review', url: 'https://example.org/b' },
    { title: 'Northfield Hospital opens research center', url: 'https://example.org/c' },
  ];
  const key = `v2:3d:${queryPhrase(items[2].title).toLowerCase()}`;
  writeFileSync(cachePath, JSON.stringify({ [key]: { at: new Date().toISOString(), state: 'observed', domains: 3, articles: 4, clusters: 2 } }));
  let calls = 0;
  try {
    const result = await checkCorroboration(items, { cachePath, pauseMs: 0, lookup: async title => {
      calls++; return { state: 'rate_limited', domainCount: null, articleCount: null, storyClusterCount: null, lowerBound: false, query: title, observedAt: new Date().toISOString() };
    } });
    assert.equal(calls, 1);
    assert.equal(result[0].domains, null); assert.equal(result[1].domains, null);
    assert.equal(result[2].domains, 3, 'a service outage must not discard valid cached evidence');
    assert.equal(result.length, items.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('sports and general-news publishers have established provenance without treating lookalikes as trusted', () => {
  for (const host of ['www.bbc.co.uk', 'www.bbc.com', 'theguardian.com', 'apnews.com', 'www.nbcsports.com', 'www.skysports.com', 'abcnews.go.com', 'www.cbsnews.com']) {
    assert.deepEqual(sourceTier(`https://${host}/story`), { tier: 'established', weight: 0.9 });
  }
  for (const host of ['bbc.co.uk.example.org', 'fakebbc.com', 'theguardian.com.example.org', 'apnews.com.evil.test']) assert.equal(sourceTier(`https://${host}/story`).tier, 'unknown');
});
test('stalled GDELT headers and response bodies are cancelled at the same deadline', async () => {
  for (const stage of ['headers', 'body']) {
    let aborted = false, cancelled = false;
    const request: typeof fetch = async (_url, options) => {
      options?.signal?.addEventListener('abort', () => { aborted = true; });
      if (stage === 'headers') return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } }));
    };
    const start = Date.now(), result = await gdeltEvidence('Riverdale Council record', { request, deadline: start + 25 });
    assert.equal(result.state, 'unavailable'); assert.equal(result.domainCount, null); assert.equal(aborted, true);
    if (stage === 'body') assert.equal(cancelled, true, 'Deadline cancels the actual body reader');
    assert.ok(Date.now() - start < 500, 'Optional lookup must not wait for a hung transport');
  }
});
test('rate-limit backoff cannot outlive the shared lookup budget and counts stay unknown', async () => {
  let calls = 0; const start = Date.now();
  const result = await gdeltEvidence('Riverdale Council record', { deadline: start + 25, backoffMs: 1000, request: async () => {
    calls++; return new Response('limit requests', { status: 429 });
  } });
  assert.equal(calls, 1); assert.equal(result.state, 'rate_limited'); assert.equal(result.domainCount, null);
  assert.ok(Date.now() - start < 500);
});
test('one budget includes pacing across the whole shortlist and unavailable coverage has neutral weight', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'corroboration-deadline-')), deadlines: number[] = [];
  const items = ['Riverdale Council', 'Eastford Transit', 'Northfield Hospital', 'Southbank Agency', 'Westfield Library'].map(title => ({ title, url: 'https://www.bbc.com/news/story' }));
  try {
    const start = Date.now();
    const result = await checkCorroboration(items, { cachePath: join(dir, 'cache.json'), budgetMs: 45, pauseMs: 20, lookup: async (title, options) => {
      deadlines.push(options!.deadline!); await new Promise(resolve => setTimeout(resolve, 10));
      return { state: 'unavailable', domainCount: null, articleCount: null, storyClusterCount: null, lowerBound: false, query: title, observedAt: new Date().toISOString() };
    } });
    assert.ok(deadlines.length >= 1 && deadlines.length <= 2); assert.equal(new Set(deadlines).size, 1, 'Every query gets the same original deadline');
    assert.equal(result.length, items.length); assert.ok(result.every(row => row.state === 'unavailable' && row.domains === null && row.weight === 0.9));
    assert.ok(Date.now() - start < 500);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('a malformed successful coverage response cannot masquerade as observed zero coverage', async () => {
  const result = await gdeltEvidence('Riverdale Council record', { request: async () => new Response('{}') });
  assert.equal(result.state, 'unavailable'); assert.equal(result.domainCount, null);
});
