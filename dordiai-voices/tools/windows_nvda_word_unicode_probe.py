"""Matched real frozen-NVDA external Resource Unicode-fast-path comparison.

No product addon/archive is installed or changed. Exact source11 manager
and host-path modules, reviewed1738 cache control and V2 fast-path candidate
are copied into an owned external probe; both leaves retain fixed Git pins. Data/descriptor copies have a >260 plain
path. Only finite membership, repeat lookup timing and lifecycle are checked.
"""
from __future__ import annotations
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
DATA_SHA = "21208748a50ebf3f5dd3e2feb94f0f3caf3490c2be784aaca2209462380e6689"
SOURCE_SHA = "d7c8157a3cfc44d3e6cce9daf45099fb34c4f5f1e80edfed70a50e6cde2d6199"
DESCRIPTOR_SHA = "2de5611c384e933e19d1cdf5fda37f17bd5c4b7602d09964f53fdb7280877459"
BASELINE_BLOB = "1738de70c9a81fab54eddde9f1e3442b9d962813"
CANDIDATE_BLOB = "7fadc20d6bd735db2b7cc08f0b694422ed27ea2e"
CONTROLLER_BLOB = "86cd46c2242614a6ec941d92767781c4d5ba34bc"
MODULE_PINS = {
    "native_membership_runtime.py": "7a620a2af548a64d909c907cbc206c4cb6c7a07c",
    "host_paths.py": "c8c7ff7571bd23d64ab4a1e84e246f5d7fcba057",
    "windows_runtime.py": "66a539fcdf000900c75dd00b3362f09fe05bb3c0",
}

