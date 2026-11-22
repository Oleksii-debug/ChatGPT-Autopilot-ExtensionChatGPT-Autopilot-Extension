"""Immutable per-speaker navigation clips, with a bounded decoded audio cache."""
from collections import OrderedDict
from hashlib import sha256
from pathlib import Path
from threading import RLock
import wave
import numpy as np
from speech_tempo import change_tempo


OUTPUT_RATE = 24000
MAX_CLIP_FRAMES = OUTPUT_RATE * 30
CACHE_BYTES = 16 * 1024 * 1024
CACHE_ITEMS = 256
_clips = OrderedDict()
_cache_size = 0
_cache_lock = RLock()


def cache_name(language, text):
    return sha256((language + "\0" + text.strip().casefold()).encode("utf-8")).hexdigest()[:24] + ".wav"


def clear_cache():
    global _cache_size
    with _cache_lock:
        _clips.clear()
        _cache_size = 0


def read_clip(path):
    """Read a validated WAV, invalidating cached content after package updates."""
    global _cache_size
    path = Path(path)
    stat = path.stat()
    key = (str(path.resolve()), stat.st_mtime_ns, stat.st_size)
    with _cache_lock:
        cached = _clips.get(key)
        if cached is not None:
            _clips.move_to_end(key)
            return cached
    with wave.open(str(path), "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, OUTPUT_RATE):
            raise ValueError("Invalid navigation cache format")
        count = wav.getnframes()
        if not 0 < count <= MAX_CLIP_FRAMES:
            raise ValueError("Invalid navigation clip length")
        pcm = wav.readframes(count)
        if len(pcm) != count * 2:
            raise ValueError("Truncated navigation clip")
        result = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        result.setflags(write=False)
    with _cache_lock:
        previous = _clips.pop(key, None)
        if previous is not None:
            _cache_size -= previous.nbytes
        _clips[key] = result
        _cache_size += result.nbytes
        while len(_clips) > CACHE_ITEMS or _cache_size > CACHE_BYTES:
            _, removed = _clips.popitem(last=False)
            _cache_size -= removed.nbytes
    return result


def load_clip(references, profile, language, text, speed):
    language = (language or "uk").lower().replace("_", "-")
    if language in {"en", "en-us"}:
        language = "en-us"
    base = Path(references) / "navigation"
    path = base / profile / cache_name(language, text)
    if not path.resolve().is_relative_to(base.resolve()):
        raise ValueError("Navigation profile escapes package")
    try:
        clip = read_clip(path)
    except (OSError, ValueError, EOFError, wave.Error):
        # A missing or damaged optimization must use the same configured
        # speaker's normal synthesis, never suppress a word or switch voices.
        return None
    return change_tempo(clip, OUTPUT_RATE, speed)
