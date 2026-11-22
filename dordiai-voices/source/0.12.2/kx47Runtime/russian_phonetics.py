"""Map standard Russian phonemes to the shared Holos acoustic alphabet."""
from functools import lru_cache
from english_phonetics import phonemizer
from speech_text import speak_numbers

# These substitutions preserve Russian stress and consonant softness. The
# Holos model is Ukrainian, so its acoustic realization keeps an accent.
PHONES = str.maketrans({"ɨ": "ɪ", "ɐ": "ɐ", "ə": "e", "ɡ": "ɡ", "ɣ": "ɦ",
                        "ɕ": "ʃʲ", "ɻ": "r", "ɭ": "ɫ", "ː": "", "ˌ": ""})

@lru_cache(maxsize=512)
def russian_phones(text):
    pronounced = speak_numbers(text, "uk")
    rows = phonemizer().phonemize("ru", pronounced)
    return " ".join("".join(row) for row in rows).translate(PHONES)
