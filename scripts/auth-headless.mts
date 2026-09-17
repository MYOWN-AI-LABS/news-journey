// auth-headless.mts — same OAuth flows as `npm run auth:google` / `auth:meta`, but
// PRINTS the consent URL instead of auto-opening the default browser, so an
// automation browser (or a human on another machine) can complete it.
//
// Usage: npx tsx scripts/auth-headless.mts google|meta
import { createServer } from "node:http";
import { google } from "googleapis";
import { saveTokens } from "../src/auth/tokens.js";
import { fetchWithTimeout, log } from "../src/util.js";

const REDIRECT_PORT = 8585;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const provider = process.argv[2];

function capture(authUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body style="font-family:sans-serif"><h2>${code ? "✅ Authorized — you can close this tab." : `❌ ${error}`}</h2></body></html>`);
      server.close();
      if (code) resolve(code); else reject(new Error(`OAuth error: ${error ?? "no code"}`));
    });
    server.listen(REDIRECT_PORT, () => {
      console.log(`AUTH_URL::${authUrl}`);
      log(`waiting for redirect on ${REDIRECT_URI}`);
    });
    setTimeout(() => { server.close(); reject(new Error("OAuth timed out (10 min)")); }, 600_000).unref();
  });
}

if (provider === "google") {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error("Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET");
  const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/youtube.upload"],
  });
  const code = await capture(url);
  const { tokens } = await oauth2.getToken(code);
  saveTokens("google", {
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token ?? undefined,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : undefined,
  });
  log("Google tokens saved");
} else if (provider === "meta") {
  const { META_APP_ID, META_APP_SECRET } = process.env;
  if (!META_APP_ID || !META_APP_SECRET) throw new Error("Set META_APP_ID / META_APP_SECRET");
  const GRAPH = "https://graph.facebook.com/v23.0";
  const authUrl =
    `https://www.facebook.com/v23.0/dialog/oauth?client_id=${META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent("instagram_basic,instagram_content_publish,pages_show_list,business_management")}`;
  const code = await capture(authUrl);
  const tokenRes = await fetchWithTimeout(
    `${GRAPH}/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code=${code}`
  );
  if (!tokenRes.ok) throw new Error(`Meta token exchange ${tokenRes.status}: ${await tokenRes.text()}`);
  const shortTok = ((await tokenRes.json()) as { access_token: string }).access_token;
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
} else {
  throw new Error("usage: auth-headless.mts google|meta");
}
