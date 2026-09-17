/** Model-free collection of an explicitly supplied, fresh editorial slate. Selection is not
 * factual approval: writers and reviewers receive the complete captured articles separately. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { load } from 'cheerio';
import { atomicJson, contained, safeId } from '../workspaces.js';
import { publicResponse, safePublicUrl } from '../sources/public-apis.js';
import { fetchRss, normalizeFeeds, type Feed } from '../sources/rss.js';
import { readableWebText, sourcePublicationDate } from '../sources/web-discovery.js';
import { captureNewsletterEvidence, type NewsletterCapture } from './newsletter-evidence.js';
import { isChallengePage } from './verify-at-selection.js';

export interface LiveEditorialSourceRequest {
  root: string; runId: string; topics: string[]; feeds?: (Feed | string)[]; urls?: string[];
  /** Minimum source count; collection can add sources up to maxSelected to meet evidenceWords. */
  selectCount: number; maxSelected?: number; windowHours?: number; minArticleWords?: number;
  minEvidenceWords?: number; maxPacketChars?: number; maxArticleChars?: number; maxCandidates?: number; deadlineMs?: number;
  requireTopicInTitle?: boolean;
}
export interface LiveEditorialSourceAdapters { request?: typeof publicResponse; now?: () => number }
export interface LiveEditorialSource {
  id: string; title: string; url: string; publishedAt: string; feedPublishedAt: string | null;
  dateBasis: 'article' | 'feed'; topicMatches: string[]; words: number;
  capture: NewsletterCapture; rawPath: string; capturePath: string;
}
export interface LiveEditorialRejection { url: string; reason: string }
export interface LiveEditorialSourceResult {
  version: 1; status: 'complete' | 'incomplete'; manifestPath: string; runId: string;
  topics: string[]; startedAt: string; completedAt: string; deadlineAt: string;
  selected: LiveEditorialSource[]; rejections: LiveEditorialRejection[];
  evidenceWords: number; packetChars: number; requests: number; reason: string | null;
  requestHash: string; candidatesHash: string;
  rawCaptures: Array<{ url: string; stage: 'feed' | 'article'; path: string; sha256: string; receiptHash: string }>;
  publicationReady: false; evidenceSelectionStillRequired: true;
}
interface Candidate { url: string; title: string; publishedAt: string | null; score: number }
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const wordCount = (text: string) => text.trim().split(/\s+/u).filter(Boolean).length;
const terms = (text: string) => text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
function matches(text: string, topics: string[]): string[] {
  const tokens = new Set(terms(text));
  return topics.filter(topic => terms(topic).every(term => tokens.has(term)));
}
function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}–${max}`);
  return value;
}
function saveNew(path: string, value: string | Buffer): void {
  writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
}
function savedFile(dir: string, filename: string): Buffer {
  const path = contained(dir, filename);
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Saved source evidence must be a regular file');
  return readFileSync(path);
}
/** Accept only publication fields belonging to article objects, never dateModified or capture time. */
function articleMetadata(html: string): { title: string; dates: string[]; relevanceText: string } {
  const $ = load(html), dates: string[] = [];
  const add = (value: unknown) => { const date = sourcePublicationDate(value); if (date) dates.push(date); };
  $('meta[property="article:published_time"],meta[name="date"]').each((_, el) => add($(el).attr('content')));
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 8 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) visit(item, depth + 1); return; }
    const row = value as Record<string, unknown>, types = Array.isArray(row['@type']) ? row['@type'] : [row['@type']];
    if (types.some(type => typeof type === 'string' && /^(?:NewsArticle|Article|ReportageNewsArticle|AnalysisNewsArticle|BlogPosting)$/.test(type))) add(row.datePublished);
    if (row['@graph']) visit(row['@graph'], depth + 1);
  };
  $('script[type="application/ld+json"]').each((_, el) => { try { visit(JSON.parse($(el).text())); } catch { /* Invalid metadata never supplies a date. */ } });
  const title = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content')?.trim() || $('title').first().text().trim();
  // This narrower view is used only for relevance; the saved/full writing evidence is unchanged.
  $('h1,nav,header,footer,aside').remove();
  return { title, dates: [...new Set(dates)], relevanceText: readableWebText($.html()) };
}

/** Each run directory is exclusive: repeating a run cannot replace evidence or reset its
 * elapsed allowance. Only the supplied feeds/URLs enter this queue; installed profile, harvest,
 * geography and model memory are never consulted. Each URL is fetched at most once per stage. */
export async function collectLiveEditorialSources(request: LiveEditorialSourceRequest, adapters: LiveEditorialSourceAdapters = {}): Promise<LiveEditorialSourceResult> {
  const runId = safeId(request.runId), topics = [...new Set(request.topics.map(topic => topic.trim()))];
  if (topics.length < 1 || topics.length > 24 || topics.some(topic => !topic || topic.length > 100 || !terms(topic).length || /[\x00-\x1f<>]/.test(topic))) throw new Error('Supply 1–24 explicit bounded topic terms');
  const selectCount = integer(request.selectCount, 1, 8, 'selectCount');
  const maxSelected = integer(request.maxSelected ?? 8, selectCount, 8, 'maxSelected');
  const windowHours = integer(request.windowHours ?? 72, 1, 336, 'windowHours');
  const minArticleWords = integer(request.minArticleWords ?? 200, 50, 2000, 'minArticleWords');
  const minEvidenceWords = integer(request.minEvidenceWords ?? selectCount * minArticleWords, 50, 5000, 'minEvidenceWords');
  const maxPacketChars = integer(request.maxPacketChars ?? 24000, 1000, 60000, 'maxPacketChars');
  const maxArticleChars = integer(request.maxArticleChars ?? Math.min(20000, maxPacketChars), 1000, 20000, 'maxArticleChars');
  const maxCandidates = integer(request.maxCandidates ?? 24, selectCount, 48, 'maxCandidates');
  const deadlineMs = integer(request.deadlineMs ?? 120000, 1000, 600000, 'deadlineMs');
  const requireTopicInTitle = request.requireTopicInTitle ?? false;
  if (typeof requireTopicInTitle !== 'boolean') throw new Error('requireTopicInTitle must be boolean');
  if ((request.feeds?.length ?? 0) > 12 || (request.urls?.length ?? 0) > 48) throw new Error('Supply at most 12 feeds and 48 article URLs');
  const feeds = [...new Map(normalizeFeeds(request.feeds ?? []).map(feed => [feed.url, feed])).values()], urls = [...new Set((request.urls ?? []).map(url => safePublicUrl(url, 'Explicit editorial source')))];
  if (!feeds.length && !urls.length) throw new Error('Supply at least one independent feed or explicit article URL');
  const now = adapters.now ?? Date.now, start = now(), deadline = start + deadlineMs;
  const normalizedRequest = { workspaceRoot: contained(request.root, '.'), runId, feeds, urls, topics, selectCount, maxSelected, windowHours, minArticleWords, minEvidenceWords, maxPacketChars, maxArticleChars, maxCandidates, deadlineMs, requireTopicInTitle };
  const requestHash = sha(JSON.stringify(normalizedRequest));
  const parent = contained(request.root, 'workdir/live-editorial-sources');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = contained(parent, runId);
  if (existsSync(dir)) {
    if (lstatSync(dir).isSymbolicLink()) throw new Error('Saved source run cannot be a symlink');
    if (!existsSync(contained(dir, 'selected-sources.json'))) throw new Error('Original source collection is incomplete; its attempt and allowance remain preserved');
    const saved: LiveEditorialSourceResult = JSON.parse(savedFile(dir, 'selected-sources.json').toString('utf8'));
    const original = JSON.parse(savedFile(dir, 'request.json').toString('utf8'));
    if (sha(JSON.stringify(original.input)) !== requestHash || saved.requestHash !== requestHash || original.startedAt !== saved.startedAt) throw new Error('Saved source inputs or original collection limits changed');
    if (saved.version !== 1 || saved.status !== 'complete' || saved.publicationReady !== false || saved.evidenceSelectionStillRequired !== true) throw new Error('Original source collection did not complete; do not reset its failure');
    if (saved.runId !== runId || saved.manifestPath !== contained(dir, 'selected-sources.json') || JSON.stringify(saved.topics) !== JSON.stringify(topics)
      || !Array.isArray(saved.selected) || saved.selected.length < selectCount || saved.selected.length > maxSelected
      || !Number.isSafeInteger(saved.requests) || saved.requests < 1 || saved.requests > feeds.length + maxCandidates
      || !Number.isFinite(Date.parse(saved.startedAt)) || !Number.isFinite(Date.parse(saved.completedAt))
      || Date.parse(saved.deadlineAt) !== Date.parse(saved.startedAt) + deadlineMs || Date.parse(saved.completedAt) > Date.parse(saved.deadlineAt)) throw new Error('Saved collection receipt is invalid');
    const candidateBytes = savedFile(dir, 'candidates.json');
    if (saved.candidatesHash !== sha(candidateBytes)) throw new Error('Saved source candidate manifest changed');
    const candidates: Candidate[] = JSON.parse(candidateBytes.toString('utf8'));
    if (!Array.isArray(candidates) || candidates.length > maxCandidates) throw new Error('Saved source candidate count changed');
    if (!Array.isArray(saved.rawCaptures) || saved.rawCaptures.length > saved.requests) throw new Error('Saved raw capture inventory changed');
    const rawKeys = new Set<string>();
    for (const row of saved.rawCaptures) {
      const url = safePublicUrl(row.url, 'Saved raw source'), key = `${row.stage}-${sha(url).slice(0, 20)}`;
      if (rawKeys.has(key) || !['feed', 'article'].includes(row.stage) || row.path !== contained(dir, `${key}.raw`)
        || !(row.stage === 'feed' ? feeds.some(feed => feed.url === url) : candidates.some(candidate => candidate.url === url))) throw new Error('Saved raw capture provenance changed');
      rawKeys.add(key);
      const raw = savedFile(dir, `${key}.raw`), receiptBytes = savedFile(dir, `${key}.raw.json`), receipt = JSON.parse(receiptBytes.toString('utf8'));
      if (sha(raw) !== row.sha256 || sha(receiptBytes) !== row.receiptHash || receipt.sha256 !== row.sha256 || receipt.url !== url || receipt.stage !== row.stage || receipt.bytes !== raw.length || receipt.rawPath !== row.path) throw new Error('Saved raw source or its receipt changed');
    }
    let words = 0, chars = 0; const used = new Set<string>(), usedText = new Set<string>();
    for (const source of saved.selected) {
      const url = safePublicUrl(source.url, 'Saved editorial source'), id = sha(url).slice(0, 20);
      const candidate = candidates.find(row => row.url === url);
      if (!candidate || used.has(url) || !rawKeys.has(`article-${id}`) || source.id !== id || source.rawPath !== contained(dir, `article-${id}.raw`) || source.capturePath !== contained(dir, `article-${id}.capture.json`)) throw new Error('Saved source attribution changed');
      used.add(url);
      const raw = savedFile(dir, `article-${id}.raw`), receipt = JSON.parse(savedFile(dir, `article-${id}.raw.json`).toString('utf8'));
      const capture: NewsletterCapture = JSON.parse(savedFile(dir, `article-${id}.capture.json`).toString('utf8'));
      const text = readableWebText(raw.toString('utf8')), metadata = articleMetadata(raw.toString('utf8'));
      if (receipt.url !== url || receipt.stage !== 'article' || receipt.status !== 200 || receipt.bytes !== raw.length || receipt.sha256 !== sha(raw)
        || JSON.stringify(source.capture) !== JSON.stringify(capture) || capture.url !== url || capture.role !== 'primary' || capture.status !== 200 || capture.failure
        || capture.bytes !== raw.length || capture.sha256 !== sha(raw) || capture.text !== text || capture.textSha256 !== sha(text) || isChallengePage(text)) throw new Error('Saved raw article or complete capture changed');
      const publishedAt = metadata.dates[0] ?? candidate.publishedAt;
      if (new Set(metadata.dates.map(date => date.slice(0, 10))).size > 1 || !publishedAt || source.publishedAt !== publishedAt || source.feedPublishedAt !== candidate.publishedAt
        || source.dateBasis !== (metadata.dates.length ? 'article' : 'feed') || source.title !== (metadata.title || candidate.title || candidate.url)
        || Date.parse(publishedAt) > start + 5 * 60000 || Date.parse(publishedAt) < start - windowHours * 3600000) throw new Error('Saved source publication metadata changed or is no longer fresh');
      const matched = matches(metadata.relevanceText, topics), count = wordCount(text);
      if (requireTopicInTitle && !matches(metadata.title || candidate.title, topics).length) throw new Error('Saved article title is outside the supplied topics');
      if (count < minArticleWords || text.length > maxArticleChars || source.words !== count || !matched.length || JSON.stringify(source.topicMatches) !== JSON.stringify(matched) || usedText.has(sha(text))) throw new Error('Saved source relevance, distinct text or evidence capacity changed');
      usedText.add(sha(text)); words += count; chars += text.length;
    }
    if (saved.evidenceWords !== words || saved.packetChars !== chars || words < minEvidenceWords || chars > maxPacketChars) throw new Error('Saved complete source packet totals changed');
    return saved; // No request, deadline reset, progress rewrite or model acceptance on reuse.
  }
  mkdirSync(dir, { mode: 0o700 }); // EEXIST deliberately preserves the original failed/completed run.
  const manifestPath = contained(dir, 'selected-sources.json'), progressPath = contained(dir, 'progress.json');
  const result: LiveEditorialSourceResult = { version: 1, status: 'incomplete', manifestPath, runId, topics,
    startedAt: new Date(start).toISOString(), completedAt: '', deadlineAt: new Date(deadline).toISOString(), selected: [], rejections: [], evidenceWords: 0, packetChars: 0, requests: 0, reason: null,
    requestHash, candidatesHash: '', rawCaptures: [], publicationReady: false, evidenceSelectionStillRequired: true };
  saveNew(contained(dir, 'request.json'), JSON.stringify({ input: normalizedRequest, startedAt: result.startedAt }, null, 2) + '\n');
  const progress = () => atomicJson(progressPath, result);
  const reject = (url: string, reason: string) => { result.rejections.push({ url, reason }); progress(); };
  const captures = new Map<string, string>();
  let stage: 'feed' | 'article' = 'feed';
  const download: typeof publicResponse = async (url, headers, timeoutMs, maxBytes = 1000000, method = 'GET') => {
    url = safePublicUrl(url, 'Live editorial source');
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('Original source-collection deadline reached');
    result.requests++; progress();
    const response = await (adapters.request ?? publicResponse)(url, headers, Math.min(timeoutMs, remaining), maxBytes, method);
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > maxBytes) throw new Error(`Source response exceeds ${maxBytes} bytes`);
    const rawPath = contained(dir, `${stage}-${sha(url).slice(0, 20)}.raw`);
    saveNew(rawPath, raw); captures.set(`${stage}:${url}`, rawPath);
    const receiptJson = JSON.stringify({ url, stage, status: response.status, observedAt: new Date(now()).toISOString(), bytes: raw.length, sha256: sha(raw), contentType: response.headers.get('content-type'), rawPath }, null, 2) + '\n';
    saveNew(rawPath + '.json', receiptJson);
    result.rawCaptures.push({ url, stage, path: rawPath, sha256: sha(raw), receiptHash: sha(receiptJson) });
    if (now() >= deadline) throw new Error('Source response exceeded the original collection deadline');
    return new Response(raw, { status: response.status, headers: response.headers });
  };
  progress();
  const candidates = new Map<string, Candidate>();
  const addCandidate = (candidate: Candidate) => {
    try {
      const url = safePublicUrl(candidate.url, 'Feed article');
      const prior = candidates.get(url);
      candidates.set(url, prior ? { url, title: prior.title || candidate.title, publishedAt: prior.publishedAt || candidate.publishedAt, score: Math.max(prior.score, candidate.score) } : { ...candidate, url });
    } catch { reject(candidate.url, 'Feed article URL failed public HTTPS safety checks'); }
  };
  for (const url of urls) addCandidate({ url, title: '', publishedAt: null, score: topics.length + 1 });
  // One feed at a time keeps the original deadline and raw-file ownership straightforward.
  for (const feed of feeds) {
    if (now() >= deadline) { reject(feed.url, 'Original source-collection deadline reached'); break; }
    let error: string | null = null;
    const items = await fetchRss([feed], windowHours, async (...args) => {
      try { return await download(...args); } catch (cause) { error = cause instanceof Error ? cause.message : 'Feed capture failed'; throw cause; }
    });
    if (!items.length) reject(feed.url, error ?? 'Feed supplied no parsable dated recent items');
    for (const item of items) addCandidate({ url: item.url, title: item.title, publishedAt: item.publishedAt, score: matches(`${item.title} ${item.summary ?? ''}`, topics).length });
  }
  const ordered = [...candidates.values()].sort((a, b) => b.score - a.score || (Date.parse(b.publishedAt ?? '') || 0) - (Date.parse(a.publishedAt ?? '') || 0) || a.url.localeCompare(b.url)).slice(0, maxCandidates);
  const candidateJson = JSON.stringify(ordered, null, 2) + '\n'; result.candidatesHash = sha(candidateJson);
  saveNew(contained(dir, 'candidates.json'), candidateJson);
  stage = 'article';
  for (const candidate of ordered) {
    if (result.selected.length >= selectCount && result.evidenceWords >= minEvidenceWords) break;
    if (now() >= deadline) { reject(candidate.url, 'Original source-collection deadline reached'); break; }
    const capture = await captureNewsletterEvidence({ url: candidate.url, role: 'primary' }, { timeoutMs: Math.min(30000, deadline - now()), maxBytes: 1000000 }, download);
    const id = sha(candidate.url).slice(0, 20), capturePath = contained(dir, `article-${id}.capture.json`);
    saveNew(capturePath, JSON.stringify(capture, null, 2) + '\n');
    const rawPath = captures.get(`article:${candidate.url}`);
    if (capture.failure || !rawPath || capture.status !== 200 || !capture.text || isChallengePage(capture.text)) { reject(candidate.url, capture.failure ?? 'Unavailable, incomplete or challenged article'); continue; }
    const raw = readFileSync(rawPath), metadata = articleMetadata(raw.toString('utf8'));
    if (capture.sha256 !== sha(raw) || capture.textSha256 !== sha(capture.text)) throw new Error('Saved source bytes do not match the capture');
    if (new Set(metadata.dates.map(date => date.slice(0, 10))).size > 1) { reject(candidate.url, 'Article contains conflicting publication dates'); continue; }
    const publishedAt = metadata.dates[0] ?? candidate.publishedAt;
    if (!publishedAt || !sourcePublicationDate(publishedAt)) { reject(candidate.url, 'No reliable article or feed publication date'); continue; }
    const timestamp = Date.parse(publishedAt);
    if (timestamp > start + 5 * 60000 || timestamp < start - windowHours * 3600000) { reject(candidate.url, 'Article publication date is stale or in the future'); continue; }
    const topicMatches = matches(metadata.relevanceText, topics), words = wordCount(capture.text);
    if (requireTopicInTitle && !matches(metadata.title || candidate.title, topics).length) { reject(candidate.url, 'Article title does not mention the supplied topics'); continue; }
    if (!topicMatches.length) { reject(candidate.url, 'Complete article does not mention the supplied topics'); continue; }
    if (words < minArticleWords) { reject(candidate.url, `Inadequate complete evidence: ${words} words; ${minArticleWords} required`); continue; }
    if (result.selected.some(source => source.capture.textSha256 === capture.textSha256)) { reject(candidate.url, 'Same complete source text already selected'); continue; }
    if (capture.text.length > maxArticleChars) { reject(candidate.url, 'Complete article exceeds the remaining source-packet capacity; no text was clipped'); continue; }
    if (result.packetChars + capture.text.length > maxPacketChars || result.selected.length >= maxSelected) {
      const replacement = result.evidenceWords < minEvidenceWords
        ? [...result.selected].sort((a, b) => a.words - b.words || a.url.localeCompare(b.url)).find(source => source.words < words && result.packetChars - source.capture.text.length + capture.text.length <= maxPacketChars)
        : undefined;
      if (!replacement) { reject(candidate.url, 'Complete article exceeds the remaining source-packet capacity; no text was clipped'); continue; }
      result.selected.splice(result.selected.indexOf(replacement), 1);
      result.evidenceWords -= replacement.words; result.packetChars -= replacement.capture.text.length;
      reject(replacement.url, 'Replaced this whole article with a longer qualified source to meet the original evidence-word floor; its capture is preserved');
    }
    const source: LiveEditorialSource = { id, title: metadata.title || candidate.title || candidate.url, url: candidate.url,
      publishedAt, feedPublishedAt: candidate.publishedAt, dateBasis: metadata.dates.length ? 'article' : 'feed',
      topicMatches, words, capture, rawPath, capturePath };
    result.selected.push(source); result.evidenceWords += words; result.packetChars += capture.text.length; progress();
  }
  result.status = now() < deadline && result.selected.length >= selectCount && result.evidenceWords >= minEvidenceWords ? 'complete' : 'incomplete';
  result.reason = result.status === 'complete' ? null : `Collected ${result.selected.length}/${selectCount} required sources and ${result.evidenceWords}/${minEvidenceWords} evidence words within the original source limits`;
  result.completedAt = new Date(now()).toISOString();
  saveNew(manifestPath, JSON.stringify(result, null, 2) + '\n'); progress();
  return result;
}
