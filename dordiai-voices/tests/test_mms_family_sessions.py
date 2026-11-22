"""Exact MMS pooling, fallback boundaries and resource/cancellation isolation."""
import errno
import gc
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from threading import Event, Thread
from time import monotonic, sleep
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import weakref

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
sys.path.insert(0, str(RUNTIME))
import mms_family_sessions as family
import wide_mms as mms
from session_control import GuardedSession, SynthesisCancelled, cancel_running

CONFIG = {"format": mms.MODEL_FORMAT, "frontend": "characters", "is_uroman": False, "code": "ha", "iso_code": "hau",
          "sample_rate": 16000, "add_blank": True, "blank_id": 0, "lowercase": True, "navigation": {}}


def fixture(folder):
    folder.mkdir(parents=True)
    (folder / "config.json").write_text(json.dumps(CONFIG), encoding="utf-8")
    (folder / "tokens.txt").write_text("_ 0\ns 1\na 2\nn 3\nu 4\n  5\n", encoding="utf-8")
    return folder


class ResourceAndTrustTests(unittest.TestCase):
    def test_core_data_hashes_and_all29_exact_models_are_pinned(self):
        self.assertEqual((family.ASSETS / "index.json").stat().st_size, family.INDEX_SIZE)
        self.assertEqual(sha256((family.ASSETS / "index.json").read_bytes()).hexdigest(), family.INDEX_SHA256)
        self.assertEqual(sha256((family.ASSETS / "graph.onnx").read_bytes()).hexdigest(), family.GRAPH_SHA256)
        index = family._index(str(family.ASSETS / "index.json"), family.signature(family.ASSETS / "index.json"))
        self.assertEqual(set(index["models"]), set(mms.SUPPORTED))
        self.assertEqual(len(index["weights"]), 460)
        self.assertEqual(len({row["sha256"] for row in index["models"].values()}), 29)

    def test_opt_out_and_explicit_opt_in(self):
        with patch.dict(os.environ, {family.ENVIRONMENT_OPTION: "0"}):
            self.assertFalse(family.enabled())
            self.assertIsNone(family.for_language("unused", "ha", lambda _: self.fail("Opt-out must not open a graph")))
        with patch.dict(os.environ, {family.ENVIRONMENT_OPTION: "1"}):
            self.assertTrue(family.enabled())

    def test_missing_and_tampered_shared_metadata_fall_back_before_open(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {family.ENVIRONMENT_OPTION: "1"}):
            root = Path(temporary)
            folder = fixture(root / "models/MMS/ha")
            assets = root / "assets"
            assets.mkdir()
            self.assertIsNone(family.for_language(folder / "model.onnx", "ha", lambda _: self.fail("Missing index"), assets=assets))
            data = bytearray((family.ASSETS / "index.json").read_bytes())
            data[-2] ^= 1
            (assets / "index.json").write_bytes(data)
            self.assertIsNone(family.for_language(folder / "model.onnx", "ha", lambda _: self.fail("Changed index"), assets=assets))

    def test_memory_cancellation_stale_and_io_errors_never_trigger_fallback(self):
        for error in (MemoryError(), SynthesisCancelled(), family.MMSResourceChanged(), OSError(errno.ENOMEM, "memory"),
                      OSError(errno.EIO, "I/O"), OSError("unclassified"), RuntimeError("inference failed")):
            with self.subTest(error=type(error).__name__):
                self.assertFalse(family._fallback_error(error))
        for code in (8, 14, 1455):
            error = OSError(errno.EINVAL, "Windows memory exhaustion")
            error.winerror = code
            self.assertFalse(family._fallback_error(error))
        self.assertTrue(family._fallback_error(FileNotFoundError(errno.ENOENT, "optional asset")))
        self.assertTrue(family._fallback_error(family.InvalidSharedMMS("unsupported")))
        self.assertFalse(family._fallback_error(family.MMSLanguageMismatch("wrong language")))

    def test_invalid_proto_cannot_create_a_weight_view(self):
        for raw in (b"", b"\x3a\x03\x2a\x03\x00", b"\xff" * 20):
            with self.subTest(raw=raw), self.assertRaises(family.InvalidSharedMMS):
                family._offsets(raw)

    def test_bound_factory_identity_is_stable_without_retaining_owner(self):
        class Factory:
            threads = 2
            def open(self, _):
                return None
        value = Factory()
        key, refs = family._factory_identity(value.open)
        another, refs2 = family._factory_identity(value.open)
        self.assertEqual(key, another)
        shared = family._Family(object(), refs)
        self.assertTrue(shared.matches(refs2))
        reference = weakref.ref(value)
        del value
        gc.collect()
        self.assertIsNone(reference())
        self.assertFalse(shared.matches(refs2))

    def test_carrier_detects_frontend_change_during_initial_read(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = fixture(Path(temporary) / "ha")
            original = mms.read_tokens
            def changing(path):
                result = original(path)
                with (folder / "config.json").open("a", encoding="utf-8") as stream:
                    stream.write(" ")
                return result
            with patch.object(mms, "read_tokens", changing), self.assertRaises(family.MMSResourceChanged):
                mms.MMSCarrier(folder)

    def test_carrier_detects_frontend_change_before_first_preload(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = fixture(Path(temporary) / "ha")
            carrier = mms.MMSCarrier(folder, session_factory=lambda _: self.fail("Stale frontend must not open a model"))
            with (folder / "tokens.txt").open("a", encoding="utf-8") as stream:
                stream.write("A 2\n")
            with self.assertRaises(family.MMSResourceChanged):
                carrier.preload()

    def test_folder_code_and_config_code_cannot_cross_bind(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = fixture(Path(temporary) / "so")
            with self.assertRaises(ValueError):
                mms.MMSCarrier(folder)

    def test_original_constructor_cannot_publish_after_resource_change(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {family.ENVIRONMENT_OPTION: "0"}):
            folder = fixture(Path(temporary) / "ha")
            graph = SimpleNamespace(
                get_inputs=lambda: [SimpleNamespace(name=k, type="tensor(int64)" if k in {"x", "x_length"} else "tensor(float)") for k in family.INPUTS],
                get_modelmeta=lambda: SimpleNamespace(custom_metadata_map={"comment": "mms", "frontend": "characters", "sample_rate": "16000", "add_blank": "1"}))
            def factory(_):
                with (folder / "tokens.txt").open("a", encoding="utf-8") as stream:
                    stream.write("A 2\n")
                return graph
            carrier = mms.MMSCarrier(folder, session_factory=factory)
            with self.assertRaises(family.MMSResourceChanged):
                carrier.preload()
            self.assertIsNone(carrier._graph)


try:
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
except ImportError:
    np = ort = None

MODELS = ROOT / "model-packs/mms/kx47Runtime/models/MMS"


class Owner:
    def __init__(self):
        self.cancel_event = Event()
        self.active_run = None
    def check_cancelled(self):
        if self.cancel_event.is_set():
            raise SynthesisCancelled()


@unittest.skipUnless(ort is not None and (MODELS / "ha/model.onnx").is_file(), "Actual pinned MMS resources/ORT required")
class ActualSharingTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {family.ENVIRONMENT_OPTION: "1"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.carriers = []
        self.addCleanup(lambda: [item.close() for item in self.carriers])
        class Factory:
            threads = 2
            def __init__(self):
                self.opened = []
            def open(self, path):
                self.opened.append(Path(path))
                return family._default_session(path)
        self.factory = Factory()

    def carrier(self, code, owner=None, folder=None):
        value = mms.MMSCarrier(folder or MODELS / code, session_factory=self.factory.open, owner=owner)
        self.carriers.append(value)
        return value

    def test_three_languages_share_one_raw_graph_and_match_original_pcm(self):
        for code, text in (("ha", "sannu"), ("so", "salaan"), ("yo", "bawo")):
            shared = self.carrier(code)
            actual = shared.audio(text, noise_scale=0., noise_scale_w=0.)[0]
            with patch.dict(os.environ, {family.ENVIRONMENT_OPTION: "0"}):
                original = mms.MMSCarrier(MODELS / code)
                try:
                    expected = original.audio(text, noise_scale=0., noise_scale_w=0.)[0]
                finally:
                    original.close()
            self.assertEqual(shared.model_session_mode, "shared-exact-weights")
            self.assertEqual(actual.shape, expected.shape)
            self.assertLessEqual(float(np.max(np.abs(actual - expected))), 1e-6)
            a = np.rint(np.clip(actual, -1, 1) * 32767).astype(np.int32)
            b = np.rint(np.clip(expected, -1, 1) * 32767).astype(np.int32)
            self.assertLessEqual(int(np.max(np.abs(a - b))), 1)
        self.assertEqual(len(self.factory.opened), 1)
        self.assertEqual(self.factory.opened[0].name, "graph.onnx")
        views = [item.preload() for item in self.carriers]
        self.assertTrue(all(item.family is views[0].family for item in views))
        self.assertTrue(all(not value.flags.writeable for item in views for value in item.weights.values()))

    def test_parallel_language_runs_do_not_mix_weights(self):
        carriers = [(self.carrier(code), text) for code, text in (("ha", "sannu"), ("so", "salaan"), ("yo", "bawo"))]
        expected = [carrier.audio(text, noise_scale=0., noise_scale_w=0.)[0] for carrier, text in carriers]
        actual, errors = {}, []
        def work(position, carrier, text):
            try:
                actual[position] = carrier.audio(text, noise_scale=0., noise_scale_w=0.)[0]
            except Exception as error:
                errors.append(error)
        threads = [Thread(target=work, args=(i, carrier, text)) for i, (carrier, text) in enumerate(carriers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
            self.assertFalse(thread.is_alive())
        self.assertFalse(errors)
        for position in range(3):
            np.testing.assert_array_equal(actual[position], expected[position])

    def test_cancellation_is_per_owner_and_shared_graph_survives(self):
        first_owner, second_owner = Owner(), Owner()
        first, second = self.carrier("ha", first_owner), self.carrier("so", second_owner)
        first.preload(); second.preload()
        self.assertIs(first._graph.session.family, second._graph.session.family)
        errors, completed = [], []
        def long_request():
            try:
                first.audio(" ".join(["sannu"] * 12), noise_scale=0., noise_scale_w=0.)
            except Exception as error:
                errors.append(error)
        thread = Thread(target=long_request)
        thread.start()
        deadline = monotonic() + 3
        while first_owner.active_run is None and thread.is_alive() and monotonic() < deadline:
            sleep(.002)
        self.assertIsNotNone(first_owner.active_run)
        first_owner.cancel_event.set()
        cancel_running(first_owner, first_owner.cancel_event)
        # Eviction drops references without closing an in-flight mapping.
        first.close()
        completed.append(second.audio("salaan", noise_scale=0., noise_scale_w=0.)[0])
        thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertTrue(any(isinstance(error, SynthesisCancelled) for error in errors))
        self.assertTrue(np.isfinite(completed[0]).all())
        self.assertIsNone(second_owner.active_run)
        self.assertFalse(second_owner.cancel_event.is_set())
        self.assertEqual(len(self.factory.opened), 1)

    def test_default_stochastic_values_are_preserved(self):
        carrier = self.carrier("ha")
        view = carrier.preload()
        actual_run = view.family.raw.run
        feeds = []
        def capture(names, values, options=None):
            feeds.append(values)
            return actual_run(names, values, options)
        proxy = SimpleNamespace(run=capture, get_inputs=view.family.raw.get_inputs,
                                get_outputs=view.family.raw.get_outputs, get_modelmeta=view.family.raw.get_modelmeta,
                                get_providers=view.family.raw.get_providers)
        with patch.object(view.family, "raw", proxy):
            result = carrier.audio("sannu")[0]
        self.assertTrue(np.isfinite(result).all())
        self.assertAlmostEqual(float(feeds[0]["noise_scale"][0]), .667, places=6)
        self.assertAlmostEqual(float(feeds[0]["noise_scale_w"][0]), .8, places=6)
        self.assertAlmostEqual(float(feeds[0]["length_scale"][0]), 1., places=6)

    def test_managed_epoch_rejects_old_carrier_and_reloads_new_mapping_and_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "runtime"
            folder = runtime / "models/MMS/ha"
            folder.mkdir(parents=True)
            for name in ("config.json", "tokens.txt", "source.npy"):
                shutil.copyfile(MODELS / "ha" / name, folder / name)
            shutil.copyfile(MODELS / "ha/model.onnx", folder / "model.onnx")
            index = runtime / "installed_resource_packs.json"
            index.write_text('{"packs":{"mms-ha":{"version":"1"}}}', encoding="utf-8")
            first = self.carrier("ha", folder=folder)
            expected = first.audio("sannu", noise_scale=0., noise_scale_w=0.)[0]
            old_source = mms.source("ha", runtime / "models").copy()
            replacement = folder / "new-model.onnx"
            shutil.copyfile(MODELS / "ha/model.onnx", replacement)
            replacement.replace(folder / "model.onnx")
            np.save(folder / "source.npy", old_source + np.float32(.01), allow_pickle=False)
            index.write_text('{"packs":{"mms-ha":{"version":"2"}}}', encoding="utf-8")
            with self.assertRaises(family.MMSResourceChanged):
                first.audio("sannu", noise_scale=0., noise_scale_w=0.)
            first.close()
            second = self.carrier("ha", folder=folder)
            actual = second.audio("sannu", noise_scale=0., noise_scale_w=0.)[0]
            np.testing.assert_array_equal(actual, expected)
            self.assertFalse(np.array_equal(mms.source("ha", runtime / "models"), old_source))
            self.assertEqual(len(self.factory.opened), 2)
            second.close()

    def test_another_audited_languages_weights_are_rejected_without_original_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary) / "models/MMS/so"
            folder.mkdir(parents=True)
            for name in ("config.json", "tokens.txt", "source.npy"):
                shutil.copyfile(MODELS / "so" / name, folder / name)
            shutil.copyfile(MODELS / "ha/model.onnx", folder / "model.onnx")
            with self.assertRaises(family.MMSLanguageMismatch):
                self.carrier("so", folder=folder).preload()
            self.assertFalse(self.factory.opened)


if __name__ == "__main__":
    unittest.main()
