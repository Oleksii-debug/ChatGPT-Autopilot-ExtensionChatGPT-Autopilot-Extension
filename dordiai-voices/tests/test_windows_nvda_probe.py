"""Probe scaffolding tests; these explicitly do not run or simulate NVDA."""
import ast
import ctypes
import importlib.util
import inspect
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import zipfile

TOOLS = Path(__file__).resolve().parents[1] / "tools"
spec = importlib.util.spec_from_file_location("windows_probe_under_test", TOOLS / "windows_nvda_probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def helper_binding_errors(source):
    """Check actual embedded calls without importing or pretending to run NVDA."""
    tree = ast.parse(source.replace("__PROBE_SETTINGS__", "{}"))
    signatures = {}
    for definition in tree.body:
        if not isinstance(definition, ast.FunctionDef):
            continue
        arguments = definition.args
        positional = arguments.posonlyargs + arguments.args
        first_default = len(positional) - len(arguments.defaults)
        parameters = [inspect.Parameter(
            argument.arg,
            inspect.Parameter.POSITIONAL_ONLY if index < len(arguments.posonlyargs)
            else inspect.Parameter.POSITIONAL_OR_KEYWORD,
            default=object() if index >= first_default else inspect.Parameter.empty,
        ) for index, argument in enumerate(positional)]
        if arguments.vararg:
            parameters.append(inspect.Parameter(arguments.vararg.arg, inspect.Parameter.VAR_POSITIONAL))
        parameters.extend(inspect.Parameter(argument.arg, inspect.Parameter.KEYWORD_ONLY,
            default=inspect.Parameter.empty if default is None else object())
            for argument, default in zip(arguments.kwonlyargs, arguments.kw_defaults))
        if arguments.kwarg:
            parameters.append(inspect.Parameter(arguments.kwarg.arg, inspect.Parameter.VAR_KEYWORD))
        signatures[definition.name] = inspect.Signature(parameters)
    errors = []
    for call in ast.walk(tree):
        if (not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name)
                or call.func.id not in signatures or any(isinstance(arg, ast.Starred) for arg in call.args)
                or any(keyword.arg is None for keyword in call.keywords)):
            continue
        try:
            signatures[call.func.id].bind(*[object() for _ in call.args],
                **{keyword.arg: object() for keyword in call.keywords})
        except TypeError as error:
            errors.append({"helper": call.func.id, "line": call.lineno, "error": str(error)})
    return errors


