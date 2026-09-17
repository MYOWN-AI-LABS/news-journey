import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson } from '../workspaces.js';
import { beginParentWork, parentModelHooks, roleHash, type ParentWorkScope } from '../llm/role-router.js';
import { runScriptFirstEditorial, type DailyEditorialCheckpoint, type DailyEditorialInput, type DailyEditorialReview, type DailyScriptFormat, type DailyEditorialRoute } from './daily-editorial.js';
import { reconcileJourneyInvalidReviewResponse, readJourneyReviewRecovery } from './journey-transport-reconciliation.js';

const text = 'The club announced a provisional schedule for the tournament. Organizers said the venue remains subject to inspection and no matches have taken place.';
const input: DailyEditorialInput = { day: '2026-09-15', brief: 'A sourced sports briefing.', stories: [{ id: 'topic-1', headline: 'Club announces provisional tournament schedule', primaryUrl: 'https://example.com/sport', sources: [{ id: 'source-1', url: 'https://example.com/sport', publishedAt: null, capturedAt: '2026-09-15T00:00:00Z', text, textSha256: createHash('sha256').update(text).digest('hex'), rawSha256: 'a'.repeat(64) }] }] };
const candidate = { text, editorialCopy: [{ storyId: 'topic-1', text }] };
const format: DailyScriptFormat = { identity: 'fixture-complete-copy', instructions: 'Return text and editorialCopy.', schema: { type: 'object', additionalProperties: false, required: ['text', 'editorialCopy'], properties: { text: { type: 'string' }, editorialCopy: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['storyId', 'text'], properties: { storyId: { type: 'string' }, text: { type: 'string' } } } } } }, validate: value => roleHash(value) === roleHash(candidate) ? null : 'Candidate changed', spokenText: value => (value as typeof candidate).text, reviewText: value => (value as typeof candidate).text, newsletterCopy: value => (value as typeof candidate).editorialCopy };
const supported: DailyEditorialReview = { verdict: 'supported', reviewedStoryIds: ['topic-1'], findings: [] };
const invalidMessage = "Codex CLI failed after retry: JSON5: invalid character ']' at 1:1772";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-recovery-')), id = '20260915-sports';
  const dir = join(root, 'workdir/videos', id), checkpointPath = join(dir, 'journey-editorial-checkpoint.json');
  mkdirSync(dir, { recursive: true }); let now = 1000;
  const parent: ParentWorkScope = { root, parentId: id, parentIdentity: 'b'.repeat(64), limits: { maxPhysicalCalls: 8, maxToolCalls: 2, totalSeconds: 60 }, now: () => now };
  const identity = { provider: 'codex', model: 'fixture-model', runtimeHash: 'c'.repeat(64) };
  const calls: string[] = []; let nextReview: DailyEditorialReview | null = null;
  const reserve = (task: string) => parentModelHooks(parent, task).beforeAttempt!({ provider: 'codex', model: 'fixture-model', attempt: 1, rescue: false, promptBytes: 100 });
  const writer: DailyEditorialRoute = { identity, call: async <T>(_prompt: string, _validate: (value: T) => string | null, task: any) => {
    calls.push(task.taskId); reserve(task.taskId); return structuredClone(task.role === 'script' ? candidate : { sections: candidate.editorialCopy }) as T;
  } };
  const reviewer: DailyEditorialRoute = { identity, call: async <T>(_prompt: string, _validate: (value: T) => string | null, task: any) => {
    calls.push(task.taskId); reserve(task.taskId);
    if (!nextReview) { reserve(task.taskId); throw new Error(invalidMessage); }
    return structuredClone(nextReview) as T;
  } };
  const save = (state: DailyEditorialCheckpoint) => atomicJson(checkpointPath, state);
  const options = { writer, reviewer, scriptFormat: format, scriptBudget: { min: 10, max: 50 }, newsletterBudget: { min: 10, max: 50 }, save };
  await assert.rejects(runScriptFirstEditorial(input, options), /factual reviewer unavailable or invalid/);
  const read = () => JSON.parse(readFileSync(checkpointPath, 'utf8')) as DailyEditorialCheckpoint;
  const original = read();
  atomicJson(join(dir, 'writing-request.json'), { parentIdentity: parent.parentIdentity });
  atomicJson(join(dir, 'journey-editorial-input.json'), { input, hash: roleHash(input) });
  const authorize = () => reconcileJourneyInvalidReviewResponse(root, id, { intent: 'retry-invalid-review-response', expectedCheckpointHash: roleHash(original), input, reviewer: identity, parent });
  const recovery = () => readJourneyReviewRecovery(root, id, input, identity, parent);
  const budgetPath = join(root, 'state/role-tasks', id, roleHash({ version: 1, parent: parent.parentIdentity }), 'budget.json');
  return { root, dir, id, parent, identity, options, read, original, authorize, recovery, calls, reserve, budgetPath, setTime: (v: number) => { now = v; }, setReview: (v: DailyEditorialReview) => { nextReview = v; }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('explicit recovery reviews the identical saved script once then formats newsletter under original spent allowance', async () => {
  const f = await fixture();
  try {
    const beforeBudget = readFileSync(f.budgetPath, 'utf8'), beforeCheckpoint = readFileSync(join(f.dir, 'journey-editorial-checkpoint.json'), 'utf8');
    const auth = f.authorize();
    assert.equal(readFileSync(f.budgetPath, 'utf8'), beforeBudget); assert.equal(readFileSync(join(f.dir, 'journey-editorial-checkpoint.json'), 'utf8'), beforeCheckpoint);
    assert.deepEqual(auth.originalCheckpoint, f.original); assert.throws(f.authorize, /EEXIST/);
    f.setReview(supported); const calls = f.calls.length;
    const result = await runScriptFirstEditorial(input, { ...f.options, checkpoint: f.read(), reviewRecovery: f.recovery() });
    assert.deepEqual(f.calls.slice(calls), ['daily-editorial-script-review-1', 'daily-editorial-newsletter-write-1']);
    assert.deepEqual(result.checkpoint.artifacts.script.candidates, f.original.artifacts.script.candidates);
    assert.equal(result.checkpoint.artifacts.script.writes, 1); assert.deepEqual(result.checkpoint.artifacts.script.failures, f.original.artifacts.script.failures);
    assert.equal(result.checkpoint.artifacts.script.reviews.length, 1); assert.equal(result.checkpoint.artifacts.newsletter.reviews.length, 0);
    const budget = beginParentWork(f.parent); assert.equal(budget.physicalAttempts, 5); assert.equal(budget.deadline, 61000);
    assert.equal(f.recovery(), undefined); f.setTime(70000);
    await runScriptFirstEditorial(input, { ...f.options, checkpoint: f.read() }); assert.equal(f.calls.length, calls + 2);
  } finally { f.cleanup(); }
});

test('a substantive recovered finding remains held without rewriting candidate or formatting newsletter', async () => {
  const f = await fixture();
  try {
    f.authorize(); f.setReview({ verdict: 'changes-required', reviewedStoryIds: ['topic-1'], findings: [{ storyId: 'topic-1', kind: 'unsupported', candidateExcerpt: 'no matches have taken place', evidence: [], reason: 'Fixture material finding must be retained.' }] });
    const calls = f.calls.length;
    await assert.rejects(runScriptFirstEditorial(input, { ...f.options, checkpoint: f.read(), reviewRecovery: f.recovery() }), /remains unsupported/);
    const held = f.read(); assert.equal(held.artifacts.script.status, 'held'); assert.equal(held.artifacts.script.writes, 1); assert.equal(held.artifacts.script.reviews[0]!.output.verdict, 'changes-required');
    assert.deepEqual(held.artifacts.script.candidates, f.original.artifacts.script.candidates); assert.equal(held.artifacts.newsletter.writes, 0); assert.equal(f.calls.length, calls + 1);
    assert.equal(f.recovery(), undefined); await assert.rejects(runScriptFirstEditorial(input, { ...f.options, checkpoint: held }), /retained held/); assert.equal(f.calls.length, calls + 1);
  } finally { f.cleanup(); }
});

test('crash after recovery consumption cannot reenter or regain reviewer allowance', async () => {
  const f = await fixture();
  try {
    f.authorize(); f.setReview(supported); const calls = f.calls.length;
    await assert.rejects(runScriptFirstEditorial(input, { ...f.options, checkpoint: f.read(), reviewRecovery: f.recovery(), save: state => { f.options.save(state); if (state.artifacts.script.reviewRecovery) throw new Error('fixture interrupted after durable consumption'); } }), /interrupted/);
    assert.ok(f.read().artifacts.script.reviewRecovery); assert.equal(f.recovery(), undefined);
    await assert.rejects(runScriptFirstEditorial(input, { ...f.options, checkpoint: f.read() }), /retained held/);
    assert.equal(f.calls.length, calls); assert.equal(beginParentWork(f.parent).physicalAttempts, 3);
  } finally { f.cleanup(); }
});

test('expired, exhausted, missing or altered original parent cannot authorize or execute recovery', async () => {
  for (const mode of ['expired', 'exhausted', 'missing', 'renewed'] as const) {
    const f = await fixture();
    try {
      f.authorize(); const beforeCheckpoint = readFileSync(join(f.dir, 'journey-editorial-checkpoint.json'), 'utf8');
      if (mode === 'expired') f.setTime(61000);
      if (mode === 'exhausted') for (let i = 0; i < 5; i++) f.reserve('sibling');
      if (mode === 'missing') rmSync(f.budgetPath);
      if (mode === 'renewed') { const value = JSON.parse(readFileSync(f.budgetPath, 'utf8')); value.deadline++; atomicJson(f.budgetPath, value); }
      assert.throws(f.recovery, /parent|ENOENT/); assert.equal(readFileSync(join(f.dir, 'journey-editorial-checkpoint.json'), 'utf8'), beforeCheckpoint); assert.equal(f.calls.length, 2);
    } finally { f.cleanup(); }
  }
});

test('source, reviewer, candidate and recognized-failure identities are required; unknown/substantive holds do not migrate', async () => {
  const f = await fixture();
  try {
    f.authorize();
    assert.throws(() => readJourneyReviewRecovery(f.root, f.id, { ...input, brief: 'Changed' }, f.identity, f.parent), /source|reviewer/);
    assert.throws(() => readJourneyReviewRecovery(f.root, f.id, input, { ...f.identity, model: 'another' }, f.parent), /reviewer/);
    const changed = structuredClone(f.original); (changed.artifacts.script.candidates[0] as any).text += ' Changed.'; changed.contentHash = roleHash(changed.artifacts);
    atomicJson(join(f.dir, 'journey-editorial-checkpoint.json'), changed); assert.throws(f.recovery, /checkpoint changed/);
    for (const failure of ['script remains unsupported: factual contradiction', 'script factual reviewer unavailable or invalid: unknown network error']) {
      const altered = structuredClone(f.original); altered.artifacts.script.failures = [failure]; altered.contentHash = roleHash(altered.artifacts);
      atomicJson(join(f.dir, 'journey-editorial-checkpoint.json'), altered);
      assert.throws(() => reconcileJourneyInvalidReviewResponse(f.root, f.id, { intent: 'retry-invalid-review-response', expectedCheckpointHash: roleHash(altered), input, reviewer: f.identity, parent: f.parent }), /recognized invalid-response/);
    }
  } finally { f.cleanup(); }
});
