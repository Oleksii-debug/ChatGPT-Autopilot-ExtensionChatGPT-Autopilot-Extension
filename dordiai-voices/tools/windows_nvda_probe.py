#!/usr/bin/env python3
"""Run a real, isolated portable NVDA smoke probe on a Windows worker.

No existing NVDA instance is stopped. Only processes started by this probe may
be terminated. Results deliberately distinguish PCM submitted to WavePlayer
from loopback audio, pronunciation assessment and release latency acceptance.

Official CLI documentation:
https://download.nvaccess.org/documentation/en/userGuide.html#CommandLineOptions
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
import uuid
import zipfile

NVDA_VERSION = "2026.3.1"
NVDA_URL = "https://download.nvaccess.org/releases/2026.3.1/nvda_2026.3.1.exe"
NVDA_SHA256 = "6f80a5b0ca720a7d0d314b5be212f37388bbe81a1107ac3298c1821a1cd3f052"
SCOPE = "isolated-real-windows-nvda-smoke"

# Fixed import-only code: no speech request, user text or arbitrary code input.
# A short-copy retry is diagnostic only and never changes the installed add-on.
NATIVE_IMPORT_DIAGNOSTIC = r'''
import contextlib, ctypes, hashlib, importlib.util, json, os, shutil, sys, tempfile
from pathlib import Path
runtime, parent_app, mode = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
sys.path.insert(0, str(runtime))
roots = [(str(runtime), "<runtime>"), (str(parent_app), "<nvda>"),
         (os.environ.get("USERPROFILE", ""), "<profile>")]
def error_details(error):
    message = str(error)
    for value, replacement in roots:
        if value:
            message = message.replace(value, replacement)
    return {"type": type(error).__name__, "message": message[:4096],
            "import_name": getattr(error, "name", None), "errno": getattr(error, "errno", None),
            "winerror": getattr(error, "winerror", None)}
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
def path_row(path):
    return {"basename": path.name, "path_length": len(str(path)), "exists": path.is_file(),
            "sha256": digest(path)}
def loaded_dlls():
    rows = []
    if os.name != "nt":
        return rows
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetModuleHandleW.argtypes = [ctypes.c_wchar_p]
    kernel.GetModuleHandleW.restype = ctypes.c_void_p
    kernel.GetModuleFileNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint]
    kernel.GetModuleFileNameW.restype = ctypes.c_uint
    for name in ("python314.dll", "MSVCP140.dll", "VCRUNTIME140.dll", "VCRUNTIME140_1.dll"):
        handle = kernel.GetModuleHandleW(name)
        if not handle:
            rows.append({"name": name, "loaded": False})
            continue
        buffer = ctypes.create_unicode_buffer(32768)
        kernel.GetModuleFileNameW(handle, buffer, len(buffer))
        path = Path(buffer.value)
        location = "other"
        for folder, label in ((runtime, "runtime"), (parent_app, "nvda"),
                              (Path(os.environ.get("SystemRoot", "C:/Windows")), "windows")):
            if path.is_relative_to(folder):
                location = label
                break
        rows.append(dict(path_row(path), name=name, loaded=True, location=location))
    return rows
report = {"scope": "fixed import-only child diagnostic; no TTS input or production fix", "mode": mode,
          "python_version": sys.version.split()[0], "pointer_bits": ctypes.sizeof(ctypes.c_void_p) * 8,
          "runtime_path_length": len(str(runtime)), "executable_path_length": len(sys.executable),
          "path_entries": [{"basename": Path(item).name, "length": len(item),
              "sha256": hashlib.sha256(item.encode()).hexdigest()} for item in os.environ.get("PATH", "").split(os.pathsep) if item]}
try:
    with contextlib.redirect_stdout(sys.stderr):
        from windows_runtime import reset_inherited_dll_directory
        report["bootstrap"] = reset_inherited_dll_directory()
        spec = importlib.util.find_spec("marisa_trie")
        origin = Path(spec.origin) if spec and spec.origin else None
        report["extension"] = path_row(origin) if origin else None
        report["loaded_before"] = loaded_dlls()
        report["dll_candidates"] = [{"directory": label, **path_row(folder / "MSVCP140.dll")}
            for label, folder in (("private_python", Path(sys.executable).parent),
                ("extension", origin.parent if origin else runtime), ("nvda", parent_app),
                ("system32", Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32"))]
        if mode == "worker-import-order":
            import ukrainian_voices, voice_controls, voice_delivery, speech_tempo
        try:
            import marisa_trie
            from marisa_trie import RecordTrie
            report["installed_path_import"] = {"status": "passed"}
        except Exception as error:
            report["installed_path_import"] = {"status": "failed", "error": error_details(error)}
            if os.name == "nt" and origin is not None and origin.is_file():
                extended = ("\\\\?\\UNC\\" + str(origin)[2:] if str(origin).startswith("\\\\")
                            else "\\\\?\\" + str(origin))
                report["extended_path_length"] = len(extended)
                try:
                    sys.modules.pop("marisa_trie", None)
                    extended_spec = importlib.util.spec_from_file_location("marisa_trie", extended)
                    module = importlib.util.module_from_spec(extended_spec)
                    sys.modules["marisa_trie"] = module
                    extended_spec.loader.exec_module(module)
                    from marisa_trie import RecordTrie
                    report["extended_path_import"] = {"status": "passed", "same_origin_bytes": True}
                except Exception as extended_error:
                    sys.modules.pop("marisa_trie", None)
                    report["extended_path_import"] = {"status": "failed", "error": error_details(extended_error)}
            if origin is not None and origin.is_file() and report.get("extended_path_import", {}).get("status") != "passed":
                with tempfile.TemporaryDirectory(prefix="dv-pyd-", ignore_cleanup_errors=True) as temporary:
                    short_path = Path(temporary) / origin.name
                    shutil.copyfile(origin, short_path)
                    report["short_copy"] = dict(path_row(short_path), same_bytes=digest(short_path) == digest(origin))
                    try:
                        sys.modules.pop("marisa_trie", None)
                        short_spec = importlib.util.spec_from_file_location("marisa_trie", short_path)
                        module = importlib.util.module_from_spec(short_spec)
                        sys.modules["marisa_trie"] = module
                        short_spec.loader.exec_module(module)
                        from marisa_trie import RecordTrie
                        report["short_copy_import"] = {"status": "passed"}
                    except Exception as short_error:
                        sys.modules.pop("marisa_trie", None)
                        report["short_copy_import"] = {"status": "failed", "error": error_details(short_error)}
        report["loaded_after"] = loaded_dlls()
        if any(report.get(key, {}).get("status") == "passed" for key in
               ("installed_path_import", "extended_path_import", "short_copy_import")):
            try:
                from ukrainian_stress import dictionary
                dictionary()
                report["dictionary_constructed"] = True
            except Exception as error:
                report["dictionary_error"] = error_details(error)
    report["status"] = "completed-diagnostic"
except Exception as error:
    report.update(status="failed-diagnostic", error=error_details(error))
print(json.dumps(report))
'''

# This code runs inside the downloaded, unmodified NVDA interpreter. Normal
# mode uses actual Windows audio. Explicit --headless-ui-probe substitutes
# only the output sink, with physical/device acceptance always blocked.
PROBE_PLUGIN = r'''
import array
import json
from pathlib import Path
import platform
import sys
import threading
import time
import traceback
import wave
NATIVE_IMPORT_DIAGNOSTIC = __NATIVE_IMPORT_DIAGNOSTIC__

import core
import globalPluginHandler
import synthDriverHandler
import wx

SETTINGS = __PROBE_SETTINGS__
OUTPUT = Path(SETTINGS["output"])
RESULT = {
    "format_version": 1, "scope": "isolated-real-windows-nvda-smoke",
    "status": "running", "run_id": SETTINGS["run_id"],
    "platform": platform.platform(), "nvda_version_expected": "2026.3.1",
    "checks": [], "limitations": [
        "PCM recorded before the physical output device is not a WASAPI loopback recording.",
        "This smoke probe does not certify pronunciation, perceived voice identity or acoustic latency percentiles.",
        "One keyboard smoke check is not a complete accessibility assessment.",
    ],
    "wave_player_verified": False,
    "physical_audio_verified": False,
    "acoustic_latency_verified": False,
    "product_ready": False,
    "recording_pcm_sink_test_double": bool(SETTINGS.get("headless_ui_probe")),
}
if SETTINGS.get("headless_ui_probe"):
    RESULT["scope"] = "real-nvda-driver-models-gui-with-recording-sink-test-double"
    RESULT["limitations"].append("Explicit headless UI probe: WavePlayer is replaced only during this isolated test by a recording PCM sink. Device and acoustic acceptance remain blocked.")
LOCK = threading.Lock()
METRICS = {}
STAGE = "startup"
FINISHED = False
DRIVER = None
ORIGINAL_PLAY = None
ORIGINAL_FEED = None
ACTIVE_REQUEST = None
LATENCY_THREAD = None
LATENCY_STOP = threading.Event()
IMPORT_DIAGNOSTIC_DONE = threading.Event()
RECOVERY_ORIGINAL_WAVE_FACTORY = None
RECOVERY_OUTPUTS = []
REQUIRED_RESOURCE_ORIGINAL_UI_MESSAGE = None
DONE = threading.Event()
SAMPLE_RATE = 24000
SAMPLES = {}


class RecordingPCMSink:
    """Explicit probe-only output double; never installed in production code."""
    _dordiai_recording_test_double = True

    def __init__(self, channels, samplesPerSec, bitsPerSample, **kwargs):
        self.channels = channels
        self.samplesPerSec = samplesPerSec
        self.bitsPerSample = bitsPerSample
        self.closed = False
        self.paused = False
        self.submitted_bytes = self.nonzero_bytes = 0

    def feed(self, data, size=None, onDone=None):
        if self.closed:
            raise OSError("Recording sink is closed")
        if not isinstance(data, (bytes, bytearray, memoryview)):
            # Official eSpeak delivers its real native PCM as c_void_p/size.
            # This remains an explicit output double, never a sound device.
            import ctypes
            if not isinstance(size, int) or not 0 <= size <= 2 * 1024 * 1024 or (size and not data):
                raise ValueError("Recording sink requires a bounded native PCM buffer")
            data = ctypes.string_at(data, size) if size else b""
        elif size is not None:
            if not isinstance(size, int) or not 0 <= size <= len(data):
                raise ValueError("Recording sink byte count exceeds its buffer")
            data = data[:size]
        if not isinstance(data, (bytes, bytearray, memoryview)) or len(data) % 2:
            raise ValueError("Recording sink requires aligned 16-bit PCM")
        self.submitted_bytes += len(data)
        self.nonzero_bytes += sum(byte != 0 for byte in data)
        if onDone is not None:
            onDone()

    def idle(self):
        pass

    def stop(self):
        pass

    def pause(self, switch):
        self.paused = bool(switch)

    def close(self):
        self.closed = True

    def enableTrimmingLeadingSilence(self, enabled):
        self.trim_leading = bool(enabled)


def save():
    temporary = OUTPUT / "nvda-probe.json.tmp"
    temporary.write_text(json.dumps(RESULT, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(OUTPUT / "nvda-probe.json")


def check(check_name, status, **details):
    RESULT["checks"].append(dict(name=check_name, status=status, **details))
    save()


def later(milliseconds, callback):
    core.callLater(milliseconds, guarded, callback)


def guarded(callback):
    if FINISHED:
        return
    try:
        callback()
    except Exception as error:
        check(STAGE + "_exception", "failed", error=repr(error), traceback=traceback.format_exc())
        finish()


def on_done(synth=None, **kwargs):
    if synth is DRIVER:
        DONE.set()


def record_play(pcm, generation):
    stage = STAGE
    if FINISHED:
        return ORIGINAL_PLAY(pcm, generation)
    original_result = ORIGINAL_PLAY(pcm, generation)
    # In normal mode this is the real WavePlayer. Explicit headless mode
    # records only the probe sink boundary and cannot certify audio output.
    with LOCK:
        entry = METRICS.setdefault(stage, {"pcm_bytes": 0, "nonzero_bytes": 0, "play_calls": 0})
        entry["pcm_bytes"] += len(pcm)
        entry["nonzero_bytes"] += sum(byte != 0 for byte in pcm)
        entry["play_calls"] += 1
        entry.setdefault("first_play_return_ns", time.perf_counter_ns())
        sample = SAMPLES.setdefault(stage, bytearray())
        remaining = max(0, SAMPLE_RATE * 2 * 8 - len(sample))
        if remaining:
            sample.extend(pcm[:remaining])
    return original_result


def snapshot(stage):
    with LOCK:
        return dict(METRICS.get(stage, {}))


def finish():
    global FINISHED
    if FINISHED:
        return
    FINISHED = True
    restore_recovery_output_factory()
    LATENCY_STOP.set()
    try:
        if DRIVER is not None:
            DRIVER.cancel()
            if ORIGINAL_PLAY is not None:
                DRIVER._play = ORIGINAL_PLAY
            if ORIGINAL_FEED is not None:
                DRIVER._player.feed = ORIGINAL_FEED
        synthDriverHandler.synthDoneSpeaking.unregister(on_done)
    except Exception as error:
        RESULT["cleanup_error"] = repr(error)
    with LOCK:
        RESULT["pcm_metrics"] = dict(METRICS)
        for stage, data in SAMPLES.items():
            if not data:
                continue
            path = OUTPUT / ("pcm-" + stage + ".wav")
            with wave.open(str(path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(SAMPLE_RATE)
                output.writeframes(bytes(data))
    statuses = {entry["status"] for entry in RESULT["checks"]}
    RESULT["status"] = "failed" if "failed" in statuses else "partial" if "blocked" in statuses else "passed"
    if SETTINGS.get("headless_ui_probe") and RESULT["status"] == "passed":
        RESULT["status"] = "partial"
    RESULT["finished_at_ns"] = time.time_ns()
    save()
    # This is the portable instance launched by the external controller only.
    core.callLater(100, core.triggerNVDAExit)


def begin():
    global DRIVER, ORIGINAL_PLAY, ORIGINAL_FEED, STAGE, SAMPLE_RATE
    STAGE = "driver_selection"
    import versionInfo
    RESULT["nvda_version_actual"] = versionInfo.version
    import speech
    try:
        speech.setSpeechMode(speech.SpeechMode.off)
    except AttributeError:
        # Direct driver requests below still work. Record possible ambient speech.
        RESULT["limitations"].append("NVDA speech-mode suppression API unavailable; desktop announcements may share the output.")
    if SETTINGS.get("headless_ui_probe"):
        import nvwave
        real_wave_player = nvwave.WavePlayer
        nvwave.WavePlayer = RecordingPCMSink
        try:
            selected = synthDriverHandler.setSynth("kx47Preview")
        finally:
            nvwave.WavePlayer = real_wave_player
        check("physical_audio_output", "blocked", reason="Explicit recording PCM sink test double; no WavePlayer/device acceptance")
    else:
        selected = synthDriverHandler.setSynth("kx47Preview")
    DRIVER = synthDriverHandler.getSynth()
    if not selected or DRIVER is None or getattr(DRIVER, "name", None) != "kx47Preview":
        check("select_dordiai", "failed", returned=bool(selected), actual=getattr(DRIVER, "name", None))
        finish()
        return
    check("select_dordiai", "passed", driver_name=DRIVER.name)
    try:
        from synthDrivers import _sonic
        _sonic.initialize()
        check("host_sonic_import_and_dll", "passed", module=getattr(_sonic, "__name__", None))
    except Exception as error:
        check("host_sonic_import_and_dll", "failed", error_type=type(error).__name__,
              import_name=getattr(error, "name", None))
    module = sys.modules.get(type(DRIVER).__module__)
    SAMPLE_RATE = getattr(module, "SAMPLE_RATE", SAMPLE_RATE)
    voices = list(DRIVER.availableVoices)
    excluded = {"kostia", "inna", "dina", "vira", "innesa", "veronika_classmate", "anatolii", "veronika"}
    check("allowed_voice_catalog", "passed" if len(voices) == 45 and not excluded.intersection(voices) else "failed",
          count=len(voices), voices=voices, excluded_present=sorted(excluded.intersection(voices)))
    enabled = sorted(DRIVER._dordiai_enabled_languages)
    check("fresh_default_languages", "passed" if set(enabled) == {"uk", "en", "ru"} else "failed", enabled=enabled)
    ORIGINAL_PLAY = DRIVER._play
    DRIVER._play = record_play
    try:
        ORIGINAL_FEED = DRIVER._player.feed
        DRIVER._player.feed = observed_feed
    except Exception as error:
        ORIGINAL_FEED = None
        RESULT["limitations"].append("Real WavePlayer feed boundary could not be instrumented: " + repr(error))
    synthDriverHandler.synthDoneSpeaking.register(on_done)
    later(500, open_settings)


def open_settings():
    global STAGE
    STAGE = "settings_dialog"
    # Inspect the real wx dialog from its nested modal event loop.
    later(1200, inspect_settings)
    DRIVER._dordiai_open_settings()


def find_dialog():
    for window in wx.GetTopLevelWindows():
        if hasattr(window, "language_list") and getattr(window, "synth", None) is DRIVER:
            return window
    return None


def inspect_settings():
    dialog = find_dialog()
    if dialog is None:
        check("settings_dialog", "failed", reason="No real dordiai settings dialog appeared")
        finish()
        return
    labels = []
    def visit(window):
        try:
            label = window.GetLabel()
            if label:
                labels.append(label)
        except Exception:
            pass
        for child in window.GetChildren():
            visit(child)
    visit(dialog)
    checked = [dialog.language_codes[index] for index in dialog.language_list.GetCheckedItems()]
    pages = [dialog.tabs.GetPageText(index) for index in range(dialog.tabs.GetPageCount())]
    required = ("voice", "mode", "mapping_language", "mapping_voice", "language_list", "voice_list", "packages")
    missing = [name for name in required if not hasattr(dialog, name)]
    check("settings_dialog", "passed" if not missing and set(checked) == {"uk", "en", "ru"} else "failed",
          title=dialog.GetTitle(), visible=dialog.IsShown(), pages=pages, labels=labels,
          checked_languages=checked, voice_rows=dialog.voice_list.GetCount(), missing_controls=missing)
    try:
        import globalPluginHandler
        import keyboardHandler
        gesture = keyboardHandler.KeyboardInputGesture.fromName("NVDA+control+shift+f10")
        bindings = []
        for plugin in globalPluginHandler.runningPlugins:
            if "dordiaiMainPreferences" in type(plugin).__module__:
                bound = plugin.getScript(gesture)
                bindings.append(getattr(bound, "__name__", None))
        check("settings_hotkey_binding", "passed" if "script_preferences" in bindings else "failed", scripts=bindings)
    except Exception as error:
        check("settings_hotkey_binding", "blocked", reason=repr(error))
    # UIActionSimulator emits actual Windows keyboard events, not EVT_CHECKLISTBOX stubs.
    try:
        dialog.Raise()
        dialog.voice.SetFocus()
        simulator = wx.UIActionSimulator()
        before = wx.Window.FindFocus()
        down = simulator.KeyDown(wx.WXK_TAB)
        up = simulator.KeyUp(wx.WXK_TAB)
        later(250, lambda: inspect_tab(dialog, before, bool(down and up)))
    except Exception as error:
        check("keyboard_tab", "blocked", reason=repr(error))
        close_settings(dialog)


def inspect_tab(dialog, before, emitted):
    after = wx.Window.FindFocus()
    changed = after is not None and after is not before
    check("keyboard_tab", "passed" if emitted and changed else "blocked", events_emitted=emitted,
          changed_focus=changed, focused_type=type(after).__name__ if after else None,
          reason=None if emitted and changed else "No interactive desktop keyboard focus transition observed")
    if not emitted or not changed or not dialog.language_list.GetCount():
        close_settings(dialog)
        return
    for index in range(dialog.tabs.GetPageCount()):
        if dialog.tabs.GetPage(index) is dialog.language_list.GetParent():
            dialog.tabs.SetSelection(index)
            break
    later(150, lambda: start_checkbox_test(dialog))


def start_checkbox_test(dialog):
    dialog.language_list.SetFocus()
    dialog.language_list.SetSelection(0)
    before_checked = dialog.language_list.IsChecked(0)
    simulator = wx.UIActionSimulator()
    simulator.KeyDown(wx.WXK_SPACE)
    simulator.KeyUp(wx.WXK_SPACE)
    later(250, lambda: inspect_space(dialog, before_checked))


def inspect_space(dialog, before_checked):
    after_checked = dialog.language_list.IsChecked(0)
    toggled = after_checked != before_checked
    check("keyboard_checkbox_space", "passed" if toggled else "blocked", changed=toggled,
          reason=None if toggled else "Space key did not reach the native checklist control")
    if toggled:
        simulator = wx.UIActionSimulator()
        simulator.KeyDown(wx.WXK_SPACE)
        simulator.KeyUp(wx.WXK_SPACE)
    later(250, lambda: close_settings(dialog))


def close_settings(dialog):
    if dialog is not None:
        dialog.onCancel(None)
    later(500, start_required_resource_recovery_probe if SETTINGS.get("required_resource_recovery_probe") else
          start_actual_typing_probe if SETTINGS.get("typing_probe") else start_phrase)


def start_phrase():
    global STAGE
    STAGE = "phrase"
    from speech.commands import LangChangeCommand, IndexCommand
    DRIVER.cancel()
    DONE.clear()
    DRIVER._dordiai_last_error = None
    DRIVER._dordiai_last_error_details = None
    RESULT["phrase_requested_ns"] = time.perf_counter_ns()
    DRIVER.speak([LangChangeCommand("uk"), "Кнопка перемикач натиснуто. ",
                  LangChangeCommand("en"), "Open the document. ", IndexCommand(880001)])
    wait_for_stage("phrase", time.monotonic() + 150.0, start_character)


def wait_for_stage(stage, deadline, continuation):
    stats = snapshot(stage)
    RESULT["worker_bootstrap"] = getattr(getattr(DRIVER, "_engine", None), "_worker_bootstrap", None)
    details = getattr(DRIVER, "_dordiai_last_error_details", None)
    if permanent_speech_failure(details):
        check(stage + "_pcm_submission", "failed", reason="Permanent speech import failure; further requests stopped",
              metrics=stats, diagnostics=details)
        DRIVER.cancel()
        start_native_import_diagnostic()
        return
    if DONE.is_set():
        error = getattr(DRIVER, "_dordiai_last_error", None)
        success = stats.get("pcm_bytes", 0) > 0 and stats.get("nonzero_bytes", 0) > 0 and not error
        if success and not SETTINGS.get("headless_ui_probe"):
            RESULT["wave_player_verified"] = True
        check(stage + "_pcm_submission", "passed" if success else "failed", metrics=stats, driver_error=error,
              diagnostics=details,
              output_boundary="recording PCM sink TEST DOUBLE" if SETTINGS.get("headless_ui_probe") else "real WavePlayer")
        later(300, continuation)
    elif time.monotonic() >= deadline:
        check(stage + "_pcm_submission", "failed", reason="Real synthesis did not complete before the watchdog", metrics=stats,
              driver_error=getattr(DRIVER, "_dordiai_last_error", None))
        DRIVER.cancel()
        later(300, continuation)
    else:
        later(250, lambda: wait_for_stage(stage, deadline, continuation))


def permanent_speech_failure(details):
    if not isinstance(details, dict):
        return False
    return details.get("type") in {"ImportError", "ModuleNotFoundError"} or (
        isinstance(details.get("worker"), dict) and
        details["worker"].get("type") in {"ImportError", "ModuleNotFoundError"})


def start_native_import_diagnostic():
    """Run fixed imports from actual NVDA, retaining its inherited environment."""
    import globalVars
    import subprocess
    command = list(DRIVER._engine._command)
    runtime = str(Path(command[4]).parent)
    def run():
        reports = []
        for mode in ("clean", "worker-import-order"):
            try:
                completed = subprocess.run([command[0], "-I", "-B", "-u", "-c", NATIVE_IMPORT_DIAGNOSTIC,
                    runtime, str(globalVars.appDir), mode], cwd=runtime, capture_output=True, timeout=20)
                report = json.loads(completed.stdout)
                report["exit_code"] = completed.returncode
                reports.append(report)
                (OUTPUT / ("native-import-" + mode + "-stderr.log")).write_bytes(completed.stderr[-131072:])
            except Exception as error:
                reports.append({"mode": mode, "status": "diagnostic-controller-error", "error_type": type(error).__name__})
        RESULT["native_import_diagnostics"] = {"launcher": "actual NVDA subprocess", "cases": reports}
        IMPORT_DIAGNOSTIC_DONE.set()
    threading.Thread(target=run, daemon=True, name="Dordiai fixed native-import diagnostic").start()
    later(100, lambda: await_native_import_diagnostic(time.monotonic() + 45))


def await_native_import_diagnostic(deadline):
    if IMPORT_DIAGNOSTIC_DONE.is_set() or time.monotonic() >= deadline:
        check("fixed_native_import_diagnostics", "passed" if IMPORT_DIAGNOSTIC_DONE.is_set() else "blocked",
              scope="Diagnostic completion only; never a model, speech or product acceptance check")
        finish()
    else:
        later(100, lambda: await_native_import_diagnostic(deadline))


def start_character():
    global STAGE
    STAGE = "character"
    from speech.commands import CharacterModeCommand, LangChangeCommand, IndexCommand
    DRIVER.cancel()
    DONE.clear()
    DRIVER._dordiai_last_error = None
    RESULT["character_requested_ns"] = time.perf_counter_ns()
    DRIVER.speak([LangChangeCommand("uk"), CharacterModeCommand(True), "а", CharacterModeCommand(False), IndexCommand(880002)])
    wait_for_stage("character", time.monotonic() + 60.0, start_cancel)


def start_cancel():
    global STAGE
    STAGE = "cancel"
    from speech.commands import LangChangeCommand
    DRIVER.cancel()
    DONE.clear()
    DRIVER.speak([LangChangeCommand("uk"), "Перевірка негайного припинення довгого мовлення. " * 200])
    later(100, measure_cancel)


def measure_cancel():
    generation = getattr(DRIVER, "_generation", None)
    started = time.perf_counter_ns()
    DRIVER.cancel()
    elapsed_ms = (time.perf_counter_ns() - started) / 1000000.0
    updated = getattr(DRIVER, "_generation", None)
    check("cancel_api", "passed" if generation is not None and updated > generation else "failed",
          call_duration_ms=elapsed_ms, generation_before=generation, generation_after=updated,
          note="One API observation, not acoustic stop latency or P95/P99 acceptance")
    later(500, start_latency)


def percentiles(values):
    import math
    ordered = sorted(values)
    if not ordered:
        return {"count": 0, "p50_ms": None, "p95_ms": None, "p99_ms": None}
    def quantile(fraction):
        return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]
    return {"count": len(ordered), "p50_ms": quantile(.50), "p95_ms": quantile(.95),
            "p99_ms": quantile(.99), "minimum_ms": ordered[0], "maximum_ms": ordered[-1]}


def observed_feed(data, *args, **kwargs):
    # Normal mode measures the real WavePlayer boundary. Explicit headless
    # mode measures the labeled test double and never satisfies device targets.
    submitted_ns = time.perf_counter_ns()
    outcome = ORIGINAL_FEED(data, *args, **kwargs)
    if isinstance(data, (bytes, bytearray, memoryview)) and any(data):
        with LOCK:
            entry = METRICS.setdefault(STAGE, {"pcm_bytes": 0, "nonzero_bytes": 0, "play_calls": 0})
            entry.setdefault("first_nonzero_feed_ns", submitted_ns)
            request = ACTIVE_REQUEST
            if request is not None and request["first_feed_ns"] is None and submitted_ns >= request["started_ns"]:
                request["first_feed_ns"] = submitted_ns
                request["event"].set()
    return outcome


def start_latency():
    global STAGE, ORIGINAL_FEED, LATENCY_THREAD
    STAGE = "api_latency"
    RESULT["latency_scope"] = {
        "boundary": "driver.speak to recording PCM sink TEST DOUBLE" if SETTINGS.get("headless_ui_probe") else "driver.speak call to first nonzero PCM forwarded to real WavePlayer.feed",
        "cancel_boundary": "elapsed real driver.cancel API call",
        "physical_audible_latency": "not measured; no loopback capture",
        "switch_boundary": "alternating individual language requests, not a continuous audible gap measurement",
        "warmup": "one isolated letter request per language before repeated samples",
        "cold_start": "Initial phrase and character timings are recorded separately after driver startup; background preloading and packaged caches mean they are not guaranteed fully cold runs.",
        "sample_count_target": 100,
        "hardware": {"platform": platform.platform(), "machine": platform.machine(),
                     "processor": platform.processor(), "python": sys.version,
                     "sample_rate": SAMPLE_RATE},
    }
    try:
        import ctypes
        RESULT["latency_scope"]["hardware"]["logical_cpu_count"] = __import__("os").cpu_count()
        RESULT["latency_scope"]["hardware"]["wave_out_devices"] = ctypes.windll.winmm.waveOutGetNumDevs()
        import config
        RESULT["latency_scope"]["hardware"]["configured_audio_device"] = str(config.conf["audio"]["outputDevice"])
        if ORIGINAL_FEED is None:
            ORIGINAL_FEED = DRIVER._player.feed
            DRIVER._player.feed = observed_feed
    except Exception as error:
        check("api_latency_measurement", "blocked", reason="Real feed cannot be instrumented: " + repr(error))
        finish()
        return
    save()
    LATENCY_THREAD = threading.Thread(target=latency_worker, daemon=True, name="Dordiai real NVDA latency probe")
    LATENCY_THREAD.start()


def latency_worker():
    global ACTIVE_REQUEST
    from speech.commands import CharacterModeCommand, LangChangeCommand
    output = {"first_after_prior_smoke_ms": {}, "warm_letters_ms": [], "cancel_api_ms": [],
              "warm_switch_requests_ms": [], "alphabet_first_pass_ms": [], "timeouts": [], "errors": []}
    deadline = time.monotonic() + 240.0
    installed = set(DRIVER._dordiai_all_languages())
    enabled = set(DRIVER._dordiai_enabled_languages)
    languages = [code for code in ("uk", "en", "ru") if code in installed and code in enabled]
    letters = {"uk": "а", "en": "a", "ru": "а"}
    alphabets = {"uk": "абвгґдеєжзиіїйклмнопрстуфхцчшщьюя",
                 "en": "abcdefghijklmnopqrstuvwxyz",
                 "ru": "абвгдеёжзийклмнопрстуфхцчшщъыьэюя"}

    def request_letter(language, wait_done=True, glyph=None):
        global ACTIVE_REQUEST
        if LATENCY_STOP.is_set() or time.monotonic() >= deadline:
            raise TimeoutError("Latency watchdog exhausted")
        if permanent_speech_failure(getattr(DRIVER, "_dordiai_last_error_details", None)):
            raise RuntimeError("Permanent speech import failure; latency requests stopped")
        DRIVER.cancel()
        DONE.clear()
        pending = {"event": threading.Event(), "started_ns": time.perf_counter_ns(), "first_feed_ns": None}
        with LOCK:
            ACTIVE_REQUEST = pending
        DRIVER.speak([LangChangeCommand(language), CharacterModeCommand(True), letters[language] if glyph is None else glyph, CharacterModeCommand(False)])
        if not pending["event"].wait(min(10.0, max(0.0, deadline - time.monotonic()))):
            output["timeouts"].append({"language": language, "error": getattr(DRIVER, "_dordiai_last_error", None)})
            DRIVER.cancel()
            return None
        latency = (pending["first_feed_ns"] - pending["started_ns"]) / 1000000.0
        if wait_done and not DONE.wait(min(5.0, max(0.0, deadline - time.monotonic()))):
            output["errors"].append("No done notification after real PCM for " + language)
        with LOCK:
            ACTIVE_REQUEST = None
        return latency

    try:
        if not languages:
            raise RuntimeError("No installed/enabled probe language")
        for language in languages:
            output["first_after_prior_smoke_ms"][language] = request_letter(language)
        # Separate fresh alphabet/digit lookups from the repeated warm "a"
        # benchmark: exact-repeat caches cannot hide missing/slow other units.
        for language in languages:
            for glyph in alphabets[language] + "0123456789 .,;:!?+-=()[]{}@#":
                value = request_letter(language, glyph=glyph)
                output["alphabet_first_pass_ms"].append({"language": language, "glyph": glyph,
                    "latency_ms": value, "primed_during_initial_warmup": glyph == letters[language]})
        primary = languages[0]
        for _ in range(100):
            value = request_letter(primary)
            if value is not None:
                output["warm_letters_ms"].append(value)
        if len(languages) >= 2:
            for index in range(100):
                value = request_letter(languages[index % len(languages)])
                if value is not None:
                    output["warm_switch_requests_ms"].append(value)
        for _ in range(100):
            value = request_letter(primary, wait_done=False)
            started = time.perf_counter_ns()
            DRIVER.cancel()
            elapsed = (time.perf_counter_ns() - started) / 1000000.0
            output["cancel_api_ms"].append(elapsed)
            if value is None:
                output["errors"].append("Cancel request had no observed active PCM")
    except Exception as error:
        output["errors"].append(repr(error))
    finally:
        DRIVER.cancel()
        with LOCK:
            ACTIVE_REQUEST = None
    summary = {"alphabet_first_pass": percentiles([row["latency_ms"] for row in output["alphabet_first_pass_ms"] if row["latency_ms"] is not None]),
               "warm_letters": percentiles(output["warm_letters_ms"]),
               "cancel_api": percentiles(output["cancel_api_ms"]),
               "warm_switch_requests": percentiles(output["warm_switch_requests_ms"]),
               "languages": languages, "samples": output}
    wx.CallAfter(latency_finished, summary)


def latency_finished(summary):
    RESULT["api_latency"] = summary
    initial = {}
    for phase in ("phrase", "character"):
        requested = RESULT.get(phase + "_requested_ns")
        first = snapshot(phase).get("first_nonzero_feed_ns")
        initial[phase + "_first_request_to_pcm_ms"] = (first - requested) / 1000000.0 if first and requested else None
    RESULT["initial_smoke_predevice_latency"] = initial
    target_complete = summary["warm_letters"]["count"] >= 100 and summary["cancel_api"]["count"] >= 100
    switch_complete = len(summary["languages"]) < 2 or summary["warm_switch_requests"]["count"] >= 100
    errors = summary["samples"]["errors"] or summary["samples"]["timeouts"]
    check("api_latency_measurement", "passed" if target_complete and switch_complete and not errors else "failed",
          letters=summary["warm_letters"], cancel=summary["cancel_api"], switch=summary["warm_switch_requests"],
          note="Measurement completion only; API/pre-device values do not certify physical latency acceptance")
    for name, measurements in (("warm_letter_predevice_target", summary["warm_letters"]),
                                ("cancel_api_target", summary["cancel_api"])):
        if SETTINGS.get("headless_ui_probe"):
            check(name, "blocked", measurements=measurements,
                  reason="Recording sink double: internal queue measurements cannot satisfy WavePlayer/device or acoustic acceptance")
            continue
        complete = measurements["count"] >= 100
        passed = complete and measurements["p95_ms"] <= 20.0 and measurements["p99_ms"] <= 50.0
        check(name, "passed" if passed else "failed", measurements=measurements,
              p95_target_ms=20.0, p99_target_ms=50.0,
              physical_audible_acceptance="not measured")
    smoke_complete = all(any(entry["name"] == phase + "_pcm_submission" and entry["status"] == "passed"
                             for entry in RESULT["checks"]) for phase in ("phrase", "character"))
    if SETTINGS.get("fatal_recovery_probe") and smoke_complete and target_complete and switch_complete and not errors:
        later(250, start_fatal_recovery_probe)
    else:
        finish()


def restore_recovery_output_factory():
    global RECOVERY_ORIGINAL_WAVE_FACTORY, REQUIRED_RESOURCE_ORIGINAL_UI_MESSAGE
    if globals().get("REQUIRED_RESOURCE_ORIGINAL_UI_MESSAGE") is not None:
        import ui
        ui.message = REQUIRED_RESOURCE_ORIGINAL_UI_MESSAGE
        REQUIRED_RESOURCE_ORIGINAL_UI_MESSAGE = None
    if RECOVERY_ORIGINAL_WAVE_FACTORY is not None:
        import nvwave
        nvwave.WavePlayer = RECOVERY_ORIGINAL_WAVE_FACTORY
        RECOVERY_ORIGINAL_WAVE_FACTORY = None


def start_fatal_recovery_probe():
    global STAGE, RECOVERY_ORIGINAL_WAVE_FACTORY
    import config
    import nvwave
    STAGE = "injected_fatal_notification_recovery"
    if synthDriverHandler.getSynth() is not DRIVER:
        check(STAGE, "blocked", reason="Original synthesizer is no longer active")
        finish()
        return
    RESULT["injected_fatal_recovery"] = {
        "scope": "Injected notification-boundary ImportError; not a real model failure or acoustic test",
        "injected": True, "model_import_error_verified": False, "physical_audio_verified": False,
        "configured_synth_before": config.conf["speech"]["synth"],
        "recording_pcm_sink_test_double": bool(SETTINGS.get("headless_ui_probe")),
    }
    if SETTINGS.get("headless_ui_probe"):
        RECOVERY_ORIGINAL_WAVE_FACTORY = nvwave.WavePlayer
        def create_recording_output(*args, **kwargs):
            sink = RecordingPCMSink(*args, **kwargs)
            RECOVERY_OUTPUTS.append(sink)
            return sink
        nvwave.WavePlayer = create_recording_output
    # Normal smoke suppresses desktop speech, but recovery must be audible.
    # Restore normal speech before observing the genuine fallback notice.
    import speech
    speech.setSpeechMode(speech.SpeechMode.talk)
    RESULT["injected_fatal_recovery"]["notice_speech_mode_enabled"] = True
    DRIVER._dordiai_report_error(ImportError("Injected probe notification boundary", name="dordiai_probe_optional_component"))
    RESULT["injected_fatal_recovery"]["queued_before_switch"] = (
        bool(getattr(DRIVER, "_dordiai_fatal_recovery_scheduled", False)) and
        synthDriverHandler.getSynth() is DRIVER)
    later(100, lambda: observe_fatal_recovery(time.monotonic() + 15.0))


def observe_fatal_recovery(deadline):
    import config
    row = RESULT["injected_fatal_recovery"]
    active = synthDriverHandler.getSynth()
    details = getattr(DRIVER, "_dordiai_last_error_details", {})
    recovery = details.get("recovery", {})
    if (active is DRIVER or recovery.get("state") == "queued") and time.monotonic() < deadline:
        later(100, lambda: observe_fatal_recovery(deadline))
        return
    row.update(active_synth=getattr(active, "name", None),
               active_driver_module=type(active).__module__ if active is not None else None,
               configured_synth_after=config.conf["speech"]["synth"], recovery=dict(recovery),
               old_driver_closed=bool(getattr(DRIVER, "_closed", False)))
    # A repeated report on the retired driver must not queue/reselect it.
    DRIVER._dordiai_report_error(ImportError("Repeated injected probe boundary", name="dordiai_probe_optional_component"))
    later(2000, finish_fatal_recovery_probe)


def finish_fatal_recovery_probe():
    import config
    row = RESULT["injected_fatal_recovery"]
    active = synthDriverHandler.getSynth()
    details = getattr(DRIVER, "_dordiai_last_error_details", {})
    row.update(recovery=dict(details.get("recovery", {})),
               active_synth_after_settlement=getattr(active, "name", None),
               configured_synth_preserved=config.conf["speech"]["synth"] == row["configured_synth_before"],
               old_driver_thread_stopped=not DRIVER._thread.is_alive(),
               recording_sink_pcm_bytes=sum(sink.submitted_bytes for sink in RECOVERY_OUTPUTS),
               recording_sink_nonzero_bytes=sum(sink.nonzero_bytes for sink in RECOVERY_OUTPUTS))
    passed = (row["queued_before_switch"] and row["active_synth"] == "espeak" and
              row["active_driver_module"] == "synthDrivers.espeak" and
              row["active_synth_after_settlement"] == "espeak" and row["configured_synth_preserved"] and
              row["old_driver_closed"] and row["old_driver_thread_stopped"] and
              row["recovery"].get("state") == "builtin-espeak-selected" and
              row["recovery"].get("espeak_selection_succeeded") is True)
    if SETTINGS.get("headless_ui_probe"):
        passed = passed and row["recording_sink_nonzero_bytes"] > 0
    check("injected_fatal_notification_recovery", "passed" if passed else "failed", observations=row)
    restore_recovery_output_factory()
    finish()



def required_probe_windows_path_text(value, *, namespace=True):
    """Normalize an absolute drive/UNC path without changing process policy."""
    import ntpath
    value = str(value)
    if value.startswith("\\\\?\\UNC\\"):
        value = "\\\\" + value[8:]
    elif value.startswith("\\\\?\\"):
        value = value[4:]
    if value.startswith("\\\\.\\") or not ntpath.isabs(value):
        raise ValueError("Owned probe I/O requires an absolute ordinary Windows path")
    value = ntpath.normpath(value)
    drive, tail = ntpath.splitdrive(value)
    if drive.startswith("\\\\") and len(drive.split("\\")) == 4:
        return "\\\\?\\UNC\\" + value[2:] if namespace else value
    if len(drive) == 2 and drive[0].isalpha() and drive[1] == ":" and tail.startswith("\\"):
        return "\\\\?\\" + value if namespace else value
    raise ValueError("Unsupported Windows device namespace in owned probe path")


def required_probe_io_path(value):
    import os
    return Path(required_probe_windows_path_text(value)) if os.name == "nt" else Path(value)


def required_probe_canonical_directory(value):
    return required_probe_io_path(required_probe_io_path(value).resolve(strict=True))


def required_resource_path_observations(value):
    """Fixed owned asset evidence only; never scan or read a user directory."""
    import os
    import hashlib
    namespaced = required_probe_io_path(value)
    plain = (Path(required_probe_windows_path_text(namespaced, namespace=False))
             if os.name == "nt" else Path(value))
    result = {}
    for label, path in (("plain", plain), ("namespace", namespaced)):
        row = {"path": str(path), "path_length": len(str(path))}
        try:
            row.update(exists=path.exists(), is_file=path.is_file())
            info = path.stat()
            row["stat_bytes"] = info.st_size
            if path.is_file():
                with path.open("rb") as source:
                    head = source.read(4096)
                row["read_head_bytes"] = len(head)
                row["read_head_sha256"] = hashlib.sha256(head).hexdigest()
        except OSError as error:
            row["error"] = {"type": type(error).__name__, "errno": error.errno,
                            "winerror": getattr(error, "winerror", None)}
        result[label] = row
    return result


def validate_required_resource_probe_ownership():
    """Verify controller ownership using scoped namespace-safe ordinary I/O."""
    import hashlib
    import re
    record = SETTINGS.get("required_resource_quarantine")
    if not isinstance(record, dict) or record.get("asset_missing_before_nvda_launch") is not True:
        raise ValueError("No controller-attested pre-launch resource quarantine")
    owned = required_probe_canonical_directory(OUTPUT)
    if (required_probe_canonical_directory(record["run_root"]) != owned
            or record["run_id"] != SETTINGS["run_id"]):
        raise ValueError("Required-resource quarantine belongs to a different probe")
    raw_addon = required_probe_io_path(record["addon_root"])
    raw_runtime = required_probe_io_path(record["runtime_root"])
    for candidate in (raw_addon, raw_runtime):
        if candidate.is_symlink() or (hasattr(candidate, "is_junction") and candidate.is_junction()):
            raise ValueError("Linked required-resource add-on or runtime")
    addon = required_probe_canonical_directory(raw_addon)
    runtime = required_probe_canonical_directory(raw_runtime)
    if addon.parent != owned / "config" / "addons" or runtime != addon / "kx47Runtime":
        raise ValueError("Required-resource quarantine is outside the owned add-on")
    module = sys.modules.get(type(DRIVER).__module__)
    if module is None or required_probe_canonical_directory(module.RUNTIME) != runtime:
        raise ValueError("Selected driver does not use the controller's owned runtime")
    relative = "models/PocketTTS/stress/ru_ruaccent/nn_omograph/model.onnx"
    if record.get("asset_relative") != relative:
        raise ValueError("Unexpected required-resource asset")
    target = runtime / relative
    quarantine = target.with_name(target.name + "." + SETTINGS["run_id"] + ".quarantine")
    if required_probe_io_path(record["quarantine_path"]) != quarantine:
        raise ValueError("Unexpected required-resource quarantine path")
    current = addon
    for component in target.relative_to(addon).parts:
        current = current / component
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise ValueError("Linked required-resource asset path")
    # These are three fixed paths in the attested owned runtime. Record both
    # spellings before the guard, so a real NVDA long-path failure is observable.
    navigation_name = hashlib.sha256("uk\0а".encode("utf-8")).hexdigest()[:24] + ".wav"
    RESULT["required_resource_path_diagnostics"] = {
        "runtime": required_resource_path_observations(runtime),
        "asset": required_resource_path_observations(target),
        "quarantine": required_resource_path_observations(quarantine),
        "known_uk_a_navigation": required_resource_path_observations(
            runtime / "models/voices/navigation/sara" / navigation_name),
    }
    save()
    if (target.exists() or not quarantine.is_file() or quarantine.is_symlink()
            or (hasattr(quarantine, "is_junction") and quarantine.is_junction())):
        raise ValueError("Required resource was not quarantined before this request")
    checksum = record.get("asset_sha256")
    if not isinstance(checksum, str) or re.fullmatch(r"[0-9a-f]{64}", checksum) is None:
        raise ValueError("Missing required-resource checksum")
    digest = hashlib.sha256()
    with quarantine.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != checksum or quarantine.stat().st_size != record["asset_bytes"]:
        raise ValueError("Required-resource quarantine bytes changed")
    command = getattr(getattr(DRIVER, "_engine", None), "_command", [])
    if (len(command) < 6 or required_probe_canonical_directory(command[0]) != runtime / "python/python.exe"
            or required_probe_canonical_directory(command[4]) != runtime / "nvda_worker.py"
            or required_probe_canonical_directory(command[5]) != runtime / "models"):
        raise ValueError("Speech worker is not private to the owned packaged runtime")
    return target


def required_resource_worker_diagnostic(details):
    if not isinstance(details, dict):
        return False
    worker = details.get("worker")
    if not isinstance(worker, dict) or worker.get("type") != "ModelDownloadError":
        return False
    cause = worker.get("cause")
    if not isinstance(cause, dict) or cause.get("type") != "FileNotFoundError" or cause.get("cause") is not None:
        return False
    def frames(node):
        rows = node.get("frames")
        if not isinstance(rows, list) or not 1 <= len(rows) <= 16 or any(not isinstance(row, dict) for row in rows):
            return set()
        return {(row.get("module"), row.get("function")) for row in rows
                if isinstance(row.get("module"), str) and isinstance(row.get("function"), str)}
    return ({("native_multilingual", "russian_text"),
             ("stressonnx.backends.ruaccent", "_load"),
             ("stressonnx.download", "_download_files")} <= frames(worker)
            and ("stressonnx.download", "_download_files") in frames(cause))


def required_resource_recovery_passed(row):
    recovery = row.get("recovery", {})
    if not isinstance(recovery, dict):
        return False
    return (row.get("quarantine_verified_before_request") is True
            and row.get("asset_still_missing") is True
            and required_resource_worker_diagnostic(row.get("diagnostics"))
            and row.get("active_synth") == "espeak"
            and row.get("active_driver_module") == "synthDrivers.espeak"
            and row.get("configured_synth_preserved") is True
            and row.get("old_driver_closed") is True
            and row.get("old_driver_thread_stopped") is True
            and recovery.get("reason") == "required-resource-unavailable"
            and recovery.get("state") == "builtin-espeak-selected"
            and recovery.get("espeak_selection_succeeded") is True
            and row.get("notice_request_observed") is True
            and row.get("notice_request_synth") == "espeak"
            and row.get("notice_pcm_nonzero_bytes", 0) > 0)


def start_required_resource_recovery_probe():
    global STAGE, RECOVERY_ORIGINAL_WAVE_FACTORY, REQUIRED_RESOURCE_ORIGINAL_UI_MESSAGE
    import config
    import nvwave
    import speech
    import ui
    from speech.commands import LangChangeCommand, IndexCommand
    STAGE = "required_resource_notification_recovery"
    RESULT["scope"] = "actual-isolated-required-resource-worker-and-fallback-proof"
    RESULT["normal_performance_benchmark_skipped"] = True
    if synthDriverHandler.getSynth() is not DRIVER:
        check(STAGE, "blocked", reason="Original owned synthesizer is no longer active")
        finish()
        return
    target = validate_required_resource_probe_ownership()
    row = RESULT["required_resource_recovery"] = {
        "scope": "Actual missing bundled RuAccent model; genuine worker error and NVDA fallback",
        "synthetic_error_injected": False, "physical_audio_verified": False,
        "acoustic_latency_verified": False, "pronunciation_verified": False,
        "configured_synth_before": config.conf["speech"]["synth"],
        "recording_pcm_sink_test_double": bool(SETTINGS.get("headless_ui_probe")),
        "quarantine_verified_before_request": True,
        "asset_missing_before_nvda_launch": True,
        "asset_sha256": SETTINGS["required_resource_quarantine"]["asset_sha256"],
        "restore_owner": "controller finally after stopping only its owned NVDA process",
        "notice_request_observed": False,
    }
    RECOVERY_ORIGINAL_WAVE_FACTORY = nvwave.WavePlayer
    def create_observed_output(*args, **kwargs):
        player = (RecordingPCMSink(*args, **kwargs) if SETTINGS.get("headless_ui_probe")
                  else RECOVERY_ORIGINAL_WAVE_FACTORY(*args, **kwargs))
        counter = RecordingPCMSink(1, 24000, 16)
        RECOVERY_OUTPUTS.append(counter)
        original_feed = player.feed
        def observed_notice_feed(data, size=None, onDone=None):
            result = original_feed(data, size=size, onDone=onDone)
            if row["notice_request_observed"]:
                counter.feed(data, size=size)
            return result
        player.feed = observed_notice_feed
        return player
    nvwave.WavePlayer = create_observed_output
    REQUIRED_RESOURCE_ORIGINAL_UI_MESSAGE = ui.message
    def observed_notice(text, *args, **kwargs):
        active = synthDriverHandler.getSynth()
        if (isinstance(text, str) and text.startswith("Не вдалося завантажити потрібні ресурси dordiai-voices.")
                and getattr(active, "name", None) == "espeak"):
            row["notice_request_observed"] = True
            row["notice_request_synth"] = active.name
            row["notice_request_ns"] = time.perf_counter_ns()
        return REQUIRED_RESOURCE_ORIGINAL_UI_MESSAGE(text, *args, **kwargs)
    ui.message = observed_notice
    speech.setSpeechMode(speech.SpeechMode.talk)
    row["notice_speech_mode_enabled"] = True
    DRIVER.cancel()
    DRIVER.voice = "sara"
    DRIVER._dordiai_last_error = None
    DRIVER._dordiai_last_error_details = None
    DONE.clear()
    row["request_started_ns"] = time.perf_counter_ns()
    # Fixed, deliberately uncached ordinary text through the public driver.
    # No production hooks, synthetic exception, direct IPC or replayed error.
    DRIVER.speak([LangChangeCommand("ru"),
                  "Проверка восстановления отсутствующего ресурса модели ударений.",
                  IndexCommand(889901)])
    save()
    later(100, lambda: observe_required_resource_recovery(target, time.monotonic() + 90.0))


def observe_required_resource_recovery(target, deadline):
    import config
    row = RESULT["required_resource_recovery"]
    active = synthDriverHandler.getSynth()
    details = getattr(DRIVER, "_dordiai_last_error_details", None)
    row.update(
        diagnostics=details,
        recovery=dict(details.get("recovery", {})) if isinstance(details, dict) else {},
        active_synth=getattr(active, "name", None),
        active_driver_module=type(active).__module__ if active is not None else None,
        configured_synth_preserved=config.conf["speech"]["synth"] == row["configured_synth_before"],
        old_driver_closed=bool(getattr(DRIVER, "_closed", False)),
        old_driver_thread_stopped=not DRIVER._thread.is_alive(),
        asset_still_missing=not target.exists(),
        notice_pcm_bytes=sum(sink.submitted_bytes for sink in RECOVERY_OUTPUTS),
        notice_pcm_nonzero_bytes=sum(sink.nonzero_bytes for sink in RECOVERY_OUTPUTS),
        output_boundary="recording PCM sink TEST DOUBLE" if SETTINGS.get("headless_ui_probe") else "forwarded real WavePlayer",
    )
    passed = required_resource_recovery_passed(row)
    if not passed and time.monotonic() < deadline:
        save()
        later(100, lambda: observe_required_resource_recovery(target, deadline))
        return
    row["elapsed_ms"] = (time.perf_counter_ns() - row["request_started_ns"]) / 1e6
    check("required_resource_notification_recovery", "passed" if passed else "failed", observations=row)
    restore_recovery_output_factory()
    finish()


class GlobalPlugin(globalPluginHandler.GlobalPlugin):
    def __init__(self):
        super().__init__()
        save()
        later(5000, begin)
'''


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verified_installer(cache):
    cache = Path(cache)
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.exists():
        actual = sha256_file(cache)
        if actual != NVDA_SHA256:
            raise ValueError("Cached NVDA installer SHA-256 mismatch: " + actual)
        return cache
    temporary = cache.with_name(cache.name + ".part-" + uuid.uuid4().hex)
    try:
        request = urllib.request.Request(NVDA_URL, headers={"User-Agent": "dordiai-voices-isolated-probe/1"})
        with urllib.request.urlopen(request, timeout=45) as source, temporary.open("xb") as target:
            shutil.copyfileobj(source, target, length=1024 * 1024)
        actual = sha256_file(temporary)
        if actual != NVDA_SHA256:
            raise ValueError("Downloaded NVDA installer SHA-256 mismatch: " + actual)
        os.replace(temporary, cache)
        return cache
    finally:
        temporary.unlink(missing_ok=True)


def existing_nvda_processes():
    """Enumerate names without opening, signaling or terminating another instance."""
    if os.name != "nt":
        return []
    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260),
        ]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel.Process32FirstW.restype = wintypes.BOOL
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel.Process32NextW.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateToolhelp32Snapshot(2, 0)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    found = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        more = kernel.Process32FirstW(handle, ctypes.byref(entry))
        while more:
            if entry.szExeFile.casefold() in {"nvda.exe", "nvda_no_uiaccess.exe", "nvda_slave.exe"}:
                found.append({"pid": entry.th32ProcessID, "name": entry.szExeFile})
            more = kernel.Process32NextW(handle, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(handle)
    return found


def extract_addon(archive, destination):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=False)
    names = set()
    with zipfile.ZipFile(archive) as source:
        if "manifest.ini" not in source.namelist():
            raise ValueError("Add-on archive has no manifest.ini")
        for info in source.infolist():
            # ZipInfo normalizes backslashes on Windows while READING a ZIP.
            # Its original name retains the bytes decoded from the archive;
            # checking filename alone would accept a noncanonical raw path.
            raw_name = info.orig_filename
            path = PurePosixPath(raw_name)
            key = raw_name.casefold()
            if (raw_name != info.filename or path.is_absolute() or ".." in path.parts or "\\" in raw_name or ":" in raw_name
                    or "\x00" in raw_name or key in names or stat.S_ISLNK(info.external_attr >> 16)):
                raise ValueError("Unsafe add-on archive member: " + raw_name)
            names.add(key)
            target = destination.joinpath(*path.parts)
            if not target.resolve().is_relative_to(destination):
                raise ValueError("Add-on archive member escapes isolated config")
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(info) as src, target.open("xb") as out:
                    shutil.copyfileobj(src, out, length=1024 * 1024)
    return destination


def addon_name(path):
    with zipfile.ZipFile(path) as archive:
        manifest = archive.read("manifest.ini").decode("utf-8-sig")
    match = re.search(r'^name\s*=\s*[\"\']?([a-zA-Z0-9_.-]+)', manifest, re.MULTILINE)
    if not match:
        raise ValueError("Cannot determine add-on name from manifest")
    return match.group(1)


def stop_owned(process):
    if process is None or process.poll() is not None:
        return
    # /T is restricted to the tree of the exact Popen PID created by this script.
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20, check=False)
    else:
        process.terminate()
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=20)


def wait_process(process, timeout, expected_file=None):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if expected_file is not None and Path(expected_file).is_file():
            return
        if process.poll() is not None:
            if expected_file is None:
                return
            raise RuntimeError("NVDA exited before producing " + str(expected_file))
        time.sleep(0.25)
    raise TimeoutError("Owned NVDA process exceeded the probe watchdog")


REQUIRED_RESOURCE_RELATIVE = Path("models/PocketTTS/stress/ru_ruaccent/nn_omograph/model.onnx")


def required_resource_probe_paths(addon, owned_run, run_id):
    """Resolve one fixed asset only within this controller's fresh configuration."""
    if not isinstance(run_id, str) or re.fullmatch(r"[0-9a-f]{32}", run_id) is None:
        raise ValueError("Invalid owned probe identifier")
    owned_run = Path(owned_run).resolve(strict=True)
    addon = Path(addon)
    if addon.is_symlink() or (hasattr(addon, "is_junction") and addon.is_junction()):
        raise ValueError("Required-resource probe refuses a linked add-on")
    if addon.resolve(strict=True).parent != owned_run / "config" / "addons":
        raise ValueError("Required-resource probe refuses an add-on outside its owned configuration")
    addon = addon.resolve(strict=True)
    runtime = addon / "kx47Runtime"
    target = runtime / REQUIRED_RESOURCE_RELATIVE
    quarantine = target.with_name(target.name + "." + run_id + ".quarantine")
    # resolve() alone would silently follow links. Reject links/junctions in
    # every controlled component, including a pre-existing target or backup.
    current = addon
    candidates = [addon]
    for component in target.relative_to(addon).parts:
        current = current / component
        candidates.append(current)
    candidates.append(quarantine)
    for candidate in candidates:
        if candidate.is_symlink() or (hasattr(candidate, "is_junction") and candidate.is_junction()):
            raise ValueError("Required-resource probe refuses linked asset paths")
    if runtime.resolve(strict=True) != runtime or target.resolve(strict=False) != target:
        raise ValueError("Required-resource probe asset escaped its owned runtime")
    return owned_run, addon, runtime, target, quarantine


