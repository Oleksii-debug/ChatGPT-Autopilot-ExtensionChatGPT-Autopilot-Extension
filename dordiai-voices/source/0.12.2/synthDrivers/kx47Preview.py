"""NVDA adapter for the KX-47 local speech engine."""

import base64
import atexit
import importlib.util
from collections import OrderedDict
from contextlib import closing
import json
from hashlib import sha256
from pathlib import Path
from queue import Empty, Full, Queue
import re
import subprocess
import sys
from time import monotonic
from threading import Condition, Thread, RLock
from unicodedata import normalize
import wave

from autoSettingsUtils.driverSetting import BooleanDriverSetting, DriverSetting, NumericDriverSetting
import config
import nvwave
from logHandler import log
from speech.commands import BreakCommand, CharacterModeCommand, IndexCommand, LangChangeCommand, PitchCommand, RateCommand, VolumeCommand
from synthDriverHandler import SynthDriver as BaseDriver, VoiceInfo, synthDoneSpeaking, synthIndexReached


SAMPLE_RATE = 24000
RUNTIME = Path(__file__).resolve().parent.parent / "kx47Runtime"


def _runtime_module(name):
    """Load the same pure runtime helper in NVDA and the isolated worker."""
    key = "_dordiai_main_" + name
    if key not in sys.modules:
        spec = importlib.util.spec_from_file_location(key, RUNTIME / (name + ".py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[key] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(key, None)
            raise
    return sys.modules[key]


_voice_policy = _runtime_module("voice_policy")
_pref_spec = importlib.util.spec_from_file_location("_dordiai_main_preferences", RUNTIME / "preferences.py")
_prefs = importlib.util.module_from_spec(_pref_spec)
_pref_spec.loader.exec_module(_prefs)
CLASSMATE_PROFILE = 'veronika_classmate'
CLASSMATE_LOCALES = frozenset(('sk', 'pl', 'de', 'fr', 'da', 'it', 'es'))
_letter_spec = importlib.util.spec_from_file_location("_classmate_letter_names", RUNTIME / "experiment_letters.py")
_letter_names = importlib.util.module_from_spec(_letter_spec)
_letter_spec.loader.exec_module(_letter_names)
_text_spec = importlib.util.spec_from_file_location("_dordiai_speech_text", RUNTIME / "speech_text.py")
_speech_text = importlib.util.module_from_spec(_text_spec)
_text_spec.loader.exec_module(_speech_text)
_latin_spec = importlib.util.spec_from_file_location("_dordiai_latin_languages", RUNTIME / "latin_languages.py")
_latin = importlib.util.module_from_spec(_latin_spec)
_latin_spec.loader.exec_module(_latin)
_wide_spec = importlib.util.spec_from_file_location("_dordiai_wide_languages", RUNTIME / "wide_languages.py")
_wide = importlib.util.module_from_spec(_wide_spec)
_wide_spec.loader.exec_module(_wide)
PROFILES = {"a": "Тетяна / Heart / Emma", "b": "Лада / Bella / Alice"}
SCRIPT_RUNS = re.compile(
    r"[A-Za-z]+(?:['’][A-Za-z]+)*|[А-Яа-яІіЇїЄєҐґ\u0301]+",
)
VOICES = {
    f"{profile}:{mode}:{accent}": (
        f"{name} ({accent})" if mode == "pronunciation" else f"Supertonic F{number}",
        profile, mode, accent,
    )
    for number, (profile, name) in enumerate(PROFILES.items(), 1)
    for mode, accents in (("pronunciation", ("en-GB", "en-US")), ("same-voice", ("en-US",)))
    for accent in accents
}


REFERENCE_VOICES = {
    "brianna": ("Бріанна", "brianna", "reference", "en-US"),
    "sara": ("Сара", "sara", "reference", "en-US"),
}

UK_LETTERS = dict(zip("абвгґдеєжзиіїйклмнопрстуфхцчшщьюя", (
    "а", "бе", "ве", "ге", "ґе", "де", "е", "є", "же", "зе", "и", "і", "ї", "йот",
    "ка", "ел", "ем", "ен", "о", "пе", "ер", "ес", "те", "у", "еф", "ха", "це",
    "че", "ша", "ща", "м'який знак", "ю", "я",
)))
EN_LETTERS = dict(zip("abcdefghijklmnopqrstuvwxyz", (
    "ay", "bee", "see", "dee", "ee", "ef", "gee", "aitch", "eye", "jay", "kay",
    "el", "em", "en", "oh", "pee", "cue", "ar", "ess", "tee", "you", "vee",
    "double you", "ex", "why", "zee",
)))


RU_LETTERS = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя", (
    "а", "бэ", "вэ", "гэ", "дэ", "е", "ё", "жэ", "зэ", "и", "и краткое",
    "ка", "эл", "эм", "эн", "о", "пэ", "эр", "эс", "тэ", "у", "эф",
    "ха", "цэ", "чэ", "ша", "ща", "твёрдый знак", "ы", "мягкий знак", "э", "ю", "я",
)))


def latin_letter_language(lower, language):
    if not _latin.LATIN.fullmatch(lower):
        return None
    if language in _latin.EXTRA:
        return language
    if lower.isascii():
        return None
    candidates = [code for code, letters in _letter_names.EXTRAS.items() if lower in letters]
    return candidates[0] if len(candidates) == 1 else None


def character_parts(text, language, english, spelling_language="auto", explicit=False,
                    enabled_languages=None):
    preferred = _wide.registered(language)
    # A keyboard event is already associated with the current language. In
    # particular a shared Latin letter is not evidence for a new language.
    for code,span in _wide.split_extended(normalize("NFC",text), preferred=language,
                                        explicit=True, enabled_languages=enabled_languages):
        if code is None and preferred and not any(ch.isalpha() for ch in span):
            code = preferred
        if code is None:
            base = "uk" if preferred else language
            yield from core_character_parts(span, base, english, spelling_language)
        else:
            # A standalone combining mark still has a name. Keep dependent
            # vowel signs, accents and conjuncts attached to their base.
            from unicodedata import category, combining
            cluster = ""
            for char in span:
                continuation = cluster and (category(char).startswith("M") or char == "\u200d"
                                             or cluster[-1] == "\u200d" or combining(cluster[-1]) == 9)
                if cluster and not continuation:
                    yield "character", (code, cluster)
                    cluster = ""
                cluster += char
            if cluster:
                yield "character", (code, cluster)


def core_character_parts(text, language, english, spelling_language="auto"):
    for char in normalize('NFC', text):
        lower = char.lower()
        cyrillic = language if spelling_language == "auto" else spelling_language
        if lower in RU_LETTERS and (lower not in UK_LETTERS or cyrillic == "ru"):
            yield "character", ("ru", RU_LETTERS[lower])
        elif lower in UK_LETTERS:
            yield "character", ("uk", UK_LETTERS[lower])
        elif (foreign := latin_letter_language(lower, language)) is not None:
            yield "character", (foreign, lower if lower == "ß" else char.upper())
        elif lower in EN_LETTERS:
            name = "zed" if lower == "z" and language.lower() == "en-gb" else EN_LETTERS[lower]
            yield "character", (language if language.startswith("en") else english, name)
        elif char.isspace():
            yield "character", (language, {"ru": "пробел", "uk": "пробіл"}.get(language, "space"))
        else:
            yield "text", (language, char)


