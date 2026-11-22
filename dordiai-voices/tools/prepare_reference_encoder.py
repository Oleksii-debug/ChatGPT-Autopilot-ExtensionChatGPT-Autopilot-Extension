#!/usr/bin/env python3
"""Acquire and verify the small OpenVoice V2 reference encoder used by new carriers.

Only public, immutable, checksum-pinned ONNX files are downloaded. Original
packages/0.12.2 remains unchanged. Inference uses ONNX Runtime and the exact
existing runtime spectrogram/resampling functions; PyTorch is not needed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPO = "TigreGotico/voiceclonnx-openvoice-v2"
REVISION = "34d010c192c97f763207f488f6057fd07fee42ad"
ENCODERS = {
    "fp32": {"filename": "tone_ref_encoder.onnx", "size_bytes": 3259275,
             "sha256": "3dd4918cab90e1acf7fa5c6f7539c27710e7a3cdfba550468c5ea49399178bf7"},
    "q8": {"filename": "tone_ref_encoder_q8.onnx", "size_bytes": 2315304,
           "sha256": "8e46097e46a68a2137acf105b58bc67cf686ec0d811c1c45ada28557a608c0e3"},
}
SMALL_FILES = ("PROVENANCE.md", "README.md", "config.json", "tone_ref_encoder_parity_report.json")
DEFAULT_OUTPUT = ROOT / "model-packs/shared-reference/kx47Runtime/models/OpenVoiceV2"


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download_pinned(record, output):
    output = Path(output)
    expected_size = record["size_bytes"]
    if output.is_file() and output.stat().st_size == expected_size and file_hash(output) == record["sha256"]:
        return output
    url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{record['filename']}"
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".reference-encoder-", dir=output.parent)
    try:
        digest, written = hashlib.sha256(), 0
        with os.fdopen(descriptor, "wb") as destination, urllib.request.urlopen(url, timeout=45) as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                written += len(block)
                if written > expected_size:
                    raise ValueError("Reference encoder exceeds the pinned size")
                digest.update(block)
                destination.write(block)
            destination.flush()
            os.fsync(destination.fileno())
        if written != expected_size or digest.hexdigest() != record["sha256"]:
            raise ValueError("Reference encoder checksum or size differs from the pinned artifact")
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return output


def prepare(output=DEFAULT_OUTPUT, variants=("fp32", "q8")):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    records = {}
    for variant in variants:
        record = ENCODERS[variant]
        path = download_pinned(record, output / record["filename"])
        records[variant] = {**record, "url": f"https://huggingface.co/{REPO}/resolve/{REVISION}/{record['filename']}",
                            "verified_sha256": file_hash(path)}
    provenance = {}
    for name in SMALL_FILES:
        url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}"
        destination = output / ("reference-encoder-" + name)
        if not destination.is_file():
            with urllib.request.urlopen(url, timeout=30) as response:
                contents = response.read(1024 * 1024 + 1)
            if len(contents) > 1024 * 1024:
                raise ValueError("Unexpectedly large reference encoder provenance")
            destination.write_bytes(contents)
        provenance[name] = {"url": url, "sha256": file_hash(destination), "size_bytes": destination.stat().st_size}
    return records, provenance


def load_encoder(path, threads=2):
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, int(threads))
    options.inter_op_num_threads = 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    session = ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
    inputs, outputs = session.get_inputs(), session.get_outputs()
    if len(inputs) != 1 or inputs[0].name != "spec" or inputs[0].type != "tensor(float)":
        raise ValueError("Unexpected reference encoder input contract")
    if len(inputs[0].shape) != 3 or inputs[0].shape[-1] != 513 or len(outputs) != 1:
        raise ValueError("Unexpected reference encoder spectrogram/output contract")
    return session


def extract_embedding(audio, sample_rate, encoder, *, threads=2):
    """Create the actual raw OpenVoice conditioning vector, never a substitute.

    ``encoder`` may be a ready ORT session or a path. The output is float32
    (1,256,1), preserving the model's original magnitude. Existing OpenVoice
    conditioning vectors are not unit normalized, so normalizing would change
    the learned conditioning space.
    """
    import numpy as np
    runtime = str(ROOT / "source/0.12.2/kx47Runtime")
    if runtime not in sys.path:
        sys.path.insert(0, runtime)
    from converted_voices import resample, spectrogram
    waveform = np.asarray(audio, dtype=np.float32)
    if waveform.ndim == 2:
        waveform = waveform.mean(axis=1)
    if waveform.ndim != 1 or waveform.size < 512 or not np.isfinite(waveform).all():
        raise ValueError("Reference audio must be finite nonempty mono/stereo PCM")
    if not isinstance(sample_rate, int) or not 8000 <= sample_rate <= 192000:
        raise ValueError("Invalid reference sample rate")
    waveform = resample(waveform, sample_rate, 22050)
    if float(np.max(np.abs(waveform))) < 1e-7:
        raise ValueError("A silent reference cannot establish the source voice")
    session = encoder if hasattr(encoder, "run") else load_encoder(encoder, threads)
    spectrum = spectrogram(waveform)[None]
    embedding = np.asarray(session.run(None, {"spec": spectrum})[0], dtype=np.float32)
    if embedding.size != 256 or not np.isfinite(embedding).all() or float(np.linalg.norm(embedding)) <= 1e-7:
        raise ValueError("Reference encoder did not produce a valid conditioning vector")
    return embedding.reshape(1, 256, 1)


def validate(output=DEFAULT_OUTPUT, sample=None, baseline_embedding=None, threads=2):
    import numpy as np
    import onnxruntime as ort
    import soundfile as sf
    output = Path(output)
    if sample is None:
        # A deterministic structural probe, explicitly not a natural-voice test.
        rate = 22050
        t = np.arange(rate * 2, dtype=np.float32) / rate
        audio = .14 * np.sin(2 * np.pi * 220 * t) + .06 * np.sin(2 * np.pi * 437 * t)
        audio *= np.minimum(1., t * 10) * np.minimum(1., (2 - t) * 10)
        sample_info = {"kind": "deterministic-synthetic-harmonic-probe", "sample_rate": rate, "samples": len(audio)}
    else:
        audio, rate = sf.read(str(sample), dtype="float32")
        sample_info = {"kind": "provided-audio", "filename": str(sample), "sha256": file_hash(sample),
                       "sample_rate": rate, "samples": len(audio)}
    records, embeddings = {}, {}
    for variant, record in ENCODERS.items():
        path = output / record["filename"]
        if not path.is_file():
            continue
        if file_hash(path) != record["sha256"]:
            raise ValueError("Reference encoder changed after acquisition")
        session = load_encoder(path, threads)
        embedding = extract_embedding(audio, int(rate), session)
        repeated = extract_embedding(audio, int(rate), session)
        np.testing.assert_array_equal(embedding, repeated)
        records[variant] = {"shape": list(embedding.shape), "dtype": str(embedding.dtype),
                            "finite": True, "norm": float(np.linalg.norm(embedding)),
                            "deterministic_repeat": True,
                            "providers": session.get_providers(),
                            "input": {"name": session.get_inputs()[0].name, "shape": session.get_inputs()[0].shape}}
        embeddings[variant] = embedding
    if not records:
        raise ValueError("Prepare at least one reference encoder before validation")
    parity = None
    if {"fp32", "q8"} <= embeddings.keys():
        first, second = (embeddings[key].ravel() for key in ("fp32", "q8"))
        parity = {"cosine": float(np.dot(first, second) / (np.linalg.norm(first) * np.linalg.norm(second))),
                  "max_abs_difference": float(np.max(np.abs(first - second)))}
    baseline = None
    if baseline_embedding is not None:
        known = np.load(baseline_embedding, allow_pickle=False)
        if known.shape != (1, 256, 1) or not np.isfinite(known).all():
            raise ValueError("Invalid existing comparison embedding")
        current = embeddings.get("fp32", next(iter(embeddings.values()))).ravel()
        original = known.ravel()
        baseline = {"file": str(baseline_embedding), "norm": float(np.linalg.norm(original)),
                    "cosine": float(np.dot(current, original) / (np.linalg.norm(current) * np.linalg.norm(original))),
                    "interpretation": "comparison only; same original enrollment waveform is not available, so exact parity is not asserted"}
    return {"onnxruntime": ort.__version__, "sample": sample_info, "encoders": records,
            "fp32_q8_comparison": parity, "baseline_comparison": baseline,
            "windows_nvda_audio_verified": False,
            "interpretation": "real CPU graph execution and conditioning-vector validation; not native pronunciation or end-user audio acceptance"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--metadata", type=Path, default=ROOT / "evidence/ref_encoder_metadata.json")
    parser.add_argument("--variant", choices=("fp32", "q8", "both"), default="both")
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--sample", type=Path)
    parser.add_argument("--baseline-embedding", type=Path)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--embedding-output", type=Path,
                        help="Generate source.npy only from the explicitly provided actual carrier audio")
    args = parser.parse_args()
    if args.embedding_output is not None and args.sample is None:
        parser.error("An actual --sample waveform is required to generate source.npy")
    variants = tuple(ENCODERS) if args.variant == "both" else (args.variant,)
    files, provenance = prepare(args.output, variants)
    result = {"format": 1, "repo_id": REPO, "revision": REVISION, "license": "MIT",
              "upstream_weights": "myshell-ai/OpenVoiceV2", "files": files, "provenance": provenance,
              "preferred_calibration_variant": "fp32", "validation": None}
    if args.verify:
        result["validation"] = validate(args.output, args.sample, args.baseline_embedding, args.threads)
    if args.embedding_output is not None:
        import numpy as np
        import soundfile as sf
        audio, rate = sf.read(str(args.sample), dtype="float32")
        encoder = args.output / ENCODERS["fp32" if "fp32" in variants else "q8"]["filename"]
        embedding = extract_embedding(audio, int(rate), encoder, threads=args.threads)
        args.embedding_output.parent.mkdir(parents=True, exist_ok=True)
        np.save(args.embedding_output, embedding, allow_pickle=False)
        result["generated_embedding"] = {"file": str(args.embedding_output), "sha256": file_hash(args.embedding_output),
                                         "source_audio_sha256": file_hash(args.sample)}
    args.metadata.parent.mkdir(parents=True, exist_ok=True)
    args.metadata.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"files": list(files), "validation": result["validation"], "metadata": str(args.metadata)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
