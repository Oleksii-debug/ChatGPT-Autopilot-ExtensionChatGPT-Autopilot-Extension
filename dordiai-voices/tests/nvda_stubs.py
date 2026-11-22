"""Minimal NVDA import surface for driver integration tests, not an NVDA emulator."""
from contextlib import contextmanager
import importlib.util
from pathlib import Path
import sys
import types
from unittest.mock import patch


class BaseDriver:
    def _get_language(self):
        return self.availableVoices[self.voice].language

    def __getattr__(self, name):
        getter = getattr(type(self), "_get_" + name, None)
        if getter is not None:
            return getter(self)
        raise AttributeError(name)

    @staticmethod
    def VoiceSetting(): return object()
    @staticmethod
    def RateSetting(): return object()
    @staticmethod
    def PitchSetting(): return object()
    @staticmethod
    def VolumeSetting(): return object()


class Setting:
    def __init__(self, *args, **kwargs): pass


class VoiceInfo:
    def __init__(self, id, displayName, language=None):
        self.id, self.displayName, self.language = id, displayName, language


class SynthCommand: pass


class SynthParamCommand(SynthCommand):
    isDefault = False


class Filter:
    def __init__(self): self.callbacks = []
    def register(self, callback): self.callbacks.append(callback)
    def unregister(self, callback): self.callbacks.remove(callback)
    def apply(self, sequence, **kwargs):
        for callback in tuple(self.callbacks): sequence = callback(sequence, **kwargs)
        return sequence


def command(name, field):
    def init(self, value=None):
        setattr(self, field, value)
    base = SynthCommand if name in {"BreakCommand", "IndexCommand"} else SynthParamCommand
    return type(name, (base,), {"__init__": init})


@contextmanager
def driver_module():
    root = Path(__file__).resolve().parents[1] / "source/0.12.2"
    modules = {}
    def module(name, **attrs):
        obj = types.ModuleType(name)
        obj.__dict__.update(attrs)
        modules[name] = obj
        return obj
    module("autoSettingsUtils", __path__=[])
    module("autoSettingsUtils.driverSetting", BooleanDriverSetting=Setting,
           DriverSetting=Setting, NumericDriverSetting=Setting)
    module("config", conf={"audio": {"outputDevice": "default"}})
    module("nvwave", WavePlayer=object)
    module("logHandler", log=types.SimpleNamespace(error=lambda *a: None,
           warning=lambda *a: None, debug=lambda *a: None))
    module("speech", __path__=[], filter_speechSequence=Filter())
    commands = {n: command(n, f) for n, f in (
        ("BreakCommand", "time"), ("CharacterModeCommand", "state"),
        ("IndexCommand", "index"), ("LangChangeCommand", "lang"),
        ("PitchCommand", "newValue"), ("RateCommand", "newValue"),
        ("VolumeCommand", "newValue"),
    )}
    module("speech.commands", SynthCommand=SynthCommand, SynthParamCommand=SynthParamCommand,
           EndUtteranceCommand=type("EndUtteranceCommand", (SynthCommand,), {}), **commands)
    notify = type("Notification", (), {"notify": staticmethod(lambda **kw: None)})()
    module("synthDriverHandler", SynthDriver=BaseDriver, VoiceInfo=VoiceInfo,
           synthDoneSpeaking=notify, synthIndexReached=notify, getSynth=lambda: None)
    module("synthDrivers", __path__=[str(root / "synthDrivers")])
    with patch.dict(sys.modules, modules):
        spec = importlib.util.spec_from_file_location("_dordiai_driver_integration",
            root / "synthDrivers/kx47Preview.py")
        driver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(driver)
        yield driver

