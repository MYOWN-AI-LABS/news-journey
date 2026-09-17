import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import { PORTRAIT_FONT_PX } from "./diagram-style.js";

let VIEWBOX = { left: 12, top: 10, right: 708, bottom: 330 };
// Set per call alongside VIEWBOX: portrait diagrams use a ~2x type scale (PORTRAIT_FONT_PX).
let PORTRAIT = false;
/** Never compress a label below this fraction of its natural width — see the note in fitTexts. */
const TEXT_SQUEEZE_FLOOR = 0.72;
function viewboxFor(svg: string): typeof VIEWBOX {
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  const w = m ? Number(m[1]) : 720;
  const h = m ? Number(m[2]) : 340;
  return { left: 12, top: 10, right: w - 12, bottom: h - 10 };
}
const BOX_GAP = 6;
const TEXT_GAP = 6;
const TEXT_INSET = 8;

const LAYOUT_BOX_CLASSES = new Set([
  "tm-sc-bank",
  "tm-sc-body",
  "tm-sc-apparatus",
  "tm-sc-apparatus-round",
  "tm-sc-chip",
  "tm-sc-metric",
  "tm-svg-accent",
  "tm-svg-warn",
  "tm-svg-danger",
]);

export interface DiagramBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiagramGeometryResult {
  svg: string;
  fittedTexts: number;
  movedBoxes: number;
  unresolvedBoxCollisions: number;
  unresolvedTextOverflows: number;
}

type Box = { node: Element; bounds: DiagramBounds };
type Point = { x: number; y: number };

const finite = (value: string | undefined): number | null => {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const right = (b: DiagramBounds): number => b.x + b.width;
const bottom = (b: DiagramBounds): number => b.y + b.height;
const area = (b: DiagramBounds): number => b.width * b.height;

export function rectanglesIntersect(a: DiagramBounds, b: DiagramBounds, gap = 0): boolean {
  return a.x < right(b) + gap
    && right(a) + gap > b.x
    && a.y < bottom(b) + gap
    && bottom(a) + gap > b.y;
}

function contains(outer: DiagramBounds, inner: DiagramBounds, tolerance = 0): boolean {
  return inner.x >= outer.x - tolerance
    && inner.y >= outer.y - tolerance
    && right(inner) <= right(outer) + tolerance
    && bottom(inner) <= bottom(outer) + tolerance;
}

function containsPoint(bounds: DiagramBounds, point: Point, tolerance = 0): boolean {
  return point.x >= bounds.x - tolerance
    && point.x <= right(bounds) + tolerance
    && point.y >= bounds.y - tolerance
    && point.y <= bottom(bounds) + tolerance;
}

function union(points: Point[]): DiagramBounds | null {
  if (!points.length) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function translated(bounds: DiagramBounds, dx: number, dy: number): DiagramBounds {
  return { ...bounds, x: bounds.x + dx, y: bounds.y + dy };
}

function translateFromAttribute(value: string | undefined): Point {
  let x = 0;
  let y = 0;
  for (const match of value?.matchAll(/translate\(\s*(-?\d+(?:\.\d+)?)\s*(?:[, ]\s*(-?\d+(?:\.\d+)?))?\s*\)/g) ?? []) {
    x += Number(match[1]);
    y += Number(match[2] ?? 0);
  }
  return { x, y };
}

/** Bounds for the absolute SVG path commands the authoring prompt permits in practice. */
function pathBounds(d: string): DiagramBounds | null {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const arity: Record<string, number> = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };
  const points: Point[] = [];
  let cursor = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  let command = "";
  let index = 0;

  const point = (x: number, y: number, relative: boolean): Point => relative
    ? { x: cursor.x + x, y: cursor.y + y }
    : { x, y };

  while (index < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[index]!)) command = tokens[index++]!;
    if (!command) return null;
    const upper = command.toUpperCase();
    const needed = arity[upper];
    if (needed === undefined) return null;
    if (upper === "Z") {
      cursor = { ...start };
      points.push({ ...cursor });
      command = "";
      continue;
    }
    if (index + needed > tokens.length || /^[a-zA-Z]$/.test(tokens[index]!)) return null;
    const values = tokens.slice(index, index + needed).map(Number);
    index += needed;
    const relative = command === command.toLowerCase();

    if (upper === "H") cursor = { x: relative ? cursor.x + values[0]! : values[0]!, y: cursor.y };
    else if (upper === "V") cursor = { x: cursor.x, y: relative ? cursor.y + values[0]! : values[0]! };
    else if (upper === "A") {
      const end = point(values[5]!, values[6]!, relative);
      const rx = Math.abs(values[0]!);
      const ry = Math.abs(values[1]!);
      points.push({ x: cursor.x - rx, y: cursor.y - ry }, { x: cursor.x + rx, y: cursor.y + ry });
      points.push({ x: end.x - rx, y: end.y - ry }, { x: end.x + rx, y: end.y + ry });
      cursor = end;
    } else {
      for (let pair = 0; pair < values.length; pair += 2) {
        points.push(point(values[pair]!, values[pair + 1]!, relative));
      }
      cursor = point(values[values.length - 2]!, values[values.length - 1]!, relative);
    }
    points.push({ ...cursor });
    if (upper === "M") {
      start = { ...cursor };
      command = relative ? "l" : "L";
    }
  }
  return union(points);
}

