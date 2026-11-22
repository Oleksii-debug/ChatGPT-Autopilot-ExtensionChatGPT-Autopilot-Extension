"""Prepare actual shared native resources and selected-profile projection evidence.

Acquisition is separate from offline private-runtime execution. Source embeddings
are measured from actual new six-layer native PCM with the pinned full-precision
OpenVoice reference encoder. No old24-layer identity is copied. Model packs are
data-only; reviewed frontend code is emitted separately for the future core.
"""
from __future__ import annotations
import argparse
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
from time import perf_counter
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("afri_resource_pins", HERE / "afri_six_ort_probe.py")
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)
pins, common = proof.pins, proof.common
CODES = {"ss": "ssw", "ve": "ven", "zu": "zul", "wo": "wol", "nso": "nso"}
HOURS = {"ssw": 12.08, "ven": 10.62, "zul": 21.14, "wol": .56, "nso": 13.24}
LABELS = {"ss": "Свазі (сісваті)", "ve": "Венда", "zu": "Зулу", "wo": "Волоф", "nso": "Північна сото (сепеді)"}
KNOWN_REFS = {"zul": "7b546bfa415993122e51694d7ba2254ef564f6220a73643314f49ba7496bfede",
              "nso": "1b3886c9bef550cd26e656190ab03dc8a4c7e65889eee64fd121cfbbfb645ab4",
              "wol": "b20601d70d20ca54a2d85cecfc388f4c9c6a57f6683426f9ece7ac459a592f27"}
ENCODER = {"bytes": 3259275, "sha256": "3dd4918cab90e1acf7fa5c6f7539c27710e7a3cdfba550468c5ea49399178bf7"}
ENCODER_URL = "https://huggingface.co/TigreGotico/voiceclonnx-openvoice-v2/resolve/34d010c192c97f763207f488f6057fd07fee42ad/tone_ref_encoder.onnx"
MINIMUM_CORE_VERSION = "0.13.1-dev.11"
VENDOR_PINS = json.loads(r'''{
  "DATA_LICENSE.md": {
    "bytes": 1831,
    "git_blob_sha1": "8bb79af373ed6eca88e51d82c5298d42648d3d07"
  },
  "pyproject.toml": {
    "bytes": 2181,
    "git_blob_sha1": "d42f9cf5e2744c882df7e6c3f540ae96dc47f2f6"
  },
  "src/africa_g2p/__init__.py": {
    "bytes": 1390,
    "git_blob_sha1": "a05b1f717c68e93f3fd526e405740442f49285e9"
  },
  "src/africa_g2p/convert.py": {
    "bytes": 43529,
    "git_blob_sha1": "cf6e3c5c8911c8d5ef88e5c85ca797883fb3e274"
  },
  "src/africa_g2p/data/ipa_universal_graphemes.json": {
    "bytes": 429875,
    "git_blob_sha1": "830093ea3ca53aea7b97dd1ea3fc749e766faf6d"
  },
  "src/africa_g2p/data/plain_latin_languages.json": {
    "bytes": 1074,
    "git_blob_sha1": "b63654c9542dc6bbd5c48b1c7858e83ad2ff5a04"
  },
  "src/africa_g2p/data/proxy_escapes.json": {
    "bytes": 20089,
    "git_blob_sha1": "613e5f19321612c8a20466fde4822267d163773b"
  },
  "src/africa_g2p/data/proxy_fidelity.json": {
    "bytes": 91354,
    "git_blob_sha1": "d5a522351f381cbcfe79ff1e9b200405f17470fd"
  },
  "src/africa_g2p/data/registry.json": {
    "bytes": 143399,
    "git_blob_sha1": "023158a6aa24426f88d7342209f8643546a2d652"
  },
  "src/africa_g2p/data/universal_fallback.json": {
    "bytes": 48144,
    "git_blob_sha1": "c96a53c982675975d110d9768dd95cbe9e096e53"
  },
  "src/africa_g2p/english.py": {
    "bytes": 5174,
    "git_blob_sha1": "ce4ff3dedda61409855527ed9abceb568c97edaa"
  },
  "src/africa_g2p/fallback.py": {
    "bytes": 4279,
    "git_blob_sha1": "a6282d877053f48abc8ae64e59c50607ca83e25d"
  },
  "src/africa_g2p/g2p.py": {
    "bytes": 14511,
    "git_blob_sha1": "19ba1192446eba7b927163c8c2557bc2461771d1"
  },
  "src/africa_g2p/languages/nso.json": {
    "bytes": 2090,
    "git_blob_sha1": "9cd3bbc84d498b642e3f43c32b9e6423cc34546c"
  },
  "src/africa_g2p/languages/ssw.json": {
    "bytes": 2579,
    "git_blob_sha1": "a345d589d643f6c09508f9fa199e6717f46b4b17"
  },
  "src/africa_g2p/languages/ven.json": {
    "bytes": 2625,
    "git_blob_sha1": "c7310a735f700bf80c97e9f5d3a2d5b5e5ba0b5f"
  },
  "src/africa_g2p/languages/wol.json": {
    "bytes": 2877,
    "git_blob_sha1": "6743b3e5c6a57ddbd97001f45299599792c632ba"
  },
  "src/africa_g2p/languages/zul.json": {
    "bytes": 2456,
    "git_blob_sha1": "4bdc6a9a9fae91915f8a1b2dc2eb398c7afe5dff"
  },
  "src/africa_g2p/loader.py": {
    "bytes": 1655,
    "git_blob_sha1": "614bd4ae262d5be5a2e3ba4c9cc622f7d7cbe10e"
  },
  "src/africa_g2p/normalizer.py": {
    "bytes": 6888,
    "git_blob_sha1": "d418da3e414f65c73c8a06c6afd4a05597130411"
  },
  "src/africa_g2p/pipeline.py": {
    "bytes": 2166,
    "git_blob_sha1": "e9824c32dcece2c2e2842c906193d14ff5d6ec43"
  }
}''')


