import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runDailyEditorial, runScriptFirstEditorial, DailyEditorialHold,
  type DailyEditorialInput, type DailyEditorialRoute, type DailyEditorialCheckpoint, type DailyEditorialReview, type DailyScriptFormat } from './daily-editorial.js';
import { jsonOutputContract } from '../llm/json-output-contract.js';
import type { DraftCall } from './script.js';
import type { PreparedModelTask } from './writing-task.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textHash = (text: string) => createHash('sha256').update(text).digest('hex');
const sentence = (name: string, n: number) => `The ${name} notice describes item ${n} as a planned local activity subject to the stated conditions.`;
const sections = ['Alpha', 'Bravo'].map(storyId => ({ storyId, text: [sentence(storyId, 1), sentence(storyId, 2)].join(' ') }));
const legacyScript = { text: sections.map(row => row.text).join(' ') };
const script = { ...legacyScript, editorialCopy: sections };
const scriptFormat: DailyScriptFormat = {
  identity: hash('fixture-complete-copy-v1'), instructions: 'Return short spoken text and complete editorialCopy for both stories.',
  schema: { type: 'object', additionalProperties: false, required: ['text', 'editorialCopy'], properties: {
    text: { type: 'string', minLength: 1, maxLength: 12000 }, editorialCopy: { type: 'array', minItems: 2, maxItems: 2,
      items: { type: 'object', additionalProperties: false, required: ['storyId', 'text'], properties: {
        storyId: { type: 'string', enum: ['Alpha', 'Bravo'] }, text: { type: 'string', minLength: 1, maxLength: 12000 },
      } } },
  } },
  validate(value) {
    const candidate = value as typeof script;
    return !candidate || Object.keys(candidate).sort().join(',') !== 'editorialCopy,text' || typeof candidate.text !== 'string'
      || !Array.isArray(candidate.editorialCopy) || candidate.editorialCopy.length !== sections.length
      || candidate.editorialCopy.some((row, i) => !row || Object.keys(row).sort().join(',') !== 'storyId,text'
        || row.storyId !== sections[i]!.storyId || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 12000)
      ? 'Return spoken text and complete owned editorialCopy' : null;
  },
  spokenText: value => (value as typeof script).text,
  reviewText: value => [(value as typeof script).text, ...(value as typeof script).editorialCopy.map(row => row.text)].join('\n'),
  newsletterCopy: value => structuredClone((value as typeof script).editorialCopy),
};
const input: DailyEditorialInput = { day: '2026-09-15', brief: 'A fictional sports briefing.', stories: sections.map(row => {
  const url = `https://fixtures.example.com/${row.storyId}`, text = row.text + ' SOURCE_ONLY_CAPTURE_NOTE: Additional venue documentation awaits publication.';
  return { id: row.storyId, headline: `${row.storyId} notice`, primaryUrl: url,
    sources: [{ id: `${row.storyId}_source`, url, text, textSha256: textHash(text), rawSha256: textHash('raw:' + text),
      capturedAt: '2026-09-15T00:00:00Z', publishedAt: '2026-09-14' }] };
}) };
const ranges = { scriptBudget: { min: 60, max: 90 }, newsletterBudget: { min: 60, max: 90 } };
const bounds = { ...ranges, scriptFormat };
const supported = (): DailyEditorialReview => ({ verdict: 'supported', reviewedStoryIds: ['Alpha', 'Bravo'], findings: [] });
function routes(reply?: (task: PreparedModelTask, prompt: string) => unknown, legacy = false) {
  const calls: { task: PreparedModelTask; prompt: string; side: string }[] = [];
  const call = (side: 'writer' | 'reviewer'): DraftCall => async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    assert.ok(task); assert.ok(jsonOutputContract(validate)); calls.push({ task, prompt, side });
    const value = reply?.(task, prompt) ?? (side === 'reviewer' ? supported() : task.taskId.includes('newsletter') ? { sections } : legacy ? legacyScript : script);
    const problem = validate(value as T); if (problem) throw new Error(problem); return structuredClone(value) as T;
  };
  return { calls, writer: { identity: { provider: 'ollama', model: 'fictional-writer', runtimeHash: hash('writer') }, call: call('writer') } satisfies DailyEditorialRoute,
    reviewer: { identity: { provider: 'grok', model: 'fictional-reviewer', runtimeHash: hash('reviewer') }, call: call('reviewer') } satisfies DailyEditorialRoute };
}

