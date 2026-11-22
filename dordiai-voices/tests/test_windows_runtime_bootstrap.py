"""Child DLL-reset contract tests, not native extension/model acceptance."""
import ast
import ctypes
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
spec = importlib.util.spec_from_file_location("windows_worker_bootstrap_test", RUNTIME / "windows_runtime.py")
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class WindowsRuntimeBootstrapTests(unittest.TestCase):
    def test_inherited_directory_is_reset_in_child_not_added_to_search(self):
        kernel = SimpleNamespace(GetDllDirectoryW=Mock(side_effect=[42, 0]), SetDllDirectoryW=Mock(return_value=1))
        with patch.object(bootstrap.os, "name", "nt"), patch.object(ctypes, "WinDLL", return_value=kernel, create=True):
            result = bootstrap.reset_inherited_dll_directory()
        kernel.SetDllDirectoryW.assert_called_once_with(None)
        self.assertEqual(kernel.GetDllDirectoryW.call_args_list[0].args, (0, None))
        self.assertTrue(result["reset_to_default"])
        self.assertTrue(result["inherited_directory_present"])
        self.assertFalse(result["directory_present_after_reset"])

    def test_noop_on_non_windows_does_not_load_a_dll(self):
        with patch.object(bootstrap.os, "name", "posix"), patch.object(ctypes, "WinDLL", create=True) as loader:
            result = bootstrap.reset_inherited_dll_directory()
        loader.assert_not_called()
        self.assertFalse(result["reset_to_default"])

    def test_failed_reset_is_not_misreported_as_success(self):
        kernel = SimpleNamespace(GetDllDirectoryW=Mock(return_value=12), SetDllDirectoryW=Mock(return_value=0))
        with patch.object(bootstrap.os, "name", "nt"), patch.object(ctypes, "WinDLL", return_value=kernel, create=True), \
                patch.object(ctypes, "get_last_error", return_value=5, create=True), \
                patch.object(ctypes, "WinError", return_value=OSError(5, "Denied"), create=True):
            with self.assertRaises(OSError):
                bootstrap.reset_inherited_dll_directory()

    def test_worker_resets_before_importing_model_request_helpers(self):
        tree = ast.parse((RUNTIME / "nvda_worker.py").read_text(encoding="utf-8"))
        reset = next(node.lineno for node in tree.body if isinstance(node, ast.Assign)
                     and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
                     and node.value.func.id == "reset_inherited_dll_directory")
        for node in tree.body:
            if isinstance(node, ast.ImportFrom) and node.module in {"session_control", "voice_policy"}:
                self.assertLess(reset, node.lineno)
        # The host driver must not change process-global Windows loader state.
        driver = (ROOT / "source/0.12.2/synthDrivers/kx47Preview.py").read_text(encoding="utf-8")
        self.assertNotIn("SetDllDirectory", driver)


if __name__ == "__main__":
    unittest.main()
