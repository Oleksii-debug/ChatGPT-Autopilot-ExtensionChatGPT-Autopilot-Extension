"""Profile behavior tests independent of wx and Windows audio."""
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from collections import OrderedDict
from unittest.mock import MagicMock, patch

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

    def test_settings_choices_use_actual_nvda_voiceinfo_display_name_api(self):
        """Exercise makeSettings with faithful parameter objects, not a GUI acceptance test."""
        class VoiceInfo:
            # NVDA VoiceInfo/StringParameterInfo exposes displayName, not name.
            __slots__ = ("id", "displayName", "language", "variant")

            def __init__(self, identifier, display_name, language=None, variant=None):
                self.id, self.displayName = identifier, display_name
                self.language, self.variant = language, variant

        driver = Driver()
        driver.description = "Dordiai test"
        for key in ("rate", "rateMultiplier", "volume", "pitch", "timbre"):
            setattr(driver, key, 2 if key == "rateMultiplier" else 50)
        choices = OrderedDict(auto=VoiceInfo("auto", "Автоматично"), uk=VoiceInfo("uk", "Українська", "uk"))
        self.assertFalse(hasattr(choices["uk"], "name"))
        for key, attribute in (("numberLanguage", "availableNumberlanguages"),
                               ("spellingLanguage", "availableSpellinglanguages"),
                               ("readingStyle", "availableReadingstyles")):
            setattr(driver, attribute, choices)
            setattr(driver, key, "uk")
        wx = MagicMock()
        helper = MagicMock()
        gui = types.ModuleType("gui")
        gui.guiHelper = types.SimpleNamespace(BoxSizerHelper=lambda *args, **kwargs: helper)
        settings = types.ModuleType("gui.settingsDialogs")
        settings.SettingsDialog = type("SettingsDialog", (), {})
        built = []

        def popup(dialog_type):
            dialog = dialog_type.__new__(dialog_type)
            dialog.voice_labels = VOICES
            dialog.language_labels = LANGUAGES
            dialog.original = driver._dordiai_selection
            dialog._checklist = MagicMock()
            dialog._update_choices = MagicMock()
            dialog._make_packages = MagicMock()
            dialog.Bind = MagicMock()
            dialog.makeSettings(MagicMock())
            built.append(dialog)

        gui.mainFrame = types.SimpleNamespace(popupSettingsDialog=popup)
        with patch.dict(sys.modules, {"wx": wx, "gui": gui, "gui.settingsDialogs": settings,
                                     "synthDriverHandler": types.SimpleNamespace(getSynth=lambda: driver)}):
            prefs.open_dialog(driver)
        self.assertEqual(len(built), 1)
        self.assertEqual(set(built[0].choices), {"numberLanguage", "spellingLanguage", "readingStyle"})
        selected = [call.kwargs["choices"] for call in helper.addLabeledControl.call_args_list
                    if call.args[0] in {"Мова чисел", "Мова кириличних літер", "Режим читання"}]
        self.assertEqual(selected, [["Автоматично", "Українська"]] * 3)


