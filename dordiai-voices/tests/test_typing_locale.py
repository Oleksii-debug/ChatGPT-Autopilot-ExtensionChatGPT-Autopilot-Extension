"""Scoped typing-locale tests; actual NVDA keyboard proof is a separate probe."""
import ast
from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
from threading import Thread
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
DRIVER = ROOT / "source/0.12.2/synthDrivers/kx47Preview.py"
PLUGIN = ROOT / "source/0.12.2/globalPlugins/dordiaiTyping.py"


def load_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def module(name, **values):
    result = ModuleType(name)
    result.__dict__.update(values)
    return result


class Point:
    def __init__(self):
        self.handlers = []
    def register(self, value):
        self.handlers.append(value)
    def unregister(self, value):
        self.handlers.remove(value)


class Suppress:
    def __init__(self, state):
        self.state = state


class NativeBase:
    def _get_language(self):
        return getattr(self, "base_language", "uk")


class PluginBase:
    def __init__(self):
        pass
    def terminate(self):
        self.terminated = True


class TypingLocaleTests(unittest.TestCase):
    def setUp(self):
        self.context = load_file("_typing_context_test", RUNTIME / "typing_locale.py")
        codes = load_file("_typing_codes_test", RUNTIME / "language_codes.py")
        tree = ast.parse(DRIVER.read_text(encoding="utf-8"))
        owner = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "SynthDriver")
        names = {"_get_language", "_dordiai_typing_context"}
        methods = [node for node in owner.body if isinstance(node, ast.FunctionDef) and node.name in names]
        cls = ast.ClassDef(name="Driver", bases=[ast.Name(id="NativeBase", ctx=ast.Load())],
                           keywords=[], body=methods, decorator_list=[])
        ns = {"NativeBase": NativeBase, "_typing_locale": self.context,
              "_prefs": SimpleNamespace(language_key=lambda value: codes.canonical_language(value, default="uk"))}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[])),
                     str(DRIVER), "exec"), ns)
        self.driver = ns["Driver"]()
        self.driver.name = "kx47Preview"
        self.driver._dordiai_mode = "auto"
        self.driver.spellingLanguage = "auto"
        self.driver._dordiai_enabled_languages = frozenset(("uk", "en", "ru"))
        self.obj = SimpleNamespace(windowThreadID=47)
        self.focus = self.obj
        self.protected = False
        self.layouts = []
        self.config = {"speech": {"trustVoiceLanguage": True, "autoLanguageSwitching": True,
                                  "kx47Preview": {"capPitchChange": 30, "sayCapForCapitals": True,
                                                 "beepForCapitals": True, "useSpellingFunctionality": True}},
                       "keyboard": {"speakTypedWords": 1, "speakTypedCharacters": 1}}
        self.args = SimpleNamespace(secure=False)
        self.speech = module("speech", filter_speechSequence=Point(), pre_speechQueued=Point())
        commands = module("speech.commands", SuppressUnicodeNormalizationCommand=Suppress)
        self.speech.commands = commands
        def get_layout(thread):
            self.layouts.append(thread)
            return 0x0419
        self.modules = {
            "api": module("api", getFocusObject=lambda: self.focus, isTypingProtected=lambda: self.protected),
            "config": module("config", conf=self.config),
            "globalPluginHandler": module("globalPluginHandler", GlobalPlugin=PluginBase),
            "globalVars": module("globalVars", appArgs=self.args),
            "languageHandler": module("languageHandler", windowsLCIDToLocaleName=lambda value: "ru_RU" if value == 0x0419 else None),
            "speech": self.speech, "speech.commands": commands,
            "synthDriverHandler": module("synthDriverHandler", getSynth=lambda: self.driver),
            "winBindings": module("winBindings", user32=SimpleNamespace(GetKeyboardLayout=get_layout)),
        }
        self.patch = patch.dict(sys.modules, self.modules)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.plugin_module = load_file("_production_typing_plugin_test", PLUGIN)
        self.plugin = self.plugin_module.GlobalPlugin()
        self.addCleanup(self.plugin.terminate)

    def test_real_event_scope_changes_getter_before_native_spelling_build_then_restores(self):
        observed = []
        self.plugin.event_typedCharacter(self.obj, lambda: observed.append(self.driver._get_language()), "а")
        self.assertEqual(observed, ["ru_RU"])
        self.assertEqual(self.driver._get_language(), "uk")
        self.assertEqual(self.layouts, [47, 47])

    def test_protected_input_keeps_normal_handler_and_never_reads_keyboard_or_stores_text(self):
        self.protected = True
        observed = []
        self.plugin.event_typedCharacter(self.obj, lambda: observed.append(self.driver._get_language()), "PRIVATE-FIXTURE")
        self.assertEqual(observed, ["uk"])
        self.assertEqual(self.layouts, [])
        self.assertIsNone(getattr(self.context._state, "current", None))

    def test_secure_or_foreign_focus_does_not_enable_context(self):
        for secure, foreign in ((True, False), (False, True)):
            with self.subTest(secure=secure, foreign=foreign):
                self.args.secure = secure
                self.focus = object() if foreign else self.obj
                seen = []
                self.plugin.event_typedCharacter(self.obj, lambda: seen.append(self.driver._get_language()), "а")
                self.assertEqual(seen, ["uk"])
        self.assertEqual(self.layouts, [])

    def test_forced_and_disabled_language_preferences_win(self):
        cases = (("forced", ("uk", "en", "ru"), "auto"),
                 ("auto", ("uk", "en"), "auto"))
        for mode, enabled, spelling in cases:
            with self.subTest(mode=mode, enabled=enabled, spelling=spelling):
                self.driver._dordiai_mode = mode
                self.driver._dordiai_enabled_languages = frozenset(enabled)
                self.driver.spellingLanguage = spelling
                values = []
                self.plugin.event_typedCharacter(self.obj, lambda: values.append(self.driver._get_language()), "а")
                self.assertEqual(values, ["uk"])

    def test_cyrillic_spelling_override_does_not_disable_word_or_english_symbol_locale(self):
        self.driver.spellingLanguage = "ru"
        for locale in ("uk_UA", "ru_RU", "en_US"):
            with self.subTest(locale=locale), self.driver._dordiai_typing_context(locale):
                self.assertEqual(self.driver._get_language(), locale)
        # Exercise the actual existing planner branch, not a replacement
        # naming table: the narrow Cyrillic override still selects Russian бэ.
        tree = ast.parse(DRIVER.read_text(encoding="utf-8"))
        tables = [node for node in tree.body if isinstance(node, ast.Assign)
                  and any(isinstance(target, ast.Name) and target.id in {"UK_LETTERS", "RU_LETTERS"}
                          for target in node.targets)]
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "core_character_parts")
        ns = {"core_character_units": lambda text, language: ((char, None) for char in text)}
        exec(compile(ast.Module(body=tables + [function], type_ignores=[]), str(DRIVER), "exec"), ns)
        self.assertEqual(list(ns["core_character_parts"]("б", "uk", "en-us", "ru")),
                         [("character", ("ru", "бэ"))])
        self.assertEqual(list(ns["core_character_parts"]("б", "uk", "en-us", "auto")),
                         [("character", ("uk", "бе"))])

    def test_context_setup_failure_does_not_prevent_normal_handler(self):
        def fail():
            raise RuntimeError("fixture protection query")
        self.modules["api"].isTypingProtected = fail
        calls = []
        self.plugin.event_typedCharacter(self.obj, lambda: calls.append("normal-handler"), "а")
        self.assertEqual(calls, ["normal-handler"])
        self.assertEqual(self.layouts, [])

    def test_valid_primary_does_not_query_voice_catalogue_getter(self):
        self.driver._dordiai_selection = (frozenset(), frozenset(), "en")
        with patch.object(NativeBase, "_get_language", side_effect=AssertionError("unnecessary catalogue lookup")):
            self.assertEqual(self.driver._get_language(), "en")

    def test_nvda_automatic_language_and_trust_settings_are_not_overridden(self):
        for key in ("trustVoiceLanguage", "autoLanguageSwitching"):
            self.config["speech"][key] = False
            before = deepcopy(self.config)
            observed = []
            self.plugin.event_typedCharacter(self.obj, lambda: observed.append(self.driver._get_language()), "а")
            self.assertEqual(observed, ["uk"])
            self.assertEqual(self.config, before)
            self.config["speech"][key] = True

    def test_word_and_character_echo_use_input_locale_without_changing_native_on_off_settings(self):
        # The ordinary native handler still decides whether to emit word and
        # character echo. Both name construction paths see the same locale.
        for words, chars in ((0, 1), (1, 1), (2, 1), (1, 0), (0, 0)):
            with self.subTest(words=words, chars=chars):
                self.config["keyboard"].update(speakTypedWords=words, speakTypedCharacters=chars)
                before = deepcopy(self.config)
                calls = []
                def normal_handler():
                    if self.config["keyboard"]["speakTypedWords"]:
                        calls.append(("native-word", self.driver._get_language()))
                    if self.config["keyboard"]["speakTypedCharacters"]:
                        calls.append(("native-character-name", self.driver._get_language()))
                self.plugin.event_typedCharacter(self.obj, normal_handler, ".")
                expected = ([("native-word", "ru_RU")] if words else [])
                if chars:
                    expected.append(("native-character-name", "ru_RU"))
                self.assertEqual(calls, expected)
                self.assertEqual(self.config, before)
                self.assertEqual(self.driver._get_language(), "uk")

    def test_configured_primary_and_forced_language_are_getter_fallback(self):
        self.driver._dordiai_selection = (frozenset(), frozenset(), "en")
        self.assertEqual(self.driver._get_language(), "en")
        self.driver._dordiai_mode = "forced"
        observed = []
        self.plugin.event_typedCharacter(self.obj, lambda: observed.append(self.driver._get_language()), "а")
        self.assertEqual(observed, ["en"])
        self.assertEqual(self.driver._get_language(), "en")
        del self.driver._dordiai_selection
        self.assertEqual(self.driver._get_language(), "uk")

    def test_invalid_or_disabled_primary_does_not_replace_base_language(self):
        self.driver._dordiai_selection = (frozenset(), frozenset(), "xx")
        self.assertEqual(self.driver._get_language(), "uk")
        self.driver._dordiai_selection = None
        self.assertEqual(self.driver._get_language(), "uk")
        self.driver.base_language = "base-default"
        self.driver._dordiai_selection = (frozenset(), frozenset(), None)
        self.assertEqual(self.driver._get_language(), "base-default")

    def test_document_spelling_with_ru_keyboard_outside_typing_is_unchanged(self):
        uk_command = SimpleNamespace(lang="uk")
        sequence = [Suppress(True), uk_command, "а", Suppress(False)]
        self.assertEqual(self.driver._get_language(), "uk")
        self.assertEqual(uk_command.lang, "uk")
        self.assertEqual(sequence[2], "а")
        self.assertEqual(self.speech.filter_speechSequence.handlers, [])
        self.assertEqual(self.speech.pre_speechQueued.handlers, [])
        self.assertEqual(self.layouts, [])
        seen = []
        self.plugin.event_typedCharacter(self.obj, lambda: seen.append(self.driver._get_language()), "а")
        self.assertEqual(seen, ["ru_RU"])
        self.assertEqual(self.driver._get_language(), "uk")
        self.assertEqual(uk_command.lang, "uk")

    def test_context_is_thread_local_and_nested_disabled_context_cannot_inherit_it(self):
        values = []
        with self.driver._dordiai_typing_context("ru_RU"):
            thread = Thread(target=lambda: values.append(self.driver._get_language()))
            thread.start()
            thread.join()
            self.assertEqual(values, ["uk"])
            with self.driver._dordiai_typing_context("xx_XX"):
                self.assertEqual(self.driver._get_language(), "uk")
            self.assertEqual(self.driver._get_language(), "ru_RU")
        self.assertEqual(self.driver._get_language(), "uk")

    def test_handler_exception_or_changed_security_predicate_clears_scope(self):
        def fail():
            self.assertEqual(self.driver._get_language(), "ru_RU")
            raise RuntimeError("fixture")
        with self.assertRaises(RuntimeError):
            self.plugin.event_typedCharacter(self.obj, fail, "а")
        self.assertEqual(self.driver._get_language(), "uk")
        with self.driver._dordiai_typing_context("ru", valid=lambda: not self.protected):
            self.protected = True
            self.assertEqual(self.driver._get_language(), "uk")

    def test_driver_language_property_explicitly_disables_auto_property_cache(self):
        tree = ast.parse(DRIVER.read_text(encoding="utf-8"))
        owner = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "SynthDriver")
        assignment = next(node for node in owner.body if isinstance(node, ast.Assign)
                          and any(isinstance(target, ast.Name) and target.id == "_cache_language" for target in node.targets))
        self.assertIs(ast.literal_eval(assignment.value), False)

    def test_plugin_does_not_emit_speech_or_modify_input_or_sequences(self):
        tree = ast.parse(PLUGIN.read_text(encoding="utf-8"))
        forbidden = {"speak", "speakText", "speakSpelling", "speakTypedCharacters",
                     "ActivateKeyboardLayout", "SendInput", "setSpeechMode", "queueEvent"}
        calls = {node.func.attr for node in ast.walk(tree)
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
        self.assertFalse(forbidden & calls)
        self.assertNotIn("getframe", PLUGIN.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
