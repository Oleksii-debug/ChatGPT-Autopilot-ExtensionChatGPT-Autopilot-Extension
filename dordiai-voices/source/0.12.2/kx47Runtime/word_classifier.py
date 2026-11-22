"""Small offline character-ngram word classifier with calibrated abstention.

The bundled model is trained from recovered, weakly labelled lexical resources.
It generalises to held-out spellings; its scores do not prove the intended
language of an isolated homograph. Exact ambiguous lexicons take precedence.
"""
from array import array
import base64
from functools import lru_cache
import gzip
import json
import math
from pathlib import Path
import sys
import unicodedata
from zlib import crc32

MODEL_PATH = Path(__file__).with_name("models") / "WordLanguage" / "word-lid.json.gz"
FORMAT = "dordiai-word-lid-v1"


def normalize_word(word):
    text = unicodedata.normalize("NFC", word.casefold().replace("’", "'"))
    output = []
    for char in text:
        if char == "\u0301" and output and unicodedata.name(output[-1], "").startswith("CYRILLIC"):
            continue
        output.append(char)
    return "".join(output)


def word_script(word):
    scripts = set()
    for char in word:
        if not char.isalpha():
            continue
        name = unicodedata.name(char, "")
        family = name.partition(" ")[0]
        if family in {"LATIN", "CYRILLIC", "GREEK", "ARABIC", "HEBREW", "DEVANAGARI", "BENGALI",
                      "GEORGIAN", "ARMENIAN", "THAI", "HIRAGANA", "KATAKANA", "HANGUL", "CJK"}:
            scripts.add(family)
        else:
            scripts.add("OTHER")
    return next(iter(scripts)) if len(scripts) == 1 else None


def feature_indexes(word, dimensions):
    value = "^" + word + "$"
    return tuple(sorted({crc32(value[offset:offset + size].encode("utf8")) % dimensions
                         for size in (2, 3, 4) for offset in range(len(value) - size + 1)}))


class WordClassifier:
    def __init__(self, document):
        if document.get("format") != FORMAT:
            raise ValueError("Unsupported word language classifier format")
        self.codes = tuple(document["codes"])
        self.scripts = document["scripts"]
        self.dimensions = int(document["dimensions"])
        self.scale = float(document["quantization"])
        self.temperature = float(document["temperature"])
        self.threshold = float(document["minimum_confidence"])
        if (not self.codes or len(set(self.codes)) != len(self.codes) or not 256 <= self.dimensions <= 65536
                or self.scale <= 0 or self.temperature <= 0 or not .5 <= self.threshold <= 1.):
            raise ValueError("Invalid word classifier parameters")
        self.weights = array("h")
        self.weights.frombytes(base64.b64decode(document["weights"], validate=True))
        if sys.byteorder != "little":
            self.weights.byteswap()
        if len(self.weights) != self.dimensions * len(self.codes):
            raise ValueError("Word classifier weight count does not match its labels")
        self.default_weights = tuple(document["default_weights"])
        if len(self.default_weights) != len(self.codes):
            raise ValueError("Word classifier defaults do not match its labels")

    def scores(self, word):
        word = normalize_word(word)
        script = word_script(word)
        if script is None:
            return []
        features = feature_indexes(word, self.dimensions)
        if not features:
            return []
        result = []
        for index, code in enumerate(self.codes):
            if script not in self.scripts[code]:
                continue
            offset = index * self.dimensions
            score = sum(self.weights[offset + feature] for feature in features) / self.scale
            seen = sum(self.weights[offset + feature] > self.default_weights[index] for feature in features)
            result.append((code, score, seen / len(features)))
        return sorted(result, key=lambda row: row[1], reverse=True)

    def rank(self, word, temperature=None):
        rows = self.scores(word)
        if not rows:
            return None, 0., 0.
        temperature = temperature or self.temperature
        best = rows[0][1]
        denominator = sum(math.exp((score - best) / temperature) for _, score, _ in rows)
        return rows[0][0], 1. / denominator, rows[0][2]

    def predict(self, word, enabled_languages=None):
        word = normalize_word(word)
        if len(word) < 4 or len(word) > 48 or not all(char.isalpha() or char in "'-" for char in word):
            return None, 0.
        code, confidence, support = self.rank(word)
        # Rank against every eligible model language BEFORE the enabled filter.
        # Otherwise disabling competitors would spuriously inflate confidence.
        if (not code or confidence < self.threshold or support < .25
                or enabled_languages is not None and code not in enabled_languages):
            return None, 0.
        return code, confidence


@lru_cache(maxsize=1)
def model():
    try:
        with gzip.open(MODEL_PATH, "rt", encoding="utf8") as stream:
            return WordClassifier(json.load(stream))
    except (OSError, ValueError, KeyError, TypeError):
        return None


@lru_cache(maxsize=4096)
def _predict(word, enabled):
    classifier = model()
    return classifier.predict(word, enabled) if classifier is not None else (None, 0.)


def predict(word, enabled_languages=None):
    enabled = None if enabled_languages is None else tuple(sorted(enabled_languages))
    return _predict(normalize_word(word), enabled)
