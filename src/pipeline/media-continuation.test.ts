import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { authorizeMediaContinuation, authorizeMediaVisualRevision, openMediaContinuation } from './media-continuation.js';
import { beginParentWork, reserveParentModelAttempt, reserveParentTool, roleHash } from '../llm/role-router.js';
import { resolveModelRuntime, type ModelConfig } from '../llm/model.js';
import { SCRIPT_FIRST_EDITORIAL_VERSION } from './daily-editorial.js';
import { reviewedJourneyScript } from './narration.js';
import { preparedModelTask } from './writing-task.js';
import type { Script, Topic } from '../types.js';
import { readableWebText } from '../sources/web-discovery.js';
import { ensureSourceVisualDevelopment } from './visual-development.js';
import { renderedMediaHash } from './media-completion.js';
import { ensureVisualCandidates, lockVisualChoices, selectedSourceSnapshots } from './visual-choice.js';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'media-continuation-')), id = '20260915-approved-media', dir = join(root, 'workdir/videos', id);
  const save = (path: string, data: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2)); };
  const priorToken = process.env.HARNESS_TOKEN;
  const tokens = { owner: 'a'.repeat(64), other: 'b'.repeat(64), viewer: 'c'.repeat(64) };
  process.env.HARNESS_TOKEN = tokens.owner;
  save(join(root, 'workspace.json'), { id: basename(root), name: 'Media continuation fixture' });
  save(join(root, 'members.json'), Object.entries(tokens).map(([id, token]) => ({ id, role: id === 'viewer' ? 'viewer' : 'owner', tokenHash: sha(token) })));
  save(join(dir, 'meta.json'), { id, createdBy: 'owner', edition: 'daily-roundup', status: 'assets_ready', posts: {} });
  const model = { provider: 'codex', timeoutSeconds: 300, providers: { codex: { command: 'codex', model: 'gpt-5.6-sol' } }, rescue: { enabled: false } } as ModelConfig;
  save(join(root, 'config/model.json'), model); save(join(root, 'config/pipeline.json'), { voice: 'af_heart', ttsEngine: 'kokoro' });
  const topic = { id, kind: 'roundup', headline: 'Reported schedule', stories: [{ n: 1, headline: 'Reported schedule', primaryUrl: 'https://example.org/schedule', weight: 'lead', verifiedClaims: ['The league published dates.'] }] };
  const settings = { model, rolePolicy: null, runtime: resolveModelRuntime(model, {}) }, memory = { hash: roleHash('original memory') };
  const writerKey = JSON.stringify({ config: model, rolePolicy: null, runtime: settings.runtime, settingsHash: roleHash(settings), memoryHash: memory.hash });
  const parentIdentity = roleHash('original approved request'), budgetIdentity = roleHash({ version: 1, parent: parentIdentity });
  const original = join(root, 'state/role-tasks', id, budgetIdentity, 'budget.json');
  const attempts = [1, 2].map(i => ({ task: `original-${i}`, at: i, provider: 'codex', model: 'gpt-5.6-sol', promptBytes: 10 }));
  save(original, { version: 1, identity: budgetIdentity, deadline: 500, maxPhysicalCalls: 5, attempts, maxToolCalls: 8, tools: [{ task: 'old-source', tool: 'capture', at: 1 }, { task: 'old-memory', tool: 'memory', at: 2 }] });
  const candidate = { hook: 'A reported schedule.', cta: 'Read the source.', body: [{ voiceover: 'The league published dates.', onScreen: { title: 'Reported dates' }, scene: 'news_card', motion: { kind: 'flow', who: 'League', what: 'Dates', how: 'Announcement', impact: 'Published schedule', status: 'Reported' } }], fullVoiceoverText: '', editorialCopy: [{ storyId: 'topic-1', text: 'The league published dates.' }], publish: { title: 'Reported dates', description: 'Reported dates.', linkedinPost: 'Reported dates.', hashtags: [] } } as unknown as Script;
  const script = reviewedJourneyScript(candidate, [topic.stories[0].primaryUrl]);
  const newsletter = { sections: [{ text: 'The league published dates.' }], wordCount: 5 };
  const artifacts = { script: { status: 'accepted', writes: 1, candidates: [candidate], reviews: [{ candidateHash: roleHash(candidate), output: { verdict: 'supported' } }] },
    newsletter: { status: 'accepted', writes: 1, candidates: [newsletter], reviews: [], formatting: { version: 1, checks: 'shape-length-formatting', approvedScriptHash: roleHash(candidate), candidateHash: roleHash(newsletter) } } };
  const checkpoint = { version: 1, identityHash: roleHash('editorial checkpoint'), contentHash: roleHash(artifacts), artifacts };
  const raw = '<html><body><main><article><h1>Reported schedule</h1><p>The league published dates.</p></article></main></body></html>';
  const text = readableWebText(raw), captureIdentity = roleHash('fixture capture');
  const source = { id: 'topic-1-source-1', url: topic.stories[0].primaryUrl, rawSha256: sha(raw), text, textSha256: sha(text), capturedAt: '2026-09-15T12:00:00Z' };
  const input = { day: '2026-09-15', brief: 'A sports briefing', stories: [{ id: 'topic-1', headline: topic.stories[0].headline, primaryUrl: topic.stories[0].primaryUrl, sources: [source] }] };
  const issue = { subject: 'Schedule', lead: { title: 'Reported dates', body: newsletter.sections[0].text, sourceName: 'example.org', sourceUrl: topic.stories[0].primaryUrl }, items: [], radar: [], signals: [] };
  save(join(dir, 'writing-request.json'), { original: topic, originalHash: roleHash(topic), preparedHash: roleHash(topic), parentIdentity, outputs: 'edition', memory, settingsSnapshot: { settings, hash: roleHash(settings) } });
  save(join(dir, 'topic.json'), topic); save(join(dir, 'script.json'), script); save(join(dir, 'journey-editorial-issue.json'), issue);
  save(join(dir, 'journey-editorial-input.json'), { identity: captureIdentity, input, hash: roleHash(input) }); save(join(dir, 'journey-editorial-checkpoint.json'), checkpoint);
  save(join(dir, 'journey-editorial-sources/topic-1-source-1.json'), { identity: captureIdentity, source });
  writeFileSync(join(dir, 'journey-editorial-sources', `${source.rawSha256}.raw`), raw);
  save(join(dir, 'companion-writing-receipt.json'), { version: 3, reviewProtocol: 'daily-editorial', editorialVersion: SCRIPT_FIRST_EDITORIAL_VERSION, writerKey, topicHash: roleHash(topic), scriptHash: roleHash(script), checkpointHash: roleHash(checkpoint), inputHash: roleHash(input) });
  save(join(dir, 'journey-editorial-receipt.json'), { version: 1, editorialVersion: SCRIPT_FIRST_EDITORIAL_VERSION, parentIdentity, writerKey, scriptHash: roleHash(script), checkpointHash: roleHash(checkpoint), inputHash: roleHash(input), issueHash: roleHash(issue) });
  let clock = 1000;
  const approval = { intent: 'continue-approved-media' as const, expectedWriterKey: writerKey, expectedScriptHash: roleHash(script), expectedNewsletterHash: roleHash(issue), expectedOriginalBudgetHash: sha(readFileSync(original)), deadlinePolicy: 'operation-only' as const };
  const options = { now: () => clock, env: {} };
  return { root, id, dir, original, save, tokens, options, approval, checkpoint, script, topic, writerKey, tick: (ms: number) => { clock += ms; }, authorize: () => authorizeMediaContinuation(root, id, approval, options), open: () => openMediaContinuation(root, id, options), close: () => { rmSync(root, { recursive: true, force: true }); if (priorToken === undefined) delete process.env.HARNESS_TOKEN; else process.env.HARNESS_TOKEN = priorToken; } };
}
async function installFixtureConcepts(f: ReturnType<typeof fixture>) {
    await ensureSourceVisualDevelopment(f.dir, f.topic as Topic, { day: '2026-09-15', writerKey: f.writerKey, call: async (prompt, validate) => {
      const value = prompt.startsWith('SOURCE VISUAL CONCEPT')
        ? { kind: 'diagram', intent: 'Reported league dates', reasonClaimIds: [1], labels: ['League announcement', 'Published dates'], caveat: 'Reported schedule', mechanism: null }
        : { fields: JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!).map((row: { id: string }) => ({ id: row.id, supported: true, claimIds: [1], reason: 'Isolated source-review fixture.' })) };
      assert.equal(validate(value as never), null); return value as never;
    } });
}
async function visualFailureFixture() {
  const f = fixture();
  try {
    await installFixtureConcepts(f);
    const review = { status: 'unverified', sha256: sha('unchanged diagram'), reason: 'Prepared vision reached its original parent deadline', before: 'retained-phone.png' };
    f.save(join(f.dir, 'diagrams.json'), [{ svg: '<svg/>', label: 'Dates', reading: 'Reported league dates', legend: [], review }]);
    f.save(join(f.dir, 'diagram-phone-review.json'), [review]);
    f.save(join(f.dir, 'meta.json'), { id: f.id, createdBy: 'owner', edition: 'daily-roundup', status: 'failed:visuals', posts: {} });
    return f;
  } catch (error) { f.close(); throw error; }
}
function finalReviewFailureFixture() {
  const f = fixture(), path = join(f.dir, 'media-completion.json');
  const parent = JSON.parse(readFileSync(join(f.dir, 'writing-request.json'), 'utf8')).parentIdentity;
  f.save(join(f.dir, 'meta.json'), { id: f.id, createdBy: 'owner', edition: 'daily-roundup', status: 'failed:final-media-qc', durationSec: 10, posts: {} });
  f.save(join(f.dir, 'props.json'), { headline: f.topic.headline, segments: f.script.body.map(row => ({ ...row, startSec: 0, endSec: 10, assetFile: null })), durationSec: 10 });
  f.save(join(f.dir, 'timestamps.json'), { narrationSha256: sha(f.script.fullVoiceoverText), durationSec: 10, words: [{ w: 'The', start: 0, end: 1 }] });
  writeFileSync(join(f.dir, 'audio.wav'), 'saved selected narration');
  f.save(join(f.dir, 'audio-qc.json'), { version: 1, status: 'pass', method: 'raw-asr-script-comparison', blocking: [], heardWords: [{ w: 'The', start: 0, end: 1 }], requestedText: f.script.fullVoiceoverText.trim(), scriptSha256: sha(f.script.fullVoiceoverText.trim()), audioSha256: sha('saved selected narration'), engine: 'kokoro', voice: 'af_heart' });
  f.save(join(f.dir, 'assets.json'), {}); writeFileSync(join(f.dir, 'final.mp4'), 'saved checked video');
  const mediaHash = renderedMediaHash(f.dir)!;
  const narration = roleHash(['script.json', 'topic.json', 'audio.wav', 'audio-qc.json', 'timestamps.json'].sort().map(name => [name, sha(readFileSync(join(f.dir, name)))]));
  const settings = roleHash({ voice: { engine: 'kokoro', voice: 'af_heart' }, files: ['pipeline.json', 'avatar.json', 'cast.json', 'editions/daily-roundup.json'].map(name => [name, existsSync(join(f.root, 'config', name)) ? sha(readFileSync(join(f.root, 'config', name))) : null]) });
  f.save(join(f.dir, 'rendered-media.json'), { version: 1, hash: mediaHash, narration: { hash: narration, settings } });
  const inputs = { version: 2, parent, writerKey: f.writerKey, expectedDurationSec: 10, files: Object.fromEntries(['script.json', 'topic.json', 'audio.wav', 'audio-qc.json', 'timestamps.json', 'props.json', 'final.mp4', 'assets.json'].map(name => [name, sha(readFileSync(join(f.dir, name)))])) };
  const inputHash = roleHash(inputs);
  const attempts = [1, 2, 3].map(n => {
    const evidencePath = `final-media-qc/${inputHash.slice(0, 16)}-00000000-0000-0000-0000-00000000000${n}`;
    const result = { version: 1, ok: false, failureKind: 'infrastructure', findings: [{ severity: 'blocking', kind: 'infrastructure', target: 'render', detail: 'Technical review unavailable: Local role parent reached its total time ceiling' }], repairTargets: [], checkedAt: '2026-09-15T00:00:00Z', inputHash, evidencePath, reviewer: { writerKey: f.writerKey, parentIdentity: parent, attempts: [] }, audioListeningApproved: false, publicationReady: false };
    f.save(join(f.dir, evidencePath, 'inputs.json'), inputs); f.save(join(f.dir, evidencePath, 'result.json'), { ...result, frames: [] });
    return { status: 'finished', result };
  });
  f.save(path, { version: 1, parent, attempts, repairs: [] });
  return { ...f, path, attempts };
}
const attempt = { provider: 'codex' as const, model: 'gpt-5.6-sol', attempt: 1, rescue: false, promptBytes: 10 };

