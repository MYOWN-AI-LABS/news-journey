import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

function fixture(program: string, newsletterBoundary = false): void {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(join(root, 'workspaces'), { recursive: true });
  const workspace = mkdtempSync(join(root, 'workspaces/test-newsletter-images-'));
  const slug = workspace.split(/[\\/]/).at(-1)!, token = 'e'.repeat(64);
  try {
    mkdirSync(join(workspace, 'config'));
    writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({ id: slug }));
    writeFileSync(join(workspace, 'members.json'), JSON.stringify([{ id: 'fixture-owner', role: 'owner', tokenHash: createHash('sha256').update(token).digest('hex') }]));
    const child = `
      import assert from 'node:assert/strict'; import { mock } from 'node:test';
      import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'; import { join } from 'node:path';
      import { createHash } from 'node:crypto'; import http from 'node:http'; import https from 'node:https'; import { syncBuiltinESMExports } from 'node:module';
      let forbidden = 0, renders = 0, formats = 0, archives = 0, acceptedIssue;
      const deny = () => { forbidden++; throw new Error('Newsletter formatting cannot fetch, generate or review source artwork'); };
      globalThis.fetch = deny; http.get = deny; http.request = deny; https.get = deny; https.request = deny; syncBuiltinESMExports();
      const source = ${JSON.stringify(new URL('./', import.meta.url).href)}, workspace = ${JSON.stringify(workspace)};
      const originalDiagram = await import(new URL('story-diagram.ts', source));
      mock.module(new URL('story-diagram.ts', source), { namedExports: { ...originalDiagram, ensureEditionDiagrams: deny } });
      const model = await import(new URL('../llm/model.ts', source));
      mock.module(new URL('../llm/model.ts', source), { namedExports: { ...model, modelJson: deny, modelVisionJson: deny, modelCanReadImages: deny } });
      ${newsletterBoundary ? `
      // Already accepted writing is a fixture; exercise the actual newsletter write/rerender boundary.
      const writing = await import(new URL('writing-context.ts', source));
      mock.module(new URL('writing-context.ts', source), { namedExports: { ...writing,
        packageWritingContext: async () => ({ topic, parent: { parentId: id }, dailyEditorial: {} }) } });
      const editorial = await import(new URL('journey-editorial.ts', source));
      mock.module(new URL('journey-editorial.ts', source), { namedExports: { ...editorial,
        prepareJourneyEditorial: async () => { formats++; return { issue: acceptedIssue }; } } });
      const managed = await import(new URL('../managed-process.ts', source));
      mock.module(new URL('../managed-process.ts', source), { namedExports: { ...managed,
        runManagedProcess: async () => { archives++; } } });
      ` : ''}
      let rendered;
      mock.module(new URL('diagram-gif.ts', source), { namedExports: { renderDiagramGifs: async (dir, key, day, data) => {
        renders++; rendered = structuredClone(data.motionStories); mkdirSync(dir, { recursive: true });
        return data.motionStories.map((_, i) => { const gif = join(dir, 'fixture-' + i + '.gif'); writeFileSync(gif, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)])); return { gif, frame0: '' }; });
      } } });
      const { attachStoryVisuals, assertIssueCarriesVisuals, newsletter, newsletterCacheIdentity } = await import(new URL('newsletter.ts', source));
      const { renderNewsletterHtml } = await import(new URL('newsletter-html.ts', source));
      const { savePersonalization } = await import(new URL('../personalization.ts', source));
      const { readVisualChoices, readVisualCandidates, ensureVisualCandidates, lockVisualChoices } = await import(new URL('visual-choice.ts', source));
      const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const id = '20260915-newsletter-art', dir = join(workspace, 'workdir/videos', id); mkdirSync(dir, { recursive: true });
      const topic = { id, kind: 'news', headline: 'Published schedule', primaryUrl: 'https://example.org/schedule' };
      const motion = { who: 'The league', what: 'Published schedule', how: 'Written notice', impact: 'Listed dates', status: 'Provisional', kind: 'flow' };
      const script = { body: [{ scene: 'news_card', voiceover: 'The league published its provisional schedule.', assetRef: 'og-0', motion, onScreen: { title: 'Published schedule' } }] };
      const save = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
      save('topic.json', topic); save('script.json', script);
      const diagrams = [{ svg: '<svg class="tm-story-svg tm-svg-authored" data-visual-primitive="authored-1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 340"><rect class="tm-sc-node" x="20" y="50" width="200" height="70"/><path class="tm-native-trace" d="M220 85 L420 85"/><rect class="tm-sc-node" x="420" y="50" width="200" height="70"/><text x="30" y="90">Published schedule</text></svg>', label: 'Schedule', reading: 'Published guide', legend: [{ kind: 'source', label: 'Schedule notice' }, { kind: 'result', label: 'Provisional dates' }], visual: { kind: 'diagram' } }];
      const receipt = () => ({ version: 1, topicHash: hash(topic), scriptHash: hash(script), selectionHash: hash({ choices: readVisualChoices(dir), candidates: readVisualCandidates(dir) }), diagrams, contentHash: hash(diagrams) });
      const data = () => ({ date: '2026-09-15', dateLong: 'September 15, 2026', issueNo: 1, video: null, coveredWeek: [], logoDataUri: null,
        publisher: { publication: 'Fixture Sports', name: 'Fixture Editor', audience: 'Sports readers', tone: 'Clear' },
        issue: { subject: 'Published schedule', lead: { title: 'Published schedule', body: 'The league published its provisional schedule.', sourceName: 'Example', sourceUrl: topic.primaryUrl }, items: [], radar: [], signals: [] },
        motionStories: [{ ...motion, n: 1, title: 'STALE_PICTURE', url: topic.primaryUrl, figureDataUri: 'data:image/gif;base64,U1RBTEVfUElDVFVSRQ==' }] });
      ${program}
      assert.equal(forbidden, 0); process.stdout.write('NEWSLETTER_IMAGE_FIXTURE_PASSED');
    `;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    const output = execFileSync(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', child], {
      cwd: root, timeout: 20_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, HARNESS_WORKSPACE: slug, HARNESS_TOKEN: token, HARNESS_IDENTITY_FILE: join(workspace, 'identity.json') },
    });
    assert.match(output, /NEWSLETTER_IMAGE_FIXTURE_PASSED/);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