class WindowsProbeScaffoldingTests(unittest.TestCase):
    def probe_tree(self):
        return ast.parse(probe.PROBE_PLUGIN.replace("__PROBE_SETTINGS__", "{}"))

    def test_recording_sink_is_explicit_double_and_validates_pcm(self):
        tree = self.probe_tree()
        definition = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "RecordingPCMSink")
        namespace = {}
        exec(compile(ast.Module(body=[definition], type_ignores=[]), "recording-sink-unit-test", "exec"), namespace)
        sink = namespace["RecordingPCMSink"](1, 24000, 16)
        self.assertTrue(sink._dordiai_recording_test_double)
        called = []
        sink.feed(b"\x01\x00", onDone=lambda: called.append(True))
        self.assertEqual(called, [True])
        with self.assertRaises(ValueError):
            sink.feed(b"odd")
        sink.close()
        with self.assertRaises(OSError):
            sink.feed(b"\x01\x00")

    def test_recording_double_accepts_actual_espeak_native_feed_signature(self):
        definition = next(node for node in self.probe_tree().body if isinstance(node, ast.ClassDef) and node.name == "RecordingPCMSink")
        namespace = {}
        exec(compile(ast.Module(body=[definition], type_ignores=[]), "native-recording-double", "exec"), namespace)
        sink = namespace["RecordingPCMSink"](1, 22050, 16)
        buffer = (ctypes.c_short * 2)(100, -100)
        callbacks = []
        sink.feed(ctypes.cast(buffer, ctypes.c_void_p), size=ctypes.sizeof(buffer), onDone=lambda: callbacks.append(True))
        self.assertEqual(sink.submitted_bytes, 4)
        self.assertGreater(sink.nonzero_bytes, 0)
        self.assertEqual(callbacks, [True])
        with self.assertRaises(ValueError):
            sink.feed(ctypes.c_void_p(), size=4)
        with self.assertRaises(ValueError):
            sink.feed(ctypes.cast(buffer, ctypes.c_void_p), size=3 * 1024 * 1024)

    def test_headless_probe_cannot_finish_as_passed_even_if_api_checks_pass(self):
        definition = next(node for node in self.probe_tree().body if isinstance(node, ast.FunctionDef) and node.name == "finish")
        result = {"checks": [{"status": "passed"}], "wave_player_verified": False, "physical_audio_verified": False,
                  "acoustic_latency_verified": False, "product_ready": False}
        namespace = {"FINISHED": False, "SETTINGS": {"headless_ui_probe": True}, "LATENCY_STOP": threading.Event(),
                     "restore_recovery_output_factory": lambda: None,
                     "DRIVER": None, "RESULT": result, "LOCK": threading.Lock(), "METRICS": {}, "SAMPLES": {},
                     "save": lambda: None, "time": time, "on_done": lambda: None,
                     "synthDriverHandler": SimpleNamespace(synthDoneSpeaking=SimpleNamespace(unregister=lambda callback: None)),
                     "core": SimpleNamespace(callLater=lambda *args: None, triggerNVDAExit=lambda: None)}
        exec(compile(ast.Module(body=[definition], type_ignores=[]), "headless-finish-unit-test", "exec"), namespace)
        namespace["finish"]()
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["wave_player_verified"])
        self.assertFalse(result["physical_audio_verified"])
        self.assertFalse(result["acoustic_latency_verified"])
        self.assertFalse(result["product_ready"])

    def test_fault_injection_runs_only_when_opted_in_after_complete_measurements(self):
        definition = next(node for node in self.probe_tree().body if isinstance(node, ast.FunctionDef) and node.name == "latency_finished")
        complete = {"count": 100, "p95_ms": 1, "p99_ms": 2}
        summary = {"warm_letters": complete, "cancel_api": complete, "warm_switch_requests": complete,
                   "languages": ["uk", "en"], "samples": {"errors": [], "timeouts": []}}
        for enabled in (False, True):
            events = []
            namespace = {"RESULT": {"checks": [{"name": phase + "_pcm_submission", "status": "passed"}
                                                for phase in ("phrase", "character")]},
                         "SETTINGS": {"headless_ui_probe": True, "fatal_recovery_probe": enabled},
                         "snapshot": lambda stage: {}, "check": lambda *a, **kw: None,
                         "later": lambda delay, callback: events.append(callback),
                         "finish": lambda: events.append("finish"), "start_fatal_recovery_probe": object()}
            exec(compile(ast.Module(body=[definition], type_ignores=[]), "optional-recovery-gate", "exec"), namespace)
            namespace["latency_finished"](summary)
            self.assertEqual(events, [namespace["start_fatal_recovery_probe"]] if enabled else ["finish"])

    def test_fatal_recovery_restores_output_factory_after_notification_boundary(self):
        names = {"restore_recovery_output_factory", "start_fatal_recovery_probe", "observe_fatal_recovery", "finish_fatal_recovery_probe"}
        definitions = [node for node in self.probe_tree().body if isinstance(node, ast.FunctionDef) and node.name in names]
        config = SimpleNamespace(conf={"speech": {"synth": "kx47Preview"}})
        factory = object()
        nvwave = SimpleNamespace(WavePlayer=factory)
        events, scheduled = [], []
        driver = SimpleNamespace(_closed=True, _thread=SimpleNamespace(is_alive=lambda: False))
        def report(error):
            self.assertIsInstance(error, ImportError)
            driver._dordiai_fatal_recovery_scheduled = True
        driver._dordiai_report_error = report
        active = [driver]
        namespace = {"SETTINGS": {"headless_ui_probe": True}, "RESULT": {}, "DRIVER": driver,
                     "RECOVERY_OUTPUTS": [], "RECOVERY_ORIGINAL_WAVE_FACTORY": None,
                     "synthDriverHandler": SimpleNamespace(getSynth=lambda: active[0]),
                     "RecordingPCMSink": object, "time": time,
                     "later": lambda delay, callback: scheduled.append(callback),
                     "finish": lambda: events.append("finish"),
                     "check": lambda name, status, **kw: events.append((name, status, kw))}
        exec(compile(ast.Module(body=definitions, type_ignores=[]), "injected-recovery-scaffolding", "exec"), namespace)
        with patch.dict("sys.modules", {"config": config, "nvwave": nvwave}):
            namespace["start_fatal_recovery_probe"]()
            self.assertTrue(namespace["RESULT"]["injected_fatal_recovery"]["queued_before_switch"])
            self.assertIsNot(nvwave.WavePlayer, factory)
            driver._dordiai_last_error_details = {"recovery": {"state": "builtin-espeak-selected", "espeak_selection_succeeded": True}}
            espeak_class = type("SynthDriver", (), {"__module__": "synthDrivers.espeak", "name": "espeak"})
            active[0] = espeak_class()
            namespace["RECOVERY_OUTPUTS"].append(SimpleNamespace(submitted_bytes=4, nonzero_bytes=2))
            namespace["observe_fatal_recovery"](time.monotonic() + 15)
            namespace["finish_fatal_recovery_probe"]()
        self.assertIs(nvwave.WavePlayer, factory)
        self.assertEqual(events[-1], "finish")
        self.assertEqual(events[-2][1], "passed")
        observations = events[-2][2]["observations"]
        self.assertFalse(observations["model_import_error_verified"])
        self.assertFalse(observations["physical_audio_verified"])

    def test_embedded_plugin_is_valid_python_without_executing_nvda(self):
        code = probe.PROBE_PLUGIN.replace("__PROBE_SETTINGS__", repr({"output": "C:/isolated/test", "run_id": "abc"}))
        compile(code, "dordiaiProbe.py", "exec")
        self.assertIn("synthDriverHandler.setSynth", code)
        self.assertIn("wx.UIActionSimulator", code)

    def test_actual_embedded_helper_calls_bind_their_signatures(self):
        self.assertEqual(helper_binding_errors(probe.PROBE_PLUGIN), [])

    def test_permanent_worker_or_host_import_failures_stop_requests(self):
        definition = next(node for node in self.probe_tree().body if isinstance(node, ast.FunctionDef)
                          and node.name == "permanent_speech_failure")
        namespace = {}
        exec(compile(ast.Module(body=[definition], type_ignores=[]), "permanent-error-check", "exec"), namespace)
        permanent = namespace["permanent_speech_failure"]
        self.assertTrue(permanent({"type": "ImportError", "import_name": "native"}))
        self.assertTrue(permanent({"type": "RuntimeError", "worker": {"type": "ModuleNotFoundError"}}))
        self.assertFalse(permanent({"type": "RuntimeError"}))
        self.assertFalse(permanent(None))

    def test_permanent_stage_failure_finishes_without_scheduling_retries(self):
        names = {"wait_for_stage", "permanent_speech_failure"}
        definitions = [node for node in self.probe_tree().body if isinstance(node, ast.FunctionDef) and node.name in names]
        events = []
        details = {"type": "RuntimeError", "worker": {"type": "ImportError", "import_name": "native"}}
        namespace = {"RESULT": {}, "snapshot": lambda stage: {"pcm_bytes": 0},
                     "DRIVER": SimpleNamespace(_dordiai_last_error_details=details, cancel=lambda: events.append("cancel")),
                     "check": lambda *args, **kw: events.append((args, kw)), "finish": lambda: events.append("finish"),
                     "later": lambda *args: self.fail("permanent error must not schedule more requests")}
        exec(compile(ast.Module(body=definitions, type_ignores=[]), "permanent-stage-check", "exec"), namespace)
        namespace["wait_for_stage"]("phrase", time.monotonic() + 150, lambda: self.fail("must finish"))
        self.assertEqual(events[-2:], ["cancel", "finish"])
        self.assertEqual(events[0][1]["diagnostics"], details)

    def test_signature_check_detects_original_driver_selection_failure(self):
        # Reproduce the exact error observed after real NVDA selected the
        # driver: positional check name collided with the name= detail.
        original_bug = probe.PROBE_PLUGIN.replace(
            "def check(check_name, status, **details):", "def check(name, status, **details):"
        ).replace("driver_name=DRIVER.name", "name=DRIVER.name")
        self.assertNotEqual(original_bug, probe.PROBE_PLUGIN)
        errors = helper_binding_errors(original_bug)
        self.assertTrue(any(row["helper"] == "check" and "multiple values" in row["error"] for row in errors), errors)

    def test_percentile_math_is_checked_without_running_nvda_plugin(self):
        tree = ast.parse(probe.PROBE_PLUGIN.replace("__PROBE_SETTINGS__", "{}"))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "percentiles")
        namespace = {}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "pure-percentiles", "exec"), namespace)
        result = namespace["percentiles"](list(range(1, 101)))
        self.assertEqual((result["p50_ms"], result["p95_ms"], result["p99_ms"]), (50, 95, 99))
        self.assertEqual(namespace["percentiles"]([])["count"], 0)

    def test_unverified_installer_cache_is_rejected_without_execution(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / "nvda.exe"
            cache.write_bytes(b"not the signed pinned installer")
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                probe.verified_installer(cache)

    def test_valid_cached_bytes_are_checked_and_reused(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / "nvda.exe"
            cache.write_bytes(b"test cache bytes")
            digest = probe.sha256_file(cache)
            with patch.object(probe, "NVDA_SHA256", digest):
                self.assertEqual(probe.verified_installer(cache), cache)

    def test_addon_extracted_only_under_isolated_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "test.nvda-addon"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("manifest.ini", 'name = "kx47Voices"')
                output.writestr("kx47Runtime/file.txt", "data")
            self.assertEqual(probe.addon_name(archive), "kx47Voices")
            probe.extract_addon(archive, root / "config" / "addons" / "test")
            self.assertEqual((root / "config/addons/test/kx47Runtime/file.txt").read_text(), "data")

    def test_archive_path_escape_rejected(self):
        for name in ("../escape", "C:/escape", "inside\\escape", "/absolute"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = root / "test.nvda-addon"
                with zipfile.ZipFile(archive, "w") as output:
                    output.writestr("manifest.ini", 'name = "probe"')
                    # ZipInfo's constructor rewrites Windows backslashes to
                    # slashes. Set the raw member name afterward so this is
                    # genuinely an unsafe ZIP fixture on every test host.
                    info = zipfile.ZipInfo("placeholder")
                    info.filename = name
                    output.writestr(info, "unsafe")
                with self.assertRaises(ValueError):
                    probe.extract_addon(archive, root / "config")

    def test_duplicate_windows_paths_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "test.nvda-addon"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("manifest.ini", 'name = "probe"')
                output.writestr("A.txt", "one")
                output.writestr("a.txt", "two")
            with self.assertRaises(ValueError):
                probe.extract_addon(archive, root / "config")

    def test_raw_backslash_rejected_even_when_zipinfo_normalized_filename(self):
        # Reproduce the Windows ZipInfo reader on every host. The raw name
        # must be checked before attempting to open or extract any member.
        member = zipfile.ZipInfo("inside/escape")
        member.orig_filename = "inside\\escape"
        archive = SimpleNamespace(namelist=lambda: ["manifest.ini", member.filename],
                                  infolist=lambda: [member])
        context = patch.object(probe.zipfile, "ZipFile")
        with tempfile.TemporaryDirectory() as temporary, context as factory:
            factory.return_value.__enter__.return_value = archive
            with self.assertRaisesRegex(ValueError, "Unsafe add-on archive member"):
                probe.extract_addon("unused-fixture.zip", Path(temporary) / "isolated")

    @unittest.skipIf(probe.os.name == "nt", "Linux guard test only")
    def test_linux_is_reported_blocked_without_download_or_nvda_stubs(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch("sys.stdout", new=io.StringIO()), patch.object(probe, "verified_installer") as downloader:
                code = probe.main(["--addon", "not-required-on-linux", "--output", temporary])
            result = json.loads((Path(temporary) / "windows-nvda-probe.json").read_text())
            self.assertEqual(code, 2)
            self.assertEqual(result["status"], "blocked")
            downloader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
