"""Optional builder overlay wiring; schema validation has its own real tests."""
from contextlib import contextmanager
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import build_release as builder
from verify_release import verify_archive


class PreparedOverlayHookTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.baseline = self.root / "baseline"
        self.source = self.root / "source"
        self.output = self.root / "output"
        self.baseline.mkdir();self.source.mkdir()
        self.put("manifest.ini", b'version = "0.12.2"\ndescription = "fixture"\n')
        self.put("kx47Runtime/models/voices/catalog.json", b'{"anna":"Anna","oleksii":"Oleksii","inna":"Excluded"}')
        self.bank_name = "kx47Runtime/models/voices/native_letters/anna.pcm"
        self.put(self.bank_name, b"old-bank")
        self.put("kx47Runtime/worker.py", b"UNCHANGED = True\n")

    def put(self, name, data):
        path = self.baseline / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def core_path(self):
        return self.output / ("dordiai-voices-" + builder.VERSION + ".nvda-addon")

    def test_without_overlay_does_not_import_or_change_metadata(self):
        module = ModuleType("prepared_bank_overlay")
        def forbidden(*args):
            raise AssertionError("Optional overlay was accessed without a flag")
        module.apply_to_inputs = forbidden
        with patch.dict(sys.modules, {"prepared_bank_overlay": module}):
            report = builder.build_release(self.baseline, self.source, self.output, only=["core"])
        self.assertNotIn("prepared_bank_overlay", report)
        with zipfile.ZipFile(self.core_path()) as archive:
            self.assertNotIn("prepared_bank_overlay", json.loads(archive.read(builder.RELEASE_MANIFEST)))
            self.assertEqual(archive.read(self.bank_name), b"old-bank")
        self.assertEqual(verify_archive(self.core_path())["voice_count"], 2)

    def test_context_owned_bank_files_survive_all_archive_writes_then_are_cleaned(self):
        module = ModuleType("prepared_bank_overlay")
        state = {}
        summary = {"format": "fixture-overlay-summary", "input_sha256": "a" * 64,
                   "note": "opaque fixture; actual schema validation belongs to validator tests"}
        overlay = self.root / "fixture-overlay.zip"
        @contextmanager
        def apply(files, supplied, input_type):
            self.assertEqual(supplied, overlay)
            self.assertIs(input_type, builder.InputFile)
            with tempfile.TemporaryDirectory(dir=self.root) as temporary:
                bank = Path(temporary) / "extended.pcm"
                bank.write_bytes(b"old-bank-plus-supplementary-clips")
                state["file"] = bank
                updated = [input_type(item.path, bank, item.group) if item.path == self.bank_name else item
                           for item in files]
                state["entered"] = True
                yield updated, summary
                self.assertTrue(bank.is_file())
            state["exited"] = True
        module.apply_to_inputs = apply
        with patch.dict(sys.modules, {"prepared_bank_overlay": module}):
            report = builder.build_release(self.baseline, self.source, self.output,
                only=["core"], prepared_bank_overlay=overlay)
        self.assertTrue(state["entered"])
        self.assertTrue(state["exited"])
        self.assertFalse(state["file"].exists())
        self.assertEqual(report["prepared_bank_overlay"], summary)
        with zipfile.ZipFile(self.core_path()) as archive:
            self.assertEqual(archive.read(self.bank_name), b"old-bank-plus-supplementary-clips")
            self.assertEqual(json.loads(archive.read(builder.RELEASE_MANIFEST))["prepared_bank_overlay"], summary)
            self.assertEqual(archive.read("kx47Runtime/worker.py"), b"UNCHANGED = True\n")
        self.assertEqual((self.baseline / self.bank_name).read_bytes(), b"old-bank")
        self.assertEqual(verify_archive(self.core_path())["voice_count"], 2)

    def test_invalid_overlay_cannot_replace_an_existing_archive(self):
        self.output.mkdir()
        self.core_path().write_bytes(b"existing immutable artifact")
        module = ModuleType("prepared_bank_overlay")
        @contextmanager
        def reject(*args):
            raise ValueError("overlay identity mismatch")
            yield
        module.apply_to_inputs = reject
        with patch.dict(sys.modules, {"prepared_bank_overlay": module}):
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                builder.build_release(self.baseline, self.source, self.output,
                    only=["core"], prepared_bank_overlay=self.root / "bad.zip")
        self.assertEqual(self.core_path().read_bytes(), b"existing immutable artifact")
        self.assertFalse((self.output / "release-build.json").exists())

    def test_cli_forwards_overlay_without_changing_version(self):
        overlay = self.root / "overlay.zip"
        argv = ["build_release.py", "--baseline", str(self.baseline), "--source", str(self.source),
                "--output", str(self.output), "--only", "core", "--prepared-bank-overlay", str(overlay)]
        with patch.object(sys, "argv", argv), patch.object(builder, "build_release") as build:
            builder.main()
        build.assert_called_once_with(self.baseline, self.source, self.output, builder.VERSION, ["core"],
                                      prepared_bank_overlay=overlay)


if __name__ == "__main__":
    unittest.main()
