import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import shutil

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "source/0.12.2/kx47Runtime"))
import package_manager as manager
import upgrade_packages as upgrade
import voice_packages

spec = importlib.util.spec_from_file_location("upgrade_voice_cli", ROOT / "tools/voice_packages.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class UpgradePackagesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old, self.new = self.root / "old", self.root / "new"
        for folder in (self.old, self.new):
            folder.mkdir()
            (folder / "manifest.ini").write_text('version = "0.13.0-dev.1"\n')

    def resource(self):
        name = "kx47Runtime/models/Extra/model.bin"
        path = self.old / name
        path.parent.mkdir(parents=True)
        path.write_bytes(b"verified model")
        record = {"size_bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        meta = {"format": manager.FORMAT, "format_version": 1, "id": "extra", "name": "Extra",
                "version": "1.0.0", "minimum_core_version": "0.13.0-dev.1", "dependencies": [], "files": {name: record}}
        manager._write_state(self.old, {"format_version": 1, "packs": {"extra": meta}})
        return name, record

    def voice(self, version="1.0.0"):
        source = self.root / ("voice" + version)
        source.mkdir()
        (source / "profile.npy").write_bytes(b"immutable profile " + version.encode())
        document = cli.prepare_manifest(source, voice_id="new_voice", name="New voice", version=version,
                                        engine={"id": "holos", "compatibility_version": 1}, languages=["uk"],
                                        provenance={"source": "Synthetic test fixture", "license": "CC0-1.0"},
                                        roles={"profile.npy": "holos_profile"})
        archive = self.root / ("voice" + version + ".zip")
        voice_packages.create_package(source, document, archive)
        return voice_packages.install_package(archive, self.old / "kx47Runtime/models/voices/packages")

    def test_registered_resources_and_all_voice_versions_preserved(self):
        name, _ = self.resource()
        first = self.voice("1.0.0")
        second = self.voice("2.0.0")
        old_registry = manager._state_path(self.old).read_bytes()
        old_index = (first.parent.parent / voice_packages.INDEX_NAME).read_bytes()
        unknown = self.old / "kx47Runtime/unknown.py"
        unknown.write_text("must not migrate")
        result = upgrade.migrate_installed_packages(self.old, self.new)
        self.assertEqual(result["resource_packs"], 1)
        self.assertEqual(result["voice_versions"], 2)
        self.assertEqual((self.new / name).read_bytes(), b"verified model")
        voices = self.new / "kx47Runtime/models/voices/packages"
        self.assertEqual([d["version"] for d in voice_packages.installed_versions(voices, "new_voice")], ["1.0.0", "2.0.0"])
        self.assertEqual(voice_packages._load_index(voices)["active"]["new_voice"], "2.0.0")
        self.assertFalse((self.new / "kx47Runtime/unknown.py").exists())
        self.assertEqual(manager._state_path(self.old).read_bytes(), old_registry)
        self.assertEqual((first.parent.parent / voice_packages.INDEX_NAME).read_bytes(), old_index)
        self.assertTrue(first.is_dir())
        self.assertTrue(second.is_dir())
        # A retried NVDA installation is idempotent.
        repeated = upgrade.migrate_installed_packages(self.old, self.new)
        self.assertEqual(repeated["copied_files"], 0)

    def test_incompatible_core_collision_aborts_without_touching_old(self):
        name, _ = self.resource()
        target = self.new / name
        target.parent.mkdir(parents=True)
        target.write_bytes(b"different core")
        with self.assertRaises(upgrade.UpgradeError):
            upgrade.migrate_installed_packages(self.old, self.new)
        self.assertEqual(target.read_bytes(), b"different core")
        self.assertEqual((self.old / name).read_bytes(), b"verified model")
        self.assertFalse(manager._state_path(self.new).exists())

    def test_identical_new_core_resource_is_not_owned_or_deleted(self):
        name, record = self.resource()
        target = self.new / name
        target.parent.mkdir(parents=True)
        target.write_bytes(b"verified model")
        (self.new / "dordiai-release.json").write_text(json.dumps({"format": "dordiai-core-release", "files": {name: record}}))
        upgrade.migrate_installed_packages(self.old, self.new)
        migrated = manager._state(self.new)["packs"]["extra"]
        self.assertEqual(migrated["files"], {})
        self.assertEqual(migrated["provided_by_core"], {name: record})
        manager.uninstall_pack("extra", self.new)
        self.assertTrue(target.is_file())

    def test_modified_old_resource_aborts(self):
        name, _ = self.resource()
        (self.old / name).write_bytes(b"corrupt")
        with self.assertRaises(upgrade.UpgradeError):
            upgrade.migrate_installed_packages(self.old, self.new)
        self.assertFalse((self.new / name).exists())

    def test_write_failure_rolls_back_new_payload_and_registry(self):
        name, _ = self.resource()
        module = upgrade._component("package_manager")
        original = module._atomic_json

        def fail_registry(path, document):
            if Path(path) == manager._state_path(self.new):
                raise OSError("Windows file lock")
            return original(path, document)

        with patch.object(module, "_atomic_json", side_effect=fail_registry), self.assertRaises(OSError):
            upgrade.migrate_installed_packages(self.old, self.new)
        self.assertFalse((self.new / name).exists())
        self.assertFalse(manager._state_path(self.new).exists())
        self.assertEqual((self.old / name).read_bytes(), b"verified model")

    def test_missing_voice_active_version_aborts(self):
        path = self.old / "kx47Runtime/models/voices/packages/voice-packages.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"format_version": 1, "active": {"new_voice": "1.0.0"}}))
        with self.assertRaises(upgrade.UpgradeError):
            upgrade.migrate_installed_packages(self.old, self.new)

    def test_incompatible_voice_adapter_aborts(self):
        path = self.voice()
        document = json.loads((path / voice_packages.MANIFEST_NAME).read_text())
        document["engine"]["compatibility_version"] = 99
        (path / voice_packages.MANIFEST_NAME).write_text(json.dumps(document))
        with self.assertRaises(ValueError):
            upgrade.migrate_installed_packages(self.old, self.new)
        self.assertFalse((self.new / "kx47Runtime/models/voices/packages/new_voice").exists())

    def test_no_registered_packages_does_not_copy_old_addon(self):
        (self.old / "old-code.py").write_text("old")
        result = upgrade.migrate_installed_packages(self.old, self.new)
        self.assertEqual(result["copied_files"], 0)
        self.assertFalse((self.new / "old-code.py").exists())

    def test_nvda_install_hook_migrates_before_registering_wrapper(self):
        name, _ = self.resource()
        config = self.root / "config"
        addons = config / "addons"
        addons.mkdir(parents=True)
        previous = addons / "kx47Voices"
        self.old.replace(previous)
        pending = addons / "kx47Voices.pendingInstall"
        self.new.replace(pending)
        runtime = pending / "kx47Runtime"
        runtime.mkdir()
        for module in ("upgrade_packages", "package_manager", "voice_policy", "voice_packages", "voice_assets"):
            shutil.copyfile(ROOT / "source/0.12.2/kx47Runtime" / (module + ".py"), runtime / (module + ".py"))
        bridge = pending / "worldVoiceBridge/DordiaiVoices"
        bridge.mkdir(parents=True)
        (bridge / "__init__.py").write_text("wrapper")
        (bridge / "manifest.json").write_text("{}")
        spec = importlib.util.spec_from_file_location("test_install_hook", ROOT / "source/0.12.2/installTasks.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"globalVars": SimpleNamespace(appArgs=SimpleNamespace(configPath=str(config)))}):
            spec.loader.exec_module(module)
        module.__file__ = str(pending / "installTasks.py")
        module.onInstall()
        self.assertEqual((pending / name).read_bytes(), b"verified model")
        self.assertEqual((previous / name).read_bytes(), b"verified model")
        self.assertEqual((config / "WorldVoice-workspace/DordiaiVoices/DordiaiVoices/__init__.py").read_text(), "wrapper")


if __name__ == "__main__":
    unittest.main()
