import type { StoryEventPacket } from './memory/story-identity.js';
export type Source = "hn" | "gh-trending" | `rss:${string}` | `public-api:${string}` | `web:${string}`;

export interface RepoInfo {
  fullName: string;
  stars: number;
  starsToday?: number;
  language?: string;
  description?: string;
  url: string;
}

export interface HarvestItem {
  id: string; // sha1(url)
  source: Source;
  title: string;
  url: string;
  score: number; // HN points, repo stars-today, or 0 for RSS
  publishedAt: string | null;
  repo: RepoInfo | null;
  summary: string;
  /** RSS only: the feed URL's hostname — `source` carries the operator's feed name, not a host. */
  origin?: string;
}

export interface HarvestFile {
  fetchedAt: string;
  items: HarvestItem[];
}

export type TopicKind = "news" | "repo" | "roundup";

export type StoryWeight = "lead" | "standard" | "quick";

/** Exact omitted source conditions used only to restrict or reject a positive claim. */
export interface SourceConditionRestriction { sourceSentenceId: number; text: string }
export interface ClaimEvidence {
  url: string; role: "primary" | "corroborating"; status: number | null;
  sha256: string | null; observedAt: string; publishedAt?: string | null;
  /** Hash of the complete captured readable text, not the selected claim subset. */
  textSha256?: string | null;
  restrictions?: SourceConditionRestriction[];
}

export interface TopicStory {
  n: number; // 1-based order in the video
  headline: string;
  summary: string; // what happened + why it matters
  weight: StoryWeight; // lead ≈ 40% of airtime, standard ≈ 25%, quick ≈ 15%
  primaryUrl: string;
  repo: RepoInfo | null;
  assetRef: string; // "og-0", "og-1", ... assigned at rank time
  suggestedScene: SceneKind;
  /** The principal company, lab, project, or team the story is about — validated at selection so
   *  at most one story per entity ships in a slate (see selectionClassificationProblem). */
  principalEntity: string;
  /** Exactly one of the operator's configured `editorial.areas.focusAreas`. */
  area: string;
  /** One or more of the operator's configured `editorial.areas.verticals`. */
  verticals: string[];
  /** Local validator notes when an unknown label used an operator-configured catch-all. */
  classificationNotes?: string[];
  /** Claims the captured sources DIRECTLY support, pinned at selection (pin-claims.ts). When present,
   *  this list is the story's whole fact budget for the script; absent means the story was kept
   *  a legacy or explicit fixture input; current live selection stops when its claim judge fails. */
  verifiedClaims?: string[];
  /** Which bytes were judged: url, role, HTTP status, sha256 of the raw capture, timestamp. */
  claimEvidence?: ClaimEvidence[];
  /** Source-bound event annotation; stale annotations are discarded before comparison. */
  storyEvent?: StoryEventPacket;
}

export interface Topic {
  id: string; // YYYYMMDD-slug
  kind: TopicKind;
  headline: string;
  angle: string;
  sourceItems: string[];
  primaryUrl: string;
  repo: RepoInfo | null;
  alternates: { headline: string; primaryUrl: string }[];
  stories?: TopicStory[]; // roundup slate, or one captured/reviewed source after single-topic preparation
}

export type SceneKind = "news_card" | "repo_card" | "stat_chart";

export interface ScriptSegment {
  voiceover: string;
  scene: SceneKind;
  onScreen: { title: string; stat?: string; sub?: string };
  /** Presenter formats only: every spoken line belongs to exactly one cast member (src/pipeline/cast.ts);
   *  `voiceover` is these texts joined in order, so every existing budget/timing check still applies. */
  lines?: { speaker: string; text: string }[];
  assetRef?: string;
  /** Source-backed mechanism brief. Required for prepared script scenes; it is the ONLY input the diagram
   *  illustrator is allowed to draw from, so a segment without one gets no artwork. */
  motion?: StoryMotion;
  /** Complete source packet rendered as an attributed text card, without an inferred mechanism. */
  sourceAccount?: { version: 1; claims: string[]; sourceUrl: string; packetHash: string; evidenceHash: string };
  /** Authored diagram shared with the newsletter; see src/pipeline/story-diagram.ts. */
  diagram?: StoryDiagram;
  /** Per-ISSUE diagram style, resolved by diagramStyleForDay() from the content day so the video and
   *  the newsletter cannot render one story in two different styles. */
  diagramStyle?: "studio" | "handwritten";
}

export interface PublishMeta {
  title: string;
  description: string;
  hashtags: string[];
  linkedinPost: string;
}

