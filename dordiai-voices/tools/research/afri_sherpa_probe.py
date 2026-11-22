"""Isolated native Swati/Venda Africa-TTS CPU proof; never registers a product model.

Acquisition is separate from inference. Only existing publisher ONNX exports
are downloaded; no export, quantization, training, closest-language mapping or
English front end is used. The inference child denies network syscalls before
native imports. Finite WAVs and training-IPA parity are technical evidence, not
native listening, NVDA, character-name, typing or full-product acceptance.
"""
from __future__ import annotations
import argparse
import ctypes
import ctypes.util
from datetime import datetime, timezone
import errno
import gc
from hashlib import sha1, sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import subprocess
import sys
import tempfile
from time import perf_counter
from urllib.error import HTTPError
from urllib.request import Request, urlopen

MODEL_REPO = "AfriSpeech/africa-tts"
MODEL_REVISION = "d47667a3bb03d0d6db924e789648abd7d55d828b"
SOURCE_REVISION = "b4508ae979dd34eea2597d420d67176ef55a21a0"
G2P_REVISION = "76b53a8fa2a688812e369837d179d4710c111a7a"
SHERPA_REVISION = "af2d8d81dbfa61c4cea4c568da78f3982edca005"
LANGUAGES = {"ssw": {"selected_code": "ss", "name": "Swati", "trained_hours": 12.08},
             "ven": {"selected_code": "ve", "name": "Venda", "trained_hours": 10.62}}
ROLES = ("lm_main", "lm_flow", "encoder", "decoder", "text_conditioner")
KNOWN_MIXED_SHA256 = {
    "sherpa-onnx/decoder.int8.onnx": "f2083d75f2027179ee335ce3e27d4e7b5e0d21d8166ed22e4e845b3143669d50",
    "sherpa-onnx/encoder.onnx": "9b80b76221ecb791e486dfb502a0279c86a6ad09d01546b1d18047d42c8024db",
    "sherpa-onnx/lm_flow.int8.onnx": "19fa27ae28c3a322cf62f290f03013ee03222652a322d2d26553c77a3682037f",
    "sherpa-onnx/lm_main.int8.onnx": "ce2dd37e2bb257cedd5a71ccdc7fcb0dc8a2955638d569a47833884104cde764",
    "sherpa-onnx/text_conditioner.onnx": "7aa23a316ae43ce94f3d2c3be5c30b4910cba86a29362f7f4e365268035b8eeb",
}
SOURCE_FILES = {
    "languages.json": ("africa_tts/languages.json", 4749, "a2d547853bd1b3b8c6db110b42e23e0f76c43000"),
    "parity_set.tsv": ("mobile/frontend/tests/parity_set.tsv", 221529, "7a24129c8f737143abffa5033de0661d312717d4"),
}
MAX_FILE_BYTES = 1_500_000_000
MAX_TOTAL_BYTES = 1_800_000_000


def digest(path):
    value = sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def write_json(path, value, *, overwrite=True):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".writing-" + str(os.getpid()))
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        if overwrite:
            temporary.replace(path)
        else:
            os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_json_url(url):
    request = Request(url, headers={"User-Agent": "dordiai-isolated-native-proof"})
    with urlopen(request, timeout=60) as response:
        raw = response.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError("Oversized publisher metadata")
    return json.loads(raw)


def artifact_record(row):
    lfs = row.get("lfs") or {}
    size = lfs.get("size", row.get("size"))
    raw_hash = lfs.get("sha256", lfs.get("oid"))
    if isinstance(raw_hash, str):
        raw_hash = raw_hash.removeprefix("sha256:")
    blob = row.get("blobId", row.get("oid"))
    if type(size) is not int or not 0 < size <= MAX_FILE_BYTES:
        raise ValueError("Missing or out-of-budget immutable artifact size")
    result = {"bytes": size}
    if isinstance(raw_hash, str) and re.fullmatch("[a-f0-9]{64}", raw_hash):
        result.update(sha256=raw_hash, pin_kind="publisher-lfs-raw-sha256")
    elif isinstance(blob, str) and re.fullmatch("[a-f0-9]{40}", blob):
        result.update(git_blob_sha1=blob, pin_kind="publisher-git-blob-sha1")
    else:
        raise ValueError("Publisher metadata is missing an immutable content digest")
    return result


