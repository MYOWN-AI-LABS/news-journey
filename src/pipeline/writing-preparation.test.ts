import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson } from '../workspaces.js';
import { beginParentWork, parentModelHooks, roleHash, reserveParentTool } from '../llm/role-router.js';
import { prepareWriting, writingPreparationFailureMessage, WRITING_PREPARATION_VERSION, type WritingPreparationAdapters, type WritingPreparationRequest } from './writing-preparation.js';
import { newsletterEvidenceSentences, type EvidenceTopic } from './newsletter-evidence.js';

const rich = JSON.parse(readFileSync(new URL('../../examples/fixtures/newsletter-rich-sports-evidence.json', import.meta.url), 'utf8')) as { topics: Array<EvidenceTopic & { sourceText: string }> };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'writing-preparation-')); let now = Date.now(), captures = 0, calls = 0;
  const request: WritingPreparationRequest = { parent: { root, parentId: 'sports-package', parentIdentity: roleHash('original sports package'), limits: { totalSeconds: 120, maxPhysicalCalls: 20, maxToolCalls: 8 }, now: () => now }, day: '2026-09-14', briefHash: roleHash('sports only'), settingsHash: roleHash('exact writer digest and settings'), topics: rich.topics.map(({ sourceText: _, ...topic }) => topic), targets: { video: { min: 195, max: 220 }, newsletter: { min: 900, max: 1300 } }, fixedVideoWords: 20 };
  const prompts: string[] = [];
  const adapters: WritingPreparationAdapters = {
    capture: async (source, limits) => {
      captures++; assert.ok(limits.timeoutMs <= 30_000); assert.equal(limits.maxBytes, 250_000);
      const text = rich.topics.find(topic => topic.primaryUrl === source.url)!.sourceText;
      return { ...source, text, status: 200, sha256: sha(text), textSha256: sha(text), observedAt: new Date(now).toISOString(), bytes: Buffer.byteLength(text) };
    },
    judge: async <T>(prompt: string, validate: (value: T) => string | null, context: Parameters<WritingPreparationAdapters['judge']>[2]) => {
      context.hooks.beforeAttempt!({ provider: 'ollama', model: 'fixture:4b', attempt: 1, rescue: false, promptBytes: Buffer.byteLength(prompt) }); calls++; prompts.push(prompt);
      const sentences = JSON.parse(prompt.split('SOURCE_SENTENCES: ')[1]!) as Array<{ id: number }>;
      const initial = prompt.startsWith('Independently review ONE source-evidence selection')
        ? JSON.parse(prompt.split('INITIAL_SELECTION: ')[1]!.split('\n')[0]!) : null;
      const value = (initial
        ? initial
        : { selectedIds: sentences.map(row => row.id), requiredIds: [], unsupportedCandidate: [] }) as T;
      assert.equal(validate(value), null); return value;
    },
  };
  return { root, request, adapters, prompts, captures: () => captures, calls: () => calls, elapse: (ms: number) => { now += ms; }, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('provider failure stays a model problem on resume instead of asking for different topic sources', async () => {
  const f = fixture(); try {
    const adapters = { ...f.adapters, judge: async <T,>(prompt: string, validate: (value: T) => string | null, context: Parameters<WritingPreparationAdapters['judge']>[2]): Promise<T> => {
      context.hooks.beforeAttempt!({ provider: 'ollama', model: 'fixture:4b', attempt: 1, rescue: false, promptBytes: Buffer.byteLength(prompt) });
      throw new Error('Provider HTTP 503');
    } };
    const result = await prepareWriting(f.request, adapters);
    assert.equal(result.status, 'needs-evidence'); if (result.status !== 'needs-evidence') return;
    assert.equal(result.failureKind, 'model-task');
    assert.ok(result.trace.some(event => event.failed && event.outcome === 'Provider HTTP 503'));
    assert.match(writingPreparationFailureMessage(result, f.request.targets.newsletter), /selected model could not finish/);
    assert.doesNotMatch(writingPreparationFailureMessage(result, f.request.targets.newsletter), /Add a detailed trusted source/);
    const attempts = result.parent.physicalAttempts;
    const resumed = await prepareWriting(f.request, adapters);
    assert.equal(resumed.status, 'needs-evidence'); if (resumed.status !== 'needs-evidence') return;
    assert.equal(resumed.failureKind, 'model-task'); assert.equal(resumed.parent.physicalAttempts, attempts);
    f.elapse(120001);
    const expired = await prepareWriting(f.request, adapters);
    assert.equal(expired.status, 'needs-evidence'); if (expired.status !== 'needs-evidence') return;
    assert.equal(expired.failureKind, 'budget');
    assert.match(writingPreparationFailureMessage(expired, f.request.targets.newsletter), /saved time or attempt limit/);
    assert.equal(expired.parent.physicalAttempts, attempts);
  } finally { f.close(); }
});

test('one topic cannot hide another topic model failure on a shared source, and missing tool capacity is a budget stop', async () => {
  const f = fixture(); try {
    f.request.topics[1]!.primaryUrl = f.request.topics[0]!.primaryUrl;
    const result = await prepareWriting(f.request, { ...f.adapters, judge: async <T,>(prompt: string, validate: (value: T) => string | null, context: Parameters<WritingPreparationAdapters['judge']>[2]) => {
      if (context.task.topicIds[0] === f.request.topics[0]!.id) {
        context.hooks.beforeAttempt!({ provider: 'ollama', model: 'fixture:4b', attempt: 1, rescue: false, promptBytes: Buffer.byteLength(prompt) });
        throw new Error('HTTP 503 for the first topic');
      }
      return f.adapters.judge(prompt, validate, context);
    } });
    assert.equal(result.status, 'needs-evidence'); if (result.status !== 'needs-evidence') return;
    assert.equal(result.failureKind, 'model-task');
    assert.ok(result.trace.some(row => row.sourceUrl === f.request.topics[0]!.primaryUrl && row.packetHash));
  } finally { f.close(); }
  const g = fixture(); try {
    g.request.parent.limits.maxToolCalls = 0;
    const result = await prepareWriting(g.request, g.adapters);
    assert.equal(result.status, 'needs-evidence'); if (result.status !== 'needs-evidence') return;
    assert.equal(result.failureKind, 'budget'); assert.equal(g.captures(), 0); assert.equal(g.calls(), 0);
    assert.doesNotMatch(writingPreparationFailureMessage(result, g.request.targets.newsletter), /Add a detailed trusted source/);
  } finally { g.close(); }
});

test('rich evidence prepares both unchanged output lengths through isolated source tasks and one cumulative allowance', async () => {
  const f = fixture(); try {
    const result = await prepareWriting(f.request, f.adapters);
    assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
    assert.equal(f.calls(), 6); assert.equal(f.captures(), 3);
    assert.equal(WRITING_PREPARATION_VERSION, 8); assert.equal(result.plan.version, 1);
    assert.deepEqual(result.plan.targets, f.request.targets);
    assert.equal(result.plan.mode, 'bounded-prose'); assert.equal(result.plan.finalReviewRequired, true); assert.equal(result.plan.sourceSupportIsFallible, true);
    assert.equal(result.plan.topics.reduce((sum, topic) => sum + topic.newsletterTarget.min, 0), 900);
    assert.equal(result.plan.topics.reduce((sum, topic) => sum + topic.newsletterTarget.max, 0), 1300);
    assert.equal(result.plan.topics.reduce((sum, topic) => sum + topic.videoTarget.min, 0), 175);
    result.plan.topics.forEach((topic, index) => {
      assert.equal(topic.verifiedClaims.join(' '), rich.topics[index]!.sourceText);
      assert.equal(topic.packets[0]!.units.every(unit => unit.requires.length === topic.packets[0]!.units.length - 1), true);
      for (const prompt of f.prompts.slice(index * 2, index * 2 + 2)) {
        assert.ok(prompt.includes(topic.headline));
        for (const other of rich.topics.filter(row => row.id !== topic.id)) assert.equal(prompt.includes(other.headline), false);
      }
      assert.match(f.prompts[index * 2 + 1]!, /^Independently review ONE source-evidence selection/);
      assert.ok(topic.packets.every(packet => packet.version === 10));
    });
    parentModelHooks(f.request.parent, 'newsletter-writer').beforeAttempt!({ provider: 'ollama', model: 'fixture:4b', attempt: 1, rescue: false, promptBytes: 500 });
    assert.equal(beginParentWork(f.request.parent).physicalAttempts, 7);
    assert.equal(beginParentWork(f.request.parent).toolAttempts, 3);
  } finally { f.close(); }
});

test('one-source video prepares real reviewed claims and resumes without extra work; an edition keeps its own full target', async () => {
  const f = fixture(); try {
    f.request.topics = [f.request.topics[0]!];
    f.request.targets.newsletter = { ...f.request.targets.video };
    const result = await prepareWriting(f.request, f.adapters);
    assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
    assert.equal(f.captures(), 1); assert.equal(f.calls(), 2);
    assert.equal(result.plan.topics.length, 1);
    assert.equal(result.plan.topics[0]!.verifiedClaims.join(' '), rich.topics[0]!.sourceText);
    assert.equal(result.plan.topics[0]!.packets[0]!.capture.sha256, sha(rich.topics[0]!.sourceText));
    assert.deepEqual(result.plan.targets, { video: { min: 195, max: 220 }, newsletter: { min: 195, max: 220 } });
    const resumed = await prepareWriting(f.request, { capture: async () => { throw new Error('must reuse capture'); }, judge: async () => { throw new Error('must reuse review'); } });
    assert.equal(resumed.status, 'ready'); assert.equal(resumed.parent.physicalAttempts, 2); assert.equal(resumed.parent.toolAttempts, 1);
  } finally { f.close(); }
  const g = fixture(); try {
    g.request.topics = [g.request.topics[0]!];
    const result = await prepareWriting(g.request, g.adapters);
    assert.equal(result.status, 'needs-evidence'); if (result.status !== 'needs-evidence') return;
    assert.deepEqual(result.coverage.newsletter.requested, { min: 900, max: 1300 });
    assert.ok(result.coverage.newsletter.minimumAdditionalWords > 0);
    assert.equal(g.captures(), 1); assert.equal(g.calls(), 2);
  } finally { g.close(); }
});

test('exact completed preparation survives a long human review with no new tools or inference, while a changed brief cannot reset the allowance', async () => {
  const f = fixture(); try {
    const first = await prepareWriting(f.request, f.adapters);
    f.elapse(121_000);
    const cached = await prepareWriting(f.request, { capture: async () => { throw new Error('must not fetch'); }, judge: async () => { throw new Error('must not infer'); } });
    assert.equal(cached.status, 'ready'); if (cached.status === 'ready') assert.equal(cached.cached, true);
    assert.equal(cached.parent.deadline, first.parent.deadline); assert.equal(f.calls(), 6);
    assert.throws(() => parentModelHooks(f.request.parent, 'new-script').beforeAttempt!({ provider: 'ollama', attempt: 1, rescue: false, promptBytes: 4 }), /time ceiling/);
    const changed = await prepareWriting({ ...f.request, briefHash: roleHash('different sports brief') }, f.adapters);
    assert.equal(changed.status, 'needs-evidence'); assert.equal(changed.parent.deadline, first.parent.deadline);
    assert.equal(changed.parent.physicalAttempts, 6); assert.equal(f.captures(), 3);
  } finally { f.close(); }
});

test('a failed source judgment resumes its saved capture and keeps successful sibling evidence without refunding failed physical attempts', async () => {
  const f = fixture(); try {
    let failures = 0;
    const failing: WritingPreparationAdapters = { ...f.adapters, judge: async (prompt, validate, context) => {
      if (prompt.includes('"id":"cup"') && failures++ < 2) {
        context.hooks.beforeAttempt!({ provider: 'ollama', model: 'fixture:4b', attempt: 1, rescue: false, promptBytes: Buffer.byteLength(prompt) });
        throw new Error('source judgment failed');
      }
      return f.adapters.judge(prompt, validate, context);
    } };
    const incomplete = await prepareWriting(f.request, failing);
    assert.equal(incomplete.status, 'needs-evidence'); assert.equal(incomplete.parent.physicalAttempts, 6); assert.equal(f.captures(), 3);
    // Each source has a strict two-logical-selection ceiling, even across worker resumes.
    const resumed = await prepareWriting(f.request, f.adapters);
    assert.equal(resumed.status, 'needs-evidence'); assert.equal(resumed.parent.physicalAttempts, 6); assert.equal(f.captures(), 3);
    assert.equal(resumed.trace.filter(row => row.outcome.includes('source judgment failed')).length, 2);
    assert.equal(resumed.trace.filter(row => row.action === 'select' && row.outcome.startsWith('exact source packet accepted')).length, 2, 'complete sibling captures are not selected again');
  } finally { f.close(); }
});

test('one failed judgment retries its saved source once; successful source packets are unchanged', async () => {
  const f = fixture(); try {
    let failed = false;
    const result = await prepareWriting(f.request, { ...f.adapters, judge: async (prompt, validate, context) => {
      if (!failed && prompt.includes('"id":"cup"')) { failed = true; context.hooks.beforeAttempt!({ provider: 'ollama', attempt: 1, rescue: false, promptBytes: Buffer.byteLength(prompt) }); throw new Error('transient JSON failure'); }
      return f.adapters.judge(prompt, validate, context);
    } });
    assert.equal(result.status, 'ready'); assert.equal(result.parent.physicalAttempts, 7); assert.equal(f.captures(), 3);
    assert.equal(result.trace.filter(row => row.action === 'capture').length, 3);
  } finally { f.close(); }
});

test('a short valid source selection expands once from the same capture, retaining its first complete sentence', async () => {
  const f = fixture(); try {
    let initial = true;
    const result = await prepareWriting(f.request, { ...f.adapters, judge: async (prompt, validate, context) => {
      if (initial) {
        initial = false;
        context.hooks.beforeAttempt!({ provider: 'ollama', attempt: 1, rescue: false, promptBytes: Buffer.byteLength(prompt) });
        const short = { selectedIds: [1], requiredIds: [], unsupportedCandidate: [] };
        assert.equal(validate(short as never), null); return short as never;
      }
      return f.adapters.judge(prompt, validate, context);
    } });
    assert.equal(result.status, 'ready'); assert.equal(result.parent.physicalAttempts, 8); assert.equal(f.captures(), 3);
    if (result.status === 'ready') assert.equal(result.plan.topics[0]!.verifiedClaims.join(' '), rich.topics[0]!.sourceText);
  } finally { f.close(); }
});

test('sparse facts produce exact unmet original length evidence and finite source work, without copied padding', async () => {
  const f = fixture(); try {
    const text = 'The provisional fixture requires later confirmation by the organizer.';
    const result = await prepareWriting(f.request, { ...f.adapters, capture: async source => ({ ...source, text, status: 200, sha256: sha(text), textSha256: sha(text), observedAt: new Date().toISOString(), bytes: Buffer.byteLength(text) }) });
    assert.equal(result.status, 'needs-evidence'); if (result.status !== 'needs-evidence') return;
    assert.deepEqual(result.coverage.newsletter.requested, { min: 900, max: 1300 });
    assert.equal(result.coverage.newsletter.availableWords, 9, 'syndicated duplicate facts count once');
    assert.equal(result.coverage.newsletter.minimumAdditionalWords, 891);
    assert.deepEqual(result.nextResearch.topicIds, f.request.topics.map(topic => topic.id));
    assert.equal(result.parent.physicalAttempts, 6); assert.equal(result.parent.toolAttempts, 3);
    assert.equal(result.trace.filter(row => row.action === 'select').length, 3, 'a fully selected sparse source cannot gain words by repeating selection');
    const resumed = await prepareWriting(f.request, f.adapters);
    assert.equal(resumed.status, 'needs-evidence'); assert.equal(resumed.parent.physicalAttempts, 6); assert.equal(resumed.parent.toolAttempts, 3);
  } finally { f.close(); }
});

test('altered source qualifiers and ready plan values fail closed, and rejected checkpoints release their lock', async () => {
  const f = fixture(); try {
    await prepareWriting(f.request, f.adapters);
    const dir = join(f.root, 'state/writing-preparation', f.request.parent.parentId), path = join(dir, readdirSync(dir)[0]!);
    const state = JSON.parse(readFileSync(path, 'utf8'));
    state.attempts[0].packet.units[0].text = 'The schedule is confirmed without conditions.';
    atomicJson(path, state);
    await assert.rejects(prepareWriting(f.request, f.adapters), /checkpoint identity/);
    await assert.rejects(prepareWriting(f.request, f.adapters), /checkpoint identity/);
    assert.equal(f.captures(), 3); assert.equal(f.calls(), 6);
  } finally { f.close(); }
});

test('parent model and tool limits persist independently across settings changes and failed capture attempts', async () => {
  const f = fixture(); try {
    f.request.parent.limits.maxToolCalls = 1;
    const first = await prepareWriting(f.request, { ...f.adapters, capture: async () => { throw new Error('fixture connection failed'); } });
    assert.equal(first.status, 'needs-evidence'); assert.equal(first.parent.toolAttempts, 1);
    assert.throws(() => reserveParentTool(f.request.parent, 'another', 'source-capture'), /tool allowance/);
    const changed = await prepareWriting({ ...f.request, settingsHash: roleHash('different writer') }, f.adapters);
    assert.equal(changed.status, 'needs-evidence'); assert.equal(changed.parent.remainingTools, 0); assert.equal(changed.parent.deadline, first.parent.deadline);
    assert.equal(f.captures(), 0);
  } finally { f.close(); }
});

test('the independent selection review cannot exceed the parent allowance or turn an unreviewed selection into ready evidence', async () => {
  const f = fixture(); try {
    f.request.parent.limits.maxPhysicalCalls = 1;
    const result = await prepareWriting(f.request, f.adapters);
    assert.equal(result.status, 'needs-evidence');
    assert.equal(result.parent.physicalAttempts, 1); assert.equal(result.parent.remainingPhysical, 0);
    assert.equal(f.calls(), 1); assert.equal(f.captures(), 1);
    if (result.status === 'needs-evidence') assert.equal(result.coverage.newsletter.availableWords, 0);
    const resumed = await prepareWriting(f.request, f.adapters);
    assert.equal(resumed.status, 'needs-evidence'); assert.equal(resumed.parent.deadline, result.parent.deadline);
    assert.equal(resumed.parent.physicalAttempts, 1); assert.equal(f.calls(), 1); assert.equal(f.captures(), 1);
  } finally { f.close(); }
});


test('all selected primaries are gathered before corroboration supplies the real missing capacity within two captures per topic', async () => {
  const f = fixture(); try {
    f.request.topics = f.request.topics.map(topic => ({ ...topic, corroboratingUrls: [`${topic.primaryUrl}/details`, `${topic.primaryUrl}/unused`] }));
    const captured: Array<{ topicId: string; role: string; url: string }> = [];
    const result = await prepareWriting(f.request, { ...f.adapters, capture: async (source, limits) => {
      const topic = rich.topics.find(topic => source.url === topic.primaryUrl || source.url === `${topic.primaryUrl}/details`);
      assert.ok(topic, 'only the selected primary and first trusted corroborating source may be captured');
      assert.ok(limits.timeoutMs <= 30_000);
      captured.push({ topicId: topic.id, role: source.role, url: source.url });
      assert.ok(captured.filter(row => row.topicId === topic.id).length <= 2);
      const sentences = newsletterEvidenceSentences(topic.sourceText);
      const text = (source.role === 'primary' ? sentences.slice(0, 1) : sentences.slice(1)).map(row => row.text).join(' ');
      return { ...source, text, status: 200, sha256: sha(text), textSha256: sha(text), observedAt: '2026-09-14T12:00:00Z', bytes: Buffer.byteLength(text) };
    } });
    assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
    assert.deepEqual(captured.slice(0, 3).map(row => row.role), ['primary', 'primary', 'primary']);
    assert.deepEqual(captured.slice(0, 3).map(row => row.topicId), f.request.topics.map(topic => topic.id));
    assert.equal(captured.length, 6); assert.equal(result.parent.toolAttempts, 6); assert.equal(result.parent.physicalAttempts, 12);
    assert.deepEqual(result.plan.targets, { video: { min: 195, max: 220 }, newsletter: { min: 900, max: 1300 } });
    assert.equal(result.plan.topics.reduce((sum, topic) => sum + topic.newsletterTarget.min, 0), 900);
    for (const [index, topic] of result.plan.topics.entries()) {
      assert.equal(topic.primaryUrl, rich.topics[index]!.primaryUrl);
      assert.deepEqual(topic.packets.map(packet => packet.capture.role), ['primary', 'corroborating']);
      assert.equal(topic.verifiedClaims.join(' '), rich.topics[index]!.sourceText);
    }
    const resumed = await prepareWriting(f.request, { judge: async () => { throw new Error('completed preparation must reuse its exact review'); }, capture: async () => { throw new Error('completed preparation must not recapture'); } });
    assert.equal(resumed.status, 'ready'); assert.equal(resumed.parent.physicalAttempts, 12); assert.equal(resumed.parent.toolAttempts, 6);
  } finally { f.close(); }
});
