/** Whole-source editorial writing for the actual Journey package. No fixture or supplied draft path. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { publicResponse } from '../sources/public-apis.js';
import { readableWebText, pagePublicationDate } from '../sources/web-discovery.js';
import { load } from 'cheerio';
import type { Topic, Script, VideoMeta } from '../types.js';
import { activeRoot, atomicJson } from '../workspaces.js';
import { readJson, videoDir, writeJson, log } from '../util.js';
import { publisher, publisherBrief } from '../publisher.js';
import { configuredModelRuntime } from '../llm/model.js';
import { beginParentWork, reserveParentTool, roleHash, type ParentWorkScope } from '../llm/role-router.js';
import { runDailyEditorial, runScriptFirstEditorial, DAILY_EDITORIAL_VERSION, SCRIPT_FIRST_EDITORIAL_VERSION, type DailyEditorialInput, type DailyEditorialCheckpoint, type DailyScriptFormat, type DailyEditorialOptions } from './daily-editorial.js';
import { captureNewsletterEvidence } from './newsletter-evidence.js';
import { countWords, scriptProblem, stagedCardProblem } from './script.js';
import { spokenScriptText, publicationIntro, reviewedJourneyScript } from './narration.js';
import { effectiveVideoWordBudget, NEWSLETTER_LENGTHS, readPersonalization } from '../personalization.js';
import { editionForVideo } from './edition.js';
import { type JourneyPreparedScriptReceipt, type packageWritingContext } from './writing-context.js';
import type { Issue } from './newsletter.js';
import { releaseLock } from '../release-lock.js';
import { readJourneySourceReplay } from './journey-source-replay.js';
import { readJourneyReviewRecovery } from './journey-transport-reconciliation.js';

export const JOURNEY_EDITORIAL_VERSION = 1;
const hashText = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Context = Awaited<ReturnType<typeof packageWritingContext>>;
const cta = 'Subscribe for sourced reporting.';
const plain = (value: unknown, max: number) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[<>\x00-\x1f]|https?:\/\/|www\./i.test(value);
// Description and LinkedIn copy are paragraphs; the pipeline itself appends "\n\nSources:" to them later.
const paragraphs = (value: unknown, max: number) => typeof value === 'string' && plain(value.replace(/\n/g, ' '), max);

/** Complete source captures retain exact bytes/text hashes and the original package allowance. */
export async function captureJourneyEditorialInput(topic: Topic, parent: ParentWorkScope): Promise<DailyEditorialInput> {
  const path = join(videoDir(topic.id), 'journey-editorial-input.json');
  const captureDir = join(videoDir(topic.id), 'journey-editorial-sources');
  mkdirSync(captureDir, { recursive: true, mode: 0o700 });
  const sources = (topic.stories ?? []).map((story, i) => ({ id: `topic-${i + 1}`, headline: story.headline, primaryUrl: story.primaryUrl,
    urls: [...new Set([story.primaryUrl, ...(story.claimEvidence ?? []).filter(row => row.role === 'corroborating').map(row => row.url)])] }));
  if (!sources.length) throw new Error('Journey editorial needs the selected story slate');
  const identity = roleHash({ version: JOURNEY_EDITORIAL_VERSION, parent: parent.parentIdentity, sources, brief: publisherBrief() });
  const replay = readJourneySourceReplay({ dir: videoDir(topic.id), topic, parentIdentity: parent.parentIdentity, brief: publisherBrief() });
  if (replay) return replay;
  type Source = DailyEditorialInput['stories'][number]['sources'][number];
  const verify = (source: Source) => {
    if (!/^topic-\d+-source-\d+$/.test(source.id) || !/^[a-f0-9]{64}$/.test(source.rawSha256)) throw new Error('Invalid captured source identity');
    const receipt = readJson<{ identity: string; source: Source }>(join(captureDir, `${source.id}.json`));
    const bytes = readFileSync(join(captureDir, `${source.rawSha256}.raw`));
    const html = bytes.toString('utf8'), $ = load(html);
    const date = pagePublicationDate($);
    if (receipt.identity !== identity || roleHash(receipt.source) !== roleHash(source) || hashText(bytes) !== source.rawSha256
      || readableWebText(html) !== source.text || hashText(source.text) !== source.textSha256 || (source.publishedAt ?? null) !== date) throw new Error('Saved complete Journey source bytes, text, URL or publication metadata changed');
  };
  const saved = readJson<{ identity: string; input: DailyEditorialInput; hash: string } | null>(path, null);
  if (saved) {
    if (saved.identity !== identity || saved.hash !== roleHash(saved.input)) throw new Error('Journey source capture identity changed; preserve this package and start a new one');
    for (const story of saved.input.stories) for (const source of story.sources) verify(source);
    return saved.input;
  }
  const deadline = beginParentWork(parent).deadline;
  const input: DailyEditorialInput = { day: `${topic.id.slice(0, 4)}-${topic.id.slice(4, 6)}-${topic.id.slice(6, 8)}`, brief: publisherBrief(), stories: [] };
  for (const story of sources) {
    const captured: Source[] = [];
    for (const [i, url] of story.urls.entries()) {
      const sourceId = `${story.id}-source-${i + 1}`, receiptPath = join(captureDir, `${sourceId}.json`);
      const previous = readJson<{ identity: string; source: Source } | null>(receiptPath, null);
      if (previous) { verify(previous.source); if (previous.source.url !== url) throw new Error('Saved source URL changed'); captured.push(previous.source); continue; }
      reserveParentTool(parent, `journey-source-${roleHash({ story: story.id, url, attempt: Date.now() }).slice(0, 24)}`, 'live-source-fetch');
      const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('Original package deadline expired during full-source capture');
      let raw: Buffer | undefined;
      const source = await captureNewsletterEvidence({ url, role: i === 0 ? 'primary' : 'corroborating' }, { timeoutMs: Math.min(20000, remaining), maxBytes: 1_000_000 }, async (...args) => {
        const response = await publicResponse(...args); raw = Buffer.from(await response.arrayBuffer());
        return new Response(new Uint8Array(raw), { status: response.status, headers: response.headers });
      });
      if (raw) {
        const rawPath = join(captureDir, `${hashText(raw)}.raw`);
        if (existsSync(rawPath)) { if (!readFileSync(rawPath).equals(raw)) throw new Error('Captured raw source hash collision'); }
        else writeFileSync(rawPath, raw, { mode: 0o600, flag: 'wx' });
      }
      if (source.status !== 200 || !source.text || !source.sha256 || !source.textSha256 || source.failure) {
        writeFileSync(join(captureDir, `${sourceId}.failure-${Date.now()}.json`), JSON.stringify(source), { mode: 0o600, flag: 'wx' });
        if (i === 0) throw new Error(`Complete primary source capture failed for ${url}; selected story and original budget retained`);
        continue;
      }
      const record: Source = { id: sourceId, url, publishedAt: source.publishedAt ?? null, capturedAt: source.observedAt,
        text: source.text, textSha256: source.textSha256, rawSha256: source.sha256 };
      writeFileSync(receiptPath, JSON.stringify({ identity, source: record }), { mode: 0o600, flag: 'wx' });
      verify(record); captured.push(record);
    }
    input.stories.push({ id: story.id, headline: story.headline, primaryUrl: story.primaryUrl, sources: captured });
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 131072) throw new Error('Complete Journey sources exceed the editorial context allowance; source conditions were not truncated');
  atomicJson(path, { identity, input, hash: roleHash(input) });
  return input;
}

