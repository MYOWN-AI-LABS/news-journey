import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runScriptFirstEditorial, DailyEditorialHold, type DailyEditorialInput, type DailyEditorialCheckpoint, type DailyLengthRecovery, type DailyScriptFormat } from './daily-editorial.js';
import { assertExhaustedLengthRecoveryCandidate, prepareEditorialCopyExpansion, editorialCopyAdditionsValidator, applyEditorialCopyExpansion, type EditorialCopyAdditions } from './editorial-length-recovery.js';
import type { DraftCall } from './script.js';
import type { PreparedModelTask } from './writing-task.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textHash = (text: string) => createHash('sha256').update(text).digest('hex');
const words = (text: string) => text.trim().split(/\s+/).length;
// Fictional orchestration controls: not real-model/source acceptance evidence.
const prose = (name: string, length: number) => [name, ...Array.from({ length: length - 2 }, (_, i) => `detail${i}`), 'ends.'].join(' ');
const base = { text: prose('Narration', 203), editorialCopy: ['Alpha', 'Bravo', 'Charlie'].map((storyId, i) => ({ storyId, text: prose(storyId, [293, 300, 273][i]!) })), presentation: 'Must stay exactly the same.' };
const second = { ...base, text: prose('Narration', 188), editorialCopy: base.editorialCopy.map((row, i) => ({ ...row, text: prose(row.storyId, [290, 300, 298][i]!) })) };
const range = { min: 900, max: 1300 };
const shape = (value: unknown): string | null => { const v = value as typeof base; return typeof v.text !== 'string' || !Array.isArray(v.editorialCopy) || v.editorialCopy.length !== 3 ? 'bad shape' : null; };
const format: DailyScriptFormat = { identity: hash('fixed fixture format'), instructions: 'Complete copy and spoken narration.', schema: { type: 'object', additionalProperties: false, required: ['text','editorialCopy','presentation'], properties: { text: { type: 'string' }, presentation: { type: 'string' }, editorialCopy: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['storyId','text'], properties: { storyId: { type: 'string' }, text: { type: 'string' } } } } } }, validateShape: shape,
  validate(value) { const bad = shape(value); if (bad) return bad; const v = value as typeof base, spoken = words(v.text), n = words(v.editorialCopy.map(row => row.text).join(' '));
    if (spoken < 200 || spoken > 225) return `script too short: ${spoken} spoken words (need 200-225). Add only source-supported body detail.`;
    return n < range.min || n > range.max ? `Complete editorialCopy has ${n} words; required 900–1300, separately from spoken narration` : null; },
  spokenText: value => (value as typeof base).text, reviewText: value => JSON.stringify(value), newsletterCopy: value => structuredClone((value as typeof base).editorialCopy) };
const input: DailyEditorialInput = { day: '2026-09-15', brief: 'Fictional sports fixture.', stories: base.editorialCopy.map(row => { const url = `https://fixture.example/${row.storyId}`; return { id: row.storyId, headline: row.storyId, primaryUrl: url,
  sources: [{ id: `${row.storyId}_source`, url, text: row.text, rawSha256: textHash('raw'+row.text), textSha256: textHash(row.text), publishedAt: '2026-09-14', capturedAt: '2026-09-15T00:00:00Z' }] }; }) };
const identity = { provider: 'codex', model: 'fixture-selected-model', runtimeHash: hash('runtime') };
const additions = (): EditorialCopyAdditions => { const plan = prepareEditorialCopyExpansion(base, format, range)!; return { additions: plan.sections.map(row => ({ storyId: row.storyId, text: prose('Additional'+row.storyId, row.min) })) }; };
function routes(reject = false) {
  const calls: string[] = []; let candidate = structuredClone(base);
  const writer: DraftCall = async <T>(_prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    calls.push(task!.taskId); let value: unknown;
    if (/copy-expansion|authorized-length/.test(task!.taskId)) { value = additions(); candidate = applyEditorialCopyExpansion(base, prepareEditorialCopyExpansion(base, format, range)!, value as EditorialCopyAdditions, format); }
    else if (task!.role === 'newsletter-draft') value = { sections: candidate.editorialCopy };
    else value = base;
    const bad = validate(value as T); if (bad) throw new Error(bad); return value as T;
  };
  const reviewer: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    calls.push(task!.taskId); assert.ok(prompt.includes(candidate.editorialCopy[0]!.text.replaceAll('\n', '\\n')));
    const value = reject ? { verdict: 'changes-required', reviewedStoryIds: input.stories.map(row => row.id), findings: [{ storyId: 'Alpha', kind: 'unsupported', candidateExcerpt: 'AdditionalAlpha', evidence: [], reason: 'Fixture rejection remains a factual hold.' }] }
      : { verdict: 'supported', reviewedStoryIds: input.stories.map(row => row.id), findings: [] };
    const bad = validate(value as T); if (bad) throw new Error(bad); return value as T;
  };
  return { calls, writer: { identity, call: writer }, reviewer: { identity, call: reviewer } };
}
const options = { scriptFormat: format, scriptBudget: { min: 200, max: 225 }, newsletterBudget: range };
async function historicalHold() {
  let checkpoint: DailyEditorialCheckpoint | undefined;
  await assert.rejects(runScriptFirstEditorial(input, { ...routes(), ...options, save: value => { checkpoint = value; throw new Error('capture initial identity'); } }), /capture initial/);
  checkpoint!.artifacts.script = { status: 'held', writes: 2, origin: 'model', candidates: [base, second], reviews: [], failures: [format.validate(base)!, format.validate(second)!, `script failed after its one repair: ${format.validate(second)!}`] };
  checkpoint!.contentHash = hash(checkpoint!.artifacts); return checkpoint!;
}
const recovery = (checkpoint: DailyEditorialCheckpoint): DailyLengthRecovery => ({ authorizationHash: hash('explicit user authorization'), checkpointHash: hash(checkpoint), inputHash: hash(input), writerHash: hash(identity), reviewerHash: hash(identity), parentIdentity: hash('bounded continuation'), assertCurrentParent() {} });

