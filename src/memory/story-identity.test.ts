import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  canonicalStoryUrl, compareStoryEvents, identifyStoryEvent, storyEventFromTopicStory,
  storyEventHash, validateStoryEventPacket, type StoryEventPacket, type SupportedStoryValue,
} from './story-identity.js';
import type { DraftCall } from '../pipeline/script.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sourceHash = hash('Complete fictional release source.');
const review = { method: 'human-verified' as const, reference: 'fictional-test-review-1' };
function value(packet: StoryEventPacket, word: string, claimId = 1): SupportedStoryValue {
  return { value: word, support: [{ sourceHash: packet.revisions[0]!.sha256!, claimId, quote: packet.claims[claimId - 1]! }] };
}
function event(options: { entity?: string; action?: string; object?: string; day?: string; url?: string } = {}): StoryEventPacket {
  const { entity = 'Harbor Lab', action = 'released', object = 'Atlas', day = '2026-09-14', url = 'https://example.com/atlas' } = options;
  const packet: StoryEventPacket = {
    version: 1, primaryUrl: url,
    claims: [`${entity} ${action} ${object} on ${day}.`, 'The release was evaluated in simulations only.'],
    revisions: [{ url, role: 'primary', status: 200, sha256: sourceHash, textSha256: hash('Complete source readable text.'),
      observedAt: '2026-09-15T01:02:03.000Z', publishedAt: '2026-09-14T01:00:00.000Z',
      restrictions: [{ sourceSentenceId: 7, text: 'Physical deployment has not been evaluated.' }] }],
  };
  packet.identity = { entity: value(packet, entity), action: value(packet, action), object: value(packet, object), eventDate: value(packet, day), review };
  validateStoryEventPacket(packet);
  return packet;
}
const stripIdentity = (packet: StoryEventPacket): StoryEventPacket => { const next = structuredClone(packet); delete next.identity; delete next.development; return next; };

test('URL canonicalization strips only known tracking and preserves meaningful versions, dates and fragments', () => {
  assert.equal(canonicalStoryUrl('https://Example.com/release?v=2&date=2026-09-14&utm_source=x#version-2'), 'https://example.com/release?v=2&date=2026-09-14#version-2');
  assert.notEqual(canonicalStoryUrl('https://example.com/release?v=1'), canonicalStoryUrl('https://example.com/release?v=2'));
  assert.match(canonicalStoryUrl('https://example.com/?utm_custom=important'), /utm_custom=important/);
  assert.throws(() => canonicalStoryUrl('https://user:password@example.com/'), /credentials/);
});

test('a title, shared URL, repository or AI buzzword alone never establishes duplicate identity', () => {
  const minimal: StoryEventPacket = { version: 1, primaryUrl: 'https://example.com/AI-agents', claims: [], revisions: [] };
  validateStoryEventPacket(minimal);
  assert.equal(compareStoryEvents(minimal, minimal).decision, 'uncertain');
  assert.equal(compareStoryEvents(stripIdentity(event()), stripIdentity(event())).decision, 'uncertain');
});

test('different supported actions by one company and unrelated AI-agent events remain eligible', () => {
  assert.equal(compareStoryEvents(event({ action: 'acquired', object: 'Harbor Robotics' }), event()).decision, 'different_event');
  assert.equal(compareStoryEvents(event({ entity: 'Cedar Lab', object: 'AI agents' }), event({ entity: 'Harbor Lab', object: 'AI agents' })).decision, 'different_event');
});

test('the same teams playing on different event dates are different events', () => {
  assert.equal(compareStoryEvents(event({ entity: 'Harbor and Cedar', action: 'played', object: 'a match', day: '2026-09-15' }),
    event({ entity: 'Harbor and Cedar', action: 'played', object: 'a match' })).decision, 'different_event');
});

test('exact complete supported facts and event fields can identify the same event across sources', () => {
  const old = event(), next = event({ url: 'https://second.example.com/report' });
  next.revisions[0]!.sha256 = hash('Different complete outlet capture.');
  for (const field of ['entity', 'action', 'object', 'eventDate'] as const) next.identity![field]!.support[0]!.sourceHash = next.revisions[0]!.sha256!;
  const result = compareStoryEvents(next, old);
  assert.equal(result.decision, 'same_event');
  assert.match(result.reason, /Published coverage must still be verified/);
  assert.equal(result.evidence.length, 2);
  assert.notEqual(result.currentHash, result.previousHash);
});

test('changed whole facts or late source restrictions remain uncertain rather than duplicate', () => {
  const old = event(), next = event();
  next.claims.push('A physical evaluation is planned.');
  assert.equal(compareStoryEvents(next, old).decision, 'uncertain');
  const restriction = event();
  restriction.revisions[0]!.restrictions!.push({ sourceSentenceId: 10, text: 'The device requires a trained operator.' });
  assert.equal(compareStoryEvents(restriction, old).decision, 'uncertain');
});

