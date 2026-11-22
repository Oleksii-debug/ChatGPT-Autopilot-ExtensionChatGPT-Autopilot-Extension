"""Small synthetic ZIP/HTTP fixtures only: no real model, pickle load or network."""
from argparse import Namespace
import builtins
from hashlib import sha256
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mni_official_audit", ROOT / "tools/research/acquire_mni_official.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MNIAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.archive = self.root / "native-source.zip"
        self.report = self.root / "metadata.json"

    def fixture(self, extra=None, missing=None):
        files = {
            "mni/fastpitch/best_model.pth": b"opaque-synthetic-checkpoint-never-deserialized",
            "mni/fastpitch/config.json": json.dumps({"model": "forward_tts",
                "characters": {"characters": "অআইঈউএঐওকখগ"}, "num_speakers": 1}).encode("utf-8"),
            "mni/hifigan/best_model.pth": b"opaque-synthetic-vocoder",
            "mni/hifigan/config.json": b'{"model":"hifigan","audio":{"sample_rate":22050}}',
        }
        if extra:
            files.update(extra)
        if missing:
            files.pop(missing)
        with zipfile.ZipFile(self.archive, "w") as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        return files

    def asset(self):
        return {"id": m.ASSET_ID, "name": "mni.zip", "size": m.ASSET_BYTES,
                "created_at": m.ASSET_CREATED, "updated_at": m.ASSET_UPDATED,
                "browser_download_url": m.DOWNLOAD_URL, "state": "uploaded", "digest": None}

    def test_opaque_weights_hashed_without_importing_torch_or_pickle(self):
        original = self.fixture()
        importer = builtins.__import__
        def guarded(name, *args, **kwargs):
            if name.split(".")[0] in {"torch", "pickle"}:
                self.fail("Checkpoint deserializer imported")
            return importer(name, *args, **kwargs)
        with mock.patch("builtins.__import__", guarded):
            result = m.inspect_archive(self.archive)
        self.assertTrue(result["layout_verified"])
        self.assertFalse(result["weights_deserialized"])
        self.assertFalse(result["archive_code_executed"])
        self.assertFalse(result["native_inference_verified"])
        self.assertEqual(result["files"]["mni/fastpitch/best_model.pth"]["sha256"],
                         sha256(original["mni/fastpitch/best_model.pth"]).hexdigest())
        self.assertIn("অ", result["configs"]["mni/fastpitch/config.json"]["characters"]["characters"])
        self.assertFalse(result["checkpoint_licence_document_present"])

    def test_checkpoint_license_text_is_recorded_without_inventing_one(self):
        self.fixture({"mni/LICENSE-model.txt": "Synthetic fixture licence only".encode()})
        result = m.inspect_archive(self.archive)
        self.assertEqual(result["licence_documents"]["mni/LICENSE-model.txt"], "Synthetic fixture licence only")

    def test_missing_native_pairs_preserve_inventory_and_remain_unverified(self):
        self.fixture(missing="mni/hifigan/best_model.pth")
        result = m.inspect_archive(self.archive)
        self.assertFalse(result["layout_verified"])
        self.assertEqual(result["missing_expected_files"], ["mni/hifigan/best_model.pth"])
        self.assertIn("mni/fastpitch/best_model.pth", result["files"])

    def test_raw_path_aliases_traversal_and_encryption_rejected(self):
        for name in ("../fastpitch/config.json", "/mni/model", "mni//model",
                     "./mni/model", "mni\\model", "mni/file:stream"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                m.member_name(zipfile.ZipInfo(name))
        info = zipfile.ZipInfo("mni/config.json")
        info.flag_bits = 1
        with self.assertRaises(ValueError):
            m.member_name(info)

    def test_symlink_member_and_case_collision_rejected(self):
        linked = zipfile.ZipInfo("mni/link")
        linked.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(ValueError):
            m.member_name(linked)
        self.fixture({"MNI/FASTPITCH/config.json": b"{}"})
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            m.inspect_archive(self.archive)

    def test_duplicate_json_keys_and_oversized_metadata_rejected(self):
        self.fixture({"mni/fastpitch/config.json": b'{"model":"one","model":"two"}'})
        with self.assertRaisesRegex(ValueError, "Duplicate source JSON"):
            m.inspect_archive(self.archive)
        self.fixture({"mni/README": b"x" * (m.MAX_METADATA + 1)})
        with self.assertRaisesRegex(ValueError, "Oversized"):
            m.inspect_archive(self.archive)

    def test_exact_asset_timestamp_size_state_and_digest_guards(self):
        actual = self.asset()
        self.assertIsNone(m.asset_identity(actual)["published_digest"])
        for key, value in (("id", 1), ("size", 1), ("updated_at", "changed"), ("state", "starter")):
            wrong = dict(actual)
            wrong[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                m.asset_identity(wrong)
        wrong = dict(actual, digest="unknown:hash")
        with self.assertRaisesRegex(ValueError, "digest"):
            m.asset_identity(wrong)

    def test_new_outputs_cannot_alias_each_other_or_project_inputs(self):
        with self.assertRaisesRegex(ValueError, "overlap"):
            m.safe_outputs(self.archive, self.archive)
        with self.assertRaisesRegex(ValueError, "overlap"):
            m.safe_outputs(self.archive, self.archive / "inside.json")
        with self.assertRaisesRegex(ValueError, "protected"):
            m.safe_outputs(ROOT / "source/new.zip", self.report)
        self.archive.write_bytes(b"existing immutable file")
        with self.assertRaises(FileExistsError):
            m.safe_outputs(self.archive, self.report)
        self.assertEqual(self.archive.read_bytes(), b"existing immutable file")

    def test_owned_report_updates_only_its_prior_unchanged_bytes(self):
        writer = m.OwnedReport(self.report)
        writer.write({"status": "one"})
        writer.write({"status": "two"})
        self.assertEqual(json.loads(self.report.read_bytes())["status"], "two")
        self.report.write_bytes(b"someone else's bytes")
        with self.assertRaisesRegex(ValueError, "outside"):
            writer.write({"status": "three"})
        self.assertEqual(self.report.read_bytes(), b"someone else's bytes")

    def test_initial_report_never_overwrites_another_writer(self):
        self.report.write_bytes(b"preserve")
        with self.assertRaises(FileExistsError):
            m.OwnedReport(self.report).write({"synthetic": True})
        self.assertEqual(self.report.read_bytes(), b"preserve")

    def test_failed_metadata_acquisition_is_recorded_as_failed_not_inferred(self):
        args = Namespace(archive=self.archive, report=self.report)
        with mock.patch.object(m, "bounded", side_effect=OSError("synthetic failure")):
            with self.assertRaises(OSError):
                m.acquire(args)
        report = json.loads(self.report.read_bytes())
        self.assertEqual(report["status"], "failed-not-inferred")
        self.assertFalse(report["model_pickle_executed"])
        self.assertFalse(self.archive.exists())

    def test_actual_acquisition_flow_uses_synthetic_bytes_and_no_weights_load(self):
        self.fixture()
        payload = self.archive.read_bytes()
        self.archive.unlink()
        asset = self.asset()
        asset["size"] = len(payload)
        args = Namespace(archive=self.archive, report=self.report)
        with mock.patch.object(m, "ASSET_BYTES", len(payload)), \
             mock.patch.object(m, "SOURCE_FILES", {}), \
             mock.patch.object(m, "bounded", return_value=json.dumps(asset).encode()), \
             mock.patch.object(m, "request", return_value=io.BytesIO(payload)), \
             mock.patch.object(m, "print_receipt"):
            result = m.acquire(args)
        self.assertEqual(result["archive"]["sha256"], sha256(payload).hexdigest())
        self.assertEqual(result["status"], "actual-official-manipuri-checkpoints-hashed-not-inferred")
        self.assertFalse(result["model_weights_loaded"])
        self.assertEqual(self.archive.read_bytes(), payload)

    def test_changed_asset_after_stream_does_not_publish_archive(self):
        self.fixture()
        payload = self.archive.read_bytes()
        self.archive.unlink()
        asset = self.asset()
        asset["size"] = len(payload)
        changed = dict(asset, updated_at="changed")
        with mock.patch.object(m, "ASSET_BYTES", len(payload)), \
             mock.patch.object(m, "SOURCE_FILES", {}), \
             mock.patch.object(m, "bounded", side_effect=[
                 json.dumps(asset).encode(), json.dumps(changed).encode()]), \
             mock.patch.object(m, "request", return_value=io.BytesIO(payload)), \
             mock.patch.object(m, "print_receipt"):
            with self.assertRaisesRegex(ValueError, "identity changed"):
                m.acquire(Namespace(archive=self.archive, report=self.report))
        self.assertFalse(self.archive.exists())

    def test_public_download_may_not_redirect_outside_github(self):
        response = io.BytesIO(b"opaque")
        response.geturl = lambda: "https://example.com/unknown"
        with mock.patch.object(m, "urlopen", return_value=response):
            with self.assertRaisesRegex(ValueError, "left GitHub"):
                m.request(m.DOWNLOAD_URL)
        self.assertTrue(response.closed)


if __name__ == "__main__":
    unittest.main()
