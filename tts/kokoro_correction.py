"""One bounded sentence-level repair of a held local Kokoro narration.

Reuse checked chunks on resume. Do not retry the same failing deterministic
request, alter approved words, or infer missing figures from the script.
"""
import json
import re
from pathlib import Path
from audio_retake import digest, retain


def correction_path(out_dir: Path, text: str, voice: str) -> Path:
    identity = {"version": 1, "engine": "kokoro", "voice": voice, "scriptSha256": digest(text.encode())}
    key = digest(json.dumps(identity, sort_keys=True).encode())
    return out_dir / "audio-corrections" / ("kokoro-" + key + ".json")


def _saved_audio(out_dir: Path, key: str) -> bytes:
    if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key):
        raise RuntimeError("Local chunk audio hash is invalid")
    raw = (out_dir / "audio-attempts" / (key + ".wav")).read_bytes()
    if digest(raw) != key:
        raise RuntimeError("Saved local chunk audio changed")
    return raw


def _saved_qc(out_dir: Path, row: dict, audio: bytes, requested: str, voice: str) -> dict:
    key = row.get("qcSha256")
    if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key):
        raise RuntimeError("Local chunk QA hash is invalid")
    raw = (out_dir / "audio-attempts" / (key + ".json")).read_bytes()
    if digest(raw) != key:
        raise RuntimeError("Saved local chunk QA changed")
    qc = json.loads(raw)
    if (qc.get("audioSha256") != digest(audio) or qc.get("requestedText") != requested
            or qc.get("voice") != voice or qc.get("engine") != "kokoro"
            or not isinstance(qc.get("blocking"), list) or not isinstance(qc.get("heardWords"), list)
            or not qc["heardWords"] or qc.get("method") != "raw-asr-script-comparison"):
        raise RuntimeError("Saved local chunk QA identity changed")
    return qc


