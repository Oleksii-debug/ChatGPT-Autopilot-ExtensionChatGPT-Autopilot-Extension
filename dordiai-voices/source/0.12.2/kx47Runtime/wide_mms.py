"""Optional native MMS/VITS ONNX pronunciation carriers.

These are pinned native-language checkpoints, not aliases to another language.
Their source speaker is projected by the shared OpenVoice layer; source.npy must
be measured from the SAME carrier, never copied from a different voice.
"""
from functools import lru_cache
import json
from pathlib import Path
import re
import unicodedata
from threading import RLock
import weakref

BACKEND = "mms-onnx"
MODEL_FORMAT = "dordiai-mms-onnx-v1"
SUPPORTED = {"ay": "ayr", "fil": "tgl", "km": "khm", "tg": "tgk", "lo": "lao", "mai": "mai",
             "doi": "dgo", "dv": "div", "dz": "dzo", "ha": "hau", "yo": "yor", "ff": "ful",
             "mg": "mlg", "so": "som", "sn": "sna", "rw": "kin", "rn": "run", "ny": "nya",
             "ak": "aka", "bm": "bam", "dyu": "dyu", "mos": "mos", "kab": "kab", "ts": "tso",
             "sg": "sag", "tpi": "tpi", "sm": "smo", "fj": "fij", "gil": "gil"}
REQUIRED = ("model.onnx", "tokens.txt", "config.json", "source.npy", "NOTICE.txt")


class UnsupportedMMSInput(ValueError):
    pass


def prepared_character_name(code, glyph, models):
    """Ordinary native names only; phonetic spelling examples are a separate mode."""
    try:
        from character_names import spoken_name
        return spoken_name(code, glyph, mode="ordinary", directory=Path(models) / "CharacterNames")
    except (ImportError, LookupError) as error:
        raise UnsupportedMMSInput("Verified native character name is not installed for " + code) from error


def read_tokens(path):
    """Preserve the literal space token and duplicate case aliases in Sherpa tables."""
    values = {}
    for line in Path(path).read_text(encoding="utf8").splitlines():
        if not line:
            continue
        try:
            symbol, number = line.rsplit(" ", 1)
            number = int(number)
        except ValueError as error:
            raise ValueError("Invalid MMS token table row") from error
        if not symbol or number < 0 or symbol in values and values[symbol] != number:
            raise ValueError("Conflicting MMS token table")
        values[symbol] = number
    if not values or 0 not in values.values():
        raise ValueError("Missing MMS token vocabulary or blank ID")
    return values


class MMSFrontend:
    def __init__(self, config, tokens):
        self.config, self.tokens = config, tokens
        if config.get("format") != MODEL_FORMAT or config.get("frontend") != "characters":
            raise ValueError("Unsupported MMS model/frontend configuration")
        if config.get("is_uroman"):
            raise ValueError("This native-script MMS adapter does not substitute an untrained romanizer")
        self.blank = int(config.get("blank_id", 0))
        if self.blank not in tokens.values():
            raise ValueError("Unknown MMS blank ID")
        self.navigation = config.get("navigation", {})

    def text(self, value, character=False):
        value = unicodedata.normalize("NFC", str(value)).replace("’", "'")
        if character:
            names = self.navigation.get("letters", {})
            names = dict(names, **self.navigation.get("punctuation", {}))
            name = names.get(value) or names.get(value.casefold())
            digits = self.navigation.get("digits", ())
            if name is None and len(value) == 1 and value.isdecimal() and len(digits) == 10:
                name = digits[unicodedata.decimal(value)]
            if name is None:
                raise UnsupportedMMSInput("Verified character name is not installed for " + self.config["code"])
            value = name
        if self.config.get("lowercase", True):
            value = value.lower()
        if any(char.isdecimal() for char in value):
            # A digit accidentally present in a training vocabulary is not a
            # verified native number-reading rule.
            digits = self.navigation.get("digits", ())
            if len(digits) != 10:
                raise UnsupportedMMSInput("Native number names are not prepared for " + self.config["code"])
            value = re.sub(r"\d+", lambda match: " " + " ".join(digits[unicodedata.decimal(char)] for char in match[0]) + " ", value)
        output, missing = [], set()
        for char in value:
            if char in self.tokens:
                output.append(char)
            elif char.isspace() or unicodedata.category(char).startswith("P"):
                output.append(" ")
            elif unicodedata.category(char).startswith(("L", "M")) or char.isdecimal():
                missing.add(char)
            else:
                # Symbol names are provided by NVDA/navigation, not guessed in
                # another language. A raw unsupported symbol remains explicit.
                missing.add(char)
        if missing:
            labels = " ".join("U+%04X" % ord(char) for char in sorted(missing))
            raise UnsupportedMMSInput("Unsupported native graphemes for " + self.config["code"] + ": " + labels)
        prepared = re.sub(r"\s+", " ", "".join(output)).strip()
        if not prepared:
            raise UnsupportedMMSInput("No native MMS graphemes in input")
        if " " in prepared and " " not in self.tokens:
            raise UnsupportedMMSInput("Native MMS vocabulary has no word separator")
        return prepared

    def ids(self, value, character=False):
        value = self.text(value, character)
        symbols = [self.tokens[char] for char in value]
        if self.config.get("add_blank", True):
            # Upstream VITS commons.intersperse uses integer 0, even when the
            # exported table spells that ID as a visible language character.
            result = [self.blank] * (2 * len(symbols) + 1)
            result[1::2] = symbols
            return result
        return symbols


