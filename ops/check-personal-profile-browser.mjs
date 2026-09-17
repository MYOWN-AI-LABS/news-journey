import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { chromium } from 'playwright';

// Run against either the private checkout or an extracted Free candidate. Every mutation
// below uses the real control worker, restricted to this disposable workspace's profile.
const candidate = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(process.argv[3] || join(candidate, 'workdir', `personal-profile-browser-${stamp}`));
mkdirSync(out, { recursive: true });
const load = relative => import(pathToFileURL(join(candidate, relative)).href);
const { atomicJson } = await load('src/workspaces.ts');
const { createControlServer, workerAction } = await load('src/control.ts');
const { callHarnessTool, harnessApi } = await load('src/connector-tools.ts');
const { readPersonalProfile, personalWritingGuidance } = await load('src/personal-profile.ts');
const { releaseProfile } = await load('src/release-profile.ts');
mkdirSync(join(candidate, 'workspaces'), { recursive: true });
const root = mkdtempSync(join(candidate, 'workspaces/personal-profile-browser-'));
const workspace = basename(root), token = randomBytes(32).toString('hex'), viewerToken = randomBytes(32).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
cpSync(join(candidate, 'config'), join(root, 'config'), { recursive: true });
for (const file of ['personal-profile.json', 'personalization.json', 'cast.json']) rmSync(join(root, 'config', file), { force: true });
for (const dir of ['state', 'workdir/videos/failed-profile-fixture', 'workdir/newsletters', 'workdir/harvest']) mkdirSync(join(root, dir), { recursive: true });
atomicJson(join(root, 'workspace.json'), { id: workspace, name: 'Personal preferences browser fixture' });
atomicJson(join(root, 'members.json'), [{ id: 'owner', role: 'owner', tokenHash: hash(token) }, { id: 'viewer', role: 'viewer', tokenHash: hash(viewerToken) }]);
atomicJson(join(root, 'desks.json'), {});
atomicJson(join(root, 'config/memory.json'), { publicationId: 'sports-browser-fixture' });
atomicJson(join(root, 'config/publisher.json'), { publication: 'Sports Fixture', name: 'Fixture Editor', audience: 'Sports readers', tone: 'Clear and factual' });
atomicJson(join(root, 'config/sources.json'), { enabledSources: ['rss'], editorial: { preferredTopics: ['Sports'], excludedTopics: [], selectionNotes: '', areas: { focusAreas: ['sports'], verticals: ['general'] } }, rss: [{ url: 'https://news.example.org/sports.xml' }] });
atomicJson(join(root, 'state/use-case.json'), { description: 'current events in sports', configuredDescription: 'current events in sports', sourceMode: 'auto', configuredSourceMode: 'auto', trustedSources: '' });
atomicJson(join(root, 'state/journey-brief.json'), { description: 'current events in sports' });
atomicJson(join(root, 'workdir/videos/failed-profile-fixture/error.json'), { error: 'Original failed fixture remains unchanged.' });
const protectedPaths = ['config/sources.json', 'config/publisher.json', 'state/use-case.json', 'state/journey-brief.json', 'workdir/videos/failed-profile-fixture/error.json'];
const originalHashes = Object.fromEntries(protectedPaths.map(path => [path, hash(readFileSync(join(root, path)))]));
const actions = [], browserErrors = [], unexpectedDialogs = [], blockedBrowserRequests = [], screenshots = [], checks = [];
const allowed = ['personal-profile-save', 'personal-profile-correct', 'personal-profile-forget', 'personal-profile-clear'];
const server = createControlServer({ codeRoot: candidate, mutate: async (selectedRoot, selectedToken, input) => {
  assert.equal(selectedRoot, root); assert.equal(selectedToken, token);
  assert.ok(allowed.includes(input.operation), `Browser fixture refuses any other mutation: ${input.operation}`);
  actions.push(input.operation);
  return workerAction(selectedRoot, selectedToken, input);
} });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
page.on('pageerror', error => browserErrors.push(error.message));
page.on('dialog', dialog => { unexpectedDialogs.push(dialog.type()); void dialog.dismiss(); });
const confinedBrowserRequest = route => {
  const url = new URL(route.request().url());
  if (url.origin === base || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
  blockedBrowserRequests.push({ origin: url.origin, method: route.request().method() });
  return route.abort();
};
await page.route('**/*', confinedBrowserRequest);
const profileFile = join(root, 'config/personal-profile.json');
const readSaved = () => readPersonalProfile(root);
const profileField = name => page.locator(`#personalProfileForm [name=${name}]`);
const correctionField = name => page.locator(`#personalCorrectionForm [name=${name}]`);
async function openProfile() {
  await page.locator('[data-stage-go=personalize]').first().click();
  await page.locator('#personalProfilePanel').waitFor({ state: 'visible' });
  if (!await page.locator('#personalProfilePanel').evaluate(el => el.open)) await page.locator('#personalProfilePanel > summary').click();
  await page.waitForFunction(() => document.querySelector('#personalCorrectionForm [name=category]').options.length === 6);
}
async function waitSaved(message) {
  await page.waitForFunction(text => document.getElementById('personalProfileStatus').textContent.includes(text) && !busy, message, { timeout: 25000 });
  assert.equal(await page.locator('#personalProfileStatus').getAttribute('data-error'), 'false');
}
async function api(path, actorToken = token, options = {}) {
  return fetch(`${base}${path}?workspace=${encodeURIComponent(workspace)}`, { ...options, headers: { authorization: `Bearer ${actorToken}`, ...options.headers }, signal: AbortSignal.timeout(20000) });
}
const about = 'Haines City, Orlando and Tampa are in my personal background. PROFILE_BACKGROUND_FIXTURE is not a news topic.';
const note = '<img src=x onerror="window.profileXssExecuted=true"> CORRECTION_NOTE_FIXTURE must remain inert text.';
let receipt;
try {
  await page.goto(`${base}/journey?workspace=${workspace}#token=${token}`);
  await page.waitForFunction(() => window.journeyReady === true);
  assert.equal(await page.locator('#quickForm [name=description]').inputValue(), 'current events in sports');
  await openProfile();
  assert.equal(await profileField('enabled').isChecked(), false);
  assert.equal(await profileField('about').inputValue(), '');
  assert.equal(existsSync(profileFile), false);
  await page.locator('[data-stage-go=describe]').first().click();
  assert.equal(await page.locator('#quickStartCreate').isEnabled(), true);
  assert.equal(actions.length, 0); assert.equal(existsSync(profileFile), false);
  checks.push('skip keeps profile empty and off');

  await openProfile();
  await profileField('enabled').check(); await profileField('about').fill(about);
  await profileField('explanation').selectOption('plain'); await profileField('detail').selectOption('brief');
  await page.locator('#personalProfileForm button[type=submit]').click(); await waitSaved('Preferences saved');
  assert.equal(readSaved().about, about); assert.equal(readSaved().enabled, true); assert.equal(readSaved().explanation, 'plain');
  assert.equal(personalWritingGuidance(readSaved()).includes('Haines City'), false);
  await page.reload(); await page.waitForFunction(() => window.journeyReady === true); await openProfile();
  assert.equal(await profileField('about').inputValue(), about); assert.equal(await profileField('enabled').isChecked(), true);
  checks.push('real worker save persists through reload without importing background topics');

  await profileField('about').fill('UNSAVED_BACKGROUND_FIXTURE');
  await page.evaluate(async () => { await refresh(); });
  assert.equal(await profileField('about').inputValue(), 'UNSAVED_BACKGROUND_FIXTURE');
  assert.equal(readSaved().about, about);
  await profileField('about').fill(about); await page.locator('#personalProfileForm button[type=submit]').click(); await waitSaved('Preferences saved');
  await page.locator('#personalCorrectionPanel > summary').click();
  await correctionField('category').selectOption('source-date'); await correctionField('note').fill('UNSAVED_CORRECTION_FIXTURE');
  await page.evaluate(async () => { await refresh(); });
  assert.equal(await correctionField('note').inputValue(), 'UNSAVED_CORRECTION_FIXTURE');
  assert.equal(await correctionField('category').inputValue(), 'source-date');
  checks.push('unsaved profile and correction inputs survive a status refresh');

  await correctionField('category').selectOption('length'); await correctionField('note').fill('');
  await page.locator('#personalCorrectionForm button[type=submit]').click(); await waitSaved('Correction saved');
  assert.equal(readSaved().corrections.length, 1); assert.equal(readSaved().corrections[0].note, '');
  assert.match(await page.locator('#personalCorrectionList').textContent(), /No additional note/);
  await correctionField('category').selectOption('source-conditions'); await correctionField('note').fill(note);
  await page.locator('#personalCorrectionForm button[type=submit]').click(); await waitSaved('Correction saved');
  assert.equal(readSaved().corrections.length, 2); assert.equal(readSaved().corrections[1].note, note);
  assert.equal(await page.locator('#personalCorrectionList img').count(), 0);
  assert.equal(await page.evaluate(() => window.profileXssExecuted === true), false);
  assert.equal(personalWritingGuidance(readSaved()).includes('CORRECTION_NOTE_FIXTURE'), false);
  checks.push('category-only correction saves and optional note is inert display text');

  const ownerView = await api('/v1/personal-profile'); assert.equal(ownerView.status, 200);
  assert.equal((await ownerView.json()).saved.about, about);
  const viewerView = await api('/v1/personal-profile', viewerToken); assert.equal(viewerView.status, 403);
  const viewerPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    viewerPage.on('pageerror', error => browserErrors.push('viewer: ' + error.message));
    await viewerPage.route('**/*', confinedBrowserRequest);
    await viewerPage.goto(`${base}/journey?workspace=${workspace}#token=${viewerToken}`);
    await viewerPage.waitForFunction(() => window.journeyReady === true);
    await viewerPage.locator('[data-stage-go=create]').first().click();
    assert.equal(await viewerPage.locator('#rememberPreviewMistake').isVisible(), false);
    await viewerPage.locator('[data-stage-go=personalize]').first().click();
    assert.equal(await viewerPage.locator('#personalProfilePanel').isVisible(), false);
  } finally { await viewerPage.close(); }
  const generalState = await (await api('/v1/state')).text(), journeyState = await (await api('/v1/journey')).text();
  for (const text of [generalState, journeyState]) assert.doesNotMatch(text, /PROFILE_BACKGROUND_FIXTURE|CORRECTION_NOTE_FIXTURE/);
  const connector = { root, token, api: harnessApi(base, workspace, token), connection: 'personal-profile-browser' };
  for (const tool of ['harness_setup', 'harness_status', 'harness_persona']) {
    const result = await callHarnessTool(connector, tool, {});
    assert.doesNotMatch(JSON.stringify(result), /PROFILE_BACKGROUND_FIXTURE|CORRECTION_NOTE_FIXTURE/);
  }
  checks.push('viewer read denied and manager-only controls hidden; ordinary HTTP/MCP state excludes personal text');

  const countBeforeRejectedShare = actions.length;
  for (const operation of ['personal-profile-share', 'personal-profile-unshare']) {
    const response = await api(`/v1/journey/${operation}`, token, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `no-click-${operation}` }, body: JSON.stringify({ expectedRevision: readSaved().revision, targets: ['codex'] }) });
    assert.equal(response.status, 403); assert.match((await response.json()).error, /explicit local browser click/);
  }
  assert.equal(actions.length, countBeforeRejectedShare);
  checks.push('agent share and removal rejected before worker dispatch without explicit local click');

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.locator('#personalProfilePanel').evaluate(el => el.scrollIntoView({ block: 'start' }));
    const bounds = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(bounds.document <= bounds.width, `Horizontal overflow: ${JSON.stringify(bounds)}`);
    const path = join(out, `personal-profile-${width}.png`);
    await page.screenshot({ path });
    screenshots.push({ width, kind: 'viewport', path, sha256: hash(readFileSync(path)) });
    const panelPath = join(out, `personal-profile-panel-${width}.png`);
    await page.locator('#personalProfilePanel').screenshot({ path: panelPath });
    screenshots.push({ width, kind: 'expanded-profile', path: panelPath, sha256: hash(readFileSync(panelPath)) });
  }
  checks.push('expanded personal preferences fit desktop, phone and 320-pixel widths');
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.locator('#personalCorrectionList .card').first().getByRole('button', { name: 'Forget this correction', exact: true }).click(); await waitSaved('correction was removed');
  assert.equal(readSaved().corrections.length, 1);
  await page.locator('#personalCorrectionList .card').first().getByRole('button', { name: 'Forget this correction', exact: true }).click(); await waitSaved('correction was removed');
  assert.equal(readSaved().corrections.length, 0);
  assert.equal(readFileSync(profileFile, 'utf8').includes('CORRECTION_NOTE_FIXTURE'), false);
  await page.locator('#personalProfileClearForm summary').click();
  await page.locator('#personalProfileClearForm button[type=submit]').click(); await waitSaved('Saved personal information');
  const cleared = readSaved();
  assert.equal(cleared.enabled, false); assert.equal(cleared.about, ''); assert.equal(cleared.explanation, ''); assert.equal(cleared.detail, ''); assert.deepEqual(cleared.corrections, []);
  assert.doesNotMatch(readFileSync(profileFile, 'utf8'), /PROFILE_BACKGROUND_FIXTURE|CORRECTION_NOTE_FIXTURE/);
  assert.equal(await profileField('about').inputValue(), ''); assert.equal(await profileField('enabled').isChecked(), false);
  for (const path of protectedPaths) assert.equal(hash(readFileSync(join(root, path))), originalHashes[path], `Unrelated saved artifact changed: ${path}`);
  for (const file of readdirSync(join(root, 'state/journey-jobs'))) assert.doesNotMatch(readFileSync(join(root, 'state/journey-jobs', file), 'utf8'), /PROFILE_BACKGROUND_FIXTURE|CORRECTION_NOTE_FIXTURE/);
  checks.push('forget and clear remove personal text while brief, sources, publisher, failed artifacts and generic job receipts remain intact');
  assert.deepEqual(browserErrors, []); assert.deepEqual(unexpectedDialogs, []);
  receipt = { passed: true, candidate, edition: releaseProfile(candidate).edition, checkedAt: new Date().toISOString(), checks, screenshots, actions, browserErrors, blockedBrowserRequests,
    protectedHashes: originalHashes, scope: 'Disposable workspace; real control server and worker. No model generation, newsletter quality, live MCP client, hosted isolation or actual agent-file write is qualified by this check.',
    actualGlobalAgentWrites: 0, generatedEditions: 0, published: false };
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks: checks.length, actions: actions.length, screenshots: screenshots.length, out }));
} catch (error) {
  const failureScreenshot = join(out, 'failure.png');
  try { await page.screenshot({ path: failureScreenshot, fullPage: true }); } catch { /* Preserve the primary error if Chromium already stopped. */ }
  writeFileSync(join(out, 'receipt.json'), JSON.stringify({ passed: false, candidate, checkedAt: new Date().toISOString(), checks, screenshots, actions, browserErrors, error: String(error?.stack || error), failureScreenshot }, null, 2) + '\n');
  throw error;
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
  rmSync(root, { recursive: true, force: true });
}
