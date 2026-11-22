"""Standalone six-layer AfricaTTS Python-ORT CPU candidate; never registers a voice.

Graph host loop follows the pinned publisher FP32 parity recipe and Sherpa Pocket
implementation. Native orthography is converted only through the exact trained
Swati/Venda G2P. No Torch, Sherpa native DLL, other-language fallback or model edits.
"""
from __future__ import annotations
import argparse
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from time import perf_counter

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("afri_ort_pins", HERE / "afri_six_layer_probe.py")
pins = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pins)
common = pins.common
ROLES = common.ROLES
RATE = 24000
LOOP_SOURCE = {"sherpa_revision": "af2d8d81dbfa61c4cea4c568da78f3982edca005",
               "sherpa_pocket_impl_blob": "c8e30a51272ac87bef0aa5ca56b4a98f6c011e04",
               "publisher_parity_blob": "70271b1d5f69626650cca086fa735ec94722c683"}
GRAPH_ARTIFACT = {"id": 14752457496, "run_id": 45017187461,
                  "zip_sha256": "1b7053f683714e6e5e734dac23e3c3e3dd1991b9f5eab52c12520e5e67e4fba3",
                  "zip_bytes": 367643455, "source_commit": "fd4c68c255e045c41ee5f63073174a8e566f621c"}


def acquire(args):
    root = args.assets.resolve()
    root.mkdir(parents=True, exist_ok=True)
    metadata = common.read_json_url("https://huggingface.co/api/models/AfriSpeech/africa-tts/revision/" + pins.MODEL_REVISION + "?blobs=true")
    if metadata.get("sha") != pins.MODEL_REVISION:
        raise ValueError("Publisher revision changed")
    rows = {x["rfilename"]: x for x in metadata["siblings"]}
    report = {"format": "afri-six-ort-small-inputs-v1", "revision": pins.MODEL_REVISION,
              "files": {}, "checkpoint_weights_downloaded": False, "product_integrated": False}
    common.write_json(args.report, report, overwrite=args.overwrite)
    targets = {"tokenizer.json": pins.PINS["tokenizer.json"], "config.yaml": pins.PINS["config.yaml"]}
    for code in common.LANGUAGES:
        relative = "voices/" + code + ".wav"
        if relative not in rows:
            relative = "sherpa-onnx/voices/" + code + ".wav"
        if relative not in rows:
            raise ValueError("Same-language reference missing")
        targets[relative] = common.artifact_record(rows[relative])
    for relative, expected in targets.items():
        path = root / relative
        common.download("https://huggingface.co/AfriSpeech/africa-tts/resolve/" + pins.MODEL_REVISION + "/" + relative, path, expected)
        role = "voice_" + Path(relative).stem if relative.endswith(".wav") else relative
        report["files"][role] = dict(expected, relative=relative, raw_sha256=common.digest(path))
    for role, (relative, size, blob) in common.SOURCE_FILES.items():
        path = root / role
        expected = {"bytes": size, "git_blob_sha1": blob}
        common.download("https://raw.githubusercontent.com/AfriSpeech/africa-tts/" + pins.SOURCE_REVISION + "/" + relative, path, expected)
        report["files"][role] = dict(expected, relative=role, raw_sha256=common.digest(path))
    report["status"] = "pinned-small-inputs-acquired"
    common.write_json(root / "small-inputs.json", report)
    common.write_json(args.report, report)
    return report