test('script-first executes factual script review before formatting, with no newsletter factual or source review', async () => {
  const r = routes(), saves: DailyEditorialCheckpoint[] = [];
  const result = await runScriptFirstEditorial(input, { ...r, ...bounds, save: state => { saves.push(state); } });
  assert.deepEqual(r.calls.map(row => row.task.taskId), ['daily-editorial-script-write-1', 'daily-editorial-script-review-1', 'daily-editorial-newsletter-write-1']);
  assert.deepEqual(r.calls.map(row => row.side), ['writer', 'reviewer', 'writer']);
  assert.deepEqual(r.calls.map(row => row.task.role), ['script', 'source-review', 'newsletter-draft']);
  for (const row of r.calls.slice(0, 2)) for (const story of input.stories) assert.ok(row.prompt.includes(story.sources[0]!.text));
  const formatted = r.calls[2]!.prompt;
  assert.match(formatted, /APPROVED SCRIPT AND NEWSLETTER PRESENTATION/);
  assert.ok(formatted.includes(JSON.stringify(script.editorialCopy)));
  assert.ok(!formatted.includes(JSON.stringify(script)), 'The formatter receives approved copy, not short narration to expand');
  assert.ok(!formatted.includes('SOURCE_ONLY_CAPTURE_NOTE'));
  for (const story of input.stories) assert.ok(!formatted.includes(story.sources[0]!.textSha256));
  assert.equal(result.checkpoint.artifacts.script.reviews.length, 1);
  assert.equal(result.checkpoint.artifacts.newsletter.reviews.length, 0);
  assert.equal(result.checkpoint.artifacts.newsletter.formatting?.approvedScriptHash, hash(script));
  assert.equal(result.checkpoint.artifacts.newsletter.formatting?.candidateHash, hash({ sections }));
  assert.equal(saves[0]!.artifacts.script.status, 'writing');
  assert.equal(saves[0]!.artifacts.script.candidates.length, 0);
  assert.deepEqual(result.newsletter.sections.map(row => row.sourceUrls), input.stories.map(row => [row.primaryUrl]));
});

test('one script factual correction is independently re-reviewed before the newsletter sees it', async () => {
  const bad = { ...script, text: script.text.replace('planned local activity', 'completed local activity') };
  const r = routes(task => task.taskId === 'daily-editorial-script-write-1' ? bad
    : task.taskId === 'daily-editorial-script-review-1' ? { verdict: 'changes-required', reviewedStoryIds: ['Alpha', 'Bravo'], findings: [{
      storyId: 'Alpha', kind: 'unsupported', candidateExcerpt: 'completed local activity', evidence: [], reason: 'The notice gives plans, not completion.' }] } : undefined);
  const result = await runScriptFirstEditorial(input, { ...r, ...bounds });
  assert.deepEqual(r.calls.map(row => row.side), ['writer', 'reviewer', 'writer', 'reviewer', 'writer']);
  assert.equal(result.checkpoint.artifacts.script.writes, 2);
  assert.equal(result.checkpoint.artifacts.script.reviews.length, 2);
  assert.equal(result.checkpoint.artifacts.newsletter.reviews.length, 0);
  assert.ok(!r.calls.at(-1)!.prompt.includes('completed local activity'));
  assert.equal(result.checkpoint.artifacts.newsletter.formatting?.approvedScriptHash, hash(script));
});

test('unsupported script holds before any newsletter call and preserves the original attempt', async () => {
  const r = routes(task => task.role === 'source-review' ? { verdict: 'insufficient-evidence', reviewedStoryIds: ['Alpha', 'Bravo'], findings: [{
    storyId: 'Alpha', kind: 'coverage', candidateExcerpt: '', evidence: [], reason: 'The complete source does not settle the event.' }] } : undefined);
  await assert.rejects(runScriptFirstEditorial(input, { ...r, ...bounds }), error => {
    assert.ok(error instanceof DailyEditorialHold);
    assert.equal(error.checkpoint.artifacts.script.candidates.length, 1);
    assert.equal(error.checkpoint.artifacts.newsletter.writes, 0);
    return true;
  });
  assert.equal(r.calls.length, 2);
});

