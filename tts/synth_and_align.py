"""Synthesize voiceover audio and produce word-level timestamps.

Contract (files in / files out — the only seam between Node and Python):
  in:  --text-file <path>   plain-text voiceover script
  out: <out-dir>/audio.wav         24 kHz mono wav
       <out-dir>/timestamps.json   {"durationSec": float, "engine": str,
                                    "words": [{"w": str, "start": f, "end": f}]}

Engines: explicitly selected Kokoro/MLX, Edge TTS, or configured voice provider.
Local synthesis failures stop; they never switch narration to an online service.
Alignment: MLX Whisper on Apple silicon or faster-whisper on Windows/other CPUs,
sequence-aligned back to the script's own words so captions stay exact.
"""

import argparse
import asyncio
import difflib
import hashlib
from decimal import Decimal
import json
import math
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path


def log(msg: str) -> None:
    print(f"[tts] {msg}", file=sys.stderr)


# TTS pronunciation fixes: words the cloned voice mispronounces. We rewrite ONLY the synthesis
# input (not the caption/alignment text), so captions keep the reviewed spelling.
# Score expansion can add synthesis words; sequence alignment retains original caption tokens.
TTS_SUBSTITUTIONS = [
    (re.compile(r"\bshareable\b", re.IGNORECASE), "share-able"),
    (re.compile(r"\bsharable\b", re.IGNORECASE), "share-able"),
    # Publication/status "live" uses /laɪv/; the verb "I live in Florida" stays unchanged.
    # The established Voicebox carrier is "must go live"; all rules preserve token count.
    (re.compile(r"\bmust\s+be\s+live\b", re.IGNORECASE), "must go live"),
    (re.compile(
        r"\b((?:(?:should|can|will|would|could|may|might)\s+be|"
        r"(?:has|have|had)\s+to\s+be|is|are|was|were|goes|went|stays|remains|"
        r"became|becomes|confirmed|verified|running|it['’]s))\s+live\b",
        re.IGNORECASE,
    ), r"\1 lyve"),
    (re.compile(
        r"\b((?:checked|re-?checked|fetched|re-?fetched|published|deployed|streamed))\s+live\b",
        re.IGNORECASE,
    ), r"\1 lyve"),
    (re.compile(
        r"\blive\s+(verification|issue|site|post|article|page|URL|video|stream|feed|data|"
        r"result|status|system|run|output|environment|service|deployment|demo|view|link|"
        r"event|coverage)\b",
        re.IGNORECASE,
    ), r"lyve \1"),
    (re.compile(r"\b(find\s+it)\s+live\s+under\b", re.IGNORECASE), r"\1 lyve under"),
]


def normalize_score_speech(text: str, asr_punctuation: bool = False, spoken_scores: bool = False) -> str:
    """Speak clear sports-result score pairs, leaving dates, ranges and negatives alone."""
    digits = dict(zip('zero one two three four five six seven eight nine'.split(), range(10)))
    digits['nil'] = 0
    def score(match: re.Match) -> str:
        first, second = (str(digits.get(part.lower(), part)) for part in (match[1], match[2]))
        prefix = re.split(r"[.!?;]", text[:match.start()])[-1][-120:]
        suffix = re.split(r"[.!?;]", text[match.end():])[0][:160]
        # A result verb near the pair supplies context; a bare numeric hyphen does not.
        result = re.search(r"\b(?:beat|beating|defeated|defeating|won|win|wins|winning|lost|losing|lose|loses|drew)\b(?:\s+[\w’'-]+){0,12}\s*$", prefix, re.IGNORECASE)
        # Scores can precede the result noun: "a 4-2 Cup win", including ASR's
        # punctuated "4 -2". Never reinterpret a spoken word "minus" this way.
        result_noun = re.match(r"\s+(?:[\w’'-]+\s+){0,5}(?:win|victory|defeat|loss|draw|lead|deficit|advantage|scoreline|cushion)\b", suffix, re.IGNORECASE)
        range_prefix = re.search(r"\b(?:by|between|from|range of)\s*$", prefix, re.IGNORECASE)
        unit_suffix = re.match(r"\s*(?:%|percent\b|degrees?\b|years?\b|months?\b|days?\b|yards?\b|met(?:er|re)s?\b|points?\b|dollars?\b)", text[match.end():], re.IGNORECASE)
        # In an explicitly cricket sentence the second value is wickets, not
        # another team's score. Keep both quantities audible ("for four" alone
        # is often transcribed as a single "for"). No bare score inference.
        cricket = (int(second) <= 10
                   and re.search(r"\b(?:cricket|wickets?|innings|T20|ODI)\b", prefix + suffix, re.IGNORECASE)
                   and re.search(r"\b(?:made|scored|posted|reached|finished\s+(?:on|at))\s*$", prefix, re.IGNORECASE))
        if range_prefix or unit_suffix:
            return match[0]
        if cricket:
            return f"{first} runs for {second} wickets"
        if not result and not result_noun:
            return match[0]
        return f"{first} to {second}"
    separator = r"\s*[-–]\s*" if asr_punctuation else r"[-–]"
    text = re.sub(r"(?<![\w.−–-])(\d{1,3})" + separator + r"(\d{1,3})(?![\w]|[-–]\d|\.\d)", score, text)
    if spoken_scores:
        # QC only: explicit spoken score words must remain two values, not an
        # arithmetic sum ("four two" != six). "Nil" means zero only in a result.
        unit = '(?:' + '|'.join(digits) + ')'
        # A writer may hyphenate the spoken pair ("beat France six-four"); the hyphen is a score separator here,
        # never a sum (fresh-package journey, Sep 17: the requested side became 10 against a correctly heard "6 -4").
        text = re.sub(r'\b(' + unit + r')(?:\s+|\s*[-–]\s*)(' + unit + r')\b', score, text, flags=re.IGNORECASE)
    return text