test('authorized media continuation preserves original bytes and caps aggregate physical/tool spending without another whole-flow timer', () => {
  const f = fixture(); try {
    const before = readFileSync(f.original), journal = f.authorize();
    assert.equal(journal.deadlinePolicy, 'operation-only'); assert.equal(journal.deadline, null);
    assert.equal(journal.limits.maxPhysicalCalls, 3); assert.equal(journal.limits.maxToolCalls, 6);
    let context = f.open(); assert.equal(beginParentWork(context.parent).deadline, Number.MAX_SAFE_INTEGER);
    f.tick(3 * 60 * 60 * 1000); // Human review time does not recreate the previous thirty-minute failure.
    for (let i = 0; i < 3; i++) reserveParentModelAttempt(context.parent, `media-${i}`, attempt);
    for (let i = 0; i < 6; i++) reserveParentTool(context.parent, `tool-${i}`, 'ffmpeg');
    context = f.open(); assert.equal(beginParentWork(context.parent).remainingPhysical, 0);
    assert.throws(() => reserveParentModelAttempt(context.parent, 'excess', attempt), /exhausted/);
    assert.throws(() => reserveParentTool(context.parent, 'excess-tool', 'ffmpeg'), /exhausted/);
    assert.ok(readFileSync(f.original).equals(before));
    assert.throws(() => f.authorize(), /already authorized/);
  } finally { f.close(); }
});

