"""Whole finite dictionary evidence must survive Cyrillic tokenization."""
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


wide = load("native_compound_wide", RUNTIME / "wide_languages.py")
leaf = load("native_compound_leaf", RUNTIME / "native_word_membership.py")
builder = load("native_compound_builder", ROOT / "tools/build_native_word_membership.py")


class NativeCompoundRoutingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "native.bin"
        # This deliberately small finite dictionary isolates segmentation from
        # classifiers. It is not a claim that every real homograph is resolved.
        self.words = {"пресс": 3, "центр": 3, "пресс-центр": 2,
                      "тест": 3, "план": 3, "тест-план": 1,
                      "кошка": 2, "мама": 3, "кошка-мама": 3,
                      "тест-план-центр": 2}
        receipt = builder.write_memberships(self.path,
            sorted((word.encode("utf8"), mask) for word, mask in self.words.items()),
            codes=("uk", "ru"))
        self.reader = leaf.MembershipLexicon(self.path, receipt["sha256"])
        self.addCleanup(self.reader.close)
        self.forwarder = SimpleNamespace(candidates=self.reader.candidates)
        self.mock = patch.dict(sys.modules,
            {"_dordiai_main_native_membership_runtime": self.forwarder})
        self.mock.start()
        self.addCleanup(self.mock.stop)
        wide._lexical_candidates.cache_clear()

    def parts(self, text, script="cyrillic"):
        return [text[start:end] for start, end in wide._dictionary_word_ranges(text, script)]

    def route(self, text, preferred="uk", enabled=("uk", "ru"), explicit=False):
        return list(wide.split_extended(text, preferred, explicit,
            enabled_languages=enabled, mode="words"))

    def test_unique_whole_word_overrides_two_shared_component_spellings(self):
        self.assertEqual(self.reader.candidates("пресс"), {"uk", "ru"})
        self.assertEqual(self.reader.candidates("центр"), {"uk", "ru"})
        self.assertEqual(self.parts("пресс-центр"), ["пресс-центр"])
        self.assertEqual(self.route("пресс-центр"), [("ru", "пресс-центр")])
        self.assertEqual(self.route("тест-план", "ru"), [("uk", "тест-план")])

    def test_whole_shared_word_preserves_current_language_instead_of_component_vote(self):
        self.assertEqual(self.route("кошка-мама"), [("uk", "кошка-мама")])
        self.assertEqual(self.route("кошка-мама", "ru"), [("ru", "кошка-мама")])

    def test_exact_maximal_multi_component_word_and_original_text_survive(self):
        self.assertEqual(self.parts("(ТЕСТ-ПЛАН-ЦЕНТР)!"), ["ТЕСТ-ПЛАН-ЦЕНТР"])
        text = "  тест-план, пресс-центр!"
        routes = self.route(text)
        self.assertEqual("".join(span for _, span in routes), text)
        self.assertEqual(routes, [("uk", "  тест-план, "), ("ru", "пресс-центр!")])

    def test_unknown_whole_retains_old_components_and_no_known_subchain_search(self):
        text = "тест-план-неизвестно"
        self.assertEqual(self.parts(text), ["тест", "план", "неизвестно"])
        self.assertEqual(self.parts("кошка-центр"), ["кошка", "центр"])

    def test_spaces_dashes_numbers_and_double_hyphens_are_never_joined(self):
        for text in ("пресс - центр", "пресс—центр", "пресс–центр", "пресс--центр", "пресс-2-центр"):
            with self.subTest(text=text):
                self.assertEqual(self.parts(text), ["пресс", "центр"])

    def test_other_script_does_not_query_native_cyrillic_resource(self):
        with patch.object(self.forwarder, "candidates", side_effect=AssertionError("wrong script")):
            self.assertEqual(self.parts("press-centre", "latin"), ["press", "centre"])

    def test_oversized_chain_never_queries_resource_or_searches_substrings(self):
        text = "-".join(["тест"] * 100)
        with patch.object(self.forwarder, "candidates", side_effect=AssertionError("oversized lookup")):
            self.assertEqual(len(self.parts(text)), 100)

    def test_forced_and_disabled_languages_still_have_priority(self):
        # Explicit core languages retain the established None delegation to
        # the caller's already selected core language, without auto guessing.
        self.assertEqual(self.route("пресс-центр", explicit=True), [(None, "пресс-центр")])
        self.assertEqual(self.route("пресс-центр", enabled=("uk",)), [("uk", "пресс-центр")])

    def test_resource_failure_is_not_hidden_by_prior_compound_result(self):
        self.assertEqual(self.parts("пресс-центр"), ["пресс-центр"])
        with patch.object(self.forwarder, "candidates", side_effect=RuntimeError("stale resource")):
            with self.assertRaisesRegex(RuntimeError, "stale resource"):
                self.parts("пресс-центр")


if __name__ == "__main__":
    unittest.main()
