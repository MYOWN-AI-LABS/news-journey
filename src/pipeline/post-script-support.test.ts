import assert from 'node:assert/strict';
import test from 'node:test';
import type { Script, Topic, TopicStory } from '../types.js';
import { reviewCompletedScript, FIXED_SCRIPT_CTA } from './post-script-support.js';
import { scriptProblem, type DraftCall } from './script.js';
import { dialogueProblem, type Cast } from './cast.js';
import { assertPreparedModelTask, type PreparedModelTask } from './writing-task.js';

import { syntheticPassingFactualResponse } from './factual-obligations.test-fixture.js';
import { factualConditionsPrompt, factualModalityPrompt, preflightFactualModalityPrompt, factualModalityBatches, type FactualConditionsReview, type FactualModalityReview } from './factual-obligations.js';
import { createSourceSupportContext, sourceSupportPrompt } from './source-support.js';
import type { DraftAssertionsResponse } from './draft-assertions.js';

const claims = ['The council published a proposed service map.', 'The proposed route would connect the library with the station.',
  'The map identifies two provisional stops.', 'The council will decide the route after consultation.'];
const story = (n = 1): TopicStory => ({ n, headline: 'A proposed service map', primaryUrl: `https://council.example/map-${n}`, summary: 'An unverified summary is not the factual packet.',
  weight: 'lead', suggestedScene: 'news_card', assetRef: `og-${n - 1}`, repo: null, principalEntity: 'Council', area: 'local', verticals: ['transport'],
  verifiedClaims: [...claims], claimEvidence: [{ role: 'primary', url: `https://council.example/map-${n}`, status: 200, sha256: 'a'.repeat(64), textSha256: 'b'.repeat(64), observedAt: '2026-09-09T12:00:00Z', publishedAt: '2026-09-08',
    restrictions: [{ sourceSentenceId: 9, text: 'The provisional route requires a council vote before service begins.' }] }] });
const topic = (roundup = false): Topic => ({ id: '20260909-map', kind: roundup ? 'roundup' : 'news', headline: 'A proposed service map', primaryUrl: story().primaryUrl,
  sourceItems: [], angle: 'An unverified angle.', repo: null, alternates: [], stories: roundup ? [story(), story(2)] : [story()] });
const motion = { who: 'The council', what: 'published a proposed map', how: 'a proposed library to station route', impact: 'Two provisional stops', status: 'Proposed', kind: 'flow' as const };
const script = (): Script => ({ hook: 'A council route remains proposed.', cta: 'A model-written value promise.', fullVoiceoverText: '',
  body: [claims.slice(0, 2), claims.slice(2)].map((rows, index) => ({ voiceover: rows.join(' '), scene: 'news_card', assetRef: `model-guessed-${index}`,
    onScreen: { title: 'A proposed service map', stat: 'Two provisional stops', sub: 'The council will decide after consultation.' }, motion: { ...motion } })),
  publish: { title: 'A proposed service map', description: 'The council published a proposed service map.', linkedinPost: 'The route remains subject to consultation.', hashtags: ['#Transport'] } });
const options = (input = topic(), validate = (value: Script) => scriptProblem(value, input, { min: 20, max: 110 }, input.kind === 'roundup')) => ({ topic: input, day: '2026-09-09', writerKey: 'exact-writer-and-parent', validateFinal: validate });
const line = (prompt: string, key: string) => JSON.parse(prompt.split('\n').find(row => row.startsWith(key + ': '))!.slice(key.length + 2));
const accepted = (prompt: string): any => syntheticPassingFactualResponse(prompt) ?? (prompt.startsWith('SOURCE SUPPORT REVIEW')
  ? { sentences: line(prompt, 'REVIEW_SENTENCE_IDS').map((id: number) => ({ id, supported: true, claimIds: [1, 2, 3, 4], reason: 'Injected source review; not a measured model verdict.' })) }
  : { fields: line(prompt, 'AUTHORED_FIELDS').map((field: { id: string }) => ({ id: field.id, supported: true, claimIds: [1], reason: 'Injected field review; not a measured model verdict.' })) });
