"""Acquire pinned native-script MMS ONNX carriers and measure their source voice.

No PyTorch, online synthesis, translation API, or substituted language is used.
Optional resources are staged outside the recovered baseline. Technical CPU
inference is verified; native pronunciation/NVDA acceptance remains separate.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from hashlib import sha1, sha256
import importlib.util
import json
import os
from pathlib import Path
import platform
import sys
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
DEFAULT_OUTPUT = ROOT / "model-packs/mms/kx47Runtime/models/MMS"
DEFAULT_INDEX = ROOT / "tools/mms_model_sources.json"
DEFAULT_ENCODER = ROOT / "model-packs/shared-reference/kx47Runtime/models/OpenVoiceV2/tone_ref_encoder.onnx"


def digest(path):
    result = sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def verified(path, record):
    path = Path(path)
    if not path.is_file() or path.stat().st_size != record["bytes"]:
        return False
    if record.get("sha256"):
        return digest(path) == record["sha256"]
    blob = sha1(("blob " + str(record["bytes"])).encode("ascii") + b"\0")
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            blob.update(chunk)
    return blob.hexdigest() == record["git_blob_sha1"]


def download(record, target, *, offline=False):
    target = Path(target)
    if target.is_symlink():
        raise ValueError("MMS destination must not be a symlink")
    target.parent.mkdir(parents=True, exist_ok=True)
    if verified(target, record):
        return target
    if offline:
        raise FileNotFoundError("Offline MMS verification requires a previously downloaded pinned artifact: " + str(target))
    if not record["url"].startswith("https://huggingface.co/") or record["bytes"] > 200 * 1024 * 1024:
        raise ValueError("Unexpected MMS source or model size")
    temporary = target.with_name(target.name + ".download")
    for attempt in range(3):
        try:
            request = Request(record["url"], headers={"User-Agent": "dordiai-voices-model-preparation"})
            count = 0
            with urlopen(request, timeout=60) as source, temporary.open("wb") as destination:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    count += len(chunk)
                    if count > record["bytes"]:
                        raise ValueError("MMS download exceeds pinned size")
                    destination.write(chunk)
                destination.flush()
                os.fsync(destination.fileno())
            if not verified(temporary, record):
                raise ValueError("MMS artifact differs from its pinned digest or length")
            temporary.replace(target)
            return target
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(1 + attempt)
        finally:
            if temporary.exists():
                temporary.unlink()
    raise RuntimeError("MMS artifact download did not complete")


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def smoke_text(tokens):
    # This tests graph/token compatibility only. It is deliberately labelled a
    # grapheme probe, not a translated sentence or proof of native pronunciation.
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


def write_json(path, document):
    Path(path).write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


def prepare_one(code, record, *, index, output, encoder_path, encoder_session, evidence, sample_text=None, offline=True):
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
    import soundfile as sf
    if str(RUNTIME) not in sys.path:
        sys.path.insert(0, str(RUNTIME))
    import wide_mms
    from prepare_reference_encoder import extract_embedding

    directory = Path(output) / code
    directory.mkdir(parents=True, exist_ok=True)
    model = download(record["assets"]["model.onnx"], directory / "model.onnx", offline=offline)
    tokens = download(record["assets"]["tokens.txt"], directory / "tokens.txt", offline=offline)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    started = time.monotonic()
    graph = ort.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])
    load_seconds = time.monotonic() - started
    metadata = graph.get_modelmeta().custom_metadata_map
    if metadata.get("comment") != "mms" or metadata.get("frontend") != "characters":
        raise ValueError("Downloaded checkpoint is not native-character MMS/VITS")
    config = {"format": wide_mms.MODEL_FORMAT, "backend": wide_mms.BACKEND, "code": code,
              "iso_code": record["iso_code"], "name_uk": record["name_uk"], "standard": record["standard"],
              "sample_rate": int(metadata["sample_rate"]), "add_blank": bool(int(metadata["add_blank"])),
              "blank_id": 0, "frontend": "characters", "is_uroman": False, "lowercase": True,
              "navigation": {}, "navigation_verified": False,
              "license": index["license"], "provenance": {"repo_id": index["repository"], "revision": index["revision"],
                  "source_project": index["source_project"], "model_url": record["assets"]["model.onnx"]["url"],
                  "model_sha256": digest(model), "tokens_sha256": digest(tokens)},
              "native_pronunciation_verified": False, "windows_nvda_verified": False}
    if record.get("partial_variant"):
        config.update(selected_id=record["selected_id"], partial_variant=True)
    write_json(directory / "config.json", config)
    carrier = wide_mms.MMSCarrier(directory, session_factory=lambda _: graph)
    text = sample_text or smoke_text(carrier.frontend.tokens)
    started = time.monotonic()
    wave, rate, applied = carrier.audio(text, speed=1., noise_scale=0., noise_scale_w=0.)
    infer_seconds = time.monotonic() - started
    evidence = Path(evidence)
    evidence.mkdir(parents=True, exist_ok=True)
    probe_file = evidence / (code + "-technical-probe.wav")
    sf.write(str(probe_file), wave, rate, subtype="PCM_16")
    # Prefer the publisher's actual natural-speech sample from the same pinned
    # checkpoint. Missing samples use the ACTUAL generated carrier, never another
    # language's voice vector. The latter reference is marked a technical probe.
    source_record = record["assets"].get("sample.wav")
    if source_record is not None:
        reference = download(source_record, evidence / (code + "-source-reference.wav"), offline=offline)
        reference_audio, reference_rate = sf.read(str(reference), dtype="float32")
        reference_basis = "publisher-sample-from-same-pinned-checkpoint"
        reference_url = source_record["url"]
    else:
        reference = probe_file
        reference_audio, reference_rate = wave, rate
        reference_basis = "actual-native-carrier-grapheme-probe-no-published-reference"
        reference_url = None
    embedding = extract_embedding(reference_audio, int(reference_rate), encoder_session)
    np.save(directory / "source.npy", embedding, allow_pickle=False)
    source_provenance = {"basis": reference_basis, "reference_url": reference_url,
                         "reference_wav_sha256": digest(reference), "reference_sample_rate": int(reference_rate),
                         "encoder_sha256": digest(encoder_path), "source_sha256": digest(directory / "source.npy"),
                         "source_shape": list(embedding.shape), "source_norm": float(np.linalg.norm(embedding)),
                         "source_dtype": str(embedding.dtype), "unit_normalized": False,
                         "generated_calibration_noise_scale": 0., "generated_calibration_noise_scale_w": 0.}
    config["source_identity"] = source_provenance
    config["technical_onnx_inference_verified"] = True
    write_json(directory / "config.json", config)
    notice = ("MMS native-language VITS model, original project Meta/Facebook MMS.\n"
              "Model weights: Creative Commons Attribution NonCommercial 4.0 (CC BY-NC 4.0).\n"
              "https://creativecommons.org/licenses/by-nc/4.0/\n"
              "ONNX conversion: Will Wade; " + index["converter_source"] + "\n"
              "Pinned repository: " + index["repository"] + " @ " + index["revision"] + "\n"
              "Original checkpoint: https://huggingface.co/facebook/mms-tts-" + record["iso_code"] + "\n"
              "Source identity measured from this carrier using OpenVoice V2 FP32 reference encoder (MIT).\n"
              "This preparation verifies finite PCM and source identity shape; native pronunciation,\n"
              "navigation names and Windows/NVDA acceptance are not claimed.\n")
    (directory / "NOTICE.txt").write_text(notice, encoding="utf8")
    return {"code": code, "iso_code": record["iso_code"], "standard": record["standard"],
            "directory": str(directory), "status": "prepared-real-onnx-carrier",
            "model_sha256": digest(model), "model_bytes": model.stat().st_size,
            "tokens_sha256": digest(tokens), "sample_rate": rate,
            "probe": {"text": text, "kind": "provided-native-text" if sample_text else "native-grapheme-smoke-test",
                      "seconds": len(wave) / rate, "samples": len(wave), "peak": float(np.max(np.abs(wave))),
                      "rms": float(np.sqrt(np.mean(wave ** 2))), "wave_sha256": digest(probe_file),
                      "graph_load_seconds": load_seconds, "graph_inference_seconds": infer_seconds,
                      "providers": graph.get_providers(), "applied_speed": applied},
            "source_identity": source_provenance,
            "navigation_verified": False, "native_pronunciation_verified": False, "windows_nvda_verified": False}


def download_one(code, record, *, output, evidence):
    rows = {}
    for filename, artifact in record["assets"].items():
        target = Path(evidence) / (code + "-source-reference.wav") if filename == "sample.wav" else Path(output) / code / filename
        path = download(artifact, target)
        rows[filename] = {"bytes": path.stat().st_size, "sha256": digest(path), "url": artifact["url"]}
    return {"code": code, "iso_code": record["iso_code"], "status": "downloaded-pinned-artifacts", "files": rows,
            "models_executed": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--download-only", action="store_true", help="Acquire pinned public bytes; never import or run ONNX Runtime")
    mode.add_argument("--offline-verify", action="store_true", help="Use only previously downloaded, hash-verified files; no HTTP calls")
    parser.add_argument("--languages", default="ha", help="Comma-separated runtime codes, or all")
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--reference-encoder", type=Path, default=DEFAULT_ENCODER)
    parser.add_argument("--report", type=Path, default=ROOT / "evidence/mms_preparation.json")
    parser.add_argument("--audio-evidence", type=Path, default=ROOT / "evidence/mms_audio")
    parser.add_argument("--samples-json", type=Path)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--ort-module-dir", type=Path, help="Explicit isolated ONNX Runtime installation for offline verification")
    parser.add_argument("--require-ort-version", help="Refuse verification with another ONNX Runtime build")
    args = parser.parse_args()
    index = json.loads(args.index.read_text(encoding="utf8"))
    if index.get("format") != "dordiai-mms-sources-v1":
        parser.error("Unsupported MMS source index")
    chosen = list(index["models"]) if args.languages == "all" else list(dict.fromkeys(args.languages.split(",")))
    if not chosen or any(code not in index["models"] for code in chosen):
        parser.error("Unknown MMS language selection")
    report = {"format": "dordiai-mms-preparation-v1", "platform": platform.platform(),
              "repo_id": index["repository"], "revision": index["revision"], "license": index["license"],
              "models": {}, "all_selected_prepared": False, "windows_nvda_verified": False,
              "mode": "download-only" if args.download_only else "offline-verification"}
    encoder = None
    samples = {}
    if args.offline_verify:
        if not args.reference_encoder.is_file():
            parser.error("Prepare the pinned FP32 OpenVoice reference encoder first")
        if args.ort_module_dir is not None:
            sys.path.insert(0, str(args.ort_module_dir.resolve()))
        import onnxruntime as ort
        ort.disable_telemetry_events()
        if args.require_ort_version and ort.__version__ != args.require_ort_version:
            parser.error("ONNX Runtime differs from the explicitly selected offline build")
        if args.ort_module_dir is not None and not Path(ort.__file__).resolve().is_relative_to(args.ort_module_dir.resolve()):
            parser.error("ONNX Runtime was imported from outside the explicitly selected directory")
        if str(Path(__file__).resolve().parent) not in sys.path:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
        from prepare_reference_encoder import load_encoder, ENCODERS
        if digest(args.reference_encoder) != ENCODERS["fp32"]["sha256"]:
            parser.error("Source vectors require the verified compatible FP32 reference encoder")
        encoder = load_encoder(args.reference_encoder)
        report.update(onnxruntime_version=ort.__version__, onnxruntime_module=str(ort.__file__),
                      ort_telemetry_disabled=True, model_downloads_made=False)
        samples = json.loads(args.samples_json.read_text(encoding="utf8")) if args.samples_json else {}
    with ThreadPoolExecutor(max_workers=max(1, min(4, args.workers))) as executor:
        futures = {}
        for code in chosen:
            if args.download_only:
                future = executor.submit(download_one, code, index["models"][code], output=args.output, evidence=args.audio_evidence)
            else:
                future = executor.submit(prepare_one, code, index["models"][code], index=index, output=args.output,
                                         encoder_path=args.reference_encoder, encoder_session=encoder,
                                         evidence=args.audio_evidence, sample_text=samples.get(code), offline=True)
            futures[future] = code
        for future in as_completed(futures):
            code = futures[future]
            try:
                result = future.result()
                print(json.dumps({"code": code, "status": result["status"],
                                  "audio_seconds": result.get("probe", {}).get("seconds"),
                                  "model_bytes": result.get("model_bytes")}, ensure_ascii=False), flush=True)
            except Exception as error:
                result = {"code": code, "status": "failed", "error": type(error).__name__ + ": " + str(error)}
                print(json.dumps(result, ensure_ascii=False), flush=True)
            report["models"][code] = result
            args.report.parent.mkdir(parents=True, exist_ok=True)
            write_json(args.report, report)
    status = "downloaded-pinned-artifacts" if args.download_only else "prepared-real-onnx-carrier"
    complete = all(row["status"] == status for row in report["models"].values())
    report["all_selected_downloaded" if args.download_only else "all_selected_prepared"] = complete
    report["model_bytes"] = sum(row.get("model_bytes", 0) for row in report["models"].values())
    write_json(args.report, report)
    return 0 if complete else 1


if __name__ == "__main__":
    raise SystemExit(main())