def language_code(value, fallback, english):
    registered = _wide.registered(value or "")
    if registered:
        return registered
    code = (value or "").lower().replace("_", "-")
    if code in ("en-gb", "en-us"):
        return code[:3] + code[3:].upper()
    base = code.split("-", 1)[0]
    return base if base in _latin.EXTRA else {"en": english, "uk": "uk", "ru": "ru"}.get(base, fallback)


def text_chunks(text, limit=280, first_limit=None):
    """Split long runs at whitespace while keeping punctuation and the given language."""
    text = text.strip()
    current_limit = first_limit or limit
    while len(text) > current_limit:
        near_start = text[:current_limit + 1]
        boundaries = list(re.finditer(r"[.!?…]\s+", near_start))
        split = boundaries[-1].start() + 1 if boundaries else max(
            (offset for offset, char in enumerate(near_start) if char.isspace()), default=-1,
        )
        split = split if split > 0 else min(len(text), limit)
        yield text[:split].rstrip()
        text = text[split:].lstrip()
        current_limit = limit
    if text:
        yield text


def language_runs(text, language, english, detect_russian=False, explicit=False,
                  enabled_languages=None, priorities=()):
    if explicit:
        yield language, text
        return
    for code,span in _wide.split_extended(text, preferred=language, explicit=False,
                                        enabled_languages=enabled_languages,
                                        mode="words", priorities=priorities):
        if code is None and _wide.registered(language) and not any(ch.isalpha() for ch in span):
            code = language
        if code is not None:
            yield code, span
        else:
            base = "uk" if _wide.registered(language) else language
            yield from core_language_runs(span, base, english, detect_russian,
                                          enabled_languages=enabled_languages, priorities=priorities)


def core_language_runs(text, language, english, detect_russian=False, explicit=False,
                       enabled_languages=None, priorities=()):
    """Route marked spans and use the local frequency dictionary for unmarked Latin."""
    default = language.lower().split("-")[0]
    if not re.search(r"[А-Яа-яІіЇїЄєҐґЁё]", text) and explicit and (default in _latin.EXTRA or default=="en"):
        yield language, text
        return
    latin = language if default in _latin.EXTRA or default=="en" else english
    preferred = latin.lower().split("-")[0]
    cyrillic = "ru" if language == "ru" else "uk"
    for target, run in _speech_text.split_mixed(
            text, cyrillic, detect_russian=detect_russian and cyrillic == "uk" and not explicit,
            enabled_languages=enabled_languages, word_mode=True):
        if target == "en":
            if explicit and default in _latin.CODES:
                yield latin, run
            else:
                for code, span in _latin.split_latin(run, preferred,
                                                     enabled_languages=enabled_languages,
                                                     mode="words", priorities=priorities):
                    yield (english if code=="en" else code), span
        else:
            yield ("ru" if language=="ru" else target), run


def text_parts(pending, language, english, mixed, detect_russian=False, spelling_language="auto", explicit=False,
               enabled_languages=None, priorities=()):
    text = normalize("NFC", " ".join(pending))
    if not text:
        return
    # NVDA can disable its CharacterMode commands, including through another
    # synthesizer's language router. A lone letter still needs its name; bare
    # consonant phonemes are not a reliable utterance for the neural model.
    if len(text) == 1 and (text.lower() in (UK_LETTERS.keys() | EN_LETTERS.keys() | RU_LETTERS.keys()) or _latin.LATIN.fullmatch(text.lower())):
        yield from character_parts(text, language, english, spelling_language, explicit,
                                   enabled_languages=enabled_languages)
        return
    if mixed:
        runs = ((code if code is not None else None if language=="uk" or _wide.registered(language) else language,span)
                for code,span in _wide.split_extended(text, preferred=language, explicit=explicit,
                                                     enabled_languages=enabled_languages,
                                                     mode="words", priorities=priorities))
    else:
        runs = language_runs(text, language, english, detect_russian, explicit,
                             enabled_languages=enabled_languages, priorities=priorities)
    for target, run in runs:
        chunks = text_chunks(run, limit=165)
        for chunk in chunks:
            yield "text", (target, chunk)


def speech_parts(sequence, fallback, english, mixed=False, detect_russian=False, spelling_language="auto",
                 enabled_languages=None, priorities=(), forced=False):
    lang = fallback
    explicit = forced
    pending = []
    characters = False
    for item in sequence:
        if isinstance(item, str):
            if characters:
                yield from character_parts(item, lang, english, spelling_language, explicit,
                                           enabled_languages=enabled_languages)
            elif item.strip():
                pending.append(item.strip())
            continue
        if isinstance(item, (LangChangeCommand, BreakCommand, IndexCommand, PitchCommand,
                             CharacterModeCommand, RateCommand, VolumeCommand)):
            yield from text_parts(pending, lang, english, mixed, detect_russian, spelling_language, explicit,
                                  enabled_languages=enabled_languages, priorities=priorities)
            pending.clear()
            if isinstance(item, LangChangeCommand):
                lang = fallback if forced else language_code(item.lang, fallback, english)
                if enabled_languages is not None and _prefs.language_key(lang) not in enabled_languages:
                    lang = fallback
                explicit = forced or bool(item.lang)
            elif isinstance(item, BreakCommand):
                yield "break", max(0, item.time)
            elif isinstance(item, PitchCommand):
                yield "pitch", item.newValue
            elif isinstance(item, RateCommand):
                yield "rate", item.newValue
            elif isinstance(item, VolumeCommand):
                yield "volume", item.newValue
            elif isinstance(item, CharacterModeCommand):
                characters = item.state
            else:
                yield "index", item.index
    yield from text_parts(pending, lang, english, mixed, detect_russian, spelling_language, explicit,
                          enabled_languages=enabled_languages, priorities=priorities)


def number_language_parts(parts, target):
    """Route a numeric override before choosing its language-specific voice.

    Keep literal numbers until the isolated speech worker expands them. NVDA
    itself does not have to import the bundled num2words dependency. The
    existing number grammar preserves decimal/group separators as one token.
    Only source grammars already implemented by speech_text are overridden;
    other languages keep their own model's number normalization.
    """
    for kind, value in parts:
        if kind != "text" or target not in {"uk", "en"}:
            yield kind, value
            continue
        language, text = value
        source = (language or "uk").lower().replace("_", "-").split("-")[0]
        if source == target or source not in _speech_text.NUMBER:
            yield kind, value
            continue
        offset = 0
        for match in _speech_text.NUMBER[source].finditer(text):
            if text[offset:match.start()].strip():
                yield kind, (language, text[offset:match.start()])
            literal = re.sub(r"[\u00a0\u202f ]", "", match.group())
            if source == "en":
                literal = literal.replace(",", "")
            if target == "en":
                literal = literal.replace(",", ".")
            yield kind, (target, literal)
            offset = match.end()
        if text[offset:].strip():
            yield kind, (language, text[offset:])


