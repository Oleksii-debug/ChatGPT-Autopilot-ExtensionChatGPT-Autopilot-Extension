"""Source parser/integrity tests only; real corpus counts require acquisition CI."""
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("native_morphology_acquisition", ROOT/"tools/acquire_morphological_words.py")
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)


class MorphologySourceTests(unittest.TestCase):
    def test_ukrainian_cyrillic_acute_is_removed_after_nfc_casefold(self):
        self.assertEqual(source.normalize_word("МО́ВИ"), "мови")
        self.assertEqual(source.normalize_word("УКРАЇ́НСЬКОЮ"), "українською")

    def test_russian_yo_is_preserved_and_never_merged_with_e(self):
        self.assertEqual(source.normalize_word("СЁ́МГА"), "сёмга")
        self.assertNotEqual(source.normalize_word("СЁМГА"), source.normalize_word("СЕМГА"))
        self.assertEqual(source.normalize_word("Е\u0308ЛКА"), "ёлка")

    def test_latin_diacritics_survive_normalization_and_are_not_cyrillic_evidence(self):
        self.assertEqual(source.normalize_word("CAFE\u0301"), "café")
        self.assertEqual(source.normalize_word("KŮŇ"), "kůň")
        self.assertFalse(source.native_cyrillic_word("café"))

    def test_apostrophe_spellings_are_canonicalized_without_dropping_the_letter(self):
        values = [source.normalize_word(word) for word in ("п'ять", "п’ять", "пʼять", "П‘ЯТЬ")]
        self.assertEqual(set(values), {"п'ять"})

    def test_single_word_filter_rejects_multiword_and_foreign_script_tokens(self):
        self.assertTrue(source.native_cyrillic_word("будь-який"))
        self.assertTrue(source.native_cyrillic_word("м'ята"))
        for word in ("", "два слова", "DVD", "слів/слова", "-слово", "слово-", "а"*97):
            self.assertFalse(source.native_cyrillic_word(word), word)

    def test_visual_full_forms_are_not_only_lemmas_or_frequency_observations(self):
        # Same publisher's pinned doc/example_indented.txt format.
        records = list(source.vesum_records([
            "заавансованість noun:inanim:f:v_naz\n",
            "  заавансованості noun:inanim:f:v_rod\n",
            "  заавансованости noun:inanim:f:v_rod:alt\n",
        ]))
        self.assertEqual(records, [("заавансованість", False, False),
            ("заавансованості", True, False), ("заавансованости", True, False)])
        words, counts, sample = source.collect_records(records, "uk", {"заавансованість": 1})
        self.assertEqual(len(words), 3)
        self.assertEqual(counts["non_initial_forms"], 2)
        self.assertEqual(set(sample), {"заавансованості", "заавансованости"})

    def test_bad_analysis_is_excluded_but_good_duplicate_can_attest_same_spelling(self):
        records = list(source.vesum_records([
            "тест noun:bad\n", "  тесту noun:v_rod\n",
            "тест noun:v_naz\n", "  тесту noun:v_rod:alt\n",
            "помилковий adj:err\n",
        ]))
        words, counts, sample = source.collect_records(records, "uk", {})
        self.assertEqual(words, {"тест", "тесту"})
        self.assertEqual(counts["excluded_bad_analysis"], 3)
        self.assertEqual(sample, ["тесту"])

    def test_russian_reader_enumerates_only_stored_exact_records(self):
        class Dictionary:
            def iteritems(self):
                yield "КОШКА", (23, 0)
                yield "КОШКАМИ", (23, 7)
        self.assertEqual(list(source.russian_records(Dictionary())),
                         [("кошка", False, False), ("кошками", True, False)])
        self.assertFalse(hasattr(Dictionary(), "parse"))

    def test_unknown_russian_record_shape_is_rejected(self):
        class Dictionary:
            def iteritems(self):
                yield "пример", (1, 2, 3)
        with self.assertRaises(ValueError):
            list(source.russian_records(Dictionary()))

    def test_stable_sample_is_source_wide_and_excludes_existing_frequency_words(self):
        values = ["форм"+chr(1072+i) for i in range(12)]
        one, two = source.StableSample("uk", {"форма"}, 3), source.StableSample("uk", {"форма"}, 3)
        for word in values:
            one.offer(word)
        for word in reversed(values):
            two.offer(word)
        self.assertEqual(one.words(), two.words())
        self.assertNotIn("форма", one.words())
        self.assertEqual(len(one.words()), 3)

    def test_word_files_are_deterministic_sorted_and_hash_expanded_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            one = source.write_words(root/"one.gz", {"бета", "альфа", "м'ята"})
            two = source.write_words(root/"two.gz", {"м'ята", "альфа", "бета"})
            self.assertEqual(one["sha256"], two["sha256"])
            expected = "альфа\nбета\nм'ята\n".encode()
            self.assertEqual(gzip.decompress((root/"one.gz").read_bytes()), expected)
            self.assertEqual(one["expanded_sha256"], hashlib.sha256(expected).hexdigest())

    def test_changed_primary_payload_is_rejected_before_any_source_file_is_written(self):
        class Response(io.BytesIO):
            def geturl(self):
                return "https://files.pythonhosted.org/pinned.whl"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"source.whl"
            with patch.object(source.urllib.request, "urlopen", return_value=Response(b"abc")):
                with self.assertRaises(ValueError):
                    source.download("https://files.pythonhosted.org/pinned.whl", path,
                                    size=3, digest="0"*64)
            self.assertFalse(path.exists())

    def test_non_primary_url_and_oversized_source_are_rejected_without_network(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(source.urllib.request, "urlopen") as request:
            for url, size in (("http://github.com/test", 3), ("https://example.org/test", 3),
                              ("https://github.com/test", source.MAX_SOURCE_BYTES+1)):
                with self.assertRaises(ValueError):
                    source.download(url, Path(directory)/"source", size=size)
            request.assert_not_called()

    def test_existing_frequency_resource_is_identified_as_finite_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"baseline.gz"
            with gzip.open(path, "wt", encoding="utf-8") as stream:
                json.dump({"format":"dordiai-cyrillic-lexicon-v1","codes":["uk","ru"],
                           "words":{"спільне":3,"окреме":1}}, stream)
            words, receipt = source.load_frequency(path)
            self.assertEqual(words["спільне"], 3)
            self.assertTrue(receipt["available"])
            self.assertIn("not native morphology", receipt["scope"])


if __name__ == "__main__":
    unittest.main()
