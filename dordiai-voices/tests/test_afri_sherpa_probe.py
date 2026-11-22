"""Metadata/content pinning and kernel isolation; no TTS models are required."""
import ctypes.util
from hashlib import sha1, sha256
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools/research/afri_sherpa_probe.py"
spec = importlib.util.spec_from_file_location("afri_sherpa_research", TOOL)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def row(path, raw="a" * 64, size=100):
    return {"rfilename": path, "size": size, "lfs": {"size": size, "sha256": raw}}


class ArtifactTests(unittest.TestCase):
    def test_prefers_complete_existing_publisher_fp32_onnx(self):
        rows = [row("onnx/" + name + ".onnx") for name in probe.ROLES]
        rows += [row("onnx/vocab.json"), row("onnx/token_scores.json")]
        _, roles, precision, _ = probe.choose_exports(rows)
        self.assertEqual(precision, "publisher-fp32-onnx")
        self.assertTrue(all(not path.endswith(".int8.onnx") for path in roles.values()))

    def test_known_mixed_export_cannot_change_raw_hash(self):
        rows = [row(path, raw=value) for path, value in probe.KNOWN_MIXED_SHA256.items()]
        rows += [row("sherpa-onnx/vocab.json"), row("sherpa-onnx/token_scores.json")]
        _, _, precision, _ = probe.choose_exports(rows)
        self.assertIn("publisher-mixed", precision)
        rows[0]["lfs"]["sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            probe.choose_exports(rows)

    def test_small_git_content_is_not_confused_with_an_lfs_pointer_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "vocab.json"
            value = b'{"example":0}'
            path.write_bytes(value)
            blob = sha1(b"blob " + str(len(value)).encode("ascii") + b"\0" + value).hexdigest()
            self.assertTrue(probe.verify_file(path, {"bytes": len(value), "git_blob_sha1": blob}))
            self.assertTrue(probe.verify_file(path, {"bytes": len(value), "sha256": sha256(value).hexdigest()}))
            path.write_bytes(b'{"example":1}')
            self.assertFalse(probe.verify_file(path, {"bytes": len(value), "git_blob_sha1": blob}))

    def test_only_two_exact_trained_language_cases_are_selected(self):
        text = "\n".join(["# lang\ttext\tipa", "nbl\twrong language\twrong"] +
                         [code + "\tnative example\ttraining ipa" for code in ("ssw", "ven") for _ in range(3)])
        cases = probe.select_cases(text, 3)
        self.assertEqual(len(cases), 6)
        self.assertEqual(set(row["language"] for row in cases), {"ssw", "ven"})
        self.assertNotIn("nbl", probe.LANGUAGES)
        self.assertNotIn("aar", probe.LANGUAGES)
        with self.assertRaises(ValueError):
            probe.select_cases("ssw\tonly one\tipa", 3)

    def test_report_initial_write_does_not_clobber_an_existing_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "report.json"
            path.write_text("original", encoding="utf-8")
            with self.assertRaises(FileExistsError):
                probe.write_json(path, {"new": True}, overwrite=False)
            self.assertEqual(path.read_text(encoding="utf-8"), "original")

    def test_report_inside_model_cache_is_rejected_before_network_acquisition(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / "cache"
            completed = subprocess.run([sys.executable, str(TOOL), "acquire", "--cache", str(cache),
                                        "--report", str(cache / "report.json")],
                                       capture_output=True, text=True)
            self.assertEqual(completed.returncode, 2)
            self.assertIn("separate report directory", completed.stderr)


@unittest.skipUnless(sys.platform == "linux" and ctypes.util.find_library("seccomp"), "Linux libseccomp required")
class NativeNetworkGuardTests(unittest.TestCase):
    def test_actual_subprocess_cannot_create_an_internet_socket(self):
        script = ("import importlib.util,json;"
                  "s=importlib.util.spec_from_file_location('guard'," + repr(str(TOOL)) + ");"
                  "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
                  "print(json.dumps(m.deny_native_network()))")
        completed = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=15)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        proof = json.loads(completed.stdout)
        self.assertTrue(proof["kernel_filter_loaded_before_inference_imports"])
        self.assertEqual(proof["actual_socket_test_errno"], 1)
        self.assertIn("connect", proof["denied_syscalls"])


if __name__ == "__main__":
    unittest.main()
