import { currentActor } from "../workspaces.js";
/**
 * Append-only delivery events (distribution kernel, Stage 2).
 *
 * Why: the only per-destination state used to be `meta.posts[platform]` on success. A hold, a skip
 * and a hard failure all left the same trace — one log line — so "why didn't X post?" had to be
 * reconstructed from logs. Each transition now lands as one JSON line in `delivery-events.jsonl`
 * beside meta.json, and the latest outcome per platform is projected into `meta.delivery`.
 *
 * Authority rule: this log RECORDS delivery; it never grants it. Nothing here may release a hold,
 * change content, or treat an accepted receipt as proof the post is live. `meta.posts` remains the
 * idempotence/completion record — this is a projection beside it.
 *
 * NEVER-THROW: a failed log write must not turn a LIVE post into an unrecorded one (the caller
 * writes meta.posts right after recording) or make approve() fail after the approval already
 * landed on disk. Every write here is wrapped; a failure is logged and swallowed.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Platform, PublishOutcome, VideoMeta } from "../types.js";
import { log } from "../util.js";

export const DELIVERY_EVENTS_FILE = "delivery-events.jsonl";

export type DeliveryEventType =
  | "release.approved"   // review/queue.approve marked the video approved
  | "release.withheld"   // a gate in postApproved held the whole release; `reason` says which
  | "platform.skipped"   // destination not in scope this run (disabled in config)
  | "platform.accepted"  // poster returned a provider id — UNCONFIRMED until independently probed
  | "platform.verified"  // emitted only by an independent live probe
  | "platform.failed";   // poster threw; `outcome.retryable` says whether a re-run may try again

export interface DeliveryEvent {
  type: DeliveryEventType;
  videoId: string;
  at: string;
  pid: number;
  actor?: { id: string; role: string };
  platform?: Platform;
  outcome?: PublishOutcome;
  reason?: string;
  detail?: Record<string, unknown>;
}

type NewEvent = Omit<DeliveryEvent, "at" | "pid"> & { at?: string };

/** Append one event. Returns the event written, or null if the write failed (never throws). */
export function appendDeliveryEvent(dir: string, ev: NewEvent): DeliveryEvent | null {
  try {
    const full: DeliveryEvent = { ...ev, actor: currentActor(), at: ev.at ?? new Date().toISOString(), pid: process.pid };
    // One line per event; appendFileSync of a single short line is the crash-safe append we need.
    appendFileSync(join(dir, DELIVERY_EVENTS_FILE), `${JSON.stringify(full)}\n`);
    return full;
  } catch (e) {
    log(`delivery-events: could not record ${ev.type} for ${ev.videoId} (${(e as Error).message}) — continuing; the log is a record, not a gate`);
    return null;
  }
}

/** Append only if the LAST event differs in type/reason/platform. Used for gates that re-evaluate
 *  on every re-run: a hold that persists stays one line per streak, and a change of reason still
 *  lands as a new line. */
export function appendDeliveryEventIfChanged(dir: string, ev: NewEvent): DeliveryEvent | null {
  const last = readDeliveryEvents(dir).at(-1);
  if (last && last.type === ev.type && last.reason === ev.reason && last.platform === ev.platform) return null;
  return appendDeliveryEvent(dir, ev);
}

/** Missing/unreadable file → []. A torn final line (process killed mid-write) is skipped, not fatal. */
export function readDeliveryEvents(dir: string): DeliveryEvent[] {
  const path = join(dir, DELIVERY_EVENTS_FILE);
  if (!existsSync(path)) return [];
  const out: DeliveryEvent[] = [];
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as DeliveryEvent); } catch { /* torn line — skip */ }
  }
  return out;
}

/** Latest outcome per platform. Release-level events carry no platform and are not projected. */
export function projectOutcomes(events: DeliveryEvent[]): Partial<Record<Platform, PublishOutcome>> {
  const out: Partial<Record<Platform, PublishOutcome>> = {};
  for (const e of events) if (e.platform && e.outcome) out[e.platform] = e.outcome;
  return out;
}

/** Destinations whose LATEST outcome is a failure no re-run can fix without a human — today that
 *  means an expired or revoked grant. Read-only: this NEVER shrinks the caller's notion of which
 *  destinations are still missing, and this projection never skips an attempt; provider-support.ts owns the retry policy. It exists so an operator is told
 *  once per breakage, with the command that fixes it, instead of once per attempt. A later success
 *  clears the block by simply being later. */
export function blockedPlatforms(events: DeliveryEvent[]): Platform[] {
  const latest = projectOutcomes(events);
  return (Object.keys(latest) as Platform[])
    .filter((p) => latest[p]!.state === "failed" && !latest[p]!.retryable);
}

/** An expired/revoked grant is NOT a transient failure: it drops the platform from every run until
 *  a human re-consents, so it is marked not retryable. */
const AUTH_EXPIRED = /invalid_grant|invalid_token|expired or revoked|Invalid Credentials|401|Unauthorized|youtubeSignupRequired|0 channels|expected UC|token exchange 4\d\d|token was invalid/i;

export function classifyFailure(message: string): { retryable: boolean; reason: "auth-expired" | "error" } {
  return AUTH_EXPIRED.test(message) ? { retryable: false, reason: "auth-expired" } : { retryable: true, reason: "error" };
}

/** Append one platform event, then re-project `meta.delivery` from the WHOLE log (in memory — the
 *  caller owns the meta.json write, exactly as it does for `meta.posts`). Re-projecting from the
 *  file, not patching one key, means a concurrent process's events are never overwritten by this
 *  process's stale in-memory view. If the append failed, the projection simply lacks this event. */
export function recordPlatformOutcome(
  dir: string,
  meta: VideoMeta,
  type: Extract<DeliveryEventType, `platform.${string}`>,
  outcome: PublishOutcome,
): void {
  appendDeliveryEvent(dir, { type, videoId: meta.id, platform: outcome.platform, outcome });
  meta.delivery = projectOutcomes(readDeliveryEvents(dir));
}
