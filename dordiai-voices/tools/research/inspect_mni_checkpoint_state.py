#!/usr/bin/env python3
"""Isolated official Manipuri checkpoint state audit; never execute TTS/inference.

Acquire first, then deny network before importing CPU Torch. weights_only=True is
mandatory with no allowlist/pickle fallback. This is not model quality evidence.
"""
from __future__ import annotations
import argparse
from collections import Counter
import ctypes
import errno
import gc
from hashlib import sha1, sha256
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
import zipfile

HERE = Path(__file__).resolve().parent
HELPER_BLOB = "4deb51022762dcf04ce730ca715937a60c058b52"
ARCHIVE_SHA256 = "f689abf7d7398b99b40e589350beae6ceee62bdde880eb8c217b2d076e6683e5"
ARCHIVE_SIZE = 1518195233
FILES = {
 "mni/fastpitch/best_model.pth": (637534809, "562a1762314ed4f5507bf8ad9ae289f0eed1eadea6637da4ba464ce5b498cada"),
 "mni/fastpitch/config.json": (7187, "53d00ea2e6ef1fd19ecc2a1739be23d091e4d8b7f4af3ec06332e9de6c106acf"),
 "mni/fastpitch/speakers.pth": (431, "f665e358b34b232fb27f7c8cd3968fcd47784a7be065ae127f611c33ee809bea"),
 "mni/hifigan/best_model.pth": (1016366844, "1ff283526aa765ce54e31c3597850a2012a45275b1ebdbd2b9d2be8da31f61b8"),
 "mni/hifigan/config.json": (4601, "1e3270337e3545d6b99aa38b75b3772cd90db7dbc7fbc051a0c5bb72c917e975"),
}
COQUI_REPOSITORY = "gokulkarthik/TTS"
COQUI_REVISION = "42155940b5d0c4c78a554af04472925ddd326887"
COQUI_FILES = {
 "LICENSE.txt": "14e2f777f6c395e7e04ab4aa306bbcc4b0c1120e",
 "TTS/utils/io.py": "0b32f77ab281073c399cc0aabe86670ff8f90969",
 "TTS/tts/utils/speakers.py": "77b61a8d11e5f981cb1d56720df3f597742e3614",
 "TTS/tts/models/forward_tts.py": "a6568a49627f8479a1122056d8f802275dc174ab",
 "TTS/tts/configs/fast_pitch_config.py": "26ccfdd54037a63c4d5d638109cd30524f8f22ca",
 "TTS/vocoder/models/hifigan_generator.py": "fc15f3af1033470990001cc5106dfe08c2930749",
 "TTS/vocoder/models/gan.py": "a3803f7714aa5c537c3de334bf9ba81496169502",
}
MAX_NODES = 300000
MAX_DEPTH = 32
MAX_REPORT = 32 * 1024**2


def helper():
    path = HERE / "acquire_mni_official.py"
    raw = path.read_bytes()
    if sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest() != HELPER_BLOB:
        raise ValueError("The audited acquisition helper snapshot changed")
    spec = importlib.util.spec_from_file_location("_audited_mni_source_acquisition", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def regular(path):
    value = Path(path)
    for part in (value,) + tuple(value.parents):
        if part.is_symlink() or getattr(part, "is_junction", lambda: False)():
            raise ValueError("Linked input/output path")
    if value.exists() and not value.is_file():
        raise ValueError("Expected a regular file")
    return value


def check_hash(path, size, digest):
    regular(path)
    state, amount = sha256(), 0
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024**2), b""):
            state.update(chunk)
            amount += len(chunk)
    if amount != size or state.hexdigest() != digest:
        raise ValueError("Pinned source file bytes differ")
    return {"sha256": digest, "size_bytes": size}


def new_path(path):
    path = regular(Path(path).absolute())
    if path.exists():
        raise FileExistsError("Output is immutable; choose a fresh path")
    h = helper()
    # Reuse the audited project-input protection, independently of archive output.
    h.safe_outputs(path.parent / (path.name + ".unused-owned-archive"), path)
    return path


