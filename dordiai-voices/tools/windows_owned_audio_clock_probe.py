"""Pinned CI artifact -> exact owned Windows child -> marker/clock evidence.

Describe mode opens no streams. Run mode requires previously reviewed exact
native-format bytes. No arbitrary PID/device, system capture, default/volume
mutation, downloads, installations or NVDA access exist in this controller.
"""
from __future__ import annotations

import argparse
import ctypes as ct
from ctypes import wintypes as wt
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from queue import Empty, Queue
import re
import secrets
import struct
import subprocess
import sys
from threading import Thread
import time
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PINS = {"repository": "Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension",
        "commit": "c2fb3b9c3336e62acb3c6400f133115e55fbb928", "run_id": "45066502844",
        "artifact_id": 14771417822, "artifact_bytes": 250008,
        "artifact_sha256": "9c4f17d96b128c1ea1998e920170388a4d1207193a1f342f3868882631900fbd",
        "source_sha256": "dea9c3c9e54b09ec9622400f8448ec9b2ee478c7cdc366109cd5e8d878edbbac",
        "frozen_source_sha256": "eba7fd78469298b7c4c300fdd80c9da18ffb1d03323c8b72230d92ff59448012"}
USB_ENDPOINT = "{0.0.0.00000000}.{fc1f7846-3543-4cff-aaee-de24d7de09b4}"
OWNED_ROOT = Path("D:/DordiaiTestTemp")
MEMBERS = {"owned-clock.exe", "windows_owned_audio_clock.cpp", "windows_process_loopback.cpp",
           "build.log", "self-test.json", "build-receipt.json"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def no_links(path):
    path = Path(path).absolute()
    for item in (path, *path.parents):
        if item.is_symlink() or getattr(item, "is_junction", lambda: False)():
            raise ValueError("Linked/reparse owned paths forbidden")
        try:
            if getattr(item.lstat(), "st_file_attributes", 0) & 0x400:
                raise ValueError("Any Windows reparse ancestor is forbidden")
        except FileNotFoundError:
            pass
    return path


def load_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw.decode("utf-8-sig"), object_pairs_hook=unique)


