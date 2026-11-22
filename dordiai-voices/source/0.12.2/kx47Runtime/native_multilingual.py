"""Native foreign-language speech using a profile enrolled from the original voice."""
from __future__ import annotations

from functools import cached_property, lru_cache
import json
from pathlib import Path
import re
import struct
import subprocess
import sys
from threading import Lock
from contextlib import nullcontext, contextmanager

import numpy as np

from session_control import SynthesisCancelled
from speech_tempo import stream_tempo
from speech_text import english_text, number_parts, speak_numbers, split_mixed
from voice_delivery import compact_padding, condition_shared
from voice_assets import asset_path, native_settings, discover_voices, supports_language
from voice_policy import require_voice_allowed
from wide_warmup import foreground_priority


class RussianPipe:
    def __init__(self, model: Path, profiles: Path, executable: Path | None = None):
        self.model = model
        self.executable = executable if executable is not None else model / "pocket-ru.exe"
        self.profiles = profiles
        self.process = None

    def _read(self, size):
        result = bytearray()
        while len(result) < size:
            chunk = self.process.stdout.read(size - len(result))
            if not chunk:
                raise RuntimeError("Russian synthesis process closed its output.")
            result.extend(chunk)
        return result

    def _size(self):
        return struct.unpack("<I", self._read(4))[0]

    def _send(self, data):
        self.process.stdin.write(data)
        self.process.stdin.flush()

    def start(self, *, foreground=False):
        if self.process is not None and self.process.poll() is None:
            return
        self.close()
        self.process = subprocess.Popen(
            [
                str(self.executable), "serve-pipe",
                "--config", str(self.model / "config.yaml"), "--profiles", str(self.profiles),
            ],
            cwd=self.model,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS,
        )
        try:
            scope=(foreground_priority(process=int(self.process._handle)) if foreground else nullcontext())
            with scope:
                if self._size() != 24000:
                    raise ValueError("Unexpected Russian synthesis sample rate.")
        except (OSError, RuntimeError, ValueError):
            self.close()
            raise

    def close(self):
        process, self.process = self.process, None
        if process is not None:
            process.stdin.close()
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            finally:
                process.stdout.close()

    def stream(self, profile, text, cancelled=lambda: False, *, seed=None):
        self.start(foreground=True)
        awaiting_ack = False
        completed = False
        try:
            request = {"profile": profile, "text": text}
            if seed is not None:
                request["seed"] = seed
            command=(json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8")
            while True:
                # The child is deliberately created BELOW_NORMAL even when
                # its parent is foreground. Use its held Popen handle only;
                # never scan/reopen PIDs or affect another application.
                with foreground_priority(process=int(self.process._handle)):
                    self._send(command)
                    awaiting_ack = False
                    size = self._size()
                    if size == 0:
                        completed = True
                        return
                    if size == 0xFFFFFFFF:
                        length = self._size()
                        if length > 16384:
                            raise ValueError("Invalid Russian synthesis error packet.")
                        message = self._read(length).decode("utf-8", errors="replace")
                        completed = True
                        raise RuntimeError(message)
                    if size > 24000 * 6 or size % 2:
                        raise ValueError("Invalid Russian synthesis PCM packet.")
                    chunk = self._read(size)
                awaiting_ack = True
                if cancelled():
                    raise SynthesisCancelled()
                yield np.frombuffer(chunk, dtype="<i2").astype(np.float32) / 32768
                if cancelled():
                    raise SynthesisCancelled()
                command = b"next\n"
        finally:
            if awaiting_ack:
                try:
                    with foreground_priority(process=int(self.process._handle)):
                        self._send(b"stop\n")
                        completed = self._size() == 0
                except (OSError, RuntimeError):
                    pass
            if not completed:
                self.close()


VOICE_GENITIVE = re.compile(
    r"(?P<head>\b(?:настройки|громкость|тембр|звук|выбор|запись)\s+)(?P<voice>голоса)(?![\w\u0301])",
    re.IGNORECASE,
)


class NativeMultilingual:
    def __init__(self, models, profiles, threads=2):
        self.models = Path(models)
        self.profiles = Path(profiles)
        self.threads = min(3, threads)
        self._russian_lock = Lock()
        self._english_lock = Lock()
        self.settings = json.loads((self.profiles / "delivery.json").read_text(encoding="utf-8"))
        self._package_russian = {}
        for profile in discover_voices(self.profiles.parent, engine_id="holos"):
            settings = native_settings(self.profiles.parent, profile)
            # A managed voice can use neutral delivery defaults. Optional
            # enrollment assets decide which native backend is actually usable.
            self.settings[profile] = settings

    def warm_russian(self):
        with self._russian_lock:
            self.russian.start()
            self.russian_text("Готово.")

    def warm_english(self):
        with self._english_lock:
            self.english.warmup()

    @cached_property
    def english(self):
        from pocket_english import PocketEnglish

        return PocketEnglish(self.threads, model=self.models / "en")

    @cached_property
    def russian(self):
        return RussianPipe(self.models / "ru", self.profiles)

    @cached_property
    def accent(self):
        from stressonnx import make_stressor

        return make_stressor(lang="ru", cache_dir=str(self.models / "stress"))

    @lru_cache(maxsize=512)
    def russian_text(self, text):
        # These nouns take the genitive singular го́лоса. Keep stress supplied
        # explicitly by the document or the user's pronunciation dictionary.
        text = VOICE_GENITIVE.sub(lambda match: match["head"] + match["voice"][:2] + "\u0301" + match["voice"][2:], text)
        russian_word = re.compile(r"[а-яё\u0301]+", re.IGNORECASE)
        planned = russian_word.findall(self.accent(text.replace("\u0301", "")))
        original = russian_word.findall(text)

        def plain(word):
            return word.casefold().replace("ё", "е").replace("\u0301", "")

        if list(map(plain, planned)) != list(map(plain, original)):
            return text
        candidates = iter(planned)

        def apply(match):
            candidate = next(candidates)
            given = match.group()
            return given if "\u0301" in given else candidate

        return russian_word.sub(apply, text)

    @lru_cache(maxsize=4)
    def english_state(self, profile):
        managed = asset_path(self.profiles.parent, profile, "pocket_english_state", required=True)
        with np.load(managed if managed is not None else self.profiles / (profile + ".npz"), allow_pickle=False) as state:
            return {
                name: state[name] if name == "state_offset" else state[name].astype(np.float32)
                for name in (spec["name"] for spec in self.english.flow_states)
            }

    def available(self, profile, language, text):
        require_voice_allowed(profile)
        language = language.lower().replace("_", "-")
        lang = {"en": "en-us", "ru-ru": "ru"}.get(language, language)
        supported = supports_language(self.profiles.parent, profile, language)
        if supported is False:
            return False
        if supported is True:
            role = "pocket_russian_prompt" if lang == "ru" else "pocket_english_state"
            if asset_path(self.profiles.parent, profile, role) is None:
                return False
        if profile not in self.settings or any(char.isdecimal() for char in text):
            return False
        if lang in {"en-us", "en-gb"}:
            return bool(re.search(r"[a-zA-Z]", text)) and not re.search(r"[а-яА-ЯёЁіїєґІЇЄҐ]", text)
        if lang == "ru":
            return bool(re.search(r"[а-яА-ЯёЁ]", text)) and not re.search(r"[a-zA-Z]", text)
        return False

    def plan(self, profile, language, text, number_language="auto"):
        if self.available(profile, language, text):
            return ((language, text),)
        if profile not in self.settings or not any(char.isdecimal() for char in text):
            return ()
        locale = language.split("-")[0]
        if locale not in {"uk", "en", "ru"}:
            return ()
        target = number_language if number_language in {"en", "uk"} else locale
        if locale == "en":
            expanded = english_text(text, number_language=target)
            parts = tuple(split_mixed(expanded, language)) if target != locale else ((language, expanded),)
        elif target != locale:
            parts = number_parts(text, language, target)
        elif locale == "ru":
            parts = ((language, speak_numbers(text, "ru")),)
        else:
            return ()
        if parts and all(code == "uk" or self.available(profile, code, phrase) for code, phrase in parts):
            return parts
        return ()

    def phrase(self, profile, parts, speed, cancelled, ukrainian_chunks):
        for locale, text in parts:
            if cancelled():
                raise SynthesisCancelled()
            if locale == "uk":
                yield from compact_padding(ukrainian_chunks(profile, "uk", text, speed), text)
            else:
                yield from self.stream(profile, locale, text, speed, cancelled)

    def close(self):
        if "russian" in self.__dict__:
            self.russian.close()
        for pipe in self._package_russian.values():
            pipe.close()
        self._package_russian.clear()

    def _russian_for(self, profile):
        managed = asset_path(self.profiles.parent, profile, "pocket_russian_prompt", required=True)
        if managed is None:
            return self.russian
        directory = str(managed.parent)
        if directory not in self._package_russian:
            # Bound the extra processes when the user changes voice repeatedly.
            if len(self._package_russian) >= 2:
                oldest = next(iter(self._package_russian))
                self._package_russian.pop(oldest).close()
            self._package_russian[directory] = RussianPipe(self.models / "ru", managed.parent)
        return self._package_russian[directory]

    @contextmanager
    def _russian_foreground(self, cancelled):
        acquired = False
        try:
            while not acquired:
                if cancelled():
                    raise SynthesisCancelled()
                acquired = self._russian_lock.acquire(timeout=.01)
                if acquired:
                    break
                pipe = self.__dict__.get("russian")
                held = getattr(pipe, "process", None)
                if held is None or held.poll() is not None:
                    continue
                held_handle = held._handle
                with foreground_priority(process=int(held_handle)):
                    while not acquired:
                        if cancelled():
                            raise SynthesisCancelled()
                        acquired = self._russian_lock.acquire(timeout=.01)
                        if pipe.process is not held or held.poll() is not None:
                            break
            # The cold child's temporary boost is gone before normal stream
            # work/yielding; RussianPipe applies its own per-packet scope.
            if cancelled():
                raise SynthesisCancelled()
            yield
        finally:
            if acquired:
                self._russian_lock.release()

    def stream(self, profile, language, text, speed=1.0, cancelled=lambda: False):
        require_voice_allowed(profile)
        key = "ru" if language.startswith("ru") else "en"
        settings = self.settings.get(profile, {}).get(key, {})
        if key == "ru":
            def russian_chunks():
                with self._russian_foreground(cancelled):
                    if cancelled():
                        raise SynthesisCancelled()
                    marked = self.russian_text(text)
                    yield from self._russian_for(profile).stream(profile, marked, cancelled, seed=settings.get("seed"))
            chunks = russian_chunks()
        else:
            with self._english_lock:
                engine, state = self.english, self.english_state(profile)
            if cancelled():
                raise SynthesisCancelled()
            chunks = engine.stream(english_text(text), state,
                                   seed=settings.get("seed", 190), temperature=settings.get("temperature"))

        def checked():
            try:
                for chunk in chunks:
                    if cancelled():
                        raise SynthesisCancelled()
                    yield chunk
            finally:
                chunks.close()

        speed = min(10.0, max(.25, speed * settings.get("tempo", 1.0)))
        delivery = condition_shared(checked(), settings.get("gain", 1.0), 0.0)
        yield from compact_padding(stream_tempo(delivery, 24000, speed), text)


def preferred_speech(primary, fallback, renderer):
    renderer["engine"] = "profile"
    emitted = False
    try:
        for block in primary:
            emitted = True
            yield block
    except (OSError, RuntimeError, ValueError, KeyError, ImportError) as error:
        if emitted:
            raise
        print(f"Native speech fallback: {type(error).__name__}", file=sys.stderr)
        renderer["engine"] = "baseline"
        yield from fallback
    finally:
        primary.close()
        fallback.close()