def choose_exports(rows):
    """Prefer a complete existing publisher FP32 export, otherwise published mixed."""
    files = {row.get("rfilename", row.get("path")): row for row in rows if row.get("rfilename", row.get("path"))}
    for path, known in KNOWN_MIXED_SHA256.items():
        if path in files and artifact_record(files[path]).get("sha256") != known:
            raise ValueError("Known published mixed-model raw hash changed: " + path)
    rejected_fp32 = []
    for prefix in ("sherpa-onnx", "onnx", "onnx-fp32", "fp32", ""):
        join = lambda name: prefix + "/" + name if prefix else name
        roles = {role: join(role + ".onnx") for role in ROLES}
        roles.update(vocab_json=join("vocab.json"), token_scores_json=join("token_scores.json"))
        if all(path in files for path in roles.values()):
            amount = sum(artifact_record(files[path])["bytes"] for path in roles.values())
            if amount <= MAX_TOTAL_BYTES:
                return files, roles, "publisher-fp32-onnx", rejected_fp32
            rejected_fp32.append({"prefix": prefix, "bytes": amount, "reason": "exceeds isolated prototype data budget"})
    roles = {role: "sherpa-onnx/" + role + (".int8.onnx" if role in {"lm_main", "lm_flow", "decoder"} else ".onnx") for role in ROLES}
    roles.update(vocab_json="sherpa-onnx/vocab.json", token_scores_json="sherpa-onnx/token_scores.json")
    if any(path not in files for path in roles.values()):
        raise ValueError("No complete compatible publisher FP32 or documented mixed ONNX export")
    if sum(artifact_record(files[path])["bytes"] for path in roles.values()) > MAX_TOTAL_BYTES:
        raise ValueError("Published export exceeds the isolated prototype budget")
    return files, roles, "publisher-mixed-int8-lm-decoder-fp32-encoder-conditioner", rejected_fp32


def verify_file(path, expected):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size != expected["bytes"]:
        return False
    if "sha256" in expected:
        return digest(path) == expected["sha256"]
    value = sha1(b"blob " + str(expected["bytes"]).encode("ascii") + b"\0")
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest() == expected["git_blob_sha1"]


def download(url, target, expected):
    target = Path(target)
    if verify_file(target, expected):
        return target
    if target.is_symlink():
        raise ValueError("Acquisition target must not be a symlink")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".download-" + str(os.getpid()))
    try:
        request = Request(url, headers={"User-Agent": "dordiai-isolated-native-proof"})
        with urlopen(request, timeout=90) as source, temporary.open("xb") as destination:
            count = 0
            for block in iter(lambda: source.read(1024 * 1024), b""):
                count += len(block)
                if count > expected["bytes"]:
                    raise ValueError("Download exceeds pinned byte count")
                destination.write(block)
        if not verify_file(temporary, expected):
            raise ValueError("Download content differs from its exact immutable pin")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def acquire(args):
    cache = args.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    metadata = read_json_url(f"https://huggingface.co/api/models/{MODEL_REPO}/revision/{MODEL_REVISION}?blobs=true")
    if metadata.get("sha") != MODEL_REVISION:
        raise ValueError("HF API did not resolve the exact pinned model revision")
    rows = metadata["siblings"]
    # Current Hub ModelInfo normally includes blob metadata with blobs=true.
    # The same pinned tree endpoint is a metadata-only fallback, never main/latest.
    if not any("size" in row or "lfs" in row for row in rows):
        rows = read_json_url(f"https://huggingface.co/api/models/{MODEL_REPO}/tree/{MODEL_REVISION}?recursive=true&limit=1000")
        if not isinstance(rows, list):
            raise ValueError("Unexpected pinned model tree response")
    files, roles, precision, rejected = choose_exports(rows)
    for code in LANGUAGES:
        selected = next((path for path in (f"sherpa-onnx/voices/{code}.wav", f"voices/{code}.wav") if path in files), None)
        if selected is None:
            raise ValueError("Same-language default reference is absent: " + code)
        roles["voice_" + code] = selected
    for path in ("config.yaml", "README.md", "LICENSE", "sherpa-onnx/voices/voices.json"):
        if path in files:
            roles["metadata_" + str(len(roles))] = path
    report = {
        "format": "dordiai-afri-pocket-source-index-v1", "status": "acquiring",
        "repository": MODEL_REPO, "revision": MODEL_REVISION, "source_revision": SOURCE_REVISION,
        "g2p_revision": G2P_REVISION, "sherpa_version": "2.0.1", "sherpa_source_revision": SHERPA_REVISION,
        "selected_languages": LANGUAGES, "precision": precision,
        "fp32_sets_not_selected": rejected, "our_quantization_or_export": False,
        "publisher_card_license": (metadata.get("cardData") or {}).get("license"),
        "publisher_model_and_default_voice_license": "CC-BY-NC-4.0 according to primary publisher",
        "code_license": "MIT (AfricaTTS), Apache-2.0 (sherpa-onnx and africa-g2p code); linguistic-data attribution separate",
        "files": {}, "native_listener_verified": False, "product_integrated": False,
    }
    write_json(args.report, report, overwrite=args.overwrite)
    for role, relative in roles.items():
        expected = artifact_record(files[relative])
        if role not in ROLES and expected["bytes"] > 8 * 1024 * 1024:
            raise ValueError("Unexpectedly large reference/tokenizer/metadata file")
        # Relative names here come only from the fixed selector above.
        path = cache / "model" / relative
        url = f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/{relative}"
        download(url, path, expected)
        report["files"][role] = dict(expected, path=str(path), repository_path=relative,
                                     url=url, measured_raw_sha256=digest(path))
        write_json(args.report, report)
    for role, (relative, size, blob) in SOURCE_FILES.items():
        expected = {"bytes": size, "git_blob_sha1": blob, "pin_kind": "primary-git-blob-sha1"}
        path = cache / "primary" / role
        url = f"https://raw.githubusercontent.com/AfriSpeech/africa-tts/{SOURCE_REVISION}/{relative}"
        download(url, path, expected)
        report["files"]["source_" + role] = dict(expected, path=str(path), url=url, measured_raw_sha256=digest(path))
    trained = json.loads(Path(report["files"]["source_languages.json"]["path"]).read_text(encoding="utf-8"))
    for code, info in LANGUAGES.items():
        if trained.get(code, {}).get("hours") != info["trained_hours"]:
            raise ValueError("Selected language is not explicitly trained with the expected primary metadata")
    report["selected_required_model_bytes"] = sum(report["files"][role]["bytes"] for role in ROLES)
    report["all_selected_download_bytes"] = sum(row["bytes"] for row in report["files"].values())
    report["status"] = "verified-existing-publisher-assets"
    write_json(args.report, report)
    write_json(cache / "source-index.json", report)
    return report


