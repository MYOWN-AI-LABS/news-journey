"""Offline engine-selection checks: no inference, downloads, or external TTS calls."""

import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from synth_and_align import main


class LocalEngineCheck(unittest.TestCase):
    def invoke(self, directory, engine=None, voice="af_heart"):
        script = Path(directory) / "script.txt"
        script.write_text("A shareable report.")
        argv = ["synth_and_align.py", "--text-file", str(script), "--out-dir", directory,
                "--voice", voice, "--kokoro-voice", "a-different-legacy-fallback-voice"]
        if engine is not None:
            argv.extend(["--engine", engine])
        return argv, script

    def test_kokoro_failure_never_calls_edge_or_alignment(self):
        for engine in (None, "kokoro"):
            with self.subTest(engine=engine), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                argv, script = self.invoke(directory, engine)
                prior = Path(directory) / "timestamps.json"
                prior.write_text('{"historical":true}\n')
                failure = ImportError("Missing local synthesis dependency")
                kokoro = stack.enter_context(patch("synth_and_align.synth_kokoro", side_effect=failure))
                edge = stack.enter_context(patch("synth_and_align.synth_edge"))
                transcribe = stack.enter_context(patch("synth_and_align.transcribe"))
                align = stack.enter_context(patch("synth_and_align.align"))
                duration = stack.enter_context(patch("synth_and_align.wav_duration"))
                stack.enter_context(patch("sys.argv", argv))
                with self.assertRaisesRegex(RuntimeError, "refusing to switch to online Edge TTS") as caught:
                    main()
                self.assertIs(caught.exception.__cause__, failure)
                self.assertIn("--engine edge explicitly", str(caught.exception))
                kokoro.assert_called_once_with("A share-able report.", Path(directory) / "audio.wav", "af_heart")
                edge.assert_not_called()
                transcribe.assert_not_called()
                align.assert_not_called()
                duration.assert_not_called()
                self.assertEqual(prior.read_text(), '{"historical":true}\n')
                self.assertEqual(script.read_text(), "A shareable report.")
                self.assertFalse((Path(directory) / "audio.wav").exists())

    def test_explicit_edge_and_successful_kokoro_keep_the_selected_engine(self):
        cases = [("edge", "en-GB-SoniaNeural", "en-GB-SoniaNeural"),
                 ("edge", "af_heart", "en-US-AriaNeural"),
                 ("kokoro", "af_bella", "af_bella")]
        for engine, voice, selected_voice in cases:
            with self.subTest(engine=engine, voice=voice), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                argv, script = self.invoke(directory, engine, voice)
                kokoro = stack.enter_context(patch("synth_and_align.synth_kokoro", side_effect=lambda *args: (Path(directory) / "audio.wav").write_bytes(b"local fixture audio")))
                edge = stack.enter_context(patch("synth_and_align.synth_edge", side_effect=lambda *args: (Path(directory) / "audio.wav").write_bytes(b"local fixture audio")))
                heard = [{"w": word, "start": 0.0, "end": 1.0} for word in ["A", "share-able", "report."]]
                words = [{"w": "shareable", "start": 0.0, "end": 1.0}]
                transcribe = stack.enter_context(patch("synth_and_align.transcribe", return_value=heard))
                align = stack.enter_context(patch("synth_and_align.align", return_value=words))
                stack.enter_context(patch("synth_and_align.wav_duration", return_value=1.0))
                stack.enter_context(patch("sys.argv", argv))
                main()
                selected, unused = (edge, kokoro) if engine == "edge" else (kokoro, edge)
                selected.assert_called_once_with("A share-able report.", Path(directory) / "audio.wav", selected_voice)
                unused.assert_not_called()
                transcribe.assert_called_once_with(Path(directory) / "audio.wav")
                align.assert_called_once_with(["A", "shareable", "report."], heard)
                self.assertEqual(json.loads((Path(directory) / "timestamps.json").read_text()),
                                 {"durationSec": 1.0, "engine": engine, "words": words})
                self.assertEqual(script.read_text(), "A shareable report.")

    def test_configured_voice_failure_never_substitutes_kokoro_or_edge(self):
        for engine in ("voicebox", "elevenlabs", "resemble"):
            with self.subTest(engine=engine), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                argv, _ = self.invoke(directory, engine, "customer-voice")
                failure = RuntimeError("Selected customer voice unavailable")
                selected = stack.enter_context(patch("synth_and_align.synth_" + engine, side_effect=failure))
                kokoro = stack.enter_context(patch("synth_and_align.synth_kokoro"))
                edge = stack.enter_context(patch("synth_and_align.synth_edge"))
                transcribe = stack.enter_context(patch("synth_and_align.transcribe"))
                stack.enter_context(patch("sys.argv", argv))
                with self.assertRaises(RuntimeError) as caught:
                    main()
                self.assertIs(caught.exception, failure)
                selected.assert_called_once()
                self.assertEqual(selected.call_args.args[:3], ("A share-able report.", Path(directory) / "audio.wav", "customer-voice"))
                if engine == "voicebox":
                    self.assertEqual(len(selected.call_args.args[3].state["attempts"]), 1)
                kokoro.assert_not_called()
                edge.assert_not_called()
                transcribe.assert_not_called()
                self.assertFalse((Path(directory) / "timestamps.json").exists())


if __name__ == "__main__":
    unittest.main()
