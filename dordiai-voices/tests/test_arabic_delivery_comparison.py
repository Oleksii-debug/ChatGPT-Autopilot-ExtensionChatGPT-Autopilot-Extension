"""Synthetic contracts for the source-bound Arabic delivery comparison."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
from zipfile import ZipFile, ZipInfo

import numpy as np

PROJECT = Path(__file__).resolve().parents[1]
SCRIPT = PROJECT / "tools/research/compare_arabic_delivery.py"
spec = importlib.util.spec_from_file_location("arabic_delivery_comparison", SCRIPT)
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)
POLICY = PROJECT / "source/0.12.2/kx47Runtime/voice_delivery.py"


def audible():
    rate = comparison.RATE
    voice = (.2*np.sin(2*np.pi*220*np.arange(rate//3)/rate)).astype(np.float32)
    return np.concatenate((np.zeros(2400, np.float32), voice, np.zeros(3600, np.float32)))


class ActualPolicyContracts(unittest.TestCase):
    def setUp(self):
        self.policy = comparison.load_policy(POLICY)

    def test_policy_is_exact_reviewed_source(self):
        self.assertEqual(comparison.file_digest(POLICY), comparison.POLICY_SHA256)
        self.assertEqual(self.policy.SAMPLE_RATE, 24000)

    def test_original_bytes_and_complete_input_are_preserved(self):
        original = comparison.pcm16(audible())
        digest = hashlib.sha256(original).hexdigest()
        derived, row = comparison.compare_clip(original, self.policy)
        self.assertEqual(hashlib.sha256(original).hexdigest(), digest)
        self.assertEqual(row["raw"]["sha256"], digest)
        self.assertEqual(row["observed_source_slice"]["kept_frames"], len(derived))
        self.assertEqual(len(original)//2, row["raw"]["frames"])
        self.assertLess(len(derived), len(original)//2)

    def test_observed_window_is_actual_input_slice(self):
        raw = comparison.pcm16(audible())
        _, row = comparison.compare_clip(raw, self.policy)
        section = row["observed_source_slice"]
        begin, end = section["start_frame"], section["end_frame_exclusive"]
        self.assertEqual(section["kept_original_pcm_sha256"],
                         comparison.digest(raw[begin*2:end*2]))
        self.assertEqual(row["removed_prefix"]["frames"]+section["kept_frames"]
                         +row["removed_suffix"]["frames"], len(raw)//2)

    def test_quiet_fricative_prefix_is_reported_when_existing_policy_crops_it(self):
        rate = comparison.RATE
        rng = np.random.default_rng(521)
        fricative = rng.normal(0, .0008, 2400).astype(np.float32)
        vowel = (.2*np.sin(2*np.pi*220*np.arange(7200)/rate)).astype(np.float32)
        clip = np.concatenate((np.zeros(6000, np.float32), fricative, vowel,
                               np.zeros(2400, np.float32)))
        _, row = comparison.compare_clip(comparison.pcm16(clip), self.policy, quiet_glyph=True)
        self.assertGreater(row["removed_prefix"]["nonzero_samples"], 0)
        self.assertTrue(row["requires_phonetic_boundary_review"])
        self.assertTrue(row["quiet_fricative_review"])
        self.assertFalse(row["activation_allowed"])
        self.assertFalse(row["phonetic_onset_verified"])

    def test_quiet_tail_is_reported_not_declared_silence(self):
        rng = np.random.default_rng(352)
        clip = np.concatenate((audible()[:-3600],
                               rng.normal(0, .001, 4800).astype(np.float32),
                               np.zeros(2400, np.float32)))
        _, row = comparison.compare_clip(comparison.pcm16(clip), self.policy, quiet_glyph=True)
        self.assertGreater(row["removed_suffix"]["nonzero_samples"], 0)
        self.assertGreater(row["removed_suffix"]["above_one_pcm_tick"], 0)
        self.assertFalse(row["phonetic_tail_verified"])

    def test_activity_is_diagnostic_at_all_four_thresholds(self):
        metrics = comparison.activity_diagnostics(audible())
        self.assertEqual(set(metrics["relative_activity"]), {"0.001", "0.005", "0.02", "0.055"})
        self.assertIn("Diagnostic", metrics["interpretation"])
        self.assertNotIn("silence_verified", metrics)

    def test_observer_is_removed_after_success(self):
        cleaner = self.policy.clean_onset
        comparison.compare_clip(comparison.pcm16(audible()), self.policy)
        self.assertIs(self.policy.clean_onset, cleaner)

    def test_observer_is_removed_when_policy_raises(self):
        cleaner = self.policy.clean_onset
        with mock.patch.object(self.policy, "prepare_letter", side_effect=RuntimeError("synthetic failure")):
            with self.assertRaisesRegex(RuntimeError, "synthetic failure"):
                comparison.compare_clip(comparison.pcm16(audible()), self.policy)
        self.assertIs(self.policy.clean_onset, cleaner)

    def test_empty_silence_odd_and_too_short_inputs_fail(self):
        for pcm in (b"", b"\x00"*2000, b"\x01", b"\x00\x01"*50):
            with self.subTest(length=len(pcm)):
                with self.assertRaises(ValueError):
                    comparison.compare_clip(pcm, self.policy)

    def test_pcm16_has_exact_full_range_round_trip(self):
        values = np.array([-32768, -32767, -42, -1, 0, 1, 42, 32766, 32767], dtype="<i2")
        self.assertEqual(comparison.pcm16(values.astype(np.float32)/32768), values.tobytes())

    def test_derived_wave_retains_complete_candidate(self):
        candidate, _ = comparison.compare_clip(comparison.pcm16(audible()), self.policy)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"derived/recording.wav"
            comparison.save_wave(path, candidate)
            import wave
            with wave.open(str(path), "rb") as wav:
                self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 24000))
                self.assertEqual(wav.readframes(wav.getnframes()), comparison.pcm16(candidate))

    def test_changed_policy_and_evidence_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"policy.py"
            path.write_bytes(POLICY.read_bytes()+b"\n# changed\n")
            with self.assertRaisesRegex(ValueError, "reviewed source13"):
                comparison.load_policy(path)
            path.write_bytes(b'{"data": 1}\r\n')
            expected = comparison.digest(path.read_bytes())
            self.assertEqual(comparison.pinned_json(path, expected), {"data": 1})
            path.write_bytes(b'{"data": 1}\n')
            with self.assertRaises(ValueError):
                comparison.pinned_json(path, expected)


class ArchiveAndIdentityContracts(unittest.TestCase):
    def test_raw1305_has_exact_recoverable_scope(self):
        self.assertEqual(comparison.RAW_BYTES, 101748675)
        self.assertEqual(len(comparison.GLYPHS), 29)
        self.assertEqual(len(set(comparison.GLYPHS)), 29)
        self.assertEqual(comparison.QUIET_GLYPHS, frozenset(("ح", "ه", "ف")))
        self.assertEqual(len(comparison.EXCLUDED), 8)

    def test_every_original_archive_member_is_checked(self):
        fixture = io.BytesIO()
        payloads = {"pcm/a.wav": b"native-data", "pcm/banks/ar/test.pcm": b"\x01\x02"*20}
        with ZipFile(fixture, "w") as archive:
            for name, data in payloads.items():
                archive.writestr(name, data)
        index = [{"path": name, "size_bytes": len(data), "sha256": comparison.digest(data)}
                 for name, data in payloads.items()]
        with ZipFile(fixture) as archive:
            comparison.verify_archive(archive, index)
            corrupt = [dict(item) for item in index]
            corrupt[-1]["sha256"] = "0"*64
            with self.assertRaises(ValueError):
                comparison.verify_archive(archive, corrupt)
            with self.assertRaises(ValueError):
                comparison.verify_archive(archive, index[:-1])

    def test_unsafe_zip_members_are_rejected(self):
        for name in ("../escape", "/absolute", "pcm\\escape", "pcm/new\nline"):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    comparison.safe_member(ZipInfo(name))
        symbolic = ZipInfo("pcm/link")
        symbolic.create_system = 3
        symbolic.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(ValueError):
            comparison.safe_member(symbolic)
        device = ZipInfo("pcm/device")
        device.external_attr = (stat.S_IFCHR | 0o600) << 16
        with self.assertRaises(ValueError):
            comparison.safe_member(device)

    def test_oversized_encrypted_and_directory_members_are_rejected(self):
        oversized = ZipInfo("pcm/huge")
        oversized.file_size = comparison.MAX_MEMBER_BYTES+1
        encrypted = ZipInfo("pcm/encrypted")
        encrypted.flag_bits = 1
        for item in (oversized, encrypted, ZipInfo("pcm/")):
            with self.assertRaises(ValueError):
                comparison.safe_member(item)

    def test_original_bank_ranges_and_hashes_are_checked(self):
        audio = b"\x00\x01"*700
        clip = {"offset": 0, "size_bytes": len(audio), "key": "a",
                "pcm_sha256": comparison.digest(audio)}
        self.assertEqual(comparison.read_clip(audio, {"a": [0, len(audio)]}, clip), audio)
        for change in ({"offset": -2}, {"offset": 1}, {"size_bytes": len(audio)+2},
                       {"pcm_sha256": "0"*64}):
            with self.subTest(change=change):
                with self.assertRaises(ValueError):
                    comparison.read_clip(audio, {"a": [0, len(audio)]}, dict(clip, **change))
        with self.assertRaises(ValueError):
            comparison.read_clip(audio, {"a": [2, len(audio)-2]}, clip)

    def test_excluded_profiles_are_rejected_before_archive_access(self):
        for profile in comparison.EXCLUDED:
            with self.assertRaisesRegex(ValueError, "allowed"):
                comparison.read_bank(None, profile, {})
        for profile in ("../other", "A", "with-space "):
            with self.assertRaises(ValueError):
                comparison.read_bank(None, profile, {})

    def test_bank_file_is_bound_to_actual_profile(self):
        bank = {"audio": {"name": "other.pcm"}, "index": {"name": "test.json"}}
        with self.assertRaisesRegex(ValueError, "filename"):
            comparison.read_bank(None, "test", bank)

    def test_research_results_never_accept_audio_or_product(self):
        policy = comparison.load_policy(POLICY)
        _, row = comparison.compare_clip(comparison.pcm16(audible()), policy)
        for field in ("activation_allowed", "phonetic_onset_verified", "phonetic_tail_verified",
                      "native_pronunciation_verified", "physical_audio_verified"):
            self.assertFalse(row[field])

    def test_wrong_archive_rejected_without_creating_output(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"wrong.zip"
            path.write_bytes(b"wrong source")
            output = Path(folder)/"new-report"
            with self.assertRaisesRegex(ValueError, "immutable complete"):
                comparison.compare_archive(path, output)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()

