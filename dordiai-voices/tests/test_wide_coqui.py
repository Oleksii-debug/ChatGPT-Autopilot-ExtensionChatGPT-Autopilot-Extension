"""Native Coqui token IDs, standard isolation and actual optional graph checks."""
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
sys.path.insert(0, str(RUNTIME))
from wide_coqui_onnx import CoquiFrontend, NativeCoqui
from wide_mms import UnsupportedMMSInput

CONFIG = {"engine": "coqui", "phoneme_type": "graphemes", "lang_code": "ig", "audio": {"sample_rate": 22050},
          "num_speakers": 1, "num_langs": 1, "use_eos_bos": False, "add_blank_char": True,
          "blank_at_start": True, "blank_at_end": True, "blank": "<BLNK>", "fold_compounds": True,
          "phoneme_id_map": {"<PAD>": 0, "<EOS>": 1, "<BOS>": 2, "<BLNK>": 3,
                             "a": 4, "b": 5, " ": 6, "-": 7, "'": 8, ".": 9}}


class FrontendTests(unittest.TestCase):
    def test_coqui_uses_its_own_blank_not_mms_zero(self):
        frontend = CoquiFrontend(CONFIG)
        self.assertEqual(frontend.ids("ab"), [3, 4, 3, 5, 3])
        alternate = dict(CONFIG, phoneme_id_map=dict(CONFIG["phoneme_id_map"], **{"<BLNK>": 75}))
        self.assertEqual(CoquiFrontend(alternate).ids("ab"), [75, 4, 75, 5, 75])

    def test_trained_punctuation_is_retained(self):
        self.assertEqual(CoquiFrontend(CONFIG).ids("ab."), [3, 4, 3, 5, 3, 9, 3])

    def test_export_compound_policy_and_word_apostrophe(self):
        frontend = CoquiFrontend(CONFIG)
        self.assertEqual(frontend.ids("a-b"), frontend.ids("a b"))
        self.assertEqual(frontend.ids("'ab"), frontend.ids("ab"))
        self.assertIn(8, frontend.ids("a'b"))
        self.assertNotIn(7, frontend.ids("a-b"))

    def test_foreign_graphemes_are_not_faked(self):
        with self.assertRaises(UnsupportedMMSInput):
            CoquiFrontend(CONFIG).ids("abж")

    def test_unverified_letter_names_are_not_phonemes(self):
        with self.assertRaises(UnsupportedMMSInput):
            CoquiFrontend(CONFIG).ids("a", character=True)
        named = dict(CONFIG, navigation={"letters": {"a": "ab"}})
        self.assertEqual(CoquiFrontend(named).ids("a", character=True), CoquiFrontend(named).ids("ab"))

    def test_other_frontend_and_multispeaker_configs_rejected(self):
        for changes in ({"engine": "transformers"}, {"lang_code": "xh"}, {"num_speakers": 2},
                        {"use_eos_bos": True}, {"blank_at_end": False}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                CoquiFrontend(dict(CONFIG, **changes))


class GraphContractTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        (self.folder / "config.json").write_text(json.dumps(CONFIG))
        (self.folder / "runtime_config.json").write_text(json.dumps({"format": "dordiai-coqui-onnx-v1", "code": "ig",
                                                                    "iso_code": "ibo", "sample_rate": 22050}))

    def test_actual_graph_contract_and_close(self):
        graph = SimpleNamespace(get_inputs=lambda: [SimpleNamespace(name=name, type=kind) for name, kind in
                                  (("input", "tensor(int64)"), ("input_lengths", "tensor(int64)"), ("scales", "tensor(float)"))])
        carrier = NativeCoqui(self.folder, session_factory=lambda _: graph)
        self.assertIs(carrier.preload(), graph)
        self.assertEqual(carrier.rate, 22050)
        carrier.close()
        with self.assertRaises(RuntimeError):
            carrier.preload()

    def test_wrong_prepared_language_standard_rejected(self):
        path = self.folder / "runtime_config.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        value["iso_code"] = "lin"
        path.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            NativeCoqui(self.folder)

    def test_unexpected_graph_signature_rejected(self):
        graph = SimpleNamespace(get_inputs=lambda: [SimpleNamespace(name="input_ids", type="tensor(int64)")])
        carrier = NativeCoqui(self.folder, session_factory=lambda _: graph)
        with self.assertRaises(ValueError):
            carrier.preload()


class SourceIndexTests(unittest.TestCase):
    def test_actual_models_and_configs_are_pinned(self):
        index = json.loads((ROOT / "tools/coqui_model_sources.json").read_text(encoding="utf-8"))
        self.assertEqual(set(index["models"]), {"ig", "ln"})
        for code, row in index["models"].items():
            self.assertEqual(row["license"], "cc-by-sa-4.0")
            model = row["assets"]["model.onnx"]
            self.assertEqual(len(model["sha256"]), 64)
            self.assertIn("/" + row["revision"] + "/", model["url"])


try:
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
except ImportError:
    np = ort = None


@unittest.skipUnless(ort is not None and (ROOT / "model-packs/coqui/kx47Runtime/models/ExtraLanguages/ig/source.npy").is_file(),
                     "Actual optional Coqui models and ONNX Runtime are required")
class RealModelTests(unittest.TestCase):
    def test_native_graphs_determinism_rate_and_actual_source(self):
        for code in ("ig", "ln"):
            with self.subTest(code=code):
                folder = ROOT / "model-packs/coqui/kx47Runtime/models/ExtraLanguages" / code
                carrier = NativeCoqui(folder)
                first = carrier.audio("aba", noise_scale=0., noise_scale_w=0.)
                repeated = carrier.audio("aba", noise_scale=0., noise_scale_w=0.)
                faster = carrier.audio("aba", rate=2., noise_scale=0., noise_scale_w=0.)
                np.testing.assert_array_equal(first, repeated)
                self.assertTrue(np.isfinite(first).all())
                self.assertGreater(float(np.max(np.abs(first))), .001)
                self.assertLess(len(faster), len(first))
                source = np.load(folder / "source.npy", allow_pickle=False)
                self.assertEqual(source.shape, (1, 256, 1))
                self.assertEqual(source.dtype, np.float32)
                metadata = json.loads((folder / "runtime_config.json").read_text(encoding="utf-8"))
                self.assertEqual(metadata["source_identity"]["source_sha256"], sha256((folder / "source.npy").read_bytes()).hexdigest())
                self.assertFalse(metadata["native_pronunciation_verified"])
                self.assertFalse(metadata["windows_nvda_verified"])
                carrier.close()


if __name__ == "__main__":
    unittest.main()