def publish(path, raw):
    path = new_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="mni-state-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def source_receipt(h):
    result = {}
    groups = [(h.REPOSITORY, h.SOURCE_REVISION, h.SOURCE_FILES),
              (COQUI_REPOSITORY, COQUI_REVISION, COQUI_FILES)]
    for repository, revision, files in groups:
        for name, blob in files.items():
            raw = h.bounded("https://raw.githubusercontent.com/" + repository + "/" + revision + "/" + name, 1024**2)
            actual = sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()
            if actual != blob:
                raise ValueError("Official frontend/architecture source pin differs")
            result[repository + "/" + name] = {
                "revision": revision, "git_blob": blob, "size_bytes": len(raw),
                "sha256": sha256(raw).hexdigest()}
            if name == "inference/src/inference.py":
                if b'aksharamukha_xlit("MeeteiMayek", "Bengali", input_text)' not in raw:
                    raise ValueError("Native same-MNI script transformation marker missing")
    return result


def acquire(cache, receipt):
    """The cache contains only the immutable official ZIP, not extracted code."""
    h = helper()
    archive = regular(Path(cache).absolute())
    report = new_path(receipt)
    if archive.resolve() == report.resolve() or archive.resolve() in report.resolve().parents:
        raise ValueError("Cache/receipt paths overlap")
    h.safe_outputs(archive.parent / "source-safety-unused.zip", report)
    asset_url = "https://api.github.com/repos/" + h.REPOSITORY + "/releases/assets/" + str(h.ASSET_ID)
    before = h.asset_identity(json.loads(h.bounded(asset_url, 262144)))
    sources = source_receipt(h)
    hit = archive.exists()
    if hit:
        record = check_hash(archive, ARCHIVE_SIZE, ARCHIVE_SHA256)
    else:
        archive.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix="official-mni-", suffix=".zip", dir=archive.parent)
        try:
            with os.fdopen(fd, "wb") as destination:
                with h.request(h.DOWNLOAD_URL) as stream:
                    total, state = 0, sha256()
                    for chunk in iter(lambda: stream.read(1024**2), b""):
                        total += len(chunk)
                        if total > ARCHIVE_SIZE:
                            raise ValueError("Official source exceeds pinned size")
                        destination.write(chunk)
                        state.update(chunk)
            if total != ARCHIVE_SIZE or state.hexdigest() != ARCHIVE_SHA256:
                raise ValueError("Official source differs from the audited raw SHA256")
            os.link(temporary, archive)
        finally:
            Path(temporary).unlink(missing_ok=True)
        record = {"sha256": ARCHIVE_SHA256, "size_bytes": ARCHIVE_SIZE}
    after = h.asset_identity(json.loads(h.bounded(asset_url, 262144)))
    if before != after:
        raise ValueError("Official asset metadata changed during acquisition/cache verification")
    result = {"format": "dordiai-mni-state-source-receipt", "format_version": 1,
              "archive": record, "asset": after, "source_files": sources,
              "cache_hit": hit, "source_code_executed": False,
              "source_code_licences": {"AI4Bharat/Indic-TTS": "MIT", "gokulkarthik/TTS": "MPL-2.0"},
              "weights_licence": "No checkpoint-specific licence document in audited ZIP; source MIT is not asserted for weights."}
    publish(report, h.json_bytes(result))
    print("MNI_STATE_ACQUIRED " + json.dumps(record, sort_keys=True), flush=True)
    return result


