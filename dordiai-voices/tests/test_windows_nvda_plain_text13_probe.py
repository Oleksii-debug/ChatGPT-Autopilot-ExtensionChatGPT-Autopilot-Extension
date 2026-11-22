import ast
import hashlib
import importlib.util
from pathlib import Path
from queue import Queue
import threading
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


OLD = load("windows_nvda_plain_text_probe")
NEW = load("windows_nvda_plain_text13_probe")


class BoundaryTests(unittest.TestCase):
    def setup_boundary(self, original=None):
        clock = types.SimpleNamespace(value=1000000000)
        time = types.SimpleNamespace(perf_counter_ns=lambda: clock.value, monotonic=lambda: clock.value / 1e9)
        state = {"boundary_lock": threading.Lock(), "boundary_serial": 0, "boundary_planners": 0,
                 "boundary_last_ns": 0, "active": None, "next_row": {}, "original_parts": original or (lambda *a, **k: iter(()))}
        driver = types.SimpleNamespace(_jobs=Queue(), _generation=1)
        seen = {"cancel": 0, "read": 0, "later": []}
        def cancel(): seen["cancel"] += 1
        speech = types.SimpleNamespace(cancelSpeech=cancel, isSpeaking=lambda: False)
        env = {"_PLAIN": state, "time": time, "DRIVER": driver,
               "synthDriverHandler": types.SimpleNamespace(getSynth=lambda: driver),
               "_plain_focus_owned": lambda: True, "_plain_current": lambda: state["active"],
               "later": lambda delay, fn: seen["later"].append(fn),
               "_plain_read_current_line": lambda: seen.__setitem__("read", seen["read"]+1)}
        exec(NEW.BOUNDARY_CODE + "\n" + NEW.OBSERVER_CODE, env)
        return env, state, clock, seen, speech

    def test_cancelled_old_planner_must_close_before_read_activates(self):
        title_part = ("text", {"text": "Old owned fixture title", "language": "en"})
        env, state, clock, seen, speech = self.setup_boundary(lambda *a, **k: iter((title_part,)))
        old = env["_plain_observe_parts"]()
        self.assertIs(next(old), title_part)
        self.assertEqual(state["boundary_planners"], 1)
        with patch.dict("sys.modules", {"speech": speech}):
            env["_plain_start_read_boundary"]()
            self.assertEqual(seen["cancel"], 1)
            clock.value += 1000000000
            env["_plain_wait_read_boundary"]()
            self.assertEqual(seen["read"], 0)
            self.assertIsNone(state["active"])
            old.close()
            clock.value += 300000000
            env["_plain_wait_read_boundary"]()
            self.assertEqual(seen["read"], 0)
            clock.value += 100000000
            env["_plain_wait_read_boundary"]()
            self.assertEqual(seen["read"], 1)
        self.assertEqual(state["boundary_planners"], 0)
        self.assertTrue(state["next_row"]["pre_read_quiescence"]["passed"])
        self.assertFalse(state["next_row"]["pre_read_quiescence"]["observer_active_before_read"])

    def test_current_read_forwards_every_part_and_never_filters_title_like_text(self):
        parts = [("text", {"text": "Old owned fixture title", "language": "en"}), ("index", 5)]
        env, state, clock, seen, speech = self.setup_boundary(lambda *a, **k: iter(parts))
        row = state["active"] = {"planned_routes": []}
        actual = list(env["_plain_observe_parts"]())
        for observed, expected in zip(actual, parts): self.assertIs(observed, expected)
        self.assertEqual(row["planned_routes"][0]["text"], "Old owned fixture title")
        self.assertEqual(state["boundary_planners"], 0)

    def test_queue_and_late_speech_activity_prevent_premature_read(self):
        env, state, clock, seen, speech = self.setup_boundary()
        env["DRIVER"]._jobs.put("pending")
        with patch.dict("sys.modules", {"speech": speech}):
            env["_plain_start_read_boundary"]()
            clock.value += 1000000000
            env["_plain_wait_read_boundary"]()
            self.assertEqual(seen["read"], 0)
            env["DRIVER"]._jobs.get_nowait()
            env["_plain_boundary_activity"]("late owned focus")
            env["_plain_wait_read_boundary"]()
            self.assertEqual(seen["cancel"], 2)
            self.assertEqual(seen["read"], 0)

    def test_bounded_refusal_instead_of_ignoring_busy_planner(self):
        env, state, clock, seen, speech = self.setup_boundary()
        state["boundary_planners"] = 1
        with patch.dict("sys.modules", {"speech": speech}):
            env["_plain_start_read_boundary"]()
            clock.value += 31000000000
            with self.assertRaises(TimeoutError): env["_plain_wait_read_boundary"]()
        self.assertEqual(seen["read"], 0)

    def test_planner_exception_and_close_release_activity_counter(self):
        def broken(*a, **k): raise ValueError("real source error")
        env, state, clock, seen, speech = self.setup_boundary(broken)
        with self.assertRaises(ValueError): next(env["_plain_observe_parts"]())
        self.assertEqual(state["boundary_planners"], 0)

    def test_original_workload_auditors_metadata_and_read_api_bodies_are_unchanged(self):
        old = ast.parse(OLD.PLUGIN_CODE)
        new = ast.parse(NEW.extend_boundary(OLD.PLUGIN_CODE))
        old_functions = {n.name: n for n in old.body if isinstance(n, ast.FunctionDef)}
        new_functions = {n.name: n for n in new.body if isinstance(n, ast.FunctionDef)}
        changed = {"_plain_observe_parts", "_plain_on_pre_speech", "_plain_on_queued", "_plain_on_synth",
                   "_plain_wait_focus", "start_actual_plain_text_probe"}
        for name, node in old_functions.items():
            if name not in changed:
                self.assertEqual(ast.dump(node, include_attributes=False),
                                 ast.dump(new_functions[name], include_attributes=False), name)
        self.assertEqual([ast.dump(n, include_attributes=False) for n in old.body if isinstance(n, ast.Assign)],
                         [ast.dump(n, include_attributes=False) for n in new.body if isinstance(n, ast.Assign)])

    def test_stale_boundary_anchor_fails_closed(self):
        with self.assertRaises(ValueError): NEW.extend_boundary(OLD.PLUGIN_CODE.replace("later(400, _plain_read_current_line)", "later(399, _plain_read_current_line)"))

    def test_retry_workflow_is_new_plain_only_and_pins_both_helpers(self):
        text = (ROOT.parent / ".github/workflows/dordiai-source13-plain-retry.yml").read_text(encoding="utf-8")
        self.assertIn("[source13-plain-retry]", text)
        self.assertIn("mode: [plain-text]", text)
        for filename, expected in (("windows_nvda_plain_text_probe.py", NEW.BASE_BLOB),
                                   ("windows_nvda_plain_text13_probe.py", None)):
            raw = (ROOT / "tools" / filename).read_bytes()
            digest = hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()
            self.assertEqual(digest, expected or digest)
            self.assertIn('"tools/' + filename + '":"' + digest + '"', text)
        self.assertIn('boundary.get("observer_active_before_read") is not False', text)
        self.assertIn('sample.get("active_planners")==0', text)
        self.assertIn('sample.get("queued_driver_jobs")==0', text)
        self.assertIn('subprocess.run(validation,check=True)', text)
        self.assertLess(text.index("pin=module.read_pin("), text.index("actual=fetch("))


if __name__ == "__main__": unittest.main()