test('text-only rerender removes cached story pictures before reading or rendering artwork', () => fixture(`
  savePersonalization(workspace, { newsletterImages: false }, false);
  save('newsletter-visuals.json', { invalid: 'Even invalid old optional art cannot block text-only formatting' });
  const issue = data(); await attachStoryVisuals(issue, id);
  assert.deepEqual(issue.motionStories, []); assert.equal(renders, 0);
  const html = renderNewsletterHtml(issue);
  assert.doesNotMatch(html, /<img\\b|STALE_PICTURE|class="topic-motion/); assert.match(html, /provisional schedule/);
`));

test('Daily Signal newsletter visual refuse: missing completed artwork cannot soft-ship on Journey', () => fixture(`
  save('diagrams.json', diagrams);
  const issue = data(); await assert.rejects(attachStoryVisuals(issue, id), /refusing to build.*visual stage/);
  assert.deepEqual(issue.motionStories, []); assert.equal(renders, 0);
  await assert.rejects(attachStoryVisuals(data(), undefined), /selected video package/);
  rmSync(join(dir, 'script.json'));
  await assert.rejects(attachStoryVisuals(data(), id), /selected script/);
`));

test('saved selected artwork is reused verbatim and changed script, topic or visual bytes fail before presentation', () => fixture(`
  save('newsletter-visuals.json', receipt());
  const issue = data(); await attachStoryVisuals(issue, id);
  assert.equal(renders, 1); assert.equal(issue.motionStories.length, 1);
  assert.deepEqual(rendered[0].diagram, diagrams[0]); assert.match(issue.motionStories[0].figureDataUri, /^data:image\\/gif;base64,/);
  assert.doesNotMatch(renderNewsletterHtml(issue), /STALE_PICTURE/);
  assert.doesNotThrow(() => assertIssueCarriesVisuals(id, issue, renderNewsletterHtml(issue)));
  const original = receipt();
  for (const wrong of [{ ...original, scriptHash: hash('other script') }, { ...original, topicHash: hash('other topic') }, { ...original, selectionHash: hash('previous image choice') }, { ...original, diagrams: [{ ...diagrams[0], label: 'Changed label' }] }]) {
    save('newsletter-visuals.json', wrong); await assert.rejects(attachStoryVisuals(data(), id), /differs from its selected script/);
  }
  assert.equal(renders, 1);
  save('newsletter-visuals.json', original);
  save('visual-choices.json', { version: 1, videoId: id, stories: { '0': { candidateId: 'snapshot', candidateHash: 'new selection', chosenBy: 'user' } } });
  await assert.rejects(attachStoryVisuals(data(), id), /differs from its selected script/);
  assert.equal(renders, 1, 'Changing the saved user choice cannot display the previous selection');
  rmSync(join(dir, 'visual-choices.json'));
  diagrams[0].visual = { kind: 'source', image: { dataUri: 'data:image/png;base64,c2F2ZWQ=', file: 'saved-photo.png' }, media: { hash: 'retained media hash' } };
  save('newsletter-visuals.json', receipt()); await assert.rejects(attachStoryVisuals(data(), id), /missing mp4 bytes/);
  assert.equal(renders, 1, 'Invalid selected media cannot be replaced by the unused SVG');
`));

