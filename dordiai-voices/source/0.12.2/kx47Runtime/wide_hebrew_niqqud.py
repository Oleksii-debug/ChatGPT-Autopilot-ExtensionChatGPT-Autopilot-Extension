"""Pointed Hebrew pronunciation for the Noa acoustic model.

Adapted from Phonikud 0.4.1 by TheWhiteEagle, CC BY 4.0.
https://github.com/thewh1teagle/phonikud. See Hebrew/phonikud-license.txt.
The vowel and consonant transducer is used without upstream numeric expansion.
Unpointed portions and lexical stress are supplied by the local ReNikud model.
"""
import re
import unicodedata
from typing import Literal
VOCAL_SHVA_DIACRITIC = "\u05bd"  # Meteg
HATAMA_DIACRITIC = "\u05ab"  # Ole
PREFIX_DIACRITIC = "|"  # Vertical bar
NIKUD_HASER_DIACRITIC = "\u05af"  # Masora, not in use
EN_GERESH = "'"
NON_STANDARD_DIAC = "".join(
    [
        VOCAL_SHVA_DIACRITIC,
        HATAMA_DIACRITIC,
        PREFIX_DIACRITIC,
        NIKUD_HASER_DIACRITIC,
        EN_GERESH,
    ]
)

HE_PATTERN = rf'[\u05b0-\u05ea{NON_STANDARD_DIAC}"]+'
# ^ Standard nikud and letters, ole, meteg, masora, vertical bar, en geresh
HE_NIKUD_PATTERN = rf"[\u05b0-\u05c7{NON_STANDARD_DIAC}]"
# ^ Letters, diacritics, en geresh
PUNCTUATION = set(r".,!? ")

STRESS_PHONEME = "ˈ"  # \u02c8 visually looks like single quote
SPECIAL_PHONEMES = ["w"]
MODERN_SCHEMA = {
    "x": "χ",  # Het
    "r": "ʁ",  # Resh
    "g": "ɡ",  # Gimel
}

# Geresh
GERESH_PHONEMES = {"ג": "dʒ", "ז": "ʒ", "ת": "ta", "צ": "tʃ", "ץ": "tʃ"}

# Consonants
LETTERS_PHONEMES = {
    "א": "ʔ",  # Alef
    "ב": "v",  # Bet
    "ג": "g",  # Gimel
    "ד": "d",  # Dalet
    "ה": "h",  # He
    "ו": "v",  # Vav
    "ז": "z",  # Zayin
    "ח": "x",  # Het
    "ט": "t",  # Tet
    "י": "j",  # Yod
    "ך": "x",  # Haf sofit
    "כ": "x",  # Haf
    "ל": "l",  # Lamed
    "ם": "m",  # Mem Sofit
    "מ": "m",  # Mem
    "ן": "n",  # Nun Sofit
    "נ": "n",  # Nun
    "ס": "s",  # Samekh
    "ע": "ʔ",  # Ayin, only voweled
    "פ": "f",  # Fey
    "ף": "f",  # Fey Sofit
    "ץ": "ts",  # Tsadik sofit
    "צ": "ts",  # Tsadik
    "ק": "k",  # Kuf
    "ר": "r",  # Resh
    "ש": "ʃ",  # Shin
    "ת": "t",  # Taf
    # Beged Kefet
    "בּ": "b",
    "כּ": "k",
    "פּ": "p",
    # Shin Sin
    "שׁ": "ʃ",
    "שׂ": "s",
    "'": "",
}

NIKUD_PHONEMES = {
    "\u05b4": "i",  # Hiriq
    "\u05b1": "e",  # Hataf segol
    "\u05b5": "e",  # Tsere
    "\u05b6": "e",  # Segol
    "\u05b2": "a",  # Hataf Patah
    "\u05b7": "a",  # Patah
    "\u05c7": "o",  # Kamatz katan
    "\u05b9": "o",  # Holam
    "\u05ba": "o",  # Holam haser for vav
    "\u05bb": "u",  # Qubuts
    "\u05b3": "o",  # Hataf qamats
    "\u05b8": "a",  # Kamataz
    HATAMA_DIACRITIC: STRESS_PHONEME,  # Stress (Hat'ama)
    VOCAL_SHVA_DIACRITIC: "e",  # Vocal Shva
}

DEDUPLICATE = {
    "\u05f3": "'",  # Hebrew geresh to regular geresh
    "־": "-",  # Hebrew Makaf to hypen
}

# Sets
SET_ENHANCED_DIACRITICS = set(
    [HATAMA_DIACRITIC, PREFIX_DIACRITIC, VOCAL_SHVA_DIACRITIC]
)