def load_candidate(directory):
    path = Path(directory)
    sys.path.insert(0, str(path.resolve()))
    import wide_afri_six
    import wide_afri_frontend
    if wide_afri_six.SUPPORTED != CODES or wide_afri_frontend.SUPPORTED != CODES:
        raise ValueError("Future reviewed runtime/frontend scope does not match actual five native languages")
    return wide_afri_six, wide_afri_frontend


def exact_copy(source, target):
    source, target = Path(source), Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and common.digest(target) != common.digest(source):
        raise FileExistsError("Refusing changed existing staging target")
    if not target.exists():
        shutil.copyfile(source, target)
    if common.digest(source) != common.digest(target):
        raise ValueError("Staged bytes differ")


def acquire(args):
    stage = args.stage.resolve()
    stage.mkdir(parents=True, exist_ok=True)
    runtime = stage / "runtime"
    for name in ("wide_afri_six.py", "wide_afri_frontend.py"):
        exact_copy(args.candidate_runtime / name, runtime / name)
    vendor = runtime / "vendor_afri_g2p"
    manifest = {"revision": pins.G2P_REVISION, "languages": CODES, "files": {},
                "scope": "Exact primary source subset; only five native charts are shipped",
                "code_license": "Apache-2.0 declared upstream; DATA_LICENSE.md retains separate source notices"}
    for relative, expected in VENDOR_PINS.items():
        name = relative.removeprefix("src/") if relative.startswith("src/") else (
            "UPSTREAM-PYPROJECT.toml" if relative == "pyproject.toml" else relative)
        target = vendor / name
        common.download("https://raw.githubusercontent.com/AfriSpeech/africa-g2p/" + pins.G2P_REVISION + "/" + relative,
                        target, expected)
        manifest["files"][name] = expected
    common.write_json(vendor / "dordiai-vendor.json", manifest)
    metadata = common.read_json_url("https://huggingface.co/api/models/AfriSpeech/africa-tts/revision/" + pins.MODEL_REVISION + "?blobs=true")
    if metadata.get("sha") != pins.MODEL_REVISION:
        raise ValueError("Model revision did not resolve exactly")
    rows = {row["rfilename"]: row for row in metadata["siblings"]}
    assets = stage / "native-inputs"
    index = {"revision": pins.MODEL_REVISION, "files": {}, "languages": CODES,
             "product_integrated": False, "model_download_from_hub": False}
    for code, iso in CODES.items():
        relative = "voices/" + iso + ".wav"
        if relative not in rows:
            relative = "sherpa-onnx/voices/" + iso + ".wav"
        if relative not in rows:
            raise ValueError("Publisher has no same-language reference")
        expected = common.artifact_record(rows[relative])
        if iso in KNOWN_REFS and expected.get("sha256") != KNOWN_REFS[iso]:
            raise ValueError("Native reference differs from completed primary proof")
        target = assets / (code + ".wav")
        common.download("https://huggingface.co/AfriSpeech/africa-tts/resolve/" + pins.MODEL_REVISION + "/" + relative,
                        target, expected)
        index["files"][code] = dict(expected, path=str(target), sha256=common.digest(target), repository_path=relative)
    expected = pins.PINS["tokenizer.json"]
    common.download("https://huggingface.co/AfriSpeech/africa-tts/resolve/" + pins.MODEL_REVISION + "/tokenizer.json",
                    assets / "tokenizer.json", expected)
    for role, (relative, amount, blob) in common.SOURCE_FILES.items():
        common.download("https://raw.githubusercontent.com/AfriSpeech/africa-tts/" + pins.SOURCE_REVISION + "/" + relative,
                        assets / role, {"bytes": amount, "git_blob_sha1": blob})
    trained = json.loads((assets / "languages.json").read_text(encoding="utf-8"))
    for iso, hours in HOURS.items():
        if trained.get(iso, {}).get("hours") != hours:
            raise ValueError("Selected native language is not trained with expected publisher metadata")
    index["tokenizer_sha256"] = common.digest(assets / "tokenizer.json")
    common.write_json(stage / "inputs.json", index)
    encoder = stage / "calibration-only/tone_ref_encoder.onnx"
    common.download(ENCODER_URL, encoder, ENCODER)
    # Source graph artifact was pinned by the enclosing acquisition workflow.
    graph_paths, provenance = proof.validate_graphs(args.graphs)
    afri, _ = load_candidate(runtime)
    folder = stage / "models/SharedAfriSixONNX"
    folder.mkdir(parents=True, exist_ok=True)
    graphs = {}
    for role in afri.ROLES:
        source = graph_paths[role]
        exact_copy(source, folder / source.name)
        graphs[role] = {"filename": source.name, "bytes": source.stat().st_size, "sha256": common.digest(source)}
    exact_copy(assets / "tokenizer.json", folder / "tokenizer.json")
    configuration = {"format": afri.FORMAT, "model_repository": "AfriSpeech/africa-tts",
                     "model_revision": pins.MODEL_REVISION, "source_checkpoint_sha256": pins.CHECKPOINT_SHA256,
                     "exporter_git_blob": pins.EXPORTER_BLOB, "flow_lm_layers": 6, "precision": "float32",
                     "sample_rate": afri.RATE, "g2p_revision": pins.G2P_REVISION,
                     "tokenizer_sha256": index["tokenizer_sha256"], "graphs": graphs,
                     "native_pronunciation_verified": False, "typing_or_character_names_verified": False,
                     "nvda_verified": False, "minimum_core_version": MINIMUM_CORE_VERSION}
    common.write_json(folder / "config.json", configuration)
    common.write_json(folder / "EXPORT_PROVENANCE.json", provenance)
    (folder / "NOTICE.txt").write_text(
        "AfriSpeech/africa-tts at " + pins.MODEL_REVISION + "\n"
        "Model and native default voices: CC-BY-NC-4.0 according to publisher.\n"
        "Exact six-layer full-FP32 checkpoint; official export, no our quantization/pruning/training.\n"
        "Original checkpoint SHA256 " + pins.CHECKPOINT_SHA256 + "\n"
        "Reviewed G2P code/data notices are in the separately reviewed future core.\n"
        "Native listening, typing, characters, and NVDA acceptance remain unverified.\n", encoding="utf-8")
    report = {"status": "prepared-inputs-only", "stage": str(stage), "vendor_files": len(VENDOR_PINS),
              "vendor_bytes": sum(x["bytes"] for x in VENDOR_PINS.values()), "input_index": index,
              "shared_model": configuration, "carrier_identity_sha256": afri.carrier_identity(configuration),
              "source_embedding_prepared": False, "product_integrated": False}
    common.write_json(args.report, report, overwrite=args.overwrite)
    return report


