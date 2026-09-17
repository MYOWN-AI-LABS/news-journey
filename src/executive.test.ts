import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, delimiter } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { CODE_ROOT, atomicJson } from './workspaces.js';
import { createControlServer, workerAction } from './control.js';
import { completedPreview, companionNeedsRepair, quickPreviewRetryKey, quickTrustedSources, writerPolicy } from './executive-actions.js';
import { isDryRunLeftover, usageSummary } from './control-state.js';
import { captureAuthCode } from './auth/oauth-server.js';
import { vocabularyLabelProblem } from './pipeline/selection-policy.js';
import { countEvidenceWords } from './pipeline/evidence-allocation.js';

test('executive source choice treats automatic requests as discovery while preserving explicit sites', () => {
  const request = 'choose for me, through an algorithm which will pull top stories from internet. these need to have valid sources.';
  assert.deepEqual(quickTrustedSources({ trustedSources: request }), []);
  assert.deepEqual(quickTrustedSources({ sourceMode: 'auto', trustedSources: 'https://unused.example.org/feed' }), []);
  assert.deepEqual(quickTrustedSources({ sourceMode: 'manual', trustedSources: 'https://news.example.org/feed\nhttps://civic.example.org/news' }), ['https://news.example.org/feed','https://civic.example.org/news']);
  assert.deepEqual(quickTrustedSources({ trustedSources: 'City Housing Newsroom' }), ['City Housing Newsroom']);
  assert.deepEqual(quickTrustedSources({ trustedSources: 'choose for me https://news.example.org/feed' }), ['choose for me https://news.example.org/feed']);
  assert.throws(() => quickTrustedSources({ sourceMode: 'manual' }), /Add a website address/);
  // The Free package offers the four proven agent CLIs; local and API routes are listed but offered in Pro (Saaket, Sep 17).
  assert.deepEqual(writerPolicy('free'), { selectable: ['claude', 'codex', 'antigravity', 'grok'], pro: ['opencode', 'zai', 'gemini', 'ollama', 'bedrock', 'openai-compatible'] });
  assert.deepEqual(writerPolicy('development').pro, []);
  // A feed address pasted into the brief is a trusted source; an ordinary link mentioned in prose is not.
  assert.deepEqual(quickTrustedSources({ sourceMode: 'auto', description: 'Football news. Trusted feed: https://feeds.bbci.co.uk/sport/football/rss.xml (photos).' }), ['https://feeds.bbci.co.uk/sport/football/rss.xml']);
  assert.deepEqual(quickTrustedSources({ sourceMode: 'auto', description: 'Like https://www.competitor.example/newsletter but for football.' }), []);
  // Feed-shaped is a path segment or extension, not a substring; a plain site pasted with the trusted box empty goes to feed discovery.
  assert.deepEqual(quickTrustedSources({ sourceMode: 'auto', description: 'See https://example.com/feedback and https://theverge.example/anatomy-of-the-window!' }), []);
  assert.deepEqual(quickTrustedSources({ sourceMode: 'auto', description: 'Feed https://example.com/feed/ and https://example.org/atom.xml.' }), ['https://example.com/feed/', 'https://example.org/atom.xml']);
  assert.deepEqual(quickTrustedSources({ sourceMode: 'manual', description: 'Use https://www.bbc.com/sport/football.' }), ['https://www.bbc.com/sport/football']);
});

