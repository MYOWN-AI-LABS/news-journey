export type DiagramStyle = "studio" | "handwritten";


export function diagramStyleForDay(day: string): DiagramStyle {
  const seed = [...day.replace(/\D/g, "")].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return seed % 2 === 0 ? "studio" : "handwritten";
}

/**
 * Diagram CSS shared VERBATIM by the newsletter and the Remotion video.
 *
 * It lives here, in one place, for the same reason the style pick does: the project rule is that a
 * story is "drawn identically in both media by construction". Two copies of these rules would drift
 * and silently reintroduce exactly that bug.
 *
 * Selectors are deliberately wrapper-agnostic ([data-diagram-style="handwritten"], not
 * .topic-motion[...]) because the video has no .topic-motion element.
 */


export function withMotionPackets(svg: string): string {
  return svg.replace(
    /<path\b([^>]*\bclass="[^"]*\btm-native-trace\b[^"]*"[^>]*)\s*\/>(?!<circle[^>]*tm-native-packet)/g, // idempotent: skip paths already carrying a packet
    (whole: string, attrs: string) => {
      const d = /\bd="([^"]*)"/.exec(attrs)?.[1];
      if (!d) return whole;
      const delay = /--trace-delay:\s*([\d.]+s)/.exec(attrs)?.[1];
      const escapedD = d.replace(/'/g, "\\'");
      return `${whole}<circle r="4.4" class="tm-native-packet" style="offset-path:path('${escapedD}')${delay ? `;animation-delay:${delay}` : ""}"/>`;
    },
  );
}


export const PORTRAIT_FONT_PX = {
  kicker: 52,
  label: 52,
  tiny: 52,
  accent: 52,
  metric: 56,
} as const;

const PORTRAIT_TYPE_CSS = [
  `.tm-story-svg.tm-svg-portrait .tm-svg-kicker{font-size:${PORTRAIT_FONT_PX.kicker}px}`,
  `.tm-story-svg.tm-svg-portrait .tm-svg-label{font-size:${PORTRAIT_FONT_PX.label}px;letter-spacing:.02em}`,
  `.tm-story-svg.tm-svg-portrait .tm-svg-tiny{font-size:${PORTRAIT_FONT_PX.tiny}px}`,
  `.tm-story-svg.tm-svg-portrait .tm-svg-accent,.tm-story-svg.tm-svg-portrait .tm-svg-warn,.tm-story-svg.tm-svg-portrait .tm-svg-danger{font-size:${PORTRAIT_FONT_PX.accent}px}`,
  `.tm-story-svg.tm-svg-portrait .tm-sc-metric{font-size:${PORTRAIT_FONT_PX.metric}px}`,
  `[data-diagram-style="handwritten"] .tm-story-svg.tm-svg-portrait .tm-svg-kicker{font-size:${PORTRAIT_FONT_PX.kicker}px}`,
  `[data-diagram-style="handwritten"] .tm-story-svg.tm-svg-portrait .tm-svg-label{font-size:${PORTRAIT_FONT_PX.label}px}`,
  `[data-diagram-style="handwritten"] .tm-story-svg.tm-svg-portrait .tm-svg-tiny{font-size:${PORTRAIT_FONT_PX.tiny}px}`,
].join("\n");

function buildStepChoreoCss(): string {
  const r: string[] = [
    ".tm-story-svg [data-step]{transition:opacity .45s ease}",
    "[data-tm-frozen] .tm-story-svg [data-step]{transition:none}",
    "[data-tm-active] .tm-story-svg [data-step]{opacity:.12}",
    "[data-tm-active] .tm-story-svg [data-step] .tm-native-trace{animation-play-state:paused;animation-delay:0s!important}",
    "[data-tm-active] .tm-story-svg [data-step] .tm-native-packet{opacity:0!important;animation-play-state:paused;animation-delay:0s!important}",
    "[data-tm-active=\"hold\"] .tm-story-svg [data-step]{opacity:1}",
  ];
  for (let a = 1; a <= 4; a++) {
    r.push(`[data-tm-active="${a}"] .tm-story-svg [data-step="${a}"]{opacity:1}`);
    r.push(`[data-tm-active="${a}"] .tm-story-svg [data-step="${a}"] .tm-native-trace{animation-play-state:running;animation-delay:0s}`);
    r.push(`[data-tm-frozen][data-tm-active="${a}"] .tm-story-svg [data-step="${a}"] .tm-native-trace{animation-play-state:paused;animation-delay:var(--tm-clock,0s)!important}`);
    r.push(`[data-tm-active="${a}"] .tm-story-svg [data-step="${a}"] .tm-native-packet{opacity:1!important;animation-play-state:running;animation-delay:0s!important}`);
    r.push(`[data-tm-frozen][data-tm-active="${a}"] .tm-story-svg [data-step="${a}"] .tm-native-packet{animation-play-state:paused;animation-delay:var(--tm-clock,0s)!important}`);
    for (let k = 1; k < a; k++) r.push(`[data-tm-active="${a}"] .tm-story-svg [data-step="${k}"]{opacity:.6}`);
  }
  r.push("@media (prefers-reduced-motion:reduce){[data-tm-active] .tm-story-svg [data-step]{opacity:1!important}}");
  return r.join("\n");
}
/** Read-in-order choreography rules (proposal G); part of DIAGRAM_CSS so every surface carries them. */
export const STEP_CHOREO_CSS = buildStepChoreoCss();

