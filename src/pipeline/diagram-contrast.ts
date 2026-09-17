/**
 * MEASURED contrast gate for story diagrams.
 *
 * WHY THIS EXISTS, and why it is a measurement rather than another CSS rule:
 *
 * `diagram-style.ts` carries a changelog of the SAME defect fixed four times, each time by adding
 * one more hand-written rule:
 *   1. a solid tm-svg-danger panel under the light tm-svg-label  → a status label at ~1.9:1
 *   2. .tm-svg-accent on both a <rect> and its <text>            → a node title rendered invisible
 *   3. .tm-sc-metric on a <rect> painting a solid orange panel   → light labels stranded on a bright
 *                                                                  panel; reported unreadable
 *   4. the authored SVG carrying its OWN light palette — an opaque full-bleed rect plus
 *      inline fill="#2d3142" on every label. Presentation attributes lose to ANY stylesheet rule, so
 *      SCHEMATIC_CSS's .tm-svg-label{fill:#F0EDF6} repainted every label near-white while the
 *      untagged background rect survived. Near-white on near-white, ~1.1:1, on both editions.
 *
 * Each fix closed one mechanism. The next mechanism was always different, so a fifth rule would not
 * have caught this one either. What every instance HAS in common is the observable outcome: text
 * whose measured contrast against what is actually behind it is too low to read.
 *
 * So this gate measures that outcome in a real browser, with the real stylesheets, and fails closed.
 * It cannot be out-argued by a new mechanism because it never reasons about mechanisms.
 */
import type { DiagramStyle } from "./diagram-style.js";

/** WCAG AA for normal text. Below this a label is reported but does not block. */
export const CONTRAST_TARGET = 4.5;
/**
 * Hard floor. Below this the edition does not publish.
 *
 * Deliberately below AA: the legitimate palette already sits far above it (the dimmest real pairing,
 * .tm-svg-tiny #A9A3B8 on the #0E0F13 stage, measures ~7.9:1), while every historical defect landed
 * at 1.1–1.9:1. A 3:1 floor separates "unreadable" from "dim" without failing artwork that is fine.
 */
export const CONTRAST_FLOOR = 3;

export interface ContrastSample {
  diagram: number;
  text: string;
  fill: string;
  backdrop: string;
  ratio: number;
  fontSize: number;
}

/** sRGB channel → linear light. */
function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Parse the rgb()/rgba() form getComputedStyle always returns. Returns null for `none`, gradients. */
export function parseRgb(value: string): [number, number, number, number] | null {
  const nums = value.match(/[\d.]+/g);
  if (!value.startsWith("rgb") || !nums || nums.length < 3) return null;
  return [Number(nums[0]), Number(nums[1]), Number(nums[2]), nums.length > 3 ? Number(nums[3]) : 1];
}

/** Composite a translucent colour over an opaque one — the accent panels are all rgba(...,.20). */
export function compositeOver(
  fg: [number, number, number, number],
  bg: [number, number, number],
): [number, number, number] {
  const a = fg[3];
  return [
    Math.round(fg[0] * a + bg[0] * (1 - a)),
    Math.round(fg[1] * a + bg[1] * (1 - a)),
    Math.round(fg[2] * a + bg[2] * (1 - a)),
  ];
}

/**
 * Browser-side probe, kept as source text (see the call site for why it cannot be a function).
 *
 * For each <text>: read its COMPUTED fill, hit-test the paint stack under its centre, composite the
 * translucent layers down to the stage colour, and report the WCAG ratio of label against backdrop.
 */
