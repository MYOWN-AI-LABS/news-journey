import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activatePro, proState, verifyLicense } from "./pro.js";

/** Free is complete; Pro is a signed, workspace-bound key pasted once. Every failure has a plain reason. */
test("a Pro key activates only for its workspace, unexpired, signed by the installed issuer", () => {
  const code = mkdtempSync(join(tmpdir(), "pro-code-")), root = mkdtempSync(join(tmpdir(), "pro-ws-"));
  try {
    mkdirSync(join(code, "config")); mkdirSync(join(root, "state")); mkdirSync(join(root, "config"));
    writeFileSync(join(root, "workspace.json"), JSON.stringify({ id: "civic-signal" }));
    const free = proState(root, code);
    assert.equal(free.active, false); assert.equal(free.plan, "free"); assert.equal(free.price, "$99/month"); assert.equal(free.checkoutUrl, ""); assert.ok(free.features.length >= 5);
    assert.throws(() => activatePro(root, "not json", code), /not a Pro key/);
    const pair = generateKeyPairSync("ed25519");
    const issue = (subject: string, expiresAt: number) => { const payload = { version: 1, issuer: "myownai-labs", subject, plan: "pro", packs: ["executive-briefing"], issuedAt: Date.now() - 1000, expiresAt }; return JSON.stringify({ payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), createPrivateKey(pair.privateKey.export({ type: "pkcs8", format: "pem" }))).toString("base64") }); };
    assert.throws(() => activatePro(root, issue("civic-signal", Date.now() + 86400000), code), /no Pro issuer key/);
    writeFileSync(join(code, "config/pro-issuer.json"), JSON.stringify({ publicKey: pair.publicKey.export({ type: "spki", format: "pem" }) }));
    assert.throws(() => activatePro(root, issue("other-workspace", Date.now() + 86400000), code), /another workspace/);
    assert.throws(() => activatePro(root, issue("civic-signal", Date.now() - 1), code), /expired/);
    const forged = JSON.parse(issue("civic-signal", Date.now() + 86400000)); forged.payload.packs = ["executive-briefing", "audience-engagement"];
    assert.throws(() => activatePro(root, JSON.stringify(forged), code), /signature/);
    const payload = activatePro(root, issue("civic-signal", Date.now() + 86400000), code);
    assert.equal(payload.plan, "pro");
    const pro = proState(root, code);
    assert.equal(pro.active, true); assert.equal(pro.plan, "pro"); assert.deepEqual(pro.packs, ["executive-briefing"]);
    assert.equal(verifyLicense({ nonsense: true }, "civic-signal", code).reason?.includes("not a Pro key"), true);
    writeFileSync(join(code, "config/commerce.json"), JSON.stringify({ checkoutUrl: "http://insecure.example/checkout", portalUrl: "https://billing.example.org/p", price: "$99/month" }));
    const c = proState(root, code); assert.equal(c.checkoutUrl, "", "only https checkout links are shown"); assert.equal(c.portalUrl, "https://billing.example.org/p");
  } finally { rmSync(code, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});