test('writing, formatting, source review and runtime substitutions remain closed before inference', async () => {
  const f = fixture(); try {
    f.authorize(); const context = f.open();
    for (const stage of ['script', 'newsletter', 'visual'] as const) await assert.rejects(context.call(stage)('unused', () => null), /cannot write/);
    const task = preparedModelTask({ role: 'source-review', capability: 'source-review', taskId: 'final-media-review', topicIds: ['topic-1'], protocol: {}, evidence: {} });
    assert.throws(() => context.vision('unused', [], () => null, task), /only final alignment/);
    assert.throws(() => openMediaContinuation(f.root, f.id, { ...f.options, env: { AI_CONTENT_MODEL_NAME: 'gpt-5.5' } }), /runtime changed/);
    f.save(join(f.root, 'config/pipeline.json'), { voice: 'different-voice', ttsEngine: 'kokoro' });
    assert.throws(() => context.assertUnchanged(), /voice or design settings changed/);
  } finally { f.close(); }
});

test('failed physical media calls remain spent on resume and use only the selected model', async () => {
  const f = fixture(); try {
    f.authorize(); const image = join(f.dir, 'review.png'); writeFileSync(image, 'image bytes for injected transport');
    let calls = 0;
    const context = openMediaContinuation(f.root, f.id, { ...f.options, vision: { primary: async request => {
      calls++; assert.equal(request.config.providers.codex?.model, 'gpt-5.6-sol'); assert.equal(request.deadline, Number.MAX_SAFE_INTEGER);
      request.hooks.beforeAttempt?.(attempt); throw new Error('fixture transport failed after reservation');
    } } });
    const task = preparedModelTask({ role: 'media-review', capability: 'frame-alignment', taskId: 'final-media-review', topicIds: ['topic-1'], protocol: {}, evidence: {} });
    await assert.rejects(context.vision('Approved script and actual media only', [image], () => null, task), /transport failed/);
    assert.equal(calls, 1); assert.equal(beginParentWork(f.open().parent).physicalAttempts, 1);
    assert.equal(beginParentWork(f.open().parent).remainingPhysical, 2);
  } finally { f.close(); }
});

test('modified original budget, missing continuation budget and enlarged allowance all hold instead of renewing', () => {
  for (const mutation of ['original', 'missing', 'enlarged'] as const) {
    const f = fixture(); try {
      const journal = f.authorize(), next = join(f.root, 'state/role-tasks', f.id, roleHash({ version: 1, parent: journal.identity }), 'budget.json');
      if (mutation === 'original') { const original = JSON.parse(readFileSync(f.original, 'utf8')); original.deadline++; f.save(f.original, original); }
      if (mutation === 'missing') rmSync(next);
      if (mutation === 'enlarged') { const changed = JSON.parse(readFileSync(next, 'utf8')); changed.maxPhysicalCalls++; f.save(next, changed); }
      assert.throws(() => f.open(), /allowance changed|cannot be renewed|ENOENT/);
      assert.throws(() => f.authorize(), /already authorized/);
    } finally { f.close(); }
  }
});

