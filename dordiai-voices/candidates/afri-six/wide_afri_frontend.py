"""Exact pinned native G2P for reviewed AfricaTTS language charts only.

The reviewed vendor source is code in the core, never executable model-pack data.
No English pipeline, nearest-language mapping or universal language selection.
"""
from functools import lru_cache
from hashlib import sha1
import importlib.util
import json
from pathlib import Path
import sys
from threading import RLock

REVISION = "76b53a8fa2a688812e369837d179d4710c111a7a"
SUPPORTED = {"ss": "ssw", "ve": "ven", "zu": "zul", "wo": "wol", "nso": "nso"}
_PACKAGE = "_dordiai_afri_g2p_76b53a8"
_LOCK = RLock()


def _vendor():
    return Path(__file__).with_name("vendor_afri_g2p")


@lru_cache(maxsize=1)
def _load():
    root = _vendor()
    manifest = json.loads((root / "dordiai-vendor.json").read_text(encoding="utf-8"))
    if manifest.get("revision") != REVISION or manifest.get("languages") != SUPPORTED:
        raise ValueError("Native reviewed African G2P vendor identity does not match reviewed source")
    for name, expected in manifest["files"].items():
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Invalid native G2P vendor path")
        data = (root / relative).read_bytes()
        actual = sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()
        if len(data) != expected["bytes"] or actual != expected["git_blob_sha1"]:
            raise ValueError("Reviewed native G2P source changed: " + name)
    package = root / "africa_g2p"
    with _LOCK:
        if _PACKAGE not in sys.modules:
            spec = importlib.util.spec_from_file_location(_PACKAGE, package / "__init__.py",
                                                         submodule_search_locations=[str(package)])
            module = importlib.util.module_from_spec(spec)
            sys.modules[_PACKAGE] = module
            try:
                spec.loader.exec_module(module)
            except Exception:
                for name in list(sys.modules):
                    if name == _PACKAGE or name.startswith(_PACKAGE + "."):
                        sys.modules.pop(name, None)
                raise
        return sys.modules[_PACKAGE].g2p


@lru_cache(maxsize=1024)
def phonemes(code, text):
    if code not in SUPPORTED:
        raise ValueError("AfricaTTS has no reviewed installed frontend for " + str(code))
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Empty native reviewed African request")
    if len(text) > 4096:
        raise ValueError("Native speech must be split into shorter utterances")
    if any(char.isdecimal() for char in text):
        raise ValueError("Native number names must be prepared before phonemization")
    result = _load()(text, SUPPORTED[code], output="ipa")
    if not isinstance(result, str) or not result.strip():
        raise ValueError("Native frontend produced no phonemes")
    return result