def cases(path):
    rows = []
    for code, iso in CODES.items():
        selected = []
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            cells = line.split("\t", 2)
            if len(cells) == 3 and cells[0] == iso:
                selected.append({"code": code, "iso": iso, "text": cells[1], "ipa": cells[2]})
        if len(selected) < 3:
            raise ValueError("Missing primary native fixtures")
        rows += selected[:3]
    return rows


def prepare(args):
    if sys.platform != "win32" or not sys.version.startswith("3.14."):
        raise ValueError("Actual unchanged core private Windows Python3.14 is required")
    core = args.core_runtime.resolve()
    if not os.path.samefile(sys.executable, core / "python/python.exe"):
        raise ValueError("Preparation did not use the exact original private interpreter")
    sys.path.insert(0, str(core))
    from windows_runtime import reset_inherited_dll_directory
    reset_inherited_dll_directory()
    stage = args.stage.resolve()
    afri, frontend = load_candidate(stage / "runtime")
    report = {"status": "preparing-native-source-identities", "product_integrated": False,
              "native_pronunciation_verified": False, "nvda_verified": False, "physical_audio_verified": False,
              "typing_or_character_names_verified": False, "selected_profile_projection_technical_verified": False,
              "source_calibrations": {}, "projections": [], "original_core_version": "0.13.1-dev.9"}
    common.write_json(args.report, report, overwrite=args.overwrite)
    policy = json.loads(args.network_policy.read_text(encoding="utf-8"))
    programs = {str(Path(x).resolve()).casefold() for x in policy.get("programs", [])}
    if (policy.get("action") != "Block" or policy.get("direction") != "Outbound"
            or policy.get("enabled") is not True or policy.get("all_firewall_profiles_enabled") is not True
            or str(Path(sys.executable).resolve()).casefold() not in programs):
        raise ValueError("Missing scoped native offline firewall evidence")
    report["network_policy"] = policy
    proof.python_socket_guard()
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1", CUDA_VISIBLE_DEVICES="")
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
    if ort.__version__ != "1.26.0" or not Path(ort.__file__).resolve().is_relative_to(core / "python"):
        raise ValueError("Only actual unchanged private ONNX Runtime1.26.0 is accepted")
    from converted_voices import spectrogram, resample
    from native_locale import NativeLocaleVoices
    from wide_voice import WideVoices
    from voice_catalog import PROFILES
    from voice_policy import EXCLUDED_VOICE_IDS, require_voice_allowed
    models = core / "models"
    references = models / "voices"
    converter = NativeLocaleVoices(models, references / "classmate_locales", threads=2)
    wide = WideVoices(models, references, converter=converter)
    if set(PROFILES).intersection(EXCLUDED_VOICE_IDS) or len(PROFILES) != 45:
        raise ValueError("The exact original45 allowed target profiles were not recovered")
    # Encoder is a separately acquired preparation-only graph; original core data is untouched.
    encoder_path = stage / "calibration-only/tone_ref_encoder.onnx"
    if common.digest(encoder_path) != ENCODER["sha256"]:
        raise ValueError("Preparation encoder differs from pinned FP32 model")
    options = ort.SessionOptions()
    options.intra_op_num_threads, options.inter_op_num_threads = 2, 1
    encoder = ort.InferenceSession(str(encoder_path), options, providers=["CPUExecutionProvider"])
    native = proof.SixLayerOrtCarrier(args.graphs, stage / "native-inputs/tokenizer.json",
                                     expected_ort_version="1.26.0", package_python=core / "python")
    index = json.loads((stage / "inputs.json").read_text(encoding="utf-8"))
    folder = stage / "models/SharedAfriSixONNX"
    shared = json.loads((folder / "config.json").read_text(encoding="utf-8"))
    selected = cases(stage / "native-inputs/parity_set.tsv")
    first_clips = {}
    calibration_dir = args.report.resolve().parent / "calibration"
    calibration_dir.mkdir(parents=True, exist_ok=True)
    for code, iso in CODES.items():
        reference, rate, reference_format = proof.read_reference_wav(index["files"][code]["path"])
        vectors, prepared_clips = [], []
        for number, row in enumerate(x for x in selected if x["code"] == code):
            ipa = frontend.phonemes(code, row["text"])
            if ipa != row["ipa"]:
                raise ValueError("Vendored native frontend differs from exact primary training fixtures")
            started = perf_counter()
            audio = native.audio(ipa, reference, rate)
            elapsed = perf_counter() - started
            if native.last_facts["generation_cap_reached"]:
                raise ValueError("Native calibration utterance did not finish")
            path = calibration_dir / (code + "-" + str(number) + ".wav")
            proof.write_pcm16_wav(path, audio, afri.RATE)
            # Re-read the exact retained PCM16 file used for measured provenance.
            retained, retained_rate, _ = proof.read_reference_wav(path)
            source_audio = resample(retained, retained_rate, 22050)
            embedding = encoder.run(None, {"spec": spectrogram(source_audio)[None]})[0].reshape(1, 256, 1).astype(np.float32)
            if not np.isfinite(embedding).all() or not np.any(embedding):
                raise ValueError("Invalid actual measured native source identity")
            vectors.append(embedding)
            prepared_clips.append({"text": row["text"], "ipa": ipa, "wav_sha256": common.digest(path),
                                   "samples": len(retained), "sample_rate": retained_rate,
                                   "native_inference_seconds": elapsed,
                                   "source_embedding_norm": float(np.linalg.norm(embedding))})
            if number == 0:
                first_clips[code] = (row, audio.copy())
        source = np.mean(np.stack(vectors), axis=0).astype(np.float32)
        if source.shape != (1, 256, 1) or not np.isfinite(source).all() or not np.any(source):
            raise ValueError("Invalid unnormalized measured source conditioning mean")
        destination = folder / "references" / code
        destination.mkdir(parents=True, exist_ok=True)
        exact_copy(index["files"][code]["path"], destination / "reference.wav")
        np.save(destination / "source.npy", source, allow_pickle=False)
        files = {name: {"bytes": (destination / name).stat().st_size, "sha256": common.digest(destination / name)}
                 for name in ("reference.wav", "source.npy")}
        record = {"format": afri.REFERENCE_FORMAT, "code": code, "iso_code": iso,
                  "model_revision": pins.MODEL_REVISION, "g2p_revision": pins.G2P_REVISION,
                  "files": files, "publisher_trained_hours": HOURS[iso],
                  "weak_training_data_caution": HOURS[iso] < 2, "reference_wav_format": reference_format,
                  "source_identity": {"calibration_kind": "actual-same-six-layer-carrier-pcm",
                                      "source_checkpoint_sha256": pins.CHECKPOINT_SHA256,
                                      "carrier_identity_sha256": afri.carrier_identity(shared),
                                      "native_reference_sha256": files["reference.wav"]["sha256"],
                                      "reference_encoder_sha256": ENCODER["sha256"],
                                      "source_sha256": files["source.npy"]["sha256"],
                                      "aggregation": "arithmetic mean of3 actual raw FP32 encoder vectors; no unit normalization",
                                      "calibration_clips": prepared_clips, "native_pronunciation_verified": False},
                  "native_pronunciation_verified": False, "typing_or_character_names_verified": False,
                  "nvda_verified": False, "numbers_verified": False}
        common.write_json(destination / "config.json", record)
        (destination / "NOTICE.txt").write_text(
            "Native " + iso + " reference: AfriSpeech/africa-tts " + pins.MODEL_REVISION + "; CC-BY-NC-4.0.\n"
            "source.npy was measured from3 genuine new six-layer native PCM clips by the pinned FP32 OpenVoice encoder.\n"
            "No previous24-layer or another language identity was copied. Native quality/letters/numbers/NVDA unverified.\n",
            encoding="utf-8")
        report["source_calibrations"][code] = record
        common.write_json(args.report, report)
    if afri.available(stage / "models") != set(CODES):
        raise ValueError("Actual prepared native resource availability differs from expected five languages")
    # Release the earlier diagnostic sessions before opening the production candidate.
    native.sessions.clear()
    native.voice_cache.clear()
    del native, encoder
    import gc
    gc.collect()
    # Actual future production adapter, not only the earlier research carrier.
    adapter = afri.AfriSixEngine(folder, owner=converter, session_factory=converter._session)
    report["runtime_adapter_checks"] = []
    output = args.report.resolve().parent / "selected-profiles"
    output.mkdir(parents=True, exist_ok=True)
    target_hashes, pcm_hashes = set(), set()
    for code in CODES:
        row, baseline_audio = first_clips[code]
        started = perf_counter()
        actual = adapter.audio(code, row["text"])
        elapsed = perf_counter() - started
        if not np.allclose(actual, baseline_audio, rtol=1e-5, atol=1e-5):
            raise ValueError("Actual future production carrier changed the validated native PCM")
        report["runtime_adapter_checks"].append({"code": code, "allclose_to_same_core_research_carrier": True,
                                                 "max_abs_diff": float(np.max(np.abs(actual - baseline_audio))),
                                                 "inference_seconds": elapsed, "facts": adapter.last_facts})
        source = afri.source(code, models=stage / "models")
        source_audio = resample(actual, afri.RATE, 22050)
        for profile in sorted(PROFILES):
            require_voice_allowed(profile)
            target = converter.target_profile(profile)
            target_hash = sha256(target.tobytes()).hexdigest()
            target_hashes.add(target_hash)
            started = perf_counter()
            clips = list(wide.converted(source_audio, source, target))
            pcm = np.concatenate(clips).astype(np.float32) if clips else np.zeros(0, np.float32)
            if len(pcm) < 100 or not np.isfinite(pcm).all() or np.max(np.abs(pcm)) < 1e-7:
                raise ValueError("Invalid actual selected-profile projection: " + profile)
            rendered = resample(pcm, 22050, 24000)
            path = output / (code + "-" + profile + ".wav")
            proof.write_pcm16_wav(path, rendered, 24000)
            waveform_hash = sha256(rendered.tobytes()).hexdigest()
            pcm_hashes.add(waveform_hash)
            report["projections"].append({"code": code, "profile": profile, "target_embedding_sha256": target_hash,
                                          "source_npy_sha256": report["source_calibrations"][code]["files"]["source.npy"]["sha256"],
                                          "finite_nonzero": True, "samples": len(rendered), "sample_rate": 24000,
                                          "wav_sha256": common.digest(path), "float32_sha256": waveform_hash,
                                          "projection_seconds": perf_counter() - started})
        common.write_json(args.report, report)
    adapter.close()
    if len(report["projections"]) != len(CODES) * 45 or len(target_hashes) < 2 or len(pcm_hashes) < 2:
        raise ValueError("Selected-profile mapping did not preserve genuinely distinct target identities")
    report.update(status="actual-five-native-sources-and225-selected-projections",
                  all_selected_profiles_projected=True, selected_profile_projection_technical_verified=True,
                  distinct_target_embeddings=len(target_hashes), distinct_projected_waveforms=len(pcm_hashes),
                  source_embeddings_copied_from_previous_model=False, private_python=sys.version,
                  private_onnxruntime=ort.__version__, product_integrated=False)
    common.write_json(args.report, report)
    return report


