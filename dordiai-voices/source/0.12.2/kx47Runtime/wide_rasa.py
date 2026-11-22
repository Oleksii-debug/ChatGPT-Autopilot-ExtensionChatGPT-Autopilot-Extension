"""Pinned Rasa ONNX pronunciation, restricted to documented trained speakers.

The original AI4Bharat model documents Bodo BRX_F=4 and ALEXA style=0.
Its public export has no Meitei characters; an inaccurate export-card MNI tag
does not make Manipuri supported. All inference is local direct ONNX Runtime,
including the required seventh emotion_id input. No uroman or Sherpa wrapper.
"""
from functools import lru_cache
import json
from pathlib import Path
import re
from threading import RLock
import unicodedata

FORMAT = "dordiai-rasa-onnx-v1"
SUPPORTED = {"brx": {"speaker_id": 4, "speaker_name": "BRX_F", "style_id": 0,
                      "style_name": "ALEXA", "script": "Deva"}}
RATE = 24000  # Actual pinned graph metadata; exporter README incorrectly says22050.
_ENGINE = None
_LOCK = RLock()


def model_folder(models):
    return Path(models) / "SharedRasaONNX"


def read_tokens(path):
    tokens = {}
    for row in Path(path).read_text(encoding="utf-8").splitlines():
        if not row:
            continue
        try:
            symbol, number = row.rsplit(" ", 1)
            number = int(number)
        except ValueError as error:
            raise ValueError("Invalid Rasa token table") from error
        if len(symbol) != 1 or number < 0 or symbol in tokens and tokens[symbol] != number:
            raise ValueError("Conflicting Rasa token table")
        tokens[symbol] = number
    # Export deliberately omits multicodepoint/special vocabulary entries0..15.
    # Blank0 is still a valid trained model ID. Literal '_' is a different ID95.
    if not tokens or tokens.get(" ") != 16 or tokens.get("_") != 95:
        raise ValueError("Unexpected native Rasa vocabulary")
    return tokens


def native_ids(text, tokens):
    text = unicodedata.normalize("NFC", str(text)).replace("\u200c", "").replace("\u200d", "")
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        raise ValueError("Empty native Rasa text")
    unsupported = set()
    for char in text:
        category = unicodedata.category(char)
        if char.isdecimal():
            raise ValueError("Native Bodo number names are not prepared for this input")
        if char not in tokens or category.startswith(("L", "M")) and not 0x0900 <= ord(char) <= 0x097f:
            unsupported.add(char)
    if unsupported:
        raise ValueError("Unsupported native Bodo characters: " + " ".join("U+%04X" % ord(c) for c in sorted(unsupported)))
    if not any(unicodedata.category(char).startswith("L") for char in text):
        raise ValueError("No native Bodo letters in request; use reviewed character names")
    values = [0] * (2 * len(text) + 1)
    values[1::2] = [tokens[char] for char in text]
    if len(values) > 4096:
        raise ValueError("Bodo text must be split into shorter utterances")
    return values