ADDITIONAL_PHONEMES = set()  # When using fallback
SET_PHONEMES = set(
    sorted(
        {
            *NIKUD_PHONEMES.values(),
            *LETTERS_PHONEMES.values(),
            *GERESH_PHONEMES.values(),
            *MODERN_SCHEMA.values(),
            *SPECIAL_PHONEMES,
        }
    )
)


class Letter:
    def __init__(self, char: str, diac: list[str]):
        self.char = unicodedata.normalize('NFD',char)
        self.all_diac = ''.join(sorted(unicodedata.normalize('NFD',diac)))
        self.diac = "".join(
            i for i in self.all_diac if i not in SET_ENHANCED_DIACRITICS
        )

    def __repr__(self):
        return f"[Letter] {self.char}{''.join(self.all_diac)}"

    def __eq__(self, value: "Letter"):
        return value.all_diac == self.all_diac and value.char == self.char

    def __str__(self):
        return self.char + self.all_diac


def sort_stress(
    phonemes: list[str], placement: Literal["syllable", "vowel"] = "vowel"
) -> list[str]:
    """
    TTS systems expect that the stress will be BEFORE vowel
    Linguistics expect in the START of the syllable
    at_start=True for place it in the beginning
    """
    if "ˈ" not in "".join(phonemes):
        # ^ Does not contains stress
        return phonemes
    if not any(i in "".join(phonemes) for i in "aeiou"):
        # ^ Does not contains vowel
        return phonemes

    # Remove stress marker
    phonemes = [p for p in phonemes if p != "ˈ"]

    if placement == "syllable":
        return ["ˈ"] + phonemes

    # Define vowels
    vowels = "aeiou"

    # Find the first phoneme that contains a vowel, and inject the stress before the vowel

    for i, phoneme in enumerate(phonemes):
        for j, char in enumerate(phoneme):
            if char in vowels:
                # Insert stress before the vowel
                phonemes[i] = phoneme[:j] + "ˈ" + phoneme[j:]
                return phonemes

    # If no vowels found, return unchanged
    return phonemes

SHVA = "\u05b0"
SIN = "\u05c2"
PATAH = "\u05b7"
KAMATZ = "\u05b8"
HATAF_KAMATZ = "\u05b3"
DAGESH = "\u05bc"
HOLAM = "\u05b9"
HIRIK = "\u05b4"
PATAH_LIKE_PATTERN = "[\u05b7-\u05b8]"
KUBUTS = "\u05bb"
TSERE = "\u05b5"
HATAMA = "\u05ab"
VAV_HOLAM = "\u05ba"
DAGESH = "\u05bc"
SEGOL = "\u05b6"


def phonemize_hebrew(
    letters: list[Letter], stress_placement: Literal["syllable", "vowel"]
) -> list[str]:
    phonemes, i = [], 0
    while i < len(letters):
        cur = letters[i]
        prev = letters[i - 1] if i > 0 else None
        next = letters[i + 1] if i + 1 < len(letters) else None
        next_phonemes, skip_offset = letter_to_phonemes(
            cur, prev, next, stress_placement
        )
        phonemes.extend(next_phonemes)
        i += skip_offset + 1
    return phonemes


def handle_yud(cur: Letter, prev: Letter | None, next: Letter | None) -> bool:
    """Returns True if Yud should skip consonants"""
    return (
        next
        # Yud without diacritics
        and not cur.diac
        # In middle
        and prev
        # Prev Hirik
        and prev.char + prev.diac != "אֵ"
        # Next Vav has meaning
        and not (next.char == "ו" and next.diac and "\u05b0" not in next.diac)
    )


def handle_vav(cur: Letter, prev: Letter | None, next: Letter | None):
    if prev and SHVA in prev.diac and HOLAM in cur.diac:
        return ["vo"], True, True, 0

    if next and next.char == "ו":
        diac = cur.diac + next.diac
        if HOLAM in diac:
            return ["vo"], True, True, 1
        if cur.diac == next.diac:
            return ["vu"], True, True, 1
        if HIRIK in cur.diac:
            return ["vi"], True, True, 0
        if SHVA in cur.diac and not next.diac:
            return ["v"], True, True, 0
        if KAMATZ in cur.diac or PATAH in cur.diac:
            return ["va"], True, True, 0
        if TSERE in cur.diac or SEGOL in cur.diac:
            return ["ve"], True, True, 0
        return [], False, False, 0

    # Single ו
    if re.search(PATAH_LIKE_PATTERN, cur.diac):
        return ["va"], True, True, 0
    if TSERE in cur.diac or SEGOL in cur.diac:
        return ["ve"], True, True, 0
    if HOLAM in cur.diac:
        return ["o"], True, True, 0
    if KUBUTS in cur.diac or DAGESH in cur.diac:
        return ["u"], True, True, 0
    if SHVA in cur.diac and not prev:
        return ["ve"], True, True, 0
    if HIRIK in cur.diac:
        return ["vi"], True, True, 0
    if next and not cur.diac:
        return [], True, True, 0

    return ["v"], True, True, 0


