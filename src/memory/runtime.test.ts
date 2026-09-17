import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TopicStory } from '../types.js';
import { canonicalStoryUrl, checkStoryCoverage, confirmStoryPublication, markStorySubmission, reserveStoryPublication, storedStory, withPublicationMemory } from './runtime.js';
import { recordWorkingMemory } from './context.js';
import { storyEventFromTopicStory } from './story-identity.js';
import { approvedPublicationStories, confirmPublicationMemory } from './publication.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function story(date = '2026-09-12', version = 'v1'): TopicStory {
  const claim = `Orion released Atlas ${version} on ${date}.`;
  const sourceHash = sha(claim);
  const row: TopicStory = { n: 1, headline: `Atlas ${version} release`, summary: claim, weight: 'lead', primaryUrl: `https://example.org/atlas`, repo: null, assetRef: 'og-0', suggestedScene: 'news_card', principalEntity: 'Orion', area: 'general', verticals: ['general'], verifiedClaims: [claim], claimEvidence: [{ url: 'https://example.org/atlas', role: 'primary', status: 200, sha256: sourceHash, textSha256: sourceHash, observedAt: '2026-09-14T10:00:00Z', publishedAt: date }] };
  const packet = storyEventFromTopicStory(row);
  const supported = (value: string) => ({ value, support: [{ sourceHash, claimId: 1, quote: claim }] });
  packet.identity = { entity: supported('Orion'), action: supported('released'), object: supported('Atlas'), version: supported(version), eventDate: supported(date), review: { method: 'human-verified', reference: 'synthetic regression fixture' } };
  row.storyEvent = packet;
  return row;
}

test('only confirmed published events suppress; new releases, changed sources and other publications remain eligible', async () => {
  const root = mkdtempSync(join(tmpdir(), 'publication-memory-'));
  try {
    const old = story();
    await reserveStoryPublication([old], 'old-run', root);
    assert.equal((await checkStoryCoverage([old], 'new-run', 30, root))[0]!.decision, 'uncertain');
    await markStorySubmission([old], 'old-run', root);
    // Ambiguous delivery remains unconfirmed; it is not falsely described as prior publication.
    assert.equal((await checkStoryCoverage([old], 'new-run', 30, root))[0]!.decision, 'uncertain');
    await confirmStoryPublication([old], 'old-run', { provider: 'fixture', remoteId: 'verified-1', url: 'https://example.org/published/1', confirmedAt: Date.now() }, root);
    assert.equal((await checkStoryCoverage([old], 'new-run', 30, root))[0]!.decision, 'same_event');
    // A title rewrite cannot hide the same supported event.
    assert.equal((await checkStoryCoverage([{ ...old, headline: 'A differently worded headline' }], 'new-run', 30, root))[0]!.decision, 'same_event');
    assert.notEqual((await checkStoryCoverage([story('2026-09-14', 'v2')], 'new-run', 30, root))[0]!.decision, 'same_event');
    const changed = structuredClone(old); changed.claimEvidence![0]!.textSha256 = sha('Updated source bytes');
    assert.notEqual((await checkStoryCoverage([changed], 'new-run', 30, root))[0]!.decision, 'same_event');
    mkdirSync(join(root, 'config'), { recursive: true }); writeFileSync(join(root, 'config/memory.json'), JSON.stringify({ publicationId: 'other-publication' }));
    assert.equal((await checkStoryCoverage([old], 'new-run', 30, root))[0]!.decision, 'uncertain');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retry retains its original reservation and a changed package cannot inherit approval coverage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'publication-approval-'));
  try {
    const row = story(); await reserveStoryPublication([row], 'test-run', root);
    const first = await withPublicationMemory(store => store.coverage({ since: 0, limit: 20 }), root);
    await new Promise(resolve => setTimeout(resolve, 5));
    await reserveStoryPublication([row], 'test-run', root);
    assert.deepEqual(await withPublicationMemory(store => store.coverage({ since: 0, limit: 20 }), root), first);
    const dir = join(root, 'workdir/videos/test-run'); mkdirSync(dir, { recursive: true });
    const bytes = JSON.stringify({ id: 'test-run', stories: [row] });
    writeFileSync(join(dir, 'topic.json'), bytes);
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id: 'test-run', explicitApproval: { topicSha256: sha(bytes) } }));
    assert.equal(approvedPublicationStories('test-run', root).length, 1);
    writeFileSync(join(dir, 'topic.json'), bytes + ' ');
    await assert.rejects(confirmPublicationMemory('test-run', { provider: 'fixture', remoteId: 'verified', confirmedAt: Date.now() }, root), /changed approval/);
    const unchanged = await withPublicationMemory(store => store.coverage({ storyIds: [storedStory(row).id], since: 0, limit: 20 }), root);
    assert.equal(unchanged[0]!.status, 'reserved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('story URL lookup retains release versions, case-sensitive paths and meaningful query values', () => {
  assert.notEqual(canonicalStoryUrl('https://example.org/Release?v=1'), canonicalStoryUrl('https://example.org/Release?v=2'));
  assert.notEqual(canonicalStoryUrl('https://example.org/Release'), canonicalStoryUrl('https://example.org/release'));
  assert.equal(canonicalStoryUrl('https://example.org/Release?v=1&utm_source=mail'), 'https://example.org/Release?v=1');
});

