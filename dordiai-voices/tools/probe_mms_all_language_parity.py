"""NEW offline reproduction of all29 MMS native/projected numerical parity.

This is a reconstruction of the procedure, not recovered bytes of the earlier
tool and not the lost earlier raw results. It executes existing local FP32
models with the current production helper. Grapheme probes demonstrate tensor
compatibility and numerical parity, not words, letter names or pronunciation.
No models are downloaded, exported, quantized, retrained or modified.

Example (all paths refer to previously acquired local files):
  python tools/probe_mms_all_language_parity.py \
    --models /path/to/models/MMS \
    --converter-models /path/to/models/OpenVoiceV2 \
    --target-embedding /path/to/models/voices/viktoriia.npy \
    --target-profile viktoriia \
    --output /path/to/evidence/new-all29-parity.json
"""
from __future__ import annotations
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import gc
from hashlib import sha256
import json
import os
from pathlib import Path
import platform
import sys
from time import perf_counter
from types import SimpleNamespace
import wave

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
MAX_FLOAT_ERROR = 1e-6
MAX_PCM16_LSB = 1


def digest(path):
    value = sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def native_probe_text(tokens):
    # Same deliberate grapheme procedure as prepare_mms_models.smoke_text.
    seen, chosen = set(), []
    for symbol, identifier in sorted(tokens.items(), key=lambda row: row[1]):
        folded = symbol.lower()
        if len(symbol) == 1 and symbol.isalpha() and folded not in seen:
            chosen.append(folded)
            seen.add(folded)
        if len(chosen) >= 20:
            break
    if len(chosen) < 3:
        raise ValueError("Too few native graphemes to exercise MMS checkpoint")
    return " ".join(chosen) + " " + " ".join(reversed(chosen))


def pcm16(audio):
    import numpy as np
    return np.rint(np.clip(audio, -1, 1) * 32767).astype("<i2")


def valid_audio(audio):
    import numpy as np
    if (not isinstance(audio, np.ndarray) or audio.dtype != np.float32
            or audio.ndim != 1 or len(audio) < 32
            or not np.isfinite(audio).all() or float(np.max(np.abs(audio))) < 1e-7):
        raise ValueError("Invalid, nonfinite, non-float32 or silent audio")
    return audio


def parity(first, second):
    import numpy as np
    valid_audio(first)
    valid_audio(second)
    if first.shape != second.shape:
        raise ValueError("Parity requires identical sample dimensions")
    a, b = pcm16(first), pcm16(second)
    delta = np.abs(a.astype(np.int32) - b.astype(np.int32))
    max_error = float(np.max(np.abs(first.astype(np.float64) - second.astype(np.float64))))
    return {
        "samples": len(first),
        "float32_bitwise_equal": first.tobytes() == second.tobytes(),
        "max_float_error": max_error,
        "original_float32_sha256": sha256(first.tobytes()).hexdigest(),
        "shared_float32_sha256": sha256(second.tobytes()).hexdigest(),
        "pcm16_bitwise_equal": a.tobytes() == b.tobytes(),
        "pcm16_max_lsb_difference": int(np.max(delta)),
        "pcm16_different_samples": int(np.count_nonzero(delta)),
        "original_pcm16_sha256": sha256(a.tobytes()).hexdigest(),
        "shared_pcm16_sha256": sha256(b.tobytes()).hexdigest(),
        "numerical_guard_passed": max_error <= MAX_FLOAT_ERROR and int(np.max(delta)) <= MAX_PCM16_LSB,
    }


def settings(ort):
    options = ort.SessionOptions()
    options.intra_op_num_threads, options.inter_op_num_threads = 2, 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.log_severity_level = 3
    return options


def memory():
    # Optional Linux process observation, not a cross-platform RAM acceptance test.
    path = Path("/proc/self/smaps_rollup")
    if not path.is_file():
        return {"available": False}
    fields = {"Rss", "Pss", "Private_Clean", "Private_Dirty", "Anonymous"}
    return {key + "_bytes": int(value.split()[0]) * 1024
            for line in path.read_text(encoding="ascii").splitlines()
            for key, _, value in [line.partition(":")] if key in fields}


@contextmanager
def mode(family, shared):
    name = family.ENVIRONMENT_OPTION
    old = os.environ.get(name)
    os.environ[name] = "1" if shared else "0"
    try:
        yield
    finally:
        if old is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = old


