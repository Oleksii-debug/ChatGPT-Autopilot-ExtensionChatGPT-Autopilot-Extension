"""Six-layer checkpoint selection is structural and immutable, without ML imports."""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "tools/research/afri_six_layer_probe.py"
spec = importlib.util.spec_from_file_location("six_layer_research", path)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class StructuralTests(unittest.TestCase):
    def facts(self, *, layers=6, dtype="F32", total=None):
        total = probe.TENSOR_ELEMENTS if total is None else total
        rows = {f"flow_lm.transformer.layers.{i}.linear1.weight":
                {"dtype": dtype, "shape": [total - layers + 1 if i == 0 else 1],
                 "data_offsets": [0, 0]} for i in range(layers)}
        raw = json.dumps(rows).encode()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "header-only.safetensors"
            path.write_bytes(struct.pack("<Q", len(raw)) + raw)
            return probe.header_facts(path)

    def test_exact_six_layer_float32_shape_metadata(self):
        facts = self.facts()
        self.assertEqual(facts["flow_lm_layer_ids"], list(range(6)))
        self.assertEqual(facts["tensor_elements"], 109502146)

    def test_stale_twenty_four_layer_model_is_rejected(self):
        with self.assertRaises(ValueError):
            self.facts(layers=24)

    def test_reduced_precision_or_different_weights_are_rejected(self):
        for args in ({"dtype": "BF16"}, {"total": probe.TENSOR_ELEMENTS - 1}):
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.facts(**args)



if __name__ == "__main__":
    unittest.main()
