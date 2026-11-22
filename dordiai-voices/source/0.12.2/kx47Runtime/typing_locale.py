"""Thread-local locale only while NVDA's normal typed-character handler runs.

No typed text, keyboard state, speech sequence or model data is retained.
"""
from contextlib import contextmanager
from threading import local

_state = local()


def _eligible(driver, language):
    return (bool(language) and getattr(driver, "_dordiai_mode", "auto") == "auto" and
            language in (getattr(driver, "_dordiai_enabled_languages", ()) or ()))


@contextmanager
def typed_context(driver, language, valid=None, locale=None):
    previous = getattr(_state, "current", None)
    _state.current = ({"driver": driver, "language": language, "locale": locale or language, "valid": valid}
                      if _eligible(driver, language) else None)
    try:
        yield
    finally:
        _state.current = previous


def language_for(driver, default):
    current = getattr(_state, "current", None)
    if current is None or current["driver"] is not driver or not _eligible(driver, current["language"]):
        return default
    try:
        if current["valid"] is not None and not current["valid"]():
            return default
    except Exception:
        return default
    return current["locale"]
