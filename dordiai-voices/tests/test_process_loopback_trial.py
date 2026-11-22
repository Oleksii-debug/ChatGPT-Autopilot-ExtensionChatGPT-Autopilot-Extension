"""Synthetic process receipts inside a fake device lease; no driver calls."""
from contextlib import contextmanager
import json
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

try:
    import numpy
except ImportError:
    raise unittest.SkipTest("CI-only waveform-analysis dependency unavailable")
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import process_loopback_guard as guard
import wasapi_loopback_calibration as backend
import windows_process_loopback_trial as trial


class ProcessTrial(unittest.TestCase):
    def exercise(self, *, wrong_pid=False, timeout=False, cleanup_ok=True, wrong_raw=False):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            args=SimpleNamespace(package=root/"package-123",validation=root/"validation.json",
                                 output=root/"trial-123",helper=root/"helper.exe",
                                 helper_build_receipt=root/"build.json",ephemeral_ci=True)
            events=[]
            @contextmanager
            def lease(path,report):
                report["owned_instance_id"]="ROOT\\DORDIAI_VBCABLE_"+"A"*32+"\\0000"
                events.append("entered")
                try:yield
                finally:
                    events.append("cleanup")
                    report["cleanup"]={"attempted":True,"removed":cleanup_ok}
            raw=struct.pack("<HHIIHHH",3,2,8000,64000,8,32,0)
            native=backend.describe_format(raw)
            if wrong_raw:native["sample_rate"]=9000
            description={"native_format":native,"selected_endpoint":{"id":"owned"}}
            def child(command,bound):
                if "--describe-native-format" in command:
                    return SimpleNamespace(pid=100,returncode=0,stdout=json.dumps(description),stderr="")
                if timeout:raise guard.subprocess.TimeoutExpired(command,bound)
                calibration=args.output/"calibration";calibration.mkdir()
                record={"capture_mode":"process-include-current-pid","target_pid":999 if wrong_pid else 101,
                        "current_pid":101,"child_processes_created":False,"requested_exclude_mode":False,
                        "selected_endpoint":{"id":"owned"},"async_activation":{"callback_completed":True}}
                (calibration/"capture.json").write_text(json.dumps(record),encoding="utf-8")
                return SimpleNamespace(pid=101,returncode=0,stdout="",stderr="")
            pnp=SimpleNamespace(owned_device=lease)
            result={"known_marker_correlated_verified":True,"virtual_audio_verified":True}
            with mock.patch.object(trial.device,"guard_environment"),mock.patch.object(trial.device,"verify_package",return_value={}), \
                    mock.patch.object(trial.device,"endpoints",return_value={}),mock.patch.object(trial.device,"WindowsPnP",return_value=pnp), \
                    mock.patch.object(trial.device,"select_new_vendor_endpoints",return_value=({"name":"Speakers (VB-Audio Virtual Cabl"},None)), \
                    mock.patch.object(guard,"verify_build",return_value={}),mock.patch.object(guard,"own_child",side_effect=child), \
                    mock.patch.object(trial,"correlate_evidence",return_value=result),mock.patch("builtins.print"):
                code=trial.run(args)
            self.assertEqual(events,["entered","cleanup"])
            report=json.loads((args.output/"loopback-trial.json").read_text(encoding="utf-8"))
            return code,report

    def test_exact_own_process_candidate_reaches_correlation(self):
        code,report=self.exercise()
        self.assertEqual(code,0)
        self.assertEqual(report["calibration_pid"],101)
        self.assertFalse(report["physical_audio_verified"])

    def test_unrelated_target_process_fails_and_releases_device(self):
        code,report=self.exercise(wrong_pid=True)
        self.assertEqual(code,1)
        self.assertFalse(report["virtual_audio_verified"])
        self.assertTrue(report["cleanup"]["removed"])

    def test_native_child_timeout_releases_device(self):
        code,report=self.exercise(timeout=True)
        self.assertEqual(code,1)
        self.assertTrue(report["cleanup"]["removed"])
        self.assertIn("timed out",report["reason"])

    def test_native_format_blob_disagreement_fails_before_marker(self):
        code,report=self.exercise(wrong_raw=True)
        self.assertEqual(code,1)
        self.assertIn("raw structure",report["reason"])

    def test_device_cleanup_failure_overrides_correlated_marker(self):
        code,report=self.exercise(cleanup_ok=False)
        self.assertEqual(code,1)
        self.assertEqual(report["status"],"failed")
        self.assertTrue(report["cleanup_failure"])


if __name__=="__main__":unittest.main()
