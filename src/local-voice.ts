import { createHash } from 'node:crypto';
import { atomicJson, contained, read } from './workspaces.js';
import { releaseLock } from './release-lock.js';
import { ensureVoicebox } from './voicebox-start.js';

const BASE = 'http://127.0.0.1:18000';
export async function voiceboxRequest(path: string, options: RequestInit = {}, fetcher = fetch): Promise<any> {
  // The first sample warms Voicebox's audio analyzer; a fresh install exceeded 30 seconds.
  const timeout = options.body instanceof FormData ? 120000 : 30000;
  const response = await fetcher(BASE + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    const detail = typeof error?.detail === 'string' ? error.detail.slice(0, 400) : '';
    throw new Error(`Local Voicebox returned HTTP ${response.status}.${detail ? ' ' + detail : options.body instanceof FormData ? ' Use a clear 2–30-second recording and retry.' : ' Check the local voice service and retry.'} Your existing voices are unchanged.`);
  }
  return response.json();
}
export async function localVoices(fetcher = fetch) {
  await ensureVoicebox({ fetcher });
  const profiles = await voiceboxRequest('/profiles', {}, fetcher);
  if (!Array.isArray(profiles)) throw new Error('The local voice service did not return a Voicebox profile list.');
  return profiles.slice(0, 100).map(p => ({ id: String(p.id), name: String(p.name).slice(0, 100), samples: Number(p.sample_count) || 0, engine: String(p.default_engine || p.preset_engine || 'qwen') }));
}

/** Only create an explicitly requested voice; never edit or delete an existing identity. */
export async function createLocalVoice(root: string, data: Record<string, unknown>, fetcher = fetch) {
  if (data.consent !== true) throw new Error('Confirm that this is your voice or you have permission to use it.');
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const transcript = typeof data.transcript === 'string' ? data.transcript.trim() : '';
  const engine = data.engine ?? 'qwen';
  if (!['qwen', 'luxtts'].includes(String(engine))) throw new Error('Choose Qwen or LuxTTS for this local voice.');
  if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Enter a voice name of 1–100 characters.');
  if (!transcript || transcript.length > 1000) throw new Error('Enter the exact words in your recording (up to 1,000 characters).');
  if (typeof data.audio !== 'string' || data.audio.length > 8 * 1024 * 1024 || data.audio.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.audio)) throw new Error('Choose an audio recording of 6 MB or smaller.');
  const bytes = Buffer.from(data.audio, 'base64');
  if (bytes.length < 44 || bytes.length > 6 * 1024 * 1024) throw new Error('Choose an audio recording of 6 MB or smaller.');
  const ext = String(data.filename || '').split('.').pop()?.toLowerCase();
  if (!ext || !['wav', 'mp3', 'm4a', 'ogg', 'flac', 'aac', 'webm', 'opus'].includes(ext)) throw new Error('Use a WAV, MP3, M4A, Ogg, FLAC or WebM recording.');
  const digest = createHash('sha256').update(name).update(transcript).update(bytes).digest('hex');
  const receipt = contained(root, 'state/local-voice-creation.json');
  const unlock = releaseLock(root, 'local-voice');
  try {
    await ensureVoicebox({ fetcher });
    const pending = read<any>(receipt, {});
    const profiles = await voiceboxRequest('/profiles', {}, fetcher);
    if (!Array.isArray(profiles)) throw new Error('Local Voicebox returned an unexpected profile list.');
    let profile = profiles.find(p => p.name === name);
    if (profile && (pending.id !== profile.id || pending.name !== name)) throw new Error('That voice name already exists. Choose it from Saved voices, or use a different name.');
    if (profile && (profile.default_engine || 'qwen') !== engine) throw new Error('This saved voice uses a different speech engine. Keep its engine or use a different name.');
    if (profile && !/^[a-zA-Z0-9_-]{1,100}$/.test(profile.id)) throw new Error('Local Voicebox returned an invalid profile id.');
    if (profile?.sample_count > 0) {
      if (pending.digest !== digest) throw new Error('This voice already has a recording. Choose it from Saved voices, or use a different name.');
      return { id: profile.id, name, engine, message: 'Your local voice is saved. Listen to its generated preview before approving the narration.' };
    }
    const created = !profile;
    if (!profile) profile = await voiceboxRequest('/profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, language: 'en', voice_type: 'cloned', default_engine: engine }) }, fetcher);
    if (typeof profile.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(profile.id)) throw new Error('Local Voicebox returned an invalid profile id.');
    if (created) atomicJson(receipt, { id: profile.id, name, digest, status: 'awaiting_sample' });
    const samples = await voiceboxRequest('/profiles/' + profile.id + '/samples', {}, fetcher);
    if (!Array.isArray(samples)) throw new Error('Local Voicebox returned an unexpected sample list.');
    if (samples.length && pending.digest !== digest) throw new Error('This voice already has a recording. Choose it from Saved voices, or use a different name.');
    atomicJson(receipt, { id: profile.id, name, digest, status: 'awaiting_sample' });
    if (!samples.length) {
      const form = new FormData(); form.set('file', new Blob([bytes]), 'recording.' + ext); form.set('reference_text', transcript);
      await voiceboxRequest('/profiles/' + profile.id + '/samples', { method: 'POST', body: form }, fetcher);
    }
    // Confirm from the samples list: Voicebox 0.5.0's GET /profiles/{id} reports sample_count 0 even after a successful
    // upload (its list and /samples are right), so every first voice was reported "not ready" (found by the Jordan simulation).
    const verified = await voiceboxRequest('/profiles/' + profile.id + '/samples', {}, fetcher);
    if (!Array.isArray(verified) || !verified.length) throw new Error('Your voice profile is saved, but its recording is not ready. Retry this recording.');
    atomicJson(receipt, { id: profile.id, name, digest, status: 'ready' });
    return { id: profile.id, name, engine, message: 'Your local voice is saved. Listen to its generated preview before approving the narration.' };
  } finally { unlock(); }
}
