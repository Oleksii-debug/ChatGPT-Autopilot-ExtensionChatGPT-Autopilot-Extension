"""Native Sesotho frontend and ONNX input contract, without model downloads."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
sys.path.insert(0, str(RUNTIME))
from wide_simba import NativeSimba, SimbaFrontend

VOCAB = {"h": 0, "a": 20, "e": 27, "l": 5, "o": 8, "-": 18, "'": 4, " ": 26}
TOKENIZER = {"pad_token": "h", "add_blank": True, "phonemize": False, "is_uroman": False}


class SimbaTests(unittest.TestCase):
    def test_special_pad_h_matches_transformers_boundary_behavior(self):
        frontend = SimbaFrontend(VOCAB, TOKENIZER)
        self.assertEqual([0], frontend.ids("h"))
        self.assertEqual([0, 0, 27, 0, 5, 0, 5, 0, 8, 0], frontend.ids("hello"))
        self.assertEqual([0, 20, 0, 0], frontend.ids("ah"))
        self.assertEqual([0, 20, 0, 0, 0, 20, 0], frontend.ids("aha"))

    def test_hyphen_apostrophe_are_kept_and_semicolon_does_not_split_requests(self):
        frontend = SimbaFrontend(VOCAB, TOKENIZER)
        ids = frontend.ids("'a-a")
        self.assertIn(4, ids)
        self.assertIn(18, ids)
        self.assertEqual(frontend.ids("ae"), frontend.ids("a;e"))
        self.assertEqual(frontend.ids("a a"), frontend.ids("a\na"))

    def test_unprepared_native_character_names_and_numbers_fail_explicitly(self):
        frontend = SimbaFrontend(VOCAB, TOKENIZER)
        for text in ("é", "5", "Ж"):
            with self.assertRaisesRegex(ValueError, "Unsupported native"):
                frontend.ids(text)
        with self.assertRaisesRegex(ValueError, "character names"):
            frontend.ids("a", character=True)

    def test_native_model_uses_exact_transformer_inputs_and_length_scale(self):
        class Graph:
            def get_inputs(self):
                return [SimpleNamespace(name=name, type="tensor(int64)") for name in ("input_ids", "attention_mask")] + [SimpleNamespace(name="scales", type="tensor(float)")]
            def run(self, outputs, values):
                self.outputs, self.values = outputs, values
                return [np.full((1, 100), .25, np.float32)]
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            for name, data in (("runtime_config.json", {"format": "dordiai-simba-onnx-v1", "code": "st", "iso_code": "sot", "sample_rate": 16000}),
                               ("upstream-vocab.json", VOCAB), ("upstream-tokenizer_config.json", TOKENIZER)):
                folder.joinpath(name).write_text(json.dumps(data))
            graph = Graph()
            native = NativeSimba(folder, session_factory=lambda path: graph)
            audio = native.audio("hello", rate=2.)
            self.assertEqual((100,), audio.shape)
            self.assertEqual(["waveform"], graph.outputs)
            self.assertTrue(np.array_equal(graph.values["attention_mask"], np.ones_like(graph.values["input_ids"])))
            self.assertEqual(np.int64, graph.values["input_ids"].dtype)
            self.assertAlmostEqual(.5, float(graph.values["scales"][1]))
            self.assertEqual(16000, native.rate)
            with patch("character_names.spoken_name", return_value="hello") as names:
                native.audio("a", character=True)
                self.assertEqual([[0, 0, 27, 0, 5, 0, 5, 0, 8, 0]], graph.values["input_ids"].tolist())
                names.assert_called_once_with("st", "a", directory=folder.parents[1] / "CharacterNames")
            with patch("character_names.spoken_name", side_effect=LookupError("No native name")):
                with self.assertRaisesRegex(ValueError, "character names"):
                    native.audio("a", character=True)


if __name__ == "__main__":
    unittest.main()
