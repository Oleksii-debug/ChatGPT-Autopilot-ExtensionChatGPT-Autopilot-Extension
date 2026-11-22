"""Diagnostic artifacts stay small and cannot mistake a failed probe for success."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("collect_windows_evidence_test", ROOT / "tools/collect_windows_evidence.py")
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class EvidenceCollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source, self.destination = self.root / "results", self.root / "evidence"
        self.source.mkdir()

    def put(self, name, data):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def test_only_reports_logs_waves_collected_not_models_or_portable_nvda(self):
        self.put("engine/report.json", b'{"status":"passed"}')
        self.put("engine/sample.wav", b"wave evidence")
        self.put("nvda/run/nvda.log", b"actual NVDA diagnostic")
        self.put("nvda/run/config/addons/main/model.json", b"excluded model configuration")
        self.put("nvda/run/portable/nvda.log", b"excluded portable tree")
        self.put("nvda/nvda_installer.exe", b"excluded installer")
        self.put("engine/model.safetensors", b"excluded weights")
        report = collector.collect(self.source, self.destination)
        self.assertEqual({row["path"] for row in report["files"]},
                         {"engine/report.json", "engine/sample.wav", "nvda/run/nvda.log"})
        self.assertFalse((self.destination / "nvda/run/config").exists())
        self.assertFalse((self.destination / "nvda/nvda_installer.exe").exists())

    def test_long_logs_keep_bounded_tail_and_mark_truncation(self):
        self.put("nvda/run/nvda.log", b"old prefix\nfinal diagnostic")
        with patch.object(collector, "LOG_TAIL_BYTES", 16):
            report = collector.collect(self.source, self.destination)
        entry = report["files"][0]
        self.assertTrue(entry["log_tail_only"])
        self.assertEqual(entry["retained_bytes"], 16)
        self.assertEqual((self.destination / entry["path"]).read_bytes(), b"final diagnostic")

    def test_json_reports_have_priority_over_wav_budget(self):
        self.put("engine/report.json", b"{}")
        self.put("engine/sample.wav", bytes(4090))
        report = collector.collect(self.source, self.destination, maximum=4096)
        self.assertEqual([row["path"] for row in report["files"]], ["engine/report.json"])
        self.assertEqual(report["omitted"][0]["path"], "engine/sample.wav")
        self.assertLessEqual(sum(path.stat().st_size for path in self.destination.rglob("*") if path.is_file()), 4096)

    def test_console_contains_failure_reason_and_real_log_tail(self):
        self.put("nvda/windows-nvda-probe.json", json.dumps({
            "status": "failed", "error": "real driver failed", "probe": {
                "status": "failed", "checks": [{"name": "driver", "status": "failed", "reason": "missing API"}]}
        }).encode("utf-8"))
        self.put("nvda/run/nvda.log", b"ERROR: real traceback\nmissing native library\n")
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            collector.print_diagnostics(self.source)
        text = buffer.getvalue()
        self.assertIn("real driver failed", text)
        self.assertIn("missing API", text)
        self.assertIn("missing native library", text)
        self.assertNotIn('"status": "passed"', text)

    def test_missing_results_are_labeled_and_stale_output_removed(self):
        self.destination.mkdir()
        (self.destination / "old-model.bin").write_bytes(b"stale")
        report = collector.collect(self.root / "absent", self.destination)
        self.assertEqual(report["status"], "no-probe-results")
        self.assertEqual(report["files"], [])
        self.assertFalse((self.destination / "old-model.bin").exists())

    def test_output_must_not_recurse_into_source(self):
        with self.assertRaises(ValueError):
            collector.collect(self.source, self.source / "nested")


if __name__ == "__main__":
    unittest.main()
