"""Pinned single-speaker Coqui/VITS native grapheme carriers (Igbo/Lingala).

Uses the export's actual ID map, blank token, punctuation and sample rate.
Speaker identity conversion is applied separately by WideVoices.
"""
import json
from pathlib import Path
import re
from threading import RLock
import unicodedata
import weakref

from wide_mms import MMSCarrier, MMSFrontend, MODEL_FORMAT, prepared_character_name

SUPPORTED = frozenset({"ig", "ln", "nd"})


class CoquiFrontend:
    def __init__(self, config):
        self.config = config
        code = config.get("lang_code")
        if (config.get("engine") != "coqui" or config.get("phoneme_type") != "graphemes"
                or code not in SUPPORTED or config.get("use_eos_bos")
                or int(config.get("num_speakers", 1)) != 1 or int(config.get("num_langs", 1)) != 1):
            raise ValueError("Unsupported native Coqui checkpoint/tokenizer")
        tokens = config["phoneme_id_map"]
        if (not isinstance(tokens, dict) or any(not isinstance(key, str) or not isinstance(value, int) or value < 0
                                                for key, value in tokens.items())):
            raise ValueError("Invalid native Coqui vocabulary")
        if not config.get("blank_at_start", True) or not config.get("blank_at_end", True):
            raise ValueError("Unsupported Coqui boundary blank policy")
        blank = tokens[config["blank"]]
        derived = {"format": MODEL_FORMAT, "frontend": "characters", "code": code, "is_uroman": False,
                   "blank_id": blank, "add_blank": bool(config.get("add_blank_char", True)), "lowercase": True,
                   "navigation": config.get("navigation", {})}
        self.native = MMSFrontend(derived, tokens)

    def normalized(self, text):
        text = unicodedata.normalize("NFC", str(text)).replace("’", "'")
        if self.config.get("fold_compounds"):
            text = re.sub(r"(?<=\w)-(?=\w)", " ", text)
            text = re.sub(r"(?<!\w)'(?=\w)", "", text)
            text = text.replace('"', '').replace('(', '').replace(')', '')
            if text.endswith("..."):
                text = text[:-3]
        return text

    def ids(self, text, character=False):
        return self.native.ids(self.normalized(text), character)


class NativeCoqui(MMSCarrier):
    def __init__(self, directory, session_factory=None, owner=None):
        self.folder = Path(directory)
        self.config = json.loads((self.folder / "config.json").read_text(encoding="utf8"))
        self.code = self.config.get("lang_code")
        runtime = json.loads((self.folder / "runtime_config.json").read_text(encoding="utf8"))
        if (runtime.get("format") != "dordiai-coqui-onnx-v1" or runtime.get("code") != self.code
                or runtime.get("iso_code") != {"ig": "ibo", "ln": "lin", "nd": "nde"}.get(self.code)
                or runtime.get("sample_rate") != self.config["audio"]["sample_rate"]):
            raise ValueError("Native Coqui model does not match its prepared language standard")
        self.frontend = CoquiFrontend(self.config)
        self.rate = self.sample_rate = int(self.config["audio"]["sample_rate"])
        if not 8000 <= self.rate <= 48000:
            raise ValueError("Invalid native Coqui sample rate")
        self.session_factory, self.owner = session_factory, owner
        self._graph = self._inputs = None
        self._closed = False
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
        with self._lock:
            if self._closed:
                return None
        if self.session_factory is None:
            import onnxruntime as ort
            ort.disable_telemetry_events()
            options = ort.SessionOptions()
            options.intra_op_num_threads = 2
            options.inter_op_num_threads = 1
            options.add_session_config_entry("session.intra_op.allow_spinning", "0")
            graph = ort.InferenceSession(str(self.folder / "model.onnx"), sess_options=options,
                                        providers=["CPUExecutionProvider"])
        else:
            graph = self.session_factory(self.folder / "model.onnx")
        if self.owner is not None:
            from session_control import GuardedSession
            if not isinstance(graph, GuardedSession):
                graph = GuardedSession(graph, self.owner)
        inputs = {entry.name: entry for entry in graph.get_inputs()}
        if (set(inputs) != {"input", "input_lengths", "scales"}
                or inputs["input"].type != "tensor(int64)" or inputs["scales"].type != "tensor(float)"):
            raise ValueError("Unexpected native Coqui ONNX graph inputs: " + str(tuple(inputs)))
        with self._lock:
            if self._closed:
                return None
            self._graph, self._inputs = graph, inputs
        return graph

    def audio(self, text, character=False, rate=1., *, noise_scale=None, noise_scale_w=None):
        import numpy as np
        if self.owner is not None:
            self.owner.check_cancelled()
        if character and not any(char.isdecimal() for char in text) and not self.config.get("navigation"):
            text = prepared_character_name(self.code, text, self.folder.parent.parent)
            character = False
        if any(char.isdecimal() for char in text) and not self.config.get("navigation", {}).get("digits"):
            from wide_numbers import spell_numbers
            expanded = spell_numbers(self.code, text)
            if character and len(text) == 1 and text.isdecimal() and expanded != text:
                text, character = expanded, False
            else:
                text = expanded
        ids = self.frontend.ids(text, character)
        if len(ids) > 4096:
            raise ValueError("Native Coqui request must be split into shorter text")
        speed = min(2.5, max(.5, float(rate)))
        inference = self.config.get("inference", {})
        noise = float(inference.get("noise_scale", .667) if noise_scale is None else noise_scale)
        duration_noise = float(inference.get("noise_w", .8) if noise_scale_w is None else noise_scale_w)
        if not 0. <= noise <= 1.5 or not 0. <= duration_noise <= 1.5:
            raise ValueError("Invalid native Coqui noise scale")
        feed = {"input": np.asarray([ids], np.int64), "input_lengths": np.asarray([len(ids)], np.int64),
                "scales": np.asarray([noise, 1. / speed, duration_noise], np.float32)}
        wave = np.asarray(self.preload().run(None, feed)[0], np.float32).reshape(-1)
        if self.owner is not None:
            self.owner.check_cancelled()
        if len(wave) < 32 or not np.isfinite(wave).all() or np.max(np.abs(wave)) < 1e-7:
            raise ValueError("Native Coqui checkpoint returned invalid or silent audio")
        return wave
