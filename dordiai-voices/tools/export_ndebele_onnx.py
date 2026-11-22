"""Safely export the pinned Northern Ndebele Coqui checkpoint for offline NVDA.

Torch/Coqui are build-only dependencies. Client inference uses the existing
small Coqui ONNX adapter. Checkpoint loading is always weights_only=True;
training-only discriminators/loss encoders are never initialised or downloaded.
"""
from __future__ import annotations

import argparse
from collections import OrderedDict
from hashlib import sha256
import json
from pathlib import Path
import platform
import sys
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
INDEX = ROOT / "tools/ndebele_checkpoint_sources.json"
CHECKPOINT_ROOT = ROOT / "downloads/ndebele"
OUTPUT = ROOT / "model-packs/ndebele/kx47Runtime/models/ExtraLanguages/nd"


def file_hash(path):
    value = sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def verify_sources(directory, index):
    for name, entry in index["assets"].items():
        path = directory / name
        if (not path.is_file() or path.stat().st_size != entry["bytes"]
                or file_hash(path) != entry["sha256"]):
            raise ValueError("Pinned Northern Ndebele source is missing or changed: " + name)


def acquire(directory, index):
    directory.mkdir(parents=True, exist_ok=True)
    for name, entry in index["assets"].items():
        path = directory / name
        if path.is_file() and path.stat().st_size == entry["bytes"] and file_hash(path) == entry["sha256"]:
            continue
        # This explicitly pinned training checkpoint is larger than a runtime
        # model. It is staged in ignored downloads/, never a client voice pack.
        if entry["bytes"] > 1100 * 1024 * 1024 or not entry["url"].startswith("https://huggingface.co/multilingual-tts/VITS-OpenBible-Ndebele/resolve/"):
            raise ValueError("Unexpected Northern Ndebele checkpoint source")
        temporary = path.with_name(path.name + ".download")
        total = 0
        with urlopen(entry["url"], timeout=60) as source, temporary.open("wb") as target:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                total += len(chunk)
                if total > entry["bytes"]:
                    raise ValueError("Checkpoint exceeded pinned length")
                target.write(chunk)
        if total != entry["bytes"] or file_hash(temporary) != entry["sha256"]:
            temporary.unlink(missing_ok=True)
            raise ValueError("Checkpoint does not match pinned SHA256")
        temporary.replace(path)
    verify_sources(directory, index)


def safe_checkpoint(path):
    import torch
    unsafe = torch.serialization.get_unsafe_globals_in_checkpoint(path)
    # Do not automatically import/allow names obtained from an unpickling error.
    # The publisher's trainer normally saves only tensors and a config dictionary.
    if unsafe:
        raise ValueError("Checkpoint contains unsupported pickle globals; no unsafe load attempted: " + repr(unsafe))
    value = torch.load(path, map_location="cpu", weights_only=True, mmap=True)
    if not isinstance(value, dict) or not isinstance(value.get("model"), dict):
        raise ValueError("Unsupported Northern Ndebele checkpoint container")
    state = value["model"]
    if not state or not all(isinstance(key, str) and isinstance(item, torch.Tensor) for key, item in state.items()):
        raise ValueError("Checkpoint model is not a tensor-only state dictionary")
    if all(key.startswith("module.") for key in state):
        state = OrderedDict((key.removeprefix("module."), item) for key, item in state.items())
    return state, {"weights_only": True, "mmap": True, "unsafe_pickle_globals": unsafe,
                   "checkpoint_top_keys": sorted(map(str, value)), "model_tensor_count": len(state)}


