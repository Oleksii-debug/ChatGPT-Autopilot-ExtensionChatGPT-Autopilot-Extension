"""Read kanji from a local, seekable kana dictionary, retaining surrounding punctuation."""
from functools import lru_cache
import json
from pathlib import Path
import unicodedata
import zlib


class JapaneseReading:
    def __init__(self, folder):
        folder = Path(folder)
        data = json.loads((folder / "index.json").read_bytes())
        self.index = data["entries"]
        self.variants = {int(code): value for code, value in data["variants"].items()}
        self.file = folder / "readings.bin"

    @lru_cache(maxsize=96)
    def readings(self, initial):
        location = self.index.get(initial)
        if location is None:
            return {}
        offset, length = location
        with self.file.open("rb") as source:
            source.seek(offset)
            return json.loads(zlib.decompress(source.read(length)))

    @lru_cache(maxsize=512)
    def pronounce(self, text):
        text = unicodedata.normalize("NFC", text).translate(self.variants)
        result = []
        previous = ""
        position = 0
        while position < len(text):
            char = text[position]
            entries = self.readings(char)
            for length, choices in entries.items():
                key = text[position:position + int(length)]
                if key not in choices:
                    continue
                kana = next((r for r, before in choices[key] if before is None or previous in before), None)
                if kana:
                    result.append(kana)
                    position += len(key)
                    previous = key
                    break
            else:
                result.append(char)
                previous = char
                position += 1
        return "".join(result)
