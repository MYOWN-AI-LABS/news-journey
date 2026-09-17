import { chromium, type BrowserContext } from "playwright";

/** A configured, workspace-owned profile. Never attach to another user's CDP browser. */
export async function launchSharedProfile(profile: string, opts: { viewport?: { width: number; height: number }; attempts?: number; profileDirectory?: string } = {}): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, {
    channel: "chrome", headless: false, viewport: opts.viewport ?? { width: 1400, height: 1000 },
    args: ["--no-first-run", "--no-default-browser-check", ...(opts.profileDirectory ? [`--profile-directory=${opts.profileDirectory}`] : [])],
  });
}
export async function closeSharedProfile(context: BrowserContext): Promise<void> { await context.close(); }