def validate_graphs(root):
    root = Path(root).resolve()
    record = json.loads((root / "dordiai-export-provenance.json").read_text(encoding="utf-8"))
    source = record.get("source_index", {})
    if record.get("status") != "exported-six-layer-fp32" or source.get("revision") != pins.MODEL_REVISION:
        raise ValueError("Not the exact completed six-layer export")
    if source["files"]["model.safetensors"]["raw_sha256"] != pins.CHECKPOINT_SHA256:
        raise ValueError("Wrong published source checkpoint")
    if source.get("checkpoint_facts", {}).get("flow_lm_layer_ids") != list(range(6)):
        raise ValueError("Not six actual source layers")
    paths = {}
    for role, row in record["exported_files"].items():
        # Linux provenance paths are descriptive; actual filenames are fixed here.
        name = role + ".onnx" if role in ROLES else role.removesuffix("_json") + ".json"
        path = root / name
        if path.is_symlink() or path.stat().st_size != row["bytes"] or common.digest(path) != row["sha256"]:
            raise ValueError("Derived graph/tokenizer changed: " + name)
        paths[role] = path
    if set(paths) != set(ROLES) | {"vocab_json", "token_scores_json"}:
        raise ValueError("Unexpected derived graph set")
    if record["exported_files"]["lm_main"]["facts"]["observed_layer_ids_from_weight_names"] != list(range(6)):
        raise ValueError("Not exactly six actual graph layers")
    return paths, record


def python_socket_guard():
    def audit(event, args):
        if event in {"socket.connect", "socket.bind", "socket.getaddrinfo", "socket.sendto"}:
            raise RuntimeError("Offline native candidate: Python network operation forbidden")
    sys.addaudithook(audit)


class SixLayerOrtCarrier:
    """Experimental unregistered 24kHz carrier using the existing PythonORT family."""

    def __init__(self, graphs, tokenizer, *, threads=2, expected_ort_version="1.27.0", package_python=None):
        import numpy as np
        import onnxruntime as ort
        ort.disable_telemetry_events()
        if ort.__version__ != expected_ort_version:
            raise ValueError("Actual ONNX Runtime differs from the explicitly requested unchanged-runtime version")
        if package_python is not None and not Path(ort.__file__).resolve().is_relative_to(Path(package_python).resolve()):
            raise ValueError("ONNX Runtime was not imported from the actual private package")
        if "torch" in sys.modules or "sherpa_onnx" in sys.modules:
            raise RuntimeError("Mixed native inference families are forbidden")
        from tokenizers import Tokenizer
        self.np, self.ort = np, ort
        self.paths, self.provenance = validate_graphs(graphs)
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        self.sessions = {role: ort.InferenceSession(str(self.paths[role]), options,
                         providers=["CPUExecutionProvider"]) for role in ROLES}
        self.tokenizer = Tokenizer.from_file(str(tokenizer))
        self.unknown_id = json.loads(Path(tokenizer).read_text(encoding="utf-8")).get("model", {}).get("unk_id")
        self.voice_cache = {}
        self.last_facts = None
        self.rate = RATE

    def zero_state(self, role, first):
        np = self.np
        dtypes = {"tensor(float)": np.float32, "tensor(int64)": np.int64, "tensor(bool)": np.bool_}
        return {item.name: np.zeros([dim if isinstance(dim, int) else 1 for dim in item.shape], dtypes[item.type])
                for item in self.sessions[role].get_inputs()[first:]}

    def audio(self, ipa, reference, reference_rate, *, temperature=0.3, seed=42, max_frames=500):
        np = self.np
        if reference_rate != RATE:
            raise ValueError("This proof requires genuine native24kHz reference; no implicit resampler")
        wave = np.asarray(reference, dtype=np.float32)
        if wave.ndim != 1 or not np.isfinite(wave).all() or len(wave) < 512:
            raise ValueError("Invalid native reference")
        wave = np.ascontiguousarray(wave[:10 * RATE])
        key = sha256(wave.tobytes()).hexdigest()
        if key not in self.voice_cache:
            if len(self.voice_cache) >= 2:
                self.voice_cache.pop(next(iter(self.voice_cache)))
            self.voice_cache[key] = self.sessions["encoder"].run(None, {"audio": wave[None, None]})[0]
        voice = self.voice_cache[key]
        ids = self.tokenizer.encode(ipa).ids
        if not ids or (self.unknown_id is not None and self.unknown_id in ids):
            raise ValueError("Empty or unknown tokenizer units")
        text = self.sessions["text_conditioner"].run(None, {"token_ids": np.asarray([ids], np.int64)})[0]
        state = self.zero_state("lm_main", 2)
        empty_seq, empty_txt = np.zeros((1, 0, 32), np.float32), np.zeros((1, 0, 1024), np.float32)

        def main(seq, emb):
            outputs = self.sessions["lm_main"].run(None, {"sequence": seq, "text_embeddings": emb, **state})
            if len(outputs) != len(state) + 2:
                raise ValueError("Unexpected recurrent state contract")
            for name, value in zip(list(state), outputs[2:]):
                state[name] = value
            return outputs[0], outputs[1]

        main(empty_seq, voice)
        main(empty_seq, text)
        current = np.full((1, 1, 32), np.nan, np.float32)
        random = np.random.default_rng(seed)
        latents, eos_step, eos_last, reached_cap = [], None, None, True
        for step in range(max_frames):
            conditioning, eos = main(current, empty_txt)
            eos_last = float(eos.reshape(-1)[0])
            if eos_step is None and eos_last > -4.:
                eos_step = step
            # Match the pinned official Sherpa stop policy, including its step-zero detail.
            if eos_step is not None and eos_step > 0 and step >= eos_step + 3:
                reached_cap = False
                break
            noise = random.normal(0., np.sqrt(temperature), (1, 32)).astype(np.float32)
            direction = self.sessions["lm_flow"].run(None, {"c": conditioning,
                          "s": np.zeros((1, 1), np.float32), "t": np.ones((1, 1), np.float32), "x": noise})[0]
            latent = noise + direction  # Exact one-LSD-step Euler update, dt=1.
            if not np.isfinite(latent).all():
                raise ValueError("Nonfinite latent")
            latents.append(latent[0])
            current = latent[:, None]
        if not latents:
            raise ValueError("No generated frames")
        # Release model state before decoder allocations, as in the native implementation.
        state.clear()
        latent = np.asarray(latents, np.float32)[None]
        decoder_state = self.zero_state("decoder", 1)
        chunks = []
        for start in range(0, latent.shape[1], 15):
            outputs = self.sessions["decoder"].run(None, {"latent": latent[:, start:start + 15], **decoder_state})
            if len(outputs) != len(decoder_state) + 1:
                raise ValueError("Unexpected decoder state contract")
            for name, value in zip(list(decoder_state), outputs[1:]):
                decoder_state[name] = value
            chunks.append(outputs[0].reshape(-1))
        audio = np.concatenate(chunks).astype(np.float32)
        if not np.isfinite(audio).all() or len(audio) < 2400:
            raise ValueError("Invalid native PCM")
        self.last_facts = {"token_ids": ids, "latent_frames": len(latents), "eos_step": eos_step,
                           "eos_last": eos_last, "generation_cap_reached": reached_cap,
                           "seed": seed, "temperature": temperature, "frame_limit": max_frames,
                           "source_loop": LOOP_SOURCE, "random_sequence_note":
                           "NumPy generator differs from C++ RNG; deterministic per our fixed seed, not sample-identical to Sherpa."}
        return audio



