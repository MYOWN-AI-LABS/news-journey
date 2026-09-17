import { sourceAccountProblem } from "./source-account.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { activeRoot, contained, read as readJson } from "../workspaces.js";
import { automationAuto } from "../automation.js";
import type { AssetManifest, RenderProps, ScriptSegment, StoryDiagram, Topic } from "../types.js";
import { SelectedVisualImageReviewError, type SelectedVisualImage, type VisualPlan } from "./visual-plan.js";
import { capturedImage } from "./captured-image.js";

/**
 * Visual Intelligence — the bounded, user-facing half of the visual director
 * (docs/beta-feedback-implementation-plan-2026-09-09.md, "Visual intelligence, choice and quality gates").
 *
 * For every story it offers up to three SOURCE-BOUND candidates — News image, News snapshot,
 * Explanation — recommends one by beat (politics, courts, public affairs and breaking news prefer
 * source visuals; mechanisms prefer an explanation), and requires one hash-locked choice per story
 * before narration or rendering is paid for. A choice is bound to the exact candidate bytes; if the
 * candidate changes, the choice is void and must be made again. No candidate is invented: an image
 * is only the capture the pipeline already made of that story's own source, and "rights" is stated
 * plainly — attribution is not clearance.
 */
export type CandidateId = "image" | "snapshot" | "explanation" | "own-image";
export type Rights = "review-only" | "attributed" | "user-owned";
export interface VisualCandidate {
  id: CandidateId;
  label: string;
  available: boolean;
  /** Plain-language availability, or the reason it cannot be used. */
  why: string;
  file?: string;
  sha256?: string;
  sourceUrl: string;
  publisher: string;
  rights: Rights;
  /** The line the visual carries; qualifiers live in `context` so a caption cannot drop them. */
  caption: string;
  /** Status caveat and the pinned claims this visual must not contradict. */
  context: string[];
  /** A request rather than a finished visual: choosing it makes the harness author and check the diagram when production continues. */
  pending?: boolean;
  reviewStatus?: string;
  /** Set when this candidate's render failed pixel QA after being chosen; it can no longer be chosen. */
  failed?: string;
  hash: string;
}
export interface StoryCandidates {
  index: number;
  title: string;
  beat: "news" | "technical";
  sourceUrl: string;
  candidates: VisualCandidate[];
  recommended: { id: CandidateId; reason: string };
}
export interface VisualCandidatesFile { version: 1; videoId: string; stories: StoryCandidates[] }
export interface VisualChoice { candidateId: CandidateId; candidateHash: string; chosenBy: "user" | "recommendation"; at: string; pending?: boolean }
export interface VisualChoicesFile { version: 1; videoId: string; stories: Record<string, VisualChoice> }

export class VisualChoiceRequired extends Error {
  constructor(public readonly stories: number[]) {
    super(`Choose a visual for ${stories.length === 1 ? "story " + (stories[0]! + 1) : "stories " + stories.map(i => i + 1).join(", ")} before narration continues.`);
    this.name = "VisualChoiceRequired";
  }
}
/** A selected explanation needs its own concept labels/cues; capture labels cannot be
 * relabelled as diagram alignment. The already locked choice remains available for retry. */
export class VisualAlignmentRequired extends Error {
  constructor(public readonly stories: number[], public readonly sourceImages: SelectedVisualImage[] = []) {
    super(`The selected visual needs narration and source alignment for ${[...stories, ...sourceImages.map(image => image.index)].map(index => `story ${index + 1}`).join(', ')}; the choice and source concept are kept.`);
    this.name = 'VisualAlignmentRequired';
  }
}

