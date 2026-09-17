import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareScriptEditorialCopy, type DraftCall, type DraftCheckpoint } from './script.js';
import { formatScriptNewsletter, type ScriptNewsletterCheckpoint } from './newsletter-from-script.js';
import { preparedScriptReceipt, assertPreparedScriptReceipt } from './writing-context.js';
import { syntheticPassingFactualResponse } from './factual-obligations.test-fixture.js';
import type { Script, Topic } from '../types.js';

const paragraphs = [
  'The Falcons won their opening match after a late goal. The club reported that its next fixture remains subject to scheduling confirmation.',
  'The Harbor team appointed Morgan Vale as captain for the coming season. The announcement did not give a date for the first match.',
];
const topic: Topic = { id: '20260915-fixture-copy', kind: 'roundup', headline: 'Club notices', angle: 'Club notices', primaryUrl: 'https://fixtures.example/falcons', repo: null, alternates: [], sourceItems: [],
  stories: paragraphs.map((text, i) => ({ n: i + 1, headline: `Club notice ${i + 1}`, summary: 'Not a factual source.', primaryUrl: `https://fixtures.example/story-${i}`, assetRef: `og-${i}`, verifiedClaims: [text], repo: null, suggestedScene: 'news_card', principalEntity: `club-${i}`, area: 'sports', verticals: ['sports'], weight: i === 1 ? 'lead' : 'standard' })) };
const options = { day: '2026-09-15', brief: 'Plain sports coverage.', writerKey: 'fixed-writer', parentIdentity: 'same-parent', budget: { min: 30, max: 100 } };
const jsonLine = (prompt: string, name: string) => JSON.parse(prompt.match(new RegExp(`^${name}: (.*)$`, 'm'))![1]!);
const respond = (prompt: string): unknown => {
  const focused = syntheticPassingFactualResponse(prompt); if (focused !== undefined) return focused;
  if (prompt.startsWith('SOURCE SUPPORT REVIEW')) {
    const sentences = jsonLine(prompt, 'DRAFT_SENTENCES') as { id: number; text: string }[];
    const claims = jsonLine(prompt, 'PINNED_CLAIMS') as { id: number; text: string }[];
    const ids = jsonLine(prompt, 'REVIEW_SENTENCE_IDS') as number[];
    return { sentences: sentences.filter(row => ids.includes(row.id)).map(row => {
      const claimIds = claims.filter(claim => claim.text.includes(row.text.trim())).map(claim => claim.id);
      return { id: row.id, supported: Boolean(claimIds.length), claimIds, reason: 'The exact fixture sentence is present in its own source claim.' };
    }) };
  }
  const claims = jsonLine(prompt, 'PINNED_CLAIMS') as { id: number; claim: string }[];
  return { text: claims.map(row => row.claim).join(' '), claimIds: claims.map(row => row.id) };
};

test('complete copy is source-reviewed before formatter, keeps selected order and resumes without model calls', async () => {
  let checkpoint: DraftCheckpoint = { values: {} }; const prompts: string[] = [];
  const call: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null) => {
    prompts.push(prompt); const value = respond(prompt) as T; assert.equal(validate(value), null); return value;
  };
  const copy = await prepareScriptEditorialCopy(topic, call, { ...options, checkpoint, save: state => { checkpoint = structuredClone(state); } });
  assert.deepEqual(copy, paragraphs.map((text, i) => ({ storyId: `topic-${i + 1}`, text })));
  assert.equal(prompts.filter(prompt => prompt.startsWith('SOURCE SUPPORT REVIEW')).length, 2);
  assert.equal(Object.keys(checkpoint.values).length, 2);
  assert.deepEqual(await prepareScriptEditorialCopy(topic, async () => { throw new Error('Reviewed copy must not be rebought'); }, { ...options, checkpoint }), copy);

  const script: Script = { editorialCopy: copy, hook: 'Club notices.', cta: 'Read the sources.', fullVoiceoverText: '',
    body: topic.stories!.map((row, i) => ({ voiceover: paragraphs[i]!, scene: 'news_card', onScreen: { title: row.headline }, assetRef: row.assetRef })),
    publish: { title: 'Club notices', description: 'Club notices.', linkedinPost: 'Club notices.', hashtags: [] } };
  const receipt = preparedScriptReceipt(topic, options.writerKey, script);
  assert.doesNotThrow(() => assertPreparedScriptReceipt(receipt, topic, options.writerKey, script));
  const changed = structuredClone(script); changed.editorialCopy![0]!.text += ' An unsupported claim.';
  assert.throws(() => assertPreparedScriptReceipt(receipt, topic, options.writerKey, changed), /not bound/i);
  const formats: string[] = []; let formatting: ScriptNewsletterCheckpoint | undefined;
  const formatCall: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null) => {
    formats.push(prompt); const value = { sections: copy.map(({ text }) => ({ text })) } as T; assert.equal(validate(value), null); return value;
  };
  const issue = await formatScriptNewsletter({ script, topic, writerKey: options.writerKey, publication: 'Fixture Press', day: options.day, budget: options.budget, call: formatCall, save: state => { formatting = structuredClone(state); } });
  assert.equal(formats.length, 1); assert.equal(formatting!.accepted, true);
  assert.ok(formats.every(prompt => !prompt.includes('SOURCE SUPPORT REVIEW') && !prompt.includes('PINNED_CLAIMS')));
  assert.equal(issue.lead.body, paragraphs[1]); assert.equal(issue.items[0]!.line, paragraphs[0]);
});

test('source rejection stops full-copy preparation without promoting it or calling a formatter', async () => {
  const saved: DraftCheckpoint[] = []; let drafts = 0;
  const call: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null) => {
    if (prompt.startsWith('NEWSLETTER TOPIC')) drafts++;
    if (prompt.startsWith('SOURCE SUPPORT REVIEW')) throw new Error('Fixture source review unavailable');
    const value = respond(prompt) as T; assert.equal(validate(value), null); return value;
  };
  await assert.rejects(prepareScriptEditorialCopy(topic, call, { ...options, save: checkpoint => saved.push(structuredClone(checkpoint)) }), /source review unavailable/);
  assert.equal(drafts, 1); assert.equal(saved.length, 0);
});


test('duplicate source ownership is rejected before full-copy writing', async () => {
  const duplicate = structuredClone(topic); duplicate.stories![1]!.primaryUrl = duplicate.stories![0]!.primaryUrl;
  let calls = 0;
  await assert.rejects(prepareScriptEditorialCopy(duplicate, async () => { calls++; throw new Error('Unexpected call'); }, options), /distinct HTTP/);
  assert.equal(calls, 0);
});
