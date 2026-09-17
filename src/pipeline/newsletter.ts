import { normalizeFeeds, type Feed } from "../sources/rss.js";
import { assertNoUnresolvedReviewDispute, persistSourceReviewDispute } from './persist-review-dispute.js';
import { matchCatalog, readCatalog, type CatalogFamily } from "../sources/catalog.js";
import { publisher, publisherBrief } from "../publisher.js";
import { CODE_ROOT } from "../workspaces.js";
import { validDay, safeId, activeRoot, contained, deskFor, atomicJson } from "../workspaces.js";
import { bandForStoryCount, defaultNewsletterWords, logoDataUri, NEWSLETTER_LENGTHS, newsletterShell, readPersonalization, selectedLengthBand, workspaceTheme } from "../personalization.js";
import { execFileSync } from "node:child_process";
import { MEDIA_PROCESS_LIMITS, runManagedProcess } from "../managed-process.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import type { HarvestFile, Script, StoryDiagram, Topic, TopicStory, VideoMeta } from "../types.js";
import { copyTextToClipboard, openExternal, portableCommand } from "../platform.js";
import { isPublicVideoUrl, publicVideoUrl } from "../post/public-video-url.js";
import { recentEntries } from "../state/ledger.js";
import { HARVEST_DIR, VIDEOS_DIR, WORKDIR, loadConfig, normalizeUrl, readJson, todayStamp, log, videoDir } from "../util.js";
import { editionForVideo, loadEdition, resolveTitle, resolveBadge } from "./edition.js";
import { assertCanonicalNewsletterHeadings, NEWSLETTER_SECTION_HEADINGS } from "./newsletter-contract.js";
import type { SelectionReportRow } from "./user-ranking.js";
import { renderNewsletterHtml, type NewsletterData } from "./newsletter-html.js";
import { renderLinkedInEdition } from "./newsletter-linkedin.js";
import { newsletterWordCount, type NewsletterStory, type NewsletterWordBudget } from "./newsletter-draft.js";
import { formatScriptNewsletter, type ScriptNewsletterCheckpoint } from './newsletter-from-script.js';
import { automationAuto } from '../automation.js';
import { preparedModelTask } from './writing-task.js';
import type { DraftCall } from './script.js';
import { newsletterMotionForSource } from './newsletter-visuals.js';
import { withMotionPackets } from './diagram-style.js';
import { visualMediaProblem } from './visual-media.js';
import { sourceAccountProblem } from './source-account.js';

/** Feed names come only from operator config or a catalog family matched to the operator's vocabulary. */
export function newsletterFeedNames(feeds: (Feed | string)[], families: CatalogFamily[], topics: string[]): string[] {
  return [...new Set([
    ...normalizeFeeds(feeds).filter((feed) => feed.newsletter).map((feed) => feed.name),
    ...matchCatalog(families, topics).flatMap((family) => family.feeds.filter((feed) => feed.newsletter).map((feed) => feed.name)),
  ])];
}

/** Names of feeds flagged as newsletters in config — never hardcode outlet names. */
export function newsletterSourceNames(): string[] {
  const cfg = loadConfig<{ rss?: (Feed | string)[]; editorial?: { preferredTopics?: string[]; areas?: { focusAreas?: string[]; verticals?: string[] } } }>("sources");
  const topics = [...(cfg.editorial?.preferredTopics ?? []), ...(cfg.editorial?.areas?.focusAreas ?? []), ...(cfg.editorial?.areas?.verticals ?? [])];
  return newsletterFeedNames(cfg.rss ?? [], readCatalog(CODE_ROOT), topics);
}

/** Identity lines and theme tokens from Personalize; read at render time so a brand change lands on --rerender. */
function newsletterBrand(fallbackAccent?: string): NewsletterData["brand"] {
  const p = readPersonalization(activeRoot());
  return { organization: p.organization, tagline: p.tagline, website: p.website, footer: p.footer, theme: workspaceTheme(activeRoot(), fallbackAccent) };
}

// Only attachStoryVisuals may admit a card after checking the current package and selection.
// Cached JSON cannot grant itself an artwork exemption; every write/rerender reattaches first.
const selectedNewsletterCards = new WeakSet<object>();

/** Daily Signal's artwork-carrying path, using the Journey's already selected edition diagrams.
 * Missing motion/artwork must survive to the refusal gate, never disappear through flatMap. */
export function motionStoriesForNewsletter(script: Script, topic: Topic, diagrams: StoryDiagram[], cards: ReadonlySet<number> = new Set()): NonNullable<NewsletterData['motionStories']> {
  return script.body.map((segment, i) => {
    const story = segment.assetRef ? topic.stories?.find(row => row.assetRef === segment.assetRef) : topic.stories?.[i];
    const url = topic.stories?.length ? story?.primaryUrl : topic.primaryUrl;
    if (cards.has(i) && url) {
      const card = { kind: 'text-card' as const, status: '', n: i + 1, title: segment.onScreen.title, url };
      return card;
    }
    if (!segment.motion || !url) throw new Error(`Story ${i + 1} has no source-bound motion; repair the upstream script/diagram stage before building the newsletter`);
    return { ...segment.motion, n: i + 1, title: segment.onScreen.title, url, diagram: diagrams[i] };
  });
}

/** Port of Daily Signal's completion invariant. A diagram object is not artwork.
 * This is presentation validation only; source review remains in the existing visual stage. */
