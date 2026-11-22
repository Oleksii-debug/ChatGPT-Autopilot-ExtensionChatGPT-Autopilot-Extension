"""Pure validation/arithmetic for a proposed own-process clock experiment.

This module creates no device/client/process and cannot start audio. Passing a
synthetic contract test is not evidence of a real hardware clock or NVDA audio.
"""
from __future__ import annotations

import re

HNS_PER_SECOND = 10_000_000
TIMESTAMP_ERROR = 4
DATA_DISCONTINUITY = 1


def uint(value):
    if type(value) is not int or not 0 <= value < 2 ** 64:
        raise ValueError("Expected a real unsigned 64-bit integer")
    return value


def qpc_to_hns(raw_ticks, frequency):
    """Raw QPC ticks ->100ns; API-returned QPC values must NOT pass here twice."""
    uint(raw_ticks)
    if uint(frequency) == 0:
        raise ValueError("Zero QPC frequency")
    return raw_ticks * HNS_PER_SECOND // frequency


def seconds_from_position(position, device_frequency):
    uint(position)
    if uint(device_frequency) == 0:
        raise ValueError("Zero IAudioClock frequency")
    return position / device_frequency


def assess_render_clock(readings, frequency):
    """Keep original order and raw results; reject unavailable/inaccurate axes."""
    if uint(frequency) == 0:
        raise ValueError("Zero IAudioClock frequency")
    rows = list(readings)
    valid = []
    for row in rows:
        if set(row) != {"hresult", "position", "qpc_hns"} or type(row["hresult"]) is not int:
            raise ValueError("Bounded exact clock observation schema required")
        uint(row["position"])
        uint(row["qpc_hns"])
        if row["hresult"] == 0:  # S_OK only; S_FALSE remains in raw rows.
            valid.append(row)
    reason = None
    if len(valid) < 2:
        reason = "fewer_than_two_S_OK_readings"
    elif any(b["position"] < a["position"] or b["qpc_hns"] < a["qpc_hns"] for a, b in zip(valid, valid[1:])):
        reason = "position_or_qpc_moved_backwards"
    elif valid[-1]["position"] == valid[0]["position"]:
        reason = "no_real_device_clock_progress"
    elif valid[-1]["qpc_hns"] == valid[0]["qpc_hns"]:
        reason = "no_correlated_qpc_progress"
    result = {"clock_axis_available": reason is None, "reason": reason,
              "frequency_device_units_per_second": frequency, "raw_readings": rows,
              "accurate_readings": len(valid), "physical_audio_verified": False,
              "actual_NVDA_verified": False}
    if reason is None:
        result["position_delta_seconds"] = (valid[-1]["position"] - valid[0]["position"]) / frequency
        result["qpc_delta_seconds"] = (valid[-1]["qpc_hns"] - valid[0]["qpc_hns"]) / HNS_PER_SECOND
        result["delta_difference_seconds"] = result["position_delta_seconds"] - result["qpc_delta_seconds"]
    return result


def assess_capture_positions(packets):
    """Never substitute a software frame counter for absent packet positions."""
    rows = list(packets)
    for row in rows:
        if set(row) != {"frames", "flags", "device_position_frames", "qpc_hns"}:
            raise ValueError("Exact packet clock schema required")
        for value in row.values():
            uint(value)
    valid = [row for row in rows if row["frames"] and not row["flags"] & (TIMESTAMP_ERROR | DATA_DISCONTINUITY)]
    progresses = (len(valid) >= 2 and valid[-1]["device_position_frames"] > valid[0]["device_position_frames"]
                  and valid[-1]["qpc_hns"] > valid[0]["qpc_hns"]
                  and all(b["device_position_frames"] >= a["device_position_frames"]
                          and b["qpc_hns"] >= a["qpc_hns"] for a, b in zip(valid, valid[1:])))
    return {"capture_position_axis_available": bool(progresses), "raw_packets": rows,
            "timestamp_error_packets": sum(bool(row["flags"] & TIMESTAMP_ERROR) for row in rows),
            "software_frame_counter_substituted": False, "render_clock_axis_substituted": False}