type Segment = Pick<ScriptSegment, "onScreen" | "motion" | "sourceAccount"> & Partial<Pick<ScriptSegment, "voiceover" | "assetRef" | "scene">>;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "source"; } };
export const CANNOT_REVIEW_IMAGES = "Your writer cannot look at images, so this visual cannot be checked. Choose the News snapshot, or turn on the connected-account fallback.";
const rejectsImages = (reason: string) => /\bHTTP\s+400\b/i.test(reason) && /\b(image|images|multimodal|vision)\b/i.test(reason);
// Recommendations use the story's own subject vocabulary, not an edition-wide image quota.
// Event reporting includes sports; an unmentioned beat must not silently mean politics only.
const NEWS_BEAT = /\b(politic\w*|public affairs|government\w*|courts?|judges?|judicial|law|laws|legal|elections?|policy|policies|breaking|world|security|crimes?|justice|congress|senate|parliament|white house|military|war|regulat\w*|sports?|football|soccer|basketball|baseball|cricket|tennis|rugby|hockey|athletics|olympics?|paralympics?|motorsport\w*)\b/i;

function candidateHash(c: Omit<VisualCandidate, "hash" | "failed">): string {
  return digest(JSON.stringify({ id: c.id, file: c.file ?? null, sha256: c.sha256 ?? null, sourceUrl: c.sourceUrl, rights: c.rights, caption: c.caption, context: c.context }));
}

/** Automated mode never recommends a candidate it could not publish: a review-only source photograph is skipped
 * in favour of the person's own image, the reviewed explanation or the attributed headline card. */
export function recommendVisual(beat: StoryCandidates["beat"], candidates: VisualCandidate[], clearedOnly = false): StoryCandidates["recommended"] {
  // A requestable-but-undrawn explanation is never the recommendation: nothing is authored that nobody chose.
  const usable = (id: CandidateId) => candidates.some(c => c.id === id && c.available && !c.failed && !c.pending && !(clearedOnly && c.rights === "review-only"));
  const preference: [CandidateId, string][] = beat === "news"
    ? [["own-image", "Your own image: rights are yours and it was chosen for this story."], ["image", "News about people, events and institutions usually benefits from its actual reporting image. This capture still needs source relevance and image review."], ["explanation", "No usable source image is available; the reviewed explanation shows this story's supported relationships."], ["snapshot", "Neither a usable source image nor a reviewed explanation is available; the attributed headline card is the honest fallback."]]
    : [["own-image", "Your own image: rights are yours and it was chosen for this story."], ["explanation", "This story is about how something works, and its diagram passed the phone-size check."], ["image", "The source image shows the actual subject. An explanation diagram is drawn only if you choose it."], ["snapshot", "Neither a reviewed diagram nor a usable image is available; the attributed headline card is the honest fallback."]];
  const pick = preference.find(([id]) => usable(id)) ?? preference[preference.length - 1]!;
  return { id: pick[0], reason: pick[1] };
}

