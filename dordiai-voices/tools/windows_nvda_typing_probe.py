"""Probe-only real Windows keyboard echo extension for the owned NVDA instance.

This module supplies code appended to the isolated probe add-on. It never
imports NVDA on the controller and never changes product add-on source.
"""
PLUGIN_CODE = r'''
import ctypes as _typing_ct
import os as _typing_os

class _TypingMouse(_typing_ct.Structure):
    _fields_ = [("dx", _typing_ct.c_int32), ("dy", _typing_ct.c_int32),
                ("mouseData", _typing_ct.c_uint32), ("dwFlags", _typing_ct.c_uint32),
                ("time", _typing_ct.c_uint32), ("dwExtraInfo", _typing_ct.c_size_t)]

class _TypingKeyboard(_typing_ct.Structure):
    _fields_ = [("wVk", _typing_ct.c_uint16), ("wScan", _typing_ct.c_uint16),
                ("dwFlags", _typing_ct.c_uint32), ("time", _typing_ct.c_uint32),
                ("dwExtraInfo", _typing_ct.c_size_t)]

class _TypingHardware(_typing_ct.Structure):
    _fields_ = [("uMsg", _typing_ct.c_uint32), ("wParamL", _typing_ct.c_uint16),
                ("wParamH", _typing_ct.c_uint16)]

class _TypingUnion(_typing_ct.Union):
    _fields_ = [("mi", _TypingMouse), ("ki", _TypingKeyboard), ("hi", _TypingHardware)]

class _TypingInput(_typing_ct.Structure):
    _fields_ = [("type", _typing_ct.c_uint32), ("data", _TypingUnion)]

_TYPING_CASES = (("uk", "00000422", "а"), ("uk", "00000422", "ї"),
                 ("en", "00000409", "a"), ("en", "00000409", "b"),
                 ("ru", "00000419", "а"), ("ru", "00000419", "ы"))
_TYPING = None


def _typing_sequence(sequence):
    result = []
    for item in sequence:
        if isinstance(item, str):
            result.append({"text": item[:120]})
        else:
            row = {"command": type(item).__name__}
            for key in ("lang", "state"):
                if hasattr(item, key):
                    row[key] = getattr(item, key)
            result.append(row)
    return result


def _typing_focus_owned():
    import api
    import controlTypes
    state = _TYPING
    if not state or state.get("cleaned"):
        return False
    focus = api.getFocusObject()
    hwnd = state["text"].GetHandle()
    pid = _typing_ct.c_uint32()
    state["user"].GetWindowThreadProcessId(hwnd, _typing_ct.byref(pid))
    return (pid.value == _typing_os.getpid() and
            state["user"].GetForegroundWindow() == state["frame"].GetHandle() and
            getattr(focus, "windowHandle", None) == hwnd and
            focus.role == controlTypes.Role.EDITABLETEXT and not api.isTypingProtected())


def _typing_on_raw_key(vkCode, scanCode, extended, pressed, injected):
    state = _TYPING
    row = state.get("active") if state and not state.get("cleaned") else None
    if row is not None and vkCode == row.get("vk"):
        row["raw_keys"].append({"pressed": bool(pressed), "injected": bool(injected),
                                "scan": int(scanCode), "time_ns": time.perf_counter_ns()})
    return True


def _typing_on_queued(speechSequence, priority):
    state = _TYPING
    row = state.get("active") if state and state.get("in_typed_handler") else None
    if row is not None:
        row["normal_typed_speech"].append(_typing_sequence(speechSequence))


def _typing_on_synth(speechSequence):
    state = _TYPING
    row = state.get("active") if state and not state.get("cleaned") else None
    if row is not None and row["typed_events"] and synthDriverHandler.getSynth() is DRIVER:
        row["driver_sequences"].append(_typing_sequence(speechSequence))
        row.setdefault("driver_request_ns", time.perf_counter_ns())


def _typing_observe_parts(*args, **kwargs):
    source = _TYPING["original_parts"](*args, **kwargs)
    try:
        for part in source:
            kind, value = part
            state = _TYPING
            row = state.get("active") if state and not state.get("cleaned") else None
            if row is not None and row["typed_events"] and kind in {"text", "character"} and isinstance(value, dict):
                row["routes"].append({key: value.get(key) for key in
                                      ("language", "profile", "character", "text")})
            yield part
    finally:
        close = getattr(source, "close", None)
        if close is not None:
            close()


def _typing_on_feed(data, *args, **kwargs):
    state = _TYPING
    submitted = time.perf_counter_ns()
    result = state["original_feed"](data, *args, **kwargs)
    row = state.get("active") if not state.get("cleaned") else None
    if (row is not None and submitted >= row.get("driver_request_ns", submitted + 1) and
            isinstance(data, (bytes, bytearray, memoryview)) and any(data)):
        row.setdefault("first_typing_pcm_ns", submitted)
    return result


def _typing_bind_user32():
    user = _typing_ct.WinDLL("user32", use_last_error=True)
    signatures = {
        "GetForegroundWindow": ([], _typing_ct.c_void_p),
        "GetWindowThreadProcessId": ([_typing_ct.c_void_p, _typing_ct.POINTER(_typing_ct.c_uint32)], _typing_ct.c_uint32),
        "GetKeyboardLayout": ([_typing_ct.c_uint32], _typing_ct.c_void_p),
        "GetKeyboardLayoutList": ([_typing_ct.c_int, _typing_ct.POINTER(_typing_ct.c_void_p)], _typing_ct.c_int),
        "LoadKeyboardLayoutW": ([_typing_ct.c_wchar_p, _typing_ct.c_uint], _typing_ct.c_void_p),
        "ActivateKeyboardLayout": ([_typing_ct.c_void_p, _typing_ct.c_uint], _typing_ct.c_void_p),
        "UnloadKeyboardLayout": ([_typing_ct.c_void_p], _typing_ct.c_int),
        "VkKeyScanExW": ([_typing_ct.c_wchar, _typing_ct.c_void_p], _typing_ct.c_short),
        "MapVirtualKeyExW": ([_typing_ct.c_uint, _typing_ct.c_uint, _typing_ct.c_void_p], _typing_ct.c_uint),
        "GetKeyState": ([_typing_ct.c_int], _typing_ct.c_short),
        "GetAsyncKeyState": ([_typing_ct.c_int], _typing_ct.c_short),
        "SendInput": ([_typing_ct.c_uint, _typing_ct.POINTER(_TypingInput), _typing_ct.c_int], _typing_ct.c_uint),
    }
    for name, (arguments, result) in signatures.items():
        function = getattr(user, name)
        function.argtypes, function.restype = arguments, result
    return user


def _typing_key_pair(scan):
    values = (_TypingInput * 2)()
    for index, flags in enumerate((0x0008, 0x0008 | 0x0002)):
        values[index].type = 1
        values[index].data.ki = _TypingKeyboard(0, scan, flags, 0, 0x44565459)
    return values


def start_actual_typing_probe():
    global _TYPING, STAGE
    import config
    import keyboardHandler
    import inputCore
    import speech
    if synthDriverHandler.getSynth() is not DRIVER:
        check("actual_typing_setup", "blocked", reason="The selected owned synthesizer changed")
        finish()
        return
    user = _typing_bind_user32()
    if keyboardHandler.ignoreInjected or user.GetKeyState(0x14) & 1 or any(
            user.GetAsyncKeyState(key) & 0x8000 for key in (0x10, 0x11, 0x12, 0x5b, 0x5c)):
        check("actual_typing_setup", "blocked", reason="Injected-key suppression, Caps Lock or an unrelated held modifier is active")
        finish()
        return
    STAGE = "typing_setup"
    count = user.GetKeyboardLayoutList(0, None)
    if not 0 < count <= 128:
        raise RuntimeError("Could not inspect owned typing keyboard layouts")
    layouts = (_typing_ct.c_void_p * count)()
    user.GetKeyboardLayoutList(count, layouts)
    frame = wx.Frame(None, title="Dordiai isolated real typing probe")
    text = wx.TextCtrl(frame, value="", size=(500, 80))
    frame.SetClientSize((520, 100))
    keys = {"speakTypedCharacters": 1, "speakTypedWords": 0,
            "handleInjectedKeys": True, "speechInterruptForCharacters": True, "speakCommandKeys": False}
    _TYPING = {"frame": frame, "text": text, "user": user, "index": 0, "active": None,
               "last_language": None, "expected": "", "loaded": [],
               "before_layouts": set(int(value) for value in layouts if value),
               "original_layout": user.GetKeyboardLayout(0),
               "saved_keys": {key: config.conf["keyboard"][key] for key in keys},
               "saved_mode": speech.getState().speechMode,
               "original_parts": DRIVER._planned_parts, "original_feed": DRIVER._player.feed,
               "cleaned": False, "in_typed_handler": False}
    RESULT["actual_typing"] = {"scope": "real SendInput to owned wx.TextCtrl through unchanged NVDA typing handlers",
        "input_injection": "scan-code SendInput, not WM_CHAR or direct speech calls",
        "speech_mode": "talk", "speak_typed_characters": 1, "speak_typed_words": 0,
        "no_manual_language_commands": True, "physical_audio_verified": False,
        "recording_pcm_sink_test_double": bool(SETTINGS.get("headless_ui_probe")), "cases": []}
    for key, value in keys.items():
        config.conf["keyboard"][key] = value
    inputCore.decide_handleRawKey.register(_typing_on_raw_key)
    speech.pre_speechQueued.register(_typing_on_queued)
    synthDriverHandler.pre_synthSpeak.register(_typing_on_synth)
    DRIVER._planned_parts = _typing_observe_parts
    DRIVER._player.feed = _typing_on_feed
    speech.clearTypedWordBuffer()
    speech.setSpeechMode(speech.SpeechMode.talk)
    frame.Show()
    frame.Raise()
    text.SetFocus()
    later(250, lambda: _typing_wait_for_focus(time.monotonic() + 8.0))


def _typing_wait_for_focus(deadline):
    if _typing_focus_owned():
        check("actual_typing_owned_focus", "passed", hwnd_verified=True, protected=False)
        _typing_next_case()
    elif time.monotonic() >= deadline:
        check("actual_typing_owned_focus", "blocked", reason="Owned editable HWND did not receive genuine NVDA focus")
        finish()
    else:
        later(100, lambda: _typing_wait_for_focus(deadline))


def _typing_next_case():
    state = _TYPING
    if state["index"] >= len(_TYPING_CASES):
        _typing_finish_results()
        return
    language, klid, glyph = _TYPING_CASES[state["index"]]
    if not _typing_focus_owned() or synthDriverHandler.getSynth() is not DRIVER:
        check("actual_typing_keyboard_pipeline", "blocked", reason="Focus or selected synthesizer ownership changed")
        finish()
        return
    if language != state["last_language"]:
        layout = state["user"].LoadKeyboardLayoutW(klid, 0)
        if layout and layout not in state["before_layouts"] and layout not in state["loaded"]:
            state["loaded"].append(layout)
        if not layout or not state["user"].ActivateKeyboardLayout(layout, 0):
            check("actual_typing_layout", "blocked", language=language, klid=klid,
                  reason="The requested real Windows keyboard layout could not be activated")
            finish()
            return
        state["last_language"] = language
        state["text"].ChangeValue("")
        state["expected"] = ""
        import speech
        speech.clearTypedWordBuffer()
        speech.cancelSpeech()
        later(500, _typing_send_case)
    else:
        later(100, _typing_send_case)


def _typing_send_case():
    global STAGE
    import api
    import speech
    state = _TYPING
    language, klid, glyph = _TYPING_CASES[state["index"]]
    if not _typing_focus_owned():
        check("actual_typing_keyboard_pipeline", "blocked", reason="Focus changed before sending a key")
        finish()
        return
    focus = api.getFocusObject()
    layout = state["user"].GetKeyboardLayout(focus.windowThreadID)
    if not layout or int(layout) & 0xffff != {"uk": 0x0422, "en": 0x0409, "ru": 0x0419}[language]:
        check("actual_typing_layout", "blocked", language=language, reason="Focused thread did not activate the requested input language")
        finish()
        return
    mapped = state["user"].VkKeyScanExW(glyph, layout)
    if mapped == -1 or mapped >> 8:
        check("actual_typing_key_mapping", "blocked", language=language, glyph=glyph,
              reason="Initial smoke requires an unmodified key in the actual selected layout")
        finish()
        return
    vk = mapped & 0xff
    scan = state["user"].MapVirtualKeyExW(vk, 0, layout)
    if not 0 < scan < 0x100:
        raise RuntimeError("Actual typing key scan code is unavailable")
    STAGE = "typing-" + language + "-" + str(state["index"])
    row = {"language": language, "klid": klid, "actual_hkl": hex(int(layout)),
           "hkl_language_id": int(layout) & 0xffff, "glyph": glyph, "vk": vk, "scan": scan,
           "expected_control_value": state["expected"] + glyph,
           "raw_keys": [], "typed_events": [], "normal_typed_speech": [],
           "driver_sequences": [], "routes": [], "stage": STAGE}
    RESULT["actual_typing"]["cases"].append(row)
    state["active"] = row
    DONE.clear()
    DRIVER._dordiai_last_error = None
    DRIVER._dordiai_last_error_details = None
    row["send_started_ns"] = time.perf_counter_ns()
    state["pending_release"] = scan
    pair = _typing_key_pair(scan)
    sent = state["user"].SendInput(2, pair, _typing_ct.sizeof(_TypingInput))
    if sent != 2:
        row.update(status="failed", reason="SendInput did not insert both keyboard events", inserted=int(sent))
        finish()
        return
    state["pending_release"] = None
    later(50, lambda: _typing_wait_case(time.monotonic() + 8.0))


def _typing_wait_case(deadline):
    state = _TYPING
    row = state["active"]
    metrics = snapshot(row["stage"])
    first_pcm = row.get("first_typing_pcm_ns")
    complete = (state["text"].GetValue() == row["expected_control_value"] and
                row["typed_events"] and row["normal_typed_speech"] and row["driver_sequences"] and
                row["routes"] and first_pcm and DONE.is_set())
    if not complete and not getattr(DRIVER, "_dordiai_last_error", None) and time.monotonic() < deadline:
        later(50, lambda: _typing_wait_case(deadline))
        return
    row["actual_control_value"] = state["text"].GetValue()
    row["pcm_metrics"] = metrics
    row["driver_error"] = getattr(DRIVER, "_dordiai_last_error", None)
    row["effective_languages"] = sorted({part["language"] for part in row["routes"] if part.get("language")})
    row["emitted_languages"] = [part["lang"] for sequence in row["driver_sequences"] for part in sequence
                                if part.get("command") == "LangChangeCommand"]
    raw_seen = any(key["pressed"] and key["injected"] for key in row["raw_keys"])
    typed_exact = [entry["glyph"] for entry in row["typed_events"]] == [row["glyph"]]
    pcm_after_request = bool(first_pcm and first_pcm >= row.get("driver_request_ns", first_pcm + 1))
    passed = bool(complete and raw_seen and typed_exact and pcm_after_request and
                  metrics.get("nonzero_bytes", 0) > 0 and not row["driver_error"])
    row["status"] = "passed" if passed else "failed"
    row["routing_status"] = ("passed" if row["effective_languages"] == [row["language"]] else "mismatch")
    row["first_pcm_ms"] = (first_pcm - row["send_started_ns"]) / 1000000.0 if first_pcm else None
    state["expected"] = row["expected_control_value"]
    state["active"] = None
    state["index"] += 1
    later(100, _typing_next_case)


def _typing_finish_results():
    rows = RESULT["actual_typing"]["cases"]
    functional = len(rows) == len(_TYPING_CASES) and all(row["status"] == "passed" for row in rows)
    routing = functional and all(row["routing_status"] == "passed" for row in rows)
    check("actual_typing_keyboard_pipeline", "passed" if functional else "failed",
          cases=len(rows), scope="Injected real keyboard/NVDA/model/PCM functional check, not physical keyboard/acoustic latency")
    check("actual_typing_language_routes", "passed" if routing else "failed",
          mismatches=[{"language": row["language"], "glyph": row["glyph"],
                       "emitted_languages": row.get("emitted_languages"),
                       "effective_languages": row.get("effective_languages")} for row in rows
                      if row.get("routing_status") != "passed"])
    finish()


def _typing_cleanup():
    import config
    import inputCore
    import speech
    state = _TYPING
    if not state or state.get("cleaned"):
        return
    state["cleaned"] = True
    state["active"] = None
    failures = []
    def restore(action):
        try:
            action()
        except Exception as error:
            failures.append(type(error).__name__)
    if state.get("pending_release"):
        pair = _typing_key_pair(state["pending_release"])
        restore(lambda: state["user"].SendInput(1, _typing_ct.byref(pair[1]), _typing_ct.sizeof(_TypingInput)))
    restore(lambda: inputCore.decide_handleRawKey.unregister(_typing_on_raw_key))
    restore(lambda: speech.pre_speechQueued.unregister(_typing_on_queued))
    restore(lambda: synthDriverHandler.pre_synthSpeak.unregister(_typing_on_synth))
    restore(lambda: setattr(DRIVER, "_planned_parts", state["original_parts"]))
    restore(lambda: setattr(DRIVER._player, "feed", state["original_feed"]))
    restore(speech.cancelSpeech)
    restore(speech.clearTypedWordBuffer)
    for key, value in state["saved_keys"].items():
        restore(lambda key=key, value=value: config.conf["keyboard"].__setitem__(key, value))
    restore(lambda: speech.setSpeechMode(state["saved_mode"]))
    restore(lambda: state["user"].ActivateKeyboardLayout(state["original_layout"], 0))
    layout_restored = state["user"].GetKeyboardLayout(0) == state["original_layout"]
    for layout in state["loaded"]:
        try:
            if not state["user"].UnloadKeyboardLayout(layout):
                failures.append("KeyboardLayoutUnloadFailed")
        except Exception as error:
            failures.append(type(error).__name__)
    restore(state["frame"].Destroy)
    restored_config = all(config.conf["keyboard"][key] == value for key, value in state["saved_keys"].items())
    restored_mode = speech.getState().speechMode == state["saved_mode"]
    RESULT["actual_typing"]["cleanup"] = {"attempted": True, "errors": failures,
        "keyboard_config_restored": restored_config, "keyboard_layout_restored": layout_restored,
        "speech_mode_restored": restored_mode}
    check("actual_typing_cleanup", "passed" if not failures and restored_config and layout_restored and restored_mode else "failed",
          observations=RESULT["actual_typing"]["cleanup"])


_TypingBaseGlobalPlugin = GlobalPlugin
class GlobalPlugin(_TypingBaseGlobalPlugin):
    def event_typedCharacter(self, obj, nextHandler, ch):
        import api
        state = _TYPING
        row = state.get("active") if state and not state.get("cleaned") else None
        owned = row is not None and getattr(obj, "windowHandle", None) == state["text"].GetHandle()
        if owned:
            protected = api.isTypingProtected()
            if not protected:
                row["typed_events"].append({"glyph": ch, "time_ns": time.perf_counter_ns()})
            else:
                row["protected_event"] = True
            state["in_typed_handler"] = not protected
        try:
            nextHandler()
        finally:
            if owned:
                state["in_typed_handler"] = False


_TypingBaseFinish = finish
def finish():
    _typing_cleanup()
    return _TypingBaseFinish()
'''


def extend_plugin(source):
    """Append probe observers after the base plugin class; compile before use."""
    result = source + "\n" + PLUGIN_CODE
    compile(result, "isolated-real-typing-probe-plugin", "exec")
    return result


def main(argv=None):
    """Reuse the pinned isolated NVDA controller with explicit typing mode."""
    import sys
    from windows_nvda_probe import main as controller_main
    arguments = list(sys.argv[1:] if argv is None else argv)
    if "--typing-probe" not in arguments:
        arguments.append("--typing-probe")
    return controller_main(arguments)


if __name__ == "__main__":
    raise SystemExit(main())
