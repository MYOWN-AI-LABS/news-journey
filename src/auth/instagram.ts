import { loadTokens, saveTokens, daysUntilExpiry } from "./tokens.js";
import { fetchWithTimeout, log } from "../util.js";

// Instagram API with Instagram Login (graph.instagram.com) — no Facebook Page.
// The long-lived token is obtained ONCE from the app dashboard's "Generate token" flow
// (developers.facebook.com → app → Instagram use case → API setup with Instagram login →
// 2. Generate access tokens), saved to state/tokens/instagram.json. It lasts ~60 days and
// is refreshed here transparently via grant_type=ig_refresh_token (works on tokens ≥24h old).
const GRAPH = "https://graph.instagram.com";

/** Bearer token for graph.instagram.com, refreshed when it's within a week of expiry. */
export async function instagramAccess(): Promise<{ token: string; igUserId: string }> {
  const t = loadTokens("instagram");
  if (!t) throw new Error("No Instagram token — generate one in the app dashboard and save it to state/tokens/instagram.json");
  const igUserId = process.env.IG_USER_ID;
  if (!igUserId) throw new Error("Set IG_USER_ID in .env (the graph.instagram.com /me id)");

  const days = daysUntilExpiry(t);
  if (days !== null && days < 7) {
    // ig_refresh_token extends a long-lived token by another 60 days.
    const res = await fetchWithTimeout(`${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${t.accessToken}`);
    if (res.ok) {
      const r = (await res.json()) as { access_token: string; expires_in?: number };
      saveTokens("instagram", {
        ...t,
        accessToken: r.access_token,
        expiresAt: r.expires_in ? new Date(Date.now() + r.expires_in * 1000).toISOString() : t.expiresAt,
      });
      log("Instagram token refreshed (+60 days)");
      return { token: r.access_token, igUserId };
    }
    log(`WARNING: Instagram token refresh failed (${res.status}); using existing token (${days?.toFixed(1)} days left)`);
  }
  return { token: t.accessToken, igUserId };
}
