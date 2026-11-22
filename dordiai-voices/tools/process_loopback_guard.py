"""Validate the locally compiled own helper and its native current-PID capture receipt."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
from types import SimpleNamespace


def temporary_regular(path, environ=os.environ):
    raw = Path(path).absolute()
    root = Path(environ["RUNNER_TEMP"]).resolve()
    run_id = environ.get("GITHUB_RUN_ID", "")
    if not run_id.isdigit() or raw.is_symlink() or not stat.S_ISREG(raw.stat().st_mode):
        raise ValueError("Fresh owned regular helper evidence required")
    for parent in raw.parents:
        if parent.is_symlink() or getattr(parent, "is_junction", lambda: False)():
            raise ValueError("Linked helper path forbidden")
    resolved = raw.resolve()
    if not resolved.is_relative_to(root) or run_id not in str(resolved.relative_to(root)):
        raise ValueError("Helper must belong to current owned temporary CI run")
    return resolved


def verify_build(binary, receipt, cpp_source, environ=os.environ):
    binary = temporary_regular(binary, environ)
    receipt = temporary_regular(receipt, environ)
    if binary.suffix.lower() != ".exe" or not 0 < binary.stat().st_size <= 16*1024*1024 or receipt.stat().st_size > 65536:
        raise ValueError("Unbounded or unexpected own helper build")
    record = json.loads(receipt.read_text(encoding="utf-8-sig"))
    if (record.get("format") != "dordiai-owned-process-loopback-build" or record.get("format_version") != 1 or
            record.get("run_id") != environ["GITHUB_RUN_ID"] or record.get("compiler_authenticode_valid") is not True or
            "O=Microsoft Corporation" not in record.get("compiler_signer_subject", "")):
        raise ValueError("No trusted existing Microsoft compiler build receipt")
    source = Path(cpp_source)
    if source.is_symlink() or not stat.S_ISREG(source.stat().st_mode):
        raise ValueError("Reviewed C++ source must be a regular repository file")
    with binary.open("rb") as stream:
        actual_binary = hashlib.file_digest(stream, "sha256").hexdigest()
    actual_source = hashlib.sha256(source.read_bytes()).hexdigest()
    if (actual_binary != record.get("executable_sha256") or actual_source != record.get("source_sha256") or
            binary.stat().st_size != record.get("executable_size_bytes")):
        raise ValueError("Compiled helper source/binary identity mismatch")
    return {"source_sha256": actual_source, "executable_sha256": actual_binary,
            "executable_size_bytes": binary.stat().st_size,
            "compiler_authenticode_valid": True, "compiler_signer_subject": record["compiler_signer_subject"]}


def own_child(command, timeout):
    """Always reap the exact child before the outer endpoint lease is removed."""
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise
        if len(stdout) > 65536 or len(stderr) > 65536:
            raise ValueError("Own helper output exceeds bounded metadata contract")
        return SimpleNamespace(pid=process.pid, returncode=process.returncode, stdout=stdout, stderr=stderr)


def verify_capture_mode(report, child_pid, endpoint_id):
    if (report.get("capture_mode") != "process-include-current-pid" or
            report.get("target_pid") != child_pid or report.get("current_pid") != child_pid or
            report.get("child_processes_created") is not False or report.get("requested_exclude_mode") is not False or
            report.get("selected_endpoint", {}).get("id") != endpoint_id or
            report.get("async_activation", {}).get("callback_completed") is not True):
        raise ValueError("Capture must include only this exact own marker child process and endpoint")
