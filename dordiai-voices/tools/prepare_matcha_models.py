"""Acquire, safely export and prepare the pinned native Kashmiri Bolbosh model.

PyTorch, Lightning and Diffusers are preparation-only dependencies. Downloads
are separate from offline model execution; clients require only the ONNX graph.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import runpy
import shutil
import sys
import time
import types
from urllib.request import urlopen

from prepare_mms_models import digest, write_json

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
DIRECTORY = ROOT / "downloads/matcha-ks"
OUTPUT = ROOT / "model-packs/matcha/kx47Runtime/models/ExtraLanguages/ks"
PUBLISHER_TEXT = "مےٛ چھُ آز سُلۍ وۄستادَس نِش گَژھُن، سُہ پرناوِ مےٛ آز بَدل کانٛہہ سبَق۔"


def download(record, path, offline=False):
    if path.is_symlink():
        raise ValueError("Matcha resource destination must not be a symlink")
    size = record["size_bytes"]
    if path.is_file() and path.stat().st_size == size and digest(path) == record["sha256"]:
        return path
    if offline:
        raise FileNotFoundError("Offline Matcha verification requires the pinned artifact: " + str(path))
    prefixes = ("https://huggingface.co/GAASH-Lab/Matcha-TTS-Kashmiri/resolve/",
                "https://raw.githubusercontent.com/gaash-lab/Bolbosh/",
                "https://raw.githubusercontent.com/abdulmuizz0903/KashmiriNormalizer/",
                "https://github.com/shivammehta25/Matcha-TTS-checkpoints/releases/download/v1.0/")
    if not record["url"].startswith(prefixes) or not 0 <= size <= 300 * 1024 * 1024:
        raise ValueError("Unexpected Matcha source URL or size")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".download")
    try:
        count = 0
        with urlopen(record["url"], timeout=60) as source, temporary.open("wb") as target:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                count += len(chunk)
                if count > size:
                    raise ValueError("Matcha source exceeds its pinned length")
                target.write(chunk)
        if count != size or digest(temporary) != record["sha256"]:
            raise ValueError("Matcha source differs from its pinned SHA256")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def verify(directory, index):
    for name, record in index["assets"].items():
        download(record, directory / name, offline=True)


def frontend_config(directory):
    symbols = runpy.run_path(str(directory / "source/matcha/text/symbols.py"))["symbols"]
    constants = runpy.run_path(str(directory / "normalizer/src/KashmiriNormalizer/constants.py"))
    return {"format": "dordiai-matcha-native-frontend-v1", "code": "ks", "symbols": symbols,
            "character_mapping": constants["KASHMIRI_CHARACTER_MAPPING"],
            "punctuation_mapping": constants["PUNCTUATION_MAP"],
            "digits_mapping": constants["ENG_KASHMIRI_DIGITS_MAP"],
            "word_to_digit_mapping": constants["WORD_TO_DIGIT_MAP"],
            "punctuations": sorted(constants["KASHMIRI_PUNCTUATIONS"]),
            "allowed_characters": sorted(constants["ALL_CHARACTERS"])}


def safe_checkpoint(path):
    import collections
    import functools
    import typing
    import torch
    from omegaconf import DictConfig, ListConfig
    from omegaconf.base import ContainerMetadata, Metadata
    from omegaconf.nodes import AnyNode
    expected = {"typing.Any", "builtins.list", "omegaconf.listconfig.ListConfig", "builtins.dict",
                "omegaconf.base.ContainerMetadata", "collections.defaultdict", "builtins.int",
                "omegaconf.base.Metadata", "functools.partial", "omegaconf.dictconfig.DictConfig",
                "omegaconf.nodes.AnyNode", "torch.optim.adam.Adam"}
    unsafe = set(torch.serialization.get_unsafe_globals_in_checkpoint(path))
    if unsafe != expected:
        raise ValueError("Kashmiri checkpoint pickle metadata differs from the audited explicit allowlist")
    # The allowlist is written in code, never imported from unpickling errors.
    # Adam is a saved hyperparameter class, never instantiated by inference.
    safe = [typing.Any, list, dict, int, DictConfig, ListConfig, ContainerMetadata, Metadata,
            AnyNode, collections.defaultdict, functools.partial, torch.optim.Adam]
    with torch.serialization.safe_globals(safe):
        checkpoint = torch.load(path, weights_only=True, mmap=True, map_location="cpu")
    if (not isinstance(checkpoint, dict) or not isinstance(checkpoint.get("state_dict"), dict)
            or not all(isinstance(k, str) and isinstance(v, torch.Tensor)
                       for k, v in checkpoint["state_dict"].items())):
        raise ValueError("Kashmiri checkpoint is not the expected tensor state dictionary")
    return checkpoint, sorted(unsafe)


def export(directory, index):
    import os
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1")
    verify(directory, index)
    import torch
    import numpy as np
    import onnxruntime as ort
    if ort.__version__ != "1.27.0":
        raise ValueError("Offline export validation requires the selected ONNX Runtime1.27.0")
    ort.disable_telemetry_events()
    torch.set_num_threads(2)
    sys.path[:0] = [str(directory / "source"), str(directory / "normalizer/src"), str(RUNTIME)]
    # Monotonic alignment is training-only, imported eagerly upstream. Make its
    # unavailable operation explicit instead of requiring a Cython build or
    # silently substituting a numerical implementation. synthesize never calls it.
    if "matcha.utils.monotonic_align" not in sys.modules:
        import importlib
        utilities = importlib.import_module("matcha.utils")
        alignment = types.ModuleType("matcha.utils.monotonic_align")
        def no_training_alignment(*args, **kwargs):
            raise RuntimeError("Monotonic alignment training is not part of offline inference/export")
        alignment.maximum_path = no_training_alignment
        sys.modules[alignment.__name__] = alignment
        utilities.monotonic_align = alignment
    from matcha.models.matcha_tts import MatchaTTS
    from matcha.hifigan.models import Generator
    from matcha.hifigan.env import AttrDict
    from matcha.hifigan.config import v1
    from matcha.text import text_to_sequence
    from matcha.utils.utils import intersperse
    from wide_matcha import MatchaFrontend
    checkpoint, audited_globals = safe_checkpoint(directory / "model.ckpt")
    hparams = dict(checkpoint["hyper_parameters"])
    hparams.update(optimizer=None, scheduler=None)
    if (hparams.get("n_vocab") != 272 or hparams.get("n_spks") != 424 or hparams.get("n_feats") != 80
            or checkpoint["state_dict"]["spk_emb.weight"].shape != (424, 64)):
        raise ValueError("Kashmiri checkpoint architecture does not match the published model")
    model = MatchaTTS(**hparams).cpu().eval()
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.requires_grad_(False)
    vocoder = Generator(AttrDict(v1)).cpu().eval()
    vocoder.load_state_dict(torch.load(directory / "g_02500000", weights_only=True,
                                      map_location="cpu")["generator"], strict=True)
    vocoder.remove_weight_norm()
    vocoder.requires_grad_(False)
    config = frontend_config(directory)
    native = MatchaFrontend(config)
    exported = directory / "export"
    exported.mkdir(parents=True, exist_ok=True)
    write_json(exported / "config.json", config)

    class EndToEnd(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.model, self.vocoder = model, vocoder
        def forward(self, x, x_lengths, scales, spks):
            result = self.model.synthesise(x, x_lengths, 10, scales[0], spks, scales[1])
            return self.vocoder(result["mel"]).clamp(-1, 1).squeeze(1), result["mel_lengths"] * 256

    wrapper = EndToEnd().eval()
    texts = ["آداب۔", "بہٕ چھُس بولان۔", PUBLISHER_TEXT]
    def inputs(text, speaker=422, rate=1.):
        actual = native.ids(text)
        upstream = intersperse(text_to_sequence(text, ["basic_cleaners"])[0], 0)
        if actual != upstream:
            raise ValueError("Native frontend IDs differ from the actual upstream training tokenizer")
        return (torch.tensor([actual], dtype=torch.int64), torch.tensor([len(actual)], dtype=torch.int64),
                torch.tensor([0., 1. / rate], dtype=torch.float32), torch.tensor([speaker], dtype=torch.int64))
    # Reset RoPE caches before tracing. A prewarmed cache would freeze its
    # maximum length into the graph and fail on longer subsequent text.
    for module in model.modules():
        if hasattr(module, "cos_cached"):
            module.cos_cached = module.sin_cached = None
    path = exported / "model.onnx"
    with torch.inference_mode():
        torch.onnx.export(wrapper, inputs(texts[1]), str(path), input_names=["x", "x_lengths", "scales", "spks"],
                          output_names=["wav", "wav_lengths"], opset_version=17, do_constant_folding=True,
                          dynamic_axes={"x": {0: "batch", 1: "tokens"}, "x_lengths": {0: "batch"},
                                        "spks": {0: "batch"}, "wav": {0: "batch", 1: "samples"},
                                        "wav_lengths": {0: "batch"}})
    options = ort.SessionOptions()
    options.intra_op_num_threads, options.inter_op_num_threads = 2, 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    session = ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
    checks = []
    for text, speaker, speed in [(texts[0], 422, 1.), (texts[1], 422, 1.), (texts[2], 422, 1.),
                                  (texts[1], 423, 1.), (texts[1], 422, 2.)]:
        args = inputs(text, speaker, speed)
        with torch.inference_mode():
            expected, expected_lengths = wrapper(*args)
        started = time.monotonic()
        actual, lengths = session.run(None, {k: v.numpy() for k, v in zip(["x", "x_lengths", "scales", "spks"], args)})
        seconds = time.monotonic() - started
        if actual.shape != tuple(expected.shape) or not np.array_equal(lengths, expected_lengths.numpy()):
            raise ValueError("Kashmiri dynamic export length differs from original PyTorch")
        error = float(np.max(np.abs(expected.numpy() - actual)))
        cosine = float(np.dot(expected.numpy().ravel(), actual.ravel()) / (np.linalg.norm(expected.numpy()) * np.linalg.norm(actual)))
        if error >= .003 or cosine < .999 or not np.isfinite(actual).all():
            raise ValueError("Kashmiri ONNX parity failed")
        checks.append({"text": text, "speaker": speaker, "speed": speed, "token_ids": args[0][0].tolist(),
                       "samples": int(lengths[0]), "seconds": seconds, "max_error": error, "cosine": cosine})
    report = {"format": "dordiai-matcha-export-v1", "repo_id": index["repo_id"], "revision": index["revision"],
              "source_revision": index["source_revision"], "normalizer_revision": index["normalizer_revision"],
              "checkpoint_sha256": digest(directory / "model.ckpt"), "vocoder_sha256": digest(directory / "g_02500000"),
              "model_sha256": digest(path), "config_sha256": digest(exported / "config.json"),
              "model_bytes": path.stat().st_size, "torch": torch.__version__, "onnxruntime": ort.__version__,
              "weights_only": True, "audited_pickle_metadata_allowlist": audited_globals,
              "training_alignment_not_initialized": True, "torch_runtime_required": False,
              "opset": 17, "steps": 10, "parity": checks, "unsupported_native_characters": ["ٲ"],
              "native_pronunciation_verified": False, "windows_nvda_verified": False}
    write_json(exported / "export_provenance.json", report)
    write_json(ROOT / "evidence/matcha_export.json", report)
    return report


def prepare(directory, output, index, encoder_path):
    import numpy as np
    import soundfile as sf
    import onnxruntime as ort
    if ort.__version__ != "1.27.0":
        raise ValueError("Offline preparation requires the selected ONNX Runtime1.27.0")
    ort.disable_telemetry_events()
    from prepare_reference_encoder import ENCODERS, load_encoder, extract_embedding
    if digest(encoder_path) != ENCODERS["fp32"]["sha256"]:
        raise ValueError("Source identity requires the compatible pinned FP32 reference encoder")
    sys.path.insert(0, str(RUNTIME))
    from wide_matcha import NativeMatcha
    exported = directory / "export"
    provenance = json.loads((exported / "export_provenance.json").read_text(encoding="utf-8"))
    if (digest(exported / "model.onnx") != provenance["model_sha256"]
            or digest(exported / "config.json") != provenance["config_sha256"]):
        raise ValueError("Exported Kashmiri graph/frontend changed after parity verification")
    output.mkdir(parents=True, exist_ok=True)
    for name in ("model.onnx", "config.json", "export_provenance.json"):
        shutil.copyfile(exported / name, output / name)
    runtime = {"format": "dordiai-matcha-onnx-v1", "backend": "extra-onnx", "code": "ks", "iso_code": "kas",
               "sample_rate": 22050, "speaker": 422, "steps": 10, "temperature": .667,
               "repo_id": index["repo_id"], "revision": index["revision"], "license": "MIT",
               "minimum_core_version": "0.13.1-dev.3", "model_sha256": provenance["model_sha256"],
               "config_sha256": provenance["config_sha256"], "technical_onnx_inference_verified": True,
               "native_pronunciation_verified": False, "navigation_verified": False, "windows_nvda_verified": False,
               "unsupported_native_characters": ["ٲ"], "unsupported_policy": "reject-or-explicit-installed-same-language-alternative"}
    write_json(output / "runtime_config.json", runtime)
    carrier = NativeMatcha(output)
    started = time.monotonic()
    audio = carrier.audio(PUBLISHER_TEXT, temperature=0.)
    seconds = time.monotonic() - started
    evidence = ROOT / "evidence/matcha_audio"
    evidence.mkdir(parents=True, exist_ok=True)
    wav = evidence / "ks-native-carrier.wav"
    sf.write(wav, audio, carrier.rate, subtype="PCM_16")
    enrollment, rate = sf.read(wav, dtype="float32")
    vector = extract_embedding(enrollment, rate, load_encoder(encoder_path))
    np.save(output / "source.npy", vector, allow_pickle=False)
    runtime["source_identity"] = {"basis": "actual-same-native-matcha-carrier-pcm16-waveform", "source_sha256": digest(output / "source.npy"),
                                  "reference_wav_sha256": digest(wav), "encoder_sha256": digest(encoder_path),
                                  "source_shape": list(vector.shape), "source_dtype": str(vector.dtype),
                                  "source_norm": float(np.linalg.norm(vector)), "unit_normalized": False}
    write_json(output / "runtime_config.json", runtime)
    for name, source in (("LICENSE-BOLBOSH.txt", directory / "source/LICENSE"),
                         ("LICENSE-NORMALIZER.txt", directory / "normalizer/LICENSE"),
                         ("UPSTREAM-README.md", directory / "source/README.md")):
        shutil.copyfile(source, output / name)
    (output / "NOTICE.txt").write_text(
        "Native Kashmiri Bolbosh/Matcha model (MIT), GAASH Lab and authors.\n"
        "https://github.com/gaash-lab/Bolbosh @ " + index["source_revision"] + "\n"
        "https://huggingface.co/GAASH-Lab/Matcha-TTS-Kashmiri @ " + index["revision"] + "\n"
        "Paper: https://arxiv.org/abs/2603.07513\n"
        "KashmiriNormalizer (MIT), Abdul Muizz @ " + index["normalizer_revision"] + "\n"
        "Universal HiFiGAN v1: official shivammehta25/Matcha-TTS-checkpoints release.\n"
        "Runtime is ONNX only. Source identity measured from this exact native carrier; no copied voice vector.\n"
        "Experimental text synthesis. Native U+0672 is absent from the trained vocabulary; it is explicitly rejected.\n"
        "Technical parity does not establish native pronunciation, character-name or NVDA acceptance.\n", encoding="utf-8")
    report = dict(runtime, status="prepared-real-onnx-carrier", model_bytes=(output / "model.onnx").stat().st_size,
                  probe={"text": PUBLISHER_TEXT, "kind": "publisher-native-sentence", "samples": len(audio),
                         "audio_seconds": len(audio) / carrier.rate, "seconds_including_load": seconds,
                         "finite": bool(np.isfinite(audio).all()), "peak": float(np.max(np.abs(audio)))})
    write_json(ROOT / "evidence/matcha_preparation.json", report)
    carrier.close()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--download-only", action="store_true")
    mode.add_argument("--export-offline", action="store_true")
    mode.add_argument("--prepare-runtime", action="store_true")
    parser.add_argument("--directory", type=Path, default=DIRECTORY)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--index", type=Path, default=ROOT / "tools/matcha_checkpoint_sources.json")
    parser.add_argument("--reference-encoder", type=Path, default=ROOT / "model-packs/shared-reference/kx47Runtime/models/OpenVoiceV2/tone_ref_encoder.onnx")
    args = parser.parse_args()
    index = json.loads(args.index.read_text(encoding="utf-8"))
    if index.get("format") != "dordiai-matcha-checkpoint-sources-v1" or index.get("code") != "ks":
        parser.error("Unsupported native Matcha source index")
    if args.download_only:
        def acquire(item):
            name, record = item
            return download(record, args.directory / name)
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(acquire, index["assets"].items()))
        result = {"status": "downloaded-pinned-artifacts", "count": len(index["assets"]), "models_executed": False}
    elif args.export_offline:
        result = export(args.directory, index)
    else:
        result = prepare(args.directory, args.output, index, args.reference_encoder)
    print(json.dumps({k: result[k] for k in ("status", "model_bytes", "model_sha256") if k in result}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
