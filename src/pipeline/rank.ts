import { activeRoot, currentActor } from "../workspaces.js";
import { storyChoiceRequired } from "../automation.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { HarvestFile, HarvestItem, SceneKind, StoryWeight, Topic, TopicStory, VideoMeta } from "../types.js";
import { modelJson } from "../llm/model.js";
import { filterCovered, addEntry } from "../state/ledger.js";
import { type SourcePreferencesConfig } from "../source-preferences.js";
import { SELECTION_POLICY_ID, assembleSlate, rankCandidates, validateRankingConfig, selectionReportRows, type PickedCandidate, type RankedCandidate, type RankingConfig, type ScoredCandidate } from "./user-ranking.js";
import { HARVEST_DIR, loadConfig, normalizeUrl, readJson, todayStamp, videoDir, writeJson, slugify, log } from "../util.js";

interface PipelineConfig {
  dedupWindowDays: number;
  topicsPerRun: number;
  format: "roundup" | "singles";
  /** alternates: verified next-best stories kept for back-fill and offered for the person's swap (default 2). */
  roundup: { minStories: number; maxStories: number; alternates?: number };
}

/* ---------- shared helpers ---------- */

const AGGREGATOR_RE = /news\.ycombinator\.com|hn\.algolia\.com|google\.com\/search/;

/** LLMs sometimes invent or "clean up" URLs. Never trust one: if the model's
 *  primaryUrl isn't verbatim from the cited source items, substitute a real one
 *  (preferring a non-aggregator link). */
function enforceRealUrl(modelUrl: string, sourceItems: HarvestItem[], label: string): string {
  if (sourceItems.length === 0) return modelUrl;
  const real = sourceItems.map((it) => it.url);
  if (real.some((u) => normalizeUrl(u) === normalizeUrl(modelUrl))) return modelUrl;
  const replacement = real.find((u) => !AGGREGATOR_RE.test(u)) ?? real[0];
  log(`URL guard: "${label}" — model wrote ${modelUrl}, substituting real source ${replacement}`);
  return replacement;
}

const rankingConfig = (): RankingConfig => validateRankingConfig(loadConfig<SourcePreferencesConfig>("sources").ranking);

async function eligibleCandidates(fresh: HarvestItem[]): Promise<ScoredCandidate[]> {
  const { dropDeadCandidates } = await import("./verify-at-selection.js");
  return dropDeadCandidates(rankCandidates(fresh, rankingConfig()));
}

/**
 * A failed or rejected package from an earlier attempt today keeps its receipts and the retry takes the next id
 * (GLM 5.3, Sep 17: "Roundup … already exists" ended a retry from saved stages). A live package with the id is a duplicate.
 */
export function roundupPackageId(base: string): string {
  let id = base;
  for (let n = 2; existsSync(join(videoDir(id), "topic.json")); n++) {
    const status = readJson<Pick<VideoMeta, "status">>(join(videoDir(id), "meta.json"), { status: "selected" }).status;
    if (!status.startsWith("failed") && status !== "rejected") throw new Error(`Roundup ${id} already exists`);
    id = `${base}-${n}`;
  }
  return id;
}

function createVideoWorkdir(topic: Topic, urls: string[], repo: string | null, status: VideoMeta["status"] = "selected"): void {
  const dir = videoDir(topic.id);
  writeJson(join(dir, "topic.json"), topic);
  writeJson(join(dir, "meta.json"), {
    id: topic.id,
    status,
    createdBy: currentActor().id,
    headline: topic.headline,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    posts: {},
  } satisfies VideoMeta);
  // Reserve in ledger at selection time so a concurrent/later run can't re-pick it
  addEntry({
    id: topic.id,
    headline: topic.headline,
    urls,
    repo,
    coveredAt: new Date().toISOString(),
    status: "selected",
    posts: {},
  });
}

/* ---------- roundup mode (default): one video, dynamic top-N weighted stories ---------- */

interface RoundupStoryPick {
  headline: string;
  summary: string;
  weight: StoryWeight;
  sourceItemIds: string[];
  primaryUrl: string;
  suggestedScene: SceneKind;
  principalEntity: string;
  area: string;
  verticals: string[];
  classificationNotes?: string[];
}

interface RoundupResponse {
  dayHeadline: string;
  angle: string;
  stories: RoundupStoryPick[];
  /** Next-best stories, strongest first: back-fill for a pick whose source cannot be read, and the person's swaps. */
  alternates?: RoundupStoryPick[];
}