test('approval must identify this exact accepted script and newsletter; held prose gets no continuation', () => {
  const f = fixture(); try {
    assert.throws(() => authorizeMediaContinuation(f.root, f.id, { ...f.approval, expectedNewsletterHash: roleHash('other issue') }, f.options), /does not match/);
    assert.equal(existsSync(join(f.dir, 'media-continuation.json')), false);
    f.checkpoint.artifacts.script.status = 'held'; f.checkpoint.contentHash = roleHash(f.checkpoint.artifacts);
    f.save(join(f.dir, 'journey-editorial-checkpoint.json'), f.checkpoint);
    assert.throws(() => f.authorize(), /accepted script evidence/);
    assert.equal(existsSync(join(f.dir, 'media-continuation.json')), false);
  } finally { f.close(); }
});

test('only the current authorized package author can grant or use a continuation', () => {
  const f = fixture(); try {
    const original = readFileSync(f.original);
    process.env.HARNESS_TOKEN = f.tokens.viewer;
    assert.throws(() => f.authorize(), /Forbidden/);
    process.env.HARNESS_TOKEN = f.tokens.other;
    assert.throws(() => f.authorize(), /another author/);
    assert.equal(existsSync(join(f.dir, 'media-continuation.json')), false);
    process.env.HARNESS_TOKEN = f.tokens.owner;
    f.authorize(); const context = f.open();
    process.env.HARNESS_TOKEN = f.tokens.other;
    assert.throws(() => f.open(), /another author/);
    assert.throws(() => context.assertUnchanged(), /another author/);
    process.env.HARNESS_TOKEN = f.tokens.owner;
    const members = JSON.parse(readFileSync(join(f.root, 'members.json'), 'utf8'));
    members.find((member: { id: string }) => member.id === 'owner').disabled = true;
    f.save(join(f.root, 'members.json'), members);
    assert.throws(() => context.assertUnchanged(), /Unauthorized/);
    assert.ok(readFileSync(f.original).equals(original));
  } finally { f.close(); }
});

test('holds, rejection, approval and any delivery activity prevent authorization and stop opened contexts', () => {
  const cases = [
    { status: 'rejected' }, { status: 'approved' }, { status: 'posted' }, { status: 'failed:script' },
    { reviewHold: { reason: 'reviewer held this package' } }, { rejectReason: 'not approved' },
    { approvedBy: { id: 'reviewer' } }, { explicitApproval: { approvedAt: 'fixture' } },
    { posts: { youtube: { id: 'posted-id' } } }, { delivery: { youtube: { status: 'unconfirmed' } } },
  ];
  for (const mutation of cases) {
    const f = fixture(); try {
      const metaPath = join(f.dir, 'meta.json'), meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      f.save(metaPath, { ...meta, ...mutation });
      assert.throws(() => f.authorize(), /held/);
      assert.equal(existsSync(join(f.dir, 'media-continuation.json')), false);
      f.save(metaPath, meta); f.authorize(); const context = f.open();
      const before = beginParentWork(context.parent).physicalAttempts;
      f.save(metaPath, { ...meta, ...mutation });
      assert.throws(() => f.open(), /held/);
      assert.throws(() => context.assertUnchanged(), /held/);
      assert.throws(() => reserveParentModelAttempt(context.parent, 'blocked', attempt), /held/);
      f.save(metaPath, meta);
      assert.equal(beginParentWork(context.parent).physicalAttempts, before);
    } finally { f.close(); }
  }
  const f = fixture(); try {
    writeFileSync(join(f.dir, 'delivery-events.jsonl'), '{"type":"release.withheld"}\n');
    assert.throws(() => f.authorize(), /held/);
  } finally { f.close(); }
});

test('an identical package and journal copied to another workspace cannot replay authorization', () => {
  const f = fixture(), otherRoot = mkdtempSync(join(tmpdir(), 'media-other-workspace-'));
  try {
    f.authorize(); cpSync(f.root, otherRoot, { recursive: true });
    assert.throws(() => openMediaContinuation(otherRoot, f.id, f.options), /journal changed/);
    assert.equal(beginParentWork(f.open().parent).physicalAttempts, 0);
  } finally { rmSync(otherRoot, { recursive: true, force: true }); f.close(); }
});

test('waiting visual choices and completed previews can be inspected but cannot spend media allowance', () => {
  const f = fixture(); try {
    const metaPath = join(f.dir, 'meta.json'), meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    f.save(metaPath, { ...meta, status: 'awaiting_visual_choice' });
    f.authorize();
    for (const status of ['awaiting_visual_choice', 'pending_review']) {
      f.save(metaPath, { ...meta, status });
      const context = f.open(); context.assertUnchanged();
      assert.throws(() => reserveParentModelAttempt(context.parent, 'blocked-review', attempt), /waiting for your visual choice or completed review/);
      assert.throws(() => reserveParentTool(context.parent, 'blocked-tool', 'ffmpeg'), /waiting for your visual choice or completed review/);
    }
    f.save(metaPath, meta);
    assert.equal(beginParentWork(f.open().parent).physicalAttempts, 0);
  } finally { f.close(); }
});