const PROBE_SOURCE = String.raw`(stageColour) => {
  const parse = (v) => {
    const nums = v && v.match(/[\d.]+/g);
    if (!v || !v.startsWith("rgb") || !nums || nums.length < 3) return null;
    return [+nums[0], +nums[1], +nums[2], nums.length > 3 ? +nums[3] : 1];
  };
  const ch = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const over = (f, b) => [
    Math.round(f[0] * f[3] + b[0] * (1 - f[3])),
    Math.round(f[1] * f[3] + b[1] * (1 - f[3])),
    Math.round(f[2] * f[3] + b[2] * (1 - f[3])),
  ];

  const base = parse(stageColour) || parse(getComputedStyle(document.body).backgroundColor) || [14, 15, 19, 1];
  const stageRgb = [base[0], base[1], base[2]];
  const out = [];

  document.querySelectorAll(".tm-stage").forEach((host) => {
    const dIndex = Number(host.dataset.d);
    host.querySelectorAll("text").forEach((t) => {
      const label = (t.textContent || "").trim();
      if (!label) return;
      const cs = getComputedStyle(t);
      const fg = parse(cs.fill);
      if (!fg) return;                            // fill:none / url() — nothing to measure

      const box = t.getBoundingClientRect();
      if (!box.width || !box.height) return;      // not rendered

      const stack = document.elementsFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      const layers = [];
      for (const el of stack) {
        if (el === t) continue;
        if (/^(svg|g)$/i.test(el.tagName)) continue;
        const s = getComputedStyle(el);
        const isShape = /^(rect|circle|ellipse|polygon|path|image)$/i.test(el.tagName);
        const raw = isShape && s.fill !== "none" ? s.fill : s.backgroundColor;
        const c = parse(raw);
        if (!c || c[3] === 0) continue;
        const fo = isShape ? parseFloat(s.fillOpacity || "1") : 1;
        const alpha = c[3] * (isFinite(fo) ? fo : 1);
        layers.push([c[0], c[1], c[2], alpha]);
        if (alpha >= 0.999) break;                // opaque: nothing below it can matter
      }

      let backdrop = stageRgb;
      for (let i = layers.length - 1; i >= 0; i--) backdrop = over(layers[i], backdrop);

      const fgSolid = over(fg, backdrop);
      out.push({
        diagram: dIndex,
        text: label.slice(0, 40),
        fill: cs.fill,
        backdrop: "rgb(" + backdrop.join(", ") + ")",
        ratio: Math.round(ratio(fgSolid, backdrop) * 100) / 100,
        fontSize: Math.round(parseFloat(cs.fontSize) || 0),
      });
    });
  });
  return out;
}`;

/**
 * Measure every label in every diagram against what is actually painted behind it.
 *
 * Runs the REAL stylesheets in a REAL browser for the same reason `diagram-png.ts` does: the defects
 * this exists to catch are cascade defects. Emulating the cascade would reproduce the emulator's
 * bugs, not the renderer's — and the renderer is what the viewer sees.
 */
export async function measureDiagramContrast(
  svgs: string[],
  opts: { accent: string; style: DiagramStyle; stage?: string },
): Promise<ContrastSample[]> {
  const { chromium } = await import("playwright");
  const { DIAGRAM_CSS, ROUGH_FILTER_DEFS } = await import("./diagram-style.js");
  const { SCHEMATIC_CSS } = await import("./story-schematic.js");

  const stage = opts.stage ?? "#0E0F13";
  const rgb = opts.accent.replace("#", "").match(/.{2}/g)?.map((h) => parseInt(h, 16)).join(",") ?? "255,255,255";

  const browser = await chromium.launch();
  try {
    // Tall viewport: hit-testing uses elementFromPoint, which only sees what is inside the viewport.
    // A short viewport silently reports "nothing behind this label" and the gate passes everything.
    const page = await browser.newPage({ viewport: { width: 1200, height: 20000 } });
    await page.setContent(
      `<!doctype html><meta charset="utf-8">
<style>
  :root{--accent:${opts.accent};--accentRgb:${rgb}}
  html,body{margin:0;background:${stage}}
  .tm-shot{width:1200px;padding:24px;box-sizing:border-box;background:${stage}}
  .tm-stage{padding:18px;border-radius:12px}
  .tm-story-svg{width:100%;height:auto;display:block}
  ${SCHEMATIC_CSS}
  ${DIAGRAM_CSS}
</style>
${ROUGH_FILTER_DEFS}
<div class="tm-shot" data-diagram-style="${opts.style}">
${svgs.map((s, i) => `<div class="tm-stage" data-d="${i}">${s}</div>`).join("")}
</div>`,
      { waitUntil: "load" },
    );
    await page.waitForTimeout(250);

    // Evaluated as a self-invoking EXPRESSION STRING, for two reasons:
    //  1. the TS runner (tsx/esbuild) rewrites function bodies and injects a `__name` helper that
    //     does not exist in the page, so a function literal throws "__name is not defined";
    //  2. Playwright ignores the `arg` parameter when the first argument is a string, so the stage
    //     colour has to be baked into the source rather than passed alongside it.
    const source = `(${PROBE_SOURCE})(${JSON.stringify(stage)})`;
    return (await page.evaluate(source)) as ContrastSample[];
  } finally {
    await browser.close();
  }
}

