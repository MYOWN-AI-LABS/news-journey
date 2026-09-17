import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { textOverflow } from "../../video/components/TextBoundsGuard.js";

test("render guard rejects overflowing glyphs and clipped SVG text while accepting fitted and hidden text", async (t) => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    // Every finding below is a glyph measurement in 80px Arial, a system font rather than one of
    // the shipped docs/journey-assets/*.woff2 faces. A runner without Arial substitutes different
    // metrics, so the fitted/overflowing boundary these cases sit on is no longer the one under test.
    const arial = await page.evaluate(() => {
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = "80px Arial";
      const installed = context.measureText("Text inside the frame").width;
      context.font = "80px no-such-installed-family";
      return installed !== context.measureText("Text inside the frame").width;
    });
    if (!arial) return t.skip("Arial is not installed on this runner; these 80px glyph bounds are specific to its metrics");
    await page.setContent(`<style>body{margin:0}#frame{position:relative;width:1080px;height:1920px;font:80px Arial}</style>
      <div id="frame"><div>Text inside the frame</div>
      <div style="position:absolute;top:300px;width:100px;overflow:hidden">CLIPPED</div>
      <div style="position:absolute;top:-100px">ABOVE</div>
      <div style="position:absolute;top:600px;left:1040px">RIGHT</div>
      <svg style="position:absolute;top:800px;overflow:hidden" width="200" height="100"><text x="190" y="70">SVG</text></svg>
      <div style="display:none;position:absolute;left:2000px">HIDDEN</div></div>`);
    // Evaluate the production browser measurement, not an imitation of its geometry rules.
    await page.addScriptTag({ content: `window.checkText = ${textOverflow.toString()}` });
    const findings = await page.evaluate(() => (window as any).checkText(document.getElementById("frame")) as string[]);
    for (const label of ["CLIPPED", "ABOVE", "RIGHT", "SVG"]) assert.ok(findings.some(s => s.includes(`"${label}"`)), label);
    assert.equal(findings.length, 4, findings.join("\n"));
    await page.locator("#frame").evaluate(el => el.innerHTML = '<div style="width:200px;overflow-wrap:anywhere">ANNOUNCEMENTS</div>');
    assert.ok((await page.evaluate(() => (window as any).checkText(document.getElementById("frame")) as string[])).some(s => s.includes("split across lines")));
    await page.locator("#frame").evaluate(el => el.innerHTML = "Text inside the frame");
    await page.locator('#frame > :not(:first-child)').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    assert.deepEqual(await page.evaluate(() => (window as any).checkText(document.getElementById("frame"))), []);
  } finally { await browser.close(); }
});
