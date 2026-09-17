#!/usr/bin/env python3
"""Tests for the dark-anomaly (black-hands / dark-blob) detector in avatar_frame_check.

Representative measurements that motivate the threshold:
  anomalous frame → near-black coverage ~0.74 per frame
  normal frame    → near-black coverage ~0.26 per frame
So DARK_ANOMALY_MAX must sit between (~0.50). These tests use synthetic images so they
run anywhere without committing video fixtures.

Run: uv run --project tts python tts/test_avatar_frame_check.py   (or via pytest)
"""
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from avatar_frame_check import DARK_ANOMALY_MAX, near_black_fraction  # noqa: E402


def _solid(rgb, size=(160, 160)):
    return Image.new("RGB", size, rgb)


def test_pure_black_is_fully_near_black():
    assert near_black_fraction(_solid((0, 0, 0))) == 1.0


def test_brand_navy_counts_as_near_black():
    # brand navy #0B0E14 = (11,14,20) — the rembg fill behind the black hands
    assert near_black_fraction(_solid((11, 14, 20))) > 0.95


def test_mid_tone_is_not_near_black():
    assert near_black_fraction(_solid((130, 130, 130))) == 0.0


def test_half_black_half_bright_is_about_half():
    img = Image.new("RGB", (100, 100), (150, 150, 150))
    for y in range(50):
        for x in range(100):
            img.putpixel((x, y), (0, 0, 0))
    assert abs(near_black_fraction(img) - 0.5) < 0.05


def test_threshold_sits_in_the_measured_gap():
    # GOOD frames ~0.26, BAD frames ~0.74 — threshold must separate them with margin.
    assert 0.40 < DARK_ANOMALY_MAX < 0.65


def test_defect_like_frame_exceeds_threshold_good_passes():
    assert near_black_fraction(_solid((5, 5, 8))) > DARK_ANOMALY_MAX      # near-black defect
    assert near_black_fraction(_solid((90, 100, 110))) < DARK_ANOMALY_MAX  # normal mid-tone


if __name__ == "__main__":
    import traceback

    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
