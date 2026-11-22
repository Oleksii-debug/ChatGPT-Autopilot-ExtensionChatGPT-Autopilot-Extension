"""Small byte fixtures; no network, token, binary model or release mutation."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.request

TOOLS = Path(__file__).resolve().parents[1] / "tools"
spec = importlib.util.spec_from_file_location("draft_core10_backup", TOOLS / "draft_core10_backup.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def release():
    return {"id": 41, "tag_name": m.TAG, "target_commitish": m.STORAGE_ANCHOR,
            "name": m.TITLE, "body": m.BODY, "draft": True, "prerelease": True,
            "published_at": None}


class FakeGitHub:
    def __init__(self, existing=False):
        self.release = release() if existing else None
        self.data = {}
        self.meta = {}
        self.calls = []
        self.tag = None
        self.bad_source = False

    def request(self, method, path, payload=None, missing_ok=False):
        self.calls.append((method, path, payload))
        if path.endswith("/actions/runs/" + str(m.SOURCE_RUN)):
            return {"head_sha": "wrong" if self.bad_source else m.SOURCE_COMMIT,
                    "status": "completed", "conclusion": "success",
                    "path": ".github/workflows/dordiai-banks10.yml"}
        if path.endswith("/actions/artifacts/" + str(m.ARTIFACT_ID)):
            return {"name": m.ARTIFACT_NAME, "expired": False,
                    "digest": "sha256:" + m.ARTIFACT_SHA256,
                    "workflow_run": {"id": m.SOURCE_RUN, "head_sha": m.SOURCE_COMMIT}}
        if path.endswith("/branches/main"):
            return {"commit": {"sha": m.STORAGE_ANCHOR}}
        if "/git/ref/tags/" in path:
            return self.tag
        if path.endswith("/releases") and method == "POST":
            if not payload["draft"] or payload["target_commitish"] != m.STORAGE_ANCHOR:
                raise AssertionError("Unsafe creation")
            self.release = dict(payload, id=41, published_at=None)
            return self.release
        if path.endswith("/releases/41") and method == "GET":
            return self.release
        raise AssertionError((method, path))

    def pages(self, path):
        if path.endswith("/releases"):
            return iter([] if self.release is None else [self.release])
        if path.endswith("/releases/41/assets"):
            return iter(self.meta.values())
        raise AssertionError(path)

    def add_asset(self, name, data):
        asset_id = 100 + len(self.meta)
        self.data[asset_id] = data
        self.meta[name] = {"id": asset_id, "name": name, "size": len(data),
                           "digest": "sha256:" + hashlib.sha256(data).hexdigest(),
                           "state": "uploaded"}
        return self.meta[name]

    def upload(self, release_id, name, stream, size):
        if name in self.meta:
            raise AssertionError("Overwrite attempted")
        data = stream.read()
        if len(data) != size:
            raise AssertionError("Size mismatch")
        self.calls.append(("UPLOAD", name, release_id))
        return self.add_asset(name, data)

    def download_fingerprint(self, asset_id):
        data = self.data[asset_id]
        self.calls.append(("DOWNLOAD", asset_id, None))
        return len(data), hashlib.sha256(data).hexdigest()


class DraftBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = b"small immutable engineering core"
        self.core = self.root / m.CORE_NAME
        self.core.write_bytes(self.payload)
        self.receipt = self.root / "receipt.json"
        identity = dict(m.IDENTITY, core={"name": m.CORE_NAME, "size_bytes": len(self.payload),
                                          "sha256": hashlib.sha256(self.payload).hexdigest()})
        marker = "<!-- dordiai-engineering-backup-v1 -->\n"
        body = (m.BODY.split(marker)[0] + marker
                + json.dumps(identity, sort_keys=True, separators=(",", ":")) + "\n")
        self.patch = mock.patch.multiple(
            m, CORE_SIZE=len(self.payload),
            CORE_SHA256=hashlib.sha256(self.payload).hexdigest(), IDENTITY=identity, BODY=body)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_create_draft_upload_verify_and_idempotent_no_overwrite(self):
        client = FakeGitHub()
        result = m.run(self.core, self.receipt, client)
        self.assertFalse(result["product_ready"])
        self.assertEqual(result["core"]["sha256"], hashlib.sha256(self.payload).hexdigest())
        self.assertEqual(len([c for c in client.calls if c[0] == "UPLOAD"]), 2)
        self.assertEqual(len([c for c in client.calls if c[0] == "DOWNLOAD"]), 2)
        self.assertTrue(client.release["draft"])
        self.assertEqual(client.release["make_latest"], "false")
        self.assertEqual(client.release["target_commitish"], m.STORAGE_ANCHOR)
        self.assertEqual(result["binary_source_commit"], m.SOURCE_COMMIT)
        self.assertNotEqual(result["binary_source_commit"], result["storage_anchor_commit"])
        self.assertEqual(json.loads(self.receipt.read_text(encoding="utf-8")), result)
        writes = len([c for c in client.calls if c[0] in ("POST", "UPLOAD")])
        m.run(self.core, self.receipt, client)
        self.assertEqual(writes, len([c for c in client.calls if c[0] in ("POST", "UPLOAD")]))
        self.assertFalse(any(c[0] in ("PATCH", "DELETE") for c in client.calls))

    def test_corrupt_local_core_never_writes_remote(self):
        self.core.write_bytes(self.payload + b"x")
        client = FakeGitHub()
        with self.assertRaisesRegex(m.BackupError, "SHA-256 mismatch"):
            m.run(self.core, self.receipt, client)
        self.assertEqual(client.calls, [])
        self.assertFalse(self.receipt.exists())

    def test_wrong_source_never_creates_release(self):
        client = FakeGitHub()
        client.bad_source = True
        with self.assertRaisesRegex(m.BackupError, "workflow identity"):
            m.run(self.core, self.receipt, client)
        self.assertFalse(any(c[0] in ("POST", "UPLOAD") for c in client.calls))

    def test_existing_published_or_unowned_draft_is_rejected(self):
        for key, value in (("draft", False), ("published_at", "2026-11-22T00:00:00Z"),
                           ("target_commitish", "main"), ("body", "other release"),
                           ("name", "other"), ("prerelease", False)):
            with self.subTest(key=key):
                client = FakeGitHub(existing=True)
                client.release[key] = value
                with self.assertRaises(m.BackupError):
                    m.run(self.core, self.receipt, client)
                self.assertFalse(any(c[0] in ("POST", "UPLOAD") for c in client.calls))

    def test_wrong_existing_tag_cannot_be_moved(self):
        client = FakeGitHub()
        client.tag = {"object": {"type": "commit", "sha": "f" * 40}}
        with self.assertRaisesRegex(m.BackupError, "different storage-anchor commit"):
            m.run(self.core, self.receipt, client)
        self.assertFalse(any(c[0] in ("POST", "UPLOAD") for c in client.calls))

    def test_changed_main_is_never_moved_or_automatically_retargeted(self):
        client = FakeGitHub()
        original = client.request
        def request(method, path, *args, **kwargs):
            if path.endswith("/branches/main"):
                return {"commit": {"sha": "e" * 40}}
            return original(method, path, *args, **kwargs)
        client.request = request
        with self.assertRaisesRegex(m.BackupError, "no automatic retarget"):
            m.run(self.core, self.receipt, client)
        self.assertIsNone(client.release)
        self.assertFalse(any(c[0] in ("POST", "UPLOAD", "PATCH") for c in client.calls))

    def test_existing_core_sha_mismatch_is_never_overwritten(self):
        client = FakeGitHub(existing=True)
        client.add_asset(m.CORE_NAME, self.payload)
        client.data[client.meta[m.CORE_NAME]["id"]] = b"x" * len(self.payload)
        with self.assertRaisesRegex(m.BackupError, "bytes mismatch"):
            m.run(self.core, self.receipt, client)
        self.assertFalse(any(c[0] == "UPLOAD" for c in client.calls))

    def test_unknown_assets_are_not_silently_adopted(self):
        client = FakeGitHub(existing=True)
        client.add_asset("someone-elses.bin", b"other")
        with self.assertRaisesRegex(m.BackupError, "unknown or duplicate"):
            m.run(self.core, self.receipt, client)
        self.assertFalse(any(c[0] == "UPLOAD" for c in client.calls))

    def test_publish_between_checks_aborts_before_upload(self):
        client = FakeGitHub(existing=True)
        original = client.request
        def request(method, path, *args, **kwargs):
            if path.endswith("/releases/41"):
                client.release["draft"] = False
            return original(method, path, *args, **kwargs)
        client.request = request
        with self.assertRaises(m.BackupError):
            m.run(self.core, self.receipt, client)
        self.assertFalse(any(c[0] == "UPLOAD" for c in client.calls))

    def test_hashing_reads_bounded_chunks(self):
        class Bounded(io.BytesIO):
            def read(self, size=-1):
                if size < 0 or size > m.CHUNK:
                    raise AssertionError("Unbounded read")
                return super().read(size)
        self.assertEqual(m.stream_fingerprint(Bounded(self.payload)),
                         (len(self.payload), hashlib.sha256(self.payload).hexdigest()))

    def test_redirect_strips_token_and_refuses_non_github(self):
        handler = m._GithubOnlyRedirect()
        req = urllib.request.Request("https://api.github.com/repos/owner/repo",
                                     headers={"Authorization": "Bearer secret"})
        for target in ("https://release-assets.githubusercontent.com/file?signature=private",
                       "https://api.github.com/resource"):
            redirected = handler.redirect_request(req, None, 302, "", {}, target)
            self.assertIsNone(redirected.get_header("Authorization"))
        for target in ("https://example.com/file", "http://release-assets.githubusercontent.com/x",
                       "https://githubusercontent.com.evil.test/x",
                       "https://user:pass@api.github.com/x"):
            with self.subTest(target=target), self.assertRaises(m.BackupError):
                handler.redirect_request(req, None, 302, "", {}, target)

    def test_receipt_conflict_and_symlink_are_not_overwritten(self):
        self.receipt.write_bytes(b"existing")
        with self.assertRaisesRegex(m.BackupError, "differs"):
            m.publish_receipt_file(self.receipt, b"new")
        self.assertEqual(self.receipt.read_bytes(), b"existing")
        linked = self.root / "link.json"
        try:
            linked.symlink_to(self.receipt)
        except (OSError, NotImplementedError):
            self.skipTest("Symlink creation unavailable")
        with self.assertRaisesRegex(m.BackupError, "Unsafe"):
            m.publish_receipt_file(linked, b"new")

    def test_workflow_has_explicit_push_gate_and_no_release_publication(self):
        path = TOOLS.parents[1] / ".github" / "workflows" / "dordiai-core10-backup.yml"
        text = path.read_text(encoding="utf-8")
        self.assertIn("[backup-dev10]", text)
        self.assertIn("artifact-ids: 14753953381", text)
        self.assertIn("run-id: 45021069771", text)
        self.assertIn("cancel-in-progress: false", text)
        self.assertIn("contents: write", text)
        self.assertNotIn("gh release publish", text)


if __name__ == "__main__":
    unittest.main()
