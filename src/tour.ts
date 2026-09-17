import { join } from "node:path";
import { ROOT, loadConfig, readJson } from "./util.js";
import type { SourcePreferencesConfig } from "./source-preferences.js";
import type { AvatarConfig } from "./types.js";
import { configuredModelRuntime } from "./llm/model.js";
import { isAppleSilicon, resolveFreeTtsEngine } from "./platform.js";

interface PipelineTourConfig {
  format: string;
  ttsEngine: "kokoro" | "edge";
}

export function productTour(): void {
  const pkg = readJson<{ version: string }>(join(ROOT, "package.json"));
  const sources = loadConfig<SourcePreferencesConfig>("sources");
  const pipeline = loadConfig<PipelineTourConfig>("pipeline");
  const avatar = loadConfig<AvatarConfig>("avatar");
  const model = configuredModelRuntime();
  const voice = ["elevenlabs", "resemble"].includes(avatar.voiceProvider)
    ? avatar.voiceProvider
    : pipeline.ttsEngine === "kokoro" && !isAppleSilicon()
      ? "Kokoro (requires Apple silicon; choose Edge explicitly for network narration)"
      : resolveFreeTtsEngine(pipeline.ttsEngine);
  const presenter = avatar.mode === "cards" ? "none (animated cards)" : `${avatar.avatarProvider ?? "heygen"} (${avatar.mode})`;

  console.log(`
News Journey v${pkg.version} - product tour

CURRENT CONFIGURATION
  Platform: ${process.platform}/${process.arch}
  Content model: ${model.label}
  Sources: ${(sources.enabledSources ?? ["hn", "githubTrending", "rss"]).join(", ")}
  Preferred topics: ${sources.editorial?.preferredTopics?.join(", ") || "none"}
  Format: ${pipeline.format}
  Voice: ${voice}
  Presenter: ${presenter}

THE REVIEW-FIRST JOURNEY
  1. CHOOSE     node start.mjs opens the browser: brief, writer, narration, Create my preview.
                 Advanced settings contains source, agent and publication controls.
                 For local models, run npm run models:recommend (llmfit-aware).
  2. PROVE      npm run dry-run
                 Uses a synthetic fixture and blocks models, providers, browsers, rendering, and publishing.
  3. COLLECT    npm run harvest
                 Reads only enabled public sources and applies topic exclusions.
  4. SELECT     npm run rank
                 Deduplicates and applies preferred topics plus editorial notes.
  5. CREATE     npm run script -> assets -> voice -> avatar -> render
                 Or run the full non-publishing pipeline with npm run produce.
  6. INSPECT    npm run review && npm run preview -- <video-id>
                 Review claims, links, narration, captions, visuals, and final.mp4.
  7. DECIDE     npm run approve -- <video-id>  OR  npm run reject -- <video-id> --reason "..."
                 Approval changes local state only; it does not publish.
  8. EXPORT     workdir/videos/<video-id>/final.mp4
  9. ENGAGE     Browser Engagement: collect/capture viewer responses, draft, review, explicitly reply.
                 X/YouTube API access or manual handoff; reaction-only signals have no reply thread.

EXAMPLES
  Safe product-tour preview:  npm run example:tour:dry-run
  Analyze local model fit:     npm run models:recommend -- --use-uvx
  Pure recommendation JSON:    npm run --silent models:recommend -- --use-uvx --json
  Full product-tour video:     npm run example:tour
  Full teaser video:           npm run example:teaser
  Connect APIs for your topics: npm run sources:setup
  Connect another JSON API:    npm run sources:connect
  Search the raw API catalog:  npm run sources:catalog -- --query "your topic"

WORKSPACES AND CONTROL
  Active data:               workspaces/<slug>/ after migration; --workspace selects it
  Create / migrate:          npm run workspace -- create <slug> / npm run workspace -- migrate
  Local review console:      npm run api:serve -- --port 4792 (see docs/control-api.md for token)
  Roles and desks:           npm run members -- list / npm run desk -- list
  Metrics and verification:  npm run metrics:weekly -- --days=7 / npm run verify:posts
  Approval binds exact artifacts; uncertain delivery waits for independent verification.

MEDIA PATHS
  macOS local:  Kokoro voice + MLX alignment + Remotion cards (Apple silicon)
  Windows:      Edge TTS + CPU faster-whisper + Remotion cards
  Online:       ElevenLabs or Resemble voice; HeyGen, Hedra, or fal avatar
  Self-hosted:  Kokoro voice + Duix.HeyGem avatar on a configured NVIDIA host

MODEL BOUNDARY
  Your coding agent's model runs OpenCode/Codex/Claude Code and needs reliable tool use.
  config/model.json independently selects the content model used by this harness.

Read QUICKSTART.md, docs/agent-compatibility.md, and docs/model-providers.md before a full run.
`);
}
