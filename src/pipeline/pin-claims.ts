/**
 * Claim pinning — judge a candidate ONCE at selection and pin the claims its sources actually
 * support, BEFORE any script exists.
 *
 * Capturability (verify-at-selection) proves a page can be read; this proves what it says. Judging
 * after a script exists leaves only one repair lever — rewriting prose — and rewriting is generative:
 * each repair is a fresh chance to over-claim something new. With the claims pinned here, the
 * script generator is told the pinned set is the whole fact budget. A failed judge cannot supply
 * that budget and stops selection for a retry; it is not a finding that the story is unsupported.
 */
import { createHash } from "node:crypto";
import { log } from "../util.js";
import { sourceText } from "./verify-at-selection.js";
import { publicResponse, safePublicUrl } from "../sources/public-apis.js";

export interface ClaimCapture {
  url: string;
  role: "primary" | "corroborating";
  status: number | null;
  sha256: string | null;
  observedAt: string;
  text: string;
}

export interface PinnedClaims {
  /** Concrete statements the captured sources directly support, phrased as they may be stated. */
  claims: string[];
  /** Things the candidate asserted that the sources do NOT support; any entry rejects the candidate. */
  unsupported: string[];
}

/** Evidence record persisted with the story: which bytes were judged. */
export type ClaimEvidence = Pick<ClaimCapture, "url" | "role" | "status" | "sha256" | "observedAt">;

/** Fields a pinned story carries into the script stage. */
export interface PinnedFields {
  verifiedClaims?: string[];
  claimEvidence?: ClaimEvidence[];
}

/** What the judge needs to know about a candidate. */
export interface ClaimCandidate {
  headline: string;
  summary?: string;
  principalEntity?: string;
}

/** Judge function shape; injectable so the decision logic is testable without a model. */
export type ClaimJudge = (prompt: string) => Promise<PinnedClaims>;

const CAPTURE_CHARS = 12_000;
const USER_AGENT = "News Journey (source verification)";

/** Fetch and extract one page. Never throws — an unreachable page is an empty capture. */
export async function captureForClaims(url: string, role: ClaimCapture["role"], request: typeof publicResponse = publicResponse): Promise<ClaimCapture> {
  const observedAt = new Date().toISOString();
  try {
    const target = safePublicUrl(url, "Claim source");
    const r = await request(target, { "User-Agent": USER_AGENT }, 30_000, 5_000_000);
    if (!r.ok) return { url, role, status: r.status, sha256: null, observedAt, text: "" };
    const raw = await r.text();
    return { url, role, status: r.status, sha256: createHash("sha256").update(raw).digest("hex"), observedAt, text: sourceText(raw).slice(0, CAPTURE_CHARS) };
  } catch (error) {
    const status = (error instanceof Error ? error.message : "").match(/^Public API HTTP (\d{3}); redirects are not followed$/)?.[1];
    return { url, role, status: status ? Number(status) : null, sha256: null, observedAt, text: "" };
  }
}

export function claimPinningPrompt(story: ClaimCandidate, captures: ClaimCapture[]): string {
  const evidence = captures
    .filter((c) => c.text)
    .map((c) => `--- ${c.role.toUpperCase()} SOURCE (${c.url}, HTTP ${c.status}) ---\n${c.text}`)
    .join("\n\n");
  return `You are the source-verification judge for a news briefing. Read ONLY the captured source text
below and decide which concrete claims about this story the sources DIRECTLY support.

STORY CANDIDATE
headline: ${story.headline}
summary:  ${story.summary ?? ""}
${story.principalEntity ? `principal entity: ${story.principalEntity}` : ""}

CAPTURED SOURCES
${evidence || "(no capturable text)"}

RULES
- A claim is supported only if the captured text states it or it follows without inference. Preserve
  every qualifier and scope marker exactly ("some", "may", "planned", "in a demo", "not measured").
- Numbers, dates, names, units and comparisons must appear in the text to be claimable. Never round
  a range into a point, never turn an announcement into a measurement, never promote a preprint,
  demo, or proposal into a shipped or proven result.
- Attribution (who did it, which institution, which company) must be stated by the source itself.
- Write each supported claim as one plain, self-contained sentence that could be spoken aloud.
- In "unsupported", list ONLY assertions that actually appear in the candidate's headline or summary
  and that the sources do not support; quote the candidate's wording. Never list what the candidate
  does not claim, and never list details the source merely omits.
- If the sources support nothing concrete, return an empty claims list. Do not invent.

Return JSON only:
{"claims":["...","..."],"unsupported":["..."]}`;
}

