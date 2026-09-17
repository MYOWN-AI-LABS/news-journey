import { captureAuthCode, REDIRECT_URI } from "./oauth-server.js";
import { loadTokens, saveTokens, daysUntilExpiry } from "./tokens.js";
import { fetchWithTimeout, log } from "../util.js";

const GRAPH = "https://graph.facebook.com/v23.0";

export async function authMeta(): Promise<void> {
  const { META_APP_ID, META_APP_SECRET } = process.env;
  if (!META_APP_ID || !META_APP_SECRET) throw new Error("Set META_APP_ID / META_APP_SECRET in .env");

  const authUrl =
    `https://www.facebook.com/v23.0/dialog/oauth?client_id=${META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent("instagram_basic,instagram_content_publish,pages_show_list,business_management")}`;
  const code = await captureAuthCode(authUrl);

  const tokenRes = await fetchWithTimeout(
    `${GRAPH}/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code=${code}`
  );
  if (!tokenRes.ok) throw new Error(`Meta token exchange ${tokenRes.status}: ${await tokenRes.text()}`);
  const shortTok = ((await tokenRes.json()) as { access_token: string }).access_token;

  // Exchange for a ~60-day long-lived token
  const longRes = await fetchWithTimeout(
    `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}` +
      `&client_secret=${META_APP_SECRET}&fb_exchange_token=${shortTok}`
  );
  if (!longRes.ok) throw new Error(`Meta long-lived exchange ${longRes.status}: ${await longRes.text()}`);
  const long = (await longRes.json()) as { access_token: string; expires_in?: number };

  saveTokens("meta", {
    accessToken: long.access_token,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : undefined,
  });
  log("Meta long-lived token saved");
}

export function metaAccess(): { token: string; igUserId: string } {
  const t = loadTokens("meta");
  if (!t) throw new Error("No Meta tokens — run: npm run auth:meta");
  const days = daysUntilExpiry(t);
  if (days !== null && days <= 0) throw new Error("Meta token expired — run: npm run auth:meta");
  if (days !== null && days < 7) log(`WARNING: Meta token expires in ${days.toFixed(1)} days`);
  const igUserId = process.env.IG_USER_ID;
  if (!igUserId) throw new Error("Set IG_USER_ID in .env (your Instagram Business account id)");
  return { token: t.accessToken, igUserId };
}
