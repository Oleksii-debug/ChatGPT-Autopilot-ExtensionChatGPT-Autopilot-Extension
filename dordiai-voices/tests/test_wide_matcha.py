"""Native Kashmiri token preservation, graph identity and actual optional PCM."""
import importlib.util
import json
from hashlib import sha256
from pathlib import Path
import sys
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
sys.path.insert(0, str(RUNTIME))
from wide_matcha import MatchaFrontend, NativeMatcha, FORMAT
from wide_mms import UnsupportedMMSInput

FIXTURE = ROOT / "tests/fixtures/matcha_ks_frontend.json"
CONFIG = json.loads(FIXTURE.read_text(encoding="utf-8"))
META = {"format": FORMAT, "code": "ks", "iso_code": "kas", "sample_rate": 22050,
        "steps": 10, "speaker": 422, "temperature": .667}


class NativeFrontendTests(unittest.TestCase):
    def setUp(self):
        self.frontend = MatchaFrontend(CONFIG)

    def test_actual_native_tokenizer_golden_ids_and_blank_boundaries(self):
        self.assertEqual(self.frontend.ids("آداب۔"), [0, 200, 0, 211, 0, 204, 0, 205, 0, 261, 0])

    def test_duplicate_training_symbols_use_last_id_not_first(self):
        self.assertEqual(len(CONFIG["symbols"]), 272)
        self.assertEqual(len(set(CONFIG["symbols"])), 268)
        self.assertEqual(self.frontend.symbols[" "], 179)
        self.assertNotEqual(self.frontend.symbols[" "], CONFIG["symbols"].index(" "))

    def test_diacritics_and_native_punctuation_are_preserved(self):
        text = "مےٛ چھُ آز سُلۍ وۄستادَس نِش گَژھُن،"
        self.assertEqual(self.frontend.normalized(text), text)
        self.assertNotEqual(self.frontend.ids("چھُ"), self.frontend.ids("چھ"))
        self.assertIn(self.frontend.symbols["،"], self.frontend.ids(text))

    def test_missing_native_alif_cannot_disappear_silently(self):
        # The source-backed digit-eight name also contains this unsupported
        # alif; its expansion must fail rather than become an incorrect name.
        for text in ("ٲ", "کٲشُر", "پانٛژھٲہ", "8", "۸", "٨"):
            with self.subTest(text=text), self.assertRaises(UnsupportedMMSInput):
                self.frontend.ids(text)

    def test_foreign_script_is_rejected_not_romanized(self):
        for text in ("hello", "каша", "ꯈꯨꯔꯨꯝꯖꯔꯤ"):
            with self.subTest(text=text), self.assertRaises(UnsupportedMMSInput):
                self.frontend.ids(text)

    def test_actual_digit_names_for_all_three_digit_forms(self):
        for glyph in ("1", "۱", "١"):
            self.assertEqual(self.frontend.normalized(glyph), "اکھ")
            self.assertEqual(self.frontend.ids(glyph), self.frontend.ids("اکھ"))

    def test_presentation_forms_follow_pinned_mapping(self):
        self.assertEqual(self.frontend.ids("ﺁﺩﺍﺏ۔"), self.frontend.ids("آداب۔"))
        self.assertEqual(self.frontend.ids("ؠ"), self.frontend.ids("ۍ"))

    def test_invalid_or_other_language_frontend_rejected(self):
        for changes in ({"code": "ur"}, {"format": "other"}, {"symbols": CONFIG["symbols"][:-1]}):
            with self.subTest(changes=tuple(changes)), self.assertRaises(ValueError):
                MatchaFrontend(dict(CONFIG, **changes))
        with self.assertRaises(UnsupportedMMSInput):
            self.frontend.ids("\n ")


class GraphContractTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        (self.folder / "config.json").write_text(json.dumps(CONFIG, ensure_ascii=False), encoding="utf-8")
        (self.folder / "runtime_config.json").write_text(json.dumps(META), encoding="utf-8")

    def test_graph_signature_and_close(self):
        graph = SimpleNamespace(get_inputs=lambda: [SimpleNamespace(name=name, type=kind) for name, kind in
            (("x", "tensor(int64)"), ("x_lengths", "tensor(int64)"), ("scales", "tensor(float)"), ("spks", "tensor(int64)"))])
        carrier = NativeMatcha(self.folder, session_factory=lambda _: graph)
        self.assertIs(carrier.preload(), graph)
        self.assertEqual(carrier.rate, 22050)
        carrier.close()
        with self.assertRaises(RuntimeError):
            carrier.preload()

    def test_wrong_language_speaker_sample_rate_or_steps_rejected(self):
        for change in ({"iso_code": "urd"}, {"code": "ur"}, {"sample_rate": 16000}, {"speaker": 0}, {"steps": 5}):
            with self.subTest(change=change):
                (self.folder / "runtime_config.json").write_text(json.dumps(dict(META, **change)), encoding="utf-8")
                with self.assertRaises(ValueError):
                    NativeMatcha(self.folder)

    def test_wrong_input_graph_rejected(self):
        graph = SimpleNamespace(get_inputs=lambda: [SimpleNamespace(name="input_ids", type="tensor(int64)")])
        with self.assertRaises(ValueError):
            NativeMatcha(self.folder, session_factory=lambda _: graph).preload()


