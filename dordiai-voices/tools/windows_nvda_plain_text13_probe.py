"""Exact historical plain-read workload with a bounded owned-focus drain.

The original content/metadata auditors remain unchanged. This wrapper never
filters titles or planned text; cancelled pre-read planners must finish before
the intentional read and its observer become active.
"""
from hashlib import sha1
import importlib.util
from pathlib import Path

BASE_BLOB = "3db4eadd4b1b9bc029d33a3272b8f083dcfcbb79"

BOUNDARY_CODE = r'''
def _plain_boundary_activity(kind):
    state = _PLAIN
    if not state or state.get("cleaned"):
        return
    with state["boundary_lock"]:
        state["boundary_serial"] += 1
        state["boundary_last_ns"] = time.perf_counter_ns()


def _plain_start_read_boundary():
    import speech
    state = _PLAIN
    state["active"] = None
    row = state["next_row"]
    row["pre_read_quiescence"] = {"scope": "Owned focus announcements cancelled before intentional read; no audio warmup or text filtering",
                                  "samples": [], "cancel_calls": 0, "passed": False}
    state["boundary_deadline"] = time.monotonic() + 30.0
    state["boundary_stable"] = 0
    state["boundary_last_cancel_serial"] = -1
    _plain_wait_read_boundary()


def _plain_wait_read_boundary():
    import speech
    state = _PLAIN
    row = state["next_row"]
    evidence = row["pre_read_quiescence"]
    if not _plain_focus_owned() or synthDriverHandler.getSynth() is not DRIVER:
        raise RuntimeError("Owned focus or selected synth changed while draining pre-read announcements")
    with state["boundary_lock"]:
        serial = state["boundary_serial"]
        planners = state["boundary_planners"]
        quiet_ms = (time.perf_counter_ns() - state["boundary_last_ns"]) / 1000000
    if serial != state["boundary_last_cancel_serial"]:
        # Genuine public cancellation, including any late-arriving focus event.
        # Nothing is deleted from the read workload or its strict route auditor.
        speech.cancelSpeech()
        state["boundary_last_cancel_serial"] = serial
        evidence["cancel_calls"] += 1
        state["boundary_stable"] = 0
    sample = {"active_planners": planners, "queued_driver_jobs": DRIVER._jobs.qsize(),
              "nvda_is_speaking": bool(speech.isSpeaking()), "quiet_ms": quiet_ms,
              "activity_serial": serial, "generation": DRIVER._generation}
    if len(evidence["samples"]) < 512:
        evidence["samples"].append(sample)
    ready = planners == 0 and sample["queued_driver_jobs"] == 0 and not sample["nvda_is_speaking"] and quiet_ms >= 250
    state["boundary_stable"] = state["boundary_stable"] + 1 if ready else 0
    if state["boundary_stable"] >= 2:
        evidence["passed"] = True
        evidence["observer_active_before_read"] = state["active"] is not None
        evidence["completed_ns"] = time.perf_counter_ns()
        return _plain_read_current_line()
    if time.monotonic() >= state["boundary_deadline"]:
        raise TimeoutError("Cancelled pre-read focus planners did not quiesce before the bounded read")
    later(100, _plain_wait_read_boundary)
'''

OBSERVER_CODE = r'''def _plain_observe_parts(*args, **kwargs):
    state = _PLAIN
    with state["boundary_lock"]:
        state["boundary_planners"] += 1
    _plain_boundary_activity("planner-start")
    source = None
    try:
        source = state["original_parts"](*args, **kwargs)
        for part in source:
            kind, value = part
            row = _plain_current()
            if row is not None and kind in {"text", "character"} and isinstance(value, dict):
                row["planned_routes"].append({key: value.get(key) for key in
                                             ("text", "language", "profile", "character")})
            yield part
    finally:
        try:
            close = getattr(source, "close", None)
            if close is not None:
                close()
        finally:
            with state["boundary_lock"]:
                state["boundary_planners"] -= 1
            _plain_boundary_activity("planner-stop")
'''


def extend_boundary(source):
    import ast
    tree = ast.parse(source)
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_plain_observe_parts")
    lines = source.splitlines(keepends=True)
    source = "".join(lines[:function.lineno-1]) + OBSERVER_CODE + "\n" + "".join(lines[function.end_lineno:])
    anchors = {
        '    later(400, _plain_read_current_line)\n': '    later(400, _plain_start_read_boundary)\n',
        '        "original_parts": DRIVER._planned_parts,':
            '        "boundary_lock": threading.Lock(), "boundary_serial": 0, "boundary_planners": 0,\n'
            '        "boundary_last_ns": time.perf_counter_ns(), "original_parts": DRIVER._planned_parts,',
        'def _plain_on_pre_speech(speechSequence, originalSpeechSequence=None, **kwargs):\n':
            'def _plain_on_pre_speech(speechSequence, originalSpeechSequence=None, **kwargs):\n    _plain_boundary_activity("pre-speech")\n',
        'def _plain_on_queued(speechSequence, priority):\n':
            'def _plain_on_queued(speechSequence, priority):\n    _plain_boundary_activity("queued")\n',
        'def _plain_on_synth(speechSequence):\n':
            'def _plain_on_synth(speechSequence):\n    _plain_boundary_activity("driver-request")\n',
    }
    for old, new in anchors.items():
        if source.count(old) != 1:
            raise ValueError("Historical plain probe boundary anchor differs")
        source = source.replace(old, new, 1)
    result = source + "\n" + BOUNDARY_CODE
    compile(result, "owned-plain13-boundary", "exec")
    return result


def main(argv=None):
    path = Path(__file__).with_name("windows_nvda_plain_text_probe.py")
    raw = path.read_bytes()
    if sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest() != BASE_BLOB:
        raise ValueError("Historical plain workload/auditor bytes changed")
    spec = importlib.util.spec_from_file_location("_source13_unchanged_plain_workload", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.PLUGIN_CODE = extend_boundary(module.PLUGIN_CODE)
    return module.main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
