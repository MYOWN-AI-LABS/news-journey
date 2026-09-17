import { assertPublicDelivery } from '../release-profile.js';
import { assertExplicitApprovalCurrent, newsletterKeyFor } from "../pipeline/explicit-approval.js";
import { assertReviewReleased } from "../pipeline/review-hold.js";
import type { VideoMeta } from "../types.js";
import { videoDir } from "../util.js";
import { isDryRun } from "../dry-run.js";
import { releaseLock } from "../release-lock.js";
import { validDay, safeId } from "../workspaces.js";
import { WORKDIR as SCOPED_WORKDIR } from "../util.js";
import { profilePath } from "../workspaces.js";
import { authorize } from "../workspaces.js";
import { chromium, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { NEWSLETTER_DIR } from "../pipeline/newsletter.js";
import type { NewsletterData } from "../pipeline/newsletter-html.js";
import { renderLinkedInEdition } from "../pipeline/newsletter-linkedin.js";
import { readJson, writeJson, todayStamp, log } from "../util.js";

const PROFILE_DIR = profilePath("linkedin-newsletter", join(homedir(), ".content-harness", "browser-profiles", "linkedin-newsletter"), "AI_CONTENT_NEWSLETTER_BROWSER_PROFILE_DIR");
const LAUNCH_ARGS = ["--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble"];

/** HTML appended to the published issue body. PURE + unit-tested. Returns "" for a non-http url. */
export function videoLinkSnippet(videoUrl: string): string {
  const u = (videoUrl ?? "").trim();
  if (!/^https?:\/\//i.test(u)) return "";
  // &amp; so the snippet is valid HTML when pasted into ProseMirror.
  return `<p>▶ <a href="${u}">Watch &amp; discuss this issue's video on my feed →</a></p>`;
}

/** Stable ugcPost URN id from a feed url. This SURVIVES LinkedIn's paste sanitization (which strips
 *  unknown attributes — so a data-* marker would never be found — but KEEPS the <a href>), so it's
 *  what we use to detect/dedupe the link in the live editor. Falls back to the url. PURE + tested. */
export function videoUrnOf(videoUrl: string): string {
  const u = (videoUrl ?? "").trim();
  return u.match(/ugcPost:(\d+)/)?.[1] ?? u;
}

async function loggedIn(page: Page): Promise<boolean> {
  if (/\/login|\/checkpoint|\/authwall|\/uas\/login/.test(page.url())) return false;
  return (await page.locator('input[name="session_key"]').count()) === 0;
}

/** Resolve the published /pulse/ permalink recorded at publish time. */
function permalinkFor(key: string): string {
  const marker = join(NEWSLETTER_DIR, `.published-${key}`);
  if (!existsSync(marker)) {
    throw new Error(`No publish marker .published-${key} — publish the issue first (it records the permalink).`);
  }
  const url = readJson<{ url: string }>(marker).url;
  if (!url || !/linkedin\.com\/pulse\//.test(url)) throw new Error(`Publish marker for ${key} has no /pulse/ url.`);
  return url;
}

/**
 * Edit the live issue to append the video feed-post link. Idempotent (skips if already linked).
 * Returns "linked" | "already-linked" | "left-open-for-manual" (composed but couldn't auto-confirm).
 */
export async function linkVideoIntoNewsletter(opts: { date?: string; editionId?: string; videoUrl: string }): Promise<string> {
  assertPublicDelivery();
  const unlock = releaseLock(); try { return await linkVideoLocked(opts); } finally { unlock(); }
}
async function linkVideoLocked(opts: { date?: string; editionId?: string; videoUrl: string }): Promise<string> {
  authorize("publish", { edition: opts.editionId ?? "daily-roundup", platform: "linkedin" });
  const day = validDay(opts.date ?? todayStamp());
  if (opts.editionId) safeId(opts.editionId);
  const isSpecial = !!opts.editionId && opts.editionId !== "daily-roundup";
  const key = isSpecial ? `${day}-${opts.editionId}` : day;

  if (!/^https?:\/\//i.test((opts.videoUrl ?? "").trim())) {
    log(`link-video: no valid video url ("${opts.videoUrl}") — skipping issue ${key}.`);
    return "no-op";
  }

  // Regenerate the LinkedIn body with the video now POSTED + its real public URL, so the
  // "🎬 Today's video briefing: <headline>" line renders as a LINK to the video. At gen time
  // video.posted was false and the url was a localhost placeholder, so that line shipped as plain
  // text — the recurring "no link to the video" bug. Persist the corrected edition to disk too.
  const dataPath = join(NEWSLETTER_DIR, `${key}.json`);
  const d = readJson<NewsletterData>(dataPath);
  if (!d.video) {
    log(`link-video: issue ${key} has no video block — skipping.`);
    return "no-op";
  }
  const source = d.sourceVideoId ?? d.video.id;
  const meta = readJson<VideoMeta>(join(videoDir(source), "meta.json"));
  assertReviewReleased(meta, "link newsletter video"); assertExplicitApprovalCurrent(meta);
  if (newsletterKeyFor(meta) !== key || d.video.id !== source || meta.posts.linkedin?.url !== opts.videoUrl) throw new Error("Reverse-link must match this issue's approved package and exact LinkedIn receipt");
  if (isDryRun()) return "dry-run";
  d.sourceVideoId = source;
  d.video.posted = true;
  d.video.videoUrl = opts.videoUrl;
  const fullHtml = renderLinkedInEdition(d);
  const bodyInner = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(fullHtml)?.[1] ?? fullHtml).trim();
  writeFileSync(join(NEWSLETTER_DIR, `${key}.linkedin.html`), fullHtml);
  writeJson(dataPath, d);

  const permalink = permalinkFor(key);

  const ctx: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    viewport: { width: 1400, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
    args: LAUNCH_ARGS,
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    await page.goto(permalink, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_500);
    if (!(await loggedIn(page))) {
      throw new Error("Publish profile isn't signed into LinkedIn. Run once: `npm run newsletter:publish -- --login`");
    }

    // EDIT-ENTRY: open the article editor (label varies across LinkedIn builds).
    let openedEditor = false;
    for (const name of [/edit article/i, /^edit$/i]) {
      const b = page.getByRole("button", { name }).first();
      if (await b.count()) { await b.click().catch(() => {}); openedEditor = true; break; }
      const l = page.getByRole("link", { name }).first();
      if (await l.count()) { await l.click().catch(() => {}); openedEditor = true; break; }
    }
    if (!openedEditor) {
      await page.screenshot({ path: join(SCOPED_WORKDIR, "link-video-no-edit-button.png") }).catch(() => {});
      throw new Error("Couldn't find the article 'Edit' control (see workdir/link-video-no-edit-button.png).");
    }
    await page.waitForTimeout(3_000);

    const editor = page.getByRole("textbox", { name: "Article editor content" });
    await editor.waitFor({ state: "visible", timeout: 30_000 });
    // Idempotency keys on whether the 🎬 HEADLINE itself is already a link (text immediately closing
    // an anchor) — NOT just whether the URN appears (an old "▶ Watch" append would falsely match).
    const headlineLinked = async () => (await editor.evaluate((el) => (el as HTMLElement).innerHTML)).includes(`${d.video!.headline}</a>`);

    if (await headlineLinked()) {
      log(`link-video: issue ${key} already links this video — no-op.`);
      await ctx.close();
      return "already-linked";
    }

    // REPLACE the whole body: select-all, then paste the regenerated body (paste replaces the
    // selection) so the 🎬 line is now a hyperlink. Two paste methods, same as publishNewsletter.
    const selectAll = async () => { await editor.click(); await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A"); await page.waitForTimeout(250); };
    await selectAll();
    await editor.evaluate((el, html) => {
      (el as HTMLElement).focus();
      const dt = new DataTransfer();
      dt.setData("text/html", html);
      dt.setData("text/plain", html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, bodyInner);
    await page.waitForTimeout(1_200);
    if (!(await headlineLinked())) {
      log("link-video: synthetic paste didn't land — retrying via clipboard + keystroke…");
      await page.evaluate(async (html) => {
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([html.replace(/<[^>]+>/g, " ")], { type: "text/plain" }),
        })]);
      }, bodyInner);
      await selectAll();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
      await page.waitForTimeout(1_200);
    }
    if (!(await headlineLinked())) {
      await page.screenshot({ path: join(SCOPED_WORKDIR, "link-video-paste-failed.png") }).catch(() => {});
      throw new Error("Video-link body refresh didn't land (see workdir/link-video-paste-failed.png) — aborting before re-publish.");
    }
    log(`link-video: refreshed issue ${key} body — 🎬 video-briefing line now links to the video.`);

    // Re-publish the edit. The published-article editor commits via "Publish"/"Done"/"Save" (label
    // varies); nudge autosave first, then click the primary action. This is the classifier-gated step.
    await editor.click();
    await page.keyboard.type(" ");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(4_000);
    for (const name of [/^publish$/i, /^done$/i, /^save$/i, /^update$/i]) {
      const b = page.getByRole("button", { name }).last();
      if (await b.count()) {
        await b.click().catch(() => {});
        await page.waitForTimeout(3_000);
        // a confirm panel may follow ("Publish")
        const confirm = page.getByRole("button", { name: /^publish$/i }).last();
        if (await confirm.count()) await confirm.click().catch(() => {});
        await page.waitForURL(/linkedin\.com\/pulse\//, { timeout: 60_000 }).catch(() => {});
        log(`✅ link-video: re-published issue ${key} with the video link → ${page.url().split("?")[0]}`);
        await ctx.close();
        return "linked";
      }
    }
    await page.screenshot({ path: join(SCOPED_WORKDIR, "link-video-no-publish.png") }).catch(() => {});
    log("⚠️ link-video: edit composed but couldn't auto-confirm — leaving the window open for a one-tap finish.");
    await page.waitForTimeout(10 * 60_000).catch(() => {});
    return "left-open-for-manual";
  } catch (e) {
    await ctx.close().catch(() => {});
    throw e;
  }
}
