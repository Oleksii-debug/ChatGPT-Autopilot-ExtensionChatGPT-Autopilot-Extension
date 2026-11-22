"""Reconstruction tool semantics; no models or network are required for helpers."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("all29_reproduction", ROOT / "tools/probe_mms_all_language_parity.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class ProcedureTests(unittest.TestCase):
    def test_probe_is_explicit_native_graphemes_not_synthetic_translation(self):
        tokens = {"A": 0, "a": 0, "b": 1, "c": 2, "_": 3, " ": 4, "9": 5}
        self.assertEqual(tool.native_probe_text(tokens), "a b c c b a")

    def test_probe_requires_three_distinct_letters(self):
        with self.assertRaises(ValueError):
            tool.native_probe_text({"a": 0, "A": 0, "b": 1, "_": 2})

    def test_probe_limits_to_twenty_and_preserves_id_order(self):
        tokens = {chr(ord("a") + i): 25 - i for i in range(26)}
        expected = list("zyxwvutsrqponmlkjihg")
        self.assertEqual(tool.native_probe_text(tokens).split(), expected + list(reversed(expected)))

    def test_explicit_mode_restores_the_callers_environment(self):
        family = SimpleNamespace(ENVIRONMENT_OPTION="DORDIAI_TEST_REPRO_MODE")
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(family.ENVIRONMENT_OPTION, None)
            with tool.mode(family, True):
                self.assertEqual(os.environ[family.ENVIRONMENT_OPTION], "1")
            self.assertNotIn(family.ENVIRONMENT_OPTION, os.environ)
            os.environ[family.ENVIRONMENT_OPTION] = "prior"
            with tool.mode(family, False):
                self.assertEqual(os.environ[family.ENVIRONMENT_OPTION], "0")
            self.assertEqual(os.environ[family.ENVIRONMENT_OPTION], "prior")

    def test_output_cannot_overwrite_model_inputs_or_existing_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            models = root / "models"
            models.mkdir()
            with self.assertRaises(ValueError):
                tool.validate_output(models / "model.json", (models,), overwrite=True)
            report = root / "report.json"
            report.write_text("old report", encoding="utf-8")
            with self.assertRaises(FileExistsError):
                tool.validate_output(report, (models,), overwrite=False)
            self.assertEqual(tool.validate_output(report, (models,), overwrite=True), report.resolve())


sys.path.insert(0, str(ROOT / "source/0.12.2/kx47Runtime"))
import voice_policy


class TargetPolicyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.target = self.root / "vector.npy"
        self.target.write_bytes(b"existing embedding bytes; shape checked later by real inference tool")
        self.args = SimpleNamespace(target_profile="future_voice_50", target_embedding=self.target,
                                    target_metadata=None, voice_references=None)
        self.assets = SimpleNamespace(INDEX_NAME="voice-packages.json",
                                      asset_path=lambda *a, **k: None, discover_voices=lambda _: {})

    def bind(self):
        return tool.target_identity(self.args, self.target.resolve(), voice_policy, self.assets)

    def test_future_allowed_profile_is_not_restricted_to_the_old_catalogue(self):
        binding = self.bind()
        self.assertEqual(binding["declared_profile_id"], "future_voice_50")
        self.assertEqual(binding["binding_kind"], "caller-declared-profile-and-exact-file-hash")
        self.assertFalse(binding["acoustic_speaker_identity_verified"])

    def test_all_eight_excluded_declared_profiles_are_rejected(self):
        self.assertEqual(len(voice_policy.EXCLUDED_VOICE_IDS), 8)
        for profile in voice_policy.EXCLUDED_VOICE_IDS:
            with self.subTest(profile=profile):
                self.args.target_profile = profile
                with self.assertRaises(ValueError):
                    self.bind()

    def test_obvious_excluded_embedding_basename_is_rejected_with_allowed_label(self):
        for profile in voice_policy.EXCLUDED_VOICE_IDS:
            with self.subTest(profile=profile):
                target = self.root / (profile + ".npy")
                target.write_bytes(self.target.read_bytes())
                self.args.target_embedding = target
                with self.assertRaises(ValueError):
                    tool.target_identity(self.args, target.resolve(), voice_policy, self.assets)

    def test_blocked_source_identity_in_sidecar_cannot_hide_behind_allowed_label(self):
        sidecar = self.target.with_suffix(".json")
        sidecar.write_text('{"profile_id":"future_voice_50","provenance":{"source_voice_id":"veronika"}}', encoding="utf-8")
        with self.assertRaises(ValueError):
            self.bind()

    def test_metadata_profile_and_embedding_hash_must_match(self):
        sidecar = self.target.with_suffix(".json")
        for value in ('{"profile_id":"another_allowed_voice"}', '{"embedding_sha256":"' + "0" * 64 + '"}'):
            with self.subTest(metadata=value):
                sidecar.write_text(value, encoding="utf-8")
                with self.assertRaises(ValueError):
                    self.bind()

    def managed_asset(self, matching):
        references = self.root / "references"
        directory = references / "packages/future_voice_50/1.0.0"
        directory.mkdir(parents=True)
        managed = directory / "embedding.npy"
        managed.write_bytes(self.target.read_bytes() if matching else b"different speaker embedding")
        manifest = {"id": "future_voice_50", "version": "1.0.0",
                    "engine": {"id": "openvoice", "compatibility_version": 1},
                    "provenance": {"source": "new permitted user profile"}}
        import json
        (directory / "voice-package.json").write_text(json.dumps(manifest), encoding="utf-8")
        document = dict(manifest, directory=str(directory))
        self.args.voice_references = references
        calls = []
        def resolve(root, profile, role, *, required):
            calls.append((root, profile, role, required))
            return managed
        self.assets = SimpleNamespace(INDEX_NAME="voice-packages.json", asset_path=resolve,
                                      discover_voices=lambda _: {"future_voice_50": document})
        return calls

    def test_active_managed_asset_hash_binds_new_profile_and_generic_embedding_name(self):
        calls = self.managed_asset(matching=True)
        binding = self.bind()
        self.assertEqual(binding["binding_kind"], "active-managed-profile-and-verified-asset-hash")
        self.assertEqual(calls[0][1:], ("future_voice_50", "target_embedding", True))
        self.assertEqual(binding["managed_profile"]["verified_embedding_sha256"], tool.digest(self.target))
        self.assertFalse(binding["acoustic_speaker_identity_verified"])

    def test_active_profile_cannot_be_claimed_for_other_embedding_bytes(self):
        self.managed_asset(matching=False)
        with self.assertRaises(ValueError):
            self.bind()


try:
    import numpy as np
except ImportError:
    np = None


@unittest.skipUnless(np is not None, "NumPy required for waveform comparisons")
class NumericalSemanticsTests(unittest.TestCase):
    def test_actual_float_and_pcm_bit_equality_is_reported(self):
        first = np.full(64, .1, dtype=np.float32)
        result = tool.parity(first, first.copy())
        self.assertTrue(result["float32_bitwise_equal"])
        self.assertTrue(result["pcm16_bitwise_equal"])
        self.assertTrue(result["numerical_guard_passed"])
        self.assertEqual(result["max_float_error"], 0.)
        self.assertEqual(result["pcm16_max_lsb_difference"], 0)

    def test_negative_zero_is_not_claimed_to_be_bit_identical(self):
        first = np.full(64, .1, dtype=np.float32)
        first[0] = np.float32(-0.)
        second = first.copy()
        second[0] = np.float32(0.)
        result = tool.parity(first, second)
        self.assertFalse(result["float32_bitwise_equal"])
        self.assertTrue(result["pcm16_bitwise_equal"])
        self.assertTrue(result["numerical_guard_passed"])

    def test_waveform_differences_and_invalid_audio_are_not_hidden(self):
        first = np.full(64, .1, dtype=np.float32)
        second = first.copy()
        second[0] += np.float32(.01)
        self.assertFalse(tool.parity(first, second)["numerical_guard_passed"])
        for invalid in (first.astype(np.float64), np.zeros(64, np.float32),
                        np.full(64, np.nan, np.float32), first.reshape(2, 32)):
            with self.subTest(shape=invalid.shape, dtype=str(invalid.dtype)):
                with self.assertRaises(ValueError):
                    tool.parity(first, invalid)


if __name__ == "__main__":
    unittest.main()