def letter_to_phonemes(
    cur: Letter,
    prev: Letter | None,
    next: Letter | None,
    stress_placement: Literal["syllable", "vowel"],
) -> tuple[str, int]:
    cur_phonemes = []
    skip_diacritics = False
    skip_consonants = False
    skip_offset = 0

    if NIKUD_HASER_DIACRITIC in cur.all_diac:
        skip_consonants = True
        skip_diacritics = True

    elif cur.char == "א" and not cur.diac and prev:
        if next and next.char != "ו":
            skip_consonants = True

    elif cur.char == "י" and handle_yud(cur, prev, next):
        skip_consonants = True

    elif cur.char == "ש" and SIN in cur.diac:
        if (
            next
            and next.char == "ש"
            and not next.diac
            and re.search("[\u05b7\u05b8]", cur.diac)
        ):
            # ^ יששכר
            cur_phonemes.append("sa")
            skip_consonants = True
            skip_diacritics = True
            skip_offset += 1
        else:
            cur_phonemes.append("s")
            skip_consonants = True

    # shin without nikud after sin = sin
    elif cur.char == "ש" and not cur.diac and prev and SIN in prev.diac:
        cur_phonemes.append("s")
        skip_consonants = True

    elif not next and cur.char == "ח" and PATAH in cur.diac:
        # Final Het gnuva
        cur_phonemes.append("ax")
        skip_diacritics = True
        skip_consonants = True

    elif not next and cur.char == "ה" and PATAH in cur.diac:
        # Final He gnuva
        cur_phonemes.append("ah")
        skip_diacritics = True
        skip_consonants = True

    elif not next and cur.char == "ע" and PATAH in cur.diac:
        # Final Ayin gnuva
        cur_phonemes.append("a")
        skip_diacritics = True
        skip_consonants = True

    if cur and "'" in cur.diac and cur.char in GERESH_PHONEMES:
        if cur.char == "ת":
            cur_phonemes.append(GERESH_PHONEMES.get(cur.char, ""))
            skip_diacritics = True
            skip_consonants = True
        else:
            # Geresh
            cur_phonemes.append(GERESH_PHONEMES.get(cur.char, ""))
            skip_consonants = True

    elif DAGESH in cur.diac and cur.char + DAGESH in LETTERS_PHONEMES:  # dagesh
        cur_phonemes.append(LETTERS_PHONEMES.get(cur.char + DAGESH, ""))
        skip_consonants = True
    elif cur.char == "ו" and NIKUD_HASER_DIACRITIC not in cur.all_diac:
        vav_phonemes, vav_skip_consonants, vav_skip_diacritics, vav_skip_offset = (
            handle_vav(cur, prev, next)
        )
        cur_phonemes.extend(vav_phonemes)
        skip_consonants = vav_skip_consonants
        skip_diacritics = vav_skip_diacritics
        skip_offset += vav_skip_offset

    if not skip_consonants:
        cur_phonemes.append(LETTERS_PHONEMES.get(cur.char, ""))

    if KAMATZ in cur.diac and next and HATAF_KAMATZ in next.diac:
        cur_phonemes.append("o")
        skip_diacritics = True

    nikud_phonemes = []
    if not skip_diacritics:
        nikud_phonemes = [
            NIKUD_PHONEMES.get(nikud, "") for nikud in cur.all_diac
        ]
    elif skip_diacritics and HATAMA_DIACRITIC in cur.all_diac:
        nikud_phonemes = [STRESS_PHONEME]
    cur_phonemes.extend(nikud_phonemes)
    # Ensure the stress is at the beginning of the syllable
    cur_phonemes = sort_stress(cur_phonemes, stress_placement)
    cur_phonemes = [
        p for p in cur_phonemes if all(i in SET_PHONEMES for i in p)
    ]
    # Remove empty phonemes
    cur_phonemes = [p for p in cur_phonemes if p]
    return cur_phonemes, skip_offset

