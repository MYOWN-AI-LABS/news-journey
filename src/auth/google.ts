import { google } from "googleapis";
import { captureAuthCode, REDIRECT_URI } from "./oauth-server.js";
import { loadTokens, saveTokens } from "./tokens.js";
import { log } from "../util.js";

function client() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env");
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
}

export async function authGoogle(engagement = false): Promise<void> {
  const oauth2 = client();
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/youtube.upload", ...(engagement ? ['https://www.googleapis.com/auth/youtube.force-ssl'] : [])],
  });
  const code = await captureAuthCode(url);
  const { tokens } = await oauth2.getToken(code);
  saveTokens("google", {
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token ?? undefined,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : undefined,
  });
  log("Google tokens saved (refresh token persists — keep OAuth consent screen in Production mode)");
}

/** Authorized OAuth2 client with auto-refresh; persists rotated tokens. */
export function googleClient() {
  const stored = loadTokens("google");
  if (!stored) throw new Error("No Google tokens — run: npm run auth:google");
  const oauth2 = client();
  oauth2.setCredentials({ access_token: stored.accessToken, refresh_token: stored.refreshToken });
  oauth2.on("tokens", (t) => {
    saveTokens("google", {
      accessToken: t.access_token ?? stored.accessToken,
      refreshToken: t.refresh_token ?? stored.refreshToken,
      expiresAt: t.expiry_date ? new Date(t.expiry_date).toISOString() : undefined,
    });
  });
  return oauth2;
}