def validate_proposed_request(request, *, parent_observed_child_pid, expected_nonce, expected_endpoint_id, expected_executable_sha256):
    """Design-stage parent binding; no run mode or arbitrary target PID exists."""
    keys = {"format", "mode", "nonce", "expected_executable_sha256", "render_endpoint_id",
            "maximum_capture_ms", "marker_duration_ms", "marker_peak"}
    if set(request) != keys or request["format"] != "dordiai-owned-clock-design-v1" or request["mode"] != "self-test":
        raise ValueError("Only the no-device self-test design is executable before root review")
    if type(parent_observed_child_pid) is not int or parent_observed_child_pid <= 0:
        raise ValueError("Exact parent-observed own child PID required")
    if not re.fullmatch(r"[0-9a-f]{32}", expected_nonce) or request["nonce"] != expected_nonce:
        raise ValueError("Run nonce differs")
    if (not re.fullmatch(r"[0-9a-f]{64}", expected_executable_sha256)
            or request["expected_executable_sha256"] != expected_executable_sha256):
        raise ValueError("Reviewed executable SHA differs")
    if request["render_endpoint_id"] != expected_endpoint_id or not re.fullmatch(r"\{0\.0\.0\.00000000\}\.\{[0-9a-f-]{36}\}", expected_endpoint_id):
        raise ValueError("Explicit inventoried render endpoint differs")
    if (type(request["maximum_capture_ms"]) is not int or request["maximum_capture_ms"] != 1500
            or type(request["marker_duration_ms"]) is not int or request["marker_duration_ms"] != 100
            or type(request["marker_peak"]) not in (int, float) or request["marker_peak"] != .03):
        raise ValueError("Only the bounded design marker contract is allowed")
    return {"validated_design_only": True, "parent_observed_child_pid": parent_observed_child_pid,
            "audio_api_called": False, "actual_run_implemented": False}


def assess_native_receipt(report, *, child_pid, process_start_filetime, nonce, executable_sha256, endpoint_id, native_format_hex):
    """Assess a future owned native receipt without ever running the helper."""
    if (report.get("format") != "dordiai-owned-hardware-clock-transport"
            or report.get("status") != "own-marker-transport-complete-clock-quality-not-yet-accepted"
            or report.get("current_pid") != child_pid or report.get("target_pid") != child_pid
            or report.get("process_start_filetime") != process_start_filetime
            or report.get("nonce") != nonce or report.get("executable_sha256") != executable_sha256
            or report.get("selected_endpoint", {}).get("id") != endpoint_id
            or report.get("native_format", {}).get("raw_format_hex") != native_format_hex
            or report.get("capture_mode") != "process-include-current-pid"
            or report.get("children_created") is not False or report.get("child_processes_created") is not False
            or report.get("requested_exclude_mode") is not False or report.get("timestamps_replaced_or_improved") is not False
            or report.get("all_own_com_interfaces_released") is not True
            or report.get("async_callback_completed") is not True
            or report.get("physical_audio_verified") is not False or report.get("product_ready") is not False):
        raise ValueError("Exact own-process native transport receipt required")
    for key in ("nonce", "executable_sha256"):
        if not re.fullmatch(r"[0-9a-f]{" + ("32" if key == "nonce" else "64") + r"}", report[key]):
            raise ValueError("Noncanonical receipt identity")
    rows = report.get("render_clock_readings")
    packets = report.get("packets")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 4096 or not isinstance(packets, list) or not 1 <= len(packets) <= 4096:
        raise ValueError("Bounded nonempty native timing observations required")
    clock_rows = []
    for row in rows:
        if not re.fullmatch(r"0x[0-9a-f]{8}", row.get("hresult", "")):
            raise ValueError("Exact native clock HRESULT required")
        if uint(row["qpc_before_ticks"]) > uint(row["qpc_after_ticks"]):
            raise ValueError("Clock call QPC order invalid")
        clock_rows.append({"hresult": int(row["hresult"], 16), "position": row["position_device_units"], "qpc_hns": row["api_qpc_100ns"]})
    capture_rows = [{"frames": row["frames"], "flags": row["flags"], "device_position_frames": row["device_position_frames"],
                     "qpc_hns": row["api_qpc_100ns"]} for row in packets]
    render_axis = assess_render_clock(clock_rows, report["render_clock_frequency_device_units_per_second"])
    capture_axis = assess_capture_positions(capture_rows)
    latency = uint(report["render_maximum_stream_latency_100ns"])
    return {"ownership_receipt_validated": True, "render_clock": render_axis, "capture_clock": capture_axis,
            "render_maximum_stream_latency_ms": latency / 10_000,
            "maximum_latency_is_measured_audible_onset": False,
            "physical_audio_verified": False, "actual_NVDA_verified": False, "product_ready": False}
