"""Removal fault recovery; these tests do not claim physical NVDA acceptance."""
import json
import mmap
import subprocess
from pathlib import Path
from types import SimpleNamespace
import sys
import types
import unittest
from unittest.mock import MagicMock, patch
import test_voice_packages as fixture
import test_upgrade_packages as migration_fixture
import test_preferences as preferences_fixture

packages = fixture.packages
prefs = preferences_fixture.prefs


class VoicePackageRetentionTests(unittest.TestCase):
    def setUp(self):
        self.case = fixture.VoicePackagesTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.case.build()
        self.directory = packages.install_package(self.case.package, self.case.root)

    def inactive(self):
        index = packages._load_index(self.case.root)
        self.assertEqual(index["format_version"], 2)
        self.assertEqual(index["active"], {})
        self.assertEqual(index["inactive"], {"example_voice": "1.0.0"})
        self.assertEqual(packages.discover_packages(self.case.root), {})
        rows = packages.list_installed_packages(self.case.root)
        self.assertEqual(len(rows), 1)
        self.assertFalse(rows[0]["active"])
        return rows[0]

    @unittest.skipUnless(sys.platform == "win32", "actual Windows mapped-file deletion semantics")
    def test_actual_windows_mapped_asset_retains_ownership_until_handle_closes(self):
        with (self.directory / "profile.npy").open("rb") as stream:
            with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ):
                with self.assertRaises(PermissionError):
                    packages.uninstall_package(self.case.root, "example_voice")
                row = self.inactive()
                self.assertIn(row["status"], ("inactive", "unavailable"))
        packages.uninstall_package(self.case.root, "example_voice")
        self.assertEqual(packages.list_installed_packages(self.case.root), [])
        self.assertFalse(self.directory.parent.exists())

    def test_locked_file_keeps_inactive_ownership_and_successful_retry(self):
        with patch.object(packages.shutil, "rmtree", side_effect=PermissionError("asset is locked")):
            with self.assertRaisesRegex(PermissionError, "asset is locked"):
                packages.uninstall_package(self.case.root, "example_voice")
        self.assertEqual(self.inactive()["status"], "inactive")
        self.assertTrue(self.directory.exists())
        packages.uninstall_package(self.case.root, "example_voice")
        self.assertEqual(packages.list_installed_packages(self.case.root), [])
        self.assertFalse(self.directory.parent.exists())

    def test_partial_delete_retains_retry_without_loading_damaged_voice(self):
        def partial_delete(path):
            (self.directory / packages.MANIFEST_NAME).unlink()
            raise PermissionError("partial delete then lock")
        with patch.object(packages.shutil, "rmtree", side_effect=partial_delete):
            with self.assertRaisesRegex(PermissionError, "partial delete"):
                packages.uninstall_package(self.case.root, "example_voice")
        self.assertEqual(self.inactive()["status"], "unavailable")
        packages.uninstall_package(self.case.root, "example_voice")
        self.assertEqual(packages.list_installed_packages(self.case.root), [])

    def test_failure_before_ownership_commit_never_deletes_or_changes_active(self):
        original = (self.case.root / packages.INDEX_NAME).read_bytes()
        with patch.object(packages, "_write_index", side_effect=OSError("index unavailable")), patch.object(packages.shutil, "rmtree") as remove:
            with self.assertRaisesRegex(OSError, "index unavailable"):
                packages.uninstall_package(self.case.root, "example_voice")
        remove.assert_not_called()
        self.assertEqual((self.case.root / packages.INDEX_NAME).read_bytes(), original)
        self.assertTrue(self.directory.exists())
        self.assertEqual(packages.discover_packages(self.case.root)["example_voice"]["version"], "1.0.0")

    def test_cleanup_commit_failure_leaves_idempotent_retry(self):
        write = packages._write_index
        calls = []
        def commit(root, document):
            calls.append(1)
            if len(calls) == 2:
                raise OSError("cleanup index commit")
            return write(root, document)
        with patch.object(packages, "_write_index", side_effect=commit):
            with self.assertRaisesRegex(OSError, "cleanup index commit"):
                packages.uninstall_package(self.case.root, "example_voice")
        self.assertEqual(self.inactive()["status"], "unavailable")
        self.assertFalse(self.directory.parent.exists())
        packages.uninstall_package(self.case.root, "example_voice")
        self.assertEqual(packages.list_installed_packages(self.case.root), [])

    def test_interrupt_during_delete_has_durable_inactive_ownership(self):
        with patch.object(packages.shutil, "rmtree", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                packages.uninstall_package(self.case.root, "example_voice")
        self.assertEqual(self.inactive()["status"], "inactive")
        packages.uninstall_package(self.case.root, "example_voice")

    def test_abrupt_process_exit_releases_lock_and_retains_cleanup_ownership(self):
        script = (
            "import os,sys; from pathlib import Path; "
            "sys.path.insert(0,sys.argv[1]); import voice_packages as p; "
            "p.shutil.rmtree=lambda path: os._exit(23); "
            "p.uninstall_package(Path(sys.argv[2]),'example_voice')"
        )
        runtime = str(Path(packages.__file__).parent)
        child = subprocess.run([sys.executable, "-c", script, runtime, str(self.case.root)],
                               capture_output=True, timeout=15)
        self.assertEqual(child.returncode, 23, child.stderr.decode(errors="replace"))
        self.assertEqual(self.inactive()["status"], "inactive")
        packages.uninstall_package(self.case.root, "example_voice")
        self.assertEqual(packages.list_installed_packages(self.case.root), [])

    def test_keep_files_and_explicit_verified_reactivation(self):
        packages.uninstall_package(self.case.root, "example_voice", keep_files=True)
        self.assertEqual(self.inactive()["status"], "inactive")
        packages.activate_version(self.case.root, "example_voice", "1.0.0")
        index = packages._load_index(self.case.root)
        self.assertNotIn("example_voice", index.get("inactive", {}))
        self.assertEqual(packages.discover_packages(self.case.root)["example_voice"]["version"], "1.0.0")

    def test_reinstall_clears_retention_only_after_verified_assets(self):
        packages.uninstall_package(self.case.root, "example_voice", keep_files=True)
        packages.install_package(self.case.package, self.case.root)
        self.assertNotIn("example_voice", packages._load_index(self.case.root).get("inactive", {}))
        packages.uninstall_package(self.case.root, "example_voice", keep_files=True)
        (self.directory / "profile.npy").write_bytes(b"damaged")
        with self.assertRaises(packages.PackageError):
            packages.activate_version(self.case.root, "example_voice", "1.0.0")
        self.assertEqual(self.inactive()["status"], "unavailable")

    def test_index_v2_is_incompatible_with_old_writer_and_returns_to_v1_after_cleanup(self):
        packages.uninstall_package(self.case.root, "example_voice", keep_files=True)
        self.assertEqual(packages._load_index(self.case.root)["format_version"], 2)
        # This is the exact legacy v1-only discriminator, not a compatibility
        # claim about running an old driver against the new format.
        self.assertNotEqual(json.loads((self.case.root / packages.INDEX_NAME).read_text())["format_version"], 1)
        packages.uninstall_package(self.case.root, "example_voice")
        self.assertEqual(packages._load_index(self.case.root), {"format_version": 1, "active": {}})

    def test_malformed_or_ambiguous_index_versions_fail_closed(self):
        for document in (
            {"format_version": 1, "active": {}, "inactive": {}},
            {"format_version": 2, "active": {}},
            {"format_version": 3, "active": {}, "inactive": {}},
            {"format_version": True, "active": {}},
            {"format_version": 2.0, "active": {}, "inactive": {}},
        ):
            with self.subTest(document=document):
                (self.case.root / packages.INDEX_NAME).write_text(json.dumps(document))
                with self.assertRaises(packages.PackageError):
                    packages.list_installed_packages(self.case.root)
                self.assertEqual(packages.discover_packages(self.case.root), {})

    def test_untrusted_manifest_cannot_override_administrative_inactive_label(self):
        packages.uninstall_package(self.case.root, "example_voice", keep_files=True)
        manifest_path = self.directory / packages.MANIFEST_NAME
        manifest = json.loads(manifest_path.read_text())
        manifest["active"] = True
        manifest_path.write_text(json.dumps(manifest))
        self.assertFalse(self.inactive()["active"])

    def test_unregistered_directories_are_neither_listed_nor_removed(self):
        foreign = self.case.root / "foreign_data"
        foreign.mkdir()
        (foreign / "keep").write_bytes(b"not our voice")
        self.assertEqual([r["id"] for r in packages.list_installed_packages(self.case.root)], ["example_voice"])
        with self.assertRaisesRegex(packages.PackageError, "not registered"):
            packages.uninstall_package(self.case.root, "foreign_data")
        self.assertEqual((foreign / "keep").read_bytes(), b"not our voice")

    def test_tampered_retained_schema_fails_closed(self):
        from voice_policy import EXCLUDED_VOICE_IDS
        invalid = [[], {"example_voice": "../bad"}, {"../escape": "1.0.0"},
                   {"NUL": "1.0.0"}, {next(iter(EXCLUDED_VOICE_IDS)): "1.0.0"},
                   {"example_voice": "1.0.0"}]
        for inactive in invalid:
            with self.subTest(inactive=inactive):
                (self.case.root / packages.INDEX_NAME).write_text(json.dumps(
                    {"format_version": 2, "active": {"example_voice": "1.0.0"}, "inactive": inactive}))
                with self.assertRaises(packages.PackageError):
                    packages.list_installed_packages(self.case.root)
                self.assertEqual(packages.discover_packages(self.case.root), {})

    def test_symlink_retained_asset_never_activates_or_deletes_target(self):
        packages.uninstall_package(self.case.root, "example_voice", keep_files=True)
        original = self.directory.parent
        moved = self.case.base / "outside"
        original.rename(moved)
        try:
            original.symlink_to(moved, target_is_directory=True)
        except OSError:
            self.skipTest("symlinks unavailable")
        self.assertEqual(self.inactive()["status"], "unavailable")
        with self.assertRaises(packages.PackageError):
            packages.uninstall_package(self.case.root, "example_voice")
        self.assertTrue((moved / "1.0.0/profile.npy").exists())

    def test_actual_dialog_labels_inactive_retention_and_dispatches_retry_remove(self):
        packages.uninstall_package(self.case.root, "example_voice", keep_files=True)
        entries = [{**self.inactive(), "kind": "voice"}]
        wx = MagicMock()
        wx.YES = 1
        gui = types.ModuleType("gui")
        gui.guiHelper = SimpleNamespace()
        dialogs = []
        gui.mainFrame = SimpleNamespace(popupSettingsDialog=dialogs.append)
        gui.messageBox = MagicMock(return_value=wx.YES)
        settings = types.ModuleType("gui.settingsDialogs")
        settings.SettingsDialog = type("SettingsDialog", (), {})
        driver = SimpleNamespace(description="fixture")
        with patch.dict(sys.modules, {"wx": wx, "gui": gui, "gui.settingsDialogs": settings,
                "synthDriverHandler": SimpleNamespace(getSynth=lambda: driver)}):
            prefs.open_dialog(driver)
            dialog = dialogs[0].__new__(dialogs[0])
            dialog._package_busy = False
            dialog.packages = MagicMock()
            dialog.packages.GetSelection.return_value = 0
            dialog.remove_package = MagicMock()
            dialog.rollback_package = MagicMock()
            dialog.package_status = MagicMock()
            dialog._package_root = lambda: self.case.root
            dialog._voice_reference_root = lambda: self.case.root.parent
            with patch.object(prefs, "list_extra_packages", return_value=entries):
                dialog._refresh_packages()
            self.assertIn("неактивний", dialog.packages.SetItems.call_args.args[0][0])
            dialog.remove_package.Enable.assert_called_with(True)
            operations = []
            dialog._run_package_operation = lambda status, callback: operations.append(callback)
            dialog._remove_package(None)
            with patch.object(prefs, "remove_extra_package") as remove:
                operations.pop()()
            remove.assert_called_once_with(entries[0], self.case.root, references=self.case.root.parent)
            # An inactive voice has no current active version to exclude.
            # Its sole retained version must therefore be selectable.
            dialog.synth = driver
            wx.ID_OK = 42
            wx.SingleChoiceDialog.return_value.__enter__.return_value.ShowModal.return_value = 42
            wx.SingleChoiceDialog.return_value.__enter__.return_value.GetSelection.return_value = 0
            assets = SimpleNamespace(
                voice_versions=lambda references, identity: packages.installed_versions(self.case.root, identity),
                activate_voice_version=MagicMock())
            with patch.object(prefs, "_package_component", return_value=assets):
                dialog._rollback_voice_package(None)
                operations.pop()()
            self.assertEqual(wx.SingleChoiceDialog.call_args.args[3], ["1.0.0"])
            assets.activate_voice_version.assert_called_once_with(
                self.case.root.parent, "example_voice", "1.0.0", engine_id="holos")


class RetainedVoiceUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.case = migration_fixture.UpgradePackagesTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.voice = self.case.voice()
        self.old_root = self.voice.parent.parent

    def test_inactive_verified_versions_and_ownership_survive_core_upgrade(self):
        packages.uninstall_package(self.old_root, "new_voice", keep_files=True)
        old_bytes = (self.old_root / packages.INDEX_NAME).read_bytes()
        result = migration_fixture.upgrade.migrate_installed_packages(self.case.old, self.case.new)
        new_root = self.case.new / "kx47Runtime/models/voices/packages"
        self.assertEqual(result["voice_versions"], 1)
        self.assertEqual(packages._load_index(new_root)["inactive"], {"new_voice": "1.0.0"})
        self.assertEqual(packages.discover_packages(new_root), {})
        self.assertEqual(packages.list_installed_packages(new_root)[0]["status"], "inactive")
        self.assertEqual((self.old_root / packages.INDEX_NAME).read_bytes(), old_bytes)

    def test_empty_retained_cleanup_record_survives_upgrade_and_can_be_removed(self):
        packages.uninstall_package(self.old_root, "new_voice", keep_files=True)
        packages.shutil.rmtree(self.voice.parent)
        migration_fixture.upgrade.migrate_installed_packages(self.case.old, self.case.new)
        new_root = self.case.new / "kx47Runtime/models/voices/packages"
        self.assertEqual(packages.list_installed_packages(new_root)[0]["status"], "unavailable")
        packages.uninstall_package(new_root, "new_voice")
        self.assertEqual(packages.list_installed_packages(new_root), [])

    def test_old_inactive_cannot_override_new_active_voice(self):
        packages.uninstall_package(self.old_root, "new_voice", keep_files=True)
        new_root = self.case.new / "kx47Runtime/models/voices/packages"
        new_root.mkdir(parents=True)
        packages._write_index(new_root, {"format_version": 1, "active": {"new_voice": "2.0.0"}})
        original = (new_root / packages.INDEX_NAME).read_bytes()
        with self.assertRaisesRegex(migration_fixture.upgrade.UpgradeError, "Конфлікт"):
            migration_fixture.upgrade.migrate_installed_packages(self.case.old, self.case.new)
        self.assertEqual((new_root / packages.INDEX_NAME).read_bytes(), original)

    def test_old_active_cannot_override_new_inactive_ownership(self):
        new_root = self.case.new / "kx47Runtime/models/voices/packages"
        new_root.mkdir(parents=True)
        packages._write_index(new_root, {"format_version": 1, "active": {},
                                        "inactive": {"new_voice": "1.0.0"}})
        original = (new_root / packages.INDEX_NAME).read_bytes()
        with self.assertRaisesRegex(migration_fixture.upgrade.UpgradeError, "Конфлікт"):
            migration_fixture.upgrade.migrate_installed_packages(self.case.old, self.case.new)
        self.assertEqual((new_root / packages.INDEX_NAME).read_bytes(), original)

    def test_partial_retained_data_blocks_upgrade_before_copy_or_index_changes(self):
        packages.uninstall_package(self.old_root, "new_voice", keep_files=True)
        (self.voice / "profile.npy").unlink()
        before = (self.old_root / packages.INDEX_NAME).read_bytes()
        with self.assertRaises((ValueError, OSError)):
            migration_fixture.upgrade.migrate_installed_packages(self.case.old, self.case.new)
        self.assertEqual((self.old_root / packages.INDEX_NAME).read_bytes(), before)
        self.assertFalse((self.case.new / "kx47Runtime/models/voices/packages" / packages.INDEX_NAME).exists())
        self.assertEqual(packages.list_installed_packages(self.old_root)[0]["status"], "unavailable")


class FreshInstallOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.case = fixture.VoicePackagesTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.case.build()
        self.final = self.case.root / "example_voice/1.0.0"

    def assert_inactive_owned(self, status="inactive"):
        index = packages._load_index(self.case.root)
        self.assertEqual(index["format_version"], 2)
        self.assertEqual(index["active"], {})
        self.assertEqual(index["inactive"], {"example_voice": "1.0.0"})
        self.assertEqual(packages.discover_packages(self.case.root), {})
        rows = packages.list_installed_packages(self.case.root)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], status)
        self.assertFalse(rows[0]["active"])

    def fail_activation(self, root, document):
        if document["active"].get("example_voice"):
            raise OSError("activation index commit failed")
        return self.original_write(root, document)

    def test_initial_ownership_commit_failure_leaves_no_promoted_or_staged_files(self):
        with patch.object(packages, "_write_index", side_effect=OSError("initial ownership commit")):
            with self.assertRaisesRegex(OSError, "initial ownership commit"):
                packages.install_package(self.case.package, self.case.root)
        self.assertFalse(self.final.exists())
        self.assertFalse(list(self.case.root.glob(".voice-install-*")))
        self.assertFalse((self.case.root / packages.INDEX_NAME).exists())
        self.assertEqual(packages.list_installed_packages(self.case.root), [])

    def test_promotion_failure_retains_owned_unavailable_row_and_allows_install_retry(self):
        self.assert_promotion_failure_and_retry()

    def assert_promotion_failure_and_retry(self):
        replace = packages.os.replace
        canonical_final = self.final.resolve()
        blocked = []
        def fail_promotion(source, destination):
            if Path(destination).resolve() == canonical_final:
                self.assertTrue(Path(source).name.startswith(".voice-install-"))
                blocked.append((str(source), str(destination)))
                raise PermissionError("promotion blocked")
            return replace(source, destination)
        with patch.object(packages.os, "replace", side_effect=fail_promotion):
            with self.assertRaisesRegex(PermissionError, "promotion blocked"):
                packages.install_package(self.case.package, self.case.root)
        self.assertEqual(len(blocked), 1, "The actual owned promotion must receive the injected fault")
        self.assertFalse(self.final.exists())
        self.assertFalse(list(self.case.root.glob(".voice-install-*")))
        self.assert_inactive_owned("unavailable")
        packages.install_package(self.case.package, self.case.root)
        self.assertEqual(packages.discover_packages(self.case.root)["example_voice"]["version"], "1.0.0")
        self.assertNotIn("inactive", packages._load_index(self.case.root))

    def test_promotion_fault_matches_the_owned_destination_through_a_root_alias(self):
        self.case.root.mkdir()
        alias = self.case.base / "installed-alias"
        try:
            alias.symlink_to(self.case.root, target_is_directory=True)
        except OSError:
            self.skipTest("directory aliases unavailable")
        self.case.root = alias
        self.final = alias / "example_voice/1.0.0"
        self.assert_promotion_failure_and_retry()

    def test_final_activation_commit_failure_keeps_promoted_files_listed_for_retry(self):
        self.original_write = packages._write_index
        with patch.object(packages, "_write_index", side_effect=self.fail_activation):
            with self.assertRaisesRegex(OSError, "activation index commit"):
                packages.install_package(self.case.package, self.case.root)
        self.assertTrue(self.final.is_dir())
        self.assertEqual((self.final / "profile.npy").read_bytes(), b"prepared vector data")
        self.assert_inactive_owned()
        packages.install_package(self.case.package, self.case.root)
        self.assertEqual(packages.discover_packages(self.case.root)["example_voice"]["version"], "1.0.0")
        self.assertNotIn("inactive", packages._load_index(self.case.root))

    def test_promoted_inactive_fresh_install_can_be_removed_without_reimport(self):
        self.original_write = packages._write_index
        with patch.object(packages, "_write_index", side_effect=self.fail_activation):
            with self.assertRaises(OSError):
                packages.install_package(self.case.package, self.case.root)
        self.assert_inactive_owned()
        packages.uninstall_package(self.case.root, "example_voice")
        self.assertEqual(packages.list_installed_packages(self.case.root), [])
        self.assertFalse(self.final.parent.exists())

    def test_abrupt_exit_after_promotion_keeps_durable_inactive_ownership_and_retry(self):
        script = '''import os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import voice_packages as p
original = p._write_index
def commit(root, document):
    if document["active"].get("example_voice"):
        os._exit(24)
    return original(root, document)
p._write_index = commit
p.install_package(Path(sys.argv[2]), Path(sys.argv[3]))
'''
        child = subprocess.run([sys.executable, "-c", script, str(Path(packages.__file__).parent),
                                str(self.case.package), str(self.case.root)], capture_output=True, timeout=15)
        self.assertEqual(child.returncode, 24, child.stderr.decode(errors="replace"))
        self.assertTrue(self.final.is_dir())
        self.assert_inactive_owned()
        packages.install_package(self.case.package, self.case.root)
        self.assertEqual(packages.discover_packages(self.case.root)["example_voice"]["version"], "1.0.0")

    def test_failed_upgrade_keeps_original_active_version_and_bytes_untouched(self):
        packages.install_package(self.case.package, self.case.root)
        old_index = (self.case.root / packages.INDEX_NAME).read_bytes()
        old_files = {path.name: path.read_bytes() for path in self.final.iterdir()}
        self.case.manifest["version"] = "2.0.0"
        self.case.build()
        with patch.object(packages, "_write_index", side_effect=OSError("upgrade activation failed")) as commits:
            with self.assertRaisesRegex(OSError, "upgrade activation failed"):
                packages.install_package(self.case.package, self.case.root)
        commits.assert_called_once()
        self.assertEqual((self.case.root / packages.INDEX_NAME).read_bytes(), old_index)
        self.assertEqual({path.name: path.read_bytes() for path in self.final.iterdir()}, old_files)
        self.assertEqual(packages.discover_packages(self.case.root)["example_voice"]["version"], "1.0.0")
        self.assertTrue((self.final.parent / "2.0.0").is_dir())
        packages.activate_version(self.case.root, "example_voice", "2.0.0")
        self.assertEqual(packages.discover_packages(self.case.root)["example_voice"]["version"], "2.0.0")

    def test_failed_upgrade_of_already_inactive_id_keeps_ownership_of_entire_subtree(self):
        self.original_write = packages._write_index
        with patch.object(packages, "_write_index", side_effect=self.fail_activation):
            with self.assertRaises(OSError):
                packages.install_package(self.case.package, self.case.root)
        self.case.manifest["version"] = "2.0.0"
        self.case.build()
        with patch.object(packages, "_write_index", side_effect=OSError("upgrade activation failed")) as commits:
            with self.assertRaises(OSError):
                packages.install_package(self.case.package, self.case.root)
        commits.assert_called_once()
        self.assert_inactive_owned()
        packages.uninstall_package(self.case.root, "example_voice")
        self.assertFalse(self.final.parent.exists())

    def test_unverified_payload_never_receives_inactive_ownership(self):
        import zipfile
        with zipfile.ZipFile(self.case.package, "w") as archive:
            archive.writestr(packages.MANIFEST_NAME, json.dumps(self.case.manifest))
            archive.writestr("profile.npy", b"X" * len(b"prepared vector data"))
        with self.assertRaisesRegex(packages.PackageError, "checksum"):
            packages.install_package(self.case.package, self.case.root)
        self.assertFalse(self.final.exists())
        self.assertFalse((self.case.root / packages.INDEX_NAME).exists())
