"""Guarded CPU MMS graph reuse with exact original float32 weight mappings.

Only the 29 audited models qualify. A malformed, missing or unsupported shared
resource falls back before synthesis to the original same-language model.
Cancellation, memory exhaustion, stale resources and inference errors propagate.
No original model is rewritten, quantized or truncated.
"""
from functools import lru_cache
from hashlib import sha256
import errno
import json
import math
import os
from pathlib import Path
import stat
import sys
from threading import RLock
import weakref

DEFAULT_ENABLED = False  # Enabled only after managed Windows replacement proof.
ENVIRONMENT_OPTION = "DORDIAI_MMS_SHARED_GRAPH"
ASSETS = Path(__file__).with_name("models") / "MMSShared"
INDEX_SIZE = 144600
INDEX_SHA256 = "919ff7937a8f3f61506bd01c374b4368cd310697a4c68a4dc8a773384230af73"
GRAPH_SIZE = 927175
GRAPH_SHA256 = "d883f15134dafb68b33acf514deac3c87c2684632fed992a8857570d12db7ec6"
EMBEDDING = "model.enc_p.emb.weight"
INPUTS = frozenset({"x", "x_length", "noise_scale", "length_scale", "noise_scale_w"})
CODES = frozenset({"ay", "fil", "km", "tg", "lo", "mai", "doi", "dv", "dz", "ha", "yo", "ff", "mg",
                   "so", "sn", "rw", "rn", "ny", "ak", "bm", "dyu", "mos", "kab", "ts", "sg", "tpi", "sm", "fj", "gil"})
_POOL_LOCK = RLock()
_POOL = weakref.WeakValueDictionary()
_VERIFIED_LOCK = RLock()
_VERIFIED = {}


class InvalidSharedMMS(ValueError):
    """A shared candidate is unsupported; original-model setup may proceed."""


class MMSResourceChanged(RuntimeError):
    """An existing carrier belongs to an old package epoch; recreate the worker."""


class MMSLanguageMismatch(ValueError):
    """A different audited language's weights must never be used as fallback."""


def enabled():
    value = os.environ.get(ENVIRONMENT_OPTION, "").strip().lower()
    if value in {"0", "false", "off", "no"}:
        return False
    if value in {"1", "true", "on", "yes"}:
        return True
    return DEFAULT_ENABLED


