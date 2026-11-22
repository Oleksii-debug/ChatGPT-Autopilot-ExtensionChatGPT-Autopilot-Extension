"""Differential Unicode/validation controls for the separate unpromoted fast path."""
from hashlib import sha1
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ORIGINAL_PATH = ROOT/"experiments/native-word-cache/native_word_membership.py"
CANDIDATE_PATH = ROOT/"experiments/native-word-unicode-fast/native_word_membership.py"
ORIGINAL = load("unicode_unchanged_baseline_test", ORIGINAL_PATH)
CANDIDATE = load("unicode_unpromoted_fast_test", CANDIDATE_PATH)
AUDIT = load("unicode_audit_test", ROOT/"tools/audit_native_word_unicode.py")


class UnicodeFastPathTests(unittest.TestCase):
    def test_only_two_functions_and_translation_constant_change(self):
        self.assertTrue(AUDIT.unchanged_reader_class(ORIGINAL_PATH.read_bytes(), CANDIDATE_PATH.read_bytes()))

    def test_removed_block_validation_is_rejected_before_differential_execution(self):
        altered = CANDIDATE_PATH.read_text().replace(
            'if normalize_word(text) != text or not valid_word(text):', 'if False:')
        self.assertNotEqual(altered, CANDIDATE_PATH.read_text())
        with self.assertRaisesRegex(ValueError, "outside reviewed"):
            AUDIT.unchanged_reader_class(ORIGINAL_PATH.read_bytes(), altered.encode())

    def test_cyrillic_only_acute_removal_and_apostrophe_normalization_are_preserved(self):
        values = {"П’Я́ТЬ": "п'ять", "п‘я́ть": "п'ять", "ПʼЯ́ТЬ": "п'ять",
                  "а\u0301\u0301": "а", "q\u0301": "q\u0301", "a\u0301": "á",
                  "\u0301я": "\u0301я", "Й\u0301": "й", "Ё\u0301": "ё",
                  "İß": "i\u0307ss", "\ud800": "\ud800"}
        for raw, expected in values.items():
            with self.subTest(raw=ascii(raw)):
                self.assertEqual(ORIGINAL.normalize_word(raw), expected)
                self.assertEqual(CANDIDATE.normalize_word(raw), expected)

    def test_word_boundaries_marks_numbers_and_nonletters_keep_exact_validity(self):
        yes = ("а", "a", "汉字", "а"*96, "п'ять", "a-b", "q\u0301", "ā")
        no = ("", "а"*97, "-а", "а-", "'а", "а'", "\u0301", "а\0б", "a_b", "а1", "а—б", "а\u200dб")
        for raw in yes+no:
            with self.subTest(raw=ascii(raw)):
                self.assertEqual(CANDIDATE.valid_word(raw), raw in yes)
                self.assertEqual(CANDIDATE.valid_word(raw), ORIGINAL.valid_word(raw))

    def test_custom_string_iteration_and_method_overrides_use_legacy_fallback(self):
        class Lying(str):
            def isalpha(self):
                return True
        class OddIteration(str):
            def casefold(self):
                return self
            def translate(self, table):
                return self
            def __iter__(self):
                return iter("а\u0301")
        for raw in (Lying("123"), OddIteration("abc"), ["а", "б"]):
            self.assertEqual(CANDIDATE.valid_word(raw), ORIGINAL.valid_word(raw))
        self.assertEqual(CANDIDATE.normalize_word(OddIteration("abc")), ORIGINAL.normalize_word(OddIteration("abc")))

    def test_overridden_translate_gets_fresh_mapping_and_cannot_poison_later_text(self):
        observed = []
        class MutatingTranslate(str):
            def casefold(self):
                return self
            def translate(self, table):
                observed.append(table)
                table[ord("’")] = "POISON"
                return str.translate(self, table)
        snapshot = dict(CANDIDATE._APOSTROPHE_TRANSLATION)
        try:
            expected = [ORIGINAL.normalize_word(MutatingTranslate("п’ять")) for _ in range(2)]
            actual = [CANDIDATE.normalize_word(MutatingTranslate("п’ять")) for _ in range(2)]
            self.assertEqual(actual, expected)
            self.assertIsNot(observed[0], observed[1])
            self.assertIsNot(observed[2], observed[3])
            self.assertTrue(all(table is not CANDIDATE._APOSTROPHE_TRANSLATION for table in observed))
            self.assertEqual(CANDIDATE._APOSTROPHE_TRANSLATION, snapshot)
            self.assertEqual(CANDIDATE.normalize_word("П’Я́ТЬ"), ORIGINAL.normalize_word("П’Я́ТЬ"))
            self.assertEqual(CANDIDATE.normalize_word("п’ять"), "п'ять")
        finally:
            CANDIDATE._APOSTROPHE_TRANSLATION.clear()
            CANDIDATE._APOSTROPHE_TRANSLATION.update(snapshot)

    def test_partial_codepoint_audit_is_explicitly_partial_and_checks_every_context(self):
        result = AUDIT.exhaustive(ORIGINAL, CANDIDATE, stop=257)
        self.assertEqual(result["codepoints"], 257)
        self.assertEqual(result["string_comparisons"], 257*6)
        self.assertFalse(result["full_unicode_range"])
        self.assertEqual(len(result["ordered_result_sha256"]), 64)
        for stop in (-1, AUDIT.MAX_CODEPOINT+1, True):
            with self.assertRaises(ValueError):
                AUDIT.exhaustive(ORIGINAL, CANDIDATE, stop=stop)

    def test_differential_audit_rejects_normalization_or_validity_disagreement(self):
        normalize_bad = SimpleNamespace(normalize_word=lambda text: "wrong", valid_word=CANDIDATE.valid_word)
        validity_bad = SimpleNamespace(normalize_word=CANDIDATE.normalize_word, valid_word=lambda text: False)
        with self.assertRaisesRegex(ValueError, "normalization differs"):
            AUDIT.exhaustive(ORIGINAL, normalize_bad, stop=1)
        with self.assertRaisesRegex(ValueError, "validity differs"):
            AUDIT.exhaustive(ORIGINAL, validity_bad, stop=128)

    def test_deterministic_random_cases_reproduce_the_same_digest(self):
        first = AUDIT.random_and_special(ORIGINAL, CANDIDATE, count=100)
        second = AUDIT.random_and_special(ORIGINAL, CANDIDATE, count=100)
        self.assertEqual(first, second)
        self.assertEqual(first["random_strings"], 100)
        self.assertEqual(first["custom_str_subclasses"], 4)
        self.assertTrue(first["ordinary_text_after_mutating_subclass_preserved"])

    def test_code_pin_catches_changes_before_module_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"module.py"
            path.write_bytes(b"original")
            expected = sha1(b"blob 8\0original").hexdigest()
            self.assertEqual(AUDIT.source(path, expected), b"original")
            path.write_bytes(b"changed!")
            with self.assertRaisesRegex(ValueError, "identity differs"):
                AUDIT.source(path, expected)

    def test_full_data_audit_rejects_wrong_artifact_before_constructing_reader(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"dataset.bin"
            path.write_bytes(b"wrong-source")
            module = SimpleNamespace(MembershipLexicon=lambda *args: self.fail("wrong data reached reader"))
            with self.assertRaisesRegex(ValueError, "authenticated native data"):
                AUDIT.validate_actual_data(module, path)


if __name__ == "__main__":
    unittest.main()
