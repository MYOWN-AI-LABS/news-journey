import type { HarvestItem, SelectionAreas } from "./types.js";
import { selectionPolicy } from "./pipeline/selection-policy.js";
import type { VerificationConfig } from "./pipeline/verify-at-selection.js";

export const SOURCE_IDS = ["hn", "githubTrending", "rss", "publicApis", "web"] as const;
const DEFAULT_SOURCE_IDS: SourceId[] = ["hn", "githubTrending", "rss"];
export type SourceId = (typeof SOURCE_IDS)[number];

export interface EditorialPreferences {
  preferredTopics?: string[];
  excludedTopics?: string[];
  selectionNotes?: string;
  /**
   * The operator's editorial territory — mission, subject areas, impact verticals.
   *
   * This is the answer to "what should this harness go and cover?". Omit it and the pipeline runs
   * as a general publication over whatever the configured sources return; set it and every
   * selection prompt is written around it and every story is classified against it.
   */
  areas?: SelectionAreas;
}

export interface SourcePreferencesConfig {
  enabledSources?: SourceId[];
  editorial?: EditorialPreferences;
  /** Source-verification policy applied at SELECTION time; see pipeline/verify-at-selection.ts. */
  verification?: VerificationConfig;
  /** Operator-selected ordering; manual is the neutral default. */
  ranking?: import("./pipeline/user-ranking.js").RankingConfig;
}

function topicPattern(topic: string): RegExp | null {
  const trimmed = topic.trim();
  if (!trimmed) return null;
  const escaped = trimmed
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "[\\s_-]+");
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i");
}

export function matchesAnyTopic(text: string, topics: string[]): boolean {
  return topics.some((topic) => topicPattern(topic)?.test(text) ?? false);
}

export function getEnabledSources(cfg: SourcePreferencesConfig): Set<SourceId> {
  const requested = cfg.enabledSources ?? DEFAULT_SOURCE_IDS;
  const invalid = requested.filter((source) => !SOURCE_IDS.includes(source));
  if (invalid.length > 0) throw new Error(`Unknown enabled source: ${invalid.join(", ")}`);
  if (requested.length === 0) throw new Error("At least one source must be enabled in config/sources.json");
  return new Set(requested);
}

export function filterExcludedTopics(items: HarvestItem[], editorial?: EditorialPreferences): HarvestItem[] {
  const excluded = editorial?.excludedTopics?.filter((topic) => topic.trim()) ?? [];
  if (excluded.length === 0) return items;
  return items.filter((item) => {
    const text = [item.title, item.summary, item.repo?.fullName, item.repo?.description]
      .filter(Boolean)
      .join(" ");
    return !matchesAnyTopic(text, excluded);
  });
}

export function editorialBrief(editorial?: EditorialPreferences): string {
  const preferred = editorial?.preferredTopics?.filter((topic) => topic.trim()) ?? [];
  const excluded = editorial?.excludedTopics?.filter((topic) => topic.trim()) ?? [];
  const notes = editorial?.selectionNotes?.trim();
  return [
    selectionPolicy(editorial?.areas),
    "",
    "Operator-selected editorial scope:",
    `- Preferred topics: ${preferred.length > 0 ? preferred.join(", ") : "no additional preference"}`,
    `- Excluded topics: ${excluded.length > 0 ? excluded.join(", ") : "none"}`,
    `- Selection notes: ${notes || "choose the strongest verifiable stories from the configured sources"}`,
    "Treat preferred topics as priorities, not as permission to invent relevance or facts.",
  ].join("\n");
}
