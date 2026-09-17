import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureVisualCandidates, lockVisualChoices } from './visual-choice.js';
import type { StoryDiagram, Topic, TopicStory } from '../types.js';

// Saaket, Sep 17: "all that has to be done is to push that image from the source into the newsletter". The first fix
// (cc0484b) stopped at the candidate list; story-diagram.ts then threw CANNOT_REVIEW_IMAGES for the very source plan it
// built, marked the photo failed and reopened the chooser — the suite stayed green because nothing drove the stage
// function on that path (review finding, ledger #122). This test drives the real ensureEditionDiagrams with a text-only
// writer and a locked photo, mocking only the media renderer and the director.

const claims = ['The guide asks the controller to read the sensor.', 'The guide specifies a response to the sensor.'];
const narration = claims.join(' ');
const story = (n: number): TopicStory => ({ n, headline: 'A controller guide', summary: '', weight: 'standard', primaryUrl: `https://example.com/guide-${n}`,
  repo: null, assetRef: `og-${n - 1}`, suggestedScene: 'news_card', principalEntity: 'Example', area: 'technology', verticals: [], verifiedClaims: [...claims],
  claimEvidence: [{ url: `https://example.com/guide-${n}`, role: 'primary', status: 200, sha256: 'a'.repeat(64), textSha256: 'b'.repeat(64), observedAt: '2026-09-14T00:00:00Z', publishedAt: '2026-09-08',
    restrictions: [{ sourceSentenceId: 9, text: 'These are documented instructions; this guide reports no execution measurements.' }] }] });
const topic = (): Topic => ({ id: '20260917-text-only-photo', kind: 'news', headline: 'Guides', angle: '', sourceItems: [], primaryUrl: story(1).primaryUrl, repo: null, alternates: [], stories: [story(1)] });
const body = [{ assetRef: 'og-0', voiceover: narration, onScreen: { title: 'Documented guide' },
  motion: { who: 'Guide', what: 'Controller instructions', how: narration, impact: 'The guide specifies instructions.', status: 'Documented instructions', kind: 'flow' as const } }];

test('a text-only writer ships the source photo it cannot review: the real stage renders it unreviewed, marks nothing failed and calls no model', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'text-only-photo-'));
  try {
    const dir = join(parent, topic().id); mkdirSync(dir);
    writeFileSync(join(dir, 'topic.json'), JSON.stringify(topic()));
    writeFileSync(join(dir, 'capture.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(100, 1)]));
    writeFileSync(join(dir, 'assets.json'), JSON.stringify({ 'og-0': 'capture.png' }));
    const diagrams: StoryDiagram[] = [{ svg: '', label: '', reading: '', legend: [] }];
    writeFileSync(join(dir, 'diagrams.json'), JSON.stringify(diagrams));
    const candidates = ensureVisualCandidates(dir, body, diagrams, false);
    assert.equal(candidates.stories[0]!.candidates.find(c => c.id === 'image')!.available, true, 'the source photo is offered to a text-only writer');
    lockVisualChoices(dir, candidates, { '0': 'image' }, 'user');
    const child = `
      import assert from 'node:assert/strict'; import { mock } from 'node:test';
      import { readdirSync, existsSync } from 'node:fs';
      const dir=${JSON.stringify(dir)}, topic=${JSON.stringify(topic())}, body=${JSON.stringify(body)};
      globalThis.fetch=async()=>{throw new Error('Unexpected external request');};
      let mediaCalls=0, reviewableSeen=null, mediaPlan=null, directorImages=null;
      const media = await import(${JSON.stringify(new URL('./visual-media.ts', import.meta.url).href)});
      mock.module(${JSON.stringify(new URL('./visual-media.ts', import.meta.url).href)}, { namedExports: { ...media,
        ensureVisualMedia: async(_dir,_n,plan,_accent,_inspect,_theme,reviewable)=>{ mediaCalls++; reviewableSeen=reviewable; mediaPlan=plan;
          return { mp4:'data:video/mp4;base64,AAAAIGZ0eXA=', gif:'data:image/gif;base64,R0lGODlh', poster:'data:image/png;base64,iVBORw0KGgo=', hash:'h', sha256:{mp4:'a',gif:'b',poster:'c'},
            review:{passed:false,unreviewed:true,hash:'h',reason:'Unreviewed: the writer cannot look at images.',at:'now'} }; },
        visualMediaProblem:()=>null } });
      const director = await import(${JSON.stringify(new URL('./visual-director.ts', import.meta.url).href)});
      mock.module(${JSON.stringify(new URL('./visual-director.ts', import.meta.url).href)}, { namedExports: { ...director,
        ensureVisualPlans: async(_dir,_body,_diagrams,_call,_inspect,_can,_key,options)=>{ directorImages=options?.sourceImages??[];
          return [{ version:1, kind:'diagram', intent:'Documented guide', reason:'director', labels:['a','b'], cues:[], caveat:'', sourceUrl:topic.stories[0].primaryUrl, decision:'model', timing:{method:'unmatched',starts:[],duration:6} }]; } } });
      const personalization=await import(${JSON.stringify(new URL('../personalization.ts', import.meta.url).href)});
      mock.module(${JSON.stringify(new URL('../personalization.ts', import.meta.url).href)}, { namedExports: { ...personalization, readPersonalization:()=>({...personalization.readPersonalization(dir),recommendationsAuto:false}) }});
      const {ensureEditionDiagrams}=await import(${JSON.stringify(new URL('./story-diagram.ts', import.meta.url).href)});
      const {readVisualChoices,readVisualCandidates}=await import(${JSON.stringify(new URL('./visual-choice.ts', import.meta.url).href)});
      process.env.HARNESS_VISUAL_CHOICE='require';
      let modelCalls=0, visionCalls=0;
      const out = await ensureEditionDiagrams(dir, body, false, async()=>{ throw new Error('Unused SVG author'); }, {
        topic, day:'2026-09-17', writerKey:'text-only-writer', call:()=>async()=>{ modelCalls++; throw new Error('No model call for a text-only photo'); }, vision:async()=>{ visionCalls++; throw new Error('No vision call for a text-only photo'); }
      });
      assert.equal(mediaCalls, 1, 'the photo reaches the media renderer');
      assert.equal(reviewableSeen, false, 'the renderer is told the writer cannot review');
      assert.equal(mediaPlan.kind, 'source'); assert.equal(mediaPlan.image.file, 'capture.png');
      assert.match(mediaPlan.image.relevance.reason, /^Unreviewed: the writer cannot look at images/);
      assert.deepEqual(directorImages, [], 'the director is never asked to review the photo');
      assert.equal(modelCalls, 0); assert.equal(visionCalls, 0);
      assert.equal(out[0].visual.kind, 'source'); assert.equal(out[0].visual.media.review.unreviewed, true); assert.equal(out[0].visual.media.review.passed, false);
      assert.equal(readVisualChoices(dir).stories['0'].candidateId, 'image', 'the choice stays locked');
      assert.equal(readVisualCandidates(dir).stories[0].candidates.find(c=>c.id==='image').failed, undefined, 'the photo is not marked failed');
      assert.ok(!readdirSync(dir).some(f=>f.startsWith('visual-choice-failure-0-')), 'no failure receipt');
      assert.equal(existsSync(dir+'/visual-results.json'), true);
      console.log('TEXT_ONLY_SOURCE_PHOTO_SHIPS_UNREVIEWED');
    `;
    const output = execFileSync(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', child], { encoding: 'utf8', timeout: 30_000 });
    assert.match(output, /TEXT_ONLY_SOURCE_PHOTO_SHIPS_UNREVIEWED/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
