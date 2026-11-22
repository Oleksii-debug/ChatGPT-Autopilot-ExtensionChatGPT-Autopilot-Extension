"""Actual PCM16 reference I/O without soundfile or another native audio DLL."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
import wave
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("afri_ort_wave", ROOT / "tools/research/afri_six_ort_probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class PcmReferenceTests(unittest.TestCase):
    def test_actual_pcm16_scaling_and_stereo_mean(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "native.wav"
            with wave.open(str(path), "wb") as output:
                output.setnchannels(2)
                output.setsampwidth(2)
                output.setframerate(24000)
                output.writeframes(struct.pack("<hhhhhh", -32768, 32767, 0, 16384, -16384, -16384))
            audio, rate, facts = probe.read_reference_wav(path)
            np.testing.assert_array_equal(audio, np.array([-1. / 65536., .25, -.5], np.float32))
            self.assertEqual(rate, 24000)
            self.assertEqual(facts["sample_width"], 2)
            self.assertEqual(facts["frames"], 3)

    def test_declared_frames_cannot_hide_truncated_pcm(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "truncated.wav"
            with wave.open(str(path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(24000)
                output.writeframes(b"\0\0" * 4)
            raw = path.read_bytes()
            path.write_bytes(raw[:-2])
            with self.assertRaisesRegex(ValueError, "Truncated"):
                probe.read_reference_wav(path)

    def test_pcm_output_is_finite_and_unsupported_reference_format_is_explicit(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaisesRegex(ValueError, "nonfinite"):
                probe.write_pcm16_wav(root / "invalid.wav", np.array([np.nan], np.float32), 24000)
            self.assertFalse((root / "invalid.wav").exists())
            probe.write_pcm16_wav(root / "valid.wav", np.array([-.5, 0, .5], np.float32), 24000)
            actual, _, _ = probe.read_reference_wav(root / "valid.wav")
            np.testing.assert_array_equal(actual, np.array([-.5, 0, .5], np.float32))
            with wave.open(str(root / "unsupported.wav"), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(1)
                output.setframerate(24000)
                output.writeframes(b"\x80")
            with self.assertRaisesRegex(ValueError, "Unsupported"):
                probe.read_reference_wav(root / "unsupported.wav")


if __name__ == "__main__":
    unittest.main()
