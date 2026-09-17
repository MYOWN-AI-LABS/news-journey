/** Explicit Codex rescue adoption: retain the original reviewed text, then continue real Journey media.
 * This is a new linked media phase, never an original-model pass or renewed writing allowance. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Topic, Script, VideoMeta } from '../types.js';
import type { ParentWorkScope } from '../llm/role-router.js';
import type { ModelConfig } from '../llm/model.js';
import { runDailyEditorial, type DailyEditorialInput, type DailyEditorialCheckpoint, type DailyEditorialRoute, type DailyScriptFormat } from './daily-editorial.js';
import type { WritingOutputs, packageWritingContext } from './writing-context.js';
import type { Issue } from './newsletter.js';
import { assertPreparedModelTask } from './writing-task.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const noCall: DailyEditorialRoute['call'] = async () => { throw new Error('Adoption cannot write or adjudicate; only an already accepted rescue is reusable'); };
interface Recipe { identity: DailyEditorialRoute['identity']; originalTopic: Topic; intro: string; newsletterBudget: { min: number; max: number }; scriptBudget: { min: number; max: number }; formatIdentity: string; providedNewsletter: NonNullable<import('./daily-editorial.js').DailyEditorialOptions['providedNewsletter']> }
interface ResultRecord { status: string; rescueProvider: string; rescueModel: string; publicationReady: boolean; unaidedOriginalModelPass: boolean; parent: ParentWorkScope; original: { packageId: string; parentIdentity: string; checkpointBytesHash: string; budgetBytesHash: string; inputHash: string; physicalAttempts: number; toolAttempts: number }; checkpointHash: string; cumulativePhysicalAttempts: number; cumulativeToolAttempts: number; usage: { physicalAttempts: number; toolAttempts: number; deadline: number } }
interface Adoption { version: 1; intent: 'explicit-user-authorized-codex-rescue-media'; createdAt: string; sourcePackageId: string; rescueId: string; packageId: string; topicHash: string; sourceResultHash: string; sourceCheckpointHash: string; sourceInputHash: string; originalBudgetHash: string; rescueBudgetHash: string; recipe: Recipe; primary: ModelConfig; settingsHash: string; mediaParent: ParentWorkScope; writerKey: string; hashes: Record<string, string>; publicationReady: false; unaidedOriginalModelPass: false; hash: string }
function immutable(path: string, bytes: string | Buffer) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) assert.ok(readFileSync(path).equals(buffer), 'Adoption cannot replace existing evidence');
  else writeFileSync(path, buffer, { flag: 'wx', mode: 0o600 });
}
function safeFile(dir: string, name: string): Buffer {
  assert.ok(name && !name.startsWith('/') && !name.split(/[\\/]/).includes('..'), 'Adoption needs a package-relative evidence path');
  const base = realpathSync(dir), path = realpathSync(resolve(base, name)), rel = relative(base, path);
  assert.ok(rel && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'), 'Adoption evidence escapes its package');
  return readFileSync(path);
}
function budgetPath(parent: Pick<ParentWorkScope, 'root' | 'parentId' | 'parentIdentity'>) { return join(parent.root, 'state/role-tasks', parent.parentId, hash({ version: 1, parent: parent.parentIdentity }), 'budget.json'); }
/** Existing phases must remain on disk; a missing media ledger cannot purchase a fresh allowance. */
export function assertRescueBudgetFiles(original: { path: string; hash: string }, editorial: { path: string; hash: string }, mediaPath: string): void {
  assert.equal(sha(readFileSync(original.path)), original.hash, 'Original failed budget changed');
  assert.equal(sha(readFileSync(editorial.path)), editorial.hash, 'Original editorial-rescue budget changed');
  assert.ok(existsSync(mediaPath), 'The rescue media budget is missing; do not recreate or renew it');
}
/** A no-call execution of the original full validator proves recipe identity, complete-source review,
 * original word bounds and every structured publication/scene field. It cannot grant new approval. */