class PreparationTests(unittest.TestCase):
    def test_catalogue_can_load_frontend_by_filepath_without_acoustic_packages(self):
        code = ("import importlib.util,json,pathlib; "
                "p=" + repr(str(RUNTIME / "wide_matcha_frontend.py")) + "; "
                "s=importlib.util.spec_from_file_location('isolated_matcha',p); "
                "m=importlib.util.module_from_spec(s);s.loader.exec_module(m); "
                "c=json.loads(pathlib.Path(" + repr(str(FIXTURE)) + ").read_text(encoding='utf-8')); "
                "assert m.MatchaFrontend(c).ids('آداب۔')==[0,200,0,211,0,204,0,205,0,261,0]")
        result = subprocess.run([sys.executable, "-I", "-S", "-c", code], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_native_model_and_normalizer_sources_have_independent_pins(self):
        index = json.loads((ROOT / "tools/matcha_checkpoint_sources.json").read_text(encoding="utf-8"))
        self.assertEqual(index["code"], "ks")
        self.assertEqual(index["iso_code"], "kas")
        self.assertEqual(index["license"], "MIT")
        self.assertIn("/718203e01e0b4ddab3e925445619c69cddeb7231/", index["assets"]["model.ckpt"]["url"])
        self.assertIn(index["normalizer_revision"], index["assets"]["normalizer/src/KashmiriNormalizer/normalizer.py"]["url"])
        self.assertGreater(len(index["assets"]), 10)
        for asset in index["assets"].values():
            self.assertEqual(len(asset["sha256"]), 64)
            self.assertGreaterEqual(asset["size_bytes"], 0)
            self.assertNotIn("/main/", asset["url"])

    def test_offline_preparation_refuses_missing_or_changed_artifacts(self):
        sys.path.insert(0, str(ROOT / "tools"))
        from prepare_matcha_models import download
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "test"
            record = {"url": "https://invalid.example/never-requested", "size_bytes": 1,
                      "sha256": sha256(b"a").hexdigest()}
            with self.assertRaises(FileNotFoundError):
                download(record, path, offline=True)
            path.write_bytes(b"b")
            with self.assertRaises(FileNotFoundError):
                download(record, path, offline=True)
            path.write_bytes(b"a")
            self.assertEqual(download(record, path, offline=True), path)


try:
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
except ImportError:
    np = ort = None

FOLDER = ROOT / "model-packs/matcha/kx47Runtime/models/ExtraLanguages/ks"


@unittest.skipUnless(ort is not None and (FOLDER / "source.npy").is_file(), "Actual optional Kashmiri resources and ORT required")
class ActualModelTests(unittest.TestCase):
    def test_actual_native_pcm_determinism_rate_identity_and_unsupported_letter(self):
        carrier = NativeMatcha(FOLDER)
        self.addCleanup(carrier.close)
        first = carrier.audio("آداب۔", temperature=0.)
        repeat = carrier.audio("آداب۔", temperature=0.)
        faster = carrier.audio("آداب۔", rate=2., temperature=0.)
        np.testing.assert_array_equal(first, repeat)
        self.assertTrue(np.isfinite(first).all())
        self.assertGreater(float(np.max(np.abs(first))), .01)
        self.assertLess(len(faster), len(first))
        vector = np.load(FOLDER / "source.npy", allow_pickle=False)
        self.assertEqual(vector.shape, (1, 256, 1))
        self.assertEqual(vector.dtype, np.float32)
        metadata = json.loads((FOLDER / "runtime_config.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["source_identity"]["source_sha256"], sha256((FOLDER / "source.npy").read_bytes()).hexdigest())
        self.assertFalse(metadata["native_pronunciation_verified"])
        self.assertFalse(metadata["navigation_verified"])
        with self.assertRaises(UnsupportedMMSInput):
            carrier.audio("کٲشُر")
        with self.assertRaises(UnsupportedMMSInput):
            carrier.audio("ب", character=True)


if __name__ == "__main__":
    unittest.main()
