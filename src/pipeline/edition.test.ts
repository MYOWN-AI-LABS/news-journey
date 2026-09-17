import assert from "node:assert/strict";
import test from "node:test";
import { loadEdition, resolveTitle } from "./edition.js";
import { isLiveArticleTitle } from "./newsletter-live.js";

test("edition registry resolves committed fictional editions", () => {
  assert.equal(loadEdition(undefined).editionId, "daily-roundup");
  assert.equal(loadEdition("example-topic").editionId, "example-topic");
});

test("edition registry rejects unknown IDs", () => {
  assert.throws(() => loadEdition("unknown-edition"), /not found/);
});

// Regression: a starter publication name alone cannot pass the exact-subject live gate.
test("generated and cached article titles retain the exact reviewed issue subject", () => {
  const subject = "A new robot learns faster from demonstrations";
  const edition = { ...loadEdition(undefined), newsletterTitle: "Example Signal {n}" };
  const title = resolveTitle(edition, subject, 3);
  assert.equal(title, `Example Signal 3 — ${subject}`);
  assert.equal(isLiveArticleTitle(title, subject), true);
  assert.equal(isLiveArticleTitle(title, "Another issue about robot hardware"), false);
  assert.equal(resolveTitle({ ...edition, newsletterTitle: title }, subject), title);
  assert.equal(isLiveArticleTitle(resolveTitle({ ...edition, newsletterTitle: "Example Signal" }, subject), subject), true);
});
