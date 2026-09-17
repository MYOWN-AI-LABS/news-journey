// Per-story diagram figures for the LinkedIn article — placed by construction, verified by content.
//
// WHY THIS SHAPE. The diagrams have never reliably reached the published LinkedIn issue: the article
// composer is a ProseMirror editor that strips inline <svg>, and an attempt to place rasters by
// caret-walking the LIVE editor produced, in order, images at the top, images stacked after the
// list, a list item split mid-word, and finally two unrelated stock photos published on the article
// — because the automation verified image PRESENCE and POSITION but never CONTENT. That last
// failure is the reason this module verifies pixels, not just placement.
//
// Measured against the composer: a pasted body containing <img src="data:image/png;base64,…">
// keeps every image exactly where the markup put it (each becomes a <figure>), and LinkedIn uploads
// it to its own CDN within ~4s. So placement is a pure string transform on the body we already
// paste, and the only thing left to verify is that what landed IS our drawing.
//
// The figures are injected at PASTE time, not baked into `<key>.linkedin.html`: explicit-approval.ts
// re-renders renderLinkedInEdition(data) and compares it byte-for-byte against the approved
// artifact, and PNG bytes are not stable across renders (the roughening filter). Embedding them in
// the artifact would void every approval on every render — the livelock RULE 2 documents.
import type { Locator, Page } from "playwright";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { NEWSLETTER_DIR } from "../pipeline/newsletter.js";
import { NEWSLETTER_SECTION_HEADINGS } from "../pipeline/newsletter-contract.js";
import type { NewsletterData } from "../pipeline/newsletter-html.js";
import { renderDiagramPngs } from "../pipeline/diagram-png.js";
import { renderDiagramGifs } from "../pipeline/diagram-gif.js";
import { log } from "../util.js";

export interface StoryFigure {
  /** 1-based story number; 1 is the lead. */
  storyNumber: number;
  /** Absolute path of the rendered raster (GIF when animated, else PNG). */
  png: string;
  /** data: URI of that raster — what goes into the pasted body. */
  dataUri: string;
  /** data: URI of the STILL the content gate compares against (frame 0 for a GIF; the PNG itself). */
  referenceUri: string;
  /** Text that must appear in the block immediately BEFORE the figure in the editor. */
  anchor: string;
}

/** Content gate, calibrated 2026-08-24 on LinkedIn's CDN renditions vs our PNGs (96×48 luminance):
 *  own drawing diff 3.6–6.1 / NCC 0.987–0.995; a SIBLING diagram from the same issue 13.5–21.4 /
 *  0.89–0.95; a FOREIGN image (another day's diagram, the cover) 165–183 / 0.08–0.21. The landed
 *  image must be closest to its own story AND inside both bounds — ≥3× margin against foreign
 *  content, and the argmin rule is what catches a swapped order. */
export const FIGURE_MATCH_MAX_DIFF = 40;
export const FIGURE_MATCH_MIN_NCC = 0.8;

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Render every story diagram to PNG (the same recipe the archive page mounts) and pair each with the
 * text it must sit under. Story 1 is the lead; stories 2..N are the "Worth your time" items, in the
 * exact order renderLinkedInEdition emits them (`issue.items[i]` ↔ `motionStories[i + 1]`).
 */
export async function storyFigures(
  key: string,
  day: string,
  data: NewsletterData,
  opts: { animated?: boolean } = {},
): Promise<StoryFigure[]> {
  const stories = data.motionStories ?? [];
  const items = data.issue.items;
  if (stories.length !== items.length + 1) {
    throw new Error(`${key}: ${stories.length} motion stories but ${items.length} Worth-your-time items — the lead + items must account for every diagram`);
  }
  const anchor = (i: number) => (i === 0 ? `The lead: ${data.issue.lead.title}` : items[i - 1].name);
  const uri = (path: string, mime: string) => `data:${mime};base64,${readFileSync(path).toString("base64")}`;
  const dir = join(NEWSLETTER_DIR, "png", key);
  // Animated by default: the published article should carry the diagram's motion, not a still.
  if (opts.animated ?? true) {
    const gifs = await renderDiagramGifs(dir, key, day, data);
    return gifs.map(({ gif, frame0 }, i) => ({
      storyNumber: i + 1, png: gif, dataUri: uri(gif, "image/gif"), referenceUri: uri(frame0, "image/png"), anchor: anchor(i),
    }));
  }
  const paths = await renderDiagramPngs(dir, key, day, data);
  return paths.map((png, i) => {
    const u = uri(png, "image/png");
    return { storyNumber: i + 1, png, dataUri: u, referenceUri: u, anchor: anchor(i) };
  });
}

