"""Prepared PCM package/driver integration; model calls are explicitly stubbed."""
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import numpy as np

from nvda_stubs import driver_module

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
sys.path.insert(0, str(RUNTIME))
import voice_assets
import voice_packages


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


banks = load("_test_prepare_voice_banks", ROOT / "tools/prepare_voice_banks.py")
probe = load("_test_bank_worker_probe", ROOT / "tools/windows_engine_probe.py")
cli = load("_test_bank_voice_cli", ROOT / "tools/voice_packages.py")
bank_reader = load("_test_native_letter_bank", ROOT / "source/0.12.2/synthDrivers/_dordiai_letter_bank.py")


class FakeWorker:
    """Produces recognizable nonzero PCM to test delivery, not speech quality."""
    def __init__(self):
        self.requests = []

    def render(self, request, timeout):
        self.requests.append(request)
        value = 120 if request["character"] else 240
        pcm = struct.pack("<hhh", value, -value, 0) * 100
        return pcm, {"renderers": [{"profile": request["profile"]}], "first_pcm_ms": 1.0}


class PreparedVoiceBanksTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.references = self.base / "installed-voices"
        self.prepared = self.base / "prepared"
        self.prepared.mkdir()
        np.save(self.prepared / "profile.npy", np.ones((1, 256), np.float32))
        self.recipe = {"voice_id": "fresh_voice", "version": "1.0.0", "name": "Fresh voice",
                       "engine": {"id": "holos", "compatibility_version": 1},
                       "languages": ["uk", "en-US"],
                       "provenance": {"source": "Synthetic fixture", "license": "CC0-1.0"},
                       "roles": {"profile.npy": "holos_profile"}}
        self.entries = [{"language": "uk", "kind": "letter", "name": "бе", "text": "бе"},
                        {"language": "en", "kind": "letter", "name": "bee", "text": "bee"},
                        {"language": "en", "kind": "command", "name": "Save", "text": "Save"}]
        self.worker = FakeWorker()
        roles, _ = banks.generate_banks(self.worker, probe, "fresh_voice", self.entries, self.prepared / "banks")
        self.recipe["roles"].update({"banks/" + name: role for name, role in roles.items()})
        self.package = self.base / "fresh.dordiai-voice"
        voice_assets.clear_cache()
        self.addCleanup(voice_assets.clear_cache)

    def install(self):
        document = cli.prepare_manifest(self.prepared, **self.recipe)
        voice_packages.create_package(self.prepared, document, self.package)
        return voice_assets.install_voice_package(self.package, self.references, engine_id="holos")

    def test_packaged_nonzero_letter_and_command_banks_keep_the_requested_identity(self):
        self.install()
        reader = bank_reader.NativeLetterBank(self.references)
        expected = struct.pack("<hhh", 120, -120, 0) * 100
        self.assertEqual(reader.read("fresh_voice", "uk", "БЕ"), expected)
        self.assertEqual(reader.read("fresh_voice", "en", "bee"), expected)
        self.assertEqual(reader.read("fresh_voice", "en-US", "bee"), expected)
        commands = bank_reader.NativeLetterBank(self.references, "native_commands")
        self.assertEqual(commands.read("fresh_voice", "en", "Save"), struct.pack("<hhh", 240, -240, 0) * 100)
        self.assertIsNone(reader.read("another_voice", "uk", "бе"))
        self.assertIsNone(reader.read("fresh_voice", "ru", "бэ"))
        self.assertTrue(all(request["profile"] == "fresh_voice" for request in self.worker.requests))
        self.assertTrue(self.worker.requests[1]["nativeProfile"])
        self.assertFalse(self.worker.requests[1].get("wideLocale", False))

    def test_driver_fast_clip_uses_core_letter_pcm_without_starting_worker(self):
        self.install()
        with driver_module() as driver:
            worker = driver.SpeechWorker(sys.executable, "unused.py", self.base / "models",
                                         (self.base / "models/Holos", self.references, "holos"))
            request = probe.make_request("uk", "fresh_voice", "бе")
            request["character"] = True
            pcm = worker.fast_clip(request)
            self.assertEqual(pcm, struct.pack("<hhh", 120, -120, 0) * 100)
            self.assertIsNone(worker._process)
            command = probe.make_request("en", "fresh_voice", "Save")
            self.assertEqual(worker.fast_clip(command), struct.pack("<hhh", 240, -240, 0) * 100)
            self.assertIsNone(worker._process)
            with self.assertRaises(ValueError):
                worker.fast_clip({**request, "profile": "kostia"})

    def test_driver_checks_spoken_foreign_letter_name_before_raw_cache_key(self):
        self.entries = [{"language": "fr", "kind": "letter", "name": "bé", "text": "bé"}]
        target = self.prepared / "other-banks"
        roles, _ = banks.generate_banks(self.worker, probe, "fresh_voice", self.entries, target)
        self.recipe["roles"] = {"profile.npy": "holos_profile", **{"other-banks/" + key: value for key, value in roles.items()}}
        self.recipe["languages"] = ["fr"]
        self.install()
        with driver_module() as driver:
            worker = driver.SpeechWorker(sys.executable, "unused.py", self.base / "models",
                                         (self.base / "models/Holos", self.references, "holos"))
            request = probe.make_request("fr", "fresh_voice", "bé")
            request.update(character=True, letterCacheText="B", nativeLocale=True)
            self.assertEqual(worker.fast_clip(request), struct.pack("<hhh", 120, -120, 0) * 100)

    def test_managed_index_cannot_claim_another_voice_or_wrong_pcm_format(self):
        path = self.prepared / "banks/letters.json"
        original = json.loads(path.read_text(encoding="utf-8"))
        for index, (key, value) in enumerate((("voice_id", "another_voice"), ("sample_rate", 22050), ("complete", False))):
            with self.subTest(key=key):
                document = {**original, key: value}
                path.write_text(json.dumps(document), encoding="utf-8")
                self.recipe["version"] = "1.0." + str(index)
                self.install()
                reader = bank_reader.NativeLetterBank(self.references)
                with self.assertRaises(ValueError):
                    reader.read("fresh_voice", "uk", "бе")

    def test_missing_half_of_managed_bank_is_rejected_before_activation(self):
        self.recipe["roles"].pop("banks/letters.pcm")
        document = cli.prepare_manifest(self.prepared, **self.recipe)
        voice_packages.create_package(self.prepared, document, self.package)
        with self.assertRaisesRegex(ValueError, "both index and audio"):
            voice_assets.install_voice_package(self.package, self.references)

    def test_profile_export_and_bank_preparation_do_not_mutate_installed_version(self):
        installed = self.install()
        original = {str(path.relative_to(installed)): sha256(path.read_bytes()).hexdigest()
                    for path in installed.rglob("*") if path.is_file()}
        runtime = self.base / "runtime"
        (runtime / "models").mkdir(parents=True)
        # The reusable export helper receives the same installed references
        # through a tiny facade; no model process or filesystem junction is used.
        assets = type("Assets", (), {
            "_profile": staticmethod(lambda refs, profile: voice_assets._profile(self.references, profile)),
            "_packages": voice_packages,
        })
        exported = self.base / "new-prepared-source"
        exported.mkdir()
        recipe = banks.copy_profile_source(runtime, assets, "fresh_voice", exported, version="1.1.0")
        self.assertEqual(recipe["version"], "1.1.0")
        self.assertEqual(set(recipe["roles"].values()), {"holos_profile"})
        roles, _ = banks.generate_banks(FakeWorker(), probe, "fresh_voice", self.entries, exported / "banks")
        recipe["roles"].update({"banks/" + name: role for name, role in roles.items()})
        cli.prepare_manifest(exported, **recipe)
        self.assertEqual(original, {str(path.relative_to(installed)): sha256(path.read_bytes()).hexdigest()
                                   for path in installed.rglob("*") if path.is_file()})

    def test_default_letter_names_are_taken_from_actual_driver_and_foreign_map(self):
        values = banks.default_letter_entries(RUNTIME, ["uk", "en-GB", "fr"])
        self.assertTrue(any(row["language"] == "uk" and row["name"] == "бе" for row in values))
        self.assertTrue(any(row["language"] == "en-gb" and row["name"] == "zed" for row in values))
        self.assertFalse(any(row["language"] == "en-gb" and row["name"] == "zee" for row in values))
        self.assertTrue(any(row["language"] == "fr" and row["name"] == "bé" for row in values))
        self.assertEqual(bank_reader.bank_key("fr", "e\u0301"), banks.entry_key("fr", "é"))

    def test_silent_and_wrong_speaker_generated_audio_is_not_packaged(self):
        class SilentWorker:
            def render(self, request, timeout):
                return bytes(240), {"renderers": [{"profile": request["profile"]}]}
        with self.assertRaisesRegex(ValueError, "silence"):
            banks.generate_banks(SilentWorker(), probe, "fresh_voice", self.entries, self.base / "silent")
        class WrongSpeaker(FakeWorker):
            def render(self, request, timeout):
                pcm, result = super().render(request, timeout)
                result["renderers"] = [{"profile": "another_voice"}]
                return pcm, result
        with self.assertRaisesRegex(ValueError, "another voice"):
            banks.generate_banks(WrongSpeaker(), probe, "fresh_voice", self.entries, self.base / "wrong-speaker")

    def test_reviewed_spoken_name_is_literal_speech_with_two_lookup_keys_one_pcm(self):
        class LiteralNamesOnly(FakeWorker):
            def render(self,request,timeout):
                if request["character"]:
                    raise ValueError("No glyph-to-name mapping is installed")
                self.assert_text=request["text"]
                return super().render(request,timeout)
        worker=LiteralNamesOnly()
        jobs=[{"kind":"letter","language":"en","lookup_text":"b","text":"bee",
               "semantic_kind":"spoken_name","aliases":["bee"],
               "source_kind":"letter_name","source_id":"reviewed-fixture"}]
        output=self.base/"reviewed-names"
        roles,_=banks.generate_banks(worker,probe,"fresh_voice",jobs,output)
        self.assertEqual(len(worker.requests),1)
        self.assertFalse(worker.requests[0]["character"])
        self.assertEqual(worker.assert_text,"bee")
        index=json.loads((output/"letters.json").read_text(encoding="utf-8"))
        self.assertEqual(index["kind"],"letters")
        self.assertEqual(index["entries"][banks.entry_key("en","b")],
                         index["entries"][banks.entry_key("en","bee")])
        self.assertEqual((output/"letters.pcm").stat().st_size,600)
        self.assertEqual(roles["letters.pcm"],"native_letters_audio")

    def test_unreviewed_raw_glyph_keeps_character_mode_and_is_not_guessed(self):
        class NoVerifiedNames(FakeWorker):
            def render(self,request,timeout):
                self.requests.append(request)
                if request["character"]:
                    raise ValueError("Verified character name is not installed")
                return super().render(request,timeout)
        worker=NoVerifiedNames()
        jobs=[{"kind":"letter","language":"ha","lookup_text":"ɓ","text":"ɓ"}]
        with self.assertRaisesRegex(ValueError,"Verified character name"):
            banks.generate_banks(worker,probe,"fresh_voice",jobs,self.base/"unreviewed-glyph")
        self.assertTrue(worker.requests[0]["character"])
        self.assertEqual(worker.requests[0]["text"],"ɓ")

    def test_phonetic_descriptions_and_conflicting_name_aliases_are_not_ordinary_names(self):
        with self.assertRaisesRegex(ValueError,"phonetic description"):
            banks.validate_entries([{"kind":"letter","language":"en","lookup_text":"a","text":"Alfa",
                                     "semantic_kind":"spoken_name","source_kind":"phonetic_description"}])
        with self.assertRaisesRegex(ValueError,"alias conflicts"):
            banks.validate_entries([
                {"kind":"letter","language":"en","lookup_text":"b","text":"bee","semantic_kind":"spoken_name"},
                {"kind":"letter","language":"en","lookup_text":"c","text":"see","semantic_kind":"spoken_name"},
                {"kind":"letter","language":"en","lookup_text":"b","text":"bee","semantic_kind":"spoken_name","aliases":["c"]},
            ])
        for key in ("kind","semantic_kind"):
            with self.subTest(malformed=key),self.assertRaises(ValueError):
                banks.validate_entries([{"kind":"letter","language":"en","text":"b",key:[]}])

    def test_primary_source_document_uses_only_explicit_reviewed_jobs(self):
        document={"format":"dordiai-character-name-sources","format_version":1,"language":"en",
                  "bank_entries":[{"kind":"letter","language":"en","lookup_text":"b","text":"bee",
                                   "semantic_kind":"spoken_name","source_kind":"letter_name"}],
                  "phonetic_descriptions":{"a":"Alfa"},"missing_ordinary_letter_names":["a"]}
        rows=banks.load_entries_document(document)
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]["lookup_text"],"b")
        self.assertEqual(rows[0]["semantic_kind"],"spoken_name")
        for override in ({"format":"unknown"},{"format_version":True},{"format_version":2},{"language":"ha"}):
            with self.subTest(override=override),self.assertRaises(ValueError):
                banks.load_entries_document({**document,**override})


if __name__ == "__main__":
    unittest.main()
