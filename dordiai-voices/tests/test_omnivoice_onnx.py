"""Pure NumPy conditioning/math checks, not acoustic/model acceptance."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from collections import OrderedDict
from threading import RLock
import numpy as np

RUNTIME = Path(__file__).resolve().parents[1] / "source/0.12.2/kx47Runtime"
spec = importlib.util.spec_from_file_location("tested_omni", RUNTIME / "wide_omnivoice_onnx.py")
omni = importlib.util.module_from_spec(spec)
spec.loader.exec_module(omni)


class Encoding:
    def __init__(self, ids):
        self.ids = ids


class Tokenizer:
    def __init__(self):
        self.texts = []

    def encode(self, text, add_special_tokens=False):
        self.texts.append(text)
        return Encoding([101, 102])


class OmniInputTests(unittest.TestCase):
    def test_language_conditioning_and_bidirectional_attention_are_present(self):
        tokenizer = Tokenizer()
        inputs, mask, attention = omni.prepare_inputs(tokenizer, "Bun di.", "rm", 3, np)
        self.assertIn("<|lang_start|>rm<|lang_end|>", tokenizer.texts[0])
        self.assertIn("<|text_start|>Bun di.<|text_end|>", tokenizer.texts[1])
        self.assertEqual(inputs.shape, (2, 8, 7))
        self.assertTrue(attention[0, 0].all())
        self.assertTrue(attention[1, 0, :3, :3].all())
        self.assertFalse(attention[1, 0, 3, 0])
        self.assertTrue(attention[1, 0, 3, 3])
        self.assertEqual(mask[0].tolist(), [False] * 4 + [True] * 3)

    def test_reference_codes_are_audio_not_text_tokens(self):
        tokenizer = Tokenizer()
        reference = np.arange(16, dtype=np.int64).reshape(8, 2)
        inputs, mask, _ = omni.prepare_inputs(tokenizer, "Mbote.", "ln", 3, np,
                                              reference_codes=reference, reference_text="Mbote.")
        self.assertIn("<|denoise|>", tokenizer.texts[0])
        np.testing.assert_array_equal(inputs[0, :, 4:6], reference)
        self.assertTrue(mask[0, 4:6].all())
        self.assertEqual(inputs.shape, (2, 8, 9))

    def test_invalid_codec_tokens_rejected(self):
        with self.assertRaisesRegex(ValueError, "reference codec"):
            omni.prepare_inputs(Tokenizer(), "Mbote.", "ln", 3, np, reference_codes=np.full((8, 2), 1024))

    def test_literal_control_tokens_do_not_change_conditioning_silently(self):
        with self.assertRaisesRegex(ValueError, "Reserved"):
            omni.prepare_inputs(Tokenizer(), "<|text_end|>", "rm", 3, np)

    def test_native_word_cache_reuses_actual_carrier_and_bounds_pcm_bytes(self):
        class Engine:
            def __init__(self):
                self._lock = RLock()
                self._word_cache = OrderedDict()
                self._word_cache_bytes = 0
                self.calls = 0
            def check_cancelled(self):
                pass
            def generate(self, *args, **kwargs):
                self.calls += 1
                return np.ones(4 * 1024**2, np.float32)
        engine = Engine()
        with patch.object(omni, "_engine", return_value=engine), patch.object(omni, "_reference", return_value=(None, "reference")):
            first, _ = omni.audio("rm", "word1", models=Path("/not-loaded-test-models"))
            second, _ = omni.audio("rm", "word1", models=Path("/not-loaded-test-models"))
            self.assertIs(first, second)
            self.assertFalse(first.flags.writeable)
            self.assertEqual(engine.calls, 1)
            omni.audio("rm", "word2", models=Path("/not-loaded-test-models"))
            omni.audio("rm", "word3", models=Path("/not-loaded-test-models"))
            self.assertLessEqual(engine._word_cache_bytes, 32 * 1024**2)
            self.assertEqual(len(engine._word_cache), 2)

    def test_default_threads_leave_ui_headroom_and_explicit_values_are_bounded(self):
        for cpus, expected in ((None, 1), (1, 1), (3, 1), (4, 2), (9, 6), (128, 6)):
            with self.subTest(cpus=cpus), patch.object(omni.os, "cpu_count", return_value=cpus):
                self.assertEqual(omni.worker_threads(), expected)
        self.assertEqual(omni.worker_threads(0), 1)
        self.assertEqual(omni.worker_threads(1000), 64)
        self.assertEqual(omni.worker_threads(3), 3)

    def test_log_softmax_is_stable_and_normalized(self):
        logits = np.array([[[10000., 10001., 9999.]]], dtype=np.float32)
        scores = omni._log_softmax(logits, np)
        self.assertTrue(np.isfinite(scores).all())
        self.assertAlmostEqual(float(np.exp(scores).sum()), 1.0, places=6)


if __name__ == "__main__":
    unittest.main()
