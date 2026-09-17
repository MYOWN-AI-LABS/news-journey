import * as cheerio from "cheerio";
import type { HarvestItem, RepoInfo } from "../types.js";
import { matchesAnyTopic } from "../source-preferences.js";
import { sha1, fetchWithTimeout, log } from "../util.js";

interface TrendingConfig {
  since: string[];
  languages: string[];
  relevanceKeywords?: string[];
  searchFallback: { minStars: number; createdWithinDays: number; topics: string[] };
}

function parseCount(s: string): number {
  const t = s.trim().replace(/,/g, "");
  if (t.endsWith("k")) return Math.round(parseFloat(t) * 1000);
  return parseInt(t, 10) || 0;
}

async function scrapeTrending(language: string, since: string): Promise<RepoInfo[]> {
  const url = `https://github.com/trending/${encodeURIComponent(language)}?since=${since}`;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
  });
  if (!res.ok) throw new Error(`GH trending ${res.status}`);
  const $ = cheerio.load(await res.text());
  const repos: RepoInfo[] = [];
  $("article.Box-row").each((_, el) => {
    const $el = $(el);
    const fullName = $el.find("h2 a").attr("href")?.replace(/^\//, "") ?? "";
    if (!fullName) return;
    const description = $el.find("p").text().trim();
    const lang = $el.find('[itemprop="programmingLanguage"]').text().trim();
    const starsText = $el.find('a[href$="/stargazers"]').first().text();
    const todayText = $el.find("span.d-inline-block.float-sm-right").text();
    const stars = parseCount(starsText);
    const starsToday = parseCount(todayText);
    repos.push({
      fullName,
      stars,
      starsToday: starsToday > stars ? undefined : starsToday,
      language: lang || undefined,
      description,
      url: `https://github.com/${fullName}`,
    });
  });
  return repos;
}

async function searchFallback(cfg: TrendingConfig["searchFallback"]): Promise<RepoInfo[]> {
  const created = new Date(Date.now() - cfg.createdWithinDays * 86400_000).toISOString().slice(0, 10);
  const q = `created:>${created} stars:>${cfg.minStars} (${cfg.topics.map((t) => `topic:${t}`).join(" OR ")})`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetchWithTimeout(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`,
    { headers }
  );
  if (!res.ok) throw new Error(`GH search ${res.status}`);
  const data = (await res.json()) as { items: any[] };
  return data.items.map((r) => ({
    fullName: r.full_name,
    stars: r.stargazers_count,
    language: r.language ?? undefined,
    description: r.description ?? "",
    url: r.html_url,
  }));
}

export async function fetchGithubTrending(cfg: TrendingConfig): Promise<HarvestItem[]> {
  const seen = new Set<string>();
  let repos: RepoInfo[] = [];
  try {
    // daily first so its starsToday (stars gained today) wins over weekly's larger window count
    for (const since of cfg.since) {
      for (const lang of cfg.languages) {
        const batch = await scrapeTrending(lang, since);
        for (const r of batch) {
          if (!seen.has(r.fullName)) {
            seen.add(r.fullName);
            repos.push(r);
          }
        }
      }
    }
    log(`GH trending: scraped ${repos.length} repos (${cfg.since.join("+")})`);
  } catch (e) {
    log(`GH trending scrape failed (${(e as Error).message}); using Search API fallback`);
    repos = await searchFallback(cfg.searchFallback);
  }
  return repos
    .filter((r) => !cfg.relevanceKeywords?.length || matchesAnyTopic(`${r.fullName} ${r.description ?? ""}`, cfg.relevanceKeywords))
    .map((r) => ({
      id: sha1(r.url),
      source: "gh-trending" as const,
      title: `${r.fullName}: ${r.description ?? ""}`.slice(0, 200),
      url: r.url,
      score: r.starsToday ?? r.stars,
      publishedAt: null,
      repo: r,
      summary: r.description ?? "",
    }));
}