test('Journey assertIssueCarriesVisuals refuses empty fallback diagrams and incomplete story coverage before GIF rendering', () => fixture(`
  diagrams[0] = { svg: '', label: '', reading: '', legend: [], visual: { kind: 'diagram', decision: 'fallback' } };
  save('newsletter-visuals.json', receipt());
  await assert.rejects(attachStoryVisuals(data(), id), /refusing to build or publish[\\s\\S]*no <svg>/);
  assert.equal(renders, 0);
  assert.throws(() => assertIssueCarriesVisuals(id, { ...data(), motionStories: [] }), /0 motion stories/);
`));

test('Journey newsletter visual refuse rejects a partial three-story slate without dropping the empty fallback', () => fixture(`
  topic.stories = [0, 1, 2].map(i => ({ assetRef: 'og-' + i, primaryUrl: topic.primaryUrl + '/' + i }));
  const first = script.body[0], drawing = diagrams[0];
  script.body = topic.stories.map(story => ({ ...first, assetRef: story.assetRef }));
  diagrams.push({ ...drawing, svg: drawing.svg.replace('authored-1', 'authored-2') },
    { svg: '', label: '', reading: '', legend: [], visual: { kind: 'diagram', decision: 'fallback' } });
  save('topic.json', topic); save('script.json', script); save('newsletter-visuals.json', receipt());
  const issue = data(); issue.issue.lead.sourceUrl = topic.stories[0].primaryUrl;
  issue.issue.items = topic.stories.slice(1).map(story => ({ name: 'Schedule', url: story.primaryUrl, line: 'Provisional dates.' }));
  await assert.rejects(attachStoryVisuals(issue, id), /story 3 diagram carries no <svg>/);
  assert.equal(issue.motionStories.length, 3); assert.equal(renders, 0);
`));

test('Journey assertIssueCarriesVisuals accepts real SVG motion stories and rejects missing or substituted rendered artwork', () => fixture(`
  save('newsletter-visuals.json', receipt());
  const issue = data(); await attachStoryVisuals(issue, id);
  const html = renderNewsletterHtml(issue);
  assert.doesNotThrow(() => assertIssueCarriesVisuals(id, issue, html));
  assert.match(html, /Fixture Sports/); assert.match(html, /Fixture Editor/);
  assert.doesNotMatch(html, /Daily Signal/);
  const missing = html.replace(/<figure\\b[\\s\\S]*?<\\/figure>/g, '');
  assert.throws(() => assertIssueCarriesVisuals(id, issue, missing), /artwork is missing/);
  assert.throws(() => assertIssueCarriesVisuals(id, issue, missing + '<!--' + html + '-->'), /artwork is missing/);
  assert.throws(() => assertIssueCarriesVisuals(id, issue, html.replace('data-visual-primitive="authored-1"', 'data-visual-primitive="authored-2"')), /selected SVG missing/);
  assert.throws(() => assertIssueCarriesVisuals(id, issue, html.replace('@keyframes tm-native-flow', '@keyframes removed')), /motion stylesheet/);
  issue.issue.items.push({ name: 'Other schedule', url: 'https://example.org/other', line: 'Another notice.' });
  assert.throws(() => assertIssueCarriesVisuals(id, issue), /2 main stories[\\s\\S]*main story 2/);
  issue.issue.items[0].url = topic.primaryUrl;
  assert.throws(() => assertIssueCarriesVisuals(id, issue), /main story 2/);
  script.body[0].motion = undefined; save('script.json', script); save('newsletter-visuals.json', receipt());
  await assert.rejects(attachStoryVisuals(data(), id), /no source-bound motion/);
`));