class PackageSpeechTests(unittest.TestCase):
    """Public NVDA selection contracts; these are not sound-device tests."""

    def setUp(self):
        self.original = types.SimpleNamespace(name="kx47Preview", saveSettings=MagicMock())
        self.current = self.original
        self.configured = "kx47Preview"
        self.calls = []
        self.speech = types.SimpleNamespace(cancelSpeech=MagicMock())
        self.handler = types.SimpleNamespace(getSynth=lambda: self.current, setSynth=self.select)

    def select(self, name, isFallback=False):
        self.calls.append((name, isFallback))
        self.current = types.SimpleNamespace(name=name, _dordiai_open_settings=MagicMock())
        if not isFallback:
            self.configured = name
        return True

    def modules(self):
        return patch.dict(sys.modules, {"speech": self.speech, "synthDriverHandler": self.handler})

    def test_maintenance_keeps_navigation_on_builtin_and_restores_fresh_driver(self):
        with self.modules():
            session = prefs.begin_package_speech(self.original)
            self.assertEqual(self.current.name, "espeak")
            self.assertIs(self.current, session["temporary_synth"])
            self.assertEqual(self.configured, "kx47Preview")
            result = prefs.finish_package_speech(session)
        self.assertTrue(result["restored"])
        self.assertIsNot(result["synth"], self.original)
        self.assertEqual(result["synth"].name, "kx47Preview")
        self.assertEqual(self.calls, [("espeak", True), ("kx47Preview", True)])
        self.original.saveSettings.assert_called_once_with()
        self.assertEqual(self.speech.cancelSpeech.call_count, 2)

    def test_user_synth_change_during_package_operation_is_respected(self):
        with self.modules():
            session = prefs.begin_package_speech(self.original)
            chosen = self.current = types.SimpleNamespace(name="oneCore")
            self.configured = "oneCore"
            result = prefs.finish_package_speech(session)
        self.assertFalse(result["restored"])
        self.assertTrue(result["user_changed_synth"])
        self.assertIs(result["synth"], chosen)
        self.assertEqual(self.calls, [("espeak", True)])
        self.assertEqual(self.configured, "oneCore")

    def test_manually_reselected_same_dordiai_gets_fresh_epoch_and_keeps_latest_settings(self):
        with self.modules():
            session = prefs.begin_package_speech(self.original)
            reselected = self.current = types.SimpleNamespace(name="kx47Preview", saveSettings=MagicMock())
            result = prefs.finish_package_speech(session)
        self.assertTrue(result["restored"])
        self.assertIsNot(result["synth"], reselected)
        reselected.saveSettings.assert_called_once_with()
        self.assertEqual(self.calls, [("espeak", True), ("kx47Preview", True)])

    def test_failed_reload_reports_failure_and_keeps_nvda_automatic_espeak_fallback(self):
        with self.modules():
            session = prefs.begin_package_speech(self.original)
            def fail_reload(name, isFallback=False):
                self.calls.append((name, isFallback))
                self.current = types.SimpleNamespace(name="espeak")
                return False
            self.handler.setSynth = fail_reload
            result = prefs.finish_package_speech(session)
        self.assertFalse(result["restored"])
        self.assertTrue(result["error"])
        self.assertEqual(result["synth"].name, "espeak")
        self.assertIn("Не вдалося перезавантажити", result["detail"])
        self.assertIn("залишено вбудований eSpeak", result["detail"])

    def test_reload_exception_activates_explicit_fallback_and_exposes_error(self):
        with self.modules():
            session = prefs.begin_package_speech(self.original)
            def fail_then_fallback(name, isFallback=False):
                if name == "kx47Preview":
                    self.current = None
                    raise RuntimeError("broken package index")
                return self.select(name, isFallback)
            self.handler.setSynth = fail_then_fallback
            result = prefs.finish_package_speech(session)
        self.assertTrue(result["error"])
        self.assertEqual(result["synth"].name, "espeak")
        self.assertIn("broken package index", result["detail"])
        self.assertEqual(self.configured, "kx47Preview")

    def test_no_package_mutation_can_start_without_spoken_builtin_selection(self):
        self.handler.setSynth = lambda name, isFallback=False: False
        with self.modules(), self.assertRaisesRegex(RuntimeError, "Пакет не змінено"):
            prefs.begin_package_speech(self.original)

    def test_different_current_synth_is_not_terminated_when_maintenance_is_requested(self):
        self.current = types.SimpleNamespace(name="oneCore")
        with self.modules(), self.assertRaisesRegex(RuntimeError, "інший синтезатор"):
            prefs.begin_package_speech(self.original)
        self.assertEqual(self.calls, [])
        self.original.saveSettings.assert_not_called()

    def _run_dialog_operation(self, fail):
        """Drive the actual dialog transaction methods, with queued UI callbacks."""
        self.original.description = "Dordiai test"
        queued, dialog_types, observed = [], [], []
        wx = MagicMock()
        wx.CallAfter = lambda callback, *args: queued.append((callback, args))
        gui = types.ModuleType("gui")
        gui.guiHelper = types.SimpleNamespace()
        gui.mainFrame = types.SimpleNamespace(popupSettingsDialog=dialog_types.append)
        gui.messageBox = MagicMock()
        settings = types.ModuleType("gui.settingsDialogs")
        class BaseDialog:
            def onCancel(self, event):
                self.closed = True
        settings.SettingsDialog = BaseDialog
        class ImmediateWorker:
            def __init__(self, target, **kwargs):
                self.target = target
            def start(self):
                self.target()
        ui = types.SimpleNamespace(message=lambda text: observed.append(("notice", self.current.name)))
        def operation():
            observed.append(("operation", self.current.name))
            if fail:
                raise ValueError("transaction rolled back")
        with self.modules(), patch.dict(sys.modules, {"wx": wx, "gui": gui,
            "gui.settingsDialogs": settings, "ui": ui}), patch("threading.Thread", ImmediateWorker):
            prefs.open_dialog(self.original)
            dialog = dialog_types[0].__new__(dialog_types[0])
            dialog.synth = self.original
            dialog._save = MagicMock(return_value=True)
            dialog.package_status = MagicMock()
            dialog.tabs = MagicMock()
            dialog.install_package = MagicMock()
            dialog.remove_package = MagicMock()
            dialog.rollback_package = MagicMock()
            dialog._package_busy = False
            dialog._run_package_operation("Робота з пакетом", operation)
            self.assertTrue(dialog._package_busy)
            self.assertEqual(observed, [("notice", "espeak"), ("operation", "espeak")])
            callback, args = queued.pop(0)
            callback(*args)
        self.assertFalse(dialog._package_busy)
        self.assertTrue(dialog.closed)
        self.assertIsNot(self.current, self.original)
        self.assertEqual(self.current.name, "kx47Preview")
        self.assertEqual(queued[0][0], self.current._dordiai_open_settings)
        detail = gui.messageBox.call_args.args[0]
        self.assertIn("автоматично перезавантажено", detail)
        self.assertEqual("transaction rolled back" in detail, fail)

    def test_dialog_package_success_reloads_and_reopens_fresh_settings(self):
        self._run_dialog_operation(False)

    def test_dialog_package_rollback_still_reloads_and_exposes_transaction_error(self):
        self._run_dialog_operation(True)


if __name__ == "__main__":
    unittest.main()