def normalize_for_tts(text: str) -> str:
    text = normalize_score_speech(text)
    for pattern, replacement in TTS_SUBSTITUTIONS:
        text = pattern.sub(replacement, text)
    return text


def convert_to_wav(source: Path, out_wav: Path) -> None:
    """Normalize any provider audio to 24 kHz mono PCM WAV with a bundled cross-platform FFmpeg."""
    from imageio_ffmpeg import get_ffmpeg_exe

    subprocess.run(
        [get_ffmpeg_exe(), "-y", "-i", str(source), "-ac", "1", "-ar", "24000", "-sample_fmt", "s16", str(out_wav)],
        check=True,
        capture_output=True,
    )


def synth_kokoro(text: str, out_wav: Path, voice: str) -> None:
    from mlx_audio.tts.generate import generate_audio

    out_prefix = str(out_wav.with_suffix(""))
    # mlx-audio >= 0.3 renamed model_path → model (older kwarg is silently ignored).
    # speed MUST stay 1.0: any other value hits a broadcast_shapes bug in mlx-audio's
    # Kokoro resampling for some text lengths. Pacing is controlled via word budgets.
    generate_audio(
        text=text,
        model="prince-canuma/Kokoro-82M",
        voice=voice,
        speed=1.0,
        file_prefix=out_prefix,
        audio_format="wav",
        join_audio=True,
        verbose=False,
    )
    # mlx-audio may write <prefix>.wav or <prefix>_000.wav depending on version
    if not out_wav.exists():
        candidates = sorted(out_wav.parent.glob(out_wav.stem + "*.wav"))
        if not candidates:
            raise RuntimeError("kokoro produced no wav output")
        candidates[0].rename(out_wav)


def synth_edge(text: str, out_wav: Path, voice: str = "en-US-AriaNeural") -> None:
    import edge_tts

    mp3_path = out_wav.with_suffix(".mp3")

    async def run() -> None:
        # +12% keeps a max-budget (215-word) roundup under Instagram's 90s Reels cap
        tts = edge_tts.Communicate(text, voice=voice, rate="+12%")
        await tts.save(str(mp3_path))

    asyncio.run(run())
    convert_to_wav(mp3_path, out_wav)
    mp3_path.unlink(missing_ok=True)


def synth_elevenlabs(text: str, out_wav: Path, voice_id: str) -> None:
    """Configured ElevenLabs voice clone. Key in ELEVENLABS_API_KEY; voice settings
    passed via ELEVENLABS_* env (set by voice.ts from config/avatar.json). Returns
    MP3 converted to the WAV Whisper and Remotion expect."""
    import os
    import urllib.request

    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("ELEVENLABS_API_KEY not set")
    if not voice_id:
        raise RuntimeError("ElevenLabs voiceId missing (config/avatar.json elevenlabs.voiceId)")

    body = json.dumps({
        "text": text,
        "model_id": os.environ.get("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2"),
        "voice_settings": {
            "stability": float(os.environ.get("ELEVENLABS_STABILITY", "0.5")),
            "similarity_boost": float(os.environ.get("ELEVENLABS_SIMILARITY", "0.75")),
            "style": float(os.environ.get("ELEVENLABS_STYLE", "0.0")),
            "use_speaker_boost": os.environ.get("ELEVENLABS_SPEAKER_BOOST", "true") == "true",
        },
    }).encode()
    # mp3_44100_128 is the broadly-available default; output_format query is optional
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128",
        data=body,
        headers={"xi-api-key": api_key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        method="POST",
    )
    mp3_path = out_wav.with_suffix(".mp3")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            mp3_path.write_bytes(resp.read())
    except urllib.error.HTTPError as e:  # surface the API's error body, not a bare 400
        raise RuntimeError(f"ElevenLabs HTTP {e.code}: {e.read().decode(errors='replace')[:300]}") from e
    convert_to_wav(mp3_path, out_wav)
    mp3_path.unlink(missing_ok=True)


def _speech_chunks(text: str, max_chars: int = 280) -> list[str]:
    """Split text into <=max_chars chunks on sentence boundaries. The /synthesize endpoint
    times out (504 VoiceGenerationTimeout) on a full ~150-word script, but short chunks
    synthesize in ~2s, so we chunk → synth each → concatenate."""
    sents = re.split(r"(?<=[.!?])\s+", text.strip())
    chunks: list[str] = []
    cur = ""
    for s in sents:
        if not s:
            continue
        if cur and len(cur) + 1 + len(s) > max_chars:
            chunks.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        chunks.append(cur)
    return chunks or [text.strip()]