const good = (seen: { prompt: string; task: PreparedModelTask }[] = []): DraftCall => async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
  assertPreparedModelTask(task); seen.push({ prompt, task }); const value = accepted(prompt) as T;
  assert.equal(validate(value), null); return value;
};

test('direct-script narration preflights all general prompts before spending affordable focused calls', async () => {
  const input = script(), originalTopic = topic(), source = originalTopic.stories![0]!;
  const pinned = Array.from({ length: 23 }, (_, i) => `The fictional service records feature group ${i + 1} ${'using a declared schema and record key '.repeat(1)}.`);
  const sentences = Array.from({ length: 16 }, (_, i) => `The fictional service records entry ${i + 1} ${'subject to consultation and the documented plan '.repeat(5)}with these original settings preserved.`);
  source.primaryUrl = 'https://source.example.org/release'; source.verifiedClaims = pinned;
  source.claimEvidence![0] = { ...source.claimEvidence![0]!, url: source.primaryUrl,
    restrictions: [{ sourceSentenceId: 1, text: 'Condition 1 requires the declared schema and unchanged record key during the partial write.' }] };
  input.body[0]!.voiceover = sentences.slice(0, 8).join(' '); input.body[1]!.voiceover = sentences.slice(8).join(' ');
  const context = createSourceSupportContext('2026-09-09', source.primaryUrl, source.claimEvidence!), text = sentences.join(' ');
  assert.ok(factualConditionsPrompt(text, pinned, context).length <= 14000);
  for (const ids of factualModalityBatches(text, 'short-batches')) assert.ok(preflightFactualModalityPrompt(text, pinned, context, ids).length <= 14000);
  const completeGeneral = sourceSupportPrompt(text, pinned, [1, 2, 3, 4], context, { asserted: [1, 2, 3, 4], evidenceLimit: [] }, [1, 2, 3, 4]);
  assert.ok(completeGeneral.length > 14000 && completeGeneral.length <= 14200);
  assert.deepEqual(line(completeGeneral, 'PINNED_CLAIMS').map((row: { text: string }) => row.text), pinned);
  assert.deepEqual(line(completeGeneral, 'DRAFT_SENTENCES').map((row: { text: string }) => row.text), sentences);
  assert.deepEqual(line(completeGeneral, 'SOURCE_CONTEXT'), context);
  const before = structuredClone(input); let calls = 0;
  await assert.rejects(reviewCompletedScript(input, options(originalTopic, () => null), async () => { calls++; throw new Error('Oversized review must not dispatch'); }), /bounded fact packet; source conditions cannot be clipped/);
  assert.equal(calls, 0); assert.deepEqual(input, before);
});

test('one actual source supports all single-story scenes under complete narration/context review and code-owned citations', async () => {
  const seen: { prompt: string; task: PreparedModelTask }[] = [], input = script(), original = structuredClone(input);
  const output = await reviewCompletedScript(input, options(), good(seen));
  assert.equal(seen.length, 7, 'three focused checks, one complete narration batch, two screen groups and one publication review');
  const narration = seen[3]!;
  assert.deepEqual(line(narration.prompt, 'DRAFT_SENTENCES').map((row: { text: string }) => row.text), claims);
  assert.equal(line(narration.prompt, 'SOURCE_CONTEXT').sources[0].restrictions[0].sourceSentenceId, 9);
  for (const call of seen) { assert.deepEqual(call.task.topicIds, ['topic-1']); assert.equal(call.task.role, 'source-review'); }
  assert.equal(output.cta, FIXED_SCRIPT_CTA); assert.deepEqual(output.body.map(row => row.assetRef), ['og-0', 'og-0']);
  assert.deepEqual(output.body.map(row => row.voiceover), original.body.map(row => row.voiceover));
  assert.equal(output.publish.description.split(story().primaryUrl).length, 2);
  const derivative = line(seen.at(-1)!.prompt, 'PINNED_CLAIMS'); assert.deepEqual(derivative.map((row: { text: string }) => row.text), [claims.join(' ')]);
  assert.doesNotMatch(JSON.stringify(derivative), /unverified summary|vote before/);
  assert.deepEqual(input, original, 'review and source assembly do not mutate provisional output');
});

