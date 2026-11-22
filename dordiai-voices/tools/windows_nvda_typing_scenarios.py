"""Additional isolated real-key scenarios and passive utterance diagnostics.

All changes run inside the owned probe add-on. Product source, NVDA timers,
speech sequences and normal editing/typing handlers are unchanged.
"""
PLUGIN_CODE = r'''
_SCENARIO_ORIGINAL_CASES = _TYPING_CASES
_ScenarioBaseStart = start_actual_typing_probe
_ScenarioBaseSend = _typing_send_case
_ScenarioBaseWait = _typing_wait_case
_ScenarioBaseFinishResults = _typing_finish_results
_ScenarioBaseCleanup = _typing_cleanup
_ScenarioBaseQueued = _typing_on_queued
_ScenarioBaseSynth = _typing_on_synth
_ScenarioBaseFeed = _typing_on_feed
_ScenarioBaseParts = _typing_observe_parts


def _scenario_name():
    return SETTINGS.get("typing_scenario", "standard")


def _scenario_row():
    state = _TYPING
    return state.get("active") if state and not state.get("cleaned") else None


def _scenario_observable(row):
    return bool(row and (row.get("typed_events") or row.get("action")))


def _scenario_indices(sequence):
    return [int(item.index) for item in sequence
            if type(item).__name__ == "IndexCommand" and isinstance(getattr(item, "index", None), int)]


def _typing_on_queued(speechSequence, priority):
    row = _scenario_row()
    if not row:
        return _ScenarioBaseQueued(speechSequence, priority)
    before = len(row["normal_typed_speech"])
    _ScenarioBaseQueued(speechSequence, priority)
    if row.get("action") and _typing_focus_owned() and len(row["normal_typed_speech"]) == before:
        row["normal_typed_speech"].append(_typing_sequence(speechSequence))
    if len(row["normal_typed_speech"]) > before:
        row.setdefault("queued_utterances", []).append({
            "queued_ns": time.perf_counter_ns(), "priority": int(priority),
            "sequence": row["normal_typed_speech"][-1]})


def _typing_on_synth(speechSequence):
    row = _scenario_row()
    before = len(row["driver_sequences"]) if row else 0
    _ScenarioBaseSynth(speechSequence)
    if not _scenario_observable(row) or synthDriverHandler.getSynth() is not DRIVER:
        return
    if row.get("action") and _typing_focus_owned() and len(row["driver_sequences"]) == before:
        row["driver_sequences"].append(_typing_sequence(speechSequence))
    if len(row["driver_sequences"]) == before:
        return
    now = time.perf_counter_ns()
    row.setdefault("driver_request_ns", now)
    utterances = row.setdefault("driver_utterances", [])
    if len(utterances) >= 16:
        row["utterance_observer_overflow"] = True
        return
    indices = _scenario_indices(speechSequence)
    utterances.append({"ordinal": len(utterances), "notified_ns": now,
        "sequence": row["driver_sequences"][-1], "indices": indices,
        "remaining_index_submissions": len(indices), "planned_parts": [],
        "pcm_bytes": 0, "nonzero_chunks": 0,
        "boundary_scope": "existing driver IndexCommand onDone feed SUBMISSION, not played-audio completion"})


def _typing_observe_parts(*args, **kwargs):
    source = _ScenarioBaseParts(*args, **kwargs)
    sequence = args[0] if args else kwargs.get("sequence", ())
    indices = _scenario_indices(sequence)
    try:
        for part in source:
            kind, value = part
            row = _scenario_row()
            if _scenario_observable(row) and kind in {"text", "character"} and isinstance(value, dict):
                route = {key: value.get(key) for key in ("language", "profile", "character", "text")}
                if row.get("action") and not row.get("typed_events"):
                    row["routes"].append(route)
                for utterance in row.get("driver_utterances", []):
                    if indices and utterance["indices"] == indices:
                        if len(utterance["planned_parts"]) < 32:
                            utterance["planned_parts"].append(dict(route, planned_ns=time.perf_counter_ns()))
                        else:
                            row["utterance_observer_overflow"] = True
                        break
            yield part
    finally:
        close = getattr(source, "close", None)
        if close is not None:
            close()


def _typing_on_feed(data, *args, **kwargs):
    row = _scenario_row()
    submitted = time.perf_counter_ns()
    target = None
    if _scenario_observable(row):
        target = next((item for item in row.get("driver_utterances", [])
                       if "submission_closed_ns" not in item), None)
        # The real driver submits an existing index with a silent onDone feed.
        # Advance the observer BEFORE calling the original feed: a headless
        # sink may immediately deliver onDone and enqueue the next utterance.
        if target is not None and callable(kwargs.get("onDone")):
            target["remaining_index_submissions"] -= 1
            if target["remaining_index_submissions"] <= 0:
                target["submission_closed_ns"] = submitted
    try:
        result = _ScenarioBaseFeed(data, *args, **kwargs)
    except Exception as error:
        if target is not None:
            target["feed_error"] = type(error).__name__
        raise
    if target is not None and isinstance(data, (bytes, bytearray, memoryview)):
        target["pcm_bytes"] += len(data)
        if any(data):
            target.setdefault("first_pcm_submission_ns", submitted)
            target["last_pcm_submission_ns"] = submitted
            target["nonzero_chunks"] += 1
            target["driver_to_first_pcm_ms"] = (
                target["first_pcm_submission_ns"] - target["notified_ns"]) / 1000000.0
            if row.get("action"):
                row.setdefault("first_typing_pcm_ns", submitted)
    return result


def _scenario_save_preferences():
    import copy
    import config
    enabled_voices = [code for code in DRIVER._dordiai_all_voices()
                      if code not in DRIVER._dordiai_selection[0]]
    return {"voices": enabled_voices, "languages": list(DRIVER._dordiai_enabled_languages),
        "default": DRIVER._dordiai_selection[2], "selected_voice": DRIVER.voice,
        "mode": DRIVER._dordiai_mode, "voice_map": dict(DRIVER._dordiai_voice_map),
        "config": copy.deepcopy(dict(config.conf["speech"][DRIVER.name]))}


def _scenario_restore_preferences():
    import config
    state = _TYPING
    saved = state.get("saved_preferences")
    if not saved:
        return
    if synthDriverHandler.getSynth() is not DRIVER:
        raise RuntimeError("Selected synthesizer changed before preference restoration")
    DRIVER._dordiai_apply(saved["voices"], saved["languages"], saved["default"],
                         saved["selected_voice"], {}, mode=saved["mode"], voice_map=saved["voice_map"])
    section = config.conf["speech"][DRIVER.name]
    for key in list(section):
        if key not in saved["config"]:
            del section[key]
    for key, value in saved["config"].items():
        section[key] = value
    restored = (DRIVER._dordiai_mode == saved["mode"] and
                DRIVER._dordiai_enabled_languages == frozenset(saved["languages"]) and
                DRIVER._dordiai_selection[2] == saved["default"] and
                DRIVER.voice == saved["selected_voice"] and
                DRIVER._dordiai_voice_map == saved["voice_map"] and dict(section) == saved["config"])
    RESULT["actual_typing"]["preference_restoration"] = {"restored": restored}
    if not restored:
        raise RuntimeError("Real driver preferences were not restored")


def start_actual_typing_probe():
    global _TYPING_CASES
    scenario = _scenario_name()
    SETTINGS["typing_words"] = 0 if scenario == "characters-only" else 1
    if scenario == "navigation":
        _TYPING_CASES = (("uk", "00000422", "б"), ("uk", "00000422", "ї"))
    elif scenario in {"forced-uk", "disabled-ru"}:
        _TYPING_CASES = (("ru", "00000419", "а"),)
    else:
        _TYPING_CASES = _SCENARIO_ORIGINAL_CASES
    _ScenarioBaseStart()
    state = _TYPING
    if not state or state.get("cleaned"):
        return
    RESULT["actual_typing"]["scenario"] = scenario
    RESULT["actual_typing"]["observer_scope"] = (
        "passive uncalibrated queued/driver/planner/index-feed timestamps; no physical acoustic claim")
    if scenario in {"forced-uk", "disabled-ru"}:
        import speech
        speech.cancelSpeech()
        saved = _scenario_save_preferences()
        state["saved_preferences"] = saved
        languages = saved["languages"] if scenario == "forced-uk" else [
            code for code in saved["languages"] if code != "ru"]
        if "uk" not in languages:
            raise RuntimeError("The real preference scenario requires installed enabled Ukrainian")
        voice_map = {key: value for key, value in saved["voice_map"].items() if key in languages}
        DRIVER._dordiai_apply(saved["voices"], languages, "uk", saved["selected_voice"], {},
            mode="forced" if scenario == "forced-uk" else "auto", voice_map=voice_map)
        RESULT["actual_typing"]["preference_application"] = {
            "api": "actual PreferencesMixin._dordiai_apply (same settings-dialog API)",
            "mode": DRIVER._dordiai_mode, "enabled_languages": sorted(DRIVER._dordiai_enabled_languages),
            "default_language": DRIVER._dordiai_selection[2], "expected_route": "uk"}


def _typing_send_case():
    _ScenarioBaseSend()
    row = _scenario_row()
    if row is None:
        return
    if _scenario_name() in {"forced-uk", "disabled-ru"}:
        row["expected_language"] = "uk"
    if _scenario_name() == "characters-only" and "expected_word_echo" in row:
        row["word_echo_must_be_absent"] = row.pop("expected_word_echo")


def _typing_wait_case(deadline):
    row = _scenario_row()
    _ScenarioBaseWait(deadline)
    if row is not None and row.get("status") and "word_echo_must_be_absent" in row:
        labels = [item["text"].strip() for sequence in row["normal_typed_speech"]
                  for item in sequence if "text" in item]
        absent = row["word_echo_must_be_absent"] not in labels
        row["word_echo_matches"] = absent
        if not absent:
            row["status"], row["routing_status"] = "failed", "mismatch"
            row["unexpected_native_word_echo"] = True


def _scenario_check_utterance_observer():
    documents = RESULT["actual_typing"]
    rows = documents["cases"] + documents.get("navigation_cases", [])
    errors = []
    for row in rows:
        if row.get("status") == "passed" and not row.get("driver_utterances"):
            errors.append({"glyph": row["glyph"], "reason": "no observed driver utterance"})
        if row.get("utterance_observer_overflow"):
            errors.append({"glyph": row["glyph"], "reason": "bounded observer quota exceeded"})
        for item in row.get("driver_utterances", []):
            audible = any(part.get("text", "").strip() for part in item["sequence"])
            if not item["indices"] or "submission_closed_ns" not in item or item.get("feed_error"):
                errors.append({"glyph": row["glyph"], "utterance": item["ordinal"],
                               "reason": "existing index feed boundary unresolved"})
            elif audible and not item.get("first_pcm_submission_ns"):
                errors.append({"glyph": row["glyph"], "utterance": item["ordinal"],
                               "reason": "spoken request had no nonzero PCM submission"})
    check("actual_typing_utterance_observation", "passed" if not errors else "failed",
          scope="existing index feed submission boundaries, never physical playback", errors=errors)


def _typing_finish_results():
    if _scenario_name() == "navigation":
        rows = RESULT["actual_typing"]["cases"]
        valid = len(rows) == 2 and all(row["status"] == "passed" and row["routing_status"] == "passed" for row in rows)
        check("actual_typing_navigation_seed", "passed" if valid else "failed",
              scope="two actual Ukrainian keys seed the real editable document")
        if valid:
            _scenario_start_navigation()
        else:
            finish()
        return
    _scenario_check_utterance_observer()
    return _ScenarioBaseFinishResults()


def _scenario_start_navigation():
    import speech
    state = _TYPING
    if not _typing_focus_owned() or state["text"].GetValue() != "бї" or state["text"].GetInsertionPoint() != 2:
        check("actual_typing_navigation_setup", "blocked", reason="Real UK seed/caret/focus differs")
        finish()
        return
    layout = state["user"].LoadKeyboardLayoutW("00000419", 0)
    if layout and layout not in state["before_layouts"] and layout not in state["loaded"]:
        state["loaded"].append(layout)
    if not layout or not state["user"].ActivateKeyboardLayout(layout, 0):
        check("actual_typing_navigation_setup", "blocked", reason="Could not activate real RU input layout")
        finish()
        return
    state["navigation_index"] = 0
    RESULT["actual_typing"]["navigation_cases"] = []
    speech.cancelSpeech()
    speech.clearTypedWordBuffer()
    later(500, _scenario_send_navigation)


def _scenario_send_navigation():
    global STAGE
    import speech
    state = _TYPING
    actions = (("Backspace", 0x08, 0x0e, False, "б", 1, "ї"),
               ("LeftArrow", 0x25, 0x4b, True, "б", 0, "бе"))
    position = state["navigation_index"]
    if position >= len(actions):
        rows = RESULT["actual_typing"]["navigation_cases"]
        valid = len(rows) == 2 and all(row["status"] == "passed" for row in rows)
        check("actual_typing_navigation_no_hkl_leak", "passed" if valid else "failed",
            scope="real Backspace/extended LeftArrow on UK text while RU keyboard is active",
            cases=[{key:row.get(key) for key in ("action","status","emitted_languages","effective_languages",
                    "expected_label","actual_control_value","actual_insertion_point")} for row in rows])
        _scenario_check_utterance_observer()
        finish()
        return
    if not _typing_focus_owned() or speech.isSpeaking() or synthDriverHandler.getSynth() is not DRIVER:
        check("actual_typing_navigation_setup", "blocked", reason="Owned focus/driver/quiescence changed")
        finish()
        return
    focus = __import__("api").getFocusObject()
    layout = state["user"].GetKeyboardLayout(focus.windowThreadID)
    if int(layout or 0) & 0xffff != 0x0419:
        check("actual_typing_navigation_setup", "blocked", reason="Navigation did not retain real RU keyboard")
        finish()
        return
    action, vk, scan, extended, expected_text, caret, label = actions[position]
    STAGE = "navigation-" + action
    row = {"action":action, "glyph":"<"+action+">", "language":"uk", "input_language":"ru",
        "actual_hkl":hex(int(layout)), "vk":vk, "scan":scan, "extended":extended,
        "raw_keys":[], "typed_events":[], "normal_typed_speech":[], "driver_sequences":[], "routes":[],
        "stage":STAGE, "expected_control_value":expected_text, "expected_insertion_point":caret,
        "expected_label":label, "send_started_ns":time.perf_counter_ns()}
    RESULT["actual_typing"]["navigation_cases"].append(row)
    state["active"] = row
    DONE.clear()
    DRIVER._dordiai_last_error = None
    events = _typing_key_events(scan, extended=extended)
    sent = state["user"].SendInput(len(events), events, _typing_ct.sizeof(_TypingInput))
    state["pending_releases"] = _typing_pending_keys(events, int(sent))
    row["inserted_key_events"] = int(sent)
    if sent != len(events):
        row.update(status="failed", reason="Navigation SendInput did not insert both balanced events")
        finish()
        return
    later(50, lambda: _scenario_wait_navigation(time.monotonic()+8.0))


def _scenario_wait_navigation(deadline):
    import speech
    row, state = _scenario_row(), _TYPING
    if row is None:
        return
    complete = (state["text"].GetValue() == row["expected_control_value"] and
        state["text"].GetInsertionPoint() == row["expected_insertion_point"] and
        row["normal_typed_speech"] and row["driver_sequences"] and row["routes"] and
        row.get("first_typing_pcm_ns") and DONE.is_set() and not speech.isSpeaking())
    if not complete and not getattr(DRIVER, "_dordiai_last_error", None) and time.monotonic() < deadline:
        later(50, lambda:_scenario_wait_navigation(deadline))
        return
    row["actual_control_value"] = state["text"].GetValue()
    row["actual_insertion_point"] = state["text"].GetInsertionPoint()
    row["emitted_languages"] = [part["lang"] for sequence in row["driver_sequences"] for part in sequence
                               if part.get("command") == "LangChangeCommand"]
    row["effective_languages"] = sorted({part["language"] for part in row["routes"] if part.get("language")})
    raw = any(key["pressed"] and key["injected"] and key["vk"] == row["vk"] and
              key.get("extended") == row["extended"] for key in row["raw_keys"])
    labels = [part.get("text","").strip() for part in row["routes"]]
    unexpected_typed = any(event["glyph"].isprintable() for event in row["typed_events"])
    row["status"] = ("passed" if complete and raw and not unexpected_typed and
        _typing_route_matches("uk",row["effective_languages"]) and
        _typing_route_matches("uk",[language for language in row["emitted_languages"] if language]) and
        row["expected_label"] in labels
        and not getattr(DRIVER,"_dordiai_last_error",None) else "failed")
    row["first_pcm_ms"] = ((row["first_typing_pcm_ns"]-row["send_started_ns"])/1000000.0
                           if row.get("first_typing_pcm_ns") else None)
    state["active"] = None
    state["navigation_index"] += 1
    later(150,_scenario_send_navigation)


def _typing_cleanup():
    state = _TYPING
    if state and not state.get("cleaned") and state.get("saved_preferences"):
        try:
            _scenario_restore_preferences()
        except Exception as error:
            RESULT["actual_typing"]["preference_restoration"] = {
                "restored":False,"error":type(error).__name__}
        check("actual_typing_preferences_restored",
            "passed" if RESULT["actual_typing"]["preference_restoration"]["restored"] else "failed",
            receipt=RESULT["actual_typing"]["preference_restoration"])
    return _ScenarioBaseCleanup()
'''
