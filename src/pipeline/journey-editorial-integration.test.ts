import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/** Exercise the real workspace, capture, preparation, editorial, visual and budget wiring.
 * Only external HTTP and model transports are replaced; this is not model qualification. */
test('fresh Journey reviews script then formats newsletter with independent visual review and exact resume', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(join(root, 'workspaces'), { recursive: true });
  const workspace = mkdtempSync(join(root, 'workspaces/test-journey-full-'));
  const slug = workspace.split(/[\\/]/).at(-1)!, token = 'e'.repeat(64);
  const save = (path: string, value: unknown) => {
    mkdirSync(join(workspace, path, '..'), { recursive: true });
    writeFileSync(join(workspace, path), JSON.stringify(value));
  };
  try {
    save('workspace.json', { id: slug });
    save('members.json', [{ id: 'fixture-owner', role: 'owner', tokenHash: createHash('sha256').update(token).digest('hex') }]);
    save('config/model.json', { provider: 'openai-compatible', timeoutSeconds: 90, rescue: { enabled: false }, providers: { openaiCompatible: { baseUrl: 'https://fixture.invalid/v1', model: 'offline-journey-fixture' } } });
    save('config/pipeline.json', { autonomy: 'review' });
    save('config/personalization.json', { newsletterLength: 'deep' });
    save('config/publisher.json', { name: 'Fixture Editor', publication: 'Fixture Sports', audience: 'Sports readers', tone: 'Sourced and concise' });
    const edition = JSON.parse(readFileSync(new URL('../../config/editions/daily-roundup.json', import.meta.url), 'utf8'));
    save('config/editions/daily-roundup.json', { ...edition, wordBudget: { min: 195, max: 220 } });
    const child = String.raw`
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { mock } from 'node:test';
      import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      import http from 'node:http'; import https from 'node:https';
      import { syncBuiltinESMExports } from 'node:module';
      const root = process.cwd(), workspace = join(root, 'workspaces', process.env.HARNESS_WORKSPACE);
      const source = pathToFileURL(root + '/src/');
      const noNetwork = () => { throw new Error('External network forbidden in offline Journey integration'); };
      globalThis.fetch = noNetwork; http.request = noNetwork; http.get = noNetwork; https.request = noNetwork; https.get = noNetwork; syncBuiltinESMExports();
      const sha = value => createHash('sha256').update(value).digest('hex');
      const rich = JSON.parse(readFileSync(join(root, 'examples/fixtures/newsletter-rich-sports-evidence.json'), 'utf8'));
      const sentences = rich.topics.map(row => [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(row.sourceText)].map(x => x.segment.trim()).filter(Boolean));
      const capturedTexts = rich.topics.map(row => row.sourceText + ' SOURCE_ONLY_CAPTURE_NOTE: Additional fixture records are archived.');
      const html = rich.topics.map((row, i) => '<html><head><meta property="article:published_time" content="2026-09-14T08:00:00Z"></head><body><article>' + capturedTexts[i] + '</article></body></html>');
      const httpRequests = [], calls = [];
      const api = await import(new URL('sources/public-apis.ts', source));
      mock.module(new URL('sources/public-apis.ts', source), { namedExports: { ...api, publicResponse: async url => {
        const index = rich.topics.findIndex(row => row.primaryUrl === url);
        assert.ok(index >= 0, 'Only an explicitly selected fixture article can be fetched');
        httpRequests.push(url); return new Response(html[index], { status: 200, headers: { 'content-type': 'text/html' } });
      } } });
      const model = await import(new URL('llm/model.ts', source));
      let script;
      mock.module(new URL('llm/model.ts', source), { namedExports: { ...model, modelJson: async (prompt, validate, config, env, images, toolsDisabled, deadline, hooks) => {
        const runtime = model.resolveModelRuntime(config, env);
        assert.equal(runtime.model, 'offline-journey-fixture'); assert.equal(config.rescue.enabled, false);
        assert.ok(deadline > Date.now()); assert.equal(toolsDisabled, true);
        hooks.beforeAttempt({ provider: runtime.provider, model: runtime.model, baseUrl: runtime.baseUrl, attempt: 1, rescue: false, promptBytes: Buffer.byteLength(prompt) });
        let value, stage;
        if (prompt.includes('Extract event identity.')) { value = null; stage = 'identity'; }
        else if (prompt.startsWith('Write the complete newsletter,')) {
          assert.ok(calls.includes('script-review'), 'Newsletter waits for accepted script factual review');
          assert.ok(prompt.includes(JSON.stringify(script.editorialCopy)), 'Newsletter receives complete accepted editorial copy');
          assert.ok(!prompt.includes('SOURCE_ONLY_CAPTURE_NOTE'), 'Formatting cannot access unapproved source-only material');
          assert.ok(!prompt.includes('\"approvedScript\":'), 'The formatter cannot expand the short spoken script');
          assert.match(prompt, /APPROVED SCRIPT AND NEWSLETTER PRESENTATION/);
          for (const text of capturedTexts) assert.ok(!prompt.includes(text), 'Formatting does not reread full source articles');
          stage = 'newsletter-write'; value = { sections: rich.topics.map((row, i) => ({ storyId: 'topic-' + (i + 1), text: row.sourceText })) };
        } else if (prompt.startsWith('Write the complete script,')) { stage = 'script-write'; value = script; }
        else if (prompt.startsWith('Independently assess the complete ')) {
          stage = prompt.startsWith('Independently assess the complete script') ? 'script-review' : 'newsletter-review';
          for (const row of rich.topics) assert.ok(prompt.includes(row.sourceText), 'Reviewer receives every complete captured article');
          if (stage === 'script-review') { for (const part of script.body) for (const text of Object.values(part.motion)) assert.ok(prompt.includes(text), 'Review includes authored motion fields'); for (const copy of script.editorialCopy) assert.ok(prompt.includes(copy.text), 'The same script review includes complete written story copy'); }
          value = { verdict: 'supported', reviewedStoryIds: ['topic-1', 'topic-2', 'topic-3'], findings: [] };
        } else if (prompt.startsWith('SOURCE VISUAL CONCEPT')) {
          stage = 'visual-write'; value = { kind: 'diagram', intent: 'Published sports schedule', reasonClaimIds: [1], labels: ['Published guide', 'Planned event'], caveat: 'Fictional scheduled event' };
        } else if (/^AUTHORED_FIELDS: /m.test(prompt)) {
          stage = 'visual-review';
          value = { fields: JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)[1]).map(field => ({ id: field.id, supported: true, claimIds: [1], reason: 'Explicit offline review fixture; this does not qualify a live reviewer.' })) };
        } else throw new Error('Unexpected fixture task: ' + prompt.slice(0, 100));
        calls.push(stage); assert.equal(validate(value), null, stage + ' must pass the actual response validator'); return value;
      } } });
      const { packageWritingContext, assertPreparedScriptReceipt } = await import(new URL('pipeline/writing-context.ts', source));
      const { prepareJourneyEditorial } = await import(new URL('pipeline/journey-editorial.ts', source));
      const { ensureSourceVisualDevelopment, readSourceVisualConcept } = await import(new URL('pipeline/visual-development.ts', source));
      const { beginParentWork } = await import(new URL('llm/role-router.ts', source));
      const { spokenScriptText } = await import(new URL('pipeline/narration.ts', source));
      const save = (path, value) => { mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), JSON.stringify(value)); };
      const id = '20260914-full-journey', dir = join(workspace, 'workdir/videos', id);
      const original = { id, kind: 'roundup', headline: 'Fictional sports schedule briefing', angle: 'Fictional integration evidence', primaryUrl: rich.topics[0].primaryUrl, repo: null, sourceItems: [], alternates: [], stories: rich.topics.map((row, i) => ({ n: i + 1, headline: row.headline, primaryUrl: row.primaryUrl, summary: 'Selected fictional sports report', weight: row.weight, verifiedClaims: sentences[i].slice(0, 3), repo: null, assetRef: 'og-' + i, suggestedScene: 'news_card', principalEntity: '', area: '', verticals: [] })) };
      assert.ok(original.stories.every(row => row.claimEvidence === undefined), 'Reproduce real selected stories without capture metadata');
      save('workdir/videos/' + id + '/topic.json', original);
      save('workdir/videos/' + id + '/meta.json', { id, edition: 'daily-roundup', status: 'selected' });
      script = { hook: 'Three fictional sports schedules.', intro: 'This is Fixture Sports.', body: original.stories.map((story, i) => ({ voiceover: '', scene: 'news_card', onScreen: { title: ['Harbor League schedule', 'River Cup format', 'Forest Run guide'][i] }, assetRef: story.assetRef,
        motion: { who: ['Harbor League', 'River Cup organizers', 'Forest Run'][i], what: 'Published sports event guide', how: 'Written event rules', impact: 'Planning information for participants', status: 'Fictional scheduled event', kind: 'flow' } })), cta: 'Subscribe for sourced reporting.', publish: { title: 'Fictional sports schedules', description: 'Published event guides and their conditions.', linkedinPost: 'Three fictional sports event guides.', hashtags: ['Sports'] } };
      script.editorialCopy = rich.topics.map((row, i) => ({ storyId: 'topic-' + (i + 1), text: row.sourceText }));
      let found = false;
      for (let a = 1; a <= 5 && !found; a++) for (let b = 1; b <= 5 && !found; b++) for (let c = 1; c <= 5 && !found; c++) {
        [a,b,c].forEach((n,i) => script.body[i].voiceover = sentences[i].slice(0,n).join(' '));
        const count = spokenScriptText(script).trim().split(/\s+/).length; found = count >= 195 && count <= 220;
      }
      assert.ok(found, 'Complete fixture sentences satisfy the production spoken range');
      assert.equal(existsSync(join(dir, 'journey-editorial-checkpoint.json')), false);
      const context = await packageWritingContext(id, 'edition');
      assert.equal(context.dailyEditorial.stories.length, 3);
      assert.deepEqual(httpRequests, rich.topics.map(row => row.primaryUrl));
      for (const [i, story] of context.dailyEditorial.stories.entries()) {
        const captured = story.sources[0]; assert.equal(captured.text, capturedTexts[i]);
        assert.equal(captured.rawSha256, sha(html[i])); assert.equal(captured.textSha256, sha(captured.text));
        assert.equal(captured.publishedAt, '2026-09-14T08:00:00.000Z');
        assert.equal(readFileSync(join(dir, 'journey-editorial-sources', captured.rawSha256 + '.raw'), 'utf8'), html[i]);
      }
      const topicBytes = readFileSync(join(dir, 'topic.json')), requestBytes = readFileSync(join(dir, 'writing-request.json'));
      const initialBudget = beginParentWork(context.parent);
      const visualOptions = { day: '2026-09-14', writerKey: context.writerKey, call: context.call('visual') };
      const [editorial, visual] = await Promise.all([prepareJourneyEditorial(context), ensureSourceVisualDevelopment(dir, context.topic, visualOptions)]);
      assert.equal(visual.status, 'ready', JSON.stringify(visual.failures)); assert.equal(visual.concepts.length, 3);
      assert.equal(calls.filter(x => x === 'visual-write').length, 3); assert.equal(calls.filter(x => x === 'visual-review').length, 3);
      assert.deepEqual(calls.filter(stage => ['newsletter-write', 'newsletter-review', 'script-write', 'script-review'].includes(stage)), ['script-write', 'script-review', 'newsletter-write']);
      assert.ok(readFileSync(join(dir, 'topic.json')).equals(topicBytes)); assert.ok(readFileSync(join(dir, 'writing-request.json')).equals(requestBytes));
      const receipt = JSON.parse(readFileSync(join(dir, 'companion-writing-receipt.json'), 'utf8'));
      assert.equal(receipt.version, 3); assertPreparedScriptReceipt(receipt, context.topic, context.writerKey, editorial.script, dir);
      const checkpoint = JSON.parse(readFileSync(join(dir, 'journey-editorial-checkpoint.json'), 'utf8'));
      for (const artifact of ['newsletter', 'script']) { assert.equal(checkpoint.artifacts[artifact].status, 'accepted'); assert.equal(checkpoint.artifacts[artifact].writes, 1); }
      assert.equal(checkpoint.artifacts.script.reviews.length, 1);
      assert.equal(editorial.issue.lead.title, script.body[0].onScreen.title, 'The newsletter reuses the already reviewed title');
      assert.deepEqual(editorial.script.editorialCopy, script.editorialCopy);
      const copyWords = script.editorialCopy.map(row => row.text).join(' ').trim().split(/\s+/).length;
      assert.ok(copyWords >= 900 && copyWords <= 1300);
      assert.equal(checkpoint.artifacts.newsletter.reviews.length, 0);
      assert.equal(checkpoint.artifacts.newsletter.formatting.approvedScriptHash, sha(JSON.stringify(checkpoint.artifacts.script.candidates.at(-1))));
      assert.equal(checkpoint.artifacts.newsletter.formatting.candidateHash, sha(JSON.stringify(checkpoint.artifacts.newsletter.candidates.at(-1))));
      assert.equal(checkpoint.artifacts.newsletter.formatting.checks, 'shape-length-formatting');
      const used = beginParentWork(context.parent);
      assert.equal(used.deadline, initialBudget.deadline); assert.equal(used.physicalAttempts - initialBudget.physicalAttempts, 9); assert.equal(used.toolAttempts, initialBudget.toolAttempts);
      const callCount = calls.length;
      const resumed = await packageWritingContext(id, 'edition');
      assert.equal(resumed.parent.parentIdentity, context.parent.parentIdentity);
      await prepareJourneyEditorial(resumed); assert.equal((await ensureSourceVisualDevelopment(dir, resumed.topic, visualOptions)).status, 'ready');
      assert.equal(calls.length, callCount); assert.equal(httpRequests.length, 3); assert.deepEqual(beginParentWork(resumed.parent), used);
      for (let i = 0; i < 3; i++) assert.equal(readSourceVisualConcept(dir, resumed.topic, i, visualOptions).narrationAlignment, 'pending', 'Source concepts do not claim final media approval');
      const rawPath = join(dir, 'journey-editorial-sources', context.dailyEditorial.stories[0].sources[0].rawSha256 + '.raw');
      writeFileSync(rawPath, '<article>Changed capture</article>');
      assert.throws(() => readSourceVisualConcept(dir, resumed.topic, 0, visualOptions), /raw source|text|metadata changed/);
      await assert.rejects(packageWritingContext(id, 'edition'), /bytes|text|metadata changed/);
      assert.equal(calls.length, callCount); assert.deepEqual(beginParentWork(resumed.parent), used);
      process.stdout.write('FULL_JOURNEY_OFFLINE_PASSED');
    `;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    const output = execFileSync(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', child], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...env, HARNESS_WORKSPACE: slug, HARNESS_TOKEN: token, HARNESS_IDENTITY_FILE: join(workspace, 'identity.json') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(output, /FULL_JOURNEY_OFFLINE_PASSED/);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
