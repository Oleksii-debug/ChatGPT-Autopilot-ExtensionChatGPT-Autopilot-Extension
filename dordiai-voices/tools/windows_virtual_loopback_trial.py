"""Lease one verified new vendor endpoint and correlate only our own loopback marker."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
import windows_virtual_audio_trial as device
from loopback_correlation import correlate, MAX_BYTES


def read_pcm(directory, receipt, filename):
    if not isinstance(receipt, dict) or receipt.get("filename") != filename:
        raise ValueError("Unexpected calibration PCM receipt")
    path = directory / filename
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
        raise ValueError("Only owned regular PCM evidence accepted")
    size = path.stat().st_size
    if not 0 < size <= MAX_BYTES or size != receipt.get("size_bytes"):
        raise ValueError("PCM size receipt mismatch")
    raw = path.read_bytes()
    if len(raw) != size or hashlib.sha256(raw).hexdigest() != receipt.get("sha256"):
        raise ValueError("PCM checksum mismatch")
    return raw


def correlate_evidence(directory, expected_marker=None):
    directory = Path(directory)
    path = directory / "capture.json"
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode) or path.stat().st_size > 4*1024*1024:
        raise ValueError("Only bounded regular calibration report accepted")
    report = json.loads(path.read_text(encoding="utf-8"))
    if (report.get("format") != "dordiai-owned-render-loopback-calibration" or
            report.get("status") != "technical-loopback-capture-complete" or
            report.get("all_own_com_interfaces_released") is not True or report.get("cleanup_errors") != [] or
            report.get("reference_all_submitted") is not True):
        raise ValueError("Native calibration did not finish and release all owned interfaces")
    for key in ("physical_audio_verified", "acoustic_latency_verified", "microphone_capture_used",
                "privacy_settings_changed", "default_device_changed", "format_changed", "service_restart_performed", "reboot_performed"):
        if report.get(key) is not False:
            raise ValueError("Calibration scope changed: " + key)
    reference = read_pcm(directory, report.get("reference_pcm"), "reference.pcm")
    captured = read_pcm(directory, report.get("captured_pcm"), "captured.pcm")
    format = report["native_format"]
    if expected_marker is None:
        from wasapi_loopback_calibration import known_marker
        expected_marker = known_marker
    if reference != expected_marker(format):
        raise ValueError("Reference differs from exact deterministic own marker")
    if len(captured) // format["block_align"] != report.get("captured_frames"):
        raise ValueError("Native captured frame receipt mismatch")
    return correlate(reference, captured, format)


def run(args):
    report = {"format": "dordiai-owned-loopback-trial", "format_version": 1, "status": "blocked",
              "physical_audio_verified": False, "acoustic_latency_verified": False, "product_ready": False,
              "virtual_audio_verified": False, "known_marker_correlated_verified": False,
              "requested_phrase_waveform_match_verified": False, "microphone_capture_used": False,
              "privacy_settings_changed": False, "default_device_changed": False, "reboot_performed": False,
              "certificates_imported": False, "signature_enforcement_modified": False,
              "vendor_installer_executed": False,
              "scope": "Exact newly owned render endpoint LOOPBACK, own calibration marker only; no NVDA/system default capture"}
    created = False
    try:
        if not args.ephemeral_ci:
            raise device.TrialBlocked("Explicit owned CI scope required")
        device.guard_environment(os.environ, args.package, args.output)
        if args.output.exists():
            raise device.TrialBlocked("Output already exists")
        args.output.mkdir(parents=True)
        created = True
        report["verification"] = device.verify_package(args.package, args.validation)
        report["endpoints_before"] = device.endpoints()
        pnp = device.WindowsPnP()
        with pnp.owned_device(args.package / "vbMmeCable64_win10.inf", report):
            deadline = time.monotonic() + 20
            while True:
                during = device.endpoints()
                render, unused_capture = device.select_new_vendor_endpoints(report["endpoints_before"], during)
                report["endpoints_during"] = during
                if render:
                    break
                if time.monotonic() >= deadline:
                    raise device.TrialBlocked("No unique new owned two-channel render endpoint")
                time.sleep(.25)
            report["render_endpoint"] = render
            calibration = args.output / "calibration"
            command = [sys.executable, str(Path(__file__).with_name("wasapi_loopback_calibration.py")),
                       "--render-name", render["name"], "--owned-instance-id", report["owned_instance_id"],
                       "--output", str(calibration)]
            try:
                child = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, timeout=15, check=False)
            except subprocess.TimeoutExpired:
                raise RuntimeError("Bounded native calibration child timed out; child terminated before owned PnP cleanup")
            report["calibration_returncode"] = child.returncode
            report["calibration_stdout_tail"] = child.stdout[-8192:]
            report["calibration_stderr_tail"] = child.stderr[-4096:]
            if child.returncode:
                raise RuntimeError("Native loopback calibration failed; preserve exact HRESULT report")
            result = correlate_evidence(calibration)
            with (args.output / "correlation.json").open("x", encoding="utf-8") as output:
                json.dump(result, output, indent=2)
                output.write("\n")
            report["correlation"] = result
            report["known_marker_correlated_verified"] = result["known_marker_correlated_verified"]
            report["virtual_audio_verified"] = result["virtual_audio_verified"]
            report["status"] = "calibration-correlated" if result["virtual_audio_verified"] else "calibration-not-correlated"
    except device.TrialBlocked as error:
        report.update(status="blocked", reason=str(error))
    except Exception as error:
        report.update(status="failed", reason=type(error).__name__ + ": " + str(error))
    finally:
        if report.get("cleanup", {}).get("attempted") and report["cleanup"].get("removed") is not True:
            report.update(status="failed", cleanup_failure=True, reason="Exact owned instance absence not verified")
        if created:
            with (args.output / "loopback-trial.json").open("x", encoding="utf-8") as output:
                json.dump(report, output, indent=2)
                output.write("\n")
        print("OWNED_LOOPBACK_TRIAL " + json.dumps(report, ensure_ascii=True), flush=True)
    return 0 if report["status"] == "calibration-correlated" else 2 if report["status"] == "blocked" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("package", "validation", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--ephemeral-ci", action="store_true")
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
