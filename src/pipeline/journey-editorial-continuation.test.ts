import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { atomicJson } from '../workspaces.js';
import { roleHash, reserveParentModelAttempt, reserveParentTool, beginParentWork } from '../llm/role-router.js';
import { resolveModelRuntime, type ModelConfig } from '../llm/model.js';
import { runScriptFirstEditorial, type DailyEditorialCheckpoint, type DailyEditorialInput, type DailyScriptFormat } from './daily-editorial.js';
import { authorizeEditorialContinuation, openEditorialContinuation, sealEditorialContinuation, assertEditorialContinuationSeal, authorizeEditorialFactualRepair, authorizeEditorialCitationRecovery } from './journey-editorial-continuation.js';
import { readableWebText } from '../sources/web-discovery.js';
import { preparedModelTask } from './writing-task.js';
import { authorizeMediaContinuation, openMediaContinuation } from './media-continuation.js';
import { reviewedJourneyScript } from './narration.js';
import type { Script } from '../types.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const text = 'The club announced a provisional schedule for the tournament. Organizers said the venue remains subject to inspection and no matches have taken place.';
const candidate = { text, hook: text, cta: '', body: [], publish: { description: '', linkedinPost: '' }, editorialCopy: [{ storyId: 'topic-1', text }] };
const format: DailyScriptFormat = { identity: 'fixture-complete-copy', instructions: 'Return text and editorialCopy.', schema: { type: 'object', additionalProperties: false, required: ['text', 'hook', 'cta', 'body', 'publish', 'editorialCopy'], properties: { text: { type: 'string' }, hook: { type: 'string' }, cta: { type: 'string' }, body: { type: 'array', items: { type: 'string' } }, publish: { type: 'object', additionalProperties: false, required: ['description', 'linkedinPost'], properties: { description: { type: 'string' }, linkedinPost: { type: 'string' } } }, editorialCopy: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['storyId', 'text'], properties: { storyId: { type: 'string' }, text: { type: 'string' } } } } } }, validate: value => roleHash(value) === roleHash(candidate) ? null : 'Candidate changed', spokenText: value => (value as typeof candidate).text, reviewText: value => (value as typeof candidate).text, newsletterCopy: value => (value as typeof candidate).editorialCopy };
const supported = { verdict: 'supported', reviewedStoryIds: ['topic-1'], findings: [] };

