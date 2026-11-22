"""Probe accounting/ownership contracts, never a substitute for real NVDA."""
import ast
from hashlib import sha1
import importlib.util
import inspect
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("resource_path_nvda_probe_test",
    ROOT/"tools/windows_nvda_resource_path_cache_probe.py")
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)


def pure_helpers():
    tree = ast.parse(TOOL.HOST_PLUGIN.replace("__HOST_MEMBERSHIP_SETTINGS__", repr({})))
    names = {"percentiles", "timed"}
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    namespace = {"time": time, "math": __import__("math")}
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])),
        "probe-actual-accounting-helpers", "exec"), namespace)
    return namespace


class FrozenWordCacheProbeTests(unittest.TestCase):
    def test_percentiles_use_even_median_and_nearest_rank_without_interpolation(self):
        stats = pure_helpers()["percentiles"]([4., 1., 3., 2.])
        self.assertEqual(stats["count"], 4)
        self.assertEqual(stats["median_ms"], 2.5)
        self.assertEqual(stats["p95_ms"], 4.)
        self.assertEqual(stats["total_ms"], 10.)
        with self.assertRaises(ValueError):
            pure_helpers()["percentiles"]([])

    def test_timed_lookup_checks_every_case_and_does_not_drop_shared_or_unknown(self):
        rows = [{"word": "мама", "memberships": ["ru", "uk"]},
                {"word": "я"*96, "memberships": []}]
        observed = []
        def lookup(word):
            observed.append(word)
            return {"ru", "uk"} if word == "мама" else set()
        stats = pure_helpers()["timed"](lookup, rows, 7)
        self.assertEqual(stats["count"], 7)
        self.assertEqual(observed, [row["word"] for row in rows]*3+["мама"])
        with self.assertRaisesRegex(ValueError, "membership differs"):
            pure_helpers()["timed"](lambda word: {"uk"}, rows, 1)

    def test_plugin_compiles_and_all_check_calls_bind(self):
        tree = ast.parse(TOOL.HOST_PLUGIN.replace("__HOST_MEMBERSHIP_SETTINGS__", repr({})))
        compile(tree, "real-frozen-cache-plugin", "exec")
        signature = inspect.Signature([
            inspect.Parameter("name", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            inspect.Parameter("passed", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            inspect.Parameter("details", inspect.Parameter.VAR_KEYWORD)])
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
            and isinstance(n.func, ast.Name) and n.func.id == "check"]
        self.assertGreaterEqual(len(calls), 7)
        for call in calls:
            signature.bind(*[object() for _ in call.args],
                **{kw.arg: object() for kw in call.keywords})

    def test_source_pin_rejects_changed_or_linked_code(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name)/"owned.py"
            path.write_bytes(b"original")
            blob = sha1(b"blob 8\0original").hexdigest()
            self.assertEqual(TOOL.pinned_source(path, blob), b"original")
            path.write_bytes(b"changed!")
            with self.assertRaisesRegex(ValueError, "Git identity"):
                TOOL.pinned_source(path, blob)
            linked = Path(name)/"link.py"
            try:
                linked.symlink_to(path)
            except OSError:
                return
            with self.assertRaises(ValueError):
                TOOL.pinned_source(linked, blob)

    def test_bad_real_input_rejected_before_external_copy(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            dataset = root/"dataset"
            run = root/"run"
            dataset.mkdir()
            run.mkdir()
            (dataset/"native-word-membership.bin").write_bytes(b"not-authenticated")
            with self.assertRaises(ValueError):
                TOOL.prepare_owned_inputs(dataset, run)
            self.assertFalse((run/"external-word-cache").exists())

    def test_main_only_composes_own_pinned_controller(self):
        controller = SimpleNamespace(main=lambda argv: (argv, controller.HOST_PLUGIN))
        with patch.object(TOOL, "base_controller", return_value=controller):
            actual = TOOL.main(["--output", "owned"])
        self.assertIs(controller.prepare_owned_inputs, TOOL.prepare_owned_inputs)
        self.assertEqual(actual, (["--output", "owned"], TOOL.HOST_PLUGIN))

    def test_nonwindows_is_blocked_by_original_controller_and_uses_no_product_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)/"report"
            original = TOOL.base_controller()
            with patch.object(original, "os", SimpleNamespace(name="posix")), \
                    patch.object(TOOL, "base_controller", return_value=original), patch("builtins.print"):
                code = TOOL.main(["--dataset-dir", directory, "--output", str(output)])
            self.assertEqual(code, 2)
            report = json.loads((output/"controller.json").read_text())
            self.assertEqual(report["status"], "blocked")
            self.assertFalse(report["product_archive_used"])
            self.assertFalse(report["nvda_host_verified"])

    def test_host_does_not_inject_audio_routing_or_replace_resource_checks(self):
        text = TOOL.HOST_PLUGIN
        self.assertNotIn("sys.path.insert", text)
        self.assertNotIn("synthDriverHandler.setSynth", text)
        self.assertNotIn("manager._verify =", text)
        self.assertIn("resource.candidates(cases[0][\"word\"])", text)
        self.assertIn("cancelled=lambda: True", text)
        self.assertIn("descriptor_change_rejected_even_after_cache_hit", text)
        self.assertIn('"production_routing_verified": False', text)
        self.assertIn('"physical_audio_verified": False', text)


if __name__ == "__main__":
    unittest.main()
