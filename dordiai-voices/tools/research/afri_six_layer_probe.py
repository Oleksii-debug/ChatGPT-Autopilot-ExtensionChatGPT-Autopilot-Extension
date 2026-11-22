"""Isolated exact six-layer AfricaTTS FP32 export and Swati/Venda proof.

Never installs a product model. No quantization, pruning, training or distillation.
Acquisition, Torch export/parity and native Sherpa inference are separate phases.
"""
from __future__ import annotations
import argparse
from contextlib import redirect_stdout
from hashlib import sha256
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import runpy
import struct
import subprocess
import sys
from time import perf_counter

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("afri_pinned_common", HERE / "afri_sherpa_probe.py")
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
MODEL_REVISION = "d47667a3bb03d0d6db924e789648abd7d55d828b"
SOURCE_REVISION = "b4508ae979dd34eea2597d420d67176ef55a21a0"
POCKET_REVISION = "a922b912dfa366975294afb568d815b305acde5d"
G2P_REVISION = "76b53a8fa2a688812e369837d179d4710c111a7a"
CHECKPOINT_SHA256 = "b4cdf2cb62674145fe83ba661041d8180faa543ff9ae1906ae3bb59c9a03171c"
CHECKPOINT_BYTES = 438033312
TENSOR_ELEMENTS = 109502146
PINS = {
    "model.safetensors": {"bytes": CHECKPOINT_BYTES, "sha256": CHECKPOINT_SHA256},
    "config.yaml": {"bytes": 1065, "git_blob_sha1": "d61303e11d12422e5c56fcf72384d1e184ab115b"},
    "tokenizer.json": {"bytes": 247366, "git_blob_sha1": "51d1c05a9d0bbc98cbba81978eb4f30f803c6356"},
}
EXPORTER_BLOB = "17017c14a7ebd7c26341b7f9f4bb13dfc6fbc4fa"
PARITY_BLOB = "70271b1d5f69626650cca086fa735ec94722c683"
FORMAT = "dordiai-afri-six-layer-fp32-v1"


def git_head(path, expected):
    actual = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    if actual != expected:
        raise ValueError("Source checkout differs from immutable revision: " + str(path))
    return actual


def index_path(args):
    return args.cache.resolve() / "six-layer-source-index.json"


def header_facts(path):
    with Path(path).open("rb") as stream:
        size = struct.unpack("<Q", stream.read(8))[0]
        if not 2 <= size <= 2 * 1024 * 1024:
            raise ValueError("Invalid safetensors metadata size")
        header = json.loads(stream.read(size))
    layers, elements, dtypes = set(), 0, set()
    for name, row in header.items():
        if name == "__metadata__":
            continue
        count = 1
        for dimension in row["shape"]:
            if type(dimension) is not int or dimension < 0:
                raise ValueError("Invalid checkpoint shape")
            count *= dimension
        elements += count
        dtypes.add(row["dtype"])
        for matched in re.finditer(r"flow_lm[.]transformer[.]layers[.](\d+)", name):
            layers.add(int(matched.group(1)))
    facts = {"flow_lm_layer_ids": sorted(layers), "tensor_elements": elements, "tensor_dtypes": sorted(dtypes)}
    if facts != {"flow_lm_layer_ids": list(range(6)), "tensor_elements": TENSOR_ELEMENTS, "tensor_dtypes": ["F32"]}:
        raise ValueError("Published checkpoint is not the exact observed six-layer full-F32 model: " + repr(facts))
    return facts


