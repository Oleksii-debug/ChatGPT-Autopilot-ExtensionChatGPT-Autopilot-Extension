"""Pronounce multilingual dictionary phonemes with a shared Holos speaker."""
from functools import lru_cache
from english_phonetics import phonemizer, ukrainian_spelling
from ipa_uk import ipa

ALL = str.maketrans({
    "ç":"x","ɲ":"nʲ","ɳ":"n","ʎ":"lʲ","ɨ":"ɪ","y":"i","ʏ":"ɪ","ø":"e","œ":"e","ɶ":"a",
    "ɕ":"ʃʲ","ʑ":"ʒʲ","ʂ":"ʃ","ʐ":"ʒ","ʀ":"r","ʁ":"r","ɾ":"r","χ":"x","ɣ":"ɦ",
    "ð":"d","θ":"t","β":"v","ɸ":"f","ʋ":"v","ɫ":"l","ɯ":"u","ɒ":"o","ɜ":"e",
    "ː":"","ˑ":"","ˌ":"","ˀ":"","̥":"","̃":"","̩":"","ʰ":"","̯":"","͡":"",
})
ACCENTS = {"sk":"sk", "pl":"pl", "de":"de", "fr":"fr", "da":"da", "it":"it", "es":"es"}


@lru_cache(maxsize=1024)
def latin_phones(text, language):
    segments = phonemizer().phonemize(ACCENTS[language],text)
    phones = " ".join("".join(segment) for segment in segments)
    if language in {"fr", "pl"}:
        for nasal in ("ɔ", "ɑ", "ɛ", "œ", "a", "e", "o"):
            phones = phones.replace(nasal + "\u0303", nasal + "n")
    phones = phones.translate(ALL)
    if language == "da":
        phones = phones.replace("?ɑ", "ɑ").translate(str.maketrans({
            "ʔ": "", "ʌ": "ɐ", "ɐ": "a", "ŋ": "n", "ɡ": "g", "ε": "ɛ",
            "̞": "", "̝": "", "̠": "",
        }))
    elif language == "es":
        phones = phones.replace("bw", "bu").replace("ɣw", "ɡu")
    return ipa(ukrainian_spelling(phones))