test('runtime and private configuration changes after opening hold before any paid work', () => {
  const f = fixture(); try {
    f.authorize(); const env: NodeJS.ProcessEnv = {};
    const context = openMediaContinuation(f.root, f.id, { ...f.options, env });
    env.AI_CONTENT_MODEL_NAME = 'other-model';
    assert.throws(() => context.assertUnchanged(), /runtime changed/);
    delete env.AI_CONTENT_MODEL_NAME;
    writeFileSync(join(f.root, '.env'), 'AI_CONTENT_MODEL_NAME="different-model"\n');
    assert.throws(() => context.assertUnchanged(), /settings changed/);
    rmSync(join(f.root, '.env'));
    assert.equal(beginParentWork(context.parent).physicalAttempts, 0);
  } finally { f.close(); }
});

test('a visual timeout retains accepted writing and source concepts, waits for normal choice and cannot refill budgets', async () => {
  const f = await visualFailureFixture(); try {
    const before = readFileSync(f.original), script = readFileSync(join(f.dir, 'script.json')), concepts = readFileSync(join(f.dir, 'visual-development.json'));
    const journal = f.authorize(); assert.ok(journal.visualRecovery); assert.equal(journal.limits.maxPhysicalCalls, 3); assert.equal(journal.limits.maxToolCalls, 6);
    assert.deepEqual(journal.visualRecovery.originalPhoneReview, JSON.parse(readFileSync(join(f.dir, 'diagram-phone-review.json'), 'utf8')));
    const context = f.open(); context.assertUnchanged();
    assert.equal(existsSync(join(f.dir, 'visual-choices.json')), false, 'authorizing recovery cannot choose a visual');
    assert.throws(() => reserveParentModelAttempt(context.parent, 'before-choice', attempt), /waiting for your visual choice/);
    assert.throws(() => reserveParentTool(context.parent, 'before-choice-tool', 'render'), /waiting for your visual choice/);
    const candidates = ensureVisualCandidates(f.dir, f.script.body, [], false);
    lockVisualChoices(f.dir, candidates, { '0': 'snapshot' }, 'user');
    assert.equal(selectedSourceSnapshots(f.dir).size, 1);
    f.save(join(f.dir, 'meta.json'), { id: f.id, createdBy: 'owner', status: 'assets_ready', posts: {} });
    reserveParentTool(context.parent, 'after-choice', 'render');
    assert.equal(beginParentWork(context.parent).remainingTools, 5);
    f.tick(24 * 60 * 60 * 1000); assert.equal(beginParentWork(f.open().parent).remainingTools, 5);
    assert.ok(readFileSync(f.original).equals(before)); assert.ok(readFileSync(join(f.dir, 'script.json')).equals(script)); assert.ok(readFileSync(join(f.dir, 'visual-development.json')).equals(concepts));
    assert.throws(() => f.authorize(), /already authorized/);
  } finally { f.close(); }
});

test('visual timeout recovery refuses rejected, unknown, incomplete or changed source evidence before authorization', async () => {
  for (const change of ['rejected', 'unknown', 'missing-concept', 'changed-source', 'source-rejected', 'wrong-writer', 'unaccepted-script'] as const) {
    const f = await visualFailureFixture(); try {
      if (change === 'rejected' || change === 'unknown') {
        const path = join(f.dir, 'diagram-phone-review.json'), reviews = JSON.parse(readFileSync(path, 'utf8'));
        if (change === 'rejected') reviews[0].status = 'failed'; else reviews[0].reason = 'An unspecified visual failure';
        const diagrams = JSON.parse(readFileSync(join(f.dir, 'diagrams.json'), 'utf8')); diagrams[0].review = reviews[0]; f.save(path, reviews); f.save(join(f.dir, 'diagrams.json'), diagrams);
      }
      if (change === 'missing-concept') { const path = join(f.dir, 'visual-development.json'), saved = JSON.parse(readFileSync(path, 'utf8')); saved.concepts = []; f.save(path, saved); }
      if (change === 'changed-source') f.save(join(f.dir, 'journey-editorial-sources/topic-1-source-1.json'), { changed: true });
      if (change === 'source-rejected') f.save(join(f.dir, 'diagram-source-rejected-fixture.json'), { accepted: false });
      if (change === 'wrong-writer') f.approval.expectedWriterKey = 'different writer';
      if (change === 'unaccepted-script') { f.checkpoint.artifacts.script.status = 'held'; f.save(join(f.dir, 'journey-editorial-checkpoint.json'), f.checkpoint); }
      assert.throws(() => f.authorize()); assert.equal(existsSync(join(f.dir, 'media-continuation.json')), false);
    } finally { f.close(); }
  }
});

test('opened visual recovery holds changed accepted concepts or settings without new calls', async () => {
  const f = await visualFailureFixture(); try {
    f.authorize(); const context = f.open(), path = join(f.dir, 'visual-development.json'), original = readFileSync(path);
    const changed = JSON.parse(original.toString()); changed.concepts[0].labels[0] = 'Changed'; f.save(path, changed);
    assert.throws(() => context.assertUnchanged(), /identity changed/); writeFileSync(path, original);
    f.save(join(f.root, 'config/pipeline.json'), { voice: 'another voice', ttsEngine: 'kokoro' });
    assert.throws(() => context.assertUnchanged(), /settings changed/);
  } finally { f.close(); }
});


