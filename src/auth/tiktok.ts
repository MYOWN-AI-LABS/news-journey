import { captureAuthCode, REDIRECT_URI } from "./oauth-server.js";
import { loadTokens, saveTokens } from "./tokens.js";
import { fetchWithTimeout, log } from "../util.js";

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

// NOTE: TikTok requires the redirect URI to be a registered HTTPS URL — localhost is NOT
// accepted in production apps. For the desktop flow either register an https tunnel
// (e.g. a stable ngrok/Cloudflare Tunnel URL set via TIKTOK_REDIRECT_URI) or use a
// sandbox app which permits localhost during development.
const REDIRECT = process.env.TIKTOK_REDIRECT_URI || REDIRECT_URI;

async function exchange(body: Record<string, string>): Promise<void> {
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`TikTok token exchange ${res.status}: ${await res.text()}`);
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!t.access_token) throw new Error(`TikTok token exchange failed: ${t.error ?? ""} ${t.error_description ?? ""}`);
  saveTokens("tiktok", {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : undefined,
  });
}

export async function authTikTok(): Promise<void> {
  const { TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET } = process.env;
  if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) throw new Error("Set TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET in .env");
  const authUrl =
    `https://www.tiktok.com/v2/auth/authorize/?client_key=${encodeURIComponent(TIKTOK_CLIENT_KEY)}` +
    `&scope=${encodeURIComponent("user.info.basic,video.publish")}&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=tiktok`;
  const code = await captureAuthCode(authUrl);
  await exchange({
    client_key: TIKTOK_CLIENT_KEY,
    client_secret: TIKTOK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT,
  });
  log("TikTok tokens saved (access ~24h; refresh ~365d — auto-renews)");
}

/** Bearer token with transparent refresh (TikTok access tokens live ~24h). */
export async function tiktokAccess(): Promise<string> {
  const t = loadTokens("tiktok");
  if (!t) throw new Error("No TikTok tokens — run: npm run auth:tiktok");
  const expiringSoon = t.expiresAt && new Date(t.expiresAt).getTime() - Date.now() < 300_000;
  if (expiringSoon) {
    if (!t.refreshToken) throw new Error("TikTok token expired and no refresh token — run: npm run auth:tiktok");
    const { TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET } = process.env;
    await exchange({
      client_key: TIKTOK_CLIENT_KEY ?? "",
      client_secret: TIKTOK_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: String(t.refreshToken),
    });
    return (loadTokens("tiktok"))!.accessToken;
  }
  return t.accessToken;
}
