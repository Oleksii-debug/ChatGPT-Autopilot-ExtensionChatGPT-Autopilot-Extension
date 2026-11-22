from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import subprocess
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
sys.path.insert(0, str(RUNTIME))
import numpy as np
import converted_voices
import native_multilingual
import reference_voices
import ukrainian_voices
import voice_assets
import voice_packages

spec_preferences = importlib.util.spec_from_file_location("test_voice_package_preferences", RUNTIME / "preferences.py")
preferences = importlib.util.module_from_spec(spec_preferences)
spec_preferences.loader.exec_module(preferences)

spec = importlib.util.spec_from_file_location("voice_package_fixture_cli", ROOT / "tools/voice_packages.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class InstalledVoiceAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.references = self.base / "voices"
        (self.references / "native_profiles").mkdir(parents=True)
        (self.references / "native_profiles/delivery.json").write_text("{}", encoding="utf-8")
        self.source = self.base / "prepared"
        self.source.mkdir()
        np.save(self.source / "holos.npy", np.full((1, 256), .25, dtype=np.float32))
        np.save(self.source / "target.npy", np.full((1, 256, 1), .5, dtype=np.float32))
        np.savez(self.source / "english.npz", state_offset=np.array([2], np.int64),
                 state_cache_0=np.ones((2, 1, 3, 8, 4), np.float32))
        (self.source / "native_delivery.json").write_text('{"en":{"tempo":1.0}}', encoding="utf-8")
        self.roles = {"holos.npy": "holos_profile", "target.npy": "target_embedding",
                      "english.npz": "pocket_english_state", "native_delivery.json": "native_delivery"}
        self.recipe = {
            "voice_id": "fresh_voice", "name": "Fresh voice", "version": "1.0.0",
            "engine": {"id": "holos", "compatibility_version": 1},
            "languages": ["uk", "en-US", "ru"],
            "provenance": {"source": "Test synthetic vectors", "license": "CC0-1.0"},
            "roles": self.roles,
        }
        self.package = self.base / "fresh.dordiai-voice"
        voice_assets.clear_cache()
        self.addCleanup(voice_assets.clear_cache)

    def install(self):
        document = cli.prepare_manifest(self.source, **self.recipe)
        voice_packages.create_package(self.source, document, self.package)
        return voice_assets.install_voice_package(self.package, self.references,
                                                  engine_id=self.recipe["engine"]["id"])

    def test_imported_profile_reaches_holos_and_conversion_adapters(self):
        installed = self.install()
        self.assertEqual(list(voice_assets.discover_voices(self.references, "holos")), ["fresh_voice"])
        holos = object.__new__(ukrainian_voices.UkrainianVoices)
        holos.references = self.references
        self.assertTrue(np.all(holos._holos_style("fresh_voice") == .25))
        converted = converted_voices.ConvertedVoices(self.base / "models", self.references)
        self.assertTrue(np.all(converted._reference("fresh_voice") == .5))
        self.assertEqual(voice_assets.asset_path(self.references, "fresh_voice", "holos_profile"), installed / "holos.npy")
        self.assertTrue(voice_assets.supports_language(self.references, "fresh_voice", "en"))
        self.assertTrue(voice_assets.supports_language(self.references, "fresh_voice", "en-US"))
        self.assertFalse(voice_assets.supports_language(self.references, "fresh_voice", "en-GB"))
        self.assertFalse(voice_assets.supports_language(self.references, "fresh_voice", "fr"))

    def test_native_english_loads_new_profile_state_without_changing_engine_code(self):
        self.install()
        engine = native_multilingual.NativeMultilingual(self.base / "models", self.references / "native_profiles")
        engine.__dict__["english"] = SimpleNamespace(flow_states=[{"name": "state_offset"}, {"name": "state_cache_0"}])
        state = engine.english_state("fresh_voice")
        self.assertEqual(state["state_offset"].tolist(), [2])
        self.assertEqual(state["state_cache_0"].shape, (2, 1, 3, 8, 4))
        self.assertTrue(engine.available("fresh_voice", "en-US", "Read this word"))
        self.assertFalse(engine.available("fresh_voice", "en-GB", "Read this word"))
        self.assertFalse(engine.available("fresh_voice", "ru", "Текст"), "No native Russian prompt was supplied")
        self.assertEqual(engine.settings["fresh_voice"]["en"]["tempo"], 1.0)

    def test_wide_conversion_uses_same_imported_target_identity(self):
        self.install()
        piper = ModuleType("piper")
        piper.PiperVoice = type("PiperVoice", (), {})
        piper.SynthesisConfig = type("SynthesisConfig", (), {})
        piper_config = ModuleType("piper.config")
        piper_config.PiperConfig = type("PiperConfig", (), {})
        spec = importlib.util.spec_from_file_location("test_native_locale_adapter", RUNTIME / "native_locale.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"piper": piper, "piper.config": piper_config}):
            spec.loader.exec_module(module)
        engine = object.__new__(module.NativeLocaleVoices)
        engine.references = self.references / "classmate_locales"
        value = engine.target_profile("fresh_voice")
        self.assertEqual(value.shape, (1, 256, 1))
        self.assertTrue(np.all(value == .5))

    def test_missing_required_profile_cannot_borrow_a_legacy_speaker(self):
        del self.roles["target.npy"]
        self.install()
        converted = converted_voices.ConvertedVoices(self.base / "models", self.references)
        with self.assertRaisesRegex(voice_packages.PackageError, "target_embedding"):
            converted._reference("fresh_voice")

    def test_modified_asset_is_rejected_on_first_use(self):
        directory = self.install()
        path = directory / "holos.npy"
        data = bytearray(path.read_bytes())
        data[-1] ^= 1
        path.write_bytes(data)
        with self.assertRaisesRegex(voice_packages.PackageError, "checksum"):
            voice_assets.asset_path(self.references, "fresh_voice", "holos_profile")

    def test_missing_installed_asset_cannot_silently_fall_back_to_legacy_profile(self):
        directory = self.install()
        (directory / "holos.npy").unlink()
        voice_assets.clear_cache()
        with self.assertRaisesRegex(voice_packages.PackageError, "unavailable"):
            voice_assets.asset_path(self.references, "fresh_voice", "holos_profile")

    def test_adapter_rejects_unimplemented_styles_and_incompatible_engine(self):
        document = cli.prepare_manifest(self.source, **self.recipe)
        document["styles"] = ["neutral", "happy"]
        voice_packages.create_package(self.source, document, self.package)
        with self.assertRaisesRegex(voice_packages.PackageError, "neutral"):
            voice_assets.install_voice_package(self.package, self.references)
        document["styles"] = ["neutral"]
        document["engine"] = {"id": "openvoice", "compatibility_version": 1}
        voice_packages.create_package(self.source, document, self.package)
        with self.assertRaisesRegex(voice_packages.PackageError, "incompatible"):
            voice_assets.install_voice_package(self.package, self.references, engine_id="holos")

    def test_omnivoice_receives_imported_reference_audio_and_transcript(self):
        (self.source / "reference.wav").write_bytes(b"test audio supplied to stub engine")
        (self.source / "reference.txt").write_text("Prepared voice transcript", encoding="utf-8")
        self.recipe["engine"] = {"id": "omnivoice", "compatibility_version": 1}
        self.recipe["roles"] = {"reference.wav": "reference_audio", "reference.txt": "reference_text"}
        directory = self.install()
        calls = []

        class FakeEngine:
            sampling_rate = 1000

            def create_voice_clone_prompt(self, **kwargs):
                calls.append(kwargs)
                return "prepared-prompt"

            def generate(self, **kwargs):
                return [np.ones(200, np.float32)]

        engine = reference_voices.ReferenceVoices(self.base / "models", self.references)
        engine.__dict__["engine"] = FakeEngine()
        audio, rate = engine.synthesize("fresh_voice", "en", "Example")
        self.assertEqual(rate, 1000)
        self.assertEqual(len(audio), 200)
        self.assertEqual(calls, [{"ref_audio": str(directory / "reference.wav"),
                                  "ref_text": "Prepared voice transcript"}])

    def test_settings_dispatch_installs_lists_and_removes_a_voice_archive(self):
        document = cli.prepare_manifest(self.source, **self.recipe)
        voice_packages.create_package(self.source, document, self.package)
        result = preferences.install_extra_package(self.package, self.base,
                                                     references=self.references, engine_id="holos")
        self.assertEqual(result["kind"], "voice")
        entries = preferences.list_extra_packages(self.base, references=self.references)
        self.assertEqual([(entry["kind"], entry["id"]) for entry in entries], [("voice", "fresh_voice")])
        preferences.remove_extra_package(entries[0], self.base, references=self.references)
        self.assertEqual(preferences.list_extra_packages(self.base, references=self.references), [])
        self.assertFalse((voice_assets.package_root(self.references) / "fresh_voice").exists())

    def test_settings_rejects_ambiguous_archive_type(self):
        import zipfile
        with zipfile.ZipFile(self.package, "w") as archive:
            archive.writestr("voice-package.json", "{}")
            archive.writestr("dordiai-resource-pack.json", "{}")
        with self.assertRaises(ValueError):
            preferences.install_extra_package(self.package, self.base, references=self.references)

    def test_activation_api_returns_to_previous_imported_version(self):
        self.install()
        self.recipe["version"] = "1.1.0"
        self.install()
        self.assertEqual(len(voice_assets.voice_versions(self.references, "fresh_voice")), 2)
        voice_assets.activate_voice_version(self.references, "fresh_voice", "1.0.0", engine_id="holos")
        self.assertEqual(voice_assets.discover_voices(self.references)["fresh_voice"]["version"], "1.0.0")

    def test_nvda_helpers_load_by_filename_without_changing_sys_path(self):
        code = (
            "import importlib.util,sys; before=list(sys.path); "
            + "p=" + repr(str(RUNTIME / "voice_assets.py")) + "; "
            + "s=importlib.util.spec_from_file_location('_test_nvda_voice_assets',p); "
            + "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
            + "assert list(sys.path)==before; assert m.ENGINE_ADAPTERS['holos']==1; print('OK')"
        )
        output = subprocess.check_output([sys.executable, "-I", "-c", code], text=True)
        self.assertEqual(output.strip(), "OK")


if __name__ == "__main__":
    unittest.main()