export const DIAGRAM_CSS = `/* tm-svg-danger/warn/accent are authored onto rect/line/polygon as well as text, but the rules
   above are TEXT rules: a fill on a line paints nothing, and a SOLID danger fill under the light
   tm-svg-label gave "FEATURES REMOVED" ~1.9:1 contrast. Element-type selectors split the two so a
   shape gets a translucent panel + stroke and the label on top stays readable. */
/* BLACK-TEXT FLOOR. SVG text with no fill rule paints BLACK, which is invisible on this stage.
   .tm-svg-warn/.tm-svg-danger text colours were declared ONLY in newsletter-html.ts, but the video
   mounts SCHEMATIC_CSS + DIAGRAM_CSS and neither carried them — so warn captions read orange in the
   newsletter and black in the video ("STATUS: ANNOUNCED · LIMITED PREVIEW", "CONTEXT DESTINATION NOT
   STATED"). :where() gives the floor ZERO specificity, so every existing class rule still wins; it
   only catches text no rule reached. Declare new text colours HERE, never in one renderer's sheet. */
:where(.tm-story-svg) text{fill:#DCD8E8}
text.tm-svg-warn{fill:#FFB45C}
text.tm-svg-danger{fill:#FF8C98}
rect.tm-svg-danger{fill:rgba(255,140,152,.20);stroke:#FF8C98;stroke-width:2.2}
rect.tm-svg-warn{fill:rgba(255,180,92,.20);stroke:#FFB45C;stroke-width:2.2}
line.tm-svg-danger{stroke:#FF8C98;stroke-width:2.6;stroke-linecap:round}
line.tm-svg-warn{stroke:#FFB45C;stroke-width:2.6;stroke-linecap:round}
line.tm-svg-accent{stroke:var(--accent);stroke-width:2.6;stroke-linecap:round}
path.tm-svg-danger{fill:none;stroke:#FF8C98;stroke-width:2.6}
polygon.tm-svg-danger{fill:#FF8C98}polygon.tm-svg-warn{fill:#FFB45C}polygon.tm-svg-accent{fill:var(--accent)}

rect.tm-svg-accent{fill:rgba(var(--accentRgb),.20);stroke:var(--accent);stroke-width:2.2}
/* An SVG <path> defaults to fill:BLACK. These are stroke-only traces, but only tm-native-route
   declared fill:none. A straight trace encloses no area so it never showed; the moment a diagram
   authored a curved or multi-segment one it filled solid — the black slab and green semicircle that
   covered the Copilot row. Declare it for every path class that is a line, not a region. */
path.tm-native-trace,path.tm-native-route,path.tm-svg-accent,path.tm-svg-warn{fill:none}
path.tm-svg-accent{stroke:var(--accent);stroke-width:2.6;stroke-linecap:round}
path.tm-svg-warn{stroke:#FFB45C;stroke-width:2.6;stroke-linecap:round}
/* A SOLID accent node left the light label and the grey tm-svg-tiny sitting on bright colour, which
   is where the unreadable sub-labels came from. Translucent like .tm-sc-core, so the same light text
   keeps its contrast. Scoped to the element so the handwritten theme's own .tm-sc-node fill (higher
   specificity, dark text on yellow) is untouched. */
rect.tm-sc-node{fill:rgba(var(--accentRgb),.22);stroke:var(--accent);stroke-width:1.6}

rect.tm-sc-metric{fill:rgba(var(--accentRgb),.20);stroke:var(--accent);stroke-width:2.2}

@keyframes tm-native-flow{to{stroke-dashoffset:-48}}
@keyframes tm-native-pulse{0%,100%{opacity:.5;transform:scale(.9)}48%,70%{opacity:1;transform:scale(1)}}
@keyframes tm-native-draw{0%{stroke-dashoffset:1;opacity:.4}55%,82%{stroke-dashoffset:0;opacity:1}100%{stroke-dashoffset:0;opacity:.45}}
.tm-native-trace{fill:none;stroke:var(--accent);stroke-width:3;stroke-linecap:round;stroke-dasharray:8 7;animation:tm-native-flow 2.4s linear infinite}
.tm-native-packet{fill:var(--accent);offset-rotate:0deg;filter:drop-shadow(0 0 3px rgba(var(--accentRgb),.85));animation:tm-native-packet 2.4s linear infinite}
@keyframes tm-native-packet{0%,4%{offset-distance:0%;opacity:0}10%{opacity:1}90%{opacity:1}96%,100%{offset-distance:100%;opacity:0}}
@supports not (offset-path: path("M0 0")){.tm-native-packet{display:none}}
.tm-sc-core-dot,.tm-sc-check{transform-box:fill-box;transform-origin:center;animation:tm-native-pulse 2s ease-in-out infinite}
polygon.tm-svg-accent{transform-box:fill-box;transform-origin:center;animation:tm-native-pulse 2.2s ease-in-out infinite}

/* FROZEN CLOCK — the rule that makes the above work in a frame-by-frame renderer at all.
   Remotion does not play animations; it SEEKS to a frame and screenshots. A CSS animation therefore
   sits at time 0 in every frame of the output, so the connectors would still be dead in the video
   even with the keyframes above present. Pausing the animation and driving its delay from the frame
   clock makes the browser paint the exact moment we ask for, which is also why narration sync comes
   free: the frame clock IS the audio clock. The host sets --tm-clock to -(frame/fps)s. */
[data-tm-frozen] .tm-story-svg *{animation-play-state:paused;animation-delay:var(--tm-clock,0s)}

/* ---- HANDWRITTEN theme: notebook stage inside the dark card. One style per ISSUE. ---- */
[data-diagram-style="handwritten"] .tm-stage{background:#F6F1E3;background-image:linear-gradient(#D9CFB6 1px,transparent 1px);background-size:100% 30px;border-radius:12px}
[data-diagram-style="handwritten"] .tm-orbit-hint{color:#6B6350}
/* Rough the SHAPES only. Filtering the whole <svg> also displaced every glyph, which is what made
   small labels like "FEATURES REMOVED" hard to read. Text stays crisp; the hand-drawn feel comes
   entirely from the strokes. A child cannot opt out of a parent filter, so it must go on here. */
[data-diagram-style="handwritten"] .tm-story-svg :is(rect,circle,polygon,polyline,path,line){filter:url(#tm-rough)}
/* Strike-through marks sit UNDER the label they cross out — full-strength they shredded it. */
[data-diagram-style="handwritten"] line.tm-svg-danger,line.tm-svg-danger{stroke-opacity:.45}
[data-diagram-style="handwritten"] .tm-story-svg text{font-family:"Kalam","Caveat","Bradley Hand","Segoe Print",cursive;letter-spacing:.01em}

[data-diagram-style="handwritten"] .tm-svg-kicker{fill:#5B4E35;font-size:14px;font-weight:700;letter-spacing:.02em}
[data-diagram-style="handwritten"] .tm-svg-label{fill:#1F2430;font-size:15px;font-weight:700}
[data-diagram-style="handwritten"] .tm-svg-tiny{fill:#4F4634;font-size:11px;font-weight:400}
[data-diagram-style="handwritten"] [class*="tm-sc-"]{fill:none;stroke:#1F2430;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
[data-diagram-style="handwritten"] text.tm-sc-metric{fill:#1F2430;stroke:none}
[data-diagram-style="handwritten"] .tm-sc-core,[data-diagram-style="handwritten"] .tm-sc-node,[data-diagram-style="handwritten"] .tm-sc-core-dot,[data-diagram-style="handwritten"] .tm-sc-chip,[data-diagram-style="handwritten"] .tm-sc-head{fill:#FCD34D;stroke:#1F2430;stroke-width:2}
[data-diagram-style="handwritten"] .tm-sc-apparatus,[data-diagram-style="handwritten"] .tm-sc-apparatus-round,[data-diagram-style="handwritten"] .tm-sc-layer{fill:rgba(252,211,77,.35);stroke:#1F2430;stroke-width:2.6}
[data-diagram-style="handwritten"] .tm-sc-check{fill:none;stroke:#15803D;stroke-width:5;stroke-linecap:round}
[data-diagram-style="handwritten"] .tm-native-route,[data-diagram-style="handwritten"] .tm-native-trace{fill:none;stroke:#1F2430;stroke-width:2.6;stroke-linecap:round;filter:url(#tm-rough2)}
[data-diagram-style="handwritten"] .tm-native-trace{stroke-dasharray:9 8}
[data-diagram-style="handwritten"] text.tm-svg-accent{fill:#9A3412}
[data-diagram-style="handwritten"] text.tm-svg-warn{fill:#92400E}
[data-diagram-style="handwritten"] text.tm-svg-danger{fill:#991B1B}
[data-diagram-style="handwritten"] rect.tm-svg-danger{fill:rgba(248,113,113,.28);stroke:#B91C1C;stroke-width:2.4}
[data-diagram-style="handwritten"] rect.tm-svg-warn{fill:rgba(251,191,36,.32);stroke:#B45309;stroke-width:2.4}
[data-diagram-style="handwritten"] line.tm-svg-danger{stroke:#B91C1C}
[data-diagram-style="handwritten"] line.tm-svg-warn{stroke:#B45309}
[data-diagram-style="handwritten"] line.tm-svg-accent{stroke:#C2410C}
[data-diagram-style="handwritten"] path.tm-svg-danger{fill:none;stroke:#B91C1C}
[data-diagram-style="handwritten"] polygon.tm-svg-danger{fill:#B91C1C}
[data-diagram-style="handwritten"] polygon.tm-svg-warn{fill:#B45309}
[data-diagram-style="handwritten"] polygon.tm-svg-accent{fill:#C2410C}


${PORTRAIT_TYPE_CSS}
[data-diagram-style="handwritten"] .tm-story-svg.tm-svg-portrait text{font-family:Arial,Helvetica,sans-serif;letter-spacing:0}

/* ================= READ-IN-ORDER CHOREOGRAPHY (proposal G) =================
   The host marks the diagram's wrapper with data-tm-active="1".."4" while a step is being read,
   or "hold" once the pass is complete. Unread steps wait dimmed, the active step is full, read
   steps settle; only the active step's connector marches and carries the packet. Without the
   attribute nothing changes, so every legacy landscape drawing keeps its ambient loops. Under the
   frozen clock (video, GIF) the active connector still seeks via --tm-clock; inactive ones are
   pinned to t=0 by the !important delay. Reduced-motion users get the finished drawing. */
${STEP_CHOREO_CSS}`;