def read_reference_wav(path):
    """Read the actual expected PCM16 native reference without a new audio DLL."""
    import numpy as np
    import wave
    path = Path(path)
    if path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Native reference WAV exceeds the bounded input budget")
    with wave.open(str(path), "rb") as source:
        facts = {"channels": source.getnchannels(), "sample_width": source.getsampwidth(),
                 "sample_rate": source.getframerate(), "frames": source.getnframes(),
                 "compression": source.getcomptype()}
        if facts["sample_width"] != 2 or facts["channels"] not in (1, 2) or facts["compression"] != "NONE":
            raise ValueError("Unsupported native reference WAV format: " + repr(facts))
        raw = source.readframes(facts["frames"])
    if len(raw) != facts["frames"] * facts["channels"] * 2:
        raise ValueError("Truncated PCM16 native reference WAV")
    audio = np.frombuffer(raw, "<i2").astype(np.float32) / 32768.
    audio = audio.reshape(-1, facts["channels"]).mean(axis=1).astype(np.float32)
    return audio, facts["sample_rate"], facts


def write_pcm16_wav(path, audio, rate):
    import numpy as np
    import wave
    if not np.isfinite(audio).all():
        raise ValueError("Refusing nonfinite output PCM")
    pcm = (np.clip(audio, -1., 1. - 1. / 32768.) * 32768.).astype("<i2")
    with Path(path).open("xb") as stream:
        with wave.open(stream, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(rate)
            output.writeframes(pcm.tobytes())


def peak_rss():
    if sys.platform == "win32":
        import ctypes
        class Counters(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
        row = Counters()
        row.cb = ctypes.sizeof(row)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
        if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(row), row.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        return int(row.PeakWorkingSetSize)
    import resource
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024


def probe(args):
    root = args.assets.resolve()
    index = json.loads((root / "small-inputs.json").read_text(encoding="utf-8"))
    if index.get("revision") != pins.MODEL_REVISION or index.get("status") != "pinned-small-inputs-acquired":
        raise ValueError("Pinned local frontend assets absent")
    for row in index["files"].values():
        path = root / row["relative"]
        if not common.verify_file(path, row) or common.digest(path) != row["raw_sha256"]:
            raise ValueError("Native frontend/reference changed")
    pins.git_head(args.g2p_source.resolve(), pins.G2P_REVISION)
    report = {"format": "dordiai-six-layer-pythonort-probe-v1", "status": "running",
              "product_integrated": False, "native_pronunciation_verified": False,
              "typing_or_character_names_verified": False, "selected_voice_projection_verified": False,
              "windows_verified": False, "nvda_verified": False, "physical_audio_verified": False,
              "virtual_audio_verified": False, "graph_artifact": GRAPH_ARTIFACT, "cases": []}
    common.write_json(args.report, report, overwrite=args.overwrite)
    if sys.platform == "win32":
        if args.network_policy is None:
            raise ValueError("Windows proof requires scoped outbound-block firewall attestation")
        policy = json.loads(args.network_policy.read_text(encoding="utf-8"))
        if policy.get("action") != "Block" or policy.get("direction") != "Outbound" or policy.get("enabled") is not True:
            raise ValueError("Missing effective outbound block policy")
        programs = {str(Path(value).resolve()).casefold() for value in policy.get("programs", [])}
        required = {str(Path(value).resolve()).casefold() for value in (sys.executable, getattr(sys, "_base_executable", None) or sys.executable)}
        if not required.issubset(programs) or policy.get("all_firewall_profiles_enabled") is not True:
            raise ValueError("Firewall scope must cover both venv launcher and base inference executable")
        report["network_policy"] = policy
        python_socket_guard()
    else:
        report["network_policy"] = common.deny_native_network()
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1", CUDA_VISIBLE_DEVICES="")
    package_python = None
    if args.packaged_runtime is not None:
        runtime = args.packaged_runtime.resolve()
        package_python = runtime / "python"
        if not os.path.samefile(sys.executable, package_python / "python.exe") or not sys.version.startswith("3.14."):
            raise ValueError("Probe must run with the actual unchanged core private Python3.14")
        bootstrap_spec = importlib.util.spec_from_file_location("dordiai_private_bootstrap", runtime / "windows_runtime.py")
        bootstrap = importlib.util.module_from_spec(bootstrap_spec)
        bootstrap_spec.loader.exec_module(bootstrap)
        report["private_bootstrap"] = bootstrap.reset_inherited_dll_directory()
    elif args.expected_ort != "1.27.0":
        raise ValueError("Existing ORT1.26 compatibility must use the actual private core package")
    sys.path.insert(0, str(args.g2p_source.resolve() / "src"))
    import numpy as np
    from africa_g2p import g2p
    started = perf_counter()
    carrier = SixLayerOrtCarrier(args.graphs, root / "tokenizer.json", expected_ort_version=args.expected_ort,
                                 package_python=package_python)
    report["runtime_imports"] = {name: {"file": str(getattr(sys.modules[name], "__file__", "")),
                                      "version": str(getattr(sys.modules[name], "__version__", "unreported"))}
                                 for name in ("numpy", "onnxruntime", "tokenizers")}
    if package_python is not None and any(not Path(row["file"]).resolve().is_relative_to(package_python.resolve())
                                          for row in report["runtime_imports"].values()):
        raise ValueError("Native dependency escaped the unchanged private package")
    report["packaged_runtime_verified"] = package_python is not None
    report["model_load_seconds"] = perf_counter() - started
    report["graph_provenance"] = carrier.provenance
    rows = common.select_cases((root / "parity_set.tsv").read_text(encoding="utf-8"), 3)
    audio_folder = args.report.resolve().parent / "audio"
    audio_folder.mkdir(parents=True, exist_ok=True)
    for number, row in enumerate(rows):
        ipa = g2p(row["text"], row["language"], output="ipa")
        if ipa != row["expected_training_ipa"]:
            raise ValueError("G2P not identical to primary training fixture")
        ref, rate, reference_format = read_reference_wav(root / index["files"]["voice_" + row["language"]]["relative"])
        started = perf_counter()
        audio = carrier.audio(ipa, ref, int(rate))
        elapsed = perf_counter() - started
        if carrier.last_facts["generation_cap_reached"]:
            raise ValueError("Output reached generation cap; cannot claim completed utterance")
        rms, peak = float(np.sqrt(np.mean(audio ** 2))), float(np.max(np.abs(audio)))
        if rms < 1e-6 or peak < 1e-5:
            raise ValueError("Silent waveform")
        path = audio_folder / (row["language"] + "-" + str(number) + ".wav")
        write_pcm16_wav(path, audio, RATE)
        item = dict(row, status="passed", ipa=ipa, samples=len(audio), sample_rate=RATE,
                    seconds=len(audio) / RATE, inference_seconds=elapsed, real_time_factor=elapsed / (len(audio) / RATE),
                    peak=peak, rms=rms, clip_fraction=float(np.mean(np.abs(audio) >= 1.)),
                    wav_file=str(path), wav_sha256=common.digest(path), float32_sha256=sha256(audio.tobytes()).hexdigest(),
                    host_facts=carrier.last_facts, reference_wav_format=reference_format, process_peak_rss_bytes=peak_rss())
        report["cases"].append(item)
        common.write_json(args.report, report)
        print(json.dumps({k: item[k] for k in ("language", "status", "seconds", "inference_seconds", "real_time_factor")}), flush=True)
    # A request after another language must begin from clean recurrent state.
    first = rows[0]
    ref, rate, _ = read_reference_wav(root / index["files"]["voice_" + first["language"]]["relative"])
    replay = carrier.audio(first["expected_training_ipa"], ref, int(rate))
    if sha256(replay.tobytes()).hexdigest() != report["cases"][0]["float32_sha256"]:
        raise ValueError("Recurrent state or reference selection leaked across language requests")
    report.update(status="actual-six-layer-pythonort-cpu-unintegrated", all_six_cases_passed=True,
                  recurrent_state_reset_replay_passed=True, process_peak_rss_bytes=peak_rss(),
                  windows_verified=sys.platform == "win32", python_version=sys.version,
                  ort_version=carrier.ort.__version__, provider="CPUExecutionProvider", executable=sys.executable,
                  wave_io="stdlib PCM16 WAV reader and writer; actual header retained; no soundfile")
    common.write_json(args.report, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("acquire", "probe"))
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--graphs", type=Path)
    parser.add_argument("--g2p-source", type=Path)
    parser.add_argument("--network-policy", type=Path)
    parser.add_argument("--packaged-runtime", type=Path)
    parser.add_argument("--expected-ort", choices=("1.27.0", "1.26.0"), default="1.27.0")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    if args.report.is_symlink() or args.report.exists() and not args.overwrite:
        parser.error("Refusing existing report")
    if args.phase == "probe" and (args.graphs is None or args.g2p_source is None):
        parser.error("--graphs/--g2p-source required")
    try:
        return (acquire(args) if args.phase == "acquire" else probe(args)) and 0
    except Exception as error:
        previous = json.loads(args.report.read_text(encoding="utf-8")) if args.report.is_file() else {}
        previous.update(status="failed", error_type=type(error).__name__, error=str(error), product_integrated=False)
        common.write_json(args.report, previous)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
