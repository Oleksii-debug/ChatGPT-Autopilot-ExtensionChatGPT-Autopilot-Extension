"""Local shared six-layer AfricaTTS carrier for actual reviewed native languages.

Exact FP32 graphs run on the existing private ONNX Runtime. Native pronunciation
is projected separately through the existing selected-voice converter. Readiness
of letters, numbers, native quality, and NVDA is never inferred from file presence.
"""
from collections import OrderedDict
from functools import lru_cache
from hashlib import sha256
import json
from pathlib import Path
from threading import RLock

FORMAT = "dordiai-afri-six-fp32-v1"
REFERENCE_FORMAT = "dordiai-afri-six-reference-v1"
MODEL_REVISION = "d47667a3bb03d0d6db924e789648abd7d55d828b"
CHECKPOINT_SHA256 = "b4cdf2cb62674145fe83ba661041d8180faa543ff9ae1906ae3bb59c9a03171c"
G2P_REVISION = "76b53a8fa2a688812e369837d179d4710c111a7a"
ENCODER_SHA256 = "3dd4918cab90e1acf7fa5c6f7539c27710e7a3cdfba550468c5ea49399178bf7"
SUPPORTED = {"ss": "ssw", "ve": "ven", "zu": "zul", "wo": "wol", "nso": "nso"}
ROLES = ("lm_main", "lm_flow", "encoder", "decoder", "text_conditioner")
RATE = 24000
_LOCK = RLock()
_ENGINE = None


def model_folder(models):
    return Path(models) / "SharedAfriSixONNX"


def _sig(path):
    stat = Path(path).stat()
    return str(path), stat.st_size, stat.st_mtime_ns, getattr(stat, "st_ctime_ns", 0), getattr(stat, "st_ino", 0)


def _digest(path):
    value = sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


@lru_cache(maxsize=32)
def _json(signature):
    path = Path(signature[0])
    if signature[1] > 4 * 1024**2:
        raise ValueError("Oversized native speech resource metadata")
    return json.loads(path.read_text(encoding="utf-8"))


def _config(folder):
    value = _json(_sig(folder / "config.json"))
    if not isinstance(value, dict):
        raise ValueError("Invalid native resource configuration")
    if (value.get("format") != FORMAT or value.get("model_revision") != MODEL_REVISION
            or value.get("source_checkpoint_sha256") != CHECKPOINT_SHA256
            or value.get("g2p_revision") != G2P_REVISION or value.get("sample_rate") != RATE
            or value.get("flow_lm_layers") != 6 or value.get("precision") != "float32"
            or set(value.get("graphs", {})) != set(ROLES)):
        raise ValueError("Native shared model differs from the verified six-layer FP32 checkpoint")
    for role, info in value["graphs"].items():
        if not isinstance(info, dict):
            raise ValueError("Invalid native graph metadata")
        if info.get("filename") != role + ".onnx" or not isinstance(info.get("bytes"), int) or info["bytes"] <= 0:
            raise ValueError("Invalid native graph descriptor")
        if not isinstance(info.get("sha256"), str) or len(info["sha256"]) != 64:
            raise ValueError("Missing immutable native graph digest")
    return value


