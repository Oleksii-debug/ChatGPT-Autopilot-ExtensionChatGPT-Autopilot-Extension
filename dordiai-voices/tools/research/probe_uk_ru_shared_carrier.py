"""Future14 isolated UK/RU core-versus-existing-Shared carrier pilot.

No registration, model rewrite, new language ID or listening/NVDA acceptance.
The fixed20 words are explicit inputs, never a language-identification test.
"""
from __future__ import annotations
import argparse
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

CORE_BYTES = 1992944744
CORE_SHA = "908a9825a8f3e1574d9d0a370ac0e35e1e1683eb04b998a937c312f0ce3ec573"
WIDE_BYTES = 552777798
WIDE_SHA = "5e500e6f5a217a39023835352c8b59761cf6d1aff5063376ca96b24fbb8df262"
AR_TOOL_BLOB = "13c17787a6e8f1ca42d94638a5923f4bafa805ae"
SHARED_SOURCE_SHA = "643fd8c683786aa4af6619ac59f2227588034b214db05ef94137e5743b598447"
FLOW_SHA = "831fe762c0b47137e20753b9023b3901fc229bbc05bd6644ddce7073d7015404"
DECODER_SHA = "9d57879aff5d3d50ae810b4e4791170b3fd1d27004be71fc2ae3f90afd588d36"
TARGET_SHA = "e880e4ff3c582760073493c9651983a46dfab5a48d1b4ea1e773ef7f31a66f9a"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def ar_recipe():
    path = Path(__file__).with_name("probe_ar_ordinary_names.py")
    raw = path.read_bytes()
    if path.is_symlink() or hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest() != AR_TOOL_BLOB:
        raise ValueError("Exact reviewed original carrier/projection recipe required")
    return load("_uk_ru_original_ar_recipe", path)


def contract():
    return load("_uk_ru_owned_input_contract", Path(__file__).with_name("uk_ru_shared_contract.py"))


def stage(args):
    # Reuse only the reviewed immutable archive extraction/manifest verification;
    # this does not render Arabic or change any character-name bank.
    data = contract().fixture(args.fixture)
    recipe = ar_recipe()
    from types import SimpleNamespace
    recipe.stage(SimpleNamespace(core=args.core, wide=args.wide, output=args.output,
        candidate=Path(__file__).with_name("ar_ordinary_name_candidate.json")))
    metadata = json.loads((args.output / "ar29-stage.json").read_text(encoding="utf-8"))
    if metadata["core_sha256"] != CORE_SHA or metadata["wide_outer_sha256"] != WIDE_SHA:
        raise ValueError("Existing stage core/wide identity differs")
    capability = args.output / "kx47Runtime/models/WideLanguages/SharedAcoustic/capabilities.json"
    declared = contract().support(capability.read_bytes(), contract().TRAINED_LANGUAGES)
    recipe.write_json(args.output / "uk-ru-pilot-stage.json", {
        "format": "dordiai-uk-ru-existing-shared-pilot-stage", "format_version": 1,
        "core_sha256": CORE_SHA, "wide_sha256": WIDE_SHA,
        "fixture_sha256": contract().FIXTURE_SHA256, "support": declared,
        "profile": data["profile"], "primary_model": "Supertone/supertonic-3",
        "primary_model_url": "https://huggingface.co/Supertone/supertonic-3",
        "original_packed_readme_sha256": metadata["shared_files"][
            "kx47Runtime/models/WideLanguages/SharedAcoustic/README.md"]["sha256"],
        "scope": "Exact core12 plus original Shared subset, not production/default selection or a new trained language"})


def delivery_function(runtime):
    # Extract this ONE unchanged function from the hash-verified immutable core,
    # avoiding import of worker startup/pipe bootstrap into the research process.
    path = runtime / "nvda_worker.py"
    raw = path.read_bytes()
    nodes = [node for node in ast.parse(raw).body if isinstance(node, ast.FunctionDef) and node.name == "delivered_audio"]
    if len(nodes) != 1:
        raise ValueError("Actual core delivery function missing")
    namespace = {}
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(path), "exec"), namespace)
    return namespace["delivered_audio"], hashlib.sha256(raw).hexdigest()