def _stat_key(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def signature(path):
    try:
        return _stat_key(Path(path).stat())
    except OSError:
        return None


def _epoch(model, assets):
    # Keep logical package-root paths: resolving a model symlink first could
    # lose the installed-resource index belonging to the active runtime.
    runtime = model.parent.parent.parent.parent
    paths = (runtime / "installed_resource_packs.json", runtime.parent / "manifest.ini",
             assets / "index.json", assets / "graph.onnx")
    return tuple((str(path.absolute()), signature(path)) for path in paths)


def resource_identity(folder):
    folder = Path(folder).absolute()
    model = folder / "model.onnx"
    paths = (model, folder / "config.json", folder / "tokens.txt", folder / "source.npy")
    return tuple((str(path), signature(path)) for path in paths) + _epoch(model, ASSETS)


def assert_resources(identity):
    if any(signature(Path(path)) != saved for path, saved in identity):
        raise MMSResourceChanged("Native MMS frontend/model resources changed; recreate the carrier")


def _assert_current(model, original_signature, epoch):
    if signature(model) != original_signature or any(signature(Path(path)) != saved for path, saved in epoch):
        raise MMSResourceChanged("Native MMS resources changed; the old carrier cannot be reused")


def _hash_stream(stream):
    stream.seek(0)
    value = sha256()
    for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
        value.update(block)
    return value.hexdigest()


def _read_pinned(path, size, expected):
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size != size:
            raise InvalidSharedMMS("Shared MMS asset size/type differs")
        data = stream.read(size + 1)
        after = os.fstat(stream.fileno())
    identity = _stat_key(before)
    if identity != _stat_key(after) or signature(path) != identity:
        raise MMSResourceChanged("Shared MMS asset changed during validation")
    if len(data) != size or sha256(data).hexdigest() != expected:
        raise InvalidSharedMMS("Shared MMS asset digest differs")
    return data


@lru_cache(maxsize=4)
def _index(path_string, identity):
    path = Path(path_string)
    try:
        document = json.loads(_read_pinned(path, INDEX_SIZE, INDEX_SHA256).decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise InvalidSharedMMS("Malformed shared MMS descriptor") from error
    if (not isinstance(document, dict) or document.get("format") != "dordiai-mms-family-weights-v1"
            or document.get("float_dtype") != "<f4" or not isinstance(document.get("models"), dict)
            or set(document["models"]) != CODES
            or document.get("graph") != {"name": "graph.onnx", "bytes": GRAPH_SIZE, "sha256": GRAPH_SHA256}):
        raise InvalidSharedMMS("Unsupported shared MMS descriptor format")
    schema = document.get("weights")
    if not isinstance(schema, list) or len(schema) != 460:
        raise InvalidSharedMMS("Unexpected shared MMS initializer count")
    names = set()
    for row in schema:
        if not isinstance(row, list) or len(row) != 2 or not isinstance(row[0], str) or row[0] in names:
            raise InvalidSharedMMS("Invalid shared MMS initializer names")
        name, shape = row
        names.add(name)
        if name == EMBEDDING:
            if shape != [None, 192]:
                raise InvalidSharedMMS("Invalid shared MMS native embedding")
        elif (not isinstance(shape, list) or any(type(x) is not int or not 0 < x <= 4096 for x in shape)
              or math.prod(shape) * 4 > 64 * 1024 * 1024):
            raise InvalidSharedMMS("Invalid shared MMS initializer shape")
    if EMBEDDING not in names or names.intersection(INPUTS):
        raise InvalidSharedMMS("Invalid shared MMS weight/input namespace")
    for row in document["models"].values():
        if (not isinstance(row, dict) or type(row.get("bytes")) is not int or not 100000000 <= row["bytes"] <= 150000000
                or not isinstance(row.get("sha256"), str) or len(row["sha256"]) != 64
                or type(row.get("vocab_rows")) is not int or not 1 <= row["vocab_rows"] <= 4096
                or not isinstance(row.get("offsets"), list) or len(row["offsets"]) != len(schema)
                or any(type(offset) is not int or not 0 <= offset < row["bytes"] for offset in row["offsets"])):
            raise InvalidSharedMMS("Invalid shared MMS per-language descriptor")
    return document


def _varint(buffer, position, end):
    value = 0
    for shift in range(0, 70, 7):
        if position >= end:
            raise InvalidSharedMMS("Truncated MMS protobuf varint")
        byte = int(buffer[position])
        position += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, position
    raise InvalidSharedMMS("Invalid MMS protobuf varint")


def _fields(buffer, start, end):
    position = start
    while position < end:
        tag, position = _varint(buffer, position, end)
        number, kind = tag >> 3, tag & 7
        if number == 0:
            raise InvalidSharedMMS("Invalid MMS protobuf field")
        if kind == 0:
            value, position = _varint(buffer, position, end)
            yield number, kind, value, position
            continue
        if kind == 2:
            size, position = _varint(buffer, position, end)
        elif kind in (1, 5):
            size = 8 if kind == 1 else 4
        else:
            raise InvalidSharedMMS("Unsupported MMS protobuf wire type")
        stop = position + size
        if stop > end:
            raise InvalidSharedMMS("MMS protobuf field exceeds its file")
        yield number, kind, position, stop
        position = stop


def _offsets(buffer):
    graphs = [(low, high) for field, wire, low, high in _fields(buffer, 0, len(buffer)) if field == 7 and wire == 2]
    if len(graphs) != 1:
        raise InvalidSharedMMS("Expected one native MMS graph")
    result = []
    for field, wire, start, end in _fields(buffer, *graphs[0]):
        if field != 5 or wire != 2:
            continue
        name, shape, dtype, raw = None, [], None, None
        for field, wire, low, high in _fields(buffer, start, end):
            if field == 1:
                if wire == 0:
                    shape.append(low)
                elif wire == 2:
                    while low < high:
                        dimension, low = _varint(buffer, low, high)
                        shape.append(dimension)
            elif field == 2 and wire == 0:
                dtype = low
            elif field == 8 and wire == 2:
                name = bytes(buffer[low:high]).decode("utf-8")
            elif field == 9 and wire == 2:
                raw = low, high - low
        if name is None or dtype != 1 or raw is None or any(not 0 < x <= 4096 for x in shape) or raw[1] != math.prod(shape) * 4:
            raise InvalidSharedMMS("Unsupported raw MMS initializer representation")
        result.append((name, shape, raw[0], raw[1]))
    return result


def _open_weights(model, entry, schema, epoch, code, known_models):
    import numpy as np
    # Every operation uses this same opened file, including its mmap. A path
    # replacement cannot switch weights between hash validation and mapping.
    with model.open("rb") as stream:
        before = os.fstat(stream.fileno())
        identity = _stat_key(before)
        if not stat.S_ISREG(before.st_mode):
            raise InvalidSharedMMS("Native MMS model size/type differs")
        def check_language(actual_hash):
            if any(name != code and value["sha256"] == actual_hash for name, value in known_models.items()):
                raise MMSLanguageMismatch("Native MMS model belongs to another audited language")
        if before.st_size != entry["bytes"]:
            if 0 < before.st_size <= 150000000:
                check_language(_hash_stream(stream))
            raise InvalidSharedMMS("Native MMS model size/type differs")
        key = (str(model.absolute()), identity, entry["sha256"], epoch)
        with _VERIFIED_LOCK:
            verified = key in _VERIFIED
        if not verified:
            actual_hash = _hash_stream(stream)
            if actual_hash != entry["sha256"]:
                check_language(actual_hash)
                raise InvalidSharedMMS("Native MMS model is outside the audited family")
        mapping = np.memmap(stream, dtype=np.uint8, mode="r", offset=0, shape=(entry["bytes"],))
        actual = _offsets(mapping)
        if len(actual) != len(schema):
            raise InvalidSharedMMS("Native MMS initializer count differs")
        weights = {}
        for position, ((name, expected_shape), row) in enumerate(zip(schema, actual)):
            shape = [entry["vocab_rows"], 192] if name == EMBEDDING else expected_shape
            actual_name, actual_shape, offset, length = row
            if (actual_name != name or actual_shape != shape or offset != entry["offsets"][position]
                    or length != math.prod(shape) * 4 or offset + length > before.st_size):
                raise InvalidSharedMMS("Native MMS TensorProto descriptor differs")
            view = np.ndarray(shape, dtype="<f4", buffer=mapping, offset=offset)
            view.setflags(write=False)
            weights[name] = view
        if _stat_key(os.fstat(stream.fileno())) != identity:
            raise MMSResourceChanged("Native MMS model changed during validation")
        _assert_current(model, identity, epoch)
        with _VERIFIED_LOCK:
            _VERIFIED[key] = True
            while len(_VERIFIED) > 64:
                _VERIFIED.pop(next(iter(_VERIFIED)))
    return mapping, weights, identity


def _factory_identity(factory):
    if factory is None:
        return ("default-cpu", 2), ()
    owner, function = getattr(factory, "__self__", None), getattr(factory, "__func__", None)
    objects = (owner, function) if owner is not None and function is not None else (factory,)
    try:
        references = tuple(weakref.ref(value) for value in objects)
    except TypeError:
        # An unusual non-weak-referenceable callable is safe but not pooled.
        return ("unpooled", object()), ()
    threads = getattr(owner, "threads", None)
    threads = threads if type(threads) is int else None
    return ("factory", tuple(id(value) for value in objects), threads), references


class _Family:
    def __init__(self, raw, references):
        self.raw, self.references = raw, references
    def matches(self, references):
        return len(self.references) == len(references) and all(saved() is current() and saved() is not None
            for saved, current in zip(self.references, references))


def _default_session(path):
    import onnxruntime as ort
    ort.disable_telemetry_events()
    options = ort.SessionOptions()
    options.intra_op_num_threads, options.inter_op_num_threads = 2, 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    return ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])


