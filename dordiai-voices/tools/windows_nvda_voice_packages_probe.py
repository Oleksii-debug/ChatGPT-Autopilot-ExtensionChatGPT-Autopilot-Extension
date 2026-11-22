"""Real NVDA/wx package-maintenance pipeline probe for an immutable core13.

Operations are dispatched through the real dialog's async maintenance method.
This does not claim native file-chooser keyboard or full accessibility acceptance.
No add-on/model download occurs until the caller supplies a verified core13.
"""
from hashlib import sha256
import importlib.util
import inspect
import json
from pathlib import Path
import re
import sys

EXPECTED_VERSION = "0.13.1-dev.13"
ANCHOR = "    later(500, open_settings)\n"


def modal_allowed(row, process_id, title):
    return (isinstance(row, dict) and row.get("pid") == process_id
            and row.get("title") == title and row.get("class") == "#32770"
            and row.get("visible") is True and row.get("ok_id") == 1)


def validate_build_pin(pin):
    if (not isinstance(pin, dict) or pin.get("format") != "dordiai-source13-build-pin"
            or pin.get("version") != EXPECTED_VERSION
            or type(pin.get("archive_bytes")) is not int or pin["archive_bytes"] <= 0
            or not re.fullmatch(r"[0-9a-f]{64}", str(pin.get("archive_sha256", "")))
            or not re.fullmatch(r"[0-9a-f]{40}", str(pin.get("source_commit", "")))
            or type(pin.get("source_run_id")) is not int or pin["source_run_id"] <= 0
            or pin.get("product_ready") is not False):
        raise ValueError("Actual immutable source13 build pin required")
    return pin


def verify_addon(path, pin):
    import zipfile
    pin = validate_build_pin(pin)
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size != pin["archive_bytes"]:
        raise ValueError("Actual source13 archive size differs")
    with path.open("rb") as stream:
        actual = __import__("hashlib").file_digest(stream, "sha256").hexdigest()
    if actual != pin["archive_sha256"]:
        raise ValueError("Actual source13 archive SHA differs")
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("dordiai-release.json"))
    if manifest.get("version") != EXPECTED_VERSION or len(manifest.get("voice_ids", [])) != 45:
        raise ValueError("Actual source13 archive identity/version differs")
    return pin


def fixture_manifest(voice, version, data):
    return {"format": "dordiai-voice-package", "format_version": 1, "id": voice,
            "name": "Owned lifecycle fixture " + voice, "version": version,
            "engine": {"id": "holos", "compatibility_version": 1},
            "languages": ["uk"], "styles": ["neutral"], "requires": [],
            "provenance": {"source": "Exact copy of the permitted installed profile in an owned disposable NVDA configuration",
                           "license": "Inherited source conditions; internal regression fixture, not a new distributable voice"},
            "files": {"holos.npy": {"size_bytes": len(data), "sha256": sha256(data).hexdigest(), "role": "holos_profile"}}}


