import { assertPublicDelivery } from '../release-profile.js';
import { pendingAttempt, beginAttempt, finishAttempt, certainlyNotSubmitted } from "./attempt.js";
import { assertExplicitApprovalCurrent } from "../pipeline/explicit-approval.js";
import { assertReviewReleased } from "../pipeline/review-hold.js";
import { releaseLock } from "../release-lock.js";
import { credentialFingerprint, retryDecision, validateAcceptedReceipt } from "./provider-support.js";
import { authorize, deskFor, desks } from "../workspaces.js";
import { existsSync } from "node:fs";
import { isDryRun } from "../dry-run.js";
import { join } from "node:path";
import type { Platform, Topic, VideoMeta } from "../types.js";
import { byStatus } from "../review/queue.js";
import { updateEntry } from "../state/ledger.js";
import { loadConfig, readJson, todayStamp, videoDir, writeJson, log } from "../util.js";
import { ADAPTERS, lanesFor, PLATFORM_ORDER } from "./adapter.js";
import { appendDeliveryEventIfChanged, blockedPlatforms, classifyFailure, readDeliveryEvents, recordPlatformOutcome } from "./delivery.js";
import { assertApprovedNewsletterPackage, assertNewsletterSubmissionReceipt, recordAcceptedPlatformMemory, confirmPublicationMemory, markPublicationMemorySubmitted, reservePublicationMemory } from '../memory/publication.js';

type PlatformsConfig = Record<Platform, { enabled: boolean }>;

/* DISTRIBUTION KERNEL. The per-platform poster bodies, their API→browser fallbacks, the destination
 * order and the concurrency lanes live as declared capabilities in src/post/adapter.ts; every hold,
 * skip, accept and failure below is also written as an append-only event by src/post/delivery.ts.
 * Behavior is unchanged: adapter.test.ts asserts the derived lanes equal the previous literal lanes. */

export function requiredTopicUrls(topic: Pick<Topic, "primaryUrl" | "stories">): string[] {
  const urls = [topic.primaryUrl, ...(topic.stories ?? []).map((story) => story.primaryUrl)]
    .map((url) => url?.trim()).filter((url): url is string => Boolean(url));
  const unique = [...new Set(urls)];
  if (unique.length === 0) throw new Error("topic contains no source URLs");
  return unique;
}

// Keep the deterministic provider order while independent lanes run concurrently.
const ORDER: Platform[] = PLATFORM_ORDER;

/* Posting lanes run concurrently; platforms within each lane run in order. Lanes are derived from
 * each adapter's `concurrencyGroup`: Threads and Reddit may use the same configured browser
 * profile, so they share a lane and remain serial; X has its own; API-only destinations need none.
 *
 * Safe for the shared `meta`: writeJson is fully synchronous, so `meta.posts[p] = r; writeJson(...)`
 * cannot be interleaved by another lane — there is no await between the mutation and the write. */
const LANES: Platform[][] = lanesFor(ORDER);

export async function postApproved(opts: { only?: string; id?: string; retryBlocked?: boolean } = {}): Promise<void> {
  assertPublicDelivery();
  const unlock = releaseLock();
  try { return await postApprovedLocked(opts); } finally { unlock(); }
}