/** Candidate hook: from this story's own assets only. Idempotent; preserves failure marks for unchanged candidates. */
export function ensureVisualCandidates(dir: string, body: Segment[], diagrams: StoryDiagram[], writerCanReadImages: boolean): VisualCandidatesFile {
  const topic = readJson<Topic | null>(contained(dir, "topic.json"), null);
  const assets = readJson<AssetManifest>(contained(dir, "assets.json"), {});
  const previous = readJson<VisualCandidatesFile | null>(contained(dir, "visual-candidates.json"), null);
  const stories: StoryCandidates[] = [];
  for (const [i, seg] of body.entries()) {
    if (!seg.motion && !seg.sourceAccount) continue;
    const story = seg.assetRef ? topic?.stories?.find(s => s.assetRef === seg.assetRef) : topic?.stories?.[i];
    const sourceUrl = topic?.stories?.length ? story?.primaryUrl ?? "" : topic?.primaryUrl ?? "";
    if (seg.sourceAccount) { const problem = sourceAccountProblem(seg, story); if (problem) throw new Error(problem); }
    const publisher = hostOf(sourceUrl);
    const title = seg.onScreen.title;
    const context = [seg.motion?.status ?? "", ...(story?.verifiedClaims ?? [])].filter(Boolean);
    const beat: StoryCandidates["beat"] = seg.sourceAccount ? "news" : NEWS_BEAT.test(`${story?.area ?? ""} ${(story?.verticals ?? []).join(" ")} ${story?.headline ?? title}`) ? "news" : "technical";
    const image = capturedImage(dir, assets[seg.assetRef ?? "og-0"], sourceUrl, "source-image");
    const own = capturedImage(dir, assets[`${seg.assetRef ?? "og-0"}-own`], sourceUrl, "source-image");
    const review = diagrams[i]?.review;
    // The candidate gate mirrors the release gate exactly: a passed review, or the operator's explicit critic opt-out.
    const explanationReady = !seg.sourceAccount && Boolean(diagrams[i]?.svg) && (review?.status === "passed" || (review?.status === "unverified" && process.env.AI_CONTENT_DIAGRAM_CRITIC === "off"));
    // Authoring is deferred while a photograph is recommended; the person can still ask for the diagram
    // (Saaket's spin, Sep 17: "why isn't an option for animation or schema provided?"). Choosing it lifts the deferral.
    const priorExplanationFailed = Boolean(previous?.stories.find(s => s.index === i)?.candidates.find(p => p.id === "explanation")?.failed);
    // A transport/process failure while authoring is not a rejection of the diagram (its receipt stays in the package); only a
    // real per-story failed mark withdraws the request (review finding: a package-wide latch removed it from every story for good).
    const explanationRequestable = !seg.sourceAccount && writerCanReadImages && !diagrams[i]?.svg && !review && !priorExplanationFailed;
    const list: Omit<VisualCandidate, "hash" | "failed">[] = [
      // The source's own reporting photo attaches with attribution; a text-only writer does not need to look at it — the
      // rights-review caveat and the human's preview stand in for the relevance review (Saaket, Sep 17: just push the source image).
      { id: "image", label: "News image", available: !seg.sourceAccount && Boolean(image), why: seg.sourceAccount ? "This source account uses an attributed text card." : !image ? "No usable image was captured from this story's source." : writerCanReadImages ? `Captured from ${publisher}. Rights are not established: review before publishing or use your own image.` : `The source's own reporting photo from ${publisher}, attached with attribution. Rights are not established: review before publishing.`, file: image?.file, sha256: image?.sha256, sourceUrl, publisher, rights: "review-only", caption: title, context },
      // The snapshot is a text card — headline and publisher, attributed — never the source image under a different label.
      { id: "snapshot", label: "News snapshot", available: Boolean(sourceUrl), why: `Headline and ${publisher} as an attributed text card; no image is used.`, sourceUrl, publisher, rights: "attributed", caption: `${story?.headline ?? title} — ${publisher}`, context },
      { id: "explanation", label: "Explanation", available: (writerCanReadImages && explanationReady && !rejectsImages(review?.reason ?? "")) || explanationRequestable, why: !writerCanReadImages || rejectsImages(review?.reason ?? "") ? CANNOT_REVIEW_IMAGES : explanationReady ? "A diagram of the mechanism; it passed the phone-size check." : review ? `The diagram did not pass its phone check: ${review.reason}` : explanationRequestable ? "Not drawn yet. Choose it and the harness authors an animated diagram and checks it at phone size when you continue (one or two model calls)." : "No explanation diagram was authored for this story.", sourceUrl, publisher, rights: "attributed", caption: title, context, reviewStatus: review?.status, ...(explanationRequestable ? { pending: true } : {}) },
    ];
    if (own && !seg.sourceAccount) list.push({ id: "own-image", label: "Your image", available: true, why: "Uploaded by you; you hold the rights.", file: own.file, sha256: own.sha256, sourceUrl, publisher: "you", rights: "user-owned", caption: title, context });
    const candidates: VisualCandidate[] = list.map(c => {
      const hash = candidateHash(c);
      const prior = previous?.stories.find(s => s.index === i)?.candidates.find(p => p.id === c.id && p.hash === hash);
      return { ...c, hash, ...(prior?.failed && c.why !== CANNOT_REVIEW_IMAGES ? { failed: prior.failed } : {}) };
    });
    // A story with nothing usable keeps the director's plan (applyVisualChoices skips it).
    const recommended = recommendVisual(beat, candidates, automationAuto(activeRoot()));
    stories.push({ index: i, title, beat, sourceUrl, candidates, recommended });
  }
  const file: VisualCandidatesFile = { version: 1, videoId: basename(dir), stories };
  writeFileSync(contained(dir, "visual-candidates.json"), JSON.stringify(file, null, 2));
  return file;
}

