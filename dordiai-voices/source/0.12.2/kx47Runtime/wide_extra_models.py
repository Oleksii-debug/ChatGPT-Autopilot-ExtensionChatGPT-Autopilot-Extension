"""Additional pinned ONNX carriers, separate from the original audited resources.

Santali uses its required Ol Chiki phonemizer, never an unrelated eSpeak voice.
A validated source identity is required before advertising conversion to the
user-selected voice. Native inference can be probed separately during preparation.
"""
from functools import lru_cache
import json
from pathlib import Path
import re
import unicodedata

AVAILABLE = {"sat"}


def folder(code, models):
    if code != "sat":
        raise KeyError(code)
    return Path(models) / "ExtraLanguages" / "sat"


def available(models, require_source=True):
    result = set()
    for code in AVAILABLE:
        root = folder(code, models)
        required = ("model.onnx", "config.json") + (("source.npy",) if require_source else ())
        if all((root / name).is_file() for name in required):
            result.add(code)
    return result


def phoneme_ids(text, config):
    from santali_phonemizer import santali_to_phonemes
    text = re.sub(r"\s+", " ", unicodedata.normalize("NFC", str(text))).strip()
    if not text:
        return []
    mapping = config["phoneme_id_map"]
    sequence = list(mapping["^"])
    for token in santali_to_phonemes(text):
        if token not in mapping:
            raise ValueError("Unsupported Santali input token: " + repr(token))
        sequence.extend(mapping[token])
        sequence.extend(mapping["_"])
    sequence.extend(mapping["$"])
    return sequence


class NativeSantali:
    def __init__(self, directory, session_factory=None, owner=None, threads=2):
        import numpy as np
        self.np = np
        self.folder = Path(directory)
        self.owner = owner
        self.config = json.loads((self.folder / "config.json").read_text(encoding="utf-8"))
        self.rate = int(self.config["audio"]["sample_rate"])
        if session_factory is None:
            import onnxruntime as ort
            options = ort.SessionOptions()
            options.intra_op_num_threads = max(1, int(threads))
            options.inter_op_num_threads = 1
            options.add_session_config_entry("session.intra_op.allow_spinning", "0")
            session_factory = lambda path: ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
        if owner is None:
            self.session = session_factory(self.folder / "model.onnx")
        else:
            from wide_loading import DeferredSession
            self.session = DeferredSession(lambda: session_factory(self.folder / "model.onnx"), owner)

    def audio(self, text, character=False, rate=1.0):
        if character:
            raise ValueError("Native Santali symbol names need a validated navigation/letter resource; phonemes are not letter names")
        if self.owner is not None:
            self.owner.check_cancelled()
        sequence = phoneme_ids(text, self.config)
        np = self.np
        if not sequence:
            return np.empty(0, dtype=np.float32)
        if len(sequence) > 4096:
            raise ValueError("Santali text must be split into shorter utterances")
        ids = np.asarray([sequence], dtype=np.int64)
        inference = self.config["inference"]
        speed = min(2.5, max(.5, float(rate)))
        feed = {
            "input": ids,
            "input_lengths": np.asarray([ids.shape[1]], dtype=np.int64),
            "scales": np.asarray([inference["noise_scale"], inference["length_scale"] / speed, inference["noise_w"]], dtype=np.float32),
            "sid": np.asarray([0], dtype=np.int64),
        }
        output = self.session.run(None, feed)[0].reshape(-1).astype(np.float32, copy=False)
        if self.owner is not None:
            self.owner.check_cancelled()
        if not output.size or not np.isfinite(output).all():
            raise ValueError("Santali model returned invalid audio")
        return output


@lru_cache(maxsize=2)
def _engine(code, models, owner=None):
    return NativeSantali(folder(code, models), owner=owner)


def audio(code, text, character=False, *, models, rate=1.0, owner=None):
    engine = _engine(code, str(Path(models).resolve()), owner)
    return engine.audio(text, character, rate), engine.rate


@lru_cache(maxsize=2)
def source(code, *, models):
    import numpy as np
    value = np.load(folder(code, models) / "source.npy", allow_pickle=False)
    if value.shape != (1, 256, 1) or value.dtype != np.float32 or not np.isfinite(value).all():
        raise ValueError("Invalid additional language source identity")
    value.setflags(write=False)
    return value
