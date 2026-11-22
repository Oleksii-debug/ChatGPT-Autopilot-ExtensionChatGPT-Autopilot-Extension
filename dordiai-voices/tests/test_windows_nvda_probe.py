"""Probe scaffolding tests; these explicitly do not run or simulate NVDA."""
import ast
import ctypes
import importlib.util
import inspect
import io
import json
from pathlib import Path
import tempfile
import subprocess
import sys
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
        speech = SimpleNamespace(SpeechMode=SimpleNamespace(talk="talk"), mode="off")
        speech.setSpeechMode = lambda mode: setattr(speech, "mode", mode)
        driver = SimpleNamespace(_closed=True, _thread=SimpleNamespace(is_alive=lambda: False))
        def report(error):
            self.assertIsInstance(error, ImportError)
            self.assertEqual(speech.mode, "talk", "Recovery notice must not remain muted by the smoke harness")
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
        with patch.dict("sys.modules", {"config": config, "nvwave": nvwave, "speech": speech}):
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
                     "check": lambda *args, **kw: events.append((args, kw)),
                     "start_native_import_diagnostic": lambda: events.append("diagnostic"),
                     "later": lambda *args: self.fail("permanent error must not schedule more requests")}
        exec(compile(ast.Module(body=definitions, type_ignores=[]), "permanent-stage-check", "exec"), namespace)
        namespace["wait_for_stage"]("phrase", time.monotonic() + 150, lambda: self.fail("must finish"))
        self.assertEqual(events[-2:], ["cancel", "diagnostic"])
        self.assertEqual(events[0][1]["diagnostics"], details)

    def test_generated_plugin_includes_fixed_diagnostic_and_compiles(self):
        source = probe.PROBE_PLUGIN.replace("__PROBE_SETTINGS__", "{}").replace(
            "__NATIVE_IMPORT_DIAGNOSTIC__", repr(probe.NATIVE_IMPORT_DIAGNOSTIC))
        compile(source, "generated-real-nvda-plugin", "exec")
        compile(probe.NATIVE_IMPORT_DIAGNOSTIC, "fixed-import-only-child", "exec")
        self.assertNotIn("DRIVER.speak", probe.NATIVE_IMPORT_DIAGNOSTIC)

    def test_short_copy_diagnostic_control_flow_preserves_exact_module_bytes(self):
        # Deliberately pure Python fixture verifies the diagnostic's retry and
        # hashing logic. This test establishes no native DLL/Windows success.
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "diagnostic-original"
            runtime.mkdir()
            (runtime / "windows_runtime.py").write_text(
                'def reset_inherited_dll_directory(): return {"status":"fixture"}\n', encoding="utf-8")
            (runtime / "marisa_trie.py").write_text(
                'if "diagnostic-original" in __file__:\n'
                '    raise ImportError("fixed fixture original-path failure", name="marisa_trie")\n'
                'class RecordTrie: pass\n', encoding="utf-8")
            (runtime / "ukrainian_stress.py").write_text('def dictionary(): return object()\n', encoding="utf-8")
            completed = subprocess.run([sys.executable, "-I", "-c", probe.NATIVE_IMPORT_DIAGNOSTIC,
                str(runtime), temporary, "clean"], capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        report = json.loads(completed.stdout)
        self.assertEqual(report["installed_path_import"]["status"], "failed")
        self.assertEqual(report["short_copy_import"]["status"], "passed")
        self.assertTrue(report["short_copy"]["same_bytes"])
        self.assertEqual(report["short_copy"]["sha256"], report["extension"]["sha256"])
        self.assertEqual(report["short_copy"]["basename"], report["extension"]["basename"])
        self.assertTrue(report["dictionary_constructed"])

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


class RequiredResourceProbeScaffoldingTests(unittest.TestCase):
    """Owned file/control-flow tests only; actual NVDA proof runs on Windows."""

    def fixture(self, root):
        owned = Path(root).resolve() / "owned-probe"
        addon = owned / "config/addons/ownedDordiai"
        target = addon / "kx47Runtime" / probe.REQUIRED_RESOURCE_RELATIVE
        target.parent.mkdir(parents=True)
        original = b"owned model fixture bytes, never an inference graph" * 100
        target.write_bytes(original)
        return owned, addon, target, original

    def embedded(self, names):
        tree = ast.parse(probe.PROBE_PLUGIN.replace("__PROBE_SETTINGS__", "{}"))
        definitions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        namespace = {}
        exec(compile(ast.Module(body=definitions, type_ignores=[]), "required-resource-scaffolding", "exec"), namespace)
        return namespace

    def test_quarantine_is_atomic_owned_and_sha_identically_restored(self):
        with tempfile.TemporaryDirectory() as temporary:
            owned, addon, target, original = self.fixture(temporary)
            record = probe.quarantine_required_resource(addon, owned, "a" * 32)
            quarantine = Path(record["quarantine_path"])
            self.assertFalse(target.exists())
            self.assertEqual(quarantine.read_bytes(), original)
            self.assertTrue(record["asset_missing_before_nvda_launch"])
            self.assertFalse(record["restored"])
            result = probe.restore_required_resource(record)
            self.assertTrue(result["sha256_identical"])
            self.assertEqual(target.read_bytes(), original)
            self.assertFalse(quarantine.exists())
            self.assertTrue(record["restored"])
            # Cleanup remains safe if an earlier successful path restored it.
            self.assertEqual(probe.restore_required_resource(record), result)

    def test_outside_owned_configuration_is_never_mutated(self):
        with tempfile.TemporaryDirectory() as temporary:
            owned, addon, target, original = self.fixture(temporary)
            wrong_owned = Path(temporary) / "another-owned-probe"
            wrong_owned.mkdir()
            with self.assertRaises(ValueError):
                probe.quarantine_required_resource(addon, wrong_owned, "a" * 32)
            self.assertEqual(target.read_bytes(), original)

    def test_linked_asset_paths_are_refused_without_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            owned, addon, target, original = self.fixture(temporary)
            real = target.with_name("actual-model")
            target.rename(real)
            try:
                target.symlink_to(real)
            except OSError as error:
                self.skipTest("Host cannot create a symlink fixture: " + type(error).__name__)
            with self.assertRaises(ValueError):
                probe.quarantine_required_resource(addon, owned, "a" * 32)
            self.assertEqual(real.read_bytes(), original)

    def test_existing_quarantine_and_invalid_identifier_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            owned, addon, target, original = self.fixture(temporary)
            quarantine = target.with_name(target.name + "." + "a" * 32 + ".quarantine")
            quarantine.write_bytes(b"existing sentinel")
            with self.assertRaises(FileExistsError):
                probe.quarantine_required_resource(addon, owned, "a" * 32)
            with self.assertRaises(ValueError):
                probe.quarantine_required_resource(addon, owned, "../escape")
            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(quarantine.read_bytes(), b"existing sentinel")

    def test_unexpected_replacement_is_not_overwritten_during_restore(self):
        with tempfile.TemporaryDirectory() as temporary:
            owned, addon, target, original = self.fixture(temporary)
            record = probe.quarantine_required_resource(addon, owned, "a" * 32)
            target.write_bytes(b"unexpected replacement sentinel")
            with self.assertRaises(FileExistsError):
                probe.restore_required_resource(record)
            self.assertEqual(target.read_bytes(), b"unexpected replacement sentinel")
            self.assertEqual(Path(record["quarantine_path"]).read_bytes(), original)
            target.unlink()
            probe.restore_required_resource(record)
            self.assertEqual(target.read_bytes(), original)

    def test_modified_quarantine_cannot_be_reported_sha_identical(self):
        with tempfile.TemporaryDirectory() as temporary:
            owned, addon, target, original = self.fixture(temporary)
            record = probe.quarantine_required_resource(addon, owned, "a" * 32)
            Path(record["quarantine_path"]).write_bytes(b"changed bytes")
            with self.assertRaises(RuntimeError):
                probe.restore_required_resource(record)
            self.assertFalse(target.exists())
            self.assertFalse(record["restored"])
            Path(record["quarantine_path"]).write_bytes(original)
            probe.restore_required_resource(record)

    def test_cleanup_restores_even_if_owned_process_shutdown_raises(self):
        with tempfile.TemporaryDirectory() as temporary:
            owned, addon, target, original = self.fixture(temporary)
            record = probe.quarantine_required_resource(addon, owned, "a" * 32)
            with patch.object(probe, "stop_owned", side_effect=TimeoutError("owned process watchdog")):
                result = probe.cleanup_required_resource_probe(object(), record)
            self.assertEqual(result["status"], "failed")
            self.assertIn("owned_process_shutdown_error", result)
            self.assertTrue(result["restoration"]["sha256_identical"])
            self.assertEqual(target.read_bytes(), original)

    def test_cleanup_retains_explicit_restoration_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            owned, addon, target, original = self.fixture(temporary)
            record = probe.quarantine_required_resource(addon, owned, "a" * 32)
            with patch.object(probe, "stop_owned"), patch.object(probe, "restore_required_resource",
                    side_effect=OSError("controlled restoration fixture failure")):
                result = probe.cleanup_required_resource_probe(None, record)
            self.assertEqual(result["status"], "failed")
            self.assertIn("restoration_error", result)
            probe.restore_required_resource(record)
            self.assertEqual(target.read_bytes(), original)

    def test_quarantine_postrename_failure_rolls_back_before_record_escapes(self):
        with tempfile.TemporaryDirectory() as temporary:
            owned, addon, target, original = self.fixture(temporary)
            real_hash = probe.sha256_file
            calls = []
            def checked_hash(path):
                calls.append(Path(path))
                if len(calls) == 2:
                    raise OSError("controlled verification fixture failure")
                return real_hash(path)
            with patch.object(probe, "sha256_file", side_effect=checked_hash):
                with self.assertRaises(OSError):
                    probe.quarantine_required_resource(addon, owned, "a" * 32)
            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(list(target.parent.glob("*.quarantine")), [])

    def test_modes_are_explicit_and_mutually_exclusive(self):
        with tempfile.TemporaryDirectory() as temporary, patch("sys.stderr", new=io.StringIO()):
            with self.assertRaises(SystemExit) as context:
                probe.main(["--addon", "unused", "--output", temporary,
                            "--fatal-recovery-probe", "--required-resource-recovery-probe"])
        self.assertEqual(context.exception.code, 2)

    def test_settings_close_branches_before_normal_speech_only_when_requested(self):
        namespace = self.embedded({"close_settings"})
        normal, resource = object(), object()
        namespace.update(start_phrase=normal, start_required_resource_recovery_probe=resource)
        for selected in (False, True):
            callbacks = []
            namespace["SETTINGS"] = {"required_resource_recovery_probe": selected}
            namespace["later"] = lambda delay, callback: callbacks.append(callback)
            namespace["close_settings"](None)
            self.assertEqual(callbacks, [resource if selected else normal])

    def test_real_missing_resource_probe_never_injects_an_exception_or_ipc_reply(self):
        tree = ast.parse(probe.PROBE_PLUGIN.replace("__PROBE_SETTINGS__", "{}"))
        definition = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                          and node.name == "start_required_resource_recovery_probe")
        methods = [node.func.attr for node in ast.walk(definition)
                   if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)]
        self.assertEqual(methods.count("speak"), 1)
        self.assertNotIn("_dordiai_report_error", methods)
        self.assertNotIn("_send", methods)
        self.assertNotIn("_receive", methods)
        self.assertNotIn("setSynth", methods)
        calls = [node.func.id for node in ast.walk(definition)
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)]
        self.assertNotIn("ImportError", calls)
        self.assertNotIn("RuntimeError", calls)
        self.assertIn("validate_required_resource_probe_ownership", calls)
        self.assertIn("SpeechMode.talk", ast.unparse(definition))

    def test_controller_restoration_is_in_finally_and_quarantine_precedes_owned_launch(self):
        tree = ast.parse(inspect.getsource(probe.main))
        top_try = next(node for node in tree.body[0].body if isinstance(node, ast.Try))
        final_calls = [node.func.id for statement in top_try.finalbody for node in ast.walk(statement)
                       if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)]
        self.assertIn("cleanup_required_resource_probe", final_calls)
        quarantine_call = next(node for node in ast.walk(top_try)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id == "quarantine_required_resource")
        launches = [node for node in ast.walk(top_try)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "Popen"]
        self.assertTrue(any(launch.lineno > quarantine_call.lineno for launch in launches))

    def accepted_row(self):
        fixture = Path(__file__).resolve().parent / "fixtures/ruaccent_required_resource_worker.json"
        diagnostics = json.loads(fixture.read_text(encoding="utf-8"))["diagnostics"]
        return {"quarantine_verified_before_request": True, "asset_still_missing": True,
                "diagnostics": {"type": "RuntimeError", "worker": diagnostics},
                "active_synth": "espeak", "active_driver_module": "synthDrivers.espeak",
                "configured_synth_preserved": True, "old_driver_closed": True, "old_driver_thread_stopped": True,
                "recovery": {"reason": "required-resource-unavailable", "state": "builtin-espeak-selected",
                             "espeak_selection_succeeded": True},
                "notice_request_observed": True, "notice_request_synth": "espeak", "notice_pcm_nonzero_bytes": 10}


    def test_plugin_requires_same_owned_driver_worker_and_quarantine_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            owned, addon, target, original = self.fixture(temporary)
            runtime = addon / "kx47Runtime"
            executable = runtime / "python/python.exe"
            executable.parent.mkdir()
            executable.write_bytes(b"unit path fixture, never executed")
            script = runtime / "nvda_worker.py"
            script.write_text("# unit path fixture, never executed\n", encoding="utf-8")
            record = probe.quarantine_required_resource(addon, owned, "a" * 32)
            namespace = self.embedded({"validate_required_resource_probe_ownership"})
            driver_class = type("OwnedPathFixture", (), {"__module__": "owned_path_fixture"})
            driver = driver_class()
            driver._engine = SimpleNamespace(_command=[
                str(executable), "-I", "-B", "-u", str(script), str(runtime / "models")])
            namespace.update(Path=Path, sys=sys, OUTPUT=owned, DRIVER=driver,
                             SETTINGS={"run_id": "a" * 32, "required_resource_quarantine": record})
            with patch.dict(sys.modules, {"owned_path_fixture": SimpleNamespace(RUNTIME=runtime)}):
                self.assertEqual(namespace["validate_required_resource_probe_ownership"](), target)
                driver._engine._command[4] = str(executable)
                with self.assertRaises(ValueError):
                    namespace["validate_required_resource_probe_ownership"]()
            probe.restore_required_resource(record)
            self.assertEqual(target.read_bytes(), original)

    def test_probe_acceptance_requires_all_recovery_evidence_not_only_selected_synth(self):
        namespace = self.embedded({"required_resource_worker_diagnostic", "required_resource_recovery_passed"})
        passed = namespace["required_resource_recovery_passed"]
        self.assertTrue(passed(self.accepted_row()))
        for field in ("quarantine_verified_before_request", "asset_still_missing", "configured_synth_preserved",
                      "old_driver_closed", "old_driver_thread_stopped", "notice_request_observed"):
            with self.subTest(field=field):
                row = self.accepted_row()
                row[field] = False
                self.assertFalse(passed(row))
        for field, value in (("notice_pcm_nonzero_bytes", 0), ("active_synth", "silence"),
                             ("active_driver_module", "probe.stub"), ("notice_request_synth", "kx47Preview"),
                             ("diagnostics", {}), ("recovery", {}), ("recovery", None)):
            with self.subTest(field=field, value=value):
                row = self.accepted_row()
                row[field] = value
                self.assertFalse(passed(row))

    def test_probe_acceptance_requires_the_actual_typed_loader_error(self):
        namespace = self.embedded({"required_resource_worker_diagnostic", "required_resource_recovery_passed"})
        passed = namespace["required_resource_recovery_passed"]
        for error_type in ("ImportError", "TimeoutError", "UnsupportedMMSInput", "FileNotFoundError"):
            row = self.accepted_row()
            row["diagnostics"]["worker"]["type"] = error_type
            self.assertFalse(passed(row))
        row = self.accepted_row()
        row["diagnostics"]["worker"]["cause"]["type"] = "ConnectionError"
        self.assertFalse(passed(row))
        row = self.accepted_row()
        row["diagnostics"]["worker"]["frames"][-1]["module"] = "foreign.download"
        self.assertFalse(passed(row))


if __name__ == "__main__":
    unittest.main()
