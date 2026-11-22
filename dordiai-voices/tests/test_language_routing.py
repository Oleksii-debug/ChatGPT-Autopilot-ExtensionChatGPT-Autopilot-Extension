"""Routing regressions runnable without Windows, NVDA, or neural dependencies."""
import array
from contextlib import ExitStack
from functools import lru_cache
import gzip
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from zlib import crc32

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
BASELINE = ROOT / "packages/0.12.2/kx47Runtime"


def load(name):
    spec = importlib.util.spec_from_file_location("routing_test_" + name, RUNTIME / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


policy = load("language_routing")
speech = load("speech_text")
latin = load("latin_languages")
wide = load("wide_languages")


def hash_index(uk, ru):
    return tuple(array.array("I", sorted(crc32(w.encode("utf8")) for w in words)) for words in (uk, ru))


def frequency_row(**frequencies):
    return "".join(chr(frequencies.get(code, 32)) for code in latin.CODES)


LEXICON = {
    "hello": frequency_row(en=130, de=65, fr=70),
    "bonjour": frequency_row(en=70, fr=130),
    "hola": frequency_row(en=70, es=130),
    "hallo": frequency_row(en=70, de=130),
    "ahoj": frequency_row(sk=130),
    "die": frequency_row(en=120, de=135),
    "in": frequency_row(en=135, de=130, it=132),
    "merci": frequency_row(fr=130),
    "dziękuję": frequency_row(pl=130),
}
UK_WORDS = {"голос", "кнопка", "перемикач", "натиснуто", "сад", "вода", "мама", "дякую"}
RU_WORDS = {"голос", "кнопка", "сад", "вода", "мама", "спасибо", "загрузки"}


class PolicyTests(unittest.TestCase):
    def test_locale_aliases(self):
        self.assertEqual(policy.language_key("en_GB"), "en")
        self.assertEqual(policy.language_key("zh-cmn"), "cmn")
        self.assertEqual(policy.language_key("no-NO"), "nb")

    def test_dictionary_lists_are_not_reduced_to_one_label(self):
        result = policy.resolve_word("die", "en", {"en", "de"}, candidates=["en", "de"])
        self.assertEqual(result.language, "en")
        self.assertEqual(set(result.candidates), {"en", "de"})
        self.assertTrue(result.ambiguous)
        self.assertEqual(policy.resolve_word("die", "de", {"en", "de"}, candidates=["en", "de"]).language, "de")

    def test_classifier_cannot_erase_known_ambiguity(self):
        result = policy.resolve_word("die", "en", {"en", "de"}, candidates=["en", "de"],
                                     classifier=lambda _: ("de", 1.))
        self.assertTrue(result.ambiguous)
        self.assertEqual(result.language, "en")

    def test_single_letters_do_not_use_dictionary_or_classifier(self):
        for character in ("a", "и", "é"):
            result = policy.resolve_word(character, "uk", {"uk", "ru", "en"}, candidates=["ru"],
                                         classifier=lambda _: ("en", 1.))
            self.assertEqual(result.language, "uk")
            self.assertEqual(result.source, "current-language")

    def test_explicit_language_beats_dictionary(self):
        result = policy.resolve_word("bonjour", "en-US", {"en", "fr"}, candidates=["fr"], explicit=True)
        self.assertEqual(result.language, "en")
        self.assertEqual(result.source, "explicit")

    def test_unknown_word_requires_classifier_confidence(self):
        self.assertEqual(policy.resolve_word("unknown", "uk", {"uk", "en"},
                         classifier=lambda _: ("en", .70)).language, "uk")
        self.assertEqual(policy.resolve_word("unknown", "uk", {"uk", "en"},
                         classifier=lambda _: ("en", .99)).language, "en")

    def test_disabled_classifier_output_never_escapes(self):
        self.assertEqual(policy.resolve_word("unknown", "uk", {"uk", "en"},
                         classifier=lambda _: ("ru", 1.)).language, "uk")

    def test_priority_and_empty_selection(self):
        self.assertEqual(policy.resolve_word("die", "uk", {"en", "de", "uk"},
                         candidates=["en", "de"], priorities=["de", "en"]).language, "de")
        with self.assertRaises(ValueError):
            policy.resolve_word("hello", "en", set())

    def test_normalization(self):
        self.assertEqual(policy.normalize_word("П’Я\u0301ТЬ"), "п'ять")
        self.assertEqual(policy.normalize_word("cafe\u0301"), "café")


class RoutingFixture:
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(speech, "cyrillic_word_index", return_value=hash_index(UK_WORDS, RU_WORDS)))
        self.stack.enter_context(patch.object(speech, "supplemental_cyrillic_index", return_value={}))
        # Deliberately bad statistical prior: exact lexical context must stop it
        # from turning a Ukrainian Windows label into Russian.
        self.stack.enter_context(patch.object(speech, "cyrillic_ngram_score", return_value=8.))
        speech.cyrillic_word_candidates.cache_clear()
        self.addCleanup(speech.cyrillic_word_candidates.cache_clear)
        self.stack.enter_context(patch.object(latin, "dictionary", return_value=LEXICON))
        self.stack.enter_context(patch.object(policy, "classify_word", return_value=(None, 0.)))
        self.stack.enter_context(patch.object(policy, "has_word_classifier", return_value=False))
        self.stack.enter_context(patch.object(speech, "routing_policy", return_value=policy))
        self.stack.enter_context(patch.object(latin, "routing_policy", return_value=policy))
        latin.word_scores.cache_clear()
        latin.word_candidates.cache_clear()
        self.addCleanup(latin.word_scores.cache_clear)
        self.addCleanup(latin.word_candidates.cache_clear)


