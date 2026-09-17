import { profilePath } from "../workspaces.js";
// Reddit video poster via browser automation.
//
// The API adapter remains primary. This browser adapter is a fallback for accounts that cannot
// obtain API access. It uses the configured shared profile and therefore takes the browser lock.
// `npm run post:reddit-login` opens that profile for authentication. REDDIT_SUBREDDIT defaults to
// `test`; set it deliberately and comply with the destination community's rules.
import { chromium, type Page } from "playwright";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import type { Script, PostResult, VideoMeta } from "../types.js";
import { loadConfig, readJson, todayStamp, videoDir, log } from "../util.js";

const PROFILE_DIR = profilePath("shared", join(homedir(), ".content-harness", "browser-profiles", "shared"), "AI_CONTENT_BROWSER_PROFILE_DIR");

// Shared lock prevents concurrent browser adapters from driving the same profile.
const LOCK = join(tmpdir(), "content-harness-browser.lock");
function acquireLock(purpose: string): void {
  try {
    mkdirSync(LOCK);
  } catch {
    let pid = 0;
    try { pid = Number(readFileSync(join(LOCK, "pid"), "utf8").trim()) || 0; } catch {}
    let alive = false;
    try { if (pid) { process.kill(pid, 0); alive = true; } } catch {}
    if (alive) throw new Error(`browser busy (pid ${pid}) — Reddit post skipped this cycle, it retries on the next run`);
    rmSync(LOCK, { recursive: true, force: true }); // stale: owner is dead
    mkdirSync(LOCK);
  }
  writeFileSync(join(LOCK, "pid"), String(process.pid));
  writeFileSync(join(LOCK, "purpose"), purpose);
  writeFileSync(join(LOCK, "since"), new Date().toISOString());
}
const releaseLock = () => rmSync(LOCK, { recursive: true, force: true });
const LAUNCH_ARGS = ["--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble", "--disable-blink-features=AutomationControlled"];
const SUBREDDIT = process.env.REDDIT_SUBREDDIT || "test";
const SITE_URL = (loadConfig<{ siteUrl?: string }>("pipeline").siteUrl ?? "https://example.invalid").replace(/\/$/, "");

/** Signed-in username via the same-origin session, or null. */
async function whoami(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    try {
      const r = await fetch("/api/me.json", { headers: { accept: "application/json" } });
      if (!r.ok) return null;
      const j = (await r.json()) as { data?: { name?: string } };
      return j?.data?.name ?? null;
    } catch {
      return null;
    }
  });
}

/**
 * Our own recent submissions carrying `probe` — powers BOTH the pre-post duplicate check and the
 * post-verify, so a failed verification can never cause a duplicate submission on the next run.
 */
async function findPost(page: Page, user: string, probe: string): Promise<PostResult | null> {
  const hit = await page.evaluate(
    async ({ user, probe }) => {
      try {
        const r = await fetch(`/user/${user}/submitted.json?limit=25`, { headers: { accept: "application/json" } });
        if (!r.ok) return null;
        const j = (await r.json()) as { data?: { children?: { data?: { id?: string; title?: string; permalink?: string } }[] } };
        const found = (j?.data?.children ?? []).find((c) => (c?.data?.title ?? "").includes(probe));
        return found?.data?.id && found.data.permalink ? { id: found.data.id, permalink: found.data.permalink } : null;
      } catch {
        return null;
      }
    },
    { user, probe }
  );
  if (!hit) return null;
  return { platform: "reddit", receiptOrigin: "profile-discovery", id: hit.id, url: `https://www.reddit.com${hit.permalink}`, postedAt: new Date().toISOString() };
}

/** Re-login helper: opens the SHARED profile if its Reddit session ever lapses. */
export async function redditPostLogin(): Promise<void> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  acquireLock("content-harness Reddit sign-in");
  let user: string | null = null;
  try {
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, channel: "chrome", viewport: { width: 1280, height: 900 }, args: LAUNCH_ARGS });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.bringToFront();
    await page.goto("https://www.reddit.com/login/");
    await page.bringToFront();
    log("A browser opened (check behind your current window). Sign in to Reddit; it saves automatically.");
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(5_000);
      user = await whoami(page);
      if (user) break;
    }
    await page.waitForTimeout(3_000); // let cookies persist
    await ctx.close();
  } finally {
    releaseLock();
  }
  if (!user) throw new Error("Sign-in not detected within 10 min — the session was NOT saved. Run npm run post:reddit-login again.");
  log(`✅ Signed in as u/${user}. The Reddit poster can now run unattended.`);
}

