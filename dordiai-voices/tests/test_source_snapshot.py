import base64
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import restore_source_snapshot as snapshots


class SourceSnapshotTests(unittest.TestCase):
    def test_restore_and_reject_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = b"exact source bytes\n"
            digest = hashlib.sha256(data).hexdigest()
            overall = hashlib.sha256(("runtime/test.py\0" + digest + "\n").encode()).hexdigest()
            document = {"format": "dordiai-source-snapshot", "format_version": 1, "source_sha256": overall,
                        "files": {"runtime/test.py": {"sha256": digest, "base64": base64.b64encode(data).decode()}}}
            path = root / "source.json"
            path.write_text(json.dumps(document))
            result = snapshots.restore(path, root / "restored")
            self.assertEqual(result["source_sha256"], overall)
            self.assertEqual((root / "restored/runtime/test.py").read_bytes(), data)
            with self.assertRaises(ValueError):
                snapshots.restore(path, root / "restored")

    def test_unsafe_path_and_corruption_leave_no_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "source.json"
            record = {"sha256": "0" * 64, "base64": "ZGF0YQ=="}
            for name in ["../outside.py", "runtime/test.py"]:
                path.write_text(json.dumps({"format": "dordiai-source-snapshot", "format_version": 1,
                                           "source_sha256": "0" * 64, "files": {name: record}}))
                with self.assertRaises(ValueError):
                    snapshots.restore(path, root / "restored")
                self.assertFalse((root / "restored").exists())


if __name__ == "__main__":
    unittest.main()
