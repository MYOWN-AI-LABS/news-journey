/** Source-only import for an explicitly selected comparison slate. Never imports model output or approval. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { load } from 'cheerio';
import { readableWebText, pagePublicationDate } from '../sources/web-discovery.js';
import type { Topic } from '../types.js';
import type { DailyEditorialInput, DailyEditorialSource } from './daily-editorial.js';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => sha(JSON.stringify(value));
const slate = (topic: Topic) => (topic.stories ?? []).map((story, i) => ({ id: `topic-${i + 1}`, headline: story.headline, primaryUrl: story.primaryUrl,
  urls: [...new Set([story.primaryUrl, ...(story.claimEvidence ?? []).filter(row => row.role === 'corroborating').map(row => row.url)])] }));
export interface JourneySourceReplayManifest {
  version: 1;
  source: { workspace: string; packageId: string; inputFileSha256: string; captureIdentity: string; inputHash: string; originalInputPath: string };
  topicSlateHash: string; briefHash: string;
  sourceReceipts: { sourceId: string; receiptPath: string; receiptSha256: string; rawPath: string; rawSha256: string }[];
  manifestHash: string;
}
function exactFile(dir: string, name: string): Buffer {
  assert.ok(typeof name === 'string' && !isAbsolute(name), 'Replay paths must be package-relative');
  const root = realpathSync(dir), path = realpathSync(resolve(root, name));
  assert.ok(relative(root, path) && !relative(root, path).startsWith('..'), 'Replay path escapes its package');
  return readFileSync(path);
}
function immutable(path: string, bytes: string | Buffer) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) assert.ok(readFileSync(path).equals(value), 'Replay cannot replace an existing receipt');
  else writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
}
function verifySource(source: DailyEditorialSource, raw: Buffer) {
  assert.match(source.id, /^topic-\d+-source-\d+$/);
  assert.match(source.rawSha256, /^[a-f0-9]{64}$/);
  assert.equal(sha(raw), source.rawSha256, 'Replay raw bytes changed');
  const html = raw.toString('utf8'), $ = load(html);
  assert.equal(readableWebText(html), source.text, 'Replay must retain complete decoded source text');
  assert.equal(sha(source.text), source.textSha256, 'Replay text hash changed');
  assert.equal(source.publishedAt ?? null, pagePublicationDate($), 'Replay publication metadata changed');
  assert.ok(Number.isFinite(Date.parse(source.capturedAt)), 'Replay needs its original capture time');
}
/** Copies only original source input/receipts/raw bytes, each unchanged; validates before model work. */
export function prepareJourneySourceReplay(sourceDir: string, dir: string, topic: Topic): JourneySourceReplayManifest {
  const original = readFileSync(join(sourceDir, 'journey-editorial-input.json'));
  const record = JSON.parse(original.toString('utf8')) as { identity: string; input: DailyEditorialInput; hash: string };
  assert.equal(record.hash, hash(record.input), 'Original complete input hash changed');
  const rows: JourneySourceReplayManifest['sourceReceipts'] = [];
  const prefix = 'journey-editorial-replay-sources';
  immutable(join(dir, prefix, 'input.json'), original);
  for (const story of record.input.stories) for (const source of story.sources) {
    const receipt = readFileSync(join(sourceDir, 'journey-editorial-sources', `${source.id}.json`));
    const parsed = JSON.parse(receipt.toString('utf8'));
    assert.equal(parsed.identity, record.identity, 'Original source parent identity differs');
    assert.equal(hash(parsed.source), hash(source), 'Original source receipt differs');
    const raw = readFileSync(join(sourceDir, 'journey-editorial-sources', `${source.rawSha256}.raw`));
    verifySource(source, raw);
    const receiptPath = `${prefix}/${source.id}.json`, rawPath = `${prefix}/${source.rawSha256}.raw`;
    immutable(join(dir, receiptPath), receipt); immutable(join(dir, rawPath), raw);
    rows.push({ sourceId: source.id, receiptPath, receiptSha256: sha(receipt), rawPath, rawSha256: source.rawSha256 });
  }
  const unsigned = { version: 1 as const, source: { workspace: resolve(sourceDir, '../../..'), packageId: sourceDir.split('/').at(-1)!, inputFileSha256: sha(original), captureIdentity: record.identity, inputHash: record.hash, originalInputPath: `${prefix}/input.json` },
    topicSlateHash: hash(slate(topic)), briefHash: hash(record.input.brief), sourceReceipts: rows };
  const manifest = { ...unsigned, manifestHash: hash(unsigned) };
  immutable(join(dir, 'journey-editorial-replay.json'), JSON.stringify(manifest));
  return manifest;
}
export function readJourneySourceReplay(options: { dir: string; topic: Topic; parentIdentity: string; brief: string }): DailyEditorialInput | null {
  const { dir, topic, parentIdentity, brief } = options;
  const path = join(dir, 'journey-editorial-replay.json');
  if (!existsSync(path)) return null;
  const { manifestHash, ...manifest } = JSON.parse(readFileSync(path, 'utf8')) as JourneySourceReplayManifest;
  assert.equal(manifest.version, 1, 'Unsupported source replay version');
  assert.equal(hash(manifest), manifestHash, 'Replay manifest changed');
  assert.equal(manifest.topicSlateHash, hash(slate(topic)), 'Replay selected stories or source ownership changed');
  assert.equal(manifest.briefHash, hash(brief), 'Replay publication brief changed');
  const bytes = exactFile(dir, manifest.source.originalInputPath);
  assert.equal(sha(bytes), manifest.source.inputFileSha256, 'Original input receipt changed');
  const original = JSON.parse(bytes.toString('utf8')) as { identity: string; input: DailyEditorialInput; hash: string };
  assert.equal(original.identity, manifest.source.captureIdentity);
  assert.equal(original.hash, manifest.source.inputHash);
  assert.equal(hash(original.input), original.hash);
  const input = original.input, selected = slate(topic);
  assert.equal(input.brief, brief);
  assert.equal(input.day, `${topic.id.slice(0, 4)}-${topic.id.slice(4, 6)}-${topic.id.slice(6, 8)}`, 'Replay must preserve the original publication day');
  assert.equal(input.stories.length, selected.length);
  assert.ok(selected.length > 0 && Buffer.byteLength(JSON.stringify(input)) <= 131072, 'Replay needs a bounded complete source packet');
  const checked: { source: DailyEditorialSource; raw: Buffer }[] = [];
  const seen = new Set<string>();
  for (const [index, story] of input.stories.entries()) {
    const owner = selected[index]!;
    assert.equal(story.id, owner.id); assert.equal(story.headline, owner.headline); assert.equal(story.primaryUrl, owner.primaryUrl);
    assert.ok(story.sources.some(row => row.id === `${owner.id}-source-1` && row.url === owner.primaryUrl), 'Replay needs the complete primary source');
    for (const source of story.sources) {
      assert.ok(!seen.has(source.id), 'Duplicate replay source'); seen.add(source.id);
      const position = Number(source.id.match(/-source-(\d+)$/)?.[1]);
      assert.equal(source.id, `${owner.id}-source-${position}`);
      assert.equal(source.url, owner.urls[position - 1], 'Replay source belongs to another story');
      const rows = manifest.sourceReceipts.filter(row => row.sourceId === source.id);
      assert.equal(rows.length, 1, 'Replay source receipt inventory differs');
      const row = rows[0]!, receiptBytes = exactFile(dir, row.receiptPath);
      assert.equal(sha(receiptBytes), row.receiptSha256);
      const receipt = JSON.parse(receiptBytes.toString('utf8'));
      assert.equal(receipt.identity, original.identity); assert.equal(hash(receipt.source), hash(source));
      const raw = exactFile(dir, row.rawPath); assert.equal(row.rawSha256, source.rawSha256); verifySource(source, raw);
      checked.push({ source, raw });
    }
  }
  assert.equal(manifest.sourceReceipts.length, seen.size, 'Replay contains unowned extra receipts');
  assert.match(parentIdentity, /^[a-f0-9]{64}$/);
  const identity = hash({ version: 1, parent: parentIdentity, sources: selected, brief });
  for (const { source, raw } of checked) {
    immutable(join(dir, 'journey-editorial-sources', `${source.rawSha256}.raw`), raw);
    immutable(join(dir, 'journey-editorial-sources', `${source.id}.json`), JSON.stringify({ identity, source }));
  }
  immutable(join(dir, 'journey-editorial-input.json'), JSON.stringify({ identity, input, hash: hash(input), replay: { manifestHash, originalCaptureIdentity: original.identity, originalInputFileSha256: sha(bytes), sourceOnly: true } }));
  return input;
}
