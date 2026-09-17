// Headless web research adapter for configured special editions.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SceneKind, SelectionAreas, StoryWeight, Topic, TopicStory, VideoMeta } from "../types.js";
import { writeJson, readJson, videoDir, slugify, todayStamp, loadConfig, log } from "../util.js";
import { checkUrls } from "../validate.js";
import { recentEntries, addEntry } from "../state/ledger.js";
import { normalizeUrl } from "../util.js";
import { configuredModelRuntime, invokeClaudeWebText } from "../llm/model.js";
import { claimEditionSerial, loadEdition } from "./edition.js";
import { selectionClassificationProblem, duplicatePrincipalEntity, selectionPolicy } from "./selection-policy.js";
import type { SourcePreferencesConfig } from "../source-preferences.js";

/** Legacy accepted-delivery context; it does not establish verified event coverage. */
function coveredContext(days = 30): { headlines: string[]; urls: Set<string> } {
  const recent = recentEntries(days).filter(entry => entry.status === "posted");
  return {
    headlines: recent.map((e) => e.headline).filter(Boolean),
    urls: new Set(recent.flatMap((e) => e.urls.map(normalizeUrl))),
  };
}
import type { EditionConfig } from "./edition.js";

export interface ResearchStory {
  headline: string;
  summary: string;
  weight: StoryWeight;
  primaryUrl: string;
  suggestedScene: SceneKind;
  principalEntity: string;
  area: string;
  verticals: string[];
}
export interface ResearchResult {
  dayHeadline: string;
  angle: string;
  stories: ResearchStory[];
}


const AGGREGATOR_RE = /news\.ycombinator\.com|hn\.algolia\.com|google\.com\/search|\/search\?/i;

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error("No JSON in research output");
  const close = text[start] === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  if (end <= start) throw new Error("Unbalanced JSON in research output");
  return text.slice(start, end + 1);
}

