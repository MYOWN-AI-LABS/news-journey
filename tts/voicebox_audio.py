"""Local narration: sentence boundaries, even levels, and quiet joins."""
import re

import numpy as np

SENTENCE_PAUSE_SEC = 0.65
CLAUSE_PAUSE_SEC = 0.16


def join_chunks(chunks: list[np.ndarray], speech: list[str], rate: int):
    """Retain the actual speech windows so alignment cannot consume an inserted pause."""
    if not chunks or len(chunks) != len(speech):
        raise RuntimeError("Local voice chunks do not match the narration")
    parts, spans, frames, word = [], [], 0, 0
    for index, (pcm, text) in enumerate(zip(chunks, speech)):
        count = len(text.split())
        spans.append({"wordStart": word, "wordEnd": word + count,
                      "startSec": frames / rate, "endSec": (frames + len(pcm)) / rate})
        parts.append(pcm)
        frames += len(pcm)
        word += count
        if index < len(chunks) - 1:
            pause = SENTENCE_PAUSE_SEC if re.search(r'''[.!?]["'’”\)\]]*$''', text) else CLAUSE_PAUSE_SEC
            silence = np.zeros(round(rate * pause), dtype=np.float32)
            parts.append(silence)
            frames += len(silence)
    return np.concatenate(parts), spans


def constrain_to_chunks(words: list[dict], spans: list[dict]) -> list[dict]:
    """Whisper may place a sentence onset in the preceding silence; the WAV bounds win."""
    if not spans or spans[0]["wordStart"] != 0 or spans[-1]["wordEnd"] != len(words):
        raise RuntimeError("Local voice timing does not cover the script")
    result = [dict(word) for word in words]
    for span in spans:
        low, high = span["startSec"], span["endSec"]
        for word in result[span["wordStart"]:span["wordEnd"]]:
            word["start"] = round(min(high, max(low, word["start"])), 3)
            word["end"] = round(min(high, max(word["start"], word["end"])), 3)
    return result


def sentence_chunks(text: str, max_chars: int = 280) -> list[str]:
    chunks, current = [], ""
    for sentence in re.split(r"(?<=[.!?])\s+", text.strip()):
        if not sentence:
            continue
        if len(sentence) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            for clause in re.split(r"(?<=[,;:])\s+", sentence):
                if current and len(current) + 1 + len(clause) > max_chars:
                    chunks.append(current)
                    current = ""
                current = f"{current} {clause}".strip()
            if current:
                chunks.append(current)
                current = ""
        else:
            current = f"{current} {sentence}".strip()
            # Very short takes lose soft sentence onsets; group them before synthesis.
            if len(current) >= 90:
                chunks.append(current)
                current = ""
    if current:
        if chunks and len(current) < 45:
            chunks[-1] += " " + current
        else:
            chunks.append(current)
    return chunks


def prepare_pcm(frames: bytes, channels: int, rate: int) -> np.ndarray:
    pcm = np.frombuffer(frames, dtype="<i2").astype(np.float32)
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    sig = pcm / 32768.0
    if not sig.size or not np.any(np.abs(sig) > 1e-6):
        raise RuntimeError("Local voice returned silence; hold the draft and retry narration")
    loud = np.abs(sig) > max(0.01, float(np.abs(sig).max()) * 0.02)
    if loud.any():
        first, last = np.argmax(loud), len(loud) - np.argmax(loud[::-1])
        pad = int(rate * 0.04)  # Keep quiet consonants before/after the detected speech.
        sig = sig[max(0, first - pad):min(len(sig), last + pad)]
    rms = float(np.sqrt(np.mean(sig ** 2)))
    sig *= 0.075 / rms
    peak = float(np.abs(sig).max())
    if peak > 0.95:
        sig *= 0.95 / peak
    fade = min(int(rate * 0.003), sig.size // 2)
    if fade:
        sig[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)
        sig[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
    return sig
