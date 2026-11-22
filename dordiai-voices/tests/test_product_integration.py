"""Cross-component policy tests using actual packaged resource inventory.

NVDA imports are stubbed; no synthesis or Windows audio result is implied.
"""
from collections import OrderedDict
import json
from pathlib import Path
import unittest

from nvda_stubs import driver_module

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "packages/0.12.2/kx47Runtime/models"


class ProductIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.context = driver_module()
        cls.driver = cls.context.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.context.__exit__(None, None, None)

    def synth(self, values=None):
        if not MODELS.is_dir():
            self.skipTest("Restore main0.12.2 model resources for structural product integration")
        obj = self.driver.SynthDriver.__new__(self.driver.SynthDriver)
        obj._dordiai_init()
        obj._models = MODELS
        obj._language_catalog = self.driver._runtime_module("language_catalog")
        names = json.loads((MODELS / "voices/catalog.json").read_text(encoding="utf-8"))
        names = self.driver._voice_policy.filter_voice_catalog(names)
        obj._voices = OrderedDict((key, (name, key, "reference", "en-US")) for key, name in names.items())
        obj._voice = next(iter(obj._voices))
        obj._managedVoices = {}
        obj._compatibleVoiceCache = {}
        obj._installedLanguageCache = None
        obj._canJoin = True
        state = self.driver._prefs.load_preference_state(values or {}, obj._dordiai_all_voices(),
                                                         obj._dordiai_all_languages(),
                                                         obj._dordiai_compatible_voices)
        obj._dordiai_selection = state["selection"]
        obj._dordiai_enabled_languages = state["enabled_languages"]
        obj._dordiai_mode = state["mode"]
        obj._dordiai_voice_map = state["voice_map"]
        return obj

    def plan(self, obj, sequence, **options):
        return list(obj._planned_parts(sequence, obj._voice, "reference", "en-US", 50,
            {"pitch": 50, "volume": 100, "timbre": 50},
            {code: (obj._voice, 50, None) for code in ("en", "ru")}, 1, True,
            native_profiles=True, **options))

    def test_fresh_real_resource_profile_has_45_voices_and_three_defaults(self):
        obj = self.synth()
        self.assertEqual(45, len(obj._dordiai_all_voices()))
        self.assertEqual({"uk", "en", "ru"}, set(obj._dordiai_enabled_languages))
        for code in ("uk", "en", "ru"):
            self.assertEqual(45, len(obj._dordiai_compatible_voices(code)))
            self.assertEqual(obj._voice, obj._dordiai_voice_for_language(code, obj._voice))
        self.assertEqual(83, len(obj._dordiai_all_languages()))

    def test_profile_positive_selection_does_not_enable_other_installed_resources(self):
        obj = self.synth({"dordiaiEnabledLanguages": "uk en", "dordiaiDefaultLanguage": "en"})
        self.assertEqual({"uk", "en"}, set(obj._dordiai_enabled_languages))
        self.assertNotIn("ru", obj._get_availableLanguages())
        self.assertNotIn("fr", obj._get_availableLanguages())
        values = self.plan(obj, [self.driver.LangChangeCommand("ru"), "Голос"])
        self.assertEqual({"en"}, {request["language"] for kind, request in values if kind == "text"})

    def test_auto_native_pronunciation_uses_language_engine_for_allowed_voice(self):
        obj = self.synth({"dordiaiEnabledLanguages": "uk en ru fr"})
        values = self.plan(obj, [self.driver.LangChangeCommand("fr"), "Bonjour"],
                           foreign_pronunciation="auto")
        self.assertEqual("fr", values[0][1]["language"])
        self.assertTrue(values[0][1].get("nativeLocale"),
                        "Auto must not reserve native-language models for an excluded legacy profile")

    def test_forced_mode_cannot_switch_number_expansion_to_disabled_language(self):
        obj = self.synth({"dordiaiEnabledLanguages": "uk", "dordiaiLanguageMode": "forced"})
        values = self.plan(obj, ["123"], number_language="en")
        self.assertTrue(values)
        self.assertEqual("uk", values[0][1]["language"])
        self.assertNotEqual("en", values[0][1]["numberLanguage"],
                            "Worker-side number expansion must obey the same forced/disabled language policy")

    def test_forced_mode_resolves_spelling_policy_before_letter_name(self):
        obj = self.synth({"dordiaiEnabledLanguages": "uk", "dordiaiLanguageMode": "forced"})
        values = self.plan(obj, [self.driver.CharacterModeCommand(True), "б"], spelling_language="ru")
        self.assertEqual("uk", values[0][1]["language"])
        self.assertEqual("бе", values[0][1]["text"],
                         "Russian letter names must not be generated and then relabelled as Ukrainian")

    def test_numeric_override_selects_target_language_voice_before_worker(self):
        obj = self.synth({"dordiaiEnabledLanguages": "uk en", "dordiaiLanguageVoices":
                          '{"uk": "sara_archive", "en": "viktoriia"}'})
        values = self.plan(obj, [self.driver.LangChangeCommand("uk"), "Ціна 1 234,50 гривень"],
                           number_language="en")
        numbers = [request for kind, request in values if request.get("text") == "1234.50"]
        self.assertEqual(1, len(numbers))
        self.assertEqual("en", numbers[0]["language"])
        self.assertEqual("viktoriia", numbers[0]["profile"])
        self.assertEqual("auto", numbers[0]["numberLanguage"])
        self.assertTrue(numbers[0]["nativeProfile"])

    def test_reverse_numeric_override_preserves_english_grouping_and_decimal(self):
        obj = self.synth({"dordiaiEnabledLanguages": "uk en", "dordiaiLanguageVoices":
                          '{"uk": "sara_archive", "en": "viktoriia"}'})
        values = self.plan(obj, [self.driver.LangChangeCommand("en"), "Price 1,234.50 dollars"],
                           number_language="uk")
        numbers = [request for kind, request in values if request.get("text") == "1234.50"]
        self.assertEqual(1, len(numbers))
        self.assertEqual("uk", numbers[0]["language"])
        self.assertEqual("sara_archive", numbers[0]["profile"])
        self.assertEqual("auto", numbers[0]["numberLanguage"])

    def test_disabled_spelling_override_cannot_change_letter_name_in_auto_mode(self):
        obj = self.synth({"dordiaiEnabledLanguages": "uk"})
        values = self.plan(obj, [self.driver.CharacterModeCommand(True), "б"], spelling_language="ru")
        self.assertEqual("uk", values[0][1]["language"])
        self.assertEqual("бе", values[0][1]["text"])

    def test_fast_foreign_mode_remains_an_explicit_choice(self):
        obj = self.synth({"dordiaiEnabledLanguages": "uk en ru fr"})
        values = self.plan(obj, [self.driver.LangChangeCommand("fr"), "Bonjour"],
                           foreign_pronunciation="fast")
        self.assertFalse(values[0][1].get("nativeLocale"))


if __name__ == "__main__":
    unittest.main()