HOST_PLUGIN = r'''
import globalPluginHandler
import core
import synthDriverHandler
import versionInfo
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
import time
import traceback

SETTINGS = __HOST_MEMBERSHIP_SETTINGS__


def percentiles(values):
    ordered = sorted(values)
    count = len(ordered)
    if not count:
        raise ValueError("No actual lookup samples")
    return {"count": count, "median_ms": (ordered[(count-1)//2]+ordered[count//2])/2,
            "p95_ms": ordered[math.ceil(count*.95)-1],
            "p99_ms": ordered[math.ceil(count*.99)-1], "max_ms": ordered[-1],
            "total_ms": sum(values)}


def load_module(name, path, expected_blob):
    raw = path.read_bytes()
    actual = hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest()
    if actual != expected_blob:
        raise ValueError("External copied module does not match reviewed Git blob")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def timed(candidates, cases, count):
    samples = []
    for index in range(count):
        case = cases[index % len(cases)]
        tick = time.perf_counter_ns()
        actual = candidates(case["word"])
        samples.append((time.perf_counter_ns()-tick)/1e6)
        if actual != frozenset(case["memberships"]):
            raise ValueError("Actual native membership differs from source/control")
    return percentiles(samples)


def run_membership_host_probe():
    report = {"format": "dordiai-real-frozen-nvda-external-word-unicode-manager",
        "format_version": 1, "status": "failed", "run_id": SETTINGS["run_id"],
        "nvda_version": versionInfo.version, "python": sys.version,
        "frozen": bool(getattr(sys, "frozen", False)), "checks": [], "comparisons": [],
        "scope": "Real frozen NVDA external unchanged Resource wrapper and leaf; no installed-product or speech test",
        "product_addon_installed": False, "product_archive_modified": False,
        "production_routing_verified": False, "typing_verified": False,
        "physical_audio_verified": False, "acoustic_latency_verified": False,
        "pronunciation_verified": False, "product_ready": False,
        "first_use_unique_improvement_claimed": False, "os_file_cache_evicted": False,
        "audio_scope": "Builtin silence; no playback or output sink replacement"}
    resource = None
    descriptor = Path(SETTINGS["descriptor_path"])
    original_descriptor = None
    def check(name, passed, **details):
        report["checks"].append(dict(name=name, status="passed" if passed else "failed", **details))
    try:
        check("real_frozen_nvda_313", report["frozen"] and versionInfo.version == "2026.3.1"
              and sys.version_info[:2] == (3, 13))
        check("builtin_silence", getattr(synthDriverHandler.getSynth(), "name", None) == "silence")
        data = Path(SETTINGS["data_path"])
        with data.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != SETTINGS["data_sha256"]:
                raise ValueError("External actual DMLX hash differs")
        original_descriptor = descriptor.read_bytes()
        if len(original_descriptor) != 558 or hashlib.sha256(original_descriptor).hexdigest() != SETTINGS["descriptor_sha256"]:
            raise ValueError("Exact original558B descriptor differs")
        check("long_external_data_path", len(SETTINGS["plain_data_path"]) > 260,
              plain_characters=len(SETTINGS["plain_data_path"]), namespace_characters=len(str(data)),
              installed_product_long_path_verified=False)
        before_sys_path = tuple(sys.path)
        cases = SETTINGS["cases"]
        variants = ("original", "candidate-cache0", "candidate-default")
        for round_number in range(1, 4):
            order = variants if round_number % 2 else tuple(reversed(variants))
            for variant in order:
                item = SETTINGS["variants"][variant]
                folder = Path(item["folder"])
                for filename, expected in SETTINGS["module_pins"].items():
                    raw = (folder/filename).read_bytes()
                    if hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest() != expected:
                        raise ValueError("Copied manager/host module changed before actual import")
                unique = SETTINGS["run_id"]+"_"+str(round_number)+"_"+variant.replace("-", "_")
                leaf = load_module("_cache_external_leaf_"+unique,
                    folder/"native_word_membership.py", item["leaf_git_blob"])
                manager = load_module("_cache_external_manager_"+unique,
                    folder/"native_membership_runtime.py", SETTINGS["manager_git_blob"])
                kwargs = {"word_cache_entries": 0} if variant == "candidate-cache0" else {}
                def factory(path, digest):
                    return leaf.MembershipLexicon(path, digest, **kwargs)
                tick = time.perf_counter_ns()
                resource = manager.Resource(Path(SETTINGS["models_path"]),
                    Path(SETTINGS["addon_root"]), reader_factory=factory)
                reader = resource.reader
                row = {"round": round_number, "variant": variant,
                    "resource_open_ms": (time.perf_counter_ns()-tick)/1e6,
                    "leaf_git_blob": item["leaf_git_blob"], "manager_git_blob": SETTINGS["manager_git_blob"],
                    "resource_enabled": resource.enabled, "case_count": len(cases),
                    "manager_lookup_api": "Unchanged Resource.candidates; no installed driver lease"}
                if not resource.enabled or reader is None or reader.word_count != 6642550 or reader.codes != ("uk", "ru"):
                    raise ValueError("Actual manager did not open exact native resource")
                row["first_pass_manager97"] = timed(resource.candidates, cases, len(cases))
                row["reader100"] = timed(reader.candidates, cases, 100)
                row["manager100"] = timed(resource.candidates, cases, 100)
                row["reader1000"] = timed(reader.candidates, cases, 1000)
                row["manager1000"] = timed(resource.candidates, cases, 1000)
                row["statistics"] = reader.statistics()
                cancelled = False
                try:
                    reader.candidates(cases[0]["word"], cancelled=lambda: True)
                except leaf.LexiconCancelled:
                    cancelled = True
                row["cancellation_checked_before_cached_return"] = cancelled
                if not cancelled:
                    raise ValueError("A cached native result bypassed cancellation")
                # Mutate only this probe's copied558B descriptor after measured
                # reads. This is never an installed or archived resource.
                descriptor.write_bytes(b"X"+original_descriptor[1:])
                detected = False
                try:
                    resource.candidates(cases[0]["word"])
                except manager.NativeMembershipResourceError:
                    detected = True
                row["descriptor_change_rejected_even_after_cache_hit"] = detected
                resource.close()
                resource = None
                closed = reader.statistics()
                row["closed_statistics"] = closed
                if not detected or not closed["closed"] or closed["cached_blocks"] or closed.get("cached_words", 0):
                    raise ValueError("Changed descriptor or cache cleanup was not enforced")
                descriptor.write_bytes(original_descriptor)
                if hashlib.sha256(descriptor.read_bytes()).hexdigest() != SETTINGS["descriptor_sha256"]:
                    raise ValueError("Copied descriptor exact restoration failed")
                report["comparisons"].append(row)
        check("nine_real_manager_comparisons", len(report["comparisons"]) == 9)
        check("host_sys_path_unchanged", tuple(sys.path) == before_sys_path, private_python_path_added=False)
        # All9 original/candidate resources are closed; rename ONLY our data
        # copy to prove Windows mmap handles are no longer retained.
        moved = data.with_name(data.name+".closed")
        data.rename(moved)
        moved.rename(data)
        check("all_external_windows_mapping_handles_released", True)
        with data.open("rb") as stream:
            check("data_unchanged", hashlib.file_digest(stream, "sha256").hexdigest() == SETTINGS["data_sha256"])
        check("descriptor_exact_restoration", descriptor.read_bytes() == original_descriptor)
        report["status"] = "passed-host-compatibility" if all(row["status"] == "passed" for row in report["checks"]) else "failed"
    except Exception as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)[:2000],
            "frames": [{"file": Path(frame.filename).name, "function": frame.name, "line": frame.lineno}
                       for frame in traceback.extract_tb(error.__traceback__)[-12:]]}
    finally:
        try:
            if resource is not None:
                resource.close()
            if original_descriptor is not None and descriptor.is_file():
                current = descriptor.read_bytes()
                if current != original_descriptor:
                    if current != b"X"+original_descriptor[1:]:
                        raise ValueError("Unexpected descriptor contents; refusing overwrite")
                    descriptor.write_bytes(original_descriptor)
        except Exception as error:
            report["status"] = "failed"
            report["cleanup_error"] = type(error).__name__+": "+str(error)[:1000]
        path = Path(SETTINGS["report_path"])
        temporary = path.with_name(path.name+".writing")
        try:
            temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
            temporary.replace(path)
        finally:
            core.callLater(100, core.triggerNVDAExit)


class GlobalPlugin(globalPluginHandler.GlobalPlugin):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        core.callLater(1500, run_membership_host_probe)
'''


