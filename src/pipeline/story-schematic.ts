import type { StoryMotion, StoryVisualDescriptorLike } from "../types.js";

/**
 * Deterministic story schematic — the fallback illustrator.
 *
 * The predecessor of this file was a table of hand-authored SVGs, each keyed to a story that had
 * already happened. Diagrams therefore appeared only on days someone edited source alongside the
 * edition: a person drew the SVG that morning. An unattended scheduled run had no such author, so an
 * unmatched story fell through to a placeholder the renderer rejected, and the edition shipped with
 * no artwork at all.
 *
 * This module removes that failure mode. It derives a drawing from the story's own who/what/how/
 * impact, so an unattended run always produces SOMETHING defensible. It is a floor, not the target:
 * because it is a stencil, two stories of the same motion kind render the same geometry and differ
 * only in their labels. `story-diagram.ts` is the per-story illustrator that supersedes it whenever
 * authoring succeeds.
 *
 * ⚠️ STYLE CONTRACT — PICTORIAL, not a flowchart.
 * An early version drew four rectangles containing wrapped prose and was rejected in review: it did
 * not match the publication's visual language. Diagrams here depict physical apparatus (rails, gate
 * pulses, shields, funnels) carrying SHORT ALL-CAPS labels, a source kicker, a metric column, and a
 * warning branch for unverified claims. Sentences belong in the reading line beneath the card, never
 * inside the artwork. The house layout, if in doubt: source cluster on the left, apparatus in the
 * centre, outcome shield on the right, metric column far right, status branch along the bottom.
 *
 * This module closes the hole WITHOUT a model call, so it still works when no provider is
 * configured, the provider is unreachable, or authoring fails validation. It composes the apparatus
 * from the `who / what / how / impact / kind` fields the script stage already produces, so it is
 * deterministic, unit-testable, and identical across the newsletter and the video — a property a
 * freshly generated image could never satisfy.
 *
 * ⛔ Do not reintroduce a bare fallback that renders nothing, and do not put sentences in the SVG.
 */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Only LEADING determiners are dropped. Removing interior function words produced fragments like
// "MARK SITS RESULTING" out of "The mark sits in the resulting language" — shorter, but nonsense.
// The reference labels ("TWO DUAL-RAIL QUBITS", "ERROR SIGNAL PRESERVED") read as English.
const LEADING = new Set(["the", "a", "an", "its", "their", "this", "that", "these", "those", "it"]);

// A truncated phrase must not end on a function word. Cutting at a fixed word count produced
// "MARK SITS IN THE" and "SUPPORTED CLAUDE MODELS WILL EMBED AN" — grammatical fragments that read
// as errors. Trailing words in this set are dropped until the label ends on something meaningful.
const TRAILING = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "with", "by", "from", "into",
  "as", "at", "is", "are", "was", "were", "be", "been", "will", "can", "could", "would", "may",
  "that", "this", "its", "their", "no", "not", "but", "so", "than", "then", "while", "which",
]);

/**
 * Reduce a prose field to a short ALL-CAPS label in the house voice. Keeps word order and interior
 * grammar, drops only leading determiners, and always breaks on a word boundary.
 */
export function keyphrase(text: string, maxWords = 3, maxChars = 26): string {
  const words = text
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && LEADING.has(words[0]!.toLowerCase())) words.shift();
  const kept: string[] = [];
  for (const word of words.slice(0, maxWords)) {
    const next = kept.length ? `${kept.join(" ")} ${word}` : word;
    if (next.length > maxChars && kept.length) break;
    kept.push(word);
  }
  while (kept.length > 1 && TRAILING.has(kept[kept.length - 1]!.toLowerCase())) kept.pop();
  return (kept.length ? kept : [words[0] ?? ""]).join(" ").toUpperCase();
}

/** Two balanced lines, so a label can breathe without becoming a paragraph. */
function twoLine(text: string, y: number, x: number, cls: string, maxWords = 4): string {
  const words = keyphrase(text, maxWords, 38).split(" ");
  if (words.length < 3) {
    return `<text x="${x}" y="${y}" class="${cls}" text-anchor="middle">${esc(words.join(" "))}</text>`;
  }
  const mid = Math.ceil(words.length / 2);
  return `<text x="${x}" y="${y - 9}" class="${cls}" text-anchor="middle">${esc(words.slice(0, mid).join(" "))}</text><text x="${x}" y="${y + 9}" class="${cls}" text-anchor="middle">${esc(words.slice(mid).join(" "))}</text>`;
}

/**
 * The left-hand source cluster, drawn as apparatus rather than a box. Each motion kind gets the
 * physical object its stories are actually about, mirroring how the authored primitives open.
 */
