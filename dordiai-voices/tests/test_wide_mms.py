"""Native-script MMS token/graph contracts and actual optional model smoke test."""
import gc
from hashlib import sha1, sha256
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from threading import Event, Thread
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import weakref

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
sys.path.insert(0, str(RUNTIME))


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mms = load(RUNTIME / "wide_mms.py", "test_mms_runtime")
preparation = load(ROOT / "tools/prepare_mms_models.py", "test_mms_preparation")
CONFIG = {"format": mms.MODEL_FORMAT, "frontend": "characters", "code": "ha", "iso_code": "hau",
          "sample_rate": 16000, "add_blank": True, "blank_id": 0, "is_uroman": False}
TOKENS = {"d": 0, "_": 1, "s": 2, "a": 3, "n": 4, "u": 5, " ": 6, "6": 7}


class FrontendTests(unittest.TestCase):
    def test_zero_blank_is_not_underscore_token(self):
        frontend = mms.MMSFrontend(CONFIG, TOKENS)
        self.assertEqual(frontend.ids("sanu"), [0, 2, 0, 3, 0, 4, 0, 5, 0])

    def test_space_token_and_uppercase_aliases_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tokens.txt"
            path.write_text("d 0\nD 0\n_ 1\n  2\n", encoding="utf8")
            self.assertEqual(mms.read_tokens(path), {"d": 0, "D": 0, "_": 1, " ": 2})

    def test_conflicting_or_negative_tokens_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tokens.txt"
            for invalid in ("a 0\na 1\n", "a -1\n", "malformed\n"):
                path.write_text(invalid, encoding="utf8")
                with self.assertRaises(ValueError):
                    mms.read_tokens(path)

    def test_punctuation_keeps_word_boundary(self):
        frontend = mms.MMSFrontend(CONFIG, TOKENS)
        self.assertEqual(frontend.text("SANU.sanu!"), "sanu sanu")

    def test_foreign_letters_are_not_silently_dropped(self):
        frontend = mms.MMSFrontend(CONFIG, TOKENS)
        with self.assertRaises(mms.UnsupportedMMSInput):
            frontend.ids("sanu українська")

    def test_unverified_letter_names_fail_instead_of_hissing(self):
        frontend = mms.MMSFrontend(CONFIG, TOKENS)
        with self.assertRaises(mms.UnsupportedMMSInput):
            frontend.ids("s", character=True)

    def test_installed_character_name_uses_same_native_vocabulary(self):
        frontend = mms.MMSFrontend(dict(CONFIG, navigation={"letters": {"s": "sanu"}}), TOKENS)
        self.assertEqual(frontend.ids("s", character=True), frontend.ids("sanu"))

    def test_digit_in_vocabulary_does_not_claim_number_reading(self):
        frontend = mms.MMSFrontend(CONFIG, TOKENS)
        with self.assertRaises(mms.UnsupportedMMSInput):
            frontend.ids("6")

    def test_native_digits_explicitly_installed(self):
        frontend = mms.MMSFrontend(dict(CONFIG, navigation={"digits": ["sanu"] * 10}), TOKENS)
        self.assertEqual(frontend.ids("٦", character=True), frontend.ids("sanu"))

    def test_native_script_without_romanization(self):
        tokens = {"្": 0, "ក": 1, "ម": 2, " ": 3}
        frontend = mms.MMSFrontend(dict(CONFIG, code="km", iso_code="khm"), tokens)
        self.assertEqual(frontend.ids("ក្ម"), [0, 1, 0, 0, 0, 2, 0])
        with self.assertRaises(ValueError):
            mms.MMSFrontend(dict(CONFIG, is_uroman=True), TOKENS)

    def test_explicit_no_blank_configuration(self):
        frontend = mms.MMSFrontend(dict(CONFIG, add_blank=False), TOKENS)
        self.assertEqual(frontend.ids("sanu"), [2, 3, 4, 5])

    def test_unsupported_punctuation_only_is_not_false_audio(self):
        with self.assertRaises(mms.UnsupportedMMSInput):
            mms.MMSFrontend(CONFIG, TOKENS).ids("!!!")


class GraphContractTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        (self.folder / "config.json").write_text(json.dumps(CONFIG), encoding="utf8")
        (self.folder / "tokens.txt").write_text("d 0\n_ 1\ns 2\na 3\nn 4\nu 5\n  6\n", encoding="utf8")

    def graph(self, **metadata_changes):
        metadata = dict(comment="mms", frontend="characters", sample_rate="16000", add_blank="1")
        metadata.update(metadata_changes)
        return SimpleNamespace(
            get_inputs=lambda: [SimpleNamespace(name=name, type="tensor(int64)" if name in {"x", "x_length"} else "tensor(float)")
                                for name in ("x", "x_length", "noise_scale", "length_scale", "noise_scale_w")],
            get_modelmeta=lambda: SimpleNamespace(custom_metadata_map=metadata),
        )

    def test_real_native_graph_contract_is_checked(self):
        graph = self.graph()
        carrier = mms.MMSCarrier(self.folder, session_factory=lambda _: graph)
        self.assertIs(carrier.preload(), graph)
        for change in ({"frontend": "espeak"}, {"sample_rate": "22050"}, {"add_blank": "0"}):
            invalid = mms.MMSCarrier(self.folder, session_factory=lambda _, c=change: self.graph(**c))
            with self.assertRaises(ValueError):
                invalid.preload()

    def test_closed_carrier_does_not_reopen(self):
        carrier = mms.MMSCarrier(self.folder, session_factory=lambda _: self.fail("Closed carrier must not load"))
        carrier.close()
        with self.assertRaises(RuntimeError):
            carrier.preload()

    def test_close_during_cold_constructor_discards_graph(self):
        entered, release = Event(), Event()
        references, errors = [], []
        class Graph:
            pass
        def factory(_):
            value = Graph()
            value.get_inputs = self.graph().get_inputs
            value.get_modelmeta = self.graph().get_modelmeta
            references.append(weakref.ref(value))
            entered.set()
            release.wait(3)
            return value
        carrier = mms.MMSCarrier(self.folder, session_factory=factory)
        def run():
            try:
                carrier.preload()
            except RuntimeError as error:
                errors.append(str(error))
        thread = Thread(target=run)
        thread.start()
        self.assertTrue(entered.wait(2))
        carrier.close()
        release.set()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertTrue(errors)
        self.assertIsNone(carrier._graph)
        gc.collect()
        self.assertIsNone(references[0]())

    def test_language_cannot_be_substituted(self):
        (self.folder / "config.json").write_text(json.dumps(dict(CONFIG, iso_code="eng")))
        with self.assertRaises(ValueError):
            mms.MMSCarrier(self.folder)
        self.assertNotIn("tamazight", mms.SUPPORTED)
        self.assertEqual(mms.SUPPORTED["kab"], "kab")


