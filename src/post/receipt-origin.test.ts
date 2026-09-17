import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Exercise real return paths. No browser, credential lookup or network request is allowed.
const child = String.raw`
  import assert from 'node:assert/strict';
  import { mock } from 'node:test';
  import { readFileSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import http from 'node:http'; import https from 'node:https';
  import { syncBuiltinESMExports } from 'node:module';
  const mode = process.env.RECEIPT_FIXTURE, temp = process.env.RECEIPT_TEMP;
  const source = new URL('./src/', 'file://' + process.cwd() + '/');
  const noNetwork = () => { throw new Error('No external I/O is allowed in receipt fixtures'); };
  globalThis.fetch = noNetwork; globalThis.WebSocket = class { constructor() { noNetwork(); } };
  http.request = noNetwork; http.get = noNetwork; https.request = noNetwork; https.get = noNetwork; syncBuiltinESMExports();
  const title = 'Shared title prefix with a different earlier story';
  const script = { publish: { title, description: 'Current approved source story.', hashtags: ['#fixture'] } };
  writeFileSync(join(temp, 'script.json'), JSON.stringify(script));
  writeFileSync(join(temp, 'final.mp4'), Buffer.from('fixture-video'));
  let apiRequests = [], submitted = false, closed = false, searches = 0, responses = 0, identityRead = false;
  const existing = mode.endsWith('-existing');
  const platform = mode.split('-')[0];
  const found = () => existing || submitted;
  function locator(key) {
    const value = {
      first: () => value, nth: () => value,
      locator: selector => locator(selector), getByText: text => locator('text:' + text),
      count: async () => { if (key === 'article') { searches++; return found() ? 1 : 0; } return 1; },
      textContent: async () => key === 'article' ? title : '',
      allTextContents: async () => [],
      getAttribute: async () => key.includes('Profile_Link') ? '/fixture' : '/fixture/status/123',
      isDisabled: async () => false,
      waitFor: async () => {}, fill: async () => {}, setInputFiles: async () => {},
      click: async () => { if (/tweetButtonInline|inner-post-submit-button|^text:Post$/.test(key)) submitted = true; },
    };
    return value;
  }
  const page = {
    url: () => 'https://fixture.invalid/home', on: () => {},
    goto: async () => {}, waitForTimeout: async () => {}, waitForURL: async () => {},
    locator, getByRole: (role, options) => locator('role:' + options.name),
    keyboard: { press: async () => {} },
    waitForEvent: async () => ({ setFiles: async () => {} }),
    waitForResponse: async () => {
      responses++;
      return { ok: () => true, status: () => 200,
        json: async () => mode === 'threads-response' ? { media: { code: 'new456', permalink: 'https://www.threads.com/@fixture/post/new456' } } : {} };
    },
    evaluate: async (fn, arg) => {
      if (!identityRead) { identityRead = true; return 'fixture'; }
      if (arg === undefined) return undefined; // Composer file-input click.
      searches++;
      if (!found()) return null;
      return platform === 'reddit' ? { id: 'old123', permalink: '/r/test/comments/old123/title/' } : '/@fixture/post/old123';
    },
  };
  mock.module('playwright', { namedExports: { chromium: {
    launchPersistentContext: async () => ({ pages: () => [page], close: async () => { closed = true; } }),
  } } });
  mock.module(new URL('workspaces.ts', source), { namedExports: { profilePath: () => join(temp, 'profile'), safeId: value => { assert.match(value, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/); return value; } } });
  mock.module(new URL('util.ts', source), { namedExports: {
    readJson: path => JSON.parse(readFileSync(path, 'utf8')), videoDir: () => temp,
    loadConfig: () => ({}), todayStamp: () => '2026-09-14', log: () => {},
    fetchWithTimeout: async (url, options) => {
      assert.equal(mode, 'x-response'); apiRequests.push({ url, method: options?.method });
      if (url.endsWith('/media/upload/initialize')) return Response.json({ data: { id: 'upload-123' } });
      if (url.endsWith('/append') || url.endsWith('/finalize')) return Response.json({});
      if (url.includes('command=STATUS')) return Response.json({ data: { processing_info: { state: 'succeeded' } } });
      assert.equal(url, 'https://api.x.com/2/tweets'); assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).text, title + '\n\n#fixture');
      submitted = true; return Response.json({ data: { id: 'new456' } });
    },
  } });
  mock.module(new URL('auth/x.ts', source), { namedExports: { xAccess: async () => 'synthetic-fixture-token' } });
  const meta = { id: '20260914-receipt-fixture' };
  let result;
  if (mode === 'x-response') result = await (await import(new URL('post/x.ts', source))).postX(meta);
  else {
    const exports = await import(new URL('post/' + platform + '-browser.ts', source));
    const name = { x: 'postXBrowser', threads: 'postThreadsBrowser', reddit: 'postRedditBrowser' }[platform];
    result = await exports[name](meta);
    assert.equal(closed, true);
  }
  assert.equal(result.platform, platform);
  assert.equal(result.receiptOrigin, mode.endsWith('-response') ? 'provider-response' : 'profile-discovery');
  assert.equal(submitted, !existing, 'A prior match must not cause a new submission');
  if (mode === 'x-response') { assert.equal(result.id, 'new456'); assert.equal(apiRequests.length, 5); }
  else {
    assert.ok(searches >= (existing ? 1 : mode === 'threads-response' ? 1 : 2));
    assert.equal(apiRequests.length, 0);
    if (platform === 'threads' && !existing) assert.equal(responses, 2);
  }
  process.stdout.write('RECEIPT_ORIGIN_PASSED');
`;

for (const mode of ['x-existing', 'x-after-click', 'threads-existing', 'threads-after-click', 'threads-response', 'reddit-existing', 'reddit-after-click', 'x-response']) {
  test(`${mode}: actual adapter keeps discovery distinct from submission response`, () => {
    const temp = mkdtempSync(join(tmpdir(), 'receipt-origin-'));
    try {
      // Browser adapter lock files and profiles are confined to this test's private temporary tree.
      mkdirSync(join(temp, 'tmp'));
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
      const output = execFileSync(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', child], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 30000,
        env: { ...env, HOME: temp, TMPDIR: join(temp, 'tmp'), TMP: join(temp, 'tmp'), TEMP: join(temp, 'tmp'), RECEIPT_FIXTURE: mode, RECEIPT_TEMP: temp },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.match(output, /RECEIPT_ORIGIN_PASSED/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}
