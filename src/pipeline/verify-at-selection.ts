import { log } from "../util.js";
import { captureForClaims, pinVerifiedClaims, type ClaimJudge, type PinnedFields, ClaimVerificationError } from "./pin-claims.js";
import { publicResponse, safePublicUrl } from "../sources/public-apis.js";

/**
 * SOURCE VERIFICATION AT SELECTION TIME.
 *
 * The order this replaces was:
 *
 *     select stories  → writes topic.json        ← fetched NOTHING
 *     write script    → full script authored from them
 *     late media preparation → the FIRST fetch of any source URL
 *
 * A story was therefore chosen and fully scripted before anything checked whether its sources could
 * be read. Moving a gate earlier is not the same as moving it to the step that COMMITS the decision:
 * a faster failure on a committed bad choice is still a bad choice, and it costs a repair loop that
 * rewrites prose which was never the problem.
 *
 * This runs INSIDE selection. A story whose sources cannot be fetched never enters the slate, so
 * there is nothing downstream to repair. It is cheap — one request per URL, no model call, before
 * any script exists.
 *
 * Deliberately conservative about what counts as dead. 401/403/429 are bot-blocks, not deaths —
 * those stay, flagged, and a later capture decides. Only a hard 404/410 or an unresolvable host
 * removes a source, because dropping a true story is the more expensive error.
 */

export interface SourceVerdict {
  url: string;
  status: number | null;
  ok: boolean;
  /** Hard 404/410/DNS — the URL does not exist. */
  dead: boolean;
  /** 2xx that yields no extractable text — a JS-only page. Verifiable by nothing. */
  empty?: boolean;
  /** 2xx whose body is a bot interstitial rather than the article. Text present, evidence absent. */
  challenged?: boolean;
}

/** Operator-configurable verification policy. Lives under `sources.verification` in config. */
export interface VerificationConfig {
  /**
   * Hosts whose article bodies this pipeline cannot capture, so a story primarily sourced there is
   * not selected.
   *
   * CONFIGURABLE ON PURPOSE. The production engine carried a hardcoded publisher list, which is
   * exactly the kind of knowledge that rots: a publisher fixes its bot wall, or adds one, and the
   * shipped constant is wrong for everyone. Operators keep their own list and can see it.
   */
  uncapturableHosts?: string[];
  /**
   * Contact string appended to the verification User-Agent. Polite crawling identifies who to
   * contact; the harness ships without one rather than with someone else's address.
   */
  contact?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
}

/** Strip markup to comparable text. Bounded so a huge page cannot blow memory in a selection loop. */
export function sourceText(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30_000);
}

/**
 * Does this extracted text look like a bot interstitial rather than an article?
 *
 * Deliberately narrow and anchored on SHORT bodies. A real article about bot protection would use
 * these same phrases — and would also run to thousands of characters. An interstitial is a few
 * hundred characters of "turn on JavaScript and wait". Length is what separates them.
 */
export function isChallengePage(text: string): boolean {
  if (text.length > 1800) return false;
  return /client challenge|checking your browser|enable javascript and cookies|just a moment\.\.\.|browser-verification|ddos protection by|please verify you are (?:a )?human|attention required!/i.test(
    text
  );
}

export function isUncapturableHost(url: string, hosts: string[] = []): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return hosts
      .map((h) => h.trim().toLowerCase().replace(/^www\./, ""))
      .filter(Boolean)
      .some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function userAgent(contact?: string): string {
  const trimmed = contact?.trim();
  return trimmed
    ? `AI Content Engine source verification (${trimmed})`
    : "AI Content Engine source verification";
}

/**
 * A 200 IS NOT EVIDENCE.
 *
 * A page can return 200 and render its article client-side, so the capture comes back with an empty
 * body. Such a page cannot support a source-grounded claim judgment. Probing
 * with HEAD at selection only ever sees the 200, so the story is selected and dies hours later.
 *
 * Ask at selection whether this page yields text a claim judge can read. A candidate that fails here cannot supply source evidence,
 * so selecting it is guaranteed waste.
 *
 * Bot-blocks are NOT emptiness: 401/403/429 mean the publisher rejected a non-browser fetch, and the
 * repository metadata can still supply the selected story context; claim pinning decides whether captured text supports it.
 */
