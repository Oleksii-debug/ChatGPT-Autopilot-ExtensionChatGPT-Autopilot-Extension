"""Preserve original NVDA locale provenance through the public sequence filter."""
from functools import lru_cache
from threading import RLock
from weakref import ref


@lru_cache(maxsize=None)
def command_type(parameter_base):
    """Create a real host SynthParamCommand; no NVDA import is required here."""
    class LanguageOriginCommand(parameter_base):
        # Automatic=False must also replay, superseding earlier explicit state.
        isDefault = False

        def __init__(self, explicit):
            if type(explicit) is not bool:
                raise ValueError("Language origin must be explicitly boolean")
            self.explicit = explicit

        def __repr__(self):
            return "LanguageOriginCommand(explicit=%r)" % self.explicit

        def __eq__(self, other):
            return type(self) is type(other) and self.explicit == other.explicit

    return LanguageOriginCommand


def annotate(sequence, language_command, origin_command, end_utterance_command=None, *, default_explicit=False):
    """Add only transport metadata, retaining all original objects and order."""
    if not isinstance(sequence, (list, tuple)):
        return sequence
    if (not any(isinstance(item, str) and item.strip() for item in sequence)
            or any(isinstance(item, origin_command) for item in sequence)):
        return sequence
    output = []
    # A validated typed-event context is an explicit keyboard-locale source,
    # even when NVDA expresses its default locale as LangChangeCommand(None).
    explicit = bool(default_explicit)
    established = False
    for item in sequence:
        if isinstance(item, language_command):
            explicit = bool(item.lang) or bool(default_explicit)
            output.append(origin_command(explicit))
            established = True
        elif isinstance(item, str) and item.strip() and not established:
            output.append(origin_command(explicit))
            established = True
        output.append(item)
        if end_utterance_command is not None and isinstance(item, end_utterance_command):
            established = False
    return output


class Subscription:
    def __init__(self, owner, point, handler, language_command, origin_command,
                 end_utterance_command=None, default_explicit=None):
        self.point = point
        self.closed = False
        self._lock = RLock()
        owner_ref = ref(owner)

        def filter_sequence(sequence, **kwargs):
            current = owner_ref()
            if (self.closed or current is None or getattr(current, "_closed", False)
                    or handler.getSynth() is not current
                    or origin_command not in getattr(current, "supportedCommands", ())):
                return sequence
            typed = bool(default_explicit(current)) if default_explicit is not None else False
            return annotate(sequence, language_command, origin_command, end_utterance_command,
                            default_explicit=typed)

        self.callback = filter_sequence
        point.register(self.callback)

    def close(self):
        with self._lock:
            if self.closed:
                return False
            self.closed = True
            self.point.unregister(self.callback)
            return True


def subscribe(owner, speech_module, handler, language_command, origin_command,
              end_utterance_command=None, default_explicit=None):
    point = getattr(speech_module, "filter_speechSequence", None)
    if point is None or not callable(getattr(point, "register", None)) or not callable(getattr(point, "unregister", None)):
        raise RuntimeError("NVDA speech.filter_speechSequence is required for Dordiai language provenance")
    return Subscription(owner, point, handler, language_command, origin_command,
                        end_utterance_command, default_explicit)
