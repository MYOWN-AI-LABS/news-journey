import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Script, Topic } from '../types.js';
import { journeyScriptFormat } from './journey-editorial.js';
import { runDailyEditorial, runScriptFirstEditorial, DailyEditorialHold, type DailyEditorialCheckpoint, type DailyEditorialInput, type DailyEditorialReview, type DailyEditorialRoute } from './daily-editorial.js';
import { spokenScriptText, reviewedJourneyScript } from './narration.js';
import { jsonOutputContract } from '../llm/json-output-contract.js';
import type { DraftCall } from './script.js';
import type { PreparedModelTask } from './writing-task.js';

// Portable fictional controls. No external requests or real-model acceptance claims.
const rich = JSON.parse(readFileSync(new URL('../../examples/fixtures/newsletter-rich-sports-evidence.json', import.meta.url), 'utf8'));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const topic = { id: '20260915-copy-contract', kind: 'roundup', headline: 'Fictional sports schedules', primaryUrl: rich.topics[0].primaryUrl,
  stories: rich.topics.map((row: any, i: number) => ({ n: i + 1, headline: row.headline, primaryUrl: row.primaryUrl, weight: row.weight, assetRef: `og-${i}` })) } as Topic;
const sentences: string[][] = rich.topics.map((row: any) => [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(row.sourceText)].map(part => part.segment.trim()));
const copy = rich.topics.map((row: any, i: number) => ({ storyId: `topic-${i + 1}`, text: row.sourceText }));
const scriptBudget = { min: 195, max: 220 }, newsletterBudget = { min: 900, max: 1300 };
const legacyCandidate = { hook: 'Three fictional sports schedules.', intro: 'This is Fixture Sports.',
  body: topic.stories!.map((story, i) => ({ voiceover: '', scene: 'news_card', onScreen: { title: ['Harbor League schedule', 'River Cup format', 'Forest Run guide'][i] }, assetRef: story.assetRef,
    motion: { who: ['Harbor League', 'River Cup organizers', 'Forest Run'][i], what: 'Published sports event guide', how: 'Written event rules', impact: 'Planning information for participants', status: 'Fictional scheduled event', kind: 'flow' } })),
  cta: 'Subscribe for sourced reporting.', publish: { title: 'Fictional sports schedules', description: 'Published event guides and their conditions.', linkedinPost: 'Three fictional sports event guides.', hashtags: ['Sports'] } };
let found = false;
for (let a = 1; a <= 5 && !found; a++) for (let b = 1; b <= 5 && !found; b++) for (let c = 1; c <= 5 && !found; c++) {
  [a, b, c].forEach((n, i) => { legacyCandidate.body[i]!.voiceover = sentences[i]!.slice(0, n).join(' '); });
  const count = spokenScriptText(legacyCandidate as Script).trim().split(/\s+/).length; found = count >= 195 && count <= 220;
}
assert.ok(found);
const candidate = { ...legacyCandidate, editorialCopy: copy };
const input: DailyEditorialInput = { day: '2026-09-15', brief: 'Fictional fixture publication for sports readers.', stories: copy.map((row: { storyId: string; text: string }, i: number) => {
  const url = topic.stories![i]!.primaryUrl, text = row.text + ' SOURCE_ONLY_CAPTURE_NOTE: Other fixture records remain archived.';
  return { id: row.storyId, headline: topic.stories![i]!.headline, primaryUrl: url, sources: [{ id: `${row.storyId}-source-1`, url, text,
    textSha256: digest(text), rawSha256: digest('raw:' + text), capturedAt: '2026-09-15T00:00:00Z', publishedAt: '2026-09-14' }] };
}) };
const format = () => journeyScriptFormat(topic, legacyCandidate.intro, scriptBudget, newsletterBudget);
const supported = (): DailyEditorialReview => ({ verdict: 'supported', reviewedStoryIds: input.stories.map(row => row.id), findings: [] });
function routes(reply?: (task: PreparedModelTask, prompt: string) => unknown) {
  const calls: { side: string; task: PreparedModelTask; prompt: string }[] = [];
  const call = (side: 'writer' | 'reviewer'): DraftCall => async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    assert.ok(task); assert.ok(jsonOutputContract(validate)); calls.push({ side, task, prompt });
    const value = reply?.(task, prompt) ?? (side === 'reviewer' ? supported() : task.taskId.includes('newsletter') ? { sections: copy } : candidate);
    const error = validate(value as T); if (error) throw new Error(error); return structuredClone(value) as T;
  };
  return { calls, writer: { identity: { provider: 'ollama', model: 'fixture-writer', runtimeHash: digest('writer') }, call: call('writer') } satisfies DailyEditorialRoute,
    reviewer: { identity: { provider: 'codex', model: 'fixture-reviewer', runtimeHash: digest('reviewer') }, call: call('reviewer') } satisfies DailyEditorialRoute };
}

