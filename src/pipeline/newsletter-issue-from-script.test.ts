import test from 'node:test';
import assert from 'node:assert/strict';
import { draftIssueFromScript, bandForStoryCount } from './newsletter.js';
import type { Script } from '../types.js';

test('a selected length floor is lowered only when it is unreachable for the story count', () => {
  const deep = { min: 900, max: 1300 };
  assert.deepEqual(bandForStoryCount(deep, 8), deep, 'a longer roundup keeps the band it already fits (NAMs eight-story edition, 900–1300)');
  assert.deepEqual(bandForStoryCount(deep, 3), deep, 'three stories can reach 900');
  assert.deepEqual(bandForStoryCount(deep, 1), { min: 400, max: 1300 }, 'one story is not required to reach 900; the ceiling stays');
  assert.deepEqual(bandForStoryCount(deep, 2), { min: 800, max: 1300 });
  assert.deepEqual(bandForStoryCount({ min: 250, max: 400 }, 1), { min: 250, max: 400 }, 'a quick one-story issue already fits and is unchanged');
});

const stories = [
  { headline: 'Club sells stakes', weight: 'lead' as const, primaryUrl: 'https://example.org/a', verifiedClaims: ['The club agreed a sale.'] },
  { headline: 'Driver retires', weight: 'standard' as const, primaryUrl: 'https://example.org/b', verifiedClaims: ['The driver retired.'] },
];
const script = { body: [{ voiceover: 'The club agreed a sale, the report says.' }, { voiceover: 'The driver retired from international duty.' }] } as unknown as Script;

test('the length gate measures the completed issue, not the raw answer: a blank item line is backfilled with the voiceover before the count', async () => {
  // Second-read finding: completeSlateIssue replaces a blank/unmatched item line with the story's own summary (here the
  // script's 6-word voiceover), so counting the raw answer (0 words for a blank line) undercounts by exactly that much.
  // Raw total = lead 8 + item 0 = 8 (would fail a 12-word floor); completed total = lead 8 + item 6 = 14 (passes it).
  const blank = { subject: 's', lead: { title: 't', body: 'The club agreed a sale, the report says.', sourceName: 'Example', sourceUrl: 'https://example.org/a' },
    items: [{ name: 'Driver retires', url: 'https://example.org/b', line: '   ' }], radar: [], signals: [] };
  const issue = await draftIssueFromScript(stories, script, '2026-09-16', (async (_prompt: string, validate: (v: unknown) => string | null) => {
    assert.equal(validate(blank), null, 'the completed 14-word issue clears a 12-word floor even though the raw draft has a blank item line');
    return blank;
  }) as never, { min: 12, max: 1000 });
  assert.equal(issue.items[0]!.line, 'The driver retired from international duty.', 'the blank line was backfilled from the voiceover');
});

test('the issue is formatted from the accepted script in one call and keeps code-owned links', async () => {
  let calls = 0;
  const issue = await draftIssueFromScript(stories, script, '2026-09-16', (async (prompt: string, validate: (v: unknown) => string | null) => {
    calls++;
    assert.match(prompt, /agreed a sale, the report says/); assert.match(prompt, /TRENDING: none/);
    const value = { subject: 'club sale agreed', lead: { title: 'Club agrees sale', body: 'The club agreed a sale, the report says.', sourceName: 'Example', sourceUrl: 'https://evil.example/x' },
      items: [{ name: 'Driver retires', url: 'https://evil.example/y', line: 'The driver retired from international duty.' }], radar: [], signals: [] };
    assert.equal(validate(value), null);
    assert.match(validate({ ...value, radar: [{ repo: 'r', url: 'u', line: 'l' }] }) ?? '', /radar/);
    return value;
  }) as never);
  assert.equal(calls, 1);
  assert.equal(issue.lead.sourceUrl, 'https://example.org/a');
  assert.equal(issue.items[0]!.url, 'https://example.org/b');
  assert.deepEqual(issue.radar, []); assert.deepEqual(issue.signals, []);
});

test('the selected newsletter length is enforced when the issue is drafted, not only after the render', async () => {
  const fitting = { subject: 'club sale agreed', lead: { title: 'Club agrees sale', body: 'The club agreed a sale, the report says.', sourceName: 'Example', sourceUrl: 'https://example.org/a' },
    items: [{ name: 'Driver retires', url: 'https://example.org/b', line: 'The driver retired from international duty.' }], radar: [], signals: [] };
  const long = { ...fitting, items: [{ ...fitting.items[0]!, line: 'The driver retired from international duty after a long career of many seasons and several trophies.' }] };
  const issue = await draftIssueFromScript(stories, script, '2026-09-16', (async (prompt: string, validate: (v: unknown) => string | null) => {
    assert.match(prompt, /Plan: about 3 words for the lead and at most 12 words per item \(1 item\)/);
    assert.match(validate(long) ?? '', /Newsletter has 24 words across the lead and items; the selected length requires 10–16 \(lead 8 words; items 16\)\. Aim for about 3 words in the lead and at most 12 per item/);
    assert.equal(validate(fitting), null);
    return fitting;
  }) as never, { min: 10, max: 16 });
  assert.equal(issue.items.length, 1);
});
