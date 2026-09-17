import { visualMediaProblem } from "./visual-media.js";
import { writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { MEDIA_PROCESS_LIMITS, runManagedProcess } from "../managed-process.js";
import { portableCommand } from "../platform.js";
import { log, ROOT } from "../util.js";
import type { NewsletterData } from "./newsletter-html.js";
import { diagramShotHtml } from "./diagram-png.js";
import { diagramStepCount, diagramStyleForDay, stepAt } from "./diagram-style.js";

/**
 * Encode through Remotion's bundled ffmpeg rather than a separate `ffmpeg-static` dependency.
 *
 * Remotion is already a hard dependency and ships an ffmpeg binary for every supported platform, so
 * this keeps the harness to ONE ffmpeg on disk and one that is known to match the renderer. It is
 * also the exact binary `src/post/publish-qc.ts` decodes with, so an artifact that encodes here is
 * verified by the same code path later. `portableCommand` supplies the Windows `npx.cmd` shim.
 */
async function ffmpeg(args: string[]): Promise<void> {
  const spec = portableCommand("npx", ["remotion", "ffmpeg", ...args]);
  await runManagedProcess(spec.command, spec.args, { operation: 'Newsletter diagram animation', timeoutMs: MEDIA_PROCESS_LIMITS.transform, cwd: ROOT });
}

export const GIF_LOOP_SECONDS = 2.4;
export const GIF_FPS = 10;
/** Stepped (portrait) diagrams: one read-in-order pass, then a hold, looped. */
export const PASS_SECONDS = 3.6;
export const HOLD_SECONDS = 1.0;
/** Narrower than the PNG (1200@2x) on purpose: a 4-figure article is pasted as ONE HTML string. */
export const GIF_WIDTH = 900;

export function diagramGifPath(dir: string, key: string, storyNumber: number): string {
  return join(dir, `${key}-story-${storyNumber}.gif`);
}
/** Frame 0 of the loop as PNG — the reference the content gate compares the landed image against. */
export function diagramGifFramePath(dir: string, key: string, storyNumber: number): string {
  return join(dir, `${key}-story-${storyNumber}-frame0.png`);
}

/**
 * Render one GIF (plus its frame-0 PNG) per story diagram, in story order. Throws rather than
 * returning a short list — a partially illustrated issue is the failure this exists to stop.
 */
export async function renderDiagramGifs(
  outDir: string,
  key: string,
  day: string,
  data: NewsletterData,
): Promise<Array<{ gif: string; frame0: string }>> {
  const stories = data.motionStories ?? [];
  if (!stories.length) throw new Error(`${key}: no motion stories — nothing to animate`);
  mkdirSync(outDir, { recursive: true });
  const style = diagramStyleForDay(day);
  const accent = data.editionAccent ?? "#7C5CFF";
  const frames = Math.round(GIF_LOOP_SECONDS * GIF_FPS);
  const out: Array<{ gif: string; frame0: string }> = [];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: GIF_WIDTH, height: 700 }, deviceScaleFactor: 1 });
    for (const [i, story] of stories.entries()) {
      const n = i + 1;
      const plan = story.diagram?.visual;
      if (plan && plan.kind !== "diagram") {
        const problem = visualMediaProblem(plan);
        if (problem) throw new Error(`${key}: story ${n}: ${problem}`);
        const gif = diagramGifPath(outDir, key, n), frame0 = diagramGifFramePath(outDir, key, n);
        writeFileSync(gif, Buffer.from(plan.media!.gif.split(",")[1], "base64"));
        writeFileSync(frame0, Buffer.from(plan.media!.poster.split(",")[1], "base64"));
        out.push({gif, frame0});
        continue;
      }
      const svg = story.diagram?.svg;
      if (!svg) throw new Error(`${key}: story ${n} has no diagram svg — rebuild the issue`);
      const frameDir = join(outDir, `frames-${n}`);
      rmSync(frameDir, { recursive: true, force: true });
      mkdirSync(frameDir, { recursive: true });
      await page.setContent(diagramShotHtml(svg, { accent, style, width: GIF_WIDTH, frozen: true }), { waitUntil: "load" });
      await page.waitForTimeout(350);
      const shot = page.locator(".tm-shot");
      // PORTRAIT PASS (proposals A + G): a stepped diagram loops one read-in-order pass — each
      // step revealed for an equal share of PASS_SECONDS, then a short hold — instead of the 2.4 s
      // ambient march. Legacy landscape drawings keep the ambient loop.
      const steps = diagramStepCount(svg);
      const passFrames = steps ? Math.round((PASS_SECONDS + HOLD_SECONDS) * GIF_FPS) : frames;
      for (let f = 0; f < passFrames; f++) {
        const t = (f / GIF_FPS).toFixed(3);
        const active = steps ? stepAt(f / GIF_FPS, steps, PASS_SECONDS) : null;
        await page.evaluate(`document.documentElement.style.setProperty("--tm-clock", "-${t}s");` +
          (active === null ? "" : `document.querySelector(".tm-shot").setAttribute("data-tm-active", "${active}")`));
        await page.waitForTimeout(40);
        await shot.screenshot({ path: join(frameDir, `f-${String(f).padStart(2, "0")}.png`) });
      }
      const gif = diagramGifPath(outDir, key, n);
      const frame0 = diagramGifFramePath(outDir, key, n);
      const attemptGif = join(outDir, `${key}-story-${n}-attempt-${randomUUID()}.gif`);
      await ffmpeg([
        "-y", "-loglevel", "error", "-framerate", String(GIF_FPS), "-i", join(frameDir, "f-%02d.png"),
        "-vf", "split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
        "-loop", "0", attemptGif,
      ]);
      if (!existsSync(attemptGif) || !statSync(attemptGif).size) throw new Error(`${key}: failed to write ${attemptGif}`);
      renameSync(attemptGif, gif);
      copyFileSync(join(frameDir, "f-00.png"), frame0);
      rmSync(frameDir, { recursive: true, force: true });
      if (!existsSync(gif) || !statSync(gif).size) throw new Error(`${key}: failed to write ${gif}`);
      out.push({ gif, frame0 });
    }
  } finally {
    await browser.close();
  }
  log(`diagram GIFs: ${out.length}/${stories.length} rendered for ${key} (${frames} ambient / ${Math.round((PASS_SECONDS + HOLD_SECONDS) * GIF_FPS)} stepped frames @ ${GIF_FPS}fps, ${out.map((o) => `${Math.round(statSync(o.gif).size / 1024)}K`).join("/")})`);
  if (out.length !== stories.length) throw new Error(`${key}: rendered ${out.length} diagram GIFs for ${stories.length} stories`);
  return out;
}