class ProvenanceTests(unittest.TestCase):
    def test_small_git_blob_and_large_lfs_digest_policies(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tokens.txt"
            value = b"a 0\n  1\n"
            path.write_bytes(value)
            git_sha = sha1(b"blob " + str(len(value)).encode("ascii") + b"\0" + value).hexdigest()
            self.assertTrue(preparation.verified(path, {"bytes": len(value), "git_blob_sha1": git_sha}))
            self.assertTrue(preparation.verified(path, {"bytes": len(value), "sha256": sha256(value).hexdigest(),
                                                      "git_blob_sha1": "pointer-sha-not-content"}))
            self.assertFalse(preparation.verified(path, {"bytes": len(value), "sha256": "0" * 64}))

    def test_offline_missing_artifact_never_opens_http(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(preparation, "urlopen", side_effect=AssertionError("Offline verification must not open HTTP")):
                with self.assertRaises(FileNotFoundError):
                    preparation.download({"bytes": 10, "sha256": "0" * 64}, Path(directory) / "model.onnx", offline=True)

    def test_download_only_does_not_import_or_execute_onnx_runtime(self):
        import builtins
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            model_dir = folder / "models/ha"
            model_dir.mkdir(parents=True)
            content = b"pinned test artifact"
            (model_dir / "model.onnx").write_bytes(content)
            index = {"format": "dordiai-mms-sources-v1", "repository": "test/source", "revision": "test",
                     "license": "test", "models": {"ha": {"iso_code": "hau", "assets": {"model.onnx": {
                         "bytes": len(content), "sha256": sha256(content).hexdigest(), "url": "https://huggingface.co/test/pinned"}}}}}
            path = folder / "index.json"
            path.write_text(json.dumps(index))
            original = builtins.__import__
            def guarded_import(name, *args, **kwargs):
                if name == "onnxruntime" or name.startswith("onnxruntime."):
                    self.fail("Download-only must not import ONNX Runtime")
                return original(name, *args, **kwargs)
            arguments = ["prepare_mms_models.py", "--download-only", "--languages", "ha", "--index", str(path),
                         "--output", str(folder / "models"), "--report", str(folder / "report.json")]
            with patch.object(sys, "argv", arguments), patch.object(builtins, "__import__", side_effect=guarded_import), \
                 patch.object(preparation, "urlopen", side_effect=AssertionError("Pinned cached artifact must not redownload")):
                self.assertEqual(preparation.main(), 0)
            result = json.loads((folder / "report.json").read_text())
            self.assertEqual(result["mode"], "download-only")
            self.assertFalse(result["models"]["ha"]["models_executed"])

    def test_all_sources_are_exact_pinned_native_exports(self):
        document = json.loads((ROOT / "tools/mms_model_sources.json").read_text())
        self.assertEqual(set(document["models"]), set(mms.SUPPORTED))
        self.assertEqual(len(document["models"]), 29)
        for code, row in document["models"].items():
            self.assertEqual(row["iso_code"], mms.SUPPORTED[code])
            self.assertIn("/" + document["revision"] + "/", row["assets"]["model.onnx"]["url"])
            self.assertEqual(len(row["assets"]["model.onnx"]["sha256"]), 64)
        self.assertTrue(document["models"]["kab"]["partial_variant"])


try:
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
except ImportError:
    np = ort = None


@unittest.skipUnless(ort is not None and (ROOT / "model-packs/mms/kx47Runtime/models/MMS/ha/config.json").is_file(),
                     "Actual optional MMS model and Linux/Windows ONNX Runtime are required")
class RealModelTests(unittest.TestCase):
    def test_actual_native_onnx_outputs_and_actual_measured_source(self):
        folder = ROOT / "model-packs/mms/kx47Runtime/models/MMS/ha"
        carrier = mms.MMSCarrier(folder)
        wave, rate, applied = carrier.audio("sannu sannu", speed=1., noise_scale=0., noise_scale_w=0.)
        repeated, _, _ = carrier.audio("sannu sannu", speed=1., noise_scale=0., noise_scale_w=0.)
        np.testing.assert_array_equal(wave, repeated)
        self.assertEqual(rate, 16000)
        self.assertEqual(applied, 1.)
        self.assertGreater(len(wave), 1000)
        self.assertTrue(np.isfinite(wave).all())
        self.assertGreater(float(np.max(np.abs(wave))), .001)
        source = mms.source("ha", folder.parent.parent)
        self.assertEqual(source.shape, (1, 256, 1))
        self.assertEqual(source.dtype, np.float32)
        self.assertGreater(float(np.linalg.norm(source)), .1)
        config = json.loads((folder / "config.json").read_text())
        self.assertEqual(config["source_identity"]["source_sha256"], preparation.digest(folder / "source.npy"))
        self.assertFalse(config["native_pronunciation_verified"])
        self.assertFalse(config["windows_nvda_verified"])
        carrier.close()


if __name__ == "__main__":
    unittest.main()
