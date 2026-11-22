"""No devices: compiled-source identity, exact current PID and reaped child watchdog."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"tools"))
import process_loopback_guard as guard


class BuildGuard(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.folder = self.root/"helper-123";self.folder.mkdir()
        self.binary = self.folder/"helper.exe";self.binary.write_bytes(b"synthetic-not-executed")
        self.source = self.root/"reviewed.cpp";self.source.write_bytes(b"reviewed-source")
        self.receipt = self.folder/"build.json"
        self.environment = {"RUNNER_TEMP":str(self.root), "GITHUB_RUN_ID":"123"}
        self.record = {"format":"dordiai-owned-process-loopback-build", "format_version":1, "run_id":"123",
                       "compiler_authenticode_valid":True, "compiler_signer_subject":"CN=Microsoft Corporation, O=Microsoft Corporation, C=US",
                       "executable_sha256":hashlib.sha256(self.binary.read_bytes()).hexdigest(),
                       "executable_size_bytes":self.binary.stat().st_size,
                       "source_sha256":hashlib.sha256(self.source.read_bytes()).hexdigest()}
        self.save()

    def save(self):
        self.receipt.write_text(json.dumps(self.record), encoding="utf-8")

    def verify(self):
        return guard.verify_build(self.binary,self.receipt,self.source,self.environment)

    def test_exact_synthetic_source_binary_and_trusted_compile_receipt(self):
        self.assertEqual(self.verify()["source_sha256"],self.record["source_sha256"])

    def test_altered_source_binary_and_receipt_rejected(self):
        for path in (self.source,self.binary):
            original=path.read_bytes();path.write_bytes(original+b"changed")
            with self.subTest(path=path.name):
                with self.assertRaisesRegex(ValueError,"identity mismatch"):
                    self.verify()
            path.write_bytes(original)

    def test_wrong_run_signer_or_unsigned_compiler_rejected(self):
        for key,value in (("run_id","456"),("compiler_authenticode_valid",False),("compiler_signer_subject","CN=Other")):
            old=self.record[key];self.record[key]=value;self.save()
            with self.subTest(key=key):
                with self.assertRaisesRegex(ValueError,"compiler build receipt"):
                    self.verify()
            self.record[key]=old
        self.save()

    def test_no_current_run_namespace_rejected(self):
        outside=self.root/"other.exe";outside.write_bytes(self.binary.read_bytes())
        with self.assertRaisesRegex(ValueError,"current owned"):
            guard.verify_build(outside,self.receipt,self.source,self.environment)

    def test_linked_binary_rejected(self):
        target=self.folder/"other.exe";self.binary.rename(target)
        try:self.binary.symlink_to(target)
        except OSError:self.skipTest("Symlink privilege unavailable")
        with self.assertRaisesRegex(ValueError,"regular"):
            self.verify()


class CaptureGuard(unittest.TestCase):
    def setUp(self):
        self.report={"capture_mode":"process-include-current-pid", "target_pid":1234,"current_pid":1234,
                     "child_processes_created":False,"requested_exclude_mode":False,
                     "selected_endpoint":{"id":"own-endpoint"},"async_activation":{"callback_completed":True}}

    def test_only_known_child_pid_and_exact_endpoint_pass(self):
        guard.verify_capture_mode(self.report,1234,"own-endpoint")

    def test_unrelated_pid_exclusion_children_endpoint_or_missing_callback_fail(self):
        for key,value in (("target_pid",999),("current_pid",999),("requested_exclude_mode",True),
                          ("child_processes_created",True),("selected_endpoint",{"id":"other"}),
                          ("async_activation",{"callback_completed":False})):
            prior=self.report[key];self.report[key]=value
            with self.subTest(key=key):
                with self.assertRaisesRegex(ValueError,"exact own marker"):
                    guard.verify_capture_mode(self.report,1234,"own-endpoint")
            self.report[key]=prior


class OwnChild(unittest.TestCase):
    def test_actual_owned_python_child_pid_and_output(self):
        child=guard.own_child([sys.executable,"-c","import os;print(os.getpid())"],5)
        self.assertEqual(child.returncode,0)
        self.assertEqual(int(child.stdout),child.pid)

    def test_actual_owned_timed_out_child_is_reaped(self):
        with self.assertRaises(guard.subprocess.TimeoutExpired):
            guard.own_child([sys.executable,"-c","import time;time.sleep(10)"],.05)


if __name__=="__main__":unittest.main()
