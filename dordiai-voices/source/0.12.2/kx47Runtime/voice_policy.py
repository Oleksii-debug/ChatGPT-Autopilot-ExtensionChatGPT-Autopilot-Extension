"""Release voice policy shared by the driver, worker and package tools.

Keep this module free of model/NVDA imports: enforcing the policy must not load
an acoustic engine or block the first focus announcement.
"""
from collections import OrderedDict


EXCLUDED_VOICE_IDS = frozenset({
    "kostia", "inna", "dina", "vira", "innesa", "veronika_classmate",
    "anatolii", "veronika",
})


def is_voice_allowed(voice_id):
    """Match identities, not display names, and fail closed for empty IDs."""
    return (isinstance(voice_id, str) and bool(voice_id.strip())
            and voice_id.strip().casefold() not in EXCLUDED_VOICE_IDS)


def require_voice_allowed(voice_id):
    if not is_voice_allowed(voice_id):
        raise ValueError("Voice is excluded from this release: " + str(voice_id))
    return voice_id


def filter_voice_catalog(voices):
    """Preserve the source's voice order while dropping excluded identities."""
    return OrderedDict((key, value) for key, value in voices.items()
                       if is_voice_allowed(key))


def resolve_voice(voices, preferred=None, aliases=None):
    """Migrate a saved choice without ever resolving an excluded old alias.

    The configured order gives a deterministic fallback; no hidden voice is
    reintroduced when a removed choice or an old profile is restored.
    """
    available = filter_voice_catalog(voices)
    if is_voice_allowed(preferred):
        candidate = (aliases or {}).get(preferred, preferred)
        if is_voice_allowed(candidate) and candidate in available:
            return candidate
    if not available:
        raise ValueError("No allowed voices are available.")
    return next(iter(available))