def acquire(args):
    root = args.cache.resolve()
    root.mkdir(parents=True, exist_ok=True)
    metadata = common.read_json_url("https://huggingface.co/api/models/AfriSpeech/africa-tts/revision/" + MODEL_REVISION + "?blobs=true")
    if metadata.get("sha") != MODEL_REVISION:
        raise ValueError("Model revision did not resolve exactly")
    rows = {row["rfilename"]: row for row in metadata["siblings"]}
    index = {"format": FORMAT, "status": "acquiring", "repository": "AfriSpeech/africa-tts",
             "revision": MODEL_REVISION, "source_revision": SOURCE_REVISION,
             "pocket_revision": POCKET_REVISION, "g2p_revision": G2P_REVISION,
             "checkpoint_origin": "exact published full six-layer FP32 student; not our distillation",
             "our_quantization": False, "our_pruning": False, "our_training": False,
             "files": {}, "product_integrated": False}
    common.write_json(args.report, index, overwrite=args.overwrite)
    targets = dict(PINS)
    for code in common.LANGUAGES:
        path = "voices/" + code + ".wav"
        if path not in rows:
            path = "sherpa-onnx/voices/" + code + ".wav"
        if path not in rows:
            raise ValueError("Exact native-language reference absent: " + code)
        targets[path] = common.artifact_record(rows[path])
    for path in ("README.md", "LICENSE", "sherpa-onnx/voices/voices.json"):
        if path in rows:
            targets[path] = common.artifact_record(rows[path])
    for relative, expected in targets.items():
        target = root / "checkpoint" / relative
        common.download("https://huggingface.co/AfriSpeech/africa-tts/resolve/" + MODEL_REVISION + "/" + relative, target, expected)
        role = ("voice_" + Path(relative).stem) if relative.endswith(".wav") else relative
        index["files"][role] = dict(expected, path=str(target), raw_sha256=common.digest(target),
                                   repository_path=relative)
        common.write_json(args.report, index)
    for role, (relative, size, blob) in common.SOURCE_FILES.items():
        expected = {"bytes": size, "git_blob_sha1": blob}
        target = root / "primary" / role
        common.download("https://raw.githubusercontent.com/AfriSpeech/africa-tts/" + SOURCE_REVISION + "/" + relative,
                        target, expected)
        index["files"][role] = dict(expected, path=str(target), raw_sha256=common.digest(target))
    trained = json.loads(Path(index["files"]["languages.json"]["path"]).read_text())
    for code, info in common.LANGUAGES.items():
        if trained.get(code, {}).get("hours") != info["trained_hours"]:
            raise ValueError("Exact Swati/Venda trained-language metadata does not match")
    index["checkpoint_facts"] = header_facts(root / "checkpoint/model.safetensors")
    index["all_download_bytes"] = sum(row["bytes"] for row in index["files"].values())
    index["status"] = "verified-six-layer-published-f32-inputs"
    common.write_json(index_path(args), index)
    common.write_json(args.report, index)
    return index


def validated_index(args):
    index = json.loads(index_path(args).read_text())
    if index.get("format") != FORMAT or index.get("status") != "verified-six-layer-published-f32-inputs":
        raise ValueError("No verified exact six-layer source index")
    for row in index["files"].values():
        if not common.verify_file(row["path"], row) or common.digest(row["path"]) != row["raw_sha256"]:
            raise ValueError("Prepared input changed since acquisition")
    return index


def source_check(args):
    git_head(args.source.resolve(), SOURCE_REVISION)
    git_head(args.pocket_source.resolve(), POCKET_REVISION)
    exporter = args.source.resolve() / "export/onnx/export_onnx.py"
    parity = args.source.resolve() / "export/onnx/test_parity.py"
    for path, blob in ((exporter, EXPORTER_BLOB), (parity, PARITY_BLOB)):
        if not common.verify_file(path, {"bytes": path.stat().st_size, "git_blob_sha1": blob}):
            raise ValueError("Audited official exporter/parity source changed")
    return exporter, parity



def preflight(args):
    """Import the exact complete dependency chain before any model download."""
    exporter, parity_source = source_check(args)
    git_head(args.g2p_source.resolve(), G2P_REVISION)
    report = {"format": FORMAT, "status": "preflight-running", "model_weights_loaded": False,
              "model_resources_downloaded": False, "product_integrated": False}
    common.write_json(args.report, report, overwrite=args.overwrite)
    report["network_guard"] = common.deny_native_network()
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1", CUDA_VISIBLE_DEVICES="")
    sys.path.insert(0, str(args.pocket_source.resolve()))
    sys.path.insert(0, str(exporter.parent))
    sys.path.insert(0, str(args.g2p_source.resolve() / "src"))
    import onnxruntime as ort
    ort.disable_telemetry_events()
    if ort.__version__ != "1.27.0":
        raise ValueError("Preflight requires safe pinned ORT1.27.0")
    import torch
    import onnx
    import safetensors
    import sentencepiece
    import tokenizers
    import yaml
    import numpy
    import scipy
    import soundfile
    from pocket_tts import TTSModel
    from africa_g2p import g2p
    # run_name deliberately differs from __main__: imports and definitions only.
    namespace = runpy.run_path(str(exporter), run_name="dordiai_export_import_preflight")
    parity = runpy.run_path(str(parity_source), run_name="dordiai_parity_import_preflight")
    if namespace["TTSModel"] is not TTSModel or "main" not in parity or torch.version.cuda is not None:
        raise ValueError("Unexpected source import or non-CPU Torch distribution")
    if any(name in sys.modules for name in ("torchaudio", "torchao", "sherpa_onnx")):
        raise ValueError("Unexpected optional or native-runtime co-load")
    report.update(status="offline-import-preflight-passed", torch_version=torch.__version__,
                  onnxruntime_version=ort.__version__, official_exporter_imported=True,
                  official_parity_imported=True, full_tts_model_imported=True,
                  source_pocket_sha=POCKET_REVISION, source_exporter_blob=EXPORTER_BLOB,
                  loaded_external_packages={name: str(getattr(sys.modules[name], "__version__", "unreported"))
                                            for name in ("numpy", "scipy", "soundfile", "yaml", "onnx", "safetensors",
                                                         "sentencepiece", "tokenizers")})
    common.write_json(args.report, report)
    return report