export function assertIssueCarriesVisuals(key: string, data: NewsletterData, renderedHtml?: string): void {
  const stories = data.motionStories ?? [];
  const problems: string[] = [];
  const urls = [data.issue.lead.sourceUrl, ...data.issue.items.map(item => item.url)];
  if (!stories.length) problems.push('the issue has 0 motion stories');
  if (stories.length !== urls.length) problems.push(`the issue has ${stories.length} motion stories for ${urls.length} main stories`);
  urls.forEach((url, i) => {
    if (!newsletterMotionForSource(data, url, i)) problems.push(`main story ${i + 1} has no source-matched artwork`);
  });
  const rendered = renderedHtml === undefined ? undefined : load(renderedHtml);
  // Metadata, comments and script strings cannot stand in for a mounted figure.
  rendered?.('script, style, template').remove();
  const numbers = new Set<number>();
  stories.forEach((story, i) => {
    const name = `story ${i + 1}`, d = story.diagram;
    if (!Number.isSafeInteger(story.n) || story.n < 1 || numbers.has(story.n)) problems.push(`${name} has no unique artwork number`);
    numbers.add(story.n);
    if (story.kind === 'text-card') {
      if (!selectedNewsletterCards.has(story) || d || story.figureDataUri) problems.push(`${name} has no verified text-card selection`);
      if (rendered?.(`figure.topic-motion[data-story-index="${story.n}"]`).length) problems.push(`${name} text-card selection unexpectedly carries artwork`);
      return;
    }
    if (!d) { problems.push(`${name} has no diagram`); return; }
    const figure = rendered?.(`figure.topic-motion[data-story-index="${story.n}"]`);
    if (figure && figure.length !== 1) problems.push(`${name} artwork is missing or duplicated in the rendered issue`);
    if (d.visual && d.visual.kind !== 'diagram') {
      const problem = visualMediaProblem(d.visual);
      if (problem) problems.push(`${name}: ${problem}`);
      if (figure) {
        const image = d.visual.kind === 'source' && d.visual.image && !d.visual.clip;
        const src = image ? d.visual.image?.dataUri ?? d.visual.media?.poster : d.visual.media?.mp4;
        if (!src || figure.find(image ? 'img.story-visual-image' : 'video.story-visual-video').attr('src') !== src
          || figure.attr('data-visual-hash') !== d.visual.media?.hash) problems.push(`${name}: selected media missing from rendered issue`);
      }
      return;
    }
    const svg = d.svg ?? '';
    const art = load(svg, { xmlMode: true });
    const shapes = art('svg rect, svg circle, svg ellipse, svg polygon, svg polyline, svg path, svg line, svg text').length;
    if (!art('svg').length) problems.push(`${name} diagram carries no <svg>`);
    else if (shapes < 3) problems.push(`${name} diagram has only ${shapes} drawn elements (blank card)`);
    if (!d.label?.trim()) problems.push(`${name} diagram has no label`);
    if (!d.legend?.length || d.legend.some(entry => !entry.label?.trim())) problems.push(`${name} diagram has no readable legend`);
    if (!art(`svg[data-visual-primitive="authored-${story.n}"]`).length) problems.push(`${name} diagram has no matching authored-${story.n} artwork`);
    if (!art('.tm-native-trace').length) problems.push(`${name} diagram has no animated connector (tm-native-trace)`);
    if (art('rect[x="0"][y="0"][width="720"][height="340"]').length) problems.push(`${name} diagram covers its dark stage with a full-bleed background`);
    for (const attr of ['fill', 'stroke', 'stop-color', 'color']) {
      if (art(`[${attr}]`).toArray().some(node => !['none', 'currentColor'].includes(art(node).attr(attr)!))) {
        problems.push(`${name} diagram overrides the stylesheet's ${attr} palette`);
      }
    }
    if (figure) {
      const expected = load(withMotionPackets(svg))('svg').toString();
      if (figure.find('.tm-stage svg').toString() !== expected) problems.push(`${name}: selected SVG missing from rendered issue`);
    }
  });
  if (renderedHtml !== undefined && stories.some(story => story.diagram && (!story.diagram.visual || story.diagram.visual.kind === 'diagram'))) {
    if (!/@keyframes tm-native-flow/.test(renderedHtml) || !/\.tm-native-trace\{[^}]*animation:tm-native-flow/.test(renderedHtml)) problems.push('rendered issue does not mount the diagram motion stylesheet');
    if (rendered!('[data-tm-frozen]').length) problems.push('rendered issue freezes its diagram animation');
  }
  if (problems.length) throw new Error(`${key}: refusing to build or publish — the figures/schemas/diagrams are not integrated.\n${problems.join('\n')}\nFix the upstream script/diagram failure and rebuild; this issue is not ready.`);
}

/** Presentation only: never generate or fact-review artwork while formatting a newsletter. */
export async function attachStoryVisuals(data:NewsletterData,id:string|undefined):Promise<void> {
  // A rerender may carry pictures from an earlier image-enabled issue.
  data.motionStories=[];
  if(!readPersonalization(activeRoot()).newsletterImages)return;
  if(!id)throw new Error('Newsletter images require a selected video package; refusing to build without story artwork');
  const dir=contained(VIDEOS_DIR,safeId(id));
  if(!existsSync(join(dir,"script.json")))throw new Error('Newsletter images require the selected script; refusing to build without story artwork');
  const script=readJson<import("../types.js").Script>(join(dir,"script.json"));
  const topic=readJson<Topic>(join(dir,"topic.json"));
  const saved=readJson<{version:number;topicHash:string;scriptHash:string;selectionHash:string;diagrams:import("../types.js").StoryDiagram[];contentHash:string}|null>(join(dir,"newsletter-visuals.json"),null);
  if(!saved)throw new Error('Newsletter images require completed edition artwork from ensureEditionDiagrams; refusing to build until the visual stage saves newsletter-visuals.json');
  const {readVisualChoices,readVisualCandidates,selectedSourceSnapshots}=await import('./visual-choice.js');
  const selectionHash=newsletterHash({choices:readVisualChoices(dir),candidates:readVisualCandidates(dir)});
  if(saved.version!==1 || saved.topicHash!==newsletterHash(topic) || saved.scriptHash!==newsletterHash(script)
    || saved.selectionHash!==selectionHash || !Array.isArray(saved.diagrams) || saved.diagrams.length!==script.body.length || saved.contentHash!==newsletterHash(saved.diagrams)) {
    throw new Error('Saved newsletter artwork differs from its selected script, story or visual output; regenerate the visual stage before using images');
  }
  const choices = readVisualChoices(dir), snapshots = selectedSourceSnapshots(dir), cards = new Set<number>();
  for (const [index, snapshot] of snapshots) {
    const segment = script.body[index];
    const story = segment?.assetRef ? topic.stories?.find(row => row.assetRef === segment.assetRef) : topic.stories?.[index];
    const sourceUrl = topic.stories?.length ? story?.primaryUrl : topic.primaryUrl;
    const diagram = saved.diagrams[index];
    if (!segment || snapshot.sourceUrl !== sourceUrl) throw new Error(`Story ${index + 1}: selected text card differs from its source`);
    if (segment.sourceAccount) {
      const problem = sourceAccountProblem(segment, story);
      if (problem) throw new Error(`Story ${index + 1}: ${problem}`);
    } else if (choices.stories[String(index)]?.chosenBy !== 'user' && !automationAuto(activeRoot())) continue; // Automated mode: the recommendation is the person's standing choice
    if (diagram?.svg || (diagram?.visual && diagram.visual.kind !== 'diagram') || diagram?.visual?.media) throw new Error(`Story ${index + 1}: selected text card unexpectedly carries artwork`);
    cards.add(index);
  }
  data.motionStories=motionStoriesForNewsletter(script,topic,saved.diagrams,cards);
  data.motionStories.filter(story => story.kind === 'text-card').forEach(story => selectedNewsletterCards.add(story));
  assertIssueCarriesVisuals(id,data);
  const artwork = data.motionStories.filter(story => story.kind !== 'text-card');
  if (!artwork.length) return;
  const {renderDiagramGifs}=await import("./diagram-gif.js");
  const figures=await renderDiagramGifs(contained(dir,"newsletter-figures"),"stories",data.date,{ ...data, motionStories: artwork });
  if(figures.length!==artwork.length)throw new Error('Newsletter artwork presentation is incomplete');
  artwork.forEach((story,i)=>story.figureDataUri=`data:image/gif;base64,${readFileSync(figures[i].gif).toString("base64")}`);
}