export function journeyScriptFormat(topic: Topic, intro: string, budget: { min: number; max: number }, editorialBudget?: { min: number; max: number }): DailyScriptFormat {
  if (editorialBudget) return completeEditorialScriptFormat(topic, intro, budget, editorialBudget);
  const stories = topic.stories!;
  const text = (max: number) => ({ type: 'string' as const, minLength: 1, maxLength: max });
  const motion = { type: 'object' as const, additionalProperties: false as const, required: ['who', 'what', 'how', 'impact', 'status', 'kind'], properties: {
    who: text(250), what: text(250), how: text(250), impact: text(250), status: text(250), kind: { type: 'string' as const, enum: ['device', 'memory', 'robot', 'compress', 'flow'] } } };
  const schema = { type: 'object' as const, additionalProperties: false as const, required: ['hook', 'intro', 'body', 'cta', 'publish'], properties: {
    hook: text(120), intro: { type: 'string' as const, const: intro }, cta: { type: 'string' as const, const: cta },
    body: { type: 'array' as const, minItems: stories.length, maxItems: stories.length, items: { type: 'object' as const, additionalProperties: false as const,
      required: ['voiceover', 'scene', 'onScreen', 'assetRef', 'motion'], properties: { voiceover: text(5000), scene: { type: 'string' as const, enum: ['news_card', 'repo_card', 'stat_chart'] },
        onScreen: { type: 'object' as const, additionalProperties: false as const, required: ['title'], properties: { title: text(90) } },
        assetRef: { type: 'string' as const, enum: stories.map(row => row.assetRef) }, motion } } },
    publish: { type: 'object' as const, additionalProperties: false as const, required: ['title', 'description', 'linkedinPost', 'hashtags'], properties: {
      title: text(95), description: text(3000), linkedinPost: text(3000), hashtags: { type: 'array' as const, maxItems: 5, items: text(60) } } },
  } };
  const instructions = `Return the complete production script as {hook,intro,body,cta,publish}, using the supplied JSON schema. Spoken words are hook + intro + all body voiceover + cta; all together must meet the stated range. Hook must be 2–14 words and source-backed. Use exactly intro=${JSON.stringify(intro)} and cta=${JSON.stringify(cta)}; these are publisher-owned framing, not source factual claims. Body must have exactly one segment per story in its supplied order, with assetRefs ${JSON.stringify(stories.map(row => row.assetRef))}. Each onScreen.title is at most 8 words. Every motion field is concise sourced prose, never an invented mechanism or benefit; use kind=flow when appropriate. All hook, narration, on-screen, motion and publication fields are reviewed against the complete sources. No model-authored URLs; the harness attaches links after review. Do not emit fullVoiceoverText; code computes it. Preserve every source qualifier and scope marker exactly (for example "women's", "international", "some", "may", "planned", "up to", "aims to"); never strengthen uncertainty into confirmation or widen a record, title, competition or scope beyond the source's own words. Attach a calendar date to a claim only when the source text states that date; a supplied publication day supports only "published today" or "this week" framing, never an event date or a "reported on <date>" assertion.`;
  const validate = (value: unknown): string | null => {
    const s = value as Script;
    if (!s || typeof s !== 'object' || Object.keys(s).sort().join(',') !== 'body,cta,hook,intro,publish') return 'Return only hook,intro,body,cta,publish';
    if (s.intro !== intro || s.cta !== cta) return 'Keep the exact publisher-owned intro and CTA';
    const problem = scriptProblem(s, topic, budget, true); if (problem) return problem;
    for (const [i, part] of s.body.entries()) {
      if (part.assetRef !== stories[i]!.assetRef || Object.keys(part).sort().join(',') !== 'assetRef,motion,onScreen,scene,voiceover' || Object.keys(part.onScreen).join(',') !== 'title' || !plain(part.voiceover, 5000)) return 'Keep complete plain scene fields and the exact selected asset order';
      const bad = stagedCardProblem({ title: part.onScreen.title, motion: part.motion! }); if (bad) return bad;
    }
    if (!plain(s.publish.title, 95) || !paragraphs(s.publish.description, 3000) || !paragraphs(s.publish.linkedinPost, 3000) || !Array.isArray(s.publish.hashtags) || s.publish.hashtags.length > 5 || s.publish.hashtags.some(x => !plain(x, 60))) return 'Publication fields need bounded source-backed plain text';
    return null;
  };
  return { identity: roleHash({ version: JOURNEY_EDITORIAL_VERSION, topic, intro, budget, schema, validate: validate.toString() }), schema, instructions, validate,
    spokenText: value => spokenScriptText(value as Script), reviewText: value => {
      const s = value as Script; return [s.hook, s.intro, ...s.body.flatMap(row => [row.voiceover, row.onScreen.title, ...Object.values(row.motion ?? {})]), s.cta, ...Object.values(s.publish).flat()].join('\n');
    } };
}

