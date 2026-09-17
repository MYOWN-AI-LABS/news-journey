import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScriptSegment, TopicStory } from '../types.js';
import { sourceAccountProblem } from './source-account.js';
import { motionBriefProblem } from './script.js';
import { ensureEditionDiagrams } from './story-diagram.js';
import { readVisualCandidates } from './visual-choice.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(): { story: TopicStory; segment: ScriptSegment } {
  const story: TopicStory = { n: 1, headline: 'Transit pilot announced', summary: '', primaryUrl: 'https://example.org/transit', repo: null, weight: 'lead', assetRef: 'og-0', suggestedScene: 'news_card', principalEntity: 'Transit board', area: 'News', verticals: [], verifiedClaims: ['The transit board announced a six-week pilot.', 'The announcement did not report passenger outcomes.'], claimEvidence: [{ url: 'https://example.org/transit', role: 'primary', status: 200, sha256: 'a'.repeat(64), observedAt: '2026-09-14T12:00:00Z' }] };
  const segment: ScriptSegment = { voiceover: story.verifiedClaims!.join(' '), scene: 'news_card', assetRef: story.assetRef, onScreen: { title: story.headline }, sourceAccount: { version: 1, claims: [...story.verifiedClaims!], sourceUrl: story.primaryUrl, packetHash: hash(story.verifiedClaims), evidenceHash: hash(story.claimEvidence) } };
  return { story, segment };
}

test('complete source account replaces only its own mechanism requirement', () => {
  const { story, segment } = fixture();
  assert.equal(sourceAccountProblem(segment, story), null);
  assert.equal(motionBriefProblem([segment], [story]), null);
  assert.match(motionBriefProblem([segment])!, /exact selected story/);
  assert.match(motionBriefProblem([segment, { ...segment, sourceAccount: undefined }], [story, story])!, /story 2 is missing/);
});

test('source account rejects dropped caveats, added prose, changed sources and forged titles', () => {
  const { story, segment } = fixture();
  for (const changed of [
    { ...segment, voiceover: story.verifiedClaims![0] },
    { ...segment, voiceover: segment.voiceover + ' The pilot improves service.' },
    { ...segment, sourceAccount: { ...segment.sourceAccount!, claims: [story.verifiedClaims![0]] } },
    { ...segment, onScreen: { title: 'Passenger experience improves' } },
    { ...segment, onScreen: { title: story.verifiedClaims![0] } },
    { ...segment, assetRef: 'og-1' },
    { ...segment, sourceAccount: { ...segment.sourceAccount!, sourceUrl: 'https://example.org/other' } },
  ]) assert.ok(sourceAccountProblem(changed, story));
  assert.ok(sourceAccountProblem(segment, { ...story, verifiedClaims: [...story.verifiedClaims!].reverse() }));
  assert.ok(sourceAccountProblem(segment, { ...story, claimEvidence: [] }));
});

test('source account renders through original attributed snapshot without unused model calls; stale context stops reuse', async () => {
  const { story, segment } = fixture(), dir = mkdtempSync(join(tmpdir(), 'source-account-'));
  const originalFetch = globalThis.fetch, previousChoice = process.env.HARNESS_VISUAL_CHOICE;
  let calls = 0;
  try {
    delete process.env.HARNESS_VISUAL_CHOICE;
    writeFileSync(join(dir, 'topic.json'), JSON.stringify({ kind: 'roundup', stories: [story] }));
    writeFileSync(join(dir, 'script.json'), JSON.stringify({ body: [segment] }));
    globalThis.fetch = async () => { calls++; throw new Error('Unexpected source-account network request'); };
    const author = async (): Promise<never> => { calls++; throw new Error('Unexpected mechanism authoring'); };
    const context = { day: '2026-09-09', writerKey: 'isolated-source-account-fixture', call: (_stage: 'visual') => async <T>(prompt: string): Promise<T> => {
      if (!prompt.startsWith('AUTHORED FIELD SOURCE REVIEW')) { calls++; throw new Error('Unexpected non-review model request'); }
      const fields = JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!);
      return { fields: fields.map((field: { id: string }) => ({ id: field.id, supported: true, claimIds: [1], reason: 'Injected heading source check.' })) } as T;
    } };
    const diagrams = await ensureEditionDiagrams(dir, [segment], false, author, context);
    assert.equal(diagrams[0].svg, '');
    assert.equal(diagrams[0].visual?.kind, 'diagram');
    const choices = readVisualCandidates(dir)!;
    assert.equal(choices.stories[0].recommended.id, 'snapshot');
    assert.deepEqual(choices.stories[0].candidates.filter(c => c.available).map(c => c.id), ['snapshot']);
    await ensureEditionDiagrams(dir, [segment], false, author, context);
    assert.equal(calls, 0);
    writeFileSync(join(dir, 'topic.json'), JSON.stringify({ kind: 'roundup', stories: [{ ...story, verifiedClaims: [...story.verifiedClaims!, 'The board changed the pilot schedule.'] }] }));
    await assert.rejects(ensureEditionDiagrams(dir, [segment], false, author, context), /differs from the selected source packet/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousChoice === undefined) delete process.env.HARNESS_VISUAL_CHOICE; else process.env.HARNESS_VISUAL_CHOICE = previousChoice;
    rmSync(dir, { recursive: true, force: true });
  }
});
