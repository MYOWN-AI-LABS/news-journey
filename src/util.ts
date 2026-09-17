import { activeRoot, contained, isWorkspace, currentActor, loadWorkspaceEnv } from "./workspaces.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

loadWorkspaceEnv();
export const DATA_ROOT = activeRoot();
if (isWorkspace(DATA_ROOT)) currentActor(DATA_ROOT);
export const WORKDIR = contained(DATA_ROOT, "workdir");
export const VIDEOS_DIR = contained(DATA_ROOT, "workdir/videos");
export const HARVEST_DIR = contained(DATA_ROOT, "workdir/harvest");
export const STATE_DIR = contained(DATA_ROOT, "state");
export const CONFIG_DIR = contained(DATA_ROOT, "config");

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 5)
    .join("-");
}

export function todayStamp(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function readJson<T>(path: string, fallback?: T): T {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing file: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

export function videoDir(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(id)) throw new Error("Invalid video id");
  return contained(DATA_ROOT, "workdir", "videos", id);
}

export function loadConfig<T>(name: string): T {
  return readJson<T>(join(CONFIG_DIR, `${name}.json`));
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    // Calendar/detail pages often identify different stories in the query. Dropping EID
    // made all events on one city's Calendar.aspx look like the same already-used story.
    const identity = [...u.searchParams].filter(([key]) => /^(eid|event_?id|article_?id|story_?id|id|p)$/i.test(key));
    u.search = "";
    const base = u.toString().replace(/\/$/, "");
    for (const [key, value] of identity.sort(([a], [b]) => a.localeCompare(b))) u.searchParams.append(key.toLowerCase(), value);
    return (base + u.search).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 15000): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

export function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
