import assert from 'node:assert/strict';
import test from 'node:test';
import { formatScriptNewsletter, type ScriptNewsletterCheckpoint } from './newsletter-from-script.js';
import { roleHash } from '../llm/role-router.js';
import type { Script, Topic } from '../types.js';
import type { DraftCall } from './script.js';
import type { PreparedModelTask } from './writing-task.js';

const paragraph = 'The club published its provisional schedule. The dates remain subject to venue approval, and the notice reports no completed matches.';
const topic: Topic = { id: '20260915-fixture-script-newsletter', kind: 'news', headline: 'Club schedule notice', angle: 'Future schedule',
  primaryUrl: 'https://fixtures.example.com/club', sourceItems: [], repo: null, alternates: [] };
const script: Script = { editorialCopy: [{ storyId: 'topic-1', text: paragraph }], hook: 'A provisional club schedule.', intro: 'Fixture publication.',
  body: [{ voiceover: paragraph, scene: 'news_card', onScreen: { title: 'Club schedule notice' }, assetRef: 'og-0' }],
  cta: 'Read the source.', fullVoiceoverText: paragraph,
  publish: { title: 'Club schedule', description: 'A provisional schedule.', linkedinPost: 'A provisional schedule.', hashtags: [] } };
function setup(replies: unknown[] = [{ sections: [{ text: paragraph }] }]) {
  const calls: { prompt: string; task: PreparedModelTask }[] = [], saves: ScriptNewsletterCheckpoint[] = [];
  const call: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    assert.ok(task); calls.push({ prompt, task });
    assert.equal(saves.at(-1)?.writes, calls.length, 'Reserve before each formatting call');
    const value = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (value instanceof Error) throw value;
    const problem = validate(value as T); if (problem) throw new Error(problem);
    return structuredClone(value) as T;
  };
  const options = { script, topic, writerKey: 'exact-runtime', publication: 'Fixture Press', day: '2026-09-15',
    budget: { min: 15, max: 30 }, call, save: (state: ScriptNewsletterCheckpoint) => { saves.push(structuredClone(state)); } };
  return { options, calls, saves };
}

test('generic formatter uses only accepted script presentation and keeps code-owned source links', async () => {
  const x = setup(); const issue = await formatScriptNewsletter(x.options);
  assert.equal(x.calls.length, 1); assert.equal(x.calls[0]!.task.role, 'newsletter-draft');
  assert.ok(x.calls[0]!.prompt.includes(JSON.stringify(script.editorialCopy)));
  assert.match(x.calls[0]!.prompt, /Do not add research, facts, source checks or another factual review/);
  assert.ok(!x.calls[0]!.prompt.includes(topic.primaryUrl));
  assert.equal(issue.lead.body, paragraph); assert.equal(issue.lead.sourceUrl, topic.primaryUrl);
  assert.deepEqual(issue.radar, []); assert.deepEqual(issue.signals, []);
  assert.equal(x.saves[0]!.writes, 1); assert.equal(x.saves[0]!.candidate, undefined);
});

test('one shape/length correction is bounded and the original minimum remains in the repair prompt', async () => {
  for (const bad of [{ sections: [{ text: 'Short.' }] }, { sections: [{ text: paragraph + ' https://bad.example/' }] }, { sections: [] }]) {
    const x = setup([bad, { sections: [{ text: paragraph }] }]);
    const result = await formatScriptNewsletter(x.options);
    assert.equal(result.lead.body, paragraph); assert.equal(x.calls.length, 2);
    assert.equal(x.calls[1]!.task.capability, 'newsletter-edit');
    assert.match(x.calls[1]!.prompt, /15–30 words/);
    assert.equal(x.saves.at(-1)!.writes, 2);
  }
});

test('exhausted formatting resumes without replenishing calls or accepted status', async () => {
  const x = setup([{ sections: [{ text: 'Short.' }] }]);
  await assert.rejects(formatScriptNewsletter(x.options), /bounded correction/);
  assert.equal(x.calls.length, 2); const checkpoint = x.saves.at(-1)!;
  assert.equal(checkpoint.accepted, false); assert.equal(checkpoint.writes, 2);
  await assert.rejects(formatScriptNewsletter({ ...x.options, checkpoint }), /bounded correction/);
  assert.equal(x.calls.length, 2);
});