export function readVisualChoices(dir: string): VisualChoicesFile {
  return readJson<VisualChoicesFile>(contained(dir, "visual-choices.json"), { version: 1, videoId: basename(dir), stories: {} });
}

/** Lock hook: bind each choice to the exact candidate; unknown, unavailable or failed candidates are refused. */
export function lockVisualChoices(dir: string, candidates: VisualCandidatesFile, choices: Record<string, CandidateId>, chosenBy: VisualChoice["chosenBy"]): VisualChoicesFile {
  const file = readVisualChoices(dir);
  for (const [key, id] of Object.entries(choices)) {
    const story = candidates.stories.find(s => String(s.index) === key);
    if (!story) throw new Error(`Story ${Number(key) + 1} has no visual to choose`);
    const candidate = story.candidates.find(c => c.id === id);
    if (!candidate || !candidate.available) throw new Error(`Story ${story.index + 1}: that visual is not available`);
    if (candidate.failed) throw new Error(`Story ${story.index + 1}: that visual failed its check (${candidate.failed}); choose another`);
    file.stories[key] = { candidateId: id, candidateHash: candidate.hash, chosenBy, at: new Date().toISOString(), ...(candidate.pending ? { pending: true } : {}) };
  }
  writeFileSync(contained(dir, "visual-choices.json"), JSON.stringify(file, null, 2));
  return file;
}

/** A user-owned image for one story: stored beside the package, offered as its own candidate. */
/**
 * A person's own image for a story. Local and open-source writers cannot look at images, so this is how their editions
 * get a photograph at all; the harness fits it to the sizes it renders (1080×1920 frame, 680-px newsletter column),
 * applies the phone's orientation and rejects anything too small, so what ships is never a raw phone upload.
 */
export async function storeOwnImage(dir: string, index: number, body: Segment[], base64: string): Promise<string> {
  const raw = Buffer.from(base64, "base64");
  const png = raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), jpeg = raw[0] === 255 && raw[1] === 216 && raw[2] === 255;
  if ((!png && !jpeg) || raw.length > 5 * 1024 * 1024 || raw.length < 64) throw new Error("Use a PNG or JPEG image up to 5 MB");
  const { fitImage } = await import("./image-fit.js");
  const fitted = await fitImage(raw, png ? "png" : "jpeg");
  const bytes = fitted.bytes;
  const ref = body[index]?.assetRef ?? "og-0";
  const file = `assets/${ref}-own.${png ? "png" : "jpg"}`;
  mkdirSync(contained(dir, "assets"), { recursive: true });
  writeFileSync(contained(dir, file), bytes, { mode: 0o600 });
  writeFileSync(contained(dir, `${file}.json`), JSON.stringify({ width: fitted.width, height: fitted.height, resized: fitted.resized, uploadedBytes: raw.length, storedBytes: bytes.length }, null, 2));
  const manifestPath = contained(dir, "assets.json");
  const manifest = readJson<AssetManifest>(manifestPath, {});
  manifest[`${ref}-own`] = file;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return file;
}

