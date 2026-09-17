import { captureAuthCode, REDIRECT_URI } from "./oauth-server.js";
import { loadTokens, saveTokens, daysUntilExpiry } from "./tokens.js";
import { fetchWithTimeout, log } from "../util.js";

export async function authLinkedIn(): Promise<void> {
  const { LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET } = process.env;
  if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
    throw new Error("Set LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET in .env");
  }
  const authUrl =
    `https://www.linkedin.com/oauth/v2/authorization?response_type=code` +
    `&client_id=${LINKEDIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent("openid profile w_member_social")}`;
  const code = await captureAuthCode(authUrl);

  const res = await fetchWithTimeout("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: LINKEDIN_CLIENT_ID,
      client_secret: LINKEDIN_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`LinkedIn token exchange ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };

  // Resolve the member URN once via OpenID userinfo and store it with the token
  const me = await fetchWithTimeout("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  if (!me.ok) throw new Error(`LinkedIn userinfo ${me.status}`);
  const profile = (await me.json()) as { sub: string };

  saveTokens("linkedin", {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    personUrn: `urn:li:person:${profile.sub}`,
  });
  log(`LinkedIn token saved (expires in ${Math.round(data.expires_in / 86400)} days)`);
}

export function linkedinAccess(): { token: string; personUrn: string } {
  const t = loadTokens("linkedin");
  if (!t) throw new Error("No LinkedIn tokens — run: npm run auth:linkedin");
  const days = daysUntilExpiry(t);
  if (days !== null && days <= 0) throw new Error("LinkedIn token expired — run: npm run auth:linkedin");
  if (days !== null && days < 7) log(`WARNING: LinkedIn token expires in ${days.toFixed(1)} days — re-auth soon`);
  return { token: t.accessToken, personUrn: t.personUrn as string };
}
