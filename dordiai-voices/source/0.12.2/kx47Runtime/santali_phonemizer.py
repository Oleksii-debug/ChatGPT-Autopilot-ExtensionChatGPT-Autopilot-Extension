# Upstream: kaushalkrishnax/santali-piper-vits, Apache-2.0.
# Pinned revision: 50da29423065a25393d58d48d83de21ad85c4d4d.
# Phonemizer copied unchanged below; see doc/third-party/Santali-Piper-NOTICE.txt.
"""Portable Santali (Ol Chiki) -> IPA / phoneme-token converter.

Reference basis:
- Unicode Standard / Ol Chiki encoding documentation.
- Michael Everson, Ol Chiki encoding proposal N2984.
- Richard Ishida, Ol Chiki (Santali) Orthography Notes.
- Unicode CLDR Santali Ol Chiki -> FONIPA transliteration data.

Design:
- No third-party dependencies.
- Deterministic and portable to Kotlin, Java, TypeScript, Rust, etc.
- santali_to_ipa() returns a readable IPA representation.
- santali_to_phonemes() returns atomic IPA tokens for a Piper ID map.

Phaarkaa is represented canonically as an ejective after the four relevant
consonants. There is no alternate mode in this file.
"""

from __future__ import annotations

import unicodedata
from typing import List

BASIC_CONSONANTS = {
    "ᱯ": "p",
    "ᱵ": "b",
    "ᱛ": "t",
    "ᱫ": "d",
    "ᱪ": "c",
    "ᱰ": "ɖ",
    "ᱴ": "ʈ",
    "ᱡ": "ɟ",
    "ᱠ": "k",
    "ᱜ": "ɡ",
    "ᱥ": "s",
    "ᱦ": "h",
    "ᱢ": "m",
    "ᱱ": "n",
    "ᱧ": "ɲ",
    "ᱬ": "ɳ",
    "ᱝ": "ŋ",
    "ᱣ": "w",
    "ᱶ": "w̃",
    "ᱨ": "r",
    "ᱲ": "ɽ",
    "ᱞ": "l",
    "ᱭ": "j",
}

VOWEL_BASES = {
    "ᱤ": "i",
    "ᱩ": "u",
    "ᱮ": "e",
    "ᱳ": "o",
    "ᱚ": "ɔ",
    "ᱟ": "a",
}

NASAL = "ᱸ"
DOT = "ᱹ"
NASAL_DOT = "ᱺ"
LONG = "ᱻ"
PHAARKAA = "ᱼ"
AHAD = "ᱽ"
ASPIRATION = "ᱷ"

GLOTTALIZED = {
    "ᱵ": ("b", "p̚", "pʼ"),
    "ᱡ": ("ɟ", "c̚", "cʼ"),
    "ᱫ": ("d", "t̚", "tʼ"),
    "ᱜ": ("ɡ", "k̚", "kʼ"),
}

PUNCTUATION_MAP = {
    "᱾": ".",
    "᱿": ".",
}


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = text.replace(DOT + NASAL, NASAL_DOT)
    text = text.replace(NASAL + DOT, NASAL_DOT)
    text = text.replace(LONG + DOT, DOT + LONG)
    text = text.replace(LONG + NASAL, NASAL + LONG)
    text = text.replace(LONG + NASAL_DOT, NASAL_DOT + LONG)
    return text


def _is_vowel_base(ch: str) -> bool:
    return ch in VOWEL_BASES


def _next_significant(text: str, index: int) -> int:
    while index < len(text) and text[index] in (
        DOT, NASAL, NASAL_DOT, LONG, AHAD, ASPIRATION
    ):
        index += 1
    return index


def _is_coda(text: str, consonant_end: int) -> bool:
    j = _next_significant(text, consonant_end)
    if j >= len(text):
        return True
    if text[j].isspace() or text[j] in ",!?;:()\"'“”‘’.":
        return True
    return not _is_vowel_base(text[j])


