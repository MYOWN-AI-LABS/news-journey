import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Curated public feeds (config/source-catalog.json) offered when a brief's topics match a family. */
export interface CatalogFeed { name: string; url: string; covers: string; newsletter?: boolean }
export interface CatalogFamily { id: string; name: string; keywords: string[]; feeds: CatalogFeed[] }

export function readCatalog(codeRoot: string): CatalogFamily[] {
  const path = join(codeRoot, "config/source-catalog.json");
  if (!existsSync(path)) return [];
  const file = JSON.parse(readFileSync(path, "utf8")) as { families?: CatalogFamily[] };
  return Array.isArray(file.families) ? file.families : [];
}

/** Families whose keywords appear in the topics; a keyword matches as a whole word or phrase, case-insensitive. */
export function matchCatalog(families: CatalogFamily[], topics: string[]): CatalogFamily[] {
  const text = " " + topics.join(" ").toLowerCase().replace(/[^a-z0-9 ]+/g, " ") + " ";
  return families.filter(f => f.keywords.some(k => text.includes(" " + k.toLowerCase() + " ")));
}