/**
 * PURE. Insert each figure into the LinkedIn body: the lead's directly under its `<h2>The lead: …</h2>`,
 * and each item's directly after its own `<li>` — which means the single "Worth your time" <ul> is
 * split into one <ul> per item so a figure can follow each. Anchored on the exact markup
 * renderLinkedInEdition emits; any drift throws, because a silently figure-less issue is the defect
 * this exists to end (RULE 4: an issue without its artwork is broken, not lesser).
 */
export function embedStoryFigures(bodyHtml: string, figures: StoryFigure[]): string {
  if (!figures.length) throw new Error("embedStoryFigures: no figures");
  const img = (f: StoryFigure) => `<img src="${f.dataUri}" alt="${escHtml(`Story ${f.storyNumber} diagram`)}">`;

  const leadRe = /<h2>The lead: [^<]*<\/h2>/;
  const leadMatches = bodyHtml.match(new RegExp(leadRe.source, "g")) ?? [];
  if (leadMatches.length !== 1) throw new Error(`embedStoryFigures: expected exactly one lead heading, found ${leadMatches.length}`);
  let out = bodyHtml.replace(leadRe, (h) => `${h}\n${img(figures[0])}`);

  const rest = figures.slice(1);
  const heading = `<h2>${NEWSLETTER_SECTION_HEADINGS.worthYourTime}</h2>`;
  const start = out.indexOf(heading);
  if (start < 0) throw new Error(`embedStoryFigures: "${heading}" not found`);
  const ulOpen = out.indexOf("<ul>", start);
  const ulClose = out.indexOf("</ul>", ulOpen);
  if (ulOpen < 0 || ulClose < 0) throw new Error("embedStoryFigures: Worth-your-time list not found");
  const listHtml = out.slice(ulOpen, ulClose + "</ul>".length);
  const items = listHtml.match(/<li>[\s\S]*?<\/li>/g) ?? [];
  if (items.length !== rest.length) throw new Error(`embedStoryFigures: ${items.length} list items but ${rest.length} item figures`);
  items.forEach((li, i) => {
    if (!li.includes(escHtml(rest[i].anchor))) {
      throw new Error(`embedStoryFigures: item ${i + 1} does not carry its anchor "${rest[i].anchor}"`);
    }
  });
  const split = items.map((li, i) => `<ul>\n${li}\n</ul>\n${img(rest[i])}`).join("\n");
  out = out.slice(0, ulOpen) + split + out.slice(ulClose + "</ul>".length);
  return out;
}

/** What the editor currently holds, one entry per top-level block, in document order. */
const EDITOR_BLOCKS = `(() => {
  const root = document.querySelector('[contenteditable="true"]');
  return [...root.children].map((el, i) => {
    const img = el.querySelector("img");
    return { i, text: (el.textContent || "").replace(/\\s+/g, " ").trim(), img: img ? { src: img.src.slice(0, 40), nw: img.naturalWidth, nh: img.naturalHeight } : null };
  });
})()`;

/** In-page: mean absolute luminance difference and normalized cross-correlation of two images,
 *  both drawn to 96×48. */
const PIXEL_DIFF = `(async ([a, b]) => {
  const load = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const W = 96, H = 48;
  const gray = (im) => {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d"); g.drawImage(im, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data, out = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    return out;
  };
  const ga = gray(ia), gb = gray(ib), n = ga.length;
  let sum = 0, ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { sum += Math.abs(ga[i] - gb[i]); ma += ga[i]; mb += gb[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = ga[i] - ma, y = gb[i] - mb; num += x * y; da += x * x; db += y * y; }
  return { diff: sum / n, ncc: da && db ? num / Math.sqrt(da * db) : 0 };
})`;

/**
 * Prove that the figures in the editor are OUR figures, in OUR order, under OUR text — before
 * anything is published. Throws with the full evidence on any miss. Presence is not proof:
 * ledger 62 shipped two strangers' photos through a check that counted figures.
 *
 *   1. every figure finished uploading (src is LinkedIn's CDN, not the data: URI we pasted);
 *   2. figure count === expected, and the block right before figure k carries anchor k;
 *   3. CONTENT: a screenshot of each landed image is compared pixel-wise with every expected PNG —
 *      it must be closest to its own story's PNG and within FIGURE_MATCH_MAX_DIFF of it.
 */
