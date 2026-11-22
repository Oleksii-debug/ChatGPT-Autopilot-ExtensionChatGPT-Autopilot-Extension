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
from time import monotonic
from threading import Condition, Thread, RLock, Event
from unicodedata import normalize
import wave

from autoSettingsUtils.driverSetting import BooleanDriverSetting, DriverSetting, NumericDriverSetting
import config
import nvwave
from logHandler import log
from speech.commands import BreakCommand, CharacterModeCommand, IndexCommand, LangChangeCommand, PitchCommand, RateCommand, VolumeCommand, BaseCallbackCommand
from speech.extensions import pre_speechQueued
from synthDriverHandler import SynthDriver as BaseDriver, VoiceInfo, synthDoneSpeaking, synthIndexReached


SAMPLE_RATE = 24000
RUNTIME = Path(__file__).resolve().parent.parent / "dordiaiUnifiedRuntime"
_pref_spec = importlib.util.spec_from_file_location("_dordiai_unified_preferences", RUNTIME / "preferences.py")
_prefs = importlib.util.module_from_spec(_pref_spec)
_pref_spec.loader.exec_module(_prefs)
_text_spec = importlib.util.spec_from_file_location("_dordiai_speech_text", RUNTIME / "speech_text.py")
_speech_text = importlib.util.module_from_spec(_text_spec)
_text_spec.loader.exec_module(_speech_text)
_registry_spec=importlib.util.spec_from_file_location('_dordiai_registry',RUNTIME/'data_registry.py')
_registry_module=importlib.util.module_from_spec(_registry_spec)
_registry_spec.loader.exec_module(_registry_module)
_REGISTRY=_registry_module.Registry(RUNTIME/'models')
_number_spec=importlib.util.spec_from_file_location('_dordiai_number_helpers',RUNTIME/'nvda_numbers.py')
_numbers=importlib.util.module_from_spec(_number_spec)
_number_spec.loader.exec_module(_numbers)
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
DE_LETTERS = {c:c.upper() for c in 'abcdefghijklmnopqrstuvwxyzäöüß'}
DE_LETTERS['ß'] = 'Eszett'
PL_LETTERS = {c:c.upper() for c in 'aąbcćdeęfghijklłmnńoópqrsśtuvwxyzźż'}
SK_LETTERS = {c:c.upper() for c in 'aáäbcčdďdzdžeéfghiíjklĺľmnňoóôpqrŕsštťuúvwx yýzž'.replace(' ','')}


def character_parts(text, language, english, spelling_language="auto"):
    alphabets = {'uk':UK_LETTERS, 'ru':RU_LETTERS, 'en':EN_LETTERS, 'de':DE_LETTERS,
                 'sk':SK_LETTERS, 'pl':PL_LETTERS}
    for char in normalize('NFC', text):
        lower = char.lower()
        base = _REGISTRY.locale(language)
        if spelling_language in ('uk','ru') and lower in (UK_LETTERS.keys() | RU_LETTERS.keys()):
            base=spelling_language
        if _REGISTRY.native_carrier(base):
            digit_names = _REGISTRY.language(base).get('digits', {})
            if char in digit_names:
                yield 'character', (base, digit_names[char])
                continue
            names = alphabets.get(base,{lower:char.upper()})
            names = _REGISTRY.language(base).get('alphabet',names)
            if lower in names:
                name='zed' if lower=='z' and language.lower().replace('_','-')=='en-gb' else names[lower]
                yield 'character',(language if base=='en' else base,name)
                continue
            if char.isspace():
                yield 'character',(base,_REGISTRY.language(base).get('space_name',{'uk':'пробіл','ru':'пробел','en':'space','de':'Leerzeichen','sk':'medzera','pl':'spacja'}.get(base,'space')))
                continue
        cyrillic = language if spelling_language == "auto" else spelling_language
        if lower in RU_LETTERS and (lower not in UK_LETTERS or cyrillic == "ru"):
            yield "character", ("ru", RU_LETTERS[lower])
        elif lower in UK_LETTERS:
            yield "character", ("uk", UK_LETTERS[lower])
        elif lower in EN_LETTERS:
            name = "zed" if lower == "z" and language.lower() == "en-gb" else EN_LETTERS[lower]
            yield "character", (language if language.startswith("en") else english, name)
        elif char.isspace():
            yield "character", (language, {"ru": "пробел", "uk": "пробіл"}.get(language, "space"))
        else:
            # The document locale can be Cyrillic during untagged letter navigation.
            # A distinctive Latin letter may still belong to one installed alphabet.
            options = [(code, alphabet[lower]) for code, settings in _REGISTRY.languages.items()
                       for alphabet in (settings.get('alphabet', alphabets.get(code, {})),)
                       if lower in alphabet]
            if len(options) == 1:
                yield "character", options[0]
            else:
                yield "text", (language, char)


def language_code(value, fallback, english):
    code = (value or "").lower().replace("_", "-")
    if code in ("en-gb", "en-us"):
        return code[:3] + code[3:].upper()
    base = code.split("-", 1)[0]
    return english if base=='en' else _REGISTRY.locale(code) if _REGISTRY.accepts(code) else fallback


