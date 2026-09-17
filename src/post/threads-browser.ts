import { profilePath } from "../workspaces.js";
// Threads video poster via browser automation.
//
// The API adapter remains primary. This browser adapter is the fallback when Threads API
// credentials are unavailable. It uses the configured shared Chrome profile and browser lock.
// The composer is a Lexical contenteditable, and the selector below targets the editable node.
import { chromium, type Page } from "playwright";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import type { Script, PostResult, VideoMeta } from "../types.js";
import { loadConfig, readJson, todayStamp, videoDir, log } from "../util.js";

const PROFILE_DIR = profilePath("shared", join(homedir(), ".content-harness", "browser-profiles", "shared"), "AI_CONTENT_BROWSER_PROFILE_DIR");
const LAUNCH_ARGS = ["--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble", "--disable-blink-features=AutomationControlled"];
const SITE_URL = (loadConfig<{ siteUrl?: string }>("pipeline").siteUrl ?? "https://example.invalid").replace(/\/$/, "");
const COMPOSER = 'div[contenteditable="true"][aria-label="Empty text field. Type to compose a new post."]';

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
    if (alive) throw new Error(`browser busy (pid ${pid}) — Threads post skipped this cycle, it retries on the next run`);
    rmSync(LOCK, { recursive: true, force: true }); // stale: owner is dead
    mkdirSync(LOCK);
  }
  writeFileSync(join(LOCK, "pid"), String(process.pid));
  writeFileSync(join(LOCK, "purpose"), purpose);
  writeFileSync(join(LOCK, "since"), new Date().toISOString());
}
const releaseLock = () => rmSync(LOCK, { recursive: true, force: true });

/** Signed-in Threads handle via the profile nav, or null when logged out. */
async function whoami(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    if (/log in or sign up/i.test(document.body.innerText)) return null;
    const own = Array.from(document.querySelectorAll('a[href^="/@"]'))
      .map((a) => a.getAttribute("href") ?? "")
      .find((h) => h.startsWith("/@") && !h.includes("/post/"));
    return own ? own.slice(2) : null;
  });
}

/**
 * Our own recent posts carrying `probe` — powers BOTH the pre-post duplicate check and the
 * post-verify, so a failed verification can never cause a duplicate post on the next run.
 */
async function findPost(page: Page, handle: string, probe: string): Promise<PostResult | null> {
  // Threads' SPA router aborts navigations (net::ERR_ABORTED), and our beforeunload-dismissing
  // dialog handler can cancel one outright — either kills a single goto. Retry a few times.
  let navigated = false;
  for (let attempt = 0; attempt < 3 && !navigated; attempt++) {
    try {
      await page.goto(`https://www.threads.com/@${handle}`, { waitUntil: "commit", timeout: 45_000 });
      navigated = true;
    } catch {
      await page.waitForTimeout(3_000);
    }
  }
  if (!navigated) throw new Error(`Could not open @${handle}'s Threads profile to verify the post`);
  await page.waitForTimeout(8_000);
  const href = await page.evaluate((probeText) => {
    const articles = Array.from(document.querySelectorAll("div[data-pressable-container], article"));
    for (const el of articles) {
      if (!(el.textContent ?? "").includes(probeText)) continue;
      const link = el.querySelector('a[href*="/post/"]');
      if (link) return link.getAttribute("href");
    }
    return null;
  }, probe);
  if (!href) return null;
  return {
    platform: "threads",
    receiptOrigin: "profile-discovery",
    id: href.match(/\/post\/([\w-]+)/)?.[1] ?? href,
    url: `https://www.threads.com${href}`,
    postedAt: new Date().toISOString(),
  };
}

