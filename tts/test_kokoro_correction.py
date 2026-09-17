"""Offline control-flow coverage; real raw-QA rules, no TTS/ASR downloads or calls."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from kokoro_correction import correct_kokoro_chunks, correction_path
from synth_and_align import audio_qc, main


def words(text):
    return [{"w": word, "start": i / 3, "end": (i + 1) / 3} for i, word in enumerate(text.split())]


class KokoroCorrectionTest(unittest.TestCase):
    text = 'The total was 254 runs for 4 wickets. The match was not cancelled.'
    chunks = ['The total was 254 runs for 4 wickets.', 'The match was not cancelled.']

    def seed(self, folder):
        raw = b'The total was 254 runs for wickets. The match was not cancelled.'
        (folder / 'audio.wav').write_bytes(raw)
        qc = audio_qc(self.text, words(raw.decode()))
        qc.update(engine='kokoro', voice='af_heart', audioSha256=hashlib.sha256(raw).hexdigest(), scriptSha256=hashlib.sha256(self.text.encode()).hexdigest())
        (folder / 'audio-qc.json').write_text(json.dumps(qc))
        return raw

    def run_correction(self, folder, transforms=None, join_transform=None):
        calls = []
        def synth(text, path, voice):
            self.assertEqual(voice, 'af_heart'); calls.append(text)
            state = json.loads(correction_path(folder, self.text, voice).read_text())
            self.assertEqual(state['attempts'][-1]['status'], 'reserved')
            output = (transforms or {}).get(text, text)
            if isinstance(output, Exception): raise output
            path.write_text(output)
        def concatenate(parts, path):
            text = b' '.join(parts).decode()
            path.write_text(join_transform(text) if join_transform else text)
        try:
            result = correct_kokoro_chunks(folder, self.text, self.text, 'af_heart', self.chunks,
                synth, lambda path: words(path.read_text()), audio_qc, concatenate)
        except Exception:
            self.calls = calls
            raise
        self.calls = calls
        return result

    def test_exact_chunks_pass_full_raw_qa_and_reentry_never_synthesizes_again(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); original = self.seed(folder)
            qc = self.run_correction(folder)
            self.assertEqual(qc['status'], 'pass'); self.assertEqual(self.calls, self.chunks)
            self.assertFalse(qc['listeningApproved'])
            self.assertEqual(qc['audioSha256'], hashlib.sha256((folder / 'audio.wav').read_bytes()).hexdigest())
            self.assertEqual((folder / 'audio-attempts' / (hashlib.sha256(original).hexdigest() + '.wav')).read_bytes(), original)
            self.assertEqual(qc['correction']['synthesisCallLimit'], 3)
            self.assertEqual(self.run_correction(folder), qc); self.assertEqual(self.calls, [])

    def test_failed_second_chunk_retains_first_and_original_and_cannot_refill(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); original = self.seed(folder)
            with self.assertRaisesRegex(RuntimeError, 'sentence correction still differs'):
                self.run_correction(folder, {self.chunks[1]: 'The match was cancelled.'})
            self.assertEqual((folder / 'audio.wav').read_bytes(), original)
            state = json.loads(correction_path(folder, self.text, 'af_heart').read_text())
            self.assertEqual([a['status'] for a in state['attempts']], ['complete', 'failed'])
            with self.assertRaisesRegex(RuntimeError, 'request remains spent'): self.run_correction(folder)
            self.assertEqual(self.calls, [])

    def test_synthesis_failure_is_spent_without_replacing_prior_narration(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); original = self.seed(folder)
            with self.assertRaisesRegex(RuntimeError, 'local failure'):
                self.run_correction(folder, {self.chunks[0]: RuntimeError('local failure')})
            self.assertEqual((folder / 'audio.wav').read_bytes(), original)
            with self.assertRaisesRegex(RuntimeError, 'request remains spent'): self.run_correction(folder)
            self.assertEqual(self.calls, [])

    def test_joined_audio_is_independently_checked_and_missing_number_still_holds(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); self.seed(folder)
            qc = self.run_correction(folder, join_transform=lambda s: s.replace('4 wickets', 'wickets'))
            self.assertEqual(qc['status'], 'hold')
            self.assertIn('recognized numeric values differ', [f['reason'] for f in qc['blocking']])
            self.assertEqual(self.run_correction(folder)['status'], 'hold'); self.assertEqual(self.calls, [])

    def test_changed_synthesis_or_tampered_audio_holds_without_more_requests(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); self.seed(folder); self.run_correction(folder)
            with self.assertRaisesRegex(RuntimeError, 'identity or allowance changed'):
                correct_kokoro_chunks(folder, self.text, self.text + ' Changed.', 'af_heart', self.chunks + ['Changed.'],
                                     None, None, None, None)
            state = json.loads(correction_path(folder, self.text, 'af_heart').read_text())
            (folder / 'audio-attempts' / (state['final']['audio'] + '.wav')).write_bytes(b'tampered')
            with self.assertRaisesRegex(RuntimeError, 'audio changed'): self.run_correction(folder)
            self.assertEqual(self.calls, [])

    def test_real_entrypoint_uses_correction_then_aligns_only_checked_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); self.seed(folder)
            (folder / 'script.txt').write_text(self.text)
            argv = ['synth_and_align.py', '--text-file', str(folder / 'script.txt'), '--out-dir', tmp, '--engine', 'kokoro', '--voice', 'af_heart']
            def synth(text, path, voice): path.write_text(text)
            def join(parts, path): path.write_bytes(b' '.join(parts))
            with patch('sys.argv', argv), patch('synth_and_align.synth_kokoro', side_effect=synth) as generated, patch('synth_and_align.transcribe', side_effect=lambda p: words(p.read_text())), patch('synth_and_align.concatenate_local_chunks',side_effect=join), patch('synth_and_align.align',return_value=words(self.text)) as align, patch('synth_and_align.wav_duration',return_value=6):
                main(); align.assert_called_once()
                self.assertEqual(generated.call_count, 1, 'short complete script is one smaller-scope sentence group')
            self.assertEqual(json.loads((folder / 'audio-qc.json').read_text())['status'], 'pass')
            self.assertEqual(json.loads((folder / 'timestamps.json').read_text())['engine'], 'kokoro')

    def test_cli_legacy_hold_adopts_original_once_and_failed_correction_never_repeats(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); original = self.seed(folder)
            (folder / 'script.txt').write_text(self.text)
            argv = ['synth_and_align.py', '--text-file', str(folder / 'script.txt'), '--out-dir', tmp, '--engine', 'kokoro', '--voice', 'af_heart']
            def synth(text, path, voice): path.write_bytes(original)
            with patch('sys.argv', argv), patch('synth_and_align.synth_kokoro', side_effect=synth) as generated, patch('synth_and_align.transcribe', side_effect=lambda p: words(p.read_text())) as asr, patch('synth_and_align.align') as align:
                with self.assertRaisesRegex(RuntimeError, 'AUDIO QC HOLD'): main()
                self.assertEqual(generated.call_count, 1); self.assertEqual(asr.call_count, 1)
                with self.assertRaisesRegex(RuntimeError, 'request remains spent'): main()
                self.assertEqual(generated.call_count, 1); self.assertEqual(asr.call_count, 1); align.assert_not_called()
            self.assertEqual((folder / 'audio.wav').read_bytes(), original)
            state = json.loads(correction_path(folder, self.text, 'af_heart').read_text())
            self.assertEqual(len(state['attempts']), 1)
            self.assertEqual(state['originalTake']['audio'], hashlib.sha256(original).hexdigest())

    def test_saved_qa_tampering_and_changed_synthesis_cannot_restart_whole_narration(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); self.seed(folder); self.run_correction(folder)
            state = json.loads(correction_path(folder, self.text, 'af_heart').read_text())
            qc_path = folder / 'audio-attempts' / (state['final']['qcSha256'] + '.json')
            qc_path.write_text('{}')
            with self.assertRaisesRegex(RuntimeError, 'QA changed'): self.run_correction(folder)
            # The real entry point also refuses a new full synthesis if its saved
            # correction no longer has reusable raw evidence.
            (folder / 'script.txt').write_text(self.text)
            (folder / 'audio-qc.json').write_text('{}')
            argv = ['synth_and_align.py', '--text-file', str(folder / 'script.txt'), '--out-dir', tmp, '--engine', 'kokoro', '--voice', 'af_heart']
            with patch('sys.argv', argv), patch('synth_and_align.synth_kokoro') as synth:
                with self.assertRaisesRegex(RuntimeError, 'cannot restart whole narration'): main()
                synth.assert_not_called()

    def test_versioned_raw_asr_recheck_retains_failed_history_without_repeating_chunk(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            self.text = 'The batter hit 114 not out from 49 balls. The match was not cancelled.'
            self.chunks = ['The batter hit 114 not out from 49 balls.', 'The match was not cancelled.']
            self.seed(folder)
            generated = []
            def synth(text, path, voice):
                generated.append(text); path.write_text(text.replace('not out', 'knot out'))
            def old_compare(text, raw):
                qc = audio_qc(text, raw); qc['normalizationVersion'] = 4
                if any(word['w'] == 'knot' for word in raw):
                    qc.update(status='hold',blocking=[{'reason':'negation differs in the recognized transcript'}])
                return qc
            with self.assertRaisesRegex(RuntimeError, 'AUDIO QC HOLD'):
                correct_kokoro_chunks(folder,self.text,self.text,'af_heart',self.chunks,synth,
                    lambda p:words(p.read_text()),old_compare,lambda parts,p:p.write_bytes(b' '.join(parts)))
            path = correction_path(folder,self.text,'af_heart')
            failed = json.loads(path.read_text())['attempts'][0]
            raw_old = (folder/'audio-attempts'/(failed['qcSha256']+'.json')).read_bytes()
            qc = self.run_correction(folder)
            self.assertEqual(qc['status'],'pass'); self.assertEqual(self.calls,[self.chunks[1]])
            row = json.loads(path.read_text())['attempts'][0]
            self.assertEqual(row['status'],'failed'); self.assertEqual(row['qcSha256'],failed['qcSha256'])
            self.assertEqual(len(row['rechecks']),1); self.assertEqual(row['rechecks'][0]['previousQcSha256'],failed['qcSha256'])
            self.assertEqual((folder/'audio-attempts'/(failed['qcSha256']+'.json')).read_bytes(),raw_old)


if __name__ == '__main__': unittest.main()