def verify_artifact(path, *, pins=None, repo=None):
    """No extraction/EXE execution; exact authenticated artifact pins come first."""
    pins = PINS if pins is None else pins
    repo = ROOT if repo is None else Path(repo)
    path = no_links(path)
    if not path.is_file() or path.stat().st_size != pins["artifact_bytes"]:
        raise ValueError("Pinned complete artifact ZIP size differs")
    raw = path.read_bytes()
    if sha(raw) != pins["artifact_sha256"]:
        raise ValueError("Pinned artifact ZIP SHA differs")
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) != len(MEMBERS) or {info.filename for info in infos} != MEMBERS:
            raise ValueError("Exact complete six-member artifact required")
        for info in infos:
            if (info.orig_filename != info.filename or info.filename not in MEMBERS
                    or info.is_dir() or info.flag_bits & 1 or not 0 < info.file_size <= 16 * 1024 * 1024
                    or ((info.external_attr >> 16) & 0o170000) not in (0, 0o100000)):
                raise ValueError("Unsafe/unbounded artifact member")
        data = {info.filename: archive.read(info) for info in infos}
    receipt = load_json(data["build-receipt.json"])
    expected_workflow = pins["repository"] + "/.github/workflows/dordiai-owned-clock-build.yml@refs/heads/dordiai-voices/audit-20261122"
    expected = {"format": "dordiai-owned-hardware-clock-build", "format_version": 1,
                "repository": pins["repository"], "commit": pins["commit"], "run_id": pins["run_id"],
                "workflow_ref": expected_workflow, "source_sha256": pins["source_sha256"],
                "frozen_source_sha256": pins["frozen_source_sha256"], "runner_os": "Windows", "runner_arch": "X64",
                "helper_executed": True, "helper_execution_mode": "--self-test-only-no-devices",
                "audio_api_called": False, "drivers_installed": False, "dependencies_installed": False, "product_ready": False}
    if any(receipt.get(key) != value or type(receipt.get(key)) is not type(value) for key, value in expected.items()):
        raise ValueError("Pinned trusted CI build receipt differs")
    if not re.fullmatch(r"[1-9][0-9]*", str(receipt.get("run_attempt", ""))) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){3}", receipt.get("sdk_version", "")):
        raise ValueError("Exact CI attempt/SDK metadata required")
    for name in ("compiler", "linker", "vswhere"):
        tool = receipt.get(name, {})
        if (tool.get("signature_status") != "Valid" or "O=Microsoft Corporation" not in tool.get("signer_subject", "")
                or not re.fullmatch(r"[0-9a-f]{64}", tool.get("sha256", ""))
                or not re.fullmatch(r"[0-9a-fA-F]{40}", tool.get("signer_thumbprint", "")) or not tool.get("file_version")):
            raise ValueError("Trusted installed Microsoft compiler/linker/locator provenance missing")
    inventory = receipt.get("files", {})
    if set(inventory) != MEMBERS - {"build-receipt.json"}:
        raise ValueError("Complete exact artifact file inventory required")
    for name, row in inventory.items():
        if type(row.get("size_bytes")) is not int or row["size_bytes"] != len(data[name]) or row.get("sha256") != sha(data[name]):
            raise ValueError("Artifact member SHA/size differs: " + name)
    for name, pin in (("windows_owned_audio_clock.cpp", "source_sha256"), ("windows_process_loopback.cpp", "frozen_source_sha256")):
        if sha(data[name]) != pins[pin] or (repo / "tools" / name).read_bytes() != data[name]:
            raise ValueError("Artifact source differs from reviewed repository bytes")
    selftest = load_json(data["self-test.json"])
    if selftest != receipt.get("native_selftest") or selftest.get("status") != "self-test-passed" or selftest.get("frozen_source_sha256") != pins["frozen_source_sha256"]:
        raise ValueError("Exact executed native self-test receipt required")
    if any(selftest.get(key) is not False for key in ("audio_device_api_called", "render_started", "capture_started", "children_created", "product_ready")):
        raise ValueError("CI self-test must have no device/audio execution")
    return data, receipt


