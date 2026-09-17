import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { VideoMeta } from "../types.js";
import { CONFIG_DIR, STATE_DIR, readJson, writeJson, videoDir, log } from "../util.js";

export interface EditionConfig {
  editionId: string;
  displayName: string;
  /** Optional spoken publication name; otherwise use the configured publisher publication. */
  spokenName?: string;
  newsletterTitle: string | null;
  badge: string | null;
  videoAccent: string;
  coverFile: string;
  newsletterLine: string;
  wordBudget: { min: number; max: number } | null;
  speedFactor: number | null;
  cadence: { weekday: number } | null;
  prompt: string | null;
  source?: "harvest" | "web" | "arxiv";
  researchBrief?: string;
  arxiv?: { categories: string[]; aiCount: number; quantumCount: number };
  repoRadar?: boolean;
  newsletterSignals?: boolean;
  introClip?: string | null;
  introDurationSec?: number;
}

const EDITIONS_DIR = join(CONFIG_DIR, "editions");
const DEFAULT_EDITION = "daily-roundup";

function validateEdition(value: unknown, sourcePath: string): EditionConfig {
  if (!value || typeof value !== "object") throw new Error(sourcePath + ": edition must be an object");
  const item = value as Record<string, unknown>;
  for (const key of ["editionId", "displayName", "videoAccent", "coverFile", "newsletterLine"]) {
    if (typeof item[key] !== "string" || !(item[key] as string).trim()) throw new Error(sourcePath + ": missing " + key);
  }
  const budget = item.wordBudget;
  if (item.spokenName !== undefined && (typeof item.spokenName !== 'string' || !item.spokenName.trim() || item.spokenName.length > 120 || /[<>\x00-\x1f]/.test(item.spokenName))) throw new Error(sourcePath + ': spokenName must be plain text of at most 120 characters');
  if (budget !== null) {
    if (!budget || typeof budget !== "object") throw new Error(sourcePath + ": wordBudget must be null or {min,max}");
    const typed = budget as Record<string, unknown>;
    if (typeof typed.min !== "number" || typeof typed.max !== "number" || typed.min <= 0 || typed.max < typed.min) {
      throw new Error(sourcePath + ": invalid wordBudget");
    }
  }
  if (item.source !== undefined && !["harvest", "web", "arxiv"].includes(String(item.source))) {
    throw new Error(sourcePath + ": source must be harvest, web, or arxiv");
  }
  return value as EditionConfig;
}

export function loadEdition(editionId: string | null | undefined): EditionConfig {
  const id = editionId || DEFAULT_EDITION;
  const sourcePath = join(EDITIONS_DIR, id + ".json");
  if (!existsSync(sourcePath)) {
    if (id !== DEFAULT_EDITION) throw new Error("edition " + id + " not found: " + sourcePath);
    const defaultPath = join(EDITIONS_DIR, DEFAULT_EDITION + ".json");
    const edition = validateEdition(readJson<unknown>(defaultPath), defaultPath);
    if (edition.editionId !== DEFAULT_EDITION) throw new Error(defaultPath + ": editionId must match filename");
    return edition;
  }
  const edition = validateEdition(readJson<unknown>(sourcePath), sourcePath);
  if (edition.editionId !== id) throw new Error(sourcePath + ": editionId must match filename");
  return edition;
}

export function resolveEdition(cliArg?: string | null, today: Date = new Date()): EditionConfig {
  if (cliArg) return loadEdition(cliArg);
  if (existsSync(EDITIONS_DIR)) {
    const weekday = today.getDay();
    for (const file of readdirSync(EDITIONS_DIR)) {
      if (!file.endsWith(".json")) continue;
      const edition = loadEdition(file.slice(0, -5));
      if (edition.editionId !== DEFAULT_EDITION && edition.cadence?.weekday === weekday) {
        log("edition: cadence match - " + edition.editionId);
        return edition;
      }
    }
  }
  return loadEdition(DEFAULT_EDITION);
}

export function claimEditionSerial(editionId: string): number {
  loadEdition(editionId);
  const ledgerPath = join(STATE_DIR, "ledger.json");
  const ledger = readJson<{ entries: unknown[]; editionSerials?: Record<string, number> }>(ledgerPath, { entries: [] });
  ledger.editionSerials = ledger.editionSerials ?? {};
  const serial = (ledger.editionSerials[editionId] ?? 0) + 1;
  ledger.editionSerials[editionId] = serial;
  writeJson(ledgerPath, ledger);
  return serial;
}

export function editionForVideo(id: string): EditionConfig {
  const metaPath = join(videoDir(id), "meta.json");
  const meta = existsSync(metaPath) ? readJson<VideoMeta>(metaPath) : null;
  return loadEdition(meta?.edition);
}

export function resolveTitle(edition: EditionConfig, subject: string, serial?: number): string {
  const publication = (edition.newsletterTitle || "Example Signal").replace("{n}", serial != null ? String(serial) : "").replace(/\s+/g, " ").trim();
  // The published title must contain the reviewed issue subject for the exact-issue live gate.
  return publication.includes(subject) ? publication : `${publication} — ${subject}`;
}

export function resolveBadge(edition: EditionConfig, serial?: number): string | null {
  if (!edition.badge) return null;
  return edition.badge.replace("{n}", serial != null ? String(serial) : "").replace(/\s+/g, " ").trim();
}