test('direct-script general review receives exact draft absence questions without inheriting the source critic verdict', async () => {
  // Explicit injected classifications prove production propagation, not model judgment quality.
  for (const exclusionStatus of ['asserted-exclusion', 'evidence-limit'] as const) for (const generalSupported of [false, true]) {
    const input = script(), selected = topic();
    const statement = exclusionStatus === 'asserted-exclusion' ? 'The council says no booking is required.' : 'The supplied map does not report operational results.';
    selected.stories![0]!.verifiedClaims![2] = statement;
    input.body[1]!.voiceover = `${statement} ${claims[3]}`;
    const original = structuredClone(input); let calls = 0, generalCalls = 0;
    const call: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null) => {
      calls++;
      const value = accepted(prompt);
      if (prompt.startsWith('DRAFT ASSERTIONS')) {
        const row = (value as DraftAssertionsResponse).sentences.find(sentence => sentence.id === 3)!;
        row.assertedStatus = 'attributed-assertion'; row.exclusionStatus = exclusionStatus;
      } else if (prompt.startsWith('FACTUAL MODALITY')) {
        const row = (value as FactualModalityReview).sentences.find(sentence => sentence.id === 3)!;
        row.basis = 'source-assertion'; row.assertedStatus = 'attributed-assertion';
        row.exclusionBasis = exclusionStatus === 'asserted-exclusion' ? 'explicit-source-negative' : 'bounded-source-silence';
        row.claimIds = [3]; row.anchors[0]!.claimId = 3;
      } else if (prompt.startsWith('SOURCE SUPPORT REVIEW')) {
        generalCalls++;
        assert.deepEqual(line(prompt, 'DRAFT_ABSENCE_QUESTIONS'), exclusionStatus === 'asserted-exclusion' ? { asserted: [3], evidenceLimit: [] } : { asserted: [], evidenceLimit: [3] });
        assert.doesNotMatch(prompt, /explicit-source-negative|bounded-source-silence/, 'source-aware verdicts cannot become evidence for the independent general critic');
        assert.deepEqual(line(prompt, 'DRAFT_SENTENCES').map((row: { text: string }) => row.text), [claims[0], claims[1], statement, claims[3]]);
        assert.deepEqual(line(prompt, 'PINNED_CLAIMS').map((row: { text: string }) => row.text), selected.stories![0]!.verifiedClaims);
        value.sentences.find((row: { id: number }) => row.id === 3).supported = generalSupported;
        value.sentences.find((row: { id: number }) => row.id === 3).reason = generalSupported ? 'Explicit injected independent support.' : 'Explicit injected independent rejection of the asserted limitation.';
      }
      assert.equal(validate(value as T), null); return value as T;
    };
    if (generalSupported) {
      const output = await reviewCompletedScript(input, options(selected), call);
      assert.deepEqual(output.body.map(row => row.voiceover), input.body.map(row => row.voiceover));
      assert.equal(calls, 7, 'question propagation adds no model task');
    } else {
      await assert.rejects(reviewCompletedScript(input, options(selected), call), /Source review disputed/);
      assert.equal(calls, 4, 'a fresh general rejection stops before screen/publication review or speech repair');
    }
    assert.equal(generalCalls, 1); assert.deepEqual(input, original);
  }
});

