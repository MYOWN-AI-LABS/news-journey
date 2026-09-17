import { releaseProfile } from './release-profile.js';
import { existsSync, readFileSync, readdirSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { CODE_ROOT, contained, desks, read } from "./workspaces.js";
import { attributionCounts } from "./attribution.js";

export function usageSummary(root: string) {
  const file = contained(root, 'state/model-calls.jsonl');
  const rows: { at: string; provider: string; model: string; inputTokens: number | null; outputTokens: number | null; reportedCostUsd: number | null }[] = [];
  const amount = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  let tail = '', truncated = false;
  if (existsSync(file)) {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size, length = Math.min(size, 1024 * 1024), bytes = Buffer.alloc(length);
      const count = readSync(fd, bytes, 0, length, size - length);
      tail = bytes.subarray(0, count).toString('utf8'); truncated = size > length;
      if (truncated) tail = tail.includes('\n') ? tail.slice(tail.indexOf('\n') + 1) : ''; // discard the partial first receipt
    } finally { closeSync(fd); }
  }
  for (const line of tail.trim().split('\n').slice(-1000)) {
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || typeof row.at !== 'string') continue;
      rows.push({ at: row.at.slice(0, 40), provider: String(row.provider || 'Unknown').slice(0, 100), model: String(row.model || 'Unknown').slice(0, 200), inputTokens: amount(row.usage?.input_tokens ?? row.usage?.prompt_tokens), outputTokens: amount(row.usage?.output_tokens ?? row.usage?.completion_tokens), reportedCostUsd: amount(row.reportedCostUsd) });
    } catch { /* incomplete or malformed receipt */ }
  }
  const measured = rows.filter(r => r.reportedCostUsd !== null);
  return { recordedCalls: rows.length, reportedCostUsd: measured.length ? measured.reduce((sum, r) => sum + r.reportedCostUsd!, 0) : null, unpricedCalls: rows.length - measured.length, rows: rows.slice(-20).reverse(), scope: (truncated ? 'Latest complete receipts within the last 1 MiB, at most 1,000 calls. ' : 'Latest 1,000 recorded writing-model calls. ') + ' Provider-reported costs are not invoices. Agent subscriptions, conversation, voice, avatar, rendering and tunnel charges are not metered here.' };
}

export function controlEvents(root: string): Record<string, unknown>[] {
  const paths: string[] = [];
  const videos = contained(root, "workdir/videos");
  if (existsSync(videos)) for (const id of readdirSync(videos)) if (/^[a-zA-Z0-9][\w-]{0,159}$/.test(id)) paths.push(contained(root, "workdir/videos", id, "delivery-events.jsonl"));
  paths.push(contained(root, "workdir/newsletters/delivery-events.jsonl"));
  const out: Record<string, unknown>[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) try { const event = JSON.parse(line); if (event && typeof event === "object" && typeof event.type === "string") out.push(event); } catch { /* incomplete final line */ }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
let fixtureIds: Set<string> | undefined;
/**
 * A dry-run stops at "selected" by design, so its package is never something to review. a beta tester (Sep 10) was shown the
 * "Example: a verifiable tooling update" fixture as her package after her own attempt failed. New dry-runs are marked;
 * older ones on testers' machines are recognised by the shipped fixture ids — only while still "selected", because
 * `example:tour` / `example:teaser` produce real packages under the same ids.
 */
export function isDryRunLeftover(id: string, meta: { status?: string; dryRun?: boolean }): boolean {
  if (meta.status !== "selected") return false;
  fixtureIds ??= new Set((existsSync(join(CODE_ROOT, "examples/fixtures")) ? readdirSync(join(CODE_ROOT, "examples/fixtures")) : []).filter(n => n.endsWith(".json")).map(n => read<{ id?: string }>(join(CODE_ROOT, "examples/fixtures", n), {}).id).filter((v): v is string => typeof v === "string"));
  return meta.dryRun === true || fixtureIds.has(id);
}
export function controlState(root: string) {
  const dir = contained(root, "workdir/videos");
  const events = controlEvents(root);
  const config = read<Record<string, { enabled?: boolean }>>(contained(root, "config/platforms.json"), {});
  const assignments = desks(root);
  const videos = (existsSync(dir) ? readdirSync(dir) : []).filter((id) => /^[a-zA-Z0-9][\w-]{0,159}$/.test(id)).flatMap((id) => {
    const meta = read<Record<string, any> | null>(contained(root, "workdir/videos", id, "meta.json"), null);
    if (!meta || meta.id !== id || isDryRunLeftover(id, meta)) return [];
    const edition = meta.edition ?? "daily-roundup";
    const desk = Object.keys(assignments).find((key) => assignments[key].editions.includes(edition)) ?? null;
    const delivery: Record<string, unknown> = {};
    for (const event of events) if (event.videoId === id && typeof event.platform === "string" && event.outcome) delivery[event.platform] = event.outcome;
    const required = Object.keys(config).filter((p) => config[p]?.enabled && (!desk || assignments[desk].channels.includes(p)) && (!Array.isArray(meta.intendedPlatforms) || meta.intendedPlatforms.includes(p)));
    return [{ id, headline: meta.headline ?? id, edition, desk, status: meta.status, createdAt: meta.createdAt, updatedAt: meta.updatedAt, durationSec: meta.durationSec, createdBy: meta.createdBy, approvedBy: meta.approvedBy, held: Boolean(meta.reviewHold), uncertain: required.filter((p) => existsSync(contained(root, "workdir/videos", id, `.delivery-${p}.json`))), posts: meta.posts ?? {}, delivery, missing: required.filter((p) => !meta.posts?.[p]) }];
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const byStatus: Record<string, number> = {};
  for (const v of videos) byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
  const nl = contained(root, "workdir/newsletters");
  const names = existsSync(nl) ? readdirSync(nl).filter((s) => /^\d{4}-\d{2}-\d{2}(?:-[a-z0-9-]+)?\.md$/.test(s)).sort() : [];
  const latestNewsletter = names.at(-1);
  const harvest = contained(root, "workdir/harvest");
  const harvests = existsSync(harvest) ? readdirSync(harvest).filter((s) => /^[\w.-]+\.json$/.test(s)).sort() : [];
  const lastHarvest = harvests.at(-1);
  const harvestCount = lastHarvest ? read<{ items?: unknown[] }>(contained(root, "workdir/harvest", lastHarvest), {}).items?.length ?? 0 : 0;
  return {
    generatedAt: new Date().toISOString(), workspace: read<{ id: string; name: string }>(contained(root, "workspace.json"), { id: "legacy", name: "Default publication" }),
    videos, byStatus, desks: assignments, platforms: config, harvestCount,
    newsletter: latestNewsletter ? { file: latestNewsletter, text: readFileSync(contained(root, "workdir/newsletters", latestNewsletter), "utf8") } : null,
    verification: read(contained(root, "workdir/verify-distribution.json"), null),
    analytics: releaseProfile().edition === "free" ? { schemaVersion: 1, snapshots: [], available: false, reason: "Audience analytics is planned for Pro." } : read(contained(root, "state/analytics-snapshots.json"), { schemaVersion: 1, snapshots: [] }),
    costs: usageSummary(root),
    attribution: { metric: "redirect requests (not unique people or impressions)", counts: releaseProfile().edition === "free" ? {} : attributionCounts(root) },
  };
}
