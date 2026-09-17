import assert from "node:assert/strict";
import test from "node:test";
import { withMotionPackets, DIAGRAM_CSS } from "./diagram-style.js";

const traced = `<svg class="tm-story-svg"><path d="M218 164 H286" class="tm-native-route tm-native-trace"/><path d="M556 164 H600" class="tm-native-route" style="opacity:.4"/></svg>`;

test("one packet is added per traced connector, riding the same path", () => {
  const out = withMotionPackets(traced);
  assert.equal((out.match(/<circle[^>]*tm-native-packet/g) ?? []).length, 1);
  assert.ok(out.includes(`offset-path:path('M218 164 H286')`));
  assert.ok(out.includes(`<path d="M218 164 H286" class="tm-native-route tm-native-trace"/>`), "original path preserved verbatim");
});

test("untraced paths get no packet and the transform is idempotent", () => {
  assert.equal((withMotionPackets(`<svg><path d="M0 0 L1 1" class="tm-native-route"/></svg>`).match(/tm-native-packet/g) ?? []).length, 0);
  const once = withMotionPackets(traced);
  assert.equal((withMotionPackets(once).match(/tm-native-packet/g) ?? []).length, (once.match(/tm-native-packet/g) ?? []).length);
});

test("an authored --trace-delay is carried onto the packet", () => {
  assert.ok(withMotionPackets(`<path d="M0 0 L10 10" class="tm-native-trace" style="--trace-delay:.3s"/>`).includes("animation-delay:.3s"));
});

test("the shared stylesheet animates the packet and hides it where offset-path is unsupported", () => {
  assert.match(DIAGRAM_CSS, /\.tm-native-packet\{[^}]*animation:tm-native-packet/);
  assert.match(DIAGRAM_CSS, /@supports not \(offset-path: path\("M0 0"\)\)\{\.tm-native-packet\{display:none\}\}/);
});