export async function verifyRescueEditorialBundle(input: DailyEditorialInput, checkpoint: DailyEditorialCheckpoint, recipe: Recipe, format: DailyScriptFormat) {
  assert.equal(recipe.identity.provider, 'codex', 'Rescue must retain the actual Codex reviewer');
  assert.ok(recipe.identity.model && recipe.identity.runtimeHash, 'Rescue reviewer identity missing');
  assert.equal(format.identity, recipe.formatIdentity, 'Original rescue script recipe changed');
  assert.equal(checkpoint.contentHash, hash(checkpoint.artifacts), 'Rescue checkpoint contents changed');
  assert.equal(Object.keys(checkpoint.artifacts).sort().join(','), 'newsletter,script');
  for (const artifact of Object.values(checkpoint.artifacts)) assert.equal(artifact.status, 'accepted', 'Only an already reviewed rescue can be adopted');
  return runDailyEditorial(input, { maxEvidenceBytes: 131072, scriptFormat: format, newsletterBudget: recipe.newsletterBudget, scriptBudget: recipe.scriptBudget,
    providedNewsletter: recipe.providedNewsletter, writer: { identity: recipe.identity, call: (...args) => noCall(...args) }, reviewer: { identity: recipe.identity, call: (...args) => noCall(...args) }, checkpoint });
}
async function settings(id: string) {
  const { activeRoot } = await import('../workspaces.js'); const { publisher, publisherBrief } = await import('../publisher.js');
  const { editionForVideo } = await import('./edition.js'); const { readPersonalization } = await import('../personalization.js');
  const { loadConfig } = await import('../util.js'); const { readCast } = await import('./cast.js');
  return { publisher: publisher(), brief: publisherBrief(), edition: editionForVideo(id), personalization: readPersonalization(activeRoot()), avatar: loadConfig('avatar'), cast: readCast(activeRoot()) };
}
/** Owner-only local operation. Reads existing rescue files; accepts no caller-authored review verdict. */
export async function createJourneyRescueAdoption(options: { sourcePackageId: string; rescueId: string; packageId: string }) {
  const { activeRoot, authorize, atomicJson } = await import('../workspaces.js');
  const { videoDir, readJson, loadConfig } = await import('../util.js');
  const { beginParentWork } = await import('../llm/role-router.js');
  const { resolveModelRuntime } = await import('../llm/model.js');
  const { journeyScriptFormat } = await import('./journey-editorial.js');
  const { publicationIntro } = await import('./narration.js');
  const { effectiveVideoWordBudget, NEWSLETTER_LENGTHS } = await import('../personalization.js');
  const { prepareJourneySourceReplay, readJourneySourceReplay } = await import('./journey-source-replay.js');
  const root = activeRoot(); const actor = authorize('produce', { root }); assert.equal(actor.role, 'owner', 'Only the workspace owner can adopt this explicitly requested rescue');
  assert.match(options.sourcePackageId, /^\d{8}-[a-z0-9-]+$/); assert.match(options.packageId, /^\d{8}-[a-z0-9-]+$/); assert.match(options.rescueId, /^codex-rescue-\d{14}$/);
  assert.notEqual(options.packageId, options.sourcePackageId, 'The original failed package must remain unchanged');
  assert.equal(options.packageId.slice(0, 8), options.sourcePackageId.slice(0, 8), 'A rescue retains its original edition day');
  const sourceDir = videoDir(options.sourcePackageId), rescueDir = join(sourceDir, 'codex-rescues', options.rescueId), dir = videoDir(options.packageId);
  assert.ok(!existsSync(dir), 'Rescue package already exists; resume its saved phase instead of renewing it');
  const resultBytes = safeFile(rescueDir, 'result.json'), result = JSON.parse(resultBytes.toString('utf8')) as ResultRecord;
  assert.equal(result.status, 'editorial-reviewed'); assert.equal(result.rescueProvider, 'codex'); assert.equal(result.publicationReady, false); assert.equal(result.unaidedOriginalModelPass, false);
  assert.equal(result.parent.root, root); assert.equal(result.parent.parentId, options.rescueId); assert.equal(result.original.packageId, options.sourcePackageId);
  const checkpointBytes = safeFile(rescueDir, 'checkpoint.json'), checkpoint = JSON.parse(checkpointBytes.toString('utf8')) as DailyEditorialCheckpoint;
  assert.equal(hash(checkpoint), result.checkpointHash);
  const inputBytes = safeFile(rescueDir, 'input.json'), input = JSON.parse(inputBytes.toString('utf8')) as DailyEditorialInput;
  assert.equal(hash(input), result.original.inputHash);
  const originalCheckpoint = safeFile(sourceDir, 'journey-editorial-checkpoint.json'); assert.equal(sha(originalCheckpoint), result.original.checkpointBytesHash);
  const originalBudget = readFileSync(budgetPath({ root, parentId: options.sourcePackageId, parentIdentity: result.original.parentIdentity })); assert.equal(sha(originalBudget), result.original.budgetBytesHash);
  const rescueBudget = readFileSync(budgetPath(result.parent)), usage = JSON.parse(rescueBudget.toString('utf8'));
  assert.equal(usage.attempts.length, result.usage.physicalAttempts); assert.equal(usage.tools.length, result.usage.toolAttempts); assert.equal(usage.deadline, result.usage.deadline);
  const originalTopic = readJson<Topic>(join(sourceDir, 'topic.json')), saved = await settings(options.sourcePackageId);
  const primary: ModelConfig = { provider: 'codex', timeoutSeconds: 300, rescue: { enabled: false }, providers: { codex: { model: result.rescueModel } } };
  const runtime = resolveModelRuntime(primary, { ...process.env, AI_CONTENT_MODEL_PROVIDER: 'codex', AI_CONTENT_MODEL_NAME: result.rescueModel });
  const bounds = saved.personalization.newsletterLength ? NEWSLETTER_LENGTHS[saved.personalization.newsletterLength].words : [900, 1300];
  const scriptBudget = effectiveVideoWordBudget(root, saved.edition.wordBudget, true), intro = publicationIntro(saved.edition, saved.publisher.publication), format = journeyScriptFormat(originalTopic, intro, scriptBudget);
  const originalState = read<Record<string, unknown>>(join(rescueDir, 'result.json')).original;
  const originalFailed = JSON.parse(originalCheckpoint.toString('utf8')) as DailyEditorialCheckpoint;
  const recipe: Recipe = { originalTopic, intro, newsletterBudget: { min: bounds[0]!, max: bounds[1]! }, scriptBudget, formatIdentity: format.identity,
    identity: { provider: 'codex', model: result.rescueModel, runtimeHash: hash({ runtime, primary, parent: result.parent.parentIdentity }) },
    providedNewsletter: { draft: originalFailed.artifacts.newsletter.candidates.at(-1) as import('./daily-editorial.js').DailyNewsletterDraft, provenance: { origin: 'original-failed-model-draft', original: originalState } } };
  await verifyRescueEditorialBundle(input, checkpoint, recipe, format);
  const topic = { ...originalTopic, id: options.packageId }, limits = { totalSeconds: 1800, maxPhysicalCalls: 48, maxToolCalls: 24 };
  const mediaParent: ParentWorkScope = { root, parentId: options.packageId, parentIdentity: hash({ version: 1, intent: 'explicit-user-authorized-codex-rescue-media', sourceResultHash: sha(resultBytes), sourceCheckpointHash: hash(checkpoint), topic, primary, settings: saved, limits }), limits };
  const writerKey = JSON.stringify({ provider: 'codex', model: result.rescueModel, rescueSource: sha(resultBytes), mediaParent: mediaParent.parentIdentity });
  mkdirSync(dir, { recursive: false, mode: 0o700 });
  const copies: Record<string, Buffer> = { 'rescue-origin/result.json': resultBytes, 'rescue-origin/checkpoint.json': checkpointBytes, 'rescue-origin/input.json': inputBytes,
    'rescue-origin/original-failed-checkpoint.json': originalCheckpoint, 'rescue-origin/original-budget.json': originalBudget, 'rescue-origin/editorial-rescue-budget.json': rescueBudget,
    'rescue-origin/original-model.json': Buffer.from(JSON.stringify(loadConfig('model'))) };
  for (const [path, bytes] of Object.entries(copies)) immutable(join(dir, path), bytes);
  const meta = readJson<VideoMeta>(join(sourceDir, 'meta.json')); atomicJson(join(dir, 'topic.json'), topic);
  atomicJson(join(dir, 'meta.json'), { ...meta, id: options.packageId, status: 'selected', posts: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  prepareJourneySourceReplay(sourceDir, dir, topic);
  const replay = readJourneySourceReplay({ dir, topic, parentIdentity: mediaParent.parentIdentity, brief: input.brief }); assert.equal(hash(replay), hash(input));
  immutable(join(dir, 'journey-editorial-checkpoint.json'), checkpointBytes);
  const body = { version: 1 as const, intent: 'explicit-user-authorized-codex-rescue-media' as const, createdAt: new Date().toISOString(), ...options, topicHash: hash(topic),
    sourceResultHash: sha(resultBytes), sourceCheckpointHash: hash(checkpoint), sourceInputHash: hash(input), originalBudgetHash: sha(originalBudget), rescueBudgetHash: sha(rescueBudget), recipe, primary,
    settingsHash: hash(saved), mediaParent, writerKey, hashes: Object.fromEntries(Object.entries(copies).map(([path, bytes]) => [path, sha(bytes)])), publicationReady: false as const, unaidedOriginalModelPass: false as const };
  immutable(join(dir, 'journey-rescue-adoption.json'), JSON.stringify({ ...body, hash: hash(body) }, null, 2));
  atomicJson(join(dir, 'writing-request.json'), { original: topic, originalHash: hash(topic), preparedHash: hash(topic), parentIdentity: mediaParent.parentIdentity, outputs: 'edition' });
  // Explicit provider change is recorded with its original configuration; ordinary original-package
  // resumes now fail their existing settings identity instead of silently buying another writer.
  atomicJson(join(root, 'config/model.json'), primary);
  beginParentWork(mediaParent);
  return { packageId: options.packageId, provider: 'codex', model: result.rescueModel, originalPhysicalAttempts: result.original.physicalAttempts, editorialRescuePhysicalAttempts: result.usage.physicalAttempts, publicationReady: false };
}
async function checked(id: string) {
  const { activeRoot } = await import('../workspaces.js'); const { videoDir, readJson, loadConfig } = await import('../util.js');
  const { journeyScriptFormat } = await import('./journey-editorial.js'); const { readJourneySourceReplay } = await import('./journey-source-replay.js');
  const root = activeRoot(), dir = videoDir(id), receipt = read<Adoption>(join(dir, 'journey-rescue-adoption.json')); const { hash: expected, ...body } = receipt;
  assert.equal(expected, hash(body), 'Rescue adoption receipt changed'); assert.equal(receipt.version, 1); assert.equal(receipt.intent, 'explicit-user-authorized-codex-rescue-media');
  assert.equal(receipt.packageId, id); assert.equal(receipt.mediaParent.root, root); assert.equal(receipt.mediaParent.parentId, id);
  assert.equal(receipt.publicationReady, false); assert.equal(receipt.unaidedOriginalModelPass, false);
  assert.equal(hash(loadConfig('model')), hash(receipt.primary), 'Rescue media model changed; its budget cannot be renewed');
  assert.equal(hash(await settings(id)), receipt.settingsHash, 'Rescue edition, publisher, voice or personalization settings changed');
  const topic = readJson<Topic>(join(dir, 'topic.json')); assert.equal(hash(topic), receipt.topicHash);
  for (const [path, expectedHash] of Object.entries(receipt.hashes)) assert.equal(sha(safeFile(dir, path)), expectedHash, 'Rescue origin evidence changed');
  const result = JSON.parse(safeFile(dir, 'rescue-origin/result.json').toString('utf8')) as ResultRecord;
  assert.equal(sha(safeFile(dir, 'rescue-origin/result.json')), receipt.sourceResultHash);
  const originalDir = videoDir(receipt.sourcePackageId);
  assert.equal(sha(safeFile(originalDir, 'journey-editorial-checkpoint.json')), result.original.checkpointBytesHash, 'Original failure changed');
  assertRescueBudgetFiles({ path: budgetPath({ root, parentId: receipt.sourcePackageId, parentIdentity: result.original.parentIdentity }), hash: receipt.originalBudgetHash },
    { path: budgetPath(result.parent), hash: receipt.rescueBudgetHash }, budgetPath(receipt.mediaParent));
  const input = JSON.parse(safeFile(dir, 'rescue-origin/input.json').toString('utf8')) as DailyEditorialInput;
  assert.equal(hash(input), receipt.sourceInputHash);
  const replay = readJourneySourceReplay({ dir, topic, parentIdentity: receipt.mediaParent.parentIdentity, brief: input.brief }); assert.equal(hash(replay), hash(input), 'Rescue complete raw sources changed');
  const checkpoint = JSON.parse(safeFile(dir, 'journey-editorial-checkpoint.json').toString('utf8')) as DailyEditorialCheckpoint;
  assert.equal(hash(checkpoint), receipt.sourceCheckpointHash, 'Adopted original checkpoint changed');
  const format = journeyScriptFormat(receipt.recipe.originalTopic, receipt.recipe.intro, receipt.recipe.scriptBudget);
  const editorial = await verifyRescueEditorialBundle(input, checkpoint, receipt.recipe, format);
  return { root, dir, topic, receipt, input, editorial, result };
}
export async function adoptedJourneyWritingContext(id: string, outputs?: WritingOutputs): Promise<Awaited<ReturnType<typeof packageWritingContext>>> {
  assert.ok(outputs === undefined || outputs === 'edition', 'Rescue retains both requested edition outputs');
  const state = await checked(id); const { createPreparedRoleDispatch, createPreparedVisionDispatch } = await import('../llm/prepared-role-dispatch.js');
  const { beginParentWork } = await import('../llm/role-router.js'); const { atomicJson } = await import('../workspaces.js');
  const parent = state.receipt.mediaParent, primary = state.receipt.primary, model = state.receipt.recipe.identity.model;
  const env = { ...process.env, AI_CONTENT_MODEL_PROVIDER: 'codex', AI_CONTENT_MODEL_NAME: model };
  const dispatchOptions = { root: state.root, parent, primary, env, policy: null, briefHash: hash(state.input.brief) };
  const usage = beginParentWork(parent);
  atomicJson(join(state.dir, 'rescue-cumulative-usage.json'), { version: 1, at: new Date().toISOString(), original: state.result.original, editorialRescue: state.result.usage, media: usage,
    cumulativePhysicalAttempts: state.result.cumulativePhysicalAttempts + usage.physicalAttempts, cumulativeToolAttempts: state.result.cumulativeToolAttempts + usage.toolAttempts, publicationReady: false, unaidedOriginalModelPass: false });
  const dispatch = createPreparedRoleDispatch(dispatchOptions), vision = createPreparedVisionDispatch(dispatchOptions);
  return { topic: state.topic, parent, writerKey: state.receipt.writerKey, dailyEditorial: state.input, vision,
    call: stage => (prompt, validate, task) => { assertPreparedModelTask(task); return dispatch(prompt, validate, { ...task, taskId: `rescue-media-${stage}:${task.taskId}` }); } };
}
export async function prepareAdoptedJourneyEditorial(context: Awaited<ReturnType<typeof packageWritingContext>>): Promise<{ issue: Issue; script: Script }> {
  const state = await checked(context.topic.id), { receipt, editorial, input, topic, dir } = state;
  assert.equal(context.parent.parentIdentity, receipt.mediaParent.parentIdentity); assert.equal(context.writerKey, receipt.writerKey); assert.equal(hash(context.dailyEditorial), hash(input));
  const { reviewedJourneyScript } = await import('./narration.js'); const { publisher } = await import('../publisher.js');
  const { atomicJson } = await import('../workspaces.js'); const { readJson } = await import('../util.js');
  const script = reviewedJourneyScript(editorial.script.structured as Script, input.stories.map(row => row.primaryUrl));
  const leadIndex = Math.max(0, topic.stories!.findIndex(row => row.weight === 'lead')), lead = editorial.newsletter.sections[leadIndex]!;
  const issue: Issue = { subject: `${publisher().publication} — ${input.day}`, lead: { title: lead.headline, body: lead.text, sourceName: new URL(input.stories[leadIndex]!.primaryUrl).hostname, sourceUrl: input.stories[leadIndex]!.primaryUrl },
    items: editorial.newsletter.sections.flatMap((row, i) => i === leadIndex ? [] : [{ name: row.headline, url: input.stories[i]!.primaryUrl, line: row.text }]), radar: [], signals: [] };
  atomicJson(join(dir, 'journey-editorial-issue.json'), issue); atomicJson(join(dir, 'script.json'), script);
  const saved = await settings(topic.id); atomicJson(join(dir, 'personalization.json'), { ...saved.personalization, wordBudget: receipt.recipe.scriptBudget });
  atomicJson(join(dir, 'companion-writing-receipt.json'), { version: 3, reviewProtocol: 'daily-editorial', editorialVersion: 6, topicHash: hash(topic), writerKey: receipt.writerKey, scriptHash: hash(script), checkpointHash: hash(editorial.checkpoint), inputHash: hash(input) });
  atomicJson(join(dir, 'journey-editorial-receipt.json'), { version: 1, editorialVersion: 6, parentIdentity: receipt.mediaParent.parentIdentity, writerKey: receipt.writerKey, inputHash: hash(input), checkpointHash: hash(editorial.checkpoint), issueHash: hash(issue), scriptHash: hash(script), newsletterBudget: receipt.recipe.newsletterBudget, scriptBudget: receipt.recipe.scriptBudget, adoptionHash: receipt.hash, actualEditorialParent: state.result.parent });
  const meta = readJson<VideoMeta>(join(dir, 'meta.json')); if (meta.status === 'selected' || meta.status === 'failed:script') atomicJson(join(dir, 'meta.json'), { ...meta, status: 'scripted', updatedAt: new Date().toISOString() });
  return { issue, script };
}