def export(args):
    index = validated_index(args)
    exporter, _ = source_check(args)
    out = args.output.resolve()
    if out.exists() and any(out.iterdir()):
        raise FileExistsError("Derived graph directory must be fresh")
    out.mkdir(parents=True, exist_ok=True)
    report = {"format": FORMAT, "status": "export-running", "source_index": index,
              "official_exporter_blob": EXPORTER_BLOB, "official_pocket_revision": POCKET_REVISION,
              "our_quantization": False, "our_pruning": False, "our_training": False,
              "product_integrated": False}
    common.write_json(args.report, report, overwrite=args.overwrite)
    report["network_guard"] = common.deny_native_network()
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1", CUDA_VISIBLE_DEVICES="")
    sys.path.insert(0, str(args.pocket_source.resolve()))
    import torch
    import yaml
    torch.set_num_threads(2)
    config = yaml.safe_load((args.cache.resolve() / "checkpoint/config.yaml").read_text())
    if config["flow_lm"]["transformer"]["num_layers"] != 6:
        raise ValueError("Pinned native config does not specify six FlowLM layers")
    started = perf_counter()
    sys.argv = [str(exporter), "--model-dir", str(args.cache.resolve() / "checkpoint"), "--out-dir", str(out)]
    runpy.run_path(str(exporter), run_name="__main__")
    report["export_seconds"] = perf_counter() - started
    import onnx
    files = {}
    for role in common.ROLES:
        path = out / (role + ".onnx")
        facts = common.graph_facts(path)
        model = onnx.load(str(path), load_external_data=False)
        forbidden = {"QuantizeLinear", "DequantizeLinear", "DynamicQuantizeLinear", "MatMulInteger", "QLinearMatMul", "QLinearConv"}
        if any(node.op_type in forbidden for node in model.graph.node):
            raise ValueError("Unexpected quantized operators in full-FP32 export")
        float_types = {onnx.TensorProto.FLOAT16, onnx.TensorProto.BFLOAT16, onnx.TensorProto.DOUBLE}
        if any(value.data_type in float_types for value in model.graph.initializer):
            raise ValueError("Unexpected reduced or different floating precision in official FP32 export")
        del model
        if role == "lm_main" and facts["observed_layer_ids_from_weight_names"] != list(range(6)):
            raise ValueError("Exported FlowLM graph does not expose exactly six actual layers")
        files[role] = {"path": str(path), "bytes": path.stat().st_size, "sha256": common.digest(path),
                       "derived_from_checkpoint_sha256": CHECKPOINT_SHA256, "facts": facts}
    for role in ("vocab", "token_scores"):
        path = out / (role + ".json")
        json.loads(path.read_text())
        files[role + "_json"] = {"path": str(path), "bytes": path.stat().st_size, "sha256": common.digest(path)}
    report.update(status="exported-six-layer-fp32", exported_files=files,
                  derived_graph_bytes=sum(x["bytes"] for x in files.values()),
                  original_inputs_unchanged=all(common.digest(x["path"]) == x["raw_sha256"] for x in index["files"].values()))
    common.write_json(out / "dordiai-export-provenance.json", report)
    common.write_json(args.report, report)
    return report


