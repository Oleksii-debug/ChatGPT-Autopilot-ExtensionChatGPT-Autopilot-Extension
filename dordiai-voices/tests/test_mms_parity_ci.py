"""Pinned data extraction and cache corruption checks without model execution."""
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mms_parity_ci", ROOT / "tools/prepare_mms_parity_ci.py")
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class CoreInputTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.addon = self.root / "fixture.nvda-addon"
        self.output = self.root / "selected"

    def archive(self, corrupt_inner=False, excluded_profile=False):
        voices = {"viktoriia": {"name": "Retained test profile"}}
        if excluded_profile:
            voices["inna"] = {"name": "Excluded"}
        payload = {
            "kx47Runtime/models/OpenVoiceV2/encoder-flow.onnx": b"fixture flow bytes",
            "kx47Runtime/models/OpenVoiceV2/decoder.onnx": b"fixture decoder bytes",
            "kx47Runtime/models/voices/viktoriia.npy": b"fixture embedding; no acoustic inference in this test",
            "kx47Runtime/models/voices/catalog.json": json.dumps(voices).encode("utf-8"),
            "kx47Runtime/python/python.exe": b"must never be extracted by selected-data staging",
        }
        records = {name: {"size_bytes": len(value), "sha256": sha256(value).hexdigest()} for name, value in payload.items()}
        if corrupt_inner:
            records["kx47Runtime/models/OpenVoiceV2/decoder.onnx"]["sha256"] = "0" * 64
        manifest = {"format": "dordiai-core-release", "format_version": 1, "version": ci.CORE_VERSION,
                    "voice_ids": list(voices), "files": records}
        with zipfile.ZipFile(self.addon, "w") as archive:
            for name, value in payload.items():
                archive.writestr(name, value)
            archive.writestr("dordiai-release.json", json.dumps(manifest))
        return ci.digest(self.addon)

    def test_only_selected_data_and_bound_profile_metadata_are_staged(self):
        actual = self.archive()
        with patch.object(ci, "CORE_SHA256", actual):
            receipt = ci.stage_core(self.addon, self.output)
            self.assertEqual(ci.verify_core(self.output)["status"], "verified")
        self.assertEqual(set(receipt["files"]), set(ci.MEMBERS.values()) | {ci.TARGET_METADATA})
        self.assertFalse(list(self.output.rglob("*.exe")))
        metadata = json.loads((self.output / ci.TARGET_METADATA).read_text(encoding="utf-8"))
        self.assertEqual(metadata["profile_id"], "viktoriia")
        self.assertEqual(metadata["embedding_sha256"], receipt["files"]["voices/viktoriia.npy"]["sha256"])
        self.assertFalse(metadata["acoustic_speaker_identity_verified"])

    def test_wrong_outer_pin_fails_before_extracting_data(self):
        self.archive()
        with patch.object(ci, "CORE_SHA256", "0" * 64), self.assertRaises(ValueError):
            ci.stage_core(self.addon, self.output)
        self.assertFalse(self.output.exists())

    def test_wrong_selected_member_hash_is_rejected_despite_matching_outer_fixture(self):
        actual = self.archive(corrupt_inner=True)
        with patch.object(ci, "CORE_SHA256", actual), self.assertRaises(ValueError):
            ci.stage_core(self.addon, self.output)
        self.assertFalse((self.output / ci.RECEIPT).exists())

    def test_cached_embedding_modification_is_rejected_on_next_run(self):
        actual = self.archive()
        with patch.object(ci, "CORE_SHA256", actual):
            ci.stage_core(self.addon, self.output)
            (self.output / "voices/viktoriia.npy").write_bytes(b"other speaker bytes")
            with self.assertRaises(ValueError):
                ci.verify_core(self.output)

    def test_excluded_profile_cannot_reenter_through_core_catalogue(self):
        actual = self.archive(excluded_profile=True)
        with patch.object(ci, "CORE_SHA256", actual), self.assertRaises(ValueError):
            ci.stage_core(self.addon, self.output)


if __name__ == "__main__":
    unittest.main()
