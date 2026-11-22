"""Run one pinned new MMS language through the actual Windows packaged worker.

Host preparation uses only the standard library and the existing resource-pack
builder. It downloads immutable model/token bytes and stages a hash-pinned,
measured same-carrier source embedding. No Torch or new host ONNX Runtime is
installed. Only the embedded add-on Python executes acoustic inference.
"""
from __future__ import annotations

import argparse
import ast
import base64
from datetime import datetime, timezone
from hashlib import sha256
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import struct
import subprocess
import sys

HERE = Path(__file__).resolve().parent
DEFAULT_FIXTURE = HERE / "windows_mms_probe_fixture.json"
DEFAULT_INDEX = HERE / "mms_model_sources.json"


def load_tool(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_fixture(document, index):
    if document.get("format") != "dordiai-windows-mms-probe-fixture-v1" or document.get("language") != "ha":
        raise ValueError("Unexpected representative MMS fixture")
    config = document["config"]
    if (config.get("format") != "dordiai-mms-onnx-v1" or config.get("backend") != "mms-onnx"
            or config.get("code") != "ha" or config.get("iso_code") != "hau"
            or config.get("frontend") != "characters" or config.get("is_uroman")):
        raise ValueError("Fixture does not describe the native Hausa MMS carrier")
    source = document["source_npy"]
    if source.get("encoding") != "base64" or source.get("bytes") != 1152:
        raise ValueError("Unexpected source-identity serialization")
    blob = base64.b64decode(source["data"], validate=True)
    if len(blob) != source["bytes"] or sha256(blob).hexdigest() != source["sha256"]:
        raise ValueError("Source-identity fixture checksum mismatch")
    if blob[:8] != b"\x93NUMPY\x01\x00":
        raise ValueError("Unexpected NumPy source format")
    header_size = struct.unpack("<H", blob[8:10])[0]
    header = ast.literal_eval(blob[10:10 + header_size].decode("ascii"))
    if header.get("shape") != (1, 256, 1) or header.get("descr") != "<f4" or header.get("fortran_order"):
        raise ValueError("Source identity is not the measured float32 (1,256,1) tensor")
    payload = blob[10 + header_size:]
    if len(payload) != 1024 or not all(math.isfinite(value) for value in struct.unpack("<256f", payload)):
        raise ValueError("Source identity has invalid numeric contents")
    provenance, identity = config["provenance"], config["source_identity"]
    model = index["models"]["ha"]["assets"]["model.onnx"]
    if (provenance.get("revision") != index["revision"] or provenance.get("repo_id") != index["repository"]
            or provenance.get("model_sha256") != model["sha256"]
            or provenance.get("model_url") != model["url"]
            or identity.get("source_sha256") != source["sha256"]
            or identity.get("basis") != "publisher-sample-from-same-pinned-checkpoint"
            or identity.get("encoder_sha256") != "3dd4918cab90e1acf7fa5c6f7539c27710e7a3cdfba550468c5ea49399178bf7"):
        raise ValueError("Fixture source identity/model provenance does not match pinned inputs")
    if document.get("windows_nvda_verified") or document.get("native_pronunciation_verified"):
        raise ValueError("Fixture cannot predeclare Windows/NVDA or pronunciation acceptance")
    if not isinstance(document.get("sample_text"), str) or not document["sample_text"].strip():
        raise ValueError("Representative MMS probe text is missing")
    return blob


def stage_resources(document, index, directory, download):
    blob = validate_fixture(document, index)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    records = {}
    for filename in ("model.onnx", "tokens.txt"):
        record = index["models"]["ha"]["assets"][filename]
        path = download(record, directory / filename)
        digest = sha256(path.read_bytes()).hexdigest()
        expected = document["config"]["provenance"]["model_sha256" if filename == "model.onnx" else "tokens_sha256"]
        if digest != expected:
            raise ValueError("Downloaded model/token bytes differ from prepared source provenance")
        records[filename] = {"bytes": path.stat().st_size, "sha256": digest, "url": record["url"]}
    (directory / "source.npy").write_bytes(blob)
    (directory / "config.json").write_text(json.dumps(document["config"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (directory / "NOTICE.txt").write_text(document["notice"], encoding="utf-8")
    return {"downloaded": records, "source_sha256": sha256(blob).hexdigest(),
            "source_preparation_platform": "Linux; pinned measured same-checkpoint identity",
            "source_identity": document["config"]["source_identity"]}


def embedded_runtime_info(runtime):
    script = "import json,sys,onnxruntime as ort; print(json.dumps({'python':sys.version,'executable':sys.executable,'onnxruntime':ort.__version__,'ort_module':ort.__file__,'providers':ort.get_available_providers()}))"
    result = subprocess.run([str(runtime / "python/python.exe"), "-I", "-B", "-c", script],
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, check=True)
    document = json.loads(result.stdout)
    if not Path(document["ort_module"]).resolve().is_relative_to((runtime / "python").resolve()):
        raise ValueError("ONNX Runtime was not loaded from the actual embedded add-on runtime")
    return document


def native_carrier_probe(runtime, directory, text, output, timeout):
    # This separate embedded process uses fixed zero-noise inference settings;
    # the later worker check retains the actual production noise settings.
    script = r'''
import json,sys,wave
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import numpy as np
from wide_mms import MMSCarrier
carrier=MMSCarrier(Path(sys.argv[2]))
audio,rate,applied=carrier.audio(sys.argv[3],speed=1.,noise_scale=0.,noise_scale_w=0.)
pcm=np.rint(np.clip(audio,-1,1)*32767).astype('<i2').tobytes()
with wave.open(sys.argv[4],'wb') as target:
 target.setnchannels(1);target.setsampwidth(2);target.setframerate(rate);target.writeframes(pcm)
print(json.dumps({'sample_rate':rate,'frames':len(audio),'duration_seconds':len(audio)/rate,'peak':float(np.max(np.abs(audio))),'rms':float(np.sqrt(np.mean(audio**2))),'noise_scale':0.,'noise_scale_w':0.,'providers':carrier.preload().get_providers()}))
carrier.close()
'''
    result = subprocess.run([str(runtime / "python/python.exe"), "-I", "-B", "-c", script,
                             str(runtime), str(directory), text, str(output / "ha-native-carrier.wav")],
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    (output / "native-carrier-stderr.log").write_text(result.stderr, encoding="utf-8")
    if result.returncode != 0:
        raise ValueError("Actual embedded MMS native carrier failed; inspect native-carrier-stderr.log")
    document = json.loads(result.stdout)
    if document["frames"] <= 0 or document["peak"] <= 0 or not math.isfinite(document["rms"]):
        raise ValueError("Actual embedded native carrier returned invalid sample metrics")
    document["wave_file"] = "ha-native-carrier.wav"
    document["wave_sha256"] = sha256((output / document["wave_file"]).read_bytes()).hexdigest()
    return document


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    parser.add_argument("--timeout", type=float, default=120.)
    args = parser.parse_args(argv)
    if not 0 < args.timeout <= 300:
        parser.error("--timeout must be positive and no more than 300 seconds")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"format": "dordiai-windows-new-mms-probe", "format_version": 1,
              "created_utc": datetime.now(timezone.utc).isoformat(), "status": "running",
              "scope": "actual embedded Windows MMS carrier plus same-speaker voice-conversion worker",
              "language": "ha", "native_pronunciation_verified": False, "nvda_verified": False,
              "wave_player_verified": False, "physical_audio_verified": False, "product_ready": False,
              "host_acoustic_dependencies_installed": False, "runs": []}
    worker = None
    result_code = 1
    try:
        if os.name != "nt":
            report.update(status="blocked", reason="Actual Windows embedded runtime is required; no downloads or acoustic execution performed")
            return 2
        runtime = args.package_root.resolve() / "kx47Runtime"
        if args.package_root.name == "kx47Runtime":
            runtime = args.package_root.resolve()
        if not (runtime / "python/python.exe").is_file():
            raise FileNotFoundError("Packaged embedded Python is missing")
        document = json.loads(args.fixture.read_text(encoding="utf-8"))
        index = json.loads(args.index.read_text(encoding="utf-8"))
        acquire = load_tool(HERE / "prepare_mms_models.py", "_mms_windows_acquire")
        report["fixture_sha256"] = sha256(args.fixture.read_bytes()).hexdigest()
        report["resource_preparation"] = stage_resources(document, index, output / "staging/MMS/ha", acquire.download)
        report["embedded_runtime"] = embedded_runtime_info(runtime)
        report["native_carrier_probe"] = native_carrier_probe(
            runtime, output / "staging/MMS/ha", document["sample_text"], output, args.timeout)
        builder = load_tool(HERE / "build_resource_pack.py", "_mms_windows_pack_builder")
        archive = output / "windows-mms-ha-probe.zip"
        report["resource_archive"] = builder.create_resource_pack(
            output / "staging/MMS/ha", archive, prefix="kx47Runtime/models/MMS/ha",
            identity="windows-mms-ha-probe", name="Pinned Hausa MMS Windows probe resources",
            languages=("ha",), engine_ids=("mms-onnx",), metadata_extra={
                "native_pronunciation_verified": False, "windows_nvda_verified": False,
                "provenance": document["config"]["provenance"]})
        manager = load_tool(runtime / "package_manager.py", "_mms_windows_actual_package_manager")
        report["resource_installation"] = manager.install_pack(archive, runtime.parent)
        engine = load_tool(HERE / "windows_engine_probe.py", "_mms_windows_engine_probe")
        catalog = engine.load_catalog(runtime)
        report["installed_language_status"] = catalog.language_status(runtime / "models", "ha")
        if not report["installed_language_status"]["resources_present"]:
            raise ValueError("Installed MMS representative is not available through the actual runtime catalogue")
        voices = json.loads((runtime / "models/voices/catalog.json").read_text(encoding="utf-8"))
        compatible = catalog.compatible_voice_ids(runtime / "models", "ha", tuple(voices))
        if not compatible:
            raise ValueError("No allowed installed voice is compatible with the MMS representative")
        voice = "sara" if "sara" in compatible else compatible[0]
        report.update(voice=voice, text=document["sample_text"],
                      waveform_bitwise_determinism="not asserted; actual production MMS noise settings remain active")
        worker = engine.PipeWorker(runtime, output / "worker-stderr.log")
        for repetition in range(2):
            pcm, result = worker.render(engine.make_request("ha", voice, document["sample_text"]), args.timeout)
            filename = f"ha-{engine.safe_name(voice)}-{repetition + 1}.wav"
            engine.save_wave(output / filename, pcm)
            report["runs"].append(dict(result, wave_file=filename, warm_repeat=repetition > 0,
                                       wave_sha256=sha256((output / filename).read_bytes()).hexdigest()))
            if not result["renderers"] or any(renderer.get("engine") != "wide:ha"
                    or renderer.get("speaker") != voice for renderer in result["renderers"]):
                raise ValueError("MMS worker fell back or changed the selected speaker")
        report["first_pcm"] = engine.timing_summary(run["first_pcm_ms"] for run in report["runs"])
        report["status"] = "passed-engine-smoke"
        result_code = 0
    except Exception as error:
        report.update(status="failed", error=type(error).__name__ + ": " + str(error))
        result_code = 1
    finally:
        if worker is not None:
            report["worker_shutdown"] = worker.close()
            if report["worker_shutdown"]["forced_termination"] or report["worker_shutdown"]["exit_code"] != 0:
                report.update(status="failed", error="Actual embedded worker did not shut down cleanly")
                result_code = 1
        report["completed_utc"] = datetime.now(timezone.utc).isoformat()
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"windows_mms_probe": report["status"], "error": report.get("error"),
                          "report": str(output / "report.json")}), flush=True)
    return result_code


if __name__ == "__main__":
    raise SystemExit(main())