export const NEWSLETTER_DIR = contained(activeRoot(), "workdir/newsletters");

/** Rebuild the static archive site (site/public) so the newsletter website stays current.
 *  Best-effort — never breaks the pipeline if the build script is missing or errors. */
async function rebuildSite(): Promise<void> {
  try {
    await runManagedProcess(process.execPath, ["--import", "tsx", join(CODE_ROOT, "site", "build.mjs")], { operation: "Newsletter archive build", timeoutMs: MEDIA_PROCESS_LIMITS.transform, stdio: "pipe" });
    log("Archive site rebuilt → site/public");
  } catch (e) {
    log(`Archive site rebuild skipped: ${(e as Error).message.split("\n")[0]}`);
  }
}

export interface Issue {
  subject: string;
  lead: { title: string; body: string; sourceName: string; sourceUrl: string };
  items: { name: string; url: string; line: string }[];
  radar: { repo: string; url: string; line: string; observedAt?: string }[];
  signals: { source: string; line: string; url: string }[];
}

/** A same-day retry must name its package rather than adopt a previous roundup's stories. */
export function newsletterVideoId(candidates: string[], requested?: string, cached?: string | null): string | undefined {
  if (requested && cached && requested !== cached) throw new Error('Cached newsletter belongs to another video; regenerate the selected package before rerendering');
  const exact = requested || cached;
  if (exact) {
    if (!candidates.includes(exact)) throw new Error(`Newsletter video ${exact} is not an eligible package for this date and edition`);
    return exact;
  }
  if (candidates.length > 1) throw new Error('Multiple video packages exist for this date and edition; select the current package with --video-id');
  return candidates[0];
}

type BoundNewsletterData = NewsletterData & { sourceStoryHash?: string; sourceProseHash?: string };
const newsletterHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function newsletterCacheIdentity(topic: Topic, issue: Issue) {
  return { sourceVideoId: topic.id, sourceStoryHash: newsletterHash(topic), sourceProseHash: newsletterHash({ subject: issue.subject, lead: issue.lead, items: issue.items }) };
}

/** Presentation-only rerender cannot turn a short saved issue into the newly requested length.
 * Headlines, links, radar and signals do not contribute to the lead-and-items word budget. */
export function assertNewsletterLength(issue: Issue, requested: NewsletterWordBudget): void {
  if (!Number.isSafeInteger(requested.min) || !Number.isSafeInteger(requested.max) || requested.min < 1 || requested.max < requested.min || requested.max > 1300) throw new Error('Newsletter length must be a finite selected range of at most 1300 words');
  const words = newsletterWordCount(issue);
  if (words < requested.min || words > requested.max) throw new Error(`Newsletter has ${words} words; the selected length requires ${requested.min}–${requested.max}. Generate the newsletter again for this length; rerender only updates its presentation.`);
}

/** Rerender may refresh presentation, never borrow another package's sources or author missing prose. */
export function assertNewsletterCache(data: BoundNewsletterData, topic: Topic): void {
  if (!data.sourceVideoId || data.sourceVideoId !== topic.id) throw new Error('Cached newsletter has no matching source video identity; regenerate it for the selected package');
  const expected = newsletterCacheIdentity(topic, data.issue);
  if (!data.sourceStoryHash || data.sourceStoryHash !== expected.sourceStoryHash) throw new Error('Cached newsletter source stories changed or were never bound; regenerate it before rerendering');
  if (!data.sourceProseHash || data.sourceProseHash !== expected.sourceProseHash) throw new Error('Cached newsletter prose changed or was never reviewed; regenerate it before rerendering');
  const stories = topic.stories ?? [{ primaryUrl: topic.primaryUrl, weight: 'lead' }];
  const lead = stories.find(story => story.weight === 'lead') ?? stories[0];
  const otherUrls = stories.filter(story => story !== lead).map(story => story.primaryUrl);
  if (!lead || data.issue.lead.sourceUrl !== lead.primaryUrl || data.issue.items.length !== otherUrls.length || data.issue.items.some((item, i) => item.url !== otherUrls[i])) throw new Error('Cached newsletter citations differ from its selected story order; regenerate it before rerendering');
}

/** The newsletter's main-story list is the selected slate, never a model-selected subset of it. */
export function completeSlateIssue(issue: Issue, stories: Pick<TopicStory, "headline" | "summary" | "weight" | "primaryUrl">[]): Issue {
  if (!stories.length) return issue;
  const leadStory = stories.find((story) => story.weight === "lead") ?? stories[0];
  const supporting = stories.filter((story) => story !== leadStory);
  const unused = [...issue.items];
  return {
    ...issue,
    lead: { ...issue.lead, sourceUrl: leadStory.primaryUrl },
    items: supporting.map((story) => {
      const index = unused.findIndex((item) =>
        normalizeUrl(item.url) === normalizeUrl(story.primaryUrl)
        || item.name.trim().toLowerCase() === story.headline.trim().toLowerCase()
      );
      const written = index >= 0 ? unused.splice(index, 1)[0] : undefined;
      return {
        name: written?.name.trim() || story.headline,
        url: story.primaryUrl,
        line: written?.line.trim() || story.summary,
      };
    }),
  };
}

export interface NewsletterHarvestSnapshot extends HarvestFile { day: string }
export interface NewsletterSelectionReport {
  contentDay: string;
  stories?: { primaryUrl: string }[];
  candidates: SelectionReportRow[];
}

/** Ranked leftovers are joined back to their immutable harvest row, so no report/model URL can leak into output. */
export function rankedRadarCandidates(
  reports: NewsletterSelectionReport[],
  snapshots: NewsletterHarvestSnapshot[],
  covered: Iterable<string>,
  limit = 5,
): Issue["radar"] {
  const coveredUrls = new Set([...covered].map(normalizeUrl));
  const harvestByDay = new Map(snapshots.map((snapshot) => [snapshot.day, snapshot]));
  const selected = new Set(reports.flatMap((report) => report.stories ?? []).map((story) => normalizeUrl(story.primaryUrl)));
  const seen = new Set<string>();
  const rows: Issue["radar"] = [];
  for (const report of [...reports].sort((a, b) => b.contentDay.localeCompare(a.contentDay))) {
    const harvest = harvestByDay.get(report.contentDay);
    if (!harvest) continue;
    for (const candidate of [...report.candidates].sort((a, b) => a.candidateOrder - b.candidateOrder)) {
      const key = normalizeUrl(candidate.primaryUrl);
      if (selected.has(key) || coveredUrls.has(key) || seen.has(key) || candidate.verification?.kept !== true) continue;
      const item = harvest.items.find((row) => row.id === candidate.candidateId && normalizeUrl(row.url) === key);
      if (!item) continue;
      seen.add(key);
      rows.push({ repo: item.title, url: item.url, line: (item.summary.trim() || item.title).slice(0, 240).trimEnd(), observedAt: harvest.fetchedAt });
      if (rows.length === limit) return rows;
    }
  }
  return rows;
}