def _consume_vowel(text: str, i: int) -> tuple[str, int]:
    base = VOWEL_BASES[text[i]]
    i += 1

    modifier = None
    if i < len(text) and text[i] in (DOT, NASAL, NASAL_DOT):
        modifier = text[i]
        i += 1

    long_mark = False
    if i < len(text) and text[i] == LONG:
        long_mark = True
        i += 1

    if modifier == DOT:
        if base == "a":
            base = "ə"
        elif base == "e":
            base = "ɛ"
        elif base == "o":
            base = "ɔ"
    elif modifier == NASAL_DOT:
        if base == "a":
            base = "ə"
        elif base == "e":
            base = "ɛ"
        elif base == "o":
            base = "ɔ"
        base += "̃"
    elif modifier == NASAL:
        base += "̃"

    if long_mark:
        base += "ː"

    return base, i


def _consume_consonant(text: str, i: int) -> tuple[str, int]:
    ch = text[i]
    i += 1
    ipa = BASIC_CONSONANTS[ch]

    aspirated = False
    if i < len(text) and text[i] == ASPIRATION:
        ipa += "ʰ"
        aspirated = True
        i += 1

    if i < len(text) and text[i] == AHAD:
        if ch in GLOTTALIZED:
            i += 1
            return GLOTTALIZED[ch][0], i
        i += 1
        return ipa, i

    if (
        i < len(text)
        and text[i] == PHAARKAA
        and ch in GLOTTALIZED
        and not aspirated
    ):
        i += 1
        return GLOTTALIZED[ch][2], i

    if ch in GLOTTALIZED and not aspirated and _is_coda(text, i):
        ipa = GLOTTALIZED[ch][1]

    if ch == "ᱦ" and not aspirated and _is_coda(text, i):
        ipa = "ʔ"

    return ipa, i


def santali_to_ipa(text: str) -> str:
    """Convert modern Ol Chiki Santali orthography to reference IPA."""
    text = _normalize(text)
    out: List[str] = []
    i = 0

    while i < len(text):
        ch = text[i]

        if ch.isspace():
            out.append(ch)
            i += 1
            continue

        if ch in PUNCTUATION_MAP:
            out.append(PUNCTUATION_MAP[ch])
            i += 1
            continue

        if ch == PHAARKAA:
            out.append(" ")
            i += 1
            continue

        if ch in VOWEL_BASES:
            ipa, i = _consume_vowel(text, i)
            out.append(ipa)
            continue

        if ch in BASIC_CONSONANTS:
            ipa, i = _consume_consonant(text, i)
            out.append(ipa)
            continue

        out.append(ch)
        i += 1

    return "".join(out)


santhi_to_ipa = santali_to_ipa

_ATOMIC_IPA = sorted(
    {
        "p̚", "t̚", "c̚", "k̚",
        "pʼ", "tʼ", "cʼ", "kʼ",
        "pʰ", "bʰ", "tʰ", "dʰ", "ʈʰ", "ɖʰ", "cʰ", "ɟʰ", "kʰ", "ɡʰ", "ɽʰ",
        "w̃",
        "iː", "uː", "eː", "oː", "əː", "ɛː", "ɔː", "aː",
        "ĩ", "ũ", "ẽ", "õ", "ə̃", "ɛ̃", "ɔ̃", "ã",
        "ĩː", "ũː", "ẽː", "õː", "ə̃ː", "ɛ̃ː", "ɔ̃ː", "ãː",
        "ɟ", "ɲ", "ɳ", "ŋ", "ɽ", "ʈ", "ɖ", "ɡ", "ɔ", "ə", "ɛ",
    },
    key=len,
    reverse=True,
)


def tokenize_ipa(ipa: str) -> List[str]:
    """Split IPA into atomic Unicode-safe tokens for Piper."""
    tokens: List[str] = []
    i = 0

    while i < len(ipa):
        if ipa[i].isspace():
            tokens.append(ipa[i])
            i += 1
            continue

        for symbol in _ATOMIC_IPA:
            if ipa.startswith(symbol, i):
                tokens.append(symbol)
                i += len(symbol)
                break
        else:
            j = i + 1
            while j < len(ipa) and unicodedata.combining(ipa[j]):
                j += 1
            tokens.append(ipa[i:j])
            i = j

    return tokens


def santali_to_phonemes(text: str) -> List[str]:
    """Convert Ol Chiki Santali directly to atomic IPA phoneme tokens."""
    return tokenize_ipa(santali_to_ipa(text))
