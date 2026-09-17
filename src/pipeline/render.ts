import { buildSegmentTimes, narrationTiming } from "./visual-timing.js";
import { scriptPrelude } from './narration.js';
import { activeRoot, assetPath, contained } from "../workspaces.js";
import { readPersonalization, workspaceTheme } from "../personalization.js";
import { randomUUID } from "node:crypto";
import { MEDIA_PROCESS_LIMITS, runManagedProcess } from "../managed-process.js";
import { copyFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AssetManifest, AvatarConfig, RenderProps, Script, Timestamps, Topic, VideoMeta } from "../types.js";
import { portableCommand } from "../platform.js";
import { CONFIG_DIR, ROOT, VIDEOS_DIR, loadConfig, readJson, videoDir, writeJson, log } from "../util.js";
import { editionForVideo } from "./edition.js";
import { ensureEditionDiagrams } from "./story-diagram.js";
import { diagramStyleForDay } from "./diagram-style.js";
import { selectedSourceSnapshots } from "./visual-choice.js";

/** The active provider's intro cap in seconds, or undefined for full-length. MUST mirror
 *  introSecondsFor() in avatar.ts — if generation says "full length" and this says "30s", the
 *  avatar is paid for in full and shown for a third of the video. */
function introSecondsForRender(cfg: AvatarConfig | undefined): number | undefined {
  const p = cfg?.avatarProvider ?? "heygen";
  const s =
    p === "fal" ? cfg?.fal?.introSeconds
    : p === "hedra" ? cfg?.hedra?.introSeconds
    : p === "heygem" ? cfg?.heygem?.introSeconds
    : undefined; // heygen: full-length avatar, no cap
  return s && s > 0 ? s : undefined;
}

