import { createHash, randomBytes } from "node:crypto";
import { captureAuthCode, REDIRECT_URI } from "./oauth-server.js";
import { loadTokens, saveTokens } from "./tokens.js";
import { fetchWithTimeout, log } from "../util.js";

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const SCOPES = "tweet.read tweet.write users.read media.write offline.access";

function basicAuth(): string {
  const { X_CLIENT_ID, X_CLIENT_SECRET } = process.env;
  if (!X_CLIENT_ID || !X_CLIENT_SECRET) throw new Error("Set X_CLIENT_ID / X_CLIENT_SECRET in .env");
  return "Basic " + Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString("base64");
}

async function exchange(body: URLSearchParams): Promise<void> {
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
    body,
  });
  if (!res.ok) throw new Error(`X token exchange ${res.status}: ${await res.text()}`);
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  saveTokens("x", {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : undefined,
  });
}

/** OAuth 2.0 Authorization Code + PKCE (confidential client). */
export async function authX(): Promise<void> {
  const { X_CLIENT_ID } = process.env;
  if (!X_CLIENT_ID) throw new Error("Set X_CLIENT_ID / X_CLIENT_SECRET in .env");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authUrl =
    `https://x.com/i/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(X_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${randomBytes(8).toString("hex")}&code_challenge=${challenge}&code_challenge_method=S256`;
  const code = await captureAuthCode(authUrl);
  await exchange(
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier, client_id: X_CLIENT_ID })
  );
  log("X tokens saved (refresh token included — auto-renews)");
}

/** Bearer token with transparent refresh (X access tokens live ~2h). */
export async function xAccess(): Promise<string> {
  const t = loadTokens("x");
  if (!t) throw new Error("No X tokens — run: npm run auth:x");
  const expiringSoon = t.expiresAt && new Date(t.expiresAt).getTime() - Date.now() < 300_000;
  if (expiringSoon) {
    if (!t.refreshToken) throw new Error("X token expired and no refresh token — run: npm run auth:x");
    await exchange(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: process.env.X_CLIENT_ID ?? "" })
    );
    return (loadTokens("x"))!.accessToken;
  }
  return t.accessToken;
}