class CoreRoutingTests(RoutingFixture, unittest.TestCase):
    def test_ukrainian_windows_label_keeps_language(self):
        text = "Кнопка перемикач натиснуто"
        self.assertEqual(speech.cyrillic_language(text, "uk"), "uk")
        self.assertEqual(list(speech.split_mixed(text, "uk", detect_russian=True)), [("uk", text)])

    def test_shared_words_inherit_language(self):
        self.assertEqual(speech.cyrillic_language("голос", "uk"), "uk")
        self.assertEqual(speech.cyrillic_language("голос", "ru"), "ru")
        self.assertEqual(speech.cyrillic_language("голос кнопка", "uk"), "uk")

    def test_single_shared_letter_inherits_current_language(self):
        self.assertEqual(speech.cyrillic_language("и", "uk"), "uk")
        self.assertEqual(speech.cyrillic_language("и", "ru"), "ru")

    def test_cyrillic_dictionary_list_switches_within_clause(self):
        runs = list(speech.split_mixed("дякую спасибо перемикач загрузки", "uk", detect_russian=True, word_mode=True))
        self.assertEqual([code for code, _ in runs], ["uk", "ru", "uk", "ru"])

    def test_disabled_russian_does_not_activate(self):
        self.assertEqual(list(speech.split_mixed("спасибо загрузки", "uk", detect_russian=True,
                                               enabled_languages={"uk", "en"}, word_mode=True)),
                         [("uk", "спасибо загрузки")])

    def test_apostrophe_stays_inside_word(self):
        self.assertEqual([m.group() for m in speech.WORDS.finditer("п’ять п'ять")], ["п’ять", "п'ять"])

    def test_latin_list_switches_per_word(self):
        runs = list(latin.split_latin("hello bonjour hola dziękuję ahoj", "en", mode="words"))
        self.assertEqual([code for code, _ in runs], ["en", "fr", "es", "pl", "sk"])

    def test_latin_homograph_prefers_user_language(self):
        self.assertEqual(list(latin.split_latin("die", "en", mode="words")), [("en", "die")])
        self.assertEqual(list(latin.split_latin("die", "de", mode="words")), [("de", "die")])

    def test_latin_enabled_filter(self):
        self.assertEqual(list(latin.split_latin("bonjour hola", "en", enabled_languages={"en", "uk"}, mode="words")),
                         [("en", "bonjour hola")])

    def test_latin_explicit_hint(self):
        self.assertEqual(list(latin.split_latin("bonjour hola", "en", explicit=True)), [("en", "bonjour hola")])

    def test_latin_single_character_no_guess(self):
        self.assertEqual(list(latin.split_latin("a", "de", mode="words")), [("de", "a")])

    def test_invalid_mode(self):
        with self.assertRaises(ValueError):
            list(latin.split_latin("hello", "en", mode="undefined"))


