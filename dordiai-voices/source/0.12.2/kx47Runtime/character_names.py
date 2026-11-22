"""Resolve explicit character names without inventing an alphabet pronunciation.

Ordinary letter/symbol names and phonetic spelling examples remain separate.
Resources are pinned preparation metadata; their presence is not an acoustic
acceptance result. Package changes require reloading/restarting the driver.
"""
from functools import lru_cache
import json
from pathlib import Path
import re
import unicodedata

_CODE = re.compile(r"[a-z][a-z0-9]{1,11}\Z")


def _language(code):
    if not isinstance(code, str):
        raise LookupError("Invalid character-name language")
    code = code.lower().replace("_", "-").split("-")[0]
    code = {"no": "nb", "iw": "he", "zh": "cmn"}.get(code, code)
    if not _CODE.fullmatch(code):
        raise LookupError("Invalid character-name language")
    return code


@lru_cache(maxsize=96)
def _load(code, directory):
    path = Path(directory) / (code + ".json")
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise LookupError("No prepared native character-name resource for " + code) from error
    if len(raw) > 4 * 1024 * 1024:
        raise LookupError("Character-name resource exceeds size limit")
    try:
        document = json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise LookupError("Invalid native character-name resource") from error
    if (not isinstance(document, dict) or document.get("format") != "dordiai-character-name-sources"
            or document.get("format_version") != 1 or document.get("language") != code):
        raise LookupError("Unsupported native character-name resource")
    for field in ("letter_names", "symbol_names", "phonetic_descriptions"):
        if not isinstance(document.get(field, {}), dict):
            raise LookupError("Invalid character-name mapping: " + field)
    return document


def data(language, directory=None):
    """directory is the CharacterNames directory itself, never the models root."""
    code = _language(language)
    root = Path(directory) if directory is not None else Path(__file__).resolve().parent / "models" / "CharacterNames"
    return _load(code, str(root.resolve()))


def spoken_name(language, glyph, mode="ordinary", directory=None):
    if not isinstance(glyph, str) or not 1 <= len(glyph) <= 32:
        raise LookupError("Provide one literal character or documented grapheme unit")
    glyph = unicodedata.normalize("NFC", glyph)
    document = data(language, directory)
    explicit_letter = mode == "ordinary" and glyph in document.get("letter_names", {})
    if mode == "ordinary":
        result = document.get("letter_names", {}).get(glyph)
        if result is None:
            result = document.get("symbol_names", {}).get(glyph)
    elif mode == "phonetic":
        descriptions = document.get("phonetic_descriptions", {}).get(glyph)
        result = descriptions[0] if isinstance(descriptions, list) and descriptions else None
    else:
        raise ValueError("Character-name mode must be ordinary or explicitly phonetic")
    if not isinstance(result, str) or not result.strip() or result == glyph and not explicit_letter:
        raise LookupError("No reviewed native %s name for %r in %s" % (mode, glyph, _language(language)))
    return result


def letter_names_ready(language, directory=None):
    document = data(language, directory)
    return document.get("letter_names_ready") is True


def clear_cache():
    _load.cache_clear()
