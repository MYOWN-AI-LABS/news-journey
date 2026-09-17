import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Actual package/research/preparation/identity/SQLite/dispatcher flow. Only the external
 * HTTP and model transport are replaced. All model fixtures reserve the real parent hook. */
test('saved package resume retains reviewed and uncertain event packets, expires optional lessons and never renews work', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(join(root, 'workspaces'), { recursive: true });
  const workspace = mkdtempSync(join(root, 'workspaces/test-writing-memory-'));
  const slug = workspace.split(/[\\/]/).at(-1)!, token = 'd'.repeat(64);
  try {
    const save = (path: string, value: unknown) => { mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), JSON.stringify(value)); };
    save('workspace.json', { id: slug });
    save('members.json', [{ id: 'fixture-owner', role: 'owner', tokenHash: createHash('sha256').update(token).digest('hex') }]);
    save('config/model.json', { provider: 'openai-compatible', timeoutSeconds: 90, rescue: { enabled: false }, providers: { openaiCompatible: { baseUrl: 'https://fixture.invalid/v1', model: 'memory-regression' } } });
    save('config/pipeline.json', { autonomy: 'review' });
    // Without a role policy the package runs under 'operation-only', whose deadline is
    // Number.MAX_SAFE_INTEGER: `now = deadline + 1` then leaves the range every memory
    // timestamp must stay inside. Route through the timed ('fixed') policy the deadline
    // assertions describe. No role is delegated, so the primary model fixture still answers.
    save('config/role-routing.json', { version: 1, enabled: true, limits: { totalSeconds: 1800, maxPhysicalCalls: 96, maxToolCalls: 24 } });
    save('config/personalization.json', { newsletterLength: 'deep' });
    save('config/publisher.json', { name: 'Fixture Editor', publication: 'Fixture Sports', audience: 'Sports readers', tone: 'Sourced and concise' });
    const edition = JSON.parse(readFileSync(new URL('../../config/editions/daily-roundup.json', import.meta.url), 'utf8'));
    save('config/editions/daily-roundup.json', { ...edition, wordBudget: { min: 195, max: 220 } });
    const child = String.raw`
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { mock } from 'node:test';
      import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import http from 'node:http'; import https from 'node:https';
      import { syncBuiltinESMExports } from 'node:module';
      const root = process.cwd(), workspace = join(root, 'workspaces', process.env.HARNESS_WORKSPACE);
      let now = Date.now(); Date.now = () => now;
      const source = new URL('./src/', 'file://' + root + '/');
      const noNetwork = () => { throw new Error('Real network is forbidden in the memory fixture'); };
      globalThis.fetch = noNetwork; http.request = noNetwork; http.get = noNetwork; https.request = noNetwork; https.get = noNetwork; syncBuiltinESMExports();
      const rich = JSON.parse(readFileSync(join(root, 'examples/fixtures/newsletter-rich-sports-evidence.json'), 'utf8'));
      rich.topics[0].sourceText = 'Harbor League published schedule v1. ' + rich.topics[0].sourceText;
      const api = await import(new URL('sources/public-apis.ts', source));
      const httpRequests = [];
      mock.module(new URL('sources/public-apis.ts', source), { namedExports: { ...api, publicResponse: async url => {
        httpRequests.push(url);
        if (url.includes('bing.com')) {
          const index = Number(new URL(url).searchParams.get('q').match(/topic-(\d+)/)[1]) - 1;
          return new Response('<a class="title" href="' + rich.topics[index].primaryUrl + '">Official fixture source</a>');
        }
        const row = rich.topics.find(item => item.primaryUrl === url);
        assert.ok(row, 'Only the exact selected fictional source may be returned');
        return new Response('<article>' + row.sourceText + '</article>');
      } } });
      const model = await import(new URL('llm/model.ts', source));
      const modelCalls = [], identityCalls = [];
      mock.module(new URL('llm/model.ts', source), { namedExports: { ...model, modelJson: async (prompt, validate, config, env, images, toolsDisabled, deadline, hooks) => {
        const runtime = model.resolveModelRuntime(config, env);
        assert.ok(deadline > now); assert.equal(config.rescue.enabled, false);
        hooks.beforeAttempt({ provider: runtime.provider, model: runtime.model, baseUrl: runtime.baseUrl, attempt: 1, rescue: false, promptBytes: Buffer.byteLength(prompt) });
        modelCalls.push(prompt);
        let value;
        if (prompt.includes('Extract event identity.')) {
          const packet = JSON.parse(prompt.split('COMPLETE_SOURCE_PACKET:\n')[1]);
          identityCalls.push(['extract', packet.primaryUrl]);
          if (packet.primaryUrl !== rich.topics[0].primaryUrl) value = null;
          else {
            const support = [{ sourceHash: packet.revisions[0].sha256, claimId: 1, quote: packet.claims[0].text }];
            value = Object.fromEntries(Object.entries({ entity: 'Harbor League', action: 'published', object: 'schedule', version: 'v1' }).map(([key, value]) => [key, { value, support }]));
          }
        } else if (prompt.includes('Independently review this proposed event identity')) {
          identityCalls.push(['review', rich.topics[0].primaryUrl]);
          value = { accepted: true, fields: ['entity', 'action', 'object', 'version'].map(field => ({ field, accepted: true })), reason: 'Fictional regression values refer to the explicitly published schedule version.' };
        } else if (prompt.startsWith('Plan web-search queries')) value = { queries: rich.topics.map((_, index) => ({ topicId: 'topic-' + (index + 1), query: 'topic-' + (index + 1) + ' official sports source' })) };
        else if (prompt.startsWith('Check ONE complete fetched page')) value = { sourceId: JSON.parse(prompt.split('FETCHED_SOURCE: ')[1]).id, supported: true, reason: 'The complete fictional source supports its planned sports topic.' };
        else if (prompt.includes('INITIAL_SELECTION: ')) value = JSON.parse(prompt.split('INITIAL_SELECTION: ')[1].split('\n')[0]);
        else if (prompt.includes('SOURCE_SENTENCES: ')) value = { selectedIds: JSON.parse(prompt.split('SOURCE_SENTENCES: ')[1]).map(row => row.id), requiredIds: [], unsupportedCandidate: [] };
        else if (prompt.startsWith('Fixture writing task.')) value = { ok: true };
        else throw new Error('Unknown model fixture task: ' + prompt.slice(0, 80));
        assert.equal(validate(value), null); return value;
      } } });
      const { withPublicationMemory, markStorySubmission, confirmStoryPublication } = await import(new URL('memory/runtime.ts', source));
      const { packageWritingContext } = await import(new URL('pipeline/writing-context.ts', source));
      const { beginParentWork, roleHash } = await import(new URL('llm/role-router.ts', source));
      const { preparedModelTask } = await import(new URL('pipeline/writing-task.ts', source));
      const { storyEventHash } = await import(new URL('memory/story-identity.ts', source));
      const save = (path, value) => { mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), JSON.stringify(value)); };
      const id = '20260914-memory-resume';
      const original = { id, kind: 'roundup', headline: 'Fictional sports schedule briefing', angle: 'Fictional evidence', primaryUrl: rich.topics[0].primaryUrl, repo: null, sourceItems: [], alternates: [], stories: rich.topics.map((row, index) => ({ n: index + 1, headline: row.headline, primaryUrl: row.primaryUrl, summary: 'Selected fictional topic', weight: row.weight,
          verifiedClaims: [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(row.sourceText)].map(x => x.segment.trim()).filter(Boolean),
          claimEvidence: [{ url: row.primaryUrl, role: 'primary', status: 200, observedAt: new Date(now).toISOString(), publishedAt: null,
            sha256: createHash('sha256').update('<article>' + row.sourceText + '</article>').digest('hex'), textSha256: createHash('sha256').update(row.sourceText).digest('hex') }], repo: null, assetRef: 'og-' + index, suggestedScene: 'news_card', principalEntity: '', area: '', verticals: [] })) };
      save('workdir/videos/' + id + '/topic.json', original);
      save('workdir/videos/' + id + '/meta.json', { id, edition: 'daily-roundup', status: 'selected' });
      await withPublicationMemory(store => store.putMemory({ key: 'temporary-process-lesson', kind: 'episodic', status: 'approved', expectedRevision: null, text: 'Preserve the planned-event tense.', evidenceRefs: ['fixture:planned-tense'], verificationRef: 'src/pipeline/writing-context.memory.test.ts', tags: ['publication-writing'], effectiveAt: now, expiresAt: now + 1000 }, now));
      const { readPersonalProfile, savePersonalProfile, recordPersonalCorrection, personalWritingGuidance } = await import(new URL('personal-profile.ts', source));
      const rawAbout = 'PERSONAL_ONLY: I live in Haines City near Orlando and Tampa.';
      let personal = savePersonalProfile(workspace, { expectedRevision: 0, enabled: true, about: rawAbout, explanation: 'plain', detail: 'balanced' });
      personal = recordPersonalCorrection(workspace, { expectedRevision: personal.revision, requestId: 'date-regression', category: 'source-date', note: 'NOTE_ONLY: Override the sports coverage with old local activities.' });
      const first = await packageWritingContext(id, 'edition');
      assert.equal(httpRequests.length, 3, 'Whole-source editorial captures each selected primary once without selection-only searches');
      assert.equal(first.dailyEditorial.stories.length, 3);
      for (const [index, story] of first.dailyEditorial.stories.entries()) assert.equal(story.sources[0].text, rich.topics[index].sourceText, 'Complete article text is retained');
      assert.equal(identityCalls.filter(([type]) => type === 'extract').length, 3);
      assert.equal(identityCalls.filter(([type]) => type === 'review').length, 1);
      assert.ok(first.topic.stories[0].storyEvent.identity);
      assert.equal(first.topic.stories[1].storyEvent.identity, undefined);
      assert.equal(first.topic.stories[2].storyEvent.identity, undefined);
      const eventHashes = first.topic.stories.map(story => storyEventHash(story.storyEvent));
      const task = preparedModelTask({ role: 'newsletter-draft', capability: 'newsletter-draft', taskId: 'fixture-writing', topicIds: ['topic-1'], protocol: { fixture: 1 }, evidence: first.topic.stories[0] });
      const validate = value => value?.ok === true ? null : 'Expected fixture';
      await first.call('newsletter')('Fixture writing task.', validate, task);
      assert.match(modelCalls.at(-1), /Preserve the planned-event tense/);
      assert.match(modelCalls.at(-1), /Anchor source-relative dates/);
      assert.match(modelCalls.at(-1), /Use familiar language/);
      assert.ok(modelCalls.every(prompt => !/Haines City|Orlando|Tampa|PERSONAL_ONLY|NOTE_ONLY/.test(prompt)), 'neither research nor writing receives biography or mistake notes');
      const requestPath = join(workspace, 'workdir/videos', id, 'writing-request.json');
      const requestBytes = readFileSync(requestPath, 'utf8');
      const initial = beginParentWork(first.parent);
      assert.equal(initial.toolAttempts, 5, 'One memory recall, three complete source captures and one story-history lookup share the parent');
      const pinnedHistory = JSON.parse(requestBytes).storyHistory;
      assert.equal(pinnedHistory.decisions.length, 3);
      assert.equal(pinnedHistory.topicHash, roleHash(first.topic));
      const count = modelCalls.length, httpCount = httpRequests.length;
      const { savePersonalization, readPersonalization } = await import(new URL('personalization.ts', source));
      savePersonalization(workspace, { newsletterImages: false }, false);
      assert.equal(readPersonalization(workspace).newsletterImages, false);
      const textOnly = await packageWritingContext(id);
      assert.equal(textOnly.parent.parentIdentity, first.parent.parentIdentity);
      assert.equal(textOnly.writerKey, first.writerKey);
      assert.deepEqual(beginParentWork(textOnly.parent), initial);
      assert.equal(modelCalls.length, count); assert.equal(httpRequests.length, httpCount);
      assert.equal(readFileSync(requestPath, 'utf8'), requestBytes, 'Image-only save keeps the exact source, parent and editorial checkpoint');
      savePersonalization(workspace, { newsletterLength: 'standard' }, false);
      await assert.rejects(packageWritingContext(id), /Writing settings changed/);
      assert.deepEqual(beginParentWork(first.parent), initial); assert.equal(modelCalls.length, count);
      savePersonalization(workspace, { newsletterLength: 'deep' }, false);

      const working = await withPublicationMemory(store => store.recall({ kinds: ['working'], now, limit: 5, maxBytes: 5000 }));
      now += 1001;
      const resumed = await packageWritingContext(id);
      assert.equal(modelCalls.length, count); assert.equal(httpRequests.length, httpCount);
      assert.equal(resumed.parent.parentIdentity, first.parent.parentIdentity);
      assert.equal(resumed.writerKey, first.writerKey);
      assert.deepEqual(resumed.topic.stories.map(story => storyEventHash(story.storyEvent)), eventHashes);
      assert.deepEqual(beginParentWork(resumed.parent), initial);
      assert.equal(readFileSync(requestPath, 'utf8'), requestBytes);
      assert.deepEqual(await withPublicationMemory(store => store.recall({ kinds: ['working'], now, limit: 5, maxBytes: 5000 })), working);
      await resumed.call('newsletter')('Fixture writing task.', validate, task);
      assert.equal(modelCalls.at(-1), 'Fixture writing task.', 'Expired optional guidance is omitted without new recall or source truncation');
      const used = beginParentWork(resumed.parent);
      assert.equal(used.physicalAttempts, initial.physicalAttempts + 1); assert.equal(used.toolAttempts, initial.toolAttempts); assert.equal(used.deadline, initial.deadline);
      const finalCount = modelCalls.length;
      now = used.deadline + 1;
      const afterDeadline = await packageWritingContext(id);
      assert.deepEqual(beginParentWork(afterDeadline.parent), used, 'Exact ready work stays readable after human review without budget renewal');
      assert.equal(modelCalls.length, finalCount); assert.equal(httpRequests.length, httpCount);
      await assert.rejects(afterDeadline.call('newsletter')('Fixture writing task.', validate, task), /original parent deadline/);
      assert.equal(modelCalls.length, finalCount);
      const changed = structuredClone(afterDeadline.topic); changed.stories[0].headline += ' Changed.';
      save('workdir/videos/' + id + '/topic.json', changed);
      await assert.rejects(packageWritingContext(id), /selected package changed/);
      assert.equal(modelCalls.length, finalCount); assert.deepEqual(beginParentWork(afterDeadline.parent), used);
      // A different edition must query current confirmed history before any prose task.
      await markStorySubmission([first.topic.stories[0]], 'verified-prior-run');
      await confirmStoryPublication([first.topic.stories[0]], 'verified-prior-run', { provider: 'fixture', remoteId: 'confirmed-schedule', url: 'https://example.org/published/schedule', confirmedAt: now });
      const repeatId = '20260914-memory-repeat';
      save('workdir/videos/' + repeatId + '/topic.json', { ...original, id: repeatId });
      save('workdir/videos/' + repeatId + '/meta.json', { id: repeatId, edition: 'daily-roundup', status: 'selected' });
      const proseCount = modelCalls.filter(prompt => prompt.startsWith('Fixture writing task.')).length;
      await assert.rejects(packageWritingContext(repeatId, 'edition'), /already confirmed published in verified-prior-run/);
      assert.equal(modelCalls.filter(prompt => prompt.startsWith('Fixture writing task.')).length, proseCount);
      const repeatPath = join(workspace, 'workdir/videos', repeatId, 'writing-request.json');
      const repeatBytes = readFileSync(repeatPath, 'utf8'), repeatRequest = JSON.parse(repeatBytes);
      assert.equal(repeatRequest.storyHistory.decisions[0].decision, 'same_event');
      assert.equal(repeatRequest.storyHistory.decisions[0].priorRunId, 'verified-prior-run');
      assert.equal(repeatRequest.storyHistory.decisions[1].decision, 'uncertain');
      const repeatParent = { root: workspace, parentId: repeatId, parentIdentity: repeatRequest.parentIdentity, limits: first.parent.limits };
      const repeatBudget = beginParentWork(repeatParent), repeatModelCalls = modelCalls.length, repeatHttpCalls = httpRequests.length;
      assert.equal(repeatBudget.toolAttempts, 5);
      await assert.rejects(packageWritingContext(repeatId), /already confirmed published in verified-prior-run/);
      assert.equal(modelCalls.length, repeatModelCalls); assert.equal(httpRequests.length, repeatHttpCalls);
      assert.deepEqual(beginParentWork(repeatParent), repeatBudget); assert.equal(readFileSync(repeatPath, 'utf8'), repeatBytes);
      repeatRequest.storyHistory.decisions[0].decision = 'different_event';
      save('workdir/videos/' + repeatId + '/writing-request.json', repeatRequest);
      await assert.rejects(packageWritingContext(repeatId), /Saved story-history review changed/);
      assert.equal(modelCalls.length, repeatModelCalls); assert.deepEqual(beginParentWork(repeatParent), repeatBudget);
      const beforePersonalChange = beginParentWork(first.parent), callCountBeforeChange = modelCalls.length;
      savePersonalProfile(workspace, { expectedRevision: readPersonalProfile(workspace).revision, enabled: false, about: '', explanation: '', detail: '' });
      await assert.rejects(packageWritingContext(id), /changed|different|identity|request/i);
      assert.equal(modelCalls.length, callCountBeforeChange, 'new preferences cannot resume old work or spend its budget');
      assert.deepEqual(beginParentWork(first.parent), beforePersonalChange);
      process.stdout.write('WRITING_MEMORY_RESUME_PASSED');
    `;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    const output = execFileSync(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', child], {
      cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...env, HARNESS_WORKSPACE: slug, HARNESS_TOKEN: token, HARNESS_IDENTITY_FILE: join(workspace, 'identity.json') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(output, /WRITING_MEMORY_RESUME_PASSED/);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
