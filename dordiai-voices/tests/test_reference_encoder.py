"""Reference calibration must be reproducible offline and disable ORT telemetry."""
import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("reference_preparation_tests", ROOT / "tools/prepare_reference_encoder.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class ReferenceEncoderTests(unittest.TestCase):
    def test_offline_verification_uses_pinned_cache_and_never_opens_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            data = b"small pinned fixture, not an ONNX inference result"
            (folder / "encoder.onnx").write_bytes(data)
            record = {"filename": "encoder.onnx", "size_bytes": len(data),
                      "sha256": hashlib.sha256(data).hexdigest()}
            with patch.object(prepare, "ENCODERS", {"fp32": record}), patch.object(prepare, "SMALL_FILES", ()), \
                    patch.object(prepare.urllib.request, "urlopen", side_effect=AssertionError("offline means no requests")):
                records, _ = prepare.prepare(folder, ("fp32",), verify_only=True)
                self.assertEqual(record["sha256"], records["fp32"]["verified_sha256"])
                (folder / "encoder.onnx").write_bytes(b"corrupted")
                with self.assertRaisesRegex(ValueError, "offline verification"):
                    prepare.prepare(folder, ("fp32",), verify_only=True)

    def test_telemetry_is_disabled_before_session_creation_and_cpu_is_explicit(self):
        events = []
        module = ModuleType("onnxruntime")
        module.disable_telemetry_events = lambda: events.append("telemetry-disabled")
        module.SessionOptions = lambda: SimpleNamespace(add_session_config_entry=lambda *args: None)
        session = SimpleNamespace(
            get_inputs=lambda: [SimpleNamespace(name="spec", type="tensor(float)", shape=["batch", "time", 513])],
            get_outputs=lambda: [SimpleNamespace(shape=["batch", 256])])
        def create(path, *, sess_options, providers):
            self.assertEqual(["telemetry-disabled"], events)
            self.assertEqual(["CPUExecutionProvider"], providers)
            events.append("session-created")
            return session
        module.InferenceSession = create
        with patch.dict(sys.modules, {"onnxruntime": module}):
            self.assertIs(session, prepare.load_encoder("local-fixture.onnx"))
        self.assertEqual(["telemetry-disabled", "session-created"], events)


if __name__ == "__main__":
    unittest.main()