test('new script contract requires complete written copy separately from short narration; legacy shape is unchanged', () => {
  const legacy = journeyScriptFormat(topic, legacyCandidate.intro, scriptBudget), current = format();
  assert.equal(legacy.validate(legacyCandidate), null); assert.ok(!legacy.schema.required!.includes('editorialCopy')); assert.equal(legacy.newsletterCopy, undefined);
  assert.equal(current.validate(candidate), null); assert.ok(current.schema.required!.includes('editorialCopy')); assert.notEqual(current.identity, legacy.identity);
  assert.match(current.validate(legacyCandidate)!, /editorialCopy/);
  assert.match(current.validate({ ...candidate, editorialCopy: [...copy].reverse() })!, /supplied storyId/);
  assert.match(current.validate({ ...candidate, editorialCopy: copy.map((row: any) => ({ ...row, text: 'The notice remains provisional.' })) })!, /Complete editorialCopy has/);
  const final = reviewedJourneyScript(candidate as Script, input.stories.map(row => row.primaryUrl));
  assert.deepEqual(final.editorialCopy, copy); assert.equal(final.fullVoiceoverText, current.spokenText(candidate));
  assert.ok(final.fullVoiceoverText.split(/\s+/).length <= 220); assert.ok(copy.map((row: any) => row.text).join(' ').split(/\s+/).length >= 900);
});

test('one script reviewer checks full copy and narration; formatter receives only approved complete copy', async () => {
  const r = routes(); const result = await runScriptFirstEditorial(input, { ...r, scriptBudget, newsletterBudget, scriptFormat: format() });
  assert.deepEqual(r.calls.map(row => row.side), ['writer', 'reviewer', 'writer']);
  for (const text of copy.map((row: any) => row.text)) assert.ok(r.calls[1]!.prompt.includes(text));
  assert.match(r.calls[1]!.prompt, /Review EVERY sentence in editorialCopy/);
  const presentation = JSON.parse(r.calls[2]!.prompt.split('APPROVED SCRIPT AND NEWSLETTER PRESENTATION:\n')[1]!);
  assert.deepEqual(presentation.approvedEditorialCopy, copy); assert.equal(presentation.approvedScript, undefined);
  assert.equal(presentation.approvedScriptHash, digest(JSON.stringify(candidate)));
  assert.ok(!r.calls[2]!.prompt.includes('SOURCE_ONLY_CAPTURE_NOTE')); assert.match(r.calls[2]!.prompt, /Do not expand the short spoken narration/);
  assert.equal(result.checkpoint.artifacts.newsletter.reviews.length, 0);
  const replay = routes(); await runScriptFirstEditorial(input, { ...replay, scriptBudget, newsletterBudget, scriptFormat: format(), checkpoint: result.checkpoint }); assert.equal(replay.calls.length, 0);
});

