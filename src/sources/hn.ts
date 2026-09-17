import type { HarvestItem } from "../types.js";
import { sha1, fetchWithTimeout, log } from "../util.js";

interface HnConfig {
  queries: string[];
  minPoints: number;
  windowHours: number;
}

interface AlgoliaHit {
  objectID: string;
  title: string;
  url: string | null;
  points: number;
  created_at: string;
  story_text: string | null;
}

export async function fetchHn(cfg: HnConfig): Promise<HarvestItem[]> {
  const since = Math.floor(Date.now() / 1000) - cfg.windowHours * 3600;
  // Algolia has no boolean OR in the query string — run one simple query per term and merge.
  const hitsById = new Map<string, AlgoliaHit>();
  for (const query of cfg.queries) {
    const params = new URLSearchParams({
      query,
      tags: "story",
      numericFilters: `points>${cfg.minPoints},created_at_i>${since}`,
      hitsPerPage: "30",
    });
    const res = await fetchWithTimeout(`https://hn.algolia.com/api/v1/search?${params}`);
    if (!res.ok) throw new Error(`HN Algolia ${res.status}`);
    const data = (await res.json()) as { hits: AlgoliaHit[] };
    for (const h of data.hits) hitsById.set(h.objectID, h);
  }
  log(`HN: ${hitsById.size} unique hits across ${cfg.queries.length} queries`);
  return [...hitsById.values()].map((h) => {
    const url = h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`;
    return {
      id: sha1(url),
      source: "hn" as const,
      title: h.title,
      url,
      score: h.points,
      publishedAt: h.created_at,
      repo: null,
      summary: (h.story_text ?? "").replace(/<[^>]+>/g, "").slice(0, 500),
    };
  });
}
