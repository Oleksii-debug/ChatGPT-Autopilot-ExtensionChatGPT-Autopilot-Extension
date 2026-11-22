#!/usr/bin/env python3
"""Measure optional Omni CPU costs and explicitly limited model-consistency proxies."""
from __future__ import annotations
import argparse
import gc
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--onnxruntime-root", type=Path, required=True)
    parser.add_argument("--models", type=Path, default=ROOT / "model-packs/extra-onnx/kx47Runtime/models/SharedOmniONNX")
    parser.add_argument("--output", type=Path, default=ROOT / "evidence/omnivoice_optimization.json")
    args = parser.parse_args()
    safe = args.onnxruntime_root.resolve()
    for binary in (p for p in safe.rglob("*") if p.is_file() and (p.suffix.lower() in {".so", ".dll", ".pyd"} or ".so." in p.name)):
        data = binary.read_bytes()
        if b"mobile.events.data.microsoft.com" in data or b"OneCollector" in data:
            raise RuntimeError("Refusing the previously rejected telemetry-capable preparation runtime")
    sys.path.insert(0, str(safe))
    import onnxruntime as ort
    if ort.__version__ != "1.27.0" or not Path(ort.__file__).resolve().is_relative_to(safe):
        raise RuntimeError("Use the verified isolated official ORT1.27 runtime")
    ort.disable_telemetry_events()
    import numpy as np
    import soundfile as sf
    sys.path.insert(0, str(ROOT / "source/0.12.2/kx47Runtime"))
    import wide_omnivoice_onnx as omni
    text, language = "Allegra.", "rm"
    codes, reference_text = omni._reference(args.models, language)
    report = {"scope": "LinuxCPU-only-not-NVDA-not-audible-latency", "onnxruntime": ort.__version__,
              "thread_benchmarks": [], "clips": [], "pronunciation_accepted": False,
              "proxy_limit": "Masked-code self-consistency measures this model's reconstruction of its own outputs, not linguistic correctness or human perceived quality."}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    def save():
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for threads in (1, 3, 6):
        for spinning in (False, True):
            engine = omni.OmniONNX(args.models, threads=threads)
            engine.options.add_session_config_entry("session.intra_op.allow_spinning", "1" if spinning else "0")
            inputs, mask, attention = omni.prepare_inputs(engine.tokenizer, text, language, 36, np, codes, reference_text)
            session = engine.session("backbone.int8.onnx")
            timings = []
            for _ in range(3):
                start = time.perf_counter()
                output = session.run(None, {"input_ids": inputs, "audio_mask": mask, "attention_mask": attention})[0]
                timings.append(time.perf_counter() - start)
            record = {"threads": threads, "spinning": spinning, "warm_forward_seconds": timings,
                      "median_seconds": float(np.median(timings)), "finite_logits": bool(np.isfinite(output).all())}
            report["thread_benchmarks"].append(record)
            print("threads", record, flush=True)
            save()
            del session, engine
            gc.collect()
    best = min(report["thread_benchmarks"], key=lambda value: value["median_seconds"])
    engine = omni.OmniONNX(args.models, threads=best["threads"])
    engine.options.add_session_config_entry("session.intra_op.allow_spinning", "1" if best["spinning"] else "0")
    report["measured_best_thread_configuration"] = best
    for steps, split in ((32, False), (8, False), (4, False), (8, True), (4, True)):
        start = time.perf_counter()
        waveform, generated = engine.generate(text, language, reference_codes=codes, reference_text=reference_text,
                                               steps=steps, split_unconditional=split, return_codes=True)
        elapsed = time.perf_counter() - start
        frames = generated.shape[-1]
        ids, mask, attention = omni.prepare_inputs(engine.tokenizer, text, language, frames, np, codes, reference_text)
        masked = np.random.default_rng(100).random(generated.shape) < .25
        heldout = generated.copy()
        heldout[masked] = omni.MASK
        ids[0, :, -frames:] = heldout
        logits = engine.session("backbone.int8.onnx").run(None, {
            "input_ids": ids[:1], "audio_mask": mask[:1], "attention_mask": attention[:1],
        })[0][0, :, -frames:, :]
        probabilities = omni._log_softmax(logits, np)
        true_log_probs = np.take_along_axis(probabilities, generated[..., None], axis=-1)[..., 0]
        record = {"steps": steps, "split": split, "seconds": elapsed,
                  "audio_seconds": len(waveform) / 24000, "rtf": elapsed / (len(waveform) / 24000),
                  "masked_code_nll": float(-true_log_probs[masked].mean()),
                  "masked_code_top1_accuracy": float(np.mean(logits.argmax(-1)[masked] == generated[masked])),
                  "adjacent_codec_repetition": float(np.mean(generated[:, 1:] == generated[:, :-1])),
                  "pcm_rms": float(np.sqrt(np.mean(waveform**2))),
                  "near_clipping_fraction": float(np.mean(np.abs(waveform) >= .99)),
                  "near_silence_fraction": float(np.mean(np.abs(waveform) <= .001)),
                  "peak": float(np.abs(waveform).max()), "human_quality_accepted": False}
        report["clips"].append(record)
        sf.write(args.models / f"optimization-rm-{steps}-split{split}.wav", waveform, 24000)
        print("clip", record, flush=True)
        save()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
