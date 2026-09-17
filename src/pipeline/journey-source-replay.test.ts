import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readableWebText } from '../sources/web-discovery.js';
import { prepareJourneySourceReplay, readJourneySourceReplay } from './journey-source-replay.js';
import type { Topic } from '../types.js';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'journey-source-replay-')), sourceDir = join(base, 'original'), dir = join(base, 'comparison');
  mkdirSync(join(sourceDir, 'journey-editorial-sources'), { recursive: true }); mkdirSync(dir);
  const html = '<html><head><meta property="article:published_time" content="2026-09-15T12:00:00Z"></head><body><article><h1>League result</h1><p>The club won the match by three points. The final is scheduled for Sunday, subject to the weather.</p></article></body></html>';
  const text = readableWebText(html), source = { id: 'topic-1-source-1', url: 'https://example.org/sport', publishedAt: '2026-09-15T12:00:00.000Z', capturedAt: '2026-09-15T14:00:00Z', text, textSha256: sha(text), rawSha256: sha(html) };
  const topic = { id: '20260915-roundup-test', stories: [{ headline: 'League result', primaryUrl: source.url, claimEvidence: [] }] } as unknown as Topic;
  const input = { day: '2026-09-15', brief: 'Sports reporting', stories: [{ id: 'topic-1', headline: 'League result', primaryUrl: source.url, sources: [source] }] };
  writeFileSync(join(sourceDir, 'journey-editorial-input.json'), JSON.stringify({ identity: sha('old-parent'), input, hash: sha(JSON.stringify(input)) }));
  writeFileSync(join(sourceDir, 'journey-editorial-sources', `${source.id}.json`), JSON.stringify({ identity: sha('old-parent'), source }));
  writeFileSync(join(sourceDir, 'journey-editorial-sources', `${source.rawSha256}.raw`), html);
  const manifest = prepareJourneySourceReplay(sourceDir, dir, topic);
  return { dir, sourceDir, topic, input, manifest, options: { dir, topic, parentIdentity: sha('new-parent'), brief: input.brief } };
}
test('imports complete original captures under fresh parent and resumes without changing receipts or importing approvals', () => {
  const f = fixture(); assert.deepEqual(readJourneySourceReplay(f.options), f.input);
  const bytes = readFileSync(join(f.dir, 'journey-editorial-input.json'));
  assert.deepEqual(readJourneySourceReplay(f.options), f.input);
  assert.ok(readFileSync(join(f.dir, 'journey-editorial-input.json')).equals(bytes));
  const receipt = JSON.parse(bytes.toString()); assert.notEqual(receipt.identity, sha('old-parent'));
  assert.equal(receipt.replay.originalCaptureIdentity, sha('old-parent'));
  assert.ok(!existsSync(join(f.dir, 'journey-editorial-checkpoint.json')));
});
test('refuses altered raw evidence before writing normal receipt', () => {
  const f = fixture(); writeFileSync(join(f.dir, f.manifest.sourceReceipts[0]!.rawPath), 'changed');
  assert.throws(() => readJourneySourceReplay(f.options), /raw bytes changed/);
  assert.ok(!existsSync(join(f.dir, 'journey-editorial-input.json')));
});
test('rejects changed story ownership, brief, date and original parent receipt', () => {
  const f = fixture();
  assert.throws(() => readJourneySourceReplay({ ...f.options, brief: 'Other topic' }), /brief changed/);
  assert.throws(() => readJourneySourceReplay({ ...f.options, topic: { ...f.topic, id: '20260916-roundup-test' } }), /publication day/);
  assert.throws(() => readJourneySourceReplay({ ...f.options, topic: { ...f.topic, stories: [{ ...f.topic.stories![0]!, primaryUrl: 'https://example.org/other' }] } }), /ownership changed/);
  writeFileSync(join(f.dir, f.manifest.sourceReceipts[0]!.receiptPath), '{}');
  assert.throws(() => readJourneySourceReplay(f.options));
});