test('changed content at one URL cannot be hidden by an unchanged selected fact packet', () => {
  const old = event(), next = event();
  next.revisions[0]!.textSha256 = hash('Changed complete source contains an unselected material update.');
  assert.equal(compareStoryEvents(next, old).decision, 'uncertain');
  const reobserved = event(); reobserved.revisions[0]!.observedAt = '2026-09-16T01:02:03.000Z';
  assert.equal(compareStoryEvents(reobserved, old).decision, 'same_event');
});

test('a supported material correction at the same URL links and preserves both revisions', () => {
  const old = event(), next = event();
  next.claims.push('Harbor Lab corrected the 2026-09-14 result after a physical evaluation.');
  next.revisions[0]!.sha256 = hash('New source revision with correction.');
  next.revisions[0]!.textSha256 = hash('New readable source revision with correction.');
  for (const field of ['entity', 'action', 'object', 'eventDate'] as const) next.identity![field]!.support[0]!.sourceHash = next.revisions[0]!.sha256!;
  next.development = { kind: 'correction', previousPacketHash: storyEventHash(old), statement: value(next, next.claims[2]!, 3), review };
  const result = compareStoryEvents(next, old);
  assert.equal(result.decision, 'new_development');
  assert.ok(result.evidence[0]!.refs.some(ref => ref.claimId === 3));
  next.development.previousPacketHash = hash('Unrelated record');
  assert.equal(compareStoryEvents(next, old).decision, 'uncertain');
});

test('a shared repository with only cosmetic text changes does not prove a new development', () => {
  const old = event({ url: 'https://github.com/example/atlas' }), next = structuredClone(old);
  next.claims.push('The README corrected a spelling mistake.');
  assert.equal(compareStoryEvents(next, old).decision, 'uncertain');
});

test('a stable explicit event ID with conflicting dates cannot settle identity', () => {
  const old = event(), next = event({ day: '2026-09-15' });
  for (const packet of [old, next]) { packet.claims.push('The event identifier is H-101.'); packet.identity!.eventId = value(packet, 'H-101', 3); }
  assert.equal(compareStoryEvents(next, old).decision, 'uncertain');
});

test('unavailable captures and missing complete readable-source hashes cannot establish duplication', () => {
  const old = event(), next = event();
  delete next.revisions[0]!.textSha256;
  assert.equal(compareStoryEvents(next, old).decision, 'uncertain');
  const unavailable = stripIdentity(old); unavailable.revisions[0]!.status = 503;
  assert.equal(compareStoryEvents(unavailable, old).decision, 'uncertain');
});

test('field validation rejects unsupported dates, bad IDs, invented quotes and model confidence', () => {
  const original = event();
  for (const mutate of [
    (p: StoryEventPacket) => { p.identity!.eventDate!.value = '2026-09-15'; },
    (p: StoryEventPacket) => { p.identity!.action.support[0]!.claimId = 30; },
    (p: StoryEventPacket) => { p.identity!.object.support[0]!.quote = 'Invented evidence'; },
    (p: StoryEventPacket) => { (p.identity as unknown as Record<string, unknown>).confidence = 0.99; },
    (p: StoryEventPacket) => { p.identity!.entity.support[0]!.sourceHash = hash('Uncaptured revision'); },
    (p: StoryEventPacket) => { (p.revisions[0] as unknown as Record<string, unknown>).role = ['primary']; },
    (p: StoryEventPacket) => { (p.identity!.review as unknown as Record<string, unknown>).method = ['human-verified']; },
  ]) { const packet = structuredClone(original); mutate(packet); assert.throws(() => validateStoryEventPacket(packet)); }
  const badDate = stripIdentity(original); badDate.revisions[0]!.publishedAt = '2026-02-30'; assert.throws(() => validateStoryEventPacket(badDate), /source date/);
});

test('TopicStory adapter never invents identity and discards saved annotations when complete evidence changes', () => {
  const packet = event();
  const story = { primaryUrl: packet.primaryUrl, verifiedClaims: packet.claims, claimEvidence: packet.revisions, storyEvent: packet };
  const saved = storyEventFromTopicStory(story);
  assert.deepEqual(saved, packet); assert.notEqual(saved, packet);
  assert.equal(storyEventFromTopicStory({ ...story, storyEvent: undefined }).identity, undefined);
  assert.equal(storyEventFromTopicStory({ ...story, verifiedClaims: [...packet.claims, 'A new result is pending.'] }).identity, undefined);
  const revisions = structuredClone(packet.revisions); revisions[0]!.restrictions!.push({ sourceSentenceId: 9, text: 'A newer timestamp is required.' });
  const changed = storyEventFromTopicStory({ ...story, claimEvidence: revisions });
  assert.equal(changed.identity, undefined); assert.equal(changed.revisions[0]!.restrictions!.length, 2);
  assert.notEqual(storyEventHash(changed), storyEventHash(packet));
});

