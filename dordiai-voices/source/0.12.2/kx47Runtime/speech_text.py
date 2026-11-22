"""Keep mixed-language runs and standalone numbers with the surrounding phrase."""
from bisect import bisect_left
from functools import lru_cache
import importlib.util
import gzip
import json
from pathlib import Path
import re
import sys
from zlib import crc32

WORDS = re.compile(
    r"[A-Za-zÀ-ÖØ-öø-ÿĀ-ž]+(?:['’‘ʼ][A-Za-zÀ-ÖØ-öø-ÿĀ-ž]+)*|[А-Яа-яІіЇїЄєҐґЁё\u0301]+(?:['’‘ʼ][А-Яа-яІіЇїЄєҐґЁё\u0301]+)*|"
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


@lru_cache(maxsize=1)
def routing_policy():
    spec = importlib.util.spec_from_file_location("_dordiai_word_routing", Path(__file__).with_name("language_routing.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def word_language(token):
    first = token[0]
    if first.isdecimal():
        return None
    return "en" if re.fullmatch(r"[A-Za-zÀ-ÖØ-öø-ÿĀ-ž]", first) else "uk"


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
    "загрузки", "загрузка", "загрузок", "где", "кто", "какой", "какая", "какие", "нет", "есть",
    "пользователь", "свойства", "настройки",
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


# Common shared spellings are explicitly retained because the recovered hashed
# lexicons are incomplete and a missing RU/UA entry does not prove uniqueness.
SHARED_CYRILLIC_WORDS = frozenset((
    "голос", "кнопка", "мама", "вода", "сад", "дар", "мир", "роман", "спорт", "порт", "парк",
    "банк", "балкон", "салон", "телефон", "текст", "автор", "команда", "номер", "метр", "тонна", "том",
    "так", "там", "тут", "то", "за", "на", "до", "по", "про", "без", "не", "нас", "вас", "вам", "нам",
    "я", "в", "у", "з", "а", "ну", "о", "об", "завтра", "сказала", "рада", "рано", "стоп", "старт", "меню",
))


@lru_cache(maxsize=1)
def supplemental_cyrillic_index():
    """Exact word->language bitset with both labels retained for homographs."""
    path = Path(__file__).with_name("models") / "WordLanguage" / "cyrillic-lexicon.json.gz"
    try:
        with gzip.open(path, "rt", encoding="utf8") as stream:
            document = json.load(stream)
        if document.get("format") != "dordiai-cyrillic-lexicon-v1" or document.get("codes") != ["uk", "ru"]:
            return {}
        words = document["words"]
        if not isinstance(words, dict) or any(not isinstance(word, str) or bits not in (1, 2, 3)
                                              for word, bits in words.items()):
            return {}
        return words
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def native_cyrillic_word_candidates(word):
    """Consult the one owned reader BEFORE any legacy decision cache."""
    manager = sys.modules.get("_dordiai_main_native_membership_runtime")
    return manager.candidates(word) if manager is not None else frozenset()


def cyrillic_word_candidates(word):
    # Pass the original spelling: the primary source also normalizes U+2018 and
    # U+02BC apostrophes, while the frozen classifier's normalization stays fixed.
    primary = native_cyrillic_word_candidates(word)
    if primary:
        return primary
    return legacy_cyrillic_word_candidates(word)


@lru_cache(maxsize=4096)
def legacy_cyrillic_word_candidates(word):
    """Return all lexical UA/RU candidates, preserving shared spellings."""
    word = routing_policy().normalize_word(word)
    ukrainian = any(letter in word for letter in "іїєґ")
    russian = any(letter in word for letter in "ыэёъ")
    if ukrainian != russian:
        return frozenset(("uk" if ukrainian else "ru",))
    # Mixed exclusive letters indicate a typo/mixed token, not a confident label.
    if ukrainian and russian:
        return frozenset()
    if word in SHARED_CYRILLIC_WORDS:
        return frozenset(("uk", "ru"))
    uk_cue = word in UKRAINIAN_CUES
    ru_cue = word in RUSSIAN_CUES
    if uk_cue != ru_cue:
        return frozenset(("uk" if uk_cue else "ru",))
    bits = supplemental_cyrillic_index().get(word)
    if bits:
        return frozenset(code for index, code in enumerate(("uk", "ru")) if bits & (1 << index))
    candidates = set()
    if word in UKRAINIAN_CUES:
        candidates.add("uk")
    if word in RUSSIAN_CUES:
        candidates.add("ru")
    if len(word) >= 3:
        uk_words, ru_words = cyrillic_word_index()
        key = crc32(word.encode("utf8"))
        if contains_hash(uk_words, key):
            candidates.add("uk")
        if contains_hash(ru_words, key):
            candidates.add("ru")
    return frozenset(candidates)


# Preserve public cache inspection/clearing used by existing diagnostic tools.
# The public wrapper itself is never cached, so a new dataset cannot return an
# old same-word primary decision from this LRU.
cyrillic_word_candidates.cache_clear = legacy_cyrillic_word_candidates.cache_clear
cyrillic_word_candidates.cache_info = legacy_cyrillic_word_candidates.cache_info


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


def cyrillic_language(text, fallback="uk", *, enabled_languages=None):
    policy = routing_policy()
    fallback = policy.fallback_language(fallback, enabled_languages)
    allowed = policy.enabled_keys(enabled_languages)
    words = tuple(dict.fromkeys(match.group() for match in WORDS.finditer(text.casefold().replace("\u0301", ""))
                                if word_language(match.group()) == "uk"))
    if not words or sum(map(len, words)) <= 1:
        return fallback
    if len(words) == 1:
        candidates = cyrillic_word_candidates(words[0])
        if candidates:
            return policy.resolve_word(words[0], fallback, allowed, candidates=candidates).language
    spread = "".join(words)
    uk = any(letter in spread for letter in "іїєґ")
    ru = any(letter in spread for letter in "ыэёъ")
    if uk != ru:
        result = "uk" if uk else "ru"
        return result if allowed is None or result in allowed else fallback
    candidates = [cyrillic_word_candidates(word) for word in words]
    unique = {next(iter(options)) for options in candidates if len(options) == 1}
    if len(unique) == 1:
        result = next(iter(unique))
        return result if allowed is None or result in allowed else fallback
    if candidates and all(options == {"uk", "ru"} for options in candidates):
        # Character statistics cannot disambiguate a line of known homographs.
        return fallback
    hints = set(words)
    cue_uk = len((hints & UKRAINIAN_CUES) - RUSSIAN_CUES)
    cue_ru = len((hints & RUSSIAN_CUES) - UKRAINIAN_CUES)
    lexical = sum(map(cyrillic_word_score, words))
    statistics = sum(map(cyrillic_ngram_score, words)) if any(len(word) > 1 for word in words) else 0.
    score = statistics + .42 * lexical + 3.25 * (cue_ru - cue_uk)
    result = "ru" if score >= 1.3 else "uk" if score <= -1.3 else fallback
    return result if allowed is None or result in allowed else fallback


def split_mixed(text, fallback="uk", *, detect_russian=False, enabled_languages=None, word_mode=False):
    policy = routing_policy()
    fallback = policy.fallback_language(fallback, enabled_languages)
    allowed = policy.enabled_keys(enabled_languages)
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
        # Strong lexical words must not be swallowed by the language of a whole
        # Cyrillic clause. In context mode, short ambiguous words stay stable.
        current = fallback
        for i, match in enumerate(matches):
            if languages[i] not in {"uk", "ru"}:
                continue
            word = policy.normalize_word(match.group())
            candidates = cyrillic_word_candidates(word)
            if len(candidates) == 1 or word_mode:
                preferred = current if word_mode else languages[i]
                def classify_unknown(token):
                    if policy.has_word_classifier():
                        return policy.classify_word(token, allowed)
                    score = cyrillic_ngram_score(token)
                    # The existing character model supplies relative evidence,
                    # not a calibrated probability of language correctness.
                    confidence = min(1., abs(score) / 3.)
                    return ("ru" if score > 0 else "uk"), confidence
                decision = policy.resolve_word(word, preferred, allowed, candidates=candidates,
                                               classifier=classify_unknown)
                languages[i] = decision.language
            current = languages[i]
    if allowed is not None:
        languages = [language if language is None or language in allowed else fallback for language in languages]
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


def speak_numbers(text, language, input_language=None):
    from num2words import num2words

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
            spoken = num2words(int(whole), lang=language)
        if sep:
            spoken += {"en": " point ", "ru": " запятая ", "uk": " кома "}[language] + digits(decimal)
        return spoken

    return NUMBER[input_language].sub(replace, text)


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
