"""Raw ZIP identities must not disappear through Windows ZipInfo normalization."""
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
for directory in (ROOT / "tools", ROOT / "source/0.12.2/kx47Runtime"):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))
import package_manager
import voice_packages
import verify_release
import restore


class RawZipIdentityTests(unittest.TestCase):
    def normalized_member(self, raw, normalized):
        member = zipfile.ZipInfo(normalized)
        member.orig_filename = raw
        return member

    def test_voice_package_rejects_raw_backslash_and_truncated_nul(self):
        for raw in ("assets\\profile.npy", "assets/profile.npy\0suffix"):
            with self.subTest(raw=raw):
                member = self.normalized_member(raw, "assets/profile.npy")
                archive = SimpleNamespace(infolist=lambda: [member])
                with self.assertRaises(voice_packages.PackageError):
                    voice_packages.inspect_zip_members(archive)

    def test_resource_package_rejects_raw_backslash_and_truncated_nul(self):
        normalized = "kx47Runtime/models/Extra/profile.npy"
        for raw in (normalized.replace("/", "\\"), normalized + "\0suffix"):
            with self.subTest(raw=raw):
                member = self.normalized_member(raw, normalized)
                archive = SimpleNamespace(infolist=lambda: [member])
                with self.assertRaises(package_manager.PackageError):
                    package_manager._read_manifest(archive)

    def test_release_verifier_rejects_raw_normalized_alias(self):
        member = self.normalized_member("kx47Runtime\\worker.py", "kx47Runtime/worker.py")
        archive = SimpleNamespace(infolist=lambda: [member])
        with patch.object(verify_release.zipfile, "ZipFile") as factory:
            factory.return_value.__enter__.return_value = archive
            with self.assertRaisesRegex(ValueError, "Noncanonical raw"):
                verify_release.verify_archive("unused-fixture.nvda-addon")

    def test_restorer_rejects_raw_alias_before_any_extraction(self):
        for raw in ("kx47Runtime\\worker.py", "kx47Runtime/worker.py\0suffix"):
            with self.subTest(raw=raw), tempfile.TemporaryDirectory() as temporary:
                member = self.normalized_member(raw, "kx47Runtime/worker.py")
                archive = SimpleNamespace(infolist=lambda: [member])
                with self.assertRaisesRegex(ValueError, "Unsafe raw"):
                    restore.safe_members(archive, Path(temporary))

    def test_ordinary_forward_slash_identity_remains_valid(self):
        member = self.normalized_member("assets/profile.npy", "assets/profile.npy")
        archive = SimpleNamespace(infolist=lambda: [member])
        self.assertEqual(set(voice_packages.inspect_zip_members(archive)), {"assets/profile.npy"})
        with tempfile.TemporaryDirectory() as temporary:
            self.assertEqual(restore.safe_members(archive, Path(temporary)), [member])


if __name__ == "__main__":
    unittest.main()
