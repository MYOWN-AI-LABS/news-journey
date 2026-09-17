import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, readJson, writeJson } from "../util.js";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string; // ISO
  [k: string]: unknown;
}

const tokenPath = (provider: string) => join(STATE_DIR, "tokens", `${provider}.json`);

export function loadTokens(provider: string): TokenSet | null {
  const p = tokenPath(provider);
  return existsSync(p) ? readJson<TokenSet>(p) : null;
}

export function saveTokens(provider: string, tokens: TokenSet): void {
  const p = tokenPath(provider);
  writeJson(p, tokens);
  if (process.platform !== "win32") chmodSync(p, 0o600);
}

export function daysUntilExpiry(tokens: TokenSet): number | null {
  if (!tokens.expiresAt) return null;
  return (new Date(tokens.expiresAt).getTime() - Date.now()) / 86400_000;
}