export function diagramCanvas(svg: string): "portrait" | "landscape" {
  return /viewBox="0 0 720 1000"/.test(svg) ? "portrait" : "landscape";
}

/** Reading steps authored as <g data-step="k">; 0 for a landscape or stencil drawing. */
export function diagramStepCount(svg: string): number {
  const ks = [...svg.matchAll(/data-step="(\d+)"/g)].map((m) => Number(m[1]));
  return ks.length ? Math.max(...ks) : 0;
}

/** The active step for a moment `t` (seconds) inside a pass of `passSeconds`; "hold" afterwards. */
export function stepAt(t: number, steps: number, passSeconds: number): number | "hold" {
  if (!steps) return "hold";
  if (t >= passSeconds) return "hold";
  return Math.min(steps, Math.floor((t / passSeconds) * steps) + 1);
}


/**
 * Roughening filters for the handwritten style. MUST be present in any document that renders a
 * handwritten stage: a filter:url() pointing at a missing id makes the referencing element vanish
 * entirely in Chrome/Safari (and therefore in Remotion), rather than rendering unfiltered.
 */
export const ROUGH_FILTER_DEFS = `<svg width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute"><defs>
<filter id="tm-rough"><feTurbulence type="fractalNoise" baseFrequency="0.022" numOctaves="3" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="3.2" xChannelSelector="R" yChannelSelector="G"/></filter>
<filter id="tm-rough2"><feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="19" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2.2" xChannelSelector="R" yChannelSelector="G"/></filter>
</defs></svg>`;