def select_cases(text, per_language):
    result = []
    for code in LANGUAGES:
        rows = []
        for line in text.splitlines():
            columns = line.split("\t", 2)
            if len(columns) == 3 and columns[0] == code:
                rows.append({"language": code, "text": columns[1], "expected_training_ipa": columns[2]})
        if len(rows) < per_language:
            raise ValueError("Pinned primary frontend fixtures lack enough exact-language cases")
        result.extend(rows[:per_language])
    return result


def deny_native_network():
    """Install an unprivileged kernel filter before native imports/threads."""
    if sys.platform != "linux":
        raise RuntimeError("Isolated prototype requires Linux native network denial")
    library = ctypes.util.find_library("seccomp")
    if not library:
        raise RuntimeError("libseccomp is required; do not infer without native network denial")
    lib = ctypes.CDLL(library, use_errno=True)
    lib.seccomp_init.argtypes, lib.seccomp_init.restype = [ctypes.c_uint32], ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes, lib.seccomp_syscall_resolve_name.restype = [ctypes.c_char_p], ctypes.c_int
    lib.seccomp_rule_add.argtypes, lib.seccomp_rule_add.restype = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint], ctypes.c_int
    lib.seccomp_load.argtypes, lib.seccomp_load.restype = [ctypes.c_void_p], ctypes.c_int
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    context = lib.seccomp_init(0x7FFF0000)
    if not context:
        raise OSError("Could not create seccomp context")
    denied = []
    try:
        for name in ("socket", "connect", "sendto", "sendmsg", "sendmmsg"):
            number = lib.seccomp_syscall_resolve_name(name.encode("ascii"))
            if number < 0 or lib.seccomp_rule_add(context, 0x00050000 | errno.EPERM, number, 0) != 0:
                raise OSError("Could not deny native network syscall: " + name)
            denied.append(name)
        if lib.seccomp_load(context) != 0:
            raise OSError("Could not load the native network denial filter")
    finally:
        lib.seccomp_release(context)
    try:
        value = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except OSError as error:
        if error.errno != errno.EPERM:
            raise
    else:
        value.close()
        raise RuntimeError("Native socket creation unexpectedly succeeded")
    return {"kernel_filter_loaded_before_inference_imports": True, "denied_syscalls": denied,
            "actual_socket_test_errno": errno.EPERM}


