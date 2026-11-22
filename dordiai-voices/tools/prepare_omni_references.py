#!/usr/bin/env python3
"""Prepare fixed same-language carrier prompts using fully local ONNX resources.

This is a reproducible structural PCM/identity check, not a native-speaker
pronunciation or NVDA speed acceptance. The reference phrases are engineering
probes. No remote model loading, transcription service or voice API is called.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODELS = ROOT / "model-packs/extra-onnx/kx47Runtime/models/SharedOmniONNX"
DEFAULT_ENCODER = ROOT / "model-packs/shared-reference/kx47Runtime/models/OpenVoiceV2/tone_ref_encoder.onnx"
TEXTS = {
    "rm": "Allegra. Bun di. Co vai?",
    "ks": "آداب۔",
    "mni": "ꯈꯨꯔꯨꯝꯖꯔꯤ",
    "brx": "खुलुमबाय।",
    "ig": "Ndewo. Kedu ka ị mere?",
    "ln": "Mbote. Ndenge nini?",
    "zu": "Sawubona. Unjani?",
    "xh": "Molo. Unjani?",
    "wo": "Salaam aleekum. Nanga def?",
    "nso": "Dumela. O kae?",
}


def file_hash(path):
    with Path(path).open("rb") as source:
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", type=Path, default=DEFAULT_MODELS)
    parser.add_argument("--reference-encoder", type=Path, default=DEFAULT_ENCODER)
    parser.add_argument("--onnxruntime-root", type=Path, required=True,
                        help="Isolated verified ORT1.27 wheel extraction, without OneCollector implementation")
    parser.add_argument("--languages", default=",".join(TEXTS))
    parser.add_argument("--evidence", type=Path, default=ROOT / "evidence/omnivoice_references.json")
    args = parser.parse_args(argv)
    runtime_root = args.onnxruntime_root.resolve()
    # Inspect before importing native code; do not retry a runtime known to send
    # unrelated startup telemetry even when its public disable API is called.
    for binary in (p for p in runtime_root.rglob("*") if p.is_file() and (p.suffix.lower() in {".so", ".dll", ".pyd"} or ".so." in p.name)):
        contents = binary.read_bytes()
        if any(endpoint in contents for endpoint in (b"mobile.events.data.microsoft.com", b"OneCollector", b"dc.services.visualstudio.com")):
            raise RuntimeError("ORT preparation runtime contains the rejected telemetry implementation")
    sys.path.insert(0, str(runtime_root))
    import onnxruntime as ort
    if ort.__version__ != "1.27.0" or not Path(ort.__file__).resolve().is_relative_to(runtime_root):
        raise RuntimeError("Use the verified isolated official ORT1.27 package for preparation")
    ort.disable_telemetry_events()
    import numpy as np
    import soundfile as sf
    sys.path.insert(0, str(ROOT / "source/0.12.2/kx47Runtime"))
    from wide_omnivoice_onnx import OmniONNX
    from prepare_reference_encoder import extract_embedding, load_encoder
    engine = OmniONNX(args.models)
    identity_encoder = load_encoder(args.reference_encoder)
    report = {"scope": "local-onnx-native-carrier-structural-probe", "onnxruntime": ort.__version__,
              "runtime_path": ort.__file__, "weights_revision": "efddec1c39169c79e57eb65f1a7b650d0906a182",
              "pronunciation_verified": False, "nvda_verified": False, "languages": {}}
    for code in args.languages.split(","):
        code = code.strip()
        if code not in TEXTS:
            raise ValueError("Unknown reference language: " + code)
        text = TEXTS[code]
        destination = args.models / "references" / code
        destination.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        audio = engine.generate(text, code, duration=2.8, instruction="female, moderate pitch")
        active = np.flatnonzero(np.abs(audio) > max(1e-5, float(np.abs(audio).max()) * .02))
        if not len(active):
            raise ValueError("Silent native reference for " + code)
        low = max(0, int(active[0]) - 1200)
        high = min(len(audio), int(active[-1]) + 1200)
        audio = audio[low:high]
        codes = engine.encode_reference(audio, 24000)
        vector = extract_embedding(audio, 24000, identity_encoder)
        sf.write(destination / "reference.wav", audio, 24000)
        np.save(destination / "codes.npy", codes, allow_pickle=False)
        np.save(destination / "source.npy", vector, allow_pickle=False)
        (destination / "text.txt").write_text(text, encoding="utf-8")
        record = {"text": text, "samples": len(audio), "sample_rate": 24000,
                  "peak": float(np.abs(audio).max()), "reference_codes_shape": list(codes.shape),
                  "source_identity_norm": float(np.linalg.norm(vector)), "finite_pcm": True,
                  "preparation_seconds": time.monotonic() - started,
                  "pronunciation_verified": False, "nvda_latency_accepted": False,
                  "files": {name: file_hash(destination / name) for name in ("reference.wav", "codes.npy", "source.npy", "text.txt")}}
        (destination / "probe.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        report["languages"][code] = record
        args.evidence.parent.mkdir(parents=True, exist_ok=True)
        args.evidence.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(code, "prepared-real-native-pcm-and-identity", round(record["preparation_seconds"], 2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