test('expired final review authorization archives every preflight attempt and preserves the original media and remaining budget', () => {
  const f = finalReviewFailureFixture(); try {
    const prior = readFileSync(f.path), budget = readFileSync(f.original), audio = readFileSync(join(f.dir, 'audio.wav')), video = readFileSync(join(f.dir, 'final.mp4'));
    const journal = f.authorize(); assert.ok(journal.finalReviewRecovery); assert.equal(journal.finalReviewRecovery.attempts, 3);
    assert.equal(journal.limits.maxPhysicalCalls, 3); assert.equal(journal.limits.maxToolCalls, 6);
    assert.ok(readFileSync(join(f.dir, 'media-continuation-evidence', `${sha(prior)}.json`)).equals(prior));
    const state = JSON.parse(readFileSync(f.path, 'utf8')); assert.equal(state.parent, journal.identity); assert.deepEqual(state.attempts, f.attempts); assert.deepEqual(state.repairs, []);
    const context = f.open(); assert.ok(context.mediaReviewRecovery); context.assertUnchanged();
    reserveParentModelAttempt(context.parent, 'fresh-final-check', attempt); f.tick(86400000);
    assert.equal(beginParentWork(f.open().parent).remainingPhysical, 2); assert.ok(readFileSync(f.original).equals(budget));
    assert.ok(readFileSync(join(f.dir, 'audio.wav')).equals(audio)); assert.ok(readFileSync(join(f.dir, 'final.mp4')).equals(video));
    state.attempts.shift(); f.save(f.path, state); assert.throws(() => f.open(), /allowance changed/);
  } finally { f.close(); }
});

test('final-review continuation cannot erase a verdict, used provider call, unknown failure, changed media or spent repair', () => {
  for (const change of ['content', 'physical-call', 'unknown', 'unfinished', 'repair', 'media', 'evidence', 'wrong-parent', 'wrong-voice'] as const) {
    const f = finalReviewFailureFixture(); try {
      const state = JSON.parse(readFileSync(f.path, 'utf8'));
      if (change === 'content') state.attempts[0].result.failureKind = 'content';
      if (change === 'physical-call') state.attempts[0].result.reviewer.attempts.push(attempt);
      if (change === 'unknown') state.attempts[0].result.findings[0].detail = 'Unspecified reviewer failure';
      if (change === 'unfinished') state.attempts[0].status = 'started';
      if (change === 'repair') state.repairs.push({ status: 'finished', targets: ['render'], review: 'old-review' });
      if (change === 'wrong-parent') state.parent = 'another-parent';
      f.save(f.path, state);
      if (change === 'media') writeFileSync(join(f.dir, 'final.mp4'), 'changed');
      if (change === 'evidence') f.save(join(f.dir, state.attempts[0].result.evidencePath, 'inputs.json'), { changed: true });
      if (change === 'wrong-voice') f.save(join(f.root, 'config/pipeline.json'), { ttsEngine: 'kokoro', voice: 'another_voice' });
      assert.throws(() => f.authorize(), /deadline-only/); assert.equal(existsSync(join(f.dir, 'media-continuation.json')), false);
    } finally { f.close(); }
  }
});

test('opened final-review continuation refuses changed archives, prior verdicts and saved media', () => {
  for (const change of ['archive', 'verdict', 'media'] as const) {
    const f = finalReviewFailureFixture(); try {
      const journal = f.authorize(), context = f.open();
      if (change === 'archive') writeFileSync(join(f.dir, 'media-continuation-evidence', `${journal.finalReviewRecovery!.originalCompletionHash}.json`), '{}');
      if (change === 'media') writeFileSync(join(f.dir, 'audio.wav'), 'changed');
      if (change === 'verdict') { const state = JSON.parse(readFileSync(f.path, 'utf8')); state.attempts[0].result.ok = true; f.save(f.path, state); }
      assert.throws(() => context.assertUnchanged(), /evidence changed|allowance changed/);
    } finally { f.close(); }
  }
});

function revisionApproval(f: ReturnType<typeof fixture>, journal: ReturnType<typeof authorizeMediaContinuation>, choice: 'image' | 'explanation' = 'explanation') {
  const budget = join(f.root, 'state/role-tasks', f.id, roleHash({ version: 1, parent: journal.identity }), 'budget.json');
  return { intent: 'revise-selected-visuals' as const, expectedJournalIdentity: journal.identity, expectedScriptHash: f.approval.expectedScriptHash,
    expectedNewsletterHash: f.approval.expectedNewsletterHash, expectedBudgetHash: sha(readFileSync(budget)), choices: { '0': choice } };
}
function revisionCatalog(f: ReturnType<typeof fixture>) {
  mkdirSync(join(f.dir, 'assets'), { recursive: true }); writeFileSync(join(f.dir, 'assets/source.png'), 'captured source image');
  const image = { id: 'image', available: true, file: 'assets/source.png', sha256: sha('captured source image'), hash: roleHash('source-image') };
  const snapshot = { id: 'snapshot', available: true, hash: roleHash('old-card') };
  f.save(join(f.dir, 'visual-candidates.json'), { version: 1, videoId: f.id, stories: [{ index: 0, candidates: [image, snapshot] }] });
  f.save(join(f.dir, 'visual-choices.json'), { version: 1, videoId: f.id, stories: { '0': { candidateId: 'snapshot', candidateHash: snapshot.hash } } });
  return { image, snapshot };
}

