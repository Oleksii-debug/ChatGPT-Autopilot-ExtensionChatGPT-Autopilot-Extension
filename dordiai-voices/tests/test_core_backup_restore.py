import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import restore_core_backup as backup
import create_core_backup as creator


class CoreBackupRestoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.raw = bytes(range(256)) * 16
        self.manifest = {"format": backup.FORMAT, "format_version": 1,
            "source_filename": "core.nvda-addon", "source_size_bytes": len(self.raw),
            "source_sha256": hashlib.sha256(self.raw).hexdigest(), "chunks": []}
        for index in range(1, 5):
            data = self.raw[(index - 1) * 1024:index * 1024]
            path = self.root / ("backup-%03d.zip" % index)
            member = "chunk-%03d.bin" % index
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.writestr(member, data)
            self.manifest["chunks"].append({"index": index, "offset_bytes": (index - 1) * 1024,
                "zip_filename": path.name, "zip_size_bytes": path.stat().st_size,
                "zip_sha256": backup.file_sha256(path), "member_name": member,
                "raw_size_bytes": len(data), "raw_sha256": hashlib.sha256(data).hexdigest()})
        self.path = self.root / "backup.json"
        self.save()

    def save(self):
        self.path.write_text(json.dumps(self.manifest), encoding="utf-8")

    def test_stream_verification_then_atomic_restoration_and_existing_match(self):
        result = backup.restore(self.path, verify_only=True)
        self.assertEqual(result["sha256"], hashlib.sha256(self.raw).hexdigest())
        output = self.root / "core.nvda-addon"
        self.assertFalse(output.exists())
        self.assertEqual(backup.restore(self.path)["status"], "restored")
        self.assertEqual(output.read_bytes(), self.raw)
        self.assertEqual(backup.restore(self.path)["status"], "already_verified")

    def test_wrong_existing_file_never_overwritten(self):
        output = self.root / "core.nvda-addon"
        output.write_bytes(b"keep this file")
        with self.assertRaises(FileExistsError):
            backup.restore(self.path)
        self.assertEqual(output.read_bytes(), b"keep this file")

    def test_chunk_order_and_manifest_path_traversal_rejected(self):
        self.manifest["chunks"].reverse()
        self.save()
        with self.assertRaisesRegex(ValueError, "order"):
            backup.restore(self.path)
        self.manifest["chunks"].reverse()
        self.manifest["chunks"][0]["zip_filename"] = "../outside.zip"
        self.save()
        with self.assertRaisesRegex(ValueError, "filename"):
            backup.restore(self.path)

    def test_corrupt_outer_zip_leaves_no_output_or_temporary(self):
        path = self.root / self.manifest["chunks"][2]["zip_filename"]
        data = bytearray(path.read_bytes());data[50] ^= 1;path.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "corrupt"):
            backup.restore(self.path)
        self.assertFalse((self.root / "core.nvda-addon").exists())
        self.assertFalse(list(self.root.glob(".dordiai-core-restore-*")))

    def test_wrong_raw_hash_and_final_hash_rejected(self):
        self.manifest["chunks"][0]["raw_sha256"] = "0" * 64
        self.save()
        with self.assertRaisesRegex(ValueError, "raw chunk"):
            backup.restore(self.path, verify_only=True)
        self.manifest["chunks"][0]["raw_sha256"] = hashlib.sha256(self.raw[:1024]).hexdigest()
        self.manifest["source_sha256"] = "0" * 64
        self.save()
        with self.assertRaisesRegex(ValueError, "original"):
            backup.restore(self.path, verify_only=True)

    def test_unsafe_zip_member_rejected_even_with_updated_outer_hash(self):
        chunk = self.manifest["chunks"][0]
        path = self.root / chunk["zip_filename"]
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("../escape.bin", self.raw[:1024])
        chunk.update(zip_size_bytes=path.stat().st_size, zip_sha256=backup.file_sha256(path))
        self.save()
        with self.assertRaisesRegex(ValueError, "member"):
            backup.restore(self.path, verify_only=True)


class CoreBackupCreateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "original.nvda-addon"
        self.raw = bytes(range(256)) * 16 + b"!"
        self.source.write_bytes(self.raw)
        self.options = {"version": "0.13.1-dev.4", "expected_sha256": backup.file_sha256(self.source)}

    def test_create_four_parts_and_restore_nondivisible_input(self):
        output = self.root / "backup"
        evidence = creator.create_backup(self.source, output, **self.options)
        self.assertTrue(evidence["real_stream_reconstruction_verified"])
        self.assertEqual(len(evidence["parts"]), 4)
        self.assertEqual(sum(r["raw_size_bytes"] for r in evidence["parts"]), len(self.raw))
        restored = self.root / "restored.nvda-addon"
        backup.restore(output / evidence["manifest_filename"], restored)
        self.assertEqual(restored.read_bytes(), self.raw)
        self.assertEqual(self.source.read_bytes(), self.raw)
        self.assertTrue((output / evidence["helper_bundle"]["filename"]).is_file())

    def test_wrong_expected_source_hash_does_not_publish_partial_backup(self):
        output = self.root / "backup"
        with self.assertRaisesRegex(ValueError, "release SHA256"):
            creator.create_backup(self.source, output, **dict(self.options, expected_sha256="0" * 64))
        self.assertFalse(output.exists())
        self.assertFalse(list(self.root.glob(".dordiai-backup-*")))
        self.assertEqual(self.source.read_bytes(), self.raw)

    def test_existing_output_and_unsafe_version_are_rejected(self):
        output = self.root / "backup"
        output.mkdir()
        marker = output / "keep"
        marker.write_bytes(b"existing backup")
        with self.assertRaises(FileExistsError):
            creator.create_backup(self.source, output, **self.options)
        self.assertEqual(marker.read_bytes(), b"existing backup")
        with self.assertRaisesRegex(ValueError, "filename"):
            creator.create_backup(self.source, self.root / "new-backup", **dict(self.options, version="../unsafe"))


if __name__ == "__main__":
    unittest.main()