async function fixture(sourceText = text) {
  const root = mkdtempSync(join(tmpdir(), 'editorial-continuation-')), id = '20260915-sports', dir = join(root, 'workdir/videos', id);
  const save = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); atomicJson(path, value); };
  const token = 'a'.repeat(64), previousToken = process.env.HARNESS_TOKEN; process.env.HARNESS_TOKEN = token;
  save(join(root, 'workspace.json'), { id: basename(root) }); save(join(root, 'members.json'), [{ id: 'owner', role: 'owner', tokenHash: sha(token) }]);
  save(join(dir, 'meta.json'), { id, createdBy: 'owner', status: 'failed:script', posts: {} });
  const model = { provider: 'codex', timeoutSeconds: 300, providers: { codex: { command: 'codex', model: 'gpt-5.6-luna' } }, rescue: { enabled: false } } as ModelConfig;
  save(join(root, 'config/model.json'), model);
  const topic = { id, kind: 'roundup', stories: [{ n: 1, headline: 'Club schedule', primaryUrl: 'https://example.com/sport' }] };
  const settings = { dailyEditorialVersion: 7, model, rolePolicy: null, runtime: resolveModelRuntime(model, {}) }, memoryBody = { version: 3, text: '', validUntil: null, records: [] }, memory = { ...memoryBody, hash: roleHash(memoryBody) };
  const writerKey = JSON.stringify({ config: model, rolePolicy: null, runtime: settings.runtime, settingsHash: roleHash(settings), memoryHash: memory.hash });
  const identity = { provider: 'codex', model: 'gpt-5.6-luna', runtimeHash: roleHash({ writerKey, runtime: settings.runtime }) };
  const parentIdentity = roleHash({ version: 7, id, original: topic, settings });
  save(join(dir, 'writing-request.json'), { original: topic, originalHash: roleHash(topic), preparedHash: roleHash(topic), outputs: 'edition', parentIdentity, settingsSnapshot: { settings, hash: roleHash(settings) }, memory });
  save(join(dir, 'topic.json'), topic);
  const raw = `<html><body><main><article><p>${sourceText}</p></article></main></body></html>`;
  const source = { id: 'topic-1-source-1', url: 'https://example.com/sport', publishedAt: null, capturedAt: '2026-09-15T00:00:00Z', text: readableWebText(raw), textSha256: sha(readableWebText(raw)), rawSha256: sha(raw) };
  const input: DailyEditorialInput = { day: '2026-09-15', brief: 'Sports.', stories: [{ id: 'topic-1', headline: 'Club schedule', primaryUrl: source.url, sources: [source] }] };
  save(join(dir, 'journey-editorial-input.json'), { input, hash: roleHash(input) }); save(join(dir, 'journey-editorial-sources', `${source.id}.json`), { source });
  writeFileSync(join(dir, 'journey-editorial-sources', `${sha(raw)}.raw`), raw);
  const checkpointPath = join(dir, 'journey-editorial-checkpoint.json');
  const base = { scriptFormat: format, scriptBudget: { min: 10, max: 50 }, newsletterBudget: { min: 10, max: 50 }, save: (value: DailyEditorialCheckpoint) => save(checkpointPath, value) };
  await assert.rejects(runScriptFirstEditorial(input, { ...base, writer: { identity, call: async () => structuredClone(candidate) as never }, reviewer: { identity, call: async () => { throw new Error("Codex CLI failed after retry: JSON5: invalid character ']' at 1:1772"); } } }), /JSON5/);
  const checkpoint = () => JSON.parse(readFileSync(checkpointPath, 'utf8')) as DailyEditorialCheckpoint;
  const parent = { root, parentId: id, parentIdentity, limits: { totalSeconds: 60, maxPhysicalCalls: 8, maxToolCalls: 4 }, now: () => 1000 };
  for (let i = 0; i < 3; i++) reserveParentModelAttempt(parent, `original-${i}`, { provider: 'codex', model: identity.model, attempt: 1, rescue: false, promptBytes: 100 });
  reserveParentTool(parent, 'captured', 'source');
  const originalBudgetPath = join(root, 'state/role-tasks', id, roleHash({ version: 1, parent: parentIdentity }), 'budget.json');
  const options = { now: () => 70000, env: {} };
  const approval = { intent: 'retry-invalid-review-response' as const, expectedCheckpointHash: roleHash(checkpoint()), expectedOriginalBudgetHash: sha(readFileSync(originalBudgetPath)) };
  const authorize = () => authorizeEditorialContinuation(root, id, approval, options);
  const attempts: string[] = [];
  const open = (fail = false) => openEditorialContinuation(root, id, { ...options, adapters: { primary: async (request, validate) => {
    attempts.push(request.prompt.startsWith('Independently') ? 'review' : 'format');
    request.hooks.beforeAttempt?.({ provider: 'codex', model: identity.model, attempt: 1, rescue: false, promptBytes: Buffer.byteLength(request.prompt) });
    if (fail) throw new Error('Injected failed response');
    const value = request.prompt.startsWith('Independently') ? supported : { sections: candidate.editorialCopy };
    assert.equal(validate(value as never), null); return value as never;
  } } });
  return { root, id, dir, save, parent, base, input, identity, checkpoint, originalBudgetPath, approval, options, authorize, open, attempts,
    close: () => { rmSync(root, { recursive: true, force: true }); if (previousToken === undefined) delete process.env.HARNESS_TOKEN; else process.env.HARNESS_TOKEN = previousToken; } };
}

