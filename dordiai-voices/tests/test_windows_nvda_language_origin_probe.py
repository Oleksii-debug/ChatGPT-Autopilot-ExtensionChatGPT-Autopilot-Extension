"""Contract tests for tool-only actual host queue proof."""
import ast
from hashlib import sha1
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("_origin_probe",ROOT/"tools/windows_nvda_language_origin_probe.py")
probe=importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

class TransportProbeTests(unittest.TestCase):
    def test_embedded_helper_is_exact_candidate(self):
        raw=probe.LANGUAGE_ORIGIN_SOURCE.encode("utf-8")
        self.assertEqual(sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest(),
            "381ad8005b98c41c54249a3460be0542acc4ef24")
    def test_compilation_and_anchor_fail_closed(self):
        base=type("Base",(),{"PROBE_PLUGIN":"def later(*a): pass\ndef close_settings():\n"+probe.ANCHOR+"def finish(): pass\n"})()
        original=base.PROBE_PLUGIN
        self.assertEqual(probe.install_language_origin_transport_probe(base),original)
        compile(base.PROBE_PLUGIN,"probe","exec")
        with self.assertRaises(ValueError):probe.install_language_origin_transport_probe(base)
    def test_uses_actual_private_queue_without_registration_or_delivery(self):
        tree=ast.parse(probe.PROBE_FUNCTION)
        calls=[ast.unparse(n.func) for n in ast.walk(tree) if isinstance(n,ast.Call)]
        self.assertIn("proof._processSpeechSequence",calls)
        self.assertIn("resume._removeCompletedFromQueue",calls)
        self.assertIn("resume._buildNextUtterance",calls)
        self.assertIn("tracker.getChanged",calls)
        self.assertNotIn("actual_manager.SpeechManager",calls)
        self.assertNotIn("speech.speak",calls)
        self.assertNotIn("DRIVER.speak",calls)
    def test_private_filter_and_no_global_monkeypatch(self):
        tree=ast.parse(probe.PROBE_FUNCTION)
        attributes=[ast.unparse(n) for n in ast.walk(tree)
            if isinstance(n,ast.Attribute) and isinstance(n.ctx,ast.Store)]
        self.assertFalse(any(n.startswith("speech.") for n in attributes))
        self.assertIn("type(speech.filter_speechSequence)()",probe.PROBE_FUNCTION)

if __name__=="__main__":unittest.main()