test('newsletter shape and length receive at most one formatting correction, never another factual review', async () => {
  const r = routes(task => task.taskId === 'daily-editorial-newsletter-write-1'
    ? { sections: sections.map(row => ({ storyId: row.storyId, text: 'Too short.' })) } : undefined);
  const result = await runScriptFirstEditorial(input, { ...r, ...bounds });
  assert.equal(r.calls.length, 4);
  assert.equal(r.calls.filter(row => row.side === 'reviewer').length, 1);
  assert.equal(result.checkpoint.artifacts.newsletter.writes, 2);
  assert.equal(result.checkpoint.artifacts.newsletter.reviews.length, 0);
  assert.match(r.calls.at(-1)!.prompt, /required 60–90/);
  assert.ok(!r.calls.at(-1)!.prompt.includes('SOURCE_ONLY_CAPTURE_NOTE'));
});

test('accepted formatting resumes without calls and cannot attach to a changed approved script', async () => {
  const r = routes(); const done = await runScriptFirstEditorial(input, { ...r, ...bounds });
  const resumed = routes(); await runScriptFirstEditorial(input, { ...resumed, ...bounds, checkpoint: done.checkpoint });
  assert.equal(resumed.calls.length, 0);
  const rebound = structuredClone(done.checkpoint);
  const changed = { ...script, text: script.text.replace('planned local activity', 'planned regional activity') };
  rebound.artifacts.script.candidates[0] = changed;
  rebound.artifacts.script.reviews[0]!.candidateHash = hash(changed);
  rebound.contentHash = hash(rebound.artifacts);
  await assert.rejects(runScriptFirstEditorial(input, { ...resumed, ...bounds, checkpoint: rebound }), /approved-script formatting receipt/);
  assert.equal(resumed.calls.length, 0);
  const tampered = structuredClone(done.checkpoint); tampered.artifacts.newsletter.candidates[0] = { sections: [] };
  await assert.rejects(runScriptFirstEditorial(input, { ...resumed, ...bounds, checkpoint: tampered }), /checkpoint identity or contents/);
});

test('reserved script interruption is retained and does not silently reopen its allowance', async () => {
  const r = routes(); let saved: DailyEditorialCheckpoint | undefined;
  await assert.rejects(runScriptFirstEditorial(input, { ...r, ...bounds, save: state => { saved = state; throw new Error('fixture checkpoint write failed'); } }), /checkpoint write failed/);
  assert.equal(r.calls.length, 0); assert.equal(saved?.artifacts.script.writes, 1);
  await assert.rejects(runScriptFirstEditorial(input, { ...r, ...bounds, checkpoint: saved }), /retained writing state/);
  assert.equal(r.calls.length, 0);
});

test('script-first rejects legacy provided-newsletter bypass while v6 accepted replay remains unchanged', async () => {
  const fresh = routes();
  await assert.rejects(runScriptFirstEditorial(input, { ...fresh, ...bounds, providedNewsletter: { draft: { sections } } }), /provided|supplied|script-first/i);
  assert.equal(fresh.calls.length, 0);
  const legacy = routes(undefined, true); const old = await runDailyEditorial(input, { ...legacy, ...ranges });
  assert.deepEqual(legacy.calls.map(row => row.task.taskId), ['daily-editorial-newsletter-write-1', 'daily-editorial-newsletter-review-1', 'daily-editorial-script-write-1', 'daily-editorial-script-review-1']);
  const replay = routes(undefined, true); await runDailyEditorial(input, { ...replay, ...ranges, checkpoint: old.checkpoint });
  assert.equal(replay.calls.length, 0);
  await assert.rejects(runScriptFirstEditorial(input, { ...replay, ...bounds, checkpoint: old.checkpoint }), /checkpoint identity/);
});

test('script-first rejects missing complete-copy contracts before calls or checkpoint reservations', async () => {
  for (const format of [undefined, { ...scriptFormat, newsletterCopy: undefined }]) {
    const r = routes(); let saves = 0;
    await assert.rejects(runScriptFirstEditorial(input, { ...r, ...ranges, scriptFormat: format, save: () => { saves++; } }), /complete reviewed newsletter-copy contract/);
    assert.equal(r.calls.length, 0); assert.equal(saves, 0);
  }
});