test('explicit visual revision preserves accepted writing and the same spent child ledger while allowing only requested visual work', async () => {
  const f = await visualFailureFixture(); try {
    revisionCatalog(f); const journal = f.authorize(), context = f.open();
    // A paid historical attempt remains spent, with only the original remainder available.
    f.save(join(f.dir, 'meta.json'), { id: f.id, createdBy: 'owner', edition: 'daily-roundup', status: 'assets_ready', posts: {} });
    reserveParentModelAttempt(context.parent, 'prior-paid-media', attempt);
    const oldScript = readFileSync(join(f.dir, 'script.json')), oldIssue = readFileSync(join(f.dir, 'journey-editorial-issue.json')), oldChoices = readFileSync(join(f.dir, 'visual-choices.json'));
    const revision = authorizeMediaVisualRevision(f.root, f.id, revisionApproval(f, journal), f.options);
    assert.equal(revision.parent, journal.identity); assert.equal(revision.spent.physicalAttempts, 1);
    assert.ok(readFileSync(join(f.dir, revision.archive.path, 'visual-choices.json')).equals(oldChoices));
    let calls = 0;
    const open = openMediaContinuation(f.root, f.id, { ...f.options, text: { primary: async (request, validate) => {
      calls++; request.hooks.beforeAttempt?.(attempt); assert.equal(request.config.providers.codex?.model, 'gpt-5.6-sol');
      const value = { visible: 'The published schedule' }; assert.equal(validate(value as never), null); return value as never;
    } } });
    const task = preparedModelTask({ role: 'script', capability: 'script-draft', taskId: 'diagram-author-1', topicIds: ['topic-1'], protocol: { diagram: 1 }, evidence: f.topic, candidate: f.script });
    assert.deepEqual(await open.call('visual')('Author only the requested visual.', () => null, task), { visible: 'The published schedule' });
    assert.equal(calls, 1); assert.equal(beginParentWork(open.parent).physicalAttempts, 2); assert.equal(beginParentWork(open.parent).remainingPhysical, 1);
    assert.equal(open.parent.parentIdentity, context.parent.parentIdentity);
    const sourceReview = preparedModelTask({ role: 'source-review', capability: 'source-review', taskId: 'diagram-1-diagram-fields-0-fields-initial-review', topicIds: ['topic-1'], protocol: {}, evidence: f.topic });
    await open.call('visual')('Review only authored diagram fields.', () => null, sourceReview);
    assert.equal(calls, 2); assert.equal(beginParentWork(open.parent).remainingPhysical, 0);
    for (const stage of ['script', 'newsletter'] as const) await assert.rejects(open.call(stage)('Forbidden', () => null, task), /cannot write/);
    for (const invalid of [{ ...task, taskId: 'daily-editorial-script' }, { ...task, topicIds: ['topic-2'] }]) await assert.rejects(open.call('visual')('Forbidden', () => null, invalid), /requested visual/);
    assert.equal(calls, 2);
    assert.ok(readFileSync(join(f.dir, 'script.json')).equals(oldScript)); assert.ok(readFileSync(join(f.dir, 'journey-editorial-issue.json')).equals(oldIssue));
    assert.throws(() => authorizeMediaVisualRevision(f.root, f.id, revisionApproval(f, journal), f.options), /already authorized/);
  } finally { f.close(); }
});

test('visual revision admits photo pixel QA but final-frame review refuses the old card', async () => {
  const f = await visualFailureFixture(); try {
    const { image } = revisionCatalog(f), journal = f.authorize();
    authorizeMediaVisualRevision(f.root, f.id, revisionApproval(f, journal, 'image'), f.options);
    let calls = 0;
    const context = openMediaContinuation(f.root, f.id, { ...f.options, vision: { primary: async request => {
      calls++; request.hooks.beforeAttempt?.(attempt); return { pass: true } as never;
    } } });
    const author = preparedModelTask({ role: 'script', capability: 'script-draft', taskId: 'diagram-author-1', topicIds: ['topic-1'], protocol: {}, evidence: f.topic });
    await assert.rejects(context.call('visual')('Unused diagram', () => null, author), /requested visual/);
    const final = preparedModelTask({ role: 'media-review', capability: 'frame-alignment', taskId: 'final-media-review', topicIds: ['topic-1'], protocol: {}, evidence: f.topic });
    assert.throws(() => context.vision('Cannot approve a card', [join(f.dir, image.file)], () => null, final), /cannot substitute/);
    assert.equal(calls, 0);
    f.save(join(f.dir, 'visual-choices.json'), { version: 1, videoId: f.id, stories: { '0': { candidateId: 'image', candidateHash: image.hash } } });
    const pixel = preparedModelTask({ role: 'source-review', capability: 'source-review', taskId: 'visual-image-review', topicIds: ['topic-1'], protocol: { diagramVision: 1 }, evidence: f.topic, candidate: f.script.body });
    assert.deepEqual(await context.vision('Review the exact chosen photo.', [join(f.dir, image.file)], () => null, pixel), { pass: true });
    assert.deepEqual(await context.vision('Compare final actual frame.', [join(f.dir, image.file)], () => null, final), { pass: true });
    assert.equal(calls, 2); assert.equal(beginParentWork(context.parent).physicalAttempts, 2);
    writeFileSync(join(f.dir, image.file), 'different image'); assert.throws(() => context.assertUnchanged(), /retained assets\/source.png changed/);
  } finally { f.close(); }
});

test('only an exact authorized visual revision can work through an older chooser pause', async () => {
  const f = await visualFailureFixture(); try {
    revisionCatalog(f); const journal = f.authorize();
    const meta = JSON.parse(readFileSync(join(f.dir, 'meta.json'), 'utf8'));
    f.save(join(f.dir, 'meta.json'), { ...meta, status: 'awaiting_visual_choice' });
    assert.throws(() => beginParentWork(f.open().parent), /waiting for your visual choice/, 'An ordinary continuation cannot choose for the user');
    authorizeMediaVisualRevision(f.root, f.id, revisionApproval(f, journal), f.options);
    f.save(join(f.dir, 'meta.json'), { ...meta, status: 'awaiting_visual_choice' });
    let calls = 0;
    const context = openMediaContinuation(f.root, f.id, { ...f.options, text: { primary: async (request) => {
      calls++; request.hooks.beforeAttempt?.(attempt); return { visual: 'Owned source explanation' } as never;
    } } });
    const task = preparedModelTask({ role: 'script', capability: 'script-draft', taskId: 'diagram-author-1', topicIds: ['topic-1'], protocol: { diagram: 1 }, evidence: f.topic });
    await context.call('visual')('Finish only the requested explanation.', () => null, task);
    assert.equal(calls, 1); assert.equal(beginParentWork(context.parent).physicalAttempts, 1);
    assert.equal(beginParentWork(context.parent).remainingPhysical, journal.limits.maxPhysicalCalls - 1);
    for (const status of ['failed:visuals', 'pending_review']) {
      f.save(join(f.dir, 'meta.json'), { ...meta, status });
      await assert.rejects(context.call('visual')('Do not retry held work.', () => null, task), /waiting for your visual choice/);
    }
    assert.equal(calls, 1, 'A real visual failure or completed preview cannot dispatch another attempt');
  } finally { f.close(); }
});