/** New script-first work verifies complete written copy and short narration in one review.
 * Keep the three-argument format above unchanged for historical accepted v6 checkpoints. */
function completeEditorialScriptFormat(topic: Topic, intro: string, budget: { min: number; max: number }, editorialBudget: { min: number; max: number }): DailyScriptFormat {
  if (!Number.isSafeInteger(editorialBudget.min) || !Number.isSafeInteger(editorialBudget.max) || editorialBudget.min < 1 || editorialBudget.max < editorialBudget.min || editorialBudget.max > 1300) throw new Error('Complete editorial copy needs a positive bounded newsletter range');
  const legacy = journeyScriptFormat(topic, intro, budget), ids = topic.stories!.map((_, i) => `topic-${i + 1}`);
  // The bounded scene fields cannot reach this structural ceiling. The requested spoken
  // range is checked below AFTER persistence, so an overlong candidate is not lost in transport.
  const shapeFormat = journeyScriptFormat(topic, intro, { min: 1, max: 50000 });
  const schema = { ...legacy.schema, required: [...legacy.schema.required!, 'editorialCopy'], properties: { ...legacy.schema.properties,
    editorialCopy: { type: 'array' as const, minItems: ids.length, maxItems: ids.length, items: { type: 'object' as const, additionalProperties: false as const,
      required: ['storyId', 'text'], properties: { storyId: { type: 'string' as const, enum: ids }, text: { type: 'string' as const, minLength: 1, maxLength: 12000 } } } } } };
  const validateShape = (value: unknown): string | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Return the complete script and editorialCopy';
    const { editorialCopy, ...spoken } = value as Script;
    const problem = shapeFormat.validate(spoken); if (problem) return problem;
    if (!Array.isArray(editorialCopy) || editorialCopy.length !== ids.length || editorialCopy.some((row, i) => !row || Object.keys(row).sort().join(',') !== 'storyId,text' || row.storyId !== ids[i]
      || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 12000 || /[<>\x00-\x09\x0b-\x1f]|https?:\/\/|www\./i.test(row.text) || !/[.!?]["'’”)]*$/.test(row.text.trim()))) return 'editorialCopy needs one complete plain-text story per supplied storyId, in order, without URLs or markup';
    return null;
  };
  const validate = (value: unknown): string | null => {
    const shape = validateShape(value); if (shape) return shape;
    const { editorialCopy: copy, ...spoken } = value as Script;
    const spokenProblem = legacy.validate(spoken); if (spokenProblem) return spokenProblem;
    const editorialCopy = copy!;
    const count = countWords(editorialCopy.map(row => row.text).join(' '));
    if (count < editorialBudget.min || count > editorialBudget.max) return `Complete editorialCopy has ${count} words; required ${editorialBudget.min}–${editorialBudget.max}, separately from spoken narration`;
    for (const row of editorialCopy) {
      const sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(row.text)].map(part => part.segment.trim().toLowerCase()).filter(Boolean);
      if (new Set(sentences).size !== sentences.length) return 'Complete editorialCopy must not repeat whole sentences to fill its word range';
    }
    return null;
  };
  const instructions = legacy.instructions.replace('{hook,intro,body,cta,publish}', '{hook,intro,body,cta,publish,editorialCopy}')
    + ` ALSO write editorialCopy as [{storyId,text}] for exactly ${JSON.stringify(ids)}, in that order. This is the COMPLETE unformatted story copy for the newsletter: ${editorialBudget.min}–${editorialBudget.max} words TOTAL across its text fields, excluding IDs and the short spoken script. Write this complete copy in the requested publication tone and style for the audience in the supplied brief. Cover each story substantively with its source conditions, attribution and dates; later formatting may change paragraph breaks, not this approved wording. The ${budget.min}–${budget.max} spoken-word range applies only to hook, intro, voiceover and CTA, never editorialCopy. Do not pad or invent details to reach either range. The same factual reviewer must check EVERY editorialCopy sentence together with all narration, motion and publication fields against the complete sources. Nothing is researched or fact-checked after this script step.`;
  return { ...legacy, schema, instructions, validate, validateShape,
    identity: roleHash({ version: 1, contract: 'complete-editorial-copy-and-spoken-script', legacy: legacy.identity, shape: shapeFormat.identity, editorialBudget, schema, instructions, validate: validate.toString(), validateShape: validateShape.toString() }),
    newsletterCopy: value => structuredClone((value as Script).editorialCopy!),
    reviewText: value => `${legacy.reviewText(value)}\n${(value as Script).editorialCopy!.map(row => row.text).join('\n\n')}` };
}

/** Shared promise in produce owns this operation; its saved checkpoint prevents sibling rewrites. */
export async function prepareJourneyEditorial(context: Context, recovery: Pick<DailyEditorialOptions, 'reviewRecovery' | 'lengthRecovery' | 'factualRecovery' | 'citationRecovery'> = {}): Promise<{ issue: Issue; script: Script }> {
  if (existsSync(join(videoDir(context.topic.id), 'journey-rescue-adoption.json'))) {
    return (await import('./journey-rescue-adoption.js')).prepareAdoptedJourneyEditorial(context);
  }
  const topic = context.topic, dir = videoDir(topic.id), input = context.dailyEditorial;
  if (!input) throw new Error('Journey editorial requires its exact complete source input');
  const unlock = releaseLock(activeRoot(), `journey-editorial-${roleHash(topic.id).slice(0, 20)}`);
  try {
    const runtime = configuredModelRuntime(); if (!runtime.model) throw new Error('Pin the selected writer model before starting the Journey editorial package');
    const personalization = readPersonalization(activeRoot()), edition = editionForVideo(topic.id);
    const video = effectiveVideoWordBudget(activeRoot(), edition.wordBudget, true);
    const selectedLength = personalization.newsletterLength ? NEWSLETTER_LENGTHS[personalization.newsletterLength].words : [900, 1300];
    const intro = publicationIntro(edition, publisher().publication);
    const identity = { provider: runtime.provider, model: runtime.model, runtimeHash: roleHash({ writerKey: context.writerKey, runtime: { ...runtime, apiKey: undefined } }) };
    const checkpointPath = join(dir, 'journey-editorial-checkpoint.json');
    const savedRequest = readJson<{ settingsSnapshot?: { settings?: { dailyEditorialVersion?: number } } }>(join(dir, 'writing-request.json'), {});
    const legacy = savedRequest.settingsSnapshot?.settings?.dailyEditorialVersion === DAILY_EDITORIAL_VERSION;
    const format = journeyScriptFormat(topic, intro, video, legacy ? undefined : { min: selectedLength[0]!, max: selectedLength[1]! });
    const savedCheckpoint = readJson<DailyEditorialCheckpoint | null>(checkpointPath, null);
    // Previously accepted text can be verified and reused; consolidation cannot rerun or
    // reinterpret an unfinished historical recipe under a fresh allowance.
    if (legacy && (!savedCheckpoint || Object.values(savedCheckpoint.artifacts).some(state => state.status !== 'accepted'))) throw new Error('Historical editorial package is preserved. Use a new package for the script-first workflow; the old evidence and allowance remain unchanged.');
    const execute = legacy ? runDailyEditorial : runScriptFirstEditorial;
    const result = await execute(input, { maxEvidenceBytes: 131072, scriptFormat: format,
      newsletterBudget: { min: selectedLength[0]!, max: selectedLength[1]! }, scriptBudget: video,
      writer: { identity, call: context.call('script') }, reviewer: { identity, call: context.call('newsletter') },
      checkpoint: savedCheckpoint ?? undefined, ...recovery,
      reviewRecovery: legacy ? undefined : recovery.reviewRecovery ?? readJourneyReviewRecovery(activeRoot(), topic.id, input, identity, context.parent),
      save: checkpoint => atomicJson(checkpointPath, checkpoint) });
    const candidate = result.script.structured as Script;
    const checked = format.validate(candidate); if (checked) throw new Error(checked);
    const script = reviewedJourneyScript(candidate, input.stories.map(row => row.primaryUrl));
    const leadIndex = topic.stories!.findIndex(row => row.weight === 'lead'), index = leadIndex < 0 ? 0 : leadIndex;
    const lead = result.newsletter.sections[index]!;
    const issue: Issue = { subject: `${publisher().publication} — ${input.day}`, lead: { title: legacy ? lead.headline : candidate.body[index]!.onScreen.title, body: lead.text, sourceName: new URL(input.stories[index]!.primaryUrl).hostname, sourceUrl: input.stories[index]!.primaryUrl },
      items: result.newsletter.sections.flatMap((row, i) => i === index ? [] : [{ name: legacy ? row.headline : candidate.body[i]!.onScreen.title, url: input.stories[i]!.primaryUrl, line: row.text }]), radar: [], signals: [] };
    const editorialVersion = legacy ? DAILY_EDITORIAL_VERSION : SCRIPT_FIRST_EDITORIAL_VERSION;
    atomicJson(join(dir, 'journey-editorial-receipt.json'), { version: JOURNEY_EDITORIAL_VERSION, editorialVersion,
      parentIdentity: context.parent.parentIdentity, writerKey: context.writerKey, inputHash: roleHash(input), checkpointHash: roleHash(result.checkpoint),
      issueHash: roleHash(issue), scriptHash: roleHash(script), newsletterBudget: { min: selectedLength[0], max: selectedLength[1] }, scriptBudget: video });
    atomicJson(join(dir, 'journey-editorial-issue.json'), issue);
    writeJson(join(dir, 'personalization.json'), { ...personalization, wordBudget: video });
    // Identical retained content must not make an existing render appear stale on resume.
    if (roleHash(readJson(join(dir, 'script.json'), null)) !== roleHash(script)) writeJson(join(dir, 'script.json'), script);
    const reviewReceipt: JourneyPreparedScriptReceipt = { version: 3, reviewProtocol: 'daily-editorial', editorialVersion, topicHash: roleHash(topic), writerKey: context.writerKey, scriptHash: roleHash(script), checkpointHash: roleHash(result.checkpoint), inputHash: roleHash(input) };
    writeJson(join(dir, 'companion-writing-receipt.json'), reviewReceipt);
    const meta = readJson<VideoMeta>(join(dir, 'meta.json'));
    if (meta.status === 'selected' || meta.status === 'failed:script') { meta.status = 'scripted'; meta.updatedAt = new Date().toISOString(); writeJson(join(dir, 'meta.json'), meta); }
    log(`Journey editorial complete: ${countWords(script.fullVoiceoverText)} fact-reviewed spoken words${candidate.editorialCopy ? ` plus ${countWords(candidate.editorialCopy.map(row => row.text).join(' '))} fact-reviewed editorial copy words` : ''}, ${result.newsletter.wordCount} newsletter words; ${legacy ? 'historical reviews retained' : 'newsletter formatting checks only'}.`);
    return { issue, script };
  } finally { unlock(); }
}
