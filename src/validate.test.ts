import assert from "node:assert/strict";
import test, { mock } from "node:test";
import https from "node:https";
import dns from "node:dns";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { checkUrl } from "./validate.js";
import { publicResponse } from "./sources/public-apis.js";

test("cited URL checks refuse unsafe destinations before transport and retain bounded HEAD/GET fallback", async () => {
  const methods: string[] = [];
  const request: typeof publicResponse = async (_url, _headers, timeout, maxBytes, method) => {
    assert.equal(timeout, 12_000); assert.equal(maxBytes, 5_000_000); methods.push(method!);
    if (method === "HEAD") throw new Error("Public API HTTP 405; redirects are not followed");
    return new Response("Article", { status: 200 });
  };
  for (const url of ["http://public.example/story", "https://127.1/private", "https://169.254.169.254/latest", "https://[::1]/private", "https://host.internal/story", "https://user:pass@public.example/story", "file:///secret"]) {
    assert.equal((await checkUrl(url, "fixture", request)).ok, false);
  }
  assert.deepEqual(methods, []);
  assert.equal((await checkUrl("https://public.example/story", "fixture", request)).ok, true);
  assert.deepEqual(methods, ["HEAD", "GET"]);
  for (const status of [401, 403, 429, 404, 410]) {
    const result = await checkUrl("https://public.example/story", "fixture", async () => { throw new Error(`Public API HTTP ${status}; redirects are not followed`); });
    assert.equal(result.ok, [401, 403, 429].includes(status)); assert.equal(result.status, status);
  }
});

test("public transport pins each connection's DNS, refuses redirects and bounds GET bytes without network access", async () => {
  let addresses = [{ address: "93.184.216.34", family: 4 }], status = 200, body = Buffer.from("article"), requests = 0;
  const methods: string[] = [], connected: string[][] = [];
  const dnsMock = mock.method(dns, "lookup", (_host: string, _options: unknown, callback: Function) => callback(null, addresses));
  const requestMock = mock.method(https, "request", (url: string, options: any, callback: Function) => {
    requests++; methods.push(options.method); assert.ok(options.signal);
    const req: any = new EventEmitter();
    req.destroy = (error: Error) => { req.emit("error", error); return req; };
    req.end = () => queueMicrotask(() => options.lookup(new URL(url).hostname, { all: true }, (error: Error | null, selected: { address: string }[]) => {
      if (error) { req.emit("error", error); return; }
      connected.push(selected.map(a => a.address));
      const response: any = new EventEmitter(); response.statusCode = status; response.headers = status === 302 ? { location: "http://127.0.0.1/private" } : {}; response.resume = () => {};
      callback(response);
      if (status >= 300) return;
      queueMicrotask(() => { if (options.method !== "HEAD") response.emit("data", body); response.emit("end"); });
    }));
    return req;
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await checkUrl("https://public.example/story", "fixture")).ok, true);
    assert.deepEqual(methods, ["HEAD"]); assert.deepEqual(connected, [["93.184.216.34"]]);
    addresses = [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }];
    const blocked = await checkUrl("https://public.example/story", "fixture");
    assert.equal(blocked.ok, false); assert.match(String(blocked.status), /private or local/); assert.equal(connected.length, 1);
    addresses = [{ address: "93.184.216.34", family: 4 }]; status = 302;
    const before = requests;
    const redirected = await checkUrl("https://public.example/story", "fixture");
    assert.equal(redirected.ok, false); assert.equal(redirected.status, 302); assert.equal(requests - before, 2, "bounded HEAD/GET only; redirect destination never requested");
    status = 200; body = Buffer.alloc(17);
    await assert.rejects(publicResponse("https://public.example/story", {}, 1000, 16), /exceeds 16 bytes/);
  } finally { requestMock.mock.restore(); dnsMock.mock.restore(); syncBuiltinESMExports(); }
});