def _family(model, assets, epoch, shared_epoch, identity, schema, factory):
    factory_key, references = _factory_identity(factory)
    key = (str(assets.absolute()), shared_epoch, factory_key)
    with _POOL_LOCK:
        current = _POOL.get(key)
        if current is not None and current.matches(references):
            _assert_current(model, identity, epoch)
            return current
        graph_path = assets / "graph.onnx"
        _read_pinned(graph_path, GRAPH_SIZE, GRAPH_SHA256)
        opened = _default_session(graph_path) if factory is None else factory(graph_path)
        # The reusable object must never retain another request owner's guard.
        from session_control import GuardedSession
        while isinstance(opened, GuardedSession):
            opened = opened.session
        _assert_current(model, identity, epoch)
        if any(not callable(getattr(opened, name, None)) for name in ("get_providers", "get_inputs", "get_modelmeta", "run")):
            raise InvalidSharedMMS("Factory does not expose a reusable raw ORT session")
        if list(opened.get_providers()) != ["CPUExecutionProvider"]:
            raise InvalidSharedMMS("Dynamic MMS weight sharing is CPU-only")
        inputs = {item.name: item for item in opened.get_inputs()}
        if set(inputs) != INPUTS | {row[0] for row in schema}:
            raise InvalidSharedMMS("Shared MMS graph input names differ")
        for name, shape in schema:
            expected = ["native_vocab_rows", 192] if name == EMBEDDING else shape
            if inputs[name].type != "tensor(float)" or list(inputs[name].shape) != expected:
                raise InvalidSharedMMS("Shared MMS graph weight shape/type differs")
        metadata = opened.get_modelmeta().custom_metadata_map
        if metadata.get("comment") != "mms" or metadata.get("sample_rate") != "16000" or metadata.get("frontend") != "characters":
            raise InvalidSharedMMS("Shared MMS graph metadata differs")
        current = _Family(opened, references)
        _assert_current(model, identity, epoch)
        _POOL[key] = current
        return current


