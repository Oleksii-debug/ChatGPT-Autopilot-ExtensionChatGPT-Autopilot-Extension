"""Identify local Latin-script language spans using word frequency and context."""
from functools import lru_cache
import gzip
import json
import importlib.util
from pathlib import Path
import re
from unicodedata import normalize

CODES = ("en", "sk", "pl", "de", "fr", "da", "it", "es")
EXTRA = frozenset(CODES[1:])
ALPHABET = "A-Za-zÀ-ÖØ-öø-ÿĀ-žȘșȚț"
LATIN = re.compile(rf"[{ALPHABET}]+(?:['’][{ALPHABET}]+)*")
LANGUAGES = {
    "uk": "Українська", "ru": "Російська", "en": "Англійська",
    "sk": "Словацька", "pl": "Польська", "de": "Німецька",
    "fr": "Французька", "da": "Данська", "it": "Італійська", "es": "Іспанська",
}
DISTINCT = (
    "",
    "ľĺŕäô",
    "ąęłńśźż",
    "ß",
    "œ",
    "æøå",
    "",
    "ñ¿¡",
)


@lru_cache(maxsize=1)
def routing_policy():
    spec = importlib.util.spec_from_file_location("_dordiai_latin_word_routing", Path(__file__).with_name("language_routing.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=1)
def dictionary():
    try:
        with gzip.open(Path(__file__).with_name("latin_dictionary.json.gz"), "rt", encoding="utf8") as file:
            return json.load(file)
    except (OSError, ValueError):
        # Missing optional dictionary must not break startup or spelling.
        return {}


@lru_cache(maxsize=4096)
def word_scores(token):
    token = normalize("NFC", token.casefold().replace("’", "'"))
    found = dictionary().get(token)
    if found is None:
        return (0.0,) * len(CODES)
    best = max(map(ord, found))
    if len(token) <= 2:
        scale = .32
    else:
        scale = 1.
    return tuple(max(-6., (ord(value)-best)/7.) * scale
                 + (2.2 if any(letter in token for letter in mark) else 0.)
                 for value,mark in zip(found,DISTINCT))


@lru_cache(maxsize=8192)
def word_candidates(token):
    """Plausible languages from the bundled frequency lexicon, not one label.

    The encoded lexicon contains low-frequency loans/names in several languages.
    Keep all alternatives close to the leading frequency; the relative margin
    is evidence, not a guarantee that another language lacks this spelling.
    """
    token = routing_policy().normalize_word(token)
    if len(token) < 2:
        return frozenset()
    row = dictionary().get(token)
    if not isinstance(row, str) or len(row) != len(CODES):
        return frozenset()
    found = [(code, ord(value)) for code, value in zip(CODES, row) if value != " "]
    if not found:
        return frozenset()
    best = max(score for _, score in found)
    return frozenset(code for code, score in found if best - score <= 24)


def _split_sentence(text, default="en", *, enabled_languages=None, mode="context", priorities=()):
    """Use the preferred language when words are missing or ambiguous."""
    policy = routing_policy()
    enabled = policy.enabled_keys(enabled_languages)
    default = policy.fallback_language(default, enabled, priorities)
    active_codes = tuple(code for code in CODES if enabled is None or code in enabled)
    parts = list(LATIN.finditer(text))
    if not parts or not active_codes:
        yield default,text
        return
    size = len(active_codes)
    indexes = [CODES.index(code) for code in active_codes]
    fallback = active_codes.index(default) if default in active_codes else 0
    priors = [0.55 if j == fallback else 0. for j in range(size)]
    states = priors
    trace = []
    for idx,match in enumerate(parts):
        token = match.group()
        full_scores = word_scores(token)
        scores = [full_scores[index] for index in indexes]
        delim = text[parts[idx-1].end():match.start()] if idx else ""
        cost = 1.0 if any(c in delim for c in ".!?;:\n—") else 2.75
        weighted = []
        back = []
        for j, score in enumerate(scores):
            k=max(range(size),key=lambda prev:states[prev]-(cost if prev!=j else 0.))
            weighted.append(states[k]-(cost if k!=j else 0.)+score+priors[j]*.42)
            back.append(k)
        states=weighted
        trace.append(back)
    final=max(range(size), key=lambda j:states[j]+priors[j]*.55)
    labels=[final]
    for back in reversed(trace[1:]):
        labels.append(back[labels[-1]])
    labels.reverse()
    labels = [active_codes[index] for index in labels]
    current = default
    for i, match in enumerate(parts):
        candidates = word_candidates(match.group())
        if enabled is not None:
            candidates = candidates & enabled
        if len(match.group()) <= 1:
            labels[i] = current
        elif mode == "words" or len(candidates) == 1:
            labels[i] = policy.resolve_word(match.group(), current, enabled,
                                            candidates=candidates, priorities=priorities,
                                            classifier=lambda token: policy.classify_word(token, enabled)).language
        current = labels[i]
    begin=0
    previous=labels[0]
    for i,label in enumerate(labels[1:],1):
        if label!=previous:
            boundary=parts[i].start()
            yield previous,text[begin:boundary].strip()
            begin=boundary
            previous=label
    yield previous,text[begin:].strip()


def split_latin(text, default="en", *, enabled_languages=None, mode="context", priorities=(), explicit=False):
    """Route context or independent word lists; never select a disabled language."""
    if mode not in {"context", "words"}:
        raise ValueError("Unknown language routing mode: " + str(mode))
    if explicit:
        yield routing_policy().fallback_language(default, enabled_languages, priorities), text
        return
    current = None
    for sentence in re.split(r"(?<=[.!?…])\s+", text):
        for code, run in _split_sentence(sentence, default, enabled_languages=enabled_languages,
                                         mode=mode, priorities=priorities):
            if current is None:
                current = code, run
            elif current[0] == code:
                current = code, current[1] + " " + run
            else:
                yield current
                current = code, run
    if current:
        yield current
