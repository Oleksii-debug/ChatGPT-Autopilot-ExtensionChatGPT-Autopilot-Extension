"""Northern Ndebele safe export evidence and independent tokenizer compatibility."""
from hashlib import sha256
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "source/0.12.2/kx47Runtime"))
from wide_coqui_onnx import CoquiFrontend, NativeCoqui


class ExportEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = json.loads((ROOT / "tools/ndebele_checkpoint_sources.json").read_text(encoding="utf-8"))
        cls.evidence = json.loads((ROOT / "evidence/ndebele_export.json").read_text(encoding="utf-8"))
        cls.frontend = json.loads((ROOT / "evidence/ndebele_frontend.json").read_text(encoding="utf-8"))

    def test_source_is_exact_northern_standard_and_client_graph_is_compact(self):
        self.assertEqual(self.index["language"], "nd")
        self.assertEqual(self.index["iso_code"], "nde")
        self.assertEqual(self.evidence["checkpoint_sha256"], self.index["assets"]["model_last.pth"]["sha256"])
        self.assertLess(self.evidence["model_bytes"], self.index["assets"]["model_last.pth"]["bytes"] / 4)
        self.assertEqual(self.evidence["license"], "cc-by-sa-4.0")
        self.assertEqual(self.frontend["lang_code"], "nd")
        with self.assertRaises(ValueError):
            CoquiFrontend(dict(self.frontend, lang_code="nr"))

    def test_safe_real_state_load_and_unconditioned_speaker_evidence(self):
        inspection = json.loads((ROOT / "evidence/ndebele_checkpoint_inspection.json").read_text(encoding="utf-8"))
        self.assertTrue(inspection["safety"]["weights_only"])
        self.assertTrue(inspection["safety"]["mmap"])
        self.assertEqual(inspection["safety"]["unsafe_pickle_globals"], [])
        self.assertIsNone(inspection["speaker_embedding_shape"])
        self.assertEqual(self.evidence["speaker_conditioning"], "none-in-trained-state")
        self.assertFalse(self.evidence["selectable_original_speakers_exposed"])
        self.assertTrue(self.evidence["strict_inference_state_loaded"])
        self.assertFalse(self.evidence["training_discriminator_initialised"])
        self.assertFalse(self.evidence["speaker_encoder_loss_initialised"])

    def test_runtime_matches_independently_recorded_coqui_tokenizer_ids(self):
        frontend = CoquiFrontend(self.frontend)
        rows = self.evidence["dynamic_length_parity"]
        self.assertGreaterEqual(len(rows), 5)
        self.assertLessEqual(min(row["tokens"] for row in rows), 3)
        self.assertGreaterEqual(max(row["tokens"] for row in rows), 80)
        for row in rows:
            with self.subTest(text=row["text"]):
                self.assertEqual(frontend.ids(row["text"]), row["token_ids"])
                self.assertEqual(len(row["token_ids"]), row["tokens"])
                self.assertTrue(row["zero_noise_bitwise_deterministic"])
                self.assertLess(row["torch_onnx_max_abs"], .005)
                self.assertGreater(row["torch_onnx_cosine"], .999)
                self.assertLess(row["samples_2x"], row["samples"])


try:
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
except ImportError:
    np = ort = None


@unittest.skipUnless(ort is not None and (ROOT / "model-packs/ndebele/kx47Runtime/models/ExtraLanguages/nd/source.npy").is_file(),
                     "Prepared Northern Ndebele model and ONNX Runtime required")
class ActualRuntimeTests(unittest.TestCase):
    def test_actual_export_has_dynamic_length_and_measured_identity(self):
        folder = ROOT / "model-packs/ndebele/kx47Runtime/models/ExtraLanguages/nd"
        carrier = NativeCoqui(folder)
        samples = []
        for text in ("a", "umuntu", "abantu bonke"):
            audio = carrier.audio(text, noise_scale=0., noise_scale_w=0.)
            repeated = carrier.audio(text, noise_scale=0., noise_scale_w=0.)
            np.testing.assert_array_equal(audio, repeated)
            self.assertTrue(np.isfinite(audio).all())
            self.assertGreater(float(np.max(np.abs(audio))), .001)
            samples.append(len(audio))
        self.assertEqual(len(set(samples)), len(samples))
        metadata = json.loads((folder / "runtime_config.json").read_text(encoding="utf-8"))
        source = np.load(folder / "source.npy", allow_pickle=False)
        self.assertEqual(source.shape, (1, 256, 1))
        self.assertEqual(source.dtype, np.float32)
        self.assertEqual(sha256((folder / "source.npy").read_bytes()).hexdigest(), metadata["source_identity"]["source_sha256"])
        self.assertFalse(metadata["native_pronunciation_verified"])
        self.assertFalse(metadata["windows_nvda_verified"])
        carrier.close()


if __name__ == "__main__":
    unittest.main()