async function postApprovedLocked(opts: { only?: string; id?: string; retryBlocked?: boolean } = {}): Promise<void> {
  authorize("publish");
  const platforms = loadConfig<PlatformsConfig>("platforms");
  const targets = opts.id
    ? [readJson<VideoMeta>(join(videoDir(opts.id), "meta.json"))]
    : byStatus("approved");

  if (targets.length === 0) {
    log("Nothing approved to post.");
    return;
  }

  // Fail closed until the exact expected newsletter issue is positively verified as live.
  const { newsletterLiveStatus } = await import("../pipeline/newsletter-live.js");

  for (const meta of targets) {
    authorize("publish", { edition: meta.edition ?? "daily-roundup", platform: opts.only });
    // M2: status enforcement is UNCONDITIONAL — the old `&& !opts.id` let a half-produced video (no
    // final.mp4) be posted by id, blowing up only after registering the LinkedIn upload asset.
    if (!["approved", "posted"].includes(meta.status)) { if (opts.id) log(`${meta.id}: status "${meta.status}" not postable — skipping.`); continue; }
    assertReviewReleased(meta, "post video");
    if (!isDryRun()) assertExplicitApprovalCurrent(meta);
    if (isDryRun()) {
      const planned = ORDER.filter((platform) => (!opts.only || platform === opts.only) && platforms[platform]?.enabled && !meta.posts[platform]);
      log(`[dry-run] ${meta.id}: would evaluate and post to ${planned.length ? planned.join(", ") : "no enabled unposted destinations"}. No network mutation attempted.`);
      continue;
    }
    // Key the gate + permalink on the video's CONTENT day (its id prefix), NOT the wall clock:
    // todayStamp() is UTC and flips at ~8pm ET, so an evening post would look for the next day's
    // issue and wrongly hold / mis-link. The id (YYYYMMDD-…) is the real day.
    const day = /^\d{8}/.test(meta.id) ? `${meta.id.slice(0, 4)}-${meta.id.slice(4, 6)}-${meta.id.slice(6, 8)}` : todayStamp();
    // Every gate that holds THIS release is recorded as one append-only event (delivery.ts), so a
    // missing destination is never just a log line: the reason is on disk beside meta.json.
    // "IfChanged": re-running `npm run post` against a persisting hold adds no new line.
    const withhold = (reason: string, detail?: Record<string, unknown>) =>
      appendDeliveryEventIfChanged(videoDir(meta.id), { type: "release.withheld", videoId: meta.id, reason, detail });

    // Coordination is fail-closed and edition-specific. There is no bypass: the exact issue subject
    // must be positively verified at its live permalink before any destination receives the video.
    const { status, issueUrl } = await newsletterLiveStatus(day, meta.edition);
    const label = meta.edition && meta.edition !== "daily-roundup" ? `${meta.edition} ` : "";
    if (status !== "live") {
      const { notify } = await import("../review/notify.js");
      log(`HOLD: ${label}issue (${day}) not verifiably live yet (status: ${status}). ${meta.id} NOT posted.`);
      log("   Publish the exact issue, verify it live, then run: npm run post");
      withhold("newsletter-not-live", { day, edition: meta.edition ?? "daily-roundup", status });
      notify("Example Signal - video held", "Publish and verify the exact issue before posting the video.");
      continue;
    }
    assertApprovedNewsletterPackage(meta);
    log(`${label || "daily "}issue live - evaluating ${meta.id}.`);
    if (issueUrl) {
      try {
        assertNewsletterSubmissionReceipt(meta, issueUrl);
        await confirmPublicationMemory(meta.id, { provider: 'linkedin-newsletter', remoteId: issueUrl, url: issueUrl, confirmedAt: Date.now() });
      }
      catch (error) {
        // An independently published legacy issue has no durable harness submission to confirm.
        // Preserve that uncertainty; the video must still acquire its own publication reservation.
        log(`Publication memory is unconfirmed for the newsletter: ${(error as Error).message}`);
        withhold('newsletter-memory-unconfirmed', { error: (error as Error).message });
      }
    }

    // Only a supported event already confirmed in another run can exclude this package.
    // Shared URLs, drafts and unconfirmed submissions do not establish prior publication.
    {
      const topicPath = join(videoDir(meta.id), "topic.json");
      if (!existsSync(topicPath)) {
        log(`HOLD: ${meta.id} has no topic.json; repeat validation cannot run.`);
        withhold("topic-missing");
        continue;
      }
      let candidateUrls: string[];
      try {
        candidateUrls = requiredTopicUrls(readJson<Topic>(topicPath));
      } catch (e) {
        log(`HOLD: ${meta.id} topic evidence is invalid: ${(e as Error).message}`);
        withhold("topic-invalid", { error: (e as Error).message });
        continue;
      }
      const { crossPipelineCheck } = await import("../pipeline/cross-pipeline-check.js");
      const cp = await crossPipelineCheck(candidateUrls, day, meta.id);
      const trueRepeats = cp.repeats;
      if (trueRepeats.length) {
        const { notify } = await import("../review/notify.js");
        log(`HOLD: ${meta.id} repeats prior coverage - NOT posting:`);
        trueRepeats.forEach((r) => log(`   ${r.url} (already in ${r.foundIn})`));
        withhold("repeat-coverage", { repeats: trueRepeats.map((r) => ({ url: r.url, foundIn: r.foundIn })) });
        notify("Example Signal - post blocked (repeat)", `${meta.id} repeats ${trueRepeats[0].foundIn}. Re-source before posting.`);
        continue;
      }
    }
    // Decode and inspect the complete media before any API upload or browser composer opens.
    // A missing dependency, corrupt stream, misplaced MP4 index, or duration mismatch is a hard hold.
    try {
      const { publishQC } = await import("./publish-qc.js");
      const qc = await publishQC(meta);
      if (!qc.pass) {
        log(`HOLD: pre-publication media QC failed for ${meta.id}: ${qc.issues.join(" | ")}`);
        withhold("media-qc", { issues: qc.issues });
        continue;
      }
      log(`pre-publication media QC passed for ${meta.id}.`);
    } catch (e) {
      log(`HOLD: pre-publication media QC could not complete for ${meta.id}: ${(e as Error).message}`);
      withhold("media-qc-unavailable", { error: (e as Error).message });
      continue;
    }

    let failures = 0;
    const runPlatform = async (platform: Platform) => {
      if (opts.only && platform !== opts.only) return;
      if (!platforms[platform]?.enabled) {
        log(`${platform}: disabled in config/platforms.json — skipping`);
        // Recorded once per video, not once per run. meta.json is deliberately NOT written here;
        // `meta.delivery` reaches disk with the next real write.
        const alreadyRecorded = readDeliveryEvents(videoDir(meta.id))
          .some((e) => e.type === "platform.skipped" && e.platform === platform);
        if (!alreadyRecorded) {
          recordPlatformOutcome(videoDir(meta.id), meta, "platform.skipped",
            { platform, state: "skipped", retryable: false, reason: "disabled", at: new Date().toISOString() });
        }
        return;
      }
      if (meta.posts[platform]) {
        log(`${platform}: already posted (${meta.posts[platform]!.id}) — skipping`);
        return;
      }
      const desk = deskFor(meta.edition ?? "daily-roundup");
      if (desk && !desks()[desk].channels.includes(platform)) return;
      if (pendingAttempt(videoDir(meta.id), platform)) {
        failures++; log(`${platform}: unresolved delivery attempt; independently verify before retrying`);
        appendDeliveryEventIfChanged(videoDir(meta.id), { type: "release.withheld", videoId: meta.id, platform, reason: "uncertain-delivery" }); return;
      }
      const retry = retryDecision(meta, platform, ADAPTERS[platform].capabilities, opts.retryBlocked);
      if (!retry.retry) { failures++; log(`${platform}: blocked pending credential repair; still missing (${retry.reason})`); return; }
      try {
        const validation = ADAPTERS[platform].validate(meta);
        if (!validation.valid) throw new Error(validation.issues.join("; "));
        await reservePublicationMemory(meta.id);
        beginAttempt(videoDir(meta.id), platform);
        await markPublicationMemorySubmitted(meta.id);
        const result = await ADAPTERS[platform].publish(meta);
        validateAcceptedReceipt(platform, result);
        meta.posts[platform] = result;
        // ACCEPTED, NOT CONFIRMED: the poster returned a provider id, which is a receipt, not proof
        // the post is live. recordPlatformOutcome is never-throw, so the meta.posts write below
        // always follows a real publish.
        recordPlatformOutcome(videoDir(meta.id), meta, "platform.accepted",
          { platform, state: "unconfirmed", retryable: false, providerId: result.id, url: result.url, at: result.postedAt });
        meta.updatedAt = new Date().toISOString();
        writeJson(join(videoDir(meta.id), "meta.json"), meta);
        try {
          if (!recordAcceptedPlatformMemory(meta, platform, result)) log(`${platform}: receipt came from profile discovery; publication memory remains unconfirmed pending exact reconciliation.`);
        } catch (error) {
          // The provider already accepted this request. Keep its real id even if auxiliary proof
          // storage fails; neither a retry nor a published-memory marker follows from this gap.
          log(`${platform}: accepted receipt saved; publication memory proof failed: ${(error as Error).message}`);
          withhold('platform-memory-unconfirmed', { platform, providerId: result.id, error: (error as Error).message });
        }
        finishAttempt(videoDir(meta.id), platform);
        log(`${platform}: posted ✓`);
      } catch (e) {
        failures++;
        const msg = (e as Error).message;
        if (!meta.posts[platform] && certainlyNotSubmitted(e)) finishAttempt(videoDir(meta.id), platform);
        log(`${platform} FAILED for ${meta.id}: ${msg}`);
        // The failure lands in the append-only log only. meta.json is NOT written here: a write after
        // a long publish attempt carries a stale `posts` view and could erase a concurrent run's record.
        const failure = classifyFailure(msg);
        // Was this destination ALREADY auth-blocked before this attempt? Read before recording, so
        // a new breakage is distinguishable from the same one failing again.
        const wasBlocked = blockedPlatforms(readDeliveryEvents(videoDir(meta.id))).includes(platform);
        recordPlatformOutcome(videoDir(meta.id), meta, "platform.failed",
          { platform, state: "failed", retryable: failure.retryable, credentialFingerprint: credentialFingerprint(platform, ADAPTERS[platform].capabilities.authProvider), reason: `${failure.reason}: ${msg.slice(0, 300)}`, at: new Date().toISOString() });
        if (failure.reason === "auth-expired") {
          const authCmd = ADAPTERS[platform].capabilities.authProvider ?? platform;
          // Say it once per breakage, not once per attempt: a dead grant fails every run, and a
          // warning that repeats on every attempt stops being read.
          log(`${platform} needs RE-AUTH${wasBlocked ? " (already reported; still blocked)" : ""}: npm run auth:${authCmd}`);
        }
      }
    };

    // Lanes run concurrently; each lane runs its own platforms in order. A lane never rejects —
    // runPlatform swallows per-platform errors into `failures` — so one dead platform cannot
    // cancel a sibling lane that is mid-upload.
    await Promise.all(
      LANES.map(async (lane) => {
        for (const platform of lane) await runPlatform(platform);
      })
    );
    const scopeDesk = deskFor(meta.edition ?? "daily-roundup");
    const required = ORDER.filter((p) => platforms[p]?.enabled && (!scopeDesk || desks()[scopeDesk].channels.includes(p)));
    if (required.length > 0 && failures === 0 && required.every((p) => meta.posts[p])) {
      meta.status = "posted";
      meta.updatedAt = new Date().toISOString();
      writeJson(join(videoDir(meta.id), "meta.json"), meta);
      updateEntry(meta.id, {
        status: "posted",
        posts: Object.fromEntries(Object.entries(meta.posts).map(([k, v]) => [k, v!.id])),
      });
      log(`${meta.id}: all enabled platforms posted ✓`);
    }
  }
}
