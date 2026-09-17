import assert from 'node:assert/strict';
import test from 'node:test';
import type { Script, Timestamps } from '../types.js';
import { narrationSections, publicationIntro, scriptPrelude, spokenScriptText } from './narration.js';
import { buildSegmentTimes } from './visual-timing.js';

test('the publication owns its spoken introduction and rejects markup or an empty name', () => {
  assert.equal(publicationIntro({}, 'The Daily Signal'), 'This is The Daily Signal.');
  assert.equal(publicationIntro({ spokenName: '  Science   Today! ' }, 'Default'), 'This is Science Today.');
  assert.throws(() => publicationIntro({}, '<script>Brand</script>'), /plain publication name/);
  assert.throws(() => publicationIntro({}, '...'), /plain publication name/);
});

test('intro, stories and closing retain their own transcript spans and old scripts still align', () => {
  const script: Script = {
    hook: 'A simulation found limits.', intro: 'This is The Daily Signal.',
    body: [{ voiceover: 'The drone stayed inside bounds.', scene: 'news_card', onScreen: { title: 'Simulation bounds' } }],
    cta: 'Read the sources.', fullVoiceoverText: '',
    publish: { title: 'Simulation', description: '', hashtags: [], linkedinPost: '' },
  };
  const stampsFor = (text: string): Timestamps => {
    const words = text.split(/\s+/).map((w, i) => ({ w, start: i * .5, end: (i + 1) * .5 }));
    return { engine: 'voicebox', words, durationSec: words.at(-1)!.end };
  };
  const stamps = stampsFor(spokenScriptText(script));
  assert.deepEqual(scriptPrelude(script).map(p => p.kind), ['hook', 'intro']);
  assert.deepEqual(narrationSections(script), [script.hook, script.intro, script.body[0].voiceover, script.cta]);
  assert.deepEqual(buildSegmentTimes(script, stamps), [
    { startSec: 0, endSec: 2 }, { startSec: 2, endSec: 4.5 },
    { startSec: 4.5, endSec: 7 }, { startSec: 7, endSec: 8.5 },
  ]);
  const legacy = { ...script, intro: undefined };
  const legacyStamps = stampsFor(spokenScriptText(legacy));
  assert.deepEqual(buildSegmentTimes(legacy, legacyStamps), [
    { startSec: 0, endSec: 2 }, { startSec: 2, endSec: 4.5 }, { startSec: 4.5, endSec: 6 },
  ]);
  assert.throws(() => buildSegmentTimes(script, legacyStamps), /regenerate voice/);
});
