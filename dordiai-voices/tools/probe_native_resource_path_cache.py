"""Owned exact-data Resource comparison; cache only immutable path spelling."""
import argparse
import cProfile
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import pstats
import shutil
import statistics
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
PREPARER_BLOB = "46e677cd20d3a873095485880dfdf80994f70ec4"
MANAGER_BLOB = "960459711ee3af8976540fd4595489fb7f69aedb"


def pinned(path, expected):
    if path.is_symlink() or not path.is_file():
        raise ValueError("An ordinary reviewed source file is required")
    raw = path.read_bytes()
    actual = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
    if actual != expected:
        raise ValueError("Reviewed source Git identity differs")
    return raw


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def measure(lookup, cases, count):
    elapsed = []
    for index in range(count):
        case = cases[index % len(cases)]
        started = time.perf_counter_ns()
        actual = lookup(case["word"])
        elapsed.append((time.perf_counter_ns() - started) / 1e6)
        if actual != frozenset(case["memberships"]):
            raise ValueError("Actual dictionary membership differs")
    ordered = sorted(elapsed)
    return {"count": count, "median_ms": statistics.median(ordered),
        "p95_ms": ordered[math.ceil(count * .95) - 1],
        "p99_ms": ordered[math.ceil(count * .99) - 1], "total_ms": sum(ordered)}


def run(dataset, output):
    preparer_path = ROOT / "tools/windows_nvda_resource_path_cache_probe.py"
    pinned(preparer_path, PREPARER_BLOB)
    preparer = load("_path_cache_owned_preparer", preparer_path)
    manager_source = ROOT / "experiments/native-resource-path-cache/native_membership_runtime.py"
    raw_manager = pinned(manager_source, MANAGER_BLOB)
    report = {"format": "dordiai-resource-pure-path-cache-matched-profile", "format_version": 1,
        "status": "failed", "python": sys.version, "platform": sys.platform,
        "baseline_manager_git_blob": preparer.MODULE_PINS["native_membership_runtime.py"],
        "candidate_manager_git_blob": MANAGER_BLOB, "leaf_git_blob": preparer.CANDIDATE_BLOB,
        "production_changed": False, "nvda_verified": False, "pronunciation_verified": False,
        "physical_audio_verified": False, "product_ready": False,
        "scope": "Three reverse-order rounds with new Resource objects in one normal CPython process. "
                 "Both use the identical V2 leaf and authentic DMLX/descriptor. "
                 "Timings exclude cProfile; separate profiles include instrumentation overhead. "
                 "No OS cache eviction or installed-driver/audio acceptance.", "comparisons": []}
    with tempfile.TemporaryDirectory(prefix="dordiai-resource-path-profile-") as temporary:
        setting = preparer.prepare_owned_inputs(dataset, temporary)
        folder = Path(setting["variants"]["original"]["folder"])
        changed = folder.parent / "manager-path-cache"
        shutil.copytree(folder, changed)
        (changed / "native_membership_runtime.py").write_bytes(raw_manager)
        report["data_sha256"] = setting["data_sha256"]
        report["plain_data_path_characters"] = len(setting["plain_data_path"])
        for number in range(1, 4):
            order = ("baseline", "candidate") if number % 2 else ("candidate", "baseline")
            for variant in order:
                code = folder if variant == "baseline" else changed
                leaf = load("_path_profile_leaf_" + str(number) + variant, code / "native_word_membership.py")
                manager = load("_path_profile_manager_" + str(number) + variant, code / "native_membership_runtime.py")
                resource = manager.Resource(setting["models_path"], setting["addon_root"],
                    reader_factory=leaf.MembershipLexicon)
                try:
                    row = {"round": number, "variant": variant,
                        "parent_counts": [len(path.parents) + 1 for path in resource.paths],
                        "first97": measure(resource.candidates, setting["cases"], 97),
                        "reader1000": measure(resource.reader.candidates, setting["cases"], 1000),
                        "manager1000": measure(resource.candidates, setting["cases"], 1000)}
                    profile = cProfile.Profile()
                    profile.enable()
                    try:
                        measure(resource.candidates, setting["cases"], 1000)
                    finally:
                        profile.disable()
                    row["profile"] = [{"filename": key[0], "line": key[1], "function": key[2],
                        "primitive_calls": value[0], "calls": value[1],
                        "self_seconds": value[2], "cumulative_seconds": value[3]}
                        for key, value in pstats.Stats(profile).stats.items()]
                    row["profile"].sort(key=lambda item: item["self_seconds"], reverse=True)
                    if variant == "candidate":
                        row["spelling_cache"] = manager._plain_path_ancestry.cache_info()._asdict()
                    report["comparisons"].append(row)
                finally:
                    resource.close()
                row["closed"] = resource.closed and resource.reader is None
                if not row["closed"]:
                    raise ValueError("Owned Resource did not close")
        for number in range(1, 4):
            pair = [row for row in report["comparisons"] if row["round"] == number]
            counts = [{(entry["filename"], entry["function"]): entry["calls"]
                for entry in row["profile"] if entry["function"] in ("is_symlink", "is_junction", "stat", "lstat")
                or (entry["filename"] == "~" and any(name in entry["function"] for name in ("nt.", "posix."))
                    and any(name in entry["function"] for name in ("stat", "islink", "isjunction")))}
                for row in pair]
            if counts[0] != counts[1]:
                raise ValueError("Candidate changed live filesystem check counts")
        report["all_round_filesystem_check_counts_identical"] = True
        report["status"] = "passed-matched-profile"
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-dir", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    result = run(args.dataset_dir, args.output)
    print(json.dumps({key: value for key, value in result.items() if key != "comparisons"}, ensure_ascii=False))
    for row in result["comparisons"]:
        print("PATH_PROFILE_MATCHED " + json.dumps({key: value for key, value in row.items() if key != "profile"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