export interface OtherDeskItem { source: string; title: string; summary: string; url: string }

/** Other-edition stories and newsletter feeds keep their harvested URLs verbatim and one row per source. */
export function otherDeskCandidates(
  snapshots: NewsletterHarvestSnapshot[],
  newsletterNames: string[],
  editions: OtherDeskItem[],
  covered: Iterable<string>,
  limit = 5,
): Issue["signals"] {
  const coveredUrls = new Set([...covered].map(normalizeUrl));
  const names = new Set(newsletterNames);
  const harvested = snapshots.flatMap((snapshot) => snapshot.items)
    .filter((item) => item.source.startsWith("rss:") && names.has(item.source.slice(4)))
    .map((item) => ({ source: item.source.slice(4), title: item.title, summary: item.summary, url: item.url }));
  const seenUrls = new Set<string>();
  const seenSources = new Set<string>();
  return [...editions, ...harvested].filter((item) => {
    const key = normalizeUrl(item.url);
    if (coveredUrls.has(key) || seenUrls.has(key) || seenSources.has(item.source)) return false;
    seenUrls.add(key); seenSources.add(item.source);
    return true;
  }).slice(0, limit).map((item) => ({
    source: item.source,
    url: item.url,
    line: (item.summary.trim() ? `${item.title} — ${item.summary.trim()}` : item.title).slice(0, 320).trimEnd(),
  }));
}

/** Writer prose may improve a row, but the verified candidate list owns membership, labels and exact URLs. */
export function completeSupportingIssue(issue: Issue, radar: Issue["radar"], signals: Issue["signals"]): Issue {
  return {
    ...issue,
    radar: radar.map((candidate) => {
      const written = issue.radar.find((row) => row.repo.trim().toLowerCase() === candidate.repo.trim().toLowerCase() && normalizeUrl(row.url) === normalizeUrl(candidate.url));
      return { ...candidate, line: (written?.line.trim() || candidate.line).slice(0, 240).trimEnd() };
    }),
    signals: signals.map((candidate) => {
      const written = issue.signals.find((row) => row.source === candidate.source && normalizeUrl(row.url) === normalizeUrl(candidate.url));
      return { ...candidate, line: (written?.line.trim() || candidate.line).slice(0, 320).trimEnd() };
    }),
  };
}

/** Historical whole-issue prompt retained for explicit comparison tools; production is staged. */
export const PROMPT = (storiesJson: string, radarJson: string, nlJson: string, date: string, wantRadar: boolean, wantSignals: boolean, lengthPlan = '', lengthBand: NewsletterWordBudget | null | undefined = undefined) => `Write today's issue of "${publisher().publication}" for ${publisher().audience}. ${publisherBrief()} Today: ${date}.

VIDEO STORIES (covered in today's video — the "lead"-weight story is the lead; the rest become items):
${storiesJson}

${wantRadar
  ? `TRENDING candidates (ranked harvested stories NOT covered in the video — use every candidate):\n${radarJson}`
  : `TRENDING: none — there are no verified ranked candidates. Return "radar": [] (an empty array).`}

${wantSignals
  ? `NEWSLETTER SIGNALS (what other configured newsletters flagged — include only if genuinely notable, MAX ONE item per outlet, prefer diverse outlets over multiple items from one):\n${nlJson}`
  : `NEWSLETTER SIGNALS: none — there are no configured, harvested newsletter candidates. Return "signals": [] (an empty array). Do NOT include newsletter/other-desk items.`}

${(() => { const band = lengthBand === undefined ? selectedLengthBand(readPersonalization(activeRoot()).newsletterLength, 3) : lengthBand; return band ? `LENGTH: ${band.min}–${band.max} words across the lead and items. Retain every selected story and fit the word budget using only its pinned claims, with qualifiers intact.` : ''; })()}${lengthPlan}
The verifiedClaims on each story are its entire fact budget. Invent no advice, aims, benefits or filler.

Respond with ONLY this JSON:
{
  "subject": "email-subject-style title ≤ 60 chars, lowercase punchy",
  "lead": {
    "title": "editorial headline for the lead story, ≤ 12 words",
    "body": "What the pinned claims establish and their stated limits. Plain text, no markdown.",
    "sourceName": "the source publication's name",
    "sourceUrl": "the story url"
  },
  "items": [ { "name": "story/repo name", "url": "...", "line": "Explain this story's pinned facts and stated limits without unsupported advice or conclusions" } ],
  "radar": ${wantRadar ? '[ { "repo": "exact candidate title", "url": "exact candidate URL", "line": "one line — why it matters" } ]' : "[]"},
  "signals": ${wantSignals ? '[ { "source": "exact candidate source name", "line": "one line", "url": "exact candidate URL" } ]' : "[]"}
}`;

/** Daily Signal / beta.6 shape (7b6a158 newsletter.ts:503): the accepted script is formatted into the issue in ONE
 * call. Each story carries its accepted narration and pinned claims; nothing is researched or reviewed again, and
 * every link is code-owned by completeSlateIssue. */
export { bandForStoryCount };
/** The customer's selected newsletter length as a word band across the lead and items, scaled to the story count; null when none was chosen. */
export function selectedNewsletterBand(storyCount = 3): NewsletterWordBudget | null {
  return selectedLengthBand(readPersonalization(activeRoot()).newsletterLength, storyCount);
}