export async function verifyEditorFigures(
  page: Page,
  editor: Locator,
  figures: StoryFigure[],
  opts: { repaste?: () => Promise<void> } = {},
): Promise<void> {
  type Block = { i: number; text: string; img: { src: string; nw: number; nh: number } | null };
  let blocks: Block[] = [];
  // UPLOAD. Each pasted data: image becomes a placeholder, then LinkedIn uploads it and swaps in
  // its CDN url — or, intermittently, drops the placeholder entirely (2026-08-24: 4/4 dropped on
  // one of five identical pastes, no error surfaced). A dropped upload is retried by re-pasting the
  // whole body; a still-pending one is waited for. Exhausting the retries throws — never publish
  // text-only when the issue has artwork.
  let attempt = 0;
  let reloads = 0;
  let lastCount = -1;
  let lastChange = Date.now();
  const deadline = Date.now() + 300_000;
  for (;;) {
    blocks = (await page.evaluate(EDITOR_BLOCKS)) as Block[];
    const figs = blocks.filter((b) => b.img);
    const uploaded = figs.every((b) => /^https?:/.test(b.img!.src) && b.img!.nw > 0);
    if (figs.length === figures.length && uploaded) break;
    if (figs.length !== lastCount) { lastCount = figs.length; lastChange = Date.now(); }
    const stalled = Date.now() - lastChange > 10_000;
    if (figs.length < figures.length && stalled) {
      if (!opts.repaste || attempt >= 3) {
        throw new Error(`figures: ${figs.length}/${figures.length} landed after ${attempt} re-paste(s) — ${JSON.stringify(figs.map((b) => b.img))}`);
      }
      attempt++;
      log(`figures: ${figs.length}/${figures.length} landed — LinkedIn dropped the upload; re-pasting (attempt ${attempt}/3)…`);
      await page.waitForTimeout(5_000);
      await opts.repaste();
      lastCount = -1;
      lastChange = Date.now();
      continue;
    }
    // EDIT MODE swaps the DOM src late. On a published article's editor every upload completed
    // (metadata POST + PUT 201 within 2s) yet all four <img> still read data: two minutes later;
    // reopening the editor showed the persisted draft with CDN urls in place. So when the swap
    // stalls on an /article/edit/<id>/ page, reload it and read the state the server holds. Never
    // reload /article/new/ — before its first autosave that would discard title and cover.
    if (figs.length === figures.length && !uploaded && Date.now() - lastChange > 45_000
        && reloads < 3 && /\/article\/edit\/\d+/.test(page.url())) {
      reloads++;
      log(`figures: ${figs.length}/${figures.length} placed but src not yet swapped — reloading the editor to read the persisted state (${reloads}/3)…`);
      await page.goto(page.url(), { waitUntil: "domcontentloaded" });
      await editor.waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForTimeout(3_000);
      lastChange = Date.now();
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`figures: ${figs.length}/${figures.length} landed, uploaded=${uploaded} after the deadline — ${JSON.stringify(figs.map((b) => b.img))}`);
    }
    await page.waitForTimeout(1_000);
  }
  const figs = blocks.filter((b) => b.img);
  const norm = (s: string) => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
  figs.forEach((b, k) => {
    const prev = blocks[b.i - 1];
    if (!prev || !norm(prev.text).includes(norm(figures[k].anchor))) {
      throw new Error(`figures: figure ${k + 1} is not under "${figures[k].anchor}" — preceded by ${JSON.stringify(prev?.text.slice(0, 80) ?? null)}`);
    }
  });

  // CONTENT. Fetch the bytes of each landed image from inside the page (LinkedIn's CDN, with the
  // session that uploaded it) and compare them with every expected PNG in a scratch page, so a
  // wrong or swapped image is caught. NOT an element screenshot: the editor renders a selected
  // figure dimmed, bordered and overlaid with its controls, which made every pair score alike
  // (measured 2026-08-24: own-story 13–28 vs others 19–32 — no discrimination).
  const shots: string[] = [];
  for (const [k] of figs.entries()) {
    const src = await editor.locator("img").nth(k).getAttribute("src");
    const b64 = (await page.evaluate(`(async (u) => {
      const r = await fetch(u); if (!r.ok) throw new Error("fetch " + r.status + " " + u);
      const b = await r.blob();
      return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
    })(${JSON.stringify(src)})`)) as string;
    if (!/^data:image\//.test(b64)) throw new Error(`figures: figure ${k + 1} bytes unreadable (${String(b64).slice(0, 40)})`);
    shots.push(b64);
  }
  const scratch = await page.context().newPage();
  type Score = { diff: number; ncc: number };
  const matrix: Score[][] = [];
  try {
    await scratch.setContent("<!doctype html><title>figure check</title>");
    for (const shot of shots) {
      const row: Score[] = [];
      for (const f of figures) row.push((await scratch.evaluate(`${PIXEL_DIFF}(${JSON.stringify([shot, f.referenceUri])})`)) as Score);
      matrix.push(row);
    }
  } finally {
    await scratch.close();
  }
  const report = matrix.map((row, k) => `figure ${k + 1}: [${row.map((d) => `${d.diff.toFixed(1)}/${d.ncc.toFixed(2)}`).join(", ")}]`).join("; ");
  matrix.forEach((row, k) => {
    const own = row[k];
    const best = row.reduce((bi, d, i) => (d.diff < row[bi].diff ? i : bi), 0);
    if (best !== k || own.diff > FIGURE_MATCH_MAX_DIFF || own.ncc < FIGURE_MATCH_MIN_NCC) {
      throw new Error(`figures: figure ${k + 1} is not story ${k + 1}'s diagram (closest=${best + 1}, diff=${own.diff.toFixed(1)} max ${FIGURE_MATCH_MAX_DIFF}, ncc=${own.ncc.toFixed(2)} min ${FIGURE_MATCH_MIN_NCC}) — ${report}`);
    }
  });
  log(`figures: ${figs.length}/${figures.length} verified in place by content — ${report}`);
}

