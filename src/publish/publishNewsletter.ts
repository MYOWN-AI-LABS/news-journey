import { assertPublicDelivery } from '../release-profile.js';
import { assetPath } from "../workspaces.js";
import { releaseLock } from "../release-lock.js";
import { validDay, safeId } from "../workspaces.js";
import { assertReviewReleased } from "../pipeline/review-hold.js";
import { WORKDIR as SCOPED_WORKDIR } from "../util.js";
import { profilePath } from "../workspaces.js";
import { authorize } from "../workspaces.js";
import { isDryRun } from "../dry-run.js";
// Explicit LinkedIn newsletter publisher (browser automation).
// LinkedIn has no supported newsletter publishing API, so this explicit command drives the article
// composer with Playwright and verifies the strongest available live-state signal. Authentication is
// held in a dedicated external browser profile created by the separate --login command.
import { chromium, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { NEWSLETTER_DIR } from "../pipeline/newsletter.js";
import { appendDeliveryEventIfChanged } from "../post/delivery.js";
import { newsletterLiveStatus } from "../pipeline/newsletter-live.js";
import { loadEdition, resolveTitle } from "../pipeline/edition.js";
import { readJson, todayStamp, log, VIDEOS_DIR } from "../util.js";
import type { Topic, VideoMeta } from "../types.js";
import { pendingAttempt, beginAttempt, finishAttempt, scopedAttemptKey } from '../post/attempt.js';
import { assertApprovedNewsletterPackage, assertNewsletterSubmissionReceipt, newsletterSubmissionBinding, confirmPublicationMemory, markPublicationMemorySubmitted, reservePublicationMemory } from '../memory/publication.js';

const PROFILE_DIR = profilePath("linkedin-newsletter", join(homedir(), ".content-harness", "browser-profiles", "linkedin-newsletter"), "AI_CONTENT_NEWSLETTER_BROWSER_PROFILE_DIR");
const LAUNCH_ARGS = ["--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble"];
const COVER = assetPath("examples/assets/placeholder-cover.svg");
const COMPOSER_URL = "https://www.linkedin.com/article/new/";

type IssueData = { sourceVideoId?: string | null; issue: { subject: string; lead: { title: string } }; issueNo: number; dateLong: string; video?: { id: string } | null; editionTitle?: string | null; editionCover?: string | null };

function bodyHtmlOf(key: string): string {
  const html = readFileSync(join(NEWSLETTER_DIR, `${key}.linkedin.html`), "utf8");
  const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return (m ? m[1] : html).trim();
}

async function loggedIn(page: Page): Promise<boolean> {
  if (/\/login|\/checkpoint|\/authwall|\/uas\/login/.test(page.url())) return false;
  return (await page.locator('input[name="session_key"]').count()) === 0;
}

/** One-time: open LinkedIn so you can sign in; the dedicated profile keeps the session for months. */
export async function publishLogin(): Promise<void> {
  authorize("manage");
  if (isDryRun()) { log("[dry-run] LinkedIn login browser blocked."); return; }
  mkdirSync(PROFILE_DIR, { recursive: true });
  // Real Chrome (channel:"chrome"), not bundled Chromium — LinkedIn serves Chromium a degraded
  // composer that never finishes mounting. A dedicated (non-default) data dir keeps CDP allowed.
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, channel: "chrome", viewport: { width: 1280, height: 900 }, args: LAUNCH_ARGS });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.bringToFront(); // surface the window — Playwright-launched Chrome often opens behind
  await page.goto("https://www.linkedin.com/login");
  await page.bringToFront();
  log("A browser opened (check behind your current window / other Spaces). Sign in to LinkedIn; once you see your feed it saves automatically.");
  await page.waitForURL(/linkedin\.com\/(feed|in)\//, { timeout: 5 * 60_000 }).catch(() => {});
  await page.waitForTimeout(4_000); // let cookies persist
  await ctx.close();
  log("✅ Signed in. The publisher can now run unattended (session lasts ~months).");
}

