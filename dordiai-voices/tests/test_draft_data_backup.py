"""Synthetic data-only fixtures; these tests never generate or judge speech."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import draft_core_backup as common
import draft_data_backup as data
import prepared_bank_overlay as banks


def digest(raw):
    return {"size_bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def fixture(root, *, wrong_bank_hash=False, extra=False):
    version = "0.13.1-banks.1"
    source_core = {"filename": "dordiai-voices-0.13.1-dev.8.nvda-addon",
                   "size_bytes": 100, "sha256": "c" * 64}
    profiles = ["voice_%02d" % i for i in range(45)]
    payloads = {name: (b"{}" if name.endswith(".json") else b"\1\0\2\0")
                for name in banks._bank_paths(profiles)}
    manifest = {"format": banks.FORMAT, "format_version": 1, "version": version,
                "source_core": source_core, "catalogue_sha256": "d" * 64,
                "voice_ids": profiles, "excluded_voice_ids": sorted(banks.EXCLUDED),
                "quality_validation": dict(banks.PENDING_QUALITY),
                "files": {name: {"old": None, "new": digest(raw), "added_keys": 0}
                          for name, raw in payloads.items()}}
    if wrong_bank_hash:
        manifest["files"][sorted(payloads)[0]]["new"]["sha256"] = "0" * 64
    raw_manifest = common.canonical_json(manifest)
    path = root / ("dordiai-supplementary-banks-" + version + ".zip")
    with zipfile.ZipFile(path, "w") as archive:
        for name, raw in payloads.items():
            archive.writestr(name, raw)
        archive.writestr(banks.MANIFEST, raw_manifest)
        if extra:
            archive.writestr("run.py", b"raise RuntimeError('must never execute')")
    spec = {"format": "dordiai-data-backup-identity", "format_version": 1,
            "repository": common.REPOSITORY, "kind": "prepared-bank-overlay",
            "version": version, "storage_anchor_commit": common.STORAGE_ANCHOR,
            "binary_source_commit": "a" * 40,
            "source_workflow": ".github/workflows/dordiai-supplementary-banks.yml",
            "source_run_id": 123, "source_artifact": {
                "id": 456, "name": "supplementary-bank-overlay-" + version,
                "wrapper_sha256": "b" * 64},
            "archive": dict(digest(path.read_bytes()), filename=path.name),
            "manifest": dict(digest(raw_manifest), filename=banks.MANIFEST),
            "source_core": source_core, "catalogue_sha256": "d" * 64,
            "product_ready": False, "quality_validation": dict(banks.PENDING_QUALITY)}
    identity = root / "identity.json"
    identity.write_bytes(common.canonical_json(spec))
    return identity, path, spec


class Fake:
    def __init__(self, spec):
        self.spec = spec
        self.release = None
        self.assets = {}
        self.calls = []
        self.failed_source = False

    def request(self, method, path, payload=None, missing_ok=False):
        self.calls.append((method, path))
        if "/actions/runs/" in path:
            return {"head_sha": self.spec["binary_source_commit"], "status": "completed",
                    "conclusion": "failure" if self.failed_source else "success",
                    "path": self.spec["source_workflow"]}
        if "/actions/artifacts/" in path:
            return {"name": self.spec["source_artifact"]["name"], "expired": False,
                    "digest": "sha256:" + self.spec["source_artifact"]["wrapper_sha256"],
                    "workflow_run": {"id": self.spec["source_run_id"],
                                     "head_sha": self.spec["binary_source_commit"]}}
        if "/git/ref/tags/" in path:
            return None
        if path.endswith("/branches/main"):
            return {"commit": {"sha": common.STORAGE_ANCHOR}}
        if path.endswith("/releases") and method == "POST":
            self.release = dict(payload, id=71, published_at=None)
            return self.release
        if path.endswith("/releases/71"):
            return self.release
        raise AssertionError((method, path))

    def pages(self, path):
        if path.endswith("/releases"):
            return iter([] if self.release is None else [self.release])
        if path.endswith("/assets"):
            return iter(a[0] for a in self.assets.values())
        raise AssertionError(path)

    def upload(self, release_id, name, stream, size):
        if name in self.assets:
            raise AssertionError("Attempted asset overwrite")
        raw = stream.read()
        if len(raw) != size:
            raise AssertionError("Wrong upload size")
        asset = {"id": 100 + len(self.assets), "name": name, "size": size,
                 "state": "uploaded", "digest": "sha256:" + hashlib.sha256(raw).hexdigest()}
        self.assets[name] = (asset, raw)
        self.calls.append(("UPLOAD", name))
        return asset

    def download_fingerprint(self, asset_id):
        for asset, raw in self.assets.values():
            if asset["id"] == asset_id:
                self.calls.append(("DOWNLOAD", asset["name"]))
                return len(raw), hashlib.sha256(raw).hexdigest()
        raise AssertionError(asset_id)


class DataBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_all180_payloads_draft_upload_readback_and_idempotence(self):
        identity, path, spec = fixture(self.root)
        client = Fake(spec)
        output = self.root / "receipt.json"
        result = data.run(identity, self.root, output, client)
        self.assertEqual(result["structural_validation"]["bank_file_count"], 180)
        self.assertEqual(result["structural_validation"]["voice_count"], 45)
        self.assertFalse(result["product_ready"])
        self.assertEqual(result["identity"]["quality_validation"], banks.PENDING_QUALITY)
        self.assertNotEqual(result["identity"]["binary_source_commit"],
                            result["identity"]["storage_anchor_commit"])
        self.assertEqual(len([c for c in client.calls if c[0] == "DOWNLOAD"]), 2)
        uploads = len([c for c in client.calls if c[0] == "UPLOAD"])
        data.run(identity, self.root, output, client)
        self.assertEqual(uploads, len([c for c in client.calls if c[0] == "UPLOAD"]))
        self.assertFalse(any(c[0] in ("PATCH", "DELETE") for c in client.calls))

    def test_corrupt_outer_archive_rejected_before_api(self):
        identity, path, spec = fixture(self.root)
        with path.open("ab") as stream:
            stream.write(b"x")
        client = Fake(spec)
        with self.assertRaisesRegex(common.BackupError, "SHA-256 mismatch"):
            data.run(identity, self.root, self.root / "receipt.json", client)
        self.assertEqual(client.calls, [])

    def test_each_new_member_hash_checked_even_when_outer_hash_matches(self):
        identity, path, spec = fixture(self.root, wrong_bank_hash=True)
        client = Fake(spec)
        with self.assertRaisesRegex(common.BackupError, "SHA-256 mismatch"):
            data.run(identity, self.root, self.root / "receipt.json", client)
        self.assertEqual(client.calls, [])

    def test_extra_executable_is_not_backed_up_or_executed(self):
        identity, path, spec = fixture(self.root, extra=True)
        client = Fake(spec)
        with self.assertRaisesRegex(common.BackupError, "identity differs"):
            data.run(identity, self.root, self.root / "receipt.json", client)
        self.assertEqual(client.calls, [])

    def test_failed_generation_cannot_create_draft(self):
        identity, path, spec = fixture(self.root)
        client = Fake(spec)
        client.failed_source = True
        with self.assertRaisesRegex(common.BackupError, "did not complete"):
            data.run(identity, self.root, self.root / "receipt.json", client)
        self.assertFalse(any(c[0] in ("POST", "UPLOAD") for c in client.calls))

    def test_published_or_wrong_ownership_release_rejected(self):
        identity, path, spec = fixture(self.root)
        for changed in ({"draft": False}, {"body": "not owned"},
                        {"target_commitish": spec["binary_source_commit"]}):
            with self.subTest(changed=changed):
                client = Fake(spec)
                client.release = {"id": 71, "tag_name": data.tag(spec),
                                  "name": data.title(spec), "body": data.body(spec),
                                  "draft": True, "prerelease": True, "published_at": None,
                                  "target_commitish": common.STORAGE_ANCHOR}
                client.release.update(changed)
                with self.assertRaises(common.BackupError):
                    data.run(identity, self.root, self.root / "receipt.json", client)
                self.assertFalse(any(c[0] == "UPLOAD" for c in client.calls))

    def test_spec_cannot_assert_product_ready_or_change_owner(self):
        identity, path, spec = fixture(self.root)
        for key, value in (("product_ready", True), ("repository", "someone/else"),
                           ("storage_anchor_commit", "f" * 40),
                           ("quality_validation", {"pronunciation": "pass"})):
            with self.subTest(key=key), self.assertRaises(common.BackupError):
                data.validate_spec(dict(spec, **{key: value}))

    def test_client_requires_exact_safe_owned_asset_names(self):
        client = common.GitHub("not-a-real-token", asset_names=("overlay.zip", "receipt.json"))
        self.assertEqual(client.asset_names, frozenset({"overlay.zip", "receipt.json"}))
        default = common.GitHub("not-a-real-token")
        self.assertEqual(default.asset_names, frozenset({common.CORE_NAME, common.RECEIPT_NAME}))
        for names in (("../evil.zip", "receipt.json"), ("same.zip", "same.zip"),
                      ("one.zip",), ("has space.zip", "receipt.json"), ([], "receipt.json")):
            with self.subTest(names=names), self.assertRaises(common.BackupError):
                common.GitHub("not-a-real-token", asset_names=names)


if __name__ == "__main__":
    unittest.main()
