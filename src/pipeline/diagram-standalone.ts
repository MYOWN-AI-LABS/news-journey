/**
 * Turn an authored diagram into a SELF-CONTAINED SVG — one that renders correctly with no external
 * stylesheet, no CSS custom properties, and no host document.
 *
 * WHY: the drawing carries almost no colour of its own. Every fill, stroke and label colour comes
 * from DIAGRAM_CSS + SCHEMATIC_CSS in the host page, and the accent arrives as the CSS variables
 * --accent / --accentRgb. That is fine while the SVG is inlined in a document. It breaks completely
 * the moment the SVG is consumed as an IMAGE:
 *
 *   - loaded into a WebGL texture (the 3D scene)
 *   - drawn onto a <canvas> for the animated GIF
 *   - referenced by <img> anywhere
 *
 * An SVG used as an image is an isolated document. It cannot see the parent stylesheet, so every
 * class rule vanishes and the diagram rasterizes as unstyled black-on-transparent geometry.
 *
 * So the stylesheet is inlined and the variables are resolved to literal colours. `var()` is
 * substituted textually rather than left for the renderer, because a data-URI SVG has no :root to
 * inherit from — an unresolved var() falls back to the property's initial value, which for `fill`
 * is BLACK. That is the same black-text failure DIAGRAM_CSS already documents, arriving by a
 * different route.
 */
// Extensionless on purpose: this module is consumed by BOTH the tsx pipeline and Remotion's webpack
// bundler, and webpack cannot resolve the ".js" specifier that Node ESM wants. (Existing ".js"
// imports elsewhere in src/pipeline survive bundling only because they are `import type`, which is
// erased before webpack ever sees it.)
import { DIAGRAM_CSS, withMotionPackets } from "./diagram-style";
import { SCHEMATIC_CSS } from "./story-schematic";

/** #RRGGBB -> "r,g,b". Accepts #RGB too, since edition accents are hand-authored. */
export function hexToRgbTriplet(hex: string): string {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const parts = full.match(/.{2}/g);
  if (!parts || parts.length < 3) return "255,255,255";
  return parts.slice(0, 3).map((p) => parseInt(p, 16)).join(",");
}

/**
 * Resolve the two custom properties this stylesheet actually uses.
 *
 * Deliberately textual and total: after this runs there must be NO var() left anywhere, or the
 * property silently resolves to its initial value in the isolated document.
 */
export function resolveCssVars(css: string, accent: string): string {
  const rgb = hexToRgbTriplet(accent);
  return css
    .replace(/var\(--accentRgb\)/g, rgb)
    .replace(/var\(--accent\)/g, accent)
    // any other var() would resolve to `initial` in an isolated document — fail loudly instead
    .replace(/var\(--([a-zA-Z0-9-]+)\)/g, (_m, name) => {
      throw new Error(`diagram-standalone: unresolved CSS variable --${name}; add it to resolveCssVars`);
    });
}

export interface StandaloneOptions {
  accent: string;
  /** Opaque backdrop painted behind the drawing. Transparent when omitted. */
  background?: string;
  /** Pixel width the SVG declares, which sets the raster resolution when used as an image. */
  width?: number;
}

/**
 * Inline the shared stylesheet into one authored diagram and return a standalone SVG string.
 *
 * The viewBox is preserved exactly, so a standalone copy and the inline copy are the same drawing
 * at the same coordinates — which is what lets the video, the web issue and the LinkedIn raster
 * stay "the same picture by construction" rather than by resemblance.
 */
export function standaloneDiagramSvg(svg: string, opts: StandaloneOptions): string {
  svg = withMotionPackets(svg); // the video textures carry the same motion as the rasters
  const css = resolveCssVars(`${SCHEMATIC_CSS}\n${DIAGRAM_CSS}`, opts.accent);
  const width = opts.width ?? 1440;
  const height = Math.round((width * 340) / 720);

  // CDATA is REQUIRED, not tidiness. An SVG consumed as an image is parsed as strict XML, and the
  // shared stylesheet's comments quote markup ("<rect class=...>", "An SVG <path> defaults to
  // fill:BLACK"). Those bare '<' characters abort the parse — "Opening and ending tag mismatch:
  // svg line 83 and style" — and the image silently never decodes, so the plate renders as nothing.
  // Comments are also stripped: this string is embedded in a data URI per texture, so the prose is
  // pure payload once inlined.
  const compact = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\n{2,}/g, "\n").trim();
  const styleBlock =
    `<style type="text/css"><![CDATA[${opts.background ? `svg{background:${opts.background}}` : ""}${compact}]]></style>`;
  const backdrop = opts.background
    ? `<rect x="0" y="0" width="720" height="340" fill="${opts.background}"/>`
    : "";

  // Declared width/height decide the raster size; without them an <img>/texture gets the viewBox's
  // 720x340 and the labels turn to mush the moment the plate is shown larger than that.
  //
  // xmlns is added ONLY when absent. A serialized plane from splitDiagramPlanes already carries one,
  // and emitting it twice is a duplicate attribute — fatal in XML, so the image never decodes and
  // the plate silently renders as nothing.
  const needsNs = !/xmlns=/.test(svg);
  let out = svg.replace(
    /^<svg\b/,
    `<svg${needsNs ? ' xmlns="http://www.w3.org/2000/svg"' : ""} width="${width}" height="${height}"`,
  );

  // Insert the stylesheet immediately after <title>, so the accessible title stays the first child.
  const titleEnd = out.indexOf("</title>");
  const at = titleEnd >= 0 ? titleEnd + "</title>".length : out.indexOf(">") + 1;
  out = out.slice(0, at) + styleBlock + backdrop + out.slice(at);
  return out;
}

