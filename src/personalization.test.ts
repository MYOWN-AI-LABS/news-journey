import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EMPTY_PERSONALIZATION, NEWSLETTER_PRESETS, brandTheme, customNewsletterShell, newsletterShell, formatChoices, logoDataUri, newsletterLengthGuidance, nextPublicationDates, readPersonalization, savePersonalization, styleBrief, videoWordBudget, workspaceTheme } from "./personalization.js";
import { writeFileSync } from "node:fs";
import { fillShell, renderNewsletterHtml } from "./pipeline/newsletter-html.js";

/**
 * Two fictional workspaces with different logos and styles must render visibly different packages
 * with no cross-workspace asset reuse and no MyOwnAI identity — the plan's Day 2 acceptance evidence.
 */
test("two workspaces render different identities and never share a logo or carry the MyOwnAI mark", () => {
  const roots = [mkdtempSync(join(tmpdir(), "brand-a-")), mkdtempSync(join(tmpdir(), "brand-b-"))];
  try {
    const logos = [1, 2].map(n => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16, n)]).toString("base64"));
    for (const [i, root] of roots.entries()) { mkdirSync(join(root, "config")); savePersonalization(root, { logo: logos[i], styleDirection: i ? "high-energy-product" : "boardroom-concise" }, false); }
    const issue = { subject: "Evidence update", lead: { title: "Study design", body: "Sourced findings", sourceName: "Study", sourceUrl: "https://news.example.org/study" }, items: [{ name: "Decision", url: "https://news.example.org/study", line: "An implication" }], radar: [], signals: [] };
    const html = roots.map((root, i) => renderNewsletterHtml({ publisher: { name: "Owner", publication: i ? "Launch Pulse" : "Board Brief", audience: "Leaders", tone: "Clear" }, issue, issueNo: 1, date: "2026-09-09", dateLong: "September 9, 2026", video: null, coveredWeek: [], logoDataUri: logoDataUri(root), styleDirection: readPersonalization(root).styleDirection } as never));
    const uris = roots.map(logoDataUri);
    assert.notEqual(uris[0], uris[1]);
    assert.match(html[0], /<body data-style="boardroom-concise">/); assert.match(html[1], /<body data-style="high-energy-product">/);
    assert.ok(html[0].includes(`src="${uris[0]}"`) && !html[0].includes(uris[1]!), "workspace A shows only its own logo");
    assert.ok(html[1].includes(`src="${uris[1]}"`) && !html[1].includes(uris[0]!), "workspace B shows only its own logo");
    for (const page of html) assert.doesNotMatch(page, /myownai|daily signal/i);
    assert.match(styleBrief(readPersonalization(roots[0]!)), /Boardroom concise/);
    assert.equal(styleBrief(EMPTY_PERSONALIZATION), "");
    assert.doesNotMatch(renderNewsletterHtml({ publisher: { name: "Owner", publication: "Plain", audience: "Leaders", tone: "Clear" }, issue, issueNo: 1, date: "2026-09-09", dateLong: "September 9, 2026", video: null, coveredWeek: [], logoDataUri: null, styleDirection: "" } as never), /brand-logo|data-style/, "no logo means the neutral text mark, no data-style");
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16, 1)]).toString("base64");