class SharedMMSView:
    """A language-owned weight snapshot on an owner-free shared ORT graph."""
    shared_exact_weights = True
    def __init__(self, family, model, identity, epoch, mapping, weights, vocab_rows):
        self.family, self.model, self.identity, self.epoch = family, model, identity, epoch
        self.mapping, self.weights, self.vocab_rows = mapping, weights, vocab_rows
    def get_inputs(self):
        return [item for item in self.family.raw.get_inputs() if item.name in INPUTS]
    def get_outputs(self):
        return self.family.raw.get_outputs()
    def get_modelmeta(self):
        return self.family.raw.get_modelmeta()
    def get_providers(self):
        return self.family.raw.get_providers()
    def run(self, output_names, input_feed, run_options=None):
        import numpy as np
        # Keep all objects alive until this exact native call finishes. Neither
        # eviction nor another carrier may close their backing file mapping.
        family, mapping, weights = self.family, self.mapping, self.weights
        _assert_current(self.model, self.identity, self.epoch)
        if set(input_feed) != INPUTS:
            raise InvalidSharedMMS("Unexpected native MMS request inputs")
        x = input_feed["x"]
        if (not isinstance(x, np.ndarray) or x.dtype != np.int64 or x.ndim != 2 or not x.size
                or int(x.min()) < 0 or int(x.max()) >= self.vocab_rows):
            raise InvalidSharedMMS("Native token IDs exceed this language's actual vocabulary")
        # Preserve the caller's stochastic scale values and its own RunOptions.
        # A shared invocation never changes another owner's cancellation state.
        result = family.raw.run(output_names, weights | input_feed, run_options)
        _assert_current(self.model, self.identity, self.epoch)
        return result


def _fallback_error(error):
    if isinstance(error, InvalidSharedMMS):
        return True
    if isinstance(error, OSError):
        if error.errno == errno.ENOMEM or getattr(error, "winerror", None) in {8, 14, 1455}:
            return False
        return error.errno in {errno.ENOENT, errno.ENOTDIR, errno.EACCES, errno.EPERM,
                               errno.EINVAL, errno.ENODEV, errno.ENOSYS, errno.ENOTSUP}
    return type(error).__module__.startswith("onnxruntime.") and type(error).__name__ in {
        "InvalidGraph", "InvalidArgument", "InvalidProtobuf", "NoSuchFile", "NotImplemented"}


def for_language(model, code, factory=None, *, assets=None):
    """Return a guarded eligible view, or None to open the original model.

Only setup validation/unsupported resources fall back. There is no fallback
inside run(): cancellation or failed inference cannot duplicate synthesis.
"""
    if not enabled() or sys.byteorder != "little" or code not in CODES:
        return None
    model = Path(model).absolute()
    assets = ASSETS if assets is None else Path(assets).absolute()
    if model.name != "model.onnx" or model.parent.name != code:
        raise InvalidSharedMMS("Native MMS folder and selected language disagree")
    shared_epoch = _epoch(model, assets)
    epoch = shared_epoch + tuple((str(model.parent / name), signature(model.parent / name))
                                for name in ("config.json", "tokens.txt", "source.npy"))
    try:
        index_path = assets / "index.json"
        descriptor = _index(str(index_path), signature(index_path))
        entry = descriptor["models"][code]
        mapping, weights, identity = _open_weights(model, entry, descriptor["weights"], epoch, code, descriptor["models"])
        family = _family(model, assets, epoch, shared_epoch, identity, descriptor["weights"], factory)
        _assert_current(model, identity, epoch)
        return SharedMMSView(family, model, identity, epoch, mapping, weights, entry["vocab_rows"])
    except Exception as error:
        if _fallback_error(error):
            return None
        raise
