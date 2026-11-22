"""Explicit equivalent tags must agree between settings and resource lookup."""
import importlib.util
import json
from pathlib import Path
import unittest

RUNTIME = Path(__file__).resolve().parents[1] / "source/0.12.2/kx47Runtime"


def module(name):
    spec = importlib.util.spec_from_file_location("_language_codes_test_" + name, RUNTIME / (name + ".py"))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


codes, catalog, preferences = map(module, ("language_codes", "language_catalog", "preferences"))


class LanguageCodeTests(unittest.TestCase):
    def test_known_iso_tags_agree_between_preferences_and_installed_catalog(self):
        for tag, expected in (("sot-ZA", "st"), ("xho", "xh"), ("hau-NG", "ha"),
                              ("nde-ZW", "nd"), ("nbl-ZA", "nr"), ("eng_US", "en"),
                              ("ukr", "uk"), ("fra-CA", "fr"), ("roh-CH", "rm")):
            with self.subTest(tag=tag):
                self.assertEqual(expected, codes.canonical_language(tag))
                self.assertEqual(expected, catalog.canonical_code(tag))
                self.assertEqual(expected, preferences.language_key(tag))

    def test_explicit_variants_are_resolved_before_region_suffixes(self):
        self.assertEqual("yue", codes.canonical_language("zh-yue-Hant-HK"))
        self.assertEqual("hyw", preferences.language_key("hy-arevmda-LB"))
        self.assertEqual("nb", codes.canonical_language("nob-NO"))
        self.assertEqual("nn", codes.canonical_language("nno-NO"))

    def test_different_standards_and_catalogue_groups_are_not_aliases(self):
        for tag in ("fil", "tl", "dgo", "doi", "ayr", "kab", "zgh", "tamazight"):
            self.assertEqual(tag, codes.canonical_language(tag))
        self.assertEqual("tl", codes.canonical_language("tgl"))
        self.assertNotEqual("fil", codes.canonical_language("tgl"))
        self.assertNotEqual(codes.canonical_language("nbl"), codes.canonical_language("nde"))

    def test_all_official_equivalents_reproduce_and_share_the_same_primary(self):
        path = RUNTIME.parents[2] / "tools/prepare_language_codes.py"
        spec = importlib.util.spec_from_file_location("prepare_iso_equivalents", path)
        generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator)
        exact = generator.prepare()
        self.assertEqual(exact, json.loads((RUNTIME / "language_iso_aliases.json").read_text(encoding="utf8")))
        self.assertEqual(len(exact), 203)
        for tag, primary in exact.items():
            with self.subTest(tag=tag):
                self.assertEqual(codes.canonical_language(tag), codes.canonical_language(primary))

    def test_common_marked_languages_are_not_misrouted_as_unknown(self):
        for tag, primary in (("bos", "bs"), ("hin", "hi"), ("ben", "bn"),
                              ("jpn", "ja"), ("ara", "ar"), ("tur", "tr"),
                              ("zho", "cmn"), ("nor", "nb")):
            with self.subTest(tag=tag):
                self.assertEqual(primary, preferences.language_key(tag))

    def test_missing_tags_keep_the_callers_own_default_policy(self):
        self.assertEqual("", catalog.canonical_code(None))
        self.assertEqual("uk", preferences.language_key(None))
        self.assertEqual("uk", preferences.language_key(" \t"))


if __name__ == "__main__":
    unittest.main()
