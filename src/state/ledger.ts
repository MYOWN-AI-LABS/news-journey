import { join } from "node:path";
import type { HarvestItem, Ledger, LedgerEntry } from "../types.js";
import { STATE_DIR, readJson, writeJson } from "../util.js";

const LEDGER_PATH = join(STATE_DIR, "ledger.json");

export function loadLedger(): Ledger {
  return readJson<Ledger>(LEDGER_PATH, { entries: [] });
}

export function saveLedger(ledger: Ledger): void {
  writeJson(LEDGER_PATH, ledger);
}

export function addEntry(entry: LedgerEntry): void {
  const ledger = loadLedger();
  ledger.entries.push(entry);
  saveLedger(ledger);
}

export function updateEntry(id: string, patch: Partial<LedgerEntry>): void {
  const ledger = loadLedger();
  const e = ledger.entries.find((x) => x.id === id);
  if (e) {
    Object.assign(e, patch);
    saveLedger(ledger);
  }
}

export function recentEntries(days: number): LedgerEntry[] {
  const cutoff = Date.now() - days * 86400_000;
  return loadLedger().entries.filter((e) => new Date(e.coveredAt).getTime() > cutoff);
}

/** Harvest metadata cannot establish event identity. Published event comparisons occur after
 * complete source evidence is available; shared URLs/repositories alone never suppress a story. */
export function filterCovered(items: HarvestItem[], _days: number): HarvestItem[] {
  return [...items];
}
