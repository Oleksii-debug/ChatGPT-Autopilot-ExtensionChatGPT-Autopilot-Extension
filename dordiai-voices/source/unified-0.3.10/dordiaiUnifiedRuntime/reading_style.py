"""Reading style and language preparation for the single-model driver."""
import re

from speech_text import split_mixed, speak_numbers, english_numeric_text, script_mismatch

from data_registry import REGISTRY
PROFILES = REGISTRY.names()
STYLES = {
    "plain": "Звичайне",
    "narration": "Начитка книги",
    "warm": "Радісно",
    "sad": "Сумно",
    "angry": "Сердито",
}

# The settings adjust pace, pitch (semitones), and dynamics independently of the model.
DELIVERY = {
    "plain": (1.00, 0.0, 1.00),
    "narration": (0.97, 0.0, 0.98),
    "warm": (1.04, 0.9, 1.04),
    "sad": (0.89, -1.2, 0.88),
    "angry": (1.06, -0.5, 1.08),
}
MARKER = re.compile(
    r"\[(?:"
    r"(?P<warm>з усмішкою|радісно|with a smile|joyfully|с улыбкой|радостно)"
    r"|(?P<sad>сумно|sadly|грустно)"
    r"|(?P<angry>сердито|angrily|гневно)"
    r"|(?P<laugh>сміється|laughs|laughter|смеётся|смеется)"
    r")\]", re.IGNORECASE
)
CUES = {
    "warm": re.compile(r"\b(?:усміхнул\w*|посміхнул\w*|радісно|smiled|grinned|joyfully|улыбнул\w*|радостно)\b", re.I),
    "sad": re.compile(r"\b(?:схлипнул\w*|сумно|заплака\w*|sadly|sobbed|заплака\w*|всхлипнул\w*|грустно)\b", re.I),
    "angry": re.compile(r"\b(?:сердито|розлютив\w*|angrily|furious|рассердил\w*|разозлил\w*)\b", re.I),
}
DIALOGUE = re.compile(r"^[—–]|[«»“”]|[\"\n]")
UK_UI_COMMANDS = frozenset(("робочий стіл", "документ", "готово", "зберегти", "відкрити"))
MODEL_TAG = re.compile(r"\[(?:laughter|sigh|(?:surprise|question|confirmation|dissatisfaction)-[a-z]+)\]")


def locale(tag):
    return REGISTRY.locale(tag)


def prepare_runs(segments, default, number_language, detect_russian, spelling=False,registry=None):
    """Keep code switching in the same model call; preserve explicit locale for monolingual spans."""
    registry=registry or REGISTRY
    if spelling:
        lang, text = segments[0]
        return [(registry.locale(lang), text)]
    runs = []
    for hint, text in segments:
        lang = registry.locale(hint or default)
        if hint and registry.native_carrier(lang) and not script_mismatch(text, lang):
            runs.append((lang, text))
            continue
        if hint is None and lang == "uk" and text.strip().casefold() in UK_UI_COMMANDS:
            hint = "uk"
        cyrillic = lang if lang in ('uk', 'ru') else 'uk'
        detect = detect_russian and (not hint or lang not in ('uk', 'ru'))
        # The acoustic markers must reach the model verbatim. Their internal
        # Latin spelling is metadata and must not trigger an English run.
        tags = {}
        def keep(match):
            placeholder = chr(0xE000 + len(tags))
            tags[placeholder] = match.group()
            return placeholder
        protected = MODEL_TAG.sub(keep, text)
        parts=[]
        for code,span in split_mixed(protected,cyrillic,detect_russian=detect):
            if code=='en' and hint and lang not in ('uk','ru') and lang in registry.languages:
                parts.append((lang,span))
            elif code=='en':
                from latin_languages import language_runs
                parts.extend(language_runs(span))
            else:
                parts.append((code,span))
        for code, span in parts:
            if lang == "ru" and code == "uk":
                code = "ru"
            target = code if number_language == "auto" else number_language
            if registry.native_carrier(code):
                # Native eSpeak phonemization handles numeric grammar for these packs.
                for placeholder, tag in tags.items():
                    span = span.replace(placeholder, tag)
                runs.append((code, span))
                continue
            if any(char.isdecimal() for char in span):
                if code == target == "en":
                    span = english_numeric_text(span)
                span = speak_numbers(span, target, code)
                if span and all(char.isdecimal() or char.isspace() for char in text):
                    code = target
            for placeholder, tag in tags.items():
                span = span.replace(placeholder, tag)
            if code == "en" and (hint or "").lower().replace("_","-") == "en-gb":
                code = "en-gb"
            runs.append((code, span))
    return runs


def prepare(segments, default, number_language, detect_russian, spelling=False):
    runs = prepare_runs(segments, default, number_language, detect_russian, spelling)
    languages = {code for code, span in runs if span.strip()}
    return next(iter(languages)) if len(languages) == 1 else None, " ".join(span for _, span in runs)


def style_for(text, selected, spelling=False):
    if spelling or selected == "plain":
        return selected if not spelling else "plain", text
    marker = MARKER.search(text)
    chosen = selected
    if selected == "narration" and marker is not None:
        chosen = "warm" if marker.lastgroup == "laugh" else marker.lastgroup
    elif selected == "narration" and DIALOGUE.search(text):
        cues = [name for name, pattern in CUES.items() if pattern.search(text)]
        if len(cues) == 1:
            chosen = cues[0]
    return chosen, MARKER.sub(lambda match: "[laughter]" if match.lastgroup == "laugh" else "", text).strip()


def punctuation_pause(text, style, rate):
    """Add a small line-final beat during narration. Internal punctuation stays in the TTS input."""
    ending = text.rstrip("»”\"')] ")
    if style == "plain" or not ending.endswith((".", "!", "?", "…", ":", ";")):
        return 0
    seconds = 0.20 if ending.endswith(("…", "...")) else 0.10 if ending.endswith((".", "!", "?")) else 0.055
    return round(rate * seconds)
