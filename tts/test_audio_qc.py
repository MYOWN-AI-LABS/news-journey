"""Offline raw-transcript QA: no speech, downloads, or provider calls."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from synth_and_align import audio_qc, main, normalize_for_tts, reusable_raw_transcript


def heard(text):
    return [{"w": w, "start": i / 3, "end": (i + 1) / 3} for i, w in enumerate(text.split())]


class AudioQcTest(unittest.TestCase):
    def test_minor_asr_formatting_and_number_forms(self):
        pairs = [
            ("Good morning. The report is ready!", "good morning the report is ready"),
            ("AI GPU", "A I G P U"),
            ("It cannot be approved.", "It can not be approved"),
            ("It can't be approved.", "It cannot be approved"),
            ("The rate was -3 percent.", "The rate was minus three percent"),
            ("A shareable report about real-time AI.", "A share-able report about real time A I"),
            ("The increase was 16.8 percent.", "The increase was sixteen point eight %"),
            ("There were 120 players.", "There were one hundred twenty players"),
            ("The budget was $45 million.", "The budget was forty five million dollars"),
            ("Published September 15, 2026.", "Published September fifteenth twenty twenty six"),
            ("The rate was 1.9 million.", "The rate was one point nine million"),
        ]
        for original, transcript in pairs:
            with self.subTest(original=original): self.assertEqual(audio_qc(original, heard(transcript))["status"], "pass")

    def test_explicit_grouped_digits_rejoin_but_separate_numbers_do_not(self):
        for transcript in ['More than 7 ,200 cases and over 3 ,475 deaths.', 'More than 7, 200 cases and over 3, 475 deaths.']:
            self.assertEqual(audio_qc('More than 7,200 cases and over 3,475 deaths.', heard(transcript))['status'], 'pass')
        for transcript in ['More than 7 200 cases and over 3 475 deaths.', 'More than 7 ,201 cases and over 3 ,475 deaths.', 'More than 72 cases and over 3 ,475 deaths.']:
            self.assertEqual(audio_qc('More than 7,200 cases and over 3,475 deaths.', heard(transcript))['status'], 'hold')

    def test_contextual_score_speech_keeps_original_captions_and_numeric_gates(self):
        original = 'Chiefs beat Denver 31-10. Leeds won 4-1 at home. City lost 3-0 to Arsenal. City beat United 1-0.'
        spoken = 'Chiefs beat Denver 31 to 10. Leeds won 4 to 1 at home. City lost 3 to 0 to Arsenal. City beat United 1 to 0.'
        self.assertEqual(normalize_for_tts(original), spoken)
        qc = audio_qc(original, heard(spoken))
        self.assertEqual(qc['status'], 'pass'); self.assertEqual(qc['requestedText'], original)
        for changed in [spoken.replace('31 to 10', '31 minus 10'), spoken.replace('4 to 1', '41'), spoken.replace('1 to 0', '1 to 2')]:
            self.assertEqual(audio_qc(original, heard(changed))['status'], 'hold')
        for text in ['Published 2026-09-15.', 'Rates were -3 percent.', 'Forecast 3-5 days.', 'They won by 3-5 points.', 'They won 3-5 percent.', 'They won last time. Forecast 3-5 days.', 'Risk score 3-5.', 'The team won in 2025-2026.']:
            self.assertEqual(normalize_for_tts(text), text)

    def test_hyphenated_spoken_result_pair_is_two_values(self):
        # Fresh-package journey, 2026-09-17: the writer wrote "six-four"; Whisper heard "6 -4"; the requested side summed to 10 and held.
        script = 'England lost to Argentina in the semi-final but beat France six-four for bronze.'
        self.assertEqual(audio_qc(script, heard('England lost to Argentina in the semifinal, but beat France 6 -4 for bronze.'))['status'], 'pass')
        self.assertEqual(audio_qc(script, heard('England lost to Argentina in the semifinal, but beat France 6 -3 for bronze.'))['status'], 'hold')
        self.assertEqual(audio_qc(script, heard('England lost to Argentina in the semifinal, but beat France 10 for bronze.'))['status'], 'hold')

    def test_spoken_result_pairs_are_not_added_and_nil_retains_zero(self):
        script = 'Arsenal beat Ipswich four two in the Cup. The goal in City\'s one nil win should have been disallowed.'
        transcript = 'Arsenal beat Ipswich 4 -2 in the Cup. The goal in City\'s 1 -0 win should have been disallowed.'
        self.assertEqual(normalize_for_tts(script), script)
        self.assertEqual(audio_qc(script, heard(transcript))['status'], 'pass')
        self.assertEqual(audio_qc(script, heard(script))['status'], 'pass')
        for wrong in [transcript.replace('4 -2', '6'), transcript.replace('4 -2', '4 -3'),
                      transcript.replace('1 -0', '1'), transcript.replace('1 -0', '1 -1'),
                      transcript.replace('4 -2', '4 minus 2'), transcript.replace('should have been', 'should not have been')]:
            with self.subTest(wrong=wrong): self.assertEqual(audio_qc(script, heard(wrong))['status'], 'hold')
        # Do not reinterpret number lists/ranges or a colloquial nil without score context.
        self.assertEqual(audio_qc('The balance was nil.', heard('The balance was zero.'))['status'], 'hold')
        self.assertEqual(audio_qc('They won by four two points.', heard('They won by 4 to 2 points.'))['status'], 'hold')

    def test_asr_score_punctuation_is_not_a_spoken_negative_word(self):
        original = 'Leeds won 4-1 after beating Newcastle United 4-1 at Elland Road.'
        punctuated = 'Leeds won 4 -1 after beating Newcastle United 4 - 1 at Elland Road.'
        self.assertEqual(audio_qc(original, heard(punctuated))['status'], 'pass')
        for transcript in ['Leeds won 4 minus 1 after beating Newcastle United 4 to 1 at Elland Road.', punctuated.replace('4 - 1', '4 - 2')]:
            self.assertEqual(audio_qc(original, heard(transcript))['status'], 'hold')
        for script, transcript in [('The rate was -3 percent.', 'The rate was 3 percent.'), ('The scores were 4 and -1.', 'The scores were 4 and 1.')]:
            self.assertEqual(audio_qc(script, heard(transcript))['status'], 'hold')

    def test_attributive_scores_and_cricket_keep_both_values_explicit(self):
        original = 'United recorded a 4-2 Cup win. After a 2-1 cup win, the coach spoke. England made 254-4 in the first T20.'
        spoken = 'United recorded a 4 to 2 Cup win. After a 2 to 1 cup win, the coach spoke. England made 254 runs for 4 wickets in the first T20.'
        self.assertEqual(normalize_for_tts(original), spoken)
        self.assertEqual(audio_qc(original, heard(spoken))['status'], 'pass')
        punctuated = 'United recorded a 4 -2 Cup win. After a 2 -1 cup win, the coach spoke. England made 254 -4 in the first T20.'
        self.assertEqual(audio_qc(original, heard(punctuated))['status'], 'pass')
        for wrong in [spoken.replace('for 4 wickets', 'for wickets'), spoken.replace('for 4 wickets', 'for 5 wickets'), spoken.replace('4 to 2', '4 minus 2'), spoken.replace('254 runs', '245 runs'), spoken.replace('254 runs for 4 wickets', '254 wickets for 4 runs')]:
            self.assertEqual(audio_qc(original, heard(wrong))['status'], 'hold')
        # Do not reconstruct a missing spoken four merely because "for" sounds similar.
        self.assertEqual(audio_qc('England made 254-4 in the first T20.', heard('England made 254 for in the first T20.'))['status'], 'hold')
        for untouched in ['The estimate was 3-5 days after the win.', 'England made 254-14 in the T20.', 'The number was 254-4.', 'The range was 2-4 percent.', 'England made -4 runs.']:
            self.assertEqual(normalize_for_tts(untouched), untouched)

    def test_score_before_a_lead_or_deficit_is_spoken_as_a_score(self):
        # GLM 5.2 run, 2026-09-17: "a 2-0 lead" was read raw, Whisper heard no zero, and the transcript check held.
        original = 'United squandered a 2-0 lead to lose 3-2 at home. They chased a 1-0 deficit and kept a 2-0 advantage.'
        spoken = 'United squandered a 2 to 0 lead to lose 3 to 2 at home. They chased a 1 to 0 deficit and kept a 2 to 0 advantage.'
        self.assertEqual(normalize_for_tts(original), spoken)
        self.assertEqual(audio_qc(original, heard(spoken))['status'], 'pass')
        self.assertEqual(audio_qc(original, heard(spoken.replace('2 to 0 lead', '2 -0 lead')))['status'], 'pass')
        self.assertEqual(audio_qc(original, heard(spoken.replace('2 to 0 lead', '2 minus 0 lead')))['status'], 'hold')
        self.assertEqual(audio_qc(original, heard(spoken.replace('2 to 0 lead', '2 to 1 lead')))['status'], 'hold')

    def test_asr_split_year_range_is_not_a_negation(self):
        requested = "Chelsea's best finish is fourth, in 2024-25, and the club last sold in 2025-2026."
        split = "Chelsea's best finish is fourth. In 2024 -25, and the club last sold in 2025 -2026."
        self.assertEqual(audio_qc(requested, heard(split))['status'], 'pass')
        self.assertEqual(audio_qc(requested, heard(split.replace('2024 -25', '2024 minus 25')))['status'], 'hold')
        self.assertEqual(audio_qc(requested, heard(split.replace('2024 -25', '2024 -26')))['status'], 'hold')
        # Outside a year range the punctuation hyphen still reads as the spoken minus it always did.
        self.assertEqual(audio_qc('The rate was 3 minus 2.', heard('The rate was 3 -2.'))['status'], 'pass')

    def test_cricket_knot_out_is_narrow_asr_spelling_not_lost_negation(self):
        requested = 'The batter hit 114 not out from 49 balls in the T20.'
        self.assertEqual(audio_qc(requested, heard(requested.replace('not out', 'knot out')))['status'], 'pass')
        for wrong in [requested.replace('not out', 'out'), requested.replace('114 not out', '115 knot out')]:
            self.assertEqual(audio_qc(requested, heard(wrong))['status'], 'hold')
        self.assertEqual(audio_qc('The report was not complete.', heard('The report was knot complete.'))['status'], 'hold')
        self.assertEqual(audio_qc('Pull the 4 knot out of the rope.', heard('Pull the 4 out of the rope.'))['changes'][0]['requested'], ['knot'])

    def test_counted_digit_plurals_preserve_count_and_number_kind(self):
        requested = 'The batter hit 10 fours and six sixes in the innings.'
        for transcript in ['The batter hit 10 -4s and 6 -6s in the innings.',
                           "The batter hit ten 4's and six six's in the innings."]:
            self.assertEqual(audio_qc(requested, heard(transcript))['status'], 'pass')
        for transcript in ['The batter hit 11 -4s and 6 -6s in the innings.',
                           'The batter hit 10 -6s and 6 -4s in the innings.',
                           'The batter hit fours and 6 -6s in the innings.',
                           'The batter hit 10 -4s and six in the innings.',
                           'The batter hit 10 minus 4s and 6 -6s in the innings.',
                           'The batter hit XIV and Six -Six\'s in the innings.',
                           'The batter hit 10 fors and 6 -6s in the innings.']:
            with self.subTest(transcript=transcript):
                self.assertEqual(audio_qc(requested, heard(transcript))['status'], 'hold')
        self.assertEqual(audio_qc('There were 12 ones and three zeros.', heard('There were 12 -1s and 3 -0s.'))['status'], 'pass')
        self.assertEqual(audio_qc('The offset was -4s.', heard('The offset was 4s.'))['status'], 'hold')

    def test_original_plural_take_can_recheck_without_resetting_failed_correction(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); text = 'The batter hit 10 fours and six sixes in the innings.'
            raw = b'exact original narration'; words = heard('The batter hit 10 -4s and 6 -6s in the innings.')
            (folder / 'script.txt').write_text(text); (folder / 'audio.wav').write_bytes(raw)
            original = json.dumps({'version':1,'normalizationVersion':5,'status':'hold','method':'raw-asr-script-comparison',
                'requestedText':text,'synthesisText':text,'heardWords':words,'engine':'kokoro','voice':'af_heart',
                'scriptSha256':hashlib.sha256(text.encode()).hexdigest(),'audioSha256':hashlib.sha256(raw).hexdigest(),
                'blocking':[{'reason':'recognized numeric values differ'}]}).encode()
            (folder / 'audio-qc.json').write_bytes(original)
            from kokoro_correction import correction_path
            journal = correction_path(folder,text,'af_heart'); journal.parent.mkdir()
            retained = b'{"attempts":[{"status":"failed","error":"missing numeral"}],"synthesisCallLimit":2}'
            journal.write_bytes(retained)
            argv = ['synth_and_align.py','--text-file',str(folder/'script.txt'),'--out-dir',tmp,'--engine','kokoro','--voice','af_heart']
            with patch('sys.argv',argv), patch('synth_and_align.synth_kokoro') as synth, patch('synth_and_align.transcribe') as transcribe, patch('kokoro_correction.correct_kokoro_chunks') as correct, patch('synth_and_align.align',return_value=heard(text)), patch('synth_and_align.wav_duration',return_value=5):
                main(); synth.assert_not_called(); transcribe.assert_not_called(); correct.assert_not_called()
            receipt = json.loads((folder/'audio-qc.json').read_text())
            self.assertEqual(receipt['status'],'pass');self.assertEqual(receipt['normalizationVersion'],8)
            self.assertEqual(receipt['heardWords'],words);self.assertFalse(receipt['listeningApproved'])
            self.assertEqual(journal.read_bytes(),retained);self.assertEqual((folder/'audio.wav').read_bytes(),raw)
            self.assertEqual((folder/'audio-attempts'/f'{hashlib.sha256(original).hexdigest()}.json').read_bytes(),original)

    def test_corrected_speech_rule_supersedes_the_old_correction_and_takes_fresh_narration(self):
        # GLM 5.2 run, 2026-09-17: the score rule changed how "a 2-0 lead" is spoken; the retained correction for the
        # old speech blocked the retry with "cannot restart whole narration". The script itself was unchanged.
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); text = 'United squandered a 2-0 lead to lose 3-2 at home.'; spoken = normalize_for_tts(text)
            self.assertNotEqual(spoken, text)
            raw = b'old narration'; (folder / 'script.txt').write_text(text); (folder / 'audio.wav').write_bytes(raw)
            (folder / 'audio-qc.json').write_text(json.dumps({'version':1,'normalizationVersion':7,'status':'hold','method':'raw-asr-script-comparison',
                'requestedText':text,'synthesisText':text,'heardWords':heard('United squandered a 2 lead to lose 3 2 at home.'),'engine':'kokoro','voice':'af_heart',
                'scriptSha256':hashlib.sha256(text.encode()).hexdigest(),'audioSha256':hashlib.sha256(raw).hexdigest(),'blocking':[{'reason':'recognized numeric values differ'}]}))
            from kokoro_correction import correction_path
            journal = correction_path(folder,text,'af_heart'); journal.parent.mkdir()
            old_identity = {'version':1,'engine':'kokoro','voice':'af_heart','scriptSha256':hashlib.sha256(text.encode()).hexdigest(),'synthesisSha256':hashlib.sha256(text.encode()).hexdigest()}
            journal.write_text(json.dumps({'identity':old_identity,'attempts':[{'status':'failed'}],'synthesisCallLimit':7}))
            argv = ['synth_and_align.py','--text-file',str(folder/'script.txt'),'--out-dir',tmp,'--engine','kokoro','--voice','af_heart']
            fresh = lambda _text, out, _voice: Path(out).write_bytes(b'fresh narration')
            with patch('sys.argv',argv), patch('synth_and_align.synth_kokoro',side_effect=fresh) as synth, patch('synth_and_align.transcribe',return_value=heard(spoken)), patch('synth_and_align.align',return_value=heard(text)), patch('synth_and_align.wav_duration',return_value=5):
                main(); synth.assert_called_once()
            self.assertFalse(journal.exists()); archived = list(journal.parent.glob('*.superseded-*.json')); self.assertEqual(len(archived),1)
            self.assertEqual(json.loads(archived[0].read_text())['identity'],old_identity)
            self.assertEqual(json.loads((folder/'audio-qc.json').read_text())['status'],'pass')
            # The same speech with a spent correction still cannot restart.
            journal.write_text(json.dumps({'identity':{**old_identity,'synthesisSha256':hashlib.sha256(spoken.encode()).hexdigest()},'attempts':[{'status':'failed'}],'synthesisCallLimit':7}))
            (folder / 'audio.wav').write_bytes(b'changed audio')
            with patch('sys.argv',argv), patch('synth_and_align.synth_kokoro') as synth, patch('synth_and_align.transcribe',return_value=heard(spoken)):
                with self.assertRaises(RuntimeError): main()
                synth.assert_not_called()

    def test_reuses_only_identical_bound_raw_audio_and_preserves_original_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); text = 'There were 7,200 cases.'; script = folder / 'script.txt'; script.write_text(text)
            wav = folder / 'audio.wav'; raw = b'bound mocked original wav'; wav.write_bytes(raw)
            words = heard('There were 7 ,200 cases.')
            old = {'version': 1, 'status':'hold', 'method':'raw-asr-script-comparison', 'requestedText':text, 'synthesisText':text, 'heardWords':words, 'engine':'kokoro', 'voice':'af_heart', 'scriptSha256':hashlib.sha256(text.encode()).hexdigest(), 'audioSha256':hashlib.sha256(raw).hexdigest(), 'blocking':[{'reason':'recognized numeric values differ'}]}
            receipt = folder / 'audio-qc.json'; original = json.dumps(old).encode(); receipt.write_bytes(original)
            argv = ['synth_and_align.py', '--text-file', str(script), '--out-dir', tmp, '--engine','kokoro','--voice','af_heart']
            with patch('sys.argv',argv), patch('synth_and_align.synth_kokoro') as synth, patch('synth_and_align.transcribe') as transcribe, patch('synth_and_align.align',return_value=heard(text)) as align, patch('synth_and_align.wav_duration',return_value=3):
                main(); synth.assert_not_called(); transcribe.assert_not_called(); align.assert_called_once()
            current = json.loads(receipt.read_text())
            self.assertEqual(current['status'],'pass'); self.assertEqual(current['heardWords'],words)
            self.assertEqual(current['reusedRawTranscriptReceiptSha256'],hashlib.sha256(original).hexdigest())
            self.assertEqual((folder/'audio-attempts'/f'{hashlib.sha256(original).hexdigest()}.json').read_bytes(),original)
            self.assertEqual((folder/'audio-attempts'/f'{hashlib.sha256(raw).hexdigest()}.wav').read_bytes(),raw)
            self.assertEqual(wav.read_bytes(),raw)
            receipt.write_text(json.dumps({**old,'postProcessing':{'speedFactor':1,'audioSha256':hashlib.sha256(raw).hexdigest()}}))
            self.assertIsNotNone(reusable_raw_transcript(folder,text,'kokoro','af_heart'),'a recorded no-op pacing step must not buy another synthesis')
            for field, value in [('voice','other'),('scriptSha256','changed'),('audioSha256','changed'),('synthesisText','changed'),('postProcessing',{'speedFactor':1.25}),('heardWords',[{'w':'x','start':float('nan'),'end':1}])]:
                receipt.write_text(json.dumps({**old,field:value}))
                self.assertIsNone(reusable_raw_transcript(folder,text,'kokoro','af_heart'))
            # A fixed score must be synthesized with the changed speech input, not grandfathered.
            score = 'Chiefs beat Denver 31-10.'
            receipt.write_text(json.dumps({**old,'requestedText':score,'synthesisText':score,'scriptSha256':hashlib.sha256(score.encode()).hexdigest()}))
            self.assertIsNone(reusable_raw_transcript(folder,score,'kokoro','af_heart'))

    def test_changed_values_and_negation_are_not_spelling_tolerance(self):
        for original, transcript in [
            ("The rate was 1.9 percent.", "The rate was 19 percent"),
            ("The rate was -3 percent.", "The rate was three percent"),
            ("The increase was 16.8 percent.", "The increase was 61.8 percent"),
            ("There were 120 players.", "There were twelve players"),
            ("It was not approved.", "It was approved"),
            ("The vote was September 15.", "The vote was September 16"),
        ]:
            with self.subTest(original=original): self.assertEqual(audio_qc(original, heard(transcript))["status"], "hold")

    def test_fresh_synthesis_cannot_mistake_an_old_take_for_new_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); script = folder / 'script.txt'; text = 'City beat United 1-0.'
            script.write_text(text); wav = folder / 'audio.wav'; old = b'old take'; wav.write_bytes(old)
            def synth(speech, output, voice):
                self.assertEqual(speech, 'City beat United 1 to 0.')
                self.assertFalse(output.exists(), 'old take must be archived and removed before synthesis')
                output.write_bytes(b'new take')
            argv = ['synth_and_align.py', '--text-file', str(script), '--out-dir', tmp, '--engine', 'kokoro', '--voice', 'af_heart']
            with patch('sys.argv', argv), patch('synth_and_align.synth_kokoro', side_effect=synth), patch('synth_and_align.transcribe', return_value=heard('City beat United 1 to 0.')), patch('synth_and_align.align', return_value=heard(text)), patch('synth_and_align.wav_duration', return_value=3):
                main()
            self.assertEqual(wav.read_bytes(), b'new take')
            self.assertEqual((folder / 'audio-attempts' / f'{hashlib.sha256(old).hexdigest()}.wav').read_bytes(), old)

    def test_measurement_and_currency_units_must_match_their_number(self):
        for original, transcript in [
            ('Waves reached 2.5 metres.', 'Waves reached 2.5 meters.'),
            ('The budget was $45 million.', 'The budget was forty five million dollars.'),
            ('The rate was 3 percent.', 'The rate was three %.'),
        ]:
            self.assertEqual(audio_qc(original, heard(transcript))['status'], 'pass')
        for original, transcript in [
            ('Waves reached 2.5 metres.', 'Waves reached 2.5 miles.'),
            ('The budget was $45 million.', 'The budget was forty five million euros.'),
            ('The rate was 3 percent.', 'The rate was three.'),
            ('The distance was 2 miles then 3 yards.', 'The distance was 2 yards then 3 miles.'),
        ]:
            qc = audio_qc(original, heard(transcript))
            self.assertEqual(qc['status'], 'hold')
            self.assertIn('recognized measurement or currency units differ', [f['reason'] for f in qc['blocking']])

    def test_missing_sentence_and_empty_audio_hold(self):
        original = "The game begins Saturday. Registration closes on Friday. Bring your ticket."
        for transcript in ["The game begins Saturday. Bring your ticket.", ""]:
            result = audio_qc(original, heard(transcript))
            self.assertEqual(result["status"], "hold")
            self.assertFalse(result["listeningApproved"])

    def test_name_spelling_difference_warns_without_false_rejection(self):
        result = audio_qc("Allen reported the result from the game today.", heard("Alan reported the result from the game today"))
        self.assertEqual(result["status"], "pass")
        self.assertTrue(result["changes"])
        self.assertFalse(result["listeningApproved"])

    def test_actual_cli_retains_raw_audio_and_stops_before_forced_alignment(self):
        for transcript, success in [("The match was not cancelled.", True), ("The match was cancelled.", False)]:
            with self.subTest(success=success), tempfile.TemporaryDirectory() as tmp:
                folder = Path(tmp); script = folder / 'script.txt'; script.write_text('The match was not cancelled.')
                wav = folder / 'audio.wav'; stamps = folder / 'timestamps.json'; stamps.write_text('{"prior":true}')
                argv = ['synth_and_align.py', '--text-file', str(script), '--out-dir', tmp, '--engine', 'kokoro', '--voice', 'af_heart']
                raw = b'private exact mocked audio bytes'
                with patch('sys.argv', argv), patch('synth_and_align.synth_kokoro', side_effect=lambda text, output, voice: output.write_bytes(raw)) as synth, patch('synth_and_align.synth_edge') as edge, patch('synth_and_align.transcribe', return_value=heard(transcript)), patch('synth_and_align.align', return_value=heard(script.read_text())) as align, patch('synth_and_align.wav_duration', return_value=3):
                    if success: main(); align.assert_called_once()
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'AUDIO QC HOLD'): main()
                        align.assert_not_called(); self.assertEqual(json.loads(stamps.read_text()), {"prior":True})
                    self.assertEqual(synth.call_count, 1 if success else 2); edge.assert_not_called()
                receipt = json.loads((folder/'audio-qc.json').read_text())
                self.assertEqual(receipt['audioSha256'], hashlib.sha256(raw).hexdigest())
                self.assertEqual(receipt['scriptSha256'], hashlib.sha256(script.read_bytes()).hexdigest())
                self.assertEqual(receipt['heardWords'], heard(transcript))
                self.assertEqual(receipt['voice'], 'af_heart'); self.assertEqual(wav.read_bytes(), raw)


if __name__ == '__main__': unittest.main()
