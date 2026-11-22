"""Native resource/routing/cancellation checks without acoustic weights."""
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CANDIDATE = ROOT / "candidates/afri-six"
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
sys.path.insert(0, str(RUNTIME))
spec = importlib.util.spec_from_file_location("afri_runtime_candidate", CANDIDATE / "wide_afri_six.py")
afri = importlib.util.module_from_spec(spec)
spec.loader.exec_module(afri)


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


class Fixture:
    def __init__(self, root, codes=("ss", "ve")):
        self.models = Path(root) / "models"
        self.folder = self.models / "SharedAfriSixONNX"
        self.folder.mkdir(parents=True)
        graph = {}
        for index, role in enumerate(afri.ROLES):
            path = self.folder / (role + ".onnx")
            path.write_bytes(bytes([index + 1]))
            graph[role] = {"filename": path.name, "bytes": 1, "sha256": digest(path)}
        (self.folder / "tokenizer.json").write_text('{"model":{"unk_id":0}}')
        (self.folder / "NOTICE.txt").write_text("native resource fixture")
        self.config = {"format": afri.FORMAT, "model_revision": afri.MODEL_REVISION,
                       "source_checkpoint_sha256": afri.CHECKPOINT_SHA256, "g2p_revision": afri.G2P_REVISION,
                       "sample_rate": 24000, "flow_lm_layers": 6, "precision": "float32", "graphs": graph,
                       "tokenizer_sha256": digest(self.folder / "tokenizer.json")}
        self.write_shared()
        for index, code in enumerate(codes):
            folder = self.folder / "references" / code
            folder.mkdir(parents=True)
            with wave.open(str(folder / "reference.wav"), "wb") as out:
                out.setnchannels(1); out.setsampwidth(2); out.setframerate(24000)
                out.writeframes(np.full(24000, 100 + index, dtype="<i2").tobytes())
            np.save(folder / "source.npy", np.full((1, 256, 1), index + 1, np.float32), allow_pickle=False)
            (folder / "NOTICE.txt").write_text("measured source fixture")
            files = {name: {"bytes": (folder / name).stat().st_size, "sha256": digest(folder / name)}
                     for name in ("reference.wav", "source.npy")}
            record = {"format": afri.REFERENCE_FORMAT, "code": code, "iso_code": afri.SUPPORTED[code],
                      "model_revision": afri.MODEL_REVISION, "g2p_revision": afri.G2P_REVISION, "files": files,
                      "source_identity": {"source_checkpoint_sha256": afri.CHECKPOINT_SHA256,
                                          "reference_encoder_sha256": afri.ENCODER_SHA256,
                                          "calibration_kind": "actual-same-six-layer-carrier-pcm",
                                          "carrier_identity_sha256": afri.carrier_identity(self.config),
                                          "native_reference_sha256": files["reference.wav"]["sha256"]}}
            (folder / "config.json").write_text(json.dumps(record))
    def write_shared(self):
        (self.folder / "config.json").write_text(json.dumps(self.config))


class Factory:
    def __init__(self, owner=None):
        self.opened, self.calls, self.owner = [], [], owner
    def __call__(self, path):
        role = Path(path).stem
        self.opened.append(role)
        parent = self
        class Session:
            def get_inputs(self):
                if role == "lm_main":
                    return [SimpleNamespace(name=name, shape=[1, 1], type="tensor(float)") for name in
                            ("sequence", "text_embeddings") + tuple("state_" + str(i) for i in range(12))]
                if role == "decoder":
                    return [SimpleNamespace(name=name, shape=[1], type="tensor(float)") for name in ("latent", "state_0")]
                return []
            def run(self, outputs, feed, run_options=None):
                parent.calls.append(role)
                if role == "encoder":
                    return [np.full((1, 2, 1024), .125, np.float32)]
                if role == "text_conditioner":
                    return [np.zeros((1, len(feed["token_ids"][0]), 1024), np.float32)]
                if role == "lm_main":
                    count = float(feed["state_0"].reshape(-1)[0])
                    eos = -3. if feed["sequence"].shape[1] and count >= 3 else -5.
                    return [np.zeros((1, 1024), np.float32), np.array([[eos]], np.float32)] + [
                        feed["state_" + str(i)] + 1 for i in range(12)]
                if role == "lm_flow":
                    if parent.owner is not None:
                        parent.owner.cancelled = True
                    return [np.full((1, 32), .05, np.float32)]
                if role == "decoder":
                    audio = np.full((1, 1, feed["latent"].shape[1] * 1920), .1, np.float32)
                    return [audio, feed["state_0"] + 1]
                raise AssertionError(role)
        return Session()


