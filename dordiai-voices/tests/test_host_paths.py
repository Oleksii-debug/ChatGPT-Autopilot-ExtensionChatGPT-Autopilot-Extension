"""Namespace-safe host roots and real same-ID replacement on long Windows paths.

No speech models, NVDA audio or cloning are exercised. Windows tests use actual
data-only packages and PCM; an actual NVDA-host diagnostic is still required
to establish the executable-manifest boundary.
"""
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

from nvda_stubs import driver_module

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
sys.path.insert(0, str(RUNTIME))
import host_paths
import voice_assets
import voice_packages

_cli_spec = importlib.util.spec_from_file_location("_host_path_test_voice_cli", ROOT / "tools/voice_packages.py")
voice_cli = importlib.util.module_from_spec(_cli_spec)
_cli_spec.loader.exec_module(voice_cli)


def load_bank():
    spec = importlib.util.spec_from_file_location("_host_path_test_letter_bank",
        ROOT / "source/0.12.2/synthDrivers/_dordiai_letter_bank.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class HostPathSpellingTests(unittest.TestCase):
    def test_nonwindows_paths_keep_existing_spelling(self):
        with patch.object(host_paths, "_WINDOWS", False):
            self.assertEqual(host_paths.filesystem_path("relative/folder"), Path("relative/folder"))

    def test_windows_drive_unc_and_existing_namespace_use_shared_pure_function(self):
        with patch.object(host_paths, "_WINDOWS", True):
            cases = ((r"C:\voices\..\voices\data", r"\\?\C:\voices\data"),
                     (r"\\server\share\voices", r"\\?\UNC\server\share\voices"),
                     (r"\\?\C:\voices\data", r"\\?\C:\voices\data"))
            for original, expected in cases:
                with self.subTest(original=original):
                    self.assertEqual(str(host_paths.filesystem_path(original)), expected)

    def test_normalization_never_changes_host_import_dll_or_interpreter_state(self):
        module = host_paths._windows_paths()
        original_path, original_executable, original_cwd = list(sys.path), sys.executable, os.getcwd()
        with patch.object(host_paths, "_WINDOWS", True), \
             patch.object(module, "configure_worker_import_paths", side_effect=AssertionError("Host import path mutation")), \
             patch.object(module, "reset_inherited_dll_directory", side_effect=AssertionError("Host DLL directory mutation")):
            value = host_paths.filesystem_path(r"C:\voices\data")
        self.assertEqual(str(value), r"\\?\C:\voices\data")
        self.assertEqual(sys.path, original_path)
        self.assertEqual(sys.executable, original_executable)
        self.assertEqual(os.getcwd(), original_cwd)

    def test_bytes_are_not_silently_reinterpreted_as_host_paths(self):
        with self.assertRaises(TypeError):
            host_paths.filesystem_path(b"C:\\voices")


@unittest.skipUnless(os.name == "nt", "Actual Windows long-path identity requires Windows")
class LongWindowsVoiceIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="dordiai-host-root-")
        self.addCleanup(self.temporary.cleanup)
        self.base = host_paths.filesystem_path(self.temporary.name)
        self.long = self.base
        while len(str(self.long)) < 350:
            self.long = self.long / ("мовні_дані_" + "x" * 28)
        self.references = self.long / "models/voices"
        self.references.mkdir(parents=True)
        self.addCleanup(lambda: shutil.rmtree(self.base, ignore_errors=False) if self.base.exists() else None)
        self.plain_references = str(self.references)[4:]  # TemporaryDirectory is a local drive.
        self.assertGreater(len(self.plain_references), 300)
        self.bank = load_bank()
        self.context = driver_module()
        self.driver = self.context.__enter__()
        self.addCleanup(lambda: self.context.__exit__(None, None, None))
        self.addCleanup(self.driver.close_shared_worker)
        self.addCleanup(voice_assets.clear_cache)
        self.old_pcm = struct.pack("<hhh", 100, -100, 0) * 100
        self.new_pcm = struct.pack("<hhh", 900, -900, 0) * 100
        directory = self.references / "native_letters"
        directory.mkdir()
        key = self.bank.bank_key("uk", "бе")
        (directory / "viktoriia.json").write_text(json.dumps({key: [0, len(self.old_pcm)]}), encoding="utf-8")
        (directory / "viktoriia.pcm").write_bytes(self.old_pcm)
        self.request = {"mode": "reference", "profile": "viktoriia", "language": "uk",
                        "text": "бе", "character": True, "speed": 1.,
                        "controls": {"pitch": 50, "timbre": 50, "volume": 100}}

    def worker(self):
        return self.driver.SpeechWorker(sys.executable, "must-not-run.py", self.long / "models",
            (self.long / "models/Holos", self.plain_references, "holos"))

    def install(self, version, bank=False):
        source = self.base / ("prepared-" + version)
        source.mkdir()
        # Valid synthetic NPY v1, not a model or a learned speaker claim.
        header = "{'descr': '<f4', 'fortran_order': False, 'shape': (1, 256), }"
        header += " " * ((16 - (10 + len(header) + 1) % 16) % 16) + "\n"
        (source / "identity.npy").write_bytes(b"\x93NUMPY\x01\x00" + struct.pack("<H", len(header))
                                                + header.encode("ascii") + struct.pack("<256f", *([.9] * 256)))
        roles = {"identity.npy": "holos_profile"}
        if bank:
            document = {"format": "dordiai-voice-bank", "format_version": 1, "voice_id": "viktoriia",
                        "kind": "letters", "sample_rate": 24000, "channels": 1, "sample_width": 2,
                        "complete": True, "entries": {self.bank.bank_key("uk", "бе"): [0, len(self.new_pcm)]}}
            (source / "letters.json").write_text(json.dumps(document), encoding="utf-8")
            (source / "letters.pcm").write_bytes(self.new_pcm)
            roles.update({"letters.json": "native_letters_index", "letters.pcm": "native_letters_audio"})
        manifest = voice_cli.prepare_manifest(source, voice_id="viktoriia", name="Synthetic replacement",
            version=version, engine={"id": "holos", "compatibility_version": 1}, languages=["uk"],
            provenance={"source": "Explicit synthetic namespace/identity fixture", "license": "CC0-1.0"}, roles=roles)
        archive = self.base / (version + ".dordiai-voice")
        voice_packages.create_package(source, manifest, archive)
        return voice_assets.install_voice_package(archive, self.references, engine_id="holos")

    def test_long_builtin_bank_is_read_from_plain_caller_root_without_model_startup(self):
        reader = self.bank.NativeLetterBank(self.plain_references)
        self.assertTrue(str(reader.references).startswith("\\\\?\\"))
        self.assertTrue(os.path.samefile(reader.references, self.references))
        self.assertEqual(reader.read("viktoriia", "uk", "бе"), self.old_pcm)
        worker = self.worker()
        self.assertTrue(str(worker._references).startswith("\\\\?\\"))
        with patch.object(self.driver.subprocess, "Popen", side_effect=AssertionError("Prepared glyph spawned model")):
            self.assertEqual(worker.fast_clip(self.request), self.old_pcm)

    def test_long_same_id_package_blocks_legacy_pcm_and_rotates_active_version(self):
        reader = self.bank.NativeLetterBank(self.plain_references)
        old_worker = self.worker()
        self.assertEqual(reader.read("viktoriia", "uk", "бе"), self.old_pcm)
        old_worker._remember_clip(old_worker._epoch_clip_key(self.request), self.old_pcm)
        installed = self.install("1.0.0")
        self.assertGreater(len(str(installed)), 300)
        self.assertEqual(self.driver._resource_epoch(self.plain_references),
                         self.driver._resource_epoch(self.references))
        with self.assertRaises(RuntimeError):
            old_worker.fast_clip(self.request)
        # Optional bank absence must never borrow old built-in PCM of same ID.
        self.assertIsNone(reader.read("viktoriia", "uk", "бе"))
        fresh = self.worker()
        with patch.object(self.driver.subprocess, "Popen", side_effect=AssertionError("Metadata check spawned model")):
            self.assertIsNone(fresh.fast_clip(self.request))
        self.install("1.0.1", bank=True)
        with self.assertRaises(RuntimeError):
            fresh.fast_clip(self.request)
        newest = self.worker()
        self.assertEqual(newest.fast_clip(self.request), self.new_pcm)
        self.assertEqual(reader.read("viktoriia", "uk", "бе"), self.new_pcm)

    def test_external_absolute_runtime_config_keeps_long_python_and_models_accessible(self):
        runtime = self.base / "external-config"
        runtime.mkdir()
        python = self.long / "private/python.exe"
        python.parent.mkdir(parents=True)
        python.write_bytes(b"filesystem-only fixture; never executed")
        models = self.long / "models"
        config = {"python": str(python)[4:], "models": str(models)[4:],
                  "referenceModel": str(models / "Holos")[4:], "referenceSamples": self.plain_references}
        (runtime / "local-runtime.json").write_text(json.dumps(config), encoding="utf-8")
        with patch.object(self.driver, "RUNTIME", runtime):
            configured = self.driver.SynthDriver._runtime_config()
        self.assertIsNotNone(configured)
        self.assertTrue(str(configured[0]).startswith("\\\\?\\"))
        self.assertTrue(str(configured[1]).startswith("\\\\?\\"))
        self.assertTrue(os.path.samefile(configured[0], python))
        self.assertTrue(os.path.samefile(configured[1], models))
        config["python"] = "relative-python.exe"
        (runtime / "local-runtime.json").write_text(json.dumps(config), encoding="utf-8")
        with patch.object(self.driver, "RUNTIME", runtime):
            self.assertIsNone(self.driver.SynthDriver._runtime_config())


if __name__ == "__main__":
    unittest.main()
