"""Run reviewed voice-removal candidates in an isolated checkout copy."""
from hashlib import sha1, sha256
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

FILES = {
    "voice_packages.py": "source/0.12.2/kx47Runtime/voice_packages.py",
    "preferences.py": "source/0.12.2/kx47Runtime/preferences.py",
    "upgrade_packages.py": "source/0.12.2/kx47Runtime/upgrade_packages.py",
    "test_voice_package_retention.py": "tests/test_voice_package_retention.py",
}
BASE = {
    FILES["voice_packages.py"]: "5be4b4dcac5bf3aa27baf657bace97e0e50b47a6",
    FILES["preferences.py"]: "dc8aab9ba81a6a53d3e0bc9a7eb0edf7c46532d6",
    FILES["upgrade_packages.py"]: "db005fec90dce8a3cf26f5b6febdc7b565a6ad46",
}
MANDATORY_WINDOWS_CASE = "test_voice_package_retention.VoicePackageRetentionTests.test_actual_windows_mapped_asset_retains_ownership_until_handle_closes"


class GateError(ValueError):
    pass


def is_windows():
    return os.name == "nt"


def git_sha(data):
    return sha1(("blob " + str(len(data)) + "\0").encode() + data).hexdigest()


def production_hashes(checkout):
    project = Path(checkout) / "dordiai-voices"
    return {name: git_sha((project / name).read_bytes()) for name in BASE}


def stage_candidate(checkout, output):
    checkout, output = Path(checkout).resolve(), Path(output).resolve()
    if output == checkout or output.is_relative_to(checkout) or output.exists():
        raise GateError("Isolation output must be new and outside the checkout")
    project = checkout / "dordiai-voices"
    candidate = project / "experiments/voice-removal-ownership"
    if candidate.is_symlink() or not candidate.is_dir():
        raise GateError("Missing real candidate directory")
    expected_names = set(FILES) | {"candidate.json"}
    if {path.name for path in candidate.iterdir()} != expected_names:
        raise GateError("Unexpected candidate inventory")
    for path in candidate.iterdir():
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 256 * 1024:
            raise GateError("Unsafe candidate file")
    manifest = json.loads((candidate / "candidate.json").read_text(encoding="utf-8"))
    if (not isinstance(manifest, dict) or manifest.get("format") != "dordiai-voice-removal-ownership-overlay"
            or type(manifest.get("format_version")) is not int or manifest["format_version"] != 1
            or not isinstance(manifest.get("files"), list) or len(manifest["files"]) != len(FILES)):
        raise GateError("Invalid candidate manifest")
    payload, seen = {}, set()
    for entry in manifest["files"]:
        if not isinstance(entry, dict):
            raise GateError("Invalid candidate entry")
        source = entry.get("source")
        if source not in FILES or source in seen or entry.get("target") != FILES[source]:
            raise GateError("Unexpected candidate destination")
        seen.add(source)
        data = (candidate / source).read_bytes()
        if sha256(data).hexdigest() != entry.get("sha256") or git_sha(data) != entry.get("git_sha"):
            raise GateError("Candidate hash differs")
        payload[FILES[source]] = data
    before = production_hashes(checkout)
    if before != BASE or (project / FILES["test_voice_package_retention.py"]).exists():
        raise GateError("Production baseline differs; refusing an unreviewed overlay")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir()
    shutil.copytree(project, output / "dordiai-voices", ignore=shutil.ignore_patterns("__pycache__"))
    if (checkout / ".github").is_dir():
        shutil.copytree(checkout / ".github", output / ".github")
    for target, data in payload.items():
        destination = output / "dordiai-voices" / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    return {"baseline_git_sha": before, "overlay": manifest["files"]}


RUNNER = r'''
import json,sys,unittest
from pathlib import Path
suite = unittest.TestLoader().discover("tests", pattern=sys.argv[1])
def cases(value):
    for child in value:
        if isinstance(child, unittest.TestSuite):
            yield from cases(child)
        else:
            yield child.id()
ids = list(cases(suite))
result = unittest.TextTestRunner(verbosity=2).run(suite)
bad = [case.id() for case,_ in result.failures + result.errors]
skipped = [case.id() for case,_ in result.skipped]
Path(sys.argv[2]).write_text(json.dumps({"total":result.testsRun,"success":result.wasSuccessful(),"case_ids":ids,"failed":bad,"skipped":skipped},indent=2)+"\n",encoding="utf-8")
sys.exit(0 if result.wasSuccessful() else 1)
'''


def execute_suite(project, output, label, pattern):
    receipt = output / (label + ".json")
    with (output / (label + ".log")).open("w", encoding="utf-8") as log:
        completed = subprocess.run([sys.executable, "-c", RUNNER, pattern, str(receipt)],
                                   cwd=project, stdout=log, stderr=subprocess.STDOUT, timeout=240)
    if not receipt.is_file():
        raise GateError("Suite did not produce its result: " + label)
    result = json.loads(receipt.read_text(encoding="utf-8"))
    if completed.returncode or not result.get("success"):
        raise GateError("Candidate suite failed: " + label)
    return result


def run_gate(checkout, output, *, require_windows=True):
    checkout, output = Path(checkout).resolve(), Path(output).resolve()
    if require_windows and not is_windows():
        raise GateError("The acceptance gate requires actual Windows")
    if output.exists() or output == checkout or output.is_relative_to(checkout):
        raise GateError("Evidence output must be new and outside the checkout")
    before = production_hashes(checkout)
    output.mkdir(parents=True)
    receipt = {"format": "dordiai-voice-removal-candidate-gate", "success": False,
               "windows": is_windows(), "product_ready": False,
               "actual_nvda_gui_verified": False, "physical_audio_verified": False}
    try:
        receipt["stage"] = stage_candidate(checkout, output / "isolated-root")
        project = output / "isolated-root/dordiai-voices"
        focused = execute_suite(project, output, "focused", "test_voice_package_retention.py")
        receipt["focused"] = focused
        if MANDATORY_WINDOWS_CASE not in focused["case_ids"]:
            raise GateError("Mandatory mapped-file test missing")
        if require_windows and MANDATORY_WINDOWS_CASE in focused["skipped"]:
            raise GateError("Mandatory Windows mapped-file test was skipped")
        if focused["total"] != 21 or len(focused["case_ids"]) != 21:
            raise GateError("The reviewed 21-case fault suite was not executed completely")
        allowed_windows_skip = "test_voice_package_retention.VoicePackageRetentionTests.test_symlink_retained_asset_never_activates_or_deletes_target"
        if require_windows and set(focused["skipped"]) - {allowed_windows_skip}:
            raise GateError("A required recovery or GUI-dispatch case was skipped")
        receipt["full"] = execute_suite(project, output, "full", "test*.py")
        receipt["success"] = True
    except Exception as error:
        receipt["error"] = str(error)
        raise
    finally:
        receipt["checkout_production_unchanged"] = production_hashes(checkout) == before
        if not receipt["checkout_production_unchanged"]:
            receipt["success"] = False
            receipt["error"] = "Checkout production bytes changed"
        (output / "gate.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    if not receipt["success"]:
        raise GateError(receipt["error"])
    return receipt


if __name__ == "__main__":
    result = run_gate(sys.argv[1], sys.argv[2])
    print(json.dumps({"success": result["success"], "focused": result["focused"]["total"],
                      "full": result["full"]["total"], "checkout_production_unchanged": result["checkout_production_unchanged"]}))
