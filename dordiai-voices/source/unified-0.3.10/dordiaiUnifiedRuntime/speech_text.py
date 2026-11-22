"""Keep mixed-language runs and standalone numbers with the surrounding phrase."""
from bisect import bisect_left
from functools import lru_cache
import json
from pathlib import Path
import re
from zlib import crc32

LATIN_LETTERS = r"A-Za-zÀ-ÖØ-öø-ž"
LATIN_LETTER = re.compile(f"[{LATIN_LETTERS}]")
CYRILLIC_LETTER = re.compile(r"[А-Яа-яІіЇїЄєҐґЁё]")
WORDS = re.compile(
    rf"[{LATIN_LETTERS}]+(?:['’][{LATIN_LETTERS}]+)*|[А-Яа-яІіЇїЄєҐґЁё\u0301]+|"
    r"\d+(?:[.,:/-]\d+)*(?:[\u00a0\u202f]\d{3})*"
)
NUMBER = {
    "uk": re.compile(r"(?<!\w)\d+(?:[\u00a0\u202f ]\d{3})*(?:[.,]\d+)?(?!\w)"),
    "en": re.compile(r"(?<!\w)(?:\d{1,3}(?:,\d{3})+|\d+(?:[\u00a0\u202f ]\d{3})*)(?:\.\d+)?(?!\w)"),
}
NUMBER["ru"] = NUMBER["uk"]
SENTENCE_END = re.compile(r"[.!?…]+[»”’\"\)\]]*\s+|[\r\n]+")
CLAUSE_END = re.compile(r"[,;:—]\s+")
DIGIT_WORDS = {
    "uk": ("нуль", "один", "два", "три", "чотири", "п'ять", "шість", "сім", "вісім", "дев'ять"),
    "en": ("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"),
    "ru": ("ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"),
}


DIGIT_WORDS.update({'sk': ['nula', 'jeden', 'dva', 'tri', 'štyri', 'päť', 'šesť', 'sedem', 'osem', 'deväť'], 'de': ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'], 'pl': ['zero', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć'], 'fr': ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'], 'da': ['nul', 'en', 'to', 'tre', 'fire', 'fem', 'seks', 'syv', 'otte', 'ni'], 'it': ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove'], 'es': ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve']})
DECIMAL_NAMES = {'uk': 'кома', 'ru': 'запятая', 'en': 'point', 'sk': 'čiarka', 'de': 'Komma', 'pl': 'przecinek', 'fr': 'virgule', 'da': 'komma', 'it': 'virgola', 'es': 'coma'}
for _language in DIGIT_WORDS:
    NUMBER.setdefault(_language, NUMBER["uk"])


def word_language(token):
    first = token[0]
    if first.isdecimal():
        return None
    return "en" if LATIN_LETTER.fullmatch(first) else "uk"


def script_mismatch(text, language):
    """A page-wide locale may disagree with the script of an embedded span."""
    if language in ("uk", "ru"):
        return bool(LATIN_LETTER.search(text))
    if language in DIGIT_WORDS:
        return bool(CYRILLIC_LETTER.search(text))
    return False


# Frequent grammatical cues cover short phrases even when both dictionaries
# contain the same spelling as an inflected word or a proper name.
RUSSIAN_CUES = frozenset((
    "безусловно", "впрочем", "всегда", "вчера", "даже", "должен", "должна", "ежели",
    "ещё", "если", "завтра", "зачем", "здесь", "из", "или", "именно", "как", "когда",
    "которого", "котором", "лишь", "может", "например", "ничего", "однако", "опять",
    "откуда", "отчего", "очень", "пожалуйста", "пока", "потому", "почему", "пожаловать",
    "сейчас", "сегодня", "сказал", "сказала", "словно", "совсем", "спасибо", "теперь",
    "тогда", "тоже", "только", "туда", "уже", "хотя", "чаще", "чем", "что", "чтобы",
    "этот", "это", "этой", "этих", "является", "откройте", "сохраните", "перейдите",
    "она", "они", "куда", "ушел", "ушёл", "человек", "оставил", "оставила", "закрой", "закройте",
    "сохрани", "сохранить", "сохранять", "открой", "открыть", "скажи", "спрашивает", "спросил",
    "отправить", "получить", "можно", "нужно", "необходимо", "выбрать", "добавить", "нажмите",
    "загрузки", "загрузка", "загрузок",
    "записал", "поставил", "взял", "пошел", "пошёл", "разговаривал", "разговаривает",
))
UKRAINIAN_CUES = frozenset((
    "або", "адже", "але", "багато", "безперечно", "вже", "вона", "вони", "де", "досить",
    "дуже", "дякую", "завтра", "завжди", "зараз", "звичайно", "здається", "знову",
    "його", "йому", "каже", "казав", "кажуть", "коли", "краще", "мабуть", "майже",
    "мене", "менше", "минулий", "можна", "навіть", "наприклад", "наступний", "начебто",
    "однак", "ось", "отже", "перепрошую", "поки", "понад", "проте", "раптом", "саме",
    "поставив", "розмовляв",
    "сказав", "сказала", "схоже", "такий", "також", "тепер", "тому", "трохи", "туди",
    "хоча", "цей", "цього", "чому", "щоб", "щодо", "що", "ще", "як", "якщо", "який",
))