function elementBounds($: CheerioAPI, node: Element): DiagramBounds | null {
  const element = $(node);
  const name = node.tagName.toLowerCase();
  let bounds: DiagramBounds | null = null;
  if (name === "rect") {
    const x = finite(element.attr("x")) ?? 0;
    const y = finite(element.attr("y")) ?? 0;
    const width = finite(element.attr("width"));
    const height = finite(element.attr("height"));
    if (width !== null && height !== null && width >= 0 && height >= 0) bounds = { x, y, width, height };
  } else if (name === "circle") {
    const cx = finite(element.attr("cx"));
    const cy = finite(element.attr("cy"));
    const r = finite(element.attr("r"));
    if (cx !== null && cy !== null && r !== null) bounds = { x: cx - r, y: cy - r, width: r * 2, height: r * 2 };
  } else if (name === "ellipse") {
    const cx = finite(element.attr("cx"));
    const cy = finite(element.attr("cy"));
    const rx = finite(element.attr("rx"));
    const ry = finite(element.attr("ry"));
    if (cx !== null && cy !== null && rx !== null && ry !== null) bounds = { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 };
  } else if (name === "line") {
    const values = ["x1", "y1", "x2", "y2"].map((attr) => finite(element.attr(attr)));
    if (values.every((value) => value !== null)) bounds = union([
      { x: values[0]!, y: values[1]! },
      { x: values[2]!, y: values[3]! },
    ]);
  } else if (name === "polygon" || name === "polyline") {
    const values = (element.attr("points")?.match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? []).map(Number);
    const points: Point[] = [];
    for (let i = 0; i + 1 < values.length; i += 2) points.push({ x: values[i]!, y: values[i + 1]! });
    bounds = union(points);
  } else if (name === "path") {
    bounds = pathBounds(element.attr("d") ?? "");
  }
  if (!bounds) return null;
  const offset = translateFromAttribute(element.attr("transform"));
  return translated(bounds, offset.x, offset.y);
}

function classNames(element: Cheerio<Element>): string[] {
  return (element.attr("class") ?? "").split(/\s+/).filter(Boolean);
}

function layoutBoxes($: CheerioAPI): Box[] {
  return $("rect").toArray().flatMap((node) => {
    const element = $(node);
    if (!classNames(element).some((name) => LAYOUT_BOX_CLASSES.has(name))) return [];
    const bounds = elementBounds($, node);
    return bounds ? [{ node, bounds }] : [];
  });
}

function addNumber(element: Cheerio<Element>, attr: string, delta: number): void {
  const value = finite(element.attr(attr));
  if (value !== null) element.attr(attr, String(Math.round((value + delta) * 100) / 100));
}