test('executive forms isolate workers, preserve secrets and route the saved writer', async () => {
  mkdirSync(join(CODE_ROOT, 'workspaces'), { recursive: true });
  const root = mkdtempSync(join(CODE_ROOT, 'workspaces/journey-check-'));
  const slug = basename(root), owner = 'a'.repeat(64), viewer = 'b'.repeat(64), editor = 'c'.repeat(64);
  cpSync(join(CODE_ROOT, 'config'), join(root, 'config'), { recursive: true });
  rmSync(join(root, 'config/personalization.json'), { force: true }); // a real save on this machine must not leak into the fixture
  atomicJson(join(root, 'config/pipeline.json'), { ...JSON.parse(readFileSync(join(root, 'config/pipeline.json'), 'utf8')), journeyReview: 'daily-signal-port' }); // this scenario asserts the ported editorial capture path
  for (const d of ['state', 'workdir/videos', 'workdir/newsletters', 'workdir/harvest']) mkdirSync(join(root, d), { recursive: true });
  atomicJson(join(root, 'workspace.json'), { id: slug, name: 'Test publication' });
  atomicJson(join(root, 'desks.json'), {});
  atomicJson(join(root, 'members.json'), [[owner, 'owner'], [viewer, 'viewer'], [editor, 'editor']].map(([token, role]) => ({ id: role, role, tokenHash: createHash('sha256').update(token).digest('hex') })));
  writeFileSync(join(root, '.env'), '# preserve Windows paths\nVIDEO_PATH="C:\\Users\\Example\\Videos"\n');
  const server = createControlServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  // Test issuer for Pro, set before the first worker spawn so the child inherits it.
  const { generateKeyPairSync, createPrivateKey, sign } = await import('node:crypto');
  const pair = generateKeyPairSync('ed25519'); process.env.HARNESS_PRO_ISSUER_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const action = (operation: string, data: Record<string, unknown>, token = owner) => workerAction(root, token, { action: 'journey', operation, data });
  try {
    const occupied = { editions: ['example-topic'], channels: ['youtube'], twoPersonRule: true };
    atomicJson(join(root, 'desks.json'), { editorial: occupied });
    await action('usage', { purpose: 'organization', organization: 'Example organization', collaboration: 'team', description: 'A weekly evidence briefing for leaders. ' + 'A longer single paragraph. '.repeat(70) });
    assert.match(JSON.parse(readFileSync(join(root, 'state/use-case.json'), 'utf8')).description, /weekly evidence/);
    // Personalize is a manage action: recommendations fill empty choices only, and an unqualified format is refused.
    // Everything personalized is Pro: the action refuses until a signed, workspace-bound key is pasted.
    await assert.rejects(action('personalize', { cadence: 'three-weekly' }), /part of Pro/);
    const proPayload = { version: 1, issuer: 'myownai-labs', subject: JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf8')).id, plan: 'pro', packs: ['executive-briefing'], issuedAt: Date.now() - 1000, expiresAt: Date.now() + 86400000 };
    await action('pro-activate', { license: JSON.stringify({ payload: proPayload, signature: sign(null, Buffer.from(JSON.stringify(proPayload)), createPrivateKey(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))).toString('base64') }) });
    assert.equal(existsSync(join(root, 'state/pro-entitlement.json')), true);
    await action('personalize', { cadence: 'three-weekly', applyRecommendations: true });
    const personalization = JSON.parse(readFileSync(join(root, 'config/personalization.json'), 'utf8'));
    assert.equal(personalization.cadence, 'three-weekly'); assert.equal(personalization.videoLength, 'standard'); assert.equal(personalization.format, 'narrator');
    await assert.rejects(action('personalize', { format: 'panel' }), /not available yet/);
    await assert.rejects(action('personalize', { cadence: 'weekly' }, viewer), /Forbidden/);
    await action('channels', { selected: ['youtube', 'linkedin'] });
    const destinations = JSON.parse(readFileSync(join(root, 'config/platforms.json'), 'utf8'));
    assert.equal(destinations.youtube.enabled, true); assert.equal(destinations.linkedin.enabled, true); assert.equal(destinations.x.enabled, false);
    await assert.rejects(action('channels', { selected: ['shell'] }), /supported channels/);
    await assert.rejects(action('channels', { selected: ['youtube'] }, viewer), /Forbidden/);
    await assert.rejects(action('media', { mode: 'cards', voiceProvider: 'voicebox' }), /Create your voice/);
    await assert.rejects(action('voicebox-create', {}, viewer), /Forbidden/);
    await action('media', { mode: 'cards', voiceProvider: 'voicebox', voiceProfile: 'My authorized voice' });
    assert.equal(JSON.parse(readFileSync(join(root, 'config/avatar.json'), 'utf8')).voicebox.profile, 'My authorized voice');
    const chosen = JSON.parse(readFileSync(join(root, 'desks.json'), 'utf8'));
    assert.deepEqual(chosen.editorial, occupied); assert.equal(chosen['editorial-2'].twoPersonRule, true);
    const fields = { publication: 'Executive Brief', audience: 'strategy leaders', name: 'Jordan Lee', tone: 'Clear', topics: 'evidence\nmarket research', areas: '', feeds: 'https://news.example.org/feed', publicApis: 'off', model: 'grok', modelName: '', modelUrl: '', apiKey: 'fixture-private-key' };
    await assert.rejects(action('publication', fields, viewer), /Forbidden/);
    await action('publication', fields);
    assert.equal(JSON.parse(readFileSync(join(root, 'config/publisher.json'), 'utf8')).publication, 'Executive Brief');
    assert.match(readFileSync(join(root, '.env'), 'utf8'), /VIDEO_PATH="C:\\Users\\Example\\Videos"/);
    assert.match(readFileSync(join(root, '.env'), 'utf8'), /fixture-private-key/);
    const state = await (await fetch(base + '/v1/journey?workspace=' + slug, { headers: { authorization: 'Bearer ' + owner } })).json();
    await assert.rejects(action('publication', { ...fields, model: 'gemini', modelUrl: state.model.url, apiKey: 'fixture-gemini-key' }), /previous provider/);
    const oldCover = JSON.parse(readFileSync(join(root, 'config/editions/daily-roundup.json'), 'utf8')).coverFile;
    const oldCoverBytes = readFileSync(join(root, oldCover));
    const envBefore = readFileSync(join(root, '.env'), 'utf8') + 'AI_CONTENT_MODEL_PROVIDER="grok"\nAI_CONTENT_MODEL_NAME="existing-runtime-model"\nAI_CONTENT_MODEL_BASE_URL="https://api.x.ai/v1"\n';
    writeFileSync(join(root, '.env'), envBefore);
    const operatorSource = JSON.parse(readFileSync(join(root, 'config/sources.json'), 'utf8'));
    operatorSource.rss = [{ name: 'Operator source', url: 'https://operator.example.org/feed', custom: 'preserved' }];
    operatorSource.editorial.excludedTopics = ['Operator exclusion'];
    operatorSource.editorial.selectionNotes = 'Keep this manually edited guidance.';
    operatorSource.editorial.areas.mission = 'Operator mission';
    atomicJson(join(root, 'config/sources.json'), operatorSource);
    const operatorPublisher = JSON.parse(readFileSync(join(root, 'config/publisher.json'), 'utf8'));
    operatorPublisher.tone = 'Operator tone'; atomicJson(join(root, 'config/publisher.json'), operatorPublisher);
    await action('publication', { publication: 'Refined title', audience: 'strategy leaders', topics: 'evidence', preserveModel: true });
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), envBefore);
    assert.deepEqual(readFileSync(join(root, oldCover)), oldCoverBytes);
    assert.notEqual(JSON.parse(readFileSync(join(root, 'config/editions/daily-roundup.json'), 'utf8')).coverFile, oldCover);
    const preserved = JSON.parse(readFileSync(join(root, 'state/journey-brief.json'), 'utf8'));
    assert.equal(preserved.feeds, 'https://operator.example.org/feed'); assert.equal(preserved.publicApis, 'off'); assert.equal(preserved.name, fields.name); assert.equal(preserved.tone, 'Operator tone');
    const sourceAfter = JSON.parse(readFileSync(join(root, 'config/sources.json'), 'utf8'));
    assert.deepEqual(sourceAfter.rss, operatorSource.rss); assert.deepEqual(sourceAfter.editorial.excludedTopics, operatorSource.editorial.excludedTopics); assert.equal(sourceAfter.editorial.selectionNotes, operatorSource.editorial.selectionNotes); assert.deepEqual(sourceAfter.editorial.areas, { ...operatorSource.editorial.areas, focusAreas: operatorSource.editorial.areas.focusAreas.filter((area: string) => !operatorSource.editorial.preferredTopics.includes(area) || area === 'evidence') });
    await action('publication', { publication: 'Refined title', audience: 'strategy leaders', topics: 'Climate evidence', preserveModel: true });
    const changedTopics = JSON.parse(readFileSync(join(root, 'config/sources.json'), 'utf8'));
    assert.ok(changedTopics.editorial.areas.focusAreas.includes('Climate evidence')); assert.equal(changedTopics.editorial.areas.mission, 'Operator mission');
    await action('publication', { publication: 'Refined title', audience: 'Engineers managing AI workloads on local hardware', topics: 'Climate evidence', preserveModel: true });
    const labels = JSON.parse(readFileSync(join(root, 'config/sources.json'), 'utf8')).editorial.areas;
    for (const label of [...labels.focusAreas, ...labels.verticals]) assert.equal(vocabularyLabelProblem(label), null, label);
    assert.equal(labels.verticals.at(-1), 'other'); assert.equal(labels.focusAreas.at(-1), 'other');
    assert.equal(state.model.keySaved, true); assert.doesNotMatch(JSON.stringify(state), /fixture-private-key|tokenHash/);
    await assert.rejects(action('channel', { platform: 'youtube', enabled: true, values: { HARNESS_TOKEN: 'anything' } }), /Unknown channel/);
    await assert.rejects(action('publication', { ...fields, modelUrl: 'file:///private', publication: 'Invalid' }), /Model URL/);
    assert.equal(JSON.parse(readFileSync(join(root, 'config/publisher.json'), 'utf8')).publication, 'Refined title');
    await action('newsletter-settings', { edition: 'daily-roundup', url: 'https://www.linkedin.com/newsletters/example-123/' });
    assert.equal(JSON.parse(readFileSync(join(root, 'config/pipeline.json'), 'utf8')).newsletterUrl, 'https://www.linkedin.com/newsletters/example-123/');
    await assert.rejects(action('newsletter-settings', { url: 'https://example.org/private' }), /actual HTTPS LinkedIn/);
    await action('channel', { platform: 'youtube', enabled: false, values: { GOOGLE_CLIENT_ID: 'fixture-client' } });
    await action('channel', { platform: 'youtube', enabled: false, values: { GOOGLE_CLIENT_ID: '' } });
    assert.match(readFileSync(join(root, '.env'), 'utf8'), /fixture-client/);
    await assert.rejects(action('draft', { edition: 'daily-roundup' }, editor), /outside your assigned desks/);
    await assert.rejects(action('publish-newsletter', {}), /Choose an existing package/);

    const legacyModel = JSON.parse(readFileSync(join(root,'config/model.json'),'utf8'));
    legacyModel.providers.claude = {command:'claude',model:'ignored-old-name',baseUrl:'https://ignored.example.org'};
    atomicJson(join(root,'config/model.json'),legacyModel);
    await action('writer',{model:'claude'});
    const legacyState = await (await fetch(base+'/v1/journey?workspace='+slug,{headers:{authorization:'Bearer '+owner}})).json();
    assert.equal(legacyState.model.name,''); assert.equal(legacyState.model.url,'');
    const sourcesBeforeWriter = readFileSync(join(root, 'config/sources.json'), 'utf8');
    await assert.rejects(action('writer', {model:'codex'}, viewer), /Forbidden/);
    await assert.rejects(action('writer', {model:'codex',apiKey:'wrong-key'}), /CLI login.*not a saved API key/);
    await assert.rejects(action('writer', {model:'codex',modelUrl:'https://wrong.example.org'}), /CLI writers/);
    await action('writer', {model:'codex'});
    assert.equal(JSON.parse(readFileSync(join(root,'config/model.json'),'utf8')).provider, 'codex');
    assert.equal(readFileSync(join(root,'config/sources.json'),'utf8'), sourcesBeforeWriter);
    assert.doesNotMatch(readFileSync(join(root,'.env'),'utf8'), /AI_CONTENT_MODEL_(PROVIDER|NAME|BASE_URL)=/);
    assert.match(readFileSync(join(root,'.env'),'utf8'), /fixture-private-key/);
    assert.equal(existsSync(join(root, 'state/model-calls.jsonl')), false);
    assert.equal(existsSync(join(root, 'state/tokens/google.json')), false);
    await assert.rejects(action('media', { mode: 'hybrid', avatarProvider: 'hedra', voiceProvider: 'kokoro' }), /as part of Pro/);
    const avatarBefore = readFileSync(join(root, 'config/avatar.json'), 'utf8');
    await assert.rejects(action('media', {mode:'hybrid',voiceProvider:'kokoro'}), /requires an active Pro/);
    assert.equal(readFileSync(join(root,'config/avatar.json'),'utf8'),avatarBefore);
    await action('editorial', {topics:'Primary evidence',avoid:'Speculation',notes:'Keep limitations visible',feeds:'https://operator.example.org/feed',enabledSources:['rss','publicApis']});
    const filtered = JSON.parse(readFileSync(join(root,'config/sources.json'),'utf8'));
    assert.deepEqual(filtered.rss,operatorSource.rss); assert.equal(filtered.editorial.areas.mission,'Operator mission');
    assert.ok(!filtered.editorial.areas.focusAreas.includes('Climate evidence')); assert.deepEqual(filtered.editorial.excludedTopics,['Speculation']); assert.deepEqual(filtered.enabledSources,['rss','publicApis']);
    await assert.rejects(action('editorial',{topics:'x',avoid:'',notes:'',feeds:'https://name:password@example.org/feed',enabledSources:['rss']}),/credentials/);
    await assert.rejects(action('editorial',{topics:'x',avoid:'',notes:'',feeds:'',enabledSources:['shell']}),/source/);
    assert.deepEqual(JSON.parse(readFileSync(join(root,'config/sources.json'),'utf8')),filtered);
    const draft = { id: '20260907-example', edition: 'daily-roundup', status: 'pending_review' };
    assert.equal(companionNeedsRepair(root, draft), true);
    assert.throws(() => companionNeedsRepair(root, { ...draft, status: 'approved' }), /Hold and review/);
    atomicJson(join(root, 'workdir/newsletters/2026-09-07.json'), { sourceVideoId: draft.id });
    assert.equal(companionNeedsRepair(root, draft), true);
    for (const suffix of ['.html', '.linkedin.html']) writeFileSync(join(root, 'workdir/newsletters/2026-09-07' + suffix), '<p>draft</p>');
    assert.equal(companionNeedsRepair(root, draft), false);
    assert.throws(() => companionNeedsRepair(root, { ...draft, id: '20260907-another' }), /Another video owns/);
    // A browser visual-choice continuation is the completed job for a CLI-started draft.
    // Reload must restore its real companion, without adopting another actor's or a paused job.
    const draftDir = join(root, 'workdir/videos', draft.id), jobsDir = join(root, 'state/journey-jobs');
    mkdirSync(draftDir, { recursive: true }); mkdirSync(jobsDir, { recursive: true });
    atomicJson(join(draftDir, 'meta.json'), draft); writeFileSync(join(draftDir, 'final.mp4'), 'fixture media');
    const restoredJob = { actor: 'owner', operation: 'visual-choice', status: 'done', result: { id: draft.id }, finishedAt: '2026-09-07T12:00:00Z' };
    atomicJson(join(jobsDir, 'completed-visual.json'), restoredJob);
    writeFileSync(join(jobsDir, 'truncated.json'), '{"actor":');
    writeFileSync(join(jobsDir, 'null.json'), 'null');
    atomicJson(join(jobsDir, 'newer-stale.json'), { ...restoredJob, result: { id: '20260908-missing' }, finishedAt: '2026-09-08T12:00:00Z' });
    const journey = async (token = owner) => (await fetch(base + '/v1/journey?workspace=' + slug, { headers: { authorization: 'Bearer ' + token } })).json();
    assert.equal((await journey()).lastDraft?.id, draft.id);
    assert.equal((await journey(viewer)).lastDraft, null);
    atomicJson(join(jobsDir, 'completed-visual.json'), { ...restoredJob, result: { id: draft.id, awaitingVisualChoice: true } });
    assert.equal((await journey()).lastDraft, null);
    atomicJson(join(jobsDir, 'completed-visual.json'), { ...restoredJob, operation: 'story-choice' });
    assert.equal((await journey()).lastDraft?.id, draft.id);
    atomicJson(join(root, 'workdir/newsletters/2026-09-07.json'), { sourceVideoId: '20260907-another' });
    assert.equal((await journey()).lastDraft, null);
    atomicJson(join(root, 'workdir/newsletters/2026-09-07.json'), { sourceVideoId: draft.id });
    atomicJson(join(draftDir, 'meta.json'), { ...draft, status: 'failed:render' });
    assert.equal((await journey()).lastDraft, null);
    atomicJson(join(draftDir, 'meta.json'), draft);
    for (const headers of [{}, { authorization: 'Bearer ' + owner, origin: 'https://example.org' }] as Record<string, string>[]) {
      const r = await fetch(base + '/v1/journey?workspace=' + slug, { headers }); assert.ok([401, 403].includes(r.status));
    }
    const post = (token: string, key: string) => fetch(base + '/v1/journey/media?workspace=' + slug, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ mode: 'cards', voiceProvider: 'kokoro' }) });
    assert.equal((await post(viewer, 'viewer-denied-1')).status, 403);
    const response = await post(owner, 'save-media-once'); assert.equal(response.status, 202); const job = (await response.json()).job;
    assert.equal((await (await post(owner, 'save-media-once')).json()).job, job);
    let result;
    for (let n = 0; n < 100; n++) { result = await (await fetch(base + '/v1/journey/jobs/' + job + '?workspace=' + slug, { headers: { authorization: 'Bearer ' + owner } })).json(); if (result.status !== 'running') break; await new Promise(r => setTimeout(r, 50)); }
    assert.equal(result.status, 'done', JSON.stringify(result));
    assert.equal((await fetch(base + '/v1/journey/jobs/' + job + '?workspace=' + slug, { headers: { authorization: 'Bearer ' + viewer } })).status, 404);
    const page = await (await fetch(base + '/journey')).text(); assert.match(page, /Create my private preview/); assert.doesNotMatch(page, new RegExp(owner));
    // Browsers request small byte ranges for metadata and seeking. Test both public and protected media.
    const mediaBytes = Buffer.from('0123456789');
    mkdirSync(join(root, 'workdir/videos/range-example'), { recursive: true });
    writeFileSync(join(root, 'workdir/videos/range-example/final.mp4'), mediaBytes);
    const privateUrl = base + '/v1/packages/range-example/artifact/final.mp4?workspace=' + slug;
    const publicBytes = readFileSync(join(CODE_ROOT, 'docs/journey-assets/walkthrough-v8.mp4'));
    for (const [url, bytes, headers] of [
      [privateUrl, mediaBytes, { authorization: 'Bearer ' + owner }],
      [base + '/journey-assets/walkthrough-v8.mp4', publicBytes, {}],
    ] as [string, Buffer, Record<string, string>][]) {
      for (const [range, start, end] of [['bytes=0-1', 0, 2], ['bytes=-3', bytes.length - 3, bytes.length], [`bytes=${bytes.length - 2}-`, bytes.length - 2, bytes.length], [`bytes=${bytes.length - 2}-999999999`, bytes.length - 2, bytes.length]] as [string, number, number][]) {
        const r = await fetch(url, { headers: { ...headers, range } });
        assert.equal(r.status, 206); assert.equal(r.headers.get('accept-ranges'), 'bytes');
        assert.equal(r.headers.get('content-range'), `bytes ${start}-${end - 1}/${bytes.length}`);
        assert.equal(r.headers.get('content-length'), String(end - start));
        assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(start, end));
      }
      for (const range of [`bytes=${bytes.length}-`, 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=bad', 'bytes=0-1,4-5']) {
        const r = await fetch(url, { headers: { ...headers, range } }); assert.equal(r.status, 416);
        assert.equal(r.headers.get('content-range'), `bytes */${bytes.length}`); assert.equal((await r.arrayBuffer()).byteLength, 0);
      }
      const head = await fetch(url, { method: 'HEAD', headers: { ...headers, range: 'bytes=0-1' } });
      assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
      const changed = await fetch(url, { headers: { ...headers, range: 'bytes=0-1', 'if-range': '"old-version"' } });
      assert.equal(changed.status, 200); assert.deepEqual(Buffer.from(await changed.arrayBuffer()), bytes);
    }
    for (const method of ['GET', 'HEAD']) assert.equal((await fetch(privateUrl, { method, headers: { range: 'bytes=0-1' } })).status, 401);
    assert.match((await fetch(base + '/guide')).headers.get('content-security-policy')!, /media-src 'self'/);
    // A browser job must inherit the operator's custom Codex login/model home, never another provider key.
    const codexHome = join(root, 'fake-codex'); mkdirSync(codexHome);
    writeFileSync(join(codexHome,'config.toml'),'model="custom-home-model"\n');
    const fake = join(codexHome,'writer-test.cjs');
    writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);let input='';