def extract(archive, stage):
    """Hash ZIP and each exact allowed file; no extractall or checkpoint loading."""
    h = helper()
    check_hash(archive, ARCHIVE_SIZE, ARCHIVE_SHA256)
    stage = Path(stage).absolute()
    if stage.exists() or stage.is_symlink():
        raise FileExistsError("Extraction stage must be new")
    for parent in stage.parents:
        if parent.is_symlink():
            raise ValueError("Linked extraction parent")
    stage.mkdir(parents=True)
    seen = set()
    with zipfile.ZipFile(archive) as zipped:
        entries = zipped.infolist()
        if len(entries) > 20:
            raise ValueError("Unexpected checkpoint archive layout")
        for info in entries:
            name = h.member_name(info)
            if name.casefold() in seen:
                raise ValueError("Duplicate checkpoint member")
            seen.add(name.casefold())
            if info.is_dir():
                if name.rstrip("/") not in {"mni", "mni/fastpitch", "mni/hifigan"}:
                    raise ValueError("Unexpected archive directory")
                continue
            if name not in FILES or info.file_size != FILES[name][0]:
                raise ValueError("Unexpected native checkpoint member/size")
            destination = stage / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            amount, state = 0, sha256()
            with zipped.open(info) as source, destination.open("xb") as target:
                for chunk in iter(lambda: source.read(1024**2), b""):
                    amount += len(chunk)
                    if amount > FILES[name][0]:
                        raise ValueError("Expanded checkpoint exceeds pin")
                    target.write(chunk)
                    state.update(chunk)
            if amount != FILES[name][0] or state.hexdigest() != FILES[name][1]:
                raise ValueError("Expanded checkpoint bytes differ")
        if set(FILES) != {name for name in seen if not name.endswith("/")}:
            raise ValueError("Missing exact native source files")
    return stage


def deny_network():
    """Linux kernel filter installed before importing Torch, no Python-only guard."""
    if sys.platform != "linux":
        raise RuntimeError("This isolated inspection requires Linux seccomp")
    lib = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_rule_add.restype = ctypes.c_int
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_load.restype = ctypes.c_int
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    context = lib.seccomp_init(0x7FFF0000)
    if not context:
        raise OSError("Cannot allocate offline syscall filter")
    names = ("socket", "connect", "sendto", "sendmsg", "sendmmsg")
    try:
        for name in names:
            number = lib.seccomp_syscall_resolve_name(name.encode("ascii"))
            if number < 0 or lib.seccomp_rule_add(context, 0x00050000 | errno.EPERM, number, 0) != 0:
                raise RuntimeError("Cannot install mandatory network syscall guard")
        if lib.seccomp_load(context) != 0:
            raise RuntimeError("Cannot activate mandatory network syscall guard")
    finally:
        lib.seccomp_release(context)
    return {"kind": "linux-seccomp", "denied_syscalls": list(names), "installed_before_torch_import": True}


def torch_version(torch):
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)(.*)$", torch.__version__)
    if not match or tuple(map(int, match.groups()[:3])) < (2, 6, 0):
        raise ValueError("weights_only audit requires Torch >=2.6")
    if not torch.__version__.endswith("+cpu") or torch.version.cuda is not None:
        raise ValueError("Only the isolated official CPU Torch distribution is allowed")
    return torch.__version__


def safe_load(torch, path):
    """No custom globals, no general pickle, no retry with unsafe deserialization."""
    mmap = zipfile.is_zipfile(path)
    return torch.load(path, weights_only=True, map_location="cpu", mmap=mmap), mmap


