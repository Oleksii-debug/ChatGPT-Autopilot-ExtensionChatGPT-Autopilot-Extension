"""Stage pinned core inputs and prepare29 MMS references for isolated CPU parity CI.

Only selected data is copied from an immutable development core. Acquisition uses
the existing checksum-pinned tools. Each language calibration runs in a fresh
serial process; no runtime source, baseline or published archive is modified.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CORE_RUN = 45005894766
CORE_VERSION = "0.13.1-dev.8"
CORE_SHA256 = "568e49547f386b17fc82d1def13257749774eecaf999f4823d74100e47bf7ac6"
PROFILE = "viktoriia"
MEMBERS = {
    "kx47Runtime/models/OpenVoiceV2/encoder-flow.onnx": "OpenVoiceV2/encoder-flow.onnx",
    "kx47Runtime/models/OpenVoiceV2/decoder.onnx": "OpenVoiceV2/decoder.onnx",
    "kx47Runtime/models/voices/viktoriia.npy": "voices/viktoriia.npy",
    "kx47Runtime/models/voices/catalog.json": "voices/catalog.json",
}
RECEIPT = "pinned-core-inputs.json"
TARGET_METADATA = "target-profile.json"


def digest(path):
    result = sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def write_json(path, document):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".writing-" + str(os.getpid()))
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(document, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def file_record(path):
    path = Path(path)
    return {"size_bytes": path.stat().st_size, "sha256": digest(path)}


def validate_profile_ids(catalogue, voice_ids):
    sys.path.insert(0, str(ROOT / "source/0.12.2/kx47Runtime"))
    from voice_policy import require_voice_allowed
    if not isinstance(catalogue, dict) or set(catalogue) != set(voice_ids) or PROFILE not in catalogue:
        raise ValueError("Pinned core retained profile catalogue is inconsistent")
    for profile in catalogue:
        require_voice_allowed(profile)


def stage_core(addon, output):
    addon, output = Path(addon).resolve(strict=True), Path(output).resolve()
    if any(output.is_relative_to(ROOT / protected) for protected in ("source", "packages")):
        raise ValueError("Core input cache must be outside source and recovered baseline")
    if digest(addon) != CORE_SHA256:
        raise ValueError("Downloaded development core differs from the immutable dev8 pin")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Fresh core input destination must be empty; cache hits use verify-core")
    with zipfile.ZipFile(addon) as archive:
        names = archive.namelist()
        if len(names) != len(set(name.casefold() for name in names)):
            raise ValueError("Ambiguous duplicate core archive members")
        manifest_info = archive.getinfo("dordiai-release.json")
        if manifest_info.file_size > 8 * 1024 * 1024:
            raise ValueError("Oversized core inventory")
        manifest = json.loads(archive.read(manifest_info))
        if (manifest.get("format") != "dordiai-core-release" or manifest.get("format_version") != 1
                or manifest.get("version") != CORE_VERSION):
            raise ValueError("Wrong immutable core version/inventory format")
        files = manifest["files"]
        records = {}
        for name, relative in MEMBERS.items():
            expected, info = files[name], archive.getinfo(name)
            if (info.is_dir() or info.file_size != expected["size_bytes"]
                    or info.file_size > 512 * 1024 * 1024):
                raise ValueError("Unexpected selected core input size")
            target = output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            value = sha256()
            with archive.open(info) as source, target.open("xb") as destination:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    value.update(block)
                    destination.write(block)
            if value.hexdigest() != expected["sha256"]:
                raise ValueError("Selected core input differs from the internal release inventory")
            records[relative] = dict(expected)
        catalogue = json.loads((output / "voices/catalog.json").read_text(encoding="utf-8"))
        validate_profile_ids(catalogue, manifest["voice_ids"])
    metadata = {
        "profile_id": PROFILE, "embedding_sha256": records["voices/viktoriia.npy"]["sha256"],
        "acoustic_speaker_identity_verified": False,
        "provenance": {"source": "retained profile asset from checksum-pinned development core",
                       "core_run": CORE_RUN, "core_version": CORE_VERSION, "core_sha256": CORE_SHA256,
                       "catalogue_member": "kx47Runtime/models/voices/catalog.json",
                       "catalogue_entry": catalogue[PROFILE],
                       "limit": "Release profile association and exact bytes; not biometric speaker identity proof"},
    }
    write_json(output / TARGET_METADATA, metadata)
    records[TARGET_METADATA] = file_record(output / TARGET_METADATA)
    receipt = {
        "format": "dordiai-mms-parity-core-input-cache-v1", "status": "verified",
        "core_run": CORE_RUN, "core_version": CORE_VERSION, "core_sha256": CORE_SHA256,
        "files": records, "retained_profile": PROFILE,
        "scope": "Selected data copies only; original core archive unchanged and no Windows executable is extracted.",
        "cache_trust": "Receipt was derived from the verified immutable archive; reuse assumes a trusted branch-owned Actions cache.",
    }
    write_json(output / RECEIPT, receipt)
    return receipt


def verify_core(output):
    output = Path(output).resolve(strict=True)
    receipt_path = output / RECEIPT
    if receipt_path.is_symlink() or receipt_path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Unsafe or oversized core cache receipt")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if (receipt.get("format") != "dordiai-mms-parity-core-input-cache-v1"
            or receipt.get("core_run") != CORE_RUN or receipt.get("core_version") != CORE_VERSION
            or receipt.get("core_sha256") != CORE_SHA256
            or set(receipt.get("files", {})) != set(MEMBERS.values()) | {TARGET_METADATA}):
        raise ValueError("Core cache receipt does not match this exact pinned recipe")
    for relative, expected in receipt["files"].items():
        path = output / relative
        if path.is_symlink() or not path.resolve(strict=True).is_relative_to(output) or file_record(path) != expected:
            raise ValueError("Cached selected core input differs: " + relative)
    catalogue = json.loads((output / "voices/catalog.json").read_text(encoding="utf-8"))
    validate_profile_ids(catalogue, catalogue)
    metadata = json.loads((output / TARGET_METADATA).read_text(encoding="utf-8"))
    if (metadata.get("profile_id") != PROFILE
            or metadata.get("embedding_sha256") != receipt["files"]["voices/viktoriia.npy"]["sha256"]):
        raise ValueError("Cached target metadata no longer binds the retained profile bytes")
    return receipt


def prepare_all(args):
    index_path = ROOT / "tools/mms_model_sources.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if index.get("format") != "dordiai-mms-sources-v1" or len(index["models"]) != 29:
        raise ValueError("This recipe expects the exact audited29-model source index")
    logs = args.logs.resolve()
    logs.mkdir(parents=True, exist_ok=True)
    report = {"format": "dordiai-mms-parity-fresh-preparation-v1", "status": "running",
              "started_utc": datetime.now(timezone.utc).isoformat(),
              "scope": "New actual source-reference measurements, not recovered earlier raw results.",
              "source_index_sha256": digest(index_path), "source_revision": index["revision"],
              "fresh_serial_process_per_language": True, "native_calibration_shared_graph_enabled": False,
              "model_downloads_allowed": False, "onnxruntime_required": "1.27.0", "languages": []}
    write_json(args.report, report)
    environment = os.environ | {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "DO_NOT_TRACK": "1",
                                "DORDIAI_MMS_SHARED_GRAPH": "0", "PYTHONUNBUFFERED": "1"}
    for code in sorted(index["models"]):
        child_report = logs / (code + "-preparation.json")
        child_log = logs / (code + "-preparation.log")
        command = [sys.executable, str(ROOT / "tools/prepare_mms_models.py"), "--offline-verify",
                   "--languages", code, "--index", str(index_path), "--output", str(args.models.resolve()),
                   "--reference-encoder", str(args.reference_encoder.resolve()),
                   "--audio-evidence", str(args.audio_evidence.resolve()), "--report", str(child_report),
                   "--workers", "1", "--require-ort-version", "1.27.0"]
        row = {"code": code, "status": "failed", "log": str(child_log), "report": str(child_report)}
        try:
            with child_log.open("x", encoding="utf-8") as stream:
                completed = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT,
                                           env=environment, timeout=args.timeout_seconds, check=False)
            row["returncode"] = completed.returncode
            if child_report.is_file():
                document = json.loads(child_report.read_text(encoding="utf-8"))
                row["report_sha256"] = digest(child_report)
                result = document.get("models", {}).get(code, {})
                row["prepared_source_identity"] = result.get("source_identity")
                row["error"] = result.get("error")
                if completed.returncode == 0 and document.get("all_selected_prepared") is True:
                    row["status"] = "prepared"
        except Exception as error:
            row["error"] = type(error).__name__ + ": " + str(error)
        report["languages"].append(row)
        write_json(args.report, report)
        print(json.dumps({"code": code, "status": row["status"], "error": row.get("error")}), flush=True)
    report["all29_prepared"] = len(report["languages"]) == 29 and all(row["status"] == "prepared" for row in report["languages"])
    report["status"] = "passed" if report["all29_prepared"] else "failed"
    report["finished_utc"] = datetime.now(timezone.utc).isoformat()
    write_json(args.report, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    stage = commands.add_parser("stage-core")
    stage.add_argument("--addon", type=Path, required=True)
    stage.add_argument("--output", type=Path, required=True)
    stage.add_argument("--report", type=Path, required=True)
    verify = commands.add_parser("verify-core")
    verify.add_argument("--output", type=Path, required=True)
    verify.add_argument("--report", type=Path, required=True)
    prepare = commands.add_parser("prepare-all")
    prepare.add_argument("--models", type=Path, required=True)
    prepare.add_argument("--reference-encoder", type=Path, required=True)
    prepare.add_argument("--audio-evidence", type=Path, required=True)
    prepare.add_argument("--report", type=Path, required=True)
    prepare.add_argument("--logs", type=Path, required=True)
    prepare.add_argument("--timeout-seconds", type=int, default=90)
    args = parser.parse_args()
    try:
        if args.mode == "prepare-all":
            result = prepare_all(args)
        elif args.mode == "stage-core":
            result = stage_core(args.addon, args.output)
            write_json(args.report, result)
        else:
            result = verify_core(args.output)
            write_json(args.report, result)
        print(json.dumps({"phase": args.mode, "status": result["status"]}), flush=True)
        return 0 if result["status"] in {"verified", "passed"} else 1
    except Exception as error:
        write_json(args.report, {"phase": args.mode, "status": "failed",
                                 "error_type": type(error).__name__, "error": str(error)})
        raise


if __name__ == "__main__":
    raise SystemExit(main())