test('event hash binds source date, full claims, restrictions and review identity', () => {
  const packet = event();
  for (const mutate of [
    (p: StoryEventPacket) => { p.revisions[0]!.publishedAt = '2026-09-13'; },
    (p: StoryEventPacket) => { p.revisions[0]!.restrictions![0]!.text = 'New restriction.'; },
    (p: StoryEventPacket) => { p.identity!.review.reference = 'review-2'; },
  ]) { const changed = structuredClone(packet); mutate(changed); assert.notEqual(storyEventHash(changed), storyEventHash(packet)); }
});

test('fresh identity extraction and independent review preserve complete context under two typed tasks', async () => {
  const complete = event(), input = stripIdentity(complete), seen: { prompt: string; role?: string; taskId?: string; evidenceHash?: string; candidateHash?: string }[] = [];
  const extracted = structuredClone(complete.identity!); delete (extracted as Partial<typeof extracted>).review;
  const call: DraftCall = async (prompt, validate, task) => {
    seen.push({ prompt, role: task?.role, taskId: task?.taskId, evidenceHash: task?.evidenceHash, candidateHash: task?.candidateHash });
    const result = seen.length === 1 ? extracted : { accepted: true, fields: Object.keys(extracted).map(field => ({ field, accepted: true })), reason: 'The complete source supports each classified field, including event date.' };
    assert.equal(validate(result as never), null); return result as never;
  };
  const result = await identifyStoryEvent(input, call, { topicId: 'topic-1', modelIdentity: 'configured-critic-endpoint-and-model-v1' });
  assert.equal(result.status, 'reviewed'); assert.equal(seen.length, 2);
  assert.ok(seen.every(item => item.role === 'source-review' && item.prompt.includes('Physical deployment has not been evaluated.') && item.prompt.includes(input.claims[1]!)));
  assert.notEqual(seen[0]!.taskId, seen[1]!.taskId); assert.equal(seen[0]!.evidenceHash, seen[1]!.evidenceHash); assert.ok(seen[1]!.candidateHash);
  assert.equal(result.packet.identity!.review.method, 'model-reviewed'); assert.equal(input.identity, undefined);
  assert.match(result.reason, /fallible/);
});

test('independent review cannot skip a field or accept one rejected classification', async () => {
  const full = event(), input = stripIdentity(full), extracted = structuredClone(full.identity!); delete (extracted as Partial<typeof extracted>).review;
  for (const badFields of [
    [{ field: 'entity', accepted: true }],
    Object.keys(extracted).map(field => ({ field, accepted: field !== 'action' })),
    Object.keys(extracted).map(() => ({ field: 'entity', accepted: true })),
  ]) {
    let calls = 0;
    const call: DraftCall = async () => (++calls === 1 ? extracted : { accepted: true, fields: badFields, reason: 'Supported.' }) as never;
    const result = await identifyStoryEvent(input, call, { topicId: 'topic-1', modelIdentity: 'fixture-model' });
    assert.equal(result.status, 'uncertain'); assert.equal(result.packet.identity, undefined); assert.equal(calls, 2);
  }
});

test('a source-unsupported first response cannot bypass the validator in an unchecked caller', async () => {
  const full = event(), input = stripIdentity(full), extracted = structuredClone(full.identity!); delete (extracted as Partial<typeof extracted>).review;
  extracted.action.value = 'deployed';
  let calls = 0;
  const result = await identifyStoryEvent(input, (async () => { calls++; return extracted; }) as DraftCall, { topicId: 'topic-1', modelIdentity: 'fixture-model' });
  assert.equal(result.status, 'uncertain'); assert.equal(calls, 1); assert.equal(result.packet.identity, undefined);
});

test('complete large evidence cannot be clipped for a smaller model and causes zero model calls', async () => {
  const packet = stripIdentity(event()); packet.claims.push('Complete supporting context '.repeat(170)); packet.claims.push('Complete condition context '.repeat(170)); packet.claims.push('Complete result context '.repeat(170)); packet.claims.push('Complete release context '.repeat(170));
  let calls = 0;
  const result = await identifyStoryEvent(packet, (async () => { calls++; throw new Error('Unexpected inference'); }) as DraftCall, { topicId: 'topic-1', modelIdentity: 'fixture-model' });
  assert.equal(result.status, 'uncertain'); assert.equal(calls, 0); assert.deepEqual(result.packet.claims, packet.claims); assert.match(result.reason, /no evidence was clipped/);
});

test('null extraction or original parent-budget rejection leaves identity uncertain without a new budget', async () => {
  const input = stripIdentity(event()); let calls = 0;
  for (const response of [null, new Error('Parent model budget exhausted')]) {
    const result = await identifyStoryEvent(input, (async () => { calls++; if (response instanceof Error) throw response; return response; }) as DraftCall, { topicId: 'topic-1', modelIdentity: 'fixture-model' });
    assert.equal(result.status, 'uncertain'); assert.equal(result.packet.identity, undefined);
  }
  assert.equal(calls, 2);
});