function candidatePick(item: RankedCandidate, i: number): RoundupStoryPick {
  return { headline: item.title, summary: item.summary, weight: i === 0 ? "lead" : "standard", sourceItemIds: [item.id], primaryUrl: item.url, suggestedScene: "news_card", principalEntity: item.title, area: "other", verticals: ["other"] };
}

async function rankRoundup(fresh: HarvestItem[], cfg: PipelineConfig): Promise<Topic[]> {
  const candidates = await eligibleCandidates(fresh);
  const candidateIds = new Set(candidates.map(c => c.id));
  const citesCandidates = (s: { sourceItemIds: string[] }) => s.sourceItemIds.every(id => candidateIds.has(id));
  const altN = Math.max(0, Math.min(20, cfg.roundup.alternates ?? 2));
  const ordered = candidates.map(candidatePick);
  const resp: RoundupResponse = { dayHeadline: `Roundup ${todayStamp()}: ${ordered[0]?.headline ?? "news"}`, angle: "Stories selected using your configured order.", stories: ordered.slice(0,cfg.roundup.minStories), alternates: ordered.slice(cfg.roundup.minStories,cfg.roundup.minStories+altN) };
  const withRealUrl = (s: RoundupStoryPick) => ({ ...s, primaryUrl: enforceRealUrl(s.primaryUrl, fresh.filter((it) => s.sourceItemIds.includes(it.id)), s.headline) });
  const recommended = resp.stories.slice(0, cfg.roundup.maxStories).map(withRealUrl);
  // Alternates the model offered (plus any picks past maxStories), each held to the same per-story rules; an invalid
  // alternate is dropped here rather than failing the call — they are optional.
  const altProblem = (a: RoundupStoryPick) => !a?.headline || !a?.primaryUrl || !Array.isArray(a.sourceItemIds) || !a.sourceItemIds.length || !citesCandidates(a)
    || !["lead", "standard", "quick"].includes(a.weight) || !["news_card", "repo_card", "stat_chart"].includes(a.suggestedScene)
    || AGGREGATOR_RE.test(a.primaryUrl);
  const alternates = [...resp.stories.slice(cfg.roundup.maxStories), ...(Array.isArray(resp.alternates) ? resp.alternates : [])]
    .filter((a) => !altProblem(a)).map(withRealUrl)
    .filter((a, i, all) => !recommended.some((r) => normalizeUrl(r.primaryUrl) === normalizeUrl(a.primaryUrl)) && all.findIndex((b) => normalizeUrl(b.primaryUrl) === normalizeUrl(a.primaryUrl)) === i)
    .slice(0, altN);

  // Capture and verify before committing any story. Unreadable picks are replaced from this same pool.
  const { verifyCandidates } = await import("./verify-at-selection.js");
  const { validatePinnedClaims } = await import("./pin-claims.js");
  type PinnedClaims = import("./pin-claims.js").PinnedClaims;
  const all = [...recommended, ...alternates];
  const { kept, dropped } = await verifyCandidates(
    all,
    loadConfig<SourcePreferencesConfig>("sources").verification,
    // Judge the claims ONCE here so the script is written from a pinned, source-backed set.
    (prompt) => modelJson<PinnedClaims>(prompt, validatePinnedClaims)
  );
  if (dropped.length) log(`Roundup: ${dropped.length} candidate(s) dropped at selection for unreadable sources.`);
  const keyOf = (s: { headline: string; primaryUrl: string }) => s.headline + "\n" + normalizeUrl(s.primaryUrl);
  const recommendedKeys = new Set(recommended.map(keyOf));

  // Consume each untried candidate once until the required readable slate exists or the pool is exhausted.
  const entityKey = (s: { primaryUrl: string }) => normalizeUrl(s.primaryUrl);
  let replacementPicks: RoundupStoryPick[] = [];
  let replacement: { requested: number; returned: number; kept: string[]; dropped: { headline: string; reason: string }[]; attempts?: number; error?: string } | null = null;
  const replacementKept: typeof kept = [], replacementDropped: typeof dropped = [];
  const attempted: RoundupStoryPick[] = [];
  let attempts = 0;
  let lastError: string | undefined;
  while (new Set([...kept, ...replacementKept].map(entityKey)).size < cfg.roundup.minStories) {
    const need = cfg.roundup.minStories - new Set([...kept, ...replacementKept].map(entityKey)).size;
    const considered = [...all, ...attempted];
    const usedIds = new Set(considered.flatMap((s) => s.sourceItemIds));
    for (const d of [...dropped, ...replacementDropped]) for (const id of d.story.sourceItemIds) usedIds.add(id);
    const pool = candidates.filter((c) => !usedIds.has(c.id));
    if (!pool.length) break;
    attempts++;
    let error: string | null = null;
    let roundPicks: RoundupStoryPick[] = [];
    let keptBefore = replacementKept.length;
    try {
      roundPicks = pool.slice(0,need).map(candidatePick).map(withRealUrl);
      replacementPicks.push(...roundPicks);
      attempted.push(...roundPicks);
      const v2 = await verifyCandidates(roundPicks, loadConfig<SourcePreferencesConfig>("sources").verification, (prompt) => modelJson<PinnedClaims>(prompt, validatePinnedClaims));
      replacementKept.push(...v2.kept); replacementDropped.push(...v2.dropped);
    } catch (e) {
      // Best effort: a writer that cannot supply valid replacements leaves the plain short-slate error below, not a model error.
      error = (e as Error).message.slice(0, 300);
      lastError = error;
      log(`selection: replacement round failed — ${error}`);
    }
    log(`selection: replacement round ${attempts} — asked for ${need}, got ${roundPicks.length}, ${replacementKept.length - keptBefore} readable this round.`);
    // No forward progress and no new attempts to exclude → stop (avoids spinning on the same failure).
    if (error || (roundPicks.length === 0 && replacementKept.length === keptBefore)) break;
    if (replacementKept.length === keptBefore && roundPicks.every((s) => attempted.filter((a) => keyOf(a) === keyOf(s)).length > 1)) break;
  }
  if (attempts) {
    replacement = {
      requested: cfg.roundup.minStories - new Set(kept.map(entityKey)).size,
      returned: replacementPicks.length,
      kept: replacementKept.map((s) => s.headline),
      dropped: replacementDropped.map((d) => ({ headline: d.story.headline, reason: d.reason })),
      ...(attempts > 1 ? { attempts } : {}),
      ...(lastError ? { error: lastError } : {}),
    };
  }
  // A short slate must say why each candidate went: the worker's log is not in front of the person (Ollama 4B, Sep 17:
  // "Only 0 stories have readable sources" with 13 judge calls and no reason anywhere the Journey shows).
  // Fewer readable stories than the configured minimum make a shorter edition, never a hold; only zero stops
  // (Saaket, Sep 17: the fresh Journey held on "Only 0 stories … 3 required" and "at least 3 are needed").
  const available = new Set([...kept, ...replacementKept].map(entityKey)).size;
  const minimum = available > 0 && available < cfg.roundup.minStories ? available : cfg.roundup.minStories;
  if (minimum !== cfg.roundup.minStories) log(`selection: only ${available} readable stor${available === 1 ? "y" : "ies"} (${cfg.roundup.minStories} requested) — continuing with a shorter edition.`);
  const { slate, spare } = (() => {
    try { return assembleSlate(kept.filter((s) => recommendedKeys.has(keyOf(s))), [...kept.filter((s) => !recommendedKeys.has(keyOf(s))), ...replacementKept], recommended.length, minimum, cfg.roundup.maxStories); }
    catch (error) {
      const reasons = [...dropped, ...replacementDropped].slice(0, 4).map((d) => `"${d.story.headline.slice(0, 60)}": ${d.reason.slice(0, 160)}`);
      throw new Error(`${(error as Error).message}${reasons.length ? ` Dropped — ${reasons.join(' · ')}` : ''}`);
    }
  })();
  if (slate.some((s) => !recommendedKeys.has(keyOf(s)))) log(`selection: back-filled ${slate.filter((s) => !recommendedKeys.has(keyOf(s))).length} unreadable pick(s) from verified alternates.`);

  const toStory = (s: (typeof slate)[number], i: number): TopicStory => {
    const sourceItems = fresh.filter((it) => s.sourceItemIds.includes(it.id));
    return {
      n: i + 1,
      headline: s.headline,
      summary: s.summary,
      weight: s.weight,
      primaryUrl: s.primaryUrl,
      ...(s.verifiedClaims?.length ? { verifiedClaims: s.verifiedClaims } : {}),
      ...(s.claimEvidence ? { claimEvidence: s.claimEvidence } : {}),
      repo: sourceItems.find((it) => it.repo)?.repo ?? null,
      assetRef: `og-${i}`,
      suggestedScene: s.suggestedScene,
      principalEntity: s.principalEntity,
      area: s.area,
      verticals: s.verticals,
      ...(s.classificationNotes?.length ? { classificationNotes: s.classificationNotes } : {}),
    };
  };
  // Exactly one lead on the committed slate: the first selected lead when it survived, otherwise the first story.
  const leadIndex = Math.max(0, slate.findIndex((s) => s.weight === "lead"));
  const stories: TopicStory[] = slate.map((s, i) => ({ ...toStory(s, i), weight: i === leadIndex ? "lead" : s.weight === "lead" ? "standard" : s.weight }));

  // Title and id follow the verified lead, not the first candidate ranked before verification: Quasar and Antigravity
  // (Sep 17) shipped a Carrick title over Fleetwood and JJ Gabriel briefings when the judge dropped the first pick.
  const dayHeadline = `Roundup ${todayStamp()}: ${stories[0]!.headline}`;
  const id = roundupPackageId(`${todayStamp().replace(/-/g, "")}-roundup-${slugify(dayHeadline)}`);

  const allSourceItems = slate.flatMap((s) => s.sourceItemIds);
  const topic: Topic = {
    id,
    kind: "roundup",
    headline: dayHeadline,
    angle: resp.angle,
    sourceItems: allSourceItems,
    primaryUrl: stories[0].primaryUrl,
    repo: stories.find((s) => s.repo)?.repo ?? null,
    alternates: spare.map((s) => ({ headline: s.headline, primaryUrl: s.primaryUrl })),
    stories,
  };

  // Only the committed slate is reserved in the ledger; an alternate the person swaps in is covered by its package.
  const urls = [
    ...stories.map((s) => s.primaryUrl),
    ...fresh.filter((it) => allSourceItems.includes(it.id)).map((it) => it.url),
  ];
  const requireChoice = storyChoiceRequired(activeRoot(), rankingConfig().mode); // Automated mode takes the recommended slate
  createVideoWorkdir(topic, urls, topic.repo?.fullName ?? null, requireChoice ? "awaiting_story_choice" : "selected");

  // The evidence behind the decision, every ordered candidate and its verification outcome.
  const verdict = new Map<string, { kept: boolean; reason?: string }>();
  for (const k of [...kept, ...replacementKept]) verdict.set(keyOf(k), { kept: true });
  for (const d of [...dropped, ...replacementDropped]) verdict.set(keyOf(d.story), { kept: false, reason: d.reason });
  const picked = new Map<string, PickedCandidate>();
  const replacementKeys = new Set(replacementPicks.map(keyOf));
  [...all, ...replacementPicks].forEach((s, i) => {
    const role = recommendedKeys.has(keyOf(s)) ? "recommended" as const : replacementKeys.has(keyOf(s)) ? "replacement" as const : "alternate" as const;
    for (const sid of s.sourceItemIds) if (!picked.has(sid)) picked.set(sid, { role, order: i + 1, verification: verdict.get(keyOf(s)) ?? null });
  });
  writeJson(join(videoDir(id), "selection-report.json"), {
    selectionPolicyId: SELECTION_POLICY_ID,
    ranking: rankingConfig(),
    generatedAt: new Date().toISOString(),
    contentDay: todayStamp(),
    counts: { candidates: candidates.length, scored: candidates.filter((c) => c.scoreBreakdown).length, recommended: recommended.length, alternates: alternates.length, kept: kept.length, dropped: dropped.length, slate: stories.length },
    replacementRound: replacement,
    stories: stories.map((s) => ({ order: s.n, headline: s.headline, primaryUrl: s.primaryUrl, weight: s.weight, principalEntity: s.principalEntity })),
    candidates: selectionReportRows(candidates, picked),
  });

  // "Choose your stories": the verified slate plus the verified spares, each with its evidence.
  const { storyKey, writeStoryChoice } = await import("./story-choice.js");
  const evidenceFor = (s: (typeof slate)[number]) => {
    const c = candidates.find((x) => s.sourceItemIds.includes(x.id));
    let sourceHost = ""; try { sourceHost = new URL(s.primaryUrl).hostname.replace(/^www\./, ""); } catch { /* keep blank */ }
    return { compositeScore: c?.scoreBreakdown ? c.score : null, scoreBreakdown: c?.scoreBreakdown ? { heat: c.scoreBreakdown.heat, provenance: c.scoreBreakdown.provenance, freshness: c.scoreBreakdown.freshness, channelRank: c.scoreBreakdown.channelRank } : null, outletsCovering: c?.outletsCovering ?? null, credibility: c?.credibility ?? null, publishedAt: c?.publishedAt ?? null, sourceHost };
  };
  const entries = [
    ...slate.map((s, i) => ({ key: storyKey(stories[i]), role: "recommended" as const, story: stories[i], sourceItemIds: s.sourceItemIds, sourceUrls: fresh.filter((it) => s.sourceItemIds.includes(it.id)).map((it) => it.url), evidence: evidenceFor(s) })),
    ...spare.map((s, i) => { const story = toStory(s, slate.length + i); return { key: storyKey(story), role: "alternate" as const, story, sourceItemIds: s.sourceItemIds, sourceUrls: fresh.filter((it) => s.sourceItemIds.includes(it.id)).map((it) => it.url), evidence: evidenceFor(s) }; }),
  ];
  // The recommended lead is the first selected story (the unattended path uses the same one), not whichever is first.
  const recommendedLead = entries.find((e) => e.role === "recommended" && e.story.weight === "lead")?.key ?? entries[0]?.key ?? null;
  writeStoryChoice(videoDir(id), { minStories: minimum, maxStories: cfg.roundup.maxStories, recommendedLead, entries }, !requireChoice);

  log(`Roundup selected: "${topic.headline}" — ${stories.length} stories (${stories.map((s) => s.weight).join(", ")})${spare.length ? `, ${spare.length} verified alternate(s)` : ""}`);
  stories.forEach((s) => log(`  ${s.n}. [${s.weight}] ${s.headline}`));
  if (requireChoice) log(`Paused for story choice (${id}).`);
  return [topic];
}