test('a later batch conflict cancels only newly acquired pre-submit reservations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'publication-batch-'));
  try {
    const existing = story('2026-09-10', 'v1'), fresh = story('2026-09-11', 'v2'), blocked = story('2026-09-12', 'v3');
    await reserveStoryPublication([existing], 'current-run', root);
    await reserveStoryPublication([blocked], 'other-run', root);
    const before = await withPublicationMemory(store => store.coverage({ since: 0, limit: 20 }), root);
    await assert.rejects(reserveStoryPublication([existing, fresh, blocked], 'current-run', root), /different publication reservation/);
    const after = await withPublicationMemory(store => store.coverage({ since: 0, limit: 20 }), root);
    for (const record of before) assert.deepEqual(after.find(row => row.idempotencyKey === record.idempotencyKey), record);
    assert.equal(after.find(row => row.storyId === storedStory(fresh).id)?.status, 'cancelled');
    assert.equal(after.filter(row => row.status === 'submitted-unconfirmed').length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same run name cannot claim another packet reservation for the same event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'publication-exact-packet-'));
  try {
    const first = story(), recaptured = structuredClone(first);
    recaptured.claimEvidence![0]!.observedAt = '2026-09-14T11:00:00Z';
    recaptured.storyEvent = undefined;
    const packet = storyEventFromTopicStory(recaptured); packet.identity = first.storyEvent!.identity; recaptured.storyEvent = packet;
    assert.notEqual(storedStory(first).id, storedStory(recaptured).id);
    await reserveStoryPublication([first], 'same-run', root);
    await assert.rejects(reserveStoryPublication([recaptured], 'same-run', root), /different publication reservation/);
    assert.equal((await withPublicationMemory(store => store.coverage({ since: 0, limit: 10 }), root)).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('read-only delivery confirmation cannot invent a submission or covered marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'publication-confirm-existing-'));
  try {
    const candidate = story();
    await assert.rejects(confirmStoryPublication([candidate], 'never-submitted', { provider: 'fixture', remoteId: 'public-title-match', confirmedAt: Date.now() }, root), /no matching durable submission/);
    assert.deepEqual(await withPublicationMemory(store => store.coverage({ since: 0, limit: 10 }), root), []);
    await reserveStoryPublication([candidate], 'reserved-only', root);
    await assert.rejects(confirmStoryPublication([candidate], 'reserved-only', { provider: 'fixture', remoteId: 'title-only', confirmedAt: Date.now() }, root), /no matching durable submission/);
    assert.equal((await withPublicationMemory(store => store.coverage({ since: 0, limit: 10 }), root))[0]?.status, 'reserved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('maximum-length edition IDs retain full audit identity with bounded lookup tags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'publication-long-id-'));
  try {
    const runId = 'r'.repeat(160);
    await withPublicationMemory(store => recordWorkingMemory(store, runId, { parentIdentity: 'a'.repeat(64), topicHash: 'b'.repeat(64), memoryHash: 'c'.repeat(64), outputs: 'video', status: 'ready' }), root);
    assert.equal((await checkStoryCoverage([story()], runId, 30, root))[0]!.decision, 'uncertain');
    const working = await withPublicationMemory(store => store.recall({ kinds: ['working'], now: Date.now(), limit: 10, maxBytes: 10000 }), root);
    assert.equal(working.length, 1);
    assert.equal(JSON.parse(working[0]!.text).runId, runId);
    assert.ok(working[0]!.tags.every(tag => tag.length <= 100));
    await reserveStoryPublication([story()], runId, root);
    assert.equal((await withPublicationMemory(store => store.coverage({ since: 0, limit: 10 }), root))[0]!.runId, runId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('published coverage still validates every incoming confirmation before idempotent reuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'publication-confirm-validation-'));
  try {
    const candidate = story(), runId = 'confirmed-run';
    await markStorySubmission([candidate], runId, root);
    const receipt = { provider: 'fixture', remoteId: 'verified-post', url: 'https://example.org/posts/verified', confirmedAt: Date.now() };
    await confirmStoryPublication([candidate], runId, receipt, root);
    const before = await withPublicationMemory(store => store.coverage({ since: 0, limit: 10 }), root);
    for (const invalid of [
      { ...receipt, provider: '' },
      { ...receipt, url: 'file:///unverified-source' },
      { ...receipt, confirmedAt: Date.now() + 60_000 },
    ]) await assert.rejects(confirmStoryPublication([candidate], runId, invalid, root), /receipt provider|source URL|future/);
    assert.deepEqual(await withPublicationMemory(store => store.coverage({ since: 0, limit: 10 }), root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
