import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { runDailyEditorial, type DailyEditorialInput, type DailyEditorialRoute, type DailyScriptFormat } from './daily-editorial.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRescueBudgetFiles, verifyRescueEditorialBundle } from './journey-rescue-adoption.js';
import type { Topic } from '../types.js';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => sha(JSON.stringify(value));
const sentence = (name: string, n: number) => `The ${name} notice describes item ${n} as a currently planned local activity subject to the stated conditions.`;
const input: DailyEditorialInput = { day: '2026-09-15', brief: 'Offline fictional sports control.', stories: ['Alpha', 'Bravo', 'Charlie'].map(name => {
  const text = Array.from({ length: 20 }, (_, i) => sentence(name, i + 1)).join(' '), url = `https://fixtures.example/${name}`;
  return { id: name, headline: name, primaryUrl: url, sources: [{ id: `${name}-source`, url, text, textSha256: sha(text), rawSha256: sha(`raw:${text}`), publishedAt: '2026-09-14', capturedAt: '2026-09-15T00:00:00Z' }] };
}) };
const newsletter = { sections: input.stories.map(row => ({ storyId: row.id, text: row.sources[0]!.text })) };
const text = input.stories.flatMap(row => Array.from({ length: 4 }, (_, i) => sentence(row.id, i + 1))).join(' ');
const script = { narration: text, publication: 'Fictional planned notices with conditions.' };
const format: DailyScriptFormat = { identity: sha('strict-original-script-recipe'), schema: { type: 'object', additionalProperties: false, required: ['narration', 'publication'], properties: { narration: { type: 'string' }, publication: { type: 'string' } } }, instructions: 'Return narration and publication.',
  validate: value => { const v = value as typeof script; return v && Object.keys(v).sort().join(',') === 'narration,publication' && typeof v.narration === 'string' && typeof v.publication === 'string' ? null : 'Exact complete script fields required'; },
  spokenText: value => (value as typeof script).narration, reviewText: value => Object.values(value as typeof script).join('\n') };
const identity = { provider: 'codex', model: 'offline-test-model', runtimeHash: sha('mocked-rescue-runtime') };
const recipe = { identity, originalTopic: {} as Topic, intro: '', newsletterBudget: { min: 900, max: 1300 }, scriptBudget: { min: 195, max: 220 }, formatIdentity: format.identity,
  providedNewsletter: { draft: newsletter, provenance: { origin: 'offline-original-held-candidate' } } };
async function accepted() {
  let calls = 0;
  const call: DailyEditorialRoute['call'] = async <T>(prompt: string, validate: (value: T) => string | null) => {
    calls++; const value = prompt.startsWith('Write') ? script : { verdict: 'supported', reviewedStoryIds: input.stories.map(row => row.id), findings: [] };
    assert.equal(validate(value as T), null); return value as T;
  };
  const result = await runDailyEditorial(input, { maxEvidenceBytes: 131072, scriptFormat: format, newsletterBudget: recipe.newsletterBudget, scriptBudget: recipe.scriptBudget, providedNewsletter: recipe.providedNewsletter,
    writer: { identity, call }, reviewer: { identity, call: (...args) => call(...args) } });
  assert.equal(calls, 3); return result;
}
test('accepted rescue revalidates complete original recipe without another model call or changing checkpoint', async () => {
  const result = await accepted(), before = JSON.stringify(result.checkpoint);
  const reused = await verifyRescueEditorialBundle(input, result.checkpoint, recipe, format);
  assert.equal(reused.newsletter.wordCount, 1020); assert.equal(reused.script.wordCount, 204); assert.equal(JSON.stringify(reused.checkpoint), before);
});
test('adoption rejects held state, changed text, wrong original recipe, different model and source hash', async () => {
  const result = await accepted();
  const held = structuredClone(result.checkpoint); held.artifacts.script.status = 'held'; held.contentHash = hash(held.artifacts);
  await assert.rejects(verifyRescueEditorialBundle(input, held, recipe, format), /already reviewed/);
  const changed = structuredClone(result.checkpoint); (changed.artifacts.script.candidates.at(-1) as unknown as typeof script).publication = 'Unreviewed changed publication field'; changed.contentHash = hash(changed.artifacts);
  await assert.rejects(verifyRescueEditorialBundle(input, changed, recipe, format), /exact factual review/);
  await assert.rejects(verifyRescueEditorialBundle(input, result.checkpoint, { ...recipe, formatIdentity: sha('wrong') }, format), /recipe changed/);
  await assert.rejects(verifyRescueEditorialBundle(input, result.checkpoint, { ...recipe, identity: { ...identity, model: 'another-model' } }, format), /identity or contents/);
  const badSource = structuredClone(input); badSource.stories[0]!.sources[0]!.textSha256 = sha('wrong');
  await assert.rejects(verifyRescueEditorialBundle(badSource, result.checkpoint, recipe, format), /source|hash|capture/i);
  await assert.rejects(verifyRescueEditorialBundle(input, result.checkpoint, { ...recipe, newsletterBudget: { min: 900, max: 1000 } }, format), /identity or contents/);
});

test('original and editorial allowances stay byte-bound and missing media ledger cannot reset a phase', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rescue-budget-control-'));
  const original = { path: join(dir, 'original.json'), hash: sha('original-expired-deadline') }, editorial = { path: join(dir, 'editorial.json'), hash: sha('accepted-writing-existing-budget') }, media = join(dir, 'media.json');
  try {
    writeFileSync(original.path, 'original-expired-deadline'); writeFileSync(editorial.path, 'accepted-writing-existing-budget');
    assert.throws(() => assertRescueBudgetFiles(original, editorial, media), /missing.*renew/);
    writeFileSync(media, 'existing-media-budget'); assertRescueBudgetFiles(original, editorial, media);
    writeFileSync(original.path, 'renewed-deadline'); assert.throws(() => assertRescueBudgetFiles(original, editorial, media), /Original failed budget changed/);
    writeFileSync(original.path, 'original-expired-deadline'); writeFileSync(editorial.path, 'reset-writing-calls');
    assert.throws(() => assertRescueBudgetFiles(original, editorial, media), /editorial-rescue budget changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