def describe(value, torch):
    """No tensor values/copies or model execution. Iterate bounded built-in state."""
    rows, storages, group_bytes, dtypes = [], {}, Counter(), Counter()
    primitives = {}
    total_nodes = 0
    def walk(item, path, depth):
        nonlocal total_nodes
        total_nodes += 1
        if total_nodes > MAX_NODES or depth > MAX_DEPTH:
            raise ValueError("Checkpoint metadata traversal quota exceeded")
        if torch.is_tensor(item):
            size = int(item.numel()) * int(item.element_size())
            row = {"path": path, "shape": list(item.shape), "dtype": str(item.dtype),
                   "numel": int(item.numel()), "logical_bytes": size,
                   "device": str(item.device), "layout": str(item.layout)}
            if str(item.device) != "cpu":
                raise ValueError("Checkpoint tensor escaped CPU mapping")
            rows.append(row)
            dtypes[str(item.dtype)] += size
            pieces = path.split("/")
            top = pieces[1] if len(pieces) > 1 else ""
            if top == "model" or top == "state_dict":
                key = pieces[2] if len(pieces) > 2 else ""
                group = "model/" + key.split(".")[0]
            else:
                group = top
            group_bytes[group] += size
            if str(item.layout) == "torch.strided":
                storage = item.untyped_storage()
                identity = storage._cdata  # dedup only, never emitted as an address
                storages[identity] = max(storages.get(identity, 0), int(storage.nbytes()))
            return
        if type(item) is dict or type(item).__name__ == "OrderedDict" and type(item).__module__ == "collections":
            for key, child in item.items():
                if type(key) not in (str, int):
                    raise ValueError("Unexpected state mapping key")
                label = str(key).replace("~", "~0").replace("/", "~1")
                walk(child, path + "/" + label, depth + 1)
            return
        if type(item) in (list, tuple):
            for index, child in enumerate(item):
                walk(child, path + "/" + str(index), depth + 1)
            return
        if item is None or type(item) in (bool, int, float, str):
            if len(primitives) < 2000:
                if type(item) is str and len(item) > 512:
                    primitives[path] = {"type": "str", "length": len(item)}
                else:
                    primitives[path] = item
            return
        raise ValueError("Unexpected loaded object type: " + type(item).__module__ + "." + type(item).__name__)
    walk(value, "", 0)
    keys = [str(key) for key in value] if type(value) is dict or type(value).__name__ == "OrderedDict" and type(value).__module__ == "collections" else None
    return {"top_level_keys": keys, "root_type": type(value).__name__, "tensors": rows,
            "tensor_count": len(rows), "logical_tensor_bytes": sum(row["logical_bytes"] for row in rows),
            "unique_storage_bytes": sum(storages.values()), "dtype_logical_bytes": dict(dtypes),
            "group_logical_bytes": dict(group_bytes), "primitive_metadata": primitives,
            "tensor_values_evaluated": False, "inference_only_size_is_not_an_export": True}


def inspect_checkpoint(torch, path):
    started = time.perf_counter()
    result = {"status": "blocked-not-inferred", "safe_load_kwargs": {"weights_only": True, "map_location": "cpu"},
              "mmap": zipfile.is_zipfile(path)}
    try:
        if Path(path).name == "speakers.pth" and Path(path).stat().st_size <= 65536:
            # The historical SpeakerManager can store JSON despite .pth suffix.
            # Only strict JSON is tried, never general pickle or custom globals.
            try:
                text = Path(path).read_text(encoding="utf-8-sig")
                parsed = json.loads(text, object_pairs_hook=helper().unique_pairs)
            except (UnicodeError, json.JSONDecodeError):
                pass
            else:
                result.update(describe(parsed, torch))
                result.update(status="safe-state-inspected-not-inferred", serialization="strict-json",
                              elapsed_seconds=time.perf_counter() - started)
                return result
        if result["mmap"]:
            # This is a static pickle-opcode scan, not permission to add globals.
            result["static_unsafe_globals"] = torch.serialization.get_unsafe_globals_in_checkpoint(path)
        value, mmap = safe_load(torch, path)
        try:
            result.update(describe(value, torch))
        finally:
            del value
            gc.collect()
        result["status"] = "safe-state-inspected-not-inferred"
    except Exception as error:
        result["error_type"] = type(error).__name__
        result["error"] = str(error)[:6000]
    result["elapsed_seconds"] = time.perf_counter() - started
    return result