export function validatePinnedClaims(raw: unknown): string | null {
  const d = raw as Partial<PinnedClaims> | null;
  if (!d || !Array.isArray(d.claims) || !Array.isArray(d.unsupported)) return "response must be {claims: string[], unsupported: string[]}";
  if (!d.claims.every((c) => typeof c === "string" && c.trim().length >= 12)) return "every claim must be a non-trivial sentence";
  if (!d.unsupported.every((c) => typeof c === "string")) return "unsupported entries must be strings";
  if (d.claims.length > 24) return "too many claims — keep the concrete, source-stated ones";
  return null;
}

export interface PinDecision {
  keep: boolean;
  why: string;
  claims: string[];
  unsupported: string[];
  evidence: ClaimEvidence[];
}

export interface ClaimVerificationFailure {
  status: "failed";
  retryable: true;
  failure: "judge-unavailable" | "invalid-verdict";
  headline: string;
  reason: string;
  evidence: ClaimEvidence[];
}

/** The selection caller must not turn an unavailable judge into a verified story. CLI output
 * includes the structured source receipt; current browser command wrappers retain only the error
 * reason, not this receipt. A durable browser source-failure receipt is still a separate gap. */
export class ClaimVerificationError extends Error {
  constructor(readonly receipt: ClaimVerificationFailure, cause?: unknown) {
    super(`Claim verification failed for "${receipt.headline}": ${receipt.failure === "judge-unavailable" ? "judge unavailable" : "invalid judge output"} (${receipt.reason}). Retry story selection; this story has not been verified.`, { cause });
    this.name = "ClaimVerificationError";
  }
}

function verificationFailed(story: ClaimCandidate, evidence: ClaimEvidence[], failure: ClaimVerificationFailure["failure"], reason: string, cause?: unknown): never {
  const error = new ClaimVerificationError({ status: "failed", retryable: true, failure, headline: story.headline, reason, evidence }, cause);
  log(`pin-claims: ${JSON.stringify(error.receipt)}`);
  throw error;
}

/**
 * Sources that support no concrete claims are dropped. A transport or format failure instead
 * stops selection with a retryable error, preserving its reason and source receipt. Neither case
 * may advance an unpinned story, and no later semantic text check is assumed.
 */
export async function pinVerifiedClaims(story: ClaimCandidate, captures: ClaimCapture[], judge: ClaimJudge): Promise<PinDecision> {
  const evidence = captures.map(({ url, role, status, sha256, observedAt }) => ({ url, role, status, sha256, observedAt }));
  const usable = captures.filter((c) => c.text);
  if (!usable.length) return { keep: false, why: "no capturable source text to verify against", claims: [], unsupported: [], evidence };
  let verdict: PinnedClaims;
  try {
    verdict = await judge(claimPinningPrompt(story, usable));
  } catch (e) {
    verificationFailed(story, evidence, "judge-unavailable", e instanceof Error ? e.message : String(e), e);
  }
  const problem = validatePinnedClaims(verdict);
  if (problem) {
    verificationFailed(story, evidence, "invalid-verdict", problem);
  }
  if (!verdict.claims.length) {
    return { keep: false, why: `sources support no concrete claim (${verdict.unsupported.length} unsupported assertions)`, claims: [], unsupported: verdict.unsupported, evidence };
  }
  // The selected headline/summary also feeds hooks, cards and newsletter subjects. Keeping supported
  // body claims cannot make an unsupported candidate title safe. Let selection backfill instead.
  if (verdict.unsupported.length) {
    return { keep: false, why: `candidate headline or summary has ${verdict.unsupported.length} unsupported assertions; select a source-supported candidate`, claims: verdict.claims, unsupported: verdict.unsupported, evidence };
  }
  return { keep: true, why: `${verdict.claims.length} claims pinned`, claims: verdict.claims, unsupported: verdict.unsupported, evidence };
}