def pack(args):
    stage = args.stage.resolve()
    result = json.loads(args.preparation_report.read_text(encoding="utf-8"))
    if result.get("status") != "actual-five-native-sources-and225-selected-projections":
        raise ValueError("No actual native/source/projection proof; packs not produced")
    sys.path.insert(0, str(args.core_runtime.resolve()))
    import package_manager
    folder = stage / "models/SharedAfriSixONNX"
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    shared_files = sorted(path for path in folder.iterdir() if path.is_file())
    tasks = [("afri-six-shared", "Спільні дані додаткових мов", shared_files, [])]
    tasks += [("afri-six-" + code, LABELS[code],
               sorted(path for path in (folder / "references" / code).iterdir() if path.is_file()),
               ["afri-six-shared"]) for code in CODES]
    report = {"status": "building-optional-data-only-packs", "minimum_core_version": MINIMUM_CORE_VERSION,
              "product_integrated": False, "actual_release_core11_installed": False,
              "installer_roundtrip_scope": "Actual package_manager and real prepared payload on owned SYNTHETIC version11 manifest scaffold, not an assembled source11 release or NVDA installation",
              "acoustic_projection_scope": "Actual unchanged core9 private Python3.14.5 and ORT1.26; candidate adapter only",
              "packs": []}
    common.write_json(args.report, report, overwrite=args.overwrite)
    for pack_id, label, paths, dependencies in tasks:
        records = {}
        for path in paths:
            name = "kx47Runtime/models/" + path.relative_to(stage / "models").as_posix()
            records[name] = {"size_bytes": path.stat().st_size, "sha256": common.digest(path)}
        meta = {"format": package_manager.FORMAT, "format_version": package_manager.SCHEMA_VERSION,
                "id": pack_id, "name": label, "version": "1.0.0", "minimum_core_version": MINIMUM_CORE_VERSION,
                "engine_ids": ["afri-six-onnx"], "dependencies": dependencies,
                "dependency_versions": {name: "1.0.0" for name in dependencies}, "files": records,
                "scope": "experimental actual native reading; pronunciation/typing/character names unverified"}
        archive = output / (pack_id + "-1.0.0.zip")
        with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as target:
            for path in paths:
                name = "kx47Runtime/models/" + path.relative_to(stage / "models").as_posix()
                entry = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.external_attr = 0o100644 << 16
                with path.open("rb") as source, target.open(entry, "w") as destination:
                    shutil.copyfileobj(source, destination, 1024 * 1024)
            entry = zipfile.ZipInfo(package_manager.MANIFEST, (1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            target.writestr(entry, json.dumps(meta, ensure_ascii=False, sort_keys=True).encode("utf-8"))
        package_manager.inspect_pack(archive)
        report["packs"].append({"id": pack_id, "path": str(archive), "bytes": archive.stat().st_size,
                                 "sha256": common.digest(archive), "files": records})
    # Existing data-only resource installer; fake isolated core version represents required future adapter.
    scratch = args.stage.resolve() / "installer-compatibility"
    scratch.mkdir()
    (scratch / "manifest.ini").write_text('name = dordiai-voices\nversion = "' + MINIMUM_CORE_VERSION + '"\n', encoding="utf-8")
    for row in report["packs"]:
        package_manager.install_pack(row["path"], addon_root=scratch)
    installed = {row["id"] for row in package_manager.list_installed_packs(scratch)}
    if installed != {row["id"] for row in report["packs"]}:
        raise ValueError("Actual package manager did not install every shared/native data pack")
    afri, _ = load_candidate(stage / "runtime")
    if afri.available(scratch / "kx47Runtime/models") != set(CODES):
        raise ValueError("Installed real payload did not expose exactly five prepared native languages")
    try:
        package_manager.uninstall_pack("afri-six-shared", addon_root=scratch)
    except package_manager.PackageError:
        pass
    else:
        raise ValueError("Shared resources could be removed while dependent languages remained installed")
    for code in CODES:
        package_manager.uninstall_pack("afri-six-" + code, addon_root=scratch)
    package_manager.uninstall_pack("afri-six-shared", addon_root=scratch)
    if package_manager.list_installed_packs(scratch):
        raise ValueError("Optional resources were not cleanly removed")
    report.update(status="six-optional-data-packs-built-and-installer-roundtrip-verified",
                  actual_installer_roundtrip_passed=True, no_executable_code_in_resource_packs=True)
    common.write_json(args.report, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("acquire", "prepare", "pack"))
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--candidate-runtime", type=Path)
    parser.add_argument("--graphs", type=Path)
    parser.add_argument("--core-runtime", type=Path)
    parser.add_argument("--network-policy", type=Path)
    parser.add_argument("--preparation-report", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    required = {"acquire": ("candidate_runtime", "graphs"), "prepare": ("core_runtime", "graphs", "network_policy"),
                "pack": ("core_runtime", "preparation_report", "output")}[args.phase]
    if any(getattr(args, name) is None for name in required):
        parser.error("Missing required phase-specific path")
    if args.report.is_symlink() or args.report.exists() and not args.overwrite:
        parser.error("Refusing existing report")
    try:
        return globals()[args.phase](args) and 0
    except Exception as error:
        report = json.loads(args.report.read_text(encoding="utf-8")) if args.report.is_file() else {}
        report.update(status="failed", error_type=type(error).__name__, error=str(error), product_integrated=False)
        common.write_json(args.report, report)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
