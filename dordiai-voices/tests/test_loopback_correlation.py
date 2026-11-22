"""Own synthetic PCM only: match full marker, reject corruption and dishonest receipts."""
from __future__ import annotations
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace
try:
    import numpy as np
except ImportError:
    raise unittest.SkipTest("NumPy CI-only loopback correlation dependency unavailable")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import loopback_correlation as correlation
import wasapi_loopback_calibration as native
import windows_virtual_loopback_trial as trial


def format(encoding="float32le", rate=8000):
    bits = 32 if encoding == "float32le" else 16
    return {"sample_rate": rate, "channels": 2, "bits_per_sample": bits,
            "block_align": bits//4, "native_encoding": encoding}


class CorrelationTests(unittest.TestCase):
    def setUp(self):
        self.fmt = format()
        self.reference = native.known_marker(self.fmt)
        self.frames = correlation.decode(self.reference, self.fmt)

    def payload(self, values):
        return np.asarray(values, dtype="<f4").tobytes()

    def test_full_marker_known_offset_and_scaled_both_channels(self):
        capture = np.concatenate((np.zeros((173, 2)), self.frames*.4, np.zeros((500, 2))))
        result = correlation.correlate(self.reference, self.payload(capture), self.fmt)
        self.assertTrue(result["known_marker_correlated_verified"])
        self.assertEqual(result["matched_capture_array_offset_frames"], 173)
        self.assertAlmostEqual(result["channels"][0]["least_squares_gain"], .4, places=6)
        for key in ("physical_audio_verified", "acoustic_latency_verified", "requested_phrase_waveform_match_verified", "product_ready"):
            self.assertIs(result[key], False)

    def test_pcm16_transport_match(self):
        fmt = format("pcm16le")
        reference = native.known_marker(fmt)
        capture = bytes(41*fmt["block_align"]) + reference
        self.assertTrue(correlation.correlate(reference, capture, fmt)["virtual_audio_verified"])

    def test_unrelated_noise_not_verified(self):
        random = np.random.default_rng(123).normal(0, .05, (12000, 2))
        self.assertFalse(correlation.correlate(self.reference, self.payload(random), self.fmt)["virtual_audio_verified"])

    def test_silence_not_verified(self):
        self.assertFalse(correlation.correlate(self.reference, bytes(len(self.reference)), self.fmt)["virtual_audio_verified"])

    def test_channel_swap_and_polarity_inversion_rejected(self):
        for values in (self.frames[:, ::-1], -self.frames):
            with self.subTest():
                self.assertFalse(correlation.correlate(self.reference, self.payload(values), self.fmt)["virtual_audio_verified"])

    def test_one_channel_unrelated_rejected(self):
        values = self.frames.copy()
        values[:, 1] = np.random.default_rng(7).normal(0, .05, len(values))
        self.assertFalse(correlation.correlate(self.reference, self.payload(values), self.fmt)["virtual_audio_verified"])

    def test_nonfinite_unaligned_short_and_oversize_frames_rejected(self):
        nonfinite = self.frames.copy();nonfinite[2, 0] = np.nan
        for payload in (self.payload(nonfinite), self.reference[:-1], self.reference[:-8], self.reference*4):
            with self.subTest():
                with self.assertRaises(ValueError):
                    correlation.correlate(self.reference, payload, self.fmt)

    def test_missing_reference_variation_rejected(self):
        with self.assertRaises(ValueError):
            correlation.correlate(bytes(len(self.reference)), self.reference, self.fmt)


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fmt = format()
        reference = native.known_marker(self.fmt)
        captured = bytes(32) + reference
        self.report = {"format": "dordiai-owned-render-loopback-calibration", "status": "technical-loopback-capture-complete",
                       "all_own_com_interfaces_released": True, "cleanup_errors": [], "reference_all_submitted": True,
                       "native_format": self.fmt, "captured_frames": len(captured)//8}
        for key in ("physical_audio_verified", "acoustic_latency_verified", "microphone_capture_used",
                    "privacy_settings_changed", "default_device_changed", "format_changed", "service_restart_performed", "reboot_performed"):
            self.report[key] = False
        for key, name, raw in (("reference_pcm", "reference.pcm", reference), ("captured_pcm", "captured.pcm", captured)):
            (self.root/name).write_bytes(raw)
            self.report[key] = {"filename": name, "size_bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
        self.save()

    def save(self):
        (self.root/"capture.json").write_text(json.dumps(self.report), encoding="utf-8")

    def test_actual_receipt_and_exact_deterministic_reference(self):
        self.assertTrue(trial.correlate_evidence(self.root)["virtual_audio_verified"])

    def test_wrong_reference_even_selfconsistent_hash_rejected(self):
        with self.assertRaisesRegex(ValueError, "exact deterministic"):
            trial.correlate_evidence(self.root, expected_marker=lambda fmt: b"other")

    def test_corrupted_capture_receipt_rejected(self):
        with (self.root/"captured.pcm").open("r+b") as output:
            output.write(b"xxxx")
        with self.assertRaisesRegex(ValueError, "checksum"):
            trial.correlate_evidence(self.root)

    def test_cleanup_and_scope_changes_fail_closed(self):
        for key, value in (("cleanup_errors", ["Stop failed"]), ("microphone_capture_used", True),
                           ("all_own_com_interfaces_released", False)):
            with self.subTest(key=key):
                prior = self.report[key];self.report[key] = value;self.save()
                with self.assertRaises(ValueError):
                    trial.correlate_evidence(self.root)
                self.report[key] = prior
        self.save()

    def test_pcm_path_traversal_and_frame_mismatch_rejected(self):
        self.report["reference_pcm"]["filename"] = "../reference.pcm";self.save()
        with self.assertRaisesRegex(ValueError, "receipt"):
            trial.correlate_evidence(self.root)
        self.report["reference_pcm"]["filename"] = "reference.pcm"
        self.report["captured_frames"] += 1;self.save()
        with self.assertRaisesRegex(ValueError, "frame receipt"):
            trial.correlate_evidence(self.root)

    def test_pcm_symlink_not_followed(self):
        original = self.root/"captured.pcm"
        target = self.root/"other.pcm";original.rename(target)
        try:
            original.symlink_to(target)
        except OSError:
            self.skipTest("Symlink privilege unavailable")
        with self.assertRaisesRegex(ValueError, "regular"):
            trial.correlate_evidence(self.root)

    def test_report_symlink_not_followed(self):
        original = self.root/"capture.json"
        target = self.root/"other.json";original.rename(target)
        try:
            original.symlink_to(target)
        except OSError:
            self.skipTest("Symlink privilege unavailable")
        with self.assertRaisesRegex(ValueError, "regular"):
            trial.correlate_evidence(self.root)


class LeaseTests(unittest.TestCase):
    def exercise(self, child, cleanup_ok=True, correlated=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args = SimpleNamespace(package=root/"package-123", validation=root/"validation.json",
                                   output=root/"output-123", ephemeral_ci=True)
            instance = "ROOT\\DORDIAI_VBCABLE_" + "A"*32 + "\\0000"
            entered = []
            @contextmanager
            def lease(path, report):
                report["owned_instance_id"] = instance;entered.append("entered")
                try:
                    yield
                finally:
                    entered.append("cleanup")
                    report["cleanup"] = {"attempted": True, "removed": cleanup_ok}
            pnp = SimpleNamespace(owned_device=lease)
            options = {"side_effect": child} if isinstance(child, Exception) else {"return_value": child}
            result = {"known_marker_correlated_verified": correlated, "virtual_audio_verified": correlated}
            with mock.patch.object(trial.device, "guard_environment"), mock.patch.object(trial.device, "verify_package", return_value={}), \
                    mock.patch.object(trial.device, "endpoints", return_value={}), mock.patch.object(trial.device, "WindowsPnP", return_value=pnp), \
                    mock.patch.object(trial.device, "select_new_vendor_endpoints", return_value=({"name":"Speakers (VB-Audio Virtual Cabl"}, None)), \
                    mock.patch.object(trial.subprocess, "run", **options), mock.patch.object(trial, "correlate_evidence", return_value=result), \
                    mock.patch("builtins.print"):
                code = trial.run(args)
            report = json.loads((args.output/"loopback-trial.json").read_text(encoding="utf-8"))
            self.assertEqual(entered, ["entered", "cleanup"])
            return code, report

    def test_native_child_failure_cleans_owned_device(self):
        code, report = self.exercise(SimpleNamespace(returncode=1, stdout="", stderr="native HRESULT"))
        self.assertEqual(code, 1)
        self.assertTrue(report["cleanup"]["removed"])
        self.assertFalse(report["virtual_audio_verified"])

    def test_child_timeout_still_cleans_owned_device(self):
        code, report = self.exercise(trial.subprocess.TimeoutExpired(["helper"], 15))
        self.assertEqual(code, 1)
        self.assertIn("timed out", report["reason"])
        self.assertTrue(report["cleanup"]["removed"])

    def test_cleanup_failure_overrides_correlated_marker(self):
        code, report = self.exercise(SimpleNamespace(returncode=0, stdout="", stderr=""), cleanup_ok=False, correlated=True)
        self.assertEqual(code, 1)
        self.assertEqual(report["status"], "failed")
        self.assertTrue(report["cleanup_failure"])


if __name__ == "__main__":
    unittest.main()