const SOURCE_CLUSTER: Record<StoryMotion["kind"], string> = {
  device: `<g class="tm-sc-cluster"><rect x="86" y="118" width="108" height="92" rx="10" class="tm-sc-chip"/><path d="M86 140 H62 M86 164 H62 M86 188 H62 M194 140 H218 M194 164 H218 M194 188 H218" class="tm-sc-pins"/><rect x="112" y="144" width="56" height="40" rx="5" class="tm-sc-core"/></g>`,
  memory: `<g class="tm-sc-cluster">${[0, 1, 2, 3].map((i) => `<rect x="70" y="${112 + i * 26}" width="140" height="18" rx="4" class="tm-sc-bank" style="--i:${i}"/>`).join("")}</g>`,
  robot: `<g class="tm-sc-cluster"><circle cx="140" cy="132" r="20" class="tm-sc-head"/><rect x="118" y="156" width="44" height="52" rx="9" class="tm-sc-body"/><path d="M118 176 L82 204 M162 176 L198 204" class="tm-sc-limb"/></g>`,
  compress: `<g class="tm-sc-cluster">${[0, 1, 2, 3, 4].map((i) => `<rect x="${76 + i * 4}" y="${110 + i * 22}" width="${128 - i * 8}" height="14" rx="3" class="tm-sc-layer" style="--i:${i}"/>`).join("")}</g>`,
  flow: `<g class="tm-sc-cluster"><circle cx="140" cy="164" r="46" class="tm-sc-ring"/><circle cx="140" cy="164" r="20" class="tm-sc-core-dot"/>${[0, 1, 2, 3, 4, 5].map((i) => { const a = (i * Math.PI) / 3; return `<circle cx="${(140 + Math.cos(a) * 46).toFixed(1)}" cy="${(164 + Math.sin(a) * 46).toFixed(1)}" r="5" class="tm-sc-node" style="--i:${i}"/>`; }).join("")}</g>`,
};

/** The centre apparatus: the mechanism itself, again shaped by the story's own kind. */
const MECHANISM: Record<StoryMotion["kind"], string> = {
  device: `<rect x="292" y="126" width="80" height="76" rx="9" class="tm-sc-apparatus"/><path d="M306 150 H358 M306 164 H358 M306 178 H358" class="tm-sc-wave"/>`,
  memory: `<circle cx="332" cy="164" r="46" class="tm-sc-apparatus-round"/><path d="M300 164 H364 M332 132 V196" class="tm-sc-wave"/>`,
  robot: `<circle cx="332" cy="164" r="46" class="tm-sc-apparatus-round"/><path d="M300 186 Q332 116 364 186" class="tm-sc-wave"/><circle cx="332" cy="164" r="7" class="tm-sc-core-dot"/>`,
  compress: `<path d="M288 122 H376 L344 164 L344 208 L320 196 L320 164 Z" class="tm-sc-apparatus"/>`,
  flow: `<circle cx="332" cy="164" r="48" class="tm-sc-apparatus-round"/><path d="M308 146 H356 M308 164 H356 M308 182 H356" class="tm-sc-wave"/>`,
};

export type SchematicStory = Pick<StoryMotion, "who" | "what" | "how" | "impact" | "status" | "kind"> & {
  metric?: { display: string; label: string } | null;
};

/**
 * Descriptor built from the story itself. The authored primitives can use a static descriptor
 * because each describes exactly one story; this one is shared by every unmatched story, so a
 * static string would put the same sentence under four different diagrams. The full sentences live
 * HERE — in the reading line under the card — not inside the artwork.
 */
export function schematicDescriptor(story: SchematicStory): StoryVisualDescriptorLike {
  const trim = (s: string) => s.trim().replace(/[.;,]+$/, "");
  return {
    primitive: "story-schematic",
    label: `${keyphrase(story.who, 4, 28)} → ${keyphrase(story.impact, 5, 34)}`,
    reading: `${trim(story.who)} ${trim(story.what).replace(/^./, (c) => c.toLowerCase())}; ${trim(story.how).replace(/^./, (c) => c.toLowerCase())}. ${trim(story.impact)}.`,
    // Short, like the reference legend ("dual-rail qubits", "two-qubit gate") — full sentences here
    // duplicated the reading line directly above and wrapped onto three rows.
    legend: [
      { kind: "source", label: keyphrase(story.who, 5, 32).toLowerCase() },
      { kind: "route", label: keyphrase(story.what, 7, 40).toLowerCase() },
      { kind: "change", label: keyphrase(story.how, 7, 40).toLowerCase() },
      { kind: "result", label: keyphrase(story.impact, 7, 40).toLowerCase() },
    ],
  };
}

/**
 * Render the schematic in the Aug-11 quantum layout: source cluster (left) → mechanism apparatus
 * (centre) → outcome shield (right), with a metric column far right and the status branch along
 * the bottom. Geometry matches the authored primitives (720×340) so it drops into the same slot in
 * both the newsletter and the Remotion scene.
 */
