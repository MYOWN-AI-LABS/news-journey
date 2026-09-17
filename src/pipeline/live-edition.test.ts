import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyPreparedLiveEvidence } from './live-edition.js';
import { readableWebText } from '../sources/web-discovery.js';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const day = '2026-09-15', brief = 'Review the captured article.';
function fixture(published: string | null = '2026-09-14T17:00:00Z') {
  const root = mkdtempSync(join(tmpdir(), 'prepared-live-source-'));
  const html = `<html><head>${published ? `<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', datePublished: published })}</script>` : ''}</head><body><article><h1>Sports bulletin</h1><p>The club announced a conditional review.</p></article></body></html>`;
  const text = readableWebText(html), rawPath = join(root, 'article.raw'), capturePath = join(root, 'article.capture.json');
  const source = { id: 'source1', url: 'https://example.org/story', publishedAt: published, capturedAt: '2026-09-15T06:00:00.000Z', text, textSha256: sha(text), rawSha256: sha(html) };
  const receipt = { url: source.url, status: 200, bytes: Buffer.byteLength(html), sha256: source.rawSha256, text, textSha256: source.textSha256, observedAt: source.capturedAt, publishedAt: null };
  writeFileSync(rawPath, html); writeFileSync(capturePath, JSON.stringify(receipt));
  const supplied = { input: { day, brief, stories: [{ id: 'story1', headline: 'Sports bulletin', primaryUrl: source.url, sources: [source] }] }, captures: [{ sourceId: source.id, url: source.url, rawPath }] };
  return { root, supplied, source, receipt, rawPath, capturePath, close: () => rmSync(root, { recursive: true, force: true }) };
}
test('import binds source URL, observation, complete text and JSON-LD publication to original receipt', () => {
  const f = fixture('2026-09-14T17:00:00.123000Z');
  try {
    assert.deepEqual(verifyPreparedLiveEvidence(f.root, f.supplied, { day, brief }), f.supplied.input);
    for (const field of ['url', 'capturedAt', 'publishedAt', 'text'] as const) {
      const changed = structuredClone(f.supplied), source = changed.input.stories[0]!.sources[0]!;
      if (field === 'url') { source.url = 'https://another.example.org/story'; changed.captures[0]!.url = source.url; }
      else if (field === 'capturedAt') source.capturedAt = '2026-09-15T07:00:00.000Z';
      else if (field === 'publishedAt') source.publishedAt = '2026-09-15T17:00:00Z';
      else { source.text += ' The review succeeded.'; source.textSha256 = sha(source.text); }
      assert.throws(() => verifyPreparedLiveEvidence(f.root, changed, { day, brief }), /does not match/);
    }
  } finally { f.close(); }
});
test('supplemental receipt wrapper is verified and unknown publication stays unknown', () => {
  const f = fixture(null);
  try {
    writeFileSync(f.capturePath, JSON.stringify({ rawPath: f.rawPath, rawSha256: f.source.rawSha256, capture: f.receipt }));
    assert.equal(verifyPreparedLiveEvidence(f.root, f.supplied, { day, brief }).stories[0]!.sources[0]!.publishedAt, null);
    writeFileSync(f.capturePath, JSON.stringify({ ...f.receipt, status: 403 }));
    assert.throws(() => verifyPreparedLiveEvidence(f.root, f.supplied, { day, brief }), /original capture receipt/);
  } finally { f.close(); }
});
test('feed fallback needs the original selection and unchanged raw feed item publication', () => {
  const f = fixture(null);
  try {
    f.source.publishedAt = '2026-09-14T17:00:00Z';
    const feedPath = join(f.root, 'feed.raw'), xml = `<rss><channel><item><link>${f.source.url}</link><pubDate>Mon, 14 Sep 2026 17:00:00 GMT</pubDate></item></channel></rss>`;
    const receipt = JSON.stringify({ url: 'https://example.org/feed', status: 200, sha256: sha(xml) });
    writeFileSync(feedPath, xml); writeFileSync(feedPath + '.json', receipt);
    const manifest = { status: 'complete', selected: [{ url: f.source.url, rawPath: f.rawPath, dateBasis: 'feed', capture: f.receipt, publishedAt: f.source.publishedAt, feedPublishedAt: f.source.publishedAt }], rawCaptures: [{ stage: 'feed', path: feedPath, sha256: sha(xml), receiptHash: sha(receipt), url: 'https://example.org/feed' }] };
    const manifestPath = join(f.root, 'selected-sources.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.equal(verifyPreparedLiveEvidence(f.root, f.supplied, { day, brief }).stories.length, 1);
    f.source.publishedAt = '2026-09-15T17:00:00Z'; manifest.selected[0]!.publishedAt = f.source.publishedAt; manifest.selected[0]!.feedPublishedAt = f.source.publishedAt;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => verifyPreparedLiveEvidence(f.root, f.supplied, { day, brief }), /publication date does not match/);
  } finally { f.close(); }
});
test('changed raw bytes, duplicate mappings and symlinked receipts cannot supply original evidence', () => {
  const f = fixture();
  try {
    f.supplied.captures.push(f.supplied.captures[0]!);
    assert.throws(() => verifyPreparedLiveEvidence(f.root, f.supplied, { day, brief }), /unique original/); f.supplied.captures.pop();
    const backup = join(f.root, 'capture-original.json'); writeFileSync(backup, JSON.stringify(f.receipt)); rmSync(f.capturePath); symlinkSync(backup, f.capturePath);
    assert.throws(() => verifyPreparedLiveEvidence(f.root, f.supplied, { day, brief }), /regular file/); rmSync(f.capturePath); writeFileSync(f.capturePath, JSON.stringify(f.receipt));
    writeFileSync(f.rawPath, '<p>Different article.</p>');
    assert.throws(() => verifyPreparedLiveEvidence(f.root, f.supplied, { day, brief }), /original capture receipt/);
  } finally { f.close(); }
});

test('original numeric timezone offsets and raw.html capture filenames keep their receipt binding', () => {
  const f = fixture('2026-09-14T17:00:00-0400');
  try {
    renameSync(f.rawPath, f.rawPath + '.html'); f.supplied.captures[0]!.rawPath = f.rawPath + '.html';
    f.source.publishedAt = '2026-09-14T21:00:00.000Z';
    assert.equal(verifyPreparedLiveEvidence(f.root, f.supplied, { day, brief }).stories.length, 1);
    writeFileSync(f.capturePath, JSON.stringify({ ...f.receipt, publishedAt: '2026-09-15T21:00:00Z' }));
    assert.throws(() => verifyPreparedLiveEvidence(f.root, f.supplied, { day, brief }), /publication date does not match/);
  } finally { f.close(); }
});