function translateElement($: CheerioAPI, node: Element, dx: number, dy: number): void {
  const element = $(node);
  const name = node.tagName.toLowerCase();
  if (name === "rect") {
    element.attr("x", String(Math.round(((finite(element.attr("x")) ?? 0) + dx) * 100) / 100));
    element.attr("y", String(Math.round(((finite(element.attr("y")) ?? 0) + dy) * 100) / 100));
  } else if (name === "text") {
    addNumber(element, "x", dx);
    addNumber(element, "y", dy);
  } else if (name === "circle" || name === "ellipse") {
    addNumber(element, "cx", dx);
    addNumber(element, "cy", dy);
  } else if (name === "line") {
    addNumber(element, "x1", dx);
    addNumber(element, "x2", dx);
    addNumber(element, "y1", dy);
    addNumber(element, "y2", dy);
  } else if (name === "polygon" || name === "polyline") {
    const values = (element.attr("points")?.match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? []).map(Number);
    element.attr("points", values.map((value, index) => String(Math.round((value + (index % 2 === 0 ? dx : dy)) * 100) / 100)).join(" "));
  } else if (name === "path") {
    const prior = element.attr("transform");
    element.attr("transform", `${prior ? `${prior} ` : ""}translate(${dx} ${dy})`);
  }
}

function moveBoxCluster($: CheerioAPI, box: Box, dx: number, dy: number): void {
  const geometry = $("rect,circle,ellipse,line,polygon,polyline,path,text").toArray();
  const owned = geometry.filter((node) => {
    if (node === box.node) return true;
    if (node.tagName.toLowerCase() === "text") {
      const element = $(node);
      const x = finite(element.attr("x"));
      const y = finite(element.attr("y"));
      return x !== null && y !== null && containsPoint(box.bounds, { x, y }, 1);
    }
    const bounds = elementBounds($, node);
    return bounds !== null && contains(box.bounds, bounds, 1);
  });
  for (const node of owned) translateElement($, node, dx, dy);
}

function boxCollisionPair(boxes: Box[]): [Box, Box] | null {
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (contains(a.bounds, b.bounds, 1) || contains(b.bounds, a.bounds, 1)) continue;
      if (rectanglesIntersect(a.bounds, b.bounds, 1)) return [a, b];
    }
  }
  return null;
}

function candidateMoves(moving: DiagramBounds, fixed: DiagramBounds): Point[] {
  return [
    { x: right(fixed) + BOX_GAP - moving.x, y: 0 },
    { x: fixed.x - BOX_GAP - right(moving), y: 0 },
    { x: 0, y: bottom(fixed) + BOX_GAP - moving.y },
    { x: 0, y: fixed.y - BOX_GAP - bottom(moving) },
  ].sort((a, b) => Math.abs(a.x) + Math.abs(a.y) - Math.abs(b.x) - Math.abs(b.y));
}

function moveIsClear(candidate: DiagramBounds, moving: Box, boxes: Box[]): boolean {
  if (candidate.x < VIEWBOX.left || candidate.y < VIEWBOX.top || right(candidate) > VIEWBOX.right || bottom(candidate) > VIEWBOX.bottom) return false;
  for (const other of boxes) {
    if (other.node === moving.node || contains(moving.bounds, other.bounds, 1)) continue;
    if (rectanglesIntersect(candidate, other.bounds, 1)) return false;
  }
  return true;
}

function repairBoxCollisions($: CheerioAPI): { moved: number; unresolved: number } {
  let moved = 0;
  const limit = Math.max(8, layoutBoxes($).length * 4);
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const boxes = layoutBoxes($);
    const pair = boxCollisionPair(boxes);
    if (!pair) return { moved, unresolved: 0 };
    const ordered = [...pair].sort((a, b) => area(a.bounds) - area(b.bounds));
    let correction: { box: Box; dx: number; dy: number } | null = null;
    for (const box of ordered) {
      const fixed = box.node === pair[0].node ? pair[1] : pair[0];
      for (const delta of candidateMoves(box.bounds, fixed.bounds)) {
        if (moveIsClear(translated(box.bounds, delta.x, delta.y), box, boxes)) {
          correction = { box, dx: delta.x, dy: delta.y };
          break;
        }
      }
      if (correction) break;
    }
    if (!correction) break;
    moveBoxCluster($, correction.box, correction.dx, correction.dy);
    moved += 1;
  }
  const boxes = layoutBoxes($);
  let unresolved = 0;
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (contains(boxes[i]!.bounds, boxes[j]!.bounds, 1) || contains(boxes[j]!.bounds, boxes[i]!.bounds, 1)) continue;
      if (rectanglesIntersect(boxes[i]!.bounds, boxes[j]!.bounds, 1)) unresolved += 1;
    }
  }
  return { moved, unresolved };
}