test('expired review continuation preserves original bytes and candidate, then charges review and formatting to remaining child', async () => {
  const f = await fixture(); try {
    const oldBudget = readFileSync(f.originalBudgetPath), oldCheckpoint = f.checkpoint(); const journal = f.authorize();
    assert.equal(journal.limits.maxPhysicalCalls, 5); assert.equal(journal.limits.maxToolCalls, 3);
    assert.deepEqual(f.checkpoint(), oldCheckpoint); assert.throws(f.authorize, /already exists/);
    const active = f.open();
    const result = await runScriptFirstEditorial(f.input, { ...f.base, writer: { identity: f.identity, call: active.context.call('script') }, reviewer: { identity: f.identity, call: active.context.call('newsletter') }, checkpoint: f.checkpoint(), reviewRecovery: active.reviewRecovery });
    assert.deepEqual(f.attempts, ['review', 'format']); assert.equal(result.checkpoint.artifacts.script.writes, 1);
    assert.deepEqual(result.checkpoint.artifacts.script.candidates, oldCheckpoint.artifacts.script.candidates);
    assert.deepEqual(result.checkpoint.artifacts.script.failures, oldCheckpoint.artifacts.script.failures);
    assert.equal(result.checkpoint.artifacts.newsletter.reviews.length, 0); assert.ok(readFileSync(f.originalBudgetPath).equals(oldBudget));
    assert.equal(beginParentWork(active.child).physicalAttempts, 2);
    const seal = sealEditorialContinuation(f.root, f.id)!; assert.equal(seal.physicalAttempts, 2); assert.equal(seal.toolAttempts, 0);
    assertEditorialContinuationSeal(f.root, f.id, seal); assert.throws(() => f.open(), /sealed/);
    assert.throws(() => reserveParentModelAttempt(active.child, 'after-seal', { provider: 'codex', model: f.identity.model, attempt: 1, rescue: false, promptBytes: 10 }), /sealed/);
    assert.equal(journal.limits.maxPhysicalCalls - seal.physicalAttempts, 3, 'Media successor receives only original remaining minus editorial child use');
  } finally { f.close(); }
});

test('spent invalid retry stays held across resume without another call or rewritten candidate', async () => {
  const f = await fixture(); try {
    f.authorize(); const active = f.open(true), before = f.checkpoint();
    await assert.rejects(runScriptFirstEditorial(f.input, { ...f.base, writer: { identity: f.identity, call: active.context.call('script') }, reviewer: { identity: f.identity, call: active.context.call('newsletter') }, checkpoint: before, reviewRecovery: active.reviewRecovery }), /Injected failed response/);
    assert.equal(f.attempts.length, 1); const resumed = f.open(); assert.equal(resumed.reviewRecovery, undefined);
    await assert.rejects(runScriptFirstEditorial(f.input, { ...f.base, writer: { identity: f.identity, call: resumed.context.call('script') }, reviewer: { identity: f.identity, call: resumed.context.call('newsletter') }, checkpoint: f.checkpoint() }), /retained held/);
    assert.equal(f.attempts.length, 1); assert.deepEqual(f.checkpoint().artifacts.script.candidates, before.artifacts.script.candidates);
  } finally { f.close(); }
});

test('changed source, model, original allowance and unrecognized hold fail before inference', async () => {
  for (const mode of ['source', 'model', 'budget', 'hold'] as const) {
    const f = await fixture(); try {
      if (mode === 'hold') { const cp = f.checkpoint(); cp.artifacts.script.failures = ['script remains unsupported: contradiction']; cp.contentHash = roleHash(cp.artifacts); f.save(join(f.dir, 'journey-editorial-checkpoint.json'), cp); assert.throws(() => authorizeEditorialContinuation(f.root, f.id, { ...f.approval, expectedCheckpointHash: roleHash(cp) }, f.options), /recognized invalid-response/); continue; }
      f.authorize();
      if (mode === 'source') { const path = join(f.dir, 'journey-editorial-input.json'); const value = JSON.parse(readFileSync(path, 'utf8')); value.input.stories[0].sources[0].text += ' Changed.'; value.hash = roleHash(value.input); f.save(path, value); }
      if (mode === 'model') { const path = join(f.root, 'config/model.json'); const value = JSON.parse(readFileSync(path, 'utf8')); value.providers.codex.model = 'gpt-5.5'; f.save(path, value); }
      if (mode === 'budget') { const value = JSON.parse(readFileSync(f.originalBudgetPath, 'utf8')); value.deadline++; f.save(f.originalBudgetPath, value); }
      assert.throws(() => f.open(), /changed/); assert.equal(f.attempts.length, 0);
    } finally { f.close(); }
  }
});