def initial_audio(items,minimum=0):
    """Preserve item order, normally delivering the first ready PCM at once.

    A minimum is retained for explicit callers, but normal playback must not
    wait for 0.6-1.2 seconds of future speech before starting. Bounded producer
    lookahead continues after playback starts.
    """
    prefix=[];size=0;ready=False
    try:
        for kind,value in items:
            if ready:
                yield kind,value
                continue
            if minimum <= 0:
                ready = True
                yield kind, value
                continue
            prefix.append((kind,value))
            if kind=='pcm':size+=len(value)
            if size>=minimum:
                ready=True
                yield from prefix
                prefix=[]
        yield from prefix
    finally:
        close=getattr(items,'close',None)
        if close is not None:close()


def buffered_items(produce, cancelled, *, pending_count=12, short_reserve=False, cancelling_threads=None):
    """Keep upcoming audio and index markers ready in delivery order."""
    if pending_count < 1:
        raise ValueError("Speech lookahead queue must have positive capacity")
    # Do not accumulate unlimited threads if a native backend refuses to
    # acknowledge cancellation. Existing workers have their stop flag set;
    # reject further synthesis until one exits rather than block NVDA forever.
    if cancelling_threads is not None:
        cancelling_threads[:] = [thread for thread in cancelling_threads if thread.is_alive()]
        if len(cancelling_threads) >= 2:
            raise RuntimeError("Previous speech workers have not acknowledged cancellation")
    pending = Queue(maxsize=pending_count)
    errors = []
    stopped = False

    def stop_requested():
        return stopped or cancelled()

    def fill():
        source = None
        try:
            source = produce(stop_requested)
            for item in source:
                while not stop_requested():
                    try:
                        pending.put(item, timeout=.01)
                        break
                    except Full:
                        continue
                else:
                    break
        except Exception as error:
            if not stop_requested():
                errors.append(error)
        finally:
            close = getattr(source, "close", None)
            if close is not None:
                try:
                    close()
                except Exception as error:
                    if not stop_requested():
                        errors.append(error)

    producer = Thread(target=fill, daemon=True, name="dordiai speech lookahead")
    producer.start()
    try:
        while not stop_requested() and (producer.is_alive() or not pending.empty()):
            try:
                item = pending.get(timeout=.01)
            except Empty:
                continue
            # short_reserve is accepted for compatibility with older callers.
            # Never delay the first ready symbol/word for speculative audio.
            if not stop_requested():
                yield item
        if errors and not stop_requested():
            raise errors[0]
    finally:
        stopped = True
        if cancelling_threads is not None:
            cancelling_threads[:] = [thread for thread in cancelling_threads if thread.is_alive()]
        # Generator close also happens for errors and newer speech, not only
        # when cancelled() currently returns True. Cleanup must stay bounded.
        producer.join(timeout=.01)
        if cancelling_threads is not None and producer.is_alive():
            cancelling_threads.append(producer)


