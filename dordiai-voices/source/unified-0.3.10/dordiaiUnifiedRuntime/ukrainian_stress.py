"""Resolve Ukrainian word stress before generating complete Piper phoneme sentences."""
from functools import lru_cache
import re
import unicodedata
import json
from pathlib import Path

ACUTE = "\u0301"
IPA_STRESS = "ˈ"
VOWELS = frozenset("аеєиіїоуюя")
IPA_VOWELS = frozenset("aɑæeɛəɜɪiɨoɔuʊʌ")
WORDS = re.compile(r"[А-Яа-яІіЇїЄєҐґ\u0301]+(?:['’ʼ][А-Яа-яІіЇїЄєҐґ\u0301]+)*")
CLAUSE = re.compile(r"[.!?…;:\n]+(?=\s|$)")
SENTENCES = re.compile(r".+?(?:[.!?…]+(?=\s|$)|$)", re.DOTALL)
PUNCTUATION = re.compile(r"[,.:;!?…]+")
APOSTROPHES = str.maketrans({"’": "'", "ʼ": "'"})
OVERRIDES = {
    # Common UI forms missing from the main dictionary or marked as variants.
    "меню": "меню́",
    "підпапка": "підпа́пка",
    "підпапки": "підпа́пки",
    "підпапку": "підпа́пку",
    "висить": "ви́сить",
    "позначено": "позна́чено",
    "дьордяй": "дьордя́й",
    "лізавета": "лізаве́та",
    "ліан": "ліа́н",
    "озвучення": "озву́чення",
    "скрінрідер": "скрінрі́дер",
    "скрінрідера": "скрінрі́дера",
    "вебсторінка": "вебсторі́нка",
    "вебсторінку": "вебсторі́нку",
}
HOMOGRAPHS = {
    "горі": (("горі́", r"\bна горі\b"),),
    "замок": (
        ("замо́к", r"\b(двер\w*|ключ\w*|висить|навісний|відмика\w*|замика\w*)\b"),
        ("за́мок", r"\b(горі|фортец\w*|середньовіч\w*|палац\w*)\b"),
    ),
    "мука": (
        ("мука́", r"\b(борошн\w*|пшеничн\w*|просі\w*)\b"),
        ("му́ка", r"\b(страждан\w*|нестерпн\w*|справжн\w*)\b"),
    ),
    "атлас": (
        ("а́тлас", r"\b(мап\w*|світу|географіч\w*)\b"),
        ("атла́с", r"\b(сукн\w*|тканин\w*|шовков\w*)\b"),
    ),
    "дорога": (
        ("доро́га", r"\b(шлях|вулиця|додому|веде|довга|рівна|ґрунтова)\b"),
        ("дорога́", r"\b(ціна|річ|покупка|подруго|занадто)\b"),
    ),
    "орган": (
        ("о́рган", r"\b(влади|державний|чуття|внутрішній|людини)\b"),
        ("орга́н", r"\b(музичний|церква|звучить|інструмент|грає)\b"),
    ),
    "відомості": (
        ("відо́мості", r"\b(докладні|інформація|про|переглянути|отримати)\b"),
        ("ві́домості", r"\b(платіжні|розрахункові|бухгалтерські)\b"),
    ),
    "зміни": (
        ("змі́ни", r"\b(збережено|зберегти|скасувати|прийняти|внесені|застосувати|внесіть)\b"),
        ("зміни́", r"\bзміни\s+(пароль|ім’я|ім'я|назву|колір|шрифт|значення)\b"),
    ),
}


@lru_cache(maxsize=1)
def dictionary():
    from ukrainian_word_stress import Disambiguation, Stressifier, StressSymbol

    return Stressifier(
        disambiguation=Disambiguation.Dictionary,
        stress_symbol=StressSymbol.CombiningAcuteAccent,
        on_ambiguity="skip",
    )


@lru_cache(maxsize=4096)
def dictionary_word(word):
    form = dictionary()(word)
    return form if form.count(ACUTE) == 1 else None