test('source absence/unsupported narration fails before screen or publication repair without rewriting speech', async () => {
  const input = script(); input.body[1]!.voiceover = 'The route is guaranteed to open next week.'; const original = structuredClone(input); let calls = 0;
  const call: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null) => {
    calls++; const focused = syntheticPassingFactualResponse(prompt);
    if (focused) { assert.equal(validate(focused as T), null); return focused as T; }
    assert.ok(prompt.startsWith('SOURCE SUPPORT REVIEW'));
    const value = { sentences: line(prompt, 'REVIEW_SENTENCE_IDS').map((id: number) => ({ id, supported: id !== 3, claimIds: id === 3 ? [] : [id], reason: id === 3 ? 'The proposal does not establish guaranteed opening.' : 'Source-supported fixture.' })) } as T;
    assert.equal(validate(value), null); return value;
  };
  await assert.rejects(reviewCompletedScript(input, options(), call), /narration is unsupported.*guaranteed opening/);
  assert.equal(calls, 4); assert.deepEqual(input, original);
});

test('one screen repair changes only the unsupported field then freshly reviews it with exact dialogue locked', async () => {
  const input = script(); input.body[0]!.onScreen.stat = 'Guaranteed service'; const seen: PreparedModelTask[] = []; let reviews = 0;
  const call: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    assertPreparedModelTask(task); seen.push(task); let value: unknown;
    if (prompt.startsWith('AUTHORED FIELD SOURCE REPAIR')) value = { edits: [{ id: 'stat', text: 'Two provisional stops' }] };
    else {
      value = accepted(prompt);
      if (prompt.startsWith('AUTHORED FIELD SOURCE REVIEW') && ++reviews === 1) (value as any).fields.find((field: any) => field.id === 'stat').supported = false;
    }
    assert.equal(validate(value as T), null); return value as T;
  };
  const output = await reviewCompletedScript(input, options(), call);
  assert.equal(seen.length, 9); assert.equal(seen.filter(row => row.role === 'source-repair').length, 1);
  assert.equal(output.body[0]!.onScreen.stat, 'Two provisional stops');
  assert.deepEqual(output.body.map(row => [row.voiceover, row.motion]), input.body.map(row => [row.voiceover, row.motion]));
});

test('a second failed screen review cannot become an accepted script or trigger another repair', async () => {
  let repairs = 0;
  const call: DraftCall = async <T>(prompt: string) => {
    if (prompt.startsWith('AUTHORED FIELD SOURCE REPAIR')) { repairs++; return { edits: [{ id: 'stat', text: 'Two provisional stops' }] } as T; }
    const value = accepted(prompt); if ('fields' in value) value.fields.find((field: any) => field.id === 'stat').supported = false;
    return value as T;
  };
  const input = script(); input.body[0]!.onScreen.stat = 'Guaranteed service';
  await assert.rejects(reviewCompletedScript(input, options(), call), /field source support failed/); assert.equal(repairs, 1);
});

test('captured primary proof and scene shape fail closed before any review', async () => {
  const variants = [topic(), topic(), topic(), topic(), topic()];
  variants[0]!.stories![0]!.verifiedClaims = [];
  variants[1]!.stories![0]!.claimEvidence = [];
  variants[2]!.stories![0]!.claimEvidence![0]!.url = 'https://other.example/new-story';
  variants[3]!.stories![0]!.claimEvidence![0]!.textSha256 = null;
  variants[4]!.stories!.push(story(2));
  let calls = 0; const never: DraftCall = async () => { calls++; throw new Error('must not call'); };
  for (const input of variants) await assert.rejects(reviewCompletedScript(script(), options(input), never), /source|captured/);
  for (const field of ['sourceAccount', 'diagram'] as const) {
    const input = script(); (input.body[0] as any)[field] = {}; await assert.rejects(reviewCompletedScript(input, options(), never), /cannot supply/);
  }
  const singleScene = script(); singleScene.body.pop(); await assert.rejects(reviewCompletedScript(singleScene, options(), never), /two-to-four/);
  assert.equal(calls, 0);
});