def file_sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def pinned_source(path, blob):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size < 1024*1024:
        raise ValueError("Reviewed regular source module required")
    raw = path.read_bytes()
    if hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest() != blob:
        raise ValueError("Reviewed source Git identity differs")
    return raw


def namespace(path):
    path = Path(path).absolute()
    text = str(path)
    if os.name == "nt" and not text.startswith("\\\\?\\"):
        text = "\\\\?\\UNC\\"+text[2:] if text.startswith("\\\\") else "\\\\?\\"+text
    return Path(text)


def prepare_owned_inputs(dataset, run):
    dataset, run = Path(dataset), Path(run)
    binary, source = dataset/"native-word-membership.bin", dataset/"acquisition-report.json"
    if binary.is_symlink() or binary.stat().st_size != 18661227 or file_sha(binary) != DATA_SHA:
        raise ValueError("Exact authenticated DMLX required before copying")
    if source.is_symlink() or source.stat().st_size > 1024*1024 or file_sha(source) != SOURCE_SHA:
        raise ValueError("Exact authenticated source receipt required")
    base = base_controller()
    cases = [case for case in base.sample_cases(json.loads(source.read_text(encoding="utf-8")))
             if case["word"] != "invalid control with spaces"]
    # Valid-shaped absence is authenticated by the actual original reader in
    # every round, not asserted to be an example of any language.
    cases.append({"word": "я"*96, "memberships": []})
    if len(cases) != 97:
        raise ValueError("Exact96 source samples and one finite-absence control required")
    descriptor = ROOT/"tools/data/native_word_membership_resource_v1.json"
    if descriptor.is_symlink() or descriptor.stat().st_size != 558 or file_sha(descriptor) != DESCRIPTOR_SHA:
        raise ValueError("Exact trusted558B descriptor required")
    runtime = ROOT/"source/0.12.2/kx47Runtime"
    archived_manager = ROOT/"experiments/native-resource-path-cache/baseline_source12.py"
    baseline = ROOT/"experiments/native-word-cache/native_word_membership.py"
    candidate = ROOT/"experiments/native-word-unicode-fast/native_word_membership.py"
    for path, blob in ((baseline, BASELINE_BLOB), (candidate, CANDIDATE_BLOB)):
        pinned_source(path, blob)
    for name, blob in MODULE_PINS.items():
        pinned_source(archived_manager if name == "native_membership_runtime.py" else runtime/name, blob)
    external = run/"external-word-cache"
    external.mkdir()
    data_root = external/"data"
    for index in range(32):
        data_path = data_root/"kx47Runtime/models/WordLanguage/native-word-membership.bin"
        if len(str(data_path)) > 280:
            break
        data_root /= "native-membership-exact-"+str(index).zfill(2)
    else:
        raise ValueError("Could not construct bounded long external data path")
    models = data_root/"kx47Runtime/models"
    folder = namespace(models/"WordLanguage")
    folder.mkdir(parents=True)
    copied_data, copied_descriptor = folder/binary.name, folder/"native-word-membership.json"
    shutil.copyfile(binary, copied_data)
    shutil.copyfile(descriptor, copied_descriptor)
    if file_sha(copied_data) != DATA_SHA or file_sha(copied_descriptor) != DESCRIPTOR_SHA:
        raise ValueError("Copied external dictionary/descriptor differs")
    variants = {}
    for variant, path, blob in (("original", baseline, BASELINE_BLOB),
            ("candidate-cache0", candidate, CANDIDATE_BLOB), ("candidate-default", candidate, CANDIDATE_BLOB)):
        code = external/variant
        code.mkdir()
        (code/"native_word_membership.py").write_bytes(pinned_source(path, blob))
        for name, expected in MODULE_PINS.items():
            source = archived_manager if name == "native_membership_runtime.py" else runtime/name
            (code/name).write_bytes(pinned_source(source, expected))
        variants[variant] = {"folder": str(code), "leaf_git_blob": blob}
    return {"data_path": str(copied_data), "plain_data_path": str(data_path),
        "descriptor_path": str(copied_descriptor), "models_path": str(namespace(models)),
        "addon_root": str(namespace(data_root)), "data_sha256": DATA_SHA,
        "descriptor_sha256": DESCRIPTOR_SHA, "source_report_sha256": SOURCE_SHA,
        "manager_git_blob": MODULE_PINS["native_membership_runtime.py"], "module_pins": MODULE_PINS,
        "cases": cases,
        "variants": variants}


def base_controller():
    path = Path(__file__).with_name("windows_nvda_membership_host_probe.py")
    pinned_source(path, CONTROLLER_BLOB)
    spec = importlib.util.spec_from_file_location("_owned_word_cache_host_controller", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv=None):
    # Compose only our pinned disposable controller; no production or NVDA
    # module is monkeypatched. Installer, unrelated-process guard, owned PID
    # cleanup and exact report ownership remain the original reviewed code.
    controller = base_controller()
    controller.prepare_owned_inputs = prepare_owned_inputs
    controller.HOST_PLUGIN = HOST_PLUGIN
    return controller.main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