def correct_kokoro_chunks(out_dir: Path, text: str, synthesis: str, voice: str,
                          chunks: list[str], synthesize, transcribe, compare, concatenate) -> dict:
    """Callbacks use the selected engine and independent raw ASR, never a writer.

    There is one correction request per sentence group, after the original held
    narration. Each request is persisted before inference. A failed/interrupted
    request remains spent; reentry cannot refill it. Final whole-audio QA is still
    mandatory, so passing individual chunks alone cannot release the narration.
    """
    if not chunks or len(chunks) > 64 or any(not c.strip() or len(c) > 1200 for c in chunks):
        raise RuntimeError("Local audio correction requires at most 64 complete bounded sentence groups")
    if " ".join(" ".join(chunks).split()) != " ".join(synthesis.split()):
        raise RuntimeError("Local audio correction must preserve every synthesis word")
    identity = {"version": 1, "engine": "kokoro", "voice": voice,
                "scriptSha256": digest(text.encode()), "synthesisSha256": digest(synthesis.encode())}
    # Key by approved script and voice, so a changed normalizer cannot reset an
    # existing correction allowance without an explicit decision.
    key = digest(json.dumps({k: v for k, v in identity.items() if k != "synthesisSha256"}, sort_keys=True).encode())
    directory = out_dir / "audio-corrections"
    directory.mkdir(exist_ok=True)
    path = correction_path(out_dir, text, voice)
    wanted = [digest(c.encode()) for c in chunks]

    def save() -> None:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2))
        tmp.replace(path)

    if path.exists():
        state = json.loads(path.read_text())
        if (state.get("identity") != identity or state.get("chunks") != wanted
                or not isinstance(state.get("attempts"), list) or len(state["attempts"]) > len(chunks)
                or any(a.get("chunk") != i or a.get("status") not in {"reserved", "failed", "complete"}
                       for i, a in enumerate(state["attempts"]))):
            raise RuntimeError("Local audio correction identity or allowance changed; preserve its receipts")
    else:
        original_audio = (out_dir / "audio.wav").read_bytes()
        original_qc = (out_dir / "audio-qc.json").read_bytes()
        receipt = json.loads(original_qc)
        if (receipt.get("audioSha256") != digest(original_audio) or receipt.get("scriptSha256") != identity["scriptSha256"]
                or receipt.get("engine") != "kokoro" or receipt.get("voice") != voice or not receipt.get("blocking")):
            raise RuntimeError("Local chunk correction requires the exact held original narration")
        state = {"identity": identity, "chunks": wanted, "originalTake": {
            "audio": retain(out_dir, original_audio, ".wav"), "qc": retain(out_dir, original_qc, ".json")},
            "synthesisCallLimit": 1 + len(chunks), "attempts": [], "final": None}
        save()
    if state.get("synthesisCallLimit") != 1 + len(chunks):
        raise RuntimeError("Local audio correction allowance changed")
    if state.get("final") is not None:
        # A whole-audio rejection is not permission to resynthesize the chunks.
        final = state["final"]
        if not isinstance(final, dict) or not final.get("audio"):
            raise RuntimeError("Local audio correction completion receipt is invalid")
        audio = _saved_audio(out_dir, final["audio"])
        qc = _saved_qc(out_dir, final, audio, text, voice)
        (out_dir / "audio.wav").write_bytes(audio)
        return qc

    selected = []
    for index, chunk in enumerate(chunks):
        if index < len(state["attempts"]):
            row = state["attempts"][index]
            if row["status"] == "reserved" or not row.get("qcSha256"):
                raise RuntimeError("Local audio chunk correction already failed or was interrupted; its request remains spent")
            audio = _saved_audio(out_dir, row.get("audio"))
            qc = _saved_qc(out_dir, row, audio, chunk, voice)
            if row["status"] == "failed":
                # A corrected deterministic QA rule may recheck the exact saved
                # raw ASR. Never re-synthesize, reset the count, or relabel the
                # historical failed request. Every new check has its own receipt.
                checks = row.get("rechecks", [])
                if checks:
                    qc = _saved_qc(out_dir, checks[-1], audio, chunk, voice)
                fresh = compare(chunk, qc["heardWords"])
                if fresh.get("normalizationVersion", 0) > qc.get("normalizationVersion", 0):
                    fresh.update(audioSha256=digest(audio), engine="kokoro", voice=voice)
                    check = {"kind": "raw-asr-recheck", "normalizationVersion": fresh["normalizationVersion"],
                             "previousQcSha256": checks[-1]["qcSha256"] if checks else row["qcSha256"],
                             "qcSha256": retain(out_dir, json.dumps(fresh, indent=2).encode(), ".json")}
                    row.setdefault("rechecks", []).append(check)
                    save()
                    qc = fresh
                if qc["blocking"]:
                    raise RuntimeError("Local audio chunk correction already failed; its request remains spent and exact raw ASR still holds")
            if qc["blocking"]:
                raise RuntimeError("Saved local audio chunk no longer passes its exact QA")
        else:
            row = {"chunk": index, "status": "reserved"}
            state["attempts"].append(row)
            save()
            candidate = directory / (key + f"-chunk-{index}.wav")
            candidate.unlink(missing_ok=True)
            try:
                synthesize(chunk, candidate, voice)
                audio = candidate.read_bytes()
                audio_hash = retain(out_dir, audio, ".wav")
                qc = compare(chunk, transcribe(candidate))
                qc.update(audioSha256=audio_hash, engine="kokoro", voice=voice)
                row.update(audio=audio_hash, qcSha256=retain(out_dir, json.dumps(qc, indent=2).encode(), ".json"))
                if qc["blocking"]:
                    raise RuntimeError("AUDIO QC HOLD: sentence correction still differs: " + "; ".join(f["reason"] for f in qc["blocking"]))
                row["status"] = "complete"
                save()
            except Exception as error:
                if candidate.exists(): row["audio"] = retain(out_dir, candidate.read_bytes(), ".wav")
                row.update(status="failed", error=str(error)[:2000])
                save()
                raise
            finally:
                candidate.unlink(missing_ok=True)
        selected.append(audio)

    candidate = directory / (key + "-joined.wav")
    try:
        concatenate(selected, candidate)
        audio = candidate.read_bytes()
        audio_hash = retain(out_dir, audio, ".wav")
        qc = compare(text, transcribe(candidate))
        qc.update(engine="kokoro", voice=voice, scriptSha256=identity["scriptSha256"], audioSha256=audio_hash,
                  correction={"version": 1, "method": "bounded-sentence-correction", "originalTakeCount": 1,
                              "reservedChunkRequests": len(state["attempts"]), "synthesisCallLimit": state["synthesisCallLimit"]})
        state["final"] = {"audio": audio_hash, "qcSha256": retain(out_dir, json.dumps(qc, indent=2).encode(), ".json")}
        save()
        # Held original remains immutable in audio-attempts; the new candidate is
        # adopted together with its own QA. The caller still rejects any blocking QA.
        (out_dir / "audio.wav").write_bytes(audio)
        return qc
    finally:
        candidate.unlink(missing_ok=True)