export async function draftIssueFromScript(stories: { headline: string; summary?: string; weight: TopicStory['weight']; primaryUrl: string; verifiedClaims?: string[] }[],
  script: Pick<Script, 'body'>, day: string, call: DraftCall, band: NewsletterWordBudget | null = selectedNewsletterBand(stories.length)): Promise<Issue> {
  if (!stories.length) throw new Error('Newsletter issue needs the selected stories');
  const rows = stories.map((story, i) => ({ headline: story.headline, summary: script.body[i]?.voiceover ?? story.summary ?? '', weight: story.weight, primaryUrl: story.primaryUrl, verifiedClaims: story.verifiedClaims ?? [] }));
  // Code-calculated per-part targets: a total band alone leaves an eight-story issue hundreds of words over.
  const itemCount = Math.max(0, stories.length - 1);
  // One story: the lead is the whole issue, so aim for the band's middle, not its ceiling (review finding).
  const plan = band ? { lead: itemCount ? Math.round(band.max * 0.2) : Math.round((band.min + band.max) / 2), item: itemCount ? Math.floor(band.max * 0.8 / itemCount) : 0 } : null;
  const planLine = plan ? ` Plan: about ${plan.lead} words for the lead${itemCount ? ` and at most ${plan.item} words per item (${itemCount} item${itemCount === 1 ? '' : 's'})` : ''}; cut repetition and lower-value claims first, never a story or a qualifier.` : '';
  const wordsIn = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
  const issue = await call<Issue>(PROMPT(JSON.stringify(rows, null, 1), '[]', '[]', day, false, false, planLine, band), r => {
    if (!r?.subject || !r?.lead?.title || typeof r?.lead?.body !== 'string' || !r.lead.body.trim() || !r?.lead?.sourceUrl) return "missing subject/lead";
    if (!Array.isArray(r.items) || r.items.length < Math.max(0, stories.length - 1)) return `items must cover all ${Math.max(0, stories.length - 1)} non-lead stories`;
    // completeSlateIssue dereferences item.name and item.url, so a missing one must be a retry message, not a later TypeError (second-read finding).
    if (r.items.some(item => typeof item?.line !== 'string' || typeof item?.name !== 'string' || typeof item?.url !== 'string')) return "every item needs a name, url and line";
    if (!Array.isArray(r.radar) || r.radar.length) return "radar must be an empty array";
    if (!Array.isArray(r.signals) || r.signals.length) return "signals must be an empty array";
    // Measure the completed issue, not the raw answer: completeSlateIssue drops extra items and backfills a blank or
    // unmatched line with the story's own summary, so a short raw draft can complete over budget and a padded raw draft
    // can complete under it — exactly the mismatch the post-render assertNewsletterLength then refused (second-read finding).
    if (band && plan) {
      const completed = completeSlateIssue(completeSupportingIssue(r, [], []), rows);
      const words = newsletterWordCount(completed);
      if (words < band.min || words > band.max) return `Newsletter has ${words} words across the lead and items; the selected length requires ${band.min}–${band.max} (lead ${wordsIn(completed.lead.body)} words; items ${completed.items.map(item => wordsIn(item.line)).join(', ')}). Aim for about ${plan.lead} words in the lead and at most ${plan.item} per item: keep every story and fit the budget using only its pinned claims, qualifiers intact`;
    }
    return null;
  }, preparedModelTask({ role: 'newsletter-draft', capability: 'newsletter-draft', taskId: 'issue-from-script', topicIds: stories.map((_, i) => `topic-${i + 1}`),
    protocol: { version: 1, operation: 'issue-from-script' }, evidence: rows, candidate: script.body.map(segment => segment.voiceover) }));
  return completeSlateIssue(completeSupportingIssue(issue, [], []), rows);
}

/** Embed the day's voiceover (data URI, self-contained playback from email attachments)
 *  plus its word-level timestamps so the player can light up the transcript in sync. */
async function briefingAudio(day: string, vid?: string): Promise<{ dataUri: string; words: { w: string; start: number; end: number }[] | null } | null> {
  if (!existsSync(VIDEOS_DIR)) return null;
  const ids = readdirSync(VIDEOS_DIR).filter((id) => id.startsWith(day.replace(/-/g, "")));
  const id = vid ?? (ids.find((i) => i.includes("roundup")) ?? ids.sort().reverse()[0]);
  if (!id) return null;
  const wav = join(VIDEOS_DIR, id, "audio.wav");
  if (!existsSync(wav)) return null;
  const m4a = join(VIDEOS_DIR, id, "audio.m4a");
  if (!existsSync(m4a)) {
    try {
      const attempt = join(VIDEOS_DIR, id, `audio-attempt-${randomUUID()}.m4a`);
      const spec = portableCommand("npx", ["remotion", "ffmpeg", "-y", "-i", wav, "-c:a", "aac", attempt]);
      await runManagedProcess(spec.command, spec.args, { operation: "Newsletter audio encoding", timeoutMs: MEDIA_PROCESS_LIMITS.transform, stdio: "pipe" });
      renameSync(attempt, m4a);
    } catch {
      return null; // no embed beats a broken embed
    }
  }
  const stampsPath = join(VIDEOS_DIR, id, "timestamps.json");
  const words = existsSync(stampsPath)
    ? readJson<{ words: { w: string; start: number; end: number }[] }>(stampsPath).words
    : null;
  return { dataUri: `data:audio/mp4;base64,${readFileSync(m4a).toString("base64")}`, words };
}

async function todaysVideo(day: string, vid?: string): Promise<{ id: string; headline: string; durationSec: number; videoUrl: string; posted: boolean } | null> {
  if (!existsSync(VIDEOS_DIR)) return null;
  const ids = readdirSync(VIDEOS_DIR).filter((id) => id.startsWith(day.replace(/-/g, "")));
  if (ids.length === 0) return null;
  // Prefer the explicit edition video; else the roundup; else the newest
  const id = vid ?? (ids.find((i) => i.includes("roundup")) ?? ids.sort().reverse()[0]);
  const meta = readJson<VideoMeta>(join(VIDEOS_DIR, id, "meta.json"));
  let videoUrl = meta.posts.linkedin?.url ?? "";
  if (!isPublicVideoUrl(videoUrl)) {
    try { videoUrl = await publicVideoUrl(meta); } catch { videoUrl = ""; }
  }
  if (!isPublicVideoUrl(videoUrl)) videoUrl = "";
  return { id, headline: meta.headline, durationSec: Math.round(meta.durationSec ?? 0), videoUrl, posted: Boolean(videoUrl) };
}

/** Until the video is publicly posted, embed it so the newsletter plays it anywhere.
 *  Once a public link exists, the newsletter links there instead and sheds the weight. */
function videoDataUri(v: NewsletterData["video"]): string | null {
  if (!v || v.posted) return null;
  const mp4 = join(VIDEOS_DIR, v.id, "final.mp4");
  if (!existsSync(mp4)) return null;
  return `data:video/mp4;base64,${readFileSync(mp4).toString("base64")}`;
}

function supportingSnapshots(day: string): NewsletterHarvestSnapshot[] {
  if (!existsSync(HARVEST_DIR)) return [];
  const cutoff = new Date(`${day}T00:00:00Z`); cutoff.setUTCDate(cutoff.getUTCDate() - 13);
  const firstDay = cutoff.toISOString().slice(0, 10);
  return readdirSync(HARVEST_DIR)
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file) && file.slice(0, 10) >= firstDay && file.slice(0, 10) <= day)
    .map((file) => ({ day: file.slice(0, 10), ...readJson<HarvestFile>(join(HARVEST_DIR, file)) }));
}

