"""Profile behavior tests independent of wx and Windows audio."""
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from collections import OrderedDict
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1] / "source" / "0.12.2" / "kx47Runtime"
spec = importlib.util.spec_from_file_location("tested_preferences", RUNTIME / "preferences.py")
prefs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prefs)

VOICES = OrderedDict(alice="Alice", bob="Bob", clara="Clara")
LANGUAGES = OrderedDict(uk="Ukrainian", en="English", ru="Russian", de="German", nb="Norwegian")


def compatible(code):
    return {"alice", "bob"} if code in {"uk", "ru"} else {"bob", "clara"}


class Base:
    @classmethod
    def _getConfigSpecForSettings(cls, settings):
        return {}

    def loadSettings(self, onlyChanged=False):
        pass

    def saveSettings(self):
        pass


class Driver(prefs.PreferencesMixin, Base):
    name = "testDriver"

    def __init__(self):
        self.voice = "alice"
        self.cancellations = 0
        self._dordiai_init()

    def _dordiai_all_voices(self):
        return VOICES.copy()

    def _dordiai_all_languages(self):
        return LANGUAGES.copy()

    def _dordiai_compatible_voices(self, code):
        return compatible(code)

    def invalidateCache(self):
        pass

    def cancel(self):
        self.cancellations += 1


