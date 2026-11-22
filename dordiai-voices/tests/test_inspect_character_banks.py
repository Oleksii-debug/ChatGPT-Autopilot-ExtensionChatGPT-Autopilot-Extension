"""Actual-source metadata audit contracts; fixtures contain NO playable audio."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bank_metadata_audit", ROOT / "tools/inspect_character_banks.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)
SOURCE = (ROOT / "source/0.12.2/synthDrivers/kx47Preview.py").read_text(encoding="utf-8")
ALPHABET = {code: tool.letters(SOURCE, variable) for code, variable in
            (("uk", "UK_LETTERS"), ("ru", "RU_LETTERS"), ("en-us", "EN_LETTERS"))}


class CompleteProbeMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def core(self, *, raw_period=False, russian_number=False, number_command=False, wrapped_command=False, bad_names=False):
        path = self.root / ("core-" + str(len(list(self.root.iterdir()))) + ".zip")
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(tool.DRIVER, SOURCE)
            archive.writestr(tool.PREFIX + "catalog.json", '{"sara":"Synthetic audit fixture"}')
            for language, mapping in ALPHABET.items():
                code = language.split("-")[0]
                document = {"format": "dordiai-character-name-sources", "format_version": 1,
                            "language": code, "symbol_names": {".": {"uk": "крапка", "ru": "точка", "en": "period"}[code]}}
                if bad_names and code == "uk":
                    document["letter_names"] = []
                archive.writestr("kx47Runtime/models/CharacterNames/" + code + ".json", json.dumps(document))
                labels = list(mapping.values()) + [{"uk": "пробіл", "ru": "пробел", "en": "space"}[code]]
                if language == "uk":
                    labels += list("0123456789")
                for label in labels:
                    archive.writestr(tool.PREFIX + "navigation/sara/" + tool.digest(language, label, nfc=False) + ".wav",
                                     b"metadata presence only; NOT audio")
            if raw_period:
                archive.writestr(tool.PREFIX + "navigation/sara/" + tool.digest("uk", ".", nfc=False) + ".wav",
                                 b"old glyph-key metadata only")
            if russian_number:
                archive.writestr(tool.PREFIX + "navigation/sara/" + tool.digest("ru", "1", nfc=False) + ".wav",
                                 b"Russian legacy numeric metadata only")
            if number_command:
                index = {tool.digest("ru", "1"): [0, 2]}
                if wrapped_command:
                    index = {"format": "dordiai-voice-bank", "format_version": 1, "voice_id": "sara",
                             "kind": "commands", "sample_rate": 24000, "channels": 1, "sample_width": 2,
                             "complete": True, "entries": index}
                archive.writestr(tool.PREFIX + "native_commands/sara.json", json.dumps(index))
                archive.writestr(tool.PREFIX + "native_commands/sara.pcm", b"\x01\x00")
        return path

    def test_full176_counts_include_digits_symbols_and_spaces_without_audio_claim(self):
        report = tool.inspect(self.core(), ["sara"])
        self.assertEqual(report["aggregate"], {"requests": 176, "prepared_candidates": 105, "live_worker_candidates": 71,
            "letter": 92, "digit": 30, "space": 3, "symbol": 51, "number_policy_bypasses": 20})
        self.assertEqual(len(report["profiles"][0]["letters"]), 92)
        self.assertEqual(len(report["profiles"][0]["probe_rows"]), 176)
        self.assertFalse(report["physical_or_nvda_latency_verified"])
        self.assertFalse(report["wav_headers_or_pcm_quality_verified"])

    def test_actual_symbol_label_does_not_borrow_raw_glyph_recording(self):
        report = tool.inspect(self.core(raw_period=True), ["sara"])
        row = next(row for row in report["profiles"][0]["probe_rows"] if row["language"] == "uk" and row["glyph"] == ".")
        self.assertEqual((row["kind"], row["text"]), ("character", "крапка"))
        self.assertTrue(row["diagnostic_raw_glyph_navigation_present"])
        self.assertFalse(row["prepared_candidate"])

    def test_russian_number_policy_bypasses_legacy_wav_but_verified_command_role_wins_first(self):
        for command in (False, True):
            with self.subTest(command=command):
                report = tool.inspect(self.core(russian_number=True, number_command=command), ["sara"])
                row = next(row for row in report["profiles"][0]["probe_rows"] if row["language"] == "ru" and row["glyph"] == "1")
                self.assertEqual(row["kind"], "text")
                self.assertTrue(row["navigation_presence"]["navigation"])
                self.assertEqual(row["prepared_candidate"], command)
                self.assertEqual(row["metadata_candidate"], "native_commands" if command else "live-worker")
                self.assertEqual(row["legacy_cache_bypass"], None if command else "legacy-number-language-rule")

    def test_builtin_core_does_not_unwrap_managed_package_header(self):
        report = tool.inspect(self.core(number_command=True, wrapped_command=True), ["sara"])
        row = next(row for row in report["profiles"][0]["probe_rows"] if row["language"] == "ru" and row["glyph"] == "1")
        self.assertFalse(row["native_commands_valid_bounds"])
        self.assertFalse(row["prepared_candidate"])
        self.assertEqual(row["legacy_cache_bypass"], "legacy-number-language-rule")

    def test_nfc_bank_key_and_legacy_navigation_key_are_not_conflated(self):
        text = "e\u0301"
        composed_key = tool.digest("uk", "é")
        names = {tool.PREFIX + "navigation/sara/" + composed_key + ".wav": object()}
        banks = {"letters": ({}, 0), "commands": ({}, 0)}
        row = tool.probe_coverage("sara", "uk", "@", "character", text, "symbol", "fixture", banks, names)
        self.assertNotEqual(row["bank_key"], row["navigation_key"])
        self.assertFalse(row["prepared_candidate"])
        banks["letters"] = ({composed_key: [0, 2]}, 2)
        row = tool.probe_coverage("sara", "uk", "@", "character", text, "symbol", "fixture", banks, names)
        self.assertEqual(row["metadata_candidate"], "native_letters")

    def test_native_profile_and_native_english_text_cache_order_is_explicit(self):
        key = tool.digest("en-us", "?", nfc=False)
        names = {tool.PREFIX + "navigation_native/sara/" + key + ".wav": object()}
        banks = {"letters": ({}, 0), "commands": ({}, 0)}
        first = tool.probe_coverage("sara", "en-us", "?", "text", "?", "symbol", "fixture", banks, names)
        second = tool.probe_coverage("sara", "en-us", "?", "text", "?", "symbol", "fixture", banks, names,
                                     native_profiles=False)
        self.assertFalse(first["prepared_candidate"])
        self.assertEqual(second["metadata_candidate"], "navigation_native")

    def test_malformed_other_character_name_field_cannot_false_attest_symbol_route(self):
        with self.assertRaises(ValueError):
            tool.inspect(self.core(bad_names=True), ["sara"])

    def test_changed_driver_semantics_are_rejected_before_claiming_exact_route(self):
        changed = SOURCE.replace("def core_character_units(", "def different_units(", 1)
        with self.assertRaises(ValueError):
            tool.semantics(changed)

    def test_actual_embedded_probe_alphabets_and_extra_glyphs_are_read_without_execution(self):
        extra, source = tool.actual_probe_extra(ROOT / "tools/windows_nvda_probe.py", ALPHABET)
        self.assertTrue(source["verified"])
        self.assertEqual(len(extra), 28)
        self.assertEqual(sum(map(len, ALPHABET.values())) + 3 * len(extra), 176)


if __name__ == "__main__":
    unittest.main()