def parse_format(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{36,1060}", value) or len(value) % 2:
        raise ValueError("Canonical bounded expected native-format hex required")
    raw = bytes.fromhex(value)
    tag, channels, rate, average, align, bits, extra = struct.unpack("<HHIIHHH", raw[:18])
    if len(raw) != 18 + extra or extra > 512:
        raise ValueError("Native-format byte size differs")
    kind = tag
    if tag == 0xFFFE:
        if extra < 22:
            raise ValueError("Short extensible format")
        valid_bits = struct.unpack("<H", raw[18:20])[0]
        subtype = str(uuid.UUID(bytes_le=raw[24:40]))
        kind = {"00000001-0000-0010-8000-00aa00389b71": 1, "00000003-0000-0010-8000-00aa00389b71": 3}.get(subtype, 0)
        if valid_bits not in (0, bits):
            raise ValueError("Unsupported native valid bits")
    if (channels != 2 or not 8000 <= rate <= 192000 or (kind, bits) not in {(1, 16), (3, 32)}
            or align != channels * bits // 8 or average != rate * align):
        raise ValueError("Unsupported unchanged native-format contract")
    return {"sample_rate": rate, "channels": channels, "bits_per_sample": bits,
            "block_align": align, "native_encoding": "float32le" if kind == 3 else "pcm16le", "raw_format_hex": value}


def ready_permit(ready, *, pid, start_filetime, nonce, executable_sha256):
    keys = {"format", "nonce", "current_pid", "process_start_filetime", "executable_sha256", "audio_api_called"}
    if (not isinstance(ready, dict) or type(pid) is not int or pid <= 0 or type(start_filetime) is not int or not 0 < start_filetime < 2**64
            or set(ready) != keys or ready["format"] != "dordiai-owned-clock-ready" or ready["nonce"] != nonce
            or type(ready["current_pid"]) is not int or ready["current_pid"] != pid
            or type(ready["process_start_filetime"]) is not int or ready["process_start_filetime"] != start_filetime
            or ready["executable_sha256"] != executable_sha256 or ready["audio_api_called"] is not False
            or not re.fullmatch(r"[0-9a-f]{32}", nonce) or not re.fullmatch(r"[0-9a-f]{64}", executable_sha256)):
        raise ValueError("Parent-held exact child PID/FILETIME/hash/nonce differs before permit")
    return f"{nonce}|{pid}|{start_filetime}|{executable_sha256}\n".encode("ascii")


def child_start_filetime(process):
    """Use held child HANDLE, never reopen a PID or round FILETIME via float/JS."""
    kernel = ct.WinDLL("kernel32", use_last_error=True)
    kernel.GetProcessTimes.argtypes = [wt.HANDLE, ct.POINTER(wt.FILETIME), ct.POINTER(wt.FILETIME), ct.POINTER(wt.FILETIME), ct.POINTER(wt.FILETIME)]
    kernel.GetProcessTimes.restype = wt.BOOL
    created, ended, system, user = (wt.FILETIME() for _ in range(4))
    if not kernel.GetProcessTimes(wt.HANDLE(int(process._handle)), ct.byref(created), ct.byref(ended), ct.byref(system), ct.byref(user)):
        raise ct.WinError(ct.get_last_error())
    return (int(created.dwHighDateTime) << 32) | int(created.dwLowDateTime)


def default_snapshot():
    """Read only default render roles via IMMDevice; no audio client activation."""
    class GUID(ct.Structure):
        _fields_ = [("a", wt.DWORD), ("b", wt.WORD), ("c", wt.WORD), ("d", ct.c_ubyte * 8)]
    def guid(value): return GUID.from_buffer_copy(uuid.UUID(value).bytes_le)
    def call(obj, index, result, *args):
        address = ct.cast(obj, ct.POINTER(ct.POINTER(ct.c_void_p))).contents[index]
        return ct.WINFUNCTYPE(result, ct.c_void_p, *[kind for kind, _ in args])(address)(obj, *[value for _, value in args])
    ole = ct.OleDLL("ole32")
    ole.CoInitializeEx.argtypes = [ct.c_void_p, wt.DWORD]; ole.CoInitializeEx.restype = ct.c_long
    ole.CoCreateInstance.argtypes = [ct.POINTER(GUID), ct.c_void_p, wt.DWORD, ct.POINTER(GUID), ct.POINTER(ct.c_void_p)]
    ole.CoCreateInstance.restype = ct.c_long; ole.CoTaskMemFree.argtypes = [ct.c_void_p]
    hr = ole.CoInitializeEx(None, 2)
    if hr < 0: raise OSError("Read-only snapshot COM initialization failed")
    enum = ct.c_void_p(); rows = {}
    try:
        hr = ole.CoCreateInstance(ct.byref(guid("bcde0395-e52f-467c-8e3d-c4579291692e")), None, 1,
                                 ct.byref(guid("a95664d2-9614-4f35-a746-de8db63617e6")), ct.byref(enum))
        if hr < 0: raise OSError("Read-only endpoint enumeration failed")
        for role in range(3):
            device = ct.c_void_p()
            hr = call(enum, 4, ct.c_long, (ct.c_int, 0), (ct.c_int, role), (ct.POINTER(ct.c_void_p), ct.byref(device)))
            if hr < 0: raise OSError("Read-only default role lookup failed")
            try:
                text = ct.c_void_p()
                hr = call(device, 5, ct.c_long, (ct.POINTER(ct.c_void_p), ct.byref(text)))
                if hr < 0: raise OSError("Read-only default ID lookup failed")
                try: rows[str(role)] = ct.wstring_at(text)
                finally: ole.CoTaskMemFree(text)
            finally: call(device, 2, wt.ULONG)
    finally:
        if enum: call(enum, 2, wt.ULONG)
        ole.CoUninitialize()
    return rows


def execute_owned(executable, directory, nonce, executable_sha256, mode, expected_format_hex=None):
    command = [str(executable), "--mode", mode, "--nonce", nonce, "--directory", str(directory),
               "--expected-exe-sha256", executable_sha256, "--endpoint-id", USB_ENDPOINT]
    if mode == "run":
        parse_format(expected_format_hex)
        command += ["--expected-format-hex", expected_format_hex]
    elif mode != "describe":
        raise ValueError("Only exact describe/run modes exist")
    started = time.monotonic(); deadline = started + 8
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               cwd=directory, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    replies = Queue(); stdout_rows = []; stderr_chunks = []; errors = []
    def stdout_reader():
        while True:
            line = process.stdout.readline(65537)
            if not line: break
            if len(line) > 65536 or len(stdout_rows) >= 4:
                errors.append("Unbounded child stdout")
                continue
            stdout_rows.append(line); replies.put(line)
        replies.put(None)
    def stderr_reader():
        retained = 0
        while True:
            part = process.stderr.read1(4096)
            if not part: return
            if retained + len(part) <= 65536:
                stderr_chunks.append(part); retained += len(part)
            else: errors.append("Unbounded child stderr")
    threads = [Thread(target=stdout_reader, daemon=True), Thread(target=stderr_reader, daemon=True)]
    for thread in threads: thread.start()
    forced = False; ready = None; start_time = None; permit_ms = None; failure = None
    try:
        line = replies.get(timeout=max(0.001, deadline-time.monotonic()))
        if line is None: raise ValueError("Own child exited before ownership ready")
        arrived = time.monotonic(); ready = load_json(line)
        start_time = child_start_filetime(process)
        permit = ready_permit(ready, pid=process.pid, start_filetime=start_time, nonce=nonce, executable_sha256=executable_sha256)
        if process.poll() is not None: raise ValueError("Owned child exited before permit")
        process.stdin.write(permit); process.stdin.flush(); process.stdin.close()
        permit_ms = (time.monotonic()-arrived)*1000
        if permit_ms >= 1000: raise TimeoutError("Ownership permit exceeded native1s window")
        process.wait(timeout=max(0.001, deadline-time.monotonic()))
    except (Empty, subprocess.TimeoutExpired, TimeoutError, ValueError, OSError) as error:
        failure = type(error).__name__ + ": " + str(error)
    finally:
        if process.poll() is None:
            process.kill(); forced = True
        process.wait(timeout=2)
        for thread in threads: thread.join(timeout=1)
        for stream in (process.stdin, process.stdout, process.stderr):
            if not stream.closed: stream.close()
    if any(thread.is_alive() for thread in threads): errors.append("Child pipe drain did not finish")
    parsed_rows = []
    for row in stdout_rows:
        try:
            value = load_json(row)
            if not isinstance(value, dict): raise ValueError("Owned stdout must contain JSON objects")
            parsed_rows.append(value)
        except (ValueError, UnicodeError) as error:
            errors.append("Invalid child JSON: " + str(error))
    return {"command": command, "pid": process.pid, "process_start_filetime": start_time,
            "ready": ready, "permit_ms": permit_ms, "exit_code": process.returncode,
            "forced_own_child_kill": forced, "failure": failure, "pipe_errors": errors,
            "stdout": parsed_rows, "stdout_raw_utf8": [row.decode("utf-8", errors="replace") for row in stdout_rows],
            "stderr": b"".join(stderr_chunks).decode("utf-8", errors="replace"),
            "elapsed_seconds": time.monotonic()-started, "own_child_reaped": process.poll() is not None}


def marker_analysis(reference_raw, captured_raw, format):
    """Full marker + ordinary windows, one common offset; no time/frame warps."""
    import numpy as np
    try:
        from loopback_correlation import decode
    except ImportError:
        sys.path.insert(0, str(ROOT / "tools"))
        from loopback_correlation import decode
    reference, captured = decode(reference_raw, format), decode(captured_raw, format)
    n, m = len(reference), len(captured)
    if n != format["sample_rate"] // 10 or not n <= m <= 2 * format["sample_rate"]:
        raise ValueError("Complete100ms marker and bounded capture required")
    coefficients = []; fft_size = 1 << (n+m-2).bit_length()
    for channel in range(2):
        ref, signal = reference[:, channel], captured[:, channel]
        centered = ref-ref.mean(); energy = float(np.dot(centered, centered))
        if energy <= 1e-12: raise ValueError("Own marker has no variation")
        convolution = np.fft.irfft(np.fft.rfft(signal, fft_size)*np.fft.rfft(centered[::-1], fft_size), fft_size)[n-1:m]
        sums = np.concatenate(([0.], np.cumsum(signal))); squares = np.concatenate(([0.], np.cumsum(signal*signal)))
        windows = np.maximum(0., squares[n:]-squares[:-n]-(sums[n:]-sums[:-n])**2/n)
        denominator = np.sqrt(windows*energy)
        coefficients.append(np.clip(np.divide(convolution, denominator, out=np.zeros_like(convolution), where=denominator>1e-15), -1., 1.))
    offset = int(np.argmax(np.minimum(coefficients[0], coefficients[1])))
    rows = []
    for window in range(6):
        begin, end = (0, n) if window == 0 else ((window-1)*n//5, window*n//5)
        for channel in range(2):
            ref = reference[begin:end, channel]; observed = captured[offset+begin:offset+end, channel]
            a, b = ref-ref.mean(), observed-observed.mean(); denominator = float(np.linalg.norm(a)*np.linalg.norm(b))
            correlation = float(np.dot(a, b)/denominator) if denominator > 1e-15 else 0.
            gain = float(np.dot(a, b)/np.dot(a, a)) if np.dot(a, a)>1e-15 else 0.
            rows.append({"window": "full" if window == 0 else window, "channel": channel, "reference_begin": begin,
                         "reference_end": end, "normalized_correlation": correlation, "gain": gain,
                         "captured_rms": float(np.sqrt(np.mean(observed*observed)))})
    verified = all(row["normalized_correlation"]>=.98 and row["gain"]>0 and row["captured_rms"]>1e-8 for row in rows)
    return {"known_own_marker_correlated": verified, "matched_capture_array_offset_frames": offset,
            "offset_is_calibrated_latency": False, "single_offset_for_full_and_all_windows": True,
            "per_window_offset_search": False, "time_or_frame_warp_applied": False, "windows": rows,
            "reference_frames": n, "capture_frames": m, "physical_audio_verified": False, "product_ready": False}


def analyze_run(report, data, describe_only, expected_format_hex):
    child = report["child"]; directory = Path(report["directory"]); nonce = report["nonce"]
    valid = (not child["failure"] and not child["pipe_errors"] and child["exit_code"] == 0
             and not child["forced_own_child_kill"] and child["own_child_reaped"] and len(child["stdout"]) == 2
             and report["default_endpoints_unchanged"])
    if valid and describe_only:
        description = child["stdout"][1]
        valid = (description.get("status") == "read-only-native-format" and description.get("selected_endpoint", {}).get("id") == USB_ENDPOINT
                 and description.get("render_started") is False and description.get("capture_started") is False)
        report["description"] = description
        if valid: parse_format(description["native_format"]["raw_format_hex"])
    elif valid:
        path = no_links(directory / "clock.json")
        if not path.is_file() or not 0 < path.stat().st_size <= 1024*1024: raise ValueError("Bounded native clock receipt required")
        native = load_json(path.read_bytes()); report["native_receipt_sha256"] = sha(path.read_bytes()); report["native_receipt"] = native
        elapsed = native.get("session_through_both_stops_seconds")
        if (native.get("frozen_source_sha256") != PINS["frozen_source_sha256"]
                or native.get("marker_duration_ms") != 100 or native.get("marker_peak_limit") != .03
                or native.get("session_limit_ms") != 1500 or type(elapsed) not in (int, float)
                or not 0 < elapsed <= 1.5):
            raise ValueError("Native source/marker/real session bounds differ")
        spec = importlib.util.spec_from_file_location("parent_owned_clock_contract", ROOT / "tools/owned_audio_clock_contract.py")
        contract = importlib.util.module_from_spec(spec); spec.loader.exec_module(contract)
        report["clock_assessment"] = contract.assess_native_receipt(native, child_pid=child["pid"], process_start_filetime=child["process_start_filetime"],
            nonce=nonce, executable_sha256=sha(data["owned-clock.exe"]), endpoint_id=USB_ENDPOINT, native_format_hex=expected_format_hex)
        pcm = {}
        for key, filename in (("reference_pcm", "reference.pcm"), ("captured_pcm", "captured.pcm")):
            row = native[key]; path = no_links(directory / filename)
            if row.get("filename") != filename or not path.is_file() or not 0 < path.stat().st_size <= 8*1024*1024:
                raise ValueError("Bounded exact own marker/capture file required")
            raw = path.read_bytes()
            if row.get("size_bytes") != len(raw) or row.get("sha256") != sha(raw): raise ValueError("Native PCM receipt differs")
            pcm[key] = raw
        report["marker_analysis"] = marker_analysis(pcm["reference_pcm"], pcm["captured_pcm"], parse_format(expected_format_hex))
        valid = report["marker_analysis"]["known_own_marker_correlated"] and report["clock_assessment"]["render_clock"]["clock_axis_available"]
    return bool(valid)


def run(artifact, *, describe_only, expected_format_hex=None):
    if os.name != "nt": raise ValueError("Actual Windows parent process required")
    if not describe_only: parse_format(expected_format_hex)
    elif expected_format_hex is not None: raise ValueError("Describe mode has no requested format")
    data, receipt = verify_artifact(artifact)
    root = no_links(OWNED_ROOT)
    if root.resolve() != Path("D:/DordiaiTestTemp").resolve() or not root.is_dir(): raise ValueError("Exact existing owned D: root required")
    nonce = secrets.token_hex(16); directory = root / ("owned-clock-"+nonce); directory.mkdir()
    no_links(directory)
    executable = directory / "owned-clock.exe"; executable.write_bytes(data["owned-clock.exe"])
    if sha(executable.read_bytes()) != receipt["files"]["owned-clock.exe"]["sha256"]: raise ValueError("Copied own executable differs")
    before = default_snapshot()
    child = execute_owned(executable, directory, nonce, sha(data["owned-clock.exe"]), "describe" if describe_only else "run", expected_format_hex)
    try:
        after = default_snapshot()
    except (OSError, ValueError) as error:
        after = {"snapshot_error": type(error).__name__ + ": " + str(error)}
    report = {"format": "dordiai-owned-clock-parent-probe", "format_version": 1, "created_utc": datetime.now(timezone.utc).isoformat(),
              "mode": "describe-only" if describe_only else "run", "artifact_pins": PINS, "build_receipt_sha256": sha(data["build-receipt.json"]),
              "directory": str(directory), "nonce": nonce, "child": child, "defaults_before": before, "defaults_after": after,
              "default_endpoints_unchanged": before == after, "default_restoration_performed": False,
              "physical_audio_verified": False, "actual_NVDA_verified": False, "product_ready": False}
    try:
        valid = analyze_run(report, data, describe_only, expected_format_hex)
    except (ValueError, KeyError, OSError, ImportError, TypeError) as error:
        valid = False
        report["analysis_error"] = type(error).__name__ + ": " + str(error)
    report["status"] = "described" if valid and describe_only else "transport-observed-independent-clock-limits-remain" if valid else "failed"
    (directory / "parent-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--artifact", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--describe-only", action="store_true"); mode.add_argument("--run", action="store_true")
    parser.add_argument("--expected-format-hex")
    args = parser.parse_args()
    report = run(args.artifact, describe_only=args.describe_only, expected_format_hex=args.expected_format_hex)
    print(json.dumps({"status": report["status"], "directory": report["directory"], "description": report.get("description"), "product_ready": False}))
    return 1 if report["status"] == "failed" else 0


if __name__ == "__main__": raise SystemExit(main())
