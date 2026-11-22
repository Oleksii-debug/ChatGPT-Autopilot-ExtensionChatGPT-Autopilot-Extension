import hashlib
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import build_release as builder
import recover_core_baseline as recovery
from verify_release import verify_archive


class RecoverCoreBaselineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.baseline = self.root / "original-baseline"
        self.source = self.root / "source"
        self.baseline.mkdir();self.source.mkdir()
        self.put(self.baseline, "manifest.ini", b'version = "0.12.2"\ndescription = "original"\n')
        self.put(self.baseline, "kx47Runtime/models/voices/catalog.json", b'{"anna":"Anna","oleksii":"Oleksii"}')
        self.put(self.baseline, "kx47Runtime/models/voices/anna.npy", b"profile")
        self.put(self.baseline, "kx47Runtime/models/Core/model.bin", b"irreplaceable shared acoustic resource")
        self.put(self.baseline, "kx47Runtime/models/Piper/de_DE-test.onnx", b"optional original model")
        self.put(self.source, "kx47Runtime/worker.py", b'raise AssertionError("Archived code must never execute")\n')
        report = builder.build_release(self.baseline, self.source, self.root / "dist", version="0.13.1-dev.4", only=["core"])
        self.archive = self.root / "dist" / report["artifacts"][0]["filename"]
        self.sha = self.digest(self.archive)

    @staticmethod
    def put(root, name, data):
        path = root / name;path.parent.mkdir(parents=True, exist_ok=True);path.write_bytes(data)

    @staticmethod
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def rewrite(self, name, changes=None, extra=None):
        path = self.root / name
        with zipfile.ZipFile(self.archive) as original, zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as out:
            for member in original.infolist():
                out.writestr(member, (changes or {}).get(member.filename, original.read(member)))
            if extra:
                for member, data in extra:
                    out.writestr(member, data)
        return path

    def test_recovered_core_rebuilds_without_original_baseline_or_old_voice_count(self):
        output = self.root / "recovered"
        result = recovery.recover(self.archive, output, expected_sha256=self.sha)
        self.assertEqual(result["voice_count"], 2)
        self.assertTrue(result["generated_release_manifest_excluded"])
        self.assertFalse((output / builder.RELEASE_MANIFEST).exists())
        self.assertFalse((output / "kx47Runtime/models/Piper/de_DE-test.onnx").exists())
        with zipfile.ZipFile(self.archive) as original:
            metadata = json.loads(original.read(builder.RELEASE_MANIFEST))
            self.assertEqual({p.relative_to(output).as_posix() for p in output.rglob("*") if p.is_file()}, set(metadata["files"]))
        empty = self.root / "empty-overlay";empty.mkdir()
        repeated = builder.build_release(output, empty, self.root / "same-build", version="0.13.1-dev.4", only=["core"])
        self.assertEqual(repeated["artifacts"][0]["sha256"], self.sha)
        self.put(empty, "kx47Runtime/worker.py", b"FUTURE_SOURCE = True\n")
        future = builder.build_release(output, empty, self.root / "future", version="0.13.1-dev.5", only=["core"])
        future_archive = self.root / "future" / future["artifacts"][0]["filename"]
        self.assertEqual(verify_archive(future_archive)["voice_count"], 2)
        with zipfile.ZipFile(future_archive) as archive:
            self.assertEqual(archive.read("kx47Runtime/worker.py"), b"FUTURE_SOURCE = True\n")
            self.assertEqual(archive.read("kx47Runtime/models/Core/model.bin"), b"irreplaceable shared acoustic resource")
        self.assertEqual(self.digest(self.archive), self.sha)
        self.assertEqual((self.baseline / "kx47Runtime/models/Piper/de_DE-test.onnx").read_bytes(), b"optional original model")

    def test_wrong_archive_sha_and_existing_output_are_preserved(self):
        output = self.root / "recovered"
        with self.assertRaisesRegex(ValueError, "trusted SHA256"):
            recovery.recover(self.archive, output, expected_sha256="0" * 64)
        self.assertFalse(output.exists())
        output.mkdir();(output / "keep").write_bytes(b"existing baseline")
        with self.assertRaises(FileExistsError):
            recovery.recover(self.archive, output, expected_sha256=self.sha)
        self.assertEqual((output / "keep").read_bytes(), b"existing baseline")

    def test_every_payload_hash_is_verified_before_any_extraction(self):
        changed = self.rewrite("changed.zip", {"kx47Runtime/models/Core/model.bin": b"irreplaceable shared acoustic resourcf"})
        with patch.object(recovery.tempfile, "mkdtemp", side_effect=AssertionError("Extraction started too early")):
            with self.assertRaisesRegex(ValueError, "checksum"):
                recovery.recover(changed, self.root / "recovered", expected_sha256=self.digest(changed))
        self.assertFalse(list(self.root.glob(".dordiai-core-baseline-*")))

    def test_strict_paths_reject_traversal_windows_aliases_and_raw_backslash(self):
        for index, name in enumerate(["../escape", "CON.txt", "con .txt", "bad./file", "folder\\evil.bin", "folder//evil.bin"]):
            with self.subTest(name=name):
                changed = self.rewrite(f"unsafe-{index}.zip", extra=[(name, b"bad")])
                with self.assertRaisesRegex(ValueError, "Unsafe"):
                    recovery.recover(changed, self.root / f"recovered-{index}", expected_sha256=self.digest(changed))

    def test_case_collision_and_symlink_are_rejected(self):
        link = zipfile.ZipInfo("link")
        link.create_system = 3;link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for index, extra in enumerate([[('MANIFEST.INI', b"collision")], [(link, b"manifest.ini")]]):
            changed = self.rewrite(f"bad-kind-{index}.zip", extra=extra)
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                recovery.recover(changed, self.root / f"recovered-{index}", expected_sha256=self.digest(changed))

    def test_metadata_catalogue_mismatch_is_rejected(self):
        with zipfile.ZipFile(self.archive) as archive:
            metadata = json.loads(archive.read(builder.RELEASE_MANIFEST))
        metadata["voice_ids"] = ["someone_else"]
        changed = self.rewrite("bad-catalogue.zip", {builder.RELEASE_MANIFEST: json.dumps(metadata).encode()})
        with self.assertRaisesRegex(ValueError, "catalogues"):
            recovery.recover(changed, self.root / "recovered", expected_sha256=self.digest(changed))


if __name__ == "__main__":
    unittest.main()
