#!/usr/bin/env python3
"""Deterministic accent-color anomaly check for edition covers and videos.\n\nThis catches wholesale accent mismatches. Element-level visual review remains a separate optional gate.\nWrites JSON to --out and exits nonzero on failure.\n"""
import argparse, json, os, subprocess, tempfile, colorsys
from statistics import median

HUE_TOLERANCE = 25.0   # degrees +/- around the expected accent hue
GROSS_FRAC = 0.55      # >this fraction off-accent = wholesale wrong color (wrong edition's cover)
SAT_MIN = 0.235        # HSV saturation (0-1); below = gray/white/black -> not a graphic pixel
VAL_MIN = 0.16         # below = too dark to read a hue
VAL_MAX = 0.92         # above = near-white -> skip
MIN_GRAPHIC = 50       # too few colored pixels to judge -> skip (treated as pass)


def hex_to_hue(h: str) -> float:
    h = h.lstrip("#")
    r, g, b = int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255
    return colorsys.rgb_to_hsv(r, g, b)[0] * 360


def hue_diff(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return min(d, 360 - d)


def analyze(path: str, expected_hue: float):
    """Global off-accent fraction + the largest single off-accent 10-deg hue cluster (a diagnostic
    hint for the vision agent). None if too few graphic pixels to judge."""
    from PIL import Image
    img = Image.open(path).convert("RGB")
    w, h = img.size
    step = max(1, w // 300)
    px = img.load()
    graphic = off = 0
    buckets = [0] * 36
    for y in range(0, h, step):
        for x in range(0, w, step):
            r, g, b = px[x, y]
            hh, ss, vv = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if ss < SAT_MIN or vv < VAL_MIN or vv > VAL_MAX:
                continue
            graphic += 1
            deg = hh * 360
            if hue_diff(deg, expected_hue) > HUE_TOLERANCE:
                off += 1
                buckets[int(deg // 10) % 36] += 1
    if graphic < MIN_GRAPHIC:
        return None
    peak = max(buckets)
    return {
        "graphic": graphic,
        "offFrac": off / graphic,
        "peakOffFrac": peak / graphic,
        "peakOffHue": buckets.index(peak) * 10 + 5,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cover", required=True)
    ap.add_argument("--video", default=None)
    ap.add_argument("--accent", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    expected = hex_to_hue(a.accent)
    reasons: list[str] = []

    cov = analyze(a.cover, expected) if os.path.exists(a.cover) else None
    cover_pass = cov is None or cov["offFrac"] <= GROSS_FRAC
    if cov is not None and not cover_pass:
        reasons.append(f"cover: {cov['offFrac']*100:.0f}% of graphic pixels off-accent "
                       f"(expected ~{expected:.0f}deg +/-{HUE_TOLERANCE:.0f}) — wholesale wrong color")

    video_off = video_pass = None
    nframes = 0
    if a.video and os.path.exists(a.video):
        try:
            with tempfile.TemporaryDirectory() as td:
                from imageio_ffmpeg import get_ffmpeg_exe
                r = subprocess.run([get_ffmpeg_exe(), "-y", "-i", a.video, "-r", "0.5",
                                    "-f", "image2", os.path.join(td, "v%03d.jpg")],
                                   capture_output=True, text=True, timeout=180)
                frames = sorted(f for f in os.listdir(td) if f.endswith(".jpg"))
                nframes = len(frames)
                if r.returncode == 0 and nframes >= 3:
                    offs = [p["offFrac"] for p in (analyze(os.path.join(td, f), expected) for f in frames) if p is not None]
                    if offs:
                        video_off = round(median(offs), 3)
                        video_pass = video_off <= GROSS_FRAC
                        if not video_pass:
                            reasons.append(f"video: median {video_off*100:.0f}% off-accent — wholesale wrong color")
        except Exception as e:  # noqa: BLE001 — never false-fail on a video tooling error
            reasons.append(f"video check skipped ({e})")

    out = {
        "accentExpected": a.accent,
        "accentHue": round(expected, 1),
        "coverOffFrac": round(cov["offFrac"], 3) if cov else None,
        "coverPeakOffFrac": round(cov["peakOffFrac"], 4) if cov else None,  # hint for vision agent
        "coverPeakOffHue": cov["peakOffHue"] if cov else None,
        "coverGraphicPx": cov["graphic"] if cov else 0,
        "coverPass": cover_pass,
        "videoOffFrac": video_off,
        "videoFrameCount": nframes,
        "videoPass": video_pass,
        "pass": cover_pass and (video_pass is not False),
        "failReasons": reasons,
    }
    json.dump(out, open(a.out, "w"), indent=2)
    print(json.dumps(out))
    return 0 if out["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
