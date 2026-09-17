/** Render real compositions and inspect their encoded pixels at phone widths. No model/provider calls. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderStill, selectComposition, renderMedia } from '@remotion/renderer';
import { chromium } from 'playwright';

const out = resolve(process.env.PRESENTATION_OUT || 'workdir/presentation-check');
mkdirSync(out, { recursive: true });
const serveUrl = await bundle({ entryPoint: resolve('video/index.ts'), publicDir: null });
const browser = await openBrowser('chrome', { chromiumOptions: { gl: 'angle' } });
const files: string[] = [];
const short = { headline: 'Layout check', hook: 'AI math announcements can come before proper writeups and credit.',
  segments: [{ scene: 'news_card', voiceover: 'A story', startSec: 6, endSec: 8, onScreen: { title: 'A readable story' }, assetFile: null }],
  cta: 'Review the sources', durationSec: 9, audioFile: '', words: [], accent: '#7C5CFF', avatarMode: 'cards' };
const basePlan = { version: 1, kind: 'three', mechanism: 'data-flow', intent: 'An open source gateway', reason: 'Show a gateway connecting services', labels: ['Open-Source Gateway', 'One Free Endpoint'], cues: [], caveat: 'Vendor-described project claims', sourceUrl: 'https://example.org', decision: 'fallback' };
const introShort = { ...short, hook: 'A simulation found limits.', prelude: [
  { kind: 'hook', text: 'A simulation found limits.', startSec: 0, endSec: 3 },
  { kind: 'intro', text: 'This is Example Briefing.', startSec: 3, endSec: 6 },
] };
const snapshot = { caption: 'A new public report explains the project’s limits — news.example.org', publisher: 'news.example.org', sourceUrl: 'https://news.example.org/report' };
const snapshotSegment = { ...short.segments[0], sourceSnapshot: snapshot, motion: { status: 'Early findings; independent review is still underway.' } };
try {
  for (const [name, id, inputProps, frame] of [
    ['hook-opening', 'Short', short, 1],
    ['hook-complete', 'Short', short, 90],
    ['hook-long-word', 'Short', { ...short, hook: 'ANTHROPIC’S-SUPERCALIFRAGILISTICEXPIALIDOCIOUS' }, 30],
    ['prelude-hook', 'Short', introShort, 60],
    ['prelude-intro', 'Short', introShort, 150],
    ['prelude-story', 'Short', introShort, 210],
    ['snapshot-overrides-stat-chart', 'Short', { ...short, segments: [{ ...snapshotSegment, scene: 'stat_chart' }] }, 210],
    ['snapshot-overrides-diagram', 'Short', { ...short, segments: [{ ...snapshotSegment, diagram: { svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Unselected diagram</text></svg>' } }] }, 210],
    ['newsletter-two-labels', 'StoryVisual', { plan: basePlan, accent: '#7C5CFF' }, 40],
    ['newsletter-four-labels', 'StoryVisual', { plan: { ...basePlan, labels: ['Source records', 'Public review', 'Verified findings', 'Release decision'] }, accent: '#008C86' }, 40],
  ] as const) {
    const composition = await selectComposition({ serveUrl, id, inputProps, puppeteerInstance: browser });
    const file = join(out, name + '.png');
    await renderStill({ serveUrl, composition, inputProps, frame, puppeteerInstance: browser, output: file });
    files.push(file);
  }
  const inputProps = { plan: basePlan, accent: '#7C5CFF' };
  const composition = await selectComposition({ serveUrl, id: 'StoryVisual', inputProps, puppeteerInstance: browser });
  await renderMedia({ serveUrl, composition, inputProps, puppeteerInstance: browser, codec: 'h264', outputLocation: join(out, 'newsletter-animation.mp4'), concurrency: 1 });
  const introComposition = await selectComposition({ serveUrl, id: 'Short', inputProps: introShort, puppeteerInstance: browser });
  await renderMedia({ serveUrl, composition: introComposition, inputProps: introShort, puppeteerInstance: browser, codec: 'h264', outputLocation: join(out, 'prelude-transition.mp4'), concurrency: 1 });
  const broken = { ...short, segments: [{ ...short.segments[0], onScreen: { title: 'W'.repeat(70) } }] };
  const brokenComposition = await selectComposition({ serveUrl, id: 'Short', inputProps: broken, puppeteerInstance: browser });
  await assert.rejects(renderStill({ serveUrl, composition: brokenComposition, inputProps: broken, frame: 195, puppeteerInstance: browser }), /TEXT OVERFLOW/);
} finally { await browser.close({ silent: true }); }
const phone = await chromium.launch();
try {
  for (const width of [320, 390]) {
    const page = await phone.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    const html = `<style>body{margin:0;font:16px Arial;background:#eee}img{display:block;width:100%;height:auto}p{padding:8px}</style>` + files.map(file => `<p>${file.split('/').pop()}</p><img src="data:image/png;base64,${readFileSync(file).toString('base64')}">`).join('');
    await page.setContent(html); await page.evaluate(() => Promise.all(Array.from(document.images, img => img.decode())));
    await page.screenshot({ path: join(out, `phone-${width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await page.close();
  }
} finally { await phone.close(); }
writeFileSync(join(out, 'receipt.json'), JSON.stringify({ passed: true, files, phoneWidths: [320, 390], rejectedBrokenTitle: true, animation: 'newsletter-animation.mp4', preludeAnimation: 'prelude-transition.mp4', preludeSeconds: { hook: [0, 3], intro: [3, 6], story: [6, 8] }, audioSynthesized: false }, null, 2));
console.log(`Presentation checks passed: ${out}`);
