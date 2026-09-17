// Run: npx tsx --test src/pipeline/verify-at-selection.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import {
  isChallengePage,
  isUncapturableHost,
  isUnusable,
  sourceText,
  probeCapturable,
  dropDeadCandidates,
  type SourceVerdict,
} from "./verify-at-selection.js";

const verdict = (over: Partial<SourceVerdict>): SourceVerdict => ({
  url: "https://example.com/a",
  status: 200,
  ok: true,
  dead: false,
  ...over,
});

test("markup is reduced to comparable text", () => {
  const html = "<html><head><style>p{color:red}</style><script>var x=1</script></head>" +
    "<body><h1>Title</h1><p>Body&nbsp;text &amp; more</p></body></html>";
  const text = sourceText(html);
  assert.match(text, /Title Body text & more/);
  assert.ok(!text.includes("var x"), "script contents must not survive");
  assert.ok(!text.includes("color:red"), "style contents must not survive");
});

/**
 * The distinguishing feature is LENGTH, not vocabulary. A genuine article about bot protection uses
 * the same phrases; treating vocabulary alone as the signal would drop real stories.
 */
test("a short interstitial is a challenge page; a long article using the same words is not", () => {
  assert.ok(isChallengePage("Just a moment... Please verify you are a human. Checking your browser."));
  assert.ok(isChallengePage("Client Challenge — enable JavaScript and cookies to continue."));

  const realArticle = (
    "Attention required! researchers published an analysis of how DDoS protection by edge networks " +
    "affects crawlers. "
  ).repeat(60);
  // Guard the premise: without this the "long article" can quietly be short and the test proves nothing.
  assert.ok(realArticle.length > 1800, `fixture must exceed the length threshold, got ${realArticle.length}`);
  assert.ok(!isChallengePage(realArticle), "a long article must not be mistaken for an interstitial");
});

test("uncapturable hosts are operator-configured, and match subdomains", () => {
  const hosts = ["blocked.example"];
  assert.ok(isUncapturableHost("https://blocked.example/article", hosts));
  assert.ok(isUncapturableHost("https://www.blocked.example/article", hosts));
  assert.ok(isUncapturableHost("https://journals.blocked.example/x", hosts));
  assert.ok(!isUncapturableHost("https://notblocked.example/x", hosts));
  assert.ok(!isUncapturableHost("https://blocked.example.evil.test/x", hosts));
});

/** The shipped harness must not carry a previous operator's publisher list. */
test("no host is uncapturable by default", () => {
  assert.ok(!isUncapturableHost("https://nature.com/articles/x"));
  assert.ok(!isUncapturableHost("https://anything.example/x", []));
});

test("a malformed URL is not treated as an uncapturable host", () => {
  assert.ok(!isUncapturableHost("not a url", ["blocked.example"]));
});

/**
 * Bot-blocks are NOT deaths. 401/403/429 mean a publisher refused a non-browser fetch; the article
 * usually exists. Dropping those at selection would discard true stories, which is the more
 * expensive error.
 */
test("only genuinely unusable sources are dropped", () => {
  assert.ok(isUnusable(verdict({ dead: true, ok: false, status: 404 })));
  assert.ok(isUnusable(verdict({ empty: true })));
  assert.ok(isUnusable(verdict({ empty: true, challenged: true })));

  for (const status of [401, 403, 429]) {
    assert.ok(
      !isUnusable(verdict({ status, ok: false })),
      `HTTP ${status} is a bot-block, not a dead source`
    );
  }
  assert.ok(!isUnusable(verdict({})));
});

