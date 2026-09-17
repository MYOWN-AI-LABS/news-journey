import { visualMediaProblem } from "./visual-media.js";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { log } from "../util.js";
import type { NewsletterData } from "./newsletter-html.js";
import { DIAGRAM_CSS, ROUGH_FILTER_DEFS, diagramStyleForDay, withMotionPackets, type DiagramStyle } from "./diagram-style.js";
import { SCHEMATIC_CSS } from "./story-schematic.js";

/** Wide enough that LinkedIn's article column does not upscale it; 2x for retina. */
const WIDTH = 1200;
const SCALE = 2;

export function diagramShotHtml(
  svg: string,
  o: { accent: string; style: DiagramStyle; width: number; frozen?: boolean },
): string {
  const accentRgb = o.accent.replace("#", "").match(/.{2}/g)!.map((h) => parseInt(h, 16)).join(",");
  return `<!doctype html><meta charset="utf-8">
<style>
  :root{--accent:${o.accent};--accentRgb:${accentRgb}}
  html,body{margin:0;padding:0;background:#0E0F13}
  .tm-shot{width:${o.width}px;padding:28px;box-sizing:border-box;background:#0E0F13}
  .tm-stage{padding:18px;border-radius:12px}
  .tm-story-svg{width:100%;height:auto;display:block}
  ${SCHEMATIC_CSS}
  ${DIAGRAM_CSS}
</style>
${ROUGH_FILTER_DEFS}
<div class="tm-shot" data-diagram-style="${o.style}"${o.frozen ? " data-tm-frozen" : ""}><div class="tm-stage">${withMotionPackets(svg)}</div></div>`;
}

export function diagramPngPath(dir: string, key: string, storyNumber: number): string {
  return join(dir, `${key}-story-${storyNumber}.png`);
}

/**
 * One diagram → one PNG at an arbitrary width (the phone-scale critic renders at 390 px). Same
 * page as every other raster, so what the judge sees is what a viewer sees.
 */
export async function renderDiagramShot(
  svg: string,
  o: { accent: string; style: DiagramStyle; width: number; context?: {title:string;caption:string} },
  outPath: string,
): Promise<string> {
  const browser = await chromium.launch();
  const deadline = setTimeout(() => { void browser.close(); }, 30_000);
  try {
    const page = await browser.newPage({ viewport: { width: o.width, height: 900 }, deviceScaleFactor: 1 });
    let html = diagramShotHtml(svg, o);
    if (o.context) {
      const esc = (v: string) => v.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      html += `<style>.tm-shot{position:relative;padding:100px 12.31% 180px;min-height:693px}.tm-shot .tm-stage{padding:0}.phone-title{position:absolute;top:30px;left:23px;right:23px;color:white;font:700 20px/1.1 Arial}.phone-caption{position:absolute;bottom:35px;left:23px;right:23px;color:white;font:700 20px/1.2 Arial}</style>`;
      html = html.replace('<div class="tm-stage">', `<div class="phone-title">${esc(o.context.title)}</div><div class="phone-caption">${esc(o.context.caption)}</div><div class="tm-stage">`);
    }
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForTimeout(350);
    await page.locator(".tm-shot").screenshot({ path: outPath });
    const labels = await page.locator("svg.tm-story-svg text").evaluateAll(nodes => nodes.map(node => {
      const text=node as SVGTextElement, matrix=text.getScreenCTM(), box=text.getBoundingClientRect();
      const size=parseFloat(getComputedStyle(text).fontSize)*Math.hypot(matrix?.a??1,matrix?.b??0);
      const original=text.getAttribute("textLength");
      if(original)text.removeAttribute("textLength");
      const natural=text.getComputedTextLength();
      if(original)text.setAttribute("textLength",original);
      return {text:text.textContent,fontPx:size,effectiveFontPx:size*(original?Math.min(1,Number(original)/natural):1),left:box.left,right:box.right};
    }));
    writeFileSync(`${outPath}.metrics.json`,JSON.stringify({width:o.width,labels,problems:labels.filter(l=>l.effectiveFontPx<16 || l.left<0 || l.right>o.width)},null,2));
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
  if (!existsSync(outPath)) throw new Error(`failed to write ${outPath}`);
  return outPath;
}

/**
 * Render one PNG per story diagram and return their paths in story order.
 *
 * Throws rather than returning a short list: a partially illustrated issue is the failure this
 * whole feature exists to stop, and the publish gate must be able to trust the count.
 */
export async function renderDiagramPngs(
  outDir: string,
  key: string,
  day: string,
  data: NewsletterData,
): Promise<string[]> {
  const stories = data.motionStories ?? [];
  if (!stories.length) throw new Error(`${key}: no motion stories — nothing to rasterize`);
  mkdirSync(outDir, { recursive: true });

  const style = diagramStyleForDay(day);
  const accent = data.editionAccent ?? "#7C5CFF";
  const paths: string[] = [];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: 900 },
      deviceScaleFactor: SCALE,
    });
    for (const [i, story] of stories.entries()) {
      const n = i + 1;
      const plan = story.diagram?.visual;
      if (plan && plan.kind !== "diagram") {
        const problem = visualMediaProblem(plan);
        if (problem) throw new Error(`${key}: story ${n}: ${problem}`);
        const out = diagramPngPath(outDir, key, n);
        writeFileSync(out, Buffer.from(plan.media!.poster.split(",")[1], "base64"));
        paths.push(out);
        continue;
      }
      const svg = story.diagram?.svg;
      if (!svg) throw new Error(`${key}: story ${n} has no diagram svg — rebuild the issue`);

      // Same stylesheet, same filter defs, same per-issue style as the archive render, so the PNG
      // and the web issue are the same drawing by construction rather than by resemblance.
      await page.setContent(diagramShotHtml(svg, { accent, style, width: WIDTH }), { waitUntil: "load" });
      // The roughening filter is applied by the compositor; without settling, an unfiltered frame
      // can be captured and the PNG quietly differs from the issue.
      await page.waitForTimeout(350);

      const shot = page.locator(".tm-shot");
      const out = diagramPngPath(outDir, key, n);
      await shot.screenshot({ path: out });
      if (!existsSync(out)) throw new Error(`${key}: failed to write ${out}`);
      paths.push(out);
    }
  } finally {
    await browser.close();
  }
  log(`diagram PNGs: ${paths.length}/${stories.length} rendered for ${key}`);
  if (paths.length !== stories.length) {
    throw new Error(`${key}: rendered ${paths.length} diagram PNGs for ${stories.length} stories`);
  }
  return paths;
}
