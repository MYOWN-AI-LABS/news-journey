// "Choose your stories": the person keeps, drops or swaps the day's stories — and picks the lead — before a word of
// script exists. Same shape as the visual choice: candidates are written once, a choice is locked to their hash, and
// `produce --resume <id>` writes the script from exactly the locked stories. Free of util/model imports on purpose:
// executive-actions loads it, and the connector child must never resolve a workspace at import.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Topic, TopicStory } from "../types.js";

export interface StoryEvidence {
  compositeScore: number | null;
  scoreBreakdown: { heat: number; provenance: number; freshness: number; channelRank: number } | null;
  outletsCovering: number | null; credibility: string | null; publishedAt: string | null; sourceHost: string;
}
export interface StoryEntry { key: string; role: "recommended" | "alternate"; story: TopicStory; sourceItemIds: string[]; evidence: StoryEvidence; /** Harvested URLs behind the story, reserved in the ledger once chosen. */ sourceUrls?: string[] }
export interface StoryChoiceLock { keys: string[]; lead: string; chosenBy: "user" | "recommendation"; lockedAt: string; candidatesHash: string }
export interface StoryChoiceFile { version: 1; createdAt: string; minStories: number; maxStories: number; recommendedLead: string | null; entries: StoryEntry[]; lock?: StoryChoiceLock }

const FILE = "story-choice.json";
export const storyKey = (s: Pick<TopicStory, "primaryUrl" | "headline">) => createHash("sha256").update(s.primaryUrl + "\n" + s.headline).digest("hex").slice(0, 16);
const candidatesHash = (f: StoryChoiceFile) => createHash("sha256").update(JSON.stringify({ min: f.minStories, max: f.maxStories, entries: f.entries })).digest("hex");

export function readStoryChoice(dir: string): StoryChoiceFile | null {
  try { return existsSync(join(dir, FILE)) ? JSON.parse(readFileSync(join(dir, FILE), "utf8")) as StoryChoiceFile : null; } catch { return null; }
}
function write(dir: string, f: StoryChoiceFile) { const p = join(dir, FILE); writeFileSync(p + ".tmp", JSON.stringify(f, null, 2)); renameSync(p + ".tmp", p); }
/** A lock counts only while the candidates it was made on are unchanged. */
const validLock = (f: StoryChoiceFile) => Boolean(f.lock) && f.lock!.candidatesHash === candidatesHash(f);

export function writeStoryChoice(dir: string, f: Omit<StoryChoiceFile, "version" | "createdAt" | "lock">, lockRecommendation: boolean): StoryChoiceFile {
  const file: StoryChoiceFile = { version: 1, createdAt: new Date().toISOString(), ...f };
  write(dir, file);
  // The unattended CLI keeps automatic selection and records that the recommendation chose.
  return lockRecommendation ? lockStoryChoice(dir, { accept: true }, "recommendation") : file;
}

/** Validate and lock a choice. `accept` takes the recommended slate; otherwise `keys` (in the order the person wants) and `lead`. */
export function lockStoryChoice(dir: string, choice: { accept?: boolean; keys?: string[]; lead?: string }, chosenBy: "user" | "recommendation"): StoryChoiceFile {
  const f = readStoryChoice(dir);
  if (!f) throw new Error("This package has no stories to choose from");
  const byKey = new Map(f.entries.map((e) => [e.key, e]));
  const keys = choice.accept ? f.entries.filter((e) => e.role === "recommended").map((e) => e.key) : [...new Set(choice.keys ?? [])];
  if (keys.some((k) => !byKey.has(k))) throw new Error("A chosen story is not one of this package's verified stories");
  if (keys.length < f.minStories || keys.length > f.maxStories) throw new Error(`Choose between ${f.minStories} and ${f.maxStories} stories (you chose ${keys.length})`);
  const seen = new Map<string, string>();
  for (const k of keys) {
    const primaryUrl = byKey.get(k)!.story.primaryUrl;
    if (seen.has(primaryUrl)) throw new Error("The same primary source was selected twice; keep one entry");
    seen.set(primaryUrl, k);
  }
  const lead = choice.lead ?? (f.recommendedLead && keys.includes(f.recommendedLead) ? f.recommendedLead : keys[0]);
  if (!keys.includes(lead)) throw new Error("The lead story must be one of the chosen stories");
  const locked: StoryChoiceFile = { ...f, lock: { keys, lead, chosenBy, lockedAt: new Date().toISOString(), candidatesHash: candidatesHash(f) } };
  write(dir, locked);
  return locked;
}

