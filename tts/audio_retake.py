"""Bounded local retakes and immutable audio evidence; no provider or ASR imports."""
import hashlib
import json
import re
from pathlib import Path

CHUNK_TAKES = 6
WHOLE_TAKES = 4  # original take plus three whole-narration retakes
CORRECTION_VERSION = 1


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def retain(out_dir: Path, raw: bytes, suffix: str) -> str:
    key = digest(raw)
    path = out_dir / "audio-attempts" / (key + suffix)
    path.parent.mkdir(exist_ok=True)
    if path.exists():
        if path.read_bytes() != raw:
            raise RuntimeError("Saved audio-attempt evidence changed")
    else:
        with path.open("xb") as saved:
            saved.write(raw)
    return key


def quality_rank(qc: dict) -> tuple[int, int, int]:
    """A blocking finding always outweighs harmless ASR spelling differences."""
    return (bool(qc["blocking"]), len(qc["blocking"]), len(qc["changes"]))


class VoiceboxRetakes:
    """The same exact speech request cannot refill its allowance on CLI reentry.

    Reserve before synthesis, including failed/interrupted attempts. Candidate WAV,
    raw ASR and voice/chunk receipts are restored together, never only their score.
    This is per-package local audio correction, not a text-model task allowance.
    """
    def __init__(self, out_dir: Path, text: str, synthesis: str, voice: str):
        self.out_dir = out_dir
        self.identity = {"version": CORRECTION_VERSION, "engine": "voicebox", "voice": voice,
                         "scriptSha256": digest(text.encode()), "synthesisSha256": digest(synthesis.encode())}
        key = digest(json.dumps(self.identity, sort_keys=True).encode())
        self.path = out_dir / "audio-corrections" / (key + ".json")
        self.path.parent.mkdir(exist_ok=True)
        self.state = {"identity": self.identity, "runtime": None, "attempts": [], "best": None}
        if self.path.exists():
            self.state = json.loads(self.path.read_text())
            attempts = self.state.get("attempts")
            if (self.state.get("identity") != self.identity or not isinstance(attempts, list)
                    or len(attempts) > WHOLE_TAKES
                    or any(a.get("take") != i + 1 or a.get("status") not in {"reserved", "complete", "failed"}
                           for i, a in enumerate(attempts))):
                raise RuntimeError("Local audio correction receipt is invalid; preserve it for inspection")

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=2))
        tmp.replace(self.path)

    def reserve(self) -> int:
        if len(self.state["attempts"]) >= WHOLE_TAKES:
            raise RuntimeError("Local audio correction allowance exhausted; private candidates retained")
        take = len(self.state["attempts"]) + 1
        self.state["attempts"].append({"take": take, "status": "reserved"})
        self.save()
        return take

    def bind_runtime(self, profile_id: str, engine: str) -> None:
        runtime = {"profileId": profile_id, "engine": engine}
        if self.state["runtime"] is not None and self.state["runtime"] != runtime:
            raise RuntimeError("Selected local voice profile or speech engine changed during correction; hold this draft")
        self.state["runtime"] = runtime
        self.save()

    def complete(self, take: int, qc: dict, voice_receipt: bytes) -> None:
        audio = (self.out_dir / "audio.wav").read_bytes()
        if (qc.get("audioSha256") != digest(audio) or qc.get("scriptSha256") != self.identity["scriptSha256"]
                or qc.get("voice") != self.identity["voice"] or qc.get("engine") != "voicebox"):
            raise RuntimeError("Local audio candidate does not match its requested voice and script")
        receipt = json.loads(voice_receipt)
        self.bind_runtime(receipt["profileId"], receipt["engine"])
        row = {"take": take, "status": "complete", "audio": retain(self.out_dir, audio, ".wav"),
               "qc": retain(self.out_dir, json.dumps(qc, indent=2).encode(), ".json"),
               "voiceReceipt": retain(self.out_dir, voice_receipt, ".json"), "rank": list(quality_rank(qc))}
        self.state["attempts"][take - 1] = row
        best = self.state["best"]
        if best is None or tuple(row["rank"]) < tuple(self.state["attempts"][best - 1]["rank"]):
            self.state["best"] = take
        self.save()

    def failed(self, take: int, error: Exception) -> None:
        self.state["attempts"][take - 1].update(status="failed", error=str(error)[:2000])
        self.save()

    def restore(self) -> dict | None:
        best = self.state["best"]
        if best is None:
            return None
        if isinstance(best, bool) or not isinstance(best, int) or not 1 <= best <= len(self.state["attempts"]):
            raise RuntimeError("Local audio best-take receipt is invalid")
        row = self.state["attempts"][best - 1]
        if row.get("status") != "complete":
            raise RuntimeError("Local audio best take is incomplete")
        files = {}
        for field, name, suffix in [("audio", "audio.wav", ".wav"), ("qc", "audio-qc.json", ".json"),
                                    ("voiceReceipt", "voice-receipt.json", ".json")]:
            key = row.get(field, "")
            if not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{64}", key):
                raise RuntimeError("Local audio candidate hash is invalid")
            raw = (self.out_dir / "audio-attempts" / (key + suffix)).read_bytes()
            if digest(raw) != key:
                raise RuntimeError("Saved audio-attempt evidence changed")
            files[name] = raw
        qc = json.loads(files["audio-qc.json"])
        voice = json.loads(files["voice-receipt.json"])
        if (qc.get("audioSha256") != digest(files["audio.wav"])
                or qc.get("scriptSha256") != self.identity["scriptSha256"]
                or qc.get("voice") != self.identity["voice"] or qc.get("engine") != "voicebox"
                or {"profileId": voice.get("profileId"), "engine": voice.get("engine")} != self.state["runtime"]):
            raise RuntimeError("Saved local audio candidate identity changed")
        for name, raw in files.items():
            (self.out_dir / name).write_bytes(raw)
        qc["correction"] = {"version": CORRECTION_VERSION, "reservedTakes": len(self.state["attempts"]),
                            "wholeTakeLimit": WHOLE_TAKES, "chunkTakeLimit": CHUNK_TAKES, "selectedTake": best,
                            "receiptSha256": digest(self.path.read_bytes())}
        (self.out_dir / "audio-qc.json").write_text(json.dumps(qc, indent=2))
        return qc
