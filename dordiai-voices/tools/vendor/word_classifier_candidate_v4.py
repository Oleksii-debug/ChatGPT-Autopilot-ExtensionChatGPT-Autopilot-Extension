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
FORMAT = "dordiai-word-lid-candidate-v4"


def normalize_word(word):
    text = unicodedata.normalize("NFC", word.casefold().replace("’", "'"))
    output = []
    for char in text:
        if char == "\u0301" and output and unicodedata.name(output[-1], "").startswith("CYRILLIC"):
            continue
        output.append(char)
    return "".join(output)




def word_script(word):
    # Keep historical model labels (including OTHER), while validating marks
    # against their actual Unicode-name family rather than that broad label.
    legacy_known = {"LATIN", "CYRILLIC", "GREEK", "ARABIC", "HEBREW", "DEVANAGARI", "BENGALI",
                    "GEORGIAN", "ARMENIAN", "THAI", "HIRAGANA", "KATAKANA", "HANGUL", "CJK"}
    explicit_families = legacy_known | {"GUJARATI", "GURMUKHI", "TAMIL", "TELUGU", "KANNADA",
        "MALAYALAM", "SINHALA", "MEETEI", "ORIYA", "LAO", "MYANMAR", "TIBETAN", "THAANA",
        "ETHIOPIC", "OL"}
    base_families, mark_families, legacy_scripts = set(), set(), set()
    for char in word:
        name = unicodedata.name(char, "")
        family = name.partition(" ")[0]
        if char.isalpha():
            base_families.add(family)
            legacy_scripts.add(family if family in legacy_known else "OTHER")
        elif unicodedata.category(char).startswith("M"):
            if family == "COMBINING":
                # Generic accents inherit the base; explicitly named script
                # marks must still match it, including an OTHER-labelled base.
                mark_families.update(script for script in explicit_families if script in name.split())
            else:
                mark_families.add(family)
    if (len(legacy_scripts) != 1 or len(base_families) != 1
            or not mark_families <= base_families):
        return None
    return next(iter(legacy_scripts))


def actual_native_family(word):
    """Actual Unicode base family, distinct from historical OTHER model labels."""
    families = {unicodedata.name(char, "").partition(" ")[0] for char in word if char.isalpha()}
    return next(iter(families)) if len(families) == 1 else None


def is_valid_word(word):
    """Accept native combining marks without allowing leading/detached marks."""
    if not isinstance(word, str) or not 1 <= len(word) <= 48:
        return False
    after_letter = False
    for char in word:
        if char.isalpha():
            after_letter = True
        elif unicodedata.category(char).startswith("M") and after_letter:
            continue
        elif char in "'-" and after_letter:
            after_letter = False
        else:
            return False
    return after_letter and word_script(word) is not None


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
        families = document.get("native_families")
        thresholds = document.get("per_predicted_class_thresholds")
        if (not isinstance(families, dict) or set(families) != set(self.codes)
                or not isinstance(thresholds, dict) or set(thresholds) != set(self.codes)):
            raise ValueError("Candidate requires complete native-family and class calibration metadata")
        self.native_families = {}
        self.class_thresholds = {}
        for code in self.codes:
            values = families[code]
            threshold = thresholds[code]
            if (not isinstance(values, list) or not values
                    or any(not isinstance(value, str) or not value for value in values)
                    or len(set(values)) != len(values)
                    or threshold is not None and (type(threshold) not in (int, float)
                        or not math.isfinite(threshold) or not .5 <= threshold <= 1.)):
                raise ValueError("Invalid candidate native-family or class calibration metadata")
            self.native_families[code] = frozenset(values)
            # None means untrusted/abstain; using 1.0 would still accept exact ties
            # or rounded certainty and is not a dependable disabled-class policy.
            self.class_thresholds[code] = threshold
        self.native_combining_marks = document.get("native_combining_marks") is True
        ambiguous = document.get("known_ambiguous_spellings", [])
        if not isinstance(ambiguous, list) or any(not isinstance(word, str) for word in ambiguous):
            raise ValueError("Invalid word classifier ambiguity guard")
        self.ambiguous_words = frozenset(ambiguous)
        self.default_weights = tuple(document["default_weights"])
        if len(self.default_weights) != len(self.codes):
            raise ValueError("Word classifier defaults do not match its labels")

    def scores(self, word):
        word = normalize_word(word)
        script = word_script(word)
        family = actual_native_family(word)
        if script is None or family is None:
            return []
        features = feature_indexes(word, self.dimensions)
        if not features:
            return []
        result = []
        for index, code in enumerate(self.codes):
            if script not in self.scripts[code] or family not in self.native_families[code]:
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
        if (len(word) < 4 or not is_valid_word(word)
                or (not getattr(self, "native_combining_marks", False)
                    and any(unicodedata.category(char).startswith("M") for char in word))
                or word in getattr(self, "ambiguous_words", ())):
            return None, 0.
        code, confidence, support = self.rank(word)
        # Rank against every eligible model language BEFORE the enabled filter.
        # Otherwise disabling competitors would spuriously inflate confidence.
        threshold = self.class_thresholds.get(code)
        if (not code or threshold is None or confidence < threshold or support < .25
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
