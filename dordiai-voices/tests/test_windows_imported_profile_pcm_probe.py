"""Proof contract tests; actual packaged inference is a separate Windows run."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("imported_pcm_probe", Path(__file__).resolve().parents[1] / "tools/windows_imported_profile_pcm_probe.py")
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class ImportedProfilePCMTests(unittest.TestCase):
    def test_fixture_is_explicit_technical_copy_with_no_audio_banks(self):
        doc = probe.fixture_manifest("1.0.0", b"source", "sara_archive")
        self.assertEqual(doc["id"], "probe_imported_profile")
        self.assertEqual(doc["languages"], ["uk"])
        self.assertIn("not a new person", doc["name"])
        self.assertEqual(list(doc["files"]), ["holos.npy"])
        self.assertEqual(doc["files"]["holos.npy"]["role"], "holos_profile")

    def test_excluded_or_arbitrary_source_cannot_enter_fixture(self):
        for name in (*probe.EXCLUDED, "unreviewed_source"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                probe.fixture_manifest("1.0.0", b"source", name)

    def test_changed_input_is_distinct_checksum(self):
        one = probe.fixture_manifest("1.0.0", b"first", "sara_archive")
        two = probe.fixture_manifest("2.0.0", b"second", "bella")
        self.assertNotEqual(one["files"]["holos.npy"]["sha256"], two["files"]["holos.npy"]["sha256"])

    def test_asset_lookup_or_pcm_alone_is_not_graph_proof(self):
        self.assertFalse(probe.graph_identity_proof([{"kind": "verified_asset", "file_sha256": "x"}], "x"))
        self.assertFalse(probe.graph_identity_proof([{"kind": "pcm", "nonzero_samples": 100}], "x"))

    def test_proof_requires_matching_successful_encoder_prosody_and_decoder(self):
        rows = [{"kind": "successful_onnx_run", "voice_array_sha256": "wanted", "model": name}
                for name in ("encoder.onnx", "prosody.onnx", "decoder_window.onnx")]
        self.assertTrue(probe.graph_identity_proof(rows, "wanted"))
        self.assertFalse(probe.graph_identity_proof(rows[:1], "wanted"))
        self.assertFalse(probe.graph_identity_proof(rows, "other"))
        rows[1]["kind"] = "attempted_onnx_run"
        self.assertFalse(probe.graph_identity_proof(rows, "wanted"))

    def test_observer_calls_original_graph_before_recording_success(self):
        source = probe.OBSERVER
        self.assertLess(source.index("result = original_run("), source.index('record(kind="successful_onnx_run"'))
        self.assertIn("return result", source)
        self.assertNotIn("np.zeros", source)
        self.assertNotIn("input_feed[\"voice\"] =", source)

    def test_output_rejects_same_or_nested_addon(self):
        for output in ("D:/fixture-core", "D:/fixture-core/output"):
            with self.subTest(output=output), self.assertRaises(ValueError):
                probe.owned_output("D:/fixture-core", output)

    def test_output_rejects_non_d_drive(self):
        with self.assertRaises(ValueError):
            probe.owned_output("D:/fixture-core", "C:/temp/forbidden-probe")


if __name__ == "__main__":
    unittest.main()
