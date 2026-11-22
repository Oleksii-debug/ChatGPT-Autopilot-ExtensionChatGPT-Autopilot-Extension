"""Read language-specific speaker recordings without importing the speech runtime."""
from functools import lru_cache
from hashlib import sha256
import json
from pathlib import Path


class NativeLetterBank:
    def __init__(self, references, folder="native_letters"):
        self.folder = Path(references) / folder if references else None

    @lru_cache(maxsize=8)
    def _index(self, profile):
        try:
            index = json.loads((self.folder / (profile + ".json")).read_text(encoding="utf8"))
        except (OSError, ValueError):
            return {}
        return index if isinstance(index, dict) else {}

    def read(self, profile, language, name):
        if (self.folder is None or not isinstance(profile, str) or profile in {"", ".", ".."}
                or any(ch in profile for ch in "/\\:\x00")):
            return None
        key = sha256((language + "\0" + name.strip().casefold()).encode("utf8")).hexdigest()[:24]
        entry = self._index(profile).get(key)
        if not isinstance(entry, list) or len(entry) != 2:
            return None
        offset, size = entry
        if (type(offset) is not int or type(size) is not int or offset < 0 or offset % 2
                or not 2 <= size <= 48000 * 8 or size % 2):
            return None
        try:
            with (self.folder / (profile + ".pcm")).open("rb") as stream:
                stream.seek(offset)
                pcm = stream.read(size)
        except (OSError, OverflowError):
            return None
        return pcm if len(pcm) == size else None