test('ordinary single repair preserves valid narration/presentation and bounds only missing complete copy', async () => {
  const r = routes(), result = await runScriptFirstEditorial(input, { ...r, ...options });
  assert.deepEqual(r.calls, ['daily-editorial-script-write-1', 'daily-editorial-script-copy-expansion-2', 'daily-editorial-script-review-2', 'daily-editorial-newsletter-write-1']);
  assert.equal(result.script.wordCount, 203); assert.equal(result.newsletter.wordCount, 960); assert.equal(result.checkpoint.artifacts.script.writes, 2);
  const output = result.script.structured as typeof base; assert.equal(output.text, base.text); assert.equal(output.presentation, base.presentation);
  output.editorialCopy.forEach((row, i) => assert.ok(row.text.startsWith(base.editorialCopy[i]!.text+'\n\n')));
  assert.equal(result.checkpoint.artifacts.newsletter.reviews.length, 0);
});

test('explicit exhausted repair retains both failed candidates and two spent writes, then reviews and formats once', async () => {
  const checkpoint = await historicalHold(), original = structuredClone(checkpoint), r = routes(); let reserved = false;
  const result = await runScriptFirstEditorial(input, { ...r, ...options, checkpoint, lengthRecovery: recovery(checkpoint), save: value => {
    if (value.artifacts.script.lengthRecovery?.status === 'started') { reserved = true; assert.equal(value.artifacts.script.writes, 2); assert.equal(value.artifacts.script.candidates.length, 2); }
  } });
  assert.ok(reserved); assert.equal(result.script.wordCount, 203); assert.equal(result.newsletter.wordCount, 960);
  assert.deepEqual(result.checkpoint.artifacts.script.candidates.slice(0,2), original.artifacts.script.candidates); assert.deepEqual(result.checkpoint.artifacts.script.failures, original.artifacts.script.failures);
  assert.equal(result.checkpoint.artifacts.script.writes, 2); assert.equal(result.checkpoint.artifacts.script.lengthRecovery?.baseIndex, 0); assert.equal(result.checkpoint.artifacts.script.candidates.length, 3);
  assert.deepEqual(r.calls, ['daily-editorial-script-authorized-length-repair','daily-editorial-script-review-2','daily-editorial-newsletter-write-1']);
  const replay = routes(); await runScriptFirstEditorial(input, { ...replay, ...options, checkpoint: result.checkpoint }); assert.equal(replay.calls.length, 0);
});

test('changed evidence/selected model, factual holds, spent recovery and tampered patches cannot buy another call', async () => {
  for (const mutation of ['input', 'writer', 'factual', 'spent']) {
    const cp = await historicalHold(), authorization = recovery(cp), r = routes();
    if (mutation === 'input') authorization.inputHash = hash('changed');
    if (mutation === 'writer') authorization.writerHash = hash('other model');
    if (mutation === 'factual') { cp.artifacts.script.failures[0] = 'unsupported: event date differs'; cp.contentHash = hash(cp.artifacts); authorization.checkpointHash = hash(cp); }
    if (mutation === 'spent') (cp.artifacts.script as any).lengthRecovery = { status: 'started' };
    await assert.rejects(runScriptFirstEditorial(input, { ...r, ...options, checkpoint: cp, lengthRecovery: authorization })); assert.equal(r.calls.length, 0);
  }
  const cp = await historicalHold(), r = routes(true); let held: DailyEditorialCheckpoint | undefined;
  await assert.rejects(runScriptFirstEditorial(input, { ...r, ...options, checkpoint: cp, lengthRecovery: recovery(cp), save: v => { held = v; } }), /Fixture rejection/);
  assert.equal(r.calls.length, 2); assert.equal(held!.artifacts.newsletter.writes, 0); assert.equal(held!.artifacts.script.reviews.length, 1);
  const again = routes(); await assert.rejects(runScriptFirstEditorial(input, { ...again, ...options, checkpoint: held, lengthRecovery: recovery(held!) })); assert.equal(again.calls.length, 0);
  const accepted = await runScriptFirstEditorial(input, { ...routes(), ...options, checkpoint: cp, lengthRecovery: recovery(cp) });
  (accepted.checkpoint.artifacts.script.candidates[2] as any).text = 'Changed narration.'; accepted.checkpoint.contentHash = hash(accepted.checkpoint.artifacts);
  await assert.rejects(runScriptFirstEditorial(input, { ...again, ...options, checkpoint: accepted.checkpoint }), /length recovery receipt/); assert.equal(again.calls.length, 0);
});

test('patches reject wrong ownership, insufficient/overlong additions, changed fixed fields and broken narration', () => {
  const plan = prepareEditorialCopyExpansion(base, format, range)!;
  assert.equal(prepareEditorialCopyExpansion(second, format, range), null);
  const validator = editorialCopyAdditionsValidator(plan);
  for (const n of [plan.sections[0]!.min-1, plan.sections[0]!.max+1]) { const p = additions(); p.additions[0]!.text=prose('Wrongsize',n); assert.match(validator(p)!, /required/); }
  const p = additions(); p.additions.reverse(); assert.match(validator(p)!, /story order/);
  assert.throws(() => applyEditorialCopyExpansion({ ...base, presentation: 'Changed' }, plan, additions(), format), /changed/);
  const cp = { version: 1, identityHash: hash('identity'), artifacts: {} } as DailyEditorialCheckpoint; assert.throws(() => assertExhaustedLengthRecoveryCandidate(cp));
});