export async function publishNewsletter(date?: string, editionId?: string): Promise<string> {
  assertPublicDelivery();
  const unlock = releaseLock(); try { return await publishNewsletterLocked(date, editionId); } finally { unlock(); }
}
async function publishNewsletterLocked(date?: string, editionId?: string): Promise<string> {
  authorize("publish", { edition: editionId ?? "daily-roundup", platform: "linkedin" });
  const day = validDay(date ?? todayStamp());
  if (editionId) safeId(editionId);
  const configuredEdition = loadEdition(editionId);
  const isSpecial = configuredEdition.editionId !== "daily-roundup";
  const keyName = isSpecial ? `${day}-${configuredEdition.editionId}` : day;
  const attemptKey = scopedAttemptKey('newsletter', keyName);
  const legacyAttemptKey = `newsletter-${keyName}`.length <= 160 ? `newsletter-${keyName}` : null;
  const liHtml = join(NEWSLETTER_DIR, `${keyName}.linkedin.html`);
  const dataPath = join(NEWSLETTER_DIR, `${keyName}.json`);
  if (!existsSync(liHtml) || !existsSync(dataPath)) throw new Error(`No generated newsletter for ${keyName} — run \`npm run newsletter\` first.`);

  // SYMMETRY WITH THE VIDEO PATH. postApproved records every gate that holds a release as an
  // append-only event; this path recorded nothing, so "why didn't the issue publish?" was
  // answerable only from a log. Same format and same never-throw appender; the subject id is the
  // ISSUE KEY, not a video id, and the log sits beside the newsletters. IfChanged, so a held issue
  // re-attempted repeatedly stays one line per streak.
  const withhold = (reason: string, detail?: Record<string, unknown>) =>
    appendDeliveryEventIfChanged(NEWSLETTER_DIR, { type: "release.withheld", videoId: keyName, reason, detail });

  const data = readJson<IssueData>(dataPath);
  const vid = data.sourceVideoId;
  if (!vid) throw new Error(`REFUSING to publish ${keyName}: issue has no exact source package identity.`);
  safeId(vid);
  const meta = readJson<VideoMeta>(join(VIDEOS_DIR, vid, 'meta.json'));
  if (meta.id !== vid) throw new Error('Newsletter package identity changed');
  assertReviewReleased(meta, 'publish newsletter');
  assertApprovedNewsletterPackage(meta, keyName);
  const actualEdition = loadEdition(meta.edition).editionId;
  if (actualEdition !== configuredEdition.editionId) throw new Error(`REFUSING to publish ${keyName}: video ${vid} belongs to edition ${actualEdition}.`);
  const cover = data.editionCover ? assetPath(data.editionCover) : COVER;
  if (!existsSync(cover)) throw new Error(`Cover missing: ${cover}`);

  const live = await newsletterLiveStatus(day, configuredEdition.editionId);
  if (live.status === "live") {
    if (!isDryRun() && live.issueUrl) {
      try {
        assertNewsletterSubmissionReceipt(meta, live.issueUrl);
        await confirmPublicationMemory(vid, { provider: 'linkedin-newsletter', remoteId: live.issueUrl, url: live.issueUrl, confirmedAt: Date.now() });
      }
      catch (error) {
        log(`Issue is live; publication memory remains unconfirmed: ${(error as Error).message}`);
        withhold('newsletter-memory-unconfirmed', { error: (error as Error).message });
        return 'already-live-memory-unconfirmed';
      }
    }
    if (isDryRun()) return 'already-live';
    finishAttempt(NEWSLETTER_DIR, attemptKey);
    if (legacyAttemptKey) finishAttempt(NEWSLETTER_DIR, legacyAttemptKey);
    log(`Issue ${keyName} is already live on the newsletter — skipping (no duplicate).`);
    return "already-live";
  }

  {
    const topicPath = join(VIDEOS_DIR, vid, "topic.json");
    if (!existsSync(topicPath)) throw new Error(`REFUSING to publish ${keyName}: missing topic evidence for ${vid}.`);
    const topic = readJson<Topic>(topicPath);
    const candidateUrls = [topic.primaryUrl, ...(topic.stories ?? []).map((s) => s.primaryUrl)].map((url) => url?.trim()).filter(Boolean) as string[];
    if (candidateUrls.length === 0) throw new Error(`REFUSING to publish ${keyName}: topic has no source URLs.`);
    const { crossPipelineCheck } = await import("../pipeline/cross-pipeline-check.js");
    const cp = await crossPipelineCheck(candidateUrls, day, vid);
    const trueRepeats = cp.repeats;
    if (trueRepeats.length) {
      log(`HOLD PUBLISH: ${keyName} repeats prior coverage - NOT publishing:`);
      trueRepeats.forEach((r) => log(`   ${r.url} (already in ${r.foundIn})`));
      const { notify } = await import("../review/notify.js");
      notify("Example Signal - publish blocked (repeat)", `${keyName} repeats ${trueRepeats[0].foundIn}. Re-source before publishing.`);
      withhold("repeat-coverage", { repeats: trueRepeats.map((r) => ({ url: r.url, foundIn: r.foundIn })) });
      return "held-repeat";
    }
  }

  {
    const { validateDay } = await import("../validate.js");
    const problems = await validateDay(day, configuredEdition.editionId);
    if (problems.length) {
      log(`HOLD PUBLISH: ${keyName} has ${problems.length} citation or repeat problem(s) - NOT publishing:`);
      problems.forEach((problem) => log(`   [${problem.status}] ${problem.url} (${problem.context})`));
      const { notify } = await import("../review/notify.js");
      notify("Example Signal - publish blocked", `${keyName}: ${problems.length} citation or repeat problem(s). Fix before publishing.`);
      withhold("dead-citation", { problems: problems.slice(0, 5).map((x) => ({ url: x.url, status: x.status })) });
      return "held-dead-link";
    }
  }

  const title = resolveTitle({ ...configuredEdition, newsletterTitle: data.editionTitle ?? configuredEdition.newsletterTitle }, data.issue.subject);
  const body = bodyHtmlOf(keyName);
  if (isDryRun()) {
    log(`[dry-run] Validated and composed ${keyName} (${title}; ${body.length} HTML characters). Browser launch and publication blocked.`);
    return "dry-run";
  }
  if (pendingAttempt(NEWSLETTER_DIR, attemptKey) || legacyAttemptKey && pendingAttempt(NEWSLETTER_DIR, legacyAttemptKey)) throw new Error('The prior newsletter submission is unconfirmed. Reconcile its exact live issue before sending again.');
  await reservePublicationMemory(vid);

  mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chrome", // real Chrome — bundled Chromium gets a degraded composer from LinkedIn
    viewport: { width: 1400, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
    args: LAUNCH_ARGS,
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    await page.goto(COMPOSER_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_500);
    if (!(await loggedIn(page))) {
      throw new Error("Publish profile isn't signed into LinkedIn. Run once: `npm run newsletter:publish -- --login`");
    }

    // Wait for the composer to load + hydrate before interacting. The cover "Upload from computer"
    // button is the most reliable readiness signal (first thing the composer renders); a short
    // settle lets React attach its click handler (clicking too early = no file dialog opens).
    await page.getByRole("button", { name: "Upload from computer" }).first().waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(2_000);

    // 1) COVER — the OLD button+filechooser path silently no-opped (completed in <300ms without
    //    actually uploading). Robust path: click upload; take the filechooser if it fires, else set
    //    files DIRECTLY on the hidden <input type=file> (works even when the native dialog doesn't
    //    surface to Playwright); handle the crop/confirm dialog flexibly; then VERIFY the empty-cover
    //    placeholder is gone (never falsely log success) and screenshot for evidence.
    log("Uploading cover…");
    const shotDir = SCOPED_WORKDIR;
    const placeholderText = "Add a cover image or video";
    const applyCover = async () => {
      const uploadBtn = page.getByRole("button", { name: "Upload from computer" }).first();
      await uploadBtn.waitFor({ state: "visible", timeout: 20_000 });
      const chooserP = page.waitForEvent("filechooser", { timeout: 5_000 }).catch(() => null);
      await uploadBtn.click();
      const chooser = await chooserP;
      if (chooser) await chooser.setFiles(cover);
      else await page.locator('input[type="file"]').first().setInputFiles(cover, { timeout: 10_000 });
      await page.waitForTimeout(2_500);
      // crop/confirm dialog if present — click its primary action (label varies across LinkedIn builds)
      const dlg = page.getByRole("dialog");
      if (await dlg.count()) {
        for (const label of ["Next", "Apply", "Save", "Crop", "Done"]) {
          const b = dlg.getByRole("button", { name: label, exact: true });
          if (await b.count()) { await b.first().click().catch(() => {}); await page.waitForTimeout(1_500); break; }
        }
      }
      await page.waitForTimeout(2_000);
    };
    await applyCover();
    await page.screenshot({ path: join(shotDir, "publish-cover.png") }).catch(() => {});
    if ((await page.getByText(placeholderText).count()) > 0) {
      // second attempt: set directly on the input element
      await page.locator('input[type="file"]').first().setInputFiles(cover, { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(2_500);
      const d2 = page.getByRole("dialog");
      if (await d2.count()) {
        for (const label of ["Next", "Apply", "Save", "Crop", "Done"]) {
          const b = d2.getByRole("button", { name: label, exact: true });
          if (await b.count()) { await b.first().click().catch(() => {}); await page.waitForTimeout(1_500); break; }
        }
      }
      await page.waitForTimeout(2_000);
      await page.screenshot({ path: join(shotDir, "publish-cover2.png") }).catch(() => {});
    }
    if ((await page.getByText(placeholderText).count()) > 0) {
      throw new Error("Cover did not upload — placeholder still present (see workdir/publish-cover*.png). Aborting before publish.");
    }
    log("Cover applied (verified — placeholder gone).");

    // 2) TITLE
    await page.getByRole("textbox", { name: "Title" }).fill(title);
    log("Title set.");

    // 3) BODY — insert the clean HTML DIRECTLY into the ProseMirror editor via a synthetic paste
    //    event (validated against the live editor). Avoids the system clipboard entirely — the old
    //    copy/paste failed because a background copier page isn't focused when execCommand runs, so
    //    the clipboard stayed empty and ⌘V pasted nothing. Also sidesteps the RTF→HTML CSS-leak.
    const editor = page.getByRole("textbox", { name: "Article editor content" });
    await editor.click();
    const linkCount = () => editor.evaluate((el) => el.querySelectorAll("a").length);
    // Expected links = however many <a> the body actually has (varies per issue: a light news day
    // can legitimately have 7). The guard compares against THIS, not a magic number, so a correct
    // small issue isn't falsely rejected. Floor of 1 so a truly empty paste still fails.
    const expectedLinks = Math.max(1, (body.match(/<a\s/gi) ?? []).length);

    // Method 1: synthetic paste — MUST focus the ProseMirror node INSIDE the page (editor.click()
    // alone doesn't focus its internal contenteditable, so the paste event gets ignored → 0 links).
    await editor.evaluate((el, html) => {
      (el as HTMLElement).focus();
      const dt = new DataTransfer();
      dt.setData("text/html", html);
      dt.setData("text/plain", html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, body);
    await page.waitForTimeout(1_200);
    let links = await linkCount();

    // Method 2 (fallback): write clean HTML to the real clipboard, then a TRUSTED ⌘V keystroke —
    // ProseMirror always honors a real paste. (clipboard-write permission is granted on the context.)
    if (links < expectedLinks) {
      log(`synthetic paste gave ${links}/${expectedLinks} links — retrying via clipboard + keystroke…`);
      await page.evaluate(async (html) => {
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([html.replace(/<[^>]+>/g, " ")], { type: "text/plain" }),
        })]);
      }, body);
      await editor.click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
      await page.waitForTimeout(1_200);
      links = await linkCount();
    }
    log(`Body inserted: ${links}/${expectedLinks} links.`);
    if (links < expectedLinks) throw new Error(`Body insert looks wrong (${links}/${expectedLinks} links) — aborting before publish.`);


    // Commit the body before advancing because LinkedIn autosaves the editor on a debounce.
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" ");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(6_000);
    let reachedPublish = false;
    for (let attempt = 0; attempt < 3 && !reachedPublish; attempt++) {
      await page.getByRole("button", { name: "Next" }).last().click().catch(() => {});
      await page.waitForTimeout(3_500);
      await page.screenshot({ path: join(SCOPED_WORKDIR, `publish-panel-${attempt}.png`) }).catch(() => {});
      reachedPublish = (await page.getByRole("button", { name: /^publish$/i }).count()) > 0;
      if (!reachedPublish) await page.waitForTimeout(4_000);
    }
    // Establish durable delivery state before any publish click or recovery path.
    const publishBtn = page.getByRole("button", { name: /^publish$/i }).last();
    await publishBtn.waitFor({ state: "visible", timeout: 25_000 });
    beginAttempt(NEWSLETTER_DIR, attemptKey);
    await markPublicationMemorySubmitted(vid);
    try {
      await publishBtn.click();
      await page.waitForURL(/linkedin\.com\/pulse\//, { timeout: 60_000 });
      const url = page.url().split("?")[0];
      log(`✅ Published Example Signal · Issue № ${data.issueNo} → ${url}`);
      // Record the EXACT permalink so the video post links to THIS edition's issue (not a sibling
      // edition's — the live-page subject match can't tell same-day issues apart reliably).
      writeFileSync(join(NEWSLETTER_DIR, `.published-${keyName}`), JSON.stringify({ url, subject: data.issue.subject, at: new Date().toISOString(), memoryBinding: newsletterSubmissionBinding(meta) }));
      // A returned permalink is accepted-but-unconfirmed. Only the existing live-page check
      // promotes it to published coverage; an ambiguous attempt cannot be retried blindly.
      await ctx.close();
      return url;
    } catch (e) {
      throw new Error(`Newsletter submission is unconfirmed. Reconcile the exact issue before sending again. ${(e as Error).message.split("\n")[0]}`, { cause: e });
    }
  } catch (e) {
    // a composition step failed (cover/title/body/caption) — close and surface the error
    await ctx.close().catch(() => {});
    throw e;
  }
}
