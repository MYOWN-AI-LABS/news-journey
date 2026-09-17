"""No-inference dependency identity controls for the tokenizer admission helper."""
import importlib.util
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("counter", Path(__file__).with_name("local-token-count.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class CounterIdentityTests(unittest.TestCase):
    def test_verified_installed_dependencies(self):
        self.assertEqual(module.verified_versions(), {"tokenizers": "0.22.2", "transformers": "5.15.0"})
    def test_changed_converter_fails_before_any_model_metadata_is_opened(self):
        with patch.object(module.importlib.metadata, "version", side_effect=lambda name: "5.15.1" if name == "transformers" else "0.22.2"), patch.object(Path, "open", side_effect=AssertionError("Metadata must not be read for an unverified converter")):
            with self.assertRaisesRegex(ValueError, "versions differ"):
                module.count({"manifest": "irrelevant", "modelRoot": "irrelevant", "digest": "0" * 64, "prompt": "Facts."})
    def test_qwen35_unicode_marks_are_kept_with_their_word(self):
        from tokenizers import Regex, pre_tokenizers
        split = pre_tokenizers.Split(Regex(module.QWEN35_PATTERN), behavior="isolated", invert=False)
        self.assertEqual([s for s, _ in split.pre_tokenize_str("தமிழ் नमस्ते")], ["தமிழ்", " नमस्ते"])
        self.assertEqual([s for s, _ in split.pre_tokenize_str("1234")], list("1234"))
    def test_image_reserve_counts_dimensions_and_rejects_unknown_or_animated_input(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / "example.png"
            Image.new("RGB", (1200, 675)).save(p)
            value = module.image_reserves([str(p)])[0]
            self.assertEqual(value["reservedTokens"], 38 * 22 * 4 + 64)
            self.assertEqual(value["sha256"], module.sha(p.read_bytes()))
            p.write_text("not an image")
            with self.assertRaises(Exception):
                module.image_reserves([str(p)])
            with self.assertRaisesRegex(ValueError, "six images"):
                module.image_reserves([str(p)] * 7)
            Image.new("RGB", (16, 16)).save(p, format="GIF")
            with self.assertRaisesRegex(ValueError, "format"):
                module.image_reserves([str(p)])

if __name__ == "__main__":
    unittest.main()
