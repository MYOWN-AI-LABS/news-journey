/** Real-feed edition entry point shared by CLI/connectors. Sources and accepted stages survive retries. */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, mkdirSync, appendFileSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { load } from 'cheerio';
import { activeRoot, authorize, atomicJson, contained, safeId, validDay, CODE_ROOT } from '../workspaces.js';
import { releaseLock } from '../release-lock.js';
import { modelJson, resolveModelRuntime, type ModelConfig, type ModelRuntime } from '../llm/model.js';
import { beginParentWork, parentModelHooks, reserveParentTool, productionRoleAdapters, type ParentWorkScope } from '../llm/role-router.js';
import { withJsonOutputContract, jsonOutputContract } from '../llm/json-output-contract.js';
import { assertPreparedModelTask, type PreparedModelTask } from './writing-task.js';
import { publicResponse } from '../sources/public-apis.js';
import { readableWebText, sourcePublicationDate } from '../sources/web-discovery.js';
import type { DraftCall } from './script.js';
import { collectLiveEditorialSources } from './live-editorial-sources.js';
import { runDailyEditorial, type DailyEditorialInput } from './daily-editorial.js';
import type { Feed } from '../sources/rss.js';
import { hasMeasuredModelIdentity, type ModelIdentity } from '../llm/model-identity.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface LiveEditionOptions {
  runId: string; day: string; brief: string; topics: string[]; feeds: Feed[];
  writer: ModelConfig; reviewer: ModelConfig;
  selectCount?: number; windowHours?: number;
  preparedEvidencePath?: string; providedNewsletterPath?: string;
  requireCorroboration?: boolean;
  limits?: { maxPhysicalCalls: number; totalSeconds: number; maxToolCalls?: number };
}
function sourceHashes(): Record<string, string> {
  const rows: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const entry of readdirSync(contained(CODE_ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && !/\.(?:test|spec)\./.test(path)) rows[path] = bytesHash(readFileSync(contained(CODE_ROOT, path)));
    }
  };
  visit('src');
  return rows;
}
function sameRuntime(a: ModelRuntime, b: ModelRuntime): boolean {
  return a.provider === b.provider && a.model === b.model && a.command === b.command && a.baseUrl === b.baseUrl;
}

/** Imported source metadata must come from the original capture and raw publication record.
 * Caller-authored hashes alone cannot assign a different outlet, observation or publication date. */
