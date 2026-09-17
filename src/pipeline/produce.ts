import { watchStage } from '../watchdog-progress.js';
import { authorize, currentActor, atomicJson, activeRoot } from "../workspaces.js";
import { join } from "node:path";
import { assertDryRunTopicFile, enableDryRun, shouldStopAfterSelection } from "../dry-run.js";
import { existsSync, readdirSync, rmSync } from "node:fs";
import type { Topic, VideoMeta } from "../types.js";
import { harvest } from "./harvest.js";
import { rank, roundupPackageId } from "./rank.js";
import { writeScript } from "./script.js";
import { writingOutputs, type WritingOutputs } from './writing-context.js';
import { roleHash } from '../llm/role-router.js';
import { finishWorkingMemory } from '../memory/context.js';
import { withPublicationMemory } from '../memory/runtime.js';
import { runIndependentDevelopment, type DevelopmentOutcome } from './development.js';
import { VIDEOS_DIR, loadConfig, readJson, videoDir, writeJson, slugify, todayStamp, log } from "../util.js";

interface PipelineConfig {
  autonomy: "review";
  topicsPerRun: number;
}

interface ProduceOpts {
  topicFile?: string;
  until?: "rank" | "script" | "assets" | "voice" | "avatar" | "render";
  force?: boolean;
  count?: string;
  edition?: string; // edition preset; defaults to daily-roundup
  dryRun?: boolean;
  /** Continue an existing package (e.g. one paused at `awaiting_visual_choice`): completed stages are kept. */
  resume?: string;
}

/** Resuming an existing package keeps its requested outputs. Stop-after and fixture options
 * choose the initial scope only; omitting them on resume must never add a newsletter. */
export function productionWritingOutputs(opts: ProduceOpts, saved: { outputs?: WritingOutputs } | null): WritingOutputs {
  if (saved?.outputs !== undefined) return writingOutputs(saved);
  return !opts.until && (!opts.topicFile || (opts.edition ?? 'daily-roundup') !== 'daily-roundup') ? 'edition' : 'video';
}

/** A complete edition includes its requested companion. Keep existing artifacts on failure,
 * but propagate the newsletter error so callers cannot report a completed edition. */
export async function completeCompanionNewsletter(
  completedIds: string[], edition: string | undefined,
  generate: (day: string, rerender: boolean, edition: string | undefined, videoId: string) => Promise<string>,
): Promise<void> {
  if (completedIds.length !== 1) throw new Error('Newsletter needs one exact completed video package; generate it separately with --video-id');
  const videoId = completedIds[0]!;
  const contentDay = `${videoId.slice(0, 4)}-${videoId.slice(4, 6)}-${videoId.slice(6, 8)}`;
  try { await generate(contentDay, false, edition, videoId); }
  catch (error) {
    throw new Error(`Edition incomplete: newsletter failed for ${videoId}. Existing written and media output is saved. ${(error as Error).message}`, { cause: error });
  }
}

async function closePackageWorkingMemory(id: string, status: 'complete' | 'cancelled'): Promise<void> {
  const request = readJson<{ memory?: unknown } | null>(join(videoDir(id), 'writing-request.json'), null);
  if (!request?.memory) return; // Legacy packages have no runtime memory to complete or invent.
  await withPublicationMemory(store => finishWorkingMemory(store, id, status));
}

function setStatus(id: string, status: VideoMeta["status"]): VideoMeta {
  const metaPath = join(videoDir(id), "meta.json");
  const meta = readJson<VideoMeta>(metaPath);
  meta.status = status;
  meta.updatedAt = new Date().toISOString();
  writeJson(metaPath, meta);
  return meta;
}

/** Skip an edition only when today's content already reached the review queue or later. */
export function isShipped(status: VideoMeta["status"]): boolean {
  return status === "posted" || status === "approved" || status === "pending_review";
}

export function producedToday(editionId: string): { id: string; status: VideoMeta["status"] } | null {
  if (!existsSync(VIDEOS_DIR)) return null;
  const today = todayStamp().replace(/-/g, ""); // e.g. "20260616"
  for (const id of readdirSync(VIDEOS_DIR)) {
    if (!id.startsWith(today)) continue;
    const metaPath = join(VIDEOS_DIR, id, "meta.json");
    if (!existsSync(metaPath)) continue;
    const meta = readJson<VideoMeta>(metaPath);
    if ((meta.edition ?? "daily-roundup") !== editionId) continue;
    if (!meta.status.startsWith("failed") && meta.status !== "rejected") return { id, status: meta.status };
  }
  return null;
}

