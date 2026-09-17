#!/usr/bin/env python3
"""Mechanical lip-sync / avatar QC — the DETERMINISTIC tier of avatar validation.

Catches the gross failure modes a bad Hedra/HeyGen generation can ship:
  1. file too small / missing      → generation failed
  2. avatar duration != audio dur  → A/V desync (the whole clip drifts)
  3. frozen / static face          → the model produced a still, no lip motion
  4. dark-blob / black hands       → a bad source (e.g. the rembg-navy portrait) makes the
                                     model render limbs/hands as black blobs on a near-black bg

Perceptual lip-sync ACCURACY (mouth shape vs phoneme timing) is a judgment call and
lives in the avatar-qc subagent (vision frames). This script is the cheap, fast,
blocking gate. Writes <dir>/avatar-qc.json and exits 1 on fail, 0 on pass.

Run: uv run --project tts python tts/avatar_frame_check.py --avatar X --timestamps Y --out Z
"""
import argparse, json, os, subprocess, sys, tempfile
from statistics import median
from imageio_ffmpeg import get_ffmpeg_exe

SIZE_MIN = 200_000          # bytes — below this the download/gen clearly failed
DUR_TOLERANCE = 0.75        # seconds — |avatar - audio| beyond this = desync
FROZEN_MIN_DIFF = 3.0       # median per-pixel frame delta (0-255); below = frozen face
NB_LEVEL = 24               # max(R,G,B) below this = a "near-black" pixel
DARK_ANOMALY_MAX = 0.50     # median near-black coverage above this indicates a dark-frame anomaly


def video_duration(path: str) -> float | None:
    """Read duration through the FFmpeg binary bundled with Remotion."""
    try:
        import re
        err = subprocess.run([get_ffmpeg_exe(), "-i", path],
                             capture_output=True, text=True, timeout=120).stderr
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", err)
        if not m:
            return None
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    except Exception:
        return None


def frozen_score(avatar: str) -> float | None:
    """Extract 1 frame/sec and return the MEDIAN mean-abs pixel delta between
    consecutive frames. A frozen face ~0; a talking head is well above FROZEN_MIN_DIFF."""
    try:
        from PIL import Image, ImageChops, ImageStat
    except Exception:
        return None  # Pillow missing → skip (don't false-fail)
    with tempfile.TemporaryDirectory() as td:
        r = subprocess.run([get_ffmpeg_exe(), "-y", "-i", avatar, "-r", "1",
                            "-f", "image2", os.path.join(td, "f%03d.jpg")],
                           capture_output=True, text=True, timeout=180)
        frames = sorted(f for f in os.listdir(td) if f.endswith(".jpg"))
        if r.returncode != 0 or len(frames) < 3:
            return None  # too short (intro clip) or extraction failed → skip
        diffs = []
        prev = None
        for f in frames:
            img = Image.open(os.path.join(td, f)).convert("L").resize((160, 90))
            if prev is not None:
                diffs.append(ImageStat.Stat(ImageChops.difference(prev, img)).mean[0])
            prev = img
        return round(median(diffs), 3) if diffs else None


def near_black_fraction(img) -> float:
    """Fraction of (sub-sampled) pixels that are near-black (max channel < NB_LEVEL).
    A dark-blob / black-hands avatar (the rembg-navy source) runs ~0.74; a normal
    on-stage avatar ~0.26. Pure function over a PIL image so it's unit-testable."""
    img = img.convert("RGB")
    w, h = img.size
    step = max(1, w // 200)  # sub-sample wide frames for speed
    px = img.load()
    near = total = 0
    for y in range(0, h, step):
        for x in range(0, w, step):
            r, g, b = px[x, y]
            total += 1
            if max(r, g, b) < NB_LEVEL:
                near += 1
    return near / total if total else 0.0


def dark_anomaly_score(avatar: str) -> float | None:
    """Median near-black coverage across 1-fps frames. High = the model rendered
    limbs/hands as black blobs on a near-black bg (bad source). None if frames can't be
    extracted or Pillow is missing → skip (don't false-fail), same policy as frozen_score."""
    try:
        from PIL import Image
    except Exception:
        return None
    with tempfile.TemporaryDirectory() as td:
        r = subprocess.run([get_ffmpeg_exe(), "-y", "-i", avatar, "-r", "1",
                            "-f", "image2", os.path.join(td, "d%03d.jpg")],
                           capture_output=True, text=True, timeout=180)
        frames = sorted(f for f in os.listdir(td) if f.endswith(".jpg"))
        if r.returncode != 0 or not frames:
            return None
        fracs = [near_black_fraction(Image.open(os.path.join(td, f))) for f in frames]
        return round(median(fracs), 3) if fracs else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--avatar", required=True)
    ap.add_argument("--timestamps", required=True)
    ap.add_argument("--out", required=True)
    # Expected avatar length: for an INTRO-mode avatar (capped to N sec) the avatar is
    # deliberately shorter than the full audio — pass that N here so duration parity is
    # checked against the avatar's intended length, not the whole narration.
    ap.add_argument("--expected-dur", type=float, default=None)
    a = ap.parse_args()

    reasons: list[str] = []

    size_ok = os.path.exists(a.avatar) and os.path.getsize(a.avatar) >= SIZE_MIN
    if not size_ok:
        reasons.append(f"avatar.mp4 missing or < {SIZE_MIN} bytes")

    audio_dur = None
    try:
        audio_dur = float(json.load(open(a.timestamps)).get("durationSec"))
    except Exception:
        reasons.append("could not read timestamps.durationSec")
    avatar_dur = video_duration(a.avatar) if size_ok else None
    # Compare against the avatar's INTENDED length: --expected-dur (intro cap) if given, else full audio.
    expected_dur = a.expected_dur if a.expected_dur else audio_dur
    dur_delta = abs(avatar_dur - expected_dur) if (avatar_dur and expected_dur) else None
    dur_ok = dur_delta is not None and dur_delta <= DUR_TOLERANCE
    if dur_delta is not None and not dur_ok:
        reasons.append(f"A/V desync: avatar {avatar_dur:.2f}s vs expected {expected_dur:.2f}s (Δ{dur_delta:.2f}s > {DUR_TOLERANCE}s)")

    fscore = frozen_score(a.avatar) if size_ok else None
    frozen = fscore is not None and fscore < FROZEN_MIN_DIFF
    if frozen:
        reasons.append(f"frozen/static face: median frame delta {fscore} < {FROZEN_MIN_DIFF}")

    dscore = dark_anomaly_score(a.avatar) if size_ok else None
    dark = dscore is not None and dscore > DARK_ANOMALY_MAX
    if dark:
        reasons.append(f"dark-blob/black-hands: near-black coverage {dscore} > {DARK_ANOMALY_MAX} "
                       "(bad source — limbs render black)")

    result = {
        "sizeOk": size_ok,
        "avatarDur": avatar_dur,
        "audioDur": audio_dur,
        "durationDelta": dur_delta,
        "durationOk": dur_ok,
        "frozenScore": fscore,
        "frozen": frozen,
        "darkScore": dscore,
        "darkAnomaly": dark,
        # pass = no hard failures. A None frozen/dark score (clip too short to judge) does NOT fail.
        "pass": size_ok and dur_ok and not frozen and not dark,
        "failReasons": reasons,
    }
    json.dump(result, open(a.out, "w"), indent=2)
    print(json.dumps(result))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
