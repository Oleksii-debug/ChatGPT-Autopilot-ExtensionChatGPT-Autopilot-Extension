"""Diagnose/start existing audio services only on an explicitly opted-in CI runner.

No driver is installed: the reviewed VB-CABLE package explicitly requires a
reboot, which this ephemeral validation workflow does not perform. Optional
candidate verification downloads pinned vendor bytes and checks Authenticode;
it does not execute the installer or alter certificate/boot/security settings.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile


VENDOR_PAGE = "https://vb-audio.com/Cable/"
VENDOR_MANUAL = "https://vb-audio.com/Cable/VBCABLE_ReferenceManual.pdf"
VENDOR_LICENSE = "https://vb-audio.com/Services/licensing.htm"
CANDIDATE_URL = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack46.zip"
CANDIDATE_BYTES = 1324680
CANDIDATE_SHA256 = "bc44e8974191a5a2427d6c979e2dab08dbb09925f3f435dfa2f0ba3e45b6eb90"
SIGNATURE_FILES = {
    "VBCABLE_Setup_x64.exe": "734c35dfa6d98f48782a451633ceb471166ec70d60482fd89a1123d0ee3c4f41",
    "vbaudio_cable64_win10.cat": "5d24c17858b49ad83bb856c66c24c5c2aecdb89cbaae2f8179c15d351124fa9f",
}


class ServiceStatus(ctypes.Structure):
    _fields_ = [(name, wintypes.DWORD) for name in (
        "service_type", "current_state", "controls_accepted", "win32_exit_code",
        "service_exit_code", "checkpoint", "wait_hint", "process_id", "flags")]


def require_ephemeral_ci(environment=None):
    environment = os.environ if environment is None else environment
    if environment.get("GITHUB_ACTIONS") != "true" or environment.get("RUNNER_OS") != "Windows":
        raise ValueError("Service changes are restricted to the explicitly opted-in ephemeral Windows Actions runner")


def audio_devices():
    winmm = ctypes.WinDLL("winmm", use_last_error=True)
    winmm.waveOutGetNumDevs.restype = wintypes.UINT
    return int(winmm.waveOutGetNumDevs())


def service_state(name, start=False):
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi.OpenSCManagerW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
    advapi.OpenSCManagerW.restype = wintypes.HANDLE
    advapi.OpenServiceW.argtypes = [wintypes.HANDLE, wintypes.LPCWSTR, wintypes.DWORD]
    advapi.OpenServiceW.restype = wintypes.HANDLE
    advapi.QueryServiceStatusEx.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.POINTER(ctypes.c_ubyte), wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.QueryServiceStatusEx.restype = wintypes.BOOL
    advapi.StartServiceW.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p]
    advapi.StartServiceW.restype = wintypes.BOOL
    advapi.CloseServiceHandle.argtypes = [wintypes.HANDLE]
    advapi.CloseServiceHandle.restype = wintypes.BOOL
    manager = advapi.OpenSCManagerW(None, None, 1)
    if not manager:
        raise ctypes.WinError(ctypes.get_last_error())
    service = None
    try:
        service = advapi.OpenServiceW(manager, name, 4 | (16 if start else 0))
        if not service:
            raise ctypes.WinError(ctypes.get_last_error())
        def query():
            status, needed = ServiceStatus(), wintypes.DWORD()
            if not advapi.QueryServiceStatusEx(service, 0, ctypes.cast(ctypes.byref(status), ctypes.POINTER(ctypes.c_ubyte)), ctypes.sizeof(status), ctypes.byref(needed)):
                raise ctypes.WinError(ctypes.get_last_error())
            return {"state": int(status.current_state), "process_id": int(status.process_id),
                    "win32_exit_code": int(status.win32_exit_code)}
        result = {"service": name, "before": query(), "start_requested": False}
        if start and result["before"]["state"] == 1:
            result["start_requested"] = True
            if not advapi.StartServiceW(service, 0, None):
                error = ctypes.get_last_error()
                if error != 1056:
                    result["start_error"] = {"winerror": error, "message": str(ctypes.WinError(error))}
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                status = query()
                if status["state"] not in {2, 3}:
                    break
                time.sleep(.25)
        result["after"] = query()
        return result
    finally:
        if service:
            advapi.CloseServiceHandle(service)
        advapi.CloseServiceHandle(manager)


def authenticode(path):
    # The path is passed through one subprocess environment value, never
    # interpolated into PowerShell code. No trusted-publisher cert is imported.
    script = "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:DORDIAI_SIGNATURE_TARGET; [pscustomobject]@{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject;issuer=$s.SignerCertificate.Issuer;thumbprint=$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress"
    environment = dict(os.environ, DORDIAI_SIGNATURE_TARGET=str(path.resolve()))
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                            env=environment, capture_output=True, text=True, timeout=30, check=True)
    signature = json.loads(result.stdout.lstrip("\ufeff"))
    if signature.get("status") != "Valid":
        raise ValueError("Candidate Authenticode signature did not validate")
    return signature


def verify_candidate(output):
    cache = output / "vendor-candidate"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / "VBCABLE_Driver_Pack46.zip"
    if not archive.exists():
        with urllib.request.urlopen(CANDIDATE_URL, timeout=30) as response:
            if urllib.parse.urlsplit(response.geturl()).hostname != "download.vb-audio.com":
                raise ValueError("Candidate download left the official vendor download host")
            data = response.read(CANDIDATE_BYTES + 1)
        if len(data) != CANDIDATE_BYTES or hashlib.sha256(data).hexdigest() != CANDIDATE_SHA256:
            raise ValueError("Candidate archive checksum or size mismatch")
        archive.write_bytes(data)
    blob = archive.read_bytes()
    if len(blob) != CANDIDATE_BYTES or hashlib.sha256(blob).hexdigest() != CANDIDATE_SHA256:
        raise ValueError("Cached candidate archive checksum or size mismatch")
    result = {"url": CANDIDATE_URL, "sha256": CANDIDATE_SHA256, "bytes": len(blob),
              "installed": False, "policy": "verification only; vendor requires reboot", "signatures": {}}
    with zipfile.ZipFile(archive) as source:
        readme = source.read("readme.txt").decode("cp1252")
        if "you must reboot" not in readme.lower():
            raise ValueError("Candidate installation instructions differ from the reviewed package")
        for filename, expected in SIGNATURE_FILES.items():
            data = source.read(filename)
            if hashlib.sha256(data).hexdigest() != expected:
                raise ValueError("Candidate signed member checksum mismatch: " + filename)
            target = cache / filename
            target.write_bytes(data)
            signature = authenticode(target)
            subject = (signature.get("subject") or "").casefold()
            if filename.endswith(".exe") and not (("vincent" in subject and "burel" in subject) or "vb-audio" in subject):
                raise ValueError("Candidate installer signature is not the reviewed vendor")
            if filename.endswith(".cat") and "microsoft windows hardware compatibility publisher" not in subject:
                raise ValueError("Candidate kernel catalog does not have the expected Windows hardware publisher")
            result["signatures"][filename] = signature
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--start-existing-services", action="store_true")
    parser.add_argument("--ephemeral-ci", action="store_true")
    parser.add_argument("--verify-vb-cable-candidate", action="store_true")
    args = parser.parse_args(argv)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"format": "dordiai-audio-endpoint-setup", "format_version": 1,
              "created_utc": datetime.now(timezone.utc).isoformat(), "status": "running",
              "scope": "ephemeral CI audio infrastructure; no product or physical-latency acceptance",
              "wave_player_verified": False, "physical_audio_verified": False, "driver_installed": False,
              "vendor_sources": [VENDOR_PAGE, VENDOR_MANUAL, VENDOR_LICENSE],
              "vendor_driver_policy": "Not installed: reviewed vendor package explicitly requires a reboot. No reboot, boot/security/trust-store changes or user-PC changes are performed."}
    try:
        if os.name != "nt":
            report.update(status="blocked", reason="Real Windows is required; no services or drivers were changed")
            return 2
        if args.start_existing_services or args.verify_vb_cable_candidate:
            if not args.ephemeral_ci:
                raise ValueError("Explicit --ephemeral-ci is required before changing a CI service or verifying a driver candidate")
            require_ephemeral_ci()
        report["wave_out_devices_before"] = audio_devices()
        report["services"] = []
        for name in ("AudioEndpointBuilder", "Audiosrv"):
            try:
                report["services"].append(service_state(name, start=args.start_existing_services))
            except OSError as error:
                report["services"].append({"service": name, "error": str(error)})
        report["wave_out_devices_after"] = audio_devices()
        if args.verify_vb_cable_candidate:
            report["candidate"] = verify_candidate(output)
        if report["wave_out_devices_after"]:
            report.update(status="endpoint-present", reason="Existing Windows audio endpoint enumerated; actual NVDA WavePlayer still must be tested")
            return 0
        report.update(status="blocked", reason="No Windows audio output endpoint is present. The reviewed virtual driver requires reboot; unattended driver installation was not attempted.")
        return 2
    except Exception as error:
        report.update(status="blocked", reason=str(error))
        return 2
    finally:
        report["completed_utc"] = datetime.now(timezone.utc).isoformat()
        (output / "audio-endpoint.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