def observe_stream(source, started, np, rate=24000):
    chunks = []
    first = None
    events = []
    total = 0
    try:
        for chunk in source:
            observed = time.perf_counter()
            array = np.asarray(chunk, dtype=np.float32)
            if array.ndim != 1 or not len(array) or not np.isfinite(array).all():
                raise ValueError("Actual core stream returned an invalid block")
            if first is None:
                first = observed - started
            total += len(array)
            if total > rate * 30 or len(events) >= 4096:
                raise ValueError("Single-word PCM or chunk bound exceeded")
            chunks.append(array.copy())
            events.append({"observed_seconds": observed - started, "samples": len(array)})
    finally:
        close = getattr(source, "close", None)
        if close is not None:
            close()
    finished = time.perf_counter() - started
    if not chunks:
        raise ValueError("No actual finite word PCM was generated")
    return np.concatenate(chunks), {"generation_wall_seconds": finished,
        "first_software_block_seconds": first, "block_events": events,
        "timing_scope": "Local generation to array; excludes WAV saving, audio device, NVDA and physical latency"}


def probe(args):
    if args.output.exists():
        raise FileExistsError("Fresh owned pilot output required")
    args.output.mkdir(parents=True)
    recipe = ar_recipe()
    data = contract().fixture(args.fixture)
    runtime = args.runtime.resolve(strict=True)
    private = (runtime / "python").resolve(strict=True)
    if not Path(sys.executable).resolve().is_relative_to(private) or sys.version_info[:2] != (3, 14) or sys.flags.utf8_mode != 1:
        raise RuntimeError("Exact unchanged private Python3.14 with UTF8 mode required")
    sys.dont_write_bytecode = True
    shared = load("_uk_ru_original_pcm_helper", Path(__file__).with_name("ordinary_name_pcm_probe.py"))
    sys.addaudithook(shared.deny_network_event)
    load("_uk_ru_original_windows_bootstrap", runtime / "windows_runtime.py").reset_inherited_dll_directory()
    sys.path.insert(0, str(runtime))
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
    if ort.__version__ != "1.26.0":
        raise RuntimeError("Unchanged private ORT1.26.0 required")
    for name in ("numpy", "onnxruntime"):
        if not Path(sys.modules[name].__file__).resolve().is_relative_to(private):
            raise RuntimeError("Native dependency escaped original private interpreter")
    before = recipe.snapshot(runtime)
    staged = json.loads((runtime.parent / "ar29-stage.json").read_text(encoding="utf-8"))
    if before != staged["existing_payload_hashes"]:
        raise ValueError("Original staged core/shared bytes changed before inference")
    models = runtime / "models"
    references = models / "voices"
    folder = models / "WideLanguages/SharedAcoustic"
    from wide_common_helpers import AVAILABLE_LANGS, UnicodeProcessor
    from wide_numbers import spell_numbers
    if any(spell_numbers(row["language"], row["text"]) != row["text"] for row in data["cases"]):
        raise ValueError("Original common-number frontend would change a literal input word")
    supported = contract().support((folder / "capabilities.json").read_bytes(), AVAILABLE_LANGS)
    processor = UnicodeProcessor(str(folder / "onnx/unicode_indexer.json"), append_terminal_period=False)
    prepared = contract().literal_inputs(processor, data["cases"])
    target_path = references / "classmate_locales/viktoriia.npy"
    paths = {"shared_source": folder / "source.npy", "flow": models / "OpenVoiceV2/encoder-flow.onnx",
        "decoder": models / "OpenVoiceV2/decoder.onnx", "target": target_path}
    for key, expected in (("shared_source", SHARED_SOURCE_SHA), ("flow", FLOW_SHA), ("decoder", DECODER_SHA), ("target", TARGET_SHA)):
        if digest(paths[key]) != expected:
            raise ValueError("Original projection/source/target bytes differ: " + key)
    from voice_policy import require_voice_allowed
    require_voice_allowed(data["profile"])
    delivered_audio, worker_sha = delivery_function(runtime)
    report = {"format": "dordiai-uk-ru-unprepared-carrier-pilot", "format_version": 1,
        "status": "running", "backend": args.backend, "python": sys.version, "onnxruntime": ort.__version__,
        "core_sha256": CORE_SHA, "wide_sha256": WIDE_SHA, "fixture_sha256": contract().FIXTURE_SHA256,
        "profile": data["profile"], "requested_speed": data["requested_speed"], "shared_source_tempo": data["source_tempo"],
        "support": supported, "prepared_shared_inputs": prepared,
        "projection_pins": {key: digest(path) for key, path in paths.items()}, "worker_source_sha256": worker_sha,
        "shared_resource_hashes": staged["shared_files"],
        "original_viktoriia_conditioning_resources": {name: value for name, value in before.items()
            if "viktoriia" in name.lower() or name == "models/voices/native_profiles/delivery.json"},
        "scope": "Explicit20literalwords, original core UK/RU request-path functions versus original trained Shared carrier plus existing Viktoriia projection. Core family conditioning differs and is reported. No NVDA/default/quality promotion.",
        "prior_plain100_adam_measurement_used_as_viktoriia_baseline": False,
        "prepared_navigation_clip_lookup_performed": False,
        "baseline_scope": "New carrier generation functions used by the original core, bypassing prepared navigation clips for this unprepared-word comparison",
        "whole_workload_warmup_performed": False, "model_weights_modified": False,
        "new_language_ids_added": False, "production_registered": False, "production_changed": False,
        "native_pronunciation_verified": False, "listener_quality_verified": False,
        "typing_verified": False, "windows_nvda_verified": False, "physical_audio_verified": False,
        "acoustic_latency_verified": False, "product_ready": False, "cases": []}
    recipe.write_json(args.output / "report.json", report)
    native = None
    held_children = []
    try:
        opened = time.perf_counter()
        if args.backend == "core":
            from ukrainian_voices import UkrainianVoices
            from native_multilingual import NativeMultilingual, preferred_speech
            engine = UkrainianVoices(models, references, threads=4)
            engine.holos  # Load original graphs, without rendering any fixture word.
            native_directory = references / "native_profiles"
            native_available = (native_directory / "delivery.json").is_file()
            native = NativeMultilingual(models / "PocketTTS", native_directory, threads=3) if native_available else None
            # The actual default driver requests nativeProfile for Russian;
            # availability/plan and the original fallback decide the real path.
            initial_plan = native.plan(data["profile"], "ru", data["cases"][1]["text"], "auto") if native is not None else ()
            if initial_plan:
                native.accent
                native._russian_for(data["profile"]).start()
            report["conditioning"] = {"uk": "Original Holos selected-profile style via UkrainianVoices.chunks",
                "ru": "Original NativeMultilingual plan/preferred_speech with core fallback",
                "request_flags_source_inferred_not_observed_nvda": {"uk_nativeProfile": False, "ru_nativeProfile": native_available},
                "initial_ru_native_plan_available": bool(initial_plan), "holos_threads": 4, "native_multilingual_threads": 3,
                "original_native_profile_delivery_settings": native.settings.get(data["profile"]) if native is not None else None,
                "original_holos_delivery_settings": engine.delivery_profiles.get(data["profile"])}
        else:
            from wide_common import CommonSpeech
            from converted_voices import resample, spectrogram
            from speech_tempo import stream_tempo
            from voice_delivery import compact_padding
            from native_locale import NativeLocaleVoices
            from converted_voices import ConvertedVoices
            owner = ConvertedVoices(models, references, threads=4)
            common = CommonSpeech(models / "WideLanguages", owner)
            common.voice.preload()
            actual_engine, _ = common.voice.engine
            if contract().literal_inputs(actual_engine.text_processor, data["cases"]) != prepared:
                raise ValueError("Actual common carrier processor differs from prechecked native inputs")
            flow, decoder = owner._session(paths["flow"]), owner._session(paths["decoder"])
            source, target = (np.load(paths[key], allow_pickle=False) for key in ("shared_source", "target"))
            for vector in (source, target):
                if vector.dtype != np.float32 or vector.shape != (1, 256, 1) or not np.isfinite(vector).all() or np.linalg.norm(vector) <= 1e-7:
                    raise ValueError("Invalid unchanged source/target identity vector")
            if common.audio.cache_info().currsize or common.audio.cache_info().hits:
                raise ValueError("Shared per-word audio cache was already primed")
            report["conditioning"] = {"carrier": "Original F1 internal style, exact uk/ru tags and calibrated shared source",
                "profile": "Original OpenVoice encoder-flow/decoder and unchanged Viktoriia target",
                "native_model_rate": actual_engine.sample_rate, "carrier_resamples_to": 24000,
                "common_audio_rate": 22050, "projection_rate": 22050, "delivery_rate": 24000,
                "source_tempo": data["source_tempo"], "post_projection_tempo": data["requested_speed"] / data["source_tempo"],
                "steps": 8, "session_threads": 4,
                "scope": "Controlled original carrier/projection recipe at source tempo1; final existing tempo applies exact requested driver-rate80 factor after projection"}
        report["model_open_seconds"] = time.perf_counter() - opened
        recipe.write_json(args.output / "report.json", report)
        for case in data["cases"]:
            code, text = case["language"], case["text"]
            started = time.perf_counter()
            facts = {"id": case["id"], "language": code, "source_text": text,
                "profile": data["profile"], "requested_speed": data["requested_speed"]}
            if args.backend == "core":
                fallback = engine.chunks(data["profile"], code, text, data["requested_speed"])
                renderer = {"engine": "baseline", "profile": data["profile"]}
                parts = native.plan(data["profile"], code, text, "auto") if code == "ru" and native is not None else ()
                stream = (preferred_speech(native.phrase(data["profile"], parts, data["requested_speed"],
                    lambda: False, engine.chunks), fallback, renderer) if parts else fallback)
                facts["actual_native_plan"] = list(parts)
            else:
                tick = time.perf_counter()
                raw = common.audio(code, text, data["source_tempo"])
                facts["native_generation_seconds"] = time.perf_counter() - tick
                facts["native_audio_seconds"] = len(raw) / 22050
                tick = time.perf_counter()
                spec = spectrogram(raw).T.copy()[None]
                latent = flow.run(None, {"spec": spec, "spec_lengths": np.asarray([spec.shape[-1]], np.int64),
                    "src_g": source, "tgt_g": target})[0]
                projected = decoder.run(None, {"/Mul_output_0": latent,
                    "/ConstantOfShape_1_output_0": np.zeros_like(target)})[0].reshape(-1)
                facts["projection_seconds"] = time.perf_counter() - tick
                wave = resample(projected, 22050, 24000)
                stream = compact_padding(stream_tempo(NativeLocaleVoices.levelled((wave,)), 24000,
                    data["requested_speed"] / data["source_tempo"]), text)
                renderer = {"engine": "existing-trained-shared-plus-original-projection", "profile": data["profile"]}
            request = {"profile": data["profile"], "language": code, "character": False}
            output = delivered_audio(stream, 24000, references, request, {}, condition=True)
            wave, timing = observe_stream(output, started, np)
            facts.update(timing, renderer=dict(renderer))
            facts["delivered_pcm"] = shared.save_wave(args.output / ("%02d-delivered.wav" % case["id"]), wave, 24000, np)
            if args.backend == "shared":
                facts["native_pcm"] = shared.save_wave(args.output / ("%02d-native.wav" % case["id"]), raw, 22050, np)
                facts["projection_pcm"] = shared.save_wave(args.output / ("%02d-projected.wav" % case["id"]), projected, 22050, np)
            report["cases"].append(facts)
            recipe.write_json(args.output / "report.json", report)
            print("UK_RU_CARRIER_WORD " + json.dumps({key: value for key, value in facts.items() if key != "block_events"}, ensure_ascii=False), flush=True)
        if args.backend == "shared":
            report["shared_audio_cache"] = common.audio.cache_info()._asdict()
            if report["shared_audio_cache"]["hits"] != 0 or report["shared_audio_cache"]["misses"] != 20:
                raise ValueError("Each shared word must be newly synthesized, not waveform-cache replay")
        if recipe.snapshot(runtime) != before:
            raise ValueError("Pilot changed original private/model/source payloads")
        report.update(status="passed-isolated20word-generation-pilot", actual_cases=20,
            original_payloads_unchanged=len(before), observed_source_texts_unchanged=True)
    except BaseException as error:
        report.update(status="failed-isolated-carrier-pilot", error_type=type(error).__name__, error=str(error))
        raise
    finally:
        cleanup_errors = []
        if native is not None:
            pipes = list(native._package_russian.values())
            if "russian" in native.__dict__:
                pipes.append(native.russian)
            held_children = [pipe.process for pipe in pipes if pipe.process is not None]
            try:
                native.close()
            except Exception as error:
                cleanup_errors.append(type(error).__name__ + ": " + str(error))
            for process in held_children:
                try:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=2)
                        except __import__("subprocess").TimeoutExpired:
                            process.kill()
                            process.wait(timeout=2)
                except Exception as error:
                    cleanup_errors.append(type(error).__name__ + ": " + str(error))
        report["owned_russian_children_reaped"] = all(process.poll() is not None for process in held_children)
        report["owned_russian_child_count"] = len(held_children)
        report["cleanup_errors"] = cleanup_errors
        if cleanup_errors or not report["owned_russian_children_reaped"]:
            report["status"] = "failed-owned-child-cleanup"
        recipe.write_json(args.output / "report.json", report)
        if cleanup_errors or not report["owned_russian_children_reaped"]:
            raise RuntimeError("Owned native Russian process cleanup did not complete cleanly")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    p = modes.add_parser("stage")
    for name in ("core", "wide", "fixture", "output"):
        p.add_argument("--" + name, required=True, type=Path)
    p = modes.add_parser("probe")
    for name in ("runtime", "fixture", "output"):
        p.add_argument("--" + name, required=True, type=Path)
    p.add_argument("--backend", required=True, choices=("core", "shared"))
    args = parser.parse_args(argv)
    globals()[args.mode](args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
