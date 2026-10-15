import assert from "node:assert/strict";
import test from "node:test";
import { fallbackSanitize, sanitizeSvg } from "./sanitize-svg.js";
import { withMotionPackets } from "./diagram-style.js";

const evil = `<svg class="tm-story-svg" onload="alert(1)"><script>fetch('//x')</script><foreignObject><div>x</div></foreignObject><a href="javascript:alert(1)"><path d="M0 0 H10" class="tm-native-trace" onclick="steal()"/></a><rect style="fill:url(https://evil.example/x)" filter="url(#rough)"/><image href="https://evil.example/p.png"/></svg>`;

test("dangerous SVG constructs are removed", () => {
  for (const out of [sanitizeSvg(evil), fallbackSanitize(evil)]) {
    assert.ok(!/<script/i.test(out), "script");
    assert.ok(!/foreignObject/i.test(out), "foreignObject");
    assert.ok(!/\son[a-z]+=/i.test(out), "event handlers");
    assert.ok(!/javascript:/i.test(out), "javascript: url");
    assert.ok(!/evil\.example/.test(out), "external refs");
    assert.ok(out.includes('filter="url(#rough)"'), "local filter refs kept");
  }
});

test("benign diagram markup and motion packets survive sanitizing", () => {
  const svg = `<svg class="tm-story-svg"><path d="M218 164 H286" class="tm-native-route tm-native-trace" style="--trace-delay: 0.4s"/></svg>`;
  const out = sanitizeSvg(withMotionPackets(svg));
  assert.ok(out.includes('class="tm-native-route tm-native-trace"'));
  assert.equal((out.match(/tm-native-packet/g) ?? []).length, 1);
  assert.ok(out.includes("offset-path:path('M218 164 H286')"));
});