test('review-only continuation rejects any writer or research task before provider invocation', async () => {
  const f = await fixture(); try {
    f.authorize(); const active = f.open();
    const task = preparedModelTask({ role: 'script', capability: 'script-draft', taskId: 'daily-editorial-script-write-2', topicIds: ['topic-1'], protocol: {}, evidence: {} });
    await assert.rejects(active.context.call('script')('Rewrite', () => null, task), /outside/); assert.equal(f.attempts.length, 0);
  } finally { f.close(); }
});

test('self-hashed journal tampering cannot enlarge remaining counts or substitute original parent', async () => {
  for (const mode of ['counts', 'parent', 'original'] as const) {
    const f = await fixture(); try {
      const journal = f.authorize();
      if (mode === 'counts') journal.limits.maxPhysicalCalls++;
      if (mode === 'parent') journal.originalParent = 'f'.repeat(64);
      if (mode === 'original') journal.originalBudget.attempts.pop();
      const { identity: _old, ...body } = journal;
      f.save(join(f.dir, 'editorial-continuation.json'), { ...body, identity: roleHash(body) });
      assert.throws(() => f.open(), /allowance|parent/); assert.equal(f.attempts.length, 0);
    } finally { f.close(); }
  }
});

test('delivery markers, rejected status and removal of original failure evidence stop an opened context', async () => {
  for (const mode of ['rejected', 'delivery-marker', 'delivery-log', 'failure'] as const) {
    const f = await fixture(); try {
      f.authorize(); const active = f.open();
      if (mode === 'rejected') f.save(join(f.dir, 'meta.json'), { id: f.id, createdBy: 'owner', status: 'rejected', posts: {} });
      if (mode === 'delivery-marker') writeFileSync(join(f.dir, '.delivery-started'), 'reserved');
      if (mode === 'delivery-log') writeFileSync(join(f.dir, 'delivery-events.jsonl'), '{}\n');
      if (mode === 'failure') { const cp = f.checkpoint(); cp.artifacts.script.failures = []; cp.contentHash = roleHash(cp.artifacts); f.save(join(f.dir, 'journey-editorial-checkpoint.json'), cp); }
      assert.throws(() => active.assertUnchanged(), /delivery|original candidates/); assert.equal(f.attempts.length, 0);
    } finally { f.close(); }
  }
});

test('actual media authorization subtracts and seals predecessor physical calls instead of granting them twice', async () => {
  const f = await fixture(); try {
    f.authorize(); const active = f.open();
    await runScriptFirstEditorial(f.input, { ...f.base, writer: { identity: f.identity, call: active.context.call('script') }, reviewer: { identity: f.identity, call: active.context.call('newsletter') }, checkpoint: f.checkpoint(), reviewRecovery: active.reviewRecovery });
    const script = reviewedJourneyScript(candidate as unknown as Script, [f.input.stories[0]!.primaryUrl]);
    const issue = { subject: 'Fixture', lead: { body: text }, items: [], radar: [], signals: [] };
    const topic = active.context.topic, checkpoint = f.checkpoint(), writerKey = active.context.writerKey;
    f.save(join(f.dir, 'script.json'), script); f.save(join(f.dir, 'journey-editorial-issue.json'), issue);
    f.save(join(f.dir, 'companion-writing-receipt.json'), { version: 3, reviewProtocol: 'daily-editorial', editorialVersion: 7, topicHash: roleHash(topic), writerKey, scriptHash: roleHash(script), checkpointHash: roleHash(checkpoint), inputHash: roleHash(f.input) });
    f.save(join(f.dir, 'journey-editorial-receipt.json'), { editorialVersion: 7, parentIdentity: f.parent.parentIdentity, writerKey, scriptHash: roleHash(script), checkpointHash: roleHash(checkpoint), inputHash: roleHash(f.input), issueHash: roleHash(issue) });
    f.save(join(f.dir, 'meta.json'), { id: f.id, createdBy: 'owner', status: 'assets_ready', posts: {} });
    const media = authorizeMediaContinuation(f.root, f.id, { intent: 'continue-approved-media', expectedWriterKey: writerKey, expectedScriptHash: roleHash(script), expectedNewsletterHash: roleHash(issue), expectedOriginalBudgetHash: f.approval.expectedOriginalBudgetHash, deadlinePolicy: 'operation-only' }, f.options);
    assert.equal(media.original.physicalAttempts, 3); assert.equal(media.editorialPredecessor?.physicalAttempts, 2); assert.equal(media.limits.maxPhysicalCalls, 3);
    const next = openMediaContinuation(f.root, f.id, f.options); assert.equal(beginParentWork(next.parent).remainingPhysical, 3);
    assert.throws(() => f.open(), /sealed/);
    const path = join(f.root, 'state/role-tasks', f.id, roleHash({ version: 1, parent: active.child.parentIdentity }), 'budget.json');
    const tampered = JSON.parse(readFileSync(path, 'utf8')); tampered.attempts.pop(); f.save(path, tampered);
    assert.throws(() => next.assertUnchanged(), /Sealed editorial spending changed/);
  } finally { f.close(); }
});

