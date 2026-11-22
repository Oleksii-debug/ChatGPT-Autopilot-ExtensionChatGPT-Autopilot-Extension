"""Reconstruct all29 offline MMS resource ZIPs from freshly verified FP32 inputs.

Uses existing acquisition/calibration and generic packaging APIs. No acoustic
weight is changed; OpenVoice conversion/encoder graphs are not copied into packs.
These are newly prepared versioned artifacts, not recovered lost ZIP bytes.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import tempfile

from build_release import ROOT
from build_resource_pack import create_resource_pack
from prepare_mms_models import digest, verified
from prepare_mms_parity_ci import write_json
from prepare_reference_encoder import ENCODERS
from verify_release import verify_archive
import package_manager as manager
from wide_mms import SUPPORTED

PACK_VERSION = "1.0.1"
MINIMUM_CORE_VERSION = "0.13.1-dev.1"
FILES = ("model.onnx", "tokens.txt", "config.json", "source.npy", "NOTICE.txt")
PRIOR_PARITY_RUN = 45009987791


def external_path(path, protected):
    path = Path(path)
    if path.is_symlink():
        raise ValueError("Output cannot be a symlink")
    path = path.resolve()
    if any(path.is_relative_to(Path(root).resolve()) for root in protected):
        raise ValueError("Output must be outside model/runtime/baseline inputs")
    return path


def load_sources(path):
    index = json.loads(Path(path).read_text(encoding="utf-8"))
    if (index.get("format") != "dordiai-mms-sources-v1" or set(index.get("models", {})) != set(SUPPORTED)
            or len(index["models"]) != 29 or index.get("license") != "CC-BY-NC-4.0"):
        raise ValueError("Expected the exact29 native MMS source records and preserved license")
    if any(index["models"][code].get("iso_code") != SUPPORTED[code] for code in SUPPORTED):
        raise ValueError("Native source records must match their exact language standards")
    return index


def prepared_model(code, index, models, proof):
    import numpy as np
    entry = index["models"][code]
    folder = Path(models) / code
    if folder.is_symlink() or not folder.is_dir():
        raise ValueError("Unsafe or absent prepared model directory: " + code)
    for name in FILES:
        path = folder / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("Missing/unsafe prepared model file: " + code + "/" + name)
    for name in ("model.onnx", "tokens.txt"):
        if not verified(folder / name, entry["assets"][name]):
            raise ValueError("Prepared bytes differ from pinned native input: " + code + "/" + name)
    hashes = {name: digest(folder / name) for name in FILES}
    config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
    identity = config.get("source_identity", {})
    if (config.get("format") != "dordiai-mms-onnx-v1" or config.get("backend") != "mms-onnx"
            or config.get("code") != code or config.get("iso_code") != entry["iso_code"]
            or config.get("frontend") != "characters" or config.get("is_uroman")
            or config.get("license") != index["license"] or config.get("sample_rate") != 16000
            or config.get("technical_onnx_inference_verified") is not True
            or config.get("provenance", {}).get("repo_id") != index["repository"]
            or config.get("provenance", {}).get("revision") != index["revision"]
            or config.get("provenance", {}).get("model_sha256") != hashes["model.onnx"]
            or config.get("provenance", {}).get("tokens_sha256") != hashes["tokens.txt"]
            or identity.get("source_sha256") != hashes["source.npy"]
            or identity.get("encoder_sha256") != ENCODERS["fp32"]["sha256"]
            or identity.get("source_shape") != [1, 256, 1] or identity.get("source_dtype") != "float32"):
        raise ValueError("Prepared native configuration/source provenance differs: " + code)
    if (proof.get("status") != "prepared-real-onnx-carrier"
            or proof.get("model_sha256") != hashes["model.onnx"]
            or proof.get("tokens_sha256") != hashes["tokens.txt"]
            or proof.get("source_identity") != identity):
        raise ValueError("Fresh preparation evidence does not bind the packaged inputs: " + code)
    vector = np.load(folder / "source.npy", allow_pickle=False)
    norm = float(np.linalg.norm(vector))
    if (vector.dtype != np.float32 or vector.shape != (1, 256, 1)
            or not np.isfinite(vector).all() or not np.isfinite(norm) or norm < 1e-7):
        raise ValueError("Invalid genuine FP32 source vector: " + code)
    notice = (folder / "NOTICE.txt").read_text(encoding="utf-8")
    if index["repository"] not in notice or index["revision"] not in notice or "by-nc/4.0" not in notice:
        raise ValueError("Missing source attribution/noncommercial notice: " + code)
    return folder, config, hashes


def build_language(code, index, models, output, proof, pack_version=PACK_VERSION):
    folder, config, hashes = prepared_model(code, index, models, proof)
    entry = index["models"][code]
    prefix, identity = "kx47Runtime/models/MMS/" + code, "mms-" + code
    extra = {
        "license": index["license"], "experimental": True,
        "reconstruction": "new fresh preparation and packaging; not recovered original ZIP bytes",
        "native_weight_precision": "original pinned FP32 bytes unchanged",
        "provenance": {"repo_id": index["repository"], "revision": index["revision"],
            "source_project": index["source_project"], "model_sha256": hashes["model.onnx"],
            "tokens_sha256": hashes["tokens.txt"], "config_sha256": hashes["config.json"],
            "source_sha256": hashes["source.npy"], "source_identity": config["source_identity"]},
        "quality_validation": {"fresh_native_cpu_preparation_verified": True,
            "native_pronunciation_verified": False, "navigation_verified": False, "windows_nvda_verified": False},
        "prior_family_numerical_parity_run": PRIOR_PARITY_RUN,
        "prior_family_numerical_parity_url": "https://github.com/Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension/actions/runs/" + str(PRIOR_PARITY_RUN),
        "minimum_core_scope": "stable mms-onnx resource API; not a claim that dev9 or every client build was tested",
    }
    if code == "kab":
        extra.update(catalogue_group=entry.get("selected_id", "tamazight"),
                     partial_variant=True, coverage_scope="Kabyle only; not Standard Moroccan Tamazight")
    # Exactly five runtime/legal files: no probe WAV, reference encoder, conversion
    # model, training data or prepared shared graph is duplicated per language.
    with tempfile.TemporaryDirectory(prefix=".mms-pack-input-", dir=Path(output).parent) as temporary:
        stage = Path(temporary)
        for name in FILES:
            if name == "model.onnx":
                try:
                    os.link(folder / name, stage / name)
                except OSError:
                    shutil.copyfile(folder / name, stage / name)
            else:
                shutil.copyfile(folder / name, stage / name)
        archive = Path(output) / ("dordiai-" + identity + "-" + pack_version + ".zip")
        result = create_resource_pack(stage, archive, prefix=prefix, identity=identity,
            name="MMS — " + entry["name_uk"], version=pack_version,
            minimum_core_version=MINIMUM_CORE_VERSION, languages=[code], engine_ids=["mms-onnx"],
            metadata_extra=extra)
    verified_archive = verify_archive(archive)
    manifest = manager.inspect_pack(archive)
    if set(manifest["files"]) != {prefix + "/" + name for name in FILES}:
        raise ValueError("Unexpected resource package contents")
    for name, expected in hashes.items():
        if manifest["files"][prefix + "/" + name]["sha256"] != expected or digest(folder / name) != expected:
            raise ValueError("Native input changed during packaging: " + code + "/" + name)
    return dict(result, id=identity, code=code, name_uk=entry["name_uk"], version=pack_version,
                minimum_core_version=MINIMUM_CORE_VERSION, license=index["license"],
                model_sha256=hashes["model.onnx"], source_sha256=hashes["source.npy"],
                archive_verification=verified_archive, experimental=True)


def roundtrip(archive, expected_id, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    manifest = directory / "manifest.ini"
    original = ('version = "' + MINIMUM_CORE_VERSION + '"\n').encode()
    manifest.write_bytes(original)
    sentinel = directory / "kx47Runtime/models/Keep/core-sentinel.bin"
    sentinel.parent.mkdir(parents=True, exist_ok=True)
    sentinel.write_bytes(b"keep core")
    metadata = manager.inspect_pack(archive)
    manager.install_pack(archive, directory)
    installed = manager.list_installed_packs(directory)
    if len(installed) != 1 or installed[0]["id"] != expected_id:
        raise ValueError("Resource pack registry round-trip differs")
    for name, record in metadata["files"].items():
        if digest(directory / name) != record["sha256"]:
            raise ValueError("Installed resource bytes differ: " + name)
    manager.uninstall_pack(expected_id, directory)
    if manager.list_installed_packs(directory) or manifest.read_bytes() != original or sentinel.read_bytes() != b"keep core":
        raise ValueError("Resource removal changed core data or registry")
    if any(path.is_file() and path != sentinel for path in (directory / "kx47Runtime/models").rglob("*")):
        raise ValueError("Resource removal left package files")
    return {"installed_files": len(metadata["files"]), "checksums_verified": True,
            "clean_uninstall": True, "core_sentinel_preserved": True,
            "scope": "real local package manager; no Windows/NVDA/acoustic acceptance"}


def build_all(args):
    models = args.models.resolve(strict=True)
    protected = (models, ROOT / "source", ROOT / "packages", ROOT / "model-packs")
    output, report_path = external_path(args.output, protected), external_path(args.report, protected)
    if output.exists() or report_path.exists() or report_path.is_relative_to(output) or output.is_relative_to(report_path):
        raise FileExistsError("Use new separate output/report paths")
    manager._version(args.pack_version)
    index = load_sources(args.index)
    preparation = json.loads(args.preparation_report.read_text(encoding="utf-8"))
    rows = preparation.get("languages", [])
    if (preparation.get("all29_prepared") is not True or preparation.get("status") != "passed"
            or preparation.get("source_index_sha256") != digest(args.index)
            or {row.get("code") for row in rows} != set(index["models"]) or len(rows) != 29
            or any(row.get("status") != "prepared" for row in rows)):
        raise ValueError("All29 fresh serial preparations must pass before publishing any packs")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".mms-packs-", dir=output.parent))
    report = {"format": "dordiai-mms-resource-packs-reconstruction-v1", "status": "running",
        "started_utc": datetime.now(timezone.utc).isoformat(), "pack_version": args.pack_version,
        "minimum_core_version": MINIMUM_CORE_VERSION, "source_index_sha256": digest(args.index),
        "source_revision": index["revision"], "license": index["license"],
        "source_commit": os.environ.get("GITHUB_SHA"), "precision": "unchanged native FP32",
        "published_to_website_or_release": False, "windows_nvda_accepted": False, "packs": []}
    published = False
    try:
        write_json(report_path, report)
        for code in sorted(index["models"]):
            child = args.preparation_logs / (code + "-preparation.json")
            aggregate = next(row for row in rows if row["code"] == code)
            if digest(child) != aggregate["report_sha256"]:
                raise ValueError("Fresh child preparation report changed: " + code)
            child_proof = json.loads(child.read_text(encoding="utf-8"))
            if (child_proof.get("all_selected_prepared") is not True
                    or set(child_proof.get("models", {})) != {code}
                    or child_proof.get("revision") != index["revision"]):
                raise ValueError("Unexpected fresh child preparation report: " + code)
            result = build_language(code, index, models, stage, child_proof["models"][code], args.pack_version)
            with tempfile.TemporaryDirectory(prefix=".mms-roundtrip-", dir=output.parent) as temporary:
                result["roundtrip"] = roundtrip(stage / result["filename"], result["id"], temporary)
            report["packs"].append(result)
            write_json(report_path, report)
            print(json.dumps({"id": result["id"], "bytes": result["size_bytes"], "sha256": result["sha256"]}), flush=True)
        catalogue = {"format": "dordiai-mms-resource-catalogue-v1", "pack_version": args.pack_version,
            "minimum_core_version": MINIMUM_CORE_VERSION, "license": index["license"],
            "experimental": True, "not_pronunciation_or_nvda_acceptance": True, "packs": report["packs"]}
        write_json(stage / "resource-catalog.json", catalogue)
        (stage / "SHA256SUMS").write_text("".join(row["sha256"] + "  " + row["filename"] + "\n" for row in report["packs"]), encoding="ascii")
        if output.exists():
            raise FileExistsError("Output folder appeared during build")
        os.rename(stage, output)
        published = True
        report.update(status="passed", all29_packs_verified=True, output=str(output),
                      package_count=29, download_bytes=sum(row["size_bytes"] for row in report["packs"]),
                      finished_utc=datetime.now(timezone.utc).isoformat())
        write_json(report_path, report)
        return report
    except Exception as error:
        report.update(status="failed", error_type=type(error).__name__, error=str(error),
                      finished_utc=datetime.now(timezone.utc).isoformat())
        write_json(report_path, report)
        raise
    finally:
        if not published:
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--index", type=Path, default=ROOT / "tools/mms_model_sources.json")
    parser.add_argument("--preparation-report", type=Path, required=True)
    parser.add_argument("--preparation-logs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--pack-version", default=PACK_VERSION)
    result = build_all(parser.parse_args())
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
