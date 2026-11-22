import copy
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "source/0.12.2/kx47Runtime"))
import voice_packages as packages

spec = importlib.util.spec_from_file_location("voice_package_cli", ROOT / "tools/voice_packages.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class VoicePackagesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.source = self.base / "source"
        self.source.mkdir()
        (self.source / "profile.npy").write_bytes(b"prepared vector data")
        self.manifest = cli.prepare_manifest(
            self.source, voice_id="example_voice", name="Example voice", version="1.0.0",
            engine={"id": "holos", "compatibility_version": 1}, languages=["uk", "en-US"],
            provenance={"source": "Synthetic test fixture", "license": "CC0-1.0"},
            roles={"profile.npy": "target_embedding"},
            requires=[{"id": "holos_shared", "version": "1.0.0"}],
        )
        self.package = self.base / "example.dordiai-voice"
        self.root = self.base / "installed"
        self.engines = {"holos": 1}
        self.resources = {"holos_shared": "1.0.0"}

    def build(self):
        return packages.create_package(self.source, self.manifest, self.package)

    def test_build_verify_install_discover_and_rollback(self):
        self.build()
        original = self.package.read_bytes()
        self.build()
        self.assertEqual(self.package.read_bytes(), original, "Building the same voice must be reproducible")
        self.assertEqual(packages.inspect_package(self.package), self.manifest)
        directory = packages.install_package(self.package, self.root, engines=self.engines, resources=self.resources)
        self.assertEqual((directory / "profile.npy").read_bytes(), b"prepared vector data")
        self.assertEqual(packages.install_package(self.package, self.root), directory)
        discovered = packages.discover_packages(self.root, engines=self.engines, resources=self.resources)
        self.assertEqual(list(discovered), ["example_voice"])
        self.assertEqual(discovered["example_voice"]["styles"], ["neutral"])
        self.manifest["version"] = "1.1.0"
        self.build()
        newer = packages.install_package(self.package, self.root)
        self.assertNotEqual(directory, newer)
        self.assertEqual(packages.discover_packages(self.root)["example_voice"]["version"], "1.1.0")
        packages.activate_version(self.root, "example_voice", "1.0.0", engines=self.engines, resources=self.resources)
        self.assertEqual(packages.discover_packages(self.root)["example_voice"]["version"], "1.0.0")

    def test_tampered_package_does_not_replace_active_version(self):
        self.build()
        packages.install_package(self.package, self.root)
        old_index = (self.root / packages.INDEX_NAME).read_bytes()
        self.manifest["version"] = "2.0.0"
        with zipfile.ZipFile(self.package, "w") as archive:
            archive.writestr(packages.MANIFEST_NAME, json.dumps(self.manifest))
            archive.writestr("profile.npy", b"altered vector data!")
        with self.assertRaises(packages.PackageError):
            packages.install_package(self.package, self.root)
        self.assertEqual((self.root / packages.INDEX_NAME).read_bytes(), old_index)
        self.assertFalse((self.root / "example_voice/2.0.0").exists())
        self.assertFalse(list(self.root.glob(".voice-install-*")))

    def test_install_rejects_missing_engine_and_shared_resources(self):
        self.build()
        for engines, resources in (({}, self.resources), ({"holos": 2}, self.resources), (self.engines, {})):
            with self.subTest(engines=engines, resources=resources), self.assertRaises(packages.PackageError):
                packages.install_package(self.package, self.root, engines=engines, resources=resources)
        self.assertFalse((self.root / packages.INDEX_NAME).exists())

    def test_same_version_cannot_silently_change_its_contents(self):
        self.build()
        packages.install_package(self.package, self.root)
        self.manifest["name"] = "Changed metadata"
        self.build()
        with self.assertRaisesRegex(packages.PackageError, "new version"):
            packages.install_package(self.package, self.root)

    def test_rollback_detects_damaged_installed_data(self):
        self.build()
        directory = packages.install_package(self.package, self.root)
        (directory / "profile.npy").write_bytes(b"altered vector data!")
        with self.assertRaises(packages.PackageError):
            packages.activate_version(self.root, "example_voice", "1.0.0")

    def test_removal_deactivates_and_deletes_only_the_selected_voice(self):
        self.build()
        packages.install_package(self.package, self.root)
        other = self.root / "other_data"
        other.mkdir()
        (other / "keep.txt").write_text("keep")
        versions = packages.installed_versions(self.root, "example_voice")
        self.assertEqual([row["version"] for row in versions], ["1.0.0"])
        packages.uninstall_package(self.root, "example_voice")
        self.assertEqual(packages.discover_packages(self.root), {})
        self.assertFalse((self.root / "example_voice").exists())
        self.assertEqual((other / "keep.txt").read_text(), "keep")

    def test_damaged_voice_remains_listed_for_administrative_removal(self):
        self.build()
        directory = packages.install_package(self.package, self.root)
        (directory / "profile.npy").unlink()
        self.assertEqual(packages.discover_packages(self.root), {})
        rows = packages.list_installed_packages(self.root)
        self.assertEqual(rows[0]["id"], "example_voice")
        self.assertEqual(rows[0]["status"], "unavailable")
        packages.uninstall_package(self.root, "example_voice")
        self.assertEqual(packages.list_installed_packages(self.root), [])

    def test_discovery_reads_sizes_without_hashing_and_filters_incompatible_voices(self):
        self.build()
        directory = packages.install_package(self.package, self.root)
        self.assertEqual(packages.discover_packages(self.root, engines={}), {})
        (directory / "profile.npy").write_bytes(b"bad")
        self.assertEqual(packages.discover_packages(self.root), {})

    def test_rejects_all_excluded_voice_identities(self):
        from voice_policy import EXCLUDED_VOICE_IDS
        for voice in EXCLUDED_VOICE_IDS:
            document = {**self.manifest, "id": voice}
            with self.subTest(voice=voice), self.assertRaises(ValueError):
                packages.validate_manifest(document)

    def test_rejects_paths_that_escape_or_alias_on_windows(self):
        invalid = ["../profile.npy", "/profile.npy", "C:/profile.npy", "a\\profile.npy", "x//y",
                   "x/./y", "x/../y", "x./y", "x /y", "NUL.npy", "a/COM1/file", "a:stream", "x\x00y"]
        for path in invalid:
            with self.subTest(path=path), self.assertRaises(packages.PackageError):
                packages.validate_member_path(path)
        self.assertEqual(packages.validate_member_path("letters/uk/і.wav"), "letters/uk/і.wav")

    def test_rejects_case_collisions_file_directory_collisions_and_executable_code(self):
        for names in (("profile.npy", "PROFILE.NPY"), ("a", "a/profile.npy"), ("run.py",)):
            document = copy.deepcopy(self.manifest)
            entry = document["files"]["profile.npy"]
            document["files"] = {name: entry for name in names}
            with self.subTest(names=names), self.assertRaises(packages.PackageError):
                packages.validate_manifest(document)

    def test_rejects_undeclared_assets_and_symlink_members(self):
        self.build()
        with zipfile.ZipFile(self.package, "a") as archive:
            archive.writestr("extra.txt", "unlisted")
        with self.assertRaisesRegex(packages.PackageError, "inventory"):
            packages.inspect_package(self.package)
        with zipfile.ZipFile(self.package, "w") as archive:
            info = zipfile.ZipInfo("profile.npy")
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "../outside")
        with self.assertRaisesRegex(packages.PackageError, "regular files"):
            packages.inspect_package(self.package)

    def test_expanded_size_limit_is_enforced_before_writing_assets(self):
        self.build()
        with self.assertRaises(packages.PackageError):
            packages.install_package(self.package, self.root, max_bytes=1)
        self.assertFalse((self.root / "example_voice").exists())

    def test_source_symlinks_are_rejected(self):
        path = self.source / "profile.npy"
        path.unlink()
        outside = self.base / "outside.npy"
        outside.write_bytes(b"prepared vector data")
        try:
            path.symlink_to(outside)
        except OSError as error:
            if getattr(error, "winerror", None) == 1314:
                self.skipTest("This Windows account cannot create filesystem symlinks")
            raise
        with self.assertRaises(packages.PackageError):
            self.build()

    def test_corrupted_sources_are_rejected(self):
        path = self.source / "profile.npy"
        path.write_bytes(b"unverified replacement")
        with self.assertRaises(packages.PackageError):
            self.build()


if __name__ == "__main__":
    unittest.main()
