import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import { normalizeDiagramGeometry, rectanglesIntersect, type DiagramBounds } from "./story-diagram-layout.js";

const parse = (svg: string): cheerio.CheerioAPI => cheerio.load(svg, { xmlMode: true }, false);

const rectBounds = ($: cheerio.CheerioAPI, selector: string): DiagramBounds => {
  const rect = $(selector);
  return {
    x: Number(rect.attr("x")),
    y: Number(rect.attr("y")),
    width: Number(rect.attr("width")),
    height: Number(rect.attr("height")),
  };
};

test("diagram geometry fits text longer than its container inside the corrected box", () => {
  const result = normalizeDiagramGeometry(`<svg viewBox="0 0 720 340">
    <rect id="container" class="tm-sc-bank" x="100" y="100" width="80" height="36"/>
    <text id="long-label" class="tm-svg-label" x="140" y="123" text-anchor="middle">A LABEL MUCH LONGER THAN ITS BOX</text>
  </svg>`);
  const $ = parse(result.svg);
  const length = Number($("#long-label").attr("textLength"));
  const box = rectBounds($, "#container");
  const center = Number($("#long-label").attr("x"));

  assert.equal(result.unresolvedTextOverflows, 0);
  assert.ok(length > 0 && length <= box.width - 16, `fitted width ${length} must stay within ${box.width - 16}`);
  assert.ok(center - length / 2 >= box.x + 8);
  assert.ok(center + length / 2 <= box.x + box.width - 8);
  assert.equal($("#long-label").attr("lengthAdjust"), "spacingAndGlyphs");
});

test("diagram geometry separates two intersecting boxes and carries contained text with the move", () => {
  const result = normalizeDiagramGeometry(`<svg viewBox="0 0 720 340">
    <rect id="box-a" class="tm-sc-bank" x="40" y="80" width="140" height="80"/>
    <rect id="box-b" class="tm-sc-body" x="150" y="120" width="120" height="70"/>
    <text id="box-b-label" class="tm-svg-label" x="210" y="150" text-anchor="middle">SECOND BOX</text>
  </svg>`);
  const $ = parse(result.svg);
  const a = rectBounds($, "#box-a");
  const b = rectBounds($, "#box-b");
  const label = { x: Number($("#box-b-label").attr("x")), y: Number($("#box-b-label").attr("y")) };

  assert.equal(result.movedBoxes, 1);
  assert.equal(result.unresolvedBoxCollisions, 0);
  assert.equal(rectanglesIntersect(a, b), false);
  assert.ok(label.x >= b.x && label.x <= b.x + b.width, "contained label moved with its box on x");
  assert.ok(label.y >= b.y && label.y <= b.y + b.height, "contained label moved with its box on y");
});

test("diagram geometry constrains a border label to the viewBox", () => {
  const result = normalizeDiagramGeometry(`<svg viewBox="0 0 720 340">
    <text id="edge-label" class="tm-svg-label" x="690" y="200" text-anchor="middle">LABEL THAT WOULD OVERRUN THE RIGHT BORDER</text>
  </svg>`);
  const $ = parse(result.svg);
  const label = $("#edge-label");
  const x = Number(label.attr("x"));
  // The newer normalizer first moves the complete label inward; fitting is only needed if it remains too wide.
  const length = Number(label.attr("textLength")) || label.text().length * 15 * .65;

  assert.equal(result.unresolvedTextOverflows, 0);
  assert.ok(length > 0);
  assert.ok(x + length / 2 <= 708, `right edge ${x + length / 2} must remain inside 708`);
  assert.ok(x - length / 2 >= 12, `left edge ${x - length / 2} must remain inside 12`);
});