test('newsletter images default on, retain explicit text-only across unrelated saves and reject ambiguous values', () => {
  const root = mkdtempSync(join(tmpdir(), 'newsletter-images-'));
  try {
    mkdirSync(join(root, 'config'));
    assert.equal(readPersonalization(root).newsletterImages, true);
    writeFileSync(join(root, 'config/personalization.json'), JSON.stringify({ newsletterLength: 'deep', styleNotes: 'Keep selected design', newsletterImages: false }));
    assert.equal(readPersonalization(root).newsletterImages, false);
    const saved = savePersonalization(root, { cadence: 'weekly', applyRecommendations: true }, false);
    assert.equal(saved.newsletterImages, false); assert.equal(saved.newsletterLength, 'deep'); assert.equal(saved.styleNotes, 'Keep selected design');
    for (const value of ['false', 'true', 0, 1, null]) assert.throws(() => savePersonalization(root, { newsletterImages: value }, false), /explicit on\/off/);
    assert.equal(readPersonalization(root).newsletterImages, false);
    assert.equal(savePersonalization(root, { newsletterImages: true }, false).newsletterImages, true);
    assert.equal(readPersonalization(root).newsletterImages, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("video length maps to a spoken-word budget and custom seconds scale it", () => {
  assert.equal(videoWordBudget(EMPTY_PERSONALIZATION), null, "no choice keeps the edition/pipeline default");
  assert.deepEqual(videoWordBudget({ ...EMPTY_PERSONALIZATION, videoLength: "standard" }), { min: 150, max: 225 });
  assert.deepEqual(videoWordBudget({ ...EMPTY_PERSONALIZATION, videoLength: "short" }), { min: 75, max: 110 });
  assert.deepEqual(videoWordBudget({ ...EMPTY_PERSONALIZATION, videoLength: "custom", videoSeconds: 100 }), { min: 220, max: 260 });
  assert.equal(videoWordBudget({ ...EMPTY_PERSONALIZATION, videoLength: "custom", videoSeconds: null }), null);
  assert.equal(newsletterLengthGuidance(EMPTY_PERSONALIZATION), "");
  assert.match(newsletterLengthGuidance({ ...EMPTY_PERSONALIZATION, newsletterLength: "quick" }), /250–400 words/);
});

test("cadence previews the next publication days as calendar dates", () => {
  const from = new Date("2026-09-09T20:00:00Z"); // a Wednesday
  assert.deepEqual(nextPublicationDates({ ...EMPTY_PERSONALIZATION, cadence: "weekly" }, from, 2), ["2026-09-14", "2026-09-21"]);
  assert.deepEqual(nextPublicationDates({ ...EMPTY_PERSONALIZATION, cadence: "three-weekly" }, from, 3), ["2026-09-11", "2026-09-14", "2026-09-16"]);
  assert.deepEqual(nextPublicationDates({ ...EMPTY_PERSONALIZATION, cadence: "weekdays" }, from, 3), ["2026-09-10", "2026-09-11", "2026-09-14"]);
  assert.deepEqual(nextPublicationDates({ ...EMPTY_PERSONALIZATION, cadence: "twice-monthly" }, from, 2), ["2026-09-15", "2026-10-01"]);
  assert.deepEqual(nextPublicationDates({ ...EMPTY_PERSONALIZATION, cadence: "custom", cadenceDays: [6] }, from, 1), ["2026-09-12"]);
  assert.deepEqual(nextPublicationDates(EMPTY_PERSONALIZATION, from), []);
  assert.deepEqual(nextPublicationDates({ ...EMPTY_PERSONALIZATION, cadence: "custom", cadenceDays: [] }, from), []);
});

test("only qualified formats are selectable and the presenter depends on avatar setup", () => {
  assert.deepEqual(formatChoices(false).filter(f => f.qualified).map(f => f.id), ["narrator"]);
  assert.deepEqual(formatChoices(true).filter(f => f.qualified).map(f => f.id), ["narrator", "presenter"]);
});

test("saving changes only supplied fields, recommendations fill empty ones, logos are content-addressed", () => {
  const root = mkdtempSync(join(tmpdir(), "personalization-"));
  try {
    mkdirSync(join(root, "config"));
    let saved = savePersonalization(root, { cadence: "weekly", newsletterLength: "deep" }, false);
    assert.equal(saved.cadence, "weekly"); assert.equal(saved.newsletterLength, "deep"); assert.equal(saved.videoLength, "");
    saved = savePersonalization(root, { applyRecommendations: true }, false);
    assert.equal(saved.newsletterLength, "deep", "a saved choice is never overwritten by a recommendation");
    assert.equal(saved.videoLength, "standard"); assert.equal(saved.format, "narrator"); assert.equal(saved.cadence, "weekly");
    saved = savePersonalization(root, { logo: PNG }, false);
    assert.match(saved.logoFile, /^assets\/logo-[a-f0-9]{64}\.png$/);
    assert.equal(readFileSync(join(root, saved.logoFile)).length, 24);
    assert.equal(savePersonalization(root, { logo: "" }, false).logoFile, "", "an empty logo returns to the neutral text mark");
    assert.deepEqual(readPersonalization(root).cadenceDays, []);
    assert.throws(() => savePersonalization(root, { format: "conversation" }, false), /not available yet/);
    assert.throws(() => savePersonalization(root, { format: "presenter" }, false), /Needs your avatar/);
    assert.equal(savePersonalization(root, { format: "presenter" }, true).format, "presenter");
    assert.throws(() => savePersonalization(root, { videoLength: "custom" }, false), /seconds/);
    assert.throws(() => savePersonalization(root, { videoLength: "custom", videoSeconds: 5 }, false), /20–240/);
    assert.throws(() => savePersonalization(root, { cadence: "custom", cadenceDays: [] }, false), /at least one/);
    assert.throws(() => savePersonalization(root, { cadence: "hourly" }, false), /Choose a publishing cadence/);
    assert.throws(() => savePersonalization(root, { logo: Buffer.from("GIF89a").toString("base64") }, false), /PNG or JPEG/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the publisher's own style description is kept, bounded and carried into the style brief as a description", () => {
  const root = mkdtempSync(join(tmpdir(), "personalization-"));
  try {
    mkdirSync(join(root, "config"));
    savePersonalization(root, { styleDirection: "friendly-explainer", styleNotes: "  plain-spoken,\n careful   with numbers " }, false);
    const saved = readPersonalization(root);
    assert.equal(saved.styleNotes, "plain-spoken, careful with numbers");
    const brief = styleBrief(saved);
    assert.match(brief, /Friendly explainer/); assert.match(brief, /own words/); assert.match(brief, /careful with numbers/); assert.match(brief, /never instructions/);
    assert.match(styleBrief({ ...EMPTY_PERSONALIZATION, styleNotes: "terse" }), /^The publisher describes/);
    assert.throws(() => savePersonalization(root, { styleNotes: "x".repeat(301) }, false), /up to 300/);
    savePersonalization(root, { styleNotes: "" }, false); assert.equal(readPersonalization(root).styleNotes, "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * 2026-09-10, Saaket: "the harness should not copy my design … it should include code for them to add their
 * code, company name, org name, personal branding". The shipped shell is neutral, every visible token is the
 * customer's, light/dark is a choice, and a workspace can bring its own shell that the harness only fills.
 */
test("the newsletter ships no house design: neutral light default, customer tokens, light or dark, own shell", () => {
  const root = mkdtempSync(join(tmpdir(), "brand-own-"));
  try {
    mkdirSync(join(root, "config"));
    const issue = { subject: "Evidence update", lead: { title: "Study design", body: "Sourced findings", sourceName: "Study", sourceUrl: "https://news.example.org/study" }, items: [{ name: "Decision", url: "https://news.example.org/study", line: "An implication" }], radar: [], signals: [] };
    const base = { publisher: { name: "Owner", publication: "Board Brief", audience: "Leaders", tone: "Clear" }, issue, issueNo: 1, date: "2026-09-10", dateLong: "September 10, 2026", video: null, coveredWeek: [], logoDataUri: null, styleDirection: "" };
    const plain = renderNewsletterHtml(base as never);
    for (const house of [/fonts\.googleapis/, /three\.min\.js/, /Fraunces/, /JetBrains/, /SEC\.0\d/, /PARTICLE GALAXY/, /SIGNAL > NOISE/, /#0B0B14/i, /#7C5CFF/i, /myownai|daily signal/i]) assert.doesNotMatch(plain, house);
    assert.match(plain, /data-theme="light"/); assert.match(plain, /--bg:#FFFFFF/);
    savePersonalization(root, { organization: "Civic Signal Media", tagline: "  Sourced   local policy  ", website: "https://civic.example.org", footer: "Reply to unsubscribe.", theme: "dark", accent: "#e4572e", fontPairing: "serif" }, false);
    const saved = readPersonalization(root);
    assert.equal(saved.tagline, "Sourced local policy"); assert.equal(saved.accent, "#E4572E"); assert.equal(saved.theme, "dark");
    assert.throws(() => savePersonalization(root, { accent: "red" }, false), /six-digit hex/);
    assert.throws(() => savePersonalization(root, { website: "http://insecure.example.org" }, false), /https/);
    assert.throws(() => savePersonalization(root, { theme: "sepia" }, false), /light or dark/);
    const theme = workspaceTheme(root, "#008C86");
    assert.equal(theme.mode, "dark"); assert.equal(theme.accent, "#E4572E"); assert.match(theme.headingFont, /Georgia/);
    assert.equal(brandTheme(EMPTY_PERSONALIZATION, "#008C86").accent, "#008C86", "no accent chosen → the edition accent");
    const branded = renderNewsletterHtml({ ...base, brand: { organization: saved.organization, tagline: saved.tagline, website: saved.website, footer: saved.footer, theme } } as never);
    assert.match(branded, /data-theme="dark"/); assert.match(branded, /--accent:#E4572E/); assert.match(branded, /Civic Signal Media/); assert.match(branded, /Sourced local policy/); assert.match(branded, /civic\.example\.org/); assert.match(branded, /Reply to unsubscribe\./);
    mkdirSync(join(root, "branding")); writeFileSync(join(root, "branding/video-theme.json"), JSON.stringify({ bg: "#101418", accent: "not-a-colour", headingFont: "<script>", mode: "light" }));
    const overridden = workspaceTheme(root, "#008C86");
    assert.equal(overridden.bg, "#101418"); assert.equal(overridden.accent, "#E4572E"); assert.equal(overridden.mode, "light"); assert.match(overridden.headingFont, /Georgia/);
    assert.equal(customNewsletterShell(root), null);
    writeFileSync(join(root, "branding/newsletter.html"), "<h1>{{publication}}</h1><p>{{ organization }}</p>{{lead}}<i>{{unknown}}</i>{{footer}}");
    const shell = customNewsletterShell(root)!;
    assert.ok(shell);
    const own = renderNewsletterHtml({ ...base, brand: { organization: "A <b>Co</b>", tagline: "", website: "", footer: "", theme }, customShell: shell } as never);
    assert.equal(own.startsWith("<h1>Board Brief</h1><p>A &lt;b&gt;Co&lt;/b&gt;</p>"), true, own.slice(0, 120));
    assert.match(own, /Study design/); assert.match(own, /<i>\{\{unknown\}\}<\/i>/); assert.doesNotMatch(own, /<style>/);
    assert.equal(fillShell("{{title}}|{{nope}}", { title: "T" }), "T|{{nope}}");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Saaket, 2026-09-10: "include in the harness to provide these examples when prompted with a choice … personalization to the user is important." */
test("newsletter styles are built in: a preset resolves to its shipped shell, suggests its look, and the workspace's own shell wins", () => {
  const root = mkdtempSync(join(tmpdir(), "brand-preset-"));
  try {
    mkdirSync(join(root, "config"));
    assert.equal(newsletterShell(root), null, "clean = the default shell");
    assert.throws(() => savePersonalization(root, { newsletterPreset: "vaporwave" }, false), /newsletter style/);
    for (const preset of NEWSLETTER_PRESETS.filter(p => p.id !== "clean")) {
      savePersonalization(root, { newsletterPreset: preset.id }, false);
      const shell = newsletterShell(root);
      assert.ok(shell && shell.includes("{{lead}}") && shell.includes("{{items}}"), preset.id + " ships a complete shell");
      assert.doesNotMatch(shell!, /fonts\.googleapis|cdn|myownai/i, preset.id + " fetches nothing and carries no vendor mark");
      const theme = brandTheme(readPersonalization(root), "#008C86");
      assert.equal(theme.mode, preset.mode); if (preset.accent) assert.equal(theme.accent, preset.accent);
    }
    // The customer's own look and accent override the preset's suggestion.
    savePersonalization(root, { newsletterPreset: "neon", theme: "light", accent: "#123456" }, false);
    const own = brandTheme(readPersonalization(root), "#008C86");
    assert.equal(own.mode, "light"); assert.equal(own.accent, "#123456");
    // A workspace shell beats the preset.
    mkdirSync(join(root, "branding")); writeFileSync(join(root, "branding/newsletter.html"), "<main>{{lead}}</main>");
    assert.equal(newsletterShell(root), "<main>{{lead}}</main>");
    savePersonalization(root, { newsletterPreset: "clean" }, false);
    assert.equal(readPersonalization(root).newsletterPreset, "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