test('an explicitly requested revision can reopen a completed local preview while retaining original QA and narration bytes', async () => {
  const f = finalReviewFailureFixture(); try {
    await installFixtureConcepts(f); const journal = f.authorize(); revisionCatalog(f); const originalState = readFileSync(f.path), audio = readFileSync(join(f.dir, 'audio.wav'));
    const meta = JSON.parse(readFileSync(join(f.dir, 'meta.json'), 'utf8')); f.save(join(f.dir, 'meta.json'), { ...meta, status: 'pending_review' });
    const revision = authorizeMediaVisualRevision(f.root, f.id, revisionApproval(f, journal, 'image'), f.options);
    const context = f.open(); assert.ok(context.mediaVisualRevision); assert.equal(context.mediaReviewRecovery, undefined);
    assert.ok(readFileSync(join(f.dir, revision.presentation.archivePath)).equals(originalState));
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')).attempts, f.attempts);
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'meta.json'), 'utf8')).status, 'assets_ready');
    assert.equal(beginParentWork(context.parent).physicalAttempts, 0); assert.ok(readFileSync(join(f.dir, 'audio.wav')).equals(audio));
    // Visual output may change; original factual writing and narration may not.
    writeFileSync(join(f.dir, 'final.mp4'), 'new visual-only render'); context.assertUnchanged();
    writeFileSync(join(f.dir, 'audio.wav'), 'changed selected narration'); assert.throws(() => context.assertUnchanged(), /retained audio.wav changed/);
  } finally { f.close(); }
});

test('visual revision fails before dispatch for changed source, choice, archive, accepted text, user hold or spent-ledger prefix', async () => {
  for (const mutation of ['source', 'archive', 'script', 'hold', 'budget', 'choice'] as const) {
    const f = await visualFailureFixture(); try {
      revisionCatalog(f); const journal = f.authorize();
      f.save(join(f.dir, 'meta.json'), { id: f.id, createdBy: 'owner', edition: 'daily-roundup', status: 'assets_ready', posts: {} });
      reserveParentModelAttempt(f.open().parent, 'old-physical', attempt);
      const revision = authorizeMediaVisualRevision(f.root, f.id, revisionApproval(f, journal, 'image'), f.options), context = f.open();
      if (mutation === 'source') writeFileSync(join(f.dir, 'journey-editorial-sources/topic-1-source-1.json'), '{}');
      if (mutation === 'archive') writeFileSync(join(f.dir, revision.archive.path, 'visual-choices.json'), '{}');
      if (mutation === 'script') writeFileSync(join(f.dir, 'script.json'), '{}');
      if (mutation === 'hold') f.save(join(f.dir, 'meta.json'), { id: f.id, createdBy: 'owner', edition: 'daily-roundup', status: 'assets_ready', reviewHold: true });
      if (mutation === 'budget') {
        const path = join(f.root, 'state/role-tasks', f.id, roleHash({ version: 1, parent: journal.identity }), 'budget.json'), budget = JSON.parse(readFileSync(path, 'utf8'));
        budget.attempts[0].task = 'replaced-old-attempt'; f.save(path, budget);
      }
      if (mutation === 'choice') f.save(join(f.dir, 'visual-choices.json'), { version: 1, videoId: f.id, stories: { '0': { candidateId: 'explanation', candidateHash: roleHash('fake') } } });
      assert.throws(() => context.assertUnchanged());
      assert.throws(() => reserveParentModelAttempt(context.parent, 'blocked', attempt));
    } finally { f.close(); }
  }
});

test('a newly requested explanation may remain unselected during authoring but cannot reach final review before acceptance', async () => {
  const f = await visualFailureFixture(); try {
    revisionCatalog(f); rmSync(join(f.dir, 'visual-choices.json'));
    const journal = f.authorize(); authorizeMediaVisualRevision(f.root, f.id, revisionApproval(f, journal), f.options);
    // Photo choices can be recorded before a sibling explanation exists. Here the
    // sole explanation represents that not-yet-available entry in the partial map.
    f.save(join(f.dir, 'visual-choices.json'), { version: 1, videoId: f.id, stories: {} });
    let calls = 0;
    const context = openMediaContinuation(f.root, f.id, { ...f.options, text: { primary: async request => {
      calls++; request.hooks.beforeAttempt?.(attempt); return { svg: 'candidate awaiting its reviews' } as never;
    } } });
    const task = preparedModelTask({ role: 'script', capability: 'script-draft', taskId: 'diagram-author-1', topicIds: ['topic-1'], protocol: {}, evidence: f.topic });
    await context.call('visual')('Author the requested explanation.', () => null, task); assert.equal(calls, 1);
    const final = preparedModelTask({ role: 'media-review', capability: 'frame-alignment', taskId: 'final-media-review', topicIds: ['topic-1'], protocol: {}, evidence: f.topic });
    assert.throws(() => context.vision('Do not accept missing artwork.', [], () => null, final), /choices must cover/);
    assert.equal(beginParentWork(context.parent).physicalAttempts, 1);
  } finally { f.close(); }
});
