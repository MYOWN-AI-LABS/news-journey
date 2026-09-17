import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { CODE_ROOT, createWorkspace, workspaceRoot, localToken, atomicJson } from './workspaces.js';
import { releaseProfile } from './release-profile.js';

const profile = releaseProfile();
assert.equal(profile.edition, 'free', 'Run against the extracted Free package');
// evaluation:true is the private-beta build (publication locked, banner shown); evaluation:false is the public build.
const { evaluation } = profile;
const slug = 'free-check-' + Date.now();
createWorkspace(slug);
const root = workspaceRoot(CODE_ROOT, slug), token = localToken(root);
process.env.HARNESS_WORKSPACE = slug; process.env.HARNESS_TOKEN = token;
const checks: string[] = [];
const packageMetadata = JSON.parse(readFileSync(join(CODE_ROOT, 'package.json'), 'utf8'));
assert.equal(packageMetadata.license, 'MIT'); assert.equal(packageMetadata.private, true);
// The evaluation build names no public home; the public build names the MyOwnAI Labs organization repository.
if (evaluation) assert.equal(packageMetadata.repository, undefined);
else assert.match(String(packageMetadata.repository?.url), /^git\+https:\/\/github\.com\/MYOWN-AI-LABS\/[a-z0-9-]+\.git$/);
assert.ok(readFileSync(join(CODE_ROOT, 'LICENSE'), 'utf8').startsWith('MIT License'));
assert.deepEqual(readdirSync(join(CODE_ROOT, 'plugins/content-harness/commands')).sort(), ['draft.md', 'review.md', 'setup.md', 'status.md']);
for (const relativePath of ['plugins/content-harness/.claude-plugin/plugin.json', 'plugins/content-harness/.codex-plugin/plugin.json']) {
  const plugin = JSON.parse(readFileSync(join(CODE_ROOT, relativePath), 'utf8'));
  if (evaluation) { assert.equal(plugin.homepage, undefined); assert.equal(plugin.repository, undefined); }
  else { assert.match(String(plugin.homepage), /^https:\/\/github\.com\/MYOWN-AI-LABS\//); assert.equal(plugin.repository, plugin.homepage); }
  // The plugin's own wording follows the build: the beta package says publication is unavailable, the public one does not.
  assert.match(plugin.description, evaluation ? /Free MIT private evaluation/ : /^Free MIT: /);
  assert.match(plugin.description, evaluation ? /Publication and Pro services are unavailable/ : /Pro services are planned/);
  if (plugin.interface) assert.match(plugin.interface.longDescription, /cannot approve, publish or send/);
}
const marketplace = JSON.parse(readFileSync(join(CODE_ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
assert.match(marketplace.description, evaluation ? /Free MIT private evaluation/ : /^Free MIT: /);
assert.match(marketplace.plugins.find((plugin: { name: string }) => plugin.name === 'content-harness').description, evaluation ? /Publication and Pro services are unavailable/ : /Pro services are planned/);
checks.push('MIT metadata and exactly four Free plugin commands make no publication or private-repository promises');
// The shipped default writer must be one with a recorded fresh-brief preview (Sep 17: three candidates shipped with an
// OpenCode default that had never produced one; agent reviews read the files and never ran the defaults).
const templateModel = JSON.parse(readFileSync(join(CODE_ROOT, 'config/model.json'), 'utf8'));
assert.equal(templateModel.provider, 'claude', 'The template default writer must be the Claude CLI, the only default with a recorded fresh-brief preview');
checks.push('Template default writer is the Claude CLI, the default proven to reach a preview from a plain brief');
const { proState, activatePro } = await import('./pro.js');
assert.equal(proState(root).active, false);
assert.throws(() => activatePro(root, '{}'), /cannot be activated/);
assert.equal(proState(root).checkoutUrl, '');
checks.push('Free package cannot activate Pro or expose checkout');
atomicJson(join(root, 'config/personalization.json'), { organization: 'Copied Brand', newsletterTheme: 'neon', videoSeconds: 180 });
const { personalizationState } = await import('./personalization.js');
assert.equal(personalizationState(root, false).saved.organization, '');
checks.push('Copied personalization does not change Free neutral defaults');
atomicJson(join(root, 'branding/video-theme.json'), { accent: '#FF0000', mode: 'dark' });
mkdirSync(join(root, 'branding'), { recursive: true });
writeFileSync(join(root, 'branding/newsletter.html'), '<html>{{headline}}</html>');
const { workspaceTheme, customNewsletterShell } = await import('./personalization.js');
assert.notEqual(workspaceTheme(root).accent, '#FF0000'); assert.equal(customNewsletterShell(root), null);
const { readCast } = await import('./pipeline/cast.js');
atomicJson(join(root, 'config/cast.json'), { version: 1, format: 'panel', members: [] });
assert.equal(readCast(root).format, 'narrator');
const { proEntitlement } = await import('./workflow-packs.js');
assert.throws(() => proEntitlement(root), /planned Pro/);
checks.push('Copied branding, cast and pack state cannot activate Pro');
let outwardCalls = 0;
const noRequest = (async () => { outwardCalls++; throw new Error('Unexpected outbound request'); }) as typeof fetch;
const voice = await import('./connector-voice.js');
await assert.rejects(voice.realtimeSession(root, 'v=0', noRequest), /planned Pro/);
await assert.rejects(voice.conversationText({ root, token, api: noRequest as any, connection: 'test' }, {}, noRequest), /planned Pro/);
const { engagementAction, collectEngagement } = await import('./engagement.js');
await assert.rejects(engagementAction('engagement-capture', {}), /planned Pro/);
await assert.rejects(collectEngagement(root, 'not-a-package', 'youtube'), /planned Pro/);
const { runAnalytics } = await import('./analytics/cli.js');
await assert.rejects(runAnalytics('collect'), /planned Pro/);
assert.equal(outwardCalls, 0);
checks.push('Voice, analytics and outreach refuse before provider calls');
const { postApproved } = await import('./post/index.js');
const { publishNewsletter } = await import('./publish/publishNewsletter.js');
const { linkVideoIntoNewsletter } = await import('./publish/linkVideoIntoNewsletter.js');
if (evaluation) {
  await assert.rejects(postApproved(), /Private evaluation/);
  await assert.rejects(publishNewsletter(), /Private evaluation/);
  await assert.rejects(linkVideoIntoNewsletter({ videoUrl: 'https://example.org/video' }), /Private evaluation/);
  checks.push('All shared publication entry points refuse private-evaluation delivery');
} else {
  // A public build has no evaluation lock. In an empty workspace postApproved has nothing to post and resolves; the
  // newsletter entry points refuse for the ordinary reason (no generated newsletter). None may refuse for
  // 'Private evaluation', and none may reach the network.
  const realFetch = globalThis.fetch; let publishOutward = 0;
  globalThis.fetch = (async () => { publishOutward++; throw new Error('Unexpected outbound request'); }) as typeof fetch;
  try {
    for (const attempt of [() => postApproved(), () => publishNewsletter(), () => linkVideoIntoNewsletter({ videoUrl: 'https://example.org/video' })]) {
      try { await attempt(); } catch (error) { assert.doesNotMatch(String((error as Error)?.message), /Private evaluation/); }
    }
  } finally { globalThis.fetch = realFetch; }
  assert.equal(publishOutward, 0, 'publication entry points must not reach the network in an empty workspace');
  checks.push('Public build: publication entry points are not locked by the evaluation profile and make no outward call');
}
const { applyExecutiveAction } = await import('./executive-actions.js');
await assert.rejects(applyExecutiveAction('personalize', {}), /Pro/);
const { createControlServer } = await import('./control.js');
const server = createControlServer();
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
try {
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = 'http://127.0.0.1:' + address.port;
  const auth = { authorization: 'Bearer ' + token };
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.ok([401,403].includes((await fetch(base + '/v1/state?workspace=' + slug)).status));
  const page = await (await fetch(base + '/journey')).text();
  assert.equal(/Free MIT.*Private evaluation/.test(page), evaluation, evaluation ? 'Evaluation banner must be present' : 'A public build must not show the evaluation banner');
  assert.match(page, /\/journey-assets\/myownai-logo\.png/, 'The MyOwnAI logo masthead must be in the page');
  assert.equal((await fetch(base + '/journey-assets/myownai-logo.png')).status, 200, 'The logo asset must be served');
  // The beta package omits every demo video; the public package keeps exactly the walkthrough tour (presenter samples stay omitted).
  if (evaluation) assert.doesNotMatch(page, /src="\/journey-assets\/[^\"]+\.mp4/);
  else {
    assert.match(page, /src="\/journey-assets\/walkthrough-v8\.mp4(?:\?[^"]*)?"/, 'the public package keeps the walkthrough tour');
    assert.doesNotMatch(page, /src="\/journey-assets\/sample-[^\"]+\.mp4/, 'presenter samples are Pro demos and stay omitted');
    assert.equal((await fetch(base + '/journey-assets/walkthrough-v8.mp4', { method: 'HEAD' })).status, 200, 'the walkthrough must be served');
  }
  const journey = await (await fetch(base + '/v1/journey?workspace=' + slug, { headers: auth })).json();
  assert.equal(journey.pro.active, false); assert.equal(journey.model.localRescue, false);
  const state = await (await fetch(base + '/v1/state?workspace=' + slug, { headers: auth })).json();
  assert.equal(state.analytics.available, false);
  const engagement = await (await fetch(base + '/v1/engagement?workspace=' + slug, { headers: auth })).json();
  assert.equal(engagement.available, false); assert.deepEqual(engagement.items, []);
  const guide = await fetch(base + '/guide'); assert.equal(guide.status, 200);
  assert.match(await guide.text(), /Free MIT/);
  // Protected artifact access still works in Free; exercise real HTTP bytes and reload.
  const id = '20260913-free-fixture', dir = join(root, 'workdir/videos', id);
  mkdirSync(dir, { recursive: true });
  atomicJson(join(dir, 'meta.json'), { id, edition: 'daily-roundup', status: 'pending_review', createdBy: 'owner' });
  const bytes = Buffer.from('synthetic range fixture'); writeFileSync(join(dir, 'final.mp4'), bytes);
  const media = await fetch(base + '/v1/packages/' + id + '/artifact/final.mp4?workspace=' + slug, { headers: { ...auth, range: 'bytes=0-8' } });
  assert.equal(media.status, 206); assert.equal(await media.text(), 'synthetic');
  checks.push('Loopback app, authentication, Free state, guide and protected byte-range artifact access pass');
  const evidence = { checkedAt: new Date().toISOString(), checks, passed: checks.length, outwardCalls, limits: ['Synthetic HTTP artifact bytes are not a playable video', 'No real model, synthesis, publication, hosted account or native Windows qualification'] };
  atomicJson(join(CODE_ROOT, 'workdir/free-evaluation-check.json'), evidence);
  console.log(JSON.stringify(evidence, null, 2));
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