test('a separately recorded exact factual repair uses the existing child and retains its rejected evidence', async () => {
  const f = await fixture(); try {
    const before = f.checkpoint();
    before.artifacts.script.writes = 2; before.artifacts.script.candidates.push(structuredClone(before.artifacts.script.candidates[0]!));
    before.artifacts.script.failures = ['Complete editorialCopy has 8 words; required 10–50, separately from spoken narration', 'script failed after its one repair: Complete editorialCopy has 8 words; required 10–50, separately from spoken narration'];
    before.contentHash = roleHash(before.artifacts); f.save(join(f.dir, 'journey-editorial-checkpoint.json'), before);
    const journal = authorizeEditorialContinuation(f.root, f.id, { ...f.approval, intent: 'repair-exhausted-script-length', expectedCheckpointHash: roleHash(before) }, f.options);
    const active = f.open(); reserveParentModelAttempt(active.child, 'fixture-length-reservation', { provider: 'codex', model: f.identity.model, attempt: 1, rescue: false, promptBytes: 10 });
    const revised = structuredClone(candidate), falseSentence = 'The tournament has already begun.'; revised.editorialCopy[0]!.text += ` ${falseSentence}`;
    const rejected = f.checkpoint(); rejected.artifacts.script.candidates.push(revised as never);
    rejected.artifacts.script.lengthRecovery = { authorizationHash: journal.identity, checkpointHash: journal.checkpointHash, parentIdentity: journal.originalParent, baseIndex: 0, status: 'finished', candidateHash: roleHash(revised), plan: {} } as never;
    rejected.artifacts.script.reviews.push({ candidateHash: roleHash(revised), reviewer: f.identity, output: { verdict: 'changes-required', reviewedStoryIds: ['topic-1'], findings: [{ storyId: 'topic-1', kind: 'contradiction', candidateExcerpt: falseSentence, evidence: [{ sourceId: 'topic-1-source-1', quote: 'no matches have taken place' }], reason: 'The source explicitly says no matches have taken place.' }] } });
    rejected.artifacts.script.failures.push('script remains unsupported: The source explicitly says no matches have taken place.'); rejected.contentHash = roleHash(rejected.artifacts);
    f.save(join(f.dir, 'journey-editorial-checkpoint.json'), rejected);
    const childPath = join(f.root, 'state/role-tasks', f.id, roleHash({ version: 1, parent: journal.identity }), 'budget.json'), childBefore = readFileSync(childPath);
    const approval = { intent: 'repair-rejected-editorial-field' as const, expectedCheckpointHash: roleHash(rejected) };
    const factual = authorizeEditorialFactualRepair(f.root, f.id, approval, f.options);
    assert.ok(readFileSync(childPath).equals(childBefore)); assert.deepEqual(factual.originalCheckpoint, rejected);
    const resumed = f.open(); assert.equal(resumed.child.parentIdentity, active.child.parentIdentity); assert.equal(resumed.factualRecovery?.authorizationHash, factual.identity);
    assert.equal(beginParentWork(resumed.child).physicalAttempts, 1); assert.throws(() => authorizeEditorialFactualRepair(f.root, f.id, approval, f.options), /already authorized/);
    const changed = f.checkpoint(); changed.artifacts.script.reviews = []; changed.contentHash = roleHash(changed.artifacts); f.save(join(f.dir, 'journey-editorial-checkpoint.json'), changed);
    assert.throws(() => resumed.assertUnchanged(), /rejected candidate, verdict or failures/);
  } finally { f.close(); }
});