def quarantine_required_resource(addon, owned_run, run_id):
    owned_run, addon, runtime, target, quarantine = required_resource_probe_paths(addon, owned_run, run_id)
    if quarantine.exists():
        raise FileExistsError("Required-resource quarantine already exists")
    info = target.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_nlink != 1:
        raise ValueError("Required-resource probe requires one nonempty ordinary owned file")
    checksum = sha256_file(target)
    record = {"run_root": str(owned_run), "addon_root": str(addon), "runtime_root": str(runtime),
              "run_id": run_id, "asset_relative": REQUIRED_RESOURCE_RELATIVE.as_posix(),
              "quarantine_path": str(quarantine), "asset_sha256": checksum,
              "asset_bytes": info.st_size, "restored": False,
              "asset_missing_before_nvda_launch": False}
    os.replace(target, quarantine)
    try:
        if target.exists() or sha256_file(quarantine) != checksum:
            raise RuntimeError("Required-resource quarantine verification failed")
        record["asset_missing_before_nvda_launch"] = True
        return record
    except BaseException:
        # No caller owns a record until this returns. Roll back even an error
        # encountered between the rename and the controller's finally block.
        if quarantine.exists() and not target.exists():
            os.replace(quarantine, target)
        raise


def restore_required_resource(record):
    """Restore byte-identical data; never overwrite an unexpected replacement."""
    owned_run, addon, runtime, target, quarantine = required_resource_probe_paths(
        record["addon_root"], record["run_root"], record["run_id"])
    if (record.get("runtime_root") != str(runtime)
            or record.get("asset_relative") != REQUIRED_RESOURCE_RELATIVE.as_posix()
            or record.get("quarantine_path") != str(quarantine)):
        raise ValueError("Required-resource restoration metadata does not match its owned asset")
    checksum = record.get("asset_sha256")
    if not isinstance(checksum, str) or re.fullmatch(r"[0-9a-f]{64}", checksum) is None:
        raise ValueError("Invalid required-resource restoration checksum")
    if quarantine.exists():
        if target.exists():
            raise FileExistsError("Refusing to overwrite a replacement required-resource asset")
        if sha256_file(quarantine) != checksum:
            raise RuntimeError("Quarantined required-resource checksum changed; original retained")
        os.replace(quarantine, target)
    if not target.is_file() or sha256_file(target) != checksum:
        raise RuntimeError("Required-resource restoration checksum verification failed")
    record["restored"] = True
    record["restored_sha256"] = checksum
    return {"restored": True, "sha256_identical": True, "bytes": target.stat().st_size}