function supportingReports(day: string, snapshots: NewsletterHarvestSnapshot[]): NewsletterSelectionReport[] {
  if (!existsSync(VIDEOS_DIR)) return [];
  const days = new Set(snapshots.map((snapshot) => snapshot.day));
  return readdirSync(VIDEOS_DIR).flatMap((id) => {
    const path = join(VIDEOS_DIR, id, "selection-report.json");
    if (!existsSync(path)) return [];
    const report = readJson<NewsletterSelectionReport>(path);
    return days.has(report.contentDay) && Array.isArray(report.candidates) ? [report] : [];
  });
}

function coveredNewsletterUrls(day: string, stories: Pick<TopicStory, "primaryUrl">[]): Set<string> {
  const covered = new Set(stories.map((story) => normalizeUrl(story.primaryUrl)));
  // Current-edition overlap is presentation deduplication. Historical URL reuse alone
  // cannot suppress a new development; verified event history is checked before publication.
  return covered;
}

function otherEditionItems(day: string, currentVideo: string | undefined): OtherDeskItem[] {
  if (!existsSync(VIDEOS_DIR)) return [];
  return readdirSync(VIDEOS_DIR).filter((id) => id !== currentVideo && id.startsWith(day.replace(/-/g, ""))).flatMap((id) => {
    const metaPath = join(VIDEOS_DIR, id, "meta.json"), topicPath = join(VIDEOS_DIR, id, "topic.json");
    if (!existsSync(metaPath) || !existsSync(topicPath)) return [];
    const meta = readJson<VideoMeta>(metaPath);
    if (meta.status.startsWith("failed") || meta.status === "rejected") return [];
    const edition = editionForVideo(id);
    const source = deskFor(edition.editionId) ?? edition.displayName;
    const topic = readJson<Topic>(topicPath);
    return (topic.stories ?? [{ headline: topic.headline, summary: topic.angle, primaryUrl: topic.primaryUrl }])
      .map((story) => ({ source, title: story.headline, summary: story.summary, url: story.primaryUrl }));
  });
}

async function supportingCandidates(day: string, currentVideo: string | undefined, stories: Pick<TopicStory, "primaryUrl">[], includeOtherDesks: boolean): Promise<{ radar: Issue["radar"]; signals: Issue["signals"] }> {
  const snapshots = supportingSnapshots(day);
  const covered = coveredNewsletterUrls(day, stories);
  // A selection report is written only after dropDeadCandidates(), so its exact harvest join is the
  // dead-link gate for radar rows. Radar rows are intentionally not added to prior coverage: they carry.
  const radar = rankedRadarCandidates(supportingReports(day, snapshots), snapshots, covered);
  if (!includeOtherDesks) return { radar, signals: [] };
  const current = snapshots.filter((snapshot) => snapshot.day === day);
  const candidates = otherDeskCandidates(current, newsletterSourceNames(), otherEditionItems(day, currentVideo), [...covered, ...radar.map((row) => row.url)]);
  if (!candidates.length) return { radar, signals: [] };
  const { checkUrls } = await import("../validate.js");
  const live = new Map((await checkUrls(candidates.map((row) => ({ url: row.url, context: row.source })))).map((row) => [row.url, row.ok]));
  return { radar, signals: candidates.filter((row) => live.get(row.url) === true) };
}

export function toMarkdown(d: NewsletterData): string {
  const items = d.issue.items.map((i) => `- **[${i.name}](${i.url})** — ${i.line}`).join("\n");
  const itemsSection = d.issue.items.length ? `\n## ${NEWSLETTER_SECTION_HEADINGS.worthYourTime}\n${items}\n` : "";
  const radarSection = d.issue.radar.length
    ? `\n## ${NEWSLETTER_SECTION_HEADINGS.radar}\n${d.issue.radar.map((r) => `- [${r.repo}](${r.url}) — ${r.line}`).join("\n")}\n`
    : "";
  const signals = d.issue.signals.length
    ? `\n## ${NEWSLETTER_SECTION_HEADINGS.otherDesks}\n${d.issue.signals.map((s) => `- ${s.source}: [${s.line}](${s.url})`).join("\n")}\n`
    : "";
  const video = d.video
    ? d.video.posted && isPublicVideoUrl(d.video.videoUrl)
      ? `🎬 **Today's video (${d.video.durationSec}s): [${d.video.headline}](${d.video.videoUrl})**`
      : `🎬 **Today's video (${d.video.durationSec}s): ${d.video.headline} — video available after publishing.**`
    : "";
  return `<!-- subject: ${d.issue.subject} -->
# ${d.publisher?.publication ?? publisher().publication}
*${d.dateLong} · Issue #${d.issueNo}*

${video}

## The lead: ${d.issue.lead.title}
${d.issue.lead.body} ([${d.issue.lead.sourceName}](${d.issue.lead.sourceUrl}))
${itemsSection}${radarSection}${signals}
*Covered this week: ${d.coveredWeek.join(" · ")}*

— ${d.publisher?.name ?? publisher().name}
`;
}

export function renderedNewsletterOutputs(data: NewsletterData): { markdown: string; web: string; linkedin: string } {
  const outputs = {
    markdown: toMarkdown(data),
    web: renderNewsletterHtml(data),
    linkedin: renderLinkedInEdition(data),
  };
  const required = {
    worthYourTime: data.issue.items.length > 0,
    radar: data.issue.radar.length > 0,
    otherDesks: data.issue.signals.length > 0,
  };
  assertCanonicalNewsletterHeadings(outputs.markdown, "markdown", required);
  assertCanonicalNewsletterHeadings(outputs.web, "web", required);
  assertCanonicalNewsletterHeadings(outputs.linkedin, "linkedin", required);
  return outputs;
}

/** Publish helper for the LinkedIn newsletter (no article API exists):
 *  rich-text edition → clipboard, composer opened — paste, title, publish. */
