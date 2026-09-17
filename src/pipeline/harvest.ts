import { join } from "node:path";
import type { HarvestFile, HarvestItem } from "../types.js";
import { fetchHn } from "../sources/hn.js";
import { fetchGithubTrending } from "../sources/github-trending.js";
import { fetchRss } from "../sources/rss.js";
import { fetchWebSources, type WebSource } from "../sources/web-discovery.js";
import { fetchConfiguredPublicApis, type PublicApisConfig } from "../sources/public-apis.js";
import {
  filterExcludedTopics,
  getEnabledSources,
  type SourceId,
  type SourcePreferencesConfig,
} from "../source-preferences.js";
import { HARVEST_DIR, loadConfig, todayStamp, writeJson, log } from "../util.js";

interface SourcesConfig extends SourcePreferencesConfig {
  hn: Parameters<typeof fetchHn>[0];
  githubTrending: Parameters<typeof fetchGithubTrending>[0];
  rss: { name: string; url: string }[];
  publicApis?: PublicApisConfig;
  webSources?: WebSource[];
}

export async function harvest(): Promise<string> {
  const cfg = loadConfig<SourcesConfig>("sources");
  const enabled = getEnabledSources(cfg);
  if (enabled.has("publicApis") && !cfg.publicApis?.endpoints?.length) {
    throw new Error("publicApis is enabled but config/sources.json publicApis.endpoints is empty");
  }
  const allSources: { id: SourceId; run: () => Promise<HarvestItem[]> }[] = [
    { id: "hn", run: () => fetchHn(cfg.hn) },
    { id: "githubTrending", run: () => fetchGithubTrending(cfg.githubTrending) },
    { id: "rss", run: () => fetchRss(cfg.rss) },
    { id: "publicApis", run: () => fetchConfiguredPublicApis(cfg.publicApis!) },
    { id: "web", run: () => fetchWebSources(cfg.webSources || []) },
  ];
  const sources = allSources.filter((source) => enabled.has(source.id));
  log(`Enabled sources: ${sources.map((source) => source.id).join(", ")}`);
  // Retry the whole fetch with bounded backoff so a transient network failure is observable.
  const backoffsS = sources.every(s => s.id === 'web') ? [] : [20, 45, 90];
  let items: HarvestItem[] = [];
  for (let attempt = 0; ; attempt++) {
    const results = await Promise.allSettled(sources.map((source) => source.run()));
    items = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") items.push(...r.value);
      else log(`Source ${sources[i].id} failed: ${r.reason?.message ?? r.reason}`);
    });
    if (items.length > 0 || attempt >= backoffsS.length) break;
    const wait = backoffsS[attempt];
    log(`Harvest empty — all sources failed (attempt ${attempt + 1}/${backoffsS.length + 1}); retrying in ${wait}s…`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  if (items.length === 0) throw new Error(`All sources failed after ${backoffsS.length + 1} attempts — nothing harvested`);

  const fetchedCount = items.length;
  items = filterExcludedTopics(items, cfg.editorial);
  if (items.length !== fetchedCount) log(`Editorial exclusions removed ${fetchedCount - items.length} harvested items`);
  if (items.length === 0) throw new Error("No harvested items remain after applying editorial exclusions");

  // Merge duplicates (same story on HN + RSS): keep highest-score copy
  const byId = new Map<string, HarvestItem>();
  for (const it of items) {
    const prev = byId.get(it.id);
    if (!prev || it.score > prev.score) byId.set(it.id, it);
  }

  const out: HarvestFile = { fetchedAt: new Date().toISOString(), items: [...byId.values()] };
  const path = join(HARVEST_DIR, `${todayStamp()}.json`);
  writeJson(path, out);
  log(`Harvested ${out.items.length} unique items → ${path}`);
  return path;
}
