"""Probe scaffolding only: no real keyboard, NVDA, model or acoustic pass."""
import ast
import ctypes
from contextlib import redirect_stderr
import importlib.util
import io
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"


def tool(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


base = tool("windows_nvda_typing_probe")
scenarios = tool("windows_nvda_typing_scenarios")


def definitions(source, namespace, *names):
    wanted = set(names)
    nodes = [node for node in ast.parse(source).body
             if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in wanted]
    if {node.name for node in nodes} != wanted:
        raise AssertionError("Missing actual probe definitions")
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])),
                 "actual-probe-scaffolding-only", "exec"), namespace)
    return namespace


def extra(namespace, *names):
    return definitions(scenarios.PLUGIN_CODE, namespace, *names)


class TypingScenarioTests(unittest.TestCase):
    def input_helpers(self):
        return definitions(base.PLUGIN_CODE, {"_typing_ct": ctypes},
            "_TypingMouse", "_TypingKeyboard", "_TypingHardware", "_TypingUnion", "_TypingInput",
            "_typing_key_events", "_typing_key_pair", "_typing_pending_keys")

    def test_extended_left_arrow_is_not_a_numpad_four(self):
        ns = self.input_helpers()
        values = ns["_typing_key_events"](0x4b, extended=True)
        self.assertEqual([item.data.ki.wVk for item in values], [0, 0])
        self.assertEqual([item.data.ki.wScan for item in values], [0x4b, 0x4b])
        self.assertEqual([item.data.ki.dwFlags for item in values], [0x09, 0x0b])
        self.assertEqual(ns["_typing_pending_keys"](values, 1), [(0x4b, True)])
        self.assertEqual(ns["_typing_pending_keys"](values, 2), [])
        release = ns["_typing_key_pair"](0x4b, extended=True)[1]
        self.assertEqual(release.data.ki.dwFlags, 0x0b)

    def test_backspace_remains_unextended_and_shift_ownership_is_unchanged(self):
        ns = self.input_helpers()
        backspace = ns["_typing_key_events"](0x0e)
        self.assertEqual([item.data.ki.dwFlags for item in backspace], [8, 10])
        shifted = ns["_typing_key_events"](2, shift=True)
        self.assertEqual(ns["_typing_pending_keys"](shifted, 2), [42, 2])

    def starter(self, scenario):
        namespace = {"SETTINGS": {"typing_scenario": scenario}, "_TYPING": None,
                     "_SCENARIO_ORIGINAL_CASES": tuple(range(9)), "RESULT": {"actual_typing": {}}}
        observed = []
        def start():
            observed.append((namespace["SETTINGS"]["typing_words"], namespace["_TYPING_CASES"]))
            namespace["_TYPING"] = {"cleaned": False}
        namespace["_ScenarioBaseStart"] = start
        extra(namespace, "_scenario_name", "start_actual_typing_probe")
        return namespace, observed

    def test_default_keeps_nine_cases_and_native_word_echo_on(self):
        ns, observed = self.starter("standard")
        ns["start_actual_typing_probe"]()
        self.assertEqual(observed, [(1, tuple(range(9)))])
        self.assertEqual(ns["RESULT"]["actual_typing"]["scenario"], "standard")

    def test_character_only_sets_native_word_echo_off_before_normal_setup(self):
        ns, observed = self.starter("characters-only")
        ns["start_actual_typing_probe"]()
        self.assertEqual(observed, [(0, tuple(range(9)))])
        self.assertNotIn("saved_preferences", ns["_TYPING"])

    def test_navigation_seeds_document_with_two_actual_keys(self):
        ns, observed = self.starter("navigation")
        ns["start_actual_typing_probe"]()
        self.assertEqual(observed, [(1, (("uk", "00000422", "б"), ("uk", "00000422", "ї")))])

    def test_character_only_removes_word_expectation_and_rejects_unexpected_echo(self):
        row = {"expected_word_echo": "ab"}
        ns = {"SETTINGS": {"typing_scenario": "characters-only"},
              "_TYPING": {"active": row, "cleaned": False}, "_ScenarioBaseSend": lambda: None}
        extra(ns, "_scenario_name", "_scenario_row", "_typing_send_case")
        ns["_typing_send_case"]()
        self.assertEqual(row["word_echo_must_be_absent"], "ab")
        self.assertNotIn("expected_word_echo", row)
        def wait(deadline):
            row.update(status="passed", routing_status="passed",
                       normal_typed_speech=[[{"text": "ab  "}], [{"text": "bang  "}]])
        ns["_ScenarioBaseWait"] = wait
        extra(ns, "_typing_wait_case")
        ns["_typing_wait_case"](123)
        self.assertEqual(row["status"], "failed")
        self.assertTrue(row["unexpected_native_word_echo"])

    def test_actual_preference_api_is_used_and_configuration_restored(self):
        for scenario in ("forced-uk", "disabled-ru"):
            with self.subTest(scenario=scenario):
                ns, observed = self.starter(scenario)
                section = {"saved": "original", "mode": "auto"}
                calls = []
                class Driver:
                    name = "kx47Preview"
                    voice = "fixture"
                    _dordiai_selection = (frozenset(), frozenset(), "uk")
                    _dordiai_enabled_languages = frozenset(("uk", "en", "ru"))
                    _dordiai_mode = "auto"
                    _dordiai_voice_map = {"ru": "fixture"}
                    def _dordiai_all_voices(self):
                        return {"fixture": object()}
                    def _dordiai_apply(self, voices, languages, default, voice, settings, mode=None, voice_map=None):
                        calls.append((list(voices), list(languages), default, voice, settings, mode, voice_map))
                        self._dordiai_selection = (frozenset(), frozenset(), default)
                        self._dordiai_enabled_languages = frozenset(languages)
                        self._dordiai_mode, self._dordiai_voice_map = mode, dict(voice_map)
                        section.update(mode=mode, new_key="generated by actual API fixture")
                driver = Driver()
                ns.update(DRIVER=driver, synthDriverHandler=SimpleNamespace(getSynth=lambda: driver))
                extra(ns, "_scenario_config_values", "_scenario_save_preferences", "_scenario_restore_preferences")
                config = SimpleNamespace(conf={"speech": {"kx47Preview": section}})
                with patch.dict(sys.modules, {"speech": SimpleNamespace(cancelSpeech=lambda: None), "config": config}):
                    ns["start_actual_typing_probe"]()
                    self.assertEqual(calls[0][2], "uk")
                    self.assertEqual(calls[0][5], "forced" if scenario == "forced-uk" else "auto")
                    self.assertEqual("ru" in calls[0][1], scenario == "forced-uk")
                    ns["_scenario_restore_preferences"]()
                self.assertEqual(len(calls), 2)
                self.assertEqual(section, {"saved": "original", "mode": "auto"})
                self.assertTrue(ns["RESULT"]["actual_typing"]["preference_restoration"]["restored"])
                self.assertEqual(driver._dordiai_enabled_languages, frozenset(("uk", "en", "ru")))

    def test_official_aggregated_section_protocol_roundtrip_needs_neither_keys_nor_delitem(self):
        values={"mode":"auto","rate":50}
        class Aggregated:
            def __iter__(self):
                return iter((*values,"spec-without-default"))
            def __getitem__(self,key):
                return values[key]
            def __setitem__(self,key,value):
                values[key]=value
            def items(self):
                return iter(values.items())
            def dict(self):
                return dict(self.items())
        section=Aggregated()
        with self.assertRaises(ValueError):
            dict(section)
        self.assertFalse(hasattr(section,"keys"))
        self.assertFalse(hasattr(section,"__delitem__"))
        class Driver:
            name="kx47Preview"
            voice="fixture"
            _dordiai_selection=(frozenset(),frozenset(),"uk")
            _dordiai_enabled_languages=frozenset(("uk","en","ru"))
            _dordiai_mode="auto"
            _dordiai_voice_map={}
            def _dordiai_all_voices(self):
                return {"fixture":object()}
            def _dordiai_apply(self,voices,languages,default,voice,settings,mode=None,voice_map=None):
                self._dordiai_selection=(frozenset(),frozenset(),default)
                self._dordiai_enabled_languages=frozenset(languages)
                self._dordiai_mode,self._dordiai_voice_map=mode,dict(voice_map)
                values["mode"]=mode
        driver=Driver()
        ns={"DRIVER":driver,"_TYPING":{},"RESULT":{"actual_typing":{}},
            "synthDriverHandler":SimpleNamespace(getSynth=lambda:driver)}
        extra(ns,"_scenario_config_values","_scenario_save_preferences","_scenario_restore_preferences")
        config=SimpleNamespace(conf={"speech":{"kx47Preview":section}})
        with patch.dict(sys.modules,{"config":config}):
            saved=ns["_scenario_save_preferences"]()
            ns["_TYPING"]["saved_preferences"]=saved
            driver._dordiai_apply(["fixture"],["uk","en"],"uk","fixture",{},mode="forced",voice_map={})
            ns["_scenario_restore_preferences"]()
        self.assertEqual(values,{"mode":"auto","rate":50})
        self.assertTrue(ns["RESULT"]["actual_typing"]["preference_restoration"]["restored"])

    def test_navigation_waits_for_real_speech_to_settle_with_bounded_timeout(self):
        clock={"now":0.}
        schedules,checks,finished=[],[],[]
        driver=object()
        state={"navigation_index":0}
        result={"actual_typing":{}}
        ns={"_TYPING":state,"RESULT":result,"DRIVER":driver,"_typing_focus_owned":lambda:True,
            "synthDriverHandler":SimpleNamespace(getSynth=lambda:driver),
            "time":SimpleNamespace(monotonic=lambda:clock["now"]),
            "later":lambda milliseconds,callback:schedules.append((milliseconds,callback)),
            "check":lambda name,status,**kw:checks.append((name,status,kw)),
            "finish":lambda:finished.append(True)}
        extra(ns,"_scenario_send_navigation")
        with patch.dict(sys.modules,{"speech":SimpleNamespace(isSpeaking=lambda:True)}):
            ns["_scenario_send_navigation"]()
            self.assertEqual(schedules[0][0],100)
            self.assertEqual(finished,[])
            clock["now"]=9.
            ns["_scenario_send_navigation"]()
        self.assertEqual(checks[-1][1],"blocked")
        self.assertIn("quiescent",checks[-1][2]["reason"])
        self.assertEqual(finished,[True])
        self.assertEqual(result["actual_typing"]["navigation_settle"]["0"]["polls"],2)

    def test_real_ru_input_is_retained_but_expected_route_is_uk_for_precedence(self):
        row = {"language": "ru", "glyph": "а"}
        for scenario in ("forced-uk", "disabled-ru"):
            ns = {"SETTINGS": {"typing_scenario": scenario},
                  "_TYPING": {"active": row, "cleaned": False}, "_ScenarioBaseSend": lambda: None}
            extra(ns, "_scenario_name", "_scenario_row", "_typing_send_case")
            ns["_typing_send_case"]()
            self.assertEqual(row["language"], "ru")
            self.assertEqual(row["expected_language"], "uk")

    def test_existing_index_boundaries_separate_word_pcm_from_symbol_pcm(self):
        counter = iter(range(100, 1000))
        clock = SimpleNamespace(perf_counter_ns=lambda: next(counter))
        driver = object()
        row = {"typed_events": [{"glyph": "!"}], "driver_sequences": []}
        state = {"active": row, "cleaned": False}
        IndexCommand = type("IndexCommand", (), {"__init__": lambda self, index: setattr(self, "index", index)})
        def sequence(items):
            return [{"text": item} if isinstance(item, str) else {"command": "IndexCommand", "index": item.index}
                    for item in items]
        forwarded = []
        def old_synth(items):
            row["driver_sequences"].append(sequence(items))
        def old_feed(data, *args, **kwargs):
            forwarded.append((data, args, kwargs))
            callback = kwargs.get("onDone")
            if callback:
                callback()
            return "original"
        ns = {"_TYPING": state, "time": clock, "DRIVER": driver,
              "synthDriverHandler": SimpleNamespace(getSynth=lambda: driver), "_typing_sequence": sequence,
              "_ScenarioBaseSynth": old_synth, "_ScenarioBaseFeed": old_feed}
        extra(ns, "_scenario_row", "_scenario_observable", "_scenario_indices", "_typing_on_synth", "_typing_on_feed")
        word, symbol = ["ab", IndexCommand(41)], ["bang", IndexCommand(42)]
        ns["_typing_on_synth"](word)
        ns["_typing_on_synth"](symbol)
        self.assertEqual(ns["_typing_on_feed"](b"\x01\x00"), "original")
        callback_events = []
        marker = lambda: callback_events.append("real existing callback")
        ns["_typing_on_feed"](b"\x00\x00", onDone=marker)
        ns["_typing_on_feed"](b"\x02\x00")
        ns["_typing_on_feed"](b"\x00\x00", onDone=marker)
        first, second = row["driver_utterances"]
        self.assertEqual(first["indices"], [41])
        self.assertEqual(second["indices"], [42])
        self.assertLess(first["first_pcm_submission_ns"], first["submission_closed_ns"])
        self.assertLess(first["submission_closed_ns"], second["first_pcm_submission_ns"])
        self.assertEqual(first["nonzero_chunks"], 1)
        self.assertEqual(second["nonzero_chunks"], 1)
        self.assertEqual(callback_events, ["real existing callback", "real existing callback"])
        self.assertIs(forwarded[1][2]["onDone"], marker)
        self.assertEqual(word[0], "ab")
        self.assertEqual(symbol[0], "bang")

    def test_planner_passthrough_retains_tuple_identity_and_generator_close(self):
        IndexCommand = type("IndexCommand", (), {"index": 17})
        value = {"language": "uk", "profile": "fixture", "character": True, "text": "бе"}
        item = ("character", value)
        closed = []
        def original(*args, **kwargs):
            try:
                yield item
            finally:
                closed.append(True)
        utterance = {"indices": [17], "planned_parts": []}
        row = {"action": "LeftArrow", "typed_events": [], "routes": [], "driver_utterances": [utterance]}
        ns = {"_TYPING": {"active": row, "cleaned": False}, "_ScenarioBaseParts": original,
              "time": SimpleNamespace(perf_counter_ns=lambda: 123)}
        extra(ns, "_scenario_row", "_scenario_observable", "_scenario_indices", "_typing_observe_parts")
        stream = ns["_typing_observe_parts"]([IndexCommand()])
        self.assertIs(next(stream), item)
        stream.close()
        self.assertEqual(closed, [True])
        self.assertEqual(row["routes"], [value])
        self.assertEqual(utterance["planned_parts"][0]["text"], "бе")

    def test_navigation_requires_real_uk_route_even_with_ru_input_layout(self):
        for language, emitted, expected in (("uk", "uk", "passed"), ("ru", "ru", "failed"), ("uk", "ru", "failed")):
            with self.subTest(language=language, emitted=emitted):
                row = {"action": "LeftArrow", "glyph": "<LeftArrow>", "language": "uk", "input_language": "ru",
                    "vk": 0x25, "extended": True, "expected_control_value": "б", "expected_insertion_point": 0,
                    "expected_label": "бе", "normal_typed_speech": [[{"text": "б"}]],
                    "driver_sequences": [[{"command": "LangChangeCommand", "lang": emitted}]],
                    "routes": [{"language": language, "text": "бе"}], "typed_events": [],
                    "raw_keys": [{"pressed": True, "injected": True, "vk": 0x25, "extended": True}],
                    "first_typing_pcm_ns": 200, "send_started_ns": 100}
                state = {"active": row, "cleaned": False, "navigation_index": 1,
                         "text": SimpleNamespace(GetValue=lambda: "б", GetInsertionPoint=lambda: 0)}
                ns = {"_TYPING": state, "DRIVER": SimpleNamespace(_dordiai_last_error=None),
                      "DONE": SimpleNamespace(is_set=lambda: True), "later": lambda *args: None,
                      "_scenario_send_navigation": object()}
                extra(ns, "_scenario_row", "_scenario_wait_navigation")
                definitions(base.PLUGIN_CODE, ns, "_typing_route_matches")
                with patch.dict(sys.modules, {"speech": SimpleNamespace(isSpeaking=lambda: False)}):
                    ns["_scenario_wait_navigation"](999)
                self.assertEqual(row["status"], expected)
                self.assertEqual(state["navigation_index"], 2)

    def test_unresolved_utterance_boundary_is_failure_not_a_silent_skip(self):
        checks = []
        row = {"glyph": "!", "driver_utterances": [{"ordinal": 0, "indices": [],
                "sequence": [{"text": "bang"}]}]}
        ns = {"RESULT": {"actual_typing": {"cases": [row]}},
              "check": lambda name, status, **kw: checks.append((name, status, kw))}
        extra(ns, "_scenario_check_utterance_observer")
        ns["_scenario_check_utterance_observer"]()
        self.assertEqual(checks[0][1], "failed")
        self.assertIn("unresolved", checks[0][2]["errors"][0]["reason"])

    def test_preference_restore_failure_cannot_prevent_other_cleanup(self):
        checks, cleaned = [], []
        ns = {"_TYPING": {"cleaned": False, "saved_preferences": {"fixture": True}},
              "RESULT": {"actual_typing": {}}, "_ScenarioBaseCleanup": lambda: cleaned.append(True),
              "check": lambda name, status, **kw: checks.append((name, status))}
        def fail():
            raise RuntimeError("fixture restore failure")
        ns["_scenario_restore_preferences"] = fail
        extra(ns, "_typing_cleanup")
        ns["_typing_cleanup"]()
        self.assertEqual(cleaned, [True])
        self.assertEqual(checks[0][1], "failed")

    def test_scenario_does_not_emit_speech_or_synthetic_locale_metadata(self):
        tree = ast.parse(scenarios.PLUGIN_CODE)
        forbidden = {"speak", "speakTypedCharacters", "speakSpelling", "queueEvent", "internal_keyDownEvent", "SetTimerResolution"}
        attributes = {node.func.attr for node in ast.walk(tree)
                      if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
        self.assertFalse(forbidden.intersection(attributes))
        self.assertFalse(any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                             and node.func.id == "LangChangeCommand" for node in ast.walk(tree)))
        self.assertNotIn("SetInsertionPoint", scenarios.PLUGIN_CODE)
        self.assertNotIn("ChangeValue", scenarios.PLUGIN_CODE)
        self.assertNotIn("PUMP_MAX_DELAY", scenarios.PLUGIN_CODE)

    def test_combined_plugin_compiles_and_nonstandard_cli_requires_typing_mode(self):
        controller = tool("windows_nvda_probe")
        source = controller.PROBE_PLUGIN.replace("__PROBE_SETTINGS__", "{}").replace(
            "__NATIVE_IMPORT_DIAGNOSTIC__", repr(controller.NATIVE_IMPORT_DIAGNOSTIC))
        combined = base.extend_plugin(source)
        compile(combined, "combined-probe-scaffolding-only", "exec")
        self.assertIn("def _scenario_wait_navigation", combined)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            controller.main(["--addon", "fixture", "--output", "fixture-output",
                             "--typing-scenario", "navigation"])
        self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
