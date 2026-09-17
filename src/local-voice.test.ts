import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalVoice, localVoices } from './local-voice.js';
import { ensureVoicebox } from './voicebox-start.js';

const health = (available: () => boolean): typeof fetch => async (url, options = {}) => {
  assert.equal(String(url), 'http://127.0.0.1:18000/health');
  assert.equal(options.redirect, 'error');
  return new Response('', { status: available() ? 200 : 503 });
};

test('Voicebox on-demand start skips the command when health is already up', async () => {
  let runs = 0;
  await ensureVoicebox({ fetcher: health(() => true), startCommand: JSON.stringify([process.execPath, '--version']), runCommand: async () => { runs++; } });
  assert.equal(runs, 0);
});

test('Voicebox on-demand start runs configured argv once and returns when health comes up', async () => {
  let available = false, runs = 0, now = 0;
  await ensureVoicebox({
    fetcher: health(() => available), startCommand: JSON.stringify([process.execPath, '--version']),
    runCommand: async (executable, args) => { assert.equal(executable, process.execPath); assert.deepEqual(args, ['--version']); runs++; available = true; },
    sleep: async ms => { now += ms; }, now: () => now,
  });
  assert.equal(runs, 1);
});

test('Voicebox reuses its managed runtime when no custom startup is configured', async () => {
  let available = false, starts = 0;
  await ensureVoicebox({ fetcher: health(() => available), startCommand: '', startManaged: async () => { starts++; available = true; } });
  assert.equal(starts, 1);
});

test('Voicebox preserves managed startup errors and points incomplete setup into the journey', async () => {
  await assert.rejects(ensureVoicebox({ fetcher: health(() => false), startCommand: '', startManaged: async () => { throw new Error('Port 18000 is occupied by another service. It has been left running.'); } }), /Port 18000 is occupied/);
  await assert.rejects(ensureVoicebox({ fetcher: health(() => false), startCommand: '', startManaged: async () => {} }), /Open the voice studio in this journey.*Prepare local Voicebox/);
});

test('Voicebox on-demand start polls for at most 150 seconds when the command never brings it up', async () => {
  let runs = 0, now = 0;
  await assert.rejects(ensureVoicebox({
    fetcher: health(() => false), startCommand: JSON.stringify([process.execPath]), runCommand: async () => { runs++; },
    sleep: async ms => { now += ms; }, now: () => now,
  }), /Open the voice studio in this journey.*Prepare local Voicebox/);
  assert.equal(runs, 1); assert.equal(now, 150000);
});

test('local voice creation protects existing identities and resumes failed uploads without a duplicate profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-voice-'));
  const profiles: any[] = [{ id: 'existing-voice', name: 'Existing voice', sample_count: 1, audio_path: '/private/sample.wav' }];
  let creates = 0, uploads = 0, failUpload = true;
  const fetcher: typeof fetch = async (url, options = {}) => {
    assert.equal(options.redirect, 'error');
    if (String(url) === 'http://127.0.0.1:18000/health') return Response.json({ status: 'ok' });
    assert.ok(String(url).startsWith('http://127.0.0.1:18000/profiles'));
    const path = new URL(String(url)).pathname, method = options.method || 'GET';
    if (path === '/profiles' && method === 'GET') return Response.json(profiles);
    if (path === '/profiles' && method === 'POST') { creates++; const profile = { id: 'new-voice', ...JSON.parse(String(options.body)), sample_count: 0 }; profiles.push(profile); return Response.json(profile); }
    if (path.endsWith('/samples')) {
      if (method === 'GET') return Response.json(profiles[1]?.sample_count ? [{ id: 'sample' }] : []);
      uploads++; assert.ok(options.body instanceof FormData); assert.equal(options.body.get('reference_text'), 'These are my recorded words.');
      if (failUpload) return Response.json({}, { status: 400 });
      profiles[1].sample_count = 1; return Response.json({ id: 'sample' });
    }
    assert.equal(path, '/profiles/new-voice'); return Response.json({ ...profiles[1], sample_count: 0 }); // as Voicebox 0.5.0 answers, sample or not
  };
  const data = { name: 'My voice', transcript: 'These are my recorded words.', audio: Buffer.alloc(144000, 1).toString('base64'), filename: 'sample.wav', consent: true, engine: 'luxtts' };
  try {
    await assert.rejects(createLocalVoice(root, { ...data, consent: false }, fetcher), /Confirm/);
    await assert.rejects(createLocalVoice(root, { ...data, audio: 'bad!' }, fetcher), /recording/);
    await assert.rejects(createLocalVoice(root, { ...data, name: 'Existing voice' }, fetcher), /already exists/);
    await assert.rejects(createLocalVoice(root, data, fetcher), /2–30-second/);
    const pending = JSON.parse(readFileSync(join(root, 'state/local-voice-creation.json'), 'utf8'));
    assert.equal(pending.id, 'new-voice'); assert.equal(pending.status, 'awaiting_sample'); assert.equal(creates, 1);
    failUpload = false; assert.equal((await createLocalVoice(root, data, fetcher)).id, 'new-voice');
    assert.equal(creates, 1); assert.equal(uploads, 2);
    assert.equal(profiles[1].default_engine, 'luxtts');
    await assert.rejects(createLocalVoice(root, { ...data, engine: 'qwen' }, fetcher), /different speech engine/);
    await createLocalVoice(root, data, fetcher); assert.equal(creates, 1); assert.equal(uploads, 2);
    await assert.rejects(createLocalVoice(root, { ...data, transcript: 'Different sample' }, fetcher), /already has a recording/);
    assert.deepEqual((await localVoices(fetcher))[0], { id: 'existing-voice', name: 'Existing voice', samples: 1, engine: 'qwen' });
    assert.doesNotMatch(readFileSync(join(root, 'state/local-voice-creation.json'), 'utf8'), /These are|AQEBAQ|audio_path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