def _resemble_one(text: str, voice_uuid: str, api_key: str) -> bytes:
    """One /synthesize call → raw wav bytes, with retry on the transient 504 timeout."""
    import time
    import urllib.request

    body = json.dumps({"voice_uuid": voice_uuid, "data": text,
                       "sample_rate": 48000, "precision": "PCM_16"}).encode()
    last: Exception | None = None
    for attempt in range(3):
        req = urllib.request.Request(
            "https://f.cluster.resemble.ai/synthesize", data=body,
            headers={"x-access-token": api_key, "Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read())
            if data.get("success") and data.get("audio_content"):
                import base64
                return base64.b64decode(data["audio_content"])
            last = RuntimeError(f"Resemble synthesis failed: {str(data)[:200]}")
        except urllib.error.HTTPError as e:
            last = RuntimeError(f"Resemble HTTP {e.code}: {e.read().decode(errors='replace')[:200]}")
            if e.code != 504:  # only the generation-timeout is worth retrying
                raise last from e
        if attempt < 2:
            time.sleep(2)
    raise last if last else RuntimeError("Resemble synthesis failed")


def synth_resemble(text: str, out_wav: Path, voice_uuid: str) -> None:
    """Configured Resemble AI (Chatterbox) voice clone. Key in RESEMBLE_API_KEY; voice in
    RESEMBLE_VOICE_UUID (passed as --voice). Chunks the script by sentence (the API times out
    on long text), synthesizes each chunk (with retry), concatenates the PCM, then normalizes to
    the mono 24k WAV Whisper and Remotion expect."""
    import io
    import os
    import wave

    api_key = os.environ.get("RESEMBLE_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("RESEMBLE_API_KEY not set")
    if not voice_uuid:
        raise RuntimeError("Resemble voice_uuid missing (config/avatar.json resemble.voiceUuid)")

    chunks = _speech_chunks(text)
    frames = b""
    params = None
    for i, chunk in enumerate(chunks):
        log(f"resemble chunk {i + 1}/{len(chunks)} ({len(chunk)} chars)")
        wav_bytes = _resemble_one(chunk, voice_uuid, api_key)
        with wave.open(io.BytesIO(wav_bytes), "rb") as w:
            if params is None:
                params = w.getparams()
            frames += w.readframes(w.getnframes())

    raw_path = out_wav.with_suffix(".raw.wav")
    with wave.open(str(raw_path), "wb") as out:
        out.setparams(params)
        out.writeframes(frames)
    # normalize to the pipeline's expected format (mono 24k LEI16), same as the other engines
    convert_to_wav(raw_path, out_wav)
    raw_path.unlink(missing_ok=True)


def normalize(word: str) -> str:
    return re.sub(r"[^a-z0-9]", "", word.lower())


def align(script_words: list[str], whisper_words: list[dict]) -> list[dict]:
    """Map whisper timings onto the script's exact words via sequence alignment."""
    a = [normalize(w) for w in script_words]
    b = [normalize(w["w"]) for w in whisper_words]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    out: list[dict | None] = [None] * len(script_words)
    for block in sm.get_matching_blocks():
        for k in range(block.size):
            ww = whisper_words[block.b + k]
            out[block.a + k] = {"w": script_words[block.a + k], "start": ww["start"], "end": ww["end"]}
    # Interpolate any unmatched words between their matched neighbours
    result: list[dict] = []
    n = len(script_words)
    i = 0
    while i < n:
        if out[i] is not None:
            result.append(out[i])
            i += 1
            continue
        j = i
        while j < n and out[j] is None:
            j += 1
        prev_end = result[-1]["end"] if result else 0.0
        next_start = out[j]["start"] if j < n else prev_end + 0.4 * (j - i)
        span = max(next_start - prev_end, 0.15 * (j - i))
        for k in range(i, j):
            frac0 = (k - i) / (j - i)
            frac1 = (k - i + 1) / (j - i)
            result.append(
                {"w": script_words[k], "start": round(prev_end + frac0 * span, 3), "end": round(prev_end + frac1 * span, 3)}
            )
        i = j
    return result


def load_audio_16k(wav: Path):
    """Load wav as 16 kHz mono float32 without needing ffmpeg on PATH."""
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(str(wav), dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != 16000:
        n_out = int(len(data) * 16000 / sr)
        x_old = np.linspace(0.0, 1.0, num=len(data), endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=n_out, endpoint=False)
        data = np.interp(x_new, x_old, data).astype("float32")
    return data


def transcribe(wav: Path) -> list[dict]:
    words: list[dict] = []
    apple_silicon = platform.system() == "Darwin" and platform.machine().lower() in {"arm64", "aarch64"}
    if apple_silicon:
        import mlx_whisper

        res = mlx_whisper.transcribe(
            load_audio_16k(wav),
            path_or_hf_repo="mlx-community/whisper-base-mlx",
            word_timestamps=True,
            language="en",
        )
        for seg in res["segments"]:
            for w in seg.get("words", []):
                words.append({"w": w["word"].strip(), "start": float(w["start"]), "end": float(w["end"])})
        return words

    from faster_whisper import WhisperModel

    model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(wav), language="en", word_timestamps=True)
    for segment in segments:
        for w in segment.words or []:
            words.append({"w": w.word.strip(), "start": float(w.start), "end": float(w.end)})
    return words


def ensure_voicebox() -> None:
    """Use the harness's shared fixed-loopback health/start gate."""
    node = shutil.which("node")
    root = Path(__file__).resolve().parent.parent
    if not node:
        raise RuntimeError("Your saved voice isn't available because Node.js could not run the Voicebox health check. Set VOICEBOX_START_COMMAND or start Voicebox.")
    try:
        check = subprocess.run(
            [node, "--import", "tsx", str(root / "src" / "voicebox-start.ts")],
            cwd=root, capture_output=True, text=True, timeout=165,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"Your saved voice isn't available because local Voicebox could not be checked. Set VOICEBOX_START_COMMAND or start Voicebox. {error}") from error
    if check.returncode:
        reason = check.stderr.strip().splitlines()[-1] if check.stderr.strip() else ""
        raise RuntimeError(reason or "Your saved voice isn't available because local Voicebox is not running on this computer. Set VOICEBOX_START_COMMAND or start Voicebox.")


def _voicebox_chunk_take(chunk: str, index: int, request_audio, out_dir: Path,
                        profile_id: str, engine: str) -> tuple[bytes, dict]:
    """Bounded per-chunk retakes, with raw evidence and the selected voice pinned."""
    from audio_retake import CHUNK_TAKES, quality_rank, retain
    best = None
    attempts = []
    for attempt in range(CHUNK_TAKES):
        audio, gid = request_audio(chunk)
        audio_hash = retain(out_dir, audio, ".wav")
        request = {"chunk": index + 1, "take": attempt + 1, "generation": gid,
                   "profileId": profile_id, "engine": engine, "text": chunk, "audioSha256": audio_hash}
        # Preserve the returned audio and generation identity even if local ASR fails.
        retain(out_dir, json.dumps(request, indent=2).encode(), ".json")
        words = transcribe(out_dir / "audio-attempts" / (audio_hash + ".wav"))
        qc = {**audio_qc(chunk, words), **request}
        qc_hash = retain(out_dir, json.dumps(qc, indent=2).encode(), ".json")
        attempts.append({**request, "qcSha256": qc_hash})
        if best is None or quality_rank(qc) < quality_rank(best[1]):
            best = (audio, qc, qc_hash)
        if not qc["changes"] and not qc["blocking"]:
            break
        log(f"Voicebox chunk {index + 1}, take {attempt + 1}/{CHUNK_TAKES}: "
            f"{len(qc['blocking'])} blocking, {len(qc['changes'])} transcript differences")
    return best[0], {"selectedGeneration": best[1]["generation"], "selectedQcSha256": best[2],
                     "blocking": best[1]["blocking"], "changes": best[1]["changes"], "attempts": attempts}


def synth_voicebox(text: str, out_wav: Path, profile: str, retakes=None) -> None:
    """Customer-owned local voice; no cloud call and no alternate-identity fallback."""
    import io
    import time
    import urllib.request
    import wave
    import numpy as np
    from voicebox_audio import sentence_chunks, prepare_pcm, join_chunks, SENTENCE_PAUSE_SEC, CLAUSE_PAUSE_SEC
    if not profile.strip():
        raise RuntimeError("Choose your own Voicebox profile in Voice & video first")
    ensure_voicebox()
    text = normalize_for_tts(text)
    # Fixed loopback service, redirects and environment proxies cannot export narration.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    base = "http://127.0.0.1:18000"
    with opener.open(base + '/profiles', timeout=30) as response:
        profiles = json.load(response)
    selected = next((p for p in profiles if p.get('id') == profile or p.get('name') == profile), None)
    if not selected:
        raise RuntimeError('The selected local voice no longer exists; choose it in Voicebox before retrying')
    engine = selected.get('default_engine') or selected.get('preset_engine') or 'qwen'
    profile_id = selected['id']
    if retakes is not None:
        retakes.bind_runtime(profile_id, engine)
    chunks = []
    receipts = []
    chunk_checks = []
    parameters = None
    speech = sentence_chunks(text)

    def request_audio(chunk):
        request = urllib.request.Request(base + "/speak", data=json.dumps({"profile": profile_id, "engine": engine, "personality": False, "text": chunk}).encode(), headers={"Content-Type": "application/json"})
        with opener.open(request, timeout=60) as response:
            started = json.load(response)
        gid = started.get("id", "")
        if not re.fullmatch(r"[A-Za-z0-9-]{1,100}", gid):
            raise RuntimeError("Local voice studio did not return a generation receipt")
        receipts.append(gid)
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            state = {}
            with opener.open(base + "/generate/" + gid + "/status", timeout=30) as response:
                for _ in range(20):
                    line = response.readline(65536).decode().strip()
                    if line.startswith("data:"):
                        state = json.loads(line[5:]); break
            if state.get("status") == "completed":
                break
            if state.get("status") in ("failed", "error"):
                raise RuntimeError("Local voice generation failed; hold the draft and check Voicebox")
            time.sleep(2)
        else:
            raise RuntimeError("Local voice generation timed out; check its receipt before retrying")
        with opener.open(base + "/audio/" + gid, timeout=60) as response:
            audio = response.read(50 * 1024 * 1024 + 1)
        if len(audio) > 50 * 1024 * 1024:
            raise RuntimeError("Unexpected local voice audio size")
        return audio, gid

    for index, chunk in enumerate(speech):
        audio, check = _voicebox_chunk_take(chunk, index, request_audio, out_wav.parent, profile_id, engine)
        chunk_checks.append(check)
        with wave.open(io.BytesIO(audio), "rb") as wav:
            current = (wav.getnchannels(), wav.getsampwidth(), wav.getframerate())
            if parameters and current != parameters:
                raise RuntimeError("Local voice chunks have different audio formats")
            if current[1] != 2:
                raise RuntimeError('Local voice must return 16-bit PCM audio')
            parameters = current
            chunks.append(prepare_pcm(wav.readframes(wav.getnframes()), current[0], current[2]))
    if not parameters or not chunks:
        raise RuntimeError("Local voice studio returned no speech")
    raw = out_wav.with_suffix(".raw.wav")
    pcm, spans = join_chunks(chunks, speech, parameters[2])
    try:
        with wave.open(str(raw), "wb") as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(parameters[2])
            wav.writeframes((pcm * 32767).astype('<i2').tobytes())
        convert_to_wav(raw, out_wav)
        out_wav.with_name('voice-receipt.json').write_text(json.dumps({'profileId': profile_id, 'profileName': selected.get('name'), 'engine': engine, 'generations': receipts, 'selectedGenerations': [c['selectedGeneration'] for c in chunk_checks], 'chunkChecks': chunk_checks, 'chunks': spans, 'chunksTimebase': 'before speed adjustment', 'audioSha256': hashlib.sha256(out_wav.read_bytes()).hexdigest(), 'processing': {'sentencePauseSec': SENTENCE_PAUSE_SEC, 'clausePauseSec': CLAUSE_PAUSE_SEC, 'targetRms': 0.075, 'peakLimit': 0.95, 'fadeSec': 0.003}, 'listeningApproved': False}, indent=2))
    finally:
        raw.unlink(missing_ok=True)


def wav_duration(wav: Path) -> float:
    import soundfile as sf

    info = sf.info(str(wav))
    return info.frames / info.samplerate


# Transcript QA follows raw-ASR comparison, before alignment replaces
# recognized words with script words. ASR differences are evidence, not listening approval.
AUDIO_QC_VERSION = 1
_QC_NUMBERS = dict(zip("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(), range(20)))
_QC_NUMBERS.update(dict(zip("twenty thirty forty fifty sixty seventy eighty ninety".split(), range(20, 100, 10))))
_QC_SCALES = {"hundred": 100, "thousand": 1000, "million": 1000000, "billion": 1000000000}
_QC_MONTHS = set("january february march april may june july august september october november december".split())
_QC_ORDINALS = dict(zip("first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth".split(), range(1, 21)))
_QC_DIGIT_PLURALS = dict(zip("zero one two three four five six seven eight nine".split(), "zeros ones twos threes fours fives sixes sevens eights nines".split()))


def _qc_tokens(text: str) -> list[str]:
    # ASR can split a sports-score hyphen into a signed-looking next token.
    # Only a contextual digit-dash-digit score is equivalent; the WORD minus is not.
    text = normalize_score_speech(text, asr_punctuation=True, spoken_scores=True)
    text = text.lower().replace("’", "'").replace("share-able", "shareable").replace("lyve", "live")
    # Counted number names: "10 fours" may be written "10 -4s" by ASR.
    # Require an explicit preceding count, a single-digit plural and no spoken
    # "minus". An isolated -4s or a Roman numeral never supplies missing speech.
    count = r"(?:\d+|" + "|".join(_QC_NUMBERS) + r")"
    plural = r"(?:[0-9]|" + "|".join(_QC_DIGIT_PLURALS) + r")"
    def counted_plural(match: re.Match) -> str:
        number = match[2]
        word = list(_QC_DIGIT_PLURALS)[int(number)] if number.isdigit() else number
        return match[1] + " " + _QC_DIGIT_PLURALS[word]
    text = re.sub(r"\b(" + count + r")\s+(?:[-–]\s*)?(" + plural + r")'?s\b", counted_plural, text)
    # Cricket's "114 not out" can be transcribed "114 knot out". The negation
    # sound is present; restrict the spelling equivalence to a numeric cricket
    # score with nearby balls/wickets/innings context. Missing "not" still fails.
    def cricket_not_out(match: re.Match) -> str:
        context = text[max(0, match.start() - 100):match.end() + 150]
        return match[1] + " not out" if re.search(r"\b(?:cricket|balls|wickets?|innings|t20|odi)\b", context) else match[0]
    text = re.sub(r"\b(\d{1,4})\s+knot\s+out\b", cricket_not_out, text)
    # Equivalent ASR contractions must not turn a retained negation into a new veto.
    contractions = {"cannot": "can not", "can't": "can not", "won't": "will not", "isn't": "is not", "wasn't": "was not", "don't": "do not", "doesn't": "does not", "didn't": "did not", "I'm": "I am"}
    for spelling, spoken in contractions.items():
        text = re.sub(r"\b" + re.escape(spelling.lower()) + r"\b", spoken.lower(), text)
    # ASR writes a spoken year range "2024-25" / "2025-2026" as "2024 -25"; rejoin it before the
    # minus rule so the split never reads as a negation. Only a four-digit year followed by a
    # two- or four-digit year qualifies; scores, offsets and the spoken word "minus" are untouched.
    text = re.sub(r"(?<=\b\d{4})\s+-(?=\d{2}(?:\d{2})?\b)", "-", text)
    text = re.sub(r"(?<![\w])-(?=\d)", "minus ", text)
    # Preserve explicit thousands punctuation across ASR word boundaries (7 + ,200).
    # Plain adjacent numbers stay separate; never infer missing thousands punctuation.
    text = re.sub(r"(?<=\d)\s*,\s*(?=\d{3}(?:\D|$))", "", text)
    # Whisper sometimes separates the fractional part into a new whitespace token.
    text = re.sub(r"(\d)\s+\.(\d)", r"\1.\2", text)
    raw = re.findall(r"\d+(?:\.\d+)?(?:st|nd|rd|th)?|[^\W\d_]+(?:'[^\W\d_]+)*|[%$€£&+=]", text, re.UNICODE)
    symbols = {"%": "percent", "&": "and", "+": "plus", "=": "equals"}
    result, i = [], 0
    while i < len(raw):
        token = raw[i]
        if token in {"$", "€", "£"}:
            # Currency position changes in speech; the unit remains checked separately below.
            result.append({"$": "dollars", "€": "euros", "£": "pounds"}[token]); i += 1; continue
        calendar = bool(result and (result[-1] in _QC_MONTHS or len(result) > 1 and result[-1] == "the" and result[-2] in _QC_MONTHS))
        if calendar:
            day = _QC_ORDINALS.get(token)
            match = re.fullmatch(r"(\d{1,2})(?:st|nd|rd|th)?", token)
            if day is None and match: day = int(match[1])
            if day is not None and 1 <= day <= 31:
                result.append(str(day)); i += 1; continue
        if re.fullmatch(r"\d+(?:\.\d+)?", token):
            value = Decimal(token); i += 1
            if i < len(raw) and raw[i] in _QC_SCALES:
                value *= _QC_SCALES[raw[i]]; i += 1
            result.append(format(value.normalize(), "f")); continue
        if token in _QC_NUMBERS or token in _QC_SCALES:
            j, parts = i, []
            while j < len(raw) and (raw[j] in _QC_NUMBERS or raw[j] in _QC_SCALES or raw[j] == "point" or raw[j] == "and" and any(p in _QC_SCALES for p in parts) and j + 1 < len(raw) and raw[j + 1] in _QC_NUMBERS):
                parts.append(raw[j]); j += 1
            integer_parts = parts[:parts.index("point")] if "point" in parts else parts
            value, group = 0, 0
            if len(integer_parts) >= 2 and integer_parts[0] in {"nineteen", "twenty"} and _QC_NUMBERS.get(integer_parts[1], 0) >= 20:
                group = _QC_NUMBERS[integer_parts[0]] * 100 + sum(_QC_NUMBERS.get(p, 0) for p in integer_parts[1:])
            else:
                for part in integer_parts:
                    if part == "hundred": group = max(group, 1) * 100
                    elif part in _QC_SCALES: value += max(group, 1) * _QC_SCALES[part]; group = 0
                    else: group += _QC_NUMBERS.get(part, 0)
            number = str(value + group)
            if "point" in parts:
                decimals = parts[parts.index("point") + 1:]
                decimal_scale = _QC_SCALES.get(decimals[-1], 1) if decimals else 1
                if decimal_scale != 1: decimals = decimals[:-1]
                if not decimals or any(p not in _QC_NUMBERS or _QC_NUMBERS[p] > 9 for p in decimals):
                    result.extend(parts); i = j; continue
                number += "." + "".join(str(_QC_NUMBERS[p]) for p in decimals)
                number = str(Decimal(number) * decimal_scale)
            result.append(format(Decimal(number).normalize(), "f")); i = j; continue
        result.append(symbols.get(token, token.replace("'", ""))); i += 1
    # A unit preceding its quantity ($45) and following it (45 dollars) are equivalent.
    for i in range(len(result) - 1):
        if result[i] in {"dollars", "euros", "pounds"} and re.fullmatch(r"\d+(?:\.\d+)?", result[i + 1]):
            result[i], result[i + 1] = result[i + 1], result[i]
    return result


_QC_UNIT_VARIANTS = {
    **dict.fromkeys(("metre", "metres", "meter", "meters"), "meters"),
    **dict.fromkeys(("kilometre", "kilometres", "kilometer", "kilometers", "km"), "kilometers"),
    **dict.fromkeys(("mile", "miles"), "miles"),
    **dict.fromkeys(("yard", "yards"), "yards"),
    **dict.fromkeys(("foot", "feet"), "feet"),
    **dict.fromkeys(("percent", "percentage"), "percent"),
    **dict.fromkeys(("dollar", "dollars"), "dollars"),
    **dict.fromkeys(("euro", "euros"), "euros"),
    **dict.fromkeys(("pound", "pounds"), "pounds"),
    **dict.fromkeys(("run", "runs"), "runs"),
    **dict.fromkeys(("wicket", "wickets"), "wickets"),
    # Retain the kind as well as its count: ten fours is not ten sixes.
    **{plural: plural for plural in _QC_DIGIT_PLURALS.values()},
}


def _qc_quantities(tokens: list[str]) -> list[tuple[str, str]]:
    # Bind common measurement/currency units to their quantity, not an unrelated name.
    return [(tokens[i - 1], _QC_UNIT_VARIANTS[token]) for i, token in enumerate(tokens)
            if i and token in _QC_UNIT_VARIANTS and re.fullmatch(r"\d+(?:\.\d+)?", tokens[i - 1])]


def audio_qc(script: str, whisper_words: list[dict]) -> dict:
    requested = _qc_tokens(normalize_for_tts(script))
    heard_text = " ".join(w["w"] for w in whisper_words)
    heard = _qc_tokens(heard_text)
    changes, blocking = [], []
    matcher = difflib.SequenceMatcher(a=requested, b=heard, autojunk=False)
    for op, a, b, c, d in matcher.get_opcodes():
        if op == "equal": continue
        before, after = requested[a:b], heard[c:d]
        # Pure compound/acronym spacing is a common ASR spelling variant, not lost speech.
        if before and after and not any(re.search(r"\d", t) for t in before + after) and "".join(before) == "".join(after): continue
        finding = {"kind": op, "requested": before, "heard": after}
        changes.append(finding)
        negations = {"no", "not", "never", "without", "cannot", "cant", "dont", "doesnt", "didnt", "isnt", "wasnt", "wont", "minus", "negative"}
        if [t for t in before if t in negations] != [t for t in after if t in negations]:
            blocking.append({**finding, "reason": "negation differs in the recognized transcript"})
        elif op == "delete" and len(before) >= 3:
            blocking.append({**finding, "reason": "three or more consecutive requested words are absent"})
    numbers = lambda words: [t for t in words if re.fullmatch(r"\d+(?:\.\d+)?", t)]
    if numbers(requested) != numbers(heard):
        blocking.append({"reason": "recognized numeric values differ", "requested": numbers(requested), "heard": numbers(heard)})
    if _qc_quantities(requested) != _qc_quantities(heard):
        blocking.append({"reason": "recognized measurement or currency units differ", "requested": _qc_quantities(requested), "heard": _qc_quantities(heard)})
    if not heard or not requested or changes and matcher.ratio() < 0.65:
        blocking.append({"reason": "recognized transcript is empty or substantially differs from the requested script"})
    return {"version": AUDIO_QC_VERSION, "normalizationVersion": 8, "status": "hold" if blocking else "pass", "method": "raw-asr-script-comparison", "requestedText": script, "synthesisText": normalize_for_tts(script), "heardWords": whisper_words, "changes": changes, "blocking": blocking, "listeningApproved": False, "policy": "Numeric or measurement/currency unit changes, lost negation, consecutive omissions and substantial transcript mismatch hold. Other ASR wording/name differences are warnings; this does not prove voice identity, stress, pronunciation or listening acceptance."}


def reusable_raw_transcript(out_dir: Path, text: str, engine: str, voice: str) -> tuple[list[dict], str] | None:
    """Reuse only raw ASR bound to identical audio, speech input, script and voice."""
    audio, receipt = out_dir / "audio.wav", out_dir / "audio-qc.json"
    if not audio.exists() or not receipt.exists():
        return None
    try:
        raw = receipt.read_bytes()
        qc = json.loads(raw)
        words = qc.get("heardWords")
        audio_hash = hashlib.sha256(audio.read_bytes()).hexdigest()
        post = qc.get("postProcessing")
        unchanged_post = (isinstance(post, dict) and post.get("speedFactor") == 1
                          and post.get("audioSha256") == audio_hash == qc.get("audioSha256"))
        if (qc.get("version") != AUDIO_QC_VERSION or qc.get("status") not in {"pass", "hold"}
            or qc.get("method") != "raw-asr-script-comparison" or post and not unchanged_post
            or qc.get("engine") != engine or qc.get("voice") != voice
            or qc.get("requestedText") != text or qc.get("synthesisText") != normalize_for_tts(text)
            or qc.get("scriptSha256") != hashlib.sha256(text.encode()).hexdigest()
            or qc.get("audioSha256") != audio_hash
            or not isinstance(words, list) or not words):
            return None
        for word in words:
            if (not isinstance(word, dict) or not isinstance(word.get("w"), str) or not word["w"].strip()
                or any(not isinstance(word.get(k), (int, float)) or isinstance(word[k], bool) or not math.isfinite(word[k]) for k in ("start", "end"))
                or word["start"] < 0 or word["end"] < word["start"]):
                return None
        return words, hashlib.sha256(raw).hexdigest()
    except (OSError, ValueError, TypeError):
        return None


def preserve_audio_attempt(out_dir: Path) -> None:
    """Keep original candidate bytes and receipt before synthesis or QA replaces them."""
    from audio_retake import retain
    for name in ("audio.wav", "audio-qc.json", "voice-receipt.json", "timestamps.json"):
        source = out_dir / name
        if source.exists():
            retain(out_dir, source.read_bytes(), source.suffix)


def bound_audio_qc(out_dir: Path, text: str, words: list[dict], engine: str, voice: str) -> dict:
    qc = audio_qc(text, words)
    qc.update({"engine": engine, "voice": voice, "scriptSha256": hashlib.sha256(text.encode()).hexdigest(),
               "audioSha256": hashlib.sha256((out_dir / "audio.wav").read_bytes()).hexdigest()})
    if engine == "voicebox":
        receipt = json.loads((out_dir / "voice-receipt.json").read_text())
        for i, check in enumerate(receipt.get("chunkChecks", [])):
            for finding in check["blocking"]:
                qc["blocking"].append({**finding, "chunk": i + 1,
                                       "reason": f"chunk {i + 1}: {finding['reason']}"})
        if qc["blocking"]:
            qc["status"] = "hold"
    return qc


def concatenate_local_chunks(chunks: list[bytes], output: Path) -> None:
    """Preserve the selected voice; join only independently checked PCM takes."""
    import io
    import numpy as np
    import soundfile as sf
    parts = [sf.read(io.BytesIO(raw), dtype="float32", always_2d=True) for raw in chunks]
    rate, channels = parts[0][1], parts[0][0].shape[1]
    if any(sr != rate or data.shape[1] != channels or not len(data) for data, sr in parts):
        raise RuntimeError("Local narration chunks have incompatible audio formats")
    silence = np.zeros((round(rate * .12), channels), dtype=np.float32)
    joined = []
    for data, _ in parts:
        if joined: joined.append(silence)
        joined.append(data)
    sf.write(str(output), np.concatenate(joined), rate, subtype="PCM_16")


def corrected_voicebox(out_dir: Path, text: str, voice: str, reuse) -> dict:
    """Keep the best whole take together with its exact raw evidence."""
    from audio_retake import VoiceboxRetakes, WHOLE_TAKES
    retakes = VoiceboxRetakes(out_dir, text, normalize_for_tts(text), voice)
    qc = retakes.restore()
    if qc is None and reuse:
        # A legacy held raw candidate remains usable; reserve its original take once.
        qc = bound_audio_qc(out_dir, text, reuse[0], "voicebox", voice)
        qc["reusedRawTranscriptReceiptSha256"] = reuse[1]
        take = retakes.reserve()
        retakes.complete(take, qc, (out_dir / "voice-receipt.json").read_bytes())
    if qc is not None:
        # A normalization correction can re-check original ASR without synthesis.
        fresh = bound_audio_qc(out_dir, text, qc["heardWords"], "voicebox", voice)
        if not fresh["changes"] and not fresh["blocking"]:
            fresh["correction"] = retakes.restore()["correction"]
            if reuse:
                fresh["reusedRawTranscriptReceiptSha256"] = reuse[1]
            (out_dir / "audio-qc.json").write_text(json.dumps(fresh, indent=2))
            return fresh
    while len(retakes.state["attempts"]) < WHOLE_TAKES:
        take = retakes.reserve()  # persisted before any new Voicebox generation
        preserve_audio_attempt(out_dir)
        (out_dir / "audio.wav").unlink(missing_ok=True)
        (out_dir / "voice-receipt.json").unlink(missing_ok=True)
        try:
            log(f"Voicebox whole take {take}/{WHOLE_TAKES}; keep the best verified candidate")
            synth_voicebox(normalize_for_tts(text), out_dir / "audio.wav", voice, retakes)
            words = transcribe(out_dir / "audio.wav")
            current = bound_audio_qc(out_dir, text, words, "voicebox", voice)
            (out_dir / "audio-qc.json").write_text(json.dumps(current, indent=2))
            retakes.complete(take, current, (out_dir / "voice-receipt.json").read_bytes())
        except Exception as error:
            # A failed new request never leaves worse/incomplete bytes beside an old score.
            preserve_audio_attempt(out_dir)
            retakes.failed(take, error)
            retakes.restore()
            raise
        qc = retakes.restore()
        if not qc["changes"] and not qc["blocking"]:
            break
    if qc is None:
        raise RuntimeError("Local audio correction allowance exhausted without a checked candidate; private attempts retained")
    return qc


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--voice", default="af_heart")
    # Retained for existing Node callers. Engine selection never substitutes another voice.
    ap.add_argument("--kokoro-voice", default="af_heart")
    ap.add_argument("--engine", choices=["voicebox", "kokoro", "edge", "elevenlabs", "resemble"], default="kokoro")
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_wav = out_dir / "audio.wav"
    text = Path(args.text_file).read_text().strip()
    # Synthesis input gets the pronunciation fixes; captions/alignment keep the original `text`.
    synth_text = normalize_for_tts(text)

    engine = args.engine
    reuse = reusable_raw_transcript(out_dir, text, engine, args.voice)
    if engine == "kokoro" and reuse is None:
        from kokoro_correction import correction_path
        record = correction_path(out_dir, text, args.voice)
        if record.exists():
            current = hashlib.sha256(synth_text.encode()).hexdigest()
            try:
                saved = json.loads(record.read_text()).get("identity") or {}
            except (OSError, ValueError):
                saved = {}
            if saved.get("synthesisSha256") == current or not saved.get("synthesisSha256"):
                raise RuntimeError("Existing local audio correction cannot restart whole narration; its original evidence or synthesis settings changed")
            # The script is unchanged but the harness now speaks it differently (a pronunciation or score rule was
            # corrected). The old correction belongs to the old speech: keep it as evidence under a superseded name
            # and take fresh narration with its own correction allowance. A same-speech retry stays spent above.
            archived = record.with_name(f"{record.stem}.superseded-{current[:12]}.json")
            record.rename(archived)
            log(f"superseded local audio correction archived as {archived.name}; taking fresh narration with the corrected speech")
    preserve_audio_attempt(out_dir)
    if engine == "voicebox":
        qc = corrected_voicebox(out_dir, text, args.voice, reuse)
        whisper_words = qc["heardWords"]
    elif reuse:
        whisper_words = reuse[0]
        log("rechecking original hash-bound raw ASR; synthesis input and audio are unchanged")
    else:
        # The prior take is archived above. A fresh synthesis must produce new bytes;
        # an existing audio.wav must not mask a provider's suffixed or missing output.
        out_wav.unlink(missing_ok=True)
        if engine == "elevenlabs":
            synth_elevenlabs(synth_text, out_wav, args.voice)
        if engine == "resemble":
            synth_resemble(synth_text, out_wav, args.voice)
        if engine == "kokoro":
            try:
                log("synthesizing with kokoro (mlx)...")
                synth_kokoro(synth_text, out_wav, args.voice)
            except Exception as e:  # noqa: BLE001 — preserve the failure without switching providers
                raise RuntimeError(
                    "Selected local Kokoro synthesis failed; refusing to switch to online Edge TTS. "
                    "Check the local TTS dependencies and cached Kokoro model, then retry. "
                    "Select --engine edge explicitly only if you want Microsoft's online voice service."
                ) from e
        if engine == "edge":
            log("synthesizing with edge-tts...")
            synth_edge(synth_text, out_wav, args.voice if args.voice.endswith("Neural") else "en-US-AriaNeural")

        backend = "mlx-whisper" if platform.system() == "Darwin" and platform.machine().lower() in {"arm64", "aarch64"} else "faster-whisper/cpu"
        log(f"transcribing for word timestamps ({backend})...")
        whisper_words = transcribe(out_wav)
    if engine != "voicebox":
        qc = bound_audio_qc(out_dir, text, whisper_words, engine, args.voice)
        if reuse: qc["reusedRawTranscriptReceiptSha256"] = reuse[1]
    (out_dir / "audio-qc.json").write_text(json.dumps(qc, indent=2))
    if engine == "kokoro" and qc["blocking"]:
        from kokoro_correction import correct_kokoro_chunks
        log("Kokoro raw ASR held: correcting complete sentence groups once, retaining checked chunks")
        qc = correct_kokoro_chunks(out_dir, text, synth_text, args.voice, _speech_chunks(synth_text),
                                  synth_kokoro, transcribe, audio_qc, concatenate_local_chunks)
        whisper_words = qc["heardWords"]
        (out_dir / "audio-qc.json").write_text(json.dumps(qc, indent=2))
    if qc["blocking"]:
        raise RuntimeError("AUDIO QC HOLD: " + "; ".join(finding["reason"] for finding in qc["blocking"]) + ". Private audio and raw transcript retained in audio-qc.json; inspect the discrepancy before retrying.")
    for finding in qc["changes"]:
        log(f"AUDIO QC warning: {finding}")
    script_words = text.split()
    words = align(script_words, whisper_words)
    if engine == "voicebox":
        from voicebox_audio import constrain_to_chunks
        receipt = json.loads(out_wav.with_name('voice-receipt.json').read_text())
        words = constrain_to_chunks(words, receipt['chunks'])

    payload = {"durationSec": round(wav_duration(out_wav), 3), "engine": engine, "words": words}
    (out_dir / "timestamps.json").write_text(json.dumps(payload, indent=2))
    log(f"done: {payload['durationSec']}s, {len(words)} words, engine={engine}")


if __name__ == "__main__":
    main()