def carrier_identity(config):
    document = {"checkpoint": CHECKPOINT_SHA256, "g2p_revision": G2P_REVISION,
                "tokenizer_sha256": config["tokenizer_sha256"], "graphs": config["graphs"]}
    return sha256(json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _reference(folder, code):
    if code not in SUPPORTED:
        raise ValueError("No reviewed native AfricaTTS language: " + str(code))
    root = folder / "references" / code
    value = _json(_sig(root / "config.json"))
    if not isinstance(value, dict) or not isinstance(value.get("source_identity"), dict):
        raise ValueError("Invalid native reference/source metadata")
    proof = value["source_identity"]
    if (value.get("format") != REFERENCE_FORMAT or value.get("code") != code
            or value.get("iso_code") != SUPPORTED[code] or value.get("model_revision") != MODEL_REVISION
            or value.get("g2p_revision") != G2P_REVISION
            or proof.get("source_checkpoint_sha256") != CHECKPOINT_SHA256
            or proof.get("reference_encoder_sha256") != ENCODER_SHA256
            or proof.get("calibration_kind") != "actual-same-six-layer-carrier-pcm"
            or proof.get("carrier_identity_sha256") != carrier_identity(_config(folder))):
        raise ValueError("Native reference/source calibration does not match the selected trained language")
    if not isinstance(value.get("files"), dict):
        raise ValueError("Invalid native source file metadata")
    for name in ("reference.wav", "source.npy"):
        entry = value["files"].get(name)
        if not isinstance(entry, dict) or not isinstance(entry.get("bytes"), int) or entry["bytes"] <= 0:
            raise ValueError("Missing prepared native reference/source")
        if (root / name).is_symlink() or (root / name).stat().st_size != entry["bytes"]:
            raise ValueError("Native reference/source size changed")
    if proof.get("native_reference_sha256") != value["files"]["reference.wav"].get("sha256"):
        raise ValueError("Native source calibration used another reference identity")
    return root, value


def _epoch(folder):
    config = _config(folder)
    paths = [folder / "config.json", folder / "tokenizer.json", folder / "NOTICE.txt"]
    paths += [folder / config["graphs"][role]["filename"] for role in ROLES]
    for code in SUPPORTED:
        root = folder / "references" / code
        if (root / "config.json").is_file():
            paths += [root / name for name in ("config.json", "reference.wav", "source.npy", "NOTICE.txt")]
    state = folder.parent.parent / "installed_resource_packs.json"
    if state.is_file():
        paths.append(state)
    return tuple(_sig(path) for path in paths)



def _valid_source(path):
    """Bounded float32 conditioning validation without native imports in NVDA."""
    import ast
    import math
    import struct
    try:
        if Path(path).stat().st_size > 4096:
            return False
        with Path(path).open("rb") as stream:
            if stream.read(6) != b"\x93NUMPY":
                return False
            version = stream.read(2)
            if version == b"\x01\x00":
                amount = struct.unpack("<H", stream.read(2))[0]
            elif version in (b"\x02\x00", b"\x03\x00"):
                amount = struct.unpack("<I", stream.read(4))[0]
            else:
                return False
            if amount > 1024:
                return False
            header = ast.literal_eval(stream.read(amount).decode("latin-1"))
            data = stream.read(1025)
        if (header.get("descr") != "<f4" or header.get("shape") != (1, 256, 1)
                or header.get("fortran_order") or len(data) != 1024):
            return False
        values = struct.unpack("<256f", data)
        return all(math.isfinite(x) for x in values) and any(values)
    except (OSError, ValueError, SyntaxError, struct.error, AttributeError):
        return False


def available(models):
    folder = model_folder(models)
    try:
        config = _config(folder)
        if not (folder / "NOTICE.txt").is_file() or not (folder / "tokenizer.json").is_file():
            return set()
        for info in config["graphs"].values():
            path = folder / info["filename"]
            if path.is_symlink() or not path.is_file() or path.stat().st_size != info["bytes"]:
                return set()
        result = set()
        for code in SUPPORTED:
            try:
                root, value = _reference(folder, code)
                if ((root / "NOTICE.txt").is_file() and _valid_source(root / "source.npy")
                        and _digest(root / "source.npy") == value["files"]["source.npy"]["sha256"]):
                    result.add(code)
            except (OSError, ValueError, KeyError, TypeError):
                pass
        return result
    except (OSError, ValueError, KeyError, TypeError):
        return set()


def _read_wav(path, np):
    import wave
    with wave.open(str(path), "rb") as stream:
        channels, width, rate, frames = stream.getnchannels(), stream.getsampwidth(), stream.getframerate(), stream.getnframes()
        if channels not in (1, 2) or width != 2 or rate != RATE or not 512 <= frames <= RATE * 10:
            raise ValueError("Unsupported prepared native reference WAV")
        raw = stream.readframes(frames)
    if len(raw) != frames * channels * 2:
        raise ValueError("Truncated native reference WAV")
    value = np.frombuffer(raw, "<i2").astype(np.float32) / 32768.
    return value.reshape(-1, channels).mean(axis=1).astype(np.float32)


class AfriSixEngine:
    def __init__(self, directory, owner=None, session_factory=None, threads=2):
        import numpy as np
        self.np, self.folder, self.owner = np, Path(directory), owner
        self.config = _config(self.folder)
        self.epoch = _epoch(self.folder)
        self._closed = False
        self._lock = RLock()
        self._references, self._clips = OrderedDict(), OrderedDict()
        self._clip_bytes = 0
        self._bundle = None
        self._deferred = None
        self.last_facts = None
        if session_factory is None:
            import onnxruntime as ort
            ort.disable_telemetry_events()
            options = ort.SessionOptions()
            options.intra_op_num_threads = max(1, min(4, int(threads)))
            options.inter_op_num_threads = 1
            options.add_session_config_entry("session.intra_op.allow_spinning", "0")
            session_factory = lambda path: ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])
        self.session_factory = session_factory
        if owner is not None:
            from wide_loading import DeferredValue
            self._deferred = DeferredValue(self._open_bundle)

    def _check(self):
        if self._closed:
            raise RuntimeError("Native AfricaTTS carrier is closed")
        if self.owner is not None:
            self.owner.check_cancelled()

    def _open_bundle(self):
        with self._lock:
            if self._closed:
                raise RuntimeError("Native carrier closed before graph construction")
        for role in ROLES:
            path = self.folder / self.config["graphs"][role]["filename"]
            if _digest(path) != self.config["graphs"][role]["sha256"]:
                raise ValueError("Pinned native graph bytes changed: " + role)
        if _digest(self.folder / "tokenizer.json") != self.config["tokenizer_sha256"]:
            raise ValueError("Pinned native tokenizer changed")
        from tokenizers import Tokenizer
        tokenizer = Tokenizer.from_file(str(self.folder / "tokenizer.json"))
        unknown = json.loads((self.folder / "tokenizer.json").read_text(encoding="utf-8")).get("model", {}).get("unk_id")
        sessions = {}
        for role in ROLES:
            with self._lock:
                if self._closed:
                    raise RuntimeError("Native carrier closed during graph construction")
            graph = self.session_factory(self.folder / self.config["graphs"][role]["filename"])
            if self.owner is not None:
                from session_control import GuardedSession
                if not isinstance(graph, GuardedSession):
                    graph = GuardedSession(graph, self.owner)
            sessions[role] = graph
        states = {}
        types = {"tensor(float)": self.np.float32, "tensor(int64)": self.np.int64, "tensor(bool)": self.np.bool_}
        for role, first in (("lm_main", 2), ("decoder", 1)):
            states[role] = [(item.name, tuple(dim if isinstance(dim, int) else 1 for dim in item.shape), types[item.type])
                            for item in sessions[role].get_inputs()[first:]]
        if len(states["lm_main"]) != 12:
            raise ValueError("Native LM must expose cache/offset states for exactly six layers")
        result = (sessions, tokenizer, unknown, states)
        with self._lock:
            if self._closed or self.epoch != _epoch(self.folder):
                raise RuntimeError("Native resources changed during graph construction")
        return result

    def _ready(self):
        self._check()
        if self.epoch != _epoch(self.folder):
            self.close()
            raise RuntimeError("Native resources changed; reopen the selected language")
        if self._bundle is None:
            bundle = self._deferred.get(self.owner) if self._deferred is not None else self._open_bundle()
            with self._lock:
                self._check()
                self._bundle = bundle
        self._check()
        return self._bundle

    def _voice(self, code, sessions):
        np = self.np
        root, proof = _reference(self.folder, code)
        key = (code, _sig(root / "reference.wav"), _sig(root / "source.npy"), _sig(root / "config.json"))
        if key in self._references:
            self._references.move_to_end(key)
            return self._references[key]
        for name in ("reference.wav", "source.npy"):
            if _digest(root / name) != proof["files"][name]["sha256"]:
                raise ValueError("Native reference/source bytes changed")
        wave = _read_wav(root / "reference.wav", np)
        voice = sessions["encoder"].run(None, {"audio": wave[None, None]})[0]
        if voice.ndim != 3 or voice.shape[0] != 1 or voice.shape[2] != 1024 or not np.isfinite(voice).all():
            raise ValueError("Invalid native prompt conditioning")
        voice.setflags(write=False)
        self._references[key] = voice
        while len(self._references) > len(SUPPORTED):
            self._references.popitem(last=False)
        return voice

    def audio(self, code, text, character=False, rate=1.0):
        from wide_afri_frontend import phonemes
        if code not in SUPPORTED:
            raise ValueError("AfricaTTS has no reviewed native language " + str(code))
        self._check()
        if character:
            from character_names import spoken_name
            text = spoken_name(code, text, directory=self.folder.parent / "CharacterNames")
        if any(char.isdecimal() for char in text):
            from wide_numbers import spell_numbers
            text = spell_numbers(code, text)
        ipa = phonemes(code, text)
        sessions, tokenizer, unknown, specs = self._ready()
        np = self.np
        key = (code, text, bool(character))
        if key in self._clips:
            self._clips.move_to_end(key)
            self.last_facts = dict(self._clips[key][1], native_clip_reused=True)
            return self._clips[key][0]
        ids = tokenizer.encode(ipa).ids
        if not ids or len(ids) > 256 or unknown is not None and unknown in ids:
            raise ValueError("Native IPA contains unsupported units or needs a shorter utterance")
        voice = self._voice(code, sessions)
        embedding = sessions["text_conditioner"].run(None, {"token_ids": np.asarray([ids], np.int64)})[0]
        state = {name: np.zeros(shape, dtype) for name, shape, dtype in specs["lm_main"]}
        empty_seq, empty_txt = np.zeros((1, 0, 32), np.float32), np.zeros((1, 0, 1024), np.float32)

        def main(sequence, text_embedding):
            self._check()
            outputs = sessions["lm_main"].run(None, {"sequence": sequence, "text_embeddings": text_embedding, **state})
            if len(outputs) != len(state) + 2:
                raise ValueError("Unexpected native LM state contract")
            for name, value in zip(list(state), outputs[2:]):
                state[name] = value
            return outputs[0], outputs[1]

        main(empty_seq, voice)
        main(empty_seq, embedding)
        previous = np.full((1, 1, 32), np.nan, np.float32)
        rng = np.random.default_rng(42)
        latent, eos_step, completed = [], None, False
        for step in range(500):
            self._check()
            condition, eos = main(previous, empty_txt)
            if eos_step is None and float(eos.reshape(-1)[0]) > -4.:
                eos_step = step
            if eos_step is not None and eos_step > 0 and step >= eos_step + 3:
                completed = True
                break
            noise = rng.normal(0., np.sqrt(.3), (1, 32)).astype(np.float32)
            direction = sessions["lm_flow"].run(None, {"c": condition, "s": np.zeros((1, 1), np.float32),
                                                       "t": np.ones((1, 1), np.float32), "x": noise})[0]
            current = noise + direction
            if not np.isfinite(current).all():
                raise ValueError("Nonfinite native latent")
            latent.append(current[0])
            previous = current[:, None]
        state.clear()
        if not completed or not latent:
            raise ValueError("Native utterance did not finish inside the prepared generation budget")
        latents = np.asarray(latent, np.float32)[None]
        state = {name: np.zeros(shape, dtype) for name, shape, dtype in specs["decoder"]}
        clips = []
        for start in range(0, latents.shape[1], 15):
            self._check()
            outputs = sessions["decoder"].run(None, {"latent": latents[:, start:start + 15], **state})
            if len(outputs) != len(state) + 1:
                raise ValueError("Unexpected native decoder state contract")
            for name, value in zip(list(state), outputs[1:]):
                state[name] = value
            clips.append(outputs[0].reshape(-1))
        wave = np.concatenate(clips).astype(np.float32)
        self._check()
        if self.epoch != _epoch(self.folder):
            self.close()
            raise RuntimeError("Native resources changed during speech; discard the result")
        if len(wave) < 32 or not np.isfinite(wave).all() or np.max(np.abs(wave)) < 1e-7:
            raise ValueError("Native carrier returned invalid or silent PCM")
        wave.setflags(write=False)
        self.last_facts = {"code": code, "iso_code": SUPPORTED[code], "backend": "afri-six-onnx",
                           "model_revision": MODEL_REVISION, "native_clip_reused": False,
                           "latent_frames": len(latent), "source_reference_shared_across_languages": False,
                           "sample_rate": RATE, "native_speed_applied": False}
        if len(wave) <= RATE * 2:
            self._clips[key] = (wave, dict(self.last_facts))
            self._clip_bytes += wave.nbytes
            while len(self._clips) > 32 or self._clip_bytes > 12 * 1024**2:
                _, old = self._clips.popitem(last=False)
                self._clip_bytes -= old[0].nbytes
        return wave

    def close(self):
        with self._lock:
            self._closed = True
            self._bundle = None
            self._deferred = None
            self._references.clear()
            self._clips.clear()
            self._clip_bytes = 0