def write_report(path, report):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def write_audio(directory, name, audio, rate):
    directory.mkdir(parents=True, exist_ok=True)
    with wave.open(str(directory / (name + ".wav")), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(rate)
        stream.writeframes(pcm16(audio).tobytes())


def embedding(path):
    import numpy as np
    value = np.load(path, allow_pickle=False)
    if value.dtype != np.float32 or value.shape != (1, 256, 1) or not np.isfinite(value).all():
        raise ValueError("Invalid actual OpenVoice reference embedding: " + str(path))
    if float(np.linalg.norm(value)) < 1e-7:
        raise ValueError("Zero OpenVoice reference embedding")
    return value


def validate_output(path, protected, overwrite):
    path = path.resolve()
    if any(path.is_relative_to(root) for root in protected):
        raise ValueError("Evidence output must be outside runtime/model/reference directories")
    if path.exists() and not overwrite:
        raise FileExistsError("Evidence output already exists; use --overwrite explicitly: " + str(path))
    return path


IDENTITY_KEYS = frozenset({
    "id", "voice_id", "profile", "profile_id", "target_profile", "source_profile",
    "speaker_id", "source_voice_id", "target_voice_id", "voice", "speaker", "name",
    "target_voice", "source_voice", "original_voice_id", "reference_voice_id", "source",
})
TARGET_ID_KEYS = ("id", "voice_id", "profile", "profile_id", "target_profile")


def reject_blocked_metadata(value, policy):
    """Reject explicit blocked identity labels, not arbitrary prose substrings."""
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).casefold() in IDENTITY_KEYS and isinstance(item, str):
                if item.split(":", 1)[0].casefold() in policy.EXCLUDED_VOICE_IDS:
                    policy.require_voice_allowed(item)
            reject_blocked_metadata(item, policy)
    elif isinstance(value, list):
        for item in value:
            reject_blocked_metadata(item, policy)


def reject_blocked_path(path, policy):
    for part in Path(path).parts:
        label = Path(part).stem
        if label.split(":", 1)[0].casefold() in policy.EXCLUDED_VOICE_IDS:
            policy.require_voice_allowed(label)


def target_identity(args, target_path, policy, assets):
    """Bind declared/managed profile to exact bytes without claiming biometrics."""
    profile = policy.require_voice_allowed(args.target_profile)
    reject_blocked_path(args.target_embedding, policy)
    reject_blocked_path(target_path, policy)
    target_hash = digest(target_path)
    metadata_paths = []
    if args.target_metadata is not None:
        metadata_paths.append(args.target_metadata.resolve(strict=True))
    for path in (Path(str(target_path) + ".json"), target_path.with_suffix(".json")):
        if path.is_file() and path not in metadata_paths:
            metadata_paths.append(path)
    references = args.voice_references.resolve(strict=True) if args.voice_references is not None else None
    # A conventional installed package can be inferred structurally. Its active
    # identity and checksum still come from the real resolver, never this name.
    for directory in list(target_path.parents)[:8]:
        manifest = directory / "voice-package.json"
        if manifest.is_file():
            if manifest not in metadata_paths:
                metadata_paths.append(manifest)
            if references is None and directory.parent.parent.name == "packages":
                references = directory.parent.parent.parent
            break
    binding = {
        "declared_profile_id": profile,
        "embedding_path": str(target_path), "embedding_sha256": target_hash,
        "binding_kind": "caller-declared-profile-and-exact-file-hash",
        "acoustic_speaker_identity_verified": False,
        "identity_limit": "Profile labels, filenames and hashes do not prove the human speaker's identity.",
        "excluded_policy_ids": sorted(policy.EXCLUDED_VOICE_IDS),
        "metadata": [], "fingerprinted_files": {},
    }
    if references is not None:
        reject_blocked_path(references, policy)
        managed = assets.asset_path(references, profile, "target_embedding", required=True)
        binding["voice_references"] = str(references)
        if managed is not None:
            managed = Path(managed).resolve(strict=True)
            reject_blocked_path(managed, policy)
            document = assets.discover_voices(references).get(profile)
            if document is None or document.get("id") != profile:
                raise ValueError("Verified asset has no matching active managed profile")
            reject_blocked_metadata(document, policy)
            managed_hash = digest(managed)
            if managed_hash != target_hash:
                raise ValueError("Provided target bytes differ from the active profile's verified embedding")
            binding.update(
                binding_kind="active-managed-profile-and-verified-asset-hash",
                managed_profile={"id": document["id"], "version": document["version"],
                                 "engine": document["engine"], "verified_embedding_path": str(managed),
                                 "verified_embedding_sha256": managed_hash,
                                 "declared_provenance": document.get("provenance", {})})
            binding["fingerprinted_files"][str(managed)] = managed_hash
            manifest = Path(document["directory"]) / "voice-package.json"
            if manifest not in metadata_paths:
                metadata_paths.append(manifest)
        # A built-in or unregistered future voice returns None. Retain explicit
        # caller declaration; do not mislabel it a checksum-verified package.
        index = references / "packages" / assets.INDEX_NAME
        if index.is_file():
            binding["fingerprinted_files"][str(index)] = digest(index)
    for path in metadata_paths:
        reject_blocked_path(path, policy)
        if path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError("Target identity metadata is unexpectedly large")
        document = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(document, dict):
            raise ValueError("Target identity metadata must be a JSON object")
        reject_blocked_metadata(document, policy)
        for key in TARGET_ID_KEYS:
            declared = document.get(key)
            if isinstance(declared, str) and declared != profile:
                raise ValueError("Target metadata profile differs from the explicit target profile")
        for key in ("embedding_sha256", "target_embedding_sha256", "sha256"):
            if key in document and document[key] != target_hash:
                raise ValueError("Target metadata embedding checksum differs from the selected bytes")
        file_hash = digest(path)
        binding["metadata"].append({"path": str(path), "sha256": file_hash,
                                    "declared_profile_fields": {key: document[key] for key in TARGET_ID_KEYS if key in document}})
        binding["fingerprinted_files"][str(path)] = file_hash
    return binding


