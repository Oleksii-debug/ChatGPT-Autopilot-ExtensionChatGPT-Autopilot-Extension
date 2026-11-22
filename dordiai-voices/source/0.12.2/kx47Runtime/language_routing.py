"""Offline routing policy shared by the NVDA and worker language planners.

A lexical candidate is evidence, not proof of the language intended by an author.
In particular, homographs retain all candidates and obey the user's preference.
No model or dictionary is loaded by this module.
"""
from collections import namedtuple
from functools import lru_cache
import importlib.util
from pathlib import Path
import unicodedata

_code_spec = importlib.util.spec_from_file_location("_dordiai_shared_language_codes", Path(__file__).with_name("language_codes.py"))
_codes = importlib.util.module_from_spec(_code_spec)
_code_spec.loader.exec_module(_codes)
ALIASES = _codes.ALIASES
WordDecision = namedtuple("WordDecision", "language candidates ambiguous source confidence")


def language_key(value):
    return _codes.canonical_language(value)


def normalize_word(word):
    # Keep diacritics except an explicitly supplied stress accent. NFC makes
    # decomposed vowel+accent input agree with the stored dictionary spelling.
    value = unicodedata.normalize("NFC", word.casefold().replace("’", "'"))
    result = []
    for char in value:
        if char == "\u0301" and result and unicodedata.name(result[-1], "").startswith("CYRILLIC"):
            continue
        result.append(char)
    return "".join(result)


def enabled_keys(enabled_languages):
    if enabled_languages is None:
        return None
    enabled = frozenset(filter(None, map(language_key, enabled_languages)))
    if not enabled:
        raise ValueError("At least one language must be enabled")
    return enabled


def fallback_language(preferred, enabled_languages=None, priorities=()):
    enabled = enabled_keys(enabled_languages)
    preferred = language_key(preferred)
    if enabled is None or preferred in enabled:
        return preferred
    for value in priorities:
        code = language_key(value)
        if code in enabled:
            return code
    # A stable result independent of set/hash iteration and no disabled route.
    return sorted(enabled)[0]


def resolve_word(word, preferred="uk", enabled_languages=None, *, candidates=(),
                 classifier=None, priorities=(), explicit=False, confidence_threshold=.92):
    """Resolve a word while exposing ambiguity and respecting enabled languages.

    ``candidates`` is a collection of plausible dictionary languages. A string
    is one language, not a sequence of letters. ``classifier`` is optional and
    returns (language, confidence); it cannot erase a known lexical ambiguity.
    A single letter always inherits the current language in automatic mode.
    """
    enabled = enabled_keys(enabled_languages)
    default = fallback_language(preferred, enabled, priorities)
    if explicit:
        return WordDecision(default, (default,), False, "explicit", 1.)
    token = normalize_word(word)
    if sum(char.isalpha() for char in token) <= 1:
        return WordDecision(default, (), False, "current-language", 0.)
    if isinstance(candidates, str):
        candidates = (candidates,)
    choices = frozenset(language_key(code) for code in candidates if code)
    choices = frozenset(code for code in choices if enabled is None or code in enabled)
    ordered = tuple(sorted(choices))
    if len(choices) == 1:
        return WordDecision(ordered[0], ordered, False, "lexicon", 1.)
    if choices:
        if default in choices:
            chosen = default
        else:
            chosen = next((language_key(code) for code in priorities if language_key(code) in choices), ordered[0])
        return WordDecision(chosen, ordered, True, "ambiguous-lexicon", 0.)
    if classifier is not None:
        code, confidence = classifier(token)
        code = language_key(code)
        if code and (enabled is None or code in enabled) and confidence >= confidence_threshold:
            return WordDecision(code, (code,), False, "classifier", float(confidence))
    return WordDecision(default, (), False, "fallback", 0.)


@lru_cache(maxsize=1)
def classifier_module():
    spec = importlib.util.spec_from_file_location("_dordiai_trained_word_classifier", Path(__file__).with_name("word_classifier.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def classify_word(word, enabled_languages=None):
    """Unknown-word-only trained classifier; (None, 0) means abstention."""
    return classifier_module().predict(word, enabled_keys(enabled_languages))


def has_word_classifier():
    return classifier_module().model() is not None


def classifier_languages():
    """Labels actually learned by the bundled word model, not the full catalogue."""
    model = classifier_module().model()
    return frozenset(model.codes) if model is not None else frozenset()