class ExtendedRoutingTests(RoutingFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(wide, "_words", return_value={"hola": "haw", "ahoj": ["sk", "cs"],
                                                                           "woord": ["nl", "af"]}))
        self.stack.enter_context(patch.object(wide, "_identify", return_value=(None, 0.)))
        self.stack.enter_context(patch.object(wide, "_phrase_language", return_value=(None, 0.)))
        self.stack.enter_context(patch.object(wide, "_auxiliary", side_effect=lambda name: {
            "language_routing": policy, "latin_languages": latin, "speech_text": speech,
        }[name]))
        wide._lexical_candidates.cache_clear()
        self.addCleanup(wide._lexical_candidates.cache_clear)

    def test_hola_not_hijacked_by_extended_single_label_lexicon(self):
        self.assertEqual(wide.split_extended("hola", preferred="en", enabled_languages={"en", "es", "haw"}, mode="words"),
                         [("es", "hola")])

    def test_shared_extended_word_keeps_both_languages(self):
        self.assertEqual(wide._lexical_candidates("ahoj", "latin"), {"sk", "cs"})
        self.assertEqual(wide.split_extended("ahoj", preferred="cs", mode="words"), [("cs", "ahoj")])
        self.assertEqual(wide.split_extended("ahoj", preferred="sk", mode="words"), [("sk", "ahoj")])

    def test_extended_list_and_exact_text_preservation(self):
        text = "hello, bonjour; hola\nдякую спасибо!"
        spans = wide.split_extended(text, preferred="en", mode="words")
        self.assertEqual("".join(span for _, span in spans), text)
        self.assertEqual([code for code, _ in spans], ["en", "fr", "es", "uk", "ru"])

    def test_disabled_languages_never_escape_extended_planner(self):
        spans = wide.split_extended("hola bonjour спасибо Γειά", preferred="uk", enabled_languages={"uk", "en"}, mode="words")
        self.assertTrue(all(code in {None, "uk", "en"} for code, _ in spans))

    def test_explicit_extended_language_pins_all_scripts(self):
        self.assertEqual(wide.split_extended("hello Γειά спасибо", preferred="el", explicit=True),
                         [("el", "hello Γειά спасибо")])

    def test_explicit_core_delegates_without_guessing(self):
        self.assertEqual(wide.split_extended("hola Γειά", preferred="uk", explicit=True), [(None, "hola Γειά")])

    def test_single_shared_character_no_language_detector(self):
        wide._identify.side_effect = AssertionError("A letter must not invoke language ID")
        self.assertEqual(wide.split_extended("a", preferred="uk"), [(None, "a")])
        self.assertEqual(wide.split_extended("a", preferred="cs"), [("cs", "a")])

    def test_unknown_is_not_a_random_foreign_language(self):
        self.assertEqual(wide.split_extended("qwertyunknown", preferred="uk", enabled_languages={"uk", "en"}, mode="words"),
                         [("uk", "qwertyunknown")])


@unittest.skipUnless((BASELINE / "latin_dictionary.json.gz").is_file(), "Recovered lexicons not restored")
class RecoveredResourceTests(unittest.TestCase):
    def test_actual_cyrillic_lexicons_and_word_model(self):
        values = memoryview((BASELINE / "cyrillic_words.bin").read_bytes()).cast("I")
        boundary = values[0] + 1
        table = json.loads((BASELINE / "cyrillic_ngrams.json").read_text(encoding="utf8"))
        with patch.object(speech, "cyrillic_word_index", return_value=(values[1:boundary], values[boundary:])), \
             patch.object(speech, "cyrillic_ngram_table", return_value=table), \
             patch.object(speech, "routing_policy", return_value=policy), \
             patch.object(policy, "has_word_classifier", return_value=False):
            speech.cyrillic_word_candidates.cache_clear()
            speech.cyrillic_ngram_score.cache_clear()
            try:
                self.assertEqual(speech.cyrillic_language("голос", "ru"), "ru")
                self.assertEqual(speech.cyrillic_language("голос", "uk"), "uk")
                self.assertEqual(speech.cyrillic_language("Кнопка перемикач натиснуто", "uk"), "uk")
                runs = list(speech.split_mixed("дякую спасибо перемикач загрузки", "uk", detect_russian=True, word_mode=True))
                self.assertEqual([code for code, _ in runs], ["uk", "ru", "uk", "ru"])
                self.assertEqual(list(speech.split_mixed("Доброе утро", "uk", detect_russian=True, word_mode=True)),
                                 [("ru", "Доброе утро")])
            finally:
                speech.cyrillic_word_candidates.cache_clear()
                speech.cyrillic_ngram_score.cache_clear()

    def test_actual_latin_lexicon_retains_homographs_and_routes_known_words(self):
        with gzip.open(BASELINE / "latin_dictionary.json.gz", "rt", encoding="utf8") as stream:
            dictionary = json.load(stream)
        with patch.object(latin, "dictionary", return_value=dictionary):
            latin.word_candidates.cache_clear()
            latin.word_scores.cache_clear()
            try:
                self.assertTrue({"en", "de"} <= latin.word_candidates("die"))
                runs = list(latin.split_latin("hello bonjour hola dziękuję", "en", mode="words"))
                self.assertEqual([code for code, _ in runs], ["en", "fr", "es", "pl"])
            finally:
                latin.word_candidates.cache_clear()
                latin.word_scores.cache_clear()


if __name__ == "__main__":
    unittest.main()
