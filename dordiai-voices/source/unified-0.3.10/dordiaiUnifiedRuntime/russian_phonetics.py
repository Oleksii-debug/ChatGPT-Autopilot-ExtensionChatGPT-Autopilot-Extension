"""Convert Russian dictionary pronunciation to phonemes trained by Holos."""
from functools import lru_cache

from english_phonetics import phonemizer, ukrainian_spelling
from ipa_uk import ipa

RUSSIAN_ALLOPHONES = str.maketrans({
    "y": "ɪ", "ɨ": "ɪ", "ɕ": "ʃʲ", "ʂ": "ʃ", "ʐ": "ʒ", "ɣ": "ɦ", "ɭ": "ɫ",
    "ː": "", "ˌ": "",
})


@lru_cache(maxsize=512)
def russian_phones(text):
    rows = phonemizer().phonemize("ru", text)
    pronunciation = " ".join("".join(row) for row in rows).translate(RUSSIAN_ALLOPHONES)
    return ipa(ukrainian_spelling(pronunciation))
