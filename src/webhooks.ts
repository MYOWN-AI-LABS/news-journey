import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { join } from "node:path";
import { atomicJson, contained, read } from "./workspaces.js";
import { controlEvents } from "./control-state.js";
import { releaseLock } from "./release-lock.js";
interface Hook { id: string; url: string; secretEnv: string; enabled?: boolean }
interface Attempt { status: "pending" | "delivered"; attempts: number; nextAt: number; lastError?: string; deliveredAt?: string }
export function webhookSignature(secret: string, timestamp: string, body: string): string { return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"); }
export async function dispatchWebhooks(root: string, send: typeof fetch = fetch): Promise<{ delivered: number; pending: number }> {
  const unlock = releaseLock(root, "webhook");
  try {
    const hooks = read<Hook[]>(contained(root, "config/webhooks.json"), []).filter((h) => h.enabled !== false);
    if (!hooks.length) return { delivered: 0, pending: 0 };
    const envPath = contained(root, ".env");
    const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
    const statePath = contained(root, "state/webhook-deliveries.json");
    const state = read<Record<string, Attempt>>(statePath, {});
    let delivered = 0, pending = 0, tried = 0;
    for (const event of controlEvents(root)) for (const hook of hooks) {
      const body = JSON.stringify(event);
      const eventId = createHash("sha256").update(body).digest("hex");
      const key = `${hook.id}:${eventId}`;
      const previous = state[key];
      if (previous?.status === "delivered") continue;
      pending++;
      if (previous?.nextAt > Date.now() || tried >= 25) continue;
      tried++;
      const attempt: Attempt = { status: "pending", attempts: (previous?.attempts ?? 0) + 1, nextAt: Date.now() + Math.min(3600_000, 1000 * 2 ** Math.min(previous?.attempts ?? 0, 12)) };
      state[key] = attempt; atomicJson(statePath, state);
      try {
        const url = new URL(hook.url);
        if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) || url.username || url.password || url.hash) throw new Error("Webhook URL must be HTTPS or loopback HTTP");
        if (!/^[A-Z][A-Z0-9_]*$/.test(hook.secretEnv)) throw new Error("Invalid signing-secret name");
        const secret = env[hook.secretEnv];
        if (!secret || secret.length < 32) throw new Error("Configure a signing secret of at least 32 characters in this workspace's .env");
        const timestamp = String(Math.floor(Date.now() / 1000));
        const response = await send(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json", "x-content-event-id": eventId, "x-content-timestamp": timestamp, "x-content-signature": webhookSignature(secret, timestamp, body) }, body });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        attempt.status = "delivered"; attempt.deliveredAt = new Date().toISOString(); delete attempt.lastError; delivered++; pending--;
      } catch (e) { attempt.lastError = (e as Error).message.slice(0, 240); }
      atomicJson(statePath, state);
    }
    return { delivered, pending };
  } finally { unlock(); }
}
