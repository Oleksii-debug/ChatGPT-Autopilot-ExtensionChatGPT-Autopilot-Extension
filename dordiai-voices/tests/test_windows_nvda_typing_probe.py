"""Typing probe scaffolding tests; no real keyboard/NVDA/model success claim."""
import ast
import ctypes
from contextlib import redirect_stderr
import importlib.util
import io
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
spec = importlib.util.spec_from_file_location("typing_probe_under_test", TOOLS / "windows_nvda_typing_probe.py")
typing_probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(typing_probe)


def nodes(*names):
    tree = ast.parse(typing_probe.PLUGIN_CODE)
    return [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]


def load_parts(namespace, *names):
    module = ast.fix_missing_locations(ast.Module(body=nodes(*names), type_ignores=[]))
    exec(compile(module, "typing-probe-scaffolding-only", "exec"), namespace)
    return namespace


class TypingProbeScaffoldingTests(unittest.TestCase):
    def test_real_win32_input_structure_size_and_scan_flags(self):
        ns = load_parts({"_typing_ct": ctypes}, "_TypingMouse", "_TypingKeyboard",
                        "_TypingHardware", "_TypingUnion", "_TypingInput", "_typing_key_events", "_typing_key_pair")
        expected = 40 if ctypes.sizeof(ctypes.c_void_p) == 8 else 28
        self.assertEqual(ctypes.sizeof(ns["_TypingInput"]), expected)
        pair = ns["_typing_key_pair"](30)
        self.assertEqual([item.type for item in pair], [1, 1])
        self.assertEqual([item.data.ki.wScan for item in pair], [30, 30])
        self.assertEqual([item.data.ki.wVk for item in pair], [0, 0])
        self.assertEqual([item.data.ki.dwFlags for item in pair], [8, 10])
        self.assertFalse(any(item.data.ki.dwFlags & 4 for item in pair), "Unicode injection bypasses the intended scan-code path")

    def test_shifted_scan_events_balance_and_partial_prefix_retains_only_owned_keys(self):
        ns = load_parts({"_typing_ct": ctypes}, "_TypingMouse", "_TypingKeyboard",
                        "_TypingHardware", "_TypingUnion", "_TypingInput",
                        "_typing_key_events", "_typing_key_pair", "_typing_pending_keys")
        values = ns["_typing_key_events"](2, shift=True)
        self.assertEqual([item.data.ki.wScan for item in values], [42, 2, 2, 42])
        self.assertEqual([item.data.ki.dwFlags for item in values], [8, 8, 10, 10])
        expected = ([], [42], [42, 2], [42], [])
        for count, pressed in enumerate(expected):
            self.assertEqual(ns["_typing_pending_keys"](values, count), pressed)

    def test_route_comparison_canonicalizes_en_variants_without_allowing_wrong_ru(self):
        ns = load_parts({}, "_typing_route_matches")
        self.assertTrue(ns["_typing_route_matches"]("en", ["en-us", "en_GB"]))
        self.assertTrue(ns["_typing_route_matches"]("ru", ["ru-RU"]))
        self.assertFalse(ns["_typing_route_matches"]("ru", ["uk"]))
        self.assertFalse(ns["_typing_route_matches"]("en", []))

    def test_official_nvda_raw_key_keyword_signature_is_nonblocking(self):
        # release-2026.3.1 keyboardHandler.internal_keyDownEvent calls the
        # Decider with exactly these five named fields.
        row = {"vk": 65, "raw_keys": []}
        ns = load_parts({"_TYPING": {"active": row, "cleaned": False}, "time": time}, "_typing_on_raw_key")
        accepted = ns["_typing_on_raw_key"](vkCode=65, scanCode=30, extended=False,
                                            pressed=True, injected=True)
        self.assertIs(accepted, True)
        self.assertEqual(len(row["raw_keys"]), 1)
        self.assertTrue(row["raw_keys"][0]["injected"])

    def test_generated_full_plugin_compiles_without_running_nvda(self):
        spec = importlib.util.spec_from_file_location("base_controller_for_typing_test", TOOLS / "windows_nvda_probe.py")
        controller = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(controller)
        base = controller.PROBE_PLUGIN.replace("__PROBE_SETTINGS__", "{}").replace(
            "__NATIVE_IMPORT_DIAGNOSTIC__", repr(controller.NATIVE_IMPORT_DIAGNOSTIC))
        combined = typing_probe.extend_plugin(base)
        compile(combined, "combined-owned-probe", "exec")
        self.assertIn("class GlobalPlugin(_TypingBaseGlobalPlugin)", combined)

    def test_probe_never_calls_a_speech_frontend_or_queues_fake_typed_events(self):
        tree = ast.parse(typing_probe.PLUGIN_CODE)
        forbidden = {"speak", "speakTypedCharacters", "speakSpelling", "queueEvent", "internal_keyDownEvent"}
        calls = [node.func.attr for node in ast.walk(tree)
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)]
        self.assertFalse(forbidden.intersection(calls))
        self.assertFalse(any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                             and node.func.id == "LangChangeCommand" for node in ast.walk(tree)))

    def observer(self, protected=False):
        tree = ast.parse(typing_probe.PLUGIN_CODE)
        original = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "GlobalPlugin")
        method = next(node for node in original.body if isinstance(node, ast.FunctionDef) and node.name == "event_typedCharacter")
        cls = ast.ClassDef(name="Observer", bases=[], keywords=[], body=[method], decorator_list=[])
        row = {"typed_events": []}
        state = {"active": row, "text": SimpleNamespace(GetHandle=lambda: 42),
                 "cleaned": False, "in_typed_handler": False}
        namespace = {"_TYPING": state, "time": time}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[])),
                     "typed-observer-unit-only", "exec"), namespace)
        api = SimpleNamespace(isTypingProtected=lambda: protected)
        return namespace["Observer"](), row, state, api

    def test_normal_handler_runs_and_context_is_scoped_to_owned_unprotected_event(self):
        observer, row, state, api = self.observer()
        seen = []
        with patch.dict(sys.modules, {"api": api}):
            observer.event_typedCharacter(SimpleNamespace(windowHandle=42),
                lambda: seen.append(state["in_typed_handler"]), "а")
        self.assertEqual(seen, [True])
        self.assertEqual([entry["glyph"] for entry in row["typed_events"]], ["а"])
        self.assertFalse(state["in_typed_handler"])

    def test_protected_event_does_not_record_character_or_enable_context(self):
        observer, row, state, api = self.observer(protected=True)
        seen = []
        with patch.dict(sys.modules, {"api": api}):
            observer.event_typedCharacter(SimpleNamespace(windowHandle=42),
                lambda: seen.append(state["in_typed_handler"]), "PRIVATE-FIXTURE")
        self.assertEqual(seen, [False])
        self.assertEqual(row["typed_events"], [])
        self.assertTrue(row["protected_event"])
        self.assertNotIn("PRIVATE-FIXTURE", repr(row))

    def test_normal_handler_exception_still_clears_context(self):
        observer, row, state, api = self.observer()
        def fail():
            raise RuntimeError("fixture")
        with patch.dict(sys.modules, {"api": api}), self.assertRaises(RuntimeError):
            observer.event_typedCharacter(SimpleNamespace(windowHandle=42), fail, "а")
        self.assertFalse(state["in_typed_handler"])

    def test_correct_keyboard_pipeline_does_not_hide_wrong_russian_route(self):
        rows = [
            {"status": "passed", "routing_status": "passed", "language": "uk", "glyph": "а",
             "emitted_languages": ["uk"], "effective_languages": ["uk"]},
            {"status": "passed", "routing_status": "mismatch", "language": "ru", "glyph": "а",
             "emitted_languages": ["uk"], "effective_languages": ["uk"]},
        ]
        events = []
        ns = load_parts({"RESULT": {"actual_typing": {"cases": rows}}, "_TYPING_CASES": (1, 2),
                         "check": lambda name, status, **kw: events.append((name, status, kw)),
                         "finish": lambda: None}, "_typing_finish_results")
        ns["_typing_finish_results"]()
        self.assertEqual(events[0][:2], ("actual_typing_keyboard_pipeline", "passed"))
        self.assertEqual(events[1][:2], ("actual_typing_language_routes", "failed"))
        self.assertEqual(events[1][2]["mismatches"][0]["glyph"], "а")

    def test_character_plan_is_observed_without_changing_yields_and_closes_on_cancel(self):
        closed, forwarded = [], []
        request = {"language": "ru", "profile": "fixture", "character": True, "text": "а"}
        item = ("character", request)
        def original(*args, **kwargs):
            forwarded.append((args, kwargs))
            try:
                yield item
                yield ("index", 47)
            finally:
                closed.append(True)
        row = {"typed_events": [{"glyph": "а"}], "routes": []}
        ns = load_parts({"_TYPING": {"original_parts": original, "active": row, "cleaned": False}},
                        "_typing_observe_parts")
        stream = ns["_typing_observe_parts"]("fixture-sequence", option=47)
        self.assertIs(next(stream), item)
        self.assertEqual(row["routes"], [request])
        stream.close()
        self.assertEqual(closed, [True])
        self.assertEqual(forwarded, [(("fixture-sequence",), {"option": 47})])

    def test_pcm_observer_preserves_feed_and_ignores_audio_before_driver_request(self):
        submitted = iter((100, 103))
        row = {"driver_request_ns": 102}
        calls = []
        state = {"active": row, "cleaned": False,
                 "original_feed": lambda data, *a, **kw: calls.append(data) or "original-result"}
        ns = load_parts({"_TYPING": state, "time": SimpleNamespace(perf_counter_ns=lambda: next(submitted))},
                        "_typing_on_feed")
        self.assertEqual(ns["_typing_on_feed"](b"\x01\x00"), "original-result")
        self.assertNotIn("first_typing_pcm_ns", row)
        self.assertEqual(ns["_typing_on_feed"](b"\x02\x00"), "original-result")
        self.assertEqual(row["first_typing_pcm_ns"], 103)
        self.assertEqual(calls, [b"\x01\x00", b"\x02\x00"])

    def test_cleanup_restores_other_state_after_one_observer_cleanup_error(self):
        events = []
        def broken_unregister(callback):
            raise RuntimeError("fixture unregister failure")
        config = SimpleNamespace(conf={"keyboard": {"speakTypedCharacters": 1}})
        mode = {"value": "talk"}
        speech = SimpleNamespace(
            pre_speechQueued=SimpleNamespace(unregister=lambda callback: events.append("unregister-queue")),
            cancelSpeech=lambda: events.append("cancel"), clearTypedWordBuffer=lambda: None,
            setSpeechMode=lambda value: mode.__setitem__("value", value),
            getState=lambda: SimpleNamespace(speechMode=mode["value"]))
        input_core = SimpleNamespace(decide_handleRawKey=SimpleNamespace(unregister=broken_unregister))
        original_parts = object()
        original_feed = object()
        driver = SimpleNamespace(_planned_parts=object(), _player=SimpleNamespace(feed=object()))
        state = {"cleaned": False, "active": {}, "pending_release": None,
                 "saved_keys": {"speakTypedCharacters": 0}, "saved_mode": "off",
                 "original_parts": original_parts, "original_feed": original_feed, "original_layout": 47, "loaded": [],
                 "user": SimpleNamespace(ActivateKeyboardLayout=lambda *args: 1, GetKeyboardLayout=lambda arg: 47),
                 "frame": SimpleNamespace(Destroy=lambda: events.append("destroy"))}
        result, checks = {"actual_typing": {}}, []
        ns = load_parts({"_TYPING": state, "DRIVER": driver, "RESULT": result,
                         "_typing_on_raw_key": object(), "_typing_on_queued": object(), "_typing_on_synth": object(),
                         "synthDriverHandler": SimpleNamespace(pre_synthSpeak=SimpleNamespace(unregister=lambda callback: events.append("unregister-synth"))),
                         "check": lambda name, status, **kw: checks.append((name, status))}, "_typing_cleanup")
        with patch.dict(sys.modules, {"config": config, "speech": speech, "inputCore": input_core}):
            ns["_typing_cleanup"]()
        self.assertIs(driver._planned_parts, original_parts)
        self.assertIs(driver._player.feed, original_feed)
        self.assertEqual(config.conf["keyboard"]["speakTypedCharacters"], 0)
        self.assertEqual(mode["value"], "off")
        self.assertIn("destroy", events)
        self.assertTrue(result["actual_typing"]["cleanup"]["keyboard_layout_restored"])
        self.assertEqual(checks[-1][1], "failed", "Cleanup failures must remain visible")

    def test_partial_shift_cleanup_releases_only_owned_pressed_scans_in_reverse(self):
        released = []
        config = SimpleNamespace(conf={"keyboard": {}})
        speech = SimpleNamespace(pre_speechQueued=SimpleNamespace(unregister=lambda cb: None),
            cancelSpeech=lambda: None, clearTypedWordBuffer=lambda: None,
            setSpeechMode=lambda mode: None, getState=lambda: SimpleNamespace(speechMode="off"))
        input_core = SimpleNamespace(decide_handleRawKey=SimpleNamespace(unregister=lambda cb: None))
        state = {"cleaned": False, "active": None, "pending_releases": [42, 2],
                 "saved_keys": {}, "saved_mode": "off", "original_layout": 47, "loaded": [],
                 "original_parts": object(), "original_feed": object(),
                 "frame": SimpleNamespace(Destroy=lambda: None)}
        def send(count, pointer, size):
            packet = ctypes.cast(pointer, ctypes.POINTER(ns["_TypingInput"])).contents
            released.append((packet.data.ki.wScan, packet.data.ki.dwFlags))
            return 1
        state["user"] = SimpleNamespace(SendInput=send, ActivateKeyboardLayout=lambda *args: 1,
                                        GetKeyboardLayout=lambda thread: 47)
        checks = []
        ns = load_parts({"_typing_ct": ctypes, "_TYPING": state, "RESULT": {"actual_typing": {}},
            "DRIVER": SimpleNamespace(_planned_parts=None, _player=SimpleNamespace(feed=None)),
            "_typing_on_raw_key": object(), "_typing_on_queued": object(), "_typing_on_synth": object(),
            "synthDriverHandler": SimpleNamespace(pre_synthSpeak=SimpleNamespace(unregister=lambda cb: None)),
            "check": lambda name, status, **kw: checks.append(status)},
            "_TypingMouse", "_TypingKeyboard", "_TypingHardware", "_TypingUnion", "_TypingInput",
            "_typing_key_events", "_typing_key_pair", "_typing_cleanup")
        with patch.dict(sys.modules, {"config": config, "speech": speech, "inputCore": input_core}):
            ns["_typing_cleanup"]()
        self.assertEqual(released, [(2, 10), (42, 10)])
        self.assertEqual(checks[-1], "passed")

    def test_standalone_controller_enables_explicit_typing_mode_once(self):
        captured = []
        controller = SimpleNamespace(main=lambda args: captured.append(args) or 7)
        with patch.dict(sys.modules, {"windows_nvda_probe": controller}):
            self.assertEqual(typing_probe.main(["--addon", "fixture", "--output", "fixture-output"]), 7)
        self.assertEqual(captured[0].count("--typing-probe"), 1)

    def test_typing_mode_is_mutually_exclusive_with_recovery(self):
        spec = importlib.util.spec_from_file_location("base_controller_typing_flags", TOOLS / "windows_nvda_probe.py")
        controller = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(controller)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            controller.main(["--addon", "fixture", "--output", "fixture-output",
                             "--typing-probe", "--fatal-recovery-probe"])
        self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