process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 if(args[args.indexOf('--model')+1]!=='custom-home-model'||process.env.XAI_API_KEY==='inherited-global-key'||!(process.env.USER||process.env.USERNAME))process.exit(2); // a CLI writer needs the user name to find its login
 fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({ok:true,provider:'codex'}));
});`, {mode:0o700});
    writeFileSync(join(codexHome,'writer-test.cmd'),'@"%dp0%/writer-test.cjs"');
    const model = JSON.parse(readFileSync(join(root,'config/model.json'),'utf8'));
    model.providers.codex.command = process.platform === 'win32' ? 'writer-test' : fake; atomicJson(join(root,'config/model.json'),model);
    const prior = {CODEX_HOME:process.env.CODEX_HOME,PATH:process.env.PATH,XAI_API_KEY:process.env.XAI_API_KEY};
    try {
      process.env.CODEX_HOME=codexHome;process.env.PATH=codexHome+delimiter+process.env.PATH;process.env.XAI_API_KEY='inherited-global-key';
      assert.match(String((await action('check-model',{})).message),/JSON check passed/);
      const receipt=JSON.parse(readFileSync(join(root,'state/model-calls.jsonl'),'utf8').trim());
      assert.equal(receipt.provider,'codex');assert.equal(receipt.model,'custom-home-model');
    } finally { for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;} }
    const description='Create a weekly AI briefing for our leadership team.',provider='codex',voice='saved';
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const savedId=day.replaceAll('-','')+'-completed-quick';mkdirSync(join(root,'workdir/videos',savedId),{recursive:true});
    atomicJson(join(root,'workdir/videos',savedId,'meta.json'),{id:savedId,createdBy:'owner',status:'pending_review',edition:'daily-roundup',createdAt:new Date().toISOString(),posts:{}});
    const receipt={status:'done',step:4,id:savedId,requestHash:createHash('sha256').update(JSON.stringify({description,provider,voice})).digest('hex'),configurationHash:createHash('sha256').update(JSON.stringify(['model','publisher','sources','avatar'].map(name=>JSON.parse(readFileSync(join(root,'config',name+'.json'),'utf8'))))).digest('hex')};
    atomicJson(join(root,'state/quick-preview.json'),receipt);
    cpSync(join(CODE_ROOT,'docs/journey-assets/sample-slides.mp4'),join(root,'workdir/videos',savedId,'final.mp4'));
    atomicJson(join(root,'workdir/newsletters',day+'.json'),{sourceVideoId:savedId});
    writeFileSync(join(root,'workdir/newsletters',day+'.html'),'<h1>Completed newsletter</h1>');
    const originalVideo=createHash('sha256').update(readFileSync(join(root,'workdir/videos',savedId,'final.mp4'))).digest('hex');
    const callsBefore=readFileSync(join(root,'state/model-calls.jsonl'),'utf8');
    const savedSources=readFileSync(join(root,'config/sources.json'),'utf8');
    await assert.rejects(action('quick-preview',{description:'Create a different climate briefing for our team.',model:provider,voiceProvider:voice}),/completed preview belongs to an earlier brief/);
    assert.deepEqual(JSON.parse(readFileSync(join(root,'state/quick-preview.json'),'utf8')),receipt);
    assert.equal(readFileSync(join(root,'config/sources.json'),'utf8'),savedSources);
    for(const op of ['visual-choice','story-choice'])assert.equal((await action(op,{id:savedId,acceptRecommendations:true,ownImages:{'0':'not an image'}})).id,savedId);
    assert.equal(createHash('sha256').update(readFileSync(join(root,'workdir/videos',savedId,'final.mp4'))).digest('hex'),originalVideo);
    assert.equal(completedPreview(root,savedId)?.id,savedId);
    atomicJson(join(root,'workdir/newsletters',day+'.json'),{sourceVideoId:'another-package'});
    assert.equal(completedPreview(root,savedId),null);
    await assert.rejects(action('quick-preview',{description,model:provider,voiceProvider:voice}),/incomplete newsletter/);
    atomicJson(join(root,'workdir/newsletters',day+'.json'),{sourceVideoId:savedId});
    assert.deepEqual(JSON.parse(readFileSync(join(root,'state/quick-preview.json'),'utf8')),receipt);
    assert.equal((await action('quick-preview',{description,model:provider,voiceProvider:voice})).id,savedId);
    assert.equal(readFileSync(join(root,'state/model-calls.jsonl'),'utf8'),callsBefore);
    // a beta tester, Sep 10: a failed attempt kept no reason, and her trusted sites were checked only after a five-minute model call.
    // The sites are checked first (no model call when none offers a feed) and the reason is saved with the progress for a reload.
    rmSync(join(root,'workdir/videos',savedId),{recursive:true,force:true});
    const sourcesBefore=readFileSync(join(root,'config/sources.json'),'utf8');
    await assert.rejects(action('quick-preview',{description,model:provider,voiceProvider:voice,trustedSources:'City Housing Newsroom'}),/looks like a name/);
    const paused=JSON.parse(readFileSync(join(root,'state/quick-preview.json'),'utf8'));
    assert.equal(paused.status,'failed');assert.equal(paused.stage,'Paused at: Plan your briefing');assert.match(paused.error,/City Housing Newsroom — This looks like a name/);
    assert.equal(paused.description,description);assert.equal(paused.sourceMode,'manual');assert.equal(paused.trustedSources,'City Housing Newsroom');assert.equal(paused.model,provider);assert.equal(paused.voiceProvider,voice);
    assert.equal(readFileSync(join(root,'state/model-calls.jsonl'),'utf8'),callsBefore,'no model call before the sites are checked');
    assert.equal(readFileSync(join(root,'config/sources.json'),'utf8'),sourcesBefore,'a failed attempt changes no sources');
    // A saved local voice is checked before any minutes are spent: whether Voicebox is down or the profile is gone, the attempt
    // stops at once, by the voice's name, with no model call. (Reads the local profile list only; nothing is synthesized.)
    const avatarSaved = readFileSync(join(root, 'config/avatar.json'), 'utf8');
    atomicJson(join(root, 'config/avatar.json'), { ...JSON.parse(avatarSaved), voiceProvider: 'voicebox', voicebox: { profile: 'no-such-profile-fixture', name: 'Fixture voice' } });
    await assert.rejects(action('quick-preview', { description, model: provider, voiceProvider: 'saved' }), /Your saved voice \(Fixture voice\) (is not ready|is not in local Voicebox any more)/);
    assert.equal(JSON.parse(readFileSync(join(root, 'state/quick-preview.json'), 'utf8')).stage, 'Paused at: Plan your briefing');
    assert.equal(readFileSync(join(root, 'state/model-calls.jsonl'), 'utf8'), callsBefore);
    writeFileSync(join(root, 'config/avatar.json'), avatarSaved);
    // A feed an agent proposes is fetched before it is saved; an invented one is refused and nothing changes.
    await assert.rejects(action('editorial',{topics:'evidence',avoid:'',notes:'',enabledSources:['rss'],feeds:'Stock Politics Feed',verifyFeeds:true}),/Nothing was saved.*looks like a name/);
    assert.equal(readFileSync(join(root,'config/sources.json'),'utf8'),sourcesBefore);
    // Codex review (P1): a paused package belongs to the brief that created it. Brief A paused at "Choose your stories";
    // brief B must not adopt A's stories as its preview (produce resumes today's paused package by itself).
    const pausedId = day.replaceAll('-', '') + '-roundup-paused-brief-a', pausedDir = join(root, 'workdir/videos', pausedId);
    mkdirSync(pausedDir, { recursive: true });
    atomicJson(join(pausedDir, 'meta.json'), { id: pausedId, status: 'awaiting_story_choice', edition: 'daily-roundup', headline: 'Brief A day', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), posts: {} });
    const pauseRecord = { stage: 'Choose your stories', step: 3, status: 'awaiting', id: pausedId, requestHash: 'f'.repeat(64), configurationHash: null, pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    atomicJson(join(root, 'state/quick-preview.json'), pauseRecord);
    writeFileSync(join(root, 'state/.release.lock'), JSON.stringify({ pid: process.pid }));
    await assert.rejects(action('quick-preview', { description, model: provider, voiceProvider: 'saved' }), /Busy: another release action is running/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'state/quick-preview.json'), 'utf8')), pauseRecord, 'an active worker keeps its preview receipt unchanged');
    rmSync(join(root, 'state/.release.lock'), { force: true });

    await assert.rejects(action('quick-preview', { description: 'A different brief: weekly transit updates for daily commuters.', model: provider, voiceProvider: 'kokoro' }), /earlier brief is waiting for your story choice/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'state/quick-preview.json'), 'utf8')), pauseRecord, "brief A's pause is untouched");
    assert.equal(readFileSync(join(root, 'state/model-calls.jsonl'), 'utf8'), callsBefore, 'no model call for the refused brief');
    // Codex review: one story choice at a time — a second submission while one holds the choice lock is refused.
    const storyEntry = { key: 'k1', role: 'recommended', story: { n: 1, headline: 'Transit fares change', summary: 'Fares change.', verifiedClaims: ['Transit fares change.'], weight: 'lead', primaryUrl: 'https://news.example.org/fares', repo: null, assetRef: 'og-0', suggestedScene: 'news_card', principalEntity: 'Transit agency', area: 'other', verticals: ['other'] }, sourceItemIds: ['i1'], evidence: { compositeScore: null, scoreBreakdown: null, outletsCovering: null, credibility: null, publishedAt: null, sourceHost: 'news.example.org' } };
    writeFileSync(join(pausedDir, 'story-choice.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), minStories: 1, maxStories: 3, recommendedLead: 'k1', entries: [storyEntry] }));
    writeFileSync(join(root, 'state/.story-choice.lock'), JSON.stringify({ pid: process.pid }));
    await assert.rejects(action('story-choice', { id: pausedId, acceptRecommendations: true }), /Busy/);
    rmSync(join(root, 'state/.story-choice.lock'), { force: true });
    // Codex review (P2): a continuation that fails after the choice is recorded on the paused quick preview, so a reload
    // shows the reason instead of an endless "awaiting". (No topic.json: the resume stops at once, before any model.)
    await assert.rejects(action('story-choice', { id: pausedId, acceptRecommendations: true }), /Cannot resume/);
    const afterResume = JSON.parse(readFileSync(join(root, 'state/quick-preview.json'), 'utf8'));
    assert.equal(afterResume.status, 'failed'); assert.equal(afterResume.id, pausedId); assert.equal(afterResume.stage, 'Paused at: Create the preview'); assert.match(afterResume.error, /Cannot resume/);
    rmSync(pausedDir, { recursive: true, force: true });

    // A browser retry keeps the retained package. Source research precedes drafting even when
    // legacy claims look rich; the fake writer's malformed query plan must retain an exact failure.
    const retryId = day.replaceAll('-', '') + '-failed-script-retry', retryDir = join(root, 'workdir/videos', retryId);
    const unrelatedId = day.replaceAll('-', '') + '-unrelated-failure', unrelatedDir = join(root, 'workdir/videos', unrelatedId);
    mkdirSync(retryDir); mkdirSync(unrelatedDir);
    const retryMeta = { id: retryId, status: 'failed:script', edition: 'daily-roundup', createdBy: 'owner', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: new Date().toISOString(), posts: {} };
    atomicJson(join(retryDir, 'meta.json'), retryMeta);
    atomicJson(join(unrelatedDir, 'meta.json'), { ...retryMeta, id: unrelatedId, createdAt: new Date().toISOString() });
    atomicJson(join(retryDir, 'topic.json'), { id: retryId, kind: 'roundup', headline: 'Retained selected story', angle: '', primaryUrl: storyEntry.story.primaryUrl, sourceItems: ['i1'], repo: null, alternates: [], stories: [storyEntry.story] });
    atomicJson(join(retryDir, 'script-tasks.json'), { values: {} });
    atomicJson(join(retryDir, 'script.json'), { stale: 'A failed rewrite must not reuse this earlier script' });
    const retryPrompts = join(codexHome, 'retry-prompts.jsonl');
    writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);let input='';
process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 fs.appendFileSync(${JSON.stringify(retryPrompts)},JSON.stringify(input)+'\\n');
 fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({ok:true}));
});`, { mode: 0o700 });
    const retryReceipt = { status: 'failed', step: 3, id: retryId, actor: 'owner', requestHash: receipt.requestHash, resumeConfigurationHash: quickPreviewRetryKey(root), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    atomicJson(join(root, 'state/quick-preview.json'), retryReceipt);
    const packagesBefore = (await import('node:fs')).readdirSync(join(root, 'workdir/videos')).sort();
    const unrelatedBefore = readFileSync(join(unrelatedDir, 'meta.json'), 'utf8');
    await assert.rejects(action('quick-preview', { description: 'A changed brief about local transit planning.', model: provider, voiceProvider: voice }), /earlier brief or changed settings/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'state/quick-preview.json'), 'utf8')), retryReceipt);
    const personalizePath = join(root, 'config/personalization.json'), personalizeBefore = readFileSync(personalizePath, 'utf8');
    atomicJson(personalizePath, { ...JSON.parse(personalizeBefore), videoLength: 'deep' });
    await assert.rejects(action('quick-preview', { description, model: provider, voiceProvider: voice }), /earlier brief or changed settings/);
    writeFileSync(personalizePath, personalizeBefore);
    assert.equal(existsSync(retryPrompts), false, 'changed request/settings make no writer call');
    // This sparse attempt has its own immutable package; changing its facts later cannot
    // silently reset the saved writing identity. The rich routing fixture below is unattempted.
    const sparseId = day.replaceAll('-', '') + '-sparse-script-retry', sparseDir = join(root, 'workdir/videos', sparseId);
    cpSync(retryDir, sparseDir, { recursive: true });
    atomicJson(join(sparseDir, 'meta.json'), { ...retryMeta, id: sparseId });
    atomicJson(join(sparseDir, 'topic.json'), { ...JSON.parse(readFileSync(join(retryDir, 'topic.json'), 'utf8')), id: sparseId });
    atomicJson(join(root, 'state/quick-preview.json'), { ...retryReceipt, id: sparseId });
    packagesBefore.push(sparseId); packagesBefore.sort();
    const evidenceReason = 'Stage script failed: Complete primary source capture failed for https://news.example.org/fares; selected story and original budget retained';
    await assert.rejects(action('quick-preview', { description, model: provider, voiceProvider: voice }), error => (error as Error).message === evidenceReason);
    const sparseFailure = JSON.parse(readFileSync(join(root, 'state/quick-preview.json'), 'utf8'));
    assert.equal(sparseFailure.error, evidenceReason, 'the browser retains the exact research failure for reload');
    assert.equal(sparseFailure.id, sparseId); assert.equal(sparseFailure.status, 'failed');
    assert.equal(sparseFailure.resumeConfigurationHash, retryReceipt.resumeConfigurationHash);
    assert.equal(existsSync(retryPrompts), false, 'unreadable primary source stops before any writer call');
    assert.deepEqual(JSON.parse(readFileSync(join(sparseDir, 'script.json'), 'utf8')), { stale: 'A failed rewrite must not reuse this earlier script' });
    assert.equal(existsSync(join(sparseDir, 'companion-writing-receipt.json')), false);
    assert.equal(JSON.parse(readFileSync(join(sparseDir, 'writing-request.json'), 'utf8')).outputs, 'edition');
    // Fictional transit-source fixture: distinct policy facts and their conditions supply the
    // unchanged standard newsletter minimum. This does not claim a real source/model acceptance.
    const retryFacts = [storyEntry.story.verifiedClaims[0]!,
      "The transit board approved a revised fare policy for its local bus network after reviewing the published consultation record. The approval covers the fare categories described in the notice, while the implementation date remains subject to completion of ticket machine updates and a separate public announcement.",
      "Adult passengers may continue buying a single journey ticket from the driver or through the existing mobile application. The revised policy applies the same fare to both purchase methods, but it does not introduce payment by bank card on vehicles that still use the older cash collection equipment.",
      "The reduced fare category remains available to passengers holding the eligibility card issued by the transit authority. Applicants must present the documents listed in the published application guide, and an application awaiting review does not itself establish eligibility to use the reduced fare when boarding a bus.",
      "Transfer tickets permit a passenger to continue a journey on another local route during the validity period printed on the ticket. The policy excludes a return trip on the originating route and states that the transfer cannot be shared with another passenger or used after its printed expiry time.",
      "Existing stored value balances will remain on registered travel accounts when the revised policy begins. The notice distinguishes those balances from promotional credits, which retain their original expiry conditions, and instructs passengers with missing balances to contact the customer service office with a transaction receipt before requesting an adjustment.",
      "Monthly passes purchased before implementation remain valid until the expiry date shown on the pass. New passes will use the revised policy after implementation, but the announcement does not promise that purchasing a pass early will extend its validity or preserve the former fare for a later billing period.",
      "Passengers who believe they were charged incorrectly may submit a review request through the customer service form or at the central office. The request must identify the journey and payment method, and the notice says a refund depends on review of the transaction rather than following automatically from a complaint.",
      "Accessible journey assistance continues under the existing booking procedure and remains separate from the fare change. Passengers requesting assistance must contact the scheduling team through the published channels, while the notice makes no announcement about additional accessible vehicles, expanded service hours or changes to the advance booking requirement.",
      "Bus operators will receive updated fare guidance before the implementation announcement is issued. The guidance includes examples of valid transfer tickets and instructions for referring disputed charges to customer service, but drivers are not authorized by this notice to amend account balances or grant permanent eligibility for a reduced fare.",
      "The authority will retain the consultation summary on its public notice page together with the approved policy. Questions received after publication will be collected for an explanatory update, and the notice distinguishes that planned update from a further board decision or an announced extension of the consultation period.",
    ];
    assert.ok(countEvidenceWords([retryFacts])[0]! >= 450);
    assert.equal(new Set(retryFacts).size, retryFacts.length);
    const retryTopicPath = join(retryDir, 'topic.json'), retryTopic = JSON.parse(readFileSync(retryTopicPath, 'utf8'));
    retryTopic.stories[0].verifiedClaims = retryFacts;
    atomicJson(retryTopicPath, retryTopic);
    atomicJson(join(root, 'state/quick-preview.json'), retryReceipt);
    await assert.rejects(action('quick-preview', { description, model: provider, voiceProvider: voice }), error => (error as Error).message === evidenceReason);
    const retryFailure = JSON.parse(readFileSync(join(root, 'state/quick-preview.json'), 'utf8'));
    assert.equal(retryFailure.id, retryId); assert.equal(retryFailure.status, 'failed'); assert.equal(retryFailure.resumeConfigurationHash, retryReceipt.resumeConfigurationHash);
    assert.equal(retryFailure.error, evidenceReason, 'preloaded fictional claims cannot bypass the real source-research contract');
    assert.equal(existsSync(retryPrompts), false, 'preloaded claims cannot buy writing before primary source capture');
    assert.deepEqual(JSON.parse(readFileSync(join(retryDir, 'script.json'), 'utf8')), { stale: 'A failed rewrite must not reuse this earlier script' });
    assert.equal(existsSync(join(retryDir, 'companion-writing-receipt.json')), false);
    assert.deepEqual((await import('node:fs')).readdirSync(join(root, 'workdir/videos')).sort(), packagesBefore, 'retry never ranks or creates a replacement package');
    assert.equal(readFileSync(join(unrelatedDir, 'meta.json'), 'utf8'), unrelatedBefore, 'the newest unrelated failure is never adopted');
    assert.equal(readFileSync(join(root, 'config/sources.json'), 'utf8'), sourcesBefore, 'retry does not re-plan the publication or sources');

  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