PROBE_FUNCTION = r'''
VOICE_LIFECYCLE = {}


def lifecycle_modal_worker(title, state):
    # Close only the genuine owned-process native OK message box. Never replace
    # gui.messageBox or return a fake wx dialog/selection result.
    import ctypes
    from ctypes import wintypes
    user = ctypes.WinDLL("user32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user.EnumWindows.restype = wintypes.BOOL
    user.EnumChildWindows.argtypes = [wintypes.HWND, callback_type, wintypes.LPARAM]
    user.EnumChildWindows.restype = wintypes.BOOL
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.GetWindowThreadProcessId.restype = wintypes.DWORD
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user.GetDlgItem.argtypes = [wintypes.HWND, ctypes.c_int]
    user.GetDlgItem.restype = wintypes.HWND
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.IsWindowVisible.restype = wintypes.BOOL
    user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user.PostMessageW.restype = wintypes.BOOL
    while time.monotonic() < state["deadline"] and not FINISHED:
        eligible = []
        def visit(hwnd, unused):
            process_id = wintypes.DWORD()
            user.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
            caption, cls = ctypes.create_unicode_buffer(2048), ctypes.create_unicode_buffer(128)
            user.GetWindowTextW(hwnd, caption, len(caption))
            user.GetClassNameW(hwnd, cls, len(cls))
            row = {"pid": int(process_id.value), "title": caption.value, "class": cls.value,
                   "visible": bool(user.IsWindowVisible(hwnd)), "ok_id": 1 if user.GetDlgItem(hwnd, 1) else None}
            if modal_allowed(row, os.getpid(), title):
                eligible.append((hwnd, row))
            return True
        user.EnumWindows(callback_type(visit), 0)
        if len(eligible) > 1:
            state["modal_error"] = "Ambiguous owned native message box"
            return
        if eligible:
            hwnd, row = eligible[0]
            texts = []
            def child_text(child, unused):
                caption, cls = ctypes.create_unicode_buffer(4096), ctypes.create_unicode_buffer(128)
                user.GetWindowTextW(child, caption, len(caption))
                user.GetClassNameW(child, cls, len(cls))
                if cls.value == "Static" and caption.value:
                    texts.append(caption.value)
                return True
            user.EnumChildWindows(hwnd, callback_type(child_text), 0)
            row["text"] = "\n".join(texts)
            row["ok_posted"] = bool(user.PostMessageW(hwnd, 0x111, 1, 0))
            state["completion_modal"] = row
            return
        time.sleep(.05)
    state["modal_error"] = "No owned completion message box before deadline"


def lifecycle_dialog():
    active = synthDriverHandler.getSynth()
    for window in wx.GetTopLevelWindows():
        if hasattr(window, "packages") and getattr(window, "synth", None) is active:
            return window
    return None


def lifecycle_modal_guarded(title, state):
    try:
        lifecycle_modal_worker(title, state)
    except Exception as error:
        state["modal_error"] = repr(error)
        state["modal_traceback"] = traceback.format_exc()


def lifecycle_begin():
    global RECOVERY_ORIGINAL_WAVE_FACTORY
    import nvwave
    if SETTINGS.get("headless_ui_probe"):
        RECOVERY_ORIGINAL_WAVE_FACTORY = nvwave.WavePlayer
        nvwave.WavePlayer = RecordingPCMSink
    result = RESULT["voice_package_lifecycle"] = {
        "scope": "Real wx dialog async maintenance, genuine installed package assets and real worker replacement",
        "api_dispatched_operations": True, "native_file_chooser_interaction_verified": False,
        "full_keyboard_accessibility_verified": False, "actual_restart_upgrade_verified": False,
        "physical_audio_verified": False, "product_ready": False, "steps": []}
    RESULT["scope"] = "actual-NVDA-real-wx-package-maintenance-functional-pipeline"
    module = sys.modules[type(DRIVER).__module__]
    prefs = module._prefs
    refs = Path(DRIVER._voiceReferences)
    assets = prefs._package_component("voice_assets")
    candidates = [path for path in sorted((refs / "holos").glob("*.npy"))
                  if path.stem in DRIVER._dordiai_all_voices() and path.stem != DRIVER.voice]
    if not candidates:
        raise ValueError("No permitted independent installed Holos fixture profile")
    profile = candidates[0]
    packages = assets._packages
    packages.require_voice_allowed(profile.stem)
    package_root = assets.package_root(refs)
    if profile.stem in packages._load_index(package_root)["active"]:
        raise ValueError("Fixture would overwrite an installed optional voice")
    source = OUTPUT / "lifecycle-fixture-source"
    source.mkdir()
    data = profile.read_bytes()
    (source / "holos.npy").write_bytes(data)
    archives = {}
    for version in ("1.0.0", "2.0.0"):
        target = OUTPUT / ("lifecycle-" + version + ".dordiai-voice")
        packages.create_package(source, fixture_manifest(profile.stem, version, data), target)
        archives[version] = target
    import zipfile
    corrupt = OUTPUT / "lifecycle-corrupt.dordiai-voice"
    document = fixture_manifest(profile.stem, "3.0.0", data)
    with zipfile.ZipFile(corrupt, "w") as archive:
        archive.writestr(packages.MANIFEST_NAME, json.dumps(document))
        archive.writestr("holos.npy", data + b"X")
    VOICE_LIFECYCLE.update(prefs=prefs, assets=assets, packages=packages, refs=refs,
        profile=profile, profile_sha=hashlib.sha256(data).hexdigest(), voice=profile.stem,
        archives=archives, corrupt=corrupt, index=0, previous_dialog=None,
        plan=[("install-v1", "1.0.0", None), ("install-v2", "2.0.0", None),
              ("rollback-v1", "1.0.0", None), ("corrupt-rejected", "1.0.0", None),
              ("locked-remove", None, "1.0.0"), ("retry-remove", None, None),
              ("install-again", "1.0.0", None), ("retain-files", None, "1.0.0"),
              ("activate-retained", "1.0.0", None), ("final-remove", None, None)])
    result.update(voice=profile.stem, original_core_profile_sha256=VOICE_LIFECYCLE["profile_sha"])
    later(250, lifecycle_next)
    DRIVER._dordiai_open_settings()


def lifecycle_next():
    global DRIVER, STAGE
    state = VOICE_LIFECYCLE
    if state["index"] == len(state["plan"]):
        RESULT["voice_package_lifecycle"]["functional_pipeline_verified"] = True
        check("voice_package_functional_pipeline", "passed", operations=len(state["plan"]))
        dialog = lifecycle_dialog()
        if dialog is not None:
            dialog.onCancel(None)
        finish()
        return
    dialog = lifecycle_dialog()
    if dialog is None:
        raise RuntimeError("No genuine freshly reopened package dialog")
    DRIVER = synthDriverHandler.getSynth()
    name, expected_active, expected_inactive = state["plan"][state["index"]]
    STAGE = "voice_package_" + name
    packages, assets, refs, voice = state["packages"], state["assets"], state["refs"], state["voice"]
    root = dialog._package_root()
    if voice in getattr(dialog, "enabled_voice_codes", []):
        dialog.voice.SetSelection(dialog.enabled_voice_codes.index(voice))
    dialog.tabs.SetSelection(3)
    row = {"name": name, "old_driver_id": id(DRIVER), "real_dialog_type": type(dialog).__name__,
           "labels": {key: getattr(dialog, key).GetLabel() for key in ("install_package", "remove_package", "rollback_package")},
           "deadline": time.monotonic() + 150}
    if name in ("install-v1", "install-v2", "install-again"):
        operation = lambda: state["prefs"].install_extra_package(state["archives"][expected_active], root, references=refs, engine_id="holos")
    elif name == "corrupt-rejected":
        operation = lambda: state["prefs"].install_extra_package(state["corrupt"], root, references=refs, engine_id="holos")
    elif name in ("rollback-v1", "activate-retained"):
        operation = lambda: assets.activate_voice_version(refs, voice, "1.0.0", engine_id="holos")
    elif name == "retain-files":
        operation = lambda: packages.uninstall_package(assets.package_root(refs), voice, keep_files=True)
    else:
        if name == "locked-remove":
            import mmap
            target = assets.asset_path(refs, voice, "holos_profile", required=True)
            row["locked_stream"] = target.open("rb")
            row["locked_map"] = mmap.mmap(row["locked_stream"].fileno(), 0, access=mmap.ACCESS_READ)
        operation = lambda: assets.uninstall_voice_package(refs, voice)
    state.update(previous_dialog=dialog, current=row)
    threading.Thread(target=lifecycle_modal_guarded, args=(dialog.title, row), daemon=True).start()
    dialog._run_package_operation("Перевірка життєвого циклу голосового пакета…", operation)
    row["espeak_selected_before_async_mutation"] = (getattr(synthDriverHandler.getSynth(), "name", None) == "espeak")
    later(100, lifecycle_poll)


def lifecycle_poll():
    global DRIVER, ORIGINAL_PLAY, ORIGINAL_FEED
    state, row = VOICE_LIFECYCLE, VOICE_LIFECYCLE["current"]
    old = state["previous_dialog"]
    dialog = lifecycle_dialog()
    active = synthDriverHandler.getSynth()
    if row.get("modal_error"):
        raise RuntimeError(row["modal_error"])
    if dialog is None or dialog is old or active is None or getattr(active, "name", None) != "kx47Preview":
        if time.monotonic() >= row["deadline"]:
            raise TimeoutError("Actual package pipeline did not restore a fresh dialog/driver")
        later(100, lifecycle_poll)
        return
    expected_active, expected_inactive = state["plan"][state["index"]][1:]
    index = state["packages"]._load_index(state["assets"].package_root(state["refs"]))
    voice = state["voice"]
    details = {
        "name": row["name"], "new_driver_id": id(active), "old_driver_id": row["old_driver_id"],
        "fresh_driver": id(active) != row["old_driver_id"],
        "old_driver_closed": bool(getattr(old.synth, "_closed", False)),
        "old_thread_stopped": not old.synth._thread.is_alive(),
        "espeak_selected_before_async_mutation": row["espeak_selected_before_async_mutation"],
        "completion_modal": row.get("completion_modal"), "labels": row["labels"],
        "active_version": index["active"].get(voice), "inactive_version": index.get("inactive", {}).get(voice),
        "index_format_version": index["format_version"],
        "core_profile_unchanged": hashlib.sha256(state["profile"].read_bytes()).hexdigest() == state["profile_sha"],
        "package_list": list(dialog.packages.GetStrings()),
        "result_notice": row.get("completion_modal", {}).get("text"),
        "maintenance_released": old._package_speech.get("maintenance_released") is True,
    }
    if details["active_version"] != expected_active or details["inactive_version"] != expected_inactive:
        raise ValueError("Actual package active/inactive ownership differs from expected operation outcome")
    if expected_active:
        target = state["assets"].asset_path(state["refs"], voice, "holos_profile", required=True)
        details["managed_profile_sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
        if details["managed_profile_sha256"] != state["profile_sha"]:
            raise ValueError("Real imported fixture profile differs")
    if expected_inactive:
        if voice in state["packages"].discover_packages(state["assets"].package_root(state["refs"])):
            raise ValueError("Inactive package was re-exposed to speech discovery")
        if not any("неактивний" in text for text in details["package_list"]):
            raise ValueError("Actual inactive package row is absent or unlabeled")
    if not all(details[key] for key in ("fresh_driver", "old_driver_closed", "old_thread_stopped", "espeak_selected_before_async_mutation", "core_profile_unchanged", "maintenance_released")):
        raise ValueError("Actual driver retirement/reload/core preservation invariant failed")
    if not row.get("completion_modal", {}).get("ok_posted"):
        raise ValueError("No genuine owned completion message box was acknowledged")
    if not (details["result_notice"] or "").strip():
        raise ValueError("Actual completion/error message text was not captured")
    success_notice = "Пакет змінено й перевірено." in (details["result_notice"] or "")
    if success_notice != (row["name"] not in {"corrupt-rejected", "locked-remove"}):
        raise ValueError("Actual accessible operation notice contradicts expected success/error")
    for key in ("locked_map", "locked_stream"):
        if key in row:
            row.pop(key).close()
    RESULT["voice_package_lifecycle"]["steps"].append(details)
    check("voice_package_" + row["name"], "passed", observations=details)
    DRIVER = active
    # Base cleanup must never restore a retired driver's bound output methods
    # onto a new instance. No audio claim is made by this lifecycle-only path.
    ORIGINAL_PLAY = ORIGINAL_FEED = None
    state["index"] += 1
    later(250, lifecycle_next)
'''


def extend_plugin(source):
    if source.count(ANCHOR) != 1 or "def lifecycle_begin(" in source:
        raise ValueError("Frozen NVDA probe source anchor differs")
    helpers = "\nimport os\nimport hashlib\nfrom hashlib import sha256\n" + inspect.getsource(modal_allowed) + "\n" + inspect.getsource(fixture_manifest)
    return source.replace(ANCHOR, "    later(500, lifecycle_begin)\n") + helpers + PROBE_FUNCTION


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument("--build-pin", type=Path, default=Path(__file__).parent / "data/source13_build_pin.json")
    args, remaining = parser.parse_known_args(argv)
    options = argparse.ArgumentParser(add_help=False)
    options.add_argument("--addon", required=True, type=Path)
    addon, unused = options.parse_known_args(remaining)
    pin = json.loads(args.build_pin.read_text(encoding="utf-8"))
    verify_addon(addon.addon, pin)
    spec = importlib.util.spec_from_file_location("_dordiai_voice_package_nvda_base", Path(__file__).with_name("windows_nvda_probe.py"))
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    base.PROBE_PLUGIN = extend_plugin(base.PROBE_PLUGIN)
    return base.main(remaining)


if __name__ == "__main__":
    raise SystemExit(main())
