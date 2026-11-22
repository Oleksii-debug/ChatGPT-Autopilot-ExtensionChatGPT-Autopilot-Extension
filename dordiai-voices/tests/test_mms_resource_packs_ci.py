"""Offline packaging contracts; tiny fixtures do not claim model inference."""
import copy
from hashlib import sha256
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import build_mms_resource_packs_ci as tool

try:
    import numpy as np
except ImportError:
    np = None


class PathAndIndexTests(unittest.TestCase):
    def test_outputs_cannot_be_inside_canonical_protected_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            protected = root / "models"
            protected.mkdir()
            with self.assertRaises(ValueError):
                tool.external_path(protected / "pack.zip", (protected,))
            self.assertEqual(tool.external_path(root / "output", (protected,)), (root / "output").resolve())

    def test_committed_index_is_exactly_the_supported29_and_keeps_nc_license(self):
        index = tool.load_sources(ROOT / "tools/mms_model_sources.json")
        self.assertEqual(len(index["models"]), 29)
        self.assertEqual(index["license"], "CC-BY-NC-4.0")
        self.assertEqual(tool.MINIMUM_CORE_VERSION, "0.13.1-dev.1")
        self.assertNotEqual(tool.PACK_VERSION, "1.0.0")

    def test_missing_or_extra_languages_cannot_be_labelled_all29(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "index.json"
            path.write_text(json.dumps({"format": "dordiai-mms-sources-v1", "models": {},
                                        "license": "CC-BY-NC-4.0"}), encoding="utf-8")
            with self.assertRaises(ValueError):
                tool.load_sources(path)


@unittest.skipUnless(np is not None, "NumPy required to validate actual NPY fixture bytes")
class ResourcePackTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.models = self.root / "MMS"
        self.output = self.root / "packs"
        self.output.mkdir()

    def fixture(self, code="ha"):
        folder = self.models / code
        folder.mkdir(parents=True)
        (folder / "model.onnx").write_bytes(b"native FP32 model packaging fixture; never executed")
        (folder / "tokens.txt").write_text("a 0\nb 1\nc 2\n", encoding="utf-8")
        np.save(folder / "source.npy", np.ones((1, 256, 1), np.float32), allow_pickle=False)
        model_hash, tokens_hash = tool.digest(folder / "model.onnx"), tool.digest(folder / "tokens.txt")
        identity = {"source_sha256": tool.digest(folder / "source.npy"),
                    "encoder_sha256": tool.ENCODERS["fp32"]["sha256"],
                    "source_shape": [1, 256, 1], "source_dtype": "float32",
                    "basis": "fixture only; not inference evidence", "unit_normalized": False}
        repository, revision = "fixture/native-models", "a" * 40
        config = {"format": "dordiai-mms-onnx-v1", "backend": "mms-onnx", "code": code,
            "iso_code": code, "frontend": "characters", "is_uroman": False, "sample_rate": 16000,
            "license": "CC-BY-NC-4.0", "technical_onnx_inference_verified": True,
            "provenance": {"repo_id": repository, "revision": revision,
                           "model_sha256": model_hash, "tokens_sha256": tokens_hash},
            "source_identity": identity}
        (folder / "config.json").write_text(json.dumps(config), encoding="utf-8")
        (folder / "NOTICE.txt").write_text(repository + "\n" + revision +
            "\nhttps://creativecommons.org/licenses/by-nc/4.0/\n", encoding="utf-8")
        (folder / "native-probe.wav").write_bytes(b"not shipped")
        (folder / "encoder-flow.onnx").write_bytes(b"not shipped")
        entry = {"iso_code": code, "name_uk": "Тестова мова", "standard": code,
                 "assets": {name: {"bytes": (folder / name).stat().st_size,
                                  "sha256": tool.digest(folder / name)}
                            for name in ("model.onnx", "tokens.txt")}}
        index = {"models": {code: entry}, "repository": repository, "revision": revision,
                 "source_project": "fixture", "license": "CC-BY-NC-4.0"}
        proof = {"status": "prepared-real-onnx-carrier", "model_sha256": model_hash,
                 "tokens_sha256": tokens_hash, "source_identity": identity}
        return folder, index, proof

    def test_only_five_runtime_legal_files_roundtrip_and_no_precision_change(self):
        folder, index, proof = self.fixture()
        before = {name: tool.digest(folder / name) for name in tool.FILES}
        result = tool.build_language("ha", index, self.models, self.output, proof)
        archive = self.output / result["filename"]
        metadata = tool.manager.inspect_pack(archive)
        self.assertEqual(len(metadata["files"]), 5)
        self.assertEqual(metadata["license"], "CC-BY-NC-4.0")
        self.assertEqual(metadata["minimum_core_version"], "0.13.1-dev.1")
        self.assertEqual(metadata["version"], "1.0.1")
        self.assertEqual(metadata["engine_ids"], ["mms-onnx"])
        self.assertTrue(metadata["experimental"])
        self.assertFalse(metadata["quality_validation"]["windows_nvda_verified"])
        self.assertEqual(metadata["provenance"]["model_sha256"], before["model.onnx"])
        with zipfile.ZipFile(archive) as zipped:
            self.assertFalse(any("encoder-flow" in name or "native-probe" in name for name in zipped.namelist()))
            self.assertEqual(zipped.read("kx47Runtime/models/MMS/ha/model.onnx"), (folder / "model.onnx").read_bytes())
        self.assertTrue(tool.roundtrip(archive, "mms-ha", self.root / "addon")["core_sentinel_preserved"])
        self.assertEqual(before, {name: tool.digest(folder / name) for name in tool.FILES})

    def test_pinned_model_and_source_hash_mismatch_are_rejected(self):
        folder, index, proof = self.fixture()
        (folder / "model.onnx").write_bytes(b"changed model")
        with self.assertRaisesRegex(ValueError, "pinned"):
            tool.prepared_model("ha", index, self.models, proof)
        folder2, index2, proof2 = self.fixture("ay")
        proof2 = copy.deepcopy(proof2)
        proof2["source_identity"]["source_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "evidence"):
            tool.prepared_model("ay", index2, self.models, proof2)

    def test_nonfinite_source_vector_is_rejected_even_if_hashes_are_updated(self):
        folder, index, proof = self.fixture()
        np.save(folder / "source.npy", np.full((1, 256, 1), np.nan, np.float32), allow_pickle=False)
        config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
        config["source_identity"]["source_sha256"] = tool.digest(folder / "source.npy")
        (folder / "config.json").write_text(json.dumps(config), encoding="utf-8")
        proof["source_identity"] = config["source_identity"]
        with self.assertRaisesRegex(ValueError, "FP32"):
            tool.prepared_model("ha", index, self.models, proof)

    def test_kabyle_package_stays_explicitly_partial(self):
        folder, index, proof = self.fixture("kab")
        index["models"]["kab"]["selected_id"] = "tamazight"
        result = tool.build_language("kab", index, self.models, self.output, proof)
        metadata = tool.manager.inspect_pack(self.output / result["filename"])
        self.assertTrue(metadata["partial_variant"])
        self.assertEqual(metadata["languages"], ["kab"])
        self.assertIn("not Standard Moroccan", metadata["coverage_scope"])

    def test_notice_and_preparation_proof_are_required(self):
        folder, index, proof = self.fixture()
        (folder / "NOTICE.txt").write_text("incorrect notice", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "notice"):
            tool.prepared_model("ha", index, self.models, proof)
        proof2 = dict(proof, status="downloaded-only")
        with self.assertRaises(ValueError):
            tool.prepared_model("ha", index, self.models, proof2)


if __name__ == "__main__":
    unittest.main()
