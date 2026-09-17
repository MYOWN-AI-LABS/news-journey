import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftEvidenceNewsletter, draftEvidenceScript, evidencePacket, inspectEvidenceBudget, selectEvidenceTopic, qualifyEvidenceRole, type EvidenceSession, type EvidenceStory } from './evidence-draft.js';
import { roleHash } from '../llm/role-router.js';
import { atomicJson } from '../workspaces.js';
import type { Topic } from '../types.js';
import { scriptProblem } from './script.js';
import { EVIDENCE_SELECTION_CONTRACT, roleQualificationStatus } from '../llm/role-state.js';

const stories = [
  { headline: 'Council releases public records', weight: 'lead' as const, primaryUrl: 'https://council.example/records', verifiedClaims: ['The council released the public records.', 'The source does not establish why earlier records were unavailable.'] },
  { headline: 'Router update removes an option', weight: 'standard' as const, primaryUrl: 'https://router.example/update', verifiedClaims: ['The router update removes the export option.', 'The announcement gives no performance measurement for the change.'] },
].map(story => ({ ...story, claimEvidence: [{ url: story.primaryUrl, role: 'primary' as const, status: 200, sha256: 'a'.repeat(64), observedAt: '2026-09-14T00:00:00Z' }] }));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'evidence-draft-')), prompts: string[] = [], models: string[] = [];
  let failSecond = false;
  const session: EvidenceSession = { root, hostRoot: root, parentId: 'package-1', parentIdentity: roleHash('exact request'), briefHash: roleHash('sports'), primary: { provider: 'ollama', providers: { ollama: { model: 'writer:7b', baseUrl: 'http://127.0.0.1:11434/v1', contextTokens: 8192 } } }, policy: { version: 1, enabled: true, roles: { writer: { provider: 'ollama', model: 'writer:7b', contextTokens: 8192 }, research: { provider: 'ollama', model: 'research:3b', contextTokens: 8192 } }, limits: { totalSeconds: 600, maxPhysicalCalls: 20 } }, env: {}, adapters: {
    inspect: async runtime => ({ identity: { provider: runtime.provider, model: runtime.model!, baseUrl: runtime.baseUrl!, digest: 'a'.repeat(64), context: { mode: 'requested', tokens: 8192, proof: 'request' }, protocolVersion: 1, runtimeVersion: 'fixture', hardwareFingerprint: 'b'.repeat(64) }, fitsMemory: true }),
    invoke: async <T>(request: any, validate: (value: T) => string | null) => {
      const runtime = request.config.providers.ollama;
      request.hooks.beforeAttempt({ provider: 'ollama', model: runtime.model, baseUrl: runtime.baseUrl, attempt: 1, rescue: false, promptBytes: Buffer.byteLength(request.prompt) });
      prompts.push(request.prompt); models.push(runtime.model);
      if (failSecond && request.prompt.includes('Router update')) throw new Error('second topic interrupted');
      const value = request.prompt.startsWith('CAPTURED SOURCE') ? { sourceIds: [1] } : { claimIds: [1, 2], highlightId: 1 };
      assert.equal(validate(value as T), null); return value as T;
    },
  } };
  return { root, session, prompts, models, fail: (value: boolean) => { failSecond = value; }, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('insufficient evidence is typed, exact and returned before any worker or inference starts', async () => {
  const f = fixture(); try {
    const result = await draftEvidenceNewsletter(stories, { radar: [], signals: [] }, { min: 300, max: 450 }, f.session);
    assert.equal(result.status, 'needs-evidence');
    if (result.status !== 'needs-evidence') throw new Error('expected research request');
    assert.equal(result.availableWords, 32); assert.equal(result.minimumAdditionalWords, 268);
    assert.equal(result.nextResearch.task, 'enrich-verified-evidence'); assert.deepEqual(result.nextResearch.sourceUrls, stories.map(story => story.primaryUrl));
    assert.equal(f.prompts.length, 0);
    const shorter = inspectEvidenceBudget(stories, { min: 10, max: 20 });
    assert.equal(shorter.status, 'needs-evidence'); if (shorter.status === 'needs-evidence') assert.equal(shorter.nextResearch.task, 'verify-independent-evidence-units');
  } finally { f.close(); }
});

test('distinct local research and writer tasks preserve every full claim, exact sources and topic isolation', async () => {
  const f = fixture(); try {
    const result = await draftEvidenceNewsletter(stories, { radar: [], signals: [] }, { min: 30, max: 40 }, f.session);
    assert.equal(result.status, 'ready'); if (result.status !== 'ready') throw new Error('expected complete issue');
    assert.equal(result.issue.lead.body, stories[0]!.verifiedClaims.join(' '));
    assert.equal(result.issue.items[0]!.line, stories[1]!.verifiedClaims.join(' '));
    assert.equal(result.issue.lead.sourceUrl, stories[0]!.primaryUrl); assert.equal(result.issue.items[0]!.url, stories[1]!.primaryUrl);
    assert.deepEqual(f.models, ['research:3b', 'writer:7b', 'research:3b', 'writer:7b']);
    for (const prompt of f.prompts.slice(0, 2)) assert.ok(!prompt.includes('Router') && !prompt.includes('router.example'));
    for (const prompt of f.prompts.slice(2)) assert.ok(!prompt.includes('Council') && !prompt.includes('council.example'));
    const again = await draftEvidenceNewsletter(stories, { radar: [], signals: [] }, { min: 30, max: 40 }, f.session);
    assert.deepEqual(again, result); assert.equal(f.prompts.length, 4);
  } finally { f.close(); }
});

test('a failed later topic resumes without rewriting earlier topics; changed provenance requires fresh work', async () => {
  const f = fixture(); try {
    f.fail(true);
    await assert.rejects(draftEvidenceNewsletter(stories, { radar: [], signals: [] }, { min: 30, max: 40 }, f.session), /second topic interrupted/);
    assert.equal(f.prompts.length, 3);
    f.fail(false);
    await draftEvidenceNewsletter(stories, { radar: [], signals: [] }, { min: 30, max: 40 }, f.session); assert.equal(f.prompts.length, 5);
    await selectEvidenceTopic({ ...stories[0]!, claimEvidence: [{ ...stories[0]!.claimEvidence[0]!, sha256: 'c'.repeat(64) }] }, 0, f.session); assert.equal(f.prompts.length, 7);
  } finally { f.close(); }
});

test('dropping a separate caveat, invented IDs, shortened highlights and free prose cannot pass the exact selector', async () => {
  for (const value of [{ claimIds: [1], highlightId: 1 }, { claimIds: [1, 3], highlightId: 1 }, { claimIds: [2, 1], highlightId: null }, { claimIds: [1, 2], highlightId: 2 }, { claimIds: [1, 2], highlightId: 1, text: 'An invented benefit.' }]) {
    const f = fixture(); try {
      delete f.session.policy.roles!.research;
      f.session.adapters.invoke = async request => {
        request.hooks.beforeAttempt!({ provider: 'ollama', model: 'writer:7b', baseUrl: 'http://127.0.0.1:11434/v1', attempt: 1, rescue: false, promptBytes: Buffer.byteLength(request.prompt) });
        return value as any;
      };
      await assert.rejects(selectEvidenceTopic(stories[0]!, 0, f.session), /claim ID|highlightId|whole topic packet/);
    } finally { f.close(); }
  }
});

test('missing source verification and oversized or incomplete claims never fall back to summary text', () => {
  for (const changed of [
    { verifiedClaims: undefined }, { claimEvidence: [] }, { verifiedClaims: ['A source claim without its ending'] },
    { verifiedClaims: ['A'.repeat(1501) + '.'] }, { verifiedClaims: [stories[0]!.verifiedClaims[0]!, stories[0]!.verifiedClaims[0]!] },
  ]) assert.throws(() => evidencePacket({ ...stories[0]!, ...changed } as EvidenceStory), /verification needed/);
});

test('source-account script keeps every source fact, uses the selected title, and requires explicit assembly permission', async () => {
  const f = fixture(); try {
    const topic: Topic = { id: 'package-1', kind: 'roundup', headline: 'Two source accounts', angle: '', primaryUrl: stories[0]!.primaryUrl, sourceItems: [], repo: null, alternates: [], stories: stories.map((story, i) => ({ ...story, n: i + 1, summary: 'Unverified summary must not appear.', assetRef: `og-${i}`, suggestedScene: 'news_card', principalEntity: 'Fixture', area: 'news', verticals: [], repo: null })) };
    const result = await draftEvidenceScript(topic, { min: 40, max: 50 }, f.session);
    assert.equal(result.status, 'ready'); if (result.status !== 'ready') throw new Error('expected script');
    assert.equal(result.script.body[0]!.voiceover, evidencePacket(stories[0]!));
    assert.equal(result.script.body[0]!.onScreen.title, stories[0]!.headline);
    assert.equal(result.script.body[0]!.motion, undefined);
    assert.ok(!result.script.fullVoiceoverText.includes('Unverified summary'));
    assert.equal(scriptProblem(result.script, topic, { min: 40, max: 50 }, true, true), null);
    assert.match(scriptProblem(result.script, topic, { min: 40, max: 50 }, true)!, /source.account|mechanism|evidence/i);
  } finally { f.close(); }
});

test('explicit task check saves only current ID-selection qualification and invalidates a failed retest', async () => {
  const f = fixture(); try {
    atomicJson(join(f.root, 'config/model.json'), f.session.primary);
    const expected = (await f.session.adapters.inspect({ provider: 'ollama', label: 'fixture', model: 'writer:7b', baseUrl: 'http://127.0.0.1:11434/v1', contextTokens: 8192, timeoutMs: 90000 })).identity;
    f.session.adapters.invoke = async <T>(request: any, validate: (value: T) => string | null) => {
      request.hooks.beforeAttempt({ provider: 'ollama', model: 'writer:7b', baseUrl: 'http://127.0.0.1:11434/v1', attempt: 1, rescue: false, promptBytes: Buffer.byteLength(request.prompt) });
      const claims = JSON.parse(request.prompt.split('PINNED_CLAIMS: ')[1]!);
      const value = { claimIds: claims.map((row: { id: number }) => row.id), highlightId: null };
      assert.equal(validate(value as T), null); return value as T;
    };
    const result = await qualifyEvidenceRole(f.root, 'writer', f.session.policy.roles!.writer!, expected, f.session.adapters, { hostRoot: f.root });
    assert.equal(result.passed, true); assert.equal(result.evidence.length, 2); assert.match(result.scope, /not prose/);
    assert.equal(roleQualificationStatus(f.root, expected, 'writer', 'claim-id-selection', EVIDENCE_SELECTION_CONTRACT).qualified, true);
    assert.equal(roleQualificationStatus(f.root, expected, 'critic', 'factual-critique', EVIDENCE_SELECTION_CONTRACT).qualified, false);
    const statePath = join(f.root, 'state/model-role-qualification.json');
    for (const malformed of [
      { ...result, passed: 'true' }, { ...result, checkedAt: new Date(Date.now() + 60000).toISOString() },
      { ...result, qualificationProtocol: undefined }, { ...result, evidence: ['made-up receipt', result.evidence[1]] },
      { ...result, evidence: [result.evidence[0], result.evidence[0]] },
    ]) {
      atomicJson(statePath, [malformed]);
      assert.equal(roleQualificationStatus(f.root, expected, 'writer', 'claim-id-selection', EVIDENCE_SELECTION_CONTRACT).qualified, false);
    }
    atomicJson(statePath, [result]);
    const receiptPath = result.evidence[0]!, receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    for (const malformed of [{ ...receipt, status: 'failed' }, { ...receipt, valueHash: '0'.repeat(64) }, { ...receipt, contractHash: roleHash('old contract') }, { ...receipt, model: { ...receipt.model, digest: 'c'.repeat(64) } }]) {
      atomicJson(receiptPath, malformed);
      assert.equal(roleQualificationStatus(f.root, expected, 'writer', 'claim-id-selection', EVIDENCE_SELECTION_CONTRACT).qualified, false);
    }
    atomicJson(receiptPath, receipt);
    const changed = { ...f.session.adapters, inspect: async (...args: Parameters<typeof f.session.adapters.inspect>) => { const value = await f.session.adapters.inspect(...args); return { ...value, identity: { ...value.identity, digest: 'c'.repeat(64) } }; } };
    const failed = await qualifyEvidenceRole(f.root, 'writer', f.session.policy.roles!.writer!, expected, changed, { hostRoot: f.root });
    assert.equal(failed.passed, false); assert.match(failed.error!, /changed/);
    assert.equal(roleQualificationStatus(f.root, expected, 'writer', 'claim-id-selection', EVIDENCE_SELECTION_CONTRACT).qualified, false);
  } finally { f.close(); }
});

test('one indivisible packet cannot silently satisfy incompatible video and newsletter lengths', () => {
  const sentence = (prefix: string, length: number) => Array.from({ length }, (_, i) => `${prefix}${i}`).join(' ') + '.';
  const newsletterPacket = [{ ...stories[0]!, verifiedClaims: [sentence('First', 120), sentence('Second', 120), sentence('Third', 125)] }];
  assert.equal(inspectEvidenceBudget(newsletterPacket, { min: 300, max: 450 }).status, 'ready');
  const video = inspectEvidenceBudget(newsletterPacket, { min: 180, max: 225 }, 15);
  assert.equal(video.status, 'needs-evidence');
  if (video.status === 'needs-evidence') {
    assert.equal(video.availableWords, 380); assert.equal(video.nextResearch.task, 'verify-independent-evidence-units');
  }
  const videoPacket = [{ ...stories[0]!, verifiedClaims: [sentence('First', 100), sentence('Second', 100)] }];
  assert.equal(inspectEvidenceBudget(videoPacket, { min: 180, max: 225 }, 15).status, 'ready');
  const newsletter = inspectEvidenceBudget(videoPacket, { min: 300, max: 450 });
  assert.equal(newsletter.status, 'needs-evidence');
  if (newsletter.status === 'needs-evidence') assert.equal(newsletter.minimumAdditionalWords, 100);
});
