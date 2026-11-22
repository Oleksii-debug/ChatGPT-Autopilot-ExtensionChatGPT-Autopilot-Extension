#!/usr/bin/env python3
"""Prepare the pinned actual Sesotho Simba ONNX carrier, without PyTorch."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "model-packs/extra-onnx/kx47Runtime/models/ExtraLanguages"
DEFAULT_ENCODER = ROOT / "model-packs/shared-reference/kx47Runtime/models/OpenVoiceV2/tone_ref_encoder.onnx"
PROBES = {"st": "Baahi bohle ba Toropo ya Vatican ke Roma.", "xh": "Molo. Unjani namhlanje?"}


def prepare(output=None, precision="fp32", verify_only=False, code="st"):
    output = Path(output) if output is not None else DEFAULT_OUTPUT / code
    index = json.loads(Path(__file__).with_name("simba_model_sources.json").read_text(encoding="utf-8"))
    specification = index["models"][code]
    spec = importlib.util.spec_from_file_location("_simba_pinned_fetch", Path(__file__).with_name("prepare_extra_models.py"))
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    output.mkdir(parents=True, exist_ok=True)
    graph = "model_int8.onnx" if precision == "int8" else "model.onnx"
    previous_hash = helper.digests(output / "model.onnx")[0] if (output / "model.onnx").is_file() else None
    records = []
    for family in ("conversion", "upstream"):
        source = specification[family]
        for name, record in source["files"].items():
            if family == "conversion" and name.endswith(".onnx") and name != graph:
                continue
            destination = ("model.onnx" if name == graph else name) if family == "conversion" else "upstream-" + name
            records.append({**helper.fetch_one(source["repository"], source["revision"], name, record,
                                               output / destination, verify_only), "local_file": destination})
    if previous_hash != specification["conversion"]["files"][graph]["sha256"]:
        (output / "source.npy").unlink(missing_ok=True)
    runtime = {"format": "dordiai-simba-onnx-v1", "code": code, "iso_code": specification["iso_code"], "sample_rate": 16000,
               "precision": precision, "frontend": "transformers-vits-graphemes", "source_identity_prepared": (output / "source.npy").is_file(),
               "native_pronunciation_verified": False, "navigation_verified": False, "windows_nvda_verified": False,
               "provenance": specification}
    (output / "runtime_config.json").write_text(json.dumps(runtime, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "NOTICE.txt").write_text(
        specification["name_uk"] + " (" + specification["iso_code"] + "), " + specification["upstream"]["repository"] + ", ONNX conversion by Phoonnx/TigreGotico.\n"
        "See pinned source metadata in runtime_config.json and both upstream/conversion README files.\n"
        "Upstream and conversion tags declare CC-BY-4.0, but the conversion author expressly notes the "
        "MMS base checkpoint has CC-BY-NC-4.0 and this fine-tuned voice cannot be used commercially.\n"
        "The deterministic tokenizer port follows Hugging Face Transformers v4.45.1 (Apache-2.0).\n"
        "Any differing upstream tokenizer language hint is retained as metadata, not used to relabel the actual acoustic checkpoint.\n"
        "These are actual separate language checkpoints. Acoustic and NVDA acceptance remain unverified.\n", encoding="utf-8")
    return {"folder": str(output), "precision": precision, "files": records, "source_identity_prepared": (output / "source.npy").is_file()}


def verify_carrier(output, encoder=DEFAULT_ENCODER, text=None, require_ort_version="1.27.0"):
    """Execute only local, already pinned graphs; calibrate from the same carrier."""
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
    import soundfile as sf
    if ort.__version__ != require_ort_version:
        raise ValueError("Use the pinned safe ONNX Runtime " + require_ort_version)
    sys.path.insert(0, str(ROOT / "source/0.12.2/kx47Runtime"))
    sys.path.insert(0, str(ROOT / "tools"))
    from wide_simba import NativeSimba
    from prepare_reference_encoder import ENCODERS, extract_embedding, file_hash
    if file_hash(encoder) != ENCODERS["fp32"]["sha256"]:
        raise ValueError("Source calibration requires the pinned compatible FP32 reference encoder")
    output = Path(output)
    runtime = json.loads((output / "runtime_config.json").read_text(encoding="utf-8"))
    code = runtime["code"]
    text = text or PROBES[code]
    started = perf_counter()
    engine = NativeSimba(output)
    loaded = perf_counter() - started
    try:
        started = perf_counter()
        wave = engine.audio(text)
        elapsed = perf_counter() - started
        identity = extract_embedding(wave, engine.rate, encoder)
        sf.write(str(output / "native-probe.wav"), wave, engine.rate, subtype="FLOAT")
        np.save(output / "source.npy", identity, allow_pickle=False)
        result = {"language": code, "iso_code": runtime["iso_code"], "precision": runtime["precision"],
                  "graph_sha256": file_hash(output / "model.onnx"), "text": text, "sample_rate": engine.rate,
                  "samples": len(wave), "seconds": len(wave) / engine.rate, "finite": bool(np.isfinite(wave).all()),
                  "peak": float(np.abs(wave).max()), "load_seconds": loaded, "render_seconds": elapsed,
                  "real_time_factor": elapsed / (len(wave) / engine.rate), "source_identity_shape": list(identity.shape),
                  "source_identity_norm": float(np.linalg.norm(identity)), "source_identity_sha256": file_hash(output / "source.npy"),
                  "source_audio_sha256": file_hash(output / "native-probe.wav"), "encoder_sha256": file_hash(encoder),
                  "onnxruntime": ort.__version__, "ort_telemetry_disabled": True, "model_downloads_made": False,
                  "native_pronunciation_verified": False, "navigation_verified": False, "windows_nvda_verified": False}
        runtime.update(source_identity_prepared=True, technical_onnx_inference_verified=True,
                       source_identity=result)
        (output / "runtime_config.json").write_text(json.dumps(runtime, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (ROOT / "evidence" / ("simba_preparation_" + code + ".json")).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return result
    finally:
        engine.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--language", choices=("st", "xh"), default="st")
    parser.add_argument("--precision", choices=("fp32", "int8"), default="fp32")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--render-probe", action="store_true", help="Run local graphs and derive the actual source.npy from this carrier")
    parser.add_argument("--reference-encoder", type=Path, default=DEFAULT_ENCODER)
    parser.add_argument("--probe-text")
    args = parser.parse_args()
    result = prepare(args.output, args.precision, args.verify_only, args.language)
    if args.render_probe:
        if not args.verify_only:
            parser.error("Use --verify-only --render-probe so inference never downloads models")
        result["probe"] = verify_carrier(result["folder"], args.reference_encoder, args.probe_text)
        result["source_identity_prepared"] = True
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
