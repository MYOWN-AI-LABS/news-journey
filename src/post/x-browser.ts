import { profilePath } from "../workspaces.js";
// Unattended X (Twitter) video poster (browser automation).
//
// The API adapter remains primary. This browser adapter is the fallback when API posting is not
// available. It uses a dedicated Chrome profile so it cannot contend with shared-profile posters.
// Run `npm run post:x-login` once to authenticate that profile. The poster verifies the resulting
// profile URL and fails closed when it cannot confirm publication.
import { chromium, type Page } from "playwright";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import type { Script, PostResult, VideoMeta } from "../types.js";
import { readJson, videoDir, log } from "../util.js";

const PROFILE_DIR = profilePath("x", join(homedir(), ".content-harness", "browser-profiles", "x"), "AI_CONTENT_X_BROWSER_PROFILE_DIR");
const LAUNCH_ARGS = ["--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble", "--disable-blink-features=AutomationControlled"];

async function loggedIn(page: Page): Promise<boolean> {
  if (/\/i\/flow\/login|\/login|\/i\/jf\/onboarding/.test(page.url())) return false;
  return (await page.locator('[data-testid="AppTabBar_Profile_Link"]').count()) > 0;
}

/**
 * Newest posts on our own profile carrying `probe`, as a PostResult — the single primitive behind
 * BOTH the pre-post duplicate check and the post-verify. Scans the top few (a pinned post or a
 * reply can sit above the newest tweet, which the old article[0]-only check mistook for "missing").
 */
async function findPost(page: Page, username: string, probe: string): Promise<PostResult | null> {
  await page.goto(`https://x.com${username}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6_000);
  const articles = page.locator("article");
  const n = Math.min(await articles.count(), 5);
  for (let i = 0; i < n; i++) {
    const article = articles.nth(i);
    if (!((await article.textContent().catch(() => "")) ?? "").includes(probe)) continue;
    const href = await article.locator('a[href*="/status/"]').first().getAttribute("href").catch(() => null);
    if (!href) continue;
    return { platform: "x", receiptOrigin: "profile-discovery", id: href.match(/\/status\/(\d+)/)?.[1] ?? href, url: `https://x.com${href}`, postedAt: new Date().toISOString() };
  }
  return null;
}

/** Recovery only: open X so you can sign the shared profile back in if its session ever expires. */
export async function xPostLogin(): Promise<void> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, channel: "chrome", viewport: { width: 1280, height: 900 }, args: LAUNCH_ARGS });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.bringToFront();
  await page.goto("https://x.com/i/flow/login");
  await page.bringToFront();
  log("A browser opened (check behind your current window). Sign in to X; once you see the home timeline it saves automatically.");
  await page.waitForURL(/x\.com\/home/, { timeout: 10 * 60_000 }).catch(() => {});
  await page.waitForTimeout(4_000); // let cookies persist
  const ok = /x\.com\/home/.test(page.url());
  await ctx.close();
  if (!ok) throw new Error("Sign-in not detected within 10 min — the session was NOT saved. Run npm run post:x-login again.");
  log("✅ Signed in. The X poster can now run unattended (session lasts ~months).");
}

/** Post the video via the x.com composer; verify it landed on the profile and return its URL. */
export async function postXBrowser(meta: VideoMeta): Promise<PostResult> {
  const dir = videoDir(meta.id);
  const script = readJson<Script>(join(dir, "script.json"));
  const text = `${script.publish.title}\n\n${script.publish.hashtags.slice(0, 4).join(" ")}`.slice(0, 280);
  const probe = script.publish.title.slice(0, 40);

  mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    viewport: { width: 1400, height: 1000 },
    args: LAUNCH_ARGS,
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("dialog", (d) => void d.accept().catch(() => {}));
  try {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5_000);
    if (!(await loggedIn(page))) {
      throw new Error(`Shared Chrome profile isn't signed in to X (${PROFILE_DIR}). Sign in there, or run: npm run post:x-login`);
    }
    const username = (await page.locator('[data-testid="AppTabBar_Profile_Link"]').getAttribute("href")) ?? "";

    // IDEMPOTENCY (hardening rule 5): posting succeeds but verification can still fail (slow
    // profile render, X rate-limit interstitial). Without this, the retry would post a DUPLICATE
    // tweet. Check the profile FIRST and short-circuit if this video is already up.
    const already = await findPost(page, username, probe);
    if (already) {
      log(`X: already live at ${already.url} — not posting again.`);
      return already;
    }
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3_000);

    const ta = page.locator('[data-testid="tweetTextarea_0"]').first();
    await ta.click({ force: true }); // transparent overlay defeats normal clicks
    await ta.fill(text);
    await page.locator('input[data-testid="fileInput"]').first().setInputFiles(join(dir, "final.mp4"));

    // Upload runs in-composer; the Post button enables only once the media attaches. Poll rather
    // than fixed-sleep: a ~10MB vertical video typically takes 15–25s, allow up to 3 min.
    const btn = page.locator('[data-testid="tweetButtonInline"]').first();
    const deadline = Date.now() + 180_000;
    for (;;) {
      const ready = (await page.locator('[data-testid="attachments"]').count()) > 0 && !(await btn.isDisabled());
      if (ready) break;
      if (Date.now() > deadline) throw new Error("X media upload timed out after 3 min (Post button never enabled)");
      await page.waitForTimeout(3_000);
    }
    await page.waitForTimeout(3_000); // let processing settle before submitting

    await btn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(6_000);
    // If the composer still holds our text the click didn't take — use X's keyboard shortcut.
    const remaining = await ta.textContent().catch(() => "");
    if (remaining && remaining.length > 10) {
      await ta.click({ force: true });
      await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
      await page.waitForTimeout(6_000);
    }
    const toast = (await page.locator('[data-testid="toast"]').allTextContents().catch(() => [] as string[])).join(" ");
    if (toast && !/sent/i.test(toast)) throw new Error(`X rejected the post: ${toast}`);

    // VERIFY on the profile (never trust the toast alone): the post must actually be there.
    const posted = await findPost(page, username, probe);
    if (!posted) throw new Error(`Post not found on profile after posting (looked for "${probe}")`);

    log(`X posted (browser): ${posted.url}`);
    return posted;
  } finally {
    await ctx.close().catch(() => {});
  }
}