const cast: Cast = { version: 1, format: 'conversation', updatedAt: null, members: [
  { id: 'jordan', name: 'Jordan', role: 'host', voice: { engine: 'kokoro', id: 'af_heart' }, consent: { grantedBy: 'owner', at: '2026-09-09T00:00:00Z', statement: 'Fixture consent' } },
  { id: 'sam', name: 'Sam', role: 'expert', voice: { engine: 'kokoro', id: 'am_adam' }, consent: { grantedBy: 'owner', at: '2026-09-09T00:00:00Z', statement: 'Fixture consent' } },
] };
test('presenter roundup reviews each real story and keeps every speaker turn exact', async () => {
  const input = script(); input.body.forEach((segment, index) => { segment.lines = claims.slice(index * 2, index * 2 + 2).map((text, i) => ({ speaker: i ? 'sam' : 'jordan', text })); });
  const selected = topic(true), seen: { prompt: string; task: PreparedModelTask }[] = [];
  const opts = options(selected, value => scriptProblem(value, selected, { min: 20, max: 110 }, true) ?? dialogueProblem(value, cast));
  const output = await reviewCompletedScript(input, opts, good(seen));
  assert.equal(seen.length, 11); assert.deepEqual(seen.slice(0, 8).map(row => row.task.topicIds), [['topic-1'], ['topic-1'], ['topic-1'], ['topic-1'], ['topic-2'], ['topic-2'], ['topic-2'], ['topic-2']]);
  assert.deepEqual(output.body.map(row => row.lines), input.body.map(row => row.lines));
  assert.deepEqual(output.body.map(row => row.assetRef), ['og-0', 'og-1']);
  const changed = structuredClone(input); changed.body[0]!.lines![0]!.speaker = 'ghost'; let calls = 0;
  await assert.rejects(reviewCompletedScript(changed, opts, async () => { calls++; throw new Error('must not call'); }), /unknown presenter/); assert.equal(calls, 0);
  changed.body[0]!.lines![0]!.speaker = 'jordan'; changed.body[0]!.lines![0]!.text = 'A different unsupported speaker line.';
  await assert.rejects(reviewCompletedScript(changed, opts, good()), /voiceover must equal its lines/);
});

test('publication repair retains hook count, narration and original total budget', async () => {
  let attempts = 0;
  const call: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null) => {
    let value: unknown;
    if (prompt.startsWith('AUTHORED FIELD SOURCE REPAIR')) { attempts++; value = { edits: [{ id: 'hook', text: 'The route remains a provisional council proposal.' }] }; }
    else {
      value = accepted(prompt);
      if (prompt.startsWith('AUTHORED FIELD SOURCE REVIEW') && line(prompt, 'AUTHORED_FIELDS').some((row: any) => row.id === 'hook')) (value as any).fields[0].supported = false;
    }
    const issue = validate(value as T); if (issue) throw new Error(issue); return value as T;
  };
  await assert.rejects(reviewCompletedScript(script(), options(), call), /Hook repair must preserve/); assert.equal(attempts, 1);
});