/**
 * Turn samples into findings. Anything under the floor is BLOCKING — an unreadable label is the
 * whole defect, and shipping it is what this gate exists to stop.
 */
export function contrastFindings(samples: ContrastSample[]): { blocking: string[]; warnings: string[] } {
  const blocking: string[] = [];
  const warnings: string[] = [];
  for (const s of samples) {
    const where = `diagram ${s.diagram + 1} label "${s.text}"`;
    const detail = `${s.ratio}:1 (${s.fill} on ${s.backdrop})`;
    if (s.ratio < CONTRAST_FLOOR) blocking.push(`${where} is unreadable at ${detail}`);
    else if (s.ratio < CONTRAST_TARGET) warnings.push(`${where} is dim at ${detail}`);
  }
  return { blocking, warnings };
}
/**
 * Inks the repair may choose from, theme ink first so it wins ties. Pure black/white are included
 * because a mid-luminance solid accent (#7C5CFF on the Daily: 124,92,255) defeats BOTH theme inks —
 * #F0EDF6 measures 3.76:1 and #0E0F13 4.41:1 there — while pure black reaches 4.8:1.
 */
const REPAIR_INKS: Record<DiagramStyle, [number, number, number][]> = {
  handwritten: [[31, 36, 48], [240, 237, 246], [0, 0, 0], [255, 255, 255]],
  studio: [[240, 237, 246], [14, 15, 19], [255, 255, 255], [0, 0, 0]],
};

/** Mirror of the browser's textContent for the entities the author emits (named + numeric — "·" arrives as &#183;). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&middot;/g, "·").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

/** Add an inline fill to every not-yet-styled <text> in `svg` whose visible content starts with `label`. */
export function patchTextFill(svg: string, label: string, ink: string): string {
  return svg.replace(/<text\b([^>]*)>([\s\S]*?)<\/text>/g, (whole, attrs: string, inner: string) => {
    if (/\bstyle=/.test(attrs)) return whole;
    const plain = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
    if (plain.slice(0, 40) !== label) return whole;
    return `<text${attrs} style="fill:${ink}">${inner}</text>`;
  });
}


export async function repairDiagramContrast(
  svgs: string[],
  opts: { accent: string; style: DiagramStyle; stage?: string },
): Promise<{ svgs: string[]; patched: number; residual: ContrastSample[] }> {
  const inks = REPAIR_INKS[opts.style];
  const hex = (c: [number, number, number]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  const out = svgs.slice();
  let patched = 0;
  let samples = await measureDiagramContrast(out, opts);
  for (let pass = 0; pass < 2; pass++) {
    const low = samples.filter((s) => s.ratio < CONTRAST_TARGET);
    if (!low.length) break;
    for (const s of low) {
      const bd = parseRgb(s.backdrop);
      if (!bd) continue;
      const backdrop: [number, number, number] = [bd[0], bd[1], bd[2]];
      // First theme-ordered ink that clears the target; only if none does, the strongest one.
      const best =
        inks.find((ink) => contrastRatio(ink, backdrop) >= CONTRAST_TARGET) ??
        inks.reduce((a, b) => (contrastRatio(b, backdrop) > contrastRatio(a, backdrop) ? b : a));
      const before = out[s.diagram]!;
      const after = patchTextFill(before, s.text, hex(best));
      if (after !== before) {
        out[s.diagram] = after;
        patched++;
      }
    }
    samples = await measureDiagramContrast(out, opts);
  }
  return { svgs: out, patched, residual: samples.filter((s) => s.ratio < CONTRAST_TARGET) };
}
