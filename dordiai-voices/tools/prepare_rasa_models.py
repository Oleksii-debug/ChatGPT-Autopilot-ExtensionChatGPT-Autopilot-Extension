#!/usr/bin/env python3
"""Prepare public pinned BRX Rasa ONNX; no original gated files or Torch needed."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "model-packs/rasa/kx47Runtime/models/SharedRasaONNX"
DEFAULT_ENCODER = ROOT / "model-packs/shared-reference/kx47Runtime/models/OpenVoiceV2/tone_ref_encoder.onnx"
REFERENCE_TEXT = "खुलुमबाय। खुलुमबाय। खुलुमबाय। खुलुमबाय।"


def prepare(output=DEFAULT_OUTPUT, verify_only=False):
    output = Path(output)
    source = json.loads(Path(__file__).with_name("rasa_model_sources.json").read_text(encoding="utf-8"))
    spec = importlib.util.spec_from_file_location("_rasa_pinned_download", Path(__file__).with_name("prepare_extra_models.py"))
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    output.mkdir(parents=True, exist_ok=True)
    records = [helper.fetch_one(source["repository"], source["revision"], name, record,
                               output / name, verify_only) for name, record in source["files"].items()]
    configuration = {"format": "dordiai-rasa-onnx-v1", "frontend": "native-characters", "sample_rate": 24000,
                     "minimum_core_version": source["minimum_core_version"],
                     "languages": source["primary_model"]["adopted_languages"], "provenance": source,
                     "native_pronunciation_verified": False, "navigation_verified": False, "windows_nvda_verified": False}
    existing = output / "config.json"
    if existing.is_file():
        try:
            old = json.loads(existing.read_text(encoding="utf-8"))
            if old.get("provenance", {}).get("revision") == source["revision"] and old.get("source_identity"):
                configuration["source_identity"] = old["source_identity"]
        except (ValueError, UnicodeError):
            pass
    existing.write_text(json.dumps(configuration, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "NOTICE.txt").write_text(
        "AI4Bharat VITS Rasa13 by Ashwin Sankar, CC-BY-4.0.\n"
        "Primary: https://huggingface.co/ai4bharat/vits_rasa_13\n"
        "Public ONNX export: https://huggingface.co/MatiasLin/sherpa-onnx-vits-rasa-13\n"
        "Pinned public graph revision: " + source["revision"] + "\n"
        "Exporter tooling by matiaslin, MIT; immutable code revision is in config.json.\n"
        "Only documented BRX_F speaker4, ALEXA style0 is registered. This is not a claim "
        "of1024trained speakers,32verified emotions, neutral-style control, or Manipuri support.\n"
        "Original gated files were not accessed. All graph bytes came from the public publisher export.\n"
        "Actual graph rate24000Hz overrides inaccurate README22050Hz.\n"
        "Pronunciation, ordinary alphabet names and NVDA acceptance remain unverified.\n", encoding="utf-8")
    return {"folder": str(output), "files": records, "registered_languages": ["brx"], "manipuri_supported": False}


def verify(output=DEFAULT_OUTPUT, encoder=DEFAULT_ENCODER, text=REFERENCE_TEXT):
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
    import soundfile as sf
    if ort.__version__ != "1.27.0":
        raise ValueError("Offline preparation requires the pinned safe ORT1.27.0")
    sys.path.insert(0, str(ROOT / "source/0.12.2/kx47Runtime"))
    sys.path.insert(0, str(ROOT / "tools"))
    from wide_rasa import RasaEngine
    from prepare_reference_encoder import file_hash, extract_embedding, ENCODERS
    if file_hash(encoder) != ENCODERS["fp32"]["sha256"]:
        raise ValueError("Use the compatible pinned FP32 OpenVoice reference encoder")
    output = Path(output)
    started = perf_counter()
    engine = RasaEngine(output)
    load = perf_counter() - started
    try:
        started = perf_counter()
        wave = engine.audio("brx", text)
        elapsed = perf_counter() - started
        identity = extract_embedding(wave, 24000, encoder)
        reference = output / "references/brx"
        reference.mkdir(parents=True, exist_ok=True)
        sf.write(str(reference / "native-probe.wav"), wave, 24000, subtype="FLOAT")
        np.save(reference / "source.npy", identity, allow_pickle=False)
        proof = {"format": "dordiai-rasa-preparation-v1", "language": "brx", "native_script": "Deva",
                 "speaker_id": 4, "source_speaker": "BRX_F", "style_id": 0, "source_style": "ALEXA",
                 "model_sha256": file_hash(output / "model.onnx"), "tokens_sha256": file_hash(output / "tokens.txt"),
                 "source_audio_sha256": file_hash(reference / "native-probe.wav"), "text": text,
                 "sample_rate": 24000, "samples": len(wave), "seconds": len(wave) / 24000,
                 "peak": float(np.abs(wave).max()), "finite": bool(np.isfinite(wave).all()),
                 "load_seconds": load, "render_seconds": elapsed, "real_time_factor": elapsed / (len(wave) / 24000),
                 "source_sha256": file_hash(reference / "source.npy"), "source_shape": list(identity.shape),
                 "source_norm": float(np.linalg.norm(identity)), "unit_normalized": False,
                 "encoder_sha256": file_hash(encoder), "onnxruntime": ort.__version__, "ort_telemetry_disabled": True,
                 "model_downloads_made": False, "native_pronunciation_verified": False,
                 "navigation_verified": False, "windows_nvda_verified": False, "manipuri_supported": False}
        configuration = json.loads((output / "config.json").read_text(encoding="utf-8"))
        configuration["source_identity"] = {"brx": proof}
        (output / "config.json").write_text(json.dumps(configuration, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (ROOT / "evidence/rasa_preparation_brx.json").write_text(json.dumps(proof, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return proof
    finally:
        engine.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--download-only", action="store_true")
    modes.add_argument("--offline-verify", action="store_true")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--reference-encoder", type=Path, default=DEFAULT_ENCODER)
    args = parser.parse_args()
    result = prepare(args.output, verify_only=args.offline_verify)
    if args.offline_verify:
        result["probe"] = verify(args.output, args.reference_encoder)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