test('shared parent errors stop immediately and never receive a new local retry allowance', async () => {
  let calls = 0; const failure = new Error('Original parent physical allowance exhausted');
  await assert.rejects(reviewCompletedScript(script(), options(), async () => { calls++; throw failure; }), error => error === failure);
  assert.equal(calls, 1);
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('the real writeScript path issues an exact final receipt only after monolithic factual gates pass', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(join(root, 'workspaces'), { recursive: true });
  const workspace = mkdtempSync(join(root, 'workspaces', 'test-post-script-')), slug = workspace.split(/[\\/]/).at(-1)!;
  const token = 'b'.repeat(64), save = (path: string, value: unknown) => writeFileSync(join(workspace, path), JSON.stringify(value));
  try {
    mkdirSync(join(workspace, 'config/editions'), { recursive: true });
    save('workspace.json', { id: slug }); save('members.json', [{ id: 'fixture-owner', role: 'owner', tokenHash: createHash('sha256').update(token).digest('hex') }]);
    save('config/pipeline.json', { wordBudget: { min: 20, max: 110 }, roundup: { wordBudget: { min: 20, max: 110 } }, siteUrl: 'https://publication.example/archive' });
    const edition = JSON.parse(readFileSync(join(root, 'config/editions/daily-roundup.json'), 'utf8')); edition.wordBudget = { min: 20, max: 110 }; save('config/editions/daily-roundup.json', edition);
    const code = `
      import assert from 'node:assert/strict';
      import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
      import { join } from 'node:path';
      import { syntheticPassingFactualResponse } from ${JSON.stringify(new URL('./factual-obligations.test-fixture.ts', import.meta.url).href)};
      import { writeScript } from ${JSON.stringify(new URL('./script.ts', import.meta.url).href)};
      import { assertPreparedScriptReceipt } from ${JSON.stringify(new URL('./writing-context.ts', import.meta.url).href)};
      globalThis.fetch = async () => { throw new Error('No fixture may invoke a network endpoint'); };
      const workspace = ${JSON.stringify(workspace)}, input = ${JSON.stringify(script())}, original = ${JSON.stringify(topic())};
      let successfulCalls = 0;
      for (const fails of [true, false]) {
        const id = '20260909-map-' + (fails ? 'failed' : 'passed'), topic = { ...original, id }, dir = join(workspace, 'workdir/videos', id);
        mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, status: 'selected', edition: 'daily-roundup' }));
        writeFileSync(join(dir, 'topic.json'), JSON.stringify(topic));
        let calls = 0;
        const get = (prompt, name) => JSON.parse(prompt.split('\\n').find(row => row.startsWith(name + ': ')).slice(name.length + 2));
        const call = async (prompt, validate, task) => {
          calls++; assert.ok(task?.protocolHash && task?.evidenceHash); let value;
          if (task.taskId === 'script-complete') value = structuredClone(input);
          else if (prompt.startsWith('FACTUAL ') || prompt.startsWith('DRAFT ASSERTIONS REVIEW')) value = syntheticPassingFactualResponse(prompt);
          else if (prompt.startsWith('SOURCE SUPPORT REVIEW')) value = { sentences: get(prompt, 'REVIEW_SENTENCE_IDS').map(id => ({ id, supported: !fails, claimIds: [id], reason: fails ? 'Injected unsupported narration.' : 'Injected accepted source review.' })) };
          else if (prompt.startsWith('AUTHORED FIELD SOURCE REVIEW')) value = { fields: get(prompt, 'AUTHORED_FIELDS').map(field => ({ id: field.id, supported: true, claimIds: [1], reason: 'Injected accepted fields.' })) };
          else throw new Error('Unexpected additional generation or repair');
          const problem = validate(value); if (problem) throw new Error(problem); return value;
        };
        const prepared = { topic, call, parentId: id, parentIdentity: 'a'.repeat(64), writerKey: 'exact-prepared-writer' };
        if (fails) {
          await assert.rejects(writeScript(id, prepared), /Source review disputed/);
          assert.equal(calls, 5); assert.ok(existsSync(join(dir, 'script-unreviewed.json')));
          assert.equal(existsSync(join(dir, 'script.json')), false); assert.equal(existsSync(join(dir, 'companion-writing-receipt.json')), false);
          assert.equal(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).status, 'selected');
          const preserved = readdirSync(dir).find(file => /^script-unreviewed-[a-f0-9]{64}\\.json$/.test(file));
          assert.ok(preserved); const bytes = readFileSync(join(dir, preserved), 'utf8');
          input.hook = 'A proposed council route needs consultation.';
          await assert.rejects(writeScript(id, prepared), /no new writing attempt/);
          assert.equal(calls, 5); assert.equal(readFileSync(join(dir, preserved), 'utf8'), bytes);
          assert.equal(readdirSync(dir).filter(file => /^script-unreviewed-[a-f0-9]{64}\\.json$/.test(file)).length, 1);
          assert.equal(existsSync(join(dir, 'companion-writing-receipt.json')), false);
        } else {
          const result = await writeScript(id, prepared), receipt = JSON.parse(readFileSync(join(dir, 'companion-writing-receipt.json'), 'utf8'));
          successfulCalls = calls; assert.equal(calls, 8);
          assert.match(result.publish.description, /Sources:/); assert.match(result.publish.description, /Disclosure:/); assert.match(result.publish.description, /publication.example/);
          assertPreparedScriptReceipt(receipt, topic, prepared.writerKey, result);
          assert.equal(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).status, 'scripted');
          assert.throws(() => assertPreparedScriptReceipt(receipt, topic, prepared.writerKey, { ...result, hook: 'Changed after review.' }), /not bound/);
        }
      }
      process.stdout.write('REVIEWED_SCRIPT_RECEIPT=' + successfulCalls);
    `;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: root, env: { ...process.env, HARNESS_WORKSPACE: slug, HARNESS_TOKEN: token }, timeout: 20_000, encoding: 'utf8' });
    assert.match(output, /REVIEWED_SCRIPT_RECEIPT=8/);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

for (const kind of ['condition', 'modality', 'date', 'scope', 'exclusion', 'temporal-frame'] as const) test(`completed script rejects focused ${kind} failure before a permissive broad critic or field repair`, async () => {
  const input = script(), original = structuredClone(input); let calls = 0, broad = 0;
  const caller: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null) => {
    calls++; let value = syntheticPassingFactualResponse(prompt);
    if (!value) { broad++; value = accepted(prompt); }
    if (prompt.startsWith('DRAFT ASSERTIONS REVIEW')) {
      const row = (value as DraftAssertionsResponse).sentences[0]!;
      if (kind === 'exclusion') row.exclusionStatus = 'asserted-exclusion';
      if (kind === 'temporal-frame') row.temporalFraming = 'uncertain';
    }
    if (kind === 'scope' && prompt.startsWith('FACTUAL CONDITIONS REVIEW')) {
      const row = (value as FactualConditionsReview).claimUses[0]!;
      row.scope = 'broadened'; row.scopeSentenceIds = [1]; row.reason = 'An asserted result omitted its source population qualifier.';
    }
    if (kind === 'condition' && prompt.startsWith('FACTUAL CONDITIONS REVIEW')) {
      const result = value as FactualConditionsReview, row = result.restrictions[0]!;
      row.claimIds = [1]; row.sentenceIds = [1, 2, 3, 4]; row.disposition = 'conflict'; row.reason = 'The council-vote condition is contradicted by asserted service.';
    }
    if (prompt.startsWith('FACTUAL MODALITY AND DATE REVIEW')) {
      const row = (value as FactualModalityReview).sentences[0]!;
      if (kind === 'exclusion') { row.exclusionBasis = 'bounded-source-silence'; row.reason = 'The supplied source is silent about this asserted exclusion.'; }
      if (kind === 'modality') { row.basis = 'prediction-or-plan'; row.assertedStatus = 'achieved-behavior'; row.reason = 'The proposed service is not an achieved result.'; }
      if (kind === 'date') { row.temporalStatus = 'relocated'; row.reason = 'The announcement day is not the edition day.'; }
    }
    assert.equal(validate(value as T), null); return value as T;
  };
  await assert.rejects(reviewCompletedScript(input, options(), caller), /Script narration factual obligations failed.*Dialogue and source qualifiers were kept unchanged/);
  assert.equal(calls, 3); assert.equal(broad, 0); assert.deepEqual(input, original);
});