export interface Script {
  hook: string;
  /** Complete unformatted newsletter copy, verified with the script before presentation. */
  editorialCopy?: { storyId: string; text: string }[];
  /** Code-owned publication ident, spoken after the source-backed hook. Older scripts may omit it. */
  intro?: string;
  body: ScriptSegment[];
  cta: string;
  fullVoiceoverText: string;
  publish: PublishMeta;
}

export type VideoStatus =
  | "selected"
  | "scripted"
  | "assets_ready"
  | "awaiting_story_choice"
  | "awaiting_visual_choice"
  | "voiced"
  | "avatar_generated"
  | "rendered"
  | "pending_review"
  | "approved"
  | "rejected"
  | "posted"
  | `failed:${string}`;

export type Platform = "youtube" | "instagram" | "linkedin" | "x" | "threads" | "tiktok" | "reddit";

export interface PostResult {
  platform: Platform;
  id: string; // platform-native id/urn
  /** Missing means legacy/unknown. A profile match never proves which artifact was submitted. */
  receiptOrigin?: "provider-response" | "profile-discovery";
  url?: string;
  note?: string;
  postedAt: string;
}

/** Explicit per-destination delivery state (distribution kernel). A poster returning an id is only
 *  `unconfirmed` — a receipt is not proof of liveness; `confirmed` is reserved for an independent
 *  live probe. `withheld` = a gate held the release; `skipped` = not in scope. */
export type DeliveryState = "confirmed" | "unconfirmed" | "failed" | "skipped" | "withheld";

export interface PublishOutcome {
  credentialFingerprint?: string;
  platform: Platform;
  state: DeliveryState;
  /** May an automated re-run attempt this destination again without a human? */
  retryable: boolean;
  providerId?: string;
  url?: string;
  reason?: string;
  at: string;
}

export interface VideoMeta {
  createdBy?: string;
  /** Written by `produce --dry-run`; such a package stops at "selected" and is not listed for review. */
  dryRun?: boolean;
  approvedBy?: { id: string; role: string };
  reviewHold?: { requestedAt: string; reason: string };
  explicitApproval?: {
    approvedAt: string; topicSha256: string; scriptSha256: string; videoSha256: string;
    newsletterHtmlSha256?: string; newsletterLinkedinHtmlSha256?: string; newsletterDataSha256?: string;
  };
  id: string;
  status: VideoStatus;
  headline: string;
  createdAt: string;
  updatedAt: string;
  durationSec?: number;
  rejectReason?: string;
  posts: Partial<Record<Platform, PostResult>>;
  /** Latest explicit delivery outcome per destination — a PROJECTION of the append-only
   *  `delivery-events.jsonl` beside this file (src/post/delivery.ts), re-derived from the whole
   *  log each time an outcome is recorded and persisted with the next meta.json write. The log is
   *  authoritative; this field may lag it. Unlike `posts`, it also records failures and skips.
   *  `posts` remains the completion record; nothing keys idempotence on this field. */
  delivery?: Partial<Record<Platform, PublishOutcome>>;
  edition?: string; // edition preset id (e.g. "example-topic"); absent -> daily-roundup
  editionSerial?: number; // per-edition serial number
}

export interface WordStamp {
  w: string;
  start: number;
  end: number;
}

export interface Timestamps {
  narrationSha256?: string;
  durationSec: number;
  engine: "kokoro" | "edge" | "elevenlabs" | "resemble" | "voicebox";
  words: WordStamp[];
  /** Presenter formats: who speaks when, from the per-line synthesis (src/pipeline/voice-cast.ts). */
  lines?: { speaker: string; name: string; role: string; startSec: number; endSec: number; engine: Timestamps["engine"] }[];
}

export interface AssetManifest {
  // assetRef -> relative file path under the video workdir, e.g. "assets/og-0.png"
  [ref: string]: string;
}