test('Daily Signal assertIssueCarriesVisuals gates Journey write and rerender before replacing any saved output', () => fixture(`
  mkdirSync(join(workspace, 'config/editions'), { recursive: true });
  writeFileSync(join(workspace, 'config/editions/daily-roundup.json'), JSON.stringify({ editionId: 'daily-roundup', displayName: 'Fixture Sports',
    newsletterTitle: 'Fixture Sports', videoAccent: '#008C86', coverFile: 'fixture.svg', newsletterLine: 'Fixture Sports', wordBudget: null }));
  writeFileSync(join(workspace, 'config/publisher.json'), JSON.stringify(data().publisher));
  savePersonalization(workspace, { newsletterImages: true, newsletterLength: 'quick', organization: 'Fixture League', accent: '#008C86' }, false);
  save('meta.json', { id, status: 'assets_ready', headline: topic.headline, posts: { linkedin: { url: 'https://www.linkedin.com/posts/fixture' } } });
  acceptedIssue = data().issue; acceptedIssue.lead.body = Array(50).fill('The schedule is provisional pending approval.').join(' ');
  const day = '2026-09-15', out = join(workspace, 'workdir/newsletters');
  const paths = ['json', 'md', 'html', 'linkedin.html'].map(ext => join(out, day + '.' + ext));
  const valid = structuredClone(diagrams[0]);
  diagrams[0] = { svg: '', label: '', reading: '', legend: [], visual: { kind: 'diagram', decision: 'fallback' } };
  save('newsletter-visuals.json', receipt());
  await assert.rejects(newsletter(day, false, undefined, id), /refusing to build or publish/);
  assert.ok(paths.every(path => !existsSync(path))); assert.equal(renders, 0); assert.equal(archives, 0);

  diagrams[0] = valid; save('newsletter-visuals.json', receipt());
  const htmlPath = await newsletter(day, false, undefined, id);
  const original = paths.map(path => readFileSync(path, 'utf8'));
  const saved = JSON.parse(original[0]);
  assert.equal(saved.motionStories.length, 1); assert.deepEqual(saved.issue, acceptedIssue);
  assert.doesNotThrow(() => assertIssueCarriesVisuals(id, saved, readFileSync(htmlPath, 'utf8')));
  assert.match(original[2], /Fixture Sports/); assert.match(original[2], /Fixture League/);
  assert.match(original[3], /data:image\\/gif;base64,/);

  diagrams[0] = { svg: '', label: '', reading: '', legend: [], visual: { kind: 'diagram', decision: 'fallback' } };
  save('newsletter-visuals.json', receipt());
  const formatted = formats, archived = archives;
  await assert.rejects(newsletter(day, true, undefined, id), /refusing to build or publish/);
  assert.deepEqual(paths.map(path => readFileSync(path, 'utf8')), original);
  assert.equal(formats, formatted); assert.equal(archives, archived);

  // Valid data must still be refused if the customer's shell omits the figures.
  diagrams[0] = valid; save('newsletter-visuals.json', receipt());
  mkdirSync(join(workspace, 'branding'), { recursive: true });
  writeFileSync(join(workspace, 'branding/newsletter.html'), '<html><body>{{publication}} {{subject}}</body></html>');
  for (const rerender of [false, true]) {
    await assert.rejects(newsletter(day, rerender, undefined, id), /artwork is missing/);
    assert.deepEqual(paths.map(path => readFileSync(path, 'utf8')), original);
    assert.equal(archives, archived);
  }
  rmSync(join(workspace, 'branding/newsletter.html'));
  await newsletter(day, true, undefined, id);
  assert.doesNotThrow(() => assertIssueCarriesVisuals(id, JSON.parse(readFileSync(paths[0], 'utf8')), readFileSync(paths[2], 'utf8')));
`, true));