test('accepted formatting cache binds exact script bytes, writer, date, publication, source and budget', async () => {
  const x = setup(); const first = await formatScriptNewsletter(x.options), checkpoint = x.saves.at(-1)!;
  assert.deepEqual(await formatScriptNewsletter({ ...x.options, checkpoint }), first); assert.equal(x.calls.length, 1);
  const changes = [
    { script: { ...script, fullVoiceoverText: paragraph + ' Changed.' } },
    { writerKey: 'other-runtime' }, { day: '2026-09-16' }, { publication: 'Other publication' },
    { topic: { ...topic, primaryUrl: 'https://fixtures.example.com/other' } }, { budget: { min: 16, max: 30 } },
  ];
  for (const change of changes) await assert.rejects(formatScriptNewsletter({ ...x.options, ...change, checkpoint }), /context changed/);
  const bad = structuredClone(checkpoint); bad.candidate!.sections[0]!.text = 'Changed text.';
  await assert.rejects(formatScriptNewsletter({ ...x.options, checkpoint: bad }), /context changed/);
  assert.equal(x.calls.length, 1);
});

test('invalid ranges and corrupted checkpoint flags cannot become accepted formatting', async () => {
  const x = setup();
  for (const budget of [{ min: Number.NaN, max: Number.POSITIVE_INFINITY }, { min: 0, max: 0 }, { min: 30, max: 15 }, { min: 15, max: 1301 }]) {
    await assert.rejects(formatScriptNewsletter({ ...x.options, budget }));
  }
  assert.equal(x.calls.length, 0);
  await formatScriptNewsletter(x.options); const checkpoint = x.saves.at(-1)!;
  for (const change of [{ accepted: 'yes' }, { accepted: true, writes: 0 }, { failures: 'not-an-array' }]) {
    await assert.rejects(formatScriptNewsletter({ ...x.options, checkpoint: { ...checkpoint, ...change } as ScriptNewsletterCheckpoint }));
  }
  assert.equal(x.calls.length, 1);
  assert.equal(checkpoint.candidateHash, roleHash(checkpoint.candidate));
});


test('missing or insufficient reviewed copy stops before any newsletter call', async () => {
  const x = setup();
  await assert.rejects(formatScriptNewsletter({ ...x.options, script: { ...script, editorialCopy: undefined } }), /complete source-reviewed editorialCopy/);
  await assert.rejects(formatScriptNewsletter({ ...x.options, budget: { min: 900, max: 1300 } }), /before newsletter formatting/);
  await assert.rejects(formatScriptNewsletter({ ...x.options, script: { ...script, editorialCopy: [{ storyId: 'topic-2', text: paragraph }] } }), /every selected story/);
  assert.equal(x.calls.length, 0);
});

test('formatter accepts paragraph breaks but holds changed facts without a factual-review call', async () => {
  const formatted = paragraph.replace('. The dates', '.\n\nThe dates');
  const x = setup([{ sections: [{ text: formatted }] }]);
  assert.equal((await formatScriptNewsletter(x.options)).lead.body, formatted);
  const y = setup([{ sections: [{ text: paragraph.replace('provisional', 'confirmed') }] }]);
  await assert.rejects(formatScriptNewsletter(y.options), /changed approved editorialCopy wording/);
  assert.equal(y.calls.length, 2);
  assert.ok(y.calls.every(row => row.task.role === 'newsletter-draft'));
  assert.equal(y.saves.at(-1)!.accepted, false);
});

test('a rehashed accepted cache still cannot change the approved words', async () => {
  const x = setup(); await formatScriptNewsletter(x.options);
  const checkpoint = structuredClone(x.saves.at(-1)!);
  checkpoint.candidate!.sections[0]!.text = paragraph.replace('provisional', 'confirmed');
  checkpoint.candidateHash = roleHash(checkpoint.candidate);
  await assert.rejects(formatScriptNewsletter({ ...x.options, checkpoint }), /formatting result is invalid/);
  assert.equal(x.calls.length, 1);
});


test('newsletter headings come from reviewed script fields rather than unchecked topic labels', async () => {
  const x = setup(); const editedScript = structuredClone(script);
  editedScript.body[0]!.onScreen.title = 'Reviewed provisional schedule';
  editedScript.publish.description = 'Sources: https://fixtures.example/private-presentation-link';
  const issue = await formatScriptNewsletter({ ...x.options, script: editedScript, topic: { ...topic, headline: 'An unchecked headline' } });
  assert.equal(issue.lead.title, 'Reviewed provisional schedule');
  assert.ok(!x.calls[0]!.prompt.includes('An unchecked headline'));
  assert.ok(!x.calls[0]!.prompt.includes('https://fixtures.example/private-presentation-link'));
});