/** Props handed to the Remotion <Short> composition via props.json */
export interface RenderProps {
  headline: string;
  hook: string;
  prelude?: { kind: 'hook' | 'intro'; text: string; startSec: number; endSec: number }[];
  cta: string;
  segments: (ScriptSegment & {
    /** Exact attributed text card selected by the user; presentation never edits script fields. */
    sourceSnapshot?: { caption: string; publisher: string; sourceUrl: string };
    visualTiming?: import("./pipeline/visual-timing.js").VisualTiming;
    startSec: number;
    endSec: number;
    assetFile: string | null;
    repo?: RepoInfo | null; // per-segment repo for roundups (multiple repos per video)
  })[];
  words: WordStamp[];
  durationSec: number;
  audioFile: string;
  accent: string;
  /** Brand tokens (light/dark, colours, fonts) from Personalize or branding/video-theme.json; absent = neutral light default. */
  theme?: import("../video/theme.js").VideoTheme | null;
  /** Personalize → Video style: background family and caption style; absent = brand wash, clean captions. */
  videoBackground?: "brand" | "studio" | "newsroom";
  captionStyle?: "clean" | "boxed" | "pill" | "glow";
  newsletterLine?: string; // CTA end-card: pointer to the publication
  logoFile?: string | null; // CTA end-card: the customer's own logo, public-dir-relative ("<id>/logo.png"); null = text mark only
  speakers?: { name: string; role: string; startSec: number; endSec: number }[]; // presenter formats: name chip while each member speaks
  stars?: { date: string; count: number }[];
  repo?: RepoInfo | null;
  // Avatar mode: HeyGen talking-head video (public-dir-relative, e.g. "<id>/avatar.mp4").
  // Present only when config/avatar.json mode is "avatar"|"hybrid" and avatar.mp4 exists.
  presenterVideo?: string | null;
  avatarMode?: "cards" | "avatar" | "hybrid";
  presenterScale?: number; // hybrid inset width as fraction of frame (e.g. 0.4)
  presenterCorner?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  // Cold-open intro clip (public-dir-relative, e.g. "<id>/intro.mp4") prepended before the content,
  // playing with ITS OWN audio; the content (scenes + captions + audio) shifts to start after it.
  introClip?: string | null;
  introDurationSec?: number;
  avatarIntroSec?: number; // show the (capped) avatar inset only for the first N seconds, then it disappears
}

/** config/avatar.json */
export interface AvatarConfig {
  mode: "cards" | "avatar" | "hybrid";
  avatarProvider?: "heygen" | "hedra" | "fal" | "heygem"; // which engine the avatar stage uses (default "heygen"); "heygem" = open-source Duix.Heygem (self-hosted, free)
  voiceProvider: "kokoro" | "elevenlabs" | "resemble" | "voicebox";
  voicebox?: { profile: string };
  disclosure: string;
  elevenlabs: {
    voiceId: string;
    modelId: string;
    stability: number;
    similarityBoost: number;
    style: number;
    speakerBoost: boolean;
  };
  resemble?: {
    voiceUuid: string; // Resemble AI (Chatterbox) cloned-voice UUID; API key in RESEMBLE_API_KEY
  };
  heygen: {
    avatarId: string; // HeyGen photo-avatar id (or studio/digital-twin avatar id) — from a one-time avatar creation
    engine?: "avatar_iii" | "avatar_iv" | "avatar_v"; // v3 engine; server defaults to avatar_iv when omitted
    resolution?: string; // "1080p" → 1080×1920 at 9:16 (short edge)
    expressiveness?: string; // photo-avatar body-motion level for Avatar IV, e.g. "high"
    motionPrompt?: string; // optional natural-motion description (photo avatars)
    avatarStyle?: string; // legacy v2 studio-avatar style — unused by the v3 path
    background: string;
    ratio: string; // aspect_ratio, e.g. "9:16"
    presenterScale: number;
    presenterCorner: "bottom-right" | "bottom-left" | "top-right" | "top-left";
    pollSeconds: number;
    maxPollMinutes: number;
  };
  hedra?: {
    modelId: string; // Hedra Character-3 / Avatar model id
    sourceImage: string; // path (repo-root-relative) of the portrait Hedra animates + lip-syncs
    aspectRatio: string; // "9:16" | "1:1" | "16:9"
    resolution: string; // e.g. "720p"
    pollSeconds: number;
    maxPollMinutes: number;
    introSeconds?: number; // cap the avatar to the first N seconds (short, cheap "opening" avatar)
  };
  fal?: {
    model?: string; // fal model id, e.g. "fal-ai/kling-video/ai-avatar/v2/standard" or "fal-ai/bytedance/omnihuman/v1.5"
    sourceImage: string; // repo-root-relative portrait the fal model animates + lip-syncs
    prompt: string; // motion/behaviour prompt (Kling/OmniHuman are instruction-tunable — drives head movement + gestures)
    introSeconds?: number; // cap the avatar to the first N seconds (short, cheap "opening" inset that then disappears)
    pollSeconds: number;
    maxPollMinutes: number;
  };
  /** Duix.Heygem (github.com/GuijiAI/HeyGem.ai) — open-source, self-hosted lip-sync. Requires the
   *  face2face Docker service on an NVIDIA GPU box. Its API takes paths RELATIVE to the service's
   *  data volume (no HTTP upload), so files are staged either via a locally-mounted dataDir or scp. */
  heygem?: {
    baseUrl?: string; // face2face service, e.g. "http://avatar-host.example:8383" (env HEYGEM_BASE_URL overrides)
    dataDir?: string; // the service's data volume as seen from this machine
    ssh?: string; // optional SSH host for an explicitly configured remote adapter
    remoteDataDir?: string; // remote service data-volume path used with SSH
    sourceVideo: string;
    chaofen?: 0 | 1; // super-resolution pass (slower, sharper); default 0
    introSeconds?: number; // cap the avatar to the first N seconds (opening inset that then disappears)
    pollSeconds: number;
    maxPollMinutes: number;
  };
}

