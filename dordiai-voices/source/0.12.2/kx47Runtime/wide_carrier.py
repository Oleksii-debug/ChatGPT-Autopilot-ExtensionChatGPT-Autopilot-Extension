"""A process-local, synchronous eSpeak NG renderer; never opens a playback device."""
import ctypes as ct
from pathlib import Path
from threading import Lock
from unicodedata import name


def cherokee_roman(text):
    result=[]
    for ch in text:
        label=name(ch.upper(),"") if len(ch.upper())==1 else ""
        if label.startswith("CHEROKEE LETTER "):
            syllable=label.removeprefix("CHEROKEE LETTER ").lower()
            syllable=syllable.replace("qu","gw").replace("ts","j")
            result.append(syllable)
        else:
            result.append(ch)
    return "".join(result)


class WideCarrier:
    CALLBACK = ct.CFUNCTYPE(ct.c_int, ct.POINTER(ct.c_int16), ct.c_int, ct.c_void_p)

    def __init__(self, folder,resources=None,library="espeak.dll"):
        self.folder = Path(folder)
        self.resources=Path(resources) if resources else self.folder
        self._rules={}
        self._europe=None
        self.lib = ct.CDLL(str(self.folder / library))
        signatures = {
            "espeak_Initialize": ([ct.c_int,ct.c_int,ct.c_char_p,ct.c_int],ct.c_int),
            "espeak_SetSynthCallback": ([self.CALLBACK],None),
            "espeak_SetVoiceByName": ([ct.c_char_p],ct.c_int),
            "espeak_SetParameter": ([ct.c_int,ct.c_int,ct.c_int],ct.c_int),
            "espeak_Synth": ([ct.c_char_p,ct.c_size_t,ct.c_uint,ct.c_int,ct.c_uint,ct.c_uint,ct.c_void_p,ct.c_void_p],ct.c_int),
            "espeak_Char": ([ct.c_wchar],ct.c_int),
            "espeak_Terminate": ([],ct.c_int),
        }
        for name,(argtypes,result) in signatures.items():
            proc=getattr(self.lib,name);proc.argtypes=argtypes;proc.restype=result
        from legacy_data_path import prepare_legacy_data_path
        self._data_location = prepare_legacy_data_path(self.folder)
        self.rate=self.lib.espeak_Initialize(2,35,self._data_location.encoded,0x8000)
        try:
            self._data_location.verify()
        except Exception:
            self.lib.espeak_Terminate()
            raise
        if self.rate<=0:
            self.lib.espeak_Terminate()
            raise RuntimeError("Could not open the bundled eSpeak NG language data")
        self._lock=Lock()
        self._packets=[]
        self._cancelled=None
        self._callback=self.CALLBACK(self._capture)
        self.lib.espeak_SetSynthCallback(self._callback)
        self._voice=None
        self._japanese=None

    def _capture(self, samples, length, events):
        if self._cancelled and self._cancelled(): return 1
        if samples and length>0: self._packets.append(ct.string_at(samples,2*length))
        return 0

    def pcm(self, voice, text, *, character=False, rate=182, cancelled=None):
        with self._lock:
            if voice.startswith("upstream:"):
                if self._europe is None:
                    self._europe=WideCarrier(self.resources/"EuropeanVoices",library="libespeak-ng.dll")
                return self._europe.pcm(voice.partition(":")[2],text,character=character,rate=rate,cancelled=cancelled)
            flags=1
            if voice.startswith("rules:"):
                from wide_phonetics import PronunciationRules,ROUTES
                code=voice.partition(":")[2];voice=ROUTES[code]
                if not character or not text.isalpha():
                    if code not in self._rules:
                        self._rules[code]=PronunciationRules(self.resources/"PronunciationRules",code)
                    text=self._rules[code].encoded(text,strict=False)
                    flags|=0x100
                    character=False
            if voice=="iro/chr":
                reading=cherokee_roman(text)
                if reading!=text:
                    text,character=reading,False
            if voice=="jpx/ja" and any(ord(char)>=0x3400 for char in text) and (self.folder/"Japanese/index.json").is_file():
                from wide_japanese import JapaneseReading
                if self._japanese is None:
                    self._japanese=JapaneseReading(self.folder/"Japanese")
                reading=self._japanese.pronounce(text)
                if reading!=text:
                    text,character=reading,False
            if self._voice!=voice:
                if self.lib.espeak_SetVoiceByName(voice.encode("ascii")):
                    raise ValueError("Unavailable speech language: "+voice)
                self._voice=voice
            self._packets=[]
            self._cancelled=cancelled
            try:
                self.lib.espeak_SetParameter(1,int(rate),0)
                if character and len(text)==1 and ord(text)<=0xffff:
                    status=self.lib.espeak_Char(text)
                else:
                    raw=text.replace("\0"," ").encode("utf8")
                    status=self.lib.espeak_Synth(raw,len(raw)+1,0,1,0,flags,None,None)
                if status: raise RuntimeError("Local language synthesis failed: "+voice)
                return b"".join(self._packets)
            finally:
                self._cancelled=None
                self._packets=[]

    def close(self):
        with self._lock:
            if self._europe is not None:
                self._europe.close()
                self._europe=None
            if self._callback is not None:
                self.lib.espeak_Terminate()
                self._callback=None