/** Data URI for <img>/THREE.TextureLoader. base64 avoids escaping every # in the inlined colours. */
export function standaloneDiagramDataUri(svg: string, opts: StandaloneOptions): string {
  const markup = standaloneDiagramSvg(svg, opts);
  const b64 = typeof Buffer !== "undefined"
    ? Buffer.from(markup, "utf8").toString("base64")
    : btoa(unescape(encodeURIComponent(markup)));
  return `data:image/svg+xml;base64,${b64}`;
}

/**
 * Split a drawing into depth planes that SHARE ONE viewBox.
 *
 * Each plane is a complete SVG at identical coordinates holding only some of the elements, so the
 * planes register perfectly while each can sit at its own Z. That is what produces parallax BETWEEN
 * NODES; a single plate, however it is tilted or shadowed, cannot.
 *
 * RULE, learned the hard way on 2026-08-21: only non-text scaffolding may recede. The far plane is
 * blurred and dimmed, so a label placed there is self-inflicted illegibility — the first attempt
 * sent section kickers back and "CURSOR CLOUD AGENTS" became unreadable. Text always rides with the
 * box that contains it, and free-standing captions stay on the connector plane, or they parallax
 * away from the edge they annotate.
 */
export type DepthPlane = "far" | "mid" | "near";

export function planeForClass(cls: string, tagName: string): DepthPlane {
  if (/tm-svg-accent|tm-sc-core|tm-sc-check|tm-sc-core-dot/.test(cls)) return "near";
  if (/tm-sc-shield/.test(cls) || tagName === "line") return "far";
  return "mid";
}

export const DEPTH_PLANES: DepthPlane[] = ["far", "mid", "near"];

/**
 * Split one drawing into three SVGs at IDENTICAL coordinates, one per depth plane.
 *
 * Browser-only: it needs real geometry (getBBox) to decide which box a label sits inside, and there
 * is no layout engine in Node. Both consumers already run in a browser — Remotion renders in
 * headless Chrome and the GIF is captured through Playwright — so this is a constraint, not a gap.
 */
export function splitDiagramPlanes(svg: string): Record<DepthPlane, string> {
  if (typeof DOMParser === "undefined") {
    throw new Error("splitDiagramPlanes requires a browser DOM (getBBox); call it from Remotion or Playwright");
  }
  // The authored root has NO xmlns — it is written to be inlined in HTML, where the parser supplies
  // one. Parsing it as "image/svg+xml" without it yields a parsererror document with zero usable
  // children, so every plane comes out empty and the 3D scene renders a floor and no diagram.
  const namespaced = /xmlns=/.test(svg)
    ? svg
    : svg.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  const parse = () => {
    const doc = new DOMParser().parseFromString(namespaced, "image/svg+xml");
    const err = doc.querySelector("parsererror");
    if (err) throw new Error(`splitDiagramPlanes: SVG did not parse — ${err.textContent?.slice(0, 160)}`);
    return doc;
  };

  // Measure against a live, laid-out copy: getBBox on a detached document returns zeroes.
  const probe = parse().documentElement as unknown as SVGSVGElement;
  const holder = document.createElement("div");
  holder.setAttribute("style", "position:absolute;left:-99999px;top:0;width:720px");
  holder.appendChild(probe);
  document.body.appendChild(holder);

  const kids = Array.from(probe.children).filter((n) => n.tagName !== "title") as SVGGraphicsElement[];
  const boxes = kids
    .filter((n) => /^(rect|circle|polygon)$/.test(n.tagName))
    .map((n) => ({ b: n.getBBox(), plane: planeForClass(n.getAttribute("class") ?? "", n.tagName) }));

  const planes: DepthPlane[] = kids.map((k) => {
    let plane = planeForClass(k.getAttribute("class") ?? "", k.tagName);
    if (k.tagName === "text") {
      const bb = k.getBBox();
      const cx = bb.x + bb.width / 2;
      const cy = bb.y + bb.height / 2;
      let best: { b: DOMRect; plane: DepthPlane } | null = null;
      let bestArea = Infinity;
      for (const cand of boxes) {
        const c = cand.b;
        if (cx >= c.x && cx <= c.x + c.width && cy >= c.y && cy <= c.y + c.height) {
          const area = c.width * c.height;
          if (area < bestArea) { bestArea = area; best = cand as { b: DOMRect; plane: DepthPlane }; }
        }
      }
      // a label rides with its box; a free-standing caption stays on the connector plane. Never far:
      // that plane is blurred and dimmed, so text there is illegible by construction.
      plane = best ? best.plane : plane === "far" ? "mid" : plane;
    }
    return plane;
  });

  holder.remove();

  const out = {} as Record<DepthPlane, string>;
  for (const target of DEPTH_PLANES) {
    const doc = parse();
    const root = doc.documentElement;
    Array.from(root.children)
      .filter((n) => n.tagName !== "title")
      .forEach((child, i) => { if (planes[i] !== target) child.remove(); });
    out[target] = new XMLSerializer().serializeToString(root);
  }
  return out;
}
