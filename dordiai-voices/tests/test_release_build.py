"""Packaging and offline installation tests; no Windows/audio claims."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "source/0.12.2/kx47Runtime"))
import build_release as build
import package_manager as manager
from verify_release import verify_archive


class ReleaseBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.baseline, self.source = self.root / "baseline", self.root / "source"
        self.baseline.mkdir()
        self.source.mkdir()
        self.put(self.baseline, "manifest.ini", b'name = "kx47Voices"\nversion = "0.12.2"\ndescription = "53 profiles"\n')
        self.put(self.baseline, "kx47Runtime/models/voices/catalog.json", json.dumps({"oleksii": "Oleksii", "anna": "Anna", "inna": "Inna"}).encode())
        self.put(self.baseline, "kx47Runtime/models/voices/inna.npy", b"excluded")
        self.put(self.baseline, "kx47Runtime/models/voices/native_letters/inna.pcm", b"excluded")
        self.put(self.baseline, "kx47Runtime/models/voices/core_spelling_2x/inna/letter.wav", b"excluded")
        self.put(self.baseline, "kx47Runtime/models/voices/anna.npy", b"allowed")
        self.put(self.baseline, "kx47Runtime/models/voices/delivery.json", b'{"inna":{},"anna":{"voice":"anna"}}')
        self.put(self.baseline, "kx47Runtime/models/english_voice_profiles.json", b'{"inna":{},"anna":{"seed":42}}')
        self.put(self.baseline, "kx47Runtime/models/WideLanguages/wide_words.json", b'{"inna":"valid-word"}')
        self.put(self.baseline, "kx47Runtime/models/Piper/de_DE-test.onnx", b"GermanModel")
        self.put(self.baseline, "kx47Runtime/models/Piper/en_US-test.onnx", b"EnglishModel")
        self.put(self.baseline, "kx47Runtime/models/Slovak/test.bin", b"SlovakModel")
        self.put(self.baseline, "kx47Runtime/worker.py", b"ORIGINAL = True\n")
        self.put(self.source, "kx47Runtime/worker.py", b"UPDATED = True\n")

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def put(root, name, data):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def test_build_overlay_exclusion_disjoint_packs_and_reproducibility(self):
        first = build.build_release(self.baseline, self.source, self.root / "out1")
        second = build.build_release(self.baseline, self.source, self.root / "out2")
        inventories = []
        for a, b in zip(first["artifacts"], second["artifacts"]):
            self.assertEqual(a["sha256"], b["sha256"])
            self.assertEqual(a["size_bytes"], b["size_bytes"])
            path = self.root / "out1" / a["filename"]
            verified = verify_archive(path)
            self.assertEqual(verified["verified_files"], a["payload_files"])
            with zipfile.ZipFile(path) as archive:
                names = {n for n in archive.namelist() if n not in {build.RELEASE_MANIFEST, build.PACK_MANIFEST}}
                for previous in inventories:
                    self.assertFalse(names & previous)
                inventories.append(names)
                if a["group"] == "core":
                    self.assertEqual(archive.read("kx47Runtime/worker.py"), b"UPDATED = True\n")
                    self.assertEqual(set(json.loads(archive.read("kx47Runtime/models/voices/catalog.json"))), {"oleksii", "anna"})
                    self.assertNotIn(b"inna", archive.read("kx47Runtime/models/voices/delivery.json"))
                    self.assertNotIn(b"inna", archive.read("kx47Runtime/models/english_voice_profiles.json"))
                    self.assertIn(b"0.13.0-dev.1", archive.read("manifest.ini"))
                if a["group"] == "wide-languages":
                    self.assertEqual(archive.read("kx47Runtime/models/WideLanguages/wide_words.json"), b'{"inna":"valid-word"}')
        self.assertEqual((self.baseline / "kx47Runtime/worker.py").read_bytes(), b"ORIGINAL = True\n")

    def test_exact_identifiers_not_substrings(self):
        self.assertTrue(build.excluded_path("models/voices/inna.npy"))
        self.assertTrue(build.excluded_path("voices/kostia/abc.wav"))
        self.assertFalse(build.excluded_path("models/voices/innate.npy"))
        self.assertFalse(build.excluded_path("models/voices/classmate_locales/languages.json"))
        self.assertEqual(build.group_for_path("kx47Runtime/models/WideLanguages/Hebrew/renikud.py"), "core")

    def test_symlink_input_rejected(self):
        try:
            (self.source / "alias").symlink_to(self.baseline / "manifest.ini")
        except OSError:
            self.skipTest("This Windows account cannot create symbolic links")
        with self.assertRaises(ValueError):
            build.collect_inputs(self.baseline, self.source)


class ResourcePackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addon = self.root / "addon"
        self.addon.mkdir()
        (self.addon / "manifest.ini").write_text('version = "0.13.0-dev.1"\n')

    def tearDown(self):
        self.temporary.cleanup()

    def make_pack(self, identity="demo", payload=None, dependencies=None, corrupt_hash=False):
        payload = payload or {"kx47Runtime/models/Test/model.bin": b"model"}
        files = {name: {"size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} for name, data in payload.items()}
        if corrupt_hash:
            next(iter(files.values()))["sha256"] = "0" * 64
        meta = {"format": manager.FORMAT, "format_version": 1, "id": identity, "version": "0.13.0-dev.1",
                "minimum_core_version": "0.13.0-dev.1", "name": "Demo", "dependencies": dependencies or [], "files": files}
        path = self.root / (identity + ".zip")
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(manager.MANIFEST, json.dumps(meta))
            for name, data in payload.items():
                archive.writestr(name, data)
        return path

    def test_install_upgrade_uninstall_preserve_core(self):
        model = "kx47Runtime/models/Test/model.bin"
        core = self.addon / "kx47Runtime/models/core.bin"
        core.parent.mkdir(parents=True)
        core.write_bytes(b"core")
        pack = self.make_pack()
        result = manager.install_pack(pack, self.addon)
        self.assertTrue(result["restart_required"])
        self.assertEqual((self.addon / model).read_bytes(), b"model")
        self.assertEqual(manager.list_installed_packs(self.addon)[0]["id"], "demo")
        pack = self.make_pack(payload={model: b"new", "kx47Runtime/models/Test/new.bin": b"second"})
        manager.install_pack(pack, self.addon)
        self.assertEqual((self.addon / model).read_bytes(), b"new")
        manager.uninstall_pack("demo", self.addon)
        self.assertFalse((self.addon / model).exists())
        self.assertEqual(core.read_bytes(), b"core")
        self.assertEqual(manager.list_installed_packs(self.addon), [])

    def test_bad_checksum_leaves_no_payload(self):
        pack = self.make_pack(corrupt_hash=True)
        with self.assertRaises(manager.PackageError):
            manager.install_pack(pack, self.addon)
        self.assertFalse((self.addon / "kx47Runtime/models/Test/model.bin").exists())
        self.assertEqual(manager.list_installed_packs(self.addon), [])

    def test_core_collision_never_overwritten(self):
        target = self.addon / "kx47Runtime/models/Test/model.bin"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"core")
        with self.assertRaises(manager.PackageError):
            manager.install_pack(self.make_pack(), self.addon)
        self.assertEqual(target.read_bytes(), b"core")

    def test_identical_core_resource_not_claimed_or_deleted_on_pack_update(self):
        name = "kx47Runtime/models/Test/model.bin"
        target = self.addon / name
        target.parent.mkdir(parents=True)
        target.write_bytes(b"model")
        first = manager.install_pack(self.make_pack(), self.addon)
        self.assertEqual(first["installed_files"], 0)
        self.assertEqual(first["provided_by_core_files"], 1)
        second = manager.install_pack(self.make_pack(payload={name: b"model", "kx47Runtime/models/Test/extra.bin": b"extra"}), self.addon)
        self.assertEqual(second["installed_files"], 1)
        manager.uninstall_pack("demo", self.addon)
        self.assertEqual(target.read_bytes(), b"model")

    def test_update_cannot_create_indirect_dependency_cycle(self):
        manager.install_pack(self.make_pack(), self.addon)
        manager.install_pack(self.make_pack("dependent", {"kx47Runtime/models/Test/second.bin": b"b"}, ["demo"]), self.addon)
        with self.assertRaises(manager.PackageError):
            manager.install_pack(self.make_pack(dependencies=["dependent"]), self.addon)
        self.assertEqual(manager._state(self.addon)["packs"]["demo"]["dependencies"], [])

    def test_missing_dependency_and_dependent_uninstall(self):
        dependent = self.make_pack("dependent", {"kx47Runtime/models/Test/second.bin": b"b"}, ["demo"])
        with self.assertRaises(manager.PackageError):
            manager.install_pack(dependent, self.addon)
        manager.install_pack(self.make_pack(), self.addon)
        manager.install_pack(dependent, self.addon)
        with self.assertRaises(manager.PackageError):
            manager.uninstall_pack("demo", self.addon)
        manager.uninstall_pack("dependent", self.addon)
        manager.uninstall_pack("demo", self.addon)

    def test_path_traversal_windows_alias_and_code_rejected(self):
        for name in ["../escape.bin", "kx47Runtime/models/../escape.bin", "kx47Runtime/models/CON.bin",
                     "kx47Runtime/models/x:stream", "kx47Runtime/models/FILE.", "kx47Runtime/models/run.py",
                     "kx47Runtime/models/x?.bin", "kx47Runtime/models//x.bin", "kx47Runtime/models/x\\bad"]:
            with self.subTest(name=name), self.assertRaises(manager.PackageError):
                manager.inspect_pack(self.make_pack(payload={name: b"data"}))

    def test_casefold_collision_rejected(self):
        pack = self.make_pack(payload={"kx47Runtime/models/Test/A.bin": b"a", "kx47Runtime/models/Test/a.bin": b"b"})
        with self.assertRaises(manager.PackageError):
            manager.install_pack(pack, self.addon)

    def test_payload_symlink_rejected(self):
        pack = self.make_pack()
        with zipfile.ZipFile(pack, "a") as archive:
            info = zipfile.ZipInfo("kx47Runtime/models/Test/link")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "../model.bin")
        with self.assertRaises(manager.PackageError):
            manager.inspect_pack(pack)

    def test_destination_symlink_rejected(self):
        target = self.addon / "kx47Runtime/models"
        target.parent.mkdir(parents=True)
        try:
            target.symlink_to(self.root, target_is_directory=True)
        except OSError:
            self.skipTest("This Windows account cannot create symbolic links")
        with self.assertRaises(manager.PackageError):
            manager.install_pack(self.make_pack(), self.addon)

    def test_modified_file_not_deleted(self):
        manager.install_pack(self.make_pack(), self.addon)
        target = self.addon / "kx47Runtime/models/Test/model.bin"
        target.write_bytes(b"user-modified")
        with self.assertRaises(manager.PackageError):
            manager.uninstall_pack("demo", self.addon)
        self.assertEqual(target.read_bytes(), b"user-modified")

    def test_upgrade_rolls_back_on_write_failure(self):
        model = "kx47Runtime/models/Test/model.bin"
        manager.install_pack(self.make_pack(), self.addon)
        pack = self.make_pack(payload={model: b"updated", "kx47Runtime/models/Test/z.bin": b"later"})
        original_replace = manager.os.replace

        def fail_second(source, target):
            if Path(target).name == "z.bin" and "staged" in Path(source).parts:
                raise OSError("Simulated Windows file lock")
            return original_replace(source, target)

        with patch.object(manager.os, "replace", side_effect=fail_second), self.assertRaises(OSError):
            manager.install_pack(pack, self.addon)
        self.assertEqual((self.addon / model).read_bytes(), b"model")
        self.assertFalse((self.addon / "kx47Runtime/models/Test/z.bin").exists())
        manager.uninstall_pack("demo", self.addon)

    def test_crash_journal_recovers_previous_files_and_state(self):
        model = "kx47Runtime/models/Test/model.bin"
        manager.install_pack(self.make_pack(), self.addon)
        state = manager._state(self.addon)
        old = state["packs"]["demo"]["files"]
        directory = self.addon / ".dordiai-pack-crash"
        backup = directory / "backup" / model
        backup.parent.mkdir(parents=True)
        target = self.addon / model
        target.replace(backup)
        target.write_bytes(b"updated-before-crash")
        created = "kx47Runtime/models/Test/new.bin"
        (self.addon / created).write_bytes(b"new")
        new = {model: {"sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "size_bytes": target.stat().st_size},
               created: {"sha256": hashlib.sha256(b"new").hexdigest(), "size_bytes": 3}}
        manager._begin_transaction(self.addon, directory, state, old, new)
        manager._state_path(self.addon).with_name(".resource-install.lock").write_text("123456789")
        with patch.object(manager, "_process_alive", return_value=False):
            with manager._locked(self.addon):
                self.assertEqual(target.read_bytes(), b"model")
                self.assertFalse((self.addon / created).exists())
                self.assertFalse(manager._journal_path(self.addon).exists())
                self.assertFalse(directory.exists())
        self.assertEqual(manager._state(self.addon), state)

    def test_transaction_recovery_normalizes_relative_root(self):
        try:
            relative = Path(os.path.relpath(self.addon, Path.cwd()))
        except ValueError:
            self.skipTest("Temporary directory is on another Windows drive")
        directory = self.addon / ".dordiai-pack-relative"
        directory.mkdir()
        state = {"format_version": 1, "packs": {}}
        manager._begin_transaction(self.addon, directory, state, {}, {})
        with manager._locked(relative):
            self.assertFalse(manager._journal_path(self.addon).exists())
            self.assertFalse(directory.exists())
        self.assertEqual(manager._state(self.addon), state)

    def test_excluded_voice_resource_rejected(self):
        for name in ["kx47Runtime/models/voices/inna.npy", "kx47Runtime/models/WideLanguages/navigation/he/vira.pcm"]:
            with self.subTest(name=name), self.assertRaises(manager.PackageError):
                manager.inspect_pack(self.make_pack(payload={name: b"voice"}))


if __name__ == "__main__":
    unittest.main()
