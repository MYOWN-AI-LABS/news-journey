"""Offline check: actual speech payloads, original captions, WAV receipt and failure holds."""
import io
import json
import tempfile
import unittest
import wave
import numpy as np
from voicebox_audio import sentence_chunks, prepare_pcm, join_chunks, constrain_to_chunks
from pathlib import Path
from unittest.mock import patch
from synth_and_align import main, synth_voicebox

class LocalVoiceCheck(unittest.TestCase):
    def test_receipt_and_failure_hold(self):
        audio = io.BytesIO()
        with wave.open(audio, 'wb') as wav:
            wav.setnchannels(2); wav.setsampwidth(2); wav.setframerate(48000); wav.writeframes(np.tile((np.sin(np.arange(4800) * 0.1) * 10000).astype('<i2')[:,None],(1,2)).tobytes())
        class Opener:
            def __init__(self, status): self.status = status; self.calls = []; self.speech = []
            def open(self, request, timeout):
                url = request if isinstance(request, str) else request.full_url
                self.calls.append(url)
                assert url.startswith('http://127.0.0.1:18000/')
                if url.endswith('/profiles'): return io.BytesIO(b'[{"id":"my-profile","name":"My own voice","default_engine":"luxtts"}]')
                if url.endswith('/speak'):
                    assert json.loads(request.data)['profile'] == 'my-profile'
                    assert json.loads(request.data)['engine'] == 'luxtts'
                    assert json.loads(request.data)['personality'] is False
                    self.speech.append(json.loads(request.data)['text'])
                    return io.BytesIO(b'{"id":"generation-1"}')
                if url.endswith('/status'): return io.BytesIO(('data: '+json.dumps({'status':self.status})+'\n').encode())
                return io.BytesIO(audio.getvalue())
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)/'voice.wav'; opener = Opener('completed')
            original = 'The page must be live. It is live. We checked live. Live verification passed. Find it live under this URL. I live in Florida. I live under that bridge. Families live under strict rules.'
            spoken = 'The page must go live. It is lyve. We checked lyve. lyve verification passed. Find it lyve under this URL. I live in Florida. I live under that bridge. Families live under strict rules.'
            def transcript(path):
                # Each chunk and the assembled narration have different raw ASR inputs.
                words = spoken if path.name == 'audio.wav' else opener.speech[-1]
                return [{'w': word, 'start': i * .001, 'end': (i + 1) * .001} for i, word in enumerate(words.split())]
            with patch('synth_and_align.ensure_voicebox') as ensure, patch('urllib.request.build_opener', return_value=opener), patch('synth_and_align.transcribe', side_effect=transcript): synth_voicebox(original,target,'My own voice')
            ensure.assert_called_once_with()
            self.assertEqual(opener.speech, sentence_chunks(spoken))
            self.assertEqual(len(original.split()), len(spoken.split()))
            with wave.open(str(target)) as wav: self.assertEqual(wav.getnframes(),2400 * len(sentence_chunks(spoken)) + 15600 * (len(sentence_chunks(spoken)) - 1)); self.assertEqual(wav.getnchannels(),1); self.assertEqual(wav.getframerate(),24000)
            receipt = json.loads((Path(tmp)/'voice-receipt.json').read_text())
            self.assertEqual(receipt['engine'], 'luxtts'); self.assertFalse(receipt['listeningApproved'])
            script = Path(tmp)/'script.txt'; script.write_text(original)
            with patch('synth_and_align.ensure_voicebox') as ensure, patch('urllib.request.build_opener', return_value=opener), patch('synth_and_align.transcribe', side_effect=transcript), patch('sys.argv', ['synth_and_align.py', '--text-file', str(script), '--out-dir', tmp, '--engine', 'voicebox', '--voice', 'My own voice']):
                main()
            ensure.assert_called_once_with()
            # The CLI normalizes before calling the shared function: both paths must agree.
            self.assertEqual(opener.speech, sentence_chunks(spoken) * 2)
            self.assertEqual(script.read_text(), original)
            self.assertEqual([w['w'] for w in json.loads((Path(tmp)/'timestamps.json').read_text())['words']], original.split())
            target.unlink(); opener = Opener('failed')
            with patch('synth_and_align.ensure_voicebox') as ensure, patch('urllib.request.build_opener', return_value=opener), self.assertRaisesRegex(RuntimeError,'hold the draft'):
                synth_voicebox('A short narration.',target,'My own voice')
            ensure.assert_called_once_with()
            self.assertFalse(target.exists()); self.assertEqual(len(opener.calls),3)
            with self.assertRaisesRegex(RuntimeError,'Choose your own'): synth_voicebox('Text',target,'')

    def test_levels_and_quiet_boundaries(self):
        wave = np.sin(np.arange(24000) * 0.1)
        quiet = prepare_pcm((wave * 1000).astype('<i2').tobytes(), 1, 24000)
        loud = prepare_pcm((wave * 20000).astype('<i2').tobytes(), 1, 24000)
        self.assertAlmostEqual(float(np.sqrt(np.mean(quiet**2))), 0.075, places=3)
        self.assertAlmostEqual(float(np.sqrt(np.mean(loud**2))), 0.075, places=3)
        self.assertEqual(quiet[0], 0); self.assertEqual(quiet[-1], 0)
        self.assertLessEqual(float(np.abs(loud).max()), 0.95)
        with self.assertRaisesRegex(RuntimeError, 'silence'): prepare_pcm(bytes(400), 1, 24000)

    def test_sentence_pause_and_it_onset(self):
        # A soft onset must survive joining; alignment must not move It into the pause.
        tone = np.ones(24000, dtype=np.float32) * .05
        pcm, spans = join_chunks([tone, tone * .1], ['muscular atrophy.', 'It is approved.'], 24000)
        self.assertTrue(np.all(pcm[24000:39600] == 0))
        self.assertTrue(np.array_equal(pcm[39600:], tone * .1))
        words = [{'w': w, 'start': start, 'end': end} for w, start, end in [
            ('muscular', 0, .5), ('atrophy.', .5, 1.4), ('It', 1.0, 1.8), ('is', 1.8, 2), ('approved.', 2, 3)]]
        aligned = constrain_to_chunks(words, spans)
        self.assertEqual(aligned[1]['end'], 1)
        self.assertEqual(aligned[2]['start'], 1.65)
        self.assertEqual(aligned[-1]['end'], 2.65)
        self.assertEqual([w['w'] for w in aligned], [w['w'] for w in words])
        self.assertEqual(words[2]['start'], 1)  # no mutation of the original evidence
        with self.assertRaisesRegex(RuntimeError, 'cover the script'): constrain_to_chunks(words[:-1], spans)

if __name__ == '__main__': unittest.main()