def export(directory, output, index):
    import torch
    from TTS.tts.configs.vits_config import VitsConfig
    from TTS.tts.models.vits import Vits
    from TTS.tts.utils.text.tokenizer import TTSTokenizer

    torch.set_num_threads(2)
    verify_sources(directory, index)
    state, safety = safe_checkpoint(directory / "model_last.pth")
    raw = json.loads((directory / "config.json").read_text(encoding="utf8"))
    config = VitsConfig()
    config.from_dict(raw)
    config.model_args.init_discriminator = False
    config.model_args.use_speaker_encoder_as_loss = False
    config.model_args.speaker_encoder_model_path = ""
    config.model_args.speaker_encoder_config_path = ""
    config.model_args.speakers_file = None
    config.speakers_file = None
    config.model_args.language_ids_file = None
    config.language_ids_file = None
    if config.model_args.use_language_embedding or config.model_args.use_d_vector_file:
        raise ValueError("Unsupported external speaker/language conditioning in this checkpoint")
    speaker_table = torch.load(directory / "speakers.pth", map_location="cpu", weights_only=True)
    if not isinstance(speaker_table, dict):
        raise ValueError("Unsupported native speaker ID table")
    embedding = state.get("emb_g.weight")
    conditioned = embedding is not None
    selected_speaker, selected_id = None, None
    if conditioned:
        if embedding.ndim != 2 or embedding.shape[0] < 1:
            raise ValueError("Invalid native speaker embedding")
        config.model_args.use_speaker_embedding = True
        config.model_args.num_speakers = int(embedding.shape[0])
        config.model_args.speaker_embedding_channels = int(embedding.shape[1])
        selected_id = 0
        selected_speaker = next((name for name, value in speaker_table.items() if value == selected_id), None)
        if selected_speaker is None:
            raise ValueError("Cannot bind the exported speaker to the original ID table")
    else:
        config.model_args.use_speaker_embedding = False
        config.model_args.num_speakers = 0
    tokenizer, config = TTSTokenizer.init_from_config(config)
    mapping = {symbol: position for position, symbol in enumerate(tokenizer.characters.vocab)}
    if len(mapping) != config.model_args.num_chars:
        raise ValueError("Tokenizer vocabulary does not match the trained embedding")
    # Bypass init_from_config/Synthesizer: they may load stale training paths,
    # audio preprocessors and auxiliary encoders that are unnecessary for export.
    model = Vits(config, ap=None, tokenizer=tokenizer, speaker_manager=None, language_manager=None).cpu().eval()
    trained = OrderedDict((key, value) for key, value in state.items() if not key.startswith("disc."))
    result = model.load_state_dict(trained, strict=True)
    if result.missing_keys or result.unexpected_keys:
        raise ValueError("Trained VITS parameters do not match the inference network")
    model.requires_grad_(False)
    del state, trained

    class ExportVoice(torch.nn.Module):
        def __init__(self, native):
            super().__init__()
            self.native = native
            if conditioned:
                self.register_buffer("speaker", torch.tensor([selected_id], dtype=torch.int64))
        def forward(self, ids, lengths, scales):
            self.native.noise_scale = scales[0]
            self.native.inference_noise_scale = scales[0]
            self.native.length_scale = scales[1]
            self.native.noise_scale_dp = scales[2]
            self.native.inference_noise_scale_dp = scales[2]
            return self.native.inference(ids, aux_input={"x_lengths": lengths, "d_vectors": None,
                      "speaker_ids": self.speaker if conditioned else None, "language_ids": None,
                      "durations": None})["model_outputs"]

    wrapper = ExportVoice(model).eval()
    ids = torch.tensor([tokenizer.text_to_ids("umuntu")], dtype=torch.int64)
    lengths = torch.tensor([ids.shape[1]], dtype=torch.int64)
    scales = torch.tensor([0., 1., 0.], dtype=torch.float32)
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with torch.inference_mode():
        torch.onnx.export(wrapper, (ids, lengths, scales), str(output / "model.onnx"),
                          input_names=["input", "input_lengths", "scales"], output_names=["output"],
                          dynamic_axes={"input": {0: "batch", 1: "tokens"}, "input_lengths": {0: "batch"},
                                        "output": {0: "batch", 2: "samples"}},
                          opset_version=15, dynamo=False, do_constant_folding=True)
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
    if ort.__version__ != "1.27.0":
        raise ValueError("Export parity requires the audited offline ONNX Runtime 1.27.0 build")
    settings = ort.SessionOptions()
    settings.intra_op_num_threads = 2
    settings.inter_op_num_threads = 1
    settings.add_session_config_entry("session.intra_op.allow_spinning", "0")
    graph = ort.InferenceSession(str(output / "model.onnx"), sess_options=settings, providers=["CPUExecutionProvider"])
    parity = []
    for phrase in ("a", "umuntu", "siyabonga", "abantu bonke", "umuntu " * 6):
        test_ids = torch.tensor([tokenizer.text_to_ids(phrase)], dtype=torch.int64)
        test_lengths = torch.tensor([test_ids.shape[1]], dtype=torch.int64)
        test_scales = torch.tensor([0., 1., 0.], dtype=torch.float32)
        with torch.inference_mode():
            expected = wrapper(test_ids, test_lengths, test_scales).cpu().numpy().reshape(-1)
        feed = {"input": test_ids.numpy(), "input_lengths": test_lengths.numpy(), "scales": test_scales.numpy()}
        actual = np.asarray(graph.run(None, feed)[0], np.float32).reshape(-1)
        repeated = np.asarray(graph.run(None, feed)[0], np.float32).reshape(-1)
        if expected.shape != actual.shape or not np.isfinite(actual).all() or not len(actual):
            raise ValueError("Export does not preserve dynamic text/audio shape for: " + phrase)
        error = float(np.max(np.abs(expected - actual)))
        cosine = float(np.dot(expected, actual) / (np.linalg.norm(expected) * np.linalg.norm(actual)))
        if error > .005 or cosine < .999 or not np.array_equal(actual, repeated):
            raise ValueError("Export waveform/parity/determinism failed for: " + phrase + ": " + str((error, cosine)))
        fast_feed = dict(feed, scales=np.asarray([0., .5, 0.], np.float32))
        fast = np.asarray(graph.run(None, fast_feed)[0]).reshape(-1)
        if not 0 < len(fast) < len(actual):
            raise ValueError("Export speaking-rate input is ineffective")
        parity.append({"text": phrase.strip(), "tokens": int(test_ids.shape[1]),
                       "token_ids": test_ids.numpy().reshape(-1).tolist(), "samples": len(actual),
                       "samples_2x": len(fast), "torch_onnx_max_abs": error, "torch_onnx_cosine": cosine,
                       "zero_noise_bitwise_deterministic": True})
    normalised = {"engine": "coqui", "phoneme_type": "graphemes", "alphabet": "unicode", "lang_code": "nd",
                  "audio": {"sample_rate": int(config.audio.sample_rate)}, "num_symbols": len(mapping),
                  "num_speakers": 1, "num_langs": 1, "speaker_id_map": {}, "lang_id_map": {},
                  "phoneme_id_map": mapping, "pad": config.characters.pad, "blank": config.characters.blank,
                  "bos": config.characters.bos, "eos": config.characters.eos,
                  "add_blank_char": bool(config.add_blank), "blank_at_start": True, "blank_at_end": True,
                  "use_eos_bos": False, "word_sep_token": " ", "blank_between": "tokens_and_words",
                  "fold_compounds": False, "keep_punctuation": True,
                  "inference": {"noise_scale": float(config.model_args.inference_noise_scale),
                                "length_scale": 1., "noise_w": float(config.model_args.inference_noise_scale_dp)}}
    (output / "config.json").write_text(json.dumps(normalised, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    (output / "UPSTREAM_README.md").write_bytes((directory / "README.md").read_bytes())
    provenance = {"format": "dordiai-ndebele-export-v1", "language": "nd", "iso_code": "nde",
                  "repo_id": index["repo_id"], "revision": index["revision"], "license": index["license"],
                  "checkpoint_sha256": file_hash(directory / "model_last.pth"),
                  "training_config_sha256": file_hash(directory / "config.json"),
                  "speaker_table_sha256": file_hash(directory / "speakers.pth"),
                  "speaker_conditioning": "fixed-trained-speaker-id" if conditioned else "none-in-trained-state",
                  "selected_speaker_id": selected_id, "selected_speaker_name": selected_speaker,
                  "declared_training_speakers": raw.get("num_speakers"),
                  "selectable_original_speakers_exposed": False,
                  "safety": safety, "strict_inference_state_loaded": True,
                  "training_discriminator_initialised": False, "speaker_encoder_loss_initialised": False,
                  "torch_version": torch.__version__, "model_bytes": (output / "model.onnx").stat().st_size,
                  "model_sha256": file_hash(output / "model.onnx"),
                  "runtime_frontend_config_sha256": file_hash(output / "config.json"),
                  "export_seconds": time.monotonic() - started,
                  "onnx_opset": 15, "onnxruntime_version": ort.__version__, "dynamic_length_parity": parity,
                  "inference_noise_slots_bound_correctly": True,
                  "native_pronunciation_verified": False, "windows_nvda_verified": False}
    (output / "export_provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    return provenance


def prepare_runtime(output):
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
    if ort.__version__ != "1.27.0":
        raise ValueError("Runtime preparation requires audited offline ONNX Runtime 1.27.0")
    import soundfile as sf
    if str(RUNTIME) not in sys.path:
        sys.path.insert(0, str(RUNTIME))
    from wide_coqui_onnx import NativeCoqui
    from prepare_reference_encoder import load_encoder, extract_embedding, ENCODERS
    from prepare_mms_models import smoke_text
    source = json.loads((output / "export_provenance.json").read_text(encoding="utf8"))
    if source["model_sha256"] != file_hash(output / "model.onnx"):
        raise ValueError("Exported Northern Ndebele graph changed after parity validation")
    if source.get("runtime_frontend_config_sha256") != file_hash(output / "config.json"):
        raise ValueError("Exported native tokenizer changed after validation")
    config = json.loads((output / "config.json").read_text(encoding="utf8"))
    runtime = {"format": "dordiai-coqui-onnx-v1", "backend": "extra-onnx", "code": "nd", "iso_code": "nde",
               "sample_rate": config["audio"]["sample_rate"], "license": source["license"],
               "repo_id": source["repo_id"], "revision": source["revision"],
               "model_sha256": source["model_sha256"], "config_sha256": source["runtime_frontend_config_sha256"],
               "speaker_conditioning": source["speaker_conditioning"],
               "declared_training_speakers": source["declared_training_speakers"],
               "selectable_original_speakers_exposed": False,
               "navigation_verified": False, "native_pronunciation_verified": False, "windows_nvda_verified": False}
    (output / "runtime_config.json").write_text(json.dumps(runtime, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    carrier = NativeCoqui(output)
    text = smoke_text(config["phoneme_id_map"])
    started = time.monotonic()
    audio = carrier.audio(text, noise_scale=0., noise_scale_w=0.)
    inference_seconds = time.monotonic() - started
    evidence = ROOT / "evidence/ndebele_audio"
    evidence.mkdir(parents=True, exist_ok=True)
    waveform = evidence / "nd-native-carrier.wav"
    sf.write(str(waveform), audio, carrier.rate, subtype="PCM_16")
    pcm, rate = sf.read(str(waveform), dtype="float32")
    encoder_path = ROOT / "model-packs/shared-reference/kx47Runtime/models/OpenVoiceV2/tone_ref_encoder.onnx"
    if file_hash(encoder_path) != ENCODERS["fp32"]["sha256"]:
        raise ValueError("Native source calibration requires the compatible pinned FP32 reference encoder")
    embedding = extract_embedding(pcm, int(rate), load_encoder(encoder_path))
    np.save(output / "source.npy", embedding, allow_pickle=False)
    identity = {"source_sha256": file_hash(output / "source.npy"), "reference_wav_sha256": file_hash(waveform),
                "encoder_sha256": file_hash(encoder_path), "source_shape": list(embedding.shape),
                "source_dtype": str(embedding.dtype), "source_norm": float(np.linalg.norm(embedding)),
                "basis": "actual-same-Northern-Ndebele-carrier-pcm16", "unit_normalized": False}
    runtime.update(source_identity=identity, technical_onnx_inference_verified=True)
    (output / "runtime_config.json").write_text(json.dumps(runtime, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    (output / "NOTICE.txt").write_text(
        "Northern Ndebele (nd/nde), multilingual-tts/VITS-OpenBible-Ndebele, CC BY-SA 4.0.\n"
        "https://creativecommons.org/licenses/by-sa/4.0/\n"
        "ONNX conversion from the exact pinned training checkpoint with strict inference weights.\n"
        "The checkpoint does NOT contain speaker conditioning; no three independently selectable voices are claimed.\n"
        "Coqui TTS inference/export code: MPL-2.0; model weights remain CC BY-SA 4.0.\n"
        "Training checkpoint, optimizer and PyTorch are NOT needed in the client.\n"
        "See UPSTREAM_README.md and export_provenance.json. No Southern Ndebele alias is provided.\n"
        "Source identity measured from this actual carrier with compatible FP32 OpenVoice V2 reference encoder.\n"
        "Native listening, ordinary character names and NVDA acceptance require separate checks.\n", encoding="utf8")
    carrier.close()
    return dict(runtime, status="prepared-real-onnx-carrier", onnxruntime_version=ort.__version__,
                torch_needed_on_client=False, model_bytes=(output / "model.onnx").stat().st_size,
                probe={"text": text, "kind": "native-grapheme-smoke-test", "audio_seconds": len(audio) / rate,
                       "graph_load_and_inference_seconds": inference_seconds,
                       "real_time_factor_including_load": inference_seconds / (len(audio) / rate),
                       "peak": float(np.max(np.abs(audio))), "rms": float(np.sqrt(np.mean(audio ** 2)))})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    phase = parser.add_mutually_exclusive_group(required=True)
    phase.add_argument("--download-only", action="store_true")
    phase.add_argument("--inspect-offline", action="store_true")
    phase.add_argument("--export-offline", action="store_true")
    phase.add_argument("--prepare-runtime", action="store_true")
    parser.add_argument("--checkpoint-root", type=Path, default=CHECKPOINT_ROOT)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--index", type=Path, default=INDEX)
    parser.add_argument("--report", type=Path, default=ROOT / "evidence/ndebele_export.json")
    args = parser.parse_args()
    index = json.loads(args.index.read_text(encoding="utf8"))
    if index.get("format") != "dordiai-ndebele-checkpoint-v1" or index.get("language") != "nd":
        parser.error("Unexpected Northern Ndebele checkpoint index")
    if args.download_only:
        acquire(args.checkpoint_root, index)
        result = {"status": "downloaded-pinned-checkpoint", "models_executed": False}
    elif args.inspect_offline:
        verify_sources(args.checkpoint_root, index)
        state, safety = safe_checkpoint(args.checkpoint_root / "model_last.pth")
        result = {"status": "safe-tensor-checkpoint-inspected", "safety": safety,
                  "speaker_embedding_shape": list(state["emb_g.weight"].shape) if "emb_g.weight" in state else None,
                  "text_embedding_shape": list(state["text_encoder.emb.weight"].shape),
                  "discriminator_tensors": sum(key.startswith("disc.") for key in state)}
    elif args.prepare_runtime:
        result = prepare_runtime(args.output)
    else:
        result = export(args.checkpoint_root, args.output, index)
    result["platform"] = platform.platform()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
