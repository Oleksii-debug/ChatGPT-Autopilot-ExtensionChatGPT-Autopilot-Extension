"""Inspect real boundary functions; no Windows/DLL/model execution is claimed."""
import ast
import importlib.util
import json
from pathlib import Path
from queue import Empty, Queue
import subprocess
import types
import unittest
from unittest.mock import patch
from time import monotonic
from threading import RLock
from threading import RLock

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
DRIVER = ROOT / "source/0.12.2/synthDrivers/kx47Preview.py"
spec = importlib.util.spec_from_file_location("safe_speech_error_under_test", RUNTIME / "error_diagnostics.py")
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)


def worker_methods(*names):
    tree = ast.parse(DRIVER.read_text(encoding="utf-8"))
    owner = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "SpeechWorker")
    body = [node for node in owner.body if isinstance(node, ast.FunctionDef) and node.name in names]
    cls = ast.ClassDef(name="Worker", bases=[], keywords=[], body=body, decorator_list=[])
    module = ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[]))
    namespace = dict(Empty=Empty, monotonic=monotonic, json=json, Path=Path, Queue=Queue,
                     subprocess=subprocess, Thread=types.SimpleNamespace)
    exec(compile(module, str(DRIVER), "exec"), namespace)
    return namespace


class ErrorDiagnosticsTests(unittest.TestCase):
    def test_frames_and_import_name_survive_but_message_source_locals_paths_do_not(self):
        secret = "PRIVATE-SPOKEN-TEXT-/users/private/document.txt"
        try:
            raise ModuleNotFoundError(secret, name="native.backend")
        except Exception as error:
            result = diagnostics.safe_error(error)
        self.assertEqual(result["type"], "ModuleNotFoundError")
        self.assertEqual(result["import_name"], "native.backend")
        self.assertEqual(result["frames"][-1]["function"], self._testMethodName)
        encoded = json.dumps(result)
        self.assertNotIn(secret, encoded)
        self.assertNotIn(str(ROOT), encoded)
        self.assertNotIn("source", result["frames"][0])

    def test_host_receive_preserves_child_import_diagnostics(self):
        namespace = worker_methods("_receive")
        worker = namespace["Worker"]()
        worker._responses = Queue()
        child = {"type": "ImportError", "import_name": "carrier", "frames": []}
        worker._responses.put(json.dumps({"error": "ImportError", "diagnostics": child}).encode("ascii"))
        worker.close = lambda: None
        with self.assertRaises(RuntimeError) as caught:
            worker._receive(1)
        self.assertEqual(diagnostics.safe_error(caught.exception)["worker"], child)

    def test_numeric_os_errors_are_retained_without_exception_message(self):
        error = OSError(13, "PRIVATE-REQUEST-TEXT")
        error.winerror = 126
        result = diagnostics.safe_error(error)
        self.assertEqual((result["errno"], result["winerror"]), (13, 126))
        self.assertNotIn("PRIVATE-REQUEST-TEXT", json.dumps(result))

    def test_numeric_cause_is_retained_without_exception_messages(self):
        try:
            try:
                error = OSError(126, "PRIVATE-NATIVE-TEXT")
                error.winerror = 126
                raise error
            except OSError as cause:
                raise ImportError("PRIVATE-IMPORT-TEXT", name="marisa_trie") from cause
        except ImportError as caught:
            result = diagnostics.safe_error(caught)
        self.assertEqual(result["cause"]["winerror"], 126)
        self.assertNotIn("PRIVATE-", json.dumps(result))

    def test_worker_popen_uses_its_trusted_script_directory(self):
        namespace = worker_methods("_send")
        observed = {}
        pipe = types.SimpleNamespace(write=lambda data: None, flush=lambda: None)
        process = types.SimpleNamespace(stdin=pipe, stdout=(), poll=lambda: None)
        def popen(command, **kwargs):
            observed.update(command=command, **kwargs)
            return process
        namespace["subprocess"] = types.SimpleNamespace(Popen=popen, PIPE=-1, DEVNULL=-3,
            CREATE_NO_WINDOW=1, BELOW_NORMAL_PRIORITY_CLASS=2)
        namespace["Thread"] = lambda **kw: types.SimpleNamespace(start=lambda: None)
        worker = namespace["Worker"]()
        worker._process = None
        worker._lifecycle_lock = RLock()
        worker._retired = False
        worker._lifecycle_lock = RLock()
        worker._retired = False
        worker._command = ["python.exe", "-I", "-B", "-u", str(RUNTIME / "nvda_worker.py"), "models"]
        worker._read = lambda *args: None
        worker._send({"mode": "cancel"})
        self.assertEqual(observed["cwd"], str(RUNTIME.resolve()))


if __name__ == "__main__":
    unittest.main()
