"""Offline correction regression: real QC, CLI, receipts and durable reservations."""
import hashlib
import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from audio_retake import CHUNK_TAKES, WHOLE_TAKES, VoiceboxRetakes
from synth_and_align import _voicebox_chunk_take, main


def heard(text):
    return [{"w": word, "start": i / 3, "end": (i + 1) / 3} for i, word in enumerate(text.split())]


class AudioRetakeTest(unittest.TestCase):
    text = "The team did not win 12 games this season."

    def cli(self, folder, transcripts, fail_on=None, engines=None, chunk_blocks=None):
        """Mock only synthesis/ASR transport. Keep main, QC, selection and receipts real."""
        script = folder / "script.txt"
        script.write_text(self.text)
        calls = []

        def synth(text, output, voice, retakes):
            index = len(calls)
            calls.append((text, voice))
            self.assertEqual(voice, "customer-selected-voice")
            self.assertEqual(retakes.state["attempts"][-1]["status"], "reserved")
            self.assertFalse(output.exists())
            retakes.bind_runtime("exact-profile", (engines or ["luxtts"] * WHOLE_TAKES)[index])
            if fail_on == index:
                raise RuntimeError("fixture provider unavailable")
            audio = f"whole take {index + 1}".encode()
            output.write_bytes(audio)
            (folder / "voice-receipt.json").write_text(json.dumps({
                "profileId": "exact-profile", "engine": "luxtts", "generations": [f"generation-{index + 1}"],
                "audioSha256": hashlib.sha256(audio).hexdigest(),
                "chunkChecks": [{"blocking": chunk_blocks}] if chunk_blocks else [],
                "chunks": [{"wordStart": 0, "wordEnd": len(self.text.split()), "startSec": 0, "endSec": 4}],
                "listeningApproved": False,
            }))

        def transcribe(path):
            index = int(path.read_bytes().decode().rsplit(" ", 1)[1]) - 1
            return heard(transcripts[index])

        stack = ExitStack()
        stack.enter_context(patch("sys.argv", ["synth_and_align.py", "--text-file", str(script), "--out-dir", str(folder),
                                               "--engine", "voicebox", "--voice", "customer-selected-voice"]))
        stack.enter_context(patch("synth_and_align.synth_voicebox", side_effect=synth))
        asr = stack.enter_context(patch("synth_and_align.transcribe", side_effect=transcribe))
        alignment = stack.enter_context(patch("synth_and_align.align", side_effect=lambda words, raw: heard(" ".join(words))))
        stack.enter_context(patch("synth_and_align.wav_duration", return_value=4))
        for engine in ["kokoro", "edge", "elevenlabs", "resemble"]:
            stack.enter_context(patch("synth_and_align.synth_" + engine, side_effect=AssertionError("Provider substitution")))
        return stack, calls, asr, alignment

    def test_clean_chunk_is_not_regenerated_when_a_later_chunk_needs_correction(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            requested = ["The first sentence is ready.", "They scored 12 points."]
            calls = []
            transcripts = {}
            def request(text):
                calls.append(text)
                audio = f"chunk take {len(calls)}".encode()
                transcript = "They scored 21 points." if len(calls) == 2 else text
                transcripts[hashlib.sha256(audio).hexdigest()] = heard(transcript)
                return audio, f"generation-{len(calls)}"
            with patch("synth_and_align.transcribe", side_effect=lambda p: transcripts[p.stem]):
                first = _voicebox_chunk_take(requested[0], 0, request, folder, "profile", "qwen")
                second = _voicebox_chunk_take(requested[1], 1, request, folder, "profile", "qwen")
            self.assertEqual(calls, [requested[0], requested[1], requested[1]])
            self.assertEqual(first[0], b"chunk take 1")
            self.assertEqual(second[0], b"chunk take 3")
            failed = second[1]["attempts"][0]
            raw = json.loads((folder / "audio-attempts" / (failed["qcSha256"] + ".json")).read_text())
            self.assertEqual(raw["heardWords"], heard("They scored 21 points."))
            self.assertEqual(raw["generation"], "generation-2")
            self.assertTrue(raw["blocking"])

    def test_chunk_ceiling_keeps_warning_over_numeric_error_and_preserves_all_takes(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); requests = []
            def request(text):
                requests.append(text)
                return f"take-{len(requests)}".encode(), f"id-{len(requests)}"
            transcripts = [heard("Alan won 12 points in the match.")] + [heard("Allen won 21 points in the match.")] * 5
            with patch("synth_and_align.transcribe", side_effect=transcripts):
                audio, receipt = _voicebox_chunk_take("Allen won 12 points in the match.", 0, request, folder, "profile", "luxtts")
            self.assertEqual(len(requests), CHUNK_TAKES)
            self.assertEqual(audio, b"take-1")
            self.assertEqual(receipt["selectedGeneration"], "id-1")
            self.assertEqual(receipt["blocking"], [])
            self.assertTrue(receipt["changes"])
            self.assertEqual(len(list((folder / "audio-attempts").glob("*.wav"))), CHUNK_TAKES)

    def test_clean_whole_retake_stops_early_and_alignment_uses_that_exact_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            stack, calls, asr, alignment = self.cli(folder, [self.text.replace("12", "21"), self.text])
            with stack:
                main()
                self.assertEqual(len(calls), 2)
                self.assertEqual(asr.call_count, 2)
                alignment.assert_called_once()
                main()  # unchanged successful reentry does not spend a new take or ASR call
                self.assertEqual(len(calls), 2)
                self.assertEqual(asr.call_count, 2)
            qc = json.loads((folder / "audio-qc.json").read_text())
            self.assertEqual((folder / "audio.wav").read_bytes(), b"whole take 2")
            self.assertEqual(qc["heardWords"], heard(self.text))
            self.assertEqual(qc["correction"]["selectedTake"], 2)
            self.assertEqual(qc["audioSha256"], hashlib.sha256(b"whole take 2").hexdigest())
            self.assertEqual(json.loads((folder / "voice-receipt.json").read_text())["generations"], ["generation-2"])

    def test_worse_whole_takes_restore_best_audio_raw_asr_and_voice_receipt_then_hold(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); stamps = folder / "timestamps.json"; stamps.write_text('{"historical":true}')
            transcripts = [self.text.replace("12", "21"), self.text.replace("not ", "").replace("12", "21"),
                           self.text.replace("12", "13"), "They won 99 matches last year."]
            stack, calls, asr, alignment = self.cli(folder, transcripts)
            with stack:
                with self.assertRaisesRegex(RuntimeError, "AUDIO QC HOLD"): main()
                self.assertEqual(len(calls), WHOLE_TAKES)
                alignment.assert_not_called()
                with self.assertRaisesRegex(RuntimeError, "AUDIO QC HOLD"): main()
                self.assertEqual(len(calls), WHOLE_TAKES)
                self.assertEqual(asr.call_count, WHOLE_TAKES)
            qc = json.loads((folder / "audio-qc.json").read_text())
            self.assertEqual(qc["heardWords"], heard(transcripts[0]))
            self.assertEqual(qc["correction"]["reservedTakes"], WHOLE_TAKES)
            self.assertEqual(qc["correction"]["selectedTake"], 1)
            self.assertEqual((folder / "audio.wav").read_bytes(), b"whole take 1")
            self.assertEqual(json.loads((folder / "voice-receipt.json").read_text())["generations"], ["generation-1"])
            self.assertEqual(stamps.read_text(), '{"historical":true}')
            self.assertEqual(len(list((folder / "audio-attempts").glob("*.wav"))), WHOLE_TAKES)

    def test_failed_retake_keeps_previous_candidate_and_counts_the_failed_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            stack, calls, _, _ = self.cli(folder, [self.text.replace("12", "21")], fail_on=1)
            with stack, self.assertRaisesRegex(RuntimeError, "fixture provider unavailable"): main()
            self.assertEqual(len(calls), 2)
            self.assertEqual((folder / "audio.wav").read_bytes(), b"whole take 1")
            ledger = json.loads(next((folder / "audio-corrections").glob("*.json")).read_text())
            self.assertEqual([r["status"] for r in ledger["attempts"]], ["complete", "failed"])
            self.assertEqual(json.loads((folder / "audio-qc.json").read_text())["heardWords"], heard(self.text.replace("12", "21")))

    def test_improved_middle_take_is_restored_after_worse_later_takes(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            warning = self.text.replace("team", "club")
            transcripts = [self.text.replace("12", "21"), warning,
                           self.text.replace("not ", ""), self.text.replace("12", "99")]
            stack, calls, _, alignment = self.cli(folder, transcripts)
            with stack:
                main()
                alignment.assert_called_once()
            self.assertEqual(len(calls), WHOLE_TAKES)
            qc = json.loads((folder / "audio-qc.json").read_text())
            self.assertEqual(qc["status"], "pass")
            self.assertEqual(qc["blocking"], [])
            self.assertTrue(qc["changes"])
            self.assertEqual(qc["heardWords"], heard(warning))
            self.assertEqual(qc["correction"]["selectedTake"], 2)
            self.assertEqual((folder / "audio.wav").read_bytes(), b"whole take 2")
            self.assertEqual(json.loads((folder / "voice-receipt.json").read_text())["generations"], ["generation-2"])

    def test_clean_whole_asr_does_not_clear_an_unresolved_selected_chunk(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            stack, calls, _, alignment = self.cli(folder, [self.text] * WHOLE_TAKES,
                chunk_blocks=[{"reason": "recognized numeric values differ", "requested": ["12"], "heard": ["21"]}])
            with stack, self.assertRaisesRegex(RuntimeError, "chunk 1: recognized numeric"):
                main()
            alignment.assert_not_called()
            self.assertEqual(len(calls), WHOLE_TAKES)
            qc = json.loads((folder / "audio-qc.json").read_text())
            self.assertEqual(qc["status"], "hold")
            self.assertEqual(qc["heardWords"], heard(self.text))
            self.assertFalse(qc["listeningApproved"])

    def test_changed_selected_engine_refuses_before_any_new_audio_is_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            stack, calls, asr, _ = self.cli(folder, [self.text.replace("12", "21")], engines=["luxtts", "qwen"])
            with stack, self.assertRaisesRegex(RuntimeError, "speech engine changed"): main()
            self.assertEqual(len(calls), 2)
            self.assertEqual(asr.call_count, 1)
            self.assertEqual((folder / "audio.wav").read_bytes(), b"whole take 1")

    def test_interrupted_reservations_cannot_reset_allowance_on_reopen(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            for i in range(WHOLE_TAKES):
                ledger = VoiceboxRetakes(folder, self.text, self.text, "voice")
                self.assertEqual(ledger.reserve(), i + 1)
            with self.assertRaisesRegex(RuntimeError, "allowance exhausted"):
                VoiceboxRetakes(folder, self.text, self.text, "voice").reserve()
            # A different explicit request has its own identity; the old allowance stays spent.
            changed = VoiceboxRetakes(folder, self.text, self.text, "other-selected-voice")
            self.assertEqual(changed.reserve(), 1)
            with self.assertRaisesRegex(RuntimeError, "profile or speech engine changed"):
                changed.bind_runtime("voice-a", "qwen"); changed.bind_runtime("voice-b", "qwen")

    def test_mutated_retained_audio_fails_before_synthesis(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            stack, calls, _, _ = self.cli(folder, [self.text])
            with stack:
                main()
                ledger = json.loads(next((folder / "audio-corrections").glob("*.json")).read_text())
                key = ledger["attempts"][0]["audio"]
                (folder / "audio-attempts" / (key + ".wav")).write_bytes(b"tampered")
                with self.assertRaisesRegex(RuntimeError, "evidence changed"): main()
                self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