class MMSCarrier:
    def __init__(self, directory, session_factory=None, owner=None):
        self.folder = Path(directory)
        from mms_family_sessions import resource_identity, assert_resources
        self._resource_identity = resource_identity(self.folder)
        self.config = json.loads((self.folder / "config.json").read_text(encoding="utf8"))
        self.code = self.config.get("code")
        if self.code not in SUPPORTED or self.config.get("iso_code") != SUPPORTED[self.code]:
            raise ValueError("MMS checkpoint language does not match its selected standard")
        if self.folder.name != self.code:
            raise ValueError("MMS directory and native language configuration disagree")
        self.frontend = MMSFrontend(self.config, read_tokens(self.folder / "tokens.txt"))
        assert_resources(self._resource_identity)
        self.sample_rate = int(self.config["sample_rate"])
        if not 8000 <= self.sample_rate <= 48000:
            raise ValueError("Invalid native MMS sample rate")
        self.owner, self.session_factory = owner, session_factory
        self._graph = None
        self._inputs = None
        self._closed = False
        self.model_session_mode = "unloaded"
        self._lock = RLock()
        if owner is not None:
            from wide_loading import DeferredValue
            reference = weakref.ref(self)
            def open_if_alive():
                carrier = reference()
                return carrier._open() if carrier is not None else None
            self._deferred = DeferredValue(open_if_alive)
        else:
            self._deferred = None

    def _open(self):
        from mms_family_sessions import assert_resources
        if hasattr(self, "_resource_identity"):
            assert_resources(self._resource_identity)
        with self._lock:
            if self._closed:
                return None
            if hasattr(self, "_resource_identity"):
                assert_resources(self._resource_identity)
        from mms_family_sessions import for_language
        graph = for_language(self.folder / "model.onnx", self.code, self.session_factory)
        shared = graph is not None
        if graph is None and self.session_factory is None:
            import onnxruntime as ort
            ort.disable_telemetry_events()
            options = ort.SessionOptions()
            options.intra_op_num_threads = 2
            options.inter_op_num_threads = 1
            options.add_session_config_entry("session.intra_op.allow_spinning", "0")
            graph = ort.InferenceSession(str(self.folder / "model.onnx"), sess_options=options,
                                        providers=["CPUExecutionProvider"])
        elif graph is None:
            graph = self.session_factory(self.folder / "model.onnx")
        if self.owner is not None:
            from session_control import GuardedSession
            if not isinstance(graph, GuardedSession):
                graph = GuardedSession(graph, self.owner)
        inputs = {entry.name: entry for entry in graph.get_inputs()}
        expected = {"x", "x_length", "noise_scale", "length_scale", "noise_scale_w"}
        if set(inputs) != expected or inputs["x"].type != "tensor(int64)":
            raise ValueError("Unexpected MMS ONNX graph inputs: " + str(tuple(inputs)))
        metadata = graph.get_modelmeta().custom_metadata_map
        if (metadata.get("comment") != "mms" or metadata.get("frontend") != "characters"
                or int(metadata.get("sample_rate", "0")) != self.sample_rate
                or bool(int(metadata.get("add_blank", "0"))) != bool(self.config.get("add_blank", True))):
            raise ValueError("MMS ONNX metadata differs from the prepared native configuration")
        with self._lock:
            if self._closed:
                return None
            self._inputs = inputs
            if hasattr(self, "_resource_identity"):
                assert_resources(self._resource_identity)
            self._graph = graph
            self.model_session_mode = "shared-exact-weights" if shared else "original"
        return graph

    def preload(self):
        if hasattr(self, "_resource_identity"):
            from mms_family_sessions import assert_resources
            assert_resources(self._resource_identity)
        with self._lock:
            if self._closed:
                raise RuntimeError("MMS carrier was closed")
            deferred = self._deferred
        graph = deferred.get(self.owner) if deferred is not None else self._graph or self._open()
        with self._lock:
            if self._closed or graph is None:
                raise RuntimeError("MMS carrier was closed")
            if hasattr(self, "_resource_identity"):
                assert_resources(self._resource_identity)
        return graph

    def close(self):
        # A cold ORT construction cannot itself be cancelled. Closing is still
        # immediate: mark the object and let any in-flight constructor discard
        # its result. The weak deferred factory cannot keep an evicted carrier
        # and its native graph alive through a bound-method cycle.
        with self._lock:
            self._closed = True
            self._graph = None
            self._inputs = None
            self._deferred = None

    def audio(self, text, character=False, speed=1., *, noise_scale=.667, noise_scale_w=.8):
        import numpy as np
        if self.owner is not None:
            self.owner.check_cancelled()
        from mms_family_sessions import assert_resources
        assert_resources(self._resource_identity)
        if character and not any(char.isdecimal() for char in text) and not self.frontend.navigation:
            text = prepared_character_name(self.code, text, self.folder.parent.parent)
            character = False
        if any(char.isdecimal() for char in text) and not self.frontend.navigation.get("digits"):
            from wide_numbers import spell_numbers
            expanded = spell_numbers(self.code, text)
            if character and len(text) == 1 and text.isdecimal() and expanded != text:
                text, character = expanded, False
            else:
                text = expanded
        tokens = self.frontend.ids(text, character)
        applied = min(2.5, max(.5, float(speed)))
        graph = self.preload()
        if not 0. <= float(noise_scale) <= 1.5 or not 0. <= float(noise_scale_w) <= 1.5:
            raise ValueError("Invalid MMS inference noise scale")
        values = {"x": np.asarray([tokens], np.int64), "x_length": np.asarray([len(tokens)], np.int64),
                  "noise_scale": np.asarray([noise_scale], np.float32), "length_scale": np.asarray([1. / applied], np.float32),
                  "noise_scale_w": np.asarray([noise_scale_w], np.float32)}
        wave = np.asarray(graph.run(["y"], values)[0], np.float32).reshape(-1)
        if self.owner is not None:
            self.owner.check_cancelled()
        assert_resources(self._resource_identity)
        if len(wave) < 32 or not np.isfinite(wave).all() or np.max(np.abs(wave)) < 1e-7:
            raise ValueError("MMS checkpoint returned invalid or silent audio")
        return wave, self.sample_rate, applied


def available(models):
    root = Path(models) / "MMS"
    return {code for code in SUPPORTED if all((root / code / name).is_file() for name in REQUIRED)}


def source(code, models):
    if code not in SUPPORTED:
        raise KeyError(code)
    from mms_family_sessions import resource_identity
    folder = Path(models) / "MMS" / code
    return _source_snapshot(str(folder / "source.npy"), resource_identity(folder))


@lru_cache(maxsize=4)
def _source_snapshot(path, identity):
    import numpy as np
    from mms_family_sessions import assert_resources
    assert_resources(identity)
    with Path(path).open("rb") as stream:
        value = np.load(stream, allow_pickle=False)
    assert_resources(identity)
    if value.shape != (1, 256, 1) or value.dtype != np.float32 or not np.isfinite(value).all():
        raise ValueError("Invalid MMS native source identity")
    value.setflags(write=False)
    return value


source.cache_clear = _source_snapshot.cache_clear
