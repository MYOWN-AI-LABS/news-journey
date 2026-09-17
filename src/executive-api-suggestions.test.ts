import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_ROOT, atomicJson } from './workspaces.js';
import { executiveState } from './executive-actions.js';
import { setupApiSources } from './sources/api-setup.js';

test('Journey suggestions belong to the saved topic and expose setup requirements without endpoints or keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-api-view-'));
  try {
    cpSync(join(CODE_ROOT, 'config'), join(root, 'config'), { recursive: true });
    for (const name of ['state', 'workdir/videos', 'workdir/newsletters']) mkdirSync(join(root, name), { recursive: true });
    atomicJson(join(root, 'config/sources.json'), { enabledSources: [], editorial: { preferredTopics: ['Sports news'] } });
    const entry = { name: 'Football scores', description: 'Football results and scores', category: 'Sports & Fitness', auth: 'apiKey', https: 'Yes', cors: 'Unknown', documentationUrl: 'https://example.org/football' };
    atomicJson(join(root, 'state/source-discovery.json'), { checkedAt: '2026-09-15T12:00:00Z', topics: ['Sports news'], areas: [], choices: [entry] });
    const sports = executiveState(root, 'owner');
    assert.equal(sports.sourceChoices[0].connection, 'needs-key');
    assert.equal(sports.sourceChoices[0].reason, 'Matches sports');
    assert.equal(sports.sourceChoices[0].documentationUrl, entry.documentationUrl);
    assert.equal('endpoint' in sports.sourceChoices[0], false);
    atomicJson(join(root, 'config/sources.json'), { enabledSources: [], editorial: { preferredTopics: ['Clinical research'] } });
    const changed = executiveState(root, 'owner');
    assert.equal(changed.sourceDiscovery.stale, true);
    assert.deepEqual(changed.sourceChoices, [], 'the old sports catalog is hidden immediately after a topic change');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changed topics require an explicit managed API update without discovery connecting or overwriting operator edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-api-update-'));
  try {
    cpSync(join(CODE_ROOT, 'config'), join(root, 'config'), { recursive: true });
    for (const name of ['state', 'workdir/videos', 'workdir/newsletters']) mkdirSync(join(root, name), { recursive: true });
    const file = join(root, 'config/sources.json');
    atomicJson(file, { enabledSources: [], editorial: { preferredTopics: ['clinical research'] } });
    const entries = [{ name: 'Crossref Metadata Search', description: 'Scholarly research metadata', category: 'Books', auth: 'No', https: 'Yes', cors: 'Unknown', documentationUrl: 'https://www.crossref.org/documentation/' }];
    let requests = 0;
    const request = async () => {
      requests++;
      return new Response(JSON.stringify({ message: { items: [{ title: ['Fixture study'], URL: 'https://doi.org/10.1234/example' }] } }));
    };
    await setupApiSources(root, { automatic: true, entries, request });
    const prior = JSON.parse(readFileSync(file, 'utf8'));
    prior.editorial.preferredTopics = ['robotics research'];
    atomicJson(file, prior);
    const beforeDiscovery = readFileSync(file, 'utf8');

    await setupApiSources(root, { automatic: true, refresh: true, select: [], entries, request });
    assert.equal(requests, 1, 'discovery must not fetch a provider endpoint');
    assert.equal(readFileSync(file, 'utf8'), beforeDiscovery, 'discovery must preserve the saved connection');
    const stale = executiveState(root, 'owner').sourceChoices.find(c => c.id === 'crossref')!;
    assert.equal(stale.needsUpdate, true);
    assert.equal(stale.connected, false, 'an old topic query cannot be presented as a current connection');
    assert.equal(stale.ready, true);
    assert.equal(readFileSync(file, 'utf8'), beforeDiscovery, 'viewing suggestions must not change the endpoint');

    await setupApiSources(root, { automatic: true, refresh: true, select: ['crossref'], entries, request });
    assert.equal(requests, 2, 'only explicit update checks the replacement connection');
    const updated = JSON.parse(readFileSync(file, 'utf8'));
    assert.match(updated.publicApis.endpoints[0].url, /robotics%20research/);
    const connected = executiveState(root, 'owner').sourceChoices.find(c => c.id === 'crossref')!;
    assert.equal(connected.connected, true);
    assert.equal(connected.needsUpdate, false);

    updated.publicApis.endpoints[0].maxItems = 3;
    updated.editorial.preferredTopics = ['quantum research'];
    atomicJson(file, updated);
    const operatorSettings = readFileSync(file, 'utf8');
    await setupApiSources(root, { automatic: true, refresh: true, select: [], entries, request });
    const manual = executiveState(root, 'owner').sourceChoices.find(c => c.id === 'crossref')!;
    assert.equal(manual.connected, true, 'operator-controlled mappings remain connected');
    assert.equal(manual.needsUpdate, false, 'do not offer automatic replacement of an operator mapping');
    assert.equal(readFileSync(file, 'utf8'), operatorSettings);
    assert.equal(requests, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('topic filtering preserves a connected custom mapping identity without exposing its endpoint or credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-api-custom-'));
  try {
    cpSync(join(CODE_ROOT, 'config'), join(root, 'config'), { recursive: true });
    for (const name of ['state', 'workdir/videos', 'workdir/newsletters']) mkdirSync(join(root, name), { recursive: true });
    const endpoint = { id: 'custom-sports-feed', name: 'Sports feed', url: 'https://example.org/api/sports', headerEnv: { Authorization: 'SPORTS_API_KEY' }, fields: { title: 'title', url: 'url' } };
    const source = { enabledSources: ['publicApis'], editorial: { preferredTopics: ['Sports news'] }, publicApis: { endpoints: [endpoint] } };
    atomicJson(join(root, 'config/sources.json'), source);
    const custom = { ...endpoint, description: 'Connected through guided JSON setup', category: 'Custom sources', auth: 'apiKey', https: 'Yes', cors: 'Unknown', documentationUrl: endpoint.url, endpoint, connection: 'ready', reason: 'Selected by you' };
    atomicJson(join(root, 'state/source-discovery.json'), { checkedAt: '2026-09-15T12:00:00Z', topics: ['Sports news'], areas: [], choices: [custom] });
    const choice = executiveState(root, 'owner').sourceChoices[0];
    assert.equal(choice.id, endpoint.id);
    assert.equal(choice.connected, true);
    assert.equal(choice.ready, true);
    assert.equal(choice.connection, 'ready');
    assert.equal(choice.needsUpdate, false);
    assert.equal('endpoint' in choice, false);
    assert.equal('headerEnv' in choice, false);
    assert.equal(JSON.stringify(choice).includes('SPORTS_API_KEY'), false);

    source.enabledSources = [];
    atomicJson(join(root, 'config/sources.json'), source);
    const disabled = executiveState(root, 'owner').sourceChoices[0];
    assert.equal(disabled.id, endpoint.id);
    assert.equal(disabled.disabled, true, 'a disabled custom mapping needs source-type re-enabling, not catalog reconnection');
    assert.equal(disabled.connected, false);

    source.enabledSources = ['publicApis'];
    source.publicApis.endpoints = [];
    atomicJson(join(root, 'config/sources.json'), source);
    const removed = executiveState(root, 'owner').sourceChoices[0];
    assert.equal(removed.connected, false, 'a stale report cannot claim a deleted custom mapping is connected');
    assert.equal(removed.ready, false);

    source.publicApis.endpoints = [endpoint];
    source.editorial.preferredTopics = ['Clinical research'];
    atomicJson(join(root, 'config/sources.json'), source);
    assert.deepEqual(executiveState(root, 'owner').sourceChoices, [], 'a connected custom mapping does not bypass the stale-topic filter');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