export async function render(id: string, preparedVisualContext?: Parameters<typeof ensureEditionDiagrams>[4]): Promise<string> {
  const dir = videoDir(id);
  const continuation = existsSync(join(dir, 'media-continuation.json'))
    ? (await import('./media-continuation.js')).openMediaContinuation(activeRoot(), id) : undefined;
  if (continuation && readJson<VideoMeta>(join(dir, 'meta.json')).status === 'pending_review') {
    throw new Error('This media continuation already reached preview; new rendering is closed');
  }
  const visualContext = continuation ?? preparedVisualContext;
  const topic = readJson<Topic>(join(dir, "topic.json"));
  const script = readJson<Script>(join(dir, "script.json"));
  const stamps = readJson<Timestamps>(join(dir, "timestamps.json"));
  const manifest = readJson<AssetManifest>(join(dir, "assets.json"), {});
  const edition = editionForVideo(id); // accent + CTA line come from the active edition

  const bounds = buildSegmentTimes(script, stamps);
  const bodyBounds = bounds.slice(script.intro ? 2 : 1, -1);

  let stars: RenderProps["stars"];
  if (manifest["stars"]) {
    stars = readJson(join(dir, manifest["stars"]));
  }

  // Avatar mode: if avatar.mp4 was generated and config isn't "cards", layer it in.
  const avatarCfg = existsSync(join(CONFIG_DIR, "avatar.json")) ? loadConfig<AvatarConfig>("avatar") : null;
  const hasPresenter = avatarCfg && avatarCfg.mode !== "cards" && existsSync(join(dir, "avatar.mp4"));
  const presenterVideo = hasPresenter ? `${id}/avatar.mp4` : null;
  // Personalize → Video style decides the framing when a presenter exists; without one it is always cards.
  const style = readPersonalization(activeRoot());
  const framing = style.videoFraming || "cards";
  const avatarMode = !hasPresenter || framing === "cards" ? "cards" : framing === "full" ? "avatar" : "hybrid";

  // Cold-open intro: copy the edition's intro clip into the public dir so Remotion can play it.
  const introSrc = edition.introClip ? assetPath(edition.introClip) : null;
  const hasIntro = !!introSrc && existsSync(introSrc);
  if (hasIntro && introSrc) copyFileSync(introSrc, join(dir, "intro.mp4"));
  const introClip = hasIntro ? `${id}/intro.mp4` : null;

  /**
   * Author the edition's diagrams ONCE, here, and hand the same objects to the video.
   *
   * `ensureEditionDiagrams` persists `diagrams.json` beside the other artifacts and is idempotent
   * against `script.json`'s mtime, so the newsletter reads the identical artwork instead of
   * authoring its own — that is what makes "one story, one drawing, both media" true by
   * construction rather than by a check that runs afterwards. A story whose authoring fails falls
   * back to the deterministic schematic, but since 2026-09-09 the function THROWS when any shown
   * diagram failed or never completed its phone review — a rejected visual cannot be rendered here
   * any more than it can be produced, rebuilt into a newsletter, or approved.
   */
  const { modelCanReadImages } = await import("../llm/model.js");
  const editionDiagrams = await ensureEditionDiagrams(dir, script.body, await modelCanReadImages(), undefined, visualContext);
  // One style per ISSUE, derived from the content day — never per story. The newsletter derives the
  // same value from the same day, so the two renderers cannot drift apart.
  const diagramStyle = diagramStyleForDay(id.slice(0, 8));

  // The customer's logo travels with the package: copied once into this video's own directory, so a
  // later logo change never alters an approved video and no render reaches into another workspace.
  const workspaceLogo = readPersonalization(activeRoot()).logoFile;
  let logoFile: string | null = null;
  if (workspaceLogo) {
    const ext = workspaceLogo.endsWith(".png") ? "png" : "jpg";
    copyFileSync(contained(activeRoot(), workspaceLogo), join(dir, `logo.${ext}`));
    logoFile = `${id}/logo.${ext}`;
  }

  const snapshots = selectedSourceSnapshots(dir);
  // The customer's brand tokens decide the look; the edition accent is only the fallback accent.
  const theme = workspaceTheme(activeRoot(), edition.videoAccent);
  const props: RenderProps = {
    headline: topic.headline,
    hook: script.hook,
    prelude: scriptPrelude(script).map((part, i) => ({ ...part, startSec: i === 0 ? 0 : bounds[i].startSec, endSec: bounds[i + 1]?.startSec ?? bounds[i].endSec })),
    cta: script.cta,
    segments: script.body.map((seg, i) => {
      // public-dir-relative path (publicDir = workdir/videos)
      let assetFile: string | null = null;
      if (snapshots.has(i)) {
        // The attributed snapshot was chosen: a text card, never the source image under that label.
      } else if (seg.assetRef && manifest[seg.assetRef] && !manifest[seg.assetRef].endsWith(".json")) {
        assetFile = `${id}/${manifest[seg.assetRef]}`;
      } else if (seg.scene === "repo_card" && manifest["repo-shot"]) {
        assetFile = `${id}/${manifest["repo-shot"]}`;
      } else if (manifest["og-0"] && topic.kind !== "roundup") {
        assetFile = `${id}/${manifest["og-0"]}`;
      }
      // Roundups carry several repos — each segment gets its own story's repo
      const story = topic.stories?.find((s) => s.assetRef === seg.assetRef) ?? topic.stories?.[i];
      // A diagram with no SVG means that segment had no motion brief to draw from; leave it unset
      // so the renderer falls back to its card scene rather than mounting an empty stage.
      const authored = editionDiagrams[i];
      return {
        ...seg,
        sourceSnapshot: snapshots.get(i),
        startSec: bodyBounds[i].startSec,
        endSec: bodyBounds[i].endSec,
        assetFile,
        repo: story ? story.repo : undefined,
        diagram: authored?.svg || authored?.visual?.kind !== "diagram" ? authored : undefined,
        visualTiming: authored?.visual ? narrationTiming(seg.voiceover, authored.visual.cues, stamps.words, bodyBounds[i].startSec, bodyBounds[i].endSec) : undefined,
        diagramStyle,
      };
    }),
    words: stamps.words,
    durationSec: stamps.durationSec,
    audioFile: `${id}/audio.wav`,
    accent: theme.accent,
    theme,
    // full URL lives in post descriptions (script.ts); the end-card stays readable
    newsletterLine: edition.newsletterLine,
    logoFile,
    speakers: stamps.lines?.map(({ name, role, startSec, endSec }) => ({ name, role, startSec, endSec })),
    stars,
    repo: topic.repo,
    presenterVideo,
    avatarMode,
    presenterScale: avatarCfg?.heygen.presenterScale,
    presenterCorner: avatarCfg?.heygen.presenterCorner,
    videoBackground: style.videoBackground || undefined,
    captionStyle: style.captionStyle || undefined,
    introClip,
    introDurationSec: hasIntro ? edition.introDurationSec : undefined,
    // Per-provider intro cap, matching introSecondsFor() in avatar.ts. The old ternary knew only
    // fal and hedra, so EVERY other provider fell through to hedra's 30s cap — including heygen,
    // which generates a FULL-LENGTH avatar. The result was an 86s avatar rendered as a 30s inset
    // that then vanished: paid for in full, shown for a third. Generation and display must read
    // the same rule, so keep this in sync with avatar.ts.
    avatarIntroSec: hasPresenter ? (framing === "opening" ? introSecondsForRender(avatarCfg) ?? 8 : introSecondsForRender(avatarCfg)) : undefined,
  };
  const propsPath = join(dir, "props.json");
  writeJson(propsPath, props);

  const outPath = join(dir, "final.mp4");
  const attemptPath = join(dir, `render-attempt-${randomUUID()}.mp4`);
  log(`Rendering ${id} (${stamps.durationSec}s)...`);
  const renderArgs = [
    "remotion",
    "render",
    join(ROOT, "video", "index.ts"),
    "Short",
    attemptPath,
    `--props=${propsPath}`,
    `--public-dir=${VIDEOS_DIR}`,
    "--codec=h264",
    "--concurrency=4",
  ];
  const remotion = portableCommand("npx", renderArgs);
  // macOS prevents idle sleep; Windows and Linux render directly.
  const spec = process.platform === "darwin"
    ? { command: "caffeinate", args: ["-i", remotion.command, ...remotion.args] }
    : remotion;
  await runManagedProcess(spec.command, spec.args, { operation: 'Video rendering', timeoutMs: MEDIA_PROCESS_LIMITS.render, cwd: ROOT });
  continuation?.assertUnchanged();
  if (!existsSync(attemptPath) || !statSync(attemptPath).size) throw new Error("render completed but output is missing or empty");
  // Failed attempts remain evidence; only a successful process replaces a previous completed render.
  renameSync(attemptPath, outPath);

  const meta = readJson<VideoMeta>(join(dir, "meta.json"));
  meta.status = "rendered";
  meta.updatedAt = new Date().toISOString();
  writeJson(join(dir, "meta.json"), meta);
  log(`Rendered → ${outPath}`);
  return outPath;
}
