"""Immutable, per-speaker navigation clips prepared during the add-on build."""
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
import wave
import numpy as np
from speech_tempo import change_tempo


def cache_name(language, text):
    return sha256((language + "\0" + text.strip().casefold()).encode("utf-8")).hexdigest()[:24] + ".wav"


@lru_cache(maxsize=256)
def read_clip(path):
    with wave.open(str(path), "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 24000):
            raise ValueError("Invalid navigation cache format")
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768


def load_clip(references, profile, language, text, speed):
    language = (language or "uk").lower().replace("_", "-")
    if language in {"en", "en-us"}:
        language = "en-us"
    path = Path(references) / "navigation" / profile / cache_name(language, text)
    if not path.is_file():
        return None
    return change_tempo(read_clip(path), 24000, speed)