test('underlength complete copy is retained and uses only the existing single script correction', async () => {
  const short = { ...candidate, editorialCopy: copy.map((row: any) => ({ ...row, text: 'The notice remains provisional.' })) };
  const r = routes(task => task.taskId === 'daily-editorial-script-write-1' ? short : undefined);
  const result = await runScriptFirstEditorial(input, { ...r, scriptBudget, newsletterBudget, scriptFormat: format() });
  assert.deepEqual(r.calls.map(row => row.task.taskId), ['daily-editorial-script-write-1', 'daily-editorial-script-write-2', 'daily-editorial-script-review-2', 'daily-editorial-newsletter-write-1']);
  assert.deepEqual(result.checkpoint.artifacts.script.candidates[0], short); assert.equal(result.checkpoint.artifacts.script.writes, 2);
  assert.match(r.calls[1]!.prompt, /Complete editorialCopy has .* required 900–1300/);
  const held = routes(task => task.role === 'script' ? short : undefined); let saved: DailyEditorialCheckpoint | undefined;
  await assert.rejects(runScriptFirstEditorial(input, { ...held, scriptBudget, newsletterBudget, scriptFormat: format(), save: state => { saved = state; } }), /script failed after its one repair/);
  assert.equal(saved!.artifacts.script.candidates.length, 2); assert.equal(saved!.artifacts.newsletter.writes, 0); assert.equal(held.calls.length, 2);
  await assert.rejects(runScriptFirstEditorial(input, { ...held, scriptBudget, newsletterBudget, scriptFormat: format(), checkpoint: saved }), /retained held/); assert.equal(held.calls.length, 2);
});

test('a factual error solely in long editorial copy blocks before newsletter formatting', async () => {
  const unsupported = 'Harbor League completed a final schedule';
  const bad = { ...candidate, editorialCopy: copy.map((row: any, i: number) => ({ ...row, text: i ? row.text : row.text.replace('Harbor League published a provisional schedule', unsupported) })) };
  const r = routes(task => task.role === 'script' ? bad : task.role === 'source-review' ? { verdict: 'changes-required', reviewedStoryIds: input.stories.map(row => row.id), findings: [{ storyId: 'topic-1', kind: 'unsupported', candidateExcerpt: unsupported, evidence: [], reason: 'The supplied notice is provisional, not a completed final schedule.' }] } : undefined);
  await assert.rejects(runScriptFirstEditorial(input, { ...r, scriptBudget, newsletterBudget, scriptFormat: format() }), error => {
    assert.ok(error instanceof DailyEditorialHold); assert.equal(error.checkpoint.artifacts.script.reviews.length, 2); assert.equal(error.checkpoint.artifacts.newsletter.writes, 0); return true;
  });
  assert.equal(r.calls.length, 4); assert.equal(r.calls.filter(row => row.task.role === 'newsletter-draft').length, 0);
});

test('overlong 337-word narration is retained before its existing single content correction', async () => {
  const overlong = structuredClone(candidate); overlong.body[0]!.voiceover = '';
  const otherWords = spokenScriptText(overlong as Script).trim().split(/\s+/).length;
  overlong.body[0]!.voiceover = copy[0].text.split(/\s+/).slice(0, 337 - otherWords).join(' ');
  assert.equal(spokenScriptText(overlong as Script).trim().split(/\s+/).length, 337);
  assert.equal(format().validateShape!(overlong), null); assert.match(format().validate(overlong)!, /script too long/);
  const r = routes(task => task.taskId === 'daily-editorial-script-write-1' ? overlong : undefined);
  const result = await runScriptFirstEditorial(input, { ...r, scriptBudget, newsletterBudget, scriptFormat: format() });
  assert.deepEqual(result.checkpoint.artifacts.script.candidates[0], overlong);
  assert.equal(result.checkpoint.artifacts.script.writes, 2); assert.equal(result.checkpoint.artifacts.script.reviews.length, 1);
  assert.equal(r.calls[2]!.task.taskId, 'daily-editorial-script-review-2'); assert.equal(r.calls.length, 4);
});