export interface LedgerEntry {
  id: string;
  headline: string;
  urls: string[];
  repo: string | null;
  coveredAt: string;
  status: "selected" | "posted" | "rejected";
  posts: Partial<Record<Platform, string>>;
}

export interface Ledger {
  entries: LedgerEntry[];
  editionSerials?: Record<string, number>; // per-edition serial counters
}

/* ------------------------------------------------------------------------------------------------
 * STORY VISUALS
 *
 * One source-backed illustration per story, authored once per edition and shared VERBATIM by the
 * newsletter and the video. Both media read the same `diagrams.json`, so a story cannot be drawn two
 * different ways — that parity is a construction guarantee, not something a check restores later.
 * ---------------------------------------------------------------------------------------------- */

/** Coarse mechanism family. Drives the schematic's opening shape, never the whole drawing. */
export type StoryMotionKind = "device" | "memory" | "robot" | "compress" | "flow";

/**
 * Which illustrator produced the drawing.
 *
 * `authored` is the model-authored, per-story diagram; `story-schematic` is the deterministic
 * fallback that runs when authoring fails or is unavailable, so an unattended edition still ships a
 * drawing rather than a bare card.
 */
export type StoryVisualPrimitive = "authored" | "story-schematic";

/** Descriptor shape shared by the authored diagram and the deterministic schematic. */
export interface StoryVisualDescriptorLike {
  primitive: StoryVisualPrimitive;
  label: string;
  reading: string;
  legend: readonly { kind: "source" | "change" | "route" | "result" | "muted"; label: string }[];
}

export interface StoryMetricPoint {
  label: string;
  value: number;
}

/** Optional quantitative evidence carried by the same story object as its mechanism map. */
export interface StoryMetric {
  value: number;
  display: string;
  label: string;
  points?: StoryMetricPoint[];
  observedAt?: string;
}

/** One source-backed visual explanation shared by the video and newsletter outputs. */
export interface StoryMotion {
  who: string;
  what: string;
  how: string;
  impact: string;
  status: string;
  kind: StoryMotionKind;
  /** Deterministic illustration selected from the story's source-backed semantics. */
  visual?: StoryVisualPrimitive;
  /** Omit when the source has no defensible number; renderers must never invent one. */
  metric?: StoryMetric;
}

/** Authored diagram for one story, generated once per edition and shared by BOTH media. */
export interface StoryDiagram {
  review?: {status:"passed"|"failed"|"unverified";sha256:string;reason:string;before?:string;after?:string};
  visual?: import("./pipeline/visual-plan.js").VisualPlan;
  svg: string;
  label: string;
  reading: string;
  legend: { kind: "source" | "change" | "route" | "result" | "muted"; label: string }[];
}

/* ------------------------------------------------------------------------------------------------
 * SELECTION POLICY
 *
 * What the operator covers is CONFIGURATION (`config/sources.json`); how evidence is judged is code.
 * See src/pipeline/selection-policy.ts for why that line is drawn where it is.
 * ---------------------------------------------------------------------------------------------- */

/** The operator's editorial territory: their mission, their subject areas, their impact verticals. */
export interface SelectionAreas {
  /** One sentence naming what this publication is looking for. Interpolated into every selection prompt. */
  mission?: string;
  /** Subject areas a story is classified INTO — exactly one per story. */
  focusAreas?: string[];
  /** Impact domains a story is tagged WITH — one or more per story. */
  verticals?: string[];
}

/**
 * Community interest and evidence maturity, kept apart on purpose.
 *
 * Merged into a single "score" a model will happily present heavy discussion as though it were peer
 * review. `not-provided` carries null rather than prose, because a sentence in an absent-evidence
 * field IS an invented metric.
 */
export interface StorySelectionEvidence {
  communityInterest: {
    status: "observed" | "not-provided";
    /** Source-backed description when observed; MUST be null when not-provided. */
    evidence: string | null;
  };
  maturity: {
    status:
      | "peer-reviewed"
      | "preprint"
      | "published-report"
      | "established-news-reporting"
      | "official-technical-release"
      | "repository"
      | "announcement";
    evidence: string;
  };
}
