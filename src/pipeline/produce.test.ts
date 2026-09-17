import assert from 'node:assert/strict';
import test from 'node:test';
import { completeCompanionNewsletter } from './produce.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

test('failed newsletter length makes the edition fail with its exact package and original cause', async () => {
  const cause = new Error('Newsletter has 365 words; needs 900–1300');
  await assert.rejects(completeCompanionNewsletter(['20260914-sports'], 'daily-roundup', async (day, rerender, edition, videoId) => {
    assert.deepEqual({ day, rerender, edition, videoId }, { day: '2026-09-14', rerender: false, edition: 'daily-roundup', videoId: '20260914-sports' });
    throw cause;
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, cause);
    assert.match(error.message, /Edition incomplete.*20260914-sports.*output is saved.*365 words; needs 900–1300/);
    return true;
  });
});

test('companion generation never guesses between same-day packages', async () => {
  let calls = 0;
  for (const ids of [[], ['20260914-sports', '20260914-cities']]) {
    await assert.rejects(completeCompanionNewsletter(ids, undefined, async () => { calls++; return 'wrong.html'; }), /one exact completed video package/);
  }
  assert.equal(calls, 0);
  await completeCompanionNewsletter(['20260914-sports'], undefined, async (_day, _rerender, _edition, id) => { calls++; return `${id}.html`; });
  assert.equal(calls, 1);
});

test('the actual completed-video guard retries a failed companion without rerunning media or weakening the selected length', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(join(root, 'workspaces'), { recursive: true });
  const workspace = mkdtempSync(join(root, 'workspaces', 'test-companion-guard-'));
  const slug = workspace.split(/[\\/]/).at(-1)!;
  const token = 'f'.repeat(64), day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const id = `${day.replaceAll('-', '')}-sports`;
  const save = (path: string, value: unknown) => writeFileSync(join(workspace, path), JSON.stringify(value));
  try {
    mkdirSync(join(workspace, 'config/editions'), { recursive: true });
    mkdirSync(join(workspace, 'workdir/videos', id), { recursive: true });
    save('workspace.json', { id: slug });
    save('members.json', [{ id: 'test-owner', role: 'owner', tokenHash: createHash('sha256').update(token).digest('hex') }]);
    save('config/pipeline.json', { autonomy: 'review', topicsPerRun: 1 });
    const edition = JSON.parse(readFileSync(join(root, 'config/editions/daily-roundup.json'), 'utf8'));
    save('config/editions/daily-roundup.json', edition);
    save(`workdir/videos/${id}/meta.json`, { id, status: 'pending_review', edition: 'daily-roundup' });
    writeFileSync(join(workspace, 'workdir/videos', id, 'final.mp4'), 'completed-video-fixture');
    const script = `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { produce } from ${JSON.stringify(new URL('./produce.ts', import.meta.url).href)};
      const root = ${JSON.stringify(workspace)}, id = ${JSON.stringify(id)}, day = ${JSON.stringify(day)};
      let calls = 0;
      const failed = async (actualDay, rerender, edition, videoId) => {
        calls++;
        assert.deepEqual({ actualDay, rerender, edition, videoId }, { actualDay: day, rerender: false, edition: undefined, videoId: id });
        throw new Error('Newsletter has 365 words; needs 900–1300');
      };
      for (const status of ['pending_review', 'approved', 'posted']) {
        writeFileSync(join(root, 'workdir/videos', id, 'meta.json'), JSON.stringify({ id, status, edition: 'daily-roundup' }));
        for (let attempt = 0; attempt < 2; attempt++) {
          await assert.rejects(produce({}, failed), /Edition incomplete.*365 words; needs 900–1300/);
          assert.equal(readFileSync(join(root, 'workdir/videos', id, 'final.mp4'), 'utf8'), 'completed-video-fixture');
          assert.equal(JSON.parse(readFileSync(join(root, 'workdir/videos', id, 'meta.json'), 'utf8')).status, status);
        }
      }
      assert.equal(calls, 6);
      await produce({ until: 'rank' }, failed);
      assert.equal(calls, 6, 'an explicit partial-stage request does not add companion generation');
      await produce({}, async (_day, _rerender, _edition, videoId) => { calls++; assert.equal(videoId, id); return 'completed-newsletter.html'; });
      assert.equal(calls, 7);
      const requestPath = join(root, 'workdir/videos', id, 'writing-request.json');
      const videoRequest = JSON.stringify({ outputs: 'video', parentIdentity: 'original-video-parent' });
      writeFileSync(requestPath, videoRequest);
      for (const status of ['pending_review', 'approved', 'posted']) {
        writeFileSync(join(root, 'workdir/videos', id, 'meta.json'), JSON.stringify({ id, status, edition: 'daily-roundup' }));
        await produce({}, failed);
        assert.equal(calls, 7, 'an implicit completed-video resume must not add an unrequested newsletter');
        assert.equal(readFileSync(requestPath, 'utf8'), videoRequest, 'saved output scope and parent stay byte-exact');
      }
      writeFileSync(requestPath, JSON.stringify({ outputs: 'edition', parentIdentity: 'original-edition-parent' }));
      await assert.rejects(produce({}, failed), /Edition incomplete.*365 words; needs 900–1300/);
      assert.equal(calls, 8, 'a saved edition still retries its unfinished exact companion');
      await produce({ until: 'script' }, failed);
      assert.equal(calls, 8, 'a stop-after request does not finish a newsletter on the completed-video shortcut');
      process.stdout.write('EXACT_COMPANION_GUARD_PASSED');
    `;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, HARNESS_WORKSPACE: slug, HARNESS_TOKEN: token } });
    assert.match(output, /EXACT_COMPANION_GUARD_PASSED/);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

/** Module mocks replace external work, not producer control flow or the actual receipt validator.
 * Each child has an authenticated disposable workspace and refuses all HTTP. */