/** Prepare evidence once, develop requested text and source visuals independently, then
 * align the accepted outputs before assets, narration and final rendering can ship. */
async function produceOne(topic: Topic, opts: ProduceOpts, companionGenerator?: Parameters<typeof completeCompanionNewsletter>[2]): Promise<void> {
  const id = topic.id;
  const { assertMediaRepairAllowed } = await import('./media-completion.js');
  assertMediaRepairAllowed(id);
  const hasMediaContinuation = existsSync(join(videoDir(id), 'media-continuation.json'));
  // "Choose your stories": nothing is written until the person's choice is locked; the resume writes the script
  // from exactly the locked stories (story-choice.ts).
  if (readJson<VideoMeta>(join(videoDir(id), "meta.json")).status === "awaiting_story_choice") {
    if (hasMediaContinuation) throw new Error("An approved media continuation cannot change its selected stories");
    const { readStoryChoice, applyStoryChoice } = await import("./story-choice.js");
    if (!readStoryChoice(videoDir(id))?.lock) { log(`Paused for story choice (${id}).`); return; }
    const applied = applyStoryChoice(videoDir(id));
    const { reservedUrls, ...chosen } = applied; topic = chosen;
    // The ledger reserved the recommendation at selection; a dropped story must be free again and a swap reserved.
    const { updateEntry } = await import("../state/ledger.js");
    updateEntry(id, { urls: reservedUrls, repo: topic.repo?.fullName ?? null, headline: topic.headline });
    setStatus(id, "selected");
    log(`Story choice applied (${id}): ${topic.stories?.map((s) => s.headline).join(" · ")}`);
  }
  const fail = (stage: string, e: Error): never => {
    // A guard failure must not replace a concurrent review hold or approval with a
    // retryable media status. Preserve that decision and its accepted artifacts.
    if (hasMediaContinuation) continuation?.assertUnchanged();
    assertMediaRepairAllowed(id);
    setStatus(id, `failed:${stage}`);
    throw new Error(`Stage ${stage} failed for ${id}: ${e.message}`);
  };

  // A resumed package keeps the stages it already completed; nothing is re-billed or rewritten.
  const resuming = opts.resume === id;
  const continuation = hasMediaContinuation ? await watchStage('restore-approved-content', async () => {
    if (!resuming) throw new Error('Continue this approved package with its exact resume id');
    return (await import('./media-continuation.js')).openMediaContinuation(activeRoot(), id);
  }, id) : undefined;
  if (continuation && readJson<VideoMeta>(join(videoDir(id), 'meta.json')).status === 'pending_review') {
    continuation.assertUnchanged();
    log(`The authorized media continuation for ${id} already reached preview; no media work was repeated.`);
    return;
  }
  const { context, companion } = continuation ? { context: continuation, companion: true } : await watchStage('capture-and-prepare-sources', async () => {
    try {
      const outputs = productionWritingOutputs(opts, readJson(join(videoDir(id), 'writing-request.json'), null));
      // This single call owns preparation/history side effects and the immutable parent.
      // Do not reopen the package lock concurrently from separate output branches.
      const context = await (await import('./writing-context.js')).packageWritingContext(id, outputs);
      return { context, companion: outputs === 'edition' };
    } catch (e) { return fail('script', e as Error); }
  }, id);
  if (!continuation) {
  const developVisuals = opts.until !== 'script' && opts.until !== 'assets';
  const tasks: Record<string, () => Promise<unknown>> = {};
  let editorialFailureStage = 'script';
  const editorial = context.dailyEditorial ? () => import('./journey-editorial.js').then(module => module.prepareJourneyEditorial(context)) : undefined;
  if (editorial) tasks.editorial = editorial;
  else tasks.script = async () => {
    const reusableScript = resuming && readJson<VideoMeta>(join(videoDir(id), "meta.json")).status !== "failed:script" && existsSync(join(videoDir(id), "script.json"));
    const receiptPath = join(videoDir(id), 'companion-writing-receipt.json');
    if (reusableScript) {
      const { assertPreparedScriptReceipt } = await import('./writing-context.js');
      assertPreparedScriptReceipt(readJson(receiptPath, null), context.topic, context.writerKey, readJson(join(videoDir(id), 'script.json')));
    }
    if (!reusableScript) {
      const script = await writeScript(id, { topic: context.topic, call: context.call('script'), writerKey: context.writerKey, parentId: context.parent.parentId, parentIdentity: context.parent.parentIdentity });
      // Only the writer's completed factual gates may issue the receipt. A structurally valid
      // result alone must never be promoted to a reviewed script here.
      const { assertPreparedScriptReceipt } = await import('./writing-context.js');
      assertPreparedScriptReceipt(readJson(receiptPath, null), context.topic, context.writerKey, script);
    }
    if (companion) {
      const { prepareCompanionText } = await import('./newsletter.js');
      try { await prepareCompanionText(id, undefined, context); }
      catch (error) { editorialFailureStage = 'newsletter'; throw error; }
    }
  };
  const { journeyReviewPortEnabled } = await import('./writing-context.js');
  if (developVisuals && journeyReviewPortEnabled()) tasks.visuals = async () => {
    const { ensureSourceVisualDevelopment } = await import('./visual-development.js');
    const result = await ensureSourceVisualDevelopment(videoDir(id), context.topic, {
      day: `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`,
      writerKey: context.writerKey, call: context.call('visual'),
    });
    if (result.status !== 'ready') throw new Error(`Visual development incomplete: ${result.failures.map(row => `${row.topicId}: ${row.error}`).join('; ')}. Completed visual concepts are saved.`);
  };
  const progress = { version: 1, topicId: id, parentIdentity: context.parent.parentIdentity, writerKey: context.writerKey,
    stage: 'independent-development', requested: Object.keys(tasks), outcomes: {} as Record<string, DevelopmentOutcome> };
  atomicJson(join(videoDir(id), 'development-status.json'), progress);
  log(`Developing script then newsletter formatting, alongside visuals for ${id}; completed work is retained.`);
  const watchedTasks = Object.fromEntries(Object.entries(tasks).map(([name, task]) => [name, () => watchStage(name, task, id)]));
  const outcomes = await runIndependentDevelopment(watchedTasks, (name, outcome) => {
    progress.outcomes[name] = outcome;
    atomicJson(join(videoDir(id), 'development-status.json'), progress);
  });
  const failures = Object.keys(tasks).map(name => [name, outcomes[name]!] as const).filter(([, outcome]) => outcome.status === 'failed');
  if (failures.length) {
    const [name] = failures[0]!;
    fail(name === 'editorial' ? 'script' : name === 'script' ? editorialFailureStage : name, new Error(failures.map(([stage, outcome]) => `${stage}: ${outcome.error}`).join('; ') + '. Other completed outputs have been kept.'));
  }
  } else log(`Continuing only saved media for ${id}; approved script, newsletter and original editorial allowance are unchanged.`);
  if (opts.until === "script") return;

  try {
    if (!(resuming && existsSync(join(videoDir(id), "assets.json")))) {
      if (continuation) throw new Error("Media continuation requires its saved asset manifest; new source collection is closed");
      const { gatherAssets } = await import("./assets.js");
      await watchStage('assets', () => gatherAssets(id), id);
    }
  } catch (e) {
    fail("assets", e as Error);
  }
  if (opts.until === "assets") return;

  try {
    const { ensureEditionDiagrams } = await import("./story-diagram.js");
    const { VisualChoiceRequired } = await import("./visual-choice.js");
    const script = readJson<import("../types.js").Script>(join(videoDir(id), "script.json"));
    // ensureEditionDiagrams throws on a failed or unfinished phone review, so a rejected visual stops
    // here — before narration and rendering are paid for — with `failed:visuals`. A story still
    // waiting for the customer's visual choice pauses the package instead; `produce --resume <id>` continues it.
    try {
      const { modelCanReadImages } = await import("../llm/model.js");
      const vision = await modelCanReadImages();
      await watchStage('visual-design-and-review', () => ensureEditionDiagrams(videoDir(id), script.body, vision, undefined, continuation), id);
    } catch (e) {
      if (e instanceof VisualChoiceRequired) {
        setStatus(id, "awaiting_visual_choice");
        log(`Paused for visual choice (${id}): ${e.message}`);
        return;
      }
      throw e;
    }
  } catch (e) { fail("visuals", e as Error); }

  // The complete written issue exists before narration/rendering. Media failures cannot
  // discard it; the final refresh below only attaches media to this exact cached prose.
  const generate = companion ? companionGenerator ?? (await import('./newsletter.js')).newsletter : undefined;
  const editionArg = opts.edition && opts.edition !== 'daily-roundup' ? opts.edition : undefined;
  if (generate) {
    setStatus(id, 'assets_ready');
    try { await watchStage('newsletter-formatting', () => completeCompanionNewsletter([id], editionArg, generate), id); }
    catch (e) { fail('newsletter', e as Error); }
  }

  const { canReuseRenderedMedia, canReuseNarration, beginSnapshotRenderRepair, preserveRenderedAttempt, rememberRenderedMedia } = await import('./media-completion.js');
  assertMediaRepairAllowed(id);
  const reuseMedia = resuming && canReuseRenderedMedia(id, continuation?.assertUnchanged);
  const reuseNarration = reuseMedia || resuming && canReuseNarration(id, continuation?.assertUnchanged);
  if (!reuseMedia) {
  if (!reuseNarration) {
  try {
    const { voice } = await import("./voice.js");
    continuation?.assertUnchanged();
    await watchStage('narration', () => voice(id), id);
    continuation?.assertUnchanged();
  } catch (e) {
    fail("voice", e as Error);
  }
  if (opts.until === "voice") return;

  try {
    const { avatar } = await import("./avatar.js");
    await watchStage('presenter', () => avatar(id), id);
  } catch (e) {
    log(`avatar failed (${(e as Error).message.split("\n")[0]}) — falling back to cards (voice over cards, no avatar) for ${id}`);
    try { rmSync(join(videoDir(id), "avatar.mp4"), { force: true }); } catch { /* nothing to remove */ }
    const { notify } = await import("../review/notify.js");
    notify("Example Signal — avatar → cards fallback", `${id}: avatar provider failed; publishing voice-over-cards (no avatar).`);
  }
  if (opts.until === "avatar") return;
  } else {
    continuation?.assertUnchanged();
    log(`Reusing exact checked narration and presenter for ${id}; only the changed visual presentation will render.`);
    if (opts.until === 'voice' || opts.until === 'avatar') return;
  }

  try {
    const { render } = await import("./render.js");
    continuation?.assertUnchanged();
    preserveRenderedAttempt(id);
    const finishSnapshotRepair = reuseNarration ? beginSnapshotRenderRepair(id, context.parent.parentIdentity, continuation?.assertUnchanged) : undefined;
    await watchStage('render', () => render(id, continuation), id);
    continuation?.assertUnchanged();
    finishSnapshotRepair?.();
  } catch (e) {
    fail("render", e as Error);
  }
  rememberRenderedMedia(id);
  } else log(`Reusing the exact saved narration and render for ${id}; only unfinished final checks will run.`);
  if (reuseMedia && (opts.until === 'voice' || opts.until === 'avatar')) return;
  if (opts.until === "render") return;

  if (!(await import('./writing-context.js')).journeyReviewPortEnabled()) log('Final media review skipped: journeyReview is "script" (Daily Signal shape: the script judge and the phone critic are the two checks).');
  else try {
    const { completeMediaReview } = await import('./media-completion.js');
    await watchStage('final-media-review', () => completeMediaReview(id, context, {
      render: async () => { continuation?.assertUnchanged(); preserveRenderedAttempt(id); await (await import('./render.js')).render(id, continuation); continuation?.assertUnchanged(); },
      voice: async () => {
        continuation?.assertUnchanged();
        await (await import('./voice.js')).voice(id);
        // A changed narration invalidates lip-sync just as it invalidates the render.
        // Retain the old presenter as evidence but never play it with a new voice take.
        if (existsSync(join(videoDir(id), 'avatar.mp4'))) {
          const { renameSync } = await import('node:fs');
          renameSync(join(videoDir(id), 'avatar.mp4'), join(videoDir(id), `avatar-before-audio-repair-${Date.now()}.mp4`));
        }
        await (await import('./avatar.js')).avatar(id);
        continuation?.assertUnchanged();
      },
    }), id);
  } catch (e) { fail('final-media-qc', e as Error); }
  if (generate) {
    try { await generate(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`, true, editionArg, id); }
    catch (e) { fail('newsletter-media', e as Error); }
  }

  continuation?.assertUnchanged();
  setStatus(id, "pending_review");
  const { notifyDraftReady } = await import("../review/notify.js");
  notifyDraftReady(id, topic.headline);
  log(`Draft ready for review: npm run preview ${id}`);
}

export async function produce(opts: ProduceOpts = {}, companionGenerator?: Parameters<typeof completeCompanionNewsletter>[2]): Promise<void> {
  authorize("produce", { edition: opts.edition ?? "daily-roundup" });
  if (opts.dryRun) enableDryRun();
  assertDryRunTopicFile(opts.topicFile);
  const cfg = loadConfig<PipelineConfig>("pipeline");
  if (cfg.autonomy !== "review") {
    throw new Error('config/pipeline.json must keep "autonomy" set to "review"');
  }
  const { loadEdition, claimEditionSerial } = await import("./edition.js");
  const edition = loadEdition(opts.edition);
  const editionId = edition.editionId;
  const isSpecial = editionId !== "daily-roundup";

  if (!opts.force && !opts.topicFile && !opts.resume) {
    const already = producedToday(editionId);
    if (already && isShipped(already.status)) {
      // Video completion can precede a newsletter failure. Retry only this exact companion
      // before a full-edition request returns; completed media stages remain untouched.
      const companion = !opts.until && productionWritingOutputs(opts, readJson(join(videoDir(already.id), 'writing-request.json'), null)) === 'edition';
      if (companion) {
        const generate = companionGenerator ?? (await import("./newsletter.js")).newsletter;
        await completeCompanionNewsletter([already.id], isSpecial ? editionId : undefined, generate);
      }
      if (!opts.until) await closePackageWorkingMemory(already.id, 'complete');
      log(`Guard: today's ${editionId} video (${already.id}, ${already.status}) is already complete${companion ? ' and its newsletter is ready' : ''} — exiting (use --force to override)`);
      return;
    }
    if (already && (already.status === "awaiting_visual_choice" || already.status === "awaiting_story_choice")) {
      // Paused for the customer's story or visual choice: continue that package rather than starting over.
      log(`Guard: today's ${editionId} content (${already.id}) is waiting for the customer's ${already.status === "awaiting_story_choice" ? "story" : "visual"} choice — resuming it.`);
      opts = { ...opts, resume: already.id };
    } else if (already) {
      log(`Guard: today's ${editionId} content (${already.id}) is half-produced (${already.status}) — rejecting the stale partial and producing fresh so the issue still publishes.`);
      const { notify } = await import("../review/notify.js");
      notify("Example Signal — recovering a stuck day", `Found a half-produced ${editionId} video (${already.status}); producing fresh so the issue still publishes.`);
      setStatus(already.id, "rejected");
      await closePackageWorkingMemory(already.id, 'cancelled');
    }
  }

  // 1. Topic selection
  let topics: Topic[];
  if (opts.resume) {
    const dir = videoDir(opts.resume);
    if (!existsSync(join(dir, "topic.json")) || !existsSync(join(dir, "meta.json"))) throw new Error(`Cannot resume ${opts.resume}: no such package`);
    const prior = readJson<VideoMeta>(join(dir, "meta.json"));
    if ((prior.edition ?? "daily-roundup") !== editionId) throw new Error("Existing artifact belongs to a different edition");
    log(`Resuming ${opts.resume} (${prior.status})`);
    topics = [readJson<Topic>(join(dir, "topic.json"))];
  } else if (opts.topicFile) {
    const topic = readJson<Topic>(opts.topicFile);
    if (!topic.id) topic.id = `${todayStamp().replace(/-/g, "")}-${slugify(topic.headline)}`;
    let dir = videoDir(topic.id);
    if (existsSync(join(dir, 'media-continuation.json'))) throw new Error('An authorized media continuation must resume its saved package; replacing its topic is not permitted');
    if (existsSync(join(dir, "topic.json"))) {
      // "Changed request" is judged against the saved writing-request's own hashes, not the enriched topic.json on disk
      // (preparation rewrites topic.json, so comparing it to the raw input calls every rerun 'changed' — second-read finding).
      // Only a genuinely changed request against a failed/rejected package continues under the next id; an identical rerun resumes.
      const saved = readJson<{ originalHash?: string; preparedHash?: string } | null>(join(dir, "writing-request.json"), null);
      const changed = saved?.originalHash
        ? ![saved.originalHash, saved.preparedHash].includes(roleHash(topic))
        : roleHash(readJson<Topic>(join(dir, "topic.json"))) !== roleHash(topic);
      if (changed) {
        const status = readJson<Pick<VideoMeta, "status">>(join(dir, "meta.json"), { status: "selected" }).status;
        if (status.startsWith("failed") || status === "rejected") {
          topic.id = roundupPackageId(topic.id);
          dir = videoDir(topic.id);
          log(`Earlier package ended ${status} with a different request; continuing as ${topic.id}`);
        }
      }
    }
    if (existsSync(join(dir, "meta.json"))) {
      const prior = readJson<VideoMeta>(join(dir, "meta.json"));
      if ((prior.edition ?? "daily-roundup") !== editionId) throw new Error("Existing artifact belongs to a different edition");
    }
    // An unchanged rerun keeps the package's enriched topic.json (story events, pinned claims): overwriting it with the raw
    // input re-bought story identification against the spent budget (review finding). A changed request on a failed
    // package already moved to a fresh id above; a changed request on a live package is refused by originalWritingTopic.
    if (!existsSync(join(dir, "topic.json"))) writeJson(join(dir, "topic.json"), topic);
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) {
      writeJson(metaPath, {
        id: topic.id,
        status: "selected",
        headline: topic.headline,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        posts: {},
        createdBy: currentActor().id,
        edition: editionId,
        ...(isSpecial ? { editionSerial: claimEditionSerial(editionId) } : {}),
        ...(opts.dryRun ? { dryRun: true } : {}), // hidden from review lists while it stays "selected"
      } satisfies VideoMeta);
    } else if (isSpecial) {
      // Tag an existing topic directory with its edition and serial.
      const m = readJson<VideoMeta>(metaPath);
      if (!m.edition) {
        m.edition = editionId;
        m.editionSerial = m.editionSerial ?? claimEditionSerial(editionId);
        writeJson(metaPath, m);
      }
    }
    log(`Using fixture topic (${editionId}): ${topic.headline}`);
    topics = [topic];
  } else if (isSpecial) {
    // No fixture was supplied, so source this edition's stories through its configured adapter.
    const { sourceEdition, buildEditionTopic } = await import("./research.js");
    const research = await sourceEdition(edition, todayStamp());
    topics = [buildEditionTopic(research, editionId)];
  } else {
    await watchStage('collect-stories', () => harvest());
    topics = await watchStage('select-stories', () => rank(undefined, opts.count ? parseInt(opts.count, 10) : undefined));
  }
  for (const topic of topics) {
    const path = join(videoDir(topic.id), "meta.json");
    const meta = readJson<VideoMeta>(path);
    if ((meta.edition ?? "daily-roundup") !== editionId) throw new Error("Existing artifact belongs to a different edition");
    if (!meta.createdBy) { meta.createdBy = currentActor().id; writeJson(path, meta); }
  }
  if (shouldStopAfterSelection()) {
    log("[dry-run] Topic selection completed; scripts, browsers, providers, rendering, publication, and posting were blocked.");
    return;
  }
  if (opts.until === "rank") return;

  // 2. Produce each topic independently — one failure must not sink the batch
  const failures: string[] = [];
  const completedIds: string[] = [];
  for (const topic of topics) {
    try {
      await produceOne(topic, opts, companionGenerator);
      completedIds.push(topic.id);
    } catch (e) {
      // A failure must name itself: an Error with an empty message or a thrown non-Error used to produce
      // "All N topics failed:" with nothing after it (Grok Bot's 4-story run, Sep 17 05:07Z).
      const described = e instanceof Error ? (e.message.trim() || `${e.name || 'Error'} without a message`) + (e.message.trim() ? '' : ` (${(e.stack ?? '').split('\n')[1]?.trim() ?? 'no stack'})`) : `non-Error thrown: ${String(e)}`;
      failures.push(described);
      log(`SKIPPING remaining stages for ${topic.id}: ${described}`);
    }
  }

  log(`Batch done: ${topics.length - failures.length}/${topics.length} videos produced`);
  if (failures.length === topics.length && topics.length > 0) {
    throw new Error(`All ${topics.length} topics failed:\n${failures.join("\n")}`);
  }

  // A package paused for the customer's visual choice has no newsletter yet; the resume builds it.
  const paused = topics.some((t) => existsSync(join(videoDir(t.id), "meta.json")) && ["awaiting_visual_choice", "awaiting_story_choice"].includes(readJson<VideoMeta>(join(videoDir(t.id), "meta.json")).status));
  if (paused) log("Newsletter deferred until the customer's choices are made.");
  // Each complete edition was written before media and refreshed after its final checks.
  if (!opts.until && !paused) for (const id of completedIds) {
    if (isShipped(readJson<VideoMeta>(join(videoDir(id), 'meta.json')).status)) await closePackageWorkingMemory(id, 'complete');
  }
}