def parity(args):
    index = validated_index(args)
    _, path = source_check(args)
    git_head(args.g2p_source.resolve(), G2P_REVISION)
    report = {"format": FORMAT, "status": "parity-running", "product_integrated": False,
              "official_parity_blob": PARITY_BLOB, "cases": []}
    common.write_json(args.report, report, overwrite=args.overwrite)
    report["network_guard"] = common.deny_native_network()
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1", CUDA_VISIBLE_DEVICES="")
    sys.path.insert(0, str(args.pocket_source.resolve()))
    sys.path.insert(0, str(path.parent))
    sys.path.insert(0, str(args.g2p_source.resolve() / "src"))
    import onnxruntime as ort
    ort.disable_telemetry_events()
    if ort.__version__ != "1.27.0":
        raise ValueError("Only isolated official ORT1.27.0 is accepted for exporter parity")
    from africa_g2p import g2p
    cases = common.select_cases(Path(index["files"]["parity_set.tsv"]["path"]).read_text(), 1)
    for row in cases:
        ipa = g2p(row["text"], row["language"], output="ipa")
        if ipa != row["expected_training_ipa"]:
            raise ValueError("G2P differs from exact training fixture")
        captured = io.StringIO()
        sys.argv = [str(path), "--model-dir", str(args.cache.resolve() / "checkpoint"),
                    "--onnx-dir", str(args.output.resolve()), "--voice", index["files"]["voice_" + row["language"]]["path"],
                    "--text", ipa]
        started = perf_counter()
        with redirect_stdout(captured):
            runpy.run_path(str(path), run_name="__main__")
        log = captured.getvalue()
        print(log, flush=True)
        metrics = []
        for line in log.splitlines():
            match = re.match(r"^\s+(.+?)\s+([0-9.+-]+e[+-]\d+)\s+\(ref max ([0-9.+-]+)\)", line)
            if match:
                metrics.append({"component": match[1].strip(), "max_abs_diff": float(match[2]), "reference_abs_max": float(match[3])})
        snr = re.search(r"decoder SNR vs torch: ([0-9.+-]+) dB", log)
        if len(metrics) != 6 or snr is None:
            raise ValueError("Primary parity report did not contain all six expected component observations")
        # A diagnostic source script prints numbers but has no numeric assertions.
        # Keep the measurements and an explicit separate conservative acceptance.
        accepted = all(item["max_abs_diff"] <= 0.01 + 0.01 * item["reference_abs_max"] for item in metrics) and float(snr[1]) >= 35
        report["cases"].append(dict(row, seconds=perf_counter() - started, metrics=metrics,
                                     decoder_snr_db=float(snr[1]), conservative_numeric_acceptance=accepted,
                                     unmodified_primary_stdout=log))
        common.write_json(args.report, report)
    report["conservative_numeric_acceptance"] = all(x["conservative_numeric_acceptance"] for x in report["cases"])
    report["acceptance_rule"] = "All six component max_abs_diff <=0.01+0.01*reference_abs_max and same-latent decoder SNR>=35dB; fixed before observations."
    report["status"] = "parity-measured"
    common.write_json(args.report, report)
    return report


