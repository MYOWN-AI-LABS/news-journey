import { captureAuthCode, REDIRECT_URI } from "./oauth-server.js";
import { loadTokens, saveTokens, daysUntilExpiry } from "./tokens.js";
import { fetchWithTimeout, log } from "../util.js";

const GRAPH = "https://graph.threads.net";

/** Threads API (separate Meta "Threads" app use case — NOT the Instagram app creds). */
export async function authThreads(): Promise<void> {
  const { THREADS_APP_ID, THREADS_APP_SECRET } = process.env;
  if (!THREADS_APP_ID || !THREADS_APP_SECRET) throw new Error("Set THREADS_APP_ID / THREADS_APP_SECRET in .env");

  const authUrl =
    `https://threads.net/oauth/authorize?client_id=${THREADS_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent("threads_basic,threads_content_publish")}&response_type=code`;
  const code = await captureAuthCode(authUrl);

  const tokenRes = await fetchWithTimeout(`${GRAPH}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: THREADS_APP_ID,
      client_secret: THREADS_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code,
    }),
  });
  if (!tokenRes.ok) throw new Error(`Threads token exchange ${tokenRes.status}: ${await tokenRes.text()}`);
  const short = (await tokenRes.json()) as { access_token: string; user_id: number };

  // Exchange for a ~60-day long-lived token
  const longRes = await fetchWithTimeout(
    `${GRAPH}/access_token?grant_type=th_exchange_token&client_secret=${THREADS_APP_SECRET}&access_token=${short.access_token}`
  );
  if (!longRes.ok) throw new Error(`Threads long-lived exchange ${longRes.status}: ${await longRes.text()}`);
  const long = (await longRes.json()) as { access_token: string; expires_in?: number };

  saveTokens("threads", {
    accessToken: long.access_token,
    userId: String(short.user_id),
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : undefined,
  });
  log("Threads long-lived token saved");
}

export function threadsAccess(): { token: string; userId: string } {
  const t = loadTokens("threads");
  if (!t) throw new Error("No Threads tokens — run: npm run auth:threads");
  const days = daysUntilExpiry(t);
  if (days !== null && days <= 0) throw new Error("Threads token expired — run: npm run auth:threads");
  if (days !== null && days < 7) log(`WARNING: Threads token expires in ${days.toFixed(1)} days`);
  return { token: t.accessToken, userId: String(t.userId) };
}