test('explicit snapshots remain text-only with source-position placeholders and cannot exempt missing selected artwork', () => fixture(`
  topic.stories = [0, 1].map(i => ({ assetRef: 'og-' + i, primaryUrl: topic.primaryUrl, headline: 'Published schedule' }));
  script.body.push({ ...script.body[0], assetRef: 'og-1' });
  diagrams.push({ ...diagrams[0], svg: diagrams[0].svg.replace('authored-1', 'authored-2') });
  save('topic.json', topic); save('script.json', script);
  const candidates = ensureVisualCandidates(dir, script.body, diagrams, true);
  lockVisualChoices(dir, candidates, { '0': 'snapshot' }, 'user');
  diagrams[0] = { svg: '', label: '', reading: '', legend: [], visual: { kind: 'diagram' } };
  save('newsletter-visuals.json', receipt());
  const issue = data(); issue.issue.items.push({ name: 'Second schedule', url: topic.primaryUrl, line: 'A second source-owned paragraph.' });
  const prose = JSON.stringify(issue.issue);
  await attachStoryVisuals(issue, id);
  assert.equal(issue.motionStories[0].kind, 'text-card'); assert.equal(issue.motionStories[0].diagram, undefined);
  assert.equal(rendered.length, 1); assert.equal(rendered[0].n, 2);
  const html = renderNewsletterHtml(issue);
  assert.doesNotMatch(html, /data-story-index="1"/); assert.match(html, /data-story-index="2"/);
  assert.doesNotThrow(() => assertIssueCarriesVisuals(id, issue, html));
  assert.equal(JSON.stringify(issue.issue), prose);
  assert.throws(() => assertIssueCarriesVisuals(id, structuredClone(issue)), /no verified text-card selection/);
  const choices = readVisualChoices(dir); choices.stories['0'].candidateHash = 'stale'; save('visual-choices.json', choices);
  save('newsletter-visuals.json', receipt());
  await assert.rejects(attachStoryVisuals(data(), id), /Choose a visual/);
  lockVisualChoices(dir, candidates, { '0': 'snapshot' }, 'recommendation'); save('newsletter-visuals.json', receipt());
  await assert.rejects(attachStoryVisuals(data(), id), /no <svg>/);
  assert.equal(renders, 1);
`));

test('source-account cards require the exact pinned packet and saved selection without fabricating motion or artwork', () => fixture(`
  const claims = ['The league published its provisional schedule.'];
  const evidence = [{ url: topic.primaryUrl, role: 'primary', status: 200, sha256: 'a'.repeat(64), observedAt: '2026-09-15T10:00:00Z' }];
  topic.stories = [{ assetRef: 'og-0', n: 1, headline: topic.headline, primaryUrl: topic.primaryUrl, verifiedClaims: claims, claimEvidence: evidence }];
  delete script.body[0].motion;
  script.body[0].sourceAccount = { version: 1, sourceUrl: topic.primaryUrl, claims, packetHash: hash(claims), evidenceHash: hash(evidence) };
  diagrams[0] = { svg: '', label: '', reading: '', legend: [], visual: { kind: 'diagram' } };
  save('topic.json', topic); save('script.json', script);
  const candidates = ensureVisualCandidates(dir, script.body, diagrams, false);
  lockVisualChoices(dir, candidates, { '0': 'snapshot' }, 'recommendation');
  save('newsletter-visuals.json', receipt());
  const issue = data(), prose = JSON.stringify(issue.issue);
  await attachStoryVisuals(issue, id);
  assert.equal(renders, 0); assert.equal(issue.motionStories[0].kind, 'text-card');
  assert.equal(JSON.stringify(issue.issue), prose); assert.equal(script.body[0].motion, undefined);
  assert.doesNotThrow(() => assertIssueCarriesVisuals(id, issue, renderNewsletterHtml(issue)));
  script.body[0].voiceover = 'Changed source account.'; save('script.json', script); save('newsletter-visuals.json', receipt());
  await assert.rejects(attachStoryVisuals(data(), id), /preserve every complete claim/);
  assert.equal(renders, 0);
`));

test('Personalize checkbox serializes false explicitly rather than omitting the option', () => {
  const html = readFileSync(new URL('../executive-page.html', import.meta.url), 'utf8');
  assert.match(html, /type="checkbox" name="newsletterImages" checked/);
  assert.match(html, /newsletterImages:s\.newsletterImages!==false/);
  const line = html.split('\n').find(row => row.startsWith('function personalizeData()'))!;
  assert.ok(line);
  const form = { elements: { recommendationsAuto: { checked: false }, newsletterImages: { checked: false } }, querySelectorAll: () => [] };
  const value = runInNewContext(`${line}; personalizeData()`, { $: () => form, formData: () => ({ newsletterImages: 'on', newsletterLength: 'deep', videoLength: 'standard' }), pendingLogo: '' });
  assert.equal(value.newsletterImages, false); assert.equal(value.newsletterLength, 'deep');
  form.elements.newsletterImages.checked = true;
  assert.equal(runInNewContext(`${line}; personalizeData()`, { $: () => form, formData: () => ({}), pendingLogo: '' }).newsletterImages, true);
});
