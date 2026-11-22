"""Identify local Latin-script language spans using word frequency and context."""
from functools import lru_cache
import gzip
import json
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
def dictionary():
    with gzip.open(Path(__file__).with_name("latin_dictionary.json.gz"), "rt", encoding="utf8") as file:
        return json.load(file)


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


def _split_sentence(text, default="en"):
    """Use the preferred language when words are missing or ambiguous."""
    parts = list(LATIN.finditer(text))
    if not parts:
        yield default,text
        return
    size = len(CODES)
    fallback = CODES.index(default) if default in CODES else 0
    priors = [0.55 if j == fallback else 0. for j in range(size)]
    states = priors
    trace = []
    for idx,match in enumerate(parts):
        token = match.group()
        scores = word_scores(token)
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
    begin=0
    previous=labels[0]
    for i,label in enumerate(labels[1:],1):
        if label!=previous:
            boundary=parts[i].start()
            yield CODES[previous],text[begin:boundary].strip()
            begin=boundary
            previous=label
    yield CODES[previous],text[begin:].strip()


def split_latin(text, default="en"):
    """Start new sentences independently, preserving punctuation and spelling."""
    current = None
    for sentence in re.split(r"(?<=[.!?…])\s+", text):
        for code, run in _split_sentence(sentence, default):
            if current is None:
                current = code, run
            elif current[0] == code:
                current = code, current[1] + " " + run
            else:
                yield current
                current = code, run
    if current:
        yield current