@lru_cache(maxsize=1)
def cyrillic_word_index():
    index = Path(__file__).with_name("cyrillic_words.bin")
    if not index.is_file():
        return (), ()
    values = memoryview(index.read_bytes()).cast("I")
    boundary = values[0] + 1
    return values[1:boundary], values[boundary:]


def contains_hash(values, key):
    position = bisect_left(values, key)
    return position < len(values) and values[position] == key


@lru_cache(maxsize=4096)
def cyrillic_word_score(word):
    uk = any(letter in word for letter in "іїєґ")
    ru = any(letter in word for letter in "ыэёъ")
    if uk != ru:
        return -5 if uk else 5
    uk = word in UKRAINIAN_CUES
    ru = word in RUSSIAN_CUES
    if uk or ru:
        return (4 if ru else 0) - (4 if uk else 0)
    if len(word) < 3:
        return 0
    uk_words, ru_words = cyrillic_word_index()
    value = crc32(word.encode("utf8"))
    return (2 if contains_hash(ru_words, value) else 0) - (2 if contains_hash(uk_words, value) else 0)


@lru_cache(maxsize=1)
def cyrillic_ngram_table():
    file = Path(__file__).with_name("cyrillic_ngrams.json")
    return json.loads(file.read_text(encoding="utf8")) if file.is_file() else {}


@lru_cache(maxsize=8192)
def cyrillic_ngram_score(word):
    table = cyrillic_ngram_table()
    value = " " + word + " "
    score = sum(table.get(value[start:start + size], 0.)
                for size in (2, 3) for start in range(len(value) - size + 1))
    return max(-8., min(8., score))


def cyrillic_language(text, fallback="uk"):
    words = tuple(dict.fromkeys(match.group() for match in WORDS.finditer(text.casefold().replace("\u0301", ""))
                                if word_language(match.group()) == "uk"))
    spread = "".join(words)
    uk = any(letter in spread for letter in "іїєґ")
    ru = any(letter in spread for letter in "ыэёъ")
    if uk != ru:
        return "uk" if uk else "ru"
    hints = set(words)
    cue_uk = len((hints & UKRAINIAN_CUES) - RUSSIAN_CUES)
    cue_ru = len((hints & RUSSIAN_CUES) - UKRAINIAN_CUES)
    lexical = sum(map(cyrillic_word_score, words))
    statistics = sum(map(cyrillic_ngram_score, words)) if any(len(word) > 1 for word in words) else 0.
    score = statistics + .42 * lexical + 3.25 * (cue_ru - cue_uk)
    return "ru" if score >= 1.3 else "uk" if score <= -1.3 else fallback


def split_mixed(text, fallback="uk", *, detect_russian=False):
    matches = list(WORDS.finditer(text))
    if not matches:
        yield fallback, text
        return
    languages = [word_language(match.group()) for match in matches]
    boundaries = [""] + [text[prev.end():curr.start()] for prev, curr in zip(matches, matches[1:])]
    clause_breaks = [bool(CLAUSE_END.search(gap) or SENTENCE_END.search(gap)) for gap in boundaries]
    sentence_breaks = [bool(SENTENCE_END.search(gap)) for gap in boundaries]
    if detect_russian:
        document_locale = cyrillic_language(text, fallback)
        sentence_start = 0
        while sentence_start < len(matches):
            sentence_end = sentence_start + 1
            while sentence_end < len(matches) and not sentence_breaks[sentence_end]:
                sentence_end += 1
            text_span = text[matches[sentence_start].start():matches[sentence_end - 1].end()]
            default = cyrillic_language(text_span, document_locale)
            left = sentence_start
            while left < sentence_end:
                if languages[left] == "en":
                    left += 1
                    continue
                right = left + 1
                while right < sentence_end and languages[right] != "en" and not clause_breaks[right]:
                    right += 1
                span = text[matches[left].start():matches[right - 1].end()]
                locale = cyrillic_language(span, default)
                languages[left:right] = [locale if language == "uk" else language for language in languages[left:right]]
                left = right
            sentence_start = sentence_end
    next_language = fallback
    for i in range(len(matches) - 1, -1, -1):
        if i < len(matches) - 1 and sentence_breaks[i + 1]:
            next_language = fallback
        if languages[i] is None:
            following = languages[i+1] if i+1 < len(matches) else None
            if following is not None and not clause_breaks[i + 1]:
                languages[i] = next_language
        else:
            next_language = languages[i]
    start = 0
    active = fallback
    for i, (match, language) in enumerate(zip(matches, languages)):
        if sentence_breaks[i]:
            if language is None:
                language = fallback
        language = language or active
        if i and active != language:
            yield active, text[start:match.start()].strip()
            start = match.start()
        active = language
    yield active, text[start:].strip()


