"""English phonetics rendered by the selected Ukrainian acoustic voice.

English-to-Ukrainian phone substitutions are adapted from the RHVoice
Ukrainian phonetic mapping (Olga Yakovleva, LGPL-2.1-or-later), with
stress-preserving orthography for ipa-uk. See doc/third-party/RHVoice-Ukrainian.
"""
from functools import lru_cache
from speech_text import english_text, split_mixed

PHONE_MAP = {
    "eɪ": "ей", "aɪ": "ай", "aʊ": "ау", "oʊ": "оу", "əʊ": "оу", "ɔɪ": "ой",
    "dʒ": "дж", "tʃ": "ч", "ɚ": "ер", "ɝ": "ор", "ɜ": "ор", "ɑ": "а", "ɒ": "о",
    "æ": "а", "ʌ": "а", "ə": "е", "ɛ": "е", "e": "е", "ɔ": "о", "o": "о",
    # Keep English KIT and FLEECE distinct in the selected Ukrainian voice.
    # Mapping both to і merged ship/sheep, sit/seat and live/leave.
    "ɪ": "и", "ᵻ": "и", "i": "і", "ʊ": "у", "u": "у", "a": "а", "ɐ": "а",
    "b": "б", "d": "д", "f": "ф", "ɡ": "ґ", "g": "ґ", "h": "г", "ʒ": "ж",
    "k": "к", "l": "л", "ɫ": "л", "m": "м", "n": "н", "ŋ": "нґ", "p": "п",
    "ŋɡ": "нґ", "ŋg": "нґ", "ŋk": "нк", "n̩": "ен", "l̩": "ел",
    "ɹ": "р", "r": "р", "ɾ": "т", "s": "с", "ʃ": "ш", "t": "т", "θ": "т",
    "ð": "д", "v": "в", "w": "в", "j": "й", "z": "з", "ː": "", "ˌ": "",
    "̩": "", "ʲ": "ь", "ʔ": "т",
}


def ukrainian_spelling(phones):
    output, stress, cursor = [], False, 0
    while cursor < len(phones):
        if phones[cursor] == "ˈ":
            stress = True
            cursor += 1
            continue
        key = phones[cursor:cursor+2] if phones[cursor:cursor+2] in PHONE_MAP else phones[cursor]
        value = PHONE_MAP.get(key, key)
        if stress:
            for i, char in enumerate(value):
                if char in "аеєиіїоуюя":
                    value = value[:i+1] + "\u0301" + value[i+1:]
                    stress = False
                    break
        if any(char.isspace() or char in ".,!?;:" for char in value):
            stress = False
        output.append(value)
        cursor += len(key)
    return "".join(output)


@lru_cache(maxsize=1)
def phonemizer():
    from piper.phonemize_espeak import EspeakPhonemizer
    return EspeakPhonemizer()


@lru_cache(maxsize=1024)
def english_phones(text, accent="en-us"):
    from ipa_uk import ipa
    from ukrainian_stress import accent_text
    # The user's numbers remain Ukrainian even inside English text. Combine
    # everything before acoustic synthesis, so number boundaries do not switch voice.
    normalized = english_text(text, number_language="uk")
    spelling = []
    for language, part in split_mixed(normalized, "en"):
        if language == "uk":
            spelling.append(accent_text(part))
        else:
            # eSpeak's British dictionary is named "en", not the NVDA locale en-GB.
            voice = "en" if accent == "en-gb" else "en-us"
            # NVDA supplies the letter A as "ay"; dictionaries can interpret
            # that spelling as the archaic word "aye" (/ai/).
            native = "ˈeɪ" if part.casefold() == "ay" else " ".join(
                "".join(row) for row in phonemizer().phonemize(voice, part))
            spelling.append(ukrainian_spelling(native))
    return ipa(" ".join(spelling))
