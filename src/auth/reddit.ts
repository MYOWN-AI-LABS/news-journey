import { randomBytes } from "node:crypto";
import { captureAuthCode, REDIRECT_URI } from "./oauth-server.js";
import { loadTokens, saveTokens } from "./tokens.js";
import { fetchWithTimeout, log } from "../util.js";

const AUTH_URL = "https://www.reddit.com/api/v1/authorize";
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const SCOPES = "submit identity";

// Reddit REQUIRES a descriptive custom User-Agent on every API call, or requests get
// silently rate-limited/blocked. Format per Reddit's own API rules: platform:app_id:version (by /u/user).
export const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT?.trim() || "web:content-harness:v1.0 (by /u/configure_me)";

function basicAuth(): string {
  const { REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET } = process.env;
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) throw new Error("Set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET in .env");
  return "Basic " + Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString("base64");
}

async function exchange(body: URLSearchParams): Promise<void> {
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth(), "User-Agent": REDDIT_USER_AGENT },
    body,
  });
  if (!res.ok) throw new Error(`Reddit token exchange ${res.status}: ${await res.text()}`);
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  saveTokens("reddit", {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : undefined,
  });
}

/** OAuth 2.0 Authorization Code (Reddit "web app" type — confidential client, no PKCE needed
 *  since the client secret is sent server-side). duration=permanent issues a refresh token. */
export async function authReddit(): Promise<void> {
  const { REDDIT_CLIENT_ID } = process.env;
  if (!REDDIT_CLIENT_ID) throw new Error("Set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET in .env");
  const state = randomBytes(8).toString("hex");
  const authUrl =
    `${AUTH_URL}?client_id=${encodeURIComponent(REDDIT_CLIENT_ID)}&response_type=code` +
    `&state=${state}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&duration=permanent&scope=${encodeURIComponent(SCOPES)}`;
  const code = await captureAuthCode(authUrl);
  await exchange(new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }));
  log("Reddit tokens saved (refresh token included — auto-renews)");
}

/** Bearer token with transparent refresh (Reddit access tokens live 1h). */
export async function redditAccess(): Promise<string> {
  const t = loadTokens("reddit");
  if (!t) throw new Error("No Reddit tokens — run: npm run auth:reddit");
  const expiringSoon = t.expiresAt && new Date(t.expiresAt).getTime() - Date.now() < 300_000;
  if (expiringSoon) {
    if (!t.refreshToken) throw new Error("Reddit token expired and no refresh token — run: npm run auth:reddit");
    await exchange(new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }));
    return loadTokens("reddit")!.accessToken;
  }
  return t.accessToken;
}