def text_chunks(text, limit=280, first_limit=None):
    """Split long runs at whitespace while keeping punctuation and the given language."""
    text = text.strip()
    current_limit = first_limit or limit
    while len(text) > current_limit:
        near_start = text[:current_limit + 1]
        boundaries = list(re.finditer(r"[.!?…]\s+", near_start))
        if not boundaries:
            boundaries=[m for m in re.finditer(r"[,;:—]\s+",near_start) if m.start()>=current_limit//2]
        split = boundaries[-1].start() + 1 if boundaries else max(
            (offset for offset, char in enumerate(near_start) if char.isspace()), default=-1,
        )
        split = split if split > 0 else min(len(text), limit)
        yield text[:split].rstrip()
        text = text[split:].lstrip()
        current_limit = limit
    if text:
        yield text


def buffered_items(produce, cancelled, *, pending_count=40):
    """Keep upcoming audio and index markers ready in delivery order."""
    pending = Queue(maxsize=pending_count)
    errors = []
    stopped = False

    def stop_requested():
        return stopped or cancelled()

    def fill():
        try:
            with closing(produce(stop_requested)) as source:
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

    producer = Thread(target=fill, daemon=True, name="dordiai speech lookahead")
    producer.start()
    try:
        while not stop_requested() and (producer.is_alive() or not pending.empty()):
            try:
                item = pending.get(timeout=.01)
            except Empty:
                continue
            if not stop_requested():
                yield item
        if errors and not stop_requested():
            raise errors[0]
    finally:
        stopped = True
        producer.join()


class PreviewAudio:
    """Hand off one in-flight preview without waiting for its final sample."""
    def __init__(self):
        self.state=Condition();self.blocks=[];self.done=False;self.error=None

    def append(self,pcm):
        with self.state:
            self.blocks.append(pcm);self.state.notify_all()

    def finish(self,error=None):
        with self.state:
            self.error=error;self.done=True;self.state.notify_all()

    def stream(self,cancelled):
        position=0
        while not cancelled():
            with self.state:
                self.state.wait_for(lambda:position<len(self.blocks) or self.done or cancelled(),timeout=.02)
                if cancelled():return
                if position<len(self.blocks):
                    block=self.blocks[position];position+=1
                elif self.done:
                    if self.error:raise self.error
                    return
                else:continue
            yield block


class SpeechWorker:
    def __init__(self, python, script, models):
        self._command = [str(python), "-I", "-B", "-u", str(script), str(models)]
        self._process = None
        self._responses = None
        self._clips = OrderedDict()
        self._navigation = OrderedDict()
        self._references = models / "voices"
        rates_path = self._references / "navigationRates" / "letters.json"
        self._letter_rates = json.loads(rates_path.read_text(encoding="utf8")) if rates_path.is_file() else {}
        self._io = RLock()
        self._cache_lock = RLock()
        self._wire_lock = RLock()
        self._pending_replies = 0
        self._interrupted_reply = {"interrupted": True}
        self.ready = False

    def fast_clip(self, request):
        with self._cache_lock:
            return self._fast_clip(request)

    def _fast_clip(self, request):
        """Read prepared speech without waiting for any neural model or worker."""
        cached=self._clips.get(self._key(request))
        if cached is not None:return cached
        controls = request.get("controls", {})
        if self._references is None or request.get("readingStyle") != "plain":
            return None
        language = request.get("language") or "uk"
        text = request["text"]
        spans = request.get("segments")
        if spans:
            if len(spans) != 1:
                return None
            hint, raw = spans[0]
            runs = ((hint,raw),) if hint and _REGISTRY.native_carrier(hint) else tuple(_speech_text.split_mixed(
                raw, hint or "uk", detect_russian=hint is None and request["detectRussian"],
            ))
            if len(runs) != 1:
                return None
            language, text = runs[0]
        if language.split("-")[0].lower() in request.get("disabledLanguages", ()):
            language = request["defaultLanguage"]
        language = language.lower().replace("_", "-")
        if language == "en" or language == "en-gb" and text != "zed":
            language = "en-us"
        if any(char.isdecimal() for char in text):
            return None
        profile = request["profile"]
        speed = request["speed"]
        variant = 1.
        key = (profile, language, text)
        if request.get("character") and speed > 1:
            rates = self._letter_rates.get(profile, {}).get(language, {}).get(text.casefold())
            if rates is not None:
                # Compressing short voiced transitions can change the vowel.
                # Choose a verified recording nearest to the requested duration.
                variant = min((1., *rates), key=lambda rate: abs(1/rate-1/speed))
                key += (variant,)
                speed = 1.
        if key not in self._navigation:
            name = sha256((language + "\0" + text.strip().casefold()).encode("utf-8")).hexdigest()[:24] + ".wav"
            if variant == 1.:
                path = self._references / "navigation" / profile / name
            else:
                path = self._references / "navigationRates" / profile / f"{variant:g}" / name
            if not path.is_file():
                return self._clips.get(self._key(request))
            with wave.open(str(path), "rb") as source:
                if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, SAMPLE_RATE):
                    raise ValueError("Invalid prepared speech format")
                self._navigation[key] = source.readframes(source.getnframes())
            if len(self._navigation) > 256:
                self._navigation.popitem(last=False)
        pcm = self._navigation[key]
        self._navigation.move_to_end(key)
        from ctypes import c_short, cast, byref, POINTER
        from synthDrivers import _sonic
        _sonic.initialize()
        custom = controls.get("pitch", 50) != 50 or controls.get("timbre", 50) != 50
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
        if custom:
            from synthDrivers._dordiai_audio import control_pcm
            pcm = control_pcm(pcm, RUNTIME / "python/rubberband-3.dll", SAMPLE_RATE,
                              controls.get("pitch", 50), controls.get("timbre", 50), controls.get("volume", 100))
        cache_key=self._key(request)
        if cache_key is not None:self._remember_clip(cache_key,pcm)
        return pcm

    @staticmethod
    def _read(process, responses):
        try:
            for line in process.stdout:
                responses.put(line)
        finally:
            responses.put(None)

    def _send(self, request):
        with self._wire_lock:self._send_locked(request)

    def _send_locked(self, request):
        if self._process is None:
            self._process = subprocess.Popen(
                self._command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW | subprocess.NORMAL_PRIORITY_CLASS,
            )
            self._responses = Queue()
            Thread(target=self._read, args=(self._process, self._responses), daemon=True).start()
        try:
            self._process.stdin.write((json.dumps(request) + "\n").encode("ascii"))
            self._process.stdin.flush()
        except OSError:
            self.close()
            raise

    def anticipate(self,requests):
        if not requests:return
        with self._wire_lock:
            if self._process is None or self._process.poll() is not None:return
            try:self._send({'mode':'anticipate','requests':requests[:8]})
            except (OSError,RuntimeError):pass

    def _receive(self, timeout, cancelled=None):
        deadline = monotonic() + timeout
        try:
            while True:
                remaining = deadline - monotonic()
                if remaining <= 0:
                    raise Empty
                try:
                    line = self._responses.get(timeout=min(remaining, .015) if cancelled else remaining)
                    break
                except Empty:
                    if cancelled is not None and cancelled():
                        # The caller still owns the outstanding reply. Release
                        # playback now and drain it before the next neural call.
                        return self._interrupted_reply
            if line is None:
                raise RuntimeError("Speech process exited.")
            return json.loads(line)
        except Empty as error:
            self.close()
            raise RuntimeError("Speech process timed out.") from error
        except (OSError, ValueError, RuntimeError):
            self.close()
            raise

    def _finish_cancel(self, wait, cancelled=None):
        # Single reader under _io. Replies are ordered: any prefetched
        # response is followed by the explicit drop acknowledgement.
        while self._pending_replies:
            if not wait and self._responses.empty():
                return False
            try:
                reply = self._receive(3, cancelled)
                if reply is self._interrupted_reply:
                    return False
                self._pending_replies -= 1
                if not self._pending_replies and not reply.get("finished"):
                    raise RuntimeError("Unacknowledged speech cancellation")
            except (ValueError, RuntimeError, OSError):
                self.close()
                break
        return True

    def _interrupt(self, pending):
        if self._process is None:
            return
        try:
            self._send({"mode": "cancel"})
            self._send({"mode": "drop"})
            self._pending_replies = 1 + int(pending)
            self._finish_cancel(wait=False)
        except (OSError, RuntimeError):
            self.close()

    def _begin_request(self, cancelled):
        # A stale preview might still own the worker. Never hold up the
        # playback producer for a navigation request that was itself cancelled.
        while not cancelled():
            if self._io.acquire(timeout=.015):
                try:
                    if not cancelled() and self._finish_cancel(wait=True, cancelled=cancelled):
                        return True
                except BaseException:
                    self._io.release()
                    raise
                self._io.release()
                return False
        return False

    def preload(self):
        with self._io:
            if self.ready and self._process is not None and self._process.poll() is None:
                return
            if self._process is not None and self._process.poll() is not None:
                self.close()
            self._send({"mode":"preload"})
            result = self._receive(30)
            if not result.get("ready"):
                raise RuntimeError(result.get("error", "Could not preload the acoustic model."))
            self.ready = True

    def stream(self, request, cancelled):
        if not self._begin_request(cancelled):
            return
        try:
            self.preload()
            if not cancelled():
                yield from self._stream(request,cancelled)
        finally:
            self._io.release()

    def _remember_clip(self,key,data):
        # Whole sentences can exceed the former eight-second packet limit.
        # Retain them for navigation without letting longer packets multiply
        # the memory bound of the 256-entry LRU.
        with self._cache_lock:
            self._clips[key]=data
            self._clips.move_to_end(key)
            while len(self._clips)>256 or sum(map(len,self._clips.values()))>48*1024*1024:
                self._clips.popitem(last=False)

    @staticmethod
    def _key(request):
        if len(request['text'])>240:return None
        return (request['profile'],request['language'],request['speed'],request['text'],request['character'],
                tuple(tuple(p) for p in request.get('segments',())),request['numberLanguage'],request['readingStyle'],
                request['detectRussian'],tuple(sorted(request['controls'].items())),request.get('continuation',False))

    def stream_batch(self,items,cancelled):
        # A prepared prefix is independent of the serialized neural transport.
        # Play it while another thread finishes preparing the rest of the line.
        position=0
        for item in items:
            if cancelled():return
            kind=item['kind']
            if kind=='source':
                clip=self.fast_clip(item['request'])
                if clip is None:break
                yield 'pcm',clip
            elif kind=='cached':yield 'pcm',base64.b64decode(item['pcm'])
            elif kind=='index':yield 'index',item['value']
            elif kind=='break':yield 'pcm',bytes(round(min(item['value'],10000)*SAMPLE_RATE/1000)*2)
            position+=1
        items=items[position:]
        if not items or not self._begin_request(cancelled):
            return
        try:
            self.preload()
            if cancelled():
                return
            # A speculative request may have finished while this foreground
            # request was waiting for the transport. Reuse it, do not render
            # the same line a second time.
            checked=[]
            for item in items:
                if item['kind']=='source':
                    clip=self.fast_clip(item['request'])
                    if clip is not None:item=dict(item,kind='cached',pcm=base64.b64encode(clip).decode('ascii'))
                checked.append(item)
            items=checked
            if not any(item['kind']=='source' for item in items):
                for item in items:
                    if cancelled():return
                    if item['kind']=='index':yield 'index',item['value']
                    elif item['kind']=='break':yield 'pcm',bytes(round(min(item['value'],10000)*SAMPLE_RATE/1000)*2)
                    else:yield 'pcm',base64.b64decode(item['pcm'])
                return
            self._send({'mode':'batch','items':items})
            active=pending=True
            collected={}
            try:
                while True:
                    response=self._receive(18,cancelled)
                    if response is self._interrupted_reply:return
                    pending=False
                    if 'error' in response:
                        active=False;raise RuntimeError(response['error'])
                    if response.get('finished'):
                        active=False;break
                    if cancelled():return
                    if 'part_finished' in response:
                        number=response['part_finished']
                        if items[number]['kind']=='source':
                            key=self._key(items[number]['request'])
                            data=collected.pop(key,None)
                            if data:
                                self._remember_clip(key,data)
                        self._send({'mode':'next'});pending=True
                        continue
                    if 'index' in response:item=('index',response['index'])
                    elif 'silence' in response:item=('pcm',bytes(round(response['silence']*SAMPLE_RATE/1000)*2))
                    else:
                        data=base64.b64decode(response['chunk'],validate=True)
                        if not data or len(data)%2:raise ValueError('Invalid batched speech PCM')
                        number=response.get('part')
                        if number is not None and items[number]['kind']=='source':
                            key=self._key(items[number]['request'])
                            if key is not None:
                                previous=collected.get(key,b'')
                                if previous is not None:
                                    collected[key]=previous+data if len(previous)+len(data)<=SAMPLE_RATE*40 else None
                        item=('pcm',data)
                    self._send({'mode':'next'});pending=True
                    yield item
            finally:
                if active:
                    self._interrupt(pending)
            if not cancelled():
                with self._cache_lock:
                    for key,data in collected.items():
                        if data:self._remember_clip(key,data)
        finally:
            self._io.release()

    def _stream(self, request, cancelled):
        key = self._key(request)
        if key is not None:
            if key in self._clips:
                self._clips.move_to_end(key)
                yield self._clips[key]
                return
        collected = []
        collected_bytes = 0
        self._send(request)
        active = True
        pending = True
        try:
            while True:
                response = self._receive(18, cancelled)
                if response is self._interrupted_reply:return
                pending = False
                if "error" in response:
                    active = False
                    raise RuntimeError(response["error"])
                if response.get("finished"):
                    active = False
                    break
                if cancelled():
                    return
                data = base64.b64decode(response["chunk"], validate=True)
                if len(data) < 2 or len(data) % 2:
                    raise ValueError("Speech process returned invalid PCM.")
                if key is not None:
                    collected_bytes += len(data)
                    if collected_bytes > SAMPLE_RATE * 40:
                        key = None
                        collected.clear()
                    else:
                        collected.append(data)
                # Start the next neural block while this block is buffered and
                # played. Waiting until after yield left the model idle.
                self._send({"mode":"next"})
                pending = True
                yield data
                if cancelled():
                    return
        finally:
            if active:
                self._interrupt(pending)
        if key is not None and collected and not cancelled():
            self._remember_clip(key,b"".join(collected))

    def close(self):
        with self._wire_lock:self._close_locked()

    def _close_locked(self):
        self._pending_replies = 0
        self.ready = False
        process, self._process = self._process, None
        if process is not None:
            try:
                if process.poll() is None:
                    process.kill()
                process.wait()
            finally:
                process.stdin.close()
                process.stdout.close()