def cleanup_required_resource_probe(process, record):
    """Always attempt restoration, even if stopping the owned process fails."""
    result = {}
    try:
        stop_owned(process)
    except Exception as error:
        result["owned_process_shutdown_error"] = repr(error)
    finally:
        try:
            result["restoration"] = restore_required_resource(record)
        except Exception as error:
            result["restoration_error"] = repr(error)
    result["status"] = "failed" if "owned_process_shutdown_error" in result or "restoration_error" in result else "passed"
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--addon", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--installer-cache", type=Path, help="Optional cache file path for the pinned official EXE")
    parser.add_argument("--timeout", type=float, default=600.0, help="Watchdog seconds for each NVDA process")
    parser.add_argument("--headless-ui-probe", action="store_true",
                        help="Explicit recording output TEST DOUBLE for real NVDA/driver/model/GUI checks; never certifies WavePlayer or acoustic output")
    recovery_modes = parser.add_mutually_exclusive_group()
    recovery_modes.add_argument("--fatal-recovery-probe", action="store_true",
                        help="Optional injected fatal-notification recovery check after normal speech/latency; not a real model-import failure proof")
    recovery_modes.add_argument("--required-resource-recovery-probe", action="store_true",
                        help="Isolated real missing RuAccent file/worker/fallback proof; skips normal speech benchmarks and restores the owned asset in finally")
    recovery_modes.add_argument("--typing-probe", action="store_true",
                        help="Owned wx.TextCtrl real SendInput/NVDA typing echo and route checks; skips direct speech benchmarks")
    parser.add_argument("--typing-scenario", choices=("standard", "characters-only", "navigation", "forced-uk", "disabled-ru"), default="standard",
                        help="Optional isolated real-key coverage; standard preserves nine keys with native word echo ON")
    args = parser.parse_args(argv)
    if args.typing_scenario != "standard" and not args.typing_probe:
        parser.error("--typing-scenario requires --typing-probe")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    run = Path(tempfile.mkdtemp(prefix="nvda-probe-", dir=output))
    result = {"format_version": 1, "scope": SCOPE, "run_id": run_id,
              "platform": platform.platform(), "status": "running", "run_directory": str(run),
              "nvda_version": NVDA_VERSION, "installer_url": NVDA_URL, "installer_sha256": NVDA_SHA256,
              "checks": [], "limitations": ["Not a full release acceptance or acoustic/linguistic assessment"]}
    result.update(wave_player_verified=False, physical_audio_verified=False,
                  acoustic_latency_verified=False, product_ready=False,
                  recording_pcm_sink_test_double=args.headless_ui_probe)
    if args.headless_ui_probe:
        result["scope"] = "real-nvda-driver-models-gui-with-recording-sink-test-double"
        result["limitations"].append("Explicit headless output double: no WavePlayer/device/acoustic acceptance")
    controller_path = output / "windows-nvda-probe.json"
    process = None
    required_resource_quarantine = None
    restoration_failed = False
    try:
        if os.name != "nt":
            result.update(status="blocked", reason="A real Windows desktop and audio environment are required; no emulation or stubs used")
            return 2
        existing = existing_nvda_processes()
        if existing:
            result.update(status="blocked", reason="An unrelated NVDA instance is running; refusing to replace or stop it", existing_nvda=existing)
            return 2
        if not args.addon.is_file():
            raise FileNotFoundError(args.addon)
        try:
            audio_devices = ctypes.WinDLL("winmm").waveOutGetNumDevs()
            result["audio_environment"] = {"wave_out_devices": int(audio_devices)}
            result["checks"].append({"name": "windows_audio_output_enumeration",
                                     "status": "passed" if audio_devices else "blocked",
                                     "reason": None if audio_devices else "Windows waveOut reports zero output devices; physical audio cannot be verified"})
        except OSError as error:
            result["checks"].append({"name": "windows_audio_output_enumeration", "status": "blocked", "reason": repr(error)})
        result["addon_path"] = str(args.addon.resolve())
        result["addon_sha256"] = sha256_file(args.addon)
        installer = verified_installer(args.installer_cache.resolve() if args.installer_cache else output / ("nvda_" + NVDA_VERSION + ".exe"))
        result["checks"].append({"name": "official_installer_checksum", "status": "passed"})
        portable = run / "portable"
        config = run / "config"
        config.mkdir()
        # No installed NVDA, registry, startup task or user configuration is changed.
        bootstrap_log = run / "portable-creation.log"
        command = [str(installer), "--create-portable-silent", "--portable-path=" + str(portable),
                   "--config-path=" + str(config), "--no-sr-flag", "--minimal", "--log-file=" + str(bootstrap_log)]
        result["portable_creation_command"] = command
        with (run / "portable-creation-console.log").open("wb") as console:
            process = subprocess.Popen(command, cwd=run, stdout=console, stderr=subprocess.STDOUT)
            wait_process(process, min(args.timeout, 240.0))
            exit_code = process.returncode
        process = None
        executable = portable / "nvda.exe"
        if not executable.is_file():
            raise RuntimeError("Portable NVDA creation did not produce nvda.exe; bootstrap exit=" + str(exit_code))
        result["checks"].append({"name": "portable_nvda_created", "status": "passed", "bootstrap_exit_code": exit_code})
        addon = extract_addon(args.addon, config / "addons" / addon_name(args.addon))
        result["extracted_addon"] = str(addon)
        if args.required_resource_recovery_probe:
            # Before launch: startup itself warms RuAccent in the real worker.
            required_resource_quarantine = quarantine_required_resource(addon, run, run_id)
            result["required_resource_quarantine"] = required_resource_quarantine
            result["scope"] = "actual-isolated-required-resource-worker-and-fallback-proof"
            result["normal_performance_benchmark_skipped"] = True
        if args.typing_probe:
            result["scope"] = "actual-isolated-keyboard-NVDA-typing-and-model-PCM-proof"
            result["normal_performance_benchmark_skipped"] = True
        probe_addon = config / "addons" / "dordiaiProbe"
        plugins = probe_addon / "globalPlugins"
        plugins.mkdir(parents=True)
        (probe_addon / "manifest.ini").write_text(
            'name = "dordiaiProbe"\nsummary = "Isolated dordiai integration probe"\n'
            'version = "1.0.0"\nauthor = "dordiai-voices"\n'
            'minimumNVDAVersion = "2026.1"\nlastTestedNVDAVersion = "2026.3.1"\n', encoding="utf-8")
        plugin_source = PROBE_PLUGIN.replace("__NATIVE_IMPORT_DIAGNOSTIC__", repr(NATIVE_IMPORT_DIAGNOSTIC)).replace("__PROBE_SETTINGS__", repr({
            "output": str(run), "run_id": run_id, "headless_ui_probe": args.headless_ui_probe,
            "fatal_recovery_probe": args.fatal_recovery_probe,
            "required_resource_recovery_probe": args.required_resource_recovery_probe,
            "typing_probe": args.typing_probe,
            "typing_scenario": args.typing_scenario,
            "required_resource_quarantine": required_resource_quarantine,
        }))
        if args.typing_probe:
            from importlib.util import module_from_spec, spec_from_file_location
            typing_spec = spec_from_file_location("_dordiai_typing_probe_controller", Path(__file__).with_name("windows_nvda_typing_probe.py"))
            typing_module = module_from_spec(typing_spec)
            typing_spec.loader.exec_module(typing_module)
            plugin_source = typing_module.extend_plugin(plugin_source)
        (plugins / "dordiaiProbe.py").write_text(plugin_source, encoding="utf-8")
        (config / "nvda.ini").write_text(
            '[general]\nshowWelcomeDialog = False\naskToExit = False\nsaveConfigurationOnExit = False\n'
            'playStartAndExitSounds = False\nlanguage = en\n'
            '[update]\nautoCheck = False\nstartupNotification = False\n'
            '[speech]\nsynth = silence\n', encoding="utf-8")
        log = run / "nvda.log"
        result["nvda_log"] = str(log)
        result["probe_json"] = str(run / "nvda-probe.json")
        command = [str(executable), "--config-path=" + str(config), "--log-file=" + str(log),
                   "--debug-logging", "--no-sr-flag", "--minimal", "--lang=en"]
        result["nvda_command"] = command
        write_json(controller_path, result)
        with (run / "nvda-console.log").open("wb") as console:
            process = subprocess.Popen(command, cwd=portable, stdout=console, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + args.timeout
            probe_path = run / "nvda-probe.json"
            while time.monotonic() < deadline:
                if probe_path.is_file():
                    try:
                        probe = json.loads(probe_path.read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        probe = {}
                    if probe.get("run_id") == run_id and probe.get("status") not in {None, "running"}:
                        result["probe"] = probe
                        result["status"] = probe["status"]
                        result["wave_player_verified"] = bool(probe.get("wave_player_verified")) and not args.headless_ui_probe
                        if result["status"] == "passed" and any(check["status"] == "blocked" for check in result["checks"]):
                            result["status"] = "partial"
                        break
                if process.poll() is not None:
                    raise RuntimeError("Real NVDA exited before the probe finished; inspect nvda.log")
                time.sleep(0.25)
            else:
                raise TimeoutError("Real NVDA probe did not finish; inspect saved partial JSON and nvda.log")
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                # First request normal shutdown inside the probe; only terminate our tree if it hangs.
                stop_owned(process)
        process = None
        result["nvda_log"] = str(log)
        result["probe_json"] = str(probe_path)
        return 0 if result["status"] == "passed" else 2 if result["status"] in {"partial", "blocked"} else 1
    except Exception as error:
        result.update(status="failed", error=repr(error), traceback=traceback.format_exc())
        return 1
    finally:
        if required_resource_quarantine is not None:
            cleanup = cleanup_required_resource_probe(process, required_resource_quarantine)
            result["required_resource_cleanup"] = cleanup
            result["checks"].append(dict(name="required_resource_sha_identical_restoration",
                                         status=cleanup["status"], **cleanup.get("restoration", {})))
            if cleanup["status"] != "passed":
                restoration_failed = True
                result["status"] = "failed"
        else:
            stop_owned(process)
        result["finished_at_ns"] = time.time_ns()
        write_json(controller_path, result)
        summary = {"status": result["status"], "result": str(controller_path), "run_directory": str(run)}
        for key in ("error", "reason", "traceback"):
            if key in result:
                summary[key] = result[key]
        if isinstance(result.get("probe"), dict):
            summary["nonpassing_checks"] = [{key: entry[key] for key in ("name", "status", "error", "reason") if key in entry}
                                             for entry in result["probe"].get("checks", []) if entry.get("status") != "passed"]
        print(json.dumps(summary), flush=True)
        if restoration_failed:
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