def inspect(args):
    h = helper()
    h.MAX_REPORT = MAX_REPORT
    report_path = new_path(args.report)
    receipt_path = regular(Path(args.receipt).absolute())
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"), object_pairs_hook=h.unique_pairs)
    if receipt.get("format") != "dordiai-mni-state-source-receipt" or receipt.get("archive") != {
            "sha256": ARCHIVE_SHA256, "size_bytes": ARCHIVE_SIZE}:
        raise ValueError("Acquisition receipt does not bind the exact audited source")
    # Extraction lives outside product trees in a new owned temporary directory.
    with tempfile.TemporaryDirectory(prefix="dordiai-mni-safe-state-") as temporary:
        stage = extract(args.archive, Path(temporary) / "native")
        configs = {name: json.loads((stage/name).read_text(encoding="utf-8"), object_pairs_hook=h.unique_pairs)
                   for name in FILES if name.endswith(".json")}
        os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1",
                          OMP_NUM_THREADS="1", MKL_NUM_THREADS="1", TOKENIZERS_PARALLELISM="false")
        report = {"format": "dordiai-mni-safe-checkpoint-state", "format_version": 1,
                  "status": "inspecting", "archive": receipt["archive"], "acquisition": receipt,
                  "tool_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
                  "configs": configs, "checkpoints": {},
                  "native_script": "Native MNI acoustic training is Bengali/Eastern-Nagari; official MeeteiMayek-to-Bengali transliteration is for the SAME MNI model.",
                  "model_source_imported": False, "inference_executed": False, "onnx_exported": False,
                  "product_integrated": False, "pronunciation_verified": False,
                  "weights_licence_asserted": False}
        writer = h.OwnedReport(report_path)
        writer.write(report)
        try:
            report["network_guard"] = deny_network()
            import torch
            report["torch_version"] = torch_version(torch)
            report["torch_file"] = str(torch.__file__)
            torch.set_num_threads(1)
            for name in FILES:
                if name.endswith(".pth"):
                    report["checkpoints"][name] = inspect_checkpoint(torch, stage/name)
                    report["checkpoints"][name]["source"] = {"size_bytes": FILES[name][0], "sha256": FILES[name][1]}
                    writer.write(report)
            succeeded = all(item["status"] == "safe-state-inspected-not-inferred"
                            for item in report["checkpoints"].values())
            report["status"] = "safe-state-audit-complete-not-inferred" if succeeded else "safe-state-audit-blocked-not-inferred"
        except Exception as error:
            report.update(status="safe-state-audit-failed-not-inferred",
                          error_type=type(error).__name__, error=str(error)[:6000])
        import resource
        report["peak_rss_kib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        writer.write(report)
        import base64, gzip
        raw = h.json_bytes(report)
        if len(raw) > MAX_REPORT:
            raise ValueError("Metadata exceeds report quota")
        encoded = base64.b64encode(gzip.compress(raw, mtime=0)).decode("ascii")
        parts = [encoded[pos:pos+4096] for pos in range(0, len(encoded), 4096)]
        for index, part in enumerate(parts, 1):
            print("MNI_STATE_REPORT_GZIP_B64_PART %d/%d %s" % (index, len(parts), part), flush=True)
        print("MNI_STATE_SUMMARY " + json.dumps({
            "status": report["status"], "torch_version": report.get("torch_version"),
            "checkpoints": {name: {key: value.get(key) for key in (
                "status", "tensor_count", "logical_tensor_bytes", "unique_storage_bytes",
                "group_logical_bytes", "dtype_logical_bytes", "static_unsafe_globals", "error_type")}
                for name, value in report["checkpoints"].items()},
            "inference_executed": False}, sort_keys=True), flush=True)
        return 0 if report["status"] == "safe-state-audit-complete-not-inferred" else 2


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("acquire", "inspect"))
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(argv)
    if args.command == "acquire":
        acquire(args.archive, args.receipt)
        return 0
    if args.report is None:
        parser.error("inspect requires --report")
    return inspect(args)


if __name__ == "__main__":
    raise SystemExit(main())