class RasaEngine:
    def __init__(self, directory, owner=None, session_factory=None, threads=2):
        import numpy as np
        self.np, self.folder, self.owner = np, Path(directory), owner
        self.config = json.loads((self.folder / "config.json").read_text(encoding="utf-8"))
        if (self.config.get("format") != FORMAT or self.config.get("sample_rate") != RATE
                or self.config.get("frontend") != "native-characters" or self.config.get("languages") != SUPPORTED):
            raise ValueError("Rasa graph/language registration does not match the documented native standard")
        self.tokens = read_tokens(self.folder / "tokens.txt")
        if session_factory is None:
            import onnxruntime as ort
            ort.disable_telemetry_events()
            options = ort.SessionOptions()
            options.intra_op_num_threads = max(1, int(threads))
            options.inter_op_num_threads = 1
            options.add_session_config_entry("session.intra_op.allow_spinning", "0")
            session_factory = lambda path: ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
        def open_graph():
            graph = session_factory(self.folder / "model.onnx")
            inputs = {item.name: item for item in graph.get_inputs()}
            integers = ("x", "x_length", "sid", "emotion_id")
            floats = ("noise_scale", "length_scale", "noise_scale_w")
            if (set(inputs) != set(integers + floats)
                    or any(inputs[name].type != "tensor(int64)" for name in integers)
                    or any(inputs[name].type != "tensor(float)" or inputs[name].shape != [] for name in floats)):
                raise ValueError("Unexpected seven-input Rasa ONNX signature")
            metadata = graph.get_modelmeta().custom_metadata_map
            if (metadata.get("comment") != "ai4bharat/vits_rasa_13" or metadata.get("frontend") != "characters"
                    or metadata.get("add_blank") != "1" or metadata.get("sample_rate") != str(RATE)
                    or metadata.get("n_speakers") != "1024" or metadata.get("num_emotions") != "32"):
                raise ValueError("Rasa ONNX metadata differs from the prepared graph")
            return graph
        if owner is None:
            self.session = open_graph()
        else:
            from wide_loading import DeferredSession
            self.session = DeferredSession(open_graph, owner)

    def audio(self, code, text, character=False, rate=1.0):
        if code not in SUPPORTED:
            raise ValueError("Rasa has no registered trained speaker for " + str(code))
        session = self.session
        if session is None:
            raise RuntimeError("Rasa carrier is closed")
        if self.owner is not None:
            self.owner.check_cancelled()
        if character:
            from character_names import spoken_name
            text = spoken_name(code, text, directory=self.folder.parent / "CharacterNames")
        if any(char.isdecimal() for char in text):
            from wide_numbers import spell_numbers
            text = spell_numbers(code, text)
        np = self.np
        ids = native_ids(text, self.tokens)
        selected = SUPPORTED[code]
        feed = {"x": np.asarray([ids], np.int64), "x_length": np.asarray([len(ids)], np.int64),
                "noise_scale": np.asarray(.667, np.float32), "length_scale": np.asarray(1. / min(2.5, max(.5, float(rate))), np.float32),
                "noise_scale_w": np.asarray(.8, np.float32), "sid": np.asarray([selected["speaker_id"]], np.int64),
                "emotion_id": np.asarray([selected["style_id"]], np.int64)}
        # One direct call preserves punctuation without Sherpa's spurious empty
        # trailing sentence; punctuation is never fed as a standalone phoneme.
        wave = np.asarray(session.run(["y"], feed)[0], np.float32).reshape(-1)
        if self.owner is not None:
            self.owner.check_cancelled()
        if len(wave) < 32 or not np.isfinite(wave).all() or np.max(np.abs(wave)) < 1e-7:
            raise ValueError("Rasa returned invalid or silent native Bodo audio")
        return wave

    def close(self):
        self.session = None


def available(models):
    root = model_folder(models)
    required = ("model.onnx", "tokens.txt", "config.json", "NOTICE.txt")
    if not all((root / name).is_file() and (root / name).stat().st_size for name in required):
        return set()
    return {code for code in SUPPORTED if (root / "references" / code / "source.npy").is_file()}


def audio(code, text, character=False, *, models, rate=1.0, owner=None):
    global _ENGINE
    key = str(model_folder(models).resolve())
    with _LOCK:
        if _ENGINE is None or _ENGINE[0] != key or _ENGINE[1] is not owner:
            if _ENGINE is not None:
                _ENGINE[2].close()
            _ENGINE = (key, owner, RasaEngine(key, owner=owner))
        engine = _ENGINE[2]
    return engine.audio(code, text, character, rate), RATE


def clear_engines(owner=None):
    global _ENGINE
    with _LOCK:
        if _ENGINE is not None and (owner is None or _ENGINE[1] is owner):
            _ENGINE[2].close()
            _ENGINE = None


@lru_cache(maxsize=2)
def source(code, *, models):
    import numpy as np
    if code not in SUPPORTED:
        raise ValueError("No registered Rasa source for " + str(code))
    value = np.load(model_folder(models) / "references" / code / "source.npy", allow_pickle=False)
    if value.shape != (1, 256, 1) or value.dtype != np.float32 or not np.isfinite(value).all() or not np.any(value):
        raise ValueError("Invalid actual Rasa source identity")
    value.setflags(write=False)
    return value
