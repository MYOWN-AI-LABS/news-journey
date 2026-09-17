import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runDailyEditorial, DailyEditorialHold, type DailyEditorialInput, type DailyNewsletterDraft, type DailyEditorialCheckpoint } from './daily-editorial.js';
import type { NewsletterLengthPlan } from './newsletter-length-tool.js';
import type { DraftCall } from './script.js';
import type { PreparedModelTask } from './writing-task.js';

// Offline control fixtures. These validate orchestration; they are not beta/model acceptance.
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sentence = (name: string, n: number) => `The ${name} notice describes item ${n} as a currently planned local activity subject to the stated conditions.`;
const input: DailyEditorialInput = { day: '2026-09-15', brief: 'Sports coverage.', stories: ['Alpha', 'Bravo', 'Charlie'].map(name => {
  const text = Array.from({ length: 30 }, (_, i) => sentence(name, i + 1)).join(' ') + ' No bridge may open before the safety review.';
  const url = `https://fixtures.example.com/${name.toLowerCase()}`;
  return { id: name, headline: `${name} notice`, primaryUrl: url, sources: [{ id: `${name}-source`, url,
    publishedAt: '2026-09-14', capturedAt: '2026-09-15T00:00:00Z', text, textSha256: hash(text), rawSha256: hash(`raw:${text}`) }] };
}) };
const overlong = (): DailyNewsletterDraft => ({ sections: input.stories.map(story => ({ storyId: story.id,
  text: Array.from({ length: 30 }, (_, i) => sentence(story.id, i + 1)).join(' ') })) });
const speech = input.stories.flatMap(story => Array.from({ length: 4 }, (_, i) => sentence(story.id, i + 1))).join(' ');
function routes(provider: string, mode: 'pass' | 'source-reject' | 'invalid-choice' = 'pass') {
  const calls: { task: PreparedModelTask; prompt: string }[] = [];
  const invoke = (review: boolean): DraftCall => async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    assert.ok(task); calls.push({ task, prompt });
    let response: unknown;
    if (review) {
      for (const story of input.stories) assert.ok(prompt.includes(story.sources[0]!.text), 'Full source remains in every factual review');
      response = mode === 'source-reject' ? { verdict: 'changes-required', reviewedStoryIds: input.stories.map(s => s.id), findings: [{ storyId: 'Alpha', kind: 'missing-condition',
        candidateExcerpt: sentence('Alpha', 1), evidence: [{ sourceId: 'Alpha-source', quote: 'No bridge may open before the safety review.' }], reason: 'The source condition is absent from the assembled candidate.' }] }
        : { verdict: 'supported', reviewedStoryIds: input.stories.map(s => s.id), findings: [] };
    } else if (task.taskId.includes('length-select')) {
      const plan = JSON.parse(prompt.split('CANDIDATE-OWNED UNITS WITH EXACT COUNTS:\n')[1]!.split('\n')[0]!) as NewsletterLengthPlan;
      response = { sections: plan.sections.map(row => ({ storyId: row.storyId, requiredIds: mode === 'invalid-choice' ? [999] : [1], rankedIds: row.units.map(unit => unit.id) })) };
    } else response = task.taskId.includes('newsletter') ? overlong() : { text: speech };
    const failure = validate(response as T); if (failure) throw new Error(failure);
    return response as T;
  };
  return { calls, writer: { identity: { provider, model: `${provider}-control`, runtimeHash: hash(provider) }, call: invoke(false) },
    reviewer: { identity: { provider, model: `${provider}-control`, runtimeHash: hash(provider) }, call: invoke(true) } };
}

test('generic length selection consumes the original repair and requires complete-source QA on every route', async () => {
  for (const provider of ['ollama', 'opencode', 'openai-compatible']) {
    const model = routes(provider); const saved: DailyEditorialCheckpoint[] = [];
    const result = await runDailyEditorial(input, { ...model, save: s => { saved.push(s); } });
    assert.equal(result.newsletter.wordCount, 1292);
    const state = result.checkpoint.artifacts.newsletter;
    assert.equal(state.writes, 2); assert.equal(state.candidates.length, 2); assert.equal(state.reviews.length, 1);
    assert.equal(state.lengthSelections!.length, 1); assert.equal(state.lengthSelections![0]!.status, 'pending-full-source-review');
    assert.equal(state.status, 'accepted');
    assert.deepEqual(model.calls.map(c => c.task.taskId), ['daily-editorial-newsletter-write-1', 'daily-editorial-newsletter-length-select-2', 'daily-editorial-newsletter-review-2', 'daily-editorial-script-write-1', 'daily-editorial-script-review-1']);
    assert.ok(saved.some(s => s.artifacts.newsletter.status === 'writing' && s.artifacts.newsletter.writes === 2 && s.artifacts.newsletter.candidates.length === 1), 'The repair is reserved before the selection call');
    const calls = model.calls.length;
    await runDailyEditorial(input, { ...model, checkpoint: result.checkpoint });
    assert.equal(model.calls.length, calls, 'An accepted exact checkpoint makes no new call');
  }
});

test('mechanically fitting whole units never override a factual rejection or obtain another repair', async () => {
  const model = routes('ollama', 'source-reject'); let held: DailyEditorialCheckpoint | undefined;
  await assert.rejects(runDailyEditorial(input, model), error => {
    assert.ok(error instanceof DailyEditorialHold); held = error.checkpoint; const state = held.artifacts.newsletter;
    assert.equal(state.status, 'held'); assert.equal(state.writes, 2); assert.equal(state.candidates.length, 2);
    assert.equal(state.reviews.length, 1); assert.equal(state.lengthSelections![0]!.finalWords, 1292);
    assert.equal(held.artifacts.script.writes, 0); return true;
  });
  const calls = model.calls.length;
  await assert.rejects(runDailyEditorial(input, { ...model, checkpoint: held }), /retained held state/);
  assert.equal(model.calls.length, calls, 'Retry never renews a spent logical allowance');
});

test('invalid unit ownership fails within the existing repair and cannot reach review', async () => {
  const model = routes('opencode', 'invalid-choice');
  await assert.rejects(runDailyEditorial(input, model), error => {
    assert.ok(error instanceof DailyEditorialHold); const state = error.checkpoint.artifacts.newsletter;
    assert.equal(state.writes, 2); assert.equal(state.candidates.length, 1); assert.equal(state.reviews.length, 0);
    assert.equal(model.calls.length, 2); return true;
  });
});