export function verifyPreparedLiveEvidence(root: string, supplied: any, expected: { day: string; brief: string }): DailyEditorialInput {
  if (supplied?.input?.day !== expected.day || supplied.input.brief !== expected.brief || !Array.isArray(supplied.input.stories)
    || !Array.isArray(supplied.captures)) throw new Error('Supplied live evidence must belong to this exact edition and brief');
  const file = (path: string) => {
    const full = contained(root, path), stat = lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Original source evidence must be a regular file');
    return readFileSync(full);
  };
  const date = (value: unknown) => {
    const normalized = typeof value === 'string' ? value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2})/, '$1') : value;
    const parsed = sourcePublicationDate(normalized); return parsed ? new Date(parsed).toISOString() : null;
  };
  for (const story of supplied.input.stories) {
    if (!Array.isArray(story?.sources)) throw new Error('Supplied story has no captured sources');
    for (const source of story.sources) {
      const captures = supplied.captures.filter((row: any) => row.sourceId === source.id && row.url === source.url);
      if (captures.length !== 1 || typeof captures[0].rawPath !== 'string') throw new Error('Supplied live source lacks its unique original raw capture');
      const capture = captures[0], rawPath = contained(root, capture.rawPath), raw = file(rawPath);
      const receiptPath = capture.capturePath ?? rawPath.replace(/\.raw(?:\.html)?$/, '.capture.json');
      const stored = JSON.parse(file(receiptPath).toString('utf8')), receipt = stored.capture ?? stored;
      const text = readableWebText(raw.toString('utf8'));
      if (receipt.url !== source.url || receipt.status !== 200 || receipt.failure || receipt.bytes !== raw.length
        || receipt.sha256 !== bytesHash(raw) || receipt.sha256 !== source.rawSha256
        || receipt.text !== text || receipt.text !== source.text || receipt.textSha256 !== bytesHash(text)
        || receipt.textSha256 !== source.textSha256 || receipt.observedAt !== source.capturedAt
        || !Number.isFinite(Date.parse(receipt.observedAt))) throw new Error('Supplied source URL, observation or text does not match its original capture receipt');
      if (stored.capture && (stored.rawSha256 !== receipt.sha256 || contained(root, stored.rawPath) !== rawPath)) throw new Error('Supplemental capture provenance changed');
      const $ = load(raw.toString('utf8')), dates: string[] = [];
      const add = (value: unknown) => { const parsed = date(value); if (parsed) dates.push(parsed); };
      $('meta[property="article:published_time"],meta[name="date"]').each((_, el) => add($(el).attr('content')));
      const visit = (value: any, depth = 0): void => {
        if (depth > 8 || !value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.slice(0, 100).forEach(item => visit(item, depth + 1)); return; }
        const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
        if (types.some((type: unknown) => typeof type === 'string' && /^(?:NewsArticle|Article|ReportageNewsArticle|AnalysisNewsArticle|BlogPosting)$/.test(type))) add(value.datePublished);
        if (value['@graph']) visit(value['@graph'], depth + 1);
        if (value.mainEntity) visit(value.mainEntity, depth + 1);
      };
      $('script[type="application/ld+json"]').each((_, el) => { try { visit(JSON.parse($(el).text())); } catch { /* Malformed metadata does not establish publication time. */ } });
      if (new Set(dates.map(value => value.slice(0, 10))).size > 1) throw new Error('Original article has conflicting publication dates');
      let supportedDate: string | null = dates[0] ?? null;
      if (!supportedDate && source.publishedAt !== null) {
        // A feed fallback must match the original completed selection AND its saved raw feed.
        const dir = dirname(rawPath), manifest = JSON.parse(file(join(dir, 'selected-sources.json')).toString('utf8'));
        const row = manifest.selected?.find((item: any) => item.url === source.url && item.rawPath === rawPath);
        if (manifest.status !== 'complete' || row?.dateBasis !== 'feed' || row.capture?.sha256 !== source.rawSha256
          || date(row.publishedAt) !== date(source.publishedAt) || date(row.feedPublishedAt) !== date(source.publishedAt)) throw new Error('Supplied source publication date lacks its original feed selection');
        for (const feed of manifest.rawCaptures ?? []) if (feed.stage === 'feed') {
          const feedRaw = file(feed.path), feedReceiptBytes = file(feed.path + '.json'), feedReceipt = JSON.parse(feedReceiptBytes.toString('utf8'));
          if (bytesHash(feedRaw) !== feed.sha256 || bytesHash(feedReceiptBytes) !== feed.receiptHash || feedReceipt.sha256 !== feed.sha256
            || feedReceipt.url !== feed.url || feedReceipt.status !== 200) throw new Error('Original publication feed receipt changed');
          const xml = load(feedRaw.toString('utf8'), { xmlMode: true });
          xml('item,entry').each((_, item) => {
            const links = xml(item).find('link').map((_, link) => xml(link).attr('href') || xml(link).text().trim()).get();
            if (!links.includes(source.url)) return;
            const published = xml(item).find('pubDate,published,dc\\:date').first().text().trim();
            const publicationDate = date(published) ?? (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s/.test(published) && Number.isFinite(Date.parse(published)) ? new Date(published).toISOString() : null);
            if (publicationDate === date(source.publishedAt)) supportedDate = publicationDate;
          });
        }
      }
      if (source.publishedAt !== null && !date(source.publishedAt) || date(source.publishedAt) !== supportedDate
        || receipt.publishedAt != null && date(receipt.publishedAt) !== supportedDate) throw new Error('Supplied publication date does not match the original article or feed');
    }
  }
  return supplied.input;
}

