import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertNarrationTranscriptQc } from './voice.js';

test('audio transcript acceptance is bound to actual bytes, script and selected narrator; warnings remain previews', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audio-qc-'));
  try {
    const text = 'The match was not cancelled.', audio = Buffer.from('exact isolated audio fixture');
    const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
    const receipt = { version: 1, status: 'pass', method: 'raw-asr-script-comparison', engine: 'kokoro', voice: 'af_heart', requestedText: text, scriptSha256: hash(text), audioSha256: hash(audio), heardWords: [{ w: 'The', start: 0, end: 1 }], blocking: [], changes: [{ requested: ['Allen'], heard: ['Alan'] }], listeningApproved: false };
    const save = (overrides = {}) => writeFileSync(join(dir, 'audio-qc.json'), JSON.stringify({ ...receipt, ...overrides }));
    writeFileSync(join(dir, 'audio.wav'), audio); save();
    assert.equal(assertNarrationTranscriptQc(dir, text, 'kokoro', 'af_heart').listeningApproved, false);
    for (const overrides of [{ status: 'hold' }, { blocking: ['missing sentence'] }, { heardWords: [] }, { scriptSha256: 'wrong' }, { audioSha256: 'wrong' }, { voice: 'af_bella' }, { engine: 'edge' }, { requestedText: 'Another script' }]) {
      save(overrides); assert.throws(() => assertNarrationTranscriptQc(dir, text, 'kokoro', 'af_heart'), /AUDIO QC HOLD/);
    }
    save(); writeFileSync(join(dir, 'audio.wav'), 'changed audio');
    assert.throws(() => assertNarrationTranscriptQc(dir, text, 'kokoro', 'af_heart'), /AUDIO QC HOLD/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