class FakeTokenizer:
    @staticmethod
    def from_file(path):
        return SimpleNamespace(encode=lambda text: SimpleNamespace(ids=[1, 2]))


class NativeResourceTests(unittest.TestCase):
    def setUp(self):
        afri.clear_engines()
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = Fixture(self.temp.name)
        self.mocks = patch.dict(sys.modules, {"tokenizers": SimpleNamespace(Tokenizer=FakeTokenizer),
                                             "wide_afri_frontend": SimpleNamespace(phonemes=lambda code, text: "native ipa")})
        self.mocks.start()
    def tearDown(self):
        afri.clear_engines()
        self.mocks.stop()
        self.temp.cleanup()

    def test_optional_absence_and_language_metadata_never_alias_another_native_language(self):
        self.assertEqual(afri.available(Path(self.temp.name) / "absent"), set())
        self.assertEqual(afri.available(self.fixture.models), {"ss", "ve"})
        path = self.fixture.folder / "references/ve/config.json"
        record = json.loads(path.read_text()); record["iso_code"] = "ssw"
        path.write_text(json.dumps(record))
        self.assertEqual(afri.available(self.fixture.models), {"ss"})
        with self.assertRaises(ValueError):
            afri._reference(self.fixture.folder, "ve")
        with self.assertRaises(ValueError):
            afri._reference(self.fixture.folder, "nr")

    def test_two_languages_share_one_graph_bundle_but_have_distinct_reference_lookups(self):
        factory = Factory()
        engine = afri.AfriSixEngine(self.fixture.folder, session_factory=factory)
        a = engine.audio("ss", "word")
        b = engine.audio("ve", "word")
        self.assertEqual(len(factory.opened), 5)
        self.assertEqual(factory.calls.count("encoder"), 2)
        self.assertEqual(len(engine._references), 2)
        self.assertEqual(len(engine._clips), 2)
        self.assertTrue(np.isfinite(a).all() and np.isfinite(b).all())
        self.assertFalse(a.flags.writeable)
        before = len(factory.calls)
        np.testing.assert_array_equal(engine.audio("ss", "word"), a)
        self.assertEqual(len(factory.calls), before)
        engine.close()

    def test_replacement_invalidates_source_snapshot_and_stale_native_audio(self):
        original = afri.source("ss", models=self.fixture.models)
        folder = self.fixture.folder / "references/ss"
        np.save(folder / "replacement.npy", np.full((1, 256, 1), 7, np.float32), allow_pickle=False)
        os.replace(folder / "replacement.npy", folder / "source.npy")
        record = json.loads((folder / "config.json").read_text())
        record["files"]["source.npy"]["sha256"] = digest(folder / "source.npy")
        (folder / "config.json").write_text(json.dumps(record))
        new = afri.source("ss", models=self.fixture.models)
        self.assertTrue(np.all(original == 1) and np.all(new == 7))
        self.assertIsNot(original, new)
        factory = Factory()
        engine = afri.AfriSixEngine(self.fixture.folder, session_factory=factory)
        engine.audio("ss", "word")
        model = self.fixture.folder / "lm_main.onnx"
        model.write_bytes(b"z")
        self.fixture.config["graphs"]["lm_main"]["sha256"] = digest(model)
        self.fixture.write_shared()
        self.assertEqual(afri.available(self.fixture.models), set())  # old source is bound to previous graph family
        with self.assertRaises(RuntimeError):
            engine.audio("ss", "word")
        self.assertTrue(engine._closed)
        self.assertFalse(engine._clips)

    def test_cancelled_request_does_not_emit_or_cache_audio_and_cleans_active_run(self):
        from session_control import SynthesisCancelled
        class Owner:
            cancelled = False
            cancel_event = None
            active_run = None
            def check_cancelled(self):
                if self.cancelled:
                    raise SynthesisCancelled()
        owner = Owner()
        factory = Factory(owner)
        fake_ort = SimpleNamespace(RunOptions=lambda: SimpleNamespace(terminate=False))
        with patch.dict(sys.modules, {"onnxruntime": fake_ort}):
            engine = afri.AfriSixEngine(self.fixture.folder, owner=owner, session_factory=factory)
            with self.assertRaises(SynthesisCancelled):
                engine.audio("ss", "word")
            self.assertIsNone(owner.active_run)
            self.assertEqual(factory.calls.count("decoder"), 0)
            self.assertFalse(engine._clips)
            engine.close()


if __name__ == "__main__":
    unittest.main()