export async function runLiveEdition(options: LiveEditionOptions) {
  const root = activeRoot(); authorize('produce', { root });
  safeId(options.runId); validDay(options.day);
  if (!options.brief?.trim() || !options.topics.length || !options.feeds.length) throw new Error('Provide this edition’s brief, topics and trusted feeds');
  const output = contained(root, 'workdir/live-editions', options.runId);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const unlock = releaseLock(root, `live-edition-${options.runId}`);
  const planPath = join(output, 'plan.json'), resultPath = join(output, 'result.json');
  const cleanConfig = (config: ModelConfig): ModelConfig => ({ ...config, rescue: { enabled: false } });
  const writer = cleanConfig(options.writer), reviewer = cleanConfig(options.reviewer);
  let writerRuntime: ModelRuntime, reviewerRuntime: ModelRuntime;
  const expectedModel = (runtime: ModelRuntime) => {
    if (!runtime.model) throw new Error('Pin an explicit model name for each writing and review route');
    if (!['ollama', 'opencode', 'codex', 'grok'].includes(runtime.provider)) throw new Error('Live beta currently requires an installed local model or an account-backed Codex/Grok CLI');
    if (runtime.provider === 'grok' && !runtime.command) throw new Error('Choose the account-backed Grok CLI explicitly');
    return runtime;
  };
  try {
    writerRuntime = resolveModelRuntime(writer, {}); reviewerRuntime = resolveModelRuntime(reviewer, {});
    expectedModel(writerRuntime); expectedModel(reviewerRuntime);
    // Writing and source QA are separate calls; the owner may select Codex for both.
    const hashes = sourceHashes();
    const suppliedEvidence = options.preparedEvidencePath ? readFileSync(contained(root, options.preparedEvidencePath), 'utf8') : undefined;
    const suppliedNewsletter = options.providedNewsletterPath ? readFileSync(contained(root, options.providedNewsletterPath), 'utf8') : undefined;
    const plan = { version: 1, options: { ...options, writer, reviewer }, sourceHashes: hashes,
      suppliedEvidenceHash: suppliedEvidence ? bytesHash(suppliedEvidence) : null, suppliedNewsletterHash: suppliedNewsletter ? bytesHash(suppliedNewsletter) : null,
      scope: 'Live RSS discovery and complete article capture, newsletter and script writing, independent source review; no media generation or publication.',
      limits: options.limits ?? { maxPhysicalCalls: 24, totalSeconds: 1800, maxToolCalls: 32 } };
    if (existsSync(planPath)) {
      if (hash(JSON.parse(readFileSync(planPath, 'utf8'))) !== hash(plan)) throw new Error('Saved run inputs or code changed; preserve this run and create a separately identified attempt');
    } else atomicJson(planPath, plan);
    const parent: ParentWorkScope = { root, parentId: options.runId, parentIdentity: hash(plan), limits: plan.limits };
    const deadline = beginParentWork(parent).deadline;
    if (Date.now() >= deadline) throw new Error('The original run deadline expired; it cannot be renewed by resume');
    const prior = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : undefined;
    const result: any = { ...prior, version: 1, startedAt: prior?.startedAt ?? new Date().toISOString(), status: 'collecting', parent,
      physicalAttempts: prior?.physicalAttempts ?? [], logicalTasks: prior?.logicalTasks ?? [], recovery: prior?.recovery ?? [],
      publicationReady: false, codeHashes: hashes };
    const save = () => atomicJson(resultPath, result);
    save();
    if (prior?.error) { result.recovery.push({ previousError: prior.error, previousFinishedAt: prior.finishedAt }); delete result.error; delete result.finishedAt; save(); }
    try {
    const localAdapters = productionRoleAdapters(root);
    const localProof = new Map<string, ModelIdentity>();
    const local = (runtime: ModelRuntime) => runtime.provider === 'ollama' || runtime.provider === 'opencode';
    // Metadata is measured before any generation. It never implies factual qualification.
    for (const runtime of [writerRuntime, reviewerRuntime]) if (local(runtime)) {
      const inspected = await localAdapters.inspect(runtime, deadline);
      result.modelChecks ??= []; result.modelChecks.push(inspected); save();
      if (!inspected.fitsMemory || !hasMeasuredModelIdentity(inspected.identity)) throw new Error(inspected.reason ?? 'Selected local model identity or memory capacity is unverified');
      localProof.set(hash(runtime), inspected.identity);
    }
    const route = (config: ModelConfig, runtime: ModelRuntime, role: string) => {
      const identity = { provider: runtime.provider, model: runtime.model!, runtimeHash: hash({ runtime, measured: localProof.get(hash(runtime)) ?? null }) };
      const call: DraftCall = async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
        assertPreparedModelTask(task);
        const number = result.logicalTasks.length + 1;
        const entry: any = { number, role, identity, task, prompt, promptHash: bytesHash(prompt), startedAt: new Date().toISOString() };
        result.logicalTasks.push(entry); save();
        const hook = parentModelHooks(parent, `edition-${hash({ number, task, role })}`);
        let localUnlock: (() => void) | undefined, entered = false;
        try {
          if (local(runtime)) {
            localUnlock = releaseLock(CODE_ROOT, 'local-role-host');
            const inspected = await localAdapters.inspect(runtime, deadline);
            if (!inspected.fitsMemory || hash(inspected.identity) !== hash(localProof.get(hash(runtime)))) throw new Error('Local model or hardware identity changed');
            await localAdapters.enter?.(runtime, deadline); entered = true;
          }
          const contract = jsonOutputContract(validate);
          const observed = (value: T) => {
            const problem = validate(value);
            appendFileSync(join(output, 'candidates.jsonl'), JSON.stringify({ number, role, value, problem, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
            return problem;
          };
          const validator = contract ? withJsonOutputContract(observed, contract.schema, { strict: contract.strict }) : observed;
          for (let recovery = 0; ; recovery++) {
            try {
              const value = await modelJson<T>(prompt, validator, config, {}, [], true, deadline, { beforeAttempt: attempt => {
                if (attempt.rescue || attempt.provider !== runtime.provider || attempt.model !== runtime.model || attempt.baseUrl !== runtime.baseUrl) throw new Error('The transport changed the selected model or provider');
                const measured = localProof.get(hash(runtime));
                const context = measured ? Math.min(measured.context.tokens!, runtime.provider === 'opencode' ? 16384 : Infinity) : Infinity;
                // UTF-8 bytes conservatively bound token count, including every corrective
                // prompt and its JSON schema. Keep room for output and chat framing.
                if (measured && attempt.promptBytes + (attempt.outputSchemaBytes ?? 0) + 4096 > context) throw new Error('Complete local prompt, schema and output allowance exceed the measured context; source text was not truncated');
                hook.beforeAttempt?.(attempt);
                result.physicalAttempts.push({ ...attempt, role, logical: number, at: new Date().toISOString() }); save();
              } });
              entry.value = value; return value;
            } catch (error) {
              const message = (error as Error).message;
              // One recovery for transport interruption; content/validation failures are never repeated here.
              if (recovery || !/fetch failed|ECONNRESET|503|502|429|connection reset/i.test(message) || Date.now() + 2000 >= deadline) throw error;
              result.recovery.push({ logical: number, error: message, at: new Date().toISOString() }); save();
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        } catch (error) { entry.error = (error as Error).message; throw error; }
        finally {
          if (entered) await localAdapters.leave?.(runtime, deadline).catch(error => { entry.cleanupError = String(error); });
          localUnlock?.(); entry.finishedAt = new Date().toISOString(); save();
        }
      };
      return { identity, call };
    };
      let sourceRequests = 0;
      const collected = suppliedEvidence ? null : await collectLiveEditorialSources({ root, runId: options.runId, topics: options.topics, feeds: options.feeds,
        selectCount: options.selectCount ?? 3, maxSelected: options.selectCount ?? 3, windowHours: options.windowHours ?? 72, minArticleWords: 300,
        minEvidenceWords: 1300, maxPacketChars: 18000, maxArticleChars: 6000,
        maxCandidates: 24, deadlineMs: 180000 }, { request: async (url, headers, timeout, maxBytes, method) => {
          reserveParentTool(parent, `fetch-${hash({ url, number: ++sourceRequests })}`, 'live-source-fetch');
          const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('Original edition deadline expired during source collection');
          return publicResponse(url, headers, Math.min(timeout, remaining), maxBytes, method);
        } });
      result.sources = collected; save();
      if (collected && collected.status !== 'complete') throw new Error('Not enough recent, relevant articles could be captured; inspect the saved source rejections');
      let input: DailyEditorialInput | undefined = collected ? { day: options.day, brief: options.brief, stories: collected.selected.map(row => ({
        id: row.id, headline: row.title, primaryUrl: row.url,
        sources: [{ id: row.id, url: row.url, publishedAt: row.publishedAt, capturedAt: row.capture.observedAt,
          text: row.capture.text, textSha256: row.capture.textSha256!, rawSha256: row.capture.sha256! }],
      })) } : undefined;
      if (suppliedEvidence) {
        const supplied = JSON.parse(suppliedEvidence);
        input = verifyPreparedLiveEvidence(root, supplied, options);
        result.sources = { mode: 'previous live captures with corroboration', status: 'complete', provenance: supplied.provenance, captures: supplied.captures }; save();
      }
      if (!input) throw new Error('This edition has no verified source input');
      atomicJson(join(output, 'input.json'), input);
      result.status = 'writing'; save();
      const checkpointPath = join(output, 'editorial-checkpoint.json');
      const written = await runDailyEditorial(input, { writer: route(writer, writerRuntime, 'writer'), reviewer: route(reviewer, reviewerRuntime, 'reviewer'),
        ...(suppliedNewsletter ? { providedNewsletter: JSON.parse(suppliedNewsletter) } : {}),
        requireCorroboration: options.requireCorroboration === true,
        maxEvidenceBytes: ['codex', 'grok'].includes(writerRuntime.provider) ? 131072 : 24000,
        checkpoint: existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, 'utf8')) : undefined,
        save: checkpoint => atomicJson(checkpointPath, checkpoint) });
      atomicJson(join(output, 'newsletter.json'), written.newsletter);
      atomicJson(join(output, 'script.json'), written.script);
      result.status = 'complete'; result.newsletterWords = written.newsletter.wordCount; result.scriptWords = written.script.wordCount;
      result.finishedAt = new Date().toISOString(); result.parentState = beginParentWork(parent); save();
      return { output, ...result };
    } catch (error) {
      result.status = 'failed'; result.error = (error as Error).message; result.finishedAt = new Date().toISOString(); result.parentState = beginParentWork(parent); save(); throw error;
    }
  } finally { unlock(); }
}
