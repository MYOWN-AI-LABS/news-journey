import test from 'node:test';
import assert from 'node:assert/strict';
import { blockingFindings, judgeScript, QC_REPAIR, qcFindingsProblem, verifyFindingQuotes } from './script-qc.js';
import type { Script, Topic } from '../types.js';

const topic = { id: '20260916-roundup', kind: 'roundup', headline: 'Day', stories: [
  { headline: 'Club sells stakes', weight: 'lead', primaryUrl: 'https://example.org/a', verifiedClaims: ['The club agreed a sale, the report says.'] },
] } as unknown as Topic;
const script = { hook: 'A sale.', cta: 'Subscribe for sourced reporting.', body: [{ voiceover: 'The club agreed a sale, the report says.', scene: 'news_card', onScreen: { title: 'Sale' } }],
  publish: { title: 't', description: 'd', linkedinPost: 'l', hashtags: [] }, fullVoiceoverText: '' } as unknown as Script;

test('the script judge is one call against the pinned claims and returns its findings', async () => {
  const calls: { prompt: string; task: { taskId: string; role: string; topicIds: string[] } }[] = [];
  const findings = await judgeScript(topic, script, (async (prompt: string, validate: (v: unknown) => string | null, task: never) => {
    calls.push({ prompt, task: task as never });
    const value = { findings: [{ severity: 'blocking', detail: 'The sale is reported, not confirmed.' }, { severity: 'warn', detail: 'style' }] };
    assert.equal(validate(value), null); return value;
  }) as never);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.prompt, /VERIFIED CLAIMS JSON/); assert.match(calls[0]!.prompt, /agreed a sale/);
  assert.deepEqual(calls[0]!.task.topicIds, ['topic-1']); assert.equal(calls[0]!.task.taskId, 'script-qc'); assert.equal(calls[0]!.task.role, 'source-review');
  assert.deepEqual(blockingFindings(findings), ['The sale is reported, not confirmed.']);
  assert.match(QC_REPAIR(blockingFindings(findings)), /AUTOMATIC QC REPAIR[\s\S]*- The sale is reported, not confirmed\./);
});

test('a blocking finding that quotes wording the script does not contain is a judge defect: kept as a warning receipt, never a block', () => {
  // Grok's second proof run, Sep 17: the judge cited a merged sentence the script never contained and held a correct
  // script. These are Grok's real sentences and the judge's real quote.
  const grok = { ...script, body: [{ voiceover: 'Next, BBC Sport reports Chris Sutton takes on legendary guitarist and Manchester City fan Johnny Marr, AI, and BBC Sport readers for week four Premier League fixtures. The AI predictions were generated using Microsoft Copilot Chat. Why it matters: Sutton is making predictions for all 380 Premier League games this season against AI, BBC Sport readers and a variety of guests.', scene: 'news_card', onScreen: { title: 'Sutton v Marr' } }] } as unknown as Script;
  const fabricated = { severity: 'blocking' as const, detail: 'Story 1 voiceover conflates week-four fixtures with the 380-game run: “this weekend’s fixtures across all 380 games this season” exceeds and merges those claims.' };
  const grounded = { severity: 'blocking' as const, detail: 'Story 1 says “week four Premier League fixtures” but the claim is only that Sutton takes on Marr for this weekend.' };
  const unquoted = { severity: 'blocking' as const, detail: 'The Copilot attribution is not in the verified claims.' };
  const out = verifyFindingQuotes([fabricated, grounded, unquoted, { severity: 'warn', detail: 'style' }], grok);
  assert.equal(out[0]!.severity, 'warn', 'the fabricated quote cannot block');
  assert.match(out[0]!.detail, /^Judge quoted wording the script does not contain.*across all 380/);
  assert.equal(out[1]!.severity, 'blocking', 'a quote that is in the script (curly vs straight quotes, case, spacing normalized) still blocks');
  assert.equal(out[2]!.severity, 'blocking', 'a finding with no quote stays fail-closed');
  assert.deepEqual(blockingFindings(out), [grounded.detail, unquoted.detail]);
});

test('the judge validator accepts an empty pass and rejects malformed findings', () => {
  assert.equal(qcFindingsProblem({ findings: [] }), null);
  assert.match(qcFindingsProblem({}) ?? '', /findings/);
  assert.match(qcFindingsProblem({ findings: [{ severity: 'fatal', detail: 'x' }] }) ?? '', /severity/);
  assert.match(qcFindingsProblem({ findings: [{ severity: 'warn', detail: ' ' }] }) ?? '', /detail/);
});