export function storySchematicSvg(story: SchematicStory, titleId: string): string {
  const kind = story.kind in SOURCE_CLUSTER ? story.kind : "flow";
  const trim = (s: string) => s.trim().replace(/[.;,]+$/, "");

  // The outcome text lives in the RIGHT COLUMN, not under the shield. Stacked below it, the second
  // line ran past the card and collided with the "drag to orbit" hint.
  const rightColumn = story.metric
    ? `<text x="632" y="146" class="tm-sc-metric" text-anchor="middle">${esc(story.metric.display.slice(0, 12))}</text>` +
      `<text x="632" y="168" class="tm-svg-tiny" text-anchor="middle">${esc(keyphrase(story.metric.label, 3, 22))}</text>` +
      twoLine(story.impact, 214, 632, "tm-svg-accent", 4)
    : `<text x="632" y="132" class="tm-svg-tiny" text-anchor="middle">RESULT</text>` +
      twoLine(story.impact, 166, 632, "tm-svg-accent", 6);

  return `<svg class="tm-story-svg tm-svg-schematic" data-visual-primitive="story-schematic" viewBox="0 0 720 340" role="img" aria-labelledby="${titleId}">
    <title id="${titleId}">${esc(`${trim(story.who)}: ${trim(story.what)}. ${trim(story.how)}. ${trim(story.impact)}.`)}</title>
    <text x="36" y="28" class="tm-svg-kicker">${esc(keyphrase(story.who, 4, 34))} · ${esc(keyphrase(story.status || "REPORTED", 2, 18))}</text>

    ${SOURCE_CLUSTER[kind]}
    ${twoLine(story.what, 250, 140, "tm-svg-label", 6)}

    <path d="M218 164 H286" class="tm-native-route tm-native-trace"/>

    ${MECHANISM[kind]}
    ${twoLine(story.how, 250, 332, "tm-svg-label", 6)}

    <path d="M384 164 H444" class="tm-native-route tm-native-trace" style="--trace-delay:.3s"/>

    <path d="M496 106 L548 126 V178 C548 222 524 250 496 266 C468 250 444 222 444 178 V126 Z" class="tm-sc-shield"/>
    <path d="M472 182 L492 202 L524 162" class="tm-sc-check"/>

    <path d="M556 164 H600" class="tm-native-route" style="opacity:.4"/>
    ${rightColumn}

    <text x="36" y="318" class="tm-svg-tiny">STATUS · ${esc(keyphrase(story.status || "REPORTED", 4, 40))}</text>
  </svg>`;
}

/**
 * Shared stylesheet for the schematic. Exported so the newsletter <style> block and the Remotion
 * scene use ONE definition — the whole point of the schematic is that both media render the same
 * picture, and two copies of the CSS is exactly how that guarantee rots.
 */
export const SCHEMATIC_CSS = `
.tm-svg-schematic .tm-svg-label{font-size:11px;letter-spacing:.06em}
.tm-svg-schematic .tm-svg-accent{font-size:11px;letter-spacing:.06em}
.tm-sc-chip{fill:#151D2D;stroke:#E7E3EF;stroke-width:2.2}
.tm-sc-core{fill:rgba(var(--accentRgb),.16);stroke:var(--accent);stroke-width:2}
.tm-sc-pins{fill:none;stroke:rgba(255,255,255,.45);stroke-width:2.4;stroke-linecap:round}
.tm-sc-bank{fill:#151D2D;stroke:rgba(255,255,255,.4);stroke-width:1.8}
.tm-sc-head{fill:#151D2D;stroke:#E7E3EF;stroke-width:2.2}
.tm-sc-body{fill:rgba(var(--accentRgb),.12);stroke:var(--accent);stroke-width:2.2}
.tm-sc-limb{fill:none;stroke:rgba(255,255,255,.45);stroke-width:2.6;stroke-linecap:round}
.tm-sc-layer{fill:rgba(var(--accentRgb),.14);stroke:var(--accent);stroke-width:1.6}
.tm-sc-ring{fill:none;stroke:rgba(255,255,255,.28);stroke-width:2.2;stroke-dasharray:6 8}
.tm-sc-core-dot{fill:rgba(var(--accentRgb),.9)}
.tm-sc-node{fill:var(--accent)}
.tm-sc-apparatus{fill:rgba(var(--accentRgb),.1);stroke:var(--accent);stroke-width:2.6}
.tm-sc-apparatus-round{fill:rgba(var(--accentRgb),.09);stroke:var(--accent);stroke-width:2.6}
.tm-sc-wave{fill:none;stroke:rgba(255,255,255,.62);stroke-width:2.4;stroke-linecap:round}
.tm-sc-shield{fill:rgba(255,255,255,.045);stroke:#E7E3EF;stroke-width:2.4}
.tm-sc-check{fill:none;stroke:var(--accent);stroke-width:4;stroke-linecap:round;stroke-linejoin:round}
.tm-sc-metric{fill:var(--accent);font-size:21px;font-weight:800;letter-spacing:.02em}
.tm-story-svg text{font-family:ui-monospace,Menlo,Consolas,monospace}
.tm-svg-kicker{fill:#9D97B2;font-size:11px;font-weight:800;letter-spacing:.1em}
.tm-svg-label{fill:#F0EDF6;font-size:12px;font-weight:800;letter-spacing:.03em}
.tm-svg-tiny{fill:#A9A3B8;font-size:8px;font-weight:800;letter-spacing:.04em}
.tm-svg-accent{fill:var(--accent);font-size:11px;font-weight:800;letter-spacing:.04em}
.tm-native-route{fill:none;stroke:var(--accent);stroke-width:3;stroke-linecap:round}
.tm-native-trace{stroke-dasharray:8 7}
`;
