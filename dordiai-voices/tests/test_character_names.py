"""Native name semantics and primary dictionary parsing, without synthesizing audio."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

names = load("names_under_test", ROOT / "source/0.12.2/kx47Runtime/character_names.py")
prep = load("names_preparation_under_test", ROOT / "tools/prepare_character_names.py")
audit = load("names_coverage_under_test", ROOT / "tools/audit_character_names.py")


class CharacterNameTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        record = {"format": "dordiai-character-name-sources", "format_version": 1, "language": "xx",
                  "letter_names": {}, "symbol_names": {"!": "native exclamation name"},
                  "phonetic_descriptions": {"a": ["native phonetic example"]}, "exemplar_units": ["a"],
                  "letter_names_ready": False}
        self.directory.joinpath("xx.json").write_text(json.dumps(record))
        names.clear_cache()

    def tearDown(self):
        names.clear_cache()
        self.temporary.cleanup()

    def test_phonetic_description_is_never_used_as_ordinary_letter_name(self):
        with self.assertRaises(LookupError):
            names.spoken_name("xx", "a", directory=self.directory)
        self.assertEqual(names.spoken_name("xx", "a", mode="phonetic", directory=self.directory), "native phonetic example")

    def test_explicit_symbol_name_can_be_rendered_as_literal_text(self):
        self.assertEqual(names.spoken_name("xx", "!", directory=self.directory), "native exclamation name")
        self.assertFalse(names.letter_names_ready("xx", self.directory))

    def test_explicitly_sourced_vowel_name_can_equal_its_glyph(self):
        path = self.directory / "xx.json"
        record = json.loads(path.read_text())
        record["letter_names"] = {"а": "а"}
        path.write_text(json.dumps(record))
        self.assertEqual(names.spoken_name("xx", "а", directory=self.directory), "а")

    def test_unknown_locale_does_not_fall_back_to_english(self):
        with self.assertRaises(LookupError):
            names.spoken_name("yy", "!", directory=self.directory)

    def test_language_path_traversal_is_rejected(self):
        with self.assertRaises(LookupError):
            names.spoken_name("../xx", "!", directory=self.directory)

    def test_empty_and_raw_glyph_descriptions_do_not_become_names(self):
        result, _ = prep.phonetic_descriptions("a\ta\nb\tBravo\n")
        self.assertNotIn("a", result)
        self.assertEqual(result["b"], ["Bravo"])

    def test_nvda_complex_symbols_and_inherited_defaults_are_not_literal_names(self):
        text = "complexSymbols:\nphrase\t.+\nsymbols:\nphrase\tphrase description\n!\tname\tall\n?\t-\n\\#\thash\n"
        result = prep.nvda_symbols(text)
        self.assertEqual(result, {"!": "name", "#": "hash"})

    def test_cldr_exemplars_preserve_digraphs_but_do_not_make_names(self):
        self.assertEqual(prep.exemplar_units("[a-c {ch} \\-]"), ["a", "b", "c", "ch", "-"])

    def test_cldr_annotations_only_supply_explicit_symbol_tts_names(self):
        raw = {"annotations": {"annotations": {"!": {"tts": ["bang"]}, "a": {"tts": ["alpha"]},
                                                   "?": {"tts": ["↑↑↑"]}}}}
        self.assertEqual(prep.cldr_symbols(raw), {"!": "bang"})

    def test_supplementary_emoji_and_bounded_sequences_are_symbol_names(self):
        values = {"😀": "native grin name", "👩‍💻": "native technologist name", "1️⃣": "native keycap one name",
                  "A": "not an alphabet-name source", "1": "not a digit-name source",
                  "x\u200dy": "not an emoji sequence", "😀\u202e": "bad bidi control", "😀" * 17: "too long"}
        document = {"annotations": {"annotations": {key: {"tts": [text]} for key, text in values.items()}}}
        result = prep.cldr_symbols(document)
        self.assertEqual(set(result), {"😀", "👩‍💻", "1️⃣"})

    def test_default_bank_budget_does_not_remove_runtime_symbol_inventory(self):
        mapping = {chr(0x1F600 + index): "native name " + str(index) for index in range(40)}
        selected = prep.symbol_bank_keys(mapping, {}, budget=4)
        self.assertEqual(len(selected), 4)
        self.assertIn("😀", selected)
        self.assertEqual(len(mapping), 40)

    def test_symbol_name_alias_collision_never_overwrites_glyph_keys(self):
        rows = [{"lookup_text": "→", "text": "Flecha derecha", "aliases": ["Flecha derecha"]},
                {"lookup_text": "🡺", "text": "flecha derecha", "aliases": ["flecha derecha"]}]
        conflicts = prep.disambiguate_bank_aliases(rows)
        self.assertEqual([row["lookup_text"] for row in rows], ["→", "🡺"])
        self.assertEqual(rows[1]["text"], "flecha derecha")
        self.assertEqual(rows[1]["aliases"], [])
        self.assertEqual(conflicts[0]["conflicts_with_lookup"], "→")

    def test_prepared_core_emoji_use_same_language_labels_and_symbol_semantics(self):
        directory = ROOT / "source/0.12.2/kx47Runtime/models/CharacterNames"
        for code, label in (("uk", "широко всміхнене обличчя"), ("en", "grinning face")):
            record = names.data(code, directory)
            self.assertEqual(names.spoken_name(code, "😀", directory=directory), label)
            self.assertNotIn("😀", record["letter_names"])
            rows = [row for row in record["bank_entries"] if row["lookup_text"] == "😀"]
            self.assertEqual(rows[0]["source_kind"], "symbol_name")
            self.assertEqual(rows[0]["semantic_kind"], "spoken_name")
            self.assertLessEqual(record["symbol_bank_preparation"]["symbol_jobs_scheduled"], 512)
            self.assertGreater(record["symbol_bank_preparation"]["symbol_jobs_pending_budget"], 0)

    def test_primary_romansh_names_are_names_not_phonetic_examples(self):
        directory = ROOT / "source/0.12.2/kx47Runtime/models/CharacterNames"
        record = names.data("rm", directory)
        self.assertTrue(record["ordinary_alphabet_source_complete"])
        self.assertEqual(len(record["ordinary_alphabet_source_repertoire"]), 26)
        self.assertEqual(names.spoken_name("rm", "B", directory=directory), "be")
        self.assertEqual(names.spoken_name("rm", "w", directory=directory), "ve dubel")
        # A source-complete table does not assert native audio/typing acceptance.
        self.assertFalse(names.letter_names_ready("rm", directory))
        entries = [entry for entry in record["bank_entries"] if entry["lookup_text"] == "B"]
        self.assertEqual(entries[0]["semantic_kind"], "spoken_name")
        self.assertEqual(entries[0]["source_id"], "curated_primary_alphabet_names")

    def test_documented_digraph_names_preserve_case_aliases(self):
        directory = ROOT / "source/0.12.2/kx47Runtime/models/CharacterNames"
        for glyph in ("sh", "Sh", "SH"):
            self.assertEqual(names.spoken_name("ha", glyph, directory=directory), "sha")

    def test_aymara_aspirate_name_resolved_by_independent_primary_table(self):
        directory = ROOT / "source/0.12.2/kx47Runtime/models/CharacterNames"
        record = names.data("ay", directory)
        self.assertTrue(record["ordinary_alphabet_source_complete"])
        self.assertEqual(len(record["ordinary_alphabet_source_repertoire"]), 32)
        self.assertNotIn("qh", record.get("curation_exclusions", {}))
        self.assertEqual(names.spoken_name("ay", "qh", directory=directory), "qha")
        self.assertEqual(names.spoken_name("ay", "q", directory=directory), "qa")
        self.assertFalse(names.letter_names_ready("ay", directory))

    def test_ordinary_names_are_native_for_new_european_scripts(self):
        directory = ROOT / "source/0.12.2/kx47Runtime/models/CharacterNames"
        for language, glyph, name in (("es", "Ñ", "eñe"), ("pl", "Ł", "eł"),
                                      ("el", "ς", "σίγμα"), ("fi", "š", "hattu-äs"),
                                      ("it", "W", "doppia vu"), ("pt", "ç", "cê cedilhado")):
            self.assertEqual(names.spoken_name(language, glyph, directory=directory), name)
            self.assertFalse(names.letter_names_ready(language, directory))

    def test_regional_name_alternatives_are_not_foreign_fallbacks(self):
        directory = ROOT / "source/0.12.2/kx47Runtime/models/CharacterNames"
        record = names.data("es", directory)
        self.assertIn("i griega", record["ordinary_letter_name_alternatives"]["y"])
        self.assertEqual(names.spoken_name("es", "y", directory=directory), "ye")

    def test_audit_separates_shared_continents_resources_and_audio_acceptance(self):
        path = self.directory / "inventory.json"
        path.write_text(json.dumps({"languages": [{"id": "xx", "name_uk": "Приклад",
            "resources_present": True, "regions": ["Європа", "Південна Америка"]}]}), encoding="utf-8")
        result = audit.audit(path, self.directory)
        self.assertEqual(result["summary"]["selected"], 1)
        self.assertEqual(result["regions"]["Європа"]["selected"], 1)
        self.assertEqual(result["regions"]["Південна Америка"]["selected"], 1)
        self.assertEqual(result["summary"]["missing_curated_ordinary_source_tables"], 1)
        self.assertFalse(result["languages"][0]["full_native_pronunciation_accepted"])

    def test_audit_rejects_language_path_traversal(self):
        path = self.directory / "inventory.json"
        path.write_text(json.dumps({"languages": [{"id": "../secret", "name_uk": "Приклад"}]}), encoding="utf-8")
        with self.assertRaises(ValueError):
            audit.audit(path, self.directory)

    def test_audit_does_not_call_legacy_german_and_french_unsupported(self):
        path = self.directory / "inventory.json"
        path.write_text(json.dumps({"languages": [
            {"id": "de", "name_uk": "Німецька", "resources_present": True, "regions": ["Європа"]},
            {"id": "fr", "name_uk": "Французька", "resources_present": True, "regions": ["Європа"]},
        ]}), encoding="utf-8")
        result = audit.audit(path, self.directory, ROOT / "source/0.12.2/kx47Runtime")
        self.assertEqual(result["summary"]["missing_curated_ordinary_source_tables"], 2)
        self.assertEqual(result["summary"]["identified_explicit_mapping_tables"], 2)
        self.assertEqual(result["summary"]["no_identified_explicit_mapping_table"], 0)
        german, french = result["languages"]
        self.assertEqual(german["legacy_project_samples"]["b"], "beh")
        self.assertEqual(french["legacy_project_samples"]["b"], "bé")
        self.assertFalse(french["nvda_typing_accepted_by_this_audit"])

    def test_engine_spelling_candidate_is_separate_from_name_table_and_quality(self):
        path = self.directory / "inventory.json"
        path.write_text(json.dumps({"languages": [
            {"id": "sr", "name_uk": "Сербська", "resources_present": True,
             "backend": "espeak+voice-conversion", "regions": ["Європа"]},
            {"id": "cs", "name_uk": "Чеська", "resources_present": True,
             "backend": "shared-neural+voice-conversion", "regions": ["Європа"]},
        ]}), encoding="utf-8")
        result = audit.audit(path, self.directory, ROOT / "source/0.12.2/kx47Runtime")
        self.assertEqual(result["summary"]["identified_explicit_mapping_tables"], 0)
        self.assertEqual(result["summary"]["engine_spelling_candidates_with_resources"], 2)
        for row in result["languages"]:
            self.assertFalse(row["known_ordinary_name_mapping_present"])
            self.assertTrue(row["engine_native_spelling_candidate"])
            self.assertFalse(row["engine_native_name_semantics_verified_by_this_audit"])
            self.assertFalse(row["nvda_typing_accepted_by_this_audit"])


if __name__ == "__main__":
    unittest.main()