/** Voids a rejected choice: failed after QA, or unavailable when the reviewer cannot accept images. */
export function failChosenCandidate(dir: string, index: number, reason: string): void {
  const candidatesPath = contained(dir, "visual-candidates.json"), choicesPath = contained(dir, "visual-choices.json");
  const candidates = readJson<VisualCandidatesFile | null>(candidatesPath, null);
  const choices = readVisualChoices(dir);
  const choice = choices.stories[String(index)];
  if (!candidates || !choice) return;
  const story = candidates.stories.find(s => s.index === index);
  const candidate = story?.candidates.find(c => c.id === choice.candidateId);
  // Preserve the exact old selection before invalidating it for the existing chooser.
  // Each distinct failed choice has an immutable receipt; no source/artwork is replaced.
  const failure = { version: 1, index, choice, sourceUrl: candidate?.sourceUrl ?? story?.sourceUrl,
    file: candidate?.file, sha256: candidate?.sha256, reason: reason.slice(0, 4000) };
  const historyPath = contained(dir, `visual-choice-failure-${index}-${digest(JSON.stringify(failure)).slice(0, 24)}.json`);
  if (!existsSync(historyPath)) writeFileSync(historyPath, JSON.stringify({ ...failure, observedAt: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
  if (candidate) {
    if (rejectsImages(reason)) { candidate.available = false; candidate.why = CANNOT_REVIEW_IMAGES; delete candidate.failed; }
    else candidate.failed = reason.slice(0, 400);
    story!.recommended = recommendVisual(story!.beat, story!.candidates);
  }
  delete choices.stories[String(index)];
  writeFileSync(candidatesPath, JSON.stringify(candidates, null, 2));
  writeFileSync(choicesPath, JSON.stringify(choices, null, 2));
}

/** A rejected selected image returns to the existing chooser, never to an unchecked diagram. */
export function failSelectedVisualImage(dir: string, error: SelectedVisualImageReviewError, require: boolean): never {
  failChosenCandidate(dir, error.index, error.message);
  if (require) throw new VisualChoiceRequired([error.index]);
  throw error;
}

/**
 * Applies the locked choices to the director's plans. With `require`, a story without a valid choice
 * stops production (`VisualChoiceRequired`); without it — the developer CLI, or "Use recommendations
 * automatically" — the recommendation is locked and recorded as such. A choice whose candidate hash
 * no longer matches is void. Returns the plans and diagrams to render.
 */
export function applyVisualChoices(dir: string, candidates: VisualCandidatesFile, plans: VisualPlan[], diagrams: StoryDiagram[], require: boolean, writerCanReadImages = true): { plans: VisualPlan[]; diagrams: StoryDiagram[] } {
  let choices = readVisualChoices(dir);
  const missing: number[] = [];
  const auto: Record<string, CandidateId> = {};
  const usable = (story: StoryCandidates) => story.candidates.some(c => c.available && !c.failed);
  for (const story of candidates.stories) {
    if (!usable(story)) continue; // nothing to choose: the director's plan stands as it is
    const key = String(story.index);
    const choice = choices.stories[key];
    const current = choice && story.candidates.find(c => c.id === choice.candidateId);
    // A requested explanation is fulfilled by the authored diagram that passed: rebind the choice to it (same chooser)
    // instead of reopening the choice; a diagram that failed its check makes the candidate unavailable and reopens it.
    if (choice?.pending && current && current.available && !current.failed && !current.pending) {
      choices = lockVisualChoices(dir, candidates, { [key]: choice.candidateId }, choice.chosenBy);
      continue;
    }
    const valid = current && current.available && !current.failed && current.hash === choice.candidateHash;
    if (valid) continue;
    if (require) missing.push(story.index);
    else auto[key] = story.recommended.id;
  }
  if (missing.length) throw new VisualChoiceRequired(missing);
  const locked = Object.keys(auto).length ? lockVisualChoices(dir, candidates, auto, "recommendation") : choices;
  const alignment = candidates.stories.filter(story => locked.stories[String(story.index)]?.candidateId === 'explanation'
    && plans[story.index]?.conceptAdaptation && plans[story.index]?.sourceConceptHash).map(story => story.index);
  const matchesReviewedImage = (plan: VisualPlan | undefined, candidate: VisualCandidate) => plan?.kind === 'source' && plan.decision === 'model'
    && !plan.clip && plan.sourceUrl === candidate.sourceUrl && !!plan.image && !!plan.image.relevance && plan.image.file === candidate.file && plan.image.sha256 === candidate.sha256
    && plan.image.sourceUrl === candidate.sourceUrl && plan.image.relevance.sha256 === candidate.sha256 && !!plan.image.relevance.reason.trim();
  const selectedImages: SelectedVisualImage[] = [];
  for (const story of candidates.stories) {
    const selected = locked.stories[String(story.index)], candidate = selected && story.candidates.find(candidate => candidate.id === selected.candidateId);
    const plan = plans[story.index];
    // A text-only writer cannot run the relevance review, so its source photo attaches directly below with the
    // rights caveat instead of the review (Saaket, Sep 17: just push the source image). An own image the person
    // uploaded is theirs and needs no review either.
    if (!candidate || !['image', 'own-image'].includes(candidate.id) || !plan?.sourceConceptHash || matchesReviewedImage(plan, candidate)
      || (candidate.id === 'image' && !writerCanReadImages)) continue;
    if (!candidate.file || !candidate.sha256) throw new SelectedVisualImageReviewError(story.index, 'Selected source image has no exact captured bytes');
    selectedImages.push({ index: story.index, candidateId: candidate.id as SelectedVisualImage['candidateId'], file: candidate.file, sha256: candidate.sha256, sourceUrl: candidate.sourceUrl });
  }
  if (alignment.length || selectedImages.length) throw new VisualAlignmentRequired(alignment, selectedImages);
  const outPlans = plans.slice(), outDiagrams = diagrams.slice();
  for (const story of candidates.stories) {
    const choice = locked.stories[String(story.index)];
    const candidate = choice && story.candidates.find(c => c.id === choice.candidateId);
    if (!candidate) continue;
    const i = story.index, plan = plans[i]!, diagram = diagrams[i]!;
    const chosen = choice.chosenBy === "user" ? "Chosen by you." : `Recommended: ${story.recommended.reason}`;
    const caveat = (candidate.rights === "review-only" ? "Source image · rights review needed" : candidate.context[0] ?? "").slice(0, 44);
    if ((candidate.id === "image" || candidate.id === "own-image") && candidate.file && candidate.sha256) {
      if (matchesReviewedImage(plan, candidate)) { outPlans[i] = { ...plan }; continue; }
      // A text-only writer's source photo carries an honest receipt: no relevance review happened, and the reason says so.
      const relevanceReason = candidate.id === "image" && !writerCanReadImages ? `Unreviewed: the writer cannot look at images; the source's own photo is attached with attribution. ${chosen}` : chosen;
      outPlans[i] = { version: 1, kind: "source", intent: candidate.caption.slice(0, 100), reason: chosen, labels: [candidate.publisher.slice(0, 22), candidate.id === "own-image" ? "Your image" : "Source image"], cues: [], caveat, sourceUrl: candidate.sourceUrl, evidence: plan.evidence ?? { narration: candidate.caption, mechanism: candidate.context.join(" "), claims: candidate.context }, image: { file: candidate.file, sha256: candidate.sha256, sourceUrl: candidate.sourceUrl, kind: "source-image", relevance: { sha256: candidate.sha256, reason: relevanceReason, verifiedAt: choice.at } }, timing: { method: "unmatched", starts: [], duration: 6 }, decision: "model" };
    } else if (candidate.id === "snapshot") {
      // Headline card only: the renderer's card scene shows title and publisher; no diagram ships and
      // the newsletter carries the story as text (attachStoryVisuals skips an empty diagram).
      outPlans[i] = { ...plan, kind: "diagram", decision: "fallback", image: undefined, clip: undefined, media: undefined, reason: chosen, warning: undefined };
      outDiagrams[i] = { ...diagram, svg: "", review: undefined };
    } else if (plan.kind !== "three") {
      outPlans[i] = { ...plan, kind: "diagram", image: undefined, clip: undefined, media: undefined, reason: chosen };
    }
  }
  return { plans: outPlans, diagrams: outDiagrams };
}

/** Exactly one representation rebind through the caller's existing factual/cue gate.
 * A second unresolved alignment or failed bounded call propagates without another loop. */
export async function applyVisualChoicesWithAlignment(dir: string, candidates: VisualCandidatesFile, plans: VisualPlan[], diagrams: StoryDiagram[], require: boolean,
  align: (stories: number[], sourceImages: SelectedVisualImage[]) => Promise<VisualPlan[]>, writerCanReadImages = true): Promise<{ plans: VisualPlan[]; diagrams: StoryDiagram[] }> {
  try { return applyVisualChoices(dir, candidates, plans, diagrams, require, writerCanReadImages); }
  catch (error) {
    if (error instanceof SelectedVisualImageReviewError) failSelectedVisualImage(dir, error, require);
    if (!(error instanceof VisualAlignmentRequired)) throw error;
    try {
      const aligned = await align([...error.stories], structuredClone(error.sourceImages));
      if (!Array.isArray(aligned) || aligned.length !== plans.length) throw new Error('Explanation alignment must retain every selected story');
      return applyVisualChoices(dir, candidates, aligned, diagrams, require, writerCanReadImages);
    } catch (failure) {
      if (failure instanceof SelectedVisualImageReviewError) failSelectedVisualImage(dir, failure, require);
      throw failure;
    }
  }
}

/** The same requirement over saved files, for approval and status displays. */
export function pendingVisualChoice(dir: string): number[] {
  const candidates = readJson<VisualCandidatesFile | null>(contained(dir, "visual-candidates.json"), null);
  if (!candidates) return [];
  const choices = readVisualChoices(dir);
  return candidates.stories.filter(story => {
    if (!story.candidates.some(c => c.available && !c.failed)) return false; // nothing to choose, nothing pending
    const choice = choices.stories[String(story.index)];
    const current = choice && story.candidates.find(c => c.id === choice.candidateId);
    return !(current && current.available && !current.failed && current.hash === choice.candidateHash);
  }).map(s => s.index);
}

/**
 * Stories whose valid locked choice is a photo captured from the source. Attribution is not clearance (Sep 9 contract):
 * such a package can be previewed, never approved. Found by the Jordan simulation (Sep 11): a recommended STAT photo
 * reached pending_review labelled "rights review needed" and nothing downstream checked rights.
 */
export function unclearedVisualStories(dir: string): number[] {
  const safely = <T>(load: () => T, fallback: T): T => { try { return load(); } catch { return fallback; } }; // garbled metadata: the rendered results decide
  const candidates = safely(() => readJson<VisualCandidatesFile | null>(contained(dir, "visual-candidates.json"), null), null);
  const choices = safely(() => readVisualChoices(dir), { version: 1, videoId: basename(dir), stories: {} } as VisualChoicesFile);
  const out = new Set((candidates?.stories ?? []).filter(story => {
    const choice = choices.stories[String(story.index)];
    const current = choice && story.candidates.find(c => c.id === choice.candidateId);
    return current?.rights === "review-only" && current.hash === choice.candidateHash;
  }).map(s => s.index));
  // What was rendered decides too, so missing or garbled choice metadata can never approve a source photo: a story shown
  // as a captured image that is not the person's own upload (storeOwnImage writes `<ref>-own.<ext>`) is not cleared.
  const shown = safely(() => readJson<Array<{ kind?: string; image?: { file?: string } } | null>>(contained(dir, "visual-results.json"), []), []);
  (Array.isArray(shown) ? shown : []).forEach((v, i) => { if (v?.kind === "source" && !/-own\.(png|jpe?g)$/i.test(v.image?.file ?? "")) out.add(i); });
  return [...out].sort((a, b) => a - b);
}

/** Stories whose valid locked choice is NOT the explanation: their unused diagram must not be judged at approval. */
/**
 * Story indexes whose locked choice is the attributed snapshot: their card must carry NO picture. The
 * renderer otherwise paints the story's fetched source image on the card straight from the asset
 * manifest — which put an image that had just failed phone review into the Civic Signal video on
 * 2026-09-10 even though the text card had been chosen for that story.
 */
export function snapshotStories(dir: string): Set<number> {
  return new Set(Object.entries(readVisualChoices(dir).stories).filter(([, c]) => c.candidateId === "snapshot").map(([i]) => Number(i)));
}

/** Bind a selected attributed card to its actual locked contents before rendering it. */
export function selectedSourceSnapshots(dir: string): Map<number, NonNullable<RenderProps["segments"][number]["sourceSnapshot"]>> {
  const choices = readVisualChoices(dir);
  const candidates = readJson<VisualCandidatesFile | null>(contained(dir, "visual-candidates.json"), null);
  const selected = new Map<number, NonNullable<RenderProps["segments"][number]["sourceSnapshot"]>>();
  for (const [key, choice] of Object.entries(choices.stories)) {
    if (choice.candidateId !== "snapshot") continue;
    const index = Number(key);
    const candidate = candidates?.stories.find(story => story.index === index)?.candidates.find(row => row.id === "snapshot");
    if (!Number.isSafeInteger(index) || index < 0 || choices.videoId !== basename(dir) || candidates?.videoId !== choices.videoId || !candidate?.available || candidate.failed
        || candidate.hash !== choice.candidateHash || candidateHash(candidate) !== choice.candidateHash) throw new VisualChoiceRequired([index]);
    selected.set(index, { caption: candidate.caption, publisher: hostOf(candidate.sourceUrl), sourceUrl: candidate.sourceUrl });
  }
  return selected;
}

export function storiesShownWithoutDiagram(dir: string): Set<number> {
  const candidates = readJson<VisualCandidatesFile | null>(contained(dir, "visual-candidates.json"), null);
  const choices = readVisualChoices(dir);
  const out = new Set<number>();
  for (const story of candidates?.stories ?? []) {
    const choice = choices.stories[String(story.index)];
    const current = choice && story.candidates.find(c => c.id === choice.candidateId);
    if (current && current.available && !current.failed && current.hash === choice.candidateHash && current.id !== "explanation") out.add(story.index);
  }
  return out;
}

export function visualCandidatesExist(dir: string): boolean { return existsSync(contained(dir, "visual-candidates.json")); }
export function readVisualCandidates(dir: string): VisualCandidatesFile | null { return readJson<VisualCandidatesFile | null>(contained(dir, "visual-candidates.json"), null); }
export function candidateThumbnail(dir: string, candidate: VisualCandidate): string | null {
  if (!candidate.file) return null;
  // ponytail: previews up to 1.5 MB — a 1.2 MB BBC still showed as a text-only option (Saaket's spin, Sep 17: "there is no
  // image for story 3?"), and the state is re-fetched on every poll, so the cap stays bounded (3 MB × 8 stories was ~28 MB
  // per poll — review finding). Upgrade path: fit the preview with image-fit.ts or serve it from an authenticated route.
  try { const data = readFileSync(contained(dir, candidate.file)); if (data.length > 1.5 * 1024 * 1024) return null; return `data:image/${data[0] === 137 ? "png" : "jpeg"};base64,${data.toString("base64")}`; } catch { return null; }
}