class PreferencesTests(unittest.TestCase):
    def load(self, values=None, languages=None):
        return prefs.load_preference_state(values or {}, VOICES, languages or LANGUAGES, compatible)

    def test_fresh_install_only_default_languages(self):
        state = self.load()
        self.assertEqual(state["enabled_languages"], {"uk", "en", "ru"})
        self.assertEqual(state["selection"][1], {"de", "nb"})

    def test_positive_selection_keeps_new_pack_opt_in(self):
        state = self.load({prefs.ENABLED_LANGUAGES_KEY: "de"})
        self.assertEqual(state["enabled_languages"], {"de"})
        self.assertEqual(state["selection"][2], "de")

    def test_legacy_explicit_exclusions_are_migrated(self):
        state = self.load({prefs.CONFIG_KEYS[1]: "uk ru"})
        self.assertEqual(state["enabled_languages"], {"en", "de", "nb"})

    def test_positive_list_takes_precedence_over_legacy_exclusions(self):
        state = self.load({prefs.ENABLED_LANGUAGES_KEY: "de", prefs.CONFIG_KEYS[1]: "de"})
        self.assertEqual(state["enabled_languages"], {"de"})

    def test_removed_language_recovers_to_working_defaults(self):
        state = self.load({prefs.ENABLED_LANGUAGES_KEY: "uninstalled", prefs.CONFIG_KEYS[2]: "uninstalled"})
        self.assertEqual(state["enabled_languages"], {"uk", "en", "ru"})
        self.assertEqual(state["selection"][2], "uk")

    def test_missing_defaults_uses_one_installed_language(self):
        state = self.load(languages=OrderedDict(de="German", nb="Norwegian"))
        self.assertEqual(state["enabled_languages"], {"de"})

    def test_no_installed_resources_is_explicit_error(self):
        with self.assertRaises(ValueError):
            prefs.load_preference_state({}, {}, LANGUAGES)
        with self.assertRaises(ValueError):
            prefs.load_preference_state({}, VOICES, {})

    def test_aliases_are_canonical_even_with_regions(self):
        self.assertEqual(prefs.language_key("no_NO"), "nb")
        self.assertEqual(prefs.language_key("zh-CN"), "cmn")
        self.assertEqual(prefs.language_key("iw_IL"), "he")
        self.assertEqual(prefs.language_key("en_GB"), "en")

    def test_bad_map_and_mode_do_not_crash_profile_load(self):
        for raw in ("broken", "[]", "true", None):
            with self.subTest(raw=raw):
                state = self.load({prefs.VOICE_MAP_KEY: raw, prefs.MODE_KEY: ["auto"]})
                self.assertEqual(state["voice_map"], {})
                self.assertEqual(state["mode"], "auto")

    def test_stale_excluded_and_incompatible_voices_not_restored(self):
        raw = json.dumps({"uk": "clara", "en": "clara", "ru": "bob", "xx": "alice"})
        state = self.load({prefs.VOICE_MAP_KEY: raw, prefs.CONFIG_KEYS[0]: "bob old_removed_voice"})
        self.assertEqual(state["voice_map"], {"en": "clara"})
        self.assertEqual(state["selection"][0], {"bob"})

    def test_character_and_text_use_identical_language_voice_hook(self):
        driver = Driver()
        driver._dordiai_voice_map = {"en": "clara", "uk": "bob"}
        self.assertEqual(driver._dordiai_voice_for_language("en-US", "bob"), "clara")
        self.assertEqual(driver._dordiai_voice_for_language("en-GB", "alice"), "clara")
        self.assertEqual(driver._dordiai_voice_for_language("uk", "alice"), "bob")

    def test_excluded_voice_never_selected_by_saved_map(self):
        driver = Driver()
        driver._dordiai_selection = (frozenset({"bob"}), frozenset({"de", "nb"}), "uk")
        driver._dordiai_voice_map = {"uk": "bob"}
        self.assertEqual(driver._dordiai_voice_for_language("uk", "bob"), "alice")

    def test_no_compatible_voice_fails_instead_of_random_voice(self):
        driver = Driver()
        driver._dordiai_selection = (frozenset({"alice", "bob"}), frozenset(), "uk")
        with self.assertRaises(ValueError):
            driver._dordiai_voice_for_language("uk", "clara")

    def test_forced_mode_uses_default_language_and_its_voice(self):
        driver = Driver()
        driver._dordiai_mode = "forced"
        driver._dordiai_voice_map = {"uk": "bob", "en": "clara"}
        self.assertEqual(driver._dordiai_language("en-US"), "uk")
        self.assertEqual(driver._dordiai_voice_for_language("en-US", "clara"), "bob")

    def test_disabled_and_unknown_languages_cannot_escape_filter(self):
        driver = Driver()
        self.assertEqual(driver._dordiai_language("de"), "uk")
        self.assertEqual(driver._dordiai_language("unknown"), "uk")
        self.assertEqual(driver._dordiai_filter_languages({"en-US", "de", "ru", "unknown"}), {"en-US", "ru"})

    def test_invalid_selection_is_rejected_before_cancellation(self):
        driver = Driver()
        for voices, languages in (([], ["uk"]), (["alice"], []), (["alice"], ["de"])):
            with self.subTest(voices=voices, languages=languages):
                with self.assertRaises(ValueError):
                    driver._dordiai_apply(voices, languages, languages[0] if languages else "uk", "alice", {})
        self.assertEqual(driver.cancellations, 0)

    def test_apply_and_profile_round_trip_preserve_mapping_and_disabled_defaults(self):
        driver = Driver()
        section = {}
        config_module = types.SimpleNamespace(conf={"speech": {driver.name: section}})
        handler_module = types.SimpleNamespace(changeVoice=lambda synth, voice: setattr(synth, "voice", voice))
        with patch.dict(sys.modules, config=config_module, synthDriverHandler=handler_module):
            driver._dordiai_apply(["bob", "clara"], ["en", "de"], "de", "clara", {},
                                 mode="forced", voice_map={"en": "bob", "de": "clara"})
            restored = Driver()
            restored.loadSettings()
        self.assertEqual(restored._dordiai_enabled_languages, {"en", "de"})
        self.assertEqual(restored._dordiai_selection[2], "de")
        self.assertEqual(restored._dordiai_mode, "forced")
        self.assertEqual(restored._dordiai_voice_map, {"en": "bob", "de": "clara"})
        self.assertEqual(section[prefs.ENABLED_LANGUAGES_KEY], "de en")

    def test_each_profile_keeps_independent_language_set(self):
        section_a = {prefs.ENABLED_LANGUAGES_KEY: "en"}
        section_b = {prefs.ENABLED_LANGUAGES_KEY: "ru"}
        driver = Driver()
        with patch.dict(sys.modules, config=types.SimpleNamespace(conf={"speech": {driver.name: section_a}})):
            driver.loadSettings()
            self.assertEqual(driver._dordiai_enabled_languages, {"en"})
        with patch.dict(sys.modules, config=types.SimpleNamespace(conf={"speech": {driver.name: section_b}})):
            driver.loadSettings(onlyChanged=True)
            self.assertEqual(driver._dordiai_enabled_languages, {"ru"})

    def test_unreadable_language_is_not_enabled_after_voice_removal(self):
        state = self.load({prefs.CONFIG_KEYS[0]: "bob clara"})
        self.assertEqual(state["enabled_languages"], {"uk", "ru"})

    def test_no_readable_language_is_an_explicit_error(self):
        with self.assertRaises(ValueError):
            prefs.load_preference_state({}, VOICES, LANGUAGES, lambda code: ())

    def test_installing_pack_does_not_silently_enable_it_on_save(self):
        driver = Driver()
        section = {}
        config_module = types.SimpleNamespace(conf={"speech": {driver.name: section}})
        with patch.dict(sys.modules, config=config_module):
            driver.loadSettings()
            driver._dordiai_all_languages = lambda: OrderedDict(**LANGUAGES, fr="French")
            driver.saveSettings()
        self.assertEqual(set(section[prefs.ENABLED_LANGUAGES_KEY].split()), {"uk", "en", "ru"})

    def test_synthesis_error_uses_nvda_queue_and_limits_repeated_notices(self):
        driver = Driver()
        queued, spoken = [], []
        event_queue = object()
        queue_module = types.SimpleNamespace(eventQueue=event_queue,
                                             queueFunction=lambda *args: queued.append(args))
        ui_module = types.SimpleNamespace(message=spoken.append)
        with patch.dict(sys.modules, queueHandler=queue_module, ui=ui_module):
            with patch("time.monotonic", side_effect=[10.0, 10.1, 16.0]):
                driver._dordiai_report_error(ValueError("Missing language resource"))
                driver._dordiai_report_error(ValueError("Repeated failure"))
                driver._dordiai_report_error(ValueError("Still unavailable"))
        self.assertEqual(len(queued), 2)
        self.assertIs(queued[0][0], event_queue)
        self.assertEqual(spoken, [])
        queued[0][1](queued[0][2])
        self.assertIn("Missing language resource", spoken[0])
        self.assertEqual(driver._dordiai_last_error, "Still unavailable")

    def test_incompatible_explicit_map_rejected(self):
        with self.assertRaises(ValueError):
            prefs.validate_preference_selection(VOICES, {"uk"}, "uk", "alice", VOICES, LANGUAGES,
                                                voice_map={"uk": "clara"}, compatible=compatible)


if __name__ == "__main__":
    unittest.main()