test("selection probes use bounded public HTTPS, preserve bot blocks and never follow redirects", async (t) => {
  const calls: { url: string; method: string }[] = [];
  const mock = t.mock.method(https, "request", (url: string | URL, options: any, callback: Function) => {
    const target = String(url), path = new URL(target).pathname;
    calls.push({ url: target, method: options.method }); assert.ok(options.signal);
    const request: any = new EventEmitter();
    request.destroy = (error: Error) => { request.emit("error", error); return request; };
    request.end = () => queueMicrotask(() => {
      const status = path === "/head-refused" ? options.method === "HEAD" ? 405 : 200 : Number(path.slice(1)) || 200;
      const response: any = new EventEmitter(); response.statusCode = status;
      response.headers = status === 302 ? { location: "http://127.0.0.1/private" } : {}; response.resume = () => {};
      callback(response);
      if (status >= 300) return;
      queueMicrotask(() => {
        if (options.method !== "HEAD") response.emit("data", path === "/oversize" ? Buffer.alloc(5_000_001) : Buffer.from(path === "/challenge" ? "Just a moment... Checking your browser." : path === "/empty" ? "<script>hidden</script>" : "<article>Verified source material.</article>"));
        response.emit("end");
      });
    });
    return request;
  });
  syncBuiltinESMExports();
  try {
    for (const url of ["http://public.example/story", "https://127.1/private", "https://[::1]/private", "https://169.254.169.254/latest", "https://name.internal/story", "https://user:secret@public.example/story"]) {
      assert.equal(isUnusable(await probeCapturable(url)), true);
      assert.deepEqual(await dropDeadCandidates([{ url }]), []);
    }
    assert.equal(calls.length, 0, "unsafe inputs never reach transport");
    for (const status of [401, 403, 429, 404, 410, 302]) {
      const result = await probeCapturable(`https://public.example/${status}`);
      assert.equal(result.status, status); assert.equal(result.dead, [404, 410, 302].includes(status));
    }
    assert.equal(isUnusable(await probeCapturable("https://public.example/oversize")), true);
    assert.equal((await probeCapturable("https://public.example/challenge")).challenged, true);
    assert.equal((await probeCapturable("https://public.example/empty")).empty, true);
    assert.equal((await probeCapturable("https://public.example/story")).ok, true);
    const candidates = ["/head-refused", "/403", "/404", "/302"].map(path => ({ url: "https://public.example" + path }));
    assert.deepEqual(await dropDeadCandidates(candidates, 1), candidates.slice(0, 2));
    assert.deepEqual(calls.filter(call => call.url.endsWith("/head-refused")).map(call => call.method), ["HEAD", "GET"]);
    assert.ok(calls.every(call => new URL(call.url).hostname === "public.example"), "redirect location is never requested");
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("a judge failure on one candidate drops it and selection continues; two consecutive failures stop with the error", async (t) => {
  const { verifyCandidates } = await import("./verify-at-selection.js");
  const { ClaimVerificationError } = await import("./pin-claims.js");
  const article = "The city announced a transit pilot on Monday. Officials said the route opens in May. ".repeat(12);
  const mock = t.mock.method(https, "request", (url: string | URL, options: any, callback: Function) => {
    const request: any = new EventEmitter(); request.destroy = () => request;
    request.end = () => queueMicrotask(() => {
      const response: any = new EventEmitter(); response.statusCode = 200; response.headers = { "content-type": "text/html" }; response.resume = () => {};
      callback(response);
      queueMicrotask(() => { if (options.method !== "HEAD") response.emit("data", Buffer.from(`<html><body><p>${article}</p></body></html>`)); response.emit("end"); });
    });
    return request;
  });
  syncBuiltinESMExports();
  try {
    const candidates = ["a", "b", "c"].map(k => ({ headline: `Story ${k}`, primaryUrl: `https://public.example/story-${k}` }));
    let calls = 0;
    const flaky = async () => { calls++; if (calls === 1) throw new Error("too many claims — keep the concrete, source-stated ones"); return { claims: ["The city announced a transit pilot."], unsupported: [] }; };
    const result = await verifyCandidates(candidates, { uncapturableHosts: [] } as any, flaky);
    assert.deepEqual(result.kept.map(s => s.headline), ["Story b", "Story c"]);
    assert.equal(result.dropped.length, 1); assert.match(result.dropped[0]!.reason, /claim verification failed/);
    const dead = async () => { throw new Error("did not answer within 300 s"); };
    await assert.rejects(verifyCandidates(candidates, { uncapturableHosts: [] } as any, dead), (error: unknown) => error instanceof ClaimVerificationError);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});
