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

# This code runs inside the downloaded, unmodified NVDA interpreter. It does
# not stub wx, the synth driver, native models or Windows audio APIs.
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
}
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
DONE = threading.Event()
SAMPLE_RATE = 24000
SAMPLES = {}


def save():
    temporary = OUTPUT / "nvda-probe.json.tmp"
    temporary.write_text(json.dumps(RESULT, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(OUTPUT / "nvda-probe.json")


def check(name, status, **details):
    RESULT["checks"].append(dict(name=name, status=status, **details))
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
    # Count only buffers whose real WavePlayer submission returned successfully.
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
    selected = synthDriverHandler.setSynth("kx47Preview")
    DRIVER = synthDriverHandler.getSynth()
    if not selected or DRIVER is None or getattr(DRIVER, "name", None) != "kx47Preview":
        check("select_dordiai", "failed", returned=bool(selected), actual=getattr(DRIVER, "name", None))
        finish()
        return
    check("select_dordiai", "passed", name=DRIVER.name)
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
    later(500, start_phrase)


def start_phrase():
    global STAGE
    STAGE = "phrase"
    from speech.commands import LangChangeCommand, IndexCommand
    DRIVER.cancel()
    DONE.clear()
    DRIVER._dordiai_last_error = None
    RESULT["phrase_requested_ns"] = time.perf_counter_ns()
    DRIVER.speak([LangChangeCommand("uk"), "Кнопка перемикач натиснуто. ",
                  LangChangeCommand("en"), "Open the document. ", IndexCommand(880001)])
    wait_for_stage("phrase", time.monotonic() + 150.0, start_character)


def wait_for_stage(stage, deadline, continuation):
    stats = snapshot(stage)
    if DONE.is_set():
        error = getattr(DRIVER, "_dordiai_last_error", None)
        success = stats.get("pcm_bytes", 0) > 0 and stats.get("nonzero_bytes", 0) > 0 and not error
        check(stage + "_pcm_submission", "passed" if success else "failed", metrics=stats, driver_error=error)
        later(300, continuation)
    elif time.monotonic() >= deadline:
        check(stage + "_pcm_submission", "failed", reason="Real synthesis did not complete before the watchdog", metrics=stats,
              driver_error=getattr(DRIVER, "_dordiai_last_error", None))
        DRIVER.cancel()
        later(300, continuation)
    else:
        later(250, lambda: wait_for_stage(stage, deadline, continuation))


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
    # Capture the boundary before the REAL WavePlayer feed, and count the
    # observation only after that real call returns. No audio output stub is used.
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
        "boundary": "driver.speak call to first nonzero PCM forwarded to real WavePlayer.feed",
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
              "warm_switch_requests_ms": [], "timeouts": [], "errors": []}
    deadline = time.monotonic() + 240.0
    installed = set(DRIVER._dordiai_all_languages())
    enabled = set(DRIVER._dordiai_enabled_languages)
    languages = [code for code in ("uk", "en", "ru") if code in installed and code in enabled]
    letters = {"uk": "а", "en": "a", "ru": "а"}

    def request_letter(language, wait_done=True):
        global ACTIVE_REQUEST
        if LATENCY_STOP.is_set() or time.monotonic() >= deadline:
            raise TimeoutError("Latency watchdog exhausted")
        DRIVER.cancel()
        DONE.clear()
        pending = {"event": threading.Event(), "started_ns": time.perf_counter_ns(), "first_feed_ns": None}
        with LOCK:
            ACTIVE_REQUEST = pending
        DRIVER.speak([LangChangeCommand(language), CharacterModeCommand(True), letters[language], CharacterModeCommand(False)])
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
    summary = {"warm_letters": percentiles(output["warm_letters_ms"]),
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
        complete = measurements["count"] >= 100
        passed = complete and measurements["p95_ms"] <= 20.0 and measurements["p99_ms"] <= 50.0
        check(name, "passed" if passed else "failed", measurements=measurements,
              p95_target_ms=20.0, p99_target_ms=50.0,
              physical_audible_acceptance="not measured")
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


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--addon", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--installer-cache", type=Path, help="Optional cache file path for the pinned official EXE")
    parser.add_argument("--timeout", type=float, default=600.0, help="Watchdog seconds for each NVDA process")
    args = parser.parse_args(argv)
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
    controller_path = output / "windows-nvda-probe.json"
    process = None
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
        probe_addon = config / "addons" / "dordiaiProbe"
        plugins = probe_addon / "globalPlugins"
        plugins.mkdir(parents=True)
        (probe_addon / "manifest.ini").write_text(
            'name = "dordiaiProbe"\nsummary = "Isolated dordiai integration probe"\n'
            'version = "1.0.0"\nauthor = "dordiai-voices"\n'
            'minimumNVDAVersion = "2026.1"\nlastTestedNVDAVersion = "2026.3.1"\n', encoding="utf-8")
        (plugins / "dordiaiProbe.py").write_text(PROBE_PLUGIN.replace("__PROBE_SETTINGS__", repr({"output": str(run), "run_id": run_id})), encoding="utf-8")
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


if __name__ == "__main__":
    raise SystemExit(main())