export async function linkedinNewsletter(date?: string, editionId?: string): Promise<void> {
  const day = validDay(date ?? todayStamp());
  if (editionId) safeId(editionId);
  const isSpecial = !!editionId && editionId !== "daily-roundup";
  const key = isSpecial ? `${day}-${editionId}` : day; // edition-scoped artifacts
  const liPath = join(NEWSLETTER_DIR, `${key}.linkedin.html`);
  if (!existsSync(liPath)) await newsletter(day, existsSync(join(NEWSLETTER_DIR, `${key}.json`)), editionId);
  const dataPath = join(NEWSLETTER_DIR, `${key}.json`);
  const staged = existsSync(dataPath) ? readJson<BoundNewsletterData>(dataPath) : null;
  const subject = staged?.issue.subject ?? day;
  // Staging is publication in all but the paste: a package whose locked visual is a photograph captured from its
  // source (rights: review-only) can be previewed, never staged or approved — attribution is not clearance.
  if (typeof staged?.sourceVideoId === 'string' && staged.sourceVideoId) {
    const { unclearedVisualStories } = await import('./visual-choice.js');
    const uncleared = unclearedVisualStories(videoDir(staged.sourceVideoId));
    if (uncleared.length) throw new Error(`Story ${uncleared.map(i => i + 1).join(', ')} shows a photograph captured from its source and its rights are not established; choose your own image, the attributed headline card or the explanation before staging this edition.`);
  }

  if (process.platform === "darwin") {
    // HTML → RTF on the clipboard so LinkedIn's editor keeps headings/links/bold.
    const rtf = execFileSync("textutil", ["-convert", "rtf", "-stdout", liPath]);
    execFileSync("pbcopy", [], { input: rtf });
  } else {
    // Windows clipboard receives readable plain text; the explicit browser publisher remains the
    // richer formatting path. Avoid shell interpolation of generated article content.
    const plain = readFileSync(liPath, "utf8")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/h\d>|<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    copyTextToClipboard(plain);
  }
  openExternal("https://www.linkedin.com/article/new/", (error) => log(`composer open failed: ${error.message}`));
  // marker: publish flow initiated — records the TITLE actually staged, so live-detection
  // still works even if the local issue is regenerated with a different subject later
  writeFileSync(join(NEWSLETTER_DIR, `.pushed-${key}`), JSON.stringify({ at: new Date().toISOString(), subject }));
  log(`LinkedIn edition on clipboard (rich text). Composer opened.`);
  log(`  1. Paste (${process.platform === "darwin" ? "⌘V" : "Ctrl+V"}) into the article body`);
  log(`  2. Title: ${publisher().publication} — ${subject}`);
  log(`  3. Publish to your newsletter`);
}

/** Draft and validate text before media production. The same task checkpoints are reused when
 * the final issue receives its video and supporting links, including after a human review pause. */