def native(args):
    index = validated_index(args)
    git_head(args.g2p_source.resolve(), G2P_REVISION)
    provenance = json.loads((args.output.resolve() / "dordiai-export-provenance.json").read_text())
    if provenance.get("status") != "exported-six-layer-fp32" or not provenance.get("original_inputs_unchanged"):
        raise ValueError("No successful exact native six-layer FP32 export")
    for row in provenance["exported_files"].values():
        if common.digest(row["path"]) != row["sha256"]:
            raise ValueError("Derived graph/tokenizer changed since export")
    report = {"format": FORMAT, "status": "native-running", "product_integrated": False,
              "native_listener_verified": False, "native_pronunciation_verified": False,
              "typing_or_character_names_verified": False, "selected_voice_projection_verified": False,
              "nvda_or_windows_verified": False, "source_index": index, "export_provenance": provenance, "cases": []}
    common.write_json(args.report, report, overwrite=args.overwrite)
    report["network_guard"] = common.deny_native_network()
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1", CUDA_VISIBLE_DEVICES="")
    sys.path.insert(0, str(args.g2p_source.resolve() / "src"))
    import numpy as np
    import sherpa_onnx
    import soundfile as sf
    import resource
    from africa_g2p import g2p
    if sherpa_onnx.__version__ != "2.0.1" or "torch" in sys.modules or "onnxruntime" in sys.modules:
        raise ValueError("Native-only official Sherpa2.0.1 process required; no Torch/PythonORT co-load")
    report["native_runtime"] = {key: str(getattr(sherpa_onnx, key)() if callable(getattr(sherpa_onnx, key)) else getattr(sherpa_onnx, key))
                                for key in ("git_sha1", "git_date", "onnxruntime_version")}
    paths = {role: provenance["exported_files"][role]["path"] for role in common.ROLES + ("vocab_json", "token_scores_json")}
    cfg = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        pocket=sherpa_onnx.OfflineTtsPocketModelConfig(**paths), num_threads=2, provider="cpu"))
    if not cfg.validate():
        raise ValueError("Official native Pocket configuration did not validate")
    started = perf_counter()
    engine = sherpa_onnx.OfflineTts(cfg)
    report["engine_load_seconds"] = perf_counter() - started
    audio_folder = args.report.resolve().parent / "audio"
    audio_folder.mkdir(parents=True, exist_ok=True)
    cases = common.select_cases(Path(index["files"]["parity_set.tsv"]["path"]).read_text(), 3)
    for position, row in enumerate(cases):
        ipa = g2p(row["text"], row["language"], output="ipa")
        if ipa != row["expected_training_ipa"]:
            raise ValueError("Native frontend differs from exact training IPA")
        ref, sr = sf.read(index["files"]["voice_" + row["language"]]["path"], dtype="float32", always_2d=True)
        ref = ref.mean(axis=1)
        if not np.isfinite(ref).all() or len(ref) < 512:
            raise ValueError("Invalid same-language reference")
        generation = sherpa_onnx.GenerationConfig()
        generation.reference_audio, generation.reference_sample_rate = ref, int(sr)
        generation.num_steps, generation.silence_scale = 1, 1.
        generation.extra = {"temperature": "0.3", "seed": "42"}
        started = perf_counter()
        result = engine.generate(ipa, generation)
        elapsed = perf_counter() - started
        audio = np.asarray(result.samples, np.float32)
        rate = int(result.sample_rate)
        if rate != 24000 or audio.ndim != 1 or len(audio) < 2400 or not np.isfinite(audio).all():
            raise ValueError("Invalid genuine native waveform")
        peak, rms = float(np.max(np.abs(audio))), float(np.sqrt(np.mean(audio ** 2)))
        if peak < 1e-5 or rms < 1e-6:
            raise ValueError("Silent native waveform")
        target = audio_folder / (row["language"] + "-" + str(position) + ".wav")
        if target.exists() or target.is_symlink():
            raise FileExistsError("Refusing existing native WAV")
        with target.open("xb") as stream:
            sf.write(stream, audio, rate, format="WAV", subtype="PCM_16")
        item = dict(row, ipa=ipa, wav_file=str(target), wav_sha256=common.digest(target),
                    seconds=len(audio) / rate, samples=len(audio), sample_rate=rate,
                    inference_seconds=elapsed, real_time_factor=elapsed / (len(audio) / rate),
                    peak=peak, rms=rms, pcm_clip_fraction=float(np.mean(np.abs(audio) >= 1.)),
                    reference_sha256=index["files"]["voice_" + row["language"]]["raw_sha256"])
        report["cases"].append(item)
        report["process_peak_rss_bytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
        common.write_json(args.report, report)
        print(json.dumps({key: item[key] for key in ("language", "seconds", "inference_seconds", "real_time_factor")}), flush=True)
    report.update(status="six-layer-fp32-native-candidate-unintegrated", all_cases_passed=len(report["cases"]) == 6,
                  exact_training_frontend_parity=True, runtime_versions={"sherpa_onnx": sherpa_onnx.__version__})
    common.write_json(args.report, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("acquire", "preflight", "export", "parity", "native"))
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--pocket-source", type=Path)
    parser.add_argument("--g2p-source", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    for name in (("source", "pocket_source", "g2p_source") if args.phase == "preflight" else
                 ("source", "pocket_source", "output") if args.phase == "export" else
                 ("source", "pocket_source", "g2p_source", "output") if args.phase == "parity" else
                 ("g2p_source", "output") if args.phase == "native" else ()):
        if getattr(args, name) is None:
            parser.error("--" + name.replace("_", "-") + " required")
    protected = [args.cache.resolve()] + ([args.output.resolve()] if args.output else [])
    if args.report.is_symlink() or args.report.exists() and not args.overwrite:
        parser.error("Refusing existing report")
    if any(args.report.resolve().is_relative_to(path) for path in protected):
        parser.error("Report must be outside acquired/derived model folders")
    try:
        return globals()[args.phase](args) and 0
    except Exception as error:
        previous = json.loads(args.report.read_text()) if args.report.is_file() else {}
        previous.update(status="failed", error_type=type(error).__name__, error=str(error), product_integrated=False)
        common.write_json(args.report, previous)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