test('citation authorization binds exact final rejected raw response and cannot grant or reset the original write allowance', async () => {
  const complete = 'The tournament organizer confirmed that the published schedule remains a provisional plan subject to inspection before any matches may take place.';
  const prefix = 'The tournament organizer confirmed that the published schedule remains a provisional plan.';
  const f = await fixture(complete); try {
    const journal = f.authorize(), active = f.open(true);
    await assert.rejects(runScriptFirstEditorial(f.input, { ...f.base, writer: { identity: f.identity, call: active.context.call('script') }, reviewer: { identity: f.identity, call: active.context.call('newsletter') }, checkpoint: f.checkpoint(), reviewRecovery: active.reviewRecovery }), /Injected failed response/);
    const rawFile = '11111111-1111-1111-1111-111111111111.json', rawPath = join(realpathSync(f.root), 'state/model-output-failures', rawFile);
    const rejection = { verdict: 'changes-required', reviewedStoryIds: ['topic-1'], findings: [{ storyId: 'topic-1', kind: 'attribution', candidateExcerpt: candidate.hook, reason: 'Preserve provisional attribution.', evidence: [{ sourceId: 'topic-1-source-1', quote: prefix }] }] };
    const packet = (value: string) => ({ text: value, bytes: Buffer.byteLength(value), sha256: sha(value), truncated: false });
    f.save(rawPath, { version: 1, provider: 'codex', model: f.identity.model, attempt: 2, rescue: false, problem: 'Reviewer evidence quote or source ownership is invalid', prompt: packet(`Independently assess the complete script\nCANDIDATE:\n${JSON.stringify(candidate)}\nCOMPLETE CAPTURED EVIDENCE AND BRIEF:\n${JSON.stringify(f.input)}`), response: packet(JSON.stringify(rejection)) });
    const cp = f.checkpoint(), failure = `script factual reviewer unavailable or invalid: Rejected output retained at ${rawPath}`;
    cp.artifacts.script.failures[cp.artifacts.script.failures.length - 1] = failure;
    cp.artifacts.script.invalidReview = { kind: 'validation', candidateHash: roleHash(candidate), reviewerHash: roleHash(f.identity), errorHash: sha(failure) }; cp.contentHash = roleHash(cp.artifacts); f.save(join(f.dir, 'journey-editorial-checkpoint.json'), cp);
    const beforeBudget = readFileSync(f.originalBudgetPath), priorCount = beginParentWork(f.open().child).physicalAttempts;
    const approval = { intent: 'reconcile-truncated-review-citation' as const, expectedCheckpointHash: roleHash(cp), rawFile, expectedRawHash: sha(readFileSync(rawPath)) };
    const receipt = authorizeEditorialCitationRecovery(f.root, f.id, approval, f.options);
    const recovered = f.open(); assert.equal(recovered.citationRecovery?.authorizationHash, receipt.identity);
    assert.equal(beginParentWork(recovered.child).physicalAttempts, priorCount); assert.ok(readFileSync(f.originalBudgetPath).equals(beforeBudget));
    assert.throws(() => authorizeEditorialCitationRecovery(f.root, f.id, approval, f.options), /already authorized/);
    const altered = f.checkpoint(); altered.artifacts.script.writes = 2; altered.contentHash = roleHash(altered.artifacts); f.save(join(f.dir, 'journey-editorial-checkpoint.json'), altered);
    assert.throws(() => f.open(), /writing counts/); f.save(join(f.dir, 'journey-editorial-checkpoint.json'), cp);
    const raw = JSON.parse(readFileSync(rawPath, 'utf8')); raw.response.text = raw.response.text.replace('provisional', 'final'); f.save(rawPath, raw);
    assert.throws(() => f.open(), /prompt or response changed/); assert.equal(journal.originalCheckpoint.artifacts.script.writes, 1);
  } finally { f.close(); }
});
