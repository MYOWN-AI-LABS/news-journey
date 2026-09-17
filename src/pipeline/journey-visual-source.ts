/** Fresh capture metadata for visual review; never rewrites the selected claims or story history. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'cheerio';
import type { ClaimEvidence, TopicStory } from '../types.js';
import { readableWebText, pagePublicationDate } from '../sources/web-discovery.js';
import { roleHash } from '../llm/role-router.js';
import type { DailyEditorialInput } from './daily-editorial.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Existing pinned claims retain their original review. These independently captured source
 * receipts identify the complete source available to the visual task, not a new claim verdict. */
export function journeyVisualCaptures(dir: string, story: TopicStory): ClaimEvidence[] | null {
  const path = join(dir, 'journey-editorial-input.json');
  if (!existsSync(path)) return null;
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { identity: string; hash: string; input: DailyEditorialInput };
  if (saved.hash !== roleHash(saved.input)) throw new Error('Complete Journey visual source input changed');
  const matches = saved.input.stories.filter(row => row.primaryUrl === story.primaryUrl && row.headline === story.headline);
  if (matches.length !== 1) throw new Error('Complete Journey visual capture does not match the selected story');
  return matches[0]!.sources.map(source => {
    if (!/^topic-\d+-source-\d+$/.test(source.id) || !/^[a-f0-9]{64}$/.test(source.rawSha256)) throw new Error('Invalid Journey visual capture identity');
    const receipt = JSON.parse(readFileSync(join(dir, 'journey-editorial-sources', `${source.id}.json`), 'utf8'));
    const bytes = readFileSync(join(dir, 'journey-editorial-sources', `${source.rawSha256}.raw`));
    const html = bytes.toString('utf8'), $ = load(html);
    const publishedAt = pagePublicationDate($);
    if (receipt.identity !== saved.identity || roleHash(receipt.source) !== roleHash(source) || hash(bytes) !== source.rawSha256
      || readableWebText(html) !== source.text || hash(source.text) !== source.textSha256 || (source.publishedAt ?? null) !== publishedAt) throw new Error('Journey visual raw source, text or publication metadata changed');
    return { url: source.url, role: source.url === story.primaryUrl ? 'primary' : 'corroborating', status: 200,
      sha256: source.rawSha256, textSha256: source.textSha256, observedAt: source.capturedAt, publishedAt: source.publishedAt };
  });
}