def run(args):
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1")
    runtime, models = args.runtime.resolve(strict=True), args.models.resolve(strict=True)
    converter_models = args.converter_models.resolve(strict=True)
    target_path = args.target_embedding.resolve(strict=True)
    shared_assets = (args.shared_assets.resolve(strict=True) if args.shared_assets is not None
                     else runtime / "models/MMSShared")
    protected = (runtime, models, converter_models, target_path.parent, shared_assets)
    output = validate_output(args.output, protected, args.overwrite)
    if output.suffix.lower() != ".json":
        raise ValueError("--output must name a JSON report")
    audio_directory = None
    if args.audio_directory is not None:
        audio_directory = validate_output(args.audio_directory, protected, args.overwrite)
    sys.path.insert(0, str(runtime))
    import numpy as np
    import onnxruntime as ort
    # Fail before every session if the known local runtime differs. This does not
    # install an alternative wheel or retry a rejected network-enabled runtime.
    if ort.__version__ != args.require_ort_version:
        raise ValueError("Expected ONNX Runtime " + args.require_ort_version + ", got " + ort.__version__)
    ort.disable_telemetry_events()
    import mms_family_sessions as family
    import wide_mms as mms
    import wide_voice
    import converted_voices
    import voice_policy
    import voice_assets
    for module in (family, mms, wide_voice, converted_voices, voice_policy, voice_assets):
        if not Path(module.__file__).resolve().is_relative_to(runtime):
            raise ValueError("A previously imported module came from another runtime: " + module.__name__)
    target_provenance = target_identity(args, target_path, voice_policy, voice_assets)
    identity_inputs = tuple(Path(path).resolve() for path in target_provenance["fingerprinted_files"])
    if "voice_references" in target_provenance:
        identity_inputs += (Path(target_provenance["voice_references"]).resolve(),)
    output = validate_output(output, protected + identity_inputs, args.overwrite)
    if audio_directory is not None:
        audio_directory = validate_output(audio_directory, protected + identity_inputs, args.overwrite)
    family.ASSETS = shared_assets
    descriptor = family._index(str(family.ASSETS / "index.json"), family.signature(family.ASSETS / "index.json"))
    codes = sorted(family.CODES) if args.languages == "all" else args.languages.split(",")
    if not codes or len(codes) != len(set(codes)) or any(code not in family.CODES for code in codes):
        raise ValueError("Select distinct exact audited MMS runtime codes, or all")
    fingerprints = {str(Path(module.__file__).resolve()): digest(module.__file__)
                    for module in (family, mms, wide_voice, converted_voices, voice_policy, voice_assets)}
    fingerprints.update(target_provenance["fingerprinted_files"])
    fingerprints[str(Path(__file__).resolve())] = digest(__file__)
    for path in (family.ASSETS / "graph.onnx", family.ASSETS / "index.json",
                 converter_models / "encoder-flow.onnx", converter_models / "decoder.onnx", target_path):
        fingerprints[str(path)] = digest(path)
    # Validate shared graph bytes before loading the conversion sessions.
    family._read_pinned(family.ASSETS / "graph.onnx", family.GRAPH_SIZE, family.GRAPH_SHA256)
    report = {
        "format": "dordiai-mms-all-language-parity-reproduction-v1",
        "tool_origin": "new reconstruction of the procedure; not the recovered earlier tool or raw earlier results",
        "started_utc": datetime.now(timezone.utc).isoformat(),
        "status": "running", "requested_codes": codes, "requested_all29": set(codes) == set(family.CODES),
        "environment": {"python": sys.version, "platform": platform.platform(),
                        "onnxruntime": ort.__version__, "onnxruntime_module": str(ort.__file__),
                        "numpy": np.__version__, "threads": 2, "providers": ["CPUExecutionProvider"]},
        "inputs": {"runtime": str(runtime), "models": str(models), "converter_models": str(converter_models),
                   "target_embedding": str(target_path), "target_profile": args.target_profile,
                   "target_identity_provenance": target_provenance,
                   "shared_assets": str(family.ASSETS), "sha256": fingerprints},
        "procedure": {"probe": "20 distinct lowercased native graphemes by token ID, followed by reversed sequence",
                      "noise_scale": 0., "noise_scale_w": 0., "speed": 1.,
                      "original_session_mode": "original", "shared_session_mode": "shared-exact-weights",
                      "original_closed_before_shared_carrier": True, "one_shared_raw_graph_held_across_languages": True,
                      "conversion": "actual WideVoices.converted, native16000→22050 resample, character=True",
                      "max_float_error": MAX_FLOAT_ERROR, "max_pcm16_lsb": MAX_PCM16_LSB},
        "scope_limits": ["Grapheme probe is not word pronunciation, ordinary letter naming or listening acceptance.",
                         "No NVDA, audio device, language detection or end-to-end latency acceptance is tested.",
                         "Zero-noise equality does not replace independent production stochastic/cancellation tests.",
                         "File cache is not flushed; timings and Linux RSS are observations, not cold-disk benchmarks.",
                         "Models stay full FP32; no claim of shrinking29 model files or fitting600 languages into3GB."],
        "languages": [], "all_requested_numerical_guards_passed": False,
        "all_requested_native_bitwise_equal": False, "all_requested_projected_bitwise_equal": False,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    write_report(output, report)
    flow = ort.InferenceSession(str(converter_models / "encoder-flow.onnx"),
                               sess_options=settings(ort), providers=["CPUExecutionProvider"])
    decoder = ort.InferenceSession(str(converter_models / "decoder.onnx"),
                                  sess_options=settings(ort), providers=["CPUExecutionProvider"])
    context = SimpleNamespace(owner=SimpleNamespace(check_cancelled=lambda: None),
                              converter=SimpleNamespace(flow=flow, decoder=decoder))
    target = embedding(target_path)
    family_anchor = None
    shared_opens = []
    def open_original(path):
        return ort.InferenceSession(str(path), sess_options=settings(ort), providers=["CPUExecutionProvider"])
    def open_shared(path):
        shared_opens.append(str(path))
        return open_original(path)
    def project(audio, source):
        audio = converted_voices.resample(audio, 16000, 22050)
        return valid_audio(np.concatenate(list(wide_voice.WideVoices.converted(
            context, audio, source, target, character=True))))
    for code in codes:
        started = perf_counter()
        original = shared = view = None
        first = second = first_projected = second_projected = source = audio = None
        row = {"code": code, "status": "running"}
        try:
            folder = models / code
            identity = family.resource_identity(folder)
            config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
            text = native_probe_text(mms.read_tokens(folder / "tokens.txt"))
            model_hash = digest(folder / "model.onnx")
            if model_hash != descriptor["models"][code]["sha256"]:
                raise ValueError("Original MMS weights do not match the pinned family")
            source_path = folder / "source.npy"
            source_hash = digest(source_path)
            if config.get("source_identity", {}).get("source_sha256") != source_hash:
                raise ValueError("Source reference vector differs from its prepared provenance")
            source = embedding(source_path)
            row.update(text=text, probe_kind="native-grapheme-smoke-test",
                       model_sha256=model_hash, model_bytes=(folder / "model.onnx").stat().st_size,
                       config_sha256=digest(folder / "config.json"), tokens_sha256=digest(folder / "tokens.txt"),
                       source_sha256=source_hash)
            with mode(family, False):
                original = mms.MMSCarrier(folder, session_factory=open_original)
                tick = perf_counter()
                first, rate, applied = original.audio(text, noise_scale=0., noise_scale_w=0.)
                row["original_render_seconds_including_session_load"] = perf_counter() - tick
                if original.model_session_mode != "original" or rate != 16000 or applied != 1.:
                    raise ValueError("Original path did not use exact expected inference settings")
            original.close()
            original = None
            gc.collect()
            with mode(family, True):
                shared = mms.MMSCarrier(folder, session_factory=open_shared)
                tick = perf_counter()
                second, rate, applied = shared.audio(text, noise_scale=0., noise_scale_w=0.)
                row["shared_render_seconds_including_guarded_activation"] = perf_counter() - tick
                if shared.model_session_mode != "shared-exact-weights" or rate != 16000 or applied != 1.:
                    raise ValueError("Shared path silently fell back or changed inference settings")
                view = shared.preload()
                if family_anchor is None:
                    family_anchor = view.family
                if view.family is not family_anchor or len(shared_opens) != 1:
                    raise ValueError("All selected languages did not reuse exactly one raw shared graph")
            row["native"] = parity(first, second)
            tick = perf_counter()
            first_projected, second_projected = project(first, source), project(second, source)
            row["projected"] = parity(first_projected, second_projected)
            row["projection_pair_seconds"] = perf_counter() - tick
            if audio_directory is not None:
                for name, audio, sample_rate in (
                        ("original-native", first, 16000), ("shared-native", second, 16000),
                        ("original-projected", first_projected, 22050), ("shared-projected", second_projected, 22050)):
                    write_audio(audio_directory, code + "-" + name, audio, sample_rate)
            family.assert_resources(identity)
            guard = row["native"]["numerical_guard_passed"] and row["projected"]["numerical_guard_passed"]
            exact = all(row[k]["float32_bitwise_equal"] and row[k]["pcm16_bitwise_equal"] for k in ("native", "projected"))
            row["status"] = "passed" if guard and (exact or not args.require_bit_exact) else "numerical-parity-failed"
        except Exception as error:
            row.update(status="failed", error_type=type(error).__name__, error=str(error))
        finally:
            if original is not None:
                original.close()
            if shared is not None:
                shared.close()
            original = shared = view = None
            # Do not retain per-language outputs/mappings in the evidence report.
            first = second = first_projected = second_projected = source = audio = None
            gc.collect()
        row["total_seconds"] = perf_counter() - started
        row["memory_after_language"] = memory()
        report["languages"].append(row)
        report["shared_raw_graph_instances"] = len(shared_opens)
        write_report(output, report)
        print(json.dumps({"code": code, "status": row["status"],
                          "native_max_lsb": row.get("native", {}).get("pcm16_max_lsb_difference"),
                          "projected_max_lsb": row.get("projected", {}).get("pcm16_max_lsb_difference")}), flush=True)
    complete = len(report["languages"]) == len(codes)
    rows = report["languages"]
    report["all_requested_numerical_guards_passed"] = complete and all(row["status"] == "passed" for row in rows)
    for kind, field in (("native", "all_requested_native_bitwise_equal"), ("projected", "all_requested_projected_bitwise_equal")):
        report[field] = complete and all(row.get(kind, {}).get("float32_bitwise_equal", False)
                                        and row.get(kind, {}).get("pcm16_bitwise_equal", False) for row in rows)
    changed = [path for path, expected in fingerprints.items() if digest(path) != expected]
    report["fingerprinted_inputs_unchanged"] = not changed
    report["changed_inputs"] = changed
    report["finished_utc"] = datetime.now(timezone.utc).isoformat()
    report["status"] = "passed" if report["all_requested_numerical_guards_passed"] and not changed else "failed"
    write_report(output, report)
    return 0 if report["status"] == "passed" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, default=DEFAULT_RUNTIME)
    parser.add_argument("--models", type=Path, required=True, help="Existing prepared directory containing all29 MMS language folders")
    parser.add_argument("--converter-models", type=Path, required=True, help="Existing OpenVoiceV2 directory containing encoder-flow.onnx and decoder.onnx")
    parser.add_argument("--target-embedding", type=Path, required=True, help="Existing registered permitted voice .npy file")
    parser.add_argument("--target-profile", "--target-voice", dest="target_profile", required=True,
                        help="Explicit permitted profile ID; future IDs are accepted without a fixed45-voice whitelist")
    parser.add_argument("--voice-references", type=Path,
                        help="Installed voice references root; verify active managed target_embedding through voice_assets")
    parser.add_argument("--target-metadata", type=Path,
                        help="Optional identity JSON; declared profile/checksum must match and blocked IDs are rejected")
    parser.add_argument("--shared-assets", type=Path, help="Existing pinned MMSShared directory; default is current runtime assets")
    parser.add_argument("--languages", default="all", help="all, or a distinct comma-separated audited subset; subset is never reported as all29")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--audio-directory", type=Path, help="Optional standalone PCM16 WAV evidence; existing directory requires --overwrite")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--require-bit-exact", action="store_true")
    parser.add_argument("--require-ort-version", choices=("1.27.0", "1.26.0"), default="1.27.0")
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
