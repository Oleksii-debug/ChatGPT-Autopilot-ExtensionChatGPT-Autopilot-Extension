"""Read prepared speaker recordings without loading any acoustic model."""
from functools import lru_cache
from hashlib import sha256
import importlib.util
import json
import ntpath
import os
from pathlib import Path
import sys
from unicodedata import normalize


MAX_INDEX_BYTES = 2 * 1024 * 1024
MAX_CLIP_BYTES = 48000 * 8
BANK_FORMAT = "dordiai-voice-bank"


def bank_language(language):
    code = language.lower().replace("_", "-")
    return "en-us" if code == "en" else code


def bank_key(language, name):
    return sha256((bank_language(language) + "\0" + normalize("NFC", name).strip().casefold()).encode("utf8")).hexdigest()[:24]


@lru_cache(maxsize=1)
def _host_paths():
    name = "_dordiai_main_host_paths"
    module = sys.modules.get(name)
    if module is None:
        location = Path(__file__).absolute().parent.parent / "kx47Runtime" / "host_paths.py"
        spelling = ntpath.normpath(str(location))
        if os.name == "nt" and not spelling.startswith(("\\\\?\\", "\\\\.\\")):
            spelling = "\\\\?\\UNC\\" + spelling[2:] if spelling.startswith("\\\\") else "\\\\?\\" + spelling
        spec = importlib.util.spec_from_file_location(name, spelling)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(name, None)
            raise
    return module


@lru_cache(maxsize=1)
def _voice_assets():
    # NVDA imports synthDrivers without the worker's runtime on sys.path.
    name = "_dordiai_prepared_bank_assets"
    module = sys.modules.get(name)
    if module is None:
        path = _host_paths().filesystem_path(Path(__file__).absolute().parent.parent / "kx47Runtime" / "voice_assets.py")
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(name, None)
            raise
    return module


def _signature(path):
    try:
        info = path.stat()
        return info.st_size, info.st_mtime_ns, info.st_ctime_ns
    except OSError:
        return None


class NativeLetterBank:
    def __init__(self, references, folder="native_letters"):
        self.references = _host_paths().filesystem_path(references) if references else None
        self.folder_name = folder
        self.folder = self.references / folder if self.references else None

    def _paths(self, profile):
        if self.folder is None:
            return None
        if self.folder_name in {"native_letters", "native_commands"}:
            assets = _voice_assets()
            try:
                assets.require_voice_allowed(profile)
            except ValueError:
                return None
            managed=assets._profile(self.references,profile)
            if managed is None:
                return self.folder/(profile+".json"),self.folder/(profile+".pcm"),False
            index = assets.asset_path(self.references, profile, self.folder_name + "_index")
            audio = assets.asset_path(self.references, profile, self.folder_name + "_audio")
            if (index is None) != (audio is None):
                raise ValueError("Installed voice has an incomplete prepared audio bank")
            if index is not None:
                return index, audio, True
            # Optional banks may be absent in a replacement package. That is
            # never permission to borrow an older built-in speaker's PCM.
            return None
        return self.folder / (profile + ".json"), self.folder / (profile + ".pcm"), False

    @lru_cache(maxsize=32)
    def _index(self, profile, index_path, managed, signature):
        if signature is None or signature[0] > MAX_INDEX_BYTES:
            if managed:
                raise ValueError("Missing or oversized installed voice bank index")
            return {}
        try:
            document = json.loads(Path(index_path).read_text(encoding="utf8"))
        except (OSError, ValueError):
            if managed:
                raise ValueError("Invalid installed voice bank index")
            return {}
        if not isinstance(document, dict):
            if managed:
                raise ValueError("Invalid installed voice bank index")
            return {}
        if managed:
            expected_kind = "letters" if self.folder_name == "native_letters" else "commands"
            if (document.get("format") != BANK_FORMAT or document.get("format_version") != 1
                    or document.get("voice_id") != profile or document.get("kind") != expected_kind
                    or document.get("sample_rate") != 24000 or document.get("channels") != 1
                    or document.get("sample_width") != 2 or document.get("complete") is not True
                    or not isinstance(document.get("entries"), dict)):
                raise ValueError("Installed voice bank identity or PCM format differs")
            document = document["entries"]
        return document

    def read(self, profile, language, name):
        if (self.folder is None or not isinstance(profile, str) or profile in {"", ".", ".."}
                or any(ch in profile for ch in "/\\:\x00")
                or not isinstance(language, str) or not isinstance(name, str)):
            return None
        paths = self._paths(profile)
        if paths is None:
            return None
        index_path, audio_path, managed = paths
        index = self._index(profile, str(index_path), managed, _signature(index_path))
        entry = index.get(bank_key(language, name))
        if not isinstance(entry, list) or len(entry) != 2:
            return None
        offset, size = entry
        if (type(offset) is not int or type(size) is not int or offset < 0 or offset % 2
                or not 2 <= size <= MAX_CLIP_BYTES or size % 2):
            return None
        try:
            if offset + size > audio_path.stat().st_size:
                return None
            with audio_path.open("rb") as stream:
                stream.seek(offset)
                pcm = stream.read(size)
        except (OSError, OverflowError):
            return None
        return pcm if len(pcm) == size else None