/* ---------- singles mode: top-N separate videos ---------- */

async function rankSingles(fresh: HarvestItem[], n: number): Promise<Topic[]> {
  if (rankingConfig().mode === "manual") throw new Error("Manual selection uses the roundup story-choice screen. Choose newest or priorities for unattended singles.");
  const candidates = await eligibleCandidates(fresh);
  const { verifyCandidates } = await import("./verify-at-selection.js");
  const { validatePinnedClaims } = await import("./pin-claims.js");
  const verified: (RoundupStoryPick & import("./pin-claims.js").PinnedFields)[] = [];
  for (const candidate of candidates) {
    const checked = await verifyCandidates([candidatePick(candidate,verified.length)],loadConfig<SourcePreferencesConfig>("sources").verification,prompt => modelJson<import("./pin-claims.js").PinnedClaims>(prompt,validatePinnedClaims));
    verified.push(...checked.kept);
    if (verified.length >= n) break;
  }
  if (verified.length < n) throw new Error(`Only ${verified.length} stories have readable sources; ${n} required. Add sources or choose another topic.`);
  const resp = {picks: verified.map(s => ({...s,kind:"news" as const,angle:s.summary}))};
  const topics: Topic[] = [];
  for (const pick of resp.picks.slice(0, n)) {
    const id = `${todayStamp().replace(/-/g, "")}-${slugify(pick.headline)}`;
    if (existsSync(join(videoDir(id), "topic.json"))) {
      log(`Skipping duplicate id ${id}`);
      continue;
    }
    const sourceItems = fresh.filter((it) => pick.sourceItemIds.includes(it.id));
    const repo = sourceItems.find((it) => it.repo)?.repo ?? null;
    const topic: Topic = {
      id,
      kind: pick.kind,
      headline: pick.headline,
      angle: pick.angle,
      sourceItems: pick.sourceItemIds,
      primaryUrl: enforceRealUrl(pick.primaryUrl, sourceItems, pick.headline),
      repo,
      alternates: [],
      ...(pick.verifiedClaims?.length ? {verifiedClaims:pick.verifiedClaims} : {}),
      ...(pick.claimEvidence ? {claimEvidence:pick.claimEvidence} : {}),
    };
    createVideoWorkdir(topic, [topic.primaryUrl, ...sourceItems.map((s) => s.url)], repo?.fullName ?? null);
    log(`Selected topic ${topics.length + 1}/${n}: "${topic.headline}" → ${videoDir(id)}`);
    topics.push(topic);
  }
  return topics;
}

/* ---------- entrypoint ---------- */

export async function rank(harvestPath?: string, count?: number, formatOverride?: string): Promise<Topic[]> {
  const path = harvestPath ?? join(HARVEST_DIR, `${todayStamp()}.json`);
  if (!existsSync(path)) throw new Error(`No harvest file at ${path} — run harvest first`);
  const harvest = readJson<HarvestFile>(path);
  const cfg = loadConfig<PipelineConfig>("pipeline");
  const format = (formatOverride as PipelineConfig["format"]) ?? cfg.format ?? "roundup";

  let fresh = filterCovered(harvest.items, cfg.dedupWindowDays);
  // Harvest URLs and repository activity are discovery metadata, not event identity.
  // Preserve candidates until complete source-backed story packets can be compared.

  log(`Ranking ${fresh.length}/${harvest.items.length} items (after exact + cross-pipeline dedup), format=${format}`);
  if (fresh.length === 0) throw new Error("Nothing new to cover after dedup");

  return format === "roundup"
    ? rankRoundup(fresh, cfg)
    : rankSingles(fresh, count ?? cfg.topicsPerRun ?? 1);
}
