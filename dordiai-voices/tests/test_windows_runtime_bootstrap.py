"""Child DLL-reset contract tests, not native extension/model acceptance."""
import ast
import ctypes
import importlib.util
import json
import os
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
spec = importlib.util.spec_from_file_location("windows_worker_bootstrap_test", RUNTIME / "windows_runtime.py")
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


def kernel_fixture(initial, *, clears=True, fails=False):
    state = [initial]
    def get_directory(size, buffer):
        if buffer is None:
            return len(state[0]) + 1
        buffer.value = state[0]
        return len(state[0])
    def set_directory(value):
        if fails:
            return 0
        if clears:
            state[0] = ""
        return 1
    return SimpleNamespace(GetDllDirectoryW=Mock(side_effect=get_directory),
                           SetDllDirectoryW=Mock(side_effect=set_directory))


@contextmanager
def windows_kernel(kernel):
    with patch.object(bootstrap.os, "name", "nt"), patch.object(ctypes, "WinDLL", return_value=kernel, create=True), \
            patch.object(ctypes, "set_last_error", create=True), \
            patch.object(ctypes, "get_last_error", return_value=0, create=True), \
            patch.object(ctypes, "WinError", return_value=OSError(5, "Denied"), create=True):
        yield


class WindowsRuntimeBootstrapTests(unittest.TestCase):
    def test_inherited_directory_is_reset_in_child_not_added_to_search(self):
        kernel = kernel_fixture("private-parent-dlls")
        with windows_kernel(kernel):
            result = bootstrap.reset_inherited_dll_directory()
        kernel.SetDllDirectoryW.assert_called_once_with(None)
        self.assertEqual(kernel.GetDllDirectoryW.call_args_list[0].args, (0, None))
        self.assertTrue(result["reset_to_default"])
        self.assertTrue(result["inherited_directory_present"])
        self.assertFalse(result["directory_present_after_reset"])

    def test_empty_string_required_size_one_is_not_a_directory(self):
        kernel = kernel_fixture("")
        self.assertEqual(kernel.GetDllDirectoryW(0, None), 1)
        with windows_kernel(kernel):
            result = bootstrap.reset_inherited_dll_directory()
        self.assertTrue(result["reset_to_default"])
        self.assertFalse(result["inherited_directory_present"])

    def test_nonempty_directory_after_reset_remains_a_failure(self):
        with windows_kernel(kernel_fixture("still-present", clears=False)):
            with self.assertRaisesRegex(OSError, "was not reset"):
                bootstrap.reset_inherited_dll_directory()

    def test_noop_on_non_windows_does_not_load_a_dll(self):
        with patch.object(bootstrap.os, "name", "posix"), patch.object(ctypes, "WinDLL", create=True) as loader:
            result = bootstrap.reset_inherited_dll_directory()
        loader.assert_not_called()
        self.assertFalse(result["reset_to_default"])

    def test_failed_reset_is_not_misreported_as_success(self):
        with windows_kernel(kernel_fixture("parent-dlls", fails=True)):
            with self.assertRaises(OSError):
                bootstrap.reset_inherited_dll_directory()

    @unittest.skipUnless(os.name == "nt", "Actual Windows loader API requires Windows")
    def test_real_windows_child_clears_directory_and_reads_empty_buffer(self):
        # Any deliberate loader-state mutation occurs inside this fresh child;
        # the unittest/NVDA host retains its own DLL search state.
        script = r'''
import ctypes, json, sys
from pathlib import Path
from ctypes import wintypes
kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.SetDllDirectoryW.argtypes = [wintypes.LPCWSTR]
kernel.SetDllDirectoryW.restype = wintypes.BOOL
assert kernel.SetDllDirectoryW(sys.argv[1])
sys.path.insert(0, sys.argv[1])
from windows_runtime import reset_inherited_dll_directory
result = reset_inherited_dll_directory()
kernel.GetDllDirectoryW.argtypes = [wintypes.DWORD, wintypes.LPWSTR]
kernel.GetDllDirectoryW.restype = wintypes.DWORD
buffer = ctypes.create_unicode_buffer(32768)
kernel.GetDllDirectoryW(len(buffer), buffer)
result["actual_after_string"] = buffer.value
print(json.dumps(result))
'''
        completed = subprocess.run([sys.executable, "-I", "-c", script, str(RUNTIME)],
                                   capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertTrue(result["inherited_directory_present"])
        self.assertTrue(result["reset_to_default"])
        self.assertEqual(result["actual_after_string"], "")

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