function textFontSize(element: Cheerio<Element>): number {
  const classes = new Set(classNames(element));
  if (PORTRAIT) {
    if (classes.has("tm-sc-metric")) return PORTRAIT_FONT_PX.metric;
    if (classes.has("tm-svg-kicker")) return PORTRAIT_FONT_PX.kicker;
    if (classes.has("tm-svg-label")) return PORTRAIT_FONT_PX.label;
    if (classes.has("tm-svg-tiny")) return PORTRAIT_FONT_PX.tiny;
    if (classes.has("tm-svg-accent") || classes.has("tm-svg-warn") || classes.has("tm-svg-danger")) return PORTRAIT_FONT_PX.accent;
    return PORTRAIT_FONT_PX.tiny;
  }
  if (classes.has("tm-sc-metric")) return 21;
  if (classes.has("tm-svg-kicker")) return 14;
  if (classes.has("tm-svg-label")) return 15;
  if (classes.has("tm-svg-tiny")) return 11;
  if (classes.has("tm-svg-accent") || classes.has("tm-svg-warn") || classes.has("tm-svg-danger")) return 15;
  return 12;
}

/** Conservative Kalam/JetBrains-Mono width used only to decide when exact SVG textLength is needed. */
function estimatedTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const char of [...text.trim()]) {
    if (/\s/.test(char)) em += 0.36;
    else if (/[MW@#%&]/.test(char)) em += 0.9;
    else if (/[I1il.,:;'·|]/.test(char)) em += 0.34;
    else em += 0.64;
  }
  return em * fontSize * 1.12;
}

function textAnchor(element: Cheerio<Element>): "start" | "middle" | "end" {
  const anchor = element.attr("text-anchor");
  return anchor === "middle" || anchor === "end" ? anchor : "start";
}

function fitTexts($: CheerioAPI): { fitted: number; unresolved: number } {
  const rects = $("rect").toArray().flatMap((node) => {
    const bounds = elementBounds($, node);
    return bounds ? [{ node, bounds }] : [];
  });
  const obstacles = $("rect,circle,ellipse,line,polygon,polyline,path").toArray().flatMap((node) => {
    const bounds = elementBounds($, node);
    return bounds ? [{ node, bounds }] : [];
  });
  const texts = $("text").toArray().flatMap((node) => {
    const element = $(node);
    const x = finite(element.attr("x"));
    const y = finite(element.attr("y"));
    if (x === null || y === null || !element.text().trim()) return [];
    return [{ node, x, y, fontSize: textFontSize(element) }];
  });
  let fitted = 0;
  let unresolved = 0;

  for (const text of texts) {
    const element = $(text.node);
    const nearOwners = rects
      .filter((rect) => text.x >= rect.bounds.x && text.x <= right(rect.bounds)
        && text.y >= rect.bounds.y - 2 && text.y <= bottom(rect.bounds) + text.fontSize * 0.45)
      .sort((a, b) => area(a.bounds) - area(b.bounds));
    const owner = nearOwners[0];
    let left = owner ? owner.bounds.x + TEXT_INSET : VIEWBOX.left;
    let laneRight = owner ? right(owner.bounds) - TEXT_INSET : VIEWBOX.right;

    if (owner) {
      // Horizontal padding is fixed, but compact 22px chips cannot carry 8px above AND below an
      // 11px caption. Scale only the vertical inset; the full glyph height still has to fit.
      const verticalInset = Math.min(5, Math.max(2, owner.bounds.height * 0.12));
      const minBaseline = owner.bounds.y + verticalInset + text.fontSize * 0.78;
      const maxBaseline = bottom(owner.bounds) - verticalInset - text.fontSize * 0.18;
      if (minBaseline > maxBaseline) {
        unresolved += 1;
        continue;
      }
      const clamped = Math.max(minBaseline, Math.min(maxBaseline, text.y));
      if (Math.abs(clamped - text.y) > 0.1) {
        element.attr("y", String(Math.round(clamped * 100) / 100));
        text.y = clamped;
      }
    } else {
      const minBaseline = VIEWBOX.top + text.fontSize * 0.8;
      const maxBaseline = VIEWBOX.bottom - text.fontSize * 0.2;
      const clamped = Math.max(minBaseline, Math.min(maxBaseline, text.y));
      if (Math.abs(clamped - text.y) > 0.1) {
        element.attr("y", String(Math.round(clamped * 100) / 100));
        text.y = clamped;
      }
    }

    for (const peer of texts) {
      if (peer.node === text.node || Math.abs(peer.y - text.y) > 1.5 || Math.abs(peer.x - text.x) < 1) continue;
      const boundary = (peer.x + text.x) / 2;
      if (peer.x < text.x) left = Math.max(left, boundary + TEXT_GAP / 2);
      else laneRight = Math.min(laneRight, boundary - TEXT_GAP / 2);
    }

    const textTop = text.y - text.fontSize * 0.82;
    const textBottom = text.y + text.fontSize * 0.22;
    for (const obstacle of obstacles) {
      if (owner?.node === obstacle.node) continue;
      if (containsPoint(obstacle.bounds, { x: text.x, y: text.y }, 1)) continue;
      // A single bbox for an L-shaped/curved path covers large empty quadrants. Treating that empty
      // area as ink squeezed otherwise-clean labels to a third of their width. Thin horizontal or
      // vertical paths are real lane boundaries; compound paths remain connector geometry, not a
      // solid rectangle. Rects/circles/polylines retain their exact bounds checks.
      if (obstacle.node.tagName.toLowerCase() === "path" && obstacle.bounds.width > 3 && obstacle.bounds.height > 3) continue;
      if (bottom(obstacle.bounds) < textTop || obstacle.bounds.y > textBottom) continue;
      if (right(obstacle.bounds) <= text.x) left = Math.max(left, right(obstacle.bounds) + TEXT_GAP);
      else if (obstacle.bounds.x >= text.x) laneRight = Math.min(laneRight, obstacle.bounds.x - TEXT_GAP);
    }

    const anchor = textAnchor(element);
    const available = anchor === "middle"
      ? 2 * Math.min(text.x - left, laneRight - text.x)
      : anchor === "end" ? text.x - left : laneRight - text.x;
    const natural = estimatedTextWidth(element.text(), text.fontSize);
    const rendered = natural;
    if (available < text.fontSize * 0.7 && rendered > Math.max(available, 0)) {
      unresolved += 1;
      continue;
    }
    if (rendered > available + 0.5) {
      const floor = owner ? 0 : natural * TEXT_SQUEEZE_FLOOR;
      const fit = Math.max(floor, Math.max(18, Math.floor(available * 10) / 10));
      if (fit < natural - 0.5) {
        element.attr("textLength", String(Math.round(fit * 10) / 10));
        element.attr("lengthAdjust", "spacingAndGlyphs");
        fitted += 1;
      } else {
        element.removeAttr("textLength");
        element.removeAttr("lengthAdjust");
      }
    } else {
      // It fits at natural width now — drop any squeeze an earlier pass left behind.
      if (element.attr("textLength")) {
        element.removeAttr("textLength");
        element.removeAttr("lengthAdjust");
        fitted += 1;
      }
    }
  }
  return { fitted, unresolved };
}

/**
 * Deterministic post-pass for untrusted, model-authored SVG geometry.
 *
 * - Partially intersecting layout boxes are moved to the nearest free in-bounds position together
 *   with the geometry/text they contain. Strictly nested boxes are left intact.
 * - Every text row receives an actual horizontal lane bounded by its containing box, adjacent text,
 *   nearby geometry, and the 720x340 viewBox. SVG textLength performs the exact final fit.
 * - Baselines on or beyond a container border are clamped back inside it.
 *
 * If a collision cannot be corrected without leaving the viewBox, the caller must reject the
 * authored diagram and use the deterministic schematic fallback.
 */
export function normalizeDiagramGeometry(svg: string): DiagramGeometryResult {
  VIEWBOX = viewboxFor(svg);
  PORTRAIT = /\btm-svg-portrait\b/.test(svg);
  const $ = cheerio.load(svg, { xmlMode: true }, false);
  const boxes = repairBoxCollisions($);
  // Order matters and is load-bearing: slide out-of-bounds labels back inside FIRST, so fitTexts
  // measures their final lanes. Doing it afterwards left a label squeezed for a lane it no longer
  // occupied, and a second normalize pass produced a different (better) result — i.e. one pass did
  // not converge.
  const clamped = clampFloatingTextsInBounds($);
  const text = fitTexts($);
  const separated = separateFloatingTexts($) + clamped;
  return {
    svg: $.xml(),
    fittedTexts: text.fitted + separated,
    movedBoxes: boxes.moved,
    unresolvedBoxCollisions: boxes.unresolved,
    unresolvedTextOverflows: text.unresolved,
  };
}

function clampFloatingTextsInBounds($: CheerioAPI): number {
  const rects = $("rect").toArray().flatMap((node) => {
    const bounds = elementBounds($, node);
    return bounds ? [bounds] : [];
  });
  let moved = 0;
  for (const node of $("text").toArray()) {
    const element = $(node);
    const x = finite(element.attr("x"));
    const y = finite(element.attr("y"));
    const label = element.text().trim();
    if (x === null || y === null || !label) continue;
    if (rects.some((b) => x >= b.x && x <= right(b) && y >= b.y && y <= bottom(b))) continue;
    const width = estimatedTextWidth(label, textFontSize(element));
    const anchor = textAnchor(element);
    const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
    const over = left + width - VIEWBOX.right;
    const under = VIEWBOX.left - left;
    const shift = over > 0.5 ? -Math.min(over, Math.max(0, left - VIEWBOX.left))
      : under > 0.5 ? Math.min(under, Math.max(0, VIEWBOX.right - (left + width))) : 0;
    if (Math.abs(shift) < 0.5) continue;
    element.attr("x", String(Math.round((x + shift) * 10) / 10));
    moved += 1;
  }
  return moved;
}

function separateFloatingTexts($: CheerioAPI): number {
  const GAP = 5;
  const rects = $("rect").toArray().flatMap((node) => {
    const bounds = elementBounds($, node);
    return bounds ? [bounds] : [];
  });
  const items = $("text").toArray().flatMap((node) => {
    const element = $(node);
    const x = finite(element.attr("x"));
    const y = finite(element.attr("y"));
    const label = element.text().trim();
    if (x === null || y === null || !label) return [];
    // Owned by a box? fitTexts already placed it — leave it alone.
    if (rects.some((b) => x >= b.x && x <= right(b) && y >= b.y && y <= bottom(b))) return [];
    const fontSize = textFontSize(element);
    const width = estimatedTextWidth(label, fontSize);
    const anchor = (element.attr("text-anchor") ?? "start").toLowerCase();
    const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
    return [{ element, y, fontSize, left, right: left + width }];
  });

  let moved = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      const [upper, lower] = a.y <= b.y ? [a, b] : [b, a];
      const horizontallyClear = upper.right <= lower.left || lower.right <= upper.left;
      if (horizontallyClear) continue;
      const upperBottom = upper.y + upper.fontSize * 0.22;
      const lowerTop = lower.y - lower.fontSize * 0.82;
      const delta = upperBottom + GAP - lowerTop;
      if (delta <= 0) continue; // already clear vertically
      if (lower.y + delta + lower.fontSize * 0.22 > VIEWBOX.bottom) continue; // would leave the canvas
      lower.y += delta;
      lower.element.attr("y", String(Math.round(lower.y * 10) / 10));
      moved += 1;
    }
  }
  return moved;
}
