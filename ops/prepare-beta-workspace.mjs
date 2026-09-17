// A new beta starts with no editorial history. Only the selected writer and narrator may carry over.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { CODE_ROOT, authenticate, atomicJson, contained, createWorkspace, localToken, read, workspaceRoot } from '../src/workspaces.ts';

/** The local model advisor's measurement describes this computer, not the publication; a fresh beta keeps it so a local writer is not refused at the script stage for want of a scan. */
export const MEASUREMENT_FILES = ['state/model-advisor.json', 'state/model-advisor-checks.json'];
export function retainedMeasurement(prior) { return MEASUREMENT_FILES.filter(path => existsSync(contained(prior, path))); }
export function prepareBetaWorkspace(slug, previous, codeRoot = CODE_ROOT) {
  // New workspaces copy the installed template. Validate it before creating a directory or
  // identity so a legacy installation's publication/profile cannot become a fresh beta's state.
  for (const name of ['publisher.json', 'personalization.json', 'personal-profile.json', 'cast.json']) {
    assert.equal(lstatSync(contained(codeRoot, 'config', name), { throwIfNoEntry: false }), undefined,
      `Fresh beta requires a neutral installed template; config/${name} must not be present`);
  }
  const templateSources = read(contained(codeRoot, 'config/sources.json'), {});
  assert.deepEqual(templateSources.editorial?.preferredTopics, [], 'Fresh beta requires an installed template without previous topics');
  assert.deepEqual(templateSources.editorial?.areas?.focusAreas, ['other'], 'Fresh beta requires neutral installed categories');
  const prior = workspaceRoot(codeRoot, previous);
  assert.equal(authenticate(prior, localToken(prior)).role, 'owner', 'Only the local workspace owner may retain its writer and narrator');
  const model = read(contained(prior, 'config/model.json'), {});
  const avatar = read(contained(prior, 'config/avatar.json'), {});
  assert.ok(['kokoro', 'voicebox'].includes(avatar.voiceProvider), 'This beta initializer supports the built-in or selected local narrator');
  const pipeline = read(contained(prior, 'config/pipeline.json'), {});
  if (avatar.voiceProvider === 'voicebox') {
    assert.ok(typeof avatar.voicebox?.profile === 'string' && avatar.voicebox.profile.trim() && avatar.voicebox.profile.length <= 200,
      'The previous workspace needs a selected local voice profile of at most 200 characters');
    assert.ok(avatar.voicebox.name === undefined || typeof avatar.voicebox.name === 'string' && avatar.voicebox.name.length <= 100,
      'The selected local voice name must be at most 100 characters');
  } else {
    assert.ok(['kokoro', 'edge'].includes(pipeline.ttsEngine), 'The previous workspace needs an explicit supported narrator engine');
    assert.ok(typeof pipeline.voice === 'string' && pipeline.voice.trim() && !pipeline.voice.includes('\0'),
      'The previous workspace needs a nonempty built-in voice name');
  }
  // Pacing is an edition setting, not a pipeline setting. Copy only this numeric field for
  // editions already present in the neutral template; never inherit earlier edition content.
  const pacing = readdirSync(contained(codeRoot, 'config/editions')).filter(name => name.endsWith('.json')).flatMap(name => {
    const value = read(contained(prior, 'config/editions', name), {}).speedFactor;
    if (value === undefined) return [];
    assert.ok(value === null || typeof value === 'number' && Number.isFinite(value) && value > 0,
      `The previous ${name} narration speed must be null or a positive finite number`);
    return [{ name, value }];
  });
  const envFile = contained(prior, '.env');
  const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const provider = env.AI_CONTENT_MODEL_PROVIDER || model.provider || 'claude';
  const key = { zai: 'ZAI_API_KEY', grok: 'XAI_API_KEY', gemini: 'GEMINI_API_KEY', 'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY' }[provider];
  const allowed = new Set(['AI_CONTENT_MODEL_PROVIDER', 'AI_CONTENT_MODEL_NAME', 'AI_CONTENT_MODEL_BASE_URL', 'AI_CONTENT_MODEL_TIMEOUT_SECONDS', 'AI_CONTENT_MODEL_API_KEY', ...(key ? [key] : [])]);
  const selectedEnv = Object.entries(env).filter(([name]) => allowed.has(name)).map(([name, value]) => {
    assert.ok(!/[\r\n]/.test(value), 'Writer settings must be single-line');
    const quote = ["'", '"', '`'].find(q => !value.includes(q) && parseEnv(`${name}=${q}${value}${q}`)[name] === value);
    assert.ok(quote, 'Writer setting cannot be safely quoted');
    return `${name}=${quote}${value}${quote}`;
  });
  const root = createWorkspace(slug, false, codeRoot); // refuses an existing directory; creates new credentials
  atomicJson(contained(root, 'config/model.json'), model);
  const freshAvatar = read(contained(root, 'config/avatar.json'), {});
  freshAvatar.voiceProvider = avatar.voiceProvider;
  if (avatar.voiceProvider === 'voicebox') freshAvatar.voicebox = { profile: avatar.voicebox.profile, name: avatar.voicebox.name || '' };
  atomicJson(contained(root, 'config/avatar.json'), freshAvatar);
  if (avatar.voiceProvider === 'kokoro') {
    const freshPipeline = read(contained(root, 'config/pipeline.json'), {});
    atomicJson(contained(root, 'config/pipeline.json'), { ...freshPipeline, ttsEngine: pipeline.ttsEngine, voice: pipeline.voice });
  }
  for (const { name, value } of pacing) {
    const file = contained(root, 'config/editions', name);
    atomicJson(file, { ...read(file, {}), speedFactor: value });
  }
  if (selectedEnv.length) writeFileSync(contained(root, '.env'), selectedEnv.join('\n') + '\n', { mode: 0o600 });
  for (const path of ['state/use-case.json', 'state/journey-brief.json', 'state/onboarding.json', 'state/quick-preview.json', 'state/source-check.json', 'config/publisher.json', 'config/personalization.json', 'config/personal-profile.json', 'config/cast.json']) {
    assert.equal(existsSync(contained(root, path)), false, `Fresh beta unexpectedly contains ${path}`);
  }
  const sources = read(contained(root, 'config/sources.json'), {});
  assert.deepEqual(sources.editorial?.preferredTopics, [], 'Fresh beta must have no previous topics');
  assert.deepEqual(sources.editorial?.areas?.focusAreas, ['other'], 'Fresh beta must have neutral categories');
  const measured = retainedMeasurement(prior);
  for (const path of measured) { mkdirSync(dirname(contained(root, path)), { recursive: true }); copyFileSync(contained(prior, path), contained(root, path)); }
  atomicJson(contained(root, 'state/beta-round.json'), { createdAt: new Date().toISOString(), previousWorkspace: previous, editorialState: 'blank', retained: ['writer', 'narrator', ...(measured.length ? ['machine-measurement'] : [])] });
  return root;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [slug, previous] = process.argv.slice(2);
  if (!slug || !previous || process.argv.length !== 4) throw new Error('Usage: node --import tsx ops/prepare-beta-workspace.mjs <new-workspace> <previous-workspace>');
  prepareBetaWorkspace(slug, previous);
  console.log(JSON.stringify({ workspace: slug, editorialState: 'blank', retained: ['writer', 'narrator', ...(retainedMeasurement(workspaceRoot(CODE_ROOT, previous)).length ? ['machine-measurement'] : [])] }));
}