_shared_worker = None
_shared_worker_lock = RLock()

def shared_worker():
    global _shared_worker
    with _shared_worker_lock:
        if _shared_worker is None:
            _shared_worker = SpeechWorker(RUNTIME/'python/python.exe', RUNTIME/'nvda_worker.py', RUNTIME/'models')
            atexit.register(_shared_worker.close)
        return _shared_worker


PROFILES = _REGISTRY.names()
UK_UI_COMMANDS = frozenset(("робочий стіл", "документ", "готово", "зберегти", "відкрити"))
STYLES = {"plain": "Звичайне", "narration": "Начитка книги", "warm": "Радісно",
          "sad": "Сумно", "angry": "Сердито"}


class SynthDriver(_prefs.PreferencesMixin, BaseDriver):
    name = "dordiaiUnified"
    description = "dordiai-voices Єдиний голос"
    supportedSettings = (
        BaseDriver.VoiceSetting(), BaseDriver.RateSetting(), BaseDriver.PitchSetting(), BaseDriver.VolumeSetting(),
        NumericDriverSetting("timbre", "Тембр", availableInSettingsRing=True),
        NumericDriverSetting("rateMultiplier", "Множник швидкості", availableInSettingsRing=True,
                             defaultVal=1, minVal=1, maxVal=5, normalStep=1, largeStep=1),
        DriverSetting("readingStyle", "Режим читання", availableInSettingsRing=True, defaultVal="plain"),
        DriverSetting("numberLanguage", "Мова чисел", availableInSettingsRing=True, defaultVal="auto"),
        DriverSetting("spellingLanguage", "Мова кириличних літер", availableInSettingsRing=True, defaultVal="auto"),
        BooleanDriverSetting("detectRussian", "Розпізнавати російський текст", defaultVal=True),
    )
    supportedCommands = frozenset({BreakCommand, CharacterModeCommand, IndexCommand, LangChangeCommand,
                                   PitchCommand, RateCommand, VolumeCommand})
    supportedNotifications = frozenset({synthDoneSpeaking, synthIndexReached})

    @classmethod
    def check(cls):
        required=[RUNTIME/'python/python.exe']
        for row in _REGISTRY.languages.values():
            backend=row['backend']
            if backend=='supertonic':
                folder=_REGISTRY.resource(row['model'])
                required.extend(_registry_module.acoustic_graph(folder/'onnx',name) for name in ('duration_predictor.onnx','text_encoder.onnx',
                    row.get('vector_model','vector_estimator.onnx'),'vocoder.onnx','tts.json','unicode_indexer.json'))
                required.append(folder/'voice_styles/F1.json')
            elif backend=='holos':
                required.extend((RUNTIME/'models/Holos'/name for name in ('encoder.onnx','decoder_window.onnx')))
            elif backend=='piper':required.append(_REGISTRY.resource(row['model']))
            elif backend=='rhvoice':required.append(_REGISTRY.resource(row['model'])/'lib/RHVoice.dll')
            if row.get('source'):required.append(_REGISTRY.resource('voices/'+row['source']))
        required.extend(_REGISTRY.resource('voices/'+row['target']) for row in _REGISTRY.voices.values())
        return all(path.is_file() for path in required)

    def __init__(self):
        self._dordiai_init()
        self._state = Condition()
        self._generation = 0
        self._paused = self._closed = False
        self._intro_pending = True
        self._jobs = Queue()
        self._serial = 0
        self._last_completed = 0
        self._speculative = Queue(maxsize=8)
        self._announcements = Queue(maxsize=8)
        self._prepared_keys = OrderedDict()
        self._job_ready = Event()
        self._prepared_count = 0
        self._peek_pending = False
        self._navigation_pending = False
        self._active_preview = None
        self._foreground_waiting = Event()
        self._voice = next(iter(PROFILES))
        self._rate = self._pitch = self._timbre = 50
        self._volume = 100
        self.rateMultiplier = 1
        self.readingStyle = "plain"
        self.numberLanguage = self.spellingLanguage = "auto"
        self.detectRussian = True
        models = RUNTIME / "models"
        self._engine = shared_worker()
        self._intro_pending = not self._engine.ready
        from synthDrivers import _sonic
        _sonic.initialize()
        self._player = nvwave.WavePlayer(1, SAMPLE_RATE, 16, outputDevice=config.conf["audio"]["outputDevice"])
        self._player.enableTrimmingLeadingSilence(False)
        self._thread = Thread(target=self._run, daemon=True, name="dordiaiUnified playback")
        self._thread.start()
        pre_speechQueued.register(self._queue_ahead)


    def _dordiai_all_voices(self):
        return OrderedDict(PROFILES)

    def _dordiai_all_languages(self):
        return OrderedDict(sorted(((code, _prefs.CORE_NAMES.get(code, code)) for code in _REGISTRY.languages), key=lambda item: item[1].casefold()))

    def _getAvailableVoices(self):
        return self._dordiai_filter_voices(OrderedDict((key, VoiceInfo(key, label, "uk")) for key, label in PROFILES.items()))

    def _get_availableLanguages(self):
        return self._dordiai_filter_languages(_REGISTRY.available_languages())

    def _get_availableReadingstyles(self):
        return OrderedDict((key, VoiceInfo(key, label)) for key, label in STYLES.items())

    def _get_availableNumberlanguages(self):
        labels = {'auto': 'За мовою тексту', 'uk': 'Українська', 'en': 'Англійська', 'ru': 'Російська', 'sk': 'Словацька', 'de': 'Німецька', 'pl': 'Польська', 'fr': 'Французька', 'da': 'Данська', 'it': 'Італійська', 'es': 'Іспанська'}
        return OrderedDict((key, VoiceInfo(key, label)) for key, label in labels.items())

    def _get_availableSpellinglanguages(self):
        labels = {"auto": "За мовою тексту", "uk": "Українська", "ru": "Російська"}
        return OrderedDict((key, VoiceInfo(key, label)) for key, label in labels.items())

    def _get_voice(self):
        return self._voice

    def _set_voice(self, value):
        if value in PROFILES:
            self._voice = value

    def _planned_parts(self, sequence, profile, rate, controls, multiplier, russian,
                       number_language, spelling_language, reading_style):
        lang, spell, tagged = "uk", False, False
        spans = []
        strings = [item for item in sequence if isinstance(item, str) and item]
        standalone_character = sum(len(normalize("NFC", item.strip())) for item in strings) == 1
        standalone_space = strings == [" "]

        def request(text, language, character=False, segments=None):
            language = self._dordiai_language(language)
            speed = self._tempo(rate, multiplier)
            result = {
                "mode": "reference", "profile": profile, "text": text, "language": language,
                "speed": min(speed, 2.0) if character else speed,
                "controls": dict(controls), "character": character, "numberLanguage": number_language,
                "readingStyle": "plain" if character else reading_style, "detectRussian": russian,
                **({"segments": segments} if segments else {}),
            }

            if self._dordiai_selection[1]:
                result["disabledLanguages"] = sorted(self._dordiai_selection[1])
                result["defaultLanguage"] = self._dordiai_selection[2]
            return result

        def flush():
            if not spans:
                return
            limited = []
            size = 0
            common=all(row['backend']=='supertonic' for row in _REGISTRY.languages.values())
            # The vocoder now streams an utterance with full encoder context.
            # Keep sentence prosody instead of inventing a new utterance every
            # 36/56 characters merely to get its first audio sooner.
            complete=' '.join(text for _,text in spans).rstrip(' »”\"\')]}')
            sentence_limit=110 if self._tempo(rate,multiplier)>=3. else 200
            context_limit=(sentence_limit if len(complete)<=sentence_limit and complete.endswith(('.', '!', '?', '…')) else 110) if common else 76
            packet_limit=context_limit
            initial_limit=packet_limit
            for hint, text in spans:
                # Bound the spoken form rather than the few printed digits.
                # This is preparation on the background render thread; the
                # original NVDA sequence and caret offsets are untouched.
                code=_REGISTRY.locale(hint) if hint else None
                if (code in _speech_text.DIGIT_WORDS and any(c.isdecimal() for c in text)
                        and not _speech_text.script_mismatch(text, code)):
                    target=code if number_language=='auto' else number_language
                    if target=='en':text=_speech_text.english_numeric_text(text,number_words=_numbers.num2words)
                    if target in _speech_text.DIGIT_WORDS:
                        text=_speech_text.speak_numbers(text,target,code,number_words=_numbers.num2words)
                for chunk in text_chunks(text, limit=context_limit,first_limit=initial_limit):
                    if limited and size + len(chunk) > packet_limit:
                        yield joined(limited,continuation=True)
                        limited, size = [], 0
                        packet_limit = context_limit
                    limited.append([hint, chunk])
                    size += len(chunk) + 1
            if limited:
                yield joined(limited)
            spans.clear()

        def joined(parts,continuation=False):
            if all(row['backend']=='supertonic' for row in _REGISTRY.languages.values()):
                parts=[[None if hint is None or russian and _REGISTRY.locale(hint)=='uk'
                        else _REGISTRY.locale(hint),span] for hint,span in parts]
            hint = parts[0][0]
            text = " ".join(span for _, span in parts)
            if len(parts) == 1 and hint is None and text.casefold() in UK_UI_COMMANDS:
                hint = "uk"
            # Untagged spans are detected even if they contain only Cyrillic.
            result=request(text, hint or "uk", segments=parts if len(parts) > 1 or hint is None else None)
            result['continuation']=continuation
            return "text",result

        for item in sequence:
            if isinstance(item, LangChangeCommand):
                tagged = bool(item.lang)
                lang = language_code(item.lang, "uk", "en-US")
                continue
            if isinstance(item, str):
                text = normalize("NFC", item.strip())
                if not text and not (spell and item or standalone_space):
                    continue
                if spell or standalone_space or (standalone_character and len(text) == 1 and (text.isalpha() or text.isdecimal() and tagged and _REGISTRY.language(lang).get("digits"))):
                    yield from flush()
                    target = _speech_text.cyrillic_language(text, lang) if russian and not tagged else lang
                    for kind, (language, name) in character_parts(item if spell or standalone_space else text, target, "en-US", spelling_language):
                        yield kind, request(name, language, kind == "character")
                else:
                    hint = lang if tagged else None
                    if spans and hint == spans[-1][0]:
                        spans[-1][1] += " " + text
                    else:
                        spans.append([hint, text])
                continue
            # SpeechManager replaces callbacks with indexes before speak().
            # Forecast the same boundaries; otherwise speculative clips join
            # text that the real request splits and can never hit the cache.
            if not isinstance(item, (BreakCommand, CharacterModeCommand, IndexCommand, PitchCommand, RateCommand, VolumeCommand, BaseCallbackCommand)):
                continue
            if isinstance(item,(PitchCommand,VolumeCommand)):
                setting='pitch' if isinstance(item,PitchCommand) else 'volume'
                if max(0,min(100,item.newValue))==controls[setting]:continue
            elif isinstance(item,RateCommand) and item.newValue==rate:continue
            elif isinstance(item,CharacterModeCommand) and item.state==spell:continue
            elif isinstance(item,BreakCommand) and item.time<=0:continue
            yield from flush()
            if isinstance(item, CharacterModeCommand):
                spell = item.state
            elif isinstance(item, IndexCommand):
                yield "index", item.index
            elif isinstance(item, BreakCommand):
                yield "break", max(0, item.time)
            elif isinstance(item, RateCommand):
                rate = item.newValue
            elif isinstance(item,(PitchCommand,VolumeCommand)):
                controls["pitch" if isinstance(item, PitchCommand) else "volume"] = max(0, min(100, item.newValue))
        yield from flush()

    def speak(self, speechSequence):
        with self._state:
            if not self._closed:
                self._serial += 1
                controls = dict(pitch=self._pitch, volume=self._volume, timbre=self._timbre)
                self._jobs.put((self._generation, self._serial, tuple(speechSequence), self._voice, self._rate, controls,
                                self.rateMultiplier, self.detectRussian, self.numberLanguage,
                                self.spellingLanguage, self.readingStyle))
                self._job_ready.set()

    def _queue_ahead(self,speechSequence,priority=None,**kwargs):
        # SpeechManager holds the next Say All utterance until the end index
        # of the current one. Its public queue notification arrives earlier.
        # Prepare only while this driver is actively speaking; never play or
        # acknowledge speculative speech, and never block NVDA's main thread.
        if getattr(priority,'name','NORMAL')!='NORMAL':return
        if not any(isinstance(item,str) and item.strip() for item in speechSequence):return
        # Roll the read-ahead window even when this line itself was already
        # prepared by the previous peek.
        if kwargs.get('_peek',True):
            self._schedule_document_peek()
            self._schedule_navigation_peek(speechSequence)
        with self._state:
            if self._closed or self._serial<=self._last_completed and not kwargs.get('_navigation'):return
            key=(self._generation,self._voice,self._rate,self.rateMultiplier,self._pitch,self._timbre,self._volume,
                 self.readingStyle,self.numberLanguage,self.spellingLanguage,self.detectRussian,
                 tuple(item if isinstance(item,str) else ('bookmark',) if isinstance(item,(IndexCommand,BaseCallbackCommand))
                       else (type(item).__name__,getattr(item,'lang',None),getattr(item,'newValue',None),
                             getattr(item,'state',None),getattr(item,'time',None))
                       for item in speechSequence if isinstance(item,(str,LangChangeCommand,IndexCommand,BaseCallbackCommand,
                                                                     PitchCommand,RateCommand,VolumeCommand,CharacterModeCommand,BreakCommand))))
            if key in self._prepared_keys:return
            controls=dict(pitch=self._pitch,volume=self._volume,timbre=self._timbre)
            args=(tuple(speechSequence),self._voice,self._rate,controls,self.rateMultiplier,self.detectRussian,
                  self.numberLanguage,self.spellingLanguage,self.readingStyle)
            try:self._speculative.put_nowait((self._generation,args,key))
            except Full:return
            try:self._announcements.put_nowait((self._generation,args))
            except Full:pass
            self._prepared_keys[key]=None
            if len(self._prepared_keys)>64:self._prepared_keys.popitem(last=False)
            self._job_ready.set()

    def _schedule_document_peek(self):
        # Say All itself exposes only the immediately following line through
        # pre_speechQueued. A short line can finish before a long following
        # line is ready. Read two further ranges through independent TextInfo
        # copies. Never move the real caret, reader, or SpeechManager queue.
        if self._peek_pending:return
        try:
            from speech import sayAll
            handler=sayAll.SayAllHandler
            reader=handler._getActiveSayAll() if handler else None
            if reader is None or not getattr(reader,'reader',None) or getattr(reader,'nextLineFunc',None):return
            self._peek_pending=True
            generation=self._generation
            def peek():
                self._peek_pending=False
                if self._closed or generation!=self._generation or handler._getActiveSayAll() is not reader:return
                try:
                    import textInfos,controlTypes
                    from speech.types import _flattenNestedSequences
                    current=reader.reader
                    if current is None:return
                    upcoming=current.copy();upcoming.collapse(end=True)
                    state=reader.speakTextInfoState.copy()
                    for _ in range(2):
                        if generation!=self._generation or self._closed:return
                        if upcoming.move(textInfos.UNIT_READINGCHUNK,1,endPoint='end')<=0:break
                        speech=reader.handler._getTextInfoSpeech(upcoming,unit=textInfos.UNIT_READINGCHUNK,
                                  reason=controlTypes.OutputReason.SAYALL,useCache=state)
                        sequence=list(_flattenNestedSequences(speech))
                        self._queue_ahead(self._prediction_sequence(sequence),_peek=False)
                        upcoming.collapse(end=True)
                except Exception:
                    log.debugWarning('dordiai: document lookahead unavailable',exc_info=True)
            import core
            core.callLater(0,peek)
        except Exception:
            self._peek_pending=False

    @staticmethod
    def _prediction_sequence(sequence):
        # TextInfo yields raw speech; the public queue hook sees text after
        # NVDA's dictionaries/symbol processing. Apply that same pure text
        # transformation without enqueueing speech or executing callbacks.
        from speech.speech import processText,getCurrentLanguage
        from speech import languageHandling
        current=default=getCurrentLanguage()
        switching=languageHandling.shouldMakeLangChangeCommand()
        output=[]
        for item in sequence:
            if isinstance(item,LangChangeCommand):
                if not switching:continue
                current=item.lang or default
                if not config.conf['speech']['autoDialectSwitching'] and current.split('_')[0]==default.split('_')[0]:current=default
                output.append(LangChangeCommand(current))
            elif isinstance(item,str):
                text=processText(current,item,config.conf['speech']['symbolLevel'],
                                 normalize=config.conf['speech']['unicodeNormalization'])
                if text:output.append(text)
            else:output.append(item)
        return output

    def _schedule_navigation_peek(self,sequence):
        if self._navigation_pending or sum(len(x.strip()) for x in sequence if isinstance(x,str))<2:return
        from speech import sayAll
        if sayAll.SayAllHandler and sayAll.SayAllHandler.isRunning():return
        import api,controlTypes
        focus=api.getFocusObject()
        if focus is None:return
        generation=self._generation
        self._navigation_pending=True
        def peek():
            self._navigation_pending=False
            if self._closed or generation!=self._generation or api.getFocusObject() is not focus:return
            try:
                states=focus.states
                if controlTypes.State.PROTECTED in states:return
                if focus.role!=controlTypes.Role.EDITABLETEXT and controlTypes.State.EDITABLE not in states:return
                import textInfos
                from utils.security import objectBelowLockScreenAndWindowsIsLocked
                if objectBelowLockScreenAndWindowsIsLocked(focus):return
                from speech.speech import getTextInfoSpeech,SpeakTextInfoState
                from speech.types import _flattenNestedSequences
                caret=focus.makeTextInfo(textInfos.POSITION_CARET)
                line=caret.copy();line.expand(textInfos.UNIT_LINE)
                spoken=' '.join(x for x in sequence if isinstance(x,str)).strip()
                line_key=re.sub(r'\W+','',line.text).casefold()
                if not any(len(key)>=2 and key in line_key for key in
                           (re.sub(r'\W+','',x).casefold() for x in sequence if isinstance(x,str))):return
                word_mode=len(spoken)<max(12,len(line.text.strip())*.6)
                unit=textInfos.UNIT_WORD if word_mode else textInfos.UNIT_LINE
                # Forward navigation gets priority; a previous item also
                # remains ready for a quick reversal. Never move the caret.
                for step in (1,2,-1):
                    if self._closed or generation!=self._generation:return
                    info=caret.copy();info.expand(unit);info.collapse(end=False)
                    if info.move(unit,step)!=step:continue
                    info.expand(unit)
                    if not info.text.strip() or len(info.text)>400:continue
                    state=SpeakTextInfoState(focus).copy()
                    state.formatFieldAttributesCache=dict(state.formatFieldAttributesCache)
                    speech=getTextInfoSpeech(info,unit=unit,reason=controlTypes.OutputReason.CARET,useCache=state)
                    forecast=self._prediction_sequence(list(_flattenNestedSequences(speech)))
                    self._queue_ahead(forecast,_peek=False,_navigation=True)
            except (RuntimeError,NotImplementedError,LookupError):pass
            except Exception:log.debugWarning('dordiai: navigation lookahead unavailable',exc_info=True)
        import core
        core.callLater(0,peek)

    def terminate(self):
        pre_speechQueued.unregister(self._queue_ahead)
        with self._state:
            self.cancel()
            self._closed = True
            self._jobs.put(None)
            self._job_ready.set()

    def _run(self):
        def preload():
            try:
                self._engine.preload()
            except Exception as error:
                log.warning("dordiai-voices Єдиний голос: preload failed (%s)", error)
        warm = Thread(target=preload, daemon=True, name="dordiaiUnified preload")
        warm.start()
        ahead_stopped=Event()
        def announce_queue():
            # Announcing a future line must not wait behind conversion of
            # the preceding preview. That serialization announced Russian
            # only after the English line had already finished playing.
            while not self._closed and not ahead_stopped.is_set():
                try:generation,input_args=self._announcements.get(timeout=.02)
                except Empty:continue
                if generation!=self._generation:continue
                try:
                    requests=[request for kind,request in self._planned_parts(*input_args)
                              if kind in ('text','character')]
                    self._engine.anticipate(requests)
                except Exception:
                    log.debugWarning('dordiai: acoustic announcement unavailable',exc_info=True)
        announcer=Thread(target=announce_queue,name='dordiai upcoming text',daemon=True)
        announcer.start()
        def prepare_queue():
            while not self._closed and not ahead_stopped.is_set():
                try:generation,input_args,key=self._speculative.get(timeout=.02)
                except Empty:continue
                cancelled=lambda expected=generation:self._closed or ahead_stopped.is_set() or expected!=self._generation
                if cancelled():continue
                try:
                    requests=[request for kind,request in self._planned_parts(*input_args) if kind in ('text','character')]
                    for request in requests:
                        abort=Event()
                        relay=PreviewAudio()
                        active=(self._engine._key(request),abort,relay)
                        while not cancelled():
                            with self._state:
                                if not self._foreground_waiting.is_set():
                                    self._active_preview=active
                                    break
                            ahead_stopped.wait(.01)
                        if cancelled():
                            relay.finish()
                            with self._state:
                                if self._active_preview is active:self._active_preview=None
                            break
                        # A navigation cancellation need not throw away the
                        # very packet being requested next. Finish this one
                        # silently; an unrelated foreground miss interrupts it.
                        stop_packet=lambda:self._closed or ahead_stopped.is_set() or abort.is_set()
                        try:
                            with closing(self._render_parts(iter((('text',request),)),warm,stop_packet,speculative=True)) as source:
                                for kind,value in source:
                                    if stop_packet():break
                                    if kind=='pcm':relay.append(value)
                        except BaseException as error:
                            relay.finish(error)
                            raise
                        finally:
                            relay.finish(relay.error)
                            with self._state:
                                if self._active_preview is active:self._active_preview=None
                    if not cancelled():self._prepared_count+=1
                except Exception as error:
                    if not cancelled():
                        log.debugWarning('dordiai preparation: %s',error)
                        with self._state:self._prepared_keys.pop(key,None)
        ahead=Thread(target=prepare_queue,name='dordiai document preparation',daemon=True)
        ahead.start()
        def render_jobs(stopped):
            # The lookahead lifetime spans utterances, not just chunks inside
            # one speak() call. Say All submits subsequent lines separately.
            # Waiting for the playback queue to drain before opening the next
            # utterance inserted a full inference delay at every line boundary.
            while not stopped():
                try:job=self._jobs.get_nowait()
                except Empty:
                    self._job_ready.wait(.02);self._job_ready.clear();continue
                if job is None:return
                generation, serial, *input_args = job
                cancelled = lambda expected=generation: stopped() or expected != self._generation
                if cancelled():continue
                try:
                    # Only the first single-line job replacing interrupted
                    # speech can use the navigation path.
                    interactive=(serial==getattr(self,'_cancelled_after_serial',-2)+1
                                 and serial==self._serial)
                    with closing(self._render_parts(self._planned_parts(*input_args), warm, cancelled,
                                                    interactive=interactive)) as source:
                        for kind, value in source:
                            if cancelled():break
                            yield kind, (value,generation,serial)
                except Exception as error:
                    if not cancelled():log.error("dordiai-voices Єдиний голос: %s",error)
                if not cancelled():yield 'end',(None,generation,serial)
        try:
            flow=buffered_items(render_jobs,lambda:self._closed,pending_count=80)
            with closing(flow):
                for kind,(value,generation,serial) in flow:
                    cancelled=lambda expected=generation: self._closed or expected!=self._generation
                    with self._state:
                        self._state.wait_for(lambda:cancelled() or not self._paused)
                        if cancelled():continue
                    if kind=='index':
                        def reached(index=value,is_cancelled=cancelled):
                            with self._state:
                                if not is_cancelled():synthIndexReached.notify(synth=self,index=index)
                        self._player.feed(bytes(2),onDone=reached)
                    elif kind=='reserve':
                        # At accelerated document speeds the first short
                        # packet can finish just before the next conversion.
                        # Let the bounded producer build a small initial
                        # reserve; cached navigation never takes this path.
                        with self._state:self._state.wait_for(cancelled,timeout=value)
                    elif kind=='end':
                        if serial!=self._serial:continue
                        self._player.idle()
                        with self._state:
                            if not cancelled() and serial==self._serial:
                                self._last_completed=serial
                                synthDoneSpeaking.notify(synth=self)
                    else:self._play(value,generation)
        finally:
            ahead_stopped.set()
            announcer.join(1)
            ahead.join(3)
            # Retain the serialized worker across synthesizer switches. Its
            # stdin closes at NVDA exit; atexit also reaps it explicitly.
            self._player.close()


    @staticmethod
    def _tempo(rate, multiplier):
        return min(10., 2 ** ((max(0, min(100, rate)) - 50) / 50) * max(1, min(5, multiplier)))

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

    def cancel(self):
        with self._state:
            if self._closed:
                return
            if self._serial > self._last_completed:
                self._cancelled_after_serial = self._serial
            self._generation += 1
            self._paused = False
            try:
                while True:
                    self._jobs.get_nowait()
            except Empty:
                pass
            try:
                while True:self._speculative.get_nowait()
            except Empty:pass
            try:
                while True:self._announcements.get_nowait()
            except Empty:pass
            self._prepared_keys.clear()
            self._job_ready.set()
            self._player.stop()
            self._state.notify_all()

    def pause(self, switch):
        with self._state:
            if not self._closed:
                self._paused = switch
                self._player.pause(switch)
                self._state.notify_all()

    def _play(self, pcm, generation):
        frame_bytes = SAMPLE_RATE * 2 // 20
        for offset in range(0, len(pcm), frame_bytes):
            with self._state:
                self._state.wait_for(lambda: generation != self._generation or not self._paused)
                if generation != self._generation:
                    return
            self._player.feed(pcm[offset:offset + frame_bytes])
            if generation != self._generation:
                self._player.stop()
                return
            self._intro_pending = False

    def _initial_document_reserve(self):
        """One bounded startup reserve per Say All reader, never per line."""
        try:
            from speech import sayAll
            import weakref
            handler=sayAll.SayAllHandler
            reader=handler._getActiveSayAll() if handler else None
            if reader is None:return 0.
            with self._state:
                previous=getattr(self,'_document_reader',None)
                if previous is not None and previous() is reader:return 0.
                self._document_reader=weakref.ref(reader)
        except (ImportError,AttributeError,TypeError):return 0.
        return .4

    @staticmethod
    def _interactive_line(items):
        text=" ".join(item["request"]["text"] for item in items if "request" in item)
        if len(text)>200 or re.search(r"[.!?…]\s+\S",text):
            return False
        from speech import sayAll
        handler=sayAll.SayAllHandler
        return handler is not None and not handler.isRunning()

    def _render_parts(self, parts, warm, cancelled, *, speculative=False, interactive=False):
        items=[]
        has_source=False
        played_prefix=False
        for kind,value in parts:
            if cancelled():return
            if kind in ('index','break'):
                items.append({'kind':kind,'value':value})
                continue
            pcm=self._engine.fast_clip(value)
            if pcm is None:
                items.append({'kind':'source','request':value})
                has_source=True
            elif has_source:
                items.append({'kind':'cached','request':value,'pcm':base64.b64encode(pcm).decode('ascii')})
            else:
                # A ready command/letter plays before planning the following
                # title, loading a model or waiting for a speculative request.
                for item in items:
                    if item['kind']=='index':yield 'index',item['value']
                    else:yield 'pcm',bytes(round(min(item['value'],10000)*SAMPLE_RATE/1000)*2)
                items.clear()
                played_prefix=True
                frame_bytes=SAMPLE_RATE*2//20
                for offset in range(0,len(pcm),frame_bytes):
                    if cancelled():return
                    yield 'pcm',pcm[offset:offset+frame_bytes]
        document_reserve=self._initial_document_reserve() if not speculative else 0.
        if has_source:
            if max(item.get('request',{}).get('speed',1.) for item in items)<3.:document_reserve=0.
            first_spoken=next(item for item in items if item['kind'] in ('source','cached'))
            if played_prefix or first_spoken['kind']=='cached':document_reserve=0.
            uncached_count=sum(item['kind']=='source' for item in items)
            reserve=(not played_prefix and not speculative and (uncached_count>1
                                         or len(first_spoken['request']['text'])>=80)
                     and max(item.get('request',{}).get('speed',1.) for item in items)>=3.
                     and all(row['backend']=='supertonic' for row in _REGISTRY.languages.values())
                     and not (uncached_count==1 and interactive and self._interactive_line(items)))
            if not speculative:
                relay=None
                with self._state:
                    self._foreground_waiting.set()
                    active=self._active_preview
                    if active:
                        first_key=self._engine._key(first_spoken['request'])
                        if first_key is not None and active[0]==first_key and not active[1].is_set():
                            relay=active[2]
                        else:
                            # A matching later packet must not monopolize
                            # the pipe while foreground needs its first word.
                            active[1].set()
            try:
                if not speculative and relay is not None:
                    self._adopted_count=getattr(self,'_adopted_count',0)+1
                    for position,item in enumerate(items):
                        if cancelled():return
                        if item['kind']=='index':yield 'index',item['value']
                        elif item['kind']=='break':yield 'pcm',bytes(round(min(item['value'],10000)*SAMPLE_RATE/1000)*2)
                        elif item['kind']=='cached':yield 'pcm',base64.b64decode(item['pcm'])
                        else:
                            # The preview has already built its initial audio
                            # reserve. Waiting again here inserts a pause at
                            # every line boundary despite ready PCM.
                            for pcm in relay.stream(cancelled):
                                if document_reserve:
                                    yield 'reserve',document_reserve;document_reserve=0.
                                yield 'pcm',pcm
                            # A long utterance can have additional packets.
                            # Reuse its live prepared prefix too, rather than
                            # waiting for that prefix to finish and requesting
                            # it a second time before rendering the tail.
                            remaining=items[position+1:]
                            if remaining:
                                for kind,value in self._engine.stream_batch(remaining,cancelled):
                                    if kind=='index':yield kind,value
                                    else:
                                        if document_reserve:
                                            yield 'reserve',document_reserve;document_reserve=0.
                                        frame_bytes=SAMPLE_RATE*2//20
                                        for offset in range(0,len(value),frame_bytes):
                                            if cancelled():return
                                            yield 'pcm',value[offset:offset+frame_bytes]
                            break
                    return
                while warm.is_alive() and not cancelled():warm.join(.015)
                if cancelled():return
                for kind,value in self._engine.stream_batch(items,cancelled):
                    if kind=='index':yield kind,value
                    else:
                        reserve_time=document_reserve
                        document_reserve=0.
                        if reserve:
                            first=next(item for item in items if item['kind'] in ('source','cached'))
                            if self._engine.fast_clip(first['request']) is None:
                                # Longer accelerated passages need more margin
                                # for the larger second packet under CPU load.
                                # Cached neighbors and isolated words skip it.
                                reserve_time=max(reserve_time,.16 if len(first_spoken['request']['text'])>=80 else
                                              .55 if uncached_count>=3 else .3)
                            reserve=False
                        if reserve_time:yield 'reserve',reserve_time
                        frame_bytes=SAMPLE_RATE*2//20
                        for offset in range(0,len(value),frame_bytes):
                            if cancelled():return
                            yield 'pcm',value[offset:offset+frame_bytes]
            finally:
                if not speculative:self._foreground_waiting.clear()
        else:
            for item in items:
                if cancelled():return
                if item['kind']=='index':yield 'index',item['value']
                elif item['kind']=='break':yield 'pcm',bytes(round(min(item['value'],10000)*SAMPLE_RATE/1000)*2)
                else:yield 'pcm',base64.b64decode(item['pcm'])
        return