def graph_facts(path):
    import onnx
    model = onnx.load_model(str(path), load_external_data=False)
    if any(value.external_data for value in model.graph.initializer):
        raise ValueError("Export has unacquired external tensor files")
    kinds = {}
    layer_ids = set()
    for value in model.graph.initializer:
        name = onnx.TensorProto.DataType.Name(value.data_type)
        kinds[name] = kinds.get(name, 0) + 1
        for matched in re.finditer(r"(?:transformer\.)?layers[./](\d+)", value.name):
            layer_ids.add(int(matched.group(1)))
    for node in model.graph.node:
        for name in [node.name] + list(node.input):
            for matched in re.finditer(r"(?:transformer\.)?layers[./](\d+)", name):
                layer_ids.add(int(matched.group(1)))
    result = {"initializer_dtypes": kinds, "observed_layer_ids_from_weight_names": sorted(layer_ids),
              "inputs": [value.name for value in model.graph.input],
              "outputs": [value.name for value in model.graph.output],
              "node_count": len(model.graph.node), "opset": [{ "domain": item.domain, "version": item.version} for item in model.opset_import]}
    del model
    gc.collect()
    return result


def worker(args):
    report = {"format": "dordiai-afri-pocket-native-cpu-proof-v1", "status": "running",
              "started_utc": datetime.now(timezone.utc).isoformat(), "product_integrated": False,
              "native_listener_verified": False, "nvda_verified": False, "typing_or_character_names_verified": False,
              "scope": "Exact trained Swati/Venda frontend IPA and actual same-language native CPU WAVs only.",
              "cases": []}
    write_json(args.report, report, overwrite=args.overwrite)
    index_path = args.cache.resolve() / "source-index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if index.get("revision") != MODEL_REVISION or index.get("status") != "verified-existing-publisher-assets":
        raise ValueError("No verified immutable source index")
    for record in index["files"].values():
        if not verify_file(record["path"], record) or digest(record["path"]) != record["measured_raw_sha256"]:
            raise ValueError("Publisher input changed since acquisition")
    g2p_source = args.g2p_source.resolve(strict=True)
    head = subprocess.check_output(["git", "-C", str(g2p_source), "rev-parse", "HEAD"], text=True).strip()
    if head != G2P_REVISION:
        raise ValueError("G2P checkout differs from the exact training commit")
    report["network_guard"] = deny_native_network()
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1", CUDA_VISIBLE_DEVICES="")
    sys.path.insert(0, str(g2p_source / "src"))
    import numpy as np
    import sherpa_onnx
    import soundfile as sf
    from africa_g2p import g2p
    if sherpa_onnx.__version__ != "2.0.1":
        raise ValueError("The official primary-tested sherpa-onnx2.0.1 is required")
    import resource
    native_versions = {key: str(getattr(sherpa_onnx, key)() if callable(getattr(sherpa_onnx, key)) else getattr(sherpa_onnx, key))
                       for key in ("git_sha1", "git_date", "onnxruntime_version")}
    report.update(source_index_sha256=digest(index_path), source=index, native_runtime=native_versions,
                  sherpa_onnx_version=sherpa_onnx.__version__, sherpa_onnx_module=str(sherpa_onnx.__file__),
                  g2p_revision=head, g2p_linguistic_data_notice=(g2p_source / "DATA_LICENSE.md").read_text(encoding="utf-8"),
                  graph_facts={})
    for role in ROLES:
        report["graph_facts"][role] = graph_facts(index["files"][role]["path"])
    report["observed_lm_layer_ids"] = report["graph_facts"]["lm_main"]["observed_layer_ids_from_weight_names"]
    report["publisher_six_layer_claim_matches_named_graph_layers"] = report["observed_lm_layer_ids"] == list(range(6))
    cases = select_cases(Path(index["files"]["source_parity_set.tsv"]["path"]).read_text(encoding="utf-8"), args.cases_per_language)
    for row in cases:
        actual = g2p(row["text"], row["language"], output="ipa")
        if actual != row["expected_training_ipa"]:
            raise ValueError("Native G2P does not reproduce the primary training IPA: " + row["language"])
        row["ipa"] = actual
    report["all_selected_frontend_bytes_match_training"] = True
    write_json(args.report, report)
    paths = {role: index["files"][role]["path"] for role in ROLES + ("vocab_json", "token_scores_json")}
    pocket = sherpa_onnx.OfflineTtsPocketModelConfig(**paths)
    config = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        pocket=pocket, num_threads=args.threads, provider="cpu"))
    started = perf_counter()
    engine = sherpa_onnx.OfflineTts(config)
    report["engine_load_seconds"] = perf_counter() - started
    audio_folder = args.report.resolve().parent / "audio"
    audio_folder.mkdir(parents=True, exist_ok=True)
    for position, row in enumerate(cases):
        result = dict(row, status="failed")
        try:
            reference_path = index["files"]["voice_" + row["language"]]["path"]
            reference, reference_rate = sf.read(reference_path, dtype="float32")
            reference = reference if reference.ndim == 1 else reference.mean(axis=1)
            if not np.isfinite(reference).all() or len(reference) < 512:
                raise ValueError("Invalid native default reference audio")
            generation = sherpa_onnx.GenerationConfig()
            generation.reference_audio, generation.reference_sample_rate = reference, int(reference_rate)
            generation.num_steps, generation.silence_scale = 1, 1.0
            generation.extra = {"temperature": "0.3"}
            started = perf_counter()
            generated = engine.generate(row["ipa"], generation)
            elapsed = perf_counter() - started
            audio = np.asarray(generated.samples, dtype=np.float32)
            rate = int(generated.sample_rate)
            if rate != 24000 or audio.ndim != 1 or len(audio) < 2400 or not np.isfinite(audio).all():
                raise ValueError("Invalid native output structure")
            peak, rms = float(np.max(np.abs(audio))), float(np.sqrt(np.mean(audio ** 2)))
            if peak < 1e-5 or rms < 1e-6:
                raise ValueError("Silent native output")
            output = audio_folder / (row["language"] + "-" + str(position) + ".wav")
            if output.is_symlink() or (output.exists() and not args.overwrite):
                raise FileExistsError("Refusing to replace existing audio output")
            descriptor, temporary = tempfile.mkstemp(prefix=output.stem + "-", suffix=".wav", dir=audio_folder)
            os.close(descriptor)
            try:
                sf.write(temporary, audio, rate, subtype="PCM_16")
                if args.overwrite:
                    Path(temporary).replace(output)
                else:
                    os.link(temporary, output)
            finally:
                Path(temporary).unlink(missing_ok=True)
            result.update(status="passed", sample_rate=rate, samples=len(audio), audio_seconds=len(audio) / rate,
                          inference_seconds=elapsed, rtf=elapsed / (len(audio) / rate), peak=peak, rms=rms,
                          pcm_clip_fraction=float(np.mean(np.abs(audio) >= 1.)),
                          wav_path=str(output), wav_sha256=digest(output), float32_sha256=sha256(audio.tobytes()).hexdigest(),
                          reference_sha256=digest(reference_path), reference_sample_rate=int(reference_rate),
                          settings={"temperature": "0.3", "num_steps": 1, "silence_scale": 1.0, "provider": "cpu", "threads": args.threads})
        except Exception as error:
            result.update(error_type=type(error).__name__, error=str(error))
        result["process_peak_rss_bytes"] = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024
        report["cases"].append(result)
        write_json(args.report, report)
        print(json.dumps({key: result.get(key) for key in ("language", "status", "inference_seconds", "audio_seconds", "rtf", "error")}), flush=True)
    report["all_cases_passed"] = len(report["cases"]) == 2 * args.cases_per_language and all(row["status"] == "passed" for row in report["cases"])
    report["process_peak_rss_bytes"] = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024
    report["inputs_unchanged"] = all(digest(record["path"]) == record["measured_raw_sha256"] for record in index["files"].values())
    report["status"] = "passed-native-technical-prototype" if report["all_cases_passed"] and report["inputs_unchanged"] else "failed"
    report["finished_utc"] = datetime.now(timezone.utc).isoformat()
    write_json(args.report, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("acquire", "worker"))
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--g2p-source", type=Path)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--threads", type=int, choices=(1, 2, 3, 4), default=2)
    parser.add_argument("--cases-per-language", type=int, choices=(1, 2, 3, 4, 5), default=3)
    args = parser.parse_args()
    if args.phase == "worker" and args.g2p_source is None:
        parser.error("--g2p-source is required for native inference")
    report_directory, cache = args.report.resolve().parent, args.cache.resolve()
    protected = [cache]
    if args.g2p_source is not None:
        protected.append(args.g2p_source.resolve())
    if any(report_directory.is_relative_to(path) or path.is_relative_to(report_directory) for path in protected):
        parser.error("Use a separate report directory outside/alongside cached model and G2P inputs")
    if args.report.is_symlink() or (args.report.exists() and not args.overwrite):
        parser.error("Refusing to replace an existing report without --overwrite")
    try:
        result = acquire(args) if args.phase == "acquire" else worker(args)
        return 0 if result["status"] in {"verified-existing-publisher-assets", "passed-native-technical-prototype"} else 1
    except Exception as error:
        prior = json.loads(args.report.read_text(encoding="utf-8")) if args.report.is_file() else {}
        prior.update(status="failed", error_type=type(error).__name__, error=str(error),
                     product_integrated=False, native_listener_verified=False)
        write_json(args.report, prior)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
