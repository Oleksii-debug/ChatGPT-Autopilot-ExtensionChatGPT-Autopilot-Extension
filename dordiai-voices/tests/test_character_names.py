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

    def test_ambiguous_primary_source_row_stays_open(self):
        directory = ROOT / "source/0.12.2/kx47Runtime/models/CharacterNames"
        record = names.data("ay", directory)
        self.assertFalse(record["ordinary_alphabet_source_complete"])
        self.assertIn("qh", record["curation_exclusions"])
        with self.assertRaises(LookupError):
            names.spoken_name("ay", "qh", directory=directory)


if __name__ == "__main__":
    unittest.main()