test('a changed automatic brief replaces inherited sources while the same brief keeps operator settings', async () => {
  const description = 'Current events in gardening for our weekly readers.';
  const plan = { publication: 'Garden Weekly', audience: 'Readers following current gardening events', topics: ['Gardening news'], communitySources: [] };
  for (const scenario of ['changed-publication-author', 'changed-person-author', 'saved-use-case', 'legacy-saved-use-case', 'same-brief', 'same-brief-operator-topics']) {
    const root = mkdtempSync(join(CODE_ROOT, 'workspaces/brief-isolation-')), slug = basename(root), token = 'd'.repeat(64);
    try {
      cpSync(join(CODE_ROOT, 'config'), join(root, 'config'), { recursive: true });
      for (const dir of ['state', 'workdir/videos', 'workdir/harvest']) mkdirSync(join(root, dir), { recursive: true });
      atomicJson(join(root, 'workspace.json'), { id: slug });
      atomicJson(join(root, 'members.json'), [{ id: 'owner', role: 'owner', tokenHash: createHash('sha256').update(token).digest('hex') }]);
      atomicJson(join(root, 'desks.json'), {});
      const same = scenario.startsWith('same-brief'), priorPublication = same ? 'Garden Weekly' : 'Haines City and Beyond';
      const author = scenario === 'changed-person-author' ? 'Jordan Lee' : priorPublication;
      atomicJson(join(root, 'config/publisher.json'), { publication: priorPublication, name: author, audience: 'Previous readers', tone: 'Clear' });
      atomicJson(join(root, 'state/onboarding.json'), { configuredAt: new Date().toISOString() });
      atomicJson(join(root, 'state/use-case.json'), { description: same || scenario === 'legacy-saved-use-case' ? description : 'Upcoming activities in Haines City and Orlando.', sourceMode: 'auto', ...(scenario === 'saved-use-case' ? { configuredDescription: 'Upcoming activities in Haines City and Orlando.', configuredSourceMode: 'auto' } : scenario === 'same-brief-operator-topics' ? { configuredDescription: description, configuredSourceMode: 'auto' } : {}) });
      const source = JSON.parse(readFileSync(join(root, 'config/sources.json'), 'utf8'));
      source.enabledSources = ['rss', 'hn', 'githubTrending', 'publicApis'];
      source.rss = [{ name: 'Chosen by the operator', url: 'https://127.0.0.1:1/never-request-this-feed', custom: 'retained for the same brief' }];
      source.editorial = { preferredTopics: same ? ['Gardening news'] : ['Haines City activities'], excludedTopics: ['rumors'], selectionNotes: 'Keep my prior editorial note.', areas: { mission: 'A custom prior mission', focusAreas: [same ? 'Gardening news' : 'Haines City activities', 'Custom operator category', 'other'], verticals: ['Custom vertical', 'other'] } };
      if (scenario === 'same-brief-operator-topics') source.editorial.preferredTopics = ['Gardening analysis'];
      // An intentionally incomplete API selection makes harvest stop before ANY fetch. For a new
      // automatic brief it must be removed; for the same brief it proves opt-outs/settings survived.
      source.publicApis = { endpoints: [], setupMode: 'off', managedEndpoints: { 'old-topic-api': 'old-fingerprint' } };
      atomicJson(join(root, 'config/sources.json'), source);
      const earlierCheck = { at: '2026-01-01T00:00:00Z', description: 'Earlier activities brief', total: 12, matching: 0 };
      atomicJson(join(root, 'state/source-check.json'), earlierCheck);
      atomicJson(join(root, 'state/source-discovery.json'), { automatic: true, inputHash: createHash('sha1').update(JSON.stringify({ topics: plan.topics, areas: [] })).digest('hex'), results: [], choices: [], topics: plan.topics, areas: [] });
      const avatar = JSON.parse(readFileSync(join(root, 'config/avatar.json'), 'utf8')); avatar.voiceProvider = 'kokoro'; avatar.mode = 'cards'; atomicJson(join(root, 'config/avatar.json'), avatar);
      const fake = join(root, 'fixture-writer.cjs'), prompts = join(root, 'writer-prompts.jsonl');
      writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);let input='';
process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 fs.appendFileSync(${JSON.stringify(prompts)},JSON.stringify(input)+'\\n');
 if(!input.includes('Turn this customer brief into publication settings.')){process.stderr.write('Fixture source search stop');process.exit(2);}
 fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(${JSON.stringify(plan)}));
});`, { mode: 0o700 });
      writeFileSync(join(root, 'fixture-writer.cmd'), '@"%dp0%/fixture-writer.cjs"');
      const model = JSON.parse(readFileSync(join(root, 'config/model.json'), 'utf8')); model.provider = 'codex'; model.providers.codex.command = process.platform === 'win32' ? join(root, 'fixture-writer.cmd') : fake; model.rescue = { enabled: false }; atomicJson(join(root, 'config/model.json'), model);
      if (scenario === 'saved-use-case') await workerAction(root, token, { action: 'journey', operation: 'usage', data: { purpose: 'personal', collaboration: 'solo', description } });
      await assert.rejects(workerAction(root, token, { action: 'journey', operation: 'quick-preview', data: { description, sourceMode: 'auto', model: 'codex', voiceProvider: 'saved' } }), /Fixture source search stop/);
      const after = JSON.parse(readFileSync(join(root, 'config/sources.json'), 'utf8'));
      if (same) {
        assert.deepEqual(after.rss, source.rss);
        assert.deepEqual([...after.enabledSources].sort(), [...source.enabledSources].sort());
        assert.deepEqual(after.editorial, source.editorial);
        assert.deepEqual(after.publicApis, source.publicApis);
      } else {
        assert.deepEqual(after.rss, []);
        assert.deepEqual(after.enabledSources, []);
        assert.deepEqual(after.editorial.preferredTopics, ['Gardening news']);
        assert.deepEqual(after.editorial.excludedTopics, []);
        assert.deepEqual(after.editorial.areas.focusAreas, ['Gardening news', 'other']);
        assert.doesNotMatch(JSON.stringify(after.editorial), /Haines|Custom operator|Custom vertical|prior/);
        assert.deepEqual(after.publicApis.endpoints, []); assert.deepEqual(after.publicApis.managedEndpoints, {});
        assert.equal(after.publicApis.setupMode, 'auto');
      }
      assert.equal(JSON.parse(readFileSync(join(root, 'config/publisher.json'), 'utf8')).name, scenario === 'changed-person-author' ? 'Jordan Lee' : 'Garden Weekly');
      const failed = JSON.parse(readFileSync(join(root, 'state/quick-preview.json'), 'utf8'));
      assert.equal(failed.description, description); assert.equal(failed.sourceMode, 'auto'); assert.equal(failed.status, 'failed'); assert.match(failed.requestHash, /^[a-f0-9]{64}$/);
      assert.equal(JSON.parse(readFileSync(join(root, 'state/use-case.json'), 'utf8')).configuredDescription, description);
      assert.deepEqual(JSON.parse(readFileSync(join(root, 'state/source-check.json'), 'utf8')), earlierCheck, 'the previous evidence receipt remains intact');
      const backups = readdirSync(join(root, 'state/onboarding-backups'));
      assert.deepEqual(JSON.parse(readFileSync(join(root, 'state/onboarding-backups', backups[0], 'sources.json'), 'utf8')), source, 'the prior source configuration remains recoverable');
      assert.equal(readFileSync(prompts, 'utf8').trim().split('\n').length, 2, 'only the fake planner and intentionally stopped source search ran');
      assert.deepEqual(readdirSync(join(root, 'workdir/videos')), [], 'no production package was created');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('a dry-run leftover is never offered for review, but a real tour package under a fixture id is', () => {
  // a beta tester, Sep 10: after her attempt failed, Publish offered the "Example: a verifiable tooling update" dry-run fixture as her package.
  assert.equal(isDryRunLeftover('20260101-example-topic', { status: 'selected' }), true, 'older dry-runs on testers\' machines carry no marker');
  assert.equal(isDryRunLeftover('20260911-new-dry-run', { status: 'selected', dryRun: true }), true);
  assert.equal(isDryRunLeftover('20260101-product-tour', { status: 'pending_review' }), false, 'example:tour produces a real package under the fixture id');
  assert.equal(isDryRunLeftover('20260911-real-attempt', { status: 'selected' }), false);
});

test('OAuth validates state, survives invalid callbacks and closes after success or provider refusal', async () => {
  const available = createServer(); available.listen(0, '127.0.0.1'); await once(available, 'listening');
  const address = available.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
  await new Promise<void>(r => available.close(() => r()));
  let opened!: (url: string) => void; const consent = new Promise<string>(r => opened = r);
  const captured = captureAuthCode('https://auth.example.org/authorize?state=fixed', { port, timeoutMs: 3000, open: url => opened(url) });
  const state = new URL(await consent).searchParams.get('state'); assert.ok(state && state !== 'fixed');
  const callback = `http://127.0.0.1:${port}/callback`;
  assert.equal((await fetch(callback + '?code=attacker', { headers: { connection: 'close' } })).status, 400);
  assert.equal((await fetch(callback + '?state=wrong&code=attacker', { headers: { connection: 'close' } })).status, 400);
  assert.equal((await fetch(callback + '?state=' + state + '&code=accepted', { headers: { connection: 'close' } })).status, 200);
  assert.equal(await captured, 'accepted');
  let denied!: (url: string) => void; const denial = new Promise<string>(r => denied = r);
  const refused = captureAuthCode('https://auth.example.org/authorize', { port, timeoutMs: 3000, open: url => denied(url) });
  const failure = assert.rejects(refused, /OAuth error: denied/);
  const deniedState = new URL(await denial).searchParams.get('state');
  const html = await (await fetch(callback + '?state=' + deniedState + '&error=denied', { headers: { connection: 'close' } })).text();
  assert.doesNotMatch(html, /denied/); await failure;
  await assert.rejects(captureAuthCode('https://auth.example.org/authorize', { port, timeoutMs: 20, open: () => {} }), /timed out/);
});

 test('cost summary distinguishes unknown from zero and stays inside its workspace', () => {
  const root=mkdtempSync(join(CODE_ROOT,'workspaces/cost-check-'));
  try {
   mkdirSync(join(root,'state'));
   assert.equal(usageSummary(root).reportedCostUsd,null);
   const rows=[{at:'2026-09-08',provider:'sample',model:'sample',reportedCostUsd:0,usage:{input_tokens:10}},{at:'2026-09-08',reportedCostUsd:null,usage:{output_tokens:-1}},{at:'2026-09-08',reportedCostUsd:.03}];
   writeFileSync(join(root,'state/model-calls.jsonl'), rows.map(r=>JSON.stringify(r)).join('\n')+'\nmalformed');
   const summary=usageSummary(root);assert.equal(summary.recordedCalls,3);assert.equal(summary.unpricedCalls,1);assert.equal(summary.reportedCostUsd,.03);assert.equal(summary.rows[1].outputTokens,null);
   writeFileSync(join(root,'state/model-calls.jsonl'),'x'.repeat(2*1024*1024)+'\n'+JSON.stringify(rows[0]));
   const bounded=usageSummary(root);assert.equal(bounded.recordedCalls,1);assert.equal(bounded.reportedCostUsd,0);assert.match(bounded.scope,/last 1 MiB/);
  } finally {rmSync(root,{recursive:true,force:true})}
 });
