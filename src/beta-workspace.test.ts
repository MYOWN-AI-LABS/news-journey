import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { CODE_ROOT, atomicJson, createWorkspace, localToken } from './workspaces.js';
// @ts-expect-error The local operator helper is JavaScript, with no generated declaration file.
import { prepareBetaWorkspace } from '../ops/prepare-beta-workspace.mjs';

test('new beta retains only writer and local narrator, never prior brief, branding, sources or jobs', () => {
  mkdirSync(join(CODE_ROOT, 'workdir'), { recursive: true });
  const dir = mkdtempSync(join(CODE_ROOT, 'workdir/beta-isolation-test-'));
  const previousIdentity = process.env.HARNESS_IDENTITY_FILE;
  process.env.HARNESS_IDENTITY_FILE = join(dir, 'identity.json');
  try {
    cpSync(join(CODE_ROOT, 'config'), join(dir, 'config'), { recursive: true });
    const old = createWorkspace('earlier', false, dir);
    const model = { provider: 'codex', providers: { codex: { command: 'codex' } } };
    atomicJson(join(old, 'config/model.json'), model);
    atomicJson(join(old, 'config/avatar.json'), { mode: 'avatar', voiceProvider: 'voicebox', voicebox: { profile: 'fixture-voice', name: 'Chosen voice' }, heygen: { avatarId: 'old-avatar' } });
    atomicJson(join(old, 'config/sources.json'), { enabledSources: ['rss'], editorial: { preferredTopics: ['Previous city activities'] }, rss: [{ url: 'https://example.org/old/feed' }] });
    atomicJson(join(old, 'config/publisher.json'), { publication: 'Previous city activities', name: 'Previous city activities' });
    atomicJson(join(old, 'config/personalization.json'), { tagline: 'Old slogan' });
    atomicJson(join(old, 'config/personal-profile.json'), { about: 'Old background and cities', enabled: true });
    atomicJson(join(old, 'config/cast.json'), { members: [{ name: 'Old presenter' }] });
    for (const name of ['use-case', 'journey-brief', 'onboarding', 'quick-preview', 'source-check']) atomicJson(join(old, 'state', name + '.json'), { description: 'Old cities', status: 'failed' });
    // The advisor's measurement describes the computer, not the publication: a fresh beta keeps it.
    atomicJson(join(old, 'state/model-advisor.json'), { version: 1, status: 'done', hardwareFingerprint: 'fixture-fingerprint', hardware: { cpuName: 'Fixture M' } });
    mkdirSync(join(old, 'branding')); writeFileSync(join(old, 'branding/old.svg'), 'old');
    const writerName = "chosen'\\nwriter";
    writeFileSync(join(old, '.env'), 'AI_CONTENT_MODEL_NAME=`' + writerName + '`\nAPIFY_TOKEN="private-old-service"\n');
    const oldBytes = readFileSync(join(old, 'state/quick-preview.json'));
    const fresh = prepareBetaWorkspace('fresh', 'earlier', dir);
    assert.deepEqual(JSON.parse(readFileSync(join(fresh, 'config/model.json'), 'utf8')), model);
    const voice = JSON.parse(readFileSync(join(fresh, 'config/avatar.json'), 'utf8'));
    assert.equal(voice.voicebox.profile, 'fixture-voice'); assert.equal(voice.mode, 'cards'); assert.notEqual(voice.heygen.avatarId, 'old-avatar');
    assert.doesNotMatch(readFileSync(join(fresh, '.env'), 'utf8'), /APIFY|private-old-service/);
    assert.equal(parseEnv(readFileSync(join(fresh, '.env'), 'utf8')).AI_CONTENT_MODEL_NAME, writerName, 'retained values round-trip without turning literal backslashes into newlines');
    assert.equal(existsSync(join(fresh, 'branding/old.svg')), false);
    assert.equal(existsSync(join(fresh, 'config/personal-profile.json')), false);
    assert.equal(existsSync(join(fresh, 'config/cast.json')), false);
    assert.notEqual(localToken(fresh), localToken(old));
    assert.equal(JSON.parse(readFileSync(join(fresh, 'state/model-advisor.json'), 'utf8')).hardwareFingerprint, 'fixture-fingerprint', 'the machine measurement carries over');
    assert.equal(existsSync(join(fresh, 'state/model-advisor-checks.json')), false, 'only files the prior actually has are copied');
    assert.deepEqual(JSON.parse(readFileSync(join(fresh, 'state/beta-round.json'), 'utf8')).retained, ['writer', 'narrator', 'machine-measurement']);
    assert.deepEqual(readFileSync(join(old, 'state/quick-preview.json')), oldBytes);
    assert.throws(() => prepareBetaWorkspace('fresh', 'earlier', dir), /already exists/);
  } finally {
    if (previousIdentity === undefined) delete process.env.HARNESS_IDENTITY_FILE; else process.env.HARNESS_IDENTITY_FILE = previousIdentity;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('contaminated installed templates fail before a beta directory or credential is created', () => {
  const dir = mkdtempSync(join(CODE_ROOT, 'workdir/beta-template-test-'));
  const previousIdentity = process.env.HARNESS_IDENTITY_FILE;
  const identity = join(dir, 'identity.json'); process.env.HARNESS_IDENTITY_FILE = identity;
  try {
    cpSync(join(CODE_ROOT, 'config'), join(dir, 'config'), { recursive: true });
    const prior = createWorkspace('earlier', false, dir);
    const priorBytes = readFileSync(join(prior, 'config/avatar.json'));
    const identities = readFileSync(identity);
    const reject = () => {
      assert.throws(() => prepareBetaWorkspace('fresh', 'earlier', dir), /neutral|without previous topics/);
      assert.equal(existsSync(join(dir, 'workspaces/fresh')), false);
      assert.deepEqual(readFileSync(identity), identities);
      assert.deepEqual(readFileSync(join(prior, 'config/avatar.json')), priorBytes);
      assert.deepEqual(readdirSync(join(dir, 'workspaces')), ['earlier']);
    };
    for (const name of ['publisher.json', 'personalization.json', 'personal-profile.json', 'cast.json']) {
      const file = join(dir, 'config', name);
      atomicJson(file, { previous: 'Earlier publication or personal context' });
      reject(); rmSync(file);
    }
    const dangling = join(dir, 'config/personal-profile.json');
    symlinkSync(join(dir, 'missing-profile.json'), dangling);
    reject(); rmSync(dangling);
    const sourcesFile = join(dir, 'config/sources.json'), sources = JSON.parse(readFileSync(sourcesFile, 'utf8'));
    for (const editorial of [
      { ...sources.editorial, preferredTopics: ['Old city activities'] },
      { ...sources.editorial, areas: { ...sources.editorial.areas, focusAreas: ['Old city activities'] } },
    ]) {
      atomicJson(sourcesFile, { ...sources, editorial }); reject();
    }
  } finally {
    if (previousIdentity === undefined) delete process.env.HARNESS_IDENTITY_FILE; else process.env.HARNESS_IDENTITY_FILE = previousIdentity;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh beta preserves the selected narrator and edition pacing without copying editorial settings', () => {
  for (const [engine, voice, factor] of [['kokoro', 'af_bella', 1.25], ['edge', 'en-GB-SoniaNeural', 1.25], ['edge', 'af_heart', 3]] as const) {
    const dir = mkdtempSync(join(CODE_ROOT, 'workdir/beta-narrator-test-'));
    const previousIdentity = process.env.HARNESS_IDENTITY_FILE;
    process.env.HARNESS_IDENTITY_FILE = join(dir, 'identity.json');
    try {
      cpSync(join(CODE_ROOT, 'config'), join(dir, 'config'), { recursive: true });
      const old = createWorkspace('earlier', false, dir);
      const pipelineFile = join(old, 'config/pipeline.json'), pipeline = JSON.parse(readFileSync(pipelineFile, 'utf8'));
      atomicJson(pipelineFile, { ...pipeline, ttsEngine: engine, voice, autonomy: 'automatic', newsletterUrl: 'https://old.example.org', wordBudget: { min: 1, max: 2 } });
      const editionFile = join(old, 'config/editions/daily-roundup.json');
      const edition = JSON.parse(readFileSync(editionFile, 'utf8'));
      atomicJson(editionFile, { ...edition, speedFactor: factor, spokenName: 'Old publication', prompt: 'Old city activities', wordBudget: { min: 1, max: 2 } });
      atomicJson(join(old, 'config/editions/private-edition.json'), { speedFactor: 1.7, prompt: 'Private old edition' });
      const example = join(old, 'config/editions/example-topic.json');
      atomicJson(example, { ...JSON.parse(readFileSync(example, 'utf8')), speedFactor: null });
      const oldBytes = readFileSync(editionFile);
      const fresh = prepareBetaWorkspace('fresh', 'earlier', dir);
      const selected = JSON.parse(readFileSync(join(fresh, 'config/pipeline.json'), 'utf8'));
      assert.equal(selected.ttsEngine, engine); assert.equal(selected.voice, voice);
      assert.equal(selected.autonomy, 'review'); assert.equal(selected.newsletterUrl, pipeline.newsletterUrl);
      assert.deepEqual(selected.wordBudget, pipeline.wordBudget);
      const newEdition = JSON.parse(readFileSync(join(fresh, 'config/editions/daily-roundup.json'), 'utf8'));
      assert.deepEqual(newEdition, { ...edition, speedFactor: factor });
      assert.equal(JSON.parse(readFileSync(join(fresh, 'config/editions/example-topic.json'), 'utf8')).speedFactor, null);
      assert.equal(existsSync(join(fresh, 'config/editions/private-edition.json')), false);
      assert.deepEqual(readFileSync(editionFile), oldBytes);
    } finally {
      if (previousIdentity === undefined) delete process.env.HARNESS_IDENTITY_FILE; else process.env.HARNESS_IDENTITY_FILE = previousIdentity;
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('invalid retained narrator or pacing is rejected before creating a workspace', () => {
  const dir = mkdtempSync(join(CODE_ROOT, 'workdir/beta-narrator-invalid-'));
  const previousIdentity = process.env.HARNESS_IDENTITY_FILE;
  const identity = join(dir, 'identity.json'); process.env.HARNESS_IDENTITY_FILE = identity;
  try {
    cpSync(join(CODE_ROOT, 'config'), join(dir, 'config'), { recursive: true });
    const old = createWorkspace('earlier', false, dir), identities = readFileSync(identity);
    const pipelineFile = join(old, 'config/pipeline.json'), pipeline = JSON.parse(readFileSync(pipelineFile, 'utf8'));
    const editionFile = join(old, 'config/editions/daily-roundup.json'), edition = JSON.parse(readFileSync(editionFile, 'utf8'));
    for (const change of [{ ttsEngine: 'other-provider' }, { voice: '' }, { voice: 42 }]) {
      atomicJson(pipelineFile, { ...pipeline, ...change });
      assert.throws(() => prepareBetaWorkspace('fresh', 'earlier', dir), /narrator engine|voice name/);
      assert.equal(existsSync(join(dir, 'workspaces/fresh')), false);
      assert.deepEqual(readFileSync(identity), identities);
    }
    atomicJson(pipelineFile, pipeline);
    for (const speedFactor of [0, -1, '1.25']) {
      atomicJson(editionFile, { ...edition, speedFactor });
      assert.throws(() => prepareBetaWorkspace('fresh', 'earlier', dir), /positive finite number/);
      assert.equal(existsSync(join(dir, 'workspaces/fresh')), false);
      assert.deepEqual(readFileSync(identity), identities);
    }
  } finally {
    if (previousIdentity === undefined) delete process.env.HARNESS_IDENTITY_FILE; else process.env.HARNESS_IDENTITY_FILE = previousIdentity;
    rmSync(dir, { recursive: true, force: true });
  }
});
