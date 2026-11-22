"""Prepare pinned native Coqui Igbo/Lingala ONNX resources without PyTorch."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import platform
import sys
import time

from prepare_mms_models import download, digest, write_json, smoke_text

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
DEFAULT_ROOT = ROOT / "model-packs/coqui/kx47Runtime/models/ExtraLanguages"
SAMPLES = {"ig": "Ndị obodo niile nke Obodo Vatican bụ Roman Katọlik."}
# Igbo sample is the publisher's model-card example (FLORES sentence), not a
# translation invented by this tool. Lingala falls back to a labelled probe.


def prepare(code, record, *, output, evidence, encoder_path, encoder):
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
    import soundfile as sf
    if str(RUNTIME) not in sys.path:
        sys.path.insert(0, str(RUNTIME))
    from wide_coqui_onnx import NativeCoqui
    from prepare_reference_encoder import extract_embedding
    folder = output / code
    for name, asset in record["assets"].items():
        download(asset, folder / name, offline=True)
    config = json.loads((folder / "config.json").read_text(encoding="utf8"))
    runtime = {"format": "dordiai-coqui-onnx-v1", "backend": "extra-onnx", "code": code,
               "iso_code": {"ig": "ibo", "ln": "lin"}[code], "sample_rate": config["audio"]["sample_rate"],
               "repo_id": record["repo_id"], "revision": record["revision"], "license": record["license"],
               "model_sha256": digest(folder / "model.onnx"), "config_sha256": digest(folder / "config.json"),
               "navigation_verified": False, "native_pronunciation_verified": False, "windows_nvda_verified": False}
    write_json(folder / "runtime_config.json", runtime)
    started = time.monotonic()
    carrier = NativeCoqui(folder)
    graph = carrier.preload()
    load_seconds = time.monotonic() - started
    text = SAMPLES.get(code) or smoke_text(config["phoneme_id_map"])
    started = time.monotonic()
    audio = carrier.audio(text, noise_scale=0., noise_scale_w=0.)
    inference_seconds = time.monotonic() - started
    evidence.mkdir(parents=True, exist_ok=True)
    waveform = evidence / (code + "-native-carrier.wav")
    sf.write(str(waveform), audio, carrier.rate, subtype="PCM_16")
    # Read back the exact pinned PCM bytes used for enrollment so the saved WAV
    # can independently reproduce source.npy without re-running stochastic TTS.
    enrollment, rate = sf.read(str(waveform), dtype="float32")
    embedding = extract_embedding(enrollment, int(rate), encoder)
    np.save(folder / "source.npy", embedding, allow_pickle=False)
    identity = {"source_sha256": digest(folder / "source.npy"), "reference_wav_sha256": digest(waveform),
                "encoder_sha256": digest(encoder_path), "basis": "actual-same-native-coqui-carrier-pcm16-waveform",
                "source_shape": list(embedding.shape), "source_dtype": str(embedding.dtype),
                "source_norm": float(np.linalg.norm(embedding)), "unit_normalized": False}
    runtime.update(source_identity=identity, technical_onnx_inference_verified=True)
    write_json(folder / "runtime_config.json", runtime)
    (folder / "NOTICE.txt").write_text(
        "Native Coqui/VITS grapheme model. " + record["repo_id"] + " @ " + record["revision"] + "\n"
        "Original training: multilingual-tts / Coqui, OpenBible resources.\n"
        "ONNX conversion: TigreGotico / Phoonnx. License: CC BY-SA 4.0.\n"
        "https://creativecommons.org/licenses/by-sa/4.0/\n"
        "Keep the included upstream README.md and its attribution/model-card links.\n"
        "Source identity measured from this actual carrier with the compatible FP32 OpenVoice V2 encoder.\n"
        "Technical waveform/source checks do not establish native pronunciation, character names or NVDA acceptance.\n", encoding="utf8")
    result = dict(runtime, status="prepared-real-onnx-carrier", model_bytes=(folder / "model.onnx").stat().st_size,
                  probe={"text": text, "kind": "publisher-native-sentence" if code in SAMPLES else "native-grapheme-smoke-test",
                         "audio_seconds": len(audio) / carrier.rate, "samples": len(audio),
                         "peak": float(np.max(np.abs(audio))), "rms": float(np.sqrt(np.mean(audio ** 2))),
                         "graph_load_seconds": load_seconds, "graph_inference_seconds": inference_seconds,
                         "real_time_factor": inference_seconds / (len(audio) / carrier.rate),
                         "inputs": [{"name": item.name, "type": item.type, "shape": item.shape} for item in graph.get_inputs()]})
    carrier.close()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--download-only", action="store_true")
    mode.add_argument("--offline-verify", action="store_true")
    parser.add_argument("--languages", default="ig,ln")
    parser.add_argument("--index", type=Path, default=ROOT / "tools/coqui_model_sources.json")
    parser.add_argument("--output", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--audio-evidence", type=Path, default=ROOT / "evidence/coqui_audio")
    parser.add_argument("--reference-encoder", type=Path, default=ROOT / "model-packs/shared-reference/kx47Runtime/models/OpenVoiceV2/tone_ref_encoder.onnx")
    parser.add_argument("--require-ort-version", default="1.27.0")
    parser.add_argument("--report", type=Path, default=ROOT / "evidence/coqui_preparation.json")
    args = parser.parse_args()
    index = json.loads(args.index.read_text(encoding="utf8"))
    if index.get("format") != "dordiai-coqui-sources-v1":
        parser.error("Unsupported native Coqui source index")
    selected = list(dict.fromkeys(args.languages.split(",")))
    if not selected or any(code not in index["models"] for code in selected):
        parser.error("Unknown native Coqui language selection")
    report = {"format": "dordiai-coqui-preparation-v1", "platform": platform.platform(),
              "mode": "download-only" if args.download_only else "offline-verification", "models": {},
              "windows_nvda_verified": False}
    encoder = None
    if args.offline_verify:
        import onnxruntime as ort
        ort.disable_telemetry_events()
        if ort.__version__ != args.require_ort_version:
            parser.error("ONNX Runtime differs from the explicitly selected offline build")
        from prepare_reference_encoder import ENCODERS, load_encoder
        if digest(args.reference_encoder) != ENCODERS["fp32"]["sha256"]:
            parser.error("Native source identity requires the compatible pinned FP32 reference encoder")
        encoder = load_encoder(args.reference_encoder)
        report.update(onnxruntime_version=ort.__version__, onnxruntime_module=str(ort.__file__),
                      ort_telemetry_disabled=True, model_downloads_made=False)
    for code in selected:
        record = index["models"][code]
        if args.download_only:
            for name, asset in record["assets"].items():
                download(asset, args.output / code / name)
            result = {"code": code, "status": "downloaded-pinned-artifacts", "models_executed": False}
        else:
            result = prepare(code, record, output=args.output, evidence=args.audio_evidence,
                             encoder_path=args.reference_encoder, encoder=encoder)
        report["models"][code] = result
        args.report.parent.mkdir(parents=True, exist_ok=True)
        write_json(args.report, report)
        print(json.dumps({"code": code, "status": result["status"], "probe": result.get("probe")}, ensure_ascii=False), flush=True)
    report["all_selected_prepared"] = args.offline_verify and len(report["models"]) == len(selected)
    write_json(args.report, report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
