import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

// Exercise only an extracted Free package and its disposable loopback workspace.
const candidate = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
assert.equal(JSON.parse(readFileSync(join(candidate, 'config/distribution.json'), 'utf8')).edition, 'free');
const out = join(candidate, 'workdir/free-personalize-check'); mkdirSync(out, { recursive: true });
for (const key of ['HARNESS_WORKSPACE', 'HARNESS_TOKEN', 'HARNESS_WORKFLOW_PACK']) delete process.env[key];
process.env.HARNESS_IDENTITY_FILE = join(out, 'identity.json');
const load = relative => import(pathToFileURL(join(candidate, relative)).href);
const ws = await load('src/workspaces.ts');
const slug = 'free-personalize-' + Date.now(); ws.createWorkspace(slug, false, candidate);
const root = ws.workspaceRoot(candidate, slug), token = ws.localToken(root);
process.env.HARNESS_WORKSPACE = slug; process.env.HARNESS_TOKEN = token;
const personalizationPath = join(root, 'config/personalization.json');
const savedPreferences = existsSync(personalizationPath) ? readFileSync(personalizationPath, 'utf8') : null;
const originalFetch = globalThis.fetch;
// Provider discovery may fail normally when no writer is configured. This UI check never
// reaches any external service or generation endpoint, even if the operator has credentials.
let blockedProviderRequests = 0;
globalThis.fetch = async () => { blockedProviderRequests++; throw new Error('Provider access disabled during Free layout fixture'); };
const { createControlServer } = await load('src/control.ts');
const server = createControlServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
const errors = [], receipts = [];
const deadline = setTimeout(() => { void browser.close(); server.closeAllConnections(); server.close(); }, 55000);
try {
  for (const [width, height] of [[1440, 1000], [390, 844], [320, 568]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await page.goto(base + '/journey?workspace=' + slug + '#token=' + token);
    await page.waitForFunction(() => window.journeyReady === true && document.querySelector('#proStatusLine').textContent.includes('planned'), null, { timeout: 15000 });
    await page.locator('[data-stage-go="personalize"]').first().click();
    const pro = page.locator('#freeProOptions'), editorial = page.locator('#freeEditorialOptions');
    assert.equal(await pro.evaluate(el => el.open), false);
    assert.equal(await editorial.evaluate(el => el.open), false);
    assert.equal(await page.locator('#continueFree').isVisible(), true);
    assert.equal(await page.locator('#personalizeForm').isVisible(), false);
    assert.equal(await page.locator('#castForm').isVisible(), false);
    assert.equal(await page.locator('#vocabularyPanel').isVisible(), false);
    const geometry = await page.evaluate(() => ({
      stageHeight: document.querySelector('#personalizeStage').getBoundingClientRect().height,
      continueBottom: document.querySelector('#continueFree').getBoundingClientRect().bottom,
      viewportHeight: innerHeight, pageWidth: document.documentElement.scrollWidth, width: innerWidth,
    }));
    assert.ok(geometry.stageHeight <= 850, JSON.stringify(geometry));
    assert.ok(geometry.continueBottom <= geometry.viewportHeight + (width === 320 ? 100 : 0), 'Continue with Free is visible, or within a short scroll on a compact phone');
    assert.ok(geometry.pageWidth <= geometry.width, 'No horizontal overflow');
    await page.screenshot({ path: join(out, 'collapsed-' + width + '.png'), fullPage: true });
    const summary = pro.locator(':scope > summary');
    await summary.focus(); await page.keyboard.press('Enter');
    assert.equal(await pro.evaluate(el => el.open), true, 'Native summary opens with keyboard');
    for (const selector of ['#chooseLogo', '#createLogo', '#designOutLoud', '[data-suggest-brand="tagline"]', '[data-suggest-brand="footer"]']) {
      assert.equal(await page.locator(selector).count(), 1);
      assert.equal(await page.locator(selector).isVisible(), true);
      assert.equal(await page.locator(selector).isDisabled(), true);
    }
    assert.equal(await page.locator('#personalizeForm [name=fontPairing]').isDisabled(), false);
    assert.equal(await page.locator('#personalizeForm [name=fontPairing]').inputValue(), '');
    assert.equal(await page.locator('#personalizeForm [name=fontPairing] option[value=serif]').evaluate(el => el.disabled), true);
    assert.equal(await page.locator('#proStart').isVisible(), false);
    assert.equal(await page.locator('#proKey').isVisible(), false);
    assert.equal(await page.locator('#personalizeForm').evaluate(form => form.elements.logoUpload.form === form && form.elements.styleDirection.form === form), true);
    await summary.focus(); await page.keyboard.press('Enter');
    assert.equal(await pro.evaluate(el => el.open), false);
    const editorialSummary = editorial.locator(':scope > summary');
    await editorialSummary.focus(); await page.keyboard.press('Space');
    assert.equal(await editorial.evaluate(el => el.open), true);
    assert.equal(await page.locator('#saveVocabulary').isEnabled(), true);
    assert.equal(await page.locator('#saveVocabulary').evaluate(el => el.form), null, 'Topic editing does not submit personalization');
    if (width === 1440) {
      await page.locator('#vocabAreas').fill('Sports');
      await page.locator('#vocabVerticals').fill('Local audience');
      await page.locator('#saveVocabulary').click();
      await page.waitForFunction(() => document.querySelector('#vocabularyStatus').textContent.startsWith('✓'), null, { timeout: 10000 });
    }
    await page.screenshot({ path: join(out, 'topics-' + width + '.png'), fullPage: true });
    await editorialSummary.focus(); await page.keyboard.press('Space');
    assert.equal(await editorial.evaluate(el => el.open), false);
    await page.locator('#continueFree').click();
    assert.equal(await page.locator('#createStage').isVisible(), true, 'Continue uses the existing preview journey');
    await page.locator('[data-stage-go="personalize"]').first().click();
    await page.evaluate(() => window.openPro());
    assert.equal(await pro.evaluate(el => el.open), true, 'Existing Pro navigation expands its parent');
    assert.equal(await page.locator('#proPanel').isVisible(), true);
    receipts.push({ width, ...geometry, keyboardOpenClose: true, defaultsPreserved: true, proLocked: true, editorialAvailable: true, continueWorks: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(existsSync(personalizationPath) ? readFileSync(personalizationPath, 'utf8') : null, savedPreferences, 'Exploring options or continuing does not save preferences');
  const receipt = { checkedAt: new Date().toISOString(), receipts, errors, blockedProviderRequests, generationCalls: 0, publication: 'disabled', preferencesUnchanged: true };
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally {
  clearTimeout(deadline); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  globalThis.fetch = originalFetch;
}