function validate(r: ResearchResult, areas?: SelectionAreas): string | null {
  if (!r?.dayHeadline || !r?.angle) return "missing dayHeadline/angle";
  if (!Array.isArray(r.stories) || r.stories.length !== 4) return "need exactly 4 stories relevant to the configured brief";
  if (r.stories.filter((s) => s.weight === "lead").length !== 1) return "exactly one story must be weight 'lead'";
  for (const s of r.stories) {
    if (!s?.headline || !s?.summary || !s?.primaryUrl) return "each story needs headline, summary, primaryUrl";
    if (!/^https?:\/\//.test(s.primaryUrl)) return `primaryUrl must be http(s): ${s.primaryUrl}`;
    if (AGGREGATOR_RE.test(s.primaryUrl)) return `primaryUrl must be a primary source, not an aggregator/search: ${s.primaryUrl}`;
    if (!["lead", "standard", "quick"].includes(s.weight)) return `invalid weight: ${s.weight}`;
    const classificationProblem = selectionClassificationProblem(s, areas);
    if (classificationProblem) return classificationProblem;
  }
  const duplicate = duplicatePrincipalEntity(r.stories);
  if (duplicate) return `entity diversity violation: multiple stories concern ${duplicate}; select at most one story per principal entity`;
  return null;
}

/** Liveness-check every chosen story's primaryUrl (shape validation can't catch a hallucinated
 *  or dead URL). 401/403/429 = bot-block = PASS; 404/410/unreachable = FAIL. Returns the list of
 *  dead URLs (empty = all live). The LLM-supplied URL is never trusted to resolve without this. */
async function deadStoryUrls(r: ResearchResult): Promise<string[]> {
  const results = await checkUrls(r.stories.map((s) => ({ url: s.primaryUrl, context: s.headline })));
  const isBotBlock = (status: number | string) => [401, 403, 429].includes(status as number);
  return results.filter((c) => !c.ok && !isBotBlock(c.status)).map((c) => c.url);
}

const PROMPT = (brief: string, today: string, covered: string[], policy: string) => `You are the research desk for "Example Signal," an independent technical newsletter. Use web search to find, for the week ending ${today}: ${brief}

${policy}
${covered.length ? `
Prior delivery context (not verified publication) — shared words, entity, repository or URL do not establish duplicate news. Keep distinct events and material developments eligible; a later evidence-based event comparison decides duplicates:
${covered.map((h) => `- ${h}`).join("\n")}
` : ""}
Pick exactly FOUR items. Requirements per item:
- A VERIFIED, LIVE primary-source URL (vendor announcement, official blog/docs, the paper/report, or the repo) — NOT an aggregator, search page, or secondary re-report. Open it to confirm it resolves.
- A 2-sentence summary: what it is + why it matters to the reader.
- Weight: exactly ONE "lead" (the single biggest), then "standard", "standard", "quick".
- suggestedScene: "news_card".
- principalEntity: the principal company, lab, project, or team.
- area: exactly one of the focus areas listed above.
- verticals: one or more of the verticals listed above.
The 4 must be substantially different, and no two may share the same principalEntity.

Respond with ONLY this JSON (no prose):
{
  "dayHeadline": "punchy 5-9 word headline for the week",
  "angle": "one sentence: the week's throughline",
  "stories": [
    { "headline": "4-8 words", "summary": "2 sentences", "weight": "lead|standard|quick", "primaryUrl": "https://...", "suggestedScene": "news_card", "principalEntity": "...", "area": "...", "verticals": ["..."] }
  ]
}`;

/** Headless web-search research for a given brief (returns 4 verified stories). One retry on invalid output. */
export async function researchViaWeb(brief: string, today: string): Promise<ResearchResult> {
  const runtime = configuredModelRuntime();
  if (runtime.provider !== "claude") {
    throw new Error(`source=web requires Claude CLI WebSearch/WebFetch; configured provider is ${runtime.provider}. Use harvest, arxiv, or a topic fixture.`);
  }
  const { headlines: covered } = coveredContext();
  const areas = loadConfig<SourcePreferencesConfig>("sources").editorial?.areas;
  const policy = selectionPolicy(areas);
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`research: claude -p web search (attempt ${attempt}, considering ${covered.length} historical headlines)...`);
    const base = PROMPT(brief, today, covered, policy);
    const prompt = attempt === 1 ? base : `${base}\n\nYour previous response was invalid: ${lastErr}\nRespond with ONLY the corrected JSON.`;
    const raw = await invokeClaudeWebText(prompt);
    try {
      const parsed = JSON.parse(extractJson(raw)) as ResearchResult;
      const problem = validate(parsed, areas);
      if (problem) { lastErr = problem; continue; }
      // A source URL can host a new release, result or correction. Do not exclude it
      // from research before complete event evidence exists.

      // validate() is shape-only; confirm each chosen URL actually resolves before trusting it
      const dead = await deadStoryUrls(parsed);
      if (dead.length) { lastErr = `dead/unreachable primaryUrl(s): ${dead.join(", ")}`; log(`research: ${lastErr}`); continue; }
      log(`research: "${parsed.dayHeadline}" (${parsed.stories.length} stories)`);
      return parsed;
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  throw new Error(`research failed after retry: ${lastErr}`);
}

/** Dispatch sourcing by edition: arXiv API for source:"arxiv", else headless web research. */
export async function sourceEdition(edition: EditionConfig, today: string): Promise<ResearchResult> {
  const configured = loadEdition(edition.editionId);
  if (configured.source === "arxiv" && configured.arxiv) {
    const { arxivResearch } = await import("./arxiv.js");
    return arxivResearch(configured.arxiv, today);
  }
  return researchViaWeb(configured.researchBrief ?? configured.prompt ?? "the most important verified developments relevant to this edition", today);
}

/** Build an edition-tagged roundup topic and metadata from a research result. */
export function buildEditionTopic(r: ResearchResult, editionId: string): Topic {
  loadEdition(editionId);
  const id = `${todayStamp().replace(/-/g, "")}-${editionId}-${slugify(r.dayHeadline)}`;
  const dir = videoDir(id);
  const metaPath = join(dir, "meta.json");
  const isNew = !existsSync(metaPath);
  const serial = isNew
    ? claimEditionSerial(editionId)
    : readJson<VideoMeta>(metaPath).editionSerial ?? claimEditionSerial(editionId);
  const stories: TopicStory[] = r.stories.map((s, i) => ({ ...s, n: i + 1, assetRef: `og-${i}`, repo: null }));
  const topic: Topic = {
    id, kind: "roundup", headline: r.dayHeadline, angle: r.angle,
    sourceItems: [], primaryUrl: stories[0].primaryUrl, repo: null, alternates: [], stories,
  };
  writeJson(join(dir, "topic.json"), topic);
  writeJson(metaPath, {
    id, status: "selected", headline: r.dayHeadline,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    posts: {}, edition: editionId, editionSerial: serial,
  } satisfies VideoMeta);
  // RESERVE this edition's coverage in the shared ledger so the daily AND the other editions
  // can inspect the selected history; only verified event memory permits exclusion. Only on
  // first creation — a re-produce of the same id keeps the single existing entry.
  if (isNew) {
    addEntry({
      id, headline: r.dayHeadline, urls: stories.map((s) => s.primaryUrl), repo: null,
      coveredAt: new Date().toISOString(), status: "selected", posts: {},
    });
  }
  return topic;
}