function runProducerRoutingFixture(program: string): string {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(join(root, 'workspaces'), { recursive: true });
  const workspace = mkdtempSync(join(root, 'workspaces', 'test-producer-routing-'));
  const slug = workspace.split(/[\\/]/).at(-1)!, token = 'e'.repeat(64);
  try {
    mkdirSync(join(workspace, 'config/editions'), { recursive: true });
    writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({ id: slug }));
    writeFileSync(join(workspace, 'members.json'), JSON.stringify([{ id: 'fixture-owner', role: 'owner', tokenHash: createHash('sha256').update(token).digest('hex') }]));
    writeFileSync(join(workspace, 'config/pipeline.json'), JSON.stringify({ autonomy: 'review', topicsPerRun: 1, ttsEngine:'kokoro', voice:'af_heart' }));
    const edition = JSON.parse(readFileSync(join(root, 'config/editions/daily-roundup.json'), 'utf8'));
    writeFileSync(join(workspace, 'config/editions/daily-roundup.json'), JSON.stringify(edition));
    writeFileSync(join(workspace, 'config/editions/fixture-special.json'), JSON.stringify({ ...edition, editionId: 'fixture-special' }));
    const child = `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import http from 'node:http'; import https from 'node:https';
      import { syncBuiltinESMExports } from 'node:module';
      let networkCalls = 0;
      const noNetwork = () => { networkCalls++; throw new Error('Unexpected real HTTP in producer regression'); };
      globalThis.fetch = noNetwork; http.request = noNetwork; http.get = noNetwork; https.request = noNetwork; https.get = noNetwork; syncBuiltinESMExports();
      const workspace = ${JSON.stringify(workspace)}, source = ${JSON.stringify(new URL('./', import.meta.url).href)};
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
      const originalWriting = await import(new URL('writing-context.ts', source));
      const originalScript = await import(new URL('script.ts', source));
      const save = (path, value) => { mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), JSON.stringify(value)); };
      let selected;
      function seed(name, saved, status = 'selected', edition = 'daily-roundup') {
        rmSync(join(workspace, 'workdir/videos'), { recursive: true, force: true });
        const id = day + '-' + name;
        selected = { id, kind: 'news', headline: 'The city announced a transit pilot', primaryUrl: 'https://example.org/transit', angle: 'The source describes a proposed pilot.' };
        save('input.json', selected); save('workdir/videos/' + id + '/topic.json', selected);
        save('workdir/videos/' + id + '/meta.json', { id, status, edition, posts: {} });
        if (saved) save('workdir/videos/' + id + '/writing-request.json', saved);
        return { id, topicFile: join(workspace, 'input.json'), dir: join(workspace, 'workdir/videos', id) };
      }
      mock.module(new URL('harvest.ts', source), { namedExports: { harvest: async () => {} } });
      const originalRank = await import(new URL('rank.ts', source));
      mock.module(new URL('rank.ts', source), { namedExports: { ...originalRank, rank: async () => [selected] } });
      ${program}
      assert.equal(networkCalls, 0);
      process.stdout.write('PRODUCER_ROUTING_FIXTURE_PASSED');
    `;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    return execFileSync(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', child], {
      cwd: root, encoding: 'utf8', timeout: 25_000,
      env: { ...env, HARNESS_WORKSPACE: slug, HARNESS_TOKEN: token, HARNESS_IDENTITY_FILE: join(workspace, 'identity.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

test('actual producer preserves saved video or edition scope across explicit and automatic resumes', () => {
  const output = runProducerRoutingFixture(`
    const routes = [];
    mock.module(new URL('writing-context.ts', source), { namedExports: { ...originalWriting, packageWritingContext: async (id, outputs) => { routes.push([outputs, id]); throw new Error('STOP_AT_CHOSEN_PREPARATION'); } } });
    mock.module(new URL('newsletter.ts', source), { namedExports: { prepareCompanionText: async () => { throw new Error('Newsletter ran after stopped preparation'); }, newsletter: async () => { throw new Error('Unexpected final newsletter'); } } });
    mock.module(new URL('script.ts', source), { namedExports: { ...originalScript, writeScript: async () => { throw new Error('Writer ran after stopped preparation'); } } });
    const { produce } = await import(new URL('produce.ts', source));
    const cases = [
      { name: 'new-until', expected: 'video', opts: f => ({ topicFile: f.topicFile, until: 'script' }) },
      { name: 'new-daily-fixture', expected: 'video', opts: f => ({ topicFile: f.topicFile }) },
      { name: 'new-full', expected: 'edition', opts: () => ({ force: true }) },
      { name: 'new-special-fixture', edition: 'fixture-special', expected: 'edition', opts: f => ({ topicFile: f.topicFile, edition: 'fixture-special' }) },
      { name: 'saved-video-explicit', saved: 'video', expected: 'video', opts: f => ({ resume: f.id }) },
      { name: 'saved-video-auto', saved: 'video', status: 'awaiting_visual_choice', expected: 'video', opts: () => ({}) },
      { name: 'saved-edition-explicit', saved: 'edition', expected: 'edition', opts: f => ({ resume: f.id, until: 'script' }) },
      { name: 'saved-edition-auto', saved: 'edition', status: 'awaiting_visual_choice', expected: 'edition', opts: () => ({}) },
    ];
    for (const row of cases) {
      const saved = row.saved ? { outputs: row.saved, parentIdentity: 'immutable-' + row.name } : null;
      const f = seed(row.name, saved, row.status, row.edition);
      const before = saved && readFileSync(join(f.dir, 'writing-request.json'), 'utf8');
      const count = routes.length;
      await assert.rejects(produce(row.opts(f)), /STOP_AT_CHOSEN_PREPARATION/);
      assert.deepEqual(routes.slice(count), [[row.expected, f.id]], row.name);
      if (saved) assert.equal(readFileSync(join(f.dir, 'writing-request.json'), 'utf8'), before);
      assert.equal(existsSync(join(f.dir, 'companion-writing-receipt.json')), false);
      assert.match(JSON.parse(readFileSync(join(f.dir, 'meta.json'), 'utf8')).status, /^failed:/);
    }
    const bad = seed('invalid-saved-scope', { outputs: 'both-and-more' });
    const count = routes.length;
    await assert.rejects(produce({ resume: bad.id }), /Saved writing output scope changed/);
    assert.equal(routes.length, count, 'invalid saved scope cannot enter preparation or acquire a new parent');
  `);
  assert.match(output, /PRODUCER_ROUTING_FIXTURE_PASSED/);
});

test('actual producer cannot mint a factual receipt from a structurally returned script or stale resume', () => {
  const output = runProducerRoutingFixture(`
    let writerCalls = 0, assetCalls = 0;
    const script = { hook: 'The city announced a proposed transit pilot.', body: [{ voiceover: 'The city announced a proposed transit pilot.', scene: 'news_card', assetRef: 'og-0', onScreen: { title: 'Proposed transit pilot' }, motion: { kind: 'flow', who: 'City', what: 'Transit pilot', how: 'A proposed bus route', impact: 'Results not measured', status: 'Proposed' } }], cta: 'Subscribe for sourced reporting.', publish: { title: 'Proposed transit pilot', description: 'The city announced a proposal.', linkedinPost: 'The city announced a proposal.', hashtags: [] } };
    const context = () => ({ topic: selected, writerKey: 'fixture-writer', parent: { parentId: selected.id, parentIdentity: 'unchanged-parent' }, call: () => async () => { throw new Error('Unexpected model call'); } });
    mock.module(new URL('writing-context.ts', source), { namedExports: { ...originalWriting, packageWritingContext: async () => context() } });
    mock.module(new URL('newsletter.ts', source), { namedExports: { prepareCompanionText: async () => ({ context: context() }), newsletter: async () => { throw new Error('Unexpected companion'); } } });
    mock.module(new URL('visual-development.ts', source), { namedExports: { ensureSourceVisualDevelopment: async () => ({ version: 1, status: 'ready', concepts: [], failures: [] }) } });
    mock.module(new URL('script.ts', source), { namedExports: { ...originalScript, writeScript: async id => { writerCalls++; save('workdir/videos/' + id + '/script.json', script); return script; } } });
    mock.module(new URL('assets.ts', source), { namedExports: { gatherAssets: async () => { assetCalls++; throw new Error('Assets must not run without a factual receipt'); } } });
    const { produce } = await import(new URL('produce.ts', source));
    for (const resume of [false, true]) for (const legacy of [false, true]) {
      const f = seed('unreviewed-' + Number(resume) + Number(legacy), { outputs: 'video', parentIdentity: 'unchanged-parent' }, resume ? 'awaiting_visual_choice' : 'selected');
      if (resume) save('workdir/videos/' + f.id + '/script.json', script);
      const receiptPath = join(f.dir, 'companion-writing-receipt.json');
      const old = JSON.stringify({ version: 1, scriptHash: 'old-structural-result' });
      if (legacy) writeFileSync(receiptPath, old);
      const before = writerCalls;
      await assert.rejects(produce(resume ? { resume: f.id } : { topicFile: f.topicFile }), /saved video script is not bound/);
      assert.equal(writerCalls, before + Number(!resume), 'resume rejects the existing unreviewed script before any rewrite');
      assert.equal(assetCalls, 0);
      if (legacy) assert.equal(readFileSync(receiptPath, 'utf8'), old, 'producer must not replace a stale receipt with a newly minted pass');
      else assert.equal(existsSync(receiptPath), false, 'only the successful factual writer may issue the receipt');
      assert.equal(JSON.parse(readFileSync(join(f.dir, 'meta.json'), 'utf8')).status, 'failed:script');
      assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'script.json'), 'utf8')), script, 'failure preserves returned or earlier script bytes');
    }
  `);
  assert.match(output, /PRODUCER_ROUTING_FIXTURE_PASSED/);
});

test('a topic file whose earlier package failed continues under the next id when the request changed, keeping the failed receipts', () => {
  const output = runProducerRoutingFixture(`
    const seen = [];
    const context = () => ({ topic: selected, writerKey: 'fixture-writer', parent: { parentId: selected.id, parentIdentity: 'unchanged-parent' }, call: () => async () => { throw new Error('Unexpected model call'); } });
    mock.module(new URL('writing-context.ts', source), { namedExports: { ...originalWriting, packageWritingContext: async () => context() } });
    mock.module(new URL('newsletter.ts', source), { namedExports: { prepareCompanionText: async () => ({ context: context() }), newsletter: async () => { throw new Error('Unexpected companion'); } } });
    mock.module(new URL('visual-development.ts', source), { namedExports: { ensureSourceVisualDevelopment: async () => ({ version: 1, status: 'ready', concepts: [], failures: [] }) } });
    mock.module(new URL('script.ts', source), { namedExports: { ...originalScript, writeScript: async id => { seen.push(id); throw new Error('stop after the id is chosen'); } } });
    const { produce } = await import(new URL('produce.ts', source));
    const f = seed('changed-request', { outputs: 'video', parentIdentity: 'unchanged-parent' }, 'failed:script');
    const failedTopic = readFileSync(join(f.dir, 'topic.json'), 'utf8');
    save('input.json', { ...selected, angle: 'The source now describes a funded pilot.' });
    await assert.rejects(produce({ topicFile: f.topicFile }), /stop after the id is chosen/);
    assert.deepEqual(seen, [f.id + '-2'], 'a changed request after a failure takes the next id');
    assert.equal(readFileSync(join(f.dir, 'topic.json'), 'utf8'), failedTopic, 'the failed package keeps its own topic');
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'meta.json'), 'utf8')).status, 'failed:script');
    assert.equal(JSON.parse(readFileSync(join(f.dir + '-2', 'topic.json'), 'utf8')).angle, 'The source now describes a funded pilot.');
    save('input.json', selected); seen.length = 0;
    await assert.rejects(produce({ topicFile: f.topicFile }), /stop after the id is chosen/);
    assert.deepEqual(seen, [f.id], 'the same request continues in its failed package');

    // The saved writing-request's hashes, not the enriched topic.json, decide 'same request': an identical rerun
    // resumes even after preparation rewrote topic.json (second-read finding). Enrich the on-disk topic and bind the
    // request to the RAW input; the identical rerun must resume, not spawn -3.
    const { roleHash } = await import(new URL('../llm/role-router.ts', source));
    seen.length = 0;
    save('workdir/videos/' + f.id + '/topic.json', { ...selected, storyEvent: 'prepared enrichment that changed the on-disk topic' });
    save('workdir/videos/' + f.id + '/writing-request.json', { outputs: 'video', parentIdentity: 'unchanged-parent', original: selected, originalHash: roleHash(selected) });
    await assert.rejects(produce({ topicFile: f.topicFile }), /stop after the id is chosen/);
    assert.deepEqual(seen, [f.id], 'an identical rerun resumes the failed package by its request hash, not a fresh id, despite the enriched topic.json');
  `);
  assert.match(output, /PRODUCER_ROUTING_FIXTURE_PASSED/);
});

/** The writer fixture represents a successful factual review only when it writes the current
 * real receipt. The companion case above separately rejects returned prose without that proof. */
function parallelProducerFixture(failedBranch: 'script' | 'visuals' | 'newsletter'): string {
  return runProducerRoutingFixture(`
    const failedBranch = ${JSON.stringify(failedBranch)};
    const f = seed('parallel-' + failedBranch, { outputs: 'edition', parentIdentity: 'fixed-parent' });
    const requestBytes = readFileSync(join(f.dir, 'writing-request.json'), 'utf8');
    const script = { hook: 'A proposed transit pilot.', body: [{ voiceover: 'The city announced a proposed transit pilot.', scene: 'news_card', assetRef: 'og-0', onScreen: { title: 'Proposed transit pilot' } }], cta: 'Read the source.', publish: { title: 'Proposed transit pilot', description: 'The city announced a proposal.', linkedinPost: 'The city announced a proposal.', hashtags: [] } };
    const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
    const gates = Object.fromEntries(['script', 'newsletter', 'visuals'].map(name => [name, deferred()]));
    const starts = Object.fromEntries(['script', 'newsletter', 'visuals'].map(name => [name, deferred()]));
    const within = (promise, label) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), 5000);
      promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    const waitFor = async (predicate, label) => {
      const end = Date.now() + 5000;
      while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for ' + label); await new Promise(r => setTimeout(r, 5)); }
    };
    const callers = Object.fromEntries(['script', 'newsletter', 'visual'].map(stage => [stage, async () => { throw new Error('Unexpected model call from ' + stage); }]));
    const contexts = [], routes = [];
    let phase = 1, writerCalls = 0, visualCalls = 0, visualGenerations = 0, newsletterCalls = 0, assets = 0, renders = 0;
    const enter = async name => { if (phase === 1) { starts[name].resolve(); await gates[name].promise; } };
    const visualPath = join(f.dir, 'source-visual-fixture.json');
    const newsletterPath = join(f.dir, 'newsletter-fixture.json');
    mock.module(new URL('writing-context.ts', source), { namedExports: { ...originalWriting, packageWritingContext: async (id, outputs) => {
      routes.push([id, outputs]); assert.equal(id, f.id); assert.equal(outputs, 'edition');
      const context = { topic: selected, writerKey: 'same-writer', parent: { parentId: id, parentIdentity: 'fixed-parent' }, call: stage => callers[stage] };
      contexts.push(context); return context;
    } } });
    mock.module(new URL('script.ts', source), { namedExports: { ...originalScript, writeScript: async (id, options) => {
      writerCalls++; assert.equal(id, f.id); assert.equal(options.topic, contexts.at(-1).topic);
      assert.equal(options.call, callers.script); assert.equal(options.parentIdentity, 'fixed-parent');
      await enter('script');
      if (phase === 1 && failedBranch === 'script') {
        save('workdir/videos/' + id + '/script-tasks.json', { failed: 'factual review', originalSource: selected.primaryUrl });
        throw new Error('SCRIPT_FACT_REVIEW_FAILED');
      }
      save('workdir/videos/' + id + '/script.json', script);
      save('workdir/videos/' + id + '/companion-writing-receipt.json', originalWriting.preparedScriptReceipt(selected, 'same-writer', script));
      return script;
    } } });
    mock.module(new URL('newsletter.ts', source), { namedExports: { prepareCompanionText: async (id, support, context) => {
      newsletterCalls++; assert.equal(id, f.id); assert.equal(support, undefined);
      assert.equal(context, contexts.at(-1), 'newsletter receives the already prepared context, not a second preparation');
      await enter('newsletter');
      assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'script.json'), 'utf8')), script, 'formatting sees the saved accepted script');
      originalWriting.assertPreparedScriptReceipt(JSON.parse(readFileSync(join(f.dir, 'companion-writing-receipt.json'), 'utf8')), selected, 'same-writer', script);
      if (phase === 1 && failedBranch === 'newsletter') throw new Error('NEWSLETTER_FORMATTING_FAILED');
      if (!existsSync(newsletterPath)) writeFileSync(newsletterPath, JSON.stringify({ source: selected.primaryUrl, text: 'Formatted newsletter fixture.' }));
      return { issue: {}, context };
    }, newsletter: async () => { throw new Error('Final newsletter assembly must not run during a failed development branch'); } } });
    mock.module(new URL('visual-development.ts', source), { namedExports: { ensureSourceVisualDevelopment: async (dir, topic, options) => {
      visualCalls++; assert.equal(dir, f.dir); assert.equal(topic, contexts.at(-1).topic);
      assert.equal(options.writerKey, 'same-writer'); assert.equal(options.call, callers.visual);
      assert.equal(options.day, day.slice(0, 4) + '-' + day.slice(4, 6) + '-' + day.slice(6, 8));
      await enter('visuals');
      if (phase === 1 && failedBranch === 'visuals') return { version: 1, status: 'failed', concepts: [], failures: [{ topicId: 'topic-1', sourceUrl: topic.primaryUrl, error: 'VISUAL_FACT_REVIEW_FAILED' }] };
      const identity = JSON.stringify({ topic, writerKey: options.writerKey });
      if (existsSync(visualPath)) assert.equal(JSON.parse(readFileSync(visualPath, 'utf8')).identity, identity, 'only the same source/writer can reuse visual progress');
      else { visualGenerations++; writeFileSync(visualPath, JSON.stringify({ identity, status: 'source-reviewed', narrationAlignment: 'pending' })); }
      return { version: 1, status: 'ready', concepts: [{ status: 'source-reviewed', narrationAlignment: 'pending' }], failures: [] };
    } } });
    mock.module(new URL('assets.ts', source), { namedExports: { gatherAssets: async () => { assets++; throw new Error('STOP_AFTER_SUCCESSFUL_DEVELOPMENT'); } } });
    mock.module(new URL('render.ts', source), { namedExports: { render: async () => { renders++; throw new Error('Unexpected renderer'); } } });
    const { produce } = await import(new URL('produce.ts', source));
    let firstSettled = false;
    const first = produce({ resume: f.id }).then(() => { firstSettled = true; return null; }, error => { firstSettled = true; return error; });
    await within(Promise.all([starts.script.promise, starts.visuals.promise]), 'independent script and visual starts');
    assert.equal(contexts.length, 1); assert.deepEqual(routes, [[f.id, 'edition']]);
    assert.equal(newsletterCalls, 0, 'newsletter formatting must wait for factual script acceptance');
    assert.equal(firstSettled, false); assert.equal(assets, 0); assert.equal(renders, 0);
    const statusPath = join(f.dir, 'development-status.json');
    const initial = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.deepEqual(initial.requested, ['script', 'visuals']);
    assert.deepEqual(initial.outcomes, {});
    if (failedBranch === 'newsletter') {
      gates.script.resolve();
      await within(starts.newsletter.promise, 'newsletter after accepted script');
      assert.equal(visualCalls, 1, 'visuals are already active while text moves to formatting');
      assert.equal(firstSettled, false);
    }
    gates[failedBranch].resolve();
    const failedOutcome = failedBranch === 'visuals' ? 'visuals' : 'script';
    await waitFor(() => JSON.parse(readFileSync(statusPath, 'utf8')).outcomes[failedOutcome]?.status === 'failed', 'failed branch checkpoint');
    assert.equal(firstSettled, false, 'a failed branch cannot abandon the still-pending independent sibling');
    if (failedBranch === 'visuals') {
      gates.script.resolve();
      await within(starts.newsletter.promise, 'formatting survives independent visual failure');
      assert.equal(firstSettled, false, 'producer waits for script-derived formatting after visual failure');
      gates.newsletter.resolve();
    } else gates.visuals.resolve();
    const failure = await within(first, 'producer failure after all sibling results');
    assert.ok(failure instanceof Error); assert.match(failure.message, /(?:FACT_REVIEW|FORMATTING)_FAILED/);
    const final = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(final.parentIdentity, 'fixed-parent'); assert.equal(final.writerKey, 'same-writer');
    for (const name of ['script', 'visuals']) assert.equal(final.outcomes[name].status, name === failedOutcome ? 'failed' : 'complete');
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'meta.json'), 'utf8')).status, 'failed:' + failedBranch, 'formatting failure must not mark the reviewed script as failed');
    assert.equal(newsletterCalls, failedBranch === 'script' ? 0 : 1);
    assert.equal(existsSync(newsletterPath), failedBranch === 'visuals');
    assert.equal(assets, 0, 'no assets after any required branch fails'); assert.equal(renders, 0);
    assert.equal(existsSync(visualPath), failedBranch !== 'visuals');
    assert.equal(existsSync(join(f.dir, 'companion-writing-receipt.json')), failedBranch !== 'script');
    const scriptBytes = failedBranch !== 'script' && readFileSync(join(f.dir, 'script.json'), 'utf8');
    const receiptBytes = failedBranch !== 'script' && readFileSync(join(f.dir, 'companion-writing-receipt.json'), 'utf8');
    const visualBytes = existsSync(visualPath) && readFileSync(visualPath, 'utf8');
    const newsletterBytes = existsSync(newsletterPath) && readFileSync(newsletterPath, 'utf8');
    phase = 2;
    await assert.rejects(produce({ resume: f.id }), /STOP_AFTER_SUCCESSFUL_DEVELOPMENT/);
    assert.equal(contexts.length, 2, 'exactly one preparation per producer attempt');
    assert.equal(writerCalls, failedBranch === 'script' ? 2 : 1, 'a current reviewed sibling script survives another branch failure');
    assert.equal(visualCalls, 2); assert.equal(visualGenerations, 1, 'matching successful source visual progress is not regenerated');
    assert.equal(newsletterCalls, failedBranch === 'script' ? 1 : 2); assert.equal(assets, 1); assert.equal(renders, 0);
    if (scriptBytes) assert.equal(readFileSync(join(f.dir, 'script.json'), 'utf8'), scriptBytes);
    if (receiptBytes) assert.equal(readFileSync(join(f.dir, 'companion-writing-receipt.json'), 'utf8'), receiptBytes);
    if (visualBytes) assert.equal(readFileSync(visualPath, 'utf8'), visualBytes);
    if (newsletterBytes) assert.equal(readFileSync(newsletterPath, 'utf8'), newsletterBytes);
    assert.equal(readFileSync(join(f.dir, 'writing-request.json'), 'utf8'), requestBytes, 'resume does not alter source scope or parent identity');
    assert.deepEqual(Object.values(JSON.parse(readFileSync(statusPath, 'utf8')).outcomes).map(value => value.status), ['complete', 'complete']);
    if (failedBranch === 'visuals') {
      const currentReceipt = readFileSync(join(f.dir, 'companion-writing-receipt.json'), 'utf8');
      save('workdir/videos/' + f.id + '/script.json', { ...script, hook: 'Unreviewed replacement' });
      await assert.rejects(produce({ resume: f.id, until: 'script' }), /saved video script is not bound/);
      assert.equal(writerCalls, 1); assert.equal(assets, 1); assert.equal(visualCalls, 2);
      assert.equal(readFileSync(join(f.dir, 'companion-writing-receipt.json'), 'utf8'), currentReceipt);
    }
  `);
}

for (const failedBranch of ['script', 'visuals', 'newsletter'] as const) {
  test(`actual producer keeps visuals independent and newsletter after script, retaining successful work when ${failedBranch} fails`, () => {
    assert.match(parallelProducerFixture(failedBranch), /PRODUCER_ROUTING_FIXTURE_PASSED/);
  });
}

/** The real producer/controller/hash guards run here. External stage implementations are
 * isolated fixtures; the writer must still issue the real exact-script receipt. */
function completedMediaFixture(firstQcFails: boolean, snapshotRefresh = false): string {
  return runProducerRoutingFixture(`
    const firstQcFails = ${JSON.stringify(firstQcFails)}, snapshotRefresh = ${JSON.stringify(snapshotRefresh)};
    const f = seed('complete-media-' + Number(firstQcFails), { outputs: 'edition', parentIdentity: 'original-parent' });
    const events = []; let writes = 0, formats = 0, voices = 0, renders = 0, checks = 0, notifications = 0;
    const script = { hook: 'A proposed transit pilot.', body: [{ voiceover: 'The city announced a proposed transit pilot.', scene: 'news_card', assetRef: 'og-0', onScreen: { title: 'Proposed transit pilot' } }], cta: 'Read the source.', publish: { title: 'Proposed transit pilot', description: 'The city announced a proposal.', linkedinPost: 'The city announced a proposal.', hashtags: [] } };
    script.body[0].motion={kind:'flow',who:'City',what:'Pilot',how:'Proposal',impact:'Reported',status:'Proposed'};
    script.fullVoiceoverText = [script.hook,...script.body.map(segment=>segment.voiceover),script.cta].join(' ');
    const {createHash}=await import('node:crypto');const hash=value=>createHash('sha256').update(value).digest('hex');
    const context = { topic: selected, writerKey: 'same-writer', parent: { parentId: f.id, parentIdentity: 'original-parent' }, call: () => async () => { throw new Error('Unexpected unmocked provider call'); } };
    const assertScript = () => originalWriting.assertPreparedScriptReceipt(JSON.parse(readFileSync(join(f.dir, 'companion-writing-receipt.json'), 'utf8')), selected, context.writerKey, JSON.parse(readFileSync(join(f.dir, 'script.json'), 'utf8')));
    mock.module(new URL('writing-context.ts', source), { namedExports: { ...originalWriting, packageWritingContext: async () => context } });
    mock.module(new URL('script.ts', source), { namedExports: { ...originalScript, writeScript: async () => {
      writes++; events.push('script-write'); events.push('script-factual-review');
      save('workdir/videos/' + f.id + '/script.json', script);
      save('workdir/videos/' + f.id + '/companion-writing-receipt.json', originalWriting.preparedScriptReceipt(selected, context.writerKey, script));
      return script;
    } } });
    mock.module(new URL('newsletter.ts', source), { namedExports: {
      prepareCompanionText: async (_id, _support, received) => {
        assert.equal(received, context); assertScript();
        const path = join(f.dir, 'formatted-newsletter.json');
        if (!existsSync(path)) { formats++; events.push('newsletter-format'); writeFileSync(path, JSON.stringify({ approvedScript: script })); }
        else assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).approvedScript, script);
        return { issue: {}, context };
      },
      newsletter: async (_day, rerender, _edition, id) => {
        assert.equal(id, f.id); assertScript(); assert.ok(existsSync(join(f.dir, 'formatted-newsletter.json')));
        if (rerender) { assert.ok(checks > 0); events.push('newsletter-cached-refresh'); }
        else events.push('newsletter-render');
        return join(f.dir, 'newsletter.html');
      },
    } });
    mock.module(new URL('visual-development.ts', source), { namedExports: { ensureSourceVisualDevelopment: async () => {
      events.push('visual-source-review'); return { version: 1, status: 'ready', concepts: [], failures: [] };
    } } });
    mock.module(new URL('assets.ts', source), { namedExports: { gatherAssets: async () => { events.push('assets'); save('workdir/videos/' + f.id + '/assets.json', {}); } } });
    mock.module(new URL('story-diagram.ts', source), { namedExports: { ensureEditionDiagrams: async () => { assertScript(); events.push('visual-alignment'); return []; } } });
    const originalModel = await import(new URL('../llm/model.ts', source));
    mock.module(new URL('../llm/model.ts', source), { namedExports: { ...originalModel, modelCanReadImages: async () => false } });
    mock.module(new URL('voice.ts', source), { namedExports: { voice: async () => {
      voices++; events.push('voice'); assertScript();
      writeFileSync(join(f.dir, 'audio.wav'), 'fixed approved narration fixture');
      save('workdir/videos/' + f.id + '/audio-qc.json', {version:1,status:'pass',method:'raw-asr-script-comparison',blocking:[],heardWords:[{w:'A',start:0,end:1}],requestedText:script.fullVoiceoverText,scriptSha256:hash(script.fullVoiceoverText),audioSha256:hash('fixed approved narration fixture'),engine:'kokoro',voice:'af_heart'});
      save('workdir/videos/' + f.id + '/timestamps.json', {narrationSha256:hash(script.fullVoiceoverText),durationSec:10,engine:'kokoro',words:[{w:'A',start:0,end:1}]});
    } } });
    mock.module(new URL('avatar.ts', source), { namedExports: { avatar: async () => { events.push('avatar'); } } });
    mock.module(new URL('render.ts', source), { namedExports: { render: async () => {
      renders++; events.push('render'); assert.equal(voices, 1);
      const {selectedSourceSnapshots}=await import(new URL('visual-choice.ts',source));const snapshot=selectedSourceSnapshots(f.dir).get(0);
      save('workdir/videos/' + f.id + '/props.json', {headline:selected.headline,hook:script.hook,cta:script.cta,segments:[{...script.body[0],startSec:2,endSec:8,assetFile:null,...(snapshot?{sourceSnapshot:snapshot}:{})}],durationSec:10,audioFile:f.id+'/audio.wav',words:[{w:'A',start:0,end:1}],accent:'#223344'});
      writeFileSync(join(f.dir, 'final.mp4'), 'fixed rendered video fixture');
    } } });
    const originalFinalMedia=await import(new URL('final-media-qc.ts',source));
    mock.module(new URL('final-media-qc.ts', source), { namedExports: { ...originalFinalMedia, reviewFinalMedia: async (id, options) => {
      checks++; events.push('final-media-qc'); assert.equal(id, f.id); assert.equal(options.context, context);
      if (firstQcFails && checks === 1) throw new Error('FINAL_QC_FIXTURE_UNAVAILABLE');
      return { version: 1, ok: true, failureKind: null, findings: [], repairTargets: [], evidencePath: 'mock-final-review', inputHash: 'same-reviewed-media', audioListeningApproved: false, publicationReady: false };
    } } });
    mock.module(new URL('../review/notify.ts', source), { namedExports: { notify: () => { throw new Error('Unexpected external notification'); }, notifyDraftReady: () => {
      notifications++; assert.equal(JSON.parse(readFileSync(join(f.dir, 'meta.json'), 'utf8')).status, 'pending_review'); events.push('pending-review');
    } } });
    const { produce } = await import(new URL('produce.ts', source));
    const { canReuseRenderedMedia } = await import(new URL('media-completion.ts', source));
    if (firstQcFails) {
      await assert.rejects(produce({ resume: f.id }), /FINAL_QC_FIXTURE_UNAVAILABLE/);
      assert.equal(JSON.parse(readFileSync(join(f.dir, 'meta.json'), 'utf8')).status, 'failed:final-media-qc');
      assert.equal(notifications, 0); assert.ok(!events.includes('newsletter-cached-refresh')); assert.ok(!events.includes('pending-review'));
      const retained = new Map(['script.json', 'companion-writing-receipt.json', 'formatted-newsletter.json', 'audio.wav', 'timestamps.json', 'final.mp4'].map(name => [name, readFileSync(join(f.dir, name), 'utf8')]));
      assert.equal(canReuseRenderedMedia(f.id), true);
      await produce({ resume: f.id });
      for (const [name, bytes] of retained) assert.equal(readFileSync(join(f.dir, name), 'utf8'), bytes, 'Unchanged recovery retains ' + name);
      assert.equal(checks, 2);
    } else await produce({ resume: f.id });
    assert.deepEqual({ writes, formats, voices, renders, notifications }, { writes: 1, formats: 1, voices: 1, renders: 1, notifications: 1 });
    const ordered = ['script-write', 'script-factual-review', 'newsletter-format', 'newsletter-render', 'voice', 'avatar', 'render', 'final-media-qc', 'newsletter-cached-refresh', 'pending-review'];
    for (let i = 1; i < ordered.length; i++) assert.ok(events.indexOf(ordered[i - 1]) < events.indexOf(ordered[i]), ordered[i - 1] + ' must finish before ' + ordered[i]);
    assert.ok(events.indexOf('visual-source-review') < events.indexOf('voice'));
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'meta.json'), 'utf8')).status, 'pending_review');
    const completedChecks = checks;
    for (const until of ['voice', 'avatar']) await produce({ resume: f.id, until });
    assert.equal(checks, completedChecks, 'An explicit stop on reused media cannot run later final-review work');
    assert.equal(voices, 1); assert.equal(renders, 1); assert.equal(notifications, 1);
    if(snapshotRefresh){
      const {ensureVisualCandidates,lockVisualChoices}=await import(new URL('visual-choice.ts',source));
      const candidates=ensureVisualCandidates(f.dir,script.body,[],false);lockVisualChoices(f.dir,candidates,{'0':'snapshot'},'user');
      assert.equal(canReuseRenderedMedia(f.id),false,'new selected snapshot invalidates only the old visual render');
      const audio=readFileSync(join(f.dir,'audio.wav')),oldProps=readFileSync(join(f.dir,'props.json'));
      const completionPath=join(f.dir,'media-completion.json');const completion=JSON.parse(readFileSync(completionPath,'utf8'));completion.attempts.at(-1).result={...completion.attempts.at(-1).result,ok:false,failureKind:'content',findings:[{severity:'blocking',kind:'content',target:'visual',detail:'Selected snapshot missing'}],repairTargets:['visual']};writeFileSync(completionPath,JSON.stringify(completion));
      const meta=JSON.parse(readFileSync(join(f.dir,'meta.json'),'utf8'));save('workdir/videos/'+f.id+'/meta.json',{...meta,status:'failed:final-media-qc'});
      await produce({resume:f.id});assert.equal(voices,1);assert.equal(events.filter(event=>event==='avatar').length,1);assert.equal(renders,2);assert.equal(writes,1);assert.equal(formats,1);
      assert.ok(readFileSync(join(f.dir,'audio.wav')).equals(audio));assert.equal(canReuseRenderedMedia(f.id),true);
      const repaired=JSON.parse(readFileSync(completionPath,'utf8'));assert.equal(repaired.repairs.length,1);assert.equal(repaired.repairs[0].status,'finished');assert.equal(repaired.attempts[0].result.ok,false);assert.equal(repaired.attempts.at(-1).result.ok,true);assert.equal(checks,completedChecks+1);
      const {readdirSync}=await import('node:fs');const histories=readdirSync(join(f.dir,'render-attempts'));assert.equal(histories.length,1);
      assert.ok(readFileSync(join(f.dir,'render-attempts',histories[0],'props.json')).equals(oldProps));
    }
  `);
}

test('actual producer completes script review, newsletter formatting, media and final QC before pending review', () => {
  assert.match(completedMediaFixture(false), /PRODUCER_ROUTING_FIXTURE_PASSED/);
});

test('snapshot rendering refresh preserves exact checked narration and presenter without another writer', () => {
  assert.match(completedMediaFixture(false,true), /PRODUCER_ROUTING_FIXTURE_PASSED/);
});

test('actual producer holds media-QC failure and resumes unchanged media without another voice or render', () => {
  assert.match(completedMediaFixture(true), /PRODUCER_ROUTING_FIXTURE_PASSED/);
});

test('explicit media continuation skips all editorial/source work, reuses the exact newsletter and preserves it across media failure', () => {
  const output = runProducerRoutingFixture(`
    const f = seed('media-continuation', { outputs:'edition', parentIdentity:'expired-original-parent' }, 'awaiting_visual_choice');
    const events = []; let narrationFails = true, holdDuringNarration = false;
    const script = { hook:'A reported schedule.', body:[{voiceover:'The league published dates.',scene:'news_card',onScreen:{title:'Reported dates'}}],cta:'Read the source.',fullVoiceoverText:'A reported schedule. The league published dates. Read the source.',publish:{title:'Reported dates',description:'Exact approved copy',linkedinPost:'Exact approved copy',hashtags:[]}};
    const issue = {subject:'Reported dates',lead:{title:'Reported dates',body:'The league published dates.',sourceName:'example.org',sourceUrl:'https://example.org/schedule'},items:[],radar:[],signals:[]};
    save('workdir/videos/'+f.id+'/script.json',script); save('workdir/videos/'+f.id+'/journey-editorial-issue.json',issue);
    save('workdir/videos/'+f.id+'/assets.json',{}); save('workdir/videos/'+f.id+'/media-continuation.json',{explicit:'routing fixture; module validation is tested separately'});
    save('workdir/videos/'+f.id+'/development-status.json',{stage:'original accepted development'});
    writeFileSync(join(f.dir,'journey-editorial-input.json'),'MUST_NOT_RECAPTURE_OR_REVIEW');
    const protectedFiles = new Map(['script.json','journey-editorial-issue.json','writing-request.json','development-status.json','journey-editorial-input.json'].map(name=>[name,readFileSync(join(f.dir,name))]));
    const unchanged = () => {assert.ok(!JSON.parse(readFileSync(join(f.dir,'meta.json'),'utf8')).reviewHold,'CONTINUATION_HELD');for(const[name,bytes]of protectedFiles)assert.ok(readFileSync(join(f.dir,name)).equals(bytes),name+' changed');};
    const deny = () => {throw new Error('FORBIDDEN_NEW_EDITORIAL_OR_SOURCE_WORK');};
    const context = {topic:selected,issue,writerKey:'same-selected-model',journal:{kind:'approved-media-only'},parent:{parentId:f.id,parentIdentity:'explicit-media-parent'},assertUnchanged:unchanged,call:()=>deny,vision:deny};
    mock.module(new URL('media-continuation.ts',source),{namedExports:{openMediaContinuation:(receivedRoot,receivedId)=>{assert.equal(receivedRoot,workspace);assert.equal(receivedId,f.id);unchanged();return context;}}});
    mock.module(new URL('writing-context.ts',source),{namedExports:{...originalWriting,packageWritingContext:deny}});
    mock.module(new URL('script.ts',source),{namedExports:{...originalScript,writeScript:deny}});
    mock.module(new URL('journey-editorial.ts',source),{namedExports:{prepareJourneyEditorial:deny}});
    mock.module(new URL('visual-development.ts',source),{namedExports:{ensureSourceVisualDevelopment:deny}});
    mock.module(new URL('assets.ts',source),{namedExports:{gatherAssets:deny}});
    const originalNewsletter=await import(new URL('newsletter.ts',source));
    const restored=await originalNewsletter.prepareCompanionText(f.id,undefined,context);assert.deepEqual(restored.issue,issue);
    await assert.rejects(originalNewsletter.prepareCompanionText(f.id,undefined,{...context,parent:{...context.parent,parentIdentity:'wrong-parent'}}),/authorized media continuation/);
    mock.module(new URL('newsletter.ts',source),{namedExports:{...originalNewsletter,newsletter:async(_day,rerender,_edition,id)=>{
      assert.equal(id,f.id);const saved=await originalNewsletter.prepareCompanionText(id,undefined,context);assert.deepEqual(saved.issue,issue);unchanged();events.push(rerender?'newsletter-media':'newsletter-presentation');return join(f.dir,'newsletter.html');
    }}});
    mock.module(new URL('story-diagram.ts',source),{namedExports:{ensureEditionDiagrams:async(_dir,body,_vision,_author,injected)=>{assert.equal(injected,context);assert.deepEqual(body,script.body);events.push('retained-visuals');return[];}}});
    const originalModel=await import(new URL('../llm/model.ts',source));mock.module(new URL('../llm/model.ts',source),{namedExports:{...originalModel,modelCanReadImages:async()=>true}});
    mock.module(new URL('voice.ts',source),{namedExports:{voice:async()=>{events.push('voice');unchanged();if(holdDuringNarration){const meta=JSON.parse(readFileSync(join(f.dir,'meta.json'),'utf8'));save('workdir/videos/'+f.id+'/meta.json',{...meta,status:'rejected',reviewHold:true});throw new Error('HOLD_ADDED_DURING_VOICE');}if(narrationFails)throw new Error('VOICE_FIXTURE_STOP');writeFileSync(join(f.dir,'audio.wav'),'fixed audio');save('workdir/videos/'+f.id+'/audio-qc.json',{exact:'fixture'});save('workdir/videos/'+f.id+'/timestamps.json',{exact:'fixture'});}}});
    mock.module(new URL('avatar.ts',source),{namedExports:{avatar:async()=>events.push('avatar')}});
    mock.module(new URL('render.ts',source),{namedExports:{render:async(id,injected)=>{assert.equal(id,f.id);assert.equal(injected,context);unchanged();events.push('render');save('workdir/videos/'+f.id+'/props.json',{exact:'fixture'});writeFileSync(join(f.dir,'final.mp4'),'fixed render');}}});
    const originalFinalMedia=await import(new URL('final-media-qc.ts',source));mock.module(new URL('final-media-qc.ts',source),{namedExports:{...originalFinalMedia,reviewFinalMedia:async(id,options)=>{assert.equal(id,f.id);assert.equal(options.context,context);unchanged();events.push('final-media-review');return{version:1,ok:true,failureKind:null,findings:[],repairTargets:[],evidencePath:'fixture-final',inputHash:'fixture-media',audioListeningApproved:false,publicationReady:false};}}});
    mock.module(new URL('../review/notify.ts',source),{namedExports:{notify:deny,notifyDraftReady:()=>events.push('preview-ready')}});
    const{produce}=await import(new URL('produce.ts',source));
    await assert.rejects(produce({resume:f.id}),/VOICE_FIXTURE_STOP/);unchanged();assert.equal(JSON.parse(readFileSync(join(f.dir,'meta.json'),'utf8')).status,'failed:voice');
    holdDuringNarration=true;await assert.rejects(produce({resume:f.id}),/CONTINUATION_HELD/);const held=JSON.parse(readFileSync(join(f.dir,'meta.json'),'utf8'));assert.equal(held.status,'rejected','Failure handling must retain the concurrent hold');assert.equal(held.reviewHold,true);save('workdir/videos/'+f.id+'/meta.json',{...held,status:'failed:voice',reviewHold:false});holdDuringNarration=false;
    narrationFails=false;await produce({resume:f.id});unchanged();assert.equal(JSON.parse(readFileSync(join(f.dir,'meta.json'),'utf8')).status,'pending_review');
    assert.equal(events.filter(event=>event==='render').length,1);assert.equal(events.filter(event=>event==='final-media-review').length,1);assert.equal(events.filter(event=>event==='preview-ready').length,1);
    const completed=events.length;await produce({resume:f.id});assert.equal(events.length,completed,'A completed continuation cannot repeat media');
    await assert.rejects(produce({topicFile:f.topicFile}),/replacing its topic is not permitted/);unchanged();
  `);
  assert.match(output, /PRODUCER_ROUTING_FIXTURE_PASSED/);
});

test('actual visual-recovery producer opens normal choices before any unused artwork or narration binding call', () => {
  const output = runProducerRoutingFixture(`
    process.env.HARNESS_VISUAL_CHOICE='require';
    const f=seed('retained-visual-choice',{outputs:'edition',parentIdentity:'retained-editorial-parent'},'failed:visuals');
    selected.kind='roundup'; selected.stories=[{n:1,headline:'The city announced a transit pilot',primaryUrl:selected.primaryUrl,verifiedClaims:['The city announced a transit pilot.']}];
    save('workdir/videos/'+f.id+'/topic.json',selected);
    const script={hook:'Reported pilot',body:[{scene:'news_card',voiceover:'The city announced a transit pilot.',onScreen:{title:'Reported pilot'},motion:{kind:'flow',who:'City',what:'Transit pilot',how:'Announcement',impact:'Proposed service',status:'Reported proposal'}}],cta:'Read the source.',fullVoiceoverText:'The city announced a transit pilot.'};
    const issue={subject:'Reported pilot',lead:{title:'Reported pilot',body:script.fullVoiceoverText,sourceName:'example.org',sourceUrl:selected.primaryUrl},items:[],radar:[],signals:[]};
    save('workdir/videos/'+f.id+'/script.json',script);save('workdir/videos/'+f.id+'/journey-editorial-issue.json',issue);
    save('workdir/videos/'+f.id+'/companion-writing-receipt.json',originalWriting.preparedScriptReceipt(selected,'retained-writer',script));
    save('workdir/videos/'+f.id+'/assets.json',{});save('workdir/videos/'+f.id+'/media-continuation.json',{fixture:'independently tested explicit authorization'});
    const protectedFiles=new Map(['script.json','journey-editorial-issue.json','writing-request.json','companion-writing-receipt.json'].map(name=>[name,readFileSync(join(f.dir,name))]));
    let calls=0,tools=0,held=false,guards=0;
    const deny=()=>{calls++;throw new Error('NO_MODEL_OR_EDITORIAL_WORK_ALLOWED');};
    const unchanged=()=>{guards++;if(held)throw new Error('RETAINED_REVIEW_HOLD');for(const[name,bytes]of protectedFiles)assert.ok(readFileSync(join(f.dir,name)).equals(bytes),name+' changed');};
    const context={topic:selected,issue,writerKey:'retained-writer',journal:{kind:'approved-media-only',visualRecovery:{version:1}},parent:{root:workspace,parentId:f.id,parentIdentity:'authorized-retained-parent'},assertUnchanged:unchanged,call:()=>deny,vision:deny};
    mock.module(new URL('media-continuation.ts',source),{namedExports:{openMediaContinuation:()=>{unchanged();return context;}}});
    mock.module(new URL('writing-context.ts',source),{namedExports:{...originalWriting,packageWritingContext:deny}});
    const managed=await import(new URL('../managed-process.ts',source));mock.module(new URL('../managed-process.ts',source),{namedExports:{...managed,runManagedProcess:async()=>{tools++;throw new Error('NO_TOOL_BEFORE_VISUAL_CHOICE');}}});
    const originalModel=await import(new URL('../llm/model.ts',source));mock.module(new URL('../llm/model.ts',source),{namedExports:{...originalModel,modelCanReadImages:async()=>true}});
    const newsletter=await import(new URL('newsletter.ts',source));mock.module(new URL('newsletter.ts',source),{namedExports:{...newsletter,newsletter:async()=>{throw new Error('STOP_AFTER_APPROVED_VISUAL_CHOICE');}}});
    const {produce}=await import(new URL('produce.ts',source));
    await produce({resume:f.id});unchanged();
    assert.equal(JSON.parse(readFileSync(join(f.dir,'meta.json'),'utf8')).status,'awaiting_visual_choice');
    assert.equal(calls,0,'No unused artwork or narration binding call may precede the chooser');assert.equal(tools,0);
    const{readdirSync}=await import('node:fs');assert.equal(readdirSync(f.dir).some(name=>name.startsWith('diagram-generation-failed-')),false,'Normal recovery choices must open before attempting and failing unused visual work');
    assert.equal(existsSync(join(f.dir,'visual-choices.json')),false,'Opening the chooser must not select a visual');
    const candidates=JSON.parse(readFileSync(join(f.dir,'visual-candidates.json'),'utf8'));
    assert.equal(candidates.stories.length,1);assert.ok(candidates.stories[0].candidates.some(c=>c.id==='snapshot'&&c.available&&!c.failed));
    assert.ok(guards>=2);
    held=true;await assert.rejects(produce({resume:f.id}),/RETAINED_REVIEW_HOLD/);assert.equal(calls,0);assert.equal(tools,0);
    held=false;const{lockVisualChoices}=await import(new URL('visual-choice.ts',source));lockVisualChoices(f.dir,candidates,{'0':'snapshot'},'user');
    const choiceBytes=readFileSync(join(f.dir,'visual-choices.json'));
    await assert.rejects(produce({resume:f.id}),/STOP_AFTER_APPROVED_VISUAL_CHOICE/);unchanged();
    assert.equal(calls,0,'The chosen snapshot must also skip unused binding');assert.equal(tools,0);assert.ok(readFileSync(join(f.dir,'visual-choices.json')).equals(choiceBytes));
  `);
  assert.match(output,/PRODUCER_ROUTING_FIXTURE_PASSED/);
});
