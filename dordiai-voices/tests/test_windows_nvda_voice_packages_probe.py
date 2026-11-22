"""Scaffolding/ownership checks, not an actual Windows/NVDA acceptance run."""
import copy
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("voice_lifecycle_probe", ROOT / "tools/windows_nvda_voice_packages_probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
sys.path.insert(0, str(ROOT / "source/0.12.2/kx47Runtime"))
import voice_packages


class OwnedLifecycleScaffoldingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.addon = self.root / "fixture.nvda-addon"
        self.write_archive()

    def write_archive(self, version=probe.EXPECTED_VERSION):
        with zipfile.ZipFile(self.addon, "w") as archive:
            archive.writestr("dordiai-release.json", json.dumps({"version": version, "voice_ids": ["voice" + str(i) for i in range(45)]}))
        raw = self.addon.read_bytes()
        self.pin = {"format": "dordiai-source13-build-pin", "version": probe.EXPECTED_VERSION,
                    "archive_bytes": len(raw), "archive_sha256": sha256(raw).hexdigest(),
                    "source_commit": "a" * 40, "source_run_id": 123, "product_ready": False}

    def test_only_owned_visible_native_ok_modal_is_eligible(self):
        expected = {"pid": 123, "title": "Dordiai settings", "class": "#32770", "visible": True, "ok_id": 1}
        self.assertTrue(probe.modal_allowed(expected, 123, "Dordiai settings"))
        for key, wrong in (("pid", 999), ("title", "Other app"), ("class", "wxWindowNR"),
                           ("visible", False), ("ok_id", None)):
            with self.subTest(key=key):
                self.assertFalse(probe.modal_allowed({**expected, key: wrong}, 123, "Dordiai settings"))

    def test_wrong_version_pin_or_promoted_product_flag_is_rejected(self):
        for key, value in (("version", "0.13.1-dev.12"), ("archive_bytes", True),
                           ("archive_sha256", "invalid"), ("source_commit", "x" * 40),
                           ("source_run_id", 0), ("product_ready", True)):
            changed = {**self.pin, key: value}
            with self.subTest(key=key), self.assertRaises(ValueError):
                probe.verify_addon(self.addon, changed)

    def test_exact_archive_hash_size_version_and45_ids_are_required(self):
        self.assertEqual(probe.verify_addon(self.addon, self.pin), self.pin)
        self.addon.write_bytes(self.addon.read_bytes() + b"modified")
        with self.assertRaisesRegex(ValueError, "size differs"):
            probe.verify_addon(self.addon, self.pin)
        self.write_archive("0.13.1-dev.12")
        with self.assertRaisesRegex(ValueError, "identity/version"):
            probe.verify_addon(self.addon, self.pin)

    def test_fixture_uses_existing_data_verbatim_in_real_package_builder(self):
        source = self.root / "profile"
        source.mkdir()
        raw = b"owned exact acoustic profile fixture"
        (source / "holos.npy").write_bytes(raw)
        document = probe.fixture_manifest("allowed_fixture", "1.0.0", raw)
        voice_packages.validate_manifest(document)
        archive = self.root / "fixture.dordiai-voice"
        voice_packages.create_package(source, document, archive)
        self.assertEqual(voice_packages.inspect_package(archive), document)
        with zipfile.ZipFile(archive) as content:
            self.assertEqual(content.read("holos.npy"), raw)

    def test_fixture_cannot_bypass_excluded_voice_policy(self):
        from voice_policy import EXCLUDED_VOICE_IDS
        for voice in EXCLUDED_VOICE_IDS:
            with self.subTest(voice=voice), self.assertRaises(ValueError):
                voice_packages.validate_manifest(probe.fixture_manifest(voice, "1.0.0", b"data"))

    def test_injected_probe_compiles_but_does_not_claim_execution(self):
        spec = importlib.util.spec_from_file_location("owned_lifecycle_base", ROOT / "tools/windows_nvda_probe.py")
        base = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(base)
        original = base.PROBE_PLUGIN
        extended = probe.extend_plugin(original)
        compile(extended, "actual-owned-NVDA-plugin", "exec")
        self.assertIn(probe.ANCHOR, original)
        with self.assertRaisesRegex(ValueError, "anchor"):
            probe.extend_plugin(extended)

    def test_missing_or_duplicate_frozen_source_anchor_cannot_be_extended(self):
        for source in ("", probe.ANCHOR * 2):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "anchor"):
                probe.extend_plugin(source)

    def test_old_core_fails_before_loading_or_downloading_NVDA(self):
        pin = self.root / "pin.json"
        changed = {**self.pin, "version": "0.13.1-dev.12"}
        pin.write_text(json.dumps(changed), encoding="utf-8")
        with patch.object(probe.importlib.util, "spec_from_file_location") as loader:
            with self.assertRaisesRegex(ValueError, "source13"):
                probe.main(["--build-pin", str(pin), "--addon", str(self.addon)])
        loader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