export async function prepareCompanionText(id: string, support: Pick<Issue, 'radar' | 'signals'> = { radar: [], signals: [] },
  preparedContext?: Awaited<ReturnType<typeof import('./writing-context.js').packageWritingContext>>) {
  if (existsSync(join(videoDir(id), 'media-continuation.json'))) {
    const context = (await import('./media-continuation.js')).openMediaContinuation(activeRoot(), id);
    if (preparedContext && (preparedContext.writerKey !== context.writerKey || preparedContext.parent.parentIdentity !== context.parent.parentIdentity)) throw new Error('Newsletter presentation must use the authorized media continuation for this package');
    context.assertUnchanged();
    return { issue: context.issue, context };
  }
  const { packageWritingContext } = await import('./writing-context.js');
  const context = preparedContext ?? await packageWritingContext(id, 'edition');
  if (context.topic.id !== id || context.parent.parentId !== id) throw new Error('Newsletter development needs this exact prepared package');
  if (context.dailyEditorial) {
    const { prepareJourneyEditorial } = await import('./journey-editorial.js');
    const { issue } = await prepareJourneyEditorial(context);
    return { issue, context };
  }
  const day = validDay(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`);
  const ed = editionForVideo(id);
  const key = ed.editionId === 'daily-roundup' ? day : `${day}-${ed.editionId}`;
  const stories: NewsletterStory[] = context.topic.stories ?? [{ headline: context.topic.headline, weight: 'lead', primaryUrl: context.topic.primaryUrl }];
  const personalization = readPersonalization(activeRoot());
  const length = personalization.newsletterLength ? NEWSLETTER_LENGTHS[personalization.newsletterLength].words : undefined;
  const script = readJson<import('../types.js').Script>(join(videoDir(id), 'script.json'));
  const { assertPreparedScriptReceipt } = await import('./writing-context.js');
  assertPreparedScriptReceipt(readJson(join(videoDir(id), 'companion-writing-receipt.json'), null), context.topic, context.writerKey, script);
  if (!(await import('./writing-context.js')).journeyReviewPortEnabled()) {
    const issue = await draftIssueFromScript(stories, script, day, context.call('newsletter'));
    return { issue, context };
  }
  const checkpointPath = join(videoDir(id), 'newsletter-formatting-checkpoint.json');
  const issue = await formatScriptNewsletter({ script, topic: context.topic, day, publication: publisher().publication, writerKey: context.writerKey,
    budget: length ? bandForStoryCount({ min: length[0], max: length[1] }, context.topic.stories?.length ?? 1) : (([min, max]) => ({ min, max }))(defaultNewsletterWords(context.topic.stories?.length ?? 1)), call: context.call('newsletter'),
    checkpoint: readJson<ScriptNewsletterCheckpoint | null>(checkpointPath, null) ?? undefined, save: checkpoint => atomicJson(checkpointPath, checkpoint) });

  return { issue, context };
}

export async function newsletter(date?: string, rerenderOnly = false, editionId?: string, videoId?: string): Promise<string> {
  const day = validDay(date ?? todayStamp());
  if (editionId) safeId(editionId);
  // Edition routing: special editions write EDITION-SCOPED filenames (<day>-<edition>.*) so an
  // additional same-day issue never clobbers the daily one, and they select only their own video.
  const ed = loadEdition(editionId);
  const isSpecial = ed.editionId !== "daily-roundup";
  const key = isSpecial ? `${day}-${ed.editionId}` : day;
  if (videoId) safeId(videoId);
  const dataPath = join(NEWSLETTER_DIR, `${key}.json`);
  if (rerenderOnly && !existsSync(dataPath)) throw new Error(`No cached issue data at ${dataPath} — run without --rerender first`);
  const cachedData = rerenderOnly ? readJson<BoundNewsletterData>(dataPath) : undefined;
  if (rerenderOnly && (typeof cachedData?.sourceVideoId !== 'string' || !cachedData.sourceVideoId)) throw new Error('Cached newsletter has no source video identity; regenerate it for the selected package before rerendering');
  const allTodayIds = existsSync(VIDEOS_DIR)
    ? readdirSync(VIDEOS_DIR).filter((id) => id.startsWith(day.replace(/-/g, "")))
    : [];
  const editionIds = allTodayIds
    .filter((id) => editionForVideo(id).editionId === ed.editionId)
    // Ignore stale partials a recovery run rejected/failed, so the issue is never built around a
    // superseded video when two same-day roundup dirs exist (see the produce.ts guard recovery).
    .filter((id) => {
      const mp = join(VIDEOS_DIR, id, "meta.json");
      if (!existsSync(mp)) return false;
      const s = readJson<VideoMeta>(mp).status;
      return !s.startsWith("failed") && s !== "rejected";
    });
  const vid = newsletterVideoId(editionIds, videoId, cachedData?.sourceVideoId);
  const serial = isSpecial && vid ? readJson<VideoMeta>(join(VIDEOS_DIR, vid, "meta.json")).editionSerial : undefined;
  const continuation = vid && existsSync(join(videoDir(vid), 'media-continuation.json'))
    ? (await import('./media-continuation.js')).openMediaContinuation(activeRoot(), vid) : undefined;

  // --rerender: rebuild md/html from the cached issue data, no LLM call
  if (rerenderOnly) {
    const data = cachedData!;
    if (continuation && newsletterHash(data.issue) !== newsletterHash(continuation.issue)) throw new Error('Cached newsletter differs from the accepted issue; media continuation cannot replace its text');
    const selectedLength = readPersonalization(activeRoot()).newsletterLength;
    if (selectedLength) {
      const [min, max] = NEWSLETTER_LENGTHS[selectedLength].words;
      // Scale the same way the draft did (bandForStoryCount): a cached one-story issue is checked against the scaled band, not the three-story one.
      assertNewsletterLength(data.issue, bandForStoryCount({ min, max }, data.issue.items.length + 1));
    }
    let stories: Pick<TopicStory, "headline" | "summary" | "weight" | "primaryUrl">[] = [];
    if (vid) {
      const topic = readJson<Topic>(join(VIDEOS_DIR, vid, "topic.json"));
      assertNewsletterCache(data, topic);
      stories = topic.stories ?? [{ headline: topic.headline, summary: topic.angle, weight: "lead" as const, primaryUrl: topic.primaryUrl }];
    }
    // Presentation-only refresh: keep the already approved story set and source links.
    // No new supporting stories, source fetches or editorial calls are introduced here.
    const briefing = await briefingAudio(day, vid); // always computed fresh, never cached
    data.audioDataUri = briefing?.dataUri ?? null;
    data.captionWords = briefing?.words ?? null;
    data.video = await todaysVideo(day, vid); // refresh posted-state + link so a rerender AFTER posting adds the video link
    data.videoDataUri = videoDataUri(data.video);
    data.editionAccent = ed.videoAccent; // re-read from config, so a palette change lands on a --rerender
    data.editionCover = ed.coverFile;    // ditto for the cover — both are branding, not cached content
    data.logoDataUri = logoDataUri(activeRoot()); data.styleDirection = readPersonalization(activeRoot()).styleDirection; // customer identity, same rule
    data.brand = newsletterBrand(ed.videoAccent); data.customShell = newsletterShell(activeRoot());
    await attachStoryVisuals(data,vid);
    const outputs = renderedNewsletterOutputs(data);
    if (readPersonalization(activeRoot()).newsletterImages) assertIssueCarriesVisuals(key,data,outputs.web);
    writeFileSync(dataPath, JSON.stringify({...data, audioDataUri:undefined, captionWords:undefined, videoDataUri:undefined, logoDataUri:undefined, brand:undefined, customShell:undefined},null,2));
    writeFileSync(join(NEWSLETTER_DIR, `${key}.md`), outputs.markdown);
    const htmlPath = join(NEWSLETTER_DIR, `${key}.html`);
    writeFileSync(htmlPath, outputs.web);
    writeFileSync(join(NEWSLETTER_DIR, `${key}.linkedin.html`), outputs.linkedin);
    log(`Newsletter re-rendered from cache → ${htmlPath}`);
    await rebuildSite();
    return htmlPath;
  }

  const selectedTopic = vid ? readJson<Topic>(join(VIDEOS_DIR, vid, 'topic.json')) : undefined;
  const stories: NewsletterStory[] = selectedTopic?.stories ?? (selectedTopic ? [{ headline: selectedTopic.headline, weight: 'lead', primaryUrl: selectedTopic.primaryUrl }] : []);
  if (stories.length === 0) throw new Error(`No ${ed.editionId} video topics for ${day} — run produce first`);

  const { issue } = await prepareCompanionText(vid!);

  // Source identity is assembled directly from the selected package, never repaired from model URLs.
  const leadStory = stories.find((s) => s.weight === "lead") ?? stories[0];

  // Source verification belongs to scripting. Newsletter formatting retains those exact
  // code-owned links instead of making another network/source-review pass.

  mkdirSync(NEWSLETTER_DIR, { recursive: true });
  // Daily issues number sequentially; a special edition uses its OWN serial (e.g. Extra № 1).
  const issueNo =
    isSpecial && serial != null
      ? serial
      : readdirSync(NEWSLETTER_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && !f.startsWith(day)).length + 1;
  const {name,publication,audience,tone} = publisher();
  const identity = {name,publication,audience,tone};
  const currentVideo = await todaysVideo(day, vid);
  const data: BoundNewsletterData = {
    publisher: identity,
    issue,
    issueNo,
    date: day,
    dateLong: new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
    ...newsletterCacheIdentity(readJson<Topic>(join(VIDEOS_DIR, vid!, 'topic.json')), issue),
    video: currentVideo,
    coveredWeek: recentEntries(7).filter(e => e.status === "posted").map((e) => e.headline),
    editionBadge: resolveBadge(ed, serial), // "EXTRA!! EDITION!! № 1 · WEEK 1" (null for daily)
    editionTitle: resolveTitle(ed, issue.subject, serial), // article title used at publish time
    editionCover: ed.coverFile, // cover the publisher uploads for this edition
    editionAccent: ed.videoAccent, // same accent the video uses — the issue was hardcoded to daily purple
    logoDataUri: logoDataUri(activeRoot()), // the customer's own logo, never another workspace's
    styleDirection: readPersonalization(activeRoot()).styleDirection,
    brand: newsletterBrand(ed.videoAccent),
    customShell: newsletterShell(activeRoot()),
  };
  const briefing = await briefingAudio(day, vid);
  data.audioDataUri = briefing?.dataUri ?? null;
  data.captionWords = briefing?.words ?? null;
  data.videoDataUri = videoDataUri(currentVideo);

  await attachStoryVisuals(data,vid);
  const outputs = renderedNewsletterOutputs(data);
  if (readPersonalization(activeRoot()).newsletterImages) assertIssueCarriesVisuals(key,data,outputs.web);
  const mdPath = join(NEWSLETTER_DIR, `${key}.md`);
  writeFileSync(mdPath, outputs.markdown);
  const htmlPath = join(NEWSLETTER_DIR, `${key}.html`);
  writeFileSync(htmlPath, outputs.web);
  writeFileSync(join(NEWSLETTER_DIR, `${key}.linkedin.html`), outputs.linkedin);
  // cache issue data for --rerender — minus the media blobs + word stamps, recomputed each render
  writeFileSync(
    join(NEWSLETTER_DIR, `${key}.json`),
    JSON.stringify({ ...data, audioDataUri: undefined, captionWords: undefined, videoDataUri: undefined, logoDataUri: undefined, brand: undefined, customShell: undefined }, null, 2)
  );
  log(`Newsletter written → ${mdPath} + ${htmlPath}`);
  await rebuildSite();
  return htmlPath;
}
