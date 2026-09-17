// Unit tests for the PURE figure placement. Run: npx tsx --test src/publish/story-figures.test.ts
import { embedStoryFigures, type StoryFigure } from "./story-figures.js";
import { existsSync, readFileSync } from "node:fs";

let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS ${name}`);
  else { failed++; console.log(`FAIL ${name}`); }
}
const fig = (n: number, anchor: string): StoryFigure => ({ storyNumber: n, png: `/x/${n}.png`, dataUri: `data:image/png;base64,F${n}`, referenceUri: `data:image/png;base64,F${n}`, anchor });

// The exact shape renderLinkedInEdition emits.
const BODY = `<p><i>No hype, just signal — Issue № 74 · Aug 24</i></p>
<h2>The lead: AI’s book-training rules remain unsettled</h2>
<p><b>MECH:</b> how</p>
<p>Lead body. (<a href="https://a.test/1">Src</a>)</p>
<h2>Worth your time</h2>
<ul>
<li><b><a href="https://a.test/2">AWS governs agent access in stages</a></b><br>line two</li>
<li><b><a href="https://a.test/3">club-3090 brings large models to gaming GPUs</a></b><br>line three</li>
<li><b><a href="https://a.test/4">GPT-5.6 Sol reprices hosted inference</a></b><br>line four</li>
</ul>
<h2>Trending, not yet covered</h2>
<ul>
<li><a href="https://a.test/5">repo</a> — trend</li>
</ul>
<p>— Example Signal</p>`;
const FIGS = [
  fig(1, "The lead: AI’s book-training rules remain unsettled"),
  fig(2, "AWS governs agent access in stages"),
  fig(3, "club-3090 brings large models to gaming GPUs"),
  fig(4, "GPT-5.6 Sol reprices hosted inference"),
];

const out = embedStoryFigures(BODY, FIGS);
const order = [...out.matchAll(/<img src="data:image\/png;base64,F(\d)"/g)].map((m) => m[1]).join("");
check("embed: four figures, in story order", order === "1234");
check("embed: lead figure sits directly under the lead heading",
  /<h2>The lead: [^<]*<\/h2>\n<img src="data:image\/png;base64,F1"/.test(out));
check("embed: item figure follows ITS OWN list item",
  /club-3090[\s\S]*?<\/li>\n<\/ul>\n<img src="data:image\/png;base64,F3"/.test(out)
  && !/AWS governs[\s\S]*?<\/li>\n<\/ul>\n<img src="data:image\/png;base64,F3"/.test(out.split("club-3090")[0]));
check("embed: the Worth-your-time list is split into one list per item", (out.match(/<ul>/g) ?? []).length === 4);
check("embed: the Trending list is untouched", /<h2>Trending, not yet covered<\/h2>\n<ul>\n<li><a href="https:\/\/a.test\/5">repo<\/a> — trend<\/li>\n<\/ul>/.test(out));
check("embed: link count unchanged", (out.match(/<a\s/g) ?? []).length === (BODY.match(/<a\s/g) ?? []).length);
check("embed: alt text carries the story number", out.includes('alt="Story 2 diagram"'));

const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
check("embed: item count mismatch throws", throws(() => embedStoryFigures(BODY, FIGS.slice(0, 3))));
check("embed: wrong anchor throws (a figure may never land under another story)",
  throws(() => embedStoryFigures(BODY, [FIGS[0], FIGS[2], FIGS[1], FIGS[3]])));
check("embed: missing lead heading throws", throws(() => embedStoryFigures(BODY.replace("The lead: ", "Lead: "), FIGS)));
check("embed: no figures throws", throws(() => embedStoryFigures(BODY, [])));

// Against the real artifact when present — the anchors are the renderer's, so drift shows here first.
const real = "workdir/newsletters/2026-08-24.linkedin.html";
if (existsSync(real)) {
  const d = JSON.parse(readFileSync("workdir/newsletters/2026-08-24.json", "utf8"));
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(readFileSync(real, "utf8"))![1].trim();
  const figs = [fig(1, `The lead: ${d.issue.lead.title}`), ...d.issue.items.map((it: { name: string }, i: number) => fig(i + 2, it.name))];
  const realOut = embedStoryFigures(body, figs);
  check("embed(real 2026-08-24): four figures placed", (realOut.match(/<img /g) ?? []).length === 4);
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
if (failed) process.exit(1);