export async function probeCapturable(url: string, cfg: VerificationConfig = {}): Promise<SourceVerdict> {
  // Known-uncapturable publisher: skip the fetch entirely. Same result as the challenge detection
  // below, without spending a request on a page already known to return an interstitial.
  if (isUncapturableHost(url, cfg.uncapturableHosts)) {
    return { url, status: null, ok: false, dead: false, empty: true, challenged: true };
  }
  try {
    const response = await publicResponse(safePublicUrl(url, "Selected source"), { "User-Agent": userAgent(cfg.contact) }, Math.max(1, Math.min(cfg.timeoutMs ?? 15_000, 30_000)), 5_000_000);
    const dead = response.status === 404 || response.status === 410;
    if (dead || [401, 403, 429].includes(response.status)) {
      return { url, status: response.status, ok: response.ok, dead };
    }
    const text = sourceText(await response.text());
    // A CHALLENGE PAGE IS NOT ARTICLE TEXT. An interstitial returns 200 WITH prose, so an
    // empty-body check waves it through: there is text, it just is not the article. Left alone,
    // such a source reaches the claim-repair loop, which can only rewrite prose — and what it
    // produces is a story ABOUT being blocked. Catch it HERE, where the story is simply not
    // selected, rather than several stages later where the only lever is wording.
    if (response.ok && text && isChallengePage(text)) {
      return { url, status: response.status, ok: response.ok, dead: false, empty: true, challenged: true };
    }
    return { url, status: response.status, ok: response.ok, dead: false, empty: response.ok && !text };
  } catch (error) {
    const status = (error as Error).message.match(/^Public API HTTP (\d{3}); redirects are not followed$/)?.[1];
    const code = status ? Number(status) : null;
    return { url, status: code, ok: false, dead: code === null || code < 400 || code === 404 || code === 410 };
  }
}

/** Does this URL exist? HEAD, falling back to GET for hosts that refuse HEAD. Dead means 404/410 or no response. */
async function probeExists(url: string, cfg: VerificationConfig = {}): Promise<SourceVerdict> {
  const deadline = Date.now() + Math.max(1, Math.min(cfg.timeoutMs ?? 12_000, 30_000));
  try {
    const target = safePublicUrl(url, "Candidate source");
    const read = (method: "HEAD" | "GET") => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Source check deadline exhausted");
      return publicResponse(target, { "User-Agent": userAgent(cfg.contact) }, remaining, 5_000_000, method);
    };
    let r: Response;
    try { r = await read("HEAD"); }
    catch (error) {
      if (!/^Public API HTTP (405|501); redirects are not followed$/.test((error as Error).message)) throw error;
      r = await read("GET"); // plenty of hosts refuse HEAD
    }
    return { url, status: r.status, ok: r.ok, dead: r.status === 404 || r.status === 410 };
  } catch (error) {
    const status = (error as Error).message.match(/^Public API HTTP (\d{3}); redirects are not followed$/)?.[1];
    const code = status ? Number(status) : null;
    return { url, status: code, ok: false, dead: code === null || code < 400 || code === 404 || code === 410 };
  }
}

/**
 * VALIDATE LINKS AT AGGREGATION, BEFORE SCORING (production, 2026-08-15): a dead link must not be scored, ranked,
 * picked, scripted and rendered before anything notices. Only a hard 404/410 or an unreachable host removes a
 * candidate — 401/403/429 are bot-blocks, not deaths, because dropping a true story is the costlier error.
 */