/** Submit the video to r/<REDDIT_SUBREDDIT>; verify it landed and return its permalink. */
export async function postRedditBrowser(meta: VideoMeta): Promise<PostResult> {
  const dir = videoDir(meta.id);
  const script = readJson<Script>(join(dir, "script.json"));
  const title = script.publish.title.slice(0, 300); // Reddit hard-caps titles at 300
  const probe = title.slice(0, 40);
  // The video's CONTENT day (its id prefix), matching how post/index.ts resolves the issue — the
  // wall clock is UTC and flips at ~8pm ET, which would link an evening post to the wrong issue.
  const day = /^\d{8}/.test(meta.id) ? `${meta.id.slice(0, 4)}-${meta.id.slice(4, 6)}-${meta.id.slice(6, 8)}` : todayStamp();

  acquireLock(`content-harness Reddit post ${meta.id}`);
  let ctx: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: "chrome",
      viewport: { width: 1400, height: 1000 },
      args: LAUNCH_ARGS,
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.on("dialog", (d) => void d.accept().catch(() => {}));
    await page.goto("https://www.reddit.com/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4_000);
    const user = await whoami(page);
    if (!user) throw new Error(`Reddit post profile isn't signed in (${PROFILE_DIR}). Run once: npm run post:reddit-login`);

    // IDEMPOTENCY: a prior run may have submitted and then failed verification. Check first so a
    // retry never double-posts (Reddit spam-filters duplicates and it burns account standing).
    const already = await findPost(page, user, probe);
    if (already) {
      log(`Reddit: already live at ${already.url} — not posting again.`);
      return already;
    }

    // Per-subreddit submit URL pre-selects the community, so we never touch the picker widget.
    await page.goto(`https://www.reddit.com/r/${SUBREDDIT}/submit?type=VIDEO`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6_000);

    // Reddit's composer is a shreddit/faceplate web-component tree. Playwright's CSS engine pierces
    // open shadow roots, but the composer renders one control PER TAB (Text/Images&Video/Link) and
    // only one is visible — so every selector here must filter on :visible or it hits a hidden twin.
    await page.locator('textarea[name="title"]:visible').first().fill(title);

    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "Upload files" }).first().click(),
    ]);
    await chooser.setFiles(join(dir, "final.mp4"));

    // Body: link the day's issue on the public site so the post carries the written briefing too.
    const issueUrl = `${SITE_URL}/issues/${day}.html`;
    await page
      .locator('div[aria-label="Optional Body text field"]:visible')
      .first()
      .fill(`Full written briefing, with every source linked: ${issueUrl}`)
      .catch(() => log("Reddit: body text field not fillable — posting video without the issue link."));

    // The Post button un-disables only once the upload finishes processing server-side.
    const btn = page.locator("#inner-post-submit-button").first();
    const deadline = Date.now() + 300_000;
    for (;;) {
      if (!(await btn.isDisabled().catch(() => true))) break;
      if (Date.now() > deadline) throw new Error("Reddit upload timed out after 5 min (Post button never enabled)");
      await page.waitForTimeout(3_000);
    }
    await btn.click({ force: true });

    // A successful submit navigates to the post permalink (/r/<sub>/comments/<id>/...).
    await page.waitForURL(/\/comments\//, { timeout: 120_000 }).catch(() => {});
    await page.waitForTimeout(5_000);

    // VERIFY on our own profile — never trust the redirect alone. Reddit can silently drop a post
    // to the spam filter (bot detection / posting-eligibility / self-promo automod), in which case
    // the composer "succeeds" but nothing is publicly live.
    const posted = await findPost(page, user, probe);
    if (!posted) {
      throw new Error(
        `Submitted to r/${SUBREDDIT} but the post is NOT on u/${user}'s profile — likely removed by the ` +
          `spam filter, automod, or a posting-eligibility/self-promotion rule. Check the subreddit's rules ` +
          `and the account's standing before retrying.`
      );
    }
    log(`Reddit posted: ${posted.url}`);
    return posted;
  } finally {
    await ctx?.close().catch(() => {});
    releaseLock();
  }
}