/** Post the video to Threads; verify it landed on the profile and return its permalink. */
export async function postThreadsBrowser(meta: VideoMeta): Promise<PostResult> {
  const dir = videoDir(meta.id);
  const script = readJson<Script>(join(dir, "script.json"));
  const day = /^\d{8}/.test(meta.id) ? `${meta.id.slice(0, 4)}-${meta.id.slice(4, 6)}-${meta.id.slice(6, 8)}` : todayStamp();
  // Threads caps posts at 500 chars; keep the issue link intact by budgeting it first.
  const link = `\n\nFull written briefing, every source linked: ${SITE_URL}/issues/${day}.html`;
  const title = script.publish.title.slice(0, 500 - link.length);
  const text = `${title}${link}`;
  const probe = script.publish.title.slice(0, 40);

  acquireLock(`ai-content-engine Threads post ${meta.id}`);
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
    await page.goto("https://www.threads.com/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5_000);
    const handle = await whoami(page);
    if (!handle) throw new Error(`The configured Chrome profile is not signed in to Threads (${PROFILE_DIR}).`);

    // IDEMPOTENCY: a prior run may have posted and then failed verification. Check first.
    const already = await findPost(page, handle, probe);
    if (already) {
      log(`Threads: already live at ${already.url} — not posting again.`);
      return already;
    }

    await page.goto("https://www.threads.com/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6_000);

    await page
      .getByRole("button", { name: "Empty text field. Type to compose a new post." })
      .first()
      .click()
      .catch(async () => {
        await page.locator('[aria-label="New thread"]').first().click().catch(() => {});
      });
    const composer = page.locator(COMPOSER).first();
    await composer.waitFor({ state: "visible", timeout: 60_000 });
    await composer.click();
    await page.waitForTimeout(1_000);
    await composer.fill(text);

    // Arm the upload listener BEFORE attaching: Threads starts POSTing the file to
    // /rupload_igvideo/ as soon as the chooser resolves, and a late listener misses it.
    // THIS is the real completion signal — see the long note on the wait below.
    const uploadDone = page
      .waitForResponse((r) => /rupload_igvideo/i.test(r.url()) && r.request().method() === "POST", { timeout: 300_000 })
      .then((r) => ({ ok: r.ok(), status: r.status() }))
      .catch(() => null);

    // Attach the video through the composer's own hidden input — clicking it opens the real
    // chooser, which Threads honours. waitForEvent must be armed BEFORE the click.
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.evaluate(() => {
        const fi = document.querySelector('input[type=file][accept*="video/mp4"]') as HTMLInputElement | null;
        if (!fi) throw new Error("Threads composer file input not found");
        fi.click();
      }),
    ]);
    await chooser.setFiles(join(dir, "final.mp4"));

    const up = await uploadDone;
    if (!up) throw new Error("Threads video upload never completed (no /rupload_igvideo/ response within 5 min)");
    if (!up.ok) throw new Error(`Threads video upload failed (HTTP ${up.status})`);
    await page.waitForTimeout(4_000); // let server-side processing settle before submitting

    const created = page
      .waitForResponse(
        (r) => /configure_text_post_app_feed/i.test(r.url()) && r.request().method() === "POST" && r.status() === 200,
        { timeout: 300_000 }
      )
      .catch(() => null);

    await page.locator("[role=dialog]").getByText("Post", { exact: true }).first().click();

    const res = await created;
    if (!res) throw new Error("Threads never confirmed the post (no HTTP 200 from configure_text_post_app_feed within 5 min) — still transcoding or rejected");
    const media = (await res.json().catch(() => null))?.media as { code?: string; permalink?: string } | undefined;
    if (media?.permalink && media.code) {
      log(`Threads posted: ${media.permalink}`);
      return { platform: "threads", receiptOrigin: "provider-response", id: media.code, url: media.permalink, postedAt: new Date().toISOString() };
    }

    // Confirmed 200 but an unexpected body shape — fall back to reading the profile.
    await page.waitForTimeout(4_000);
    const posted = await findPost(page, handle, probe);
    if (!posted) throw new Error(`Threads returned 200 but the post is NOT on @${handle}'s profile — response body had no permalink.`);
    log(`Threads posted: ${posted.url}`);
    return posted;
  } finally {
    await ctx?.close().catch(() => {});
    releaseLock();
  }
}