export async function dropDeadCandidates<T extends { url: string; title?: string }>(items: T[], concurrency = 8, cfg: VerificationConfig = {}): Promise<T[]> {
  const verdicts = new Map<string, SourceVerdict>();
  const queue = [...new Set(items.map((i) => i.url))];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let u = queue.pop(); u; u = queue.pop()) verdicts.set(u, await probeExists(u, cfg));
  }));
  const kept = items.filter((i) => !verdicts.get(i.url)?.dead);
  if (kept.length < items.length) log(`aggregation: dropped ${items.length - kept.length} of ${items.length} candidates with dead links before scoring — ${items.filter((i) => verdicts.get(i.url)?.dead).map((i) => `${i.title ?? i.url} (${verdicts.get(i.url)?.status ?? "unreachable"})`).join("; ")}`);
  return kept;
}

/** A source that cannot supply evidence: it does not exist, or it yields no readable article text. */
export function isUnusable(verdict: SourceVerdict): boolean {
  return verdict.dead || verdict.empty === true;
}

export interface SelectionCandidate {
  headline: string;
  primaryUrl: string;
  summary?: string;
  principalEntity?: string;
}

export interface VerifiedSelection<T extends SelectionCandidate> {
  kept: Array<T & PinnedFields>;
  dropped: Array<{ story: T; reason: string }>;
}

/**
 * Drop candidates whose PRIMARY source cannot be read, before the slate is committed.
 *
 * Returns the reasons rather than only the survivors: a selection stage that silently shrinks its
 * own slate is indistinguishable from a quiet day, and the operator needs to know the difference.
 */
export async function verifyCandidates<T extends SelectionCandidate>(
  candidates: T[],
  cfg: VerificationConfig = {},
  /**
   * Optional claim judge (pin-claims.ts). When given, every capturable candidate is judged ONCE here
   * and its supported claims are pinned onto the kept story; a candidate whose sources support
   * nothing concrete is dropped now, while backfill is still cheap. Without a judge, selection
   * checks capturability only (the pre-pinning behaviour).
   */
  judge?: ClaimJudge
): Promise<VerifiedSelection<T>> {
  const kept: Array<T & PinnedFields> = [];
  const dropped: Array<{ story: T; reason: string }> = [];
  let judgeFailures = 0, lastJudgeError: ClaimVerificationError | undefined;
  const verdicts = await Promise.all(candidates.map((story) => probeCapturable(story.primaryUrl, cfg)));
  for (const [i, verdict] of verdicts.entries()) {
    const story = candidates[i]!;
    if (!isUnusable(verdict)) {
      if (!judge) { kept.push(story); continue; }
      let pin: Awaited<ReturnType<typeof pinVerifiedClaims>>;
      try { pin = await pinVerifiedClaims(story, [await captureForClaims(story.primaryUrl, "primary")], judge); judgeFailures = 0; }
      catch (error) {
        // A judge that fails on one candidate (invalid output, silence) drops that candidate and selection continues
        // with the next, exactly as an unreadable source is dropped (Saaket, Sep 17: resume, never shut off). Two
        // consecutive judge failures mean the provider itself is failing; that stops with the real error.
        if (!(error instanceof ClaimVerificationError) || ++judgeFailures >= 2) throw error;
        lastJudgeError = error;
        dropped.push({ story, reason: `claim verification failed — ${error.message.slice(0, 240)}` }); continue;
      }
      if (!pin.keep) { dropped.push({ story, reason: `claims unverifiable — ${pin.why}` }); continue; }
      log(`selection: "${story.headline}" — ${pin.why}`);
      kept.push({ ...story, ...(pin.claims.length ? { verifiedClaims: pin.claims } : {}), claimEvidence: pin.evidence });
      continue;
    }
    const reason = verdict.dead
      ? `primary source does not resolve (${verdict.status ?? "no response"})`
      : verdict.challenged
        ? "primary source returned a bot interstitial, not the article"
        : `primary source yielded no readable text (${verdict.status ?? "no response"})`;
    dropped.push({ story, reason });
  }
  if (dropped.length) {
    log(`selection: dropped ${dropped.length}/${candidates.length} candidate(s) with unreadable sources`);
    for (const { story, reason } of dropped) log(`  - ${story.headline}: ${reason}`);
  }
  // Nothing survived and a judge failure is among the reasons: the real error and its capture receipt, not "0 stories".
  if (!kept.length && lastJudgeError) throw lastJudgeError;
  return { kept, dropped };
}