/** Blocks of the LIVE article page (reader view), in document order, with images resolved. */
const LIVE_BLOCKS = `(() => {
  const article = document.querySelector("article") || document.body;
  const container = article.querySelector('[class*="article-main__content"], [class*="reader-article-content"], .reader-content-blocks-container') || article;
  return [...container.querySelectorAll("p, h1, h2, h3, ul, figure, img")]
    .filter((el) => el.tagName !== "IMG" || !el.closest("figure"))
    .map((el) => {
      const img = el.tagName === "IMG" ? el : el.querySelector("img");
      return { text: (el.textContent || "").replace(/\\s+/g, " ").trim(), img: img ? { src: img.currentSrc || img.src, nw: img.naturalWidth } : null };
    });
})()`;

/**
 * Verify the PUBLISHED page — the artifact readers see. Same three proofs as the editor check
 * (count, each figure under its own anchor, content by CDN bytes), run on the live /pulse/ URL
 * after Publish/Update. Returns the report; throws on any miss.
 */
export async function verifyLiveFigures(page: Page, articleUrl: string, figures: StoryFigure[]): Promise<string> {
  await page.goto(articleUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);
  // The reader lazy-loads images; walk the page so every <img> resolves.
  for (let y = 0; y < 12_000; y += 700) { await page.evaluate(`window.scrollTo(0, ${y})`); await page.waitForTimeout(250); }
  type LB = { text: string; img: { src: string; nw: number } | null };
  const blocks = (await page.evaluate(LIVE_BLOCKS)) as LB[];
  const imgs = blocks.filter((b) => b.img && b.img.nw > 400);
  if (imgs.length !== figures.length) {
    throw new Error(`live figures: ${imgs.length}/${figures.length} on ${articleUrl} — ${JSON.stringify(imgs.map((b) => b.img))}`);
  }
  const norm = (t: string) => t.replace(/ /g, " ").replace(/\s+/g, " ").trim();
  imgs.forEach((b, k) => {
    const i = blocks.indexOf(b);
    const before = blocks.slice(Math.max(0, i - 3), i).map((x) => norm(x.text)).join(" ");
    if (!before.includes(norm(figures[k].anchor))) {
      throw new Error(`live figures: figure ${k + 1} is not under "${figures[k].anchor}" — preceded by ${JSON.stringify(before.slice(-120))}`);
    }
  });
  const scratch = await page.context().newPage();
  const scores: Array<{ diff: number; ncc: number }> = [];
  try {
    await scratch.setContent("<!doctype html><title>live figure check</title>");
    for (const [k, b] of imgs.entries()) {
      const b64 = (await page.evaluate(`(async (u) => {
        const r = await fetch(u); if (!r.ok) throw new Error("fetch " + r.status);
        const bl = await r.blob();
        return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(bl); });
      })(${JSON.stringify(b.img!.src)})`)) as string;
      scores.push((await scratch.evaluate(`${PIXEL_DIFF}(${JSON.stringify([b64, figures[k].referenceUri])})`)) as { diff: number; ncc: number });
    }
  } finally {
    await scratch.close();
  }
  const report = scores.map((d, k) => `figure ${k + 1}: ${d.diff.toFixed(1)}/${d.ncc.toFixed(2)}`).join("; ");
  scores.forEach((d, k) => {
    if (d.diff > FIGURE_MATCH_MAX_DIFF || d.ncc < FIGURE_MATCH_MIN_NCC) {
      throw new Error(`live figures: figure ${k + 1} on ${articleUrl} is not story ${k + 1}'s diagram (diff=${d.diff.toFixed(1)}, ncc=${d.ncc.toFixed(2)}) — ${report}`);
    }
  });
  return report;
}