class SpeechWorker:
    def __init__(self, python, script, models, reference_config=None, preload_language="mixed"):
        self._command = [str(python), "-I", "-B", "-u", str(script), str(models)]
        if reference_config is not None:
            model, samples, engine = reference_config
            self._command.extend(("--reference-model", str(model), "--references", str(samples), "--reference-engine", engine))
        self._command.extend(("--preload-language", preload_language))
        self._process = None
        self._responses = None
        self._clips = OrderedDict()
        self._cache_lock = RLock()
        self._io = RLock()
        self._ready_modes = set()
        self._navigation = OrderedDict()
        self._references = Path(reference_config[1]) if reference_config else None
        from synthDrivers._dordiai_letter_bank import NativeLetterBank
        self._letterBank = NativeLetterBank(self._references)
        self._commandBank = NativeLetterBank(self._references, "native_commands")
        self._wideNavigation = {}

    def fast_clip(self, request):
        """Read prepared speech without waiting for any neural model or worker."""
        if request.get("danishCommands") and not request.get("character") and not request.get("segments"):
            pcm = self._commandBank.read(request["profile"], "da", request["text"])
            if pcm is not None:
                return self._control_prepared_clip(request, pcm, native=True)
        if request.get("wideLocale") and not request.get("segments") and len(request["text"])<=160:
            code = _wide.registered(request["language"])
            if code and self._references is not None:
                if code not in self._wideNavigation:
                    from synthDrivers._dordiai_letter_bank import NativeLetterBank
                    folder = self._references.parent / "WideLanguages" / "navigation"
                    self._wideNavigation[code] = NativeLetterBank(folder, code) if (folder / code).is_dir() else None
                bank = self._wideNavigation[code]
                if bank is not None:
                    kind = "-char" if request.get("character") else "-text"
                    pcm = bank.read(request["profile"], code + kind, normalize("NFC",request["text"]))
                    if pcm is not None:
                        return self._control_prepared_clip(request, pcm, native=True)
        cached=self._cached_clip(request)
        if cached is not None:return cached
        if request.get("wideLocale"):
            return None
        if request.get("nativeLocale") and request["profile"] != CLASSMATE_PROFILE and not request.get("character"):
            # Older immutable clips of these phrases use Ukrainian acoustic approximations.
            return None
        if self._references is None or request.get("segments"):
            return None
        language = (request.get("language") or ("en-us" if re.search(r"[A-Za-z]", request["text"]) else "uk")).lower().replace("_", "-")
        language = "en-us" if language == "en" else language
        spelling = request.get("character") and language in {"uk", "en-us", "en-gb", "ru"}
        if spelling and language == "en-gb" and request["text"] != "zed":
            language = "en-us"
        native = request.get("nativeEnglish", False) and not request["text"].isdecimal()
        if any(char.isdecimal() for char in request["text"]) and (
                language != "uk" or request.get("numberLanguage", "auto") != "auto"):
            return None
        if spelling:
            cache = "navigation"
        elif request.get("nativeProfile") and not request["text"].isdecimal():
            cache = "navigation_profile"
            if language == "en-gb":
                language = "en-us"
        else:
            cache = "navigation_native" if native else "navigation"
        clip_text = request.get("letterCacheText", request["text"])
        core_at_cap = False
        if (spelling and language == "uk" and request["speed"] == 2.0 and clip_text in {"є", "ес", "ї"}):
            digest = sha256(("uk\0" + clip_text.strip().casefold()).encode("utf8")).hexdigest()[:24] + ".wav"
            if (self._references / "core_spelling_2x" / request["profile"] / digest).is_file():
                cache = "core_spelling_2x"
                core_at_cap = True
        native_letter = bool(request.get("character") and (request.get("nativeLocale") or request.get("preparedLetterName"))
                             and language in CLASSMATE_LOCALES)
        key = (cache, request["profile"], language, clip_text, native_letter)
        if key not in self._navigation:
            name = sha256((language + "\0" + clip_text.strip().casefold()).encode("utf-8")).hexdigest()[:24] + ".wav"
            path = self._references / cache / request["profile"] / name
            if path.is_file():
                with wave.open(str(path), "rb") as source:
                    if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, SAMPLE_RATE):
                        raise ValueError("Invalid prepared speech format")
                    pcm = source.readframes(source.getnframes())
            elif native_letter:
                pcm = self._letterBank.read(request["profile"], language, request.get("preparedLetterName", request["text"]))
                if pcm is None:
                    return None
            else:
                return None
            self._navigation[key] = pcm
            if len(self._navigation) > 256:
                self._navigation.popitem(last=False)
        pcm = self._navigation[key]
        self._navigation.move_to_end(key)
        if core_at_cap:
            request = dict(request, speed=1.0)
        return self._control_prepared_clip(request, pcm, native_letter or core_at_cap)

    @staticmethod
    def _control_prepared_clip(request, pcm, native):
        controls = request.get("controls", {})
        if native and controls.get("volume", 100) == 0 and request["speed"] == 1.0:
            return bytes(len(pcm))
        if (native and request["speed"] == 1.0 and controls.get("pitch", 50) == 50
                and controls.get("timbre", 50) == 50 and controls.get("volume", 100) == 100):
            return pcm
        from ctypes import c_short, cast, byref, POINTER
        from synthDrivers import _sonic
        _sonic.initialize()
        custom = controls.get("pitch", 50) != 50 or controls.get("timbre", 50) != 50
        speed = request["speed"]
        ratios = (speed,) if speed <= 4 else (speed ** .5, speed ** .5)
        volume = 1.0 if custom else controls.get("volume", 100) / 100
        for index, ratio in enumerate(ratios):
            sonic = _sonic.SonicStream(SAMPLE_RATE, 1)
            sonic.speed = ratio
            sonic.volume = volume if index == len(ratios) - 1 else 1.0
            data = (c_short * (len(pcm) // 2)).from_buffer_copy(pcm)
            quantum = SAMPLE_RATE // 25
            for offset in range(0, len(data), quantum):
                sonic.writeShort(cast(byref(data, offset * 2), POINTER(c_short)), min(quantum, len(data) - offset))
            sonic.flush()
            changed = bytes(sonic.readShort())
            if changed:
                pcm = changed
        if native and controls.get("volume", 100) == 0:
            return bytes(len(pcm))
        if custom:
            from synthDrivers._dordiai_audio import control_pcm
            pcm = control_pcm(pcm, RUNTIME / "python/rubberband-3.dll", SAMPLE_RATE,
                              controls.get("pitch", 50), controls.get("timbre", 50), controls.get("volume", 100))
        return pcm

    @staticmethod
    def _read(process, responses):
        try:
            for line in process.stdout:
                responses.put(line)
        finally:
            responses.put(None)

    def _send(self, request):
        if self._process is not None and self._process.poll() is not None:self.close()
        if self._process is None:
            self._process = subprocess.Popen(
                self._command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS,
            )
            self._responses = Queue()
            Thread(target=self._read, args=(self._process, self._responses), daemon=True).start()
        try:
            self._process.stdin.write((json.dumps(request) + "\n").encode("ascii"))
            self._process.stdin.flush()
        except OSError:
            self.close()
            raise

    def _receive(self, timeout, cancelled=None):
        try:
            deadline = monotonic() + timeout
            cold_limit = deadline + 45
            cancel_sent = False
            while True:
                remaining = deadline - monotonic()
                if remaining <= 0:
                    raise Empty
                try:
                    line = self._responses.get(timeout=min(remaining, 0.01) if cancelled else remaining)
                    if line and line.startswith(b'{"loadingStage":'):
                        stage = json.loads(line).get("loadingStage")
                        if stage not in {"language-source", "selected-voice", "voice-decoder", "language-phonetics"}:
                            raise ValueError("Unexpected speech loading state")
                        if cancelled is not None and not cancel_sent and not cancelled():
                            deadline = min(cold_limit, monotonic() + max(35,timeout))
                        continue
                    break
                except Empty:
                    if cancelled and cancelled():
                        if not cancel_sent:
                            self._send({"mode": "cancel"})
                            cancel_sent = True
                            # A slow/stuck native call is exceptional. Normal cancellation
                            # finishes after its current model stage, retaining warm models.
                            deadline = min(deadline, monotonic() + 5)
            if line is None:
                raise RuntimeError("Speech worker closed its response pipe.")
            result = json.loads(line)
        except (OSError, Empty, ValueError, RuntimeError):
            self.close()
            raise
        if "error" in result:
            raise RuntimeError(result["error"])
        return result

    def discard_forecast(self, token):
        with self._io:
            if self._process is not None and self._process.poll() is None:
                try:
                    self._send({"mode": "discardForecast", "token": token})
                except OSError:
                    pass

    def preload(self, *, runtime_only=False):
        with self._io:
            if (runtime_only in self._ready_modes and self._process is not None
                    and self._process.poll() is None):return
            self._send({"mode": "preload", "runtimeOnly": runtime_only})
            if not self._receive(25).get("ready"):
                raise RuntimeError("Speech worker preload failed.")
            self._ready_modes.add(runtime_only)

    @staticmethod
    def _decode(pcm):
        data = base64.b64decode(pcm, validate=True)
        if len(data) < 2 or len(data) % 2:
            raise ValueError("Speech worker returned malformed PCM audio.")
        return data

    @staticmethod
    def _clip_key(request):
        if request.get('mode')!='reference' or len(request.get('text',''))>240:return None
        return json.dumps({key:value for key,value in request.items() if key not in {'stream','nextNative'}},
                          sort_keys=True,ensure_ascii=True)

    def _cached_clip(self,request):
        key=self._clip_key(request)
        with self._cache_lock:
            cached=self._clips.get(key) if key is not None else None
            if cached is not None:self._clips.move_to_end(key)
            return cached

    def _remember_clip(self,key,data):
        with self._cache_lock:
            self._clips[key]=data
            self._clips.move_to_end(key)
            while len(self._clips)>256 or sum(map(len,self._clips.values()))>48*1024*1024:
                self._clips.popitem(last=False)

    def stream(self, request, cancelled):
        while not cancelled():
            if self._io.acquire(timeout=.012):
                try:
                    if not cancelled():
                        yield from self._stream(request,cancelled)
                finally:
                    self._io.release()
                return

    def _stream(self, request, cancelled):
        clip_key = self._clip_key(request)
        cached=self._cached_clip(request)
        if cached is not None:
            yield cached
            return

        retained = []
        retained_size=0
        self._send({**request, "stream": True, "reportLoading": bool(request.get("wideLocale"))})
        active = True
        pending = True
        try:
            while True:
                result = self._receive(20, cancelled)
                pending=False
                complete = result.get("finished", False) or "pcm" in result
                if complete:
                    active = False
                if cancelled():
                    return
                if result.get("finished"):
                    break
                pcm = self._decode(result["pcm" if complete else "chunk"])
                if clip_key is not None:
                    retained_size+=len(pcm)
                    if retained_size>SAMPLE_RATE*40:
                        clip_key=None;retained.clear()
                    else:retained.append(pcm)
                # Start the next neural block while the returned PCM is being
                # queued/played, rather than waiting for that audio to drain.
                if not complete:
                    self._send({"mode": "next"})
                    pending=True
                yield pcm
                if complete:
                    break
                if cancelled():
                    return
        finally:
            if active and self._process is not None:
                try:
                    self._send({"mode": "cancel"})
                    self._send({"mode": "drop"})
                    if pending:self._receive(5)
                    if not self._receive(5).get('finished'):
                        raise RuntimeError('Speech cancellation was not acknowledged')
                except (OSError, Empty, ValueError, RuntimeError):
                    self.close()
        if cancelled():
            return
        if retained and clip_key is not None:
            combined = b"".join(retained)
            self._remember_clip(clip_key,combined)

    def render(self, request):
        return b"".join(self.stream(request, lambda: False))

    def buffered_stream(self, request, cancelled):
        yield from buffered_items(lambda stop: self.stream(request, stop), cancelled, pending_count=2)

    def close(self):
        self._ready_modes.clear()
        process, self._process = self._process, None
        if process is not None:
            try:
                if process.poll() is None:
                    process.kill()
                process.wait()
            finally:
                process.stdin.close()
                process.stdout.close()


_shared_lock=RLock()
_shared_entry=None


def acquire_shared_worker(python,script,models,reference_config,language):
    """Reuse one inactive main worker; concurrent bridge instances stay private."""
    global _shared_entry
    key=(str(python),str(script),str(models),tuple(map(str,reference_config or ())),language)
    with _shared_lock:
        if _shared_entry is not None and _shared_entry['lease'] is not None:
            return SpeechWorker(python,script,models,reference_config,language),None
        if _shared_entry is None or _shared_entry['key']!=key:
            if _shared_entry is not None:_shared_entry['worker'].close()
            _shared_entry=dict(key=key,worker=SpeechWorker(python,script,models,reference_config,language),lease=None)
        token=object();_shared_entry['lease']=token
        return _shared_entry['worker'],token


def release_shared_worker(token):
    with _shared_lock:
        if token is not None and _shared_entry is not None and _shared_entry['lease'] is token:
            _shared_entry['lease']=None


def close_shared_worker():
    global _shared_entry
    with _shared_lock:
        if _shared_entry is not None:
            _shared_entry['worker'].close();_shared_entry=None


atexit.register(close_shared_worker)


class SynthDriver(_prefs.PreferencesMixin, BaseDriver):
    name = "kx47Preview"
    description = "dordiai-voices"
    supportedSettings = (
        BaseDriver.VoiceSetting(), BaseDriver.RateSetting(), BaseDriver.PitchSetting(),
        BaseDriver.VolumeSetting(),
        NumericDriverSetting("timbre", "&Тембр", availableInSettingsRing=True),
        NumericDriverSetting("rateMultiplier", "Множник швидкості", availableInSettingsRing=True,
                             defaultVal=1, minVal=1, maxVal=5, normalStep=1, largeStep=1),
        BooleanDriverSetting("detectRussian", "Розпізнавати російський текст", defaultVal=True),
        DriverSetting("foreignPronunciation", "Вимова інших мов", availableInSettingsRing=True, defaultVal="auto"),
        DriverSetting("numberLanguage", "Мова чисел", availableInSettingsRing=True, defaultVal="auto"),
        DriverSetting("spellingLanguage", "Мова кириличних літер", availableInSettingsRing=True, defaultVal="auto"),
        DriverSetting("envoice", "Англійський голос", availableInSettingsRing=True, defaultVal="main"),
        BooleanDriverSetting("enIndependent", "Окремі параметри англійської", availableInSettingsRing=True),
        NumericDriverSetting("enRate", "Англійська швидкість", availableInSettingsRing=True),
        NumericDriverSetting("enPitch", "Англійська висота", availableInSettingsRing=True),
        NumericDriverSetting("enTimbre", "Англійський тембр", availableInSettingsRing=True),
        NumericDriverSetting("enVolume", "Англійська гучність", availableInSettingsRing=True, defaultVal=100),
        DriverSetting("ruvoice", "Російський голос", availableInSettingsRing=True, defaultVal="main"),
        BooleanDriverSetting("ruIndependent", "Окремі параметри російської", availableInSettingsRing=True),
        NumericDriverSetting("ruRate", "Російська швидкість", availableInSettingsRing=True),
        NumericDriverSetting("ruPitch", "Російська висота", availableInSettingsRing=True),
        NumericDriverSetting("ruTimbre", "Російський тембр", availableInSettingsRing=True),
        NumericDriverSetting("ruVolume", "Російська гучність", availableInSettingsRing=True, defaultVal=100),
    )
    supportedCommands = frozenset({BreakCommand, CharacterModeCommand, IndexCommand, LangChangeCommand,
                                   PitchCommand, RateCommand, VolumeCommand})
    supportedNotifications = frozenset({synthDoneSpeaking, synthIndexReached})

    @classmethod
    def _runtime_config(cls):
        try:
            if (RUNTIME / "python" / "python.exe").is_file():
                python, models = RUNTIME / "python" / "python.exe", RUNTIME / "models"
                return python, models, {
                    "referencesOnly": True, "referenceEngine": "holos",
                    "referenceModel": models / "Holos", "referenceSamples": models / "voices",
                }
            info = json.loads((RUNTIME / "local-runtime.json").read_text(encoding="utf-8-sig"))
            python = Path(info["python"])
            models = Path(info["models"])
            if python.is_absolute() and models.is_absolute() and python.is_file() and models.is_dir():
                return python, models, info
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return None

    @classmethod
    def check(cls):
        return cls._runtime_config() is not None

    def __init__(self):
        self._dordiai_init()
        _wide.refresh_personal(True)
        if _wide.PERSONAL:
            self.supportedSettings=(*type(self).supportedSettings,DriverSetting(
                "personalLanguage","Мова тексту без позначки",availableInSettingsRing=True,defaultVal="auto"))
        runtime = self._runtime_config()
        if runtime is None:
            raise RuntimeError("Prepare the KX-47 runtime before selecting this synthesizer.")
        python, models, info = runtime
        _runtime_module("package_manager").recover_pending_install(RUNTIME.parent)
        self._models = models
        self._language_catalog = _runtime_module("language_catalog")
        self._voice_assets = _runtime_module("voice_assets")
        self._managedVoices = {}
        self._compatibleVoiceCache = {}
        self._installedLanguageCache = None
        self._voices = {} if info.get("referencesOnly") else dict(VOICES)
        self._warm = info.get("referenceEngine") in {"openvoice", "holos"}
        reference_config = None
        if "referenceModel" in info and "referenceSamples" in info:
            model, samples = Path(info["referenceModel"]), Path(info["referenceSamples"])
            if model.is_absolute() and samples.is_absolute() and model.is_dir() and samples.is_dir():
                reference_config = model, samples, info.get("referenceEngine", "omnivoice")
                self._voiceReferences = samples
                self._referenceEngine = info.get("referenceEngine", "omnivoice")
                if (samples / "catalog.json").is_file():
                    names = json.loads((samples / "catalog.json").read_text(encoding="utf-8"))
                    self._voices.update({
                        key: (name, key, "reference", "en-US")
                        for key, name in _voice_policy.filter_voice_catalog(names).items()
                    })
                else:
                    self._voices.update(REFERENCE_VOICES)
                self._managedVoices = self._voice_assets.discover_voices(
                    samples, engine_id=info.get("referenceEngine", "omnivoice"),
                )
                for key, document in self._managedVoices.items():
                    self._voices[key] = (document["name"], key, "reference", "en-US")
        self._voices = dict(_voice_policy.filter_voice_catalog(self._voices))
        if not self._voices:
            raise RuntimeError("No configured KX-47 voices are available.")
        self._voiceAliases = {}
        if reference_config:
            alias_file = Path(reference_config[1]) / "voice_aliases.json"
            if alias_file.is_file():
                aliases = json.loads(alias_file.read_text(encoding="utf-8"))
                self._voiceAliases = {old: new for old, new in aliases.items()
                                      if old not in self._voices and new in self._voices
                                      and _voice_policy.is_voice_allowed(old)}
        self._voice = next(iter(self._voices))
        self._rate = self._pitch = self._timbre = 50
        self._volume = 100
        self.rateMultiplier = 1
        self.detectRussian = True
        self.nativeEnglish = True
        self.sameVoiceForMixed = False
        self.nativeProfiles = True
        self.foreignPronunciation = "auto"
        self.numberLanguage = self.spellingLanguage = self.personalLanguage = "auto"
        self.envoice = self.ruvoice = "main"
        self.enIndependent = self.ruIndependent = False
        self.enRate = self.enPitch = self.enTimbre = 50
        self.ruRate = self.ruPitch = self.ruTimbre = 50
        self.enVolume = self.ruVolume = 100
        self._canJoin = info.get("referenceEngine") == "holos" and self.name == "kx47Preview"
        self._hasNativeEnglish = self._canJoin and (models / "english_voice_profiles.json").is_file()
        native_directory = Path(reference_config[1]) / "native_profiles" if reference_config else None
        self._hasNativeProfiles = bool(self._canJoin and native_directory and
                                       (native_directory / "delivery.json").is_file())
        self._state = Condition()
        self._generation = 0
        self._paused = False
        self._closed = False
        self._jobs = Queue()
        separate = info.get("referenceEngine") == "holos" and not self._canJoin
        self._worker_lease=None
        if self.name=='kx47Preview' and not separate:
            self._engine,self._worker_lease=acquire_shared_worker(python,RUNTIME/'nvda_worker.py',models,reference_config,'mixed')
        else:
            self._engine=SpeechWorker(python,RUNTIME/'nvda_worker.py',models,reference_config,'uk' if separate else 'mixed')
        self._english_engine = SpeechWorker(python, RUNTIME / "nvda_worker.py", models, reference_config, "en") if separate else None
        from synthDrivers import _sonic
        _sonic.initialize()
        self._player = nvwave.WavePlayer(1, SAMPLE_RATE, 16, outputDevice=config.conf["audio"]["outputDevice"])
        self._player.enableTrimmingLeadingSilence(False)
        self._thread = Thread(target=self._run, daemon=True, name="Diordiai speech")
        self._thread.start()


    def _dordiai_all_voices(self):
        return OrderedDict((key, value[0]) for key, value in self._voices.items())

    def _dordiai_all_languages(self):
        # Packs are activated on the next driver instance. An open worker must
        # never observe half of a newly installed or removed resource group.
        if self._installedLanguageCache is None:
            self._installedLanguageCache = self._language_catalog.installed_languages(self._models)
        return OrderedDict(self._installedLanguageCache)

    def _dordiai_compatible_voices(self, language):
        code = self._language_catalog.canonical_code(language)
        if code not in self._compatibleVoiceCache:
            built_in = self._language_catalog.compatible_voice_ids(
                self._models, code, tuple(self._voices),
            )
            managed = set()
            if code in self._dordiai_all_languages():
                required_role = {"uk": "holos_profile", "en": "pocket_english_state",
                                 "ru": "pocket_russian_prompt"}.get(code, "target_embedding")
                for voice, document in self._managedVoices.items():
                    languages = {self._language_catalog.canonical_code(c) for c in document["languages"]}
                    roles = {entry["role"] for entry in document["files"].values()}
                    if code in languages and required_role in roles:
                        managed.add(voice)
            self._compatibleVoiceCache[code] = tuple(
                voice for voice in self._voices
                if voice in managed or voice in built_in and voice not in self._managedVoices
            )
        return self._compatibleVoiceCache[code]

    def _getAvailableVoices(self):
        return self._dordiai_filter_voices(OrderedDict((key, VoiceInfo(key, value[0], "uk")) for key, value in self._voices.items()))

    def _get_availablePersonallanguages(self):
        _wide.refresh_personal(True)
        choices=OrderedDict(auto=VoiceInfo("auto","Автоматично"))
        choices.update((key,VoiceInfo(key,item["name"],key)) for key,item in _wide.PERSONAL.items())
        return choices

    def _get_availableLanguages(self):
        installed = set(self._dordiai_all_languages())
        variants = {"en_GB", "en_US"} if "en" in installed else set()
        return self._dordiai_filter_languages(installed | variants)

    def _get_availableEnvoices(self):
        names = OrderedDict(main=VoiceInfo("main", "Основний голос", "en"))
        compatible = self._dordiai_compatible_voices("en")
        names.update((key, VoiceInfo(key, self._voices[key][0], "en")) for key in compatible)
        return self._dordiai_filter_voices(names)

    def _get_availableForeignpronunciations(self):
        return OrderedDict(
            auto=VoiceInfo("auto", "Звичайна вимова вибраної мови"),
            native=VoiceInfo("native", "Вимова мовної моделі з тембром вибраного голосу"),
            fast=VoiceInfo("fast", "Швидка вимова"),
        )

    def _get_availableNumberlanguages(self):
        return OrderedDict(
            auto=VoiceInfo("auto", "За мовою тексту"),
            uk=VoiceInfo("uk", "Українська"),
            en=VoiceInfo("en", "Англійська"),
        )

    def _get_availableSpellinglanguages(self):
        return OrderedDict(
            auto=VoiceInfo("auto", "За мовою тексту"),
            uk=VoiceInfo("uk", "Українська"),
            ru=VoiceInfo("ru", "Російська"),
        )

    def _get_availableRuvoices(self):
        names = OrderedDict(main=VoiceInfo("main", "Основний голос", "ru"))
        compatible = self._dordiai_compatible_voices("ru")
        names.update((key, VoiceInfo(key, self._voices[key][0], "ru")) for key in compatible)
        return self._dordiai_filter_voices(names)

    def _resolve_voice_id(self, value):
        if not _voice_policy.is_voice_allowed(value):
            return value
        return self._voiceAliases.get(value, value)

    def _set_envoice(self, value):
        key = self._resolve_voice_id(value)
        self._envoice = key if key in self._voices and _voice_policy.is_voice_allowed(key) else "main"

    def _get_envoice(self):
        return self._envoice

    def _set_ruvoice(self, value):
        key = self._resolve_voice_id(value)
        self._ruvoice = key if key in self._voices and _voice_policy.is_voice_allowed(key) else "main"

    def _get_ruvoice(self):
        return self._ruvoice

    def _speech_roles(self):
        roles = {}
        for code in ("en", "ru"):
            key = "main" if self.sameVoiceForMixed else getattr(self, code + "voice")
            voice = self._voices.get(key, self._voices[self._voice])
            independent = getattr(self, code + "Independent")
            controls = {name: getattr(self, code + name.capitalize()) for name in ("pitch", "volume", "timbre")}
            roles[code] = (voice[1], getattr(self, code + "Rate"), controls if independent else None)
        return roles

    @staticmethod
    def _tempo(rate, multiplier):
        return min(10., 2 ** ((max(0, min(100, rate)) - 50) / 50) * max(1, min(5, multiplier)))

    def _planned_parts(self, sequence, profile, mode, english, rate, controls, roles, multiplier, russian,
                       native_english=False, same_voice_for_mixed=False, native_profiles=False, number_language="auto",
                       spelling_language="auto", foreign_pronunciation="auto"):
        default_language = self._dordiai_selection[2]
        forced = self._dordiai_mode == "forced"
        if forced or (number_language != "auto" and
                      _prefs.language_key(number_language) not in self._dordiai_enabled_languages):
            number_language = "auto"
        if forced or (spelling_language != "auto" and
                      _prefs.language_key(spelling_language) not in self._dordiai_enabled_languages):
            spelling_language = "auto"
        parts = speech_parts(
            sequence, default_language, english, detect_russian=russian,
            spelling_language=spelling_language,
            enabled_languages=self._dordiai_enabled_languages,
            priorities=(default_language,), forced=forced,
        )
        parts = number_language_parts(parts, number_language)
        # A language profile or the same-voice mode must never use the generic
        # Piper speaker, even if an older configuration enabled that setting.
        native_english = native_english and not (same_voice_for_mixed or native_profiles)
        pending = None
        for kind, value in parts:
            if kind not in {"text", "character"}:
                if pending is not None:
                    yield "text", pending
                    pending = None
                if kind in {"pitch", "volume"}:
                    controls[kind] = max(0, min(100, value))
                elif kind == "rate":
                    rate = value
                else:
                    yield kind, value
                continue
            language, text = value
            language = self._dordiai_language(language)
            language = (language or "uk").replace("_", "-").lower()
            wide_code = _wide.registered(language)
            language = wide_code or language
            role_profile, role_rate, role_controls = roles.get(language.split("-")[0], (profile, rate, None))
            if role_profile in self._dordiai_selection[0]:
                role_profile, role_rate, role_controls = profile, rate, None
            chosen_profile = self._dordiai_voice_for_language(language, role_profile)
            if chosen_profile != role_profile:
                role_rate, role_controls = rate, None
            role_profile = _voice_policy.require_voice_allowed(chosen_profile)
            if kind == "character" and role_profile == CLASSMATE_PROFILE and language in CLASSMATE_LOCALES:
                text = _letter_names.letter_name(language, text) or text
            speed = self._tempo(role_rate if role_controls is not None else rate, multiplier)
            if kind == "character":
                speed = min(speed, 2.0 if language in {"uk", "ru"} else 2.5)
            has_foreign_profile = role_profile != "anatolii"
            use_native_profiles = native_profiles or role_profile == CLASSMATE_PROFILE
            request = {"profile": role_profile, "mode": mode, "speed": speed,
                       "language": language, "text": text,
                       "controls": dict(controls if role_controls is None else role_controls),
                       "character": kind == "character",
                       # The numeric override was split before selecting its
                       # voice. Do not switch language again inside the worker.
                       "numberLanguage": "auto",
                       "nativeEnglish": has_foreign_profile and native_english and kind == "text" and language.startswith("en-"),
                       "nativeProfile": has_foreign_profile and use_native_profiles and
                           language in ("en", "en-us", "en-gb", "ru", "ru-ru")}
            if (kind == "text" and language.split("-")[0] == "da" and
                    foreign_pronunciation in {"auto", "native"}):
                request["danishCommands"] = True
            if wide_code:
                request["wideLocale"] = True
                request["nativeEnglish"] = request["nativeProfile"] = False
            if language in CLASSMATE_LOCALES:
                if kind == "character":
                    request["nativeLocale"] = foreign_pronunciation in {"auto", "native"}
                    if foreign_pronunciation == "auto" and role_profile != CLASSMATE_PROFILE:
                        prepared_name = _letter_names.letter_name(language, text)
                        if prepared_name:
                            # A recording is an immediate improvement. Preserve the old
                            # worker request if a future voice has no recording yet.
                            request["preparedLetterName"] = prepared_name
                    if role_profile != CLASSMATE_PROFILE and request["nativeLocale"]:
                        spoken = _letter_names.letter_name(language, text)
                        if spoken:
                            # Prefer an installed speaker recording under its
                            # original key, before rendering the language's letter name.
                            request["letterCacheText"] = text
                            request["text"] = spoken
                else:
                    request["nativeLocale"] = foreign_pronunciation in {"auto", "native"}
            same_delivery = pending is not None and all(pending[key] == request[key] for key in ("profile", "speed", "controls"))
            can_join = (self._canJoin and kind == "text" and same_delivery and
                        not (pending.get("wideLocale") or request.get("wideLocale")) and
                        not (pending.get("nativeLocale") or request.get("nativeLocale")) and
                        not pending["nativeEnglish"] and not request["nativeEnglish"] and
                        not pending["nativeProfile"] and not request["nativeProfile"] and
                        pending["language"] != language and len(pending["text"]) + len(text) < 165 and
                        not re.search(r"[.!?…][»”’\"\)\]]*$", pending["text"]))
            if can_join:
                pending.setdefault("segments", [[pending["language"], pending["text"]]]).append([language, text])
                pending["text"] += " " + text
                pending["language"] = language
                continue
            if pending is not None:
                yield "text", pending
                pending = None
            if kind == "character":
                yield kind, request
            else:
                pending = request
        if pending is not None:
            yield "text", pending

    def _get_voice(self):
        return self._voice

    def _set_voice(self, value):
        value = self._resolve_voice_id(value)
        if value in self._voices and _voice_policy.is_voice_allowed(value):
            self._voice = value

    def _get_rate(self):
        return self._rate

    def _set_rate(self, value):
        self._rate = max(0, min(100, int(value)))

    def _get_pitch(self):
        return self._pitch

    def _set_pitch(self, value):
        self._pitch = max(0, min(100, int(value)))

    def _get_volume(self):
        return self._volume

    def _set_volume(self, value):
        self._volume = max(0, min(100, int(value)))

    def _get_timbre(self):
        return self._timbre

    def _set_timbre(self, value):
        self._timbre = max(0, min(100, int(value)))

    def speak(self, speechSequence):
        with self._state:
            if not self._closed:
                controls = dict(pitch=self._pitch, volume=self._volume, timbre=self._timbre)
                roles = self._speech_roles() if self._canJoin else {}
                if self.personalLanguage!="auto" and self.personalLanguage in _wide.PERSONAL:
                    chosen=self.personalLanguage
                    speechSequence=(LangChangeCommand(chosen),*(LangChangeCommand(chosen)
                        if isinstance(item,LangChangeCommand) and not item.lang else item for item in speechSequence))

                from speech import sayAll
                continuous = bool(sayAll.SayAllHandler and sayAll.SayAllHandler.isRunning())
                self._jobs.put((self._generation, tuple(speechSequence), self._voice, self._rate, controls,
                                roles, self.rateMultiplier, self._canJoin and self.detectRussian,
                                self._hasNativeEnglish and not self._hasNativeProfiles,
                                self.sameVoiceForMixed,
                                self._hasNativeProfiles,
                                self.numberLanguage, self.spellingLanguage, self.foreignPronunciation, continuous))

    def cancel(self):
        with self._state:
            if self._closed:
                return
            self._generation += 1
            self._paused = False
            try:
                while True:
                    self._jobs.get_nowait()
            except Empty:
                pass
            self._player.stop()
            self._state.notify_all()

    def pause(self, switch):
        with self._state:
            if not self._closed:
                self._paused = switch
                self._player.pause(switch)
                self._state.notify_all()

    def terminate(self):
        with self._state:
            if self._closed:
                return
            self.cancel()
            self._closed = True
            self._jobs.put(None)
        # _run owns the worker until outstanding streams have acknowledged
        # cancellation. Releasing here lets a replacement driver reuse it
        # while this driver's old stream is still issuing cancel/drop.

    def _play(self, pcm, generation):
        frame_bytes = SAMPLE_RATE * 2 // 100
        for offset in range(0, len(pcm), frame_bytes):
            with self._state:
                self._state.wait_for(lambda: generation != self._generation or not self._paused)
                if generation != self._generation:
                    return
            self._player.feed(pcm[offset:offset + frame_bytes])
            if generation != self._generation:
                self._player.stop()
                return


    def _render_with_lookahead(self, parts, warm_threads, cancelled):
        from uuid import uuid4
        token = None
        def forecasts():
            nonlocal token
            previous = None
            for current in parts:
                if previous is not None:
                    kind, value = previous
                    next_kind, following = current
                    if (kind == next_kind == "text" and following.get("nativeLocale")
                            and min(value["speed"], following["speed"]) >= 3
                            and following["language"] in CLASSMATE_LOCALES
                            and value["language"] != following["language"]
                            and len(following["text"]) <= 200
                            and self._engine._cached_clip(following) is None
                            and not re.search(r"[.!?…].*\w", following["text"], re.DOTALL)):
                        if token is None:
                            token = uuid4().hex
                        value = dict(value, nextNative=(token, following["language"], following["text"]))
                    yield kind, value
                previous = current
            if previous is not None:
                yield previous
        try:
            yield from self._render_parts(forecasts(), warm_threads, cancelled)
        finally:
            if token is not None and cancelled():
                self._engine.discard_forecast(token)

    def _render_parts(self, parts, warm_threads, cancelled):
        # Bound lookahead in milliseconds even when a worker returns a full
        # cached sentence. One queue lets synthesis prepare the next language
        # while Windows is still playing the previous part.
        frame_bytes = SAMPLE_RATE * 2 // 100
        for kind, value in parts:
            if cancelled():
                return
            if kind == "index":
                yield kind, value
                continue
            try:
                if kind == "break":
                    blocks = iter((bytes(round(min(value, 10000) * SAMPLE_RATE / 1000) * 2),))
                else:
                    engine = self._english_engine if self._english_engine is not None and value["language"].startswith("en") else self._engine
                    cached = engine.fast_clip(value)
                    if cached is not None:
                        blocks = iter((cached,))
                    else:
                        warm = warm_threads.get(engine)
                        while warm is not None and warm.is_alive() and not cancelled():
                            warm.join(.01)
                        if cancelled():
                            return
                        warm_threads.pop(engine, None)
                        blocks = engine.stream(value, cancelled)
                try:
                    for pcm in blocks:
                        for offset in range(0, len(pcm), frame_bytes):
                            if cancelled():
                                return
                            yield "pcm", pcm[offset:offset + frame_bytes]
                finally:
                    close = getattr(blocks, "close", None)
                    if close is not None:
                        close()
            except Exception as error:
                if not cancelled():
                    log.error("dordiai-voices: speech synthesis failed (%s).", error)
                    # Continuing after a failed word silently loses text.
                    # Propagate to the output loop, which stops this utterance.
                    raise

    def _run(self):
        cancelling_threads = []
        try:
            warm_threads = {}
            if self._warm:
                def warm(engine):
                    try:
                        engine.preload(runtime_only=self._hasNativeProfiles)
                    except Exception as error:
                        log.warning("dordiai-voices: preload failed (%s).", type(error).__name__)
                for engine in (self._engine, self._english_engine):
                    if engine is not None:
                        thread = Thread(target=warm, args=(engine,), daemon=True, name="dordiai preload")
                        warm_threads[engine] = thread
                        thread.start()
            while (job := self._jobs.get()) is not None:
                (generation, sequence, voice, rate, controls, roles, multiplier, russian,
                 native_english, same_voice_for_mixed, native_profiles, number_language, spelling_language, foreign_pronunciation, continuous) = job
                _, profile, mode, english = self._voices[voice]
                render_parts = (self._render_with_lookahead if foreign_pronunciation in {"auto", "native"} and
                                self._tempo(rate, multiplier) >= 3 and not any(
                                    isinstance(item, CharacterModeCommand) and item.state
                                    for item in sequence) else self._render_parts)
                def produce(stop):
                    parts = self._planned_parts(sequence, profile, mode, english, rate, controls, roles,
                                                multiplier, russian, native_english, same_voice_for_mixed,
                                                native_profiles, number_language, spelling_language, foreign_pronunciation)
                    if continuous:
                        parts = list(parts)
                        spoken = [request for kind, request in parts if kind == "text"]
                        languages = {request["language"] for request in spoken}
                        if len(languages) > 1:
                            pcm = render_parts(parts, warm_threads, stop)
                            return pcm
                    return render_parts(parts, warm_threads, stop)
                short_reserve = False
                if (not continuous and self._tempo(rate, multiplier) >= 3 and
                        not any(isinstance(item, CharacterModeCommand) and item.state for item in sequence)):
                    langs = {item.lang.lower().replace("_", "-").split("-")[0] for item in sequence
                             if isinstance(item, LangChangeCommand) and item.lang}
                    short_reserve = len(langs) > 1
                    if not short_reserve:
                        words = " ".join(item for item in sequence if isinstance(item, str))
                        short_reserve = bool(re.search("[А-Яа-яІіЇїЄєҐґЁё]", words) and
                                             re.search("[a-zA-Z]", words))
                flow = buffered_items(produce, lambda: generation != self._generation,
                                      short_reserve=short_reserve, cancelling_threads=cancelling_threads)
                try:
                    with closing(flow):
                        for kind, value in flow:
                            with self._state:
                                self._state.wait_for(lambda: generation != self._generation or not self._paused)
                                if generation != self._generation:
                                    break
                            if kind == "index":
                                def reached(index=value, expected=generation):
                                    with self._state:
                                        if expected == self._generation:
                                            synthIndexReached.notify(synth=self, index=index)
                                self._player.feed(b"\x00\x00", onDone=reached)
                            else:
                                self._play(value, generation)
                except Exception as error:
                    if generation == self._generation:
                        log.error("dordiai-voices: speech output failed (%s).", error)
                        report = getattr(self, "_dordiai_report_error", None)
                        if report is not None:
                            report(error)
                if generation == self._generation and self._jobs.empty():
                    try:
                        self._player.idle()
                    except OSError:
                        log.error("dordiai-voices: audio device did not finish playback.")
                    with self._state:
                        if generation == self._generation and self._jobs.empty():
                            synthDoneSpeaking.notify(synth=self)
        finally:
            outstanding = [thread for thread in cancelling_threads + list(warm_threads.values())
                           if thread.is_alive()]
            for thread in outstanding:
                thread.join(timeout=.05)
            outstanding = [thread for thread in outstanding if thread.is_alive()]
            if self._worker_lease is None or outstanding:
                self._engine.close()
            if self._english_engine is not None:
                self._english_engine.close()
            if outstanding:
                # Keep a busy shared lease out of circulation even when a
                # defective native call does not terminate. Waiting happens
                # only in this daemon, never in NVDA's terminate() call.
                def release_when_quiet():
                    for thread in outstanding:
                        thread.join()
                    release_shared_worker(self._worker_lease)
                Thread(target=release_when_quiet, daemon=True,
                       name="dordiai retired worker cleanup").start()
            else:
                release_shared_worker(self._worker_lease)
            self._player.close()