def speak_numbers(text, language, input_language=None, *, number_words=None):
    if number_words is None:
        from num2words import num2words as number_words

    names = DIGIT_WORDS[language]
    input_language = input_language or language

    def digits(number):
        return " ".join(names[int(digit)] for digit in number)

    def replace(match):
        literal = match.group()
        number = re.sub(r"[\u00a0\u202f ]", "", literal)
        if input_language == "en":
            number = number.replace(",", "")
        whole, sep, decimal = number.replace(",", ".").partition(".")
        if len(whole) > 12 or (len(whole) > 1 and whole.startswith("0")):
            spoken = digits(whole)
        else:
            spoken = number_words(int(whole), lang=language)
        if sep:
            spoken += ' '+DECIMAL_NAMES[language]+' ' + digits(decimal)
        return spoken

    return NUMBER[input_language].sub(replace, text)


DOTTED_VERSION = re.compile(r"(?<![.\d])\d+(?:\.\d+){2,}(?!\d|\.\d)")
CLOCK = re.compile(r"(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])")

def english_numeric_text(text, *, number_words=None):
    """Expand versions and clock times before an acoustic packet is bounded."""
    if number_words is None:
        from num2words import num2words as number_words
    def pronounce_time(match):
        hours,minutes=map(int,match.groups())
        result=number_words(hours,lang='en')
        if minutes==0:return result+" o'clock"
        if minutes<10:return result+' oh '+number_words(minutes,lang='en')
        return result+' '+number_words(minutes,lang='en')
    text=DOTTED_VERSION.sub(lambda match:' point '.join(speak_numbers(value,'en',number_words=number_words)
                           for value in match.group().split('.')),text)
    return CLOCK.sub(pronounce_time,text)


ENGLISH_TERMS = {
    "nvda": "N V D A",
    "rhvoice": "R H Voice",
    "dordiai-voices": "Dordiai Voices",
    "ctrl": "Control",
    "ctrl+": "Control plus ",
    "caps lock": "Caps Lock",
    "alt+": "Alt plus ",
    "shift+": "Shift plus ",
    "usb": "U S B",
    "url": "U R L",
    "pdf": "P D F",
    "mp3": "M P three",
    "mb": "megabytes",
    "gb": "gigabytes",
    "kb": "kilobytes",
    "ui": "U I",
    "gpu": "G P U",
    "cpu": "C P U",
    "html": "H T M L",
    "api": "A P I",
    "tts": "T T S",
}
ENGLISH_TERM_PATTERN = re.compile(
    r"(?<!\w)(?:" + "|".join(map(re.escape, sorted((term for term in ENGLISH_TERMS if not term.endswith("+")), key=len, reverse=True))) +
    r")(?![A-Za-z0-9])", re.IGNORECASE
)


def english_text(text, number_language="en"):
    # A shortcut can touch the next key without an intervening space.
    text = re.sub(r"(?i)\b(ctrl|alt|shift)\s*\+\s*", lambda m: ENGLISH_TERMS[m[1].lower() + "+"], text)
    text = re.sub(r"(?i)\b(\d+(?:[.,]\d+)?)\s*(mb|gb|kb)\b",
                  lambda m: f"{m[1]} {ENGLISH_TERMS[m[2].lower()]}", text)
    text = ENGLISH_TERM_PATTERN.sub(
        lambda m: "M P 3" if number_language == "uk" and m[0].lower() == "mp3" else ENGLISH_TERMS[m[0].lower()], text)
    text = re.sub(r"(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])", " ", text)
    return speak_numbers(text, number_language, "en")


def number_parts(text, language, target):
    """Keep punctuation with spoken number runs in the requested language."""
    source = language.split("-")[0]
    parts = []
    position = 0

    def append_text(fragment):
        fragment = fragment.strip()
        if parts and (prefix := re.match(r"^[,.;:!?…]+", fragment)):
            parts[-1] = target, parts[-1][1] + prefix.group()
            fragment = fragment[prefix.end():].lstrip()
        if fragment:
            parts.append((language, fragment))

    for match in NUMBER[source].finditer(text):
        append_text(text[position:match.start()])
        parts.append((target, speak_numbers(match.group(), target, source)))
        position = match.end()
    append_text(text[position:])
    return tuple(parts)