test('formatting permits paragraph breaks but cannot change a sentence or call another factual reviewer', async () => {
  const paragraphCopy = copy.map((row: any) => ({ ...row, text: row.text.replace(/\. /g, '.\n\n') }));
  const spaced = routes(task => task.role === 'newsletter-draft' ? { sections: paragraphCopy } : undefined);
  const accepted = await runScriptFirstEditorial(input, { ...spaced, scriptBudget, newsletterBudget, scriptFormat: format() });
  assert.equal(accepted.checkpoint.artifacts.newsletter.status, 'accepted'); assert.equal(spaced.calls.length, 3);
  assert.equal(spaced.calls.filter(row => row.task.role === 'source-review').length, 1);
  const altered = copy.map((row: any, i: number) => ({ ...row, text: i ? row.text : row.text.replace('provisional schedule', 'confirmed schedule') }));
  const changed = routes(task => task.role === 'newsletter-draft' ? { sections: altered } : undefined);
  let saved: DailyEditorialCheckpoint | undefined;
  await assert.rejects(runScriptFirstEditorial(input, { ...changed, scriptBudget, newsletterBudget, scriptFormat: format(), save: state => { saved = state; } }), /formatting changed approved editorialCopy wording/);
  assert.equal(saved!.artifacts.script.status, 'accepted'); assert.equal(saved!.artifacts.newsletter.writes, 2);
  assert.equal(saved!.artifacts.newsletter.candidates.length, 2); assert.equal(saved!.artifacts.newsletter.reviews.length, 0);
  assert.equal(changed.calls.filter(row => row.task.role === 'source-review').length, 1);
  assert.equal(changed.calls.length, 4, 'Only the existing formatting correction is allowed');
  const tampered = structuredClone(accepted.checkpoint); tampered.artifacts.newsletter.candidates[0] = { sections: altered };
  tampered.artifacts.newsletter.formatting!.candidateHash = digest(JSON.stringify({ sections: altered }));
  tampered.contentHash = digest(JSON.stringify(tampered.artifacts));
  await assert.rejects(runScriptFirstEditorial(input, { ...spaced, scriptBudget, newsletterBudget, scriptFormat: format(), checkpoint: tampered }), /approved-script formatting receipt/); assert.equal(spaced.calls.length, 3);
});

test('historical v6 accepted replay stays unchanged and cannot be relabeled as complete-copy approval', async () => {
  const legacyFormat = journeyScriptFormat(topic, legacyCandidate.intro, scriptBudget), r = routes(task => task.role === 'script' ? legacyCandidate : undefined);
  const done = await runDailyEditorial(input, { ...r, scriptBudget, newsletterBudget, scriptFormat: legacyFormat }); assert.equal(r.calls.length, 4);
  await runDailyEditorial(input, { ...r, scriptBudget, newsletterBudget, scriptFormat: legacyFormat, checkpoint: done.checkpoint }); assert.equal(r.calls.length, 4);
  await assert.rejects(runScriptFirstEditorial(input, { ...r, scriptBudget, newsletterBudget, scriptFormat: format(), checkpoint: done.checkpoint }), /checkpoint identity/); assert.equal(r.calls.length, 4);
  const fresh = routes(); const current = await runScriptFirstEditorial(input, { ...fresh, scriptBudget, newsletterBudget, scriptFormat: format() });
  await assert.rejects(runScriptFirstEditorial(input, { ...fresh, scriptBudget, newsletterBudget, scriptFormat: journeyScriptFormat(topic, legacyCandidate.intro, scriptBudget, { min: 901, max: 1300 }), checkpoint: current.checkpoint }), /checkpoint identity/); assert.equal(fresh.calls.length, 3);
});

test('publication description and LinkedIn copy may contain paragraph breaks; titles and hashtags stay single-line', () => {
  const current = format();
  const paragraphs = { ...candidate, publish: { ...candidate.publish, description: 'Published event guides.\nTheir conditions follow.', linkedinPost: 'Three fictional sports event guides.\n\nEach guide lists its rules.' } };
  assert.equal(current.validate(paragraphs), null);
  assert.match(current.validate({ ...candidate, publish: { ...candidate.publish, title: 'Fictional\nschedules' } })!, /Publication fields/);
  assert.match(current.validate({ ...candidate, publish: { ...candidate.publish, hashtags: ['Sports\nNews'] } })!, /Publication fields/);
  assert.match(current.validate({ ...candidate, publish: { ...candidate.publish, linkedinPost: 'See www.example.org\n\nfor rules.' } })!, /Publication fields/);
});
