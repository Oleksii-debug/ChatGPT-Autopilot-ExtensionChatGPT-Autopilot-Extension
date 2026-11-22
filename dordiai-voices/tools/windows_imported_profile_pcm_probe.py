"""Isolated immutable-core13 managed-profile -> real Holos ONNX -> PCM proof.

No live NVDA configuration/audio device is opened. The observer only forwards
calls unchanged and records successful acoustic graph input identities. Fixtures
are technical copies of permitted profiles, never new people or voice training.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
from queue import Queue
import shutil
import subprocess
import sys
from threading import Thread
import wave

TEST_ID = "probe_imported_profile"
EXCLUDED = {"kostia", "inna", "dina", "vira", "innesa", "veronika_classmate", "anatolii", "veronika"}
TEXT = "Збережений профіль читає нове речення. Перевірка українського голосу."
RELEASE_SHA256 = "839f781a417d30da0af4cfa15aefefd8d3dc26629dd00c04c6ff0277a479b035"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def fixture_manifest(version, data, source_id):
    if source_id in EXCLUDED or source_id not in {"sara_archive", "bella"}:
        raise ValueError("Only explicit permitted technical fixture sources")
    return {"format": "dordiai-voice-package", "format_version": 1,
            "id": TEST_ID, "name": "Technical profile copy; not a new person", "version": version,
            "engine": {"id": "holos", "compatibility_version": 1},
            "languages": ["uk"], "styles": ["neutral"], "requires": [],
            "provenance": {"source": "Exact internal regression copy of " + source_id,
                           "license": "Inherited source conditions; internal fixture, no new distribution permission"},
            "files": {"holos.npy": {"size_bytes": len(data),
                                     "sha256": hashlib.sha256(data).hexdigest(), "role": "holos_profile"}}}


def owned_output(addon, output):
    addon, output = Path(addon).resolve(), Path(output).resolve()
    if output.drive.casefold() != "d:" or addon == output or addon in output.parents or output in addon.parents:
        raise ValueError("Output must be a separate owned D: directory outside the immutable add-on")
    if output.exists():
        raise ValueError("Use a fresh output directory; existing data is never removed")
    return addon, output


def graph_identity_proof(rows, expected):
    """Require successful encoder, prosody AND audio decoder with actual style."""
    calls = [row for row in rows if row.get("kind") == "successful_onnx_run"
             and row.get("voice_array_sha256") == expected]
    return all(any(name in row.get("model", "").casefold() for row in calls)
               for name in ("encoder", "prosody", "decoder"))


OBSERVER = r'''
import sys, json, hashlib
from pathlib import Path
runtime, trace = Path(sys.argv[1]), Path(sys.argv[2])
sys.path.insert(0, str(runtime))
def record(**row):
    with trace.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, ensure_ascii=True) + "\n")
import ukrainian_voices, session_control, navigation_cache
original_asset = ukrainian_voices.asset_path
def observed_asset(references, profile, role, **kw):
    path = original_asset(references, profile, role, **kw)
    if path is not None:
        data = Path(path).read_bytes()
        record(kind="verified_asset", profile=profile, role=role, path=str(path),
               file_sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data))
    return path
ukrainian_voices.asset_path = observed_asset
original_run = session_control.GuardedSession.run
def observed_run(self, output_names, input_feed, run_options=None):
    result = original_run(self, output_names, input_feed, run_options)
    if "voice" in input_feed:
        voice = input_feed["voice"]
        record(kind="successful_onnx_run", model=str(getattr(self.session,"_model_path","unknown")),
               voice_array_sha256=hashlib.sha256(voice.tobytes()).hexdigest(),
               shape=list(voice.shape), dtype=str(voice.dtype), outputs=output_names)
    return result
session_control.GuardedSession.run = observed_run
original_clip = navigation_cache.load_clip
def observed_clip(*args, **kwargs):
    result = original_clip(*args, **kwargs)
    record(kind="navigation_bank_lookup", hit=result is not None)
    return result
navigation_cache.load_clip = observed_clip
sys.argv = [str(runtime / "nvda_worker.py"), *sys.argv[3:]]
import nvda_worker
nvda_worker.main()
'''


def load_helper():
    path = Path(__file__).with_name("windows_engine_probe.py")
    spec = importlib.util.spec_from_file_location("imported_profile_engine_helper", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def worker(helper, runtime, refs, observer, trace, stderr_path):
    """Reuse finite bounded JSON/PCM transport with a forward-only observer."""
    obj = helper.PipeWorker.__new__(helper.PipeWorker)
    obj.runtime = runtime
    obj.command = [str(runtime / "python/python.exe"), "-I", "-B", "-u", str(observer),
                   str(runtime), str(trace), str(runtime / "models"), "--reference-model",
                   str(runtime / "models/Holos"), "--references", str(refs),
                   "--reference-engine", "holos", "--preload-language", "uk"]
    obj.responses = Queue()
    obj.stderr = stderr_path.open("wb")
    try:
        obj.process = subprocess.Popen(obj.command, cwd=runtime, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=obj.stderr,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
                                       | getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0))
    except BaseException:
        obj.stderr.close()
        raise
    obj.reader = Thread(target=obj._read, daemon=True)
    obj.reader.start()
    return obj


def run(addon, output, timeout=180):
    if platform.system() != "Windows":
        raise ValueError("This probe requires real Windows packaged native libraries")
    addon, output = owned_output(addon, output)
    if digest(addon / "dordiai-release.json") != RELEASE_SHA256:
        raise ValueError("Restored immutable source13 inventory digest differs")
    release = json.loads((addon / "dordiai-release.json").read_text(encoding="utf-8-sig"))
    if release.get("version") != "0.13.1-dev.13" or len(release.get("voice_ids", [])) != 45:
        raise ValueError("Expected restored immutable 45-profile source13 payload")
    runtime = addon / "kx47Runtime"
    tracked = sorted(runtime.glob("*.py"))
    tracked += sorted((runtime / "models/Holos").iterdir())
    tracked += [runtime / "python/python.exe"]
    tracked += [runtime / "models/voices/holos" / (name + ".npy") for name in ("sara_archive", "bella")]
    before = {str(path): digest(path) for path in tracked}
    for path in tracked:
        name = path.relative_to(addon).as_posix()
        expected = release["files"].get(name)
        if expected is None or expected["sha256"] != before[str(path)] or expected["size_bytes"] != path.stat().st_size:
            raise ValueError("Immutable inventory mismatch: " + name)
    output.mkdir(parents=True)
    refs = output / "references"
    (refs / "holos").mkdir(parents=True)
    # Only small Holos profile data/calibration are copied. No letter, command,
    # navigation, or native banks exist here; large models remain read-only shared.
    for path in (runtime / "models/voices/holos").glob("*.npy"):
        if path.stem not in EXCLUDED:
            shutil.copyfile(path, refs / "holos" / path.name)
    for name in ("reference_prosody.json", "ukrainian_articulation.json"):
        shutil.copyfile(runtime / "models/voices" / name, refs / name)
    sys.path.insert(0, str(runtime))
    try:
        import voice_assets as assets
    finally:
        sys.path.pop(0)
    helper = load_helper()
    observer = output / "observer.py"
    observer.write_text(OBSERVER, encoding="utf-8")
    import numpy as np
    versions, cases = {}, []
    for version, source_id in (("1.0.0", "sara_archive"), ("2.0.0", "bella")):
        data = (refs / "holos" / (source_id + ".npy")).read_bytes()
        source = output / ("source-" + version)
        source.mkdir()
        (source / "holos.npy").write_bytes(data)
        package = output / ("fixture-" + version + ".zip")
        manifest = fixture_manifest(version, data, source_id)
        assets._packages.create_package(source, manifest, package)
        assets.install_voice_package(package, refs, engine_id="holos", resources={})
        value = np.load(source / "holos.npy", allow_pickle=False)
        versions[version] = {"source_profile": source_id, "file_sha256": hashlib.sha256(data).hexdigest(),
                             "array_sha256": hashlib.sha256(value.tobytes()).hexdigest(),
                             "package_sha256": digest(package), "shape": list(value.shape), "dtype": str(value.dtype)}

    def render(label, profile, version=None, expect_failure=False):
        if version is not None:
            assets.activate_voice_version(refs, TEST_ID, version, engine_id="holos", resources={})
        trace = output / (label + ".trace.jsonl")
        obj = worker(helper, runtime, refs, observer, trace, output / (label + ".stderr.log"))
        row = {"case": label, "profile": profile, "version": version, "request_text": TEXT}
        try:
            request = helper.make_request("uk", profile, TEXT)
            pcm, metrics = obj.render(request, timeout)
            if expect_failure:
                raise AssertionError("Missing managed identity silently returned audio")
            wav = output / (label + ".wav")
            with wave.open(str(wav), "wb") as stream:
                stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(24000); stream.writeframes(pcm)
            row.update(metrics=metrics, pcm_sha256=hashlib.sha256(pcm).hexdigest(), wav=str(wav), wav_sha256=digest(wav))
        except helper.ProbeError as error:
            if not expect_failure:
                raise
            if str(error) != "Speech engine error: PackageError":
                raise AssertionError("Expected managed-package rejection, not another worker failure") from error
            row.update(expected_failure=True, error=str(error))
        finally:
            row["shutdown"] = obj.close()
        traces = [json.loads(line) for line in trace.read_text(encoding="utf-8").splitlines()] if trace.exists() else []
        row.update(trace=str(trace), trace_sha256=digest(trace) if trace.exists() else None, observed=traces)
        row["stderr_sha256"] = digest(output / (label + ".stderr.log"))
        if expect_failure and any(t.get("kind") == "successful_onnx_run" for t in traces):
            raise AssertionError("Invalid package reached acoustic model instead of failing closed")
        if row["shutdown"].get("forced_termination") or row["shutdown"].get("exit_code") != 0:
            raise AssertionError("Worker did not shut down cleanly")
        if not expect_failure:
            wanted = versions[version or "1.0.0"]
            row["actual_graph_identity_proved"] = graph_identity_proof(traces, wanted["array_sha256"])
            row["no_navigation_bank_hit"] = not any(t.get("hit") for t in traces if t.get("kind") == "navigation_bank_lookup")
            if version:
                found = [t for t in traces if t.get("kind") == "verified_asset" and t.get("profile") == TEST_ID]
                row["managed_asset_exact"] = bool(found) and all(t["file_sha256"] == wanted["file_sha256"]
                    and Path(t["path"]).samefile(refs / "packages" / TEST_ID / version / "holos.npy") for t in found)
            if not row["actual_graph_identity_proved"] or not row["no_navigation_bank_hit"] or row.get("managed_asset_exact") is False:
                raise AssertionError("Imported asset/actual graph identity or bank exclusion proof missing")
        cases.append(row)

    render("builtin-control", "sara_archive")
    render("imported-v1", TEST_ID, "1.0.0")
    render("imported-v2-changed-input", TEST_ID, "2.0.0")
    render("rollback-v1", TEST_ID, "1.0.0")
    target = assets.asset_path(refs, TEST_ID, "holos_profile", required=True)
    held = target.with_suffix(".npy.held")
    target.rename(held)
    try:
        render("missing-managed-asset", TEST_ID, expect_failure=True)
    finally:
        held.rename(target)
        assets.clear_cache()
    same_input = cases[0]["pcm_sha256"] == cases[1]["pcm_sha256"] == cases[3]["pcm_sha256"]
    changed = cases[1]["pcm_sha256"] != cases[2]["pcm_sha256"]
    after = {str(path): digest(path) for path in tracked}
    result = {"format": "dordiai-imported-profile-pcm-probe", "format_version": 1,
              "created_utc": datetime.now(timezone.utc).isoformat(), "platform": platform.platform(),
              "status": "passed" if same_input and changed and before == after else "failed", "addon": str(addon),
              "release_version": release["version"], "technical_copy_not_new_person": True,
              "immutable_release_inventory_sha256": RELEASE_SHA256,
              "original_files_before": before, "original_files_after": after,
              "original_tracked_files_unchanged": before == after,
              "worker_python_sha256": digest(runtime / "python/python.exe"),
              "observer_sha256": digest(observer), "versions": versions, "cases": cases,
              "same_array_builtin_imported_rollback_pcm_identical": same_input,
              "changed_imported_target_changes_pcm": changed,
              "scope": "Windows packaged Holos uk managed asset to actual successful ONNX inputs and 24kHz PCM",
              "not_proved": ["NVDA/UI integration", "physical audio onset/cancellation", "native pronunciation or perceived identity",
                             "English/Russian and other engines/adapters", "product acceptance"], "product_ready": False}
    (output / "report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--addon", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=180)
    args = parser.parse_args()
    result = run(args.addon, args.output, args.timeout)
    print(json.dumps({"status": result["status"], "cases": len(result["cases"]), "product_ready": False}))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