def audio(code, text, character=False, *, models, rate=1.0, owner=None, session_factory=None):
    global _ENGINE
    folder = model_folder(models)
    epoch = _epoch(folder)
    key = (str(folder.resolve()), epoch)
    with _LOCK:
        if _ENGINE is None or _ENGINE[0] != key or _ENGINE[1] is not owner:
            if _ENGINE is not None:
                _ENGINE[2].close()
            _ENGINE = (key, owner, AfriSixEngine(folder, owner=owner, session_factory=session_factory))
        engine = _ENGINE[2]
    return engine.audio(code, text, character, rate), RATE


def clear_engines(owner=None):
    global _ENGINE
    with _LOCK:
        if _ENGINE is not None and (owner is None or _ENGINE[1] is owner):
            _ENGINE[2].close()
            _ENGINE = None
    _source_snapshot.cache_clear()


@lru_cache(maxsize=8)
def _source_snapshot(path, signature, metadata_signature):
    import numpy as np
    value = np.load(path, allow_pickle=False)
    if value.shape != (1, 256, 1) or value.dtype != np.float32 or not np.isfinite(value).all() or not np.any(value):
        raise ValueError("Invalid actual native source identity")
    value.setflags(write=False)
    return value


def source(code, *, models):
    folder = model_folder(models)
    root, config = _reference(folder, code)
    path = root / "source.npy"
    if _digest(path) != config["files"]["source.npy"]["sha256"]:
        raise ValueError("Native source identity changed since calibration")
    return _source_snapshot(str(path), _sig(path), _sig(root / "config.json"))
