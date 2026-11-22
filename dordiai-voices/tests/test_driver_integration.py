"""Exercise the real NVDA adapter planner against its runtime helpers."""
from collections import OrderedDict
import unittest
from nvda_stubs import driver_module


class DriverPlanningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.context = driver_module()
        cls.module = cls.context.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.context.__exit__(None, None, None)

    def synth(self, enabled=("uk", "en", "ru")):
        obj = self.module.SynthDriver.__new__(self.module.SynthDriver)
        obj._dordiai_init()
        obj._voices = {"viktoriia": ("Вікторія", "viktoriia", "reference", "en-US"),
                       "alice": ("Alice", "alice", "reference", "en-US")}
        obj._voice = "viktoriia"
        obj._canJoin = False
        obj._dordiai_enabled_languages = frozenset(enabled)
        obj._dordiai_selection = (frozenset(), frozenset(), "uk")
        obj._dordiai_voice_map = {"en": "alice", "ru": "alice", "uk": "viktoriia"}
        obj._dordiai_compatible_voices = lambda language: tuple(obj._voices)
        return obj

    def planned(self, obj, sequence):
        return list(obj._planned_parts(sequence, "viktoriia", "reference", "en-US",
            50, {"pitch": 50, "volume": 100, "timbre": 50},
            {"en": ("alice", 50, None), "ru": ("alice", 50, None)}, 1, True))

    def test_character_and_text_keep_same_language_voice(self):
        d = self.module
        values = self.planned(self.synth(), [d.LangChangeCommand("en"),
            "book", d.CharacterModeCommand(True), "b"])
        self.assertEqual([kind for kind, _ in values], ["text", "character"])
        self.assertEqual([request["profile"] for _, request in values], ["alice", "alice"])
        self.assertEqual(values[1][1]["text"], "bee")

    def test_forced_language_applies_before_character_name(self):
        d = self.module
        obj = self.synth()
        obj._dordiai_mode = "forced"
        values = self.planned(obj, [d.LangChangeCommand("ru"), d.CharacterModeCommand(True), "б"])
        self.assertEqual(values[0][1]["language"], "uk")
        self.assertEqual(values[0][1]["text"], "бе")
        self.assertEqual(values[0][1]["profile"], "viktoriia")

    def test_disabled_marked_language_applies_before_character_name(self):
        d = self.module
        obj = self.synth(("uk", "en"))
        values = self.planned(obj, [d.LangChangeCommand("ru"), d.CharacterModeCommand(True), "б"])
        self.assertEqual(values[0][1]["language"], "uk")
        self.assertEqual(values[0][1]["text"], "бе")

    def test_explicit_language_does_not_get_guessed_per_word(self):
        d = self.module
        values = self.planned(self.synth(), [d.LangChangeCommand("uk"), "Голос кнопка перемикач натиснуто"])
        self.assertEqual(len(values), 1)
        self.assertEqual(values[0][1]["language"], "uk")

    def test_iso_aliases_resolve_before_core_fallback(self):
        d = self.module
        for tag, expected in (("eng", "en-US"), ("ukr", "uk"),
                              ("rus", "ru"), ("deu", "de"),
                              ("fra", "fr"), ("en_GB", "en-GB")):
            with self.subTest(tag=tag):
                self.assertEqual(d.language_code(tag, "uk", "en-US"), expected)

    def test_explicit_noncore_iso_tags_survive_the_complete_planner(self):
        d = self.module
        for tag, code, text in (("hin", "hi", "नमस्ते"),
                                ("bos", "bs", "zdravo"),
                                ("jpn", "ja", "こんにちは")):
            with self.subTest(tag=tag):
                obj = self.synth(("uk", "en", "ru", code))
                parts = self.planned(obj, [d.LangChangeCommand(tag), text])
                self.assertEqual(len(parts), 1)
                self.assertEqual(parts[0][1]["language"], code)
                self.assertEqual(parts[0][1]["text"], text)
                self.assertTrue(parts[0][1]["wideLocale"])

    def test_shared_lone_letter_uses_current_language(self):
        d = self.module
        values = self.planned(self.synth(), [d.LangChangeCommand("ru"), "б"])
        self.assertEqual(values[0][1]["text"], "бэ")
        self.assertEqual(values[0][1]["profile"], "alice")

    def test_core_symbol_and_emoji_names_keep_current_language_and_voice(self):
        d = self.module
        for language, glyph in (("uk", "😀"), ("en", "👩\u200d💻"), ("uk", "!")):
            with self.subTest(language=language, glyph=glyph):
                expected = d._runtime_module("character_names").spoken_name(language, glyph)
                values = self.planned(self.synth(), [d.LangChangeCommand(language),
                    d.CharacterModeCommand(True), glyph])
                self.assertEqual(len(values), 1)
                request = values[0][1]
                self.assertTrue(request["character"])
                self.assertEqual(request["text"], expected)
                self.assertEqual(request["language"].split("-")[0], language)
                self.assertEqual(request["profile"], "alice" if language == "en" else "viktoriia")

    def test_emoji_sequence_does_not_consume_the_next_typed_letter(self):
        d = self.module
        values = list(d.core_character_parts("👩\u200d💻b", "en-US", "en-US"))
        self.assertEqual(len(values), 2)
        self.assertEqual(values[0][1][1], d._runtime_module("character_names").spoken_name("en", "👩\u200d💻"))
        self.assertEqual(values[1], ("character", ("en-US", "bee")))

    def test_ukrainian_label_no_foreign_language_when_only_defaults_enabled(self):
        values = self.planned(self.synth(), ["Кнопка перемикач натиснуто"])
        self.assertTrue(values)
        self.assertEqual({request["language"] for _, request in values}, {"uk"})

    def test_legacy_removed_alias_cannot_restore_voice(self):
        obj = self.synth()
        obj._voiceAliases = {"veronika": "alice"}
        # Resolving a legacy id must not resurrect the disallowed identity or
        # silently redirect its saved settings onto another person's voice.
        obj._set_voice("veronika")
        self.assertEqual(obj._voice, "viktoriia")

    def test_wide_language_mapping_does_not_revert_to_main_profile(self):
        d = self.module
        obj = self.synth(("uk", "en", "ru", "el"))
        obj._dordiai_voice_map["el"] = "alice"
        values = self.planned(obj, [d.LangChangeCommand("el"), "κόσμος"])
        self.assertEqual(values[0][1]["language"], "el")
        self.assertTrue(values[0][1]["wideLocale"])
        self.assertEqual(values[0][1]["profile"], "alice")


if __name__ == "__main__":
    unittest.main()
