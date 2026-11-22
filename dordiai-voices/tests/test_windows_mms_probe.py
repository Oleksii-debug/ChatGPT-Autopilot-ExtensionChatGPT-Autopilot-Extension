"""Pinned representative fixtures and preparation guards; no Windows/model execution."""
import base64
from contextlib import redirect_stdout
import copy
from hashlib import sha256
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("windows_mms_probe_test", ROOT / "tools/windows_mms_probe.py")
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class WindowsMMSProbeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads(probe.DEFAULT_FIXTURE.read_text(encoding="utf-8"))
        self.index = json.loads(probe.DEFAULT_INDEX.read_text(encoding="utf-8"))

    def test_frozen_source_is_actual_same_checkpoint_identity(self):
        data = probe.validate_fixture(self.fixture, self.index)
        self.assertEqual(len(data), 1152)
        self.assertEqual(sha256(data).hexdigest(), "c10d010faf3e2e92484b272be201a5cae92ade7ba0b94265499121ac5aa441f2")
        self.assertFalse(self.fixture["windows_nvda_verified"])
        self.assertFalse(self.fixture["native_pronunciation_verified"])
        self.assertEqual(self.fixture["config"]["source_identity"]["basis"], "publisher-sample-from-same-pinned-checkpoint")

    def test_modified_or_other_checkpoint_embedding_is_rejected(self):
        for change in ("tensor", "checkpoint", "claims"):
            fixture = copy.deepcopy(self.fixture)
            if change == "tensor":
                data = bytearray(base64.b64decode(fixture["source_npy"]["data"]))
                data[-1] ^= 1
                fixture["source_npy"]["data"] = base64.b64encode(data).decode("ascii")
            elif change == "checkpoint":
                fixture["config"]["provenance"]["revision"] = "wrong"
            else:
                fixture["windows_nvda_verified"] = True
            with self.subTest(change=change), self.assertRaises(ValueError):
                probe.validate_fixture(fixture, self.index)

    def test_staging_wrong_graph_cannot_borrow_valid_source_identity(self):
        def bad_download(record, destination):
            destination.write_bytes(b"not the pinned model")
            return destination
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, "differ from prepared source"):
                probe.stage_resources(self.fixture, self.index, Path(folder), bad_download)

    def test_shared_probe_rejects_successful_audio_from_original_fallback(self):
        # A nonzero waveform alone must not masquerade as shared-graph proof.
        result = SimpleNamespace(returncode=0, stderr="", stdout=json.dumps({
            "frames": 1600, "peak": .4, "rms": .05, "model_session_mode": "original"}))
        with tempfile.TemporaryDirectory() as folder, patch.object(probe.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(ValueError, "requested inference path"):
                probe.native_carrier_probe(Path(folder), Path(folder), "fixed probe", Path(folder), 10,
                                           expected_mode="shared-exact-weights")

    @unittest.skipIf(probe.os.name == "nt", "Non-Windows guard only")
    def test_non_windows_does_not_download_models_or_pretend_to_verify(self):
        with tempfile.TemporaryDirectory() as folder, redirect_stdout(io.StringIO()), patch.object(probe, "stage_resources") as stage:
            result = probe.main(["--package-root", "missing-package", "--output", folder])
            report = json.loads((Path(folder) / "report.json").read_text(encoding="utf-8"))
            stage.assert_not_called()
        self.assertEqual(result, 2)
        self.assertEqual(report["status"], "blocked")
        self.assertFalse(report["nvda_verified"])
        self.assertFalse(report["wave_player_verified"])
        self.assertFalse(report["product_ready"])


if __name__ == "__main__":
    unittest.main()
