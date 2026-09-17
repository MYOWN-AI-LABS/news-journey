/**
 * Neutral sample diagram for the `Diagram3D` preview composition. NOT used by the pipeline.
 *
 * It exists so `npm run studio` can open the 3D diagram scene without first running a full edition,
 * and so the class vocabulary in `src/pipeline/story-diagram.ts` has a worked reference. It is
 * deliberately about a fictional mechanism: nothing here comes from a real story.
 *
 * It exercises the parts the renderer actually depends on — a kicker, a status chip, source/apparatus/
 * result columns, an animated `tm-native-trace` connector, a metric bar, and a `tm-svg-warn` branch —
 * so a regression in any of those shows up in the preview.
 */
export const SAMPLE_DIAGRAM_SVG =
  '<svg class="tm-story-svg tm-svg-authored" data-visual-primitive="authored-1" viewBox="0 0 720 340" role="img" aria-labelledby="tm-visual-1">' +
  '<title id="tm-visual-1">A sample mechanism: two sources are merged, checked, and emitted as one verified result.</title>' +
  '<text class="tm-svg-kicker" x="24" y="28" font-family="sans-serif" font-size="12" font-weight="600" letter-spacing="1.6">EXAMPLE MECHANISM</text>' +
  '<rect class="tm-sc-chip" x="628" y="12" width="68" height="24" rx="4"/>' +
  '<text class="tm-svg-tiny" x="662" y="28" font-family="sans-serif" font-size="8" font-weight="600" text-anchor="middle" letter-spacing="1" textLength="52" lengthAdjust="spacingAndGlyphs">SAMPLE</text>' +
  '<line x1="24" y1="44" x2="696" y2="44" stroke-width="1"/>' +
  '<text class="tm-svg-kicker" x="24" y="62" font-family="sans-serif" font-size="8" font-weight="600" letter-spacing="1.2">TWO SOURCES IN, ONE VERIFIED RESULT OUT</text>' +
  '<rect class="tm-sc-bank" x="24" y="80" width="160" height="104" rx="8"/>' +
  '<text class="tm-svg-label" x="40" y="102" font-family="sans-serif" font-size="8" font-weight="600" letter-spacing="0.8" textLength="128" lengthAdjust="spacingAndGlyphs">SOURCE INPUTS</text>' +
  '<rect class="tm-sc-chip" x="40" y="114" width="128" height="22" rx="4"/>' +
  '<text class="tm-svg-tiny" x="104" y="129" font-family="sans-serif" font-size="8" font-weight="600" text-anchor="middle">FEED A</text>' +
  '<rect class="tm-sc-chip" x="40" y="146" width="128" height="22" rx="4"/>' +
  '<text class="tm-svg-tiny" x="104" y="161" font-family="sans-serif" font-size="8" font-weight="600" text-anchor="middle">FEED B</text>' +
  '<path class="tm-native-route tm-native-trace tm-svg-accent" d="M184 132 H228" fill="none" stroke-width="2"/>' +
  '<polygon class="tm-svg-accent" points="220,128 228,132 220,136"/>' +
  '<text class="tm-svg-tiny tm-svg-accent" x="206" y="120" font-family="sans-serif" font-size="8" font-weight="600" text-anchor="middle" textLength="30" lengthAdjust="spacingAndGlyphs">MERGE</text>' +
  '<rect class="tm-sc-core tm-svg-accent" x="228" y="88" width="184" height="96" rx="8" stroke-width="2"/>' +
  '<circle class="tm-sc-core-dot tm-svg-accent" cx="252" cy="112" r="8"/>' +
  '<text class="tm-svg-label" x="272" y="116" font-family="sans-serif" font-size="12" font-weight="600">CHECK STAGE</text>' +
  '<rect class="tm-sc-pins" x="244" y="140" width="152" height="28" rx="4"/>' +
  '<text class="tm-svg-tiny" x="320" y="158" font-family="sans-serif" font-size="8" font-weight="600" text-anchor="middle">CORROBORATION REQUIRED</text>' +
  '<path class="tm-native-route tm-native-trace" d="M412 120 H524" fill="none" stroke-width="2"/>' +
  '<polygon class="tm-native-route" points="516,116 524,120 516,124"/>' +
  '<text class="tm-svg-tiny" x="468" y="108" font-family="sans-serif" font-size="8" font-weight="600" text-anchor="middle">PASS</text>' +
  '<rect class="tm-sc-check" x="524" y="100" width="152" height="40" rx="8"/>' +
  '<text class="tm-svg-label" x="600" y="125" font-family="sans-serif" font-size="12" font-weight="600" text-anchor="middle">VERIFIED OUT</text>' +
  '<line x1="24" y1="204" x2="696" y2="204" stroke-width="1"/>' +
  '<text class="tm-svg-kicker" x="24" y="224" font-family="sans-serif" font-size="8" font-weight="600" letter-spacing="1.2">FAILURE BRANCH AND MEASURE</text>' +
  '<path class="tm-native-route tm-native-trace tm-svg-warn" d="M320 184 V252 H396" fill="none" stroke-width="2"/>' +
  '<polygon class="tm-svg-warn" points="388,248 396,252 388,256"/>' +
  '<rect class="tm-svg-warn" x="396" y="232" width="180" height="40" rx="8"/>' +
  '<text class="tm-svg-label tm-svg-warn" x="486" y="257" font-family="sans-serif" font-size="12" font-weight="600" text-anchor="middle" textLength="160" lengthAdjust="spacingAndGlyphs">HELD, NOT PUBLISHED</text>' +
  '<rect class="tm-sc-metric" x="24" y="232" width="180" height="56" rx="8"/>' +
  '<text class="tm-svg-label" x="114" y="256" font-family="sans-serif" font-size="12" font-weight="600" text-anchor="middle">2 OF 2</text>' +
  '<text class="tm-svg-tiny" x="114" y="274" font-family="sans-serif" font-size="8" font-weight="600" text-anchor="middle" textLength="150" lengthAdjust="spacingAndGlyphs">SOURCES REQUIRED TO EMIT</text>' +
  "</svg>";

export const SAMPLE_ACCENT = "#7C5CFF";