_MARKS = r'\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7'
_POINT = re.compile('['+_MARKS+']')
_WORD = re.compile(r"[א-ת](?:[א-ת"+_MARKS+r"]|['׳](?=[א-ת]))*")
_CLUSTERS = re.compile(r"([א-ת])(["+_MARKS+r"'׳]*)")
_VOWELS = 'aeiou'
_VOWEL_MARK = re.compile(r'[\u05b0-\u05bb\u05c7]')
_MODERN = str.maketrans(MODERN_SCHEMA)

def _has_vowel(s):
    return any(c in _VOWELS for c in s)

def _word(word, original):
    pairs=_CLUSTERS.findall(word.replace('׳',"'"))
    letters=[Letter(c,m) for c,m in pairs]
    if not letters:return ''.join(original)
    # A single dagesh or shin dot is common in partly pointed prose. Preserve
    # the trained model's vowels for letters which the writer left unspecified.
    lookup=[];pos=0
    for c,marks in pairs:
        lookup.append(original[pos] if pos<len(original) else '')
        pos+=1+marks.count("'")
    marked=[bool(_VOWEL_MARK.search(m) or (c=='ו' and DAGESH in m)) for c,m in pairs]
    # A predictor can attach furtive /a/ to the final guttural. If the
    # preceding consonant explicitly carries patah (as in פְּתַח), counting
    # that prediction as another unmarked vowel invents a second syllable.
    complete=any(marked) and all(flag or not _has_vowel(ipa) or letter.char in 'אהוי'
        or (i==len(letters)-1 and i>0 and letter.char in 'חע' and PATAH in letters[i-1].diac)
        for i,(flag,ipa,letter) in enumerate(zip(marked,lookup,letters)))
    sounds=[]
    i=0
    while i<len(letters):
        cur=letters[i];before=letters[i-1] if i else None;after=letters[i+1] if i+1<len(letters) else None
        output,skip=letter_to_phonemes(cur,before,after,'vowel')
        ipa=''.join(output).translate(_MODERN)
        if not complete and not marked[i]:
            inferred=lookup[i]
            if DAGESH in cur.diac or SIN in cur.diac or '\u05c1' in cur.diac:
                # Honor explicit spirantization/sibilance; retain the inferred
                # nucleus and stress of this otherwise unpointed letter.
                vowel=re.search(r'ˈ?[aeiou].*',inferred)
                ipa=ipa.rstrip(_VOWELS+'ˈ')+(vowel.group() if vowel else '')
            else:ipa=inferred.replace('ˈ','')
        sounds.append(ipa);i+=1+skip
    raw=''.join(sounds)
    raw=re.sub('[hʔ]$','',raw);raw=re.sub('ij$','i',raw)
    preferred=''.join(lookup)
    if 'ˈ' in raw:return raw
    kernels=[i for i,c in enumerate(raw) if c in _VOWELS]
    if not kernels:return raw or preferred
    # Preserve learned lexical stress when the supplied vowels agree. When
    # pointing changes the word's vocalic pattern, Hebrew's final stress is
    # the default. Explicit Phonikud hatama already took precedence above.
    predicted_vowels=[c for c in preferred if c in _VOWELS]
    given=[raw[i] for i in kernels]
    segolate=(len(letters)==3 and len(kernels)==2
              and ((any(m in letters[0].diac for m in (TSERE,SEGOL)) and SEGOL in letters[1].diac)
                   or (PATAH in letters[0].diac and letters[1].char=='י' and HIRIK in letters[1].diac)))
    if segolate:stress=0
    elif given==predicted_vowels and 'ˈ' in preferred:
        stress=len([c for c in preferred.split('ˈ')[0] if c in _VOWELS])
    else:stress=len(kernels)-1
    k=kernels[min(stress,len(kernels)-1)];return raw[:k]+'ˈ'+raw[k:]

def has_marks(text):
    return bool(_POINT.search(text))

def pronounce(text,predict):
    original=unicodedata.normalize('NFD',text)
    bare=_POINT.sub('',original)
    # The trained context is retained in one pass for all unpointed words.
    parts=predict(bare,letter_chunks=True)
    if len(parts)!=len(bare):raise ValueError('Hebrew grapheme alignment differs')
    offsets=[0]
    for char in original:offsets.append(offsets[-1]+(not has_marks(char)))
    out=[];cursor=0
    for match in _WORD.finditer(original):
        word=match.group()
        if not has_marks(word):continue
        lo,hi=offsets[match.start()],offsets[match.end()]
        out.extend(parts[cursor:lo])
        out.append(_word(word,parts[lo:hi]));cursor=hi
    out.extend(parts[cursor:])
    return ''.join(out)
