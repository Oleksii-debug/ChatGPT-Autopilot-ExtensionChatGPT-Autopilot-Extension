"""Rasa native speaker/script/shape contracts; fixtures are not acoustic proofs."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
sys.path.insert(0, str(RUNTIME))
import wide_rasa as rasa


class Graph:
    def get_inputs(self):
        return [SimpleNamespace(name=name, type="tensor(int64)", shape=["N", "L"] if name == "x" else ["N"])
                for name in ("x", "x_length", "sid", "emotion_id")] + [
                SimpleNamespace(name=name, type="tensor(float)", shape=[]) for name in ("noise_scale", "length_scale", "noise_scale_w")]
    def get_modelmeta(self):
        return SimpleNamespace(custom_metadata_map={"comment": "ai4bharat/vits_rasa_13", "frontend": "characters", "add_blank": "1",
                               "sample_rate": "24000", "n_speakers": "1024", "num_emotions": "32"})
    def run(self, outputs, feed):
        self.calls.append((outputs, feed))
        return [np.full((1, 1, 2400), .2, np.float32)]
    def __init__(self):
        self.calls = []


class RasaTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.folder.joinpath("tokens.txt").write_text("  16\n_ 95\nख 170\nक 169\n। 248\n", encoding="utf-8")
        self.configuration = {"format": rasa.FORMAT, "sample_rate": 24000, "frontend": "native-characters", "languages": rasa.SUPPORTED}
        self.folder.joinpath("config.json").write_text(json.dumps(self.configuration))

    def test_blank_zero_is_not_literal_underscore_95(self):
        values = rasa.native_ids("ख", rasa.read_tokens(self.folder / "tokens.txt"))
        self.assertEqual([0, 170, 0], values)

    def test_no_meitei_latin_or_unprepared_numbers_are_silently_romanized(self):
        tokens = rasa.read_tokens(self.folder / "tokens.txt")
        for text in ("ꯈꯨꯔꯨꯝ", "hello", "क2", "क२"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                rasa.native_ids(text, tokens)
        with self.assertRaisesRegex(ValueError, "No native Bodo letters"):
            rasa.native_ids("।", tokens)

    def test_required_seventh_style_input_and_scalar_noise_have_actual_shapes(self):
        graph = Graph()
        engine = rasa.RasaEngine(self.folder, session_factory=lambda path: graph)
        self.addCleanup(engine.close)
        wave = engine.audio("brx", "ख।", rate=2.)
        self.assertEqual((2400,), wave.shape)
        self.assertEqual(1, len(graph.calls), "No extra punctuation-only model call")
        outputs, feed = graph.calls[0]
        self.assertEqual(["y"], outputs)
        self.assertEqual([4], feed["sid"].tolist())
        self.assertEqual([0], feed["emotion_id"].tolist())
        self.assertEqual((), feed["length_scale"].shape)
        self.assertEqual(.5, float(feed["length_scale"]))
        self.assertEqual([[0, 170, 0, 248, 0]], feed["x"].tolist())
        with self.assertRaisesRegex(ValueError, "no registered trained speaker"):
            engine.audio("mni", "ख")

    def test_wrong_speaker_or_sample_rate_cannot_be_labeled_bodo(self):
        self.configuration["sample_rate"] = 22050
        self.folder.joinpath("config.json").write_text(json.dumps(self.configuration))
        with self.assertRaisesRegex(ValueError, "registration"):
            rasa.RasaEngine(self.folder, session_factory=lambda path: Graph())
        self.configuration["sample_rate"] = 24000
        self.configuration["languages"] = {"brx": dict(rasa.SUPPORTED["brx"], speaker_id=0)}
        self.folder.joinpath("config.json").write_text(json.dumps(self.configuration))
        with self.assertRaisesRegex(ValueError, "registration"):
            rasa.RasaEngine(self.folder, session_factory=lambda path: Graph())

    def test_a_six_input_graph_is_rejected_instead_of_ignoring_emotion(self):
        graph = Graph()
        original = graph.get_inputs
        graph.get_inputs = lambda: [item for item in original() if item.name != "emotion_id"]
        with self.assertRaisesRegex(ValueError, "seven-input"):
            rasa.RasaEngine(self.folder, session_factory=lambda path: graph)


if __name__ == "__main__":
    unittest.main()
