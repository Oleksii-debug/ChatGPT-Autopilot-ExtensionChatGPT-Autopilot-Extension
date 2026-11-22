#!/usr/bin/env python3
"""Backup one Git-pinned generated data overlay to an owned unpublished draft.

The identity JSON must be reviewed and committed after generation. This helper
preserves bytes; it does not certify pronunciation or physical audio.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import zipfile

import draft_core_backup as common
import prepared_bank_overlay as banks

RECEIPT = "dordiai-prepared-banks-backup-receipt.json"
FIELDS = {"format", "format_version", "repository", "kind", "version",
          "storage_anchor_commit", "binary_source_commit", "source_workflow",
          "source_run_id", "source_artifact", "archive", "manifest", "source_core",
          "catalogue_sha256", "product_ready", "quality_validation"}


def record(value, *, filename=True, maximum=2**31 - 1):
    keys = {"filename", "size_bytes", "sha256"} if filename else {"size_bytes", "sha256"}
    if (not isinstance(value, dict) or set(value) != keys
            or type(value.get("size_bytes")) is not int
            or not 0 < value["size_bytes"] <= maximum
            or not isinstance(value.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", value["sha256"])):
        raise common.BackupError("Invalid pinned data record")
    if filename and (not isinstance(value.get("filename"), str)
                     or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,149}", value["filename"])):
        raise common.BackupError("Unsafe pinned data filename")
    return value


def validate_spec(spec):
    if (not isinstance(spec, dict) or set(spec) != FIELDS
            or spec["format"] != "dordiai-data-backup-identity" or spec["format_version"] != 1
            or spec["repository"] != common.REPOSITORY or spec["kind"] != "prepared-bank-overlay"
            or spec["storage_anchor_commit"] != common.STORAGE_ANCHOR
            or not isinstance(spec["binary_source_commit"], str)
            or not re.fullmatch(r"[0-9a-f]{40}", spec["binary_source_commit"])
            or spec["source_workflow"] != ".github/workflows/dordiai-supplementary-banks.yml"
            or type(spec["source_run_id"]) is not int or spec["source_run_id"] <= 0
            or spec["product_ready"] is not False
            or spec["quality_validation"] != banks.PENDING_QUALITY
            or not isinstance(spec["version"], str)
            or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9.-]+", spec["version"])
            or not isinstance(spec["catalogue_sha256"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", spec["catalogue_sha256"])):
        raise common.BackupError("Invalid owned overlay backup identity")
    archive = record(spec["archive"])
    if archive["filename"] != "dordiai-supplementary-banks-" + spec["version"] + ".zip":
        raise common.BackupError("Archive name differs from the pinned overlay version")
    manifest = record(spec["manifest"], maximum=banks.MAX_MANIFEST)
    if manifest["filename"] != banks.MANIFEST:
        raise common.BackupError("Wrong pinned overlay manifest")
    record(spec["source_core"], maximum=8 * 1024**3)
    artifact = spec["source_artifact"]
    if (not isinstance(artifact, dict) or set(artifact) != {"id", "name", "wrapper_sha256"}
            or type(artifact["id"]) is not int or artifact["id"] <= 0
            or artifact["name"] != "supplementary-bank-overlay-" + spec["version"]
            or not isinstance(artifact["wrapper_sha256"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", artifact["wrapper_sha256"])):
        raise common.BackupError("Invalid pinned source artifact")
    return spec


def read_identity(path):
    return validate_spec(banks._json(Path(path).read_bytes()))


def tag(spec):
    return "dordiai-voices-banks-" + spec["version"] + "-engineering-backup"


def title(spec):
    return "Dordiai prepared banks " + spec["version"] + " engineering backup (unpublished)"


def body(spec):
    return ("Owned data-only engineering backup. Keep DRAFT; do not publish or replace assets. "
            "Pronunciation, NVDA and physical audio remain pending.\n\n"
            "<!-- dordiai-data-backup-v1 -->\n"
            + json.dumps(spec, sort_keys=True, separators=(",", ":")) + "\n")


def owned_release(release, spec):
    expected = {"tag_name": tag(spec), "target_commitish": spec["storage_anchor_commit"],
                "name": title(spec), "body": body(spec), "draft": True, "prerelease": True}
    if (any(release.get(k) != v for k, v in expected.items())
            or release.get("published_at") is not None
            or type(release.get("id")) is not int or release["id"] <= 0):
        raise common.BackupError("Existing overlay release is not the exact owned unpublished draft")
    return release


def verify_source(client, spec):
    run = client.request("GET", common.api_path("/actions/runs/" + str(spec["source_run_id"])))
    if (run.get("head_sha") != spec["binary_source_commit"] or run.get("status") != "completed"
            or run.get("conclusion") != "success" or run.get("path") != spec["source_workflow"]):
        raise common.BackupError("Overlay generation run did not complete successfully at its pin")
    expected = spec["source_artifact"]
    actual = client.request("GET", common.api_path("/actions/artifacts/" + str(expected["id"])))
    if (actual.get("name") != expected["name"] or actual.get("expired") is not False
            or actual.get("digest") != "sha256:" + expected["wrapper_sha256"]
            or actual.get("workflow_run", {}).get("id") != spec["source_run_id"]
            or actual.get("workflow_run", {}).get("head_sha") != spec["binary_source_commit"]):
        raise common.BackupError("Overlay source artifact identity differs or expired")


def validate_overlay(stream, spec):
    common.verify_stream(stream, spec["archive"]["size_bytes"], spec["archive"]["sha256"])
    stream.seek(0)
    with zipfile.ZipFile(stream) as archive:
        infos = banks._zip_files(archive)
        manifest_raw = banks._read(archive, infos, banks.MANIFEST, banks.MAX_MANIFEST)
        if banks._record(manifest_raw) != {
                "size_bytes": spec["manifest"]["size_bytes"], "sha256": spec["manifest"]["sha256"]}:
            raise common.BackupError("Pinned overlay manifest bytes differ")
        manifest = banks._json(manifest_raw)
        if not isinstance(manifest, dict):
            raise common.BackupError("Overlay manifest must be a JSON object")
        profiles = banks._profiles(manifest.get("voice_ids"))
        paths = banks._bank_paths(profiles)
        if (set(infos) != paths | {banks.MANIFEST}
                or manifest.get("format") != banks.FORMAT or manifest.get("format_version") != 1
                or manifest.get("version") != spec["version"]
                or manifest.get("source_core") != spec["source_core"]
                or manifest.get("catalogue_sha256") != spec["catalogue_sha256"]
                or manifest.get("excluded_voice_ids") != sorted(banks.EXCLUDED)
                or manifest.get("quality_validation") != banks.PENDING_QUALITY
                or not isinstance(manifest.get("files"), dict) or set(manifest["files"]) != paths):
            raise common.BackupError("Overlay data/catalogue/source identity differs")
        total = 0
        for name in sorted(paths):
            entry = manifest["files"][name]
            new = entry.get("new") if isinstance(entry, dict) else None
            if not banks._valid_record(new) or infos[name].file_size != new["size_bytes"]:
                raise common.BackupError("Overlay bank payload metadata differs")
            total += new["size_bytes"]
            if total > banks.MAX_RAW:
                raise common.BackupError("Overlay raw banks exceed the1GiB validation limit")
            with archive.open(infos[name]) as member:
                common.verify_stream(member, new["size_bytes"], new["sha256"])
        return {"voice_count": len(profiles), "bank_file_count": len(paths),
                "bank_size_bytes": total, "manifest_sha256": spec["manifest"]["sha256"],
                "scope": "Stored new bank bytes/structure only; not independent audio acceptance"}


def find_or_create(client, spec):
    reference = client.request("GET", common.api_path("/git/ref/tags/" + tag(spec)), missing_ok=True)
    if reference is not None:
        # This helper only ever owns lightweight storage tags, never adopt an ambiguous target.
        obj = reference.get("object", {})
        if obj.get("type") != "commit" or obj.get("sha") != spec["storage_anchor_commit"]:
            raise common.BackupError("Existing overlay storage tag targets another commit")
    matches = [r for r in client.pages(common.api_path("/releases")) if r.get("tag_name") == tag(spec)]
    if len(matches) > 1:
        raise common.BackupError("Ambiguous overlay draft identity")
    if matches:
        return owned_release(matches[0], spec)
    anchor = client.request("GET", common.api_path("/branches/main"))
    if anchor.get("commit", {}).get("sha") != spec["storage_anchor_commit"]:
        raise common.BackupError("Pinned storage anchor changed; no automatic retarget")
    return owned_release(client.request("POST", common.api_path("/releases"), {
        "tag_name": tag(spec), "target_commitish": spec["storage_anchor_commit"],
        "name": title(spec), "body": body(spec), "draft": True, "prerelease": True,
        "make_latest": "false", "generate_release_notes": False,
    }), spec)


def ensure_asset(client, release, spec, name, stream, size, sha256):
    for attempt in range(2):
        owned_release(client.request("GET", common.api_path("/releases/" + str(release["id"]))), spec)
        rows = list(client.pages(common.api_path("/releases/" + str(release["id"]) + "/assets")))
        allowed = {spec["archive"]["filename"], RECEIPT}
        if (any(a.get("name") not in allowed for a in rows)
                or len({a["name"] for a in rows}) != len(rows)):
            raise common.BackupError("Unknown or duplicate overlay backup asset")
        existing = {a["name"]: a for a in rows}
        if name in existing:
            common.verify_asset(client, existing[name], size, sha256)
            return existing[name]
        if attempt:
            raise common.BackupError("Uploaded overlay asset is not visible; no replacement attempted")
        stream.seek(0)
        uploaded = client.upload(release["id"], name, stream, size)
        if uploaded.get("name") != name:
            raise common.BackupError("Uploaded overlay asset identity differs")
    raise AssertionError("Unreachable")

def run(identity_path, input_directory, receipt_path, client=None):
    spec = read_identity(identity_path)
    path = Path(input_directory) / spec["archive"]["filename"]
    if path.is_symlink() or not path.is_file():
        raise common.BackupError("Expected one regular pinned overlay ZIP")
    if client is None:
        client = common.GitHub(os.environ.get("GITHUB_TOKEN", ""),
                               asset_names=(spec["archive"]["filename"], RECEIPT))
    with path.open("rb") as stream:
        structural = validate_overlay(stream, spec)
        verify_source(client, spec)
        release = find_or_create(client, spec)
        actual = ensure_asset(client, release, spec, path.name, stream,
                              spec["archive"]["size_bytes"], spec["archive"]["sha256"])
        receipt = {"format": "dordiai-data-backup-receipt", "format_version": 1,
                   "identity": spec, "release_id": release["id"], "release_draft": True,
                   "asset_id": actual["id"], "binary_download_sha256_verified": True,
                   "structural_validation": structural, "product_ready": False}
        payload = common.canonical_json(receipt)
        ensure_asset(client, release, spec, RECEIPT, io.BytesIO(payload),
                     len(payload), hashlib.sha256(payload).hexdigest())
        owned_release(client.request("GET", common.api_path("/releases/" + str(release["id"]))), spec)
        common.publish_receipt_file(receipt_path, payload)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--identity", required=True, type=Path)
    parser.add_argument("--input-directory", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = run(args.identity, args.input_directory, args.receipt)
    except (common.BackupError, banks.OverlayError, OSError, ValueError, zipfile.BadZipFile) as exc:
        print("Overlay backup failed: " + (str(exc) if isinstance(exc, common.BackupError)
                                          else type(exc).__name__))
        return 1
    print(json.dumps({"draft_release_id": result["release_id"],
                      "archive_sha256": result["identity"]["archive"]["sha256"],
                      "product_ready": False}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