@lru_cache(maxsize=1)
def rhvoice_dictionary():
    path = Path(__file__).with_name("rhvoice_stress.json")
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def stress_position(word):
    vowels_read = 0
    for char in word:
        if char in VOWELS:
            vowels_read += 1
        if char == ACUTE:
            return vowels_read - 1
    return None


def word_stress(word, context):
    if ACUTE in word:
        return word if word.count(ACUTE) == 1 and word[word.index(ACUTE) - 1:word.index(ACUTE)] in VOWELS else None
    if word in OVERRIDES:
        return OVERRIDES[word]
    matches = [form for form, pattern in HOMOGRAPHS.get(word, ()) if re.search(pattern, context)]
    if len(matches) == 1:
        return matches[0]
    if word in rhvoice_dictionary():
        return rhvoice_dictionary()[word]
    return dictionary_word(word)


def _stress_edits(text):
    boundaries = list(CLAUSE.finditer(text))
    left = 0
    boundary = iter(boundaries)
    right = next(boundary, None)
    for match in WORDS.finditer(text):
        while right is not None and right.end() <= match.start():
            left = right.end()
            right = next(boundary, None)
        word = match.group().lower().translate(APOSTROPHES)
        if sum(char in VOWELS for char in word) < 2:
            continue
        context = text[left:right.start() if right else len(text)].lower().replace(ACUTE, "")
        resolved = word_stress(word, context)
        if resolved:
            yield match, resolved


def accent_text(text):
    """Apply dictionary stress without altering the text's punctuation or case."""
    text = unicodedata.normalize("NFC", text)
    edits = []
    for match, resolved in _stress_edits(text):
        if ACUTE in match.group():
            continue
        offset = resolved.index(ACUTE)
        original = match.group()
        edits.append((match.start(), match.end(), original[:offset] + ACUTE + original[offset:]))
    for start, end, value in reversed(edits):
        text = text[:start] + value + text[end:]
    return text


def _stress_phones(voice, word, syllable):
    phonemes = voice.phonemize(word)
    if len(phonemes) != 1:
        return None
    phones = [p for p in phonemes[0] if p not in (IPA_STRESS, "ˌ")]
    vowels = [i for i, p in enumerate(phones) if p and p[0] in IPA_VOWELS]
    if len(vowels) != sum(c in VOWELS for c in word) or not 0 <= syllable < len(vowels):
        return None
    phones.insert(vowels[syllable], IPA_STRESS)
    return phones


def prepare_ukrainian(text, voice):
    """Keep eSpeak sentence boundaries and pass exactly one space between words."""
    text = unicodedata.normalize("NFC", text).replace("[[", "[ [").replace("]]", "] ]")
    corrected = []
    for match, form in _stress_edits(text):
        word = match.group().lower().translate(APOSTROPHES).replace(ACUTE, "")
        phones = _stress_phones(voice, word, stress_position(form))
        if phones is not None:
            corrected.append((match.start(), match.end(), "".join(phones)))
    # Encode punctuation as phonemes because eSpeak ignores a punctuation-only fragment.
    for match in PUNCTUATION.finditer(text):
        if (match.start() and text[match.start() - 1].isdigit()
                and match.end() < len(text) and text[match.end()].isdigit()):
            continue
        corrected.append((match.start(), match.end(), match.group().replace("…", ".")))
    for start, end, phones in sorted(corrected, reverse=True):
        text = text[:start] + f"[[{phones}]]" + text[end:]
    return text


def piper_sentences(text, voice):
    """Send stress to Piper with a single phoneme space and intact sentence contours."""
    supported = voice.config.phoneme_id_map
    # The tokenizer joins adjacent raw blocks with duplicate spaces. Collapse those
    # after phonemization so they cannot create additional acoustic word breaks.
    for clause in SENTENCES.finditer(text):
        for sentence in voice.phonemize(prepare_ukrainian(clause.group().strip(), voice)):
            output = []
            for phone in sentence:
                if phone in supported and (phone != " " or output and output[-1] != " "):
                    output.append(phone)
            while output and output[-1] == " ":
                output.pop()
            if output:
                yield output
