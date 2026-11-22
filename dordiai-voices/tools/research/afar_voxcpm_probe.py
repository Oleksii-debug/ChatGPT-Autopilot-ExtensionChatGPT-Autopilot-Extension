#!/usr/bin/env python3
"""Isolated Afar VoxCPM CPU research probe; never registers an NVDA resource.

Acquisition and inference are separate commands. Inference uses local, pinned
assets and audited OpenBMB source; no remote Python code or reference voice.
A finite waveform does not establish native pronunciation, correct symbols,
typing suitability, selected-voice projection or product readiness.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import sys
import time
import traceback
import urllib.request

MODEL_REPOSITORY = "michsethowusu/voxcpm-afrispeech-full-inference-20260606"
MODEL_REVISION = "e3d25f78d2613dc0e659f12711f4cac1bf1b81a1"
RUNTIME_REPOSITORY = "OpenBMB/VoxCPM"
RUNTIME_REVISION = "300e4260b509066151d623dc9c0aa922cf82232b"
FILES = {
    "pytorch_model.bin": "0b25598a4e2f9b63273744e5863cb06733dada7cb445b531bc625d6e2a581bf6",
    "audiovae.pth": "5b93f34c771281679b0ff93be3d1c1681eb1f301c3892e701db8f10a725b20a9",
    "config.json": None, "tokenizer.json": None,
    "tokenizer_config.json": None, "special_tokens_map.json": None,
    "README.md": None,
}
# Short, verbatim Afar examples from the publisher's actual training-data
# collection (18 words total). No original audio/reference is downloaded.
SAMPLES = [
    {"id": "Afar_aar_00000002", "text": "KANQAAN MARAT ABEN QEEBI."},
    {"id": "Afar_aar_00000010", "text": "Adoonibedek wokkel geeniih qeebi kaat aben."},
    {"id": "Afar_aar_00000009", "text": "Bedek deqsita aracal tabna alfih numuk yeysen."},
]
TEXT_SOURCE = "https://huggingface.co/datasets/AfriSpeech/youversion-african-speech"
CONDITIONING = {
    "requested_language": "aa / aar (Afar)",
    "training_subset": "Afar_aar",
    "selection": "Native Afar orthography, as documented by the fine-tune publisher",
    "explicit_language_token": None,
    "language_argument_exposed_by_runtime": False,
    "g2p_used": False,
    "related_language_substitution": False,
    "reference_voice_or_prompt_audio_used": False,
    "note": "This released multilingual model infers language from text. No invented language tag or neighbouring-language phonemizer is added. Native pronunciation remains unverified.",
}

def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def write_report(path, report):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def acquire(folder, report_path):
    folder.mkdir(parents=True, exist_ok=True)
    receipt = {"repository": MODEL_REPOSITORY, "revision": MODEL_REVISION,
               "candidate_license": "Apache-2.0 declared by publisher; original dataset/source terms remain separate",
               "weights_downloaded": True, "inference_executed": False, "files": {}}
    for name, expected in FILES.items():
        target = folder / name
        url = f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}/{name}"
        if target.is_file() and expected and digest(target) != expected:
            raise ValueError(f"Existing candidate file has wrong SHA256: {name}")
        if not target.is_file():
            temporary = folder / (name + ".partial")
            request = urllib.request.Request(url, headers={"User-Agent": "dordiai-afar-research/1"})
            with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as f:
                total = 0
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    total += len(block)
                    if total > (3_000_000_000 if name.endswith((".bin", ".pth")) else 20_000_000):
                        raise ValueError("Candidate file exceeds bounded download size")
                    f.write(block)
            temporary.replace(target)
        actual = digest(target)
        if expected is not None and actual != expected:
            raise ValueError(f"Publisher weight SHA256 mismatch: {name}")
        receipt["files"][name] = {"sha256": actual, "bytes": target.stat().st_size,
                                  "expected_sha256": expected, "url": url,
                                  "pin": "exact immutable model revision"}
        write_report(report_path, receipt)
    write_report(folder / "dordiai-acquisition.json", receipt)
    return receipt

def validate_assets(folder):
    receipt_path = folder / "dordiai-acquisition.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt["repository"] != MODEL_REPOSITORY or receipt["revision"] != MODEL_REVISION:
        raise ValueError("Acquisition receipt identifies a different checkpoint")
    for name, expected in FILES.items():
        path = folder / name
        actual = digest(path)
        if actual != receipt["files"][name]["sha256"] or expected and actual != expected:
            raise ValueError("Local candidate asset changed: " + name)
    return receipt

def install_network_guard(report):
    def audit(event, arguments):
        if event in {"socket.connect", "socket.getaddrinfo", "socket.bind", "socket.sendto"}:
            report.setdefault("blocked_network_attempts", []).append({"event": event})
            raise RuntimeError("Inference is offline: network socket operation blocked")
    sys.addaudithook(audit)
    report["offline_socket_guard_enabled"] = True

def checkpoint_state(torch, path):
    try:
        checkpoint = torch.load(path, map_location="cpu", weights_only=True, mmap=True)
    except RuntimeError as error:
        if "mmap" not in str(error).lower():
            raise
        checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    state = checkpoint.get("state_dict", checkpoint)
    if not isinstance(state, dict) or not state or not all(isinstance(k, str) for k in state):
        raise ValueError("Checkpoint is not a nonempty tensor state mapping")
    return state

def probe(folder, runtime, output, report_path):
    output.mkdir(parents=True, exist_ok=True)
    report = {"status": "candidate-unintegrated", "language": "aa",
              "repository": MODEL_REPOSITORY, "model_revision": MODEL_REVISION,
              "runtime_repository": RUNTIME_REPOSITORY, "runtime_revision": RUNTIME_REVISION,
              "conditioning": CONDITIONING, "text_source": TEXT_SOURCE,
              "source_text_revision": None,
              "source_text_revision_limitation": "Publisher dataset examples observed 2026-11-22; row identifiers retained. No dataset revision hash is invented.",
              "registered_in_product": False, "native_listener_verified": False,
              "native_pronunciation_verified": False, "nvda_or_windows_verified": False,
              "typing_or_character_names_verified": False, "selected_voice_projection_verified": False,
              "cases": []}
    write_report(report_path, report)
    try:
        report["assets"] = validate_assets(folder)
        for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
            os.environ[key] = "1"
        os.environ["DO_NOT_TRACK"] = "1"
        os.environ["TOKENIZERS_PARALLELISM"] = "false"
        install_network_guard(report)
        source_blobs = {
            "src/voxcpm/model/voxcpm.py": "20fc15b6df0955b018c8329f84f0ceecec37da71",
            "src/voxcpm/model/utils.py": "f6d7463ca19ab6cc0ddcbd44563603aa8029b6a7",
            "src/voxcpm/modules/audiovae/audio_vae.py": "38899180cfa8b2ffbcfc3aadc439310790efb03b"}
        for relative, expected in source_blobs.items():
            data = (runtime / relative).read_bytes()
            actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            if actual != expected:
                raise ValueError("Audited runtime source differs: " + relative)
        report["audited_runtime_git_blobs_verified"] = source_blobs
        sys.path.insert(0, str(runtime / "src"))
        import numpy as np
        import soundfile as sf
        import torch
        from transformers import LlamaTokenizerFast
        from voxcpm.model.voxcpm import VoxCPMConfig, VoxCPMModel
        from voxcpm.modules.audiovae import AudioVAE
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        torch.manual_seed(20261122)
        if torch.version.cuda is not None:
            raise RuntimeError("Research job must use the pinned CPU-only PyTorch wheel")
        config = VoxCPMConfig.model_validate_json((folder / "config.json").read_text())
        report["original_config_dtype"] = config.dtype
        report["original_config_max_length"] = config.max_length
        # Memory-only runtime choices, not edits to checkpoint files or tensors.
        config.device = "cpu"
        config.dtype = "float32"
        config.max_length = min(config.max_length, 256)
        report["runtime_overrides"] = {"device": "cpu", "dtype": config.dtype,
                                       "cache_horizon": config.max_length,
                                       "checkpoint_files_rewritten": False}
        tokenizer = LlamaTokenizerFast.from_pretrained(str(folder), local_files_only=True,
                                                       trust_remote_code=False)
        vae = AudioVAE(config=config.audio_vae_config) if config.audio_vae_config else AudioVAE()
        started = time.perf_counter()
        model = VoxCPMModel(config, tokenizer, vae, device="cpu")
        state = checkpoint_state(torch, folder / "pytorch_model.bin")
        vae_state = checkpoint_state(torch, folder / "audiovae.pth")
        state = dict(state)
        for key, value in vae_state.items():
            state["audio_vae." + key] = value
        # Unlike the upstream permissive loader, require complete key parity.
        # A mismatched checkpoint cannot generate a falsely accepted random head.
        result = model.load_state_dict(state, strict=True)
        report["state_keys_missing"] = list(result.missing_keys)
        report["state_keys_unexpected"] = list(result.unexpected_keys)
        del state, vae_state
        model = model.to("cpu").eval().optimize(disable=True)
        report["model_load_seconds"] = time.perf_counter() - started
        report["parameter_count"] = sum(p.numel() for p in model.parameters())
        report["sample_rate"] = int(model.sample_rate)
        if report["sample_rate"] != 16000:
            raise ValueError("Published 16kHz AudioVAE contract differs from actual checkpoint")
        report["torch_version"] = torch.__version__
        report["runtime_file"] = str(sys.modules["voxcpm.model.voxcpm"].__file__)
        report["runtime_source_git_blob"] = {
            "src/voxcpm/model/voxcpm.py": "20fc15b6df0955b018c8329f84f0ceecec37da71",
            "src/voxcpm/model/utils.py": "f6d7463ca19ab6cc0ddcbd44563603aa8029b6a7",
            "src/voxcpm/modules/audiovae/audio_vae.py": "38899180cfa8b2ffbcfc3aadc439310790efb03b"}
        for index, sample in enumerate(SAMPLES):
            ids = list(model.text_tokenizer(sample["text"]))
            if not ids or tokenizer.unk_token_id is not None and tokenizer.unk_token_id in ids:
                raise ValueError("Native Afar input contains unknown tokenizer units")
            if len(ids) + 96 + 1 > config.max_length:
                raise ValueError("Native text exceeds bounded CPU cache horizon")
            started = time.perf_counter()
            with torch.inference_mode():
                waveform = model.generate(target_text=sample["text"], prompt_text="",
                                          prompt_wav_path="", inference_timesteps=10,
                                          cfg_value=2.0, min_len=2, max_len=96,
                                          retry_badcase=False, seed=20261122 + index)
            audio = waveform.detach().float().cpu().numpy().reshape(-1)
            if audio.size < 512 or not np.isfinite(audio).all() or float(np.max(np.abs(audio))) < 1e-6:
                raise ValueError("Candidate produced empty, nonfinite or silent native-text PCM")
            elapsed = time.perf_counter() - started
            target = output / ("afar-" + str(index).zfill(2) + ".wav")
            sf.write(target, audio, model.sample_rate, subtype="PCM_16")
            encoded_capacity = 96 * model.patch_size * model.chunk_size
            report["cases"].append({**sample, "token_ids": ids,
                "seconds": len(audio) / model.sample_rate, "samples": len(audio),
                "inference_seconds": elapsed, "real_time_factor": elapsed / (len(audio) / model.sample_rate),
                "peak": float(np.max(np.abs(audio))), "rms": float(np.sqrt(np.mean(audio ** 2))),
                "wav_sha256": digest(target), "wav_file": target.name,
                "finite_nonzero": True,
                "may_have_reached_generation_cap": len(audio) >= encoded_capacity})
            report["peak_rss_kib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            write_report(report_path, report)
        report["status"] = "real-native-text-pcm-candidate-unintegrated"
        report["native_text_pcm_executed"] = True
        return report
    except BaseException as error:
        report["status"] = "candidate-probe-failed"
        report["error"] = {"type": type(error).__name__, "message": str(error),
                           "traceback": traceback.format_exc()[-16000:]}
        raise
    finally:
        report["peak_rss_kib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        write_report(report_path, report)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("acquire", "probe"))
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.mode == "acquire":
        acquire(args.models, args.output / "acquisition.json")
    else:
        if args.runtime is None:
            parser.error("--runtime is required for offline inference")
        probe(args.models, args.runtime, args.output, args.output / "afar-probe.json")

if __name__ == "__main__":
    main()
