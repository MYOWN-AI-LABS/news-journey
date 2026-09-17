// arXiv sourcing for the "Research Digest" edition. Fetches recent papers from arXiv RSS for the
// configured categories, then has the configured model pick the most significant papers and
// write 2-sentence why-it-matters summaries. URLs are the arXiv abs links from the feed (real +
// live) — Claude must reuse them verbatim, never invent one.
import Parser from "rss-parser";
import { modelJson } from "../llm/model.js";
import { checkUrls } from "../validate.js";
import { recentEntries } from "../state/ledger.js";
import type { ResearchResult } from "./research.js";
import { log } from "../util.js";

interface Candidate {
  title: string;
  url: string;
  abstract: string;
  isQuantum: boolean;
}

async function fetchCategory(cat: string): Promise<Candidate[]> {
  const parser = new Parser({ timeout: 20_000, headers: { "User-Agent": "Mozilla/5.0 (Example Signal research desk)" } });
  // arXiv's daily RSS (rss.arxiv.org) is EMPTY on weekends/holidays (no announcements that day). Use
  // the API sorted by submittedDate so we always pull the MOST RECENT papers, any day of the week.
  const feed = await parser.parseURL(`https://export.arxiv.org/api/query?search_query=cat:${cat}&sortBy=submittedDate&sortOrder=descending&max_results=25`);
  return (feed.items ?? []).slice(0, 25).map((it) => ({
    title: (it.title ?? "").replace(/\s+/g, " ").trim(),
    url: (it.link ?? (it as { id?: string }).id ?? "").trim(),
    abstract: (it.contentSnippet ?? (it as { content?: string }).content ?? (it as { summary?: string }).summary ?? "").replace(/\s+/g, " ").trim(),
    isQuantum: cat === "quant-ph",
  }));
}

const SELECT_PROMPT = (aiN: number, qN: number, candJson: string, today: string, covered: string[]) => `You are the research editor for "Example Signal," an independent technical newsletter. From these recent arXiv papers (week ending ${today}), pick the ${aiN} most significant AI/ML papers AND the ${qN} most significant quantum (quant-ph) papers for a PRACTITIONER audience — substantive, likely-impactful work, not incremental tweaks.
${covered.length ? `
Prior delivery headlines below are context only, not verified publication. Shared vocabulary, an entity or a URL never establishes duplicate news; retain distinct events and new developments for the later evidence-based event check:
${covered.map((h) => `- ${h}`).join("\n")}
` : ""}
For each chosen paper: keep its EXACT url from the list (never invent or edit a URL), write a punchy 4-8 word headline, and a 2-sentence summary (what it shows + why it matters to people building with AI). Weights: exactly ONE "lead" (the single most important), then "standard", "standard", "quick". suggestedScene: "news_card".

Candidates (title, url, isQuantum, abstract):
${candJson}

Respond with ONLY this JSON:
{
  "dayHeadline": "punchy 5-9 word headline for the digest",
  "angle": "one sentence: the throughline",
  "stories": [
    { "headline": "4-8 words", "summary": "2 sentences", "weight": "lead|standard|quick", "primaryUrl": "<exact url from the list>", "suggestedScene": "news_card" }
  ]
}`;

export async function arxivResearch(
  cfg: { categories: string[]; aiCount: number; quantumCount: number },
  today: string
): Promise<ResearchResult> {
  log(`arxiv: fetching ${cfg.categories.join(", ")}...`);
  const all: Candidate[] = [];
  for (const cat of cfg.categories) {
    try {
      all.push(...(await fetchCategory(cat)));
    } catch (e) {
      log(`arxiv: ${cat} fetch failed (${(e as Error).message})`);
    }
  }
  if (all.length === 0) throw new Error("arxiv: no papers fetched from any category");

  const seen = new Set<string>();
  const cands = all.filter((c) => c.url && !seen.has(c.url) && seen.add(c.url));
  const allowed = new Set(cands.map((c) => c.url));
  const compact = cands.map((c) => ({ title: c.title, url: c.url, isQuantum: c.isQuantum, abstract: c.abstract.slice(0, 280) }));
  const need = cfg.aiCount + cfg.quantumCount;
  const covered = recentEntries(30).filter(e => e.status === "posted").map((e) => e.headline).filter(Boolean); // Legacy delivery context only; exact memory receipts govern exclusions.
  log(`arxiv: ${cands.length} candidate papers → selecting top ${need} (considering ${covered.length} historical headlines)`);

  const res = await modelJson<ResearchResult>(
    SELECT_PROMPT(cfg.aiCount, cfg.quantumCount, JSON.stringify(compact, null, 1), today, covered),
    (r) => {
      if (!r?.dayHeadline || !Array.isArray(r.stories) || r.stories.length < need) return `need at least ${need} stories`;
      if (r.stories.filter((s) => s.weight === "lead").length !== 1) return "exactly one story must be 'lead'";
      for (const s of r.stories) {
        if (!s?.headline || !s?.summary || !s?.primaryUrl) return "each story needs headline, summary, primaryUrl";
        if (!allowed.has(s.primaryUrl)) return `primaryUrl must be a provided arXiv URL (verbatim): ${s.primaryUrl}`;
      }
      return null;
    }
  );
  res.stories = res.stories.slice(0, need).map((s) => ({ ...s, suggestedScene: "news_card" as const }));

  // The model validator is synchronous (URL must be a provided arXiv link); confirm liveness too.
  // arXiv abs links are usually fine, but a transient pull or a withdrawn paper can 404 — never ship one.
  const checks = await checkUrls(res.stories.map((s) => ({ url: s.primaryUrl, context: s.headline })));
  const isBotBlock = (status: number | string) => [401, 403, 429].includes(status as number);
  const dead = checks.filter((c) => !c.ok && !isBotBlock(c.status)).map((c) => c.url);
  if (dead.length) throw new Error(`arxiv: dead/unreachable primaryUrl(s), refusing to ship: ${dead.join(", ")}`);

  return res;
}