/** The locked stories, lead first, renumbered, exactly one lead. Refuses when unlocked or when the candidates changed after the lock. */
export function lockedStories(dir: string): { stories: TopicStory[]; sourceItems: string[]; urls: string[] } {
  const f = readStoryChoice(dir);
  if (!f?.lock) throw new Error("Waiting for your story choice");
  if (!validLock(f)) {
    // Clear the stale lock so the panel offers the choice again (callers hold the package's production lock).
    const { lock: _stale, ...unlocked } = f; write(dir, unlocked as StoryChoiceFile);
    throw new Error("The stories changed after they were chosen; choose them again");
  }
  const byKey = new Map(f.entries.map((e) => [e.key, e]));
  const ordered = [f.lock.lead, ...f.lock.keys.filter((k) => k !== f.lock!.lead)].map((k) => byKey.get(k)!);
  const stories = ordered.map((e, i) => ({ ...e.story, n: i + 1, assetRef: `og-${i}`, weight: i === 0 ? "lead" as const : e.story.weight === "lead" ? "standard" as const : e.story.weight }));
  return { stories, sourceItems: [...new Set(ordered.flatMap((e) => e.sourceItemIds))], urls: [...new Set(ordered.flatMap((e) => [e.story.primaryUrl, ...(e.sourceUrls ?? [])]))] };
}

/**
 * Rewrite topic.json from the locked choice; the script is then written from exactly these stories. The selection report
 * records the final slate (the model's recommendation is kept beside it as `recommendedStories`), and `urls` is what the
 * caller reserves in the ledger in place of the recommendation — a dropped story must not stay reserved.
 */
export function applyStoryChoice(dir: string): Topic & { reservedUrls: string[] } {
  const topic = JSON.parse(readFileSync(join(dir, "topic.json"), "utf8")) as Topic;
  const { stories, sourceItems, urls } = lockedStories(dir);
  // The roundup is titled after its lead; the title was set at ranking from the first candidate, and the chosen lead may be
  // another story (Quasar, Sep 17: the judge dropped the first candidate and the newsletter's video line still named it).
  const headline = topic.kind === "roundup" ? topic.headline.replace(/^(Roundup \d{4}-\d{2}-\d{2}): [\s\S]*$/, (_m, prefix: string) => `${prefix}: ${stories[0].headline}`) : topic.headline;
  const next: Topic = { ...topic, headline, stories, sourceItems, primaryUrl: stories[0].primaryUrl, repo: stories.find((s) => s.repo)?.repo ?? null };
  writeFileSync(join(dir, "topic.json.tmp"), JSON.stringify(next, null, 2)); renameSync(join(dir, "topic.json.tmp"), join(dir, "topic.json"));
  if (headline !== topic.headline && existsSync(join(dir, "meta.json"))) {
    const meta = { ...JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")), headline };
    writeFileSync(join(dir, "meta.json.tmp"), JSON.stringify(meta, null, 2)); renameSync(join(dir, "meta.json.tmp"), join(dir, "meta.json"));
  }
  const reportPath = join(dir, "selection-report.json");
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    const lock = readStoryChoice(dir)!.lock!;
    const final = { ...report, recommendedStories: report.recommendedStories ?? report.stories, stories: stories.map((s) => ({ order: s.n, headline: s.headline, primaryUrl: s.primaryUrl, weight: s.weight, principalEntity: s.principalEntity })), choice: { chosenBy: lock.chosenBy, lockedAt: lock.lockedAt } };
    writeFileSync(reportPath + ".tmp", JSON.stringify(final, null, 2)); renameSync(reportPath + ".tmp", reportPath);
  }
  return { ...next, reservedUrls: urls };
}

/** Read model for the Create stage: every offered story with its evidence in plain numbers. */
export function storyChoiceView(dir: string) {
  const f = readStoryChoice(dir);
  if (!f) return null;
  return {
    // "locked" means a lock that still applies; a lock made on candidates that changed shows the choice again.
    minStories: f.minStories, maxStories: f.maxStories, recommendedLead: f.recommendedLead, locked: validLock(f), staleLock: Boolean(f.lock) && !validLock(f),
    stories: f.entries.map((e) => ({ key: e.key, role: e.role, headline: e.story.headline, summary: e.story.summary, weight: e.story.weight, principalEntity: e.story.principalEntity, primaryUrl: e.story.primaryUrl, ...e.evidence })),
  };
}
