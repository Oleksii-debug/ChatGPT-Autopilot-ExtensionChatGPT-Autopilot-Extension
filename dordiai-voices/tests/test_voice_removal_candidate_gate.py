import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("voice_removal_candidate_gate", ROOT / "tools/research/voice_removal_candidate_gate.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class CandidateIsolationGuards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.checkout = self.root / "checkout"
        self.project = self.checkout / "dordiai-voices"
        self.experiment = self.project / "experiments/voice-removal-ownership"
        self.experiment.mkdir(parents=True)
        self.baseline = {}
        entries = []
        for source, target in gate.FILES.items():
            data = ("candidate " + source).encode()
            (self.experiment / source).write_bytes(data)
            entries.append({"source": source, "target": target, "sha256": gate.sha256(data).hexdigest(), "git_sha": gate.git_sha(data)})
            if target in gate.BASE:
                path = self.project / target
                path.parent.mkdir(parents=True, exist_ok=True)
                original = ("production " + source).encode()
                path.write_bytes(original)
                self.baseline[target] = gate.git_sha(original)
        self.manifest = {"format": "dordiai-voice-removal-ownership-overlay", "format_version": 1, "files": entries}
        self.write_manifest()
        self.patch = patch.object(gate, "BASE", self.baseline)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.output = self.root / "isolated"

    def write_manifest(self):
        (self.experiment / "candidate.json").write_text(json.dumps(self.manifest))

    def test_only_the_isolated_copy_receives_candidate_runtime_and_test(self):
        before = gate.production_hashes(self.checkout)
        gate.stage_candidate(self.checkout, self.output)
        self.assertEqual(gate.production_hashes(self.checkout), before)
        for source, target in gate.FILES.items():
            self.assertEqual((self.output / "dordiai-voices" / target).read_bytes(), (self.experiment / source).read_bytes())
        self.assertFalse((self.project / gate.FILES["test_voice_package_retention.py"]).exists())

    def test_tampered_candidate_hash_never_creates_output(self):
        (self.experiment / "voice_packages.py").write_text("tampered")
        with self.assertRaisesRegex(gate.GateError, "hash differs"):
            gate.stage_candidate(self.checkout, self.output)
        self.assertFalse(self.output.exists())

    def test_changed_production_baseline_never_creates_output(self):
        (self.project / gate.FILES["preferences.py"]).write_text("unexpected newer driver")
        with self.assertRaisesRegex(gate.GateError, "baseline differs"):
            gate.stage_candidate(self.checkout, self.output)
        self.assertFalse(self.output.exists())

    def test_manifest_cannot_add_duplicate_or_escape_destination(self):
        for target in ("../../outside.py", gate.FILES["preferences.py"]):
            with self.subTest(target=target):
                self.manifest["files"][0]["target"] = target
                self.write_manifest()
                with self.assertRaisesRegex(gate.GateError, "destination"):
                    gate.stage_candidate(self.checkout, self.output)
                self.assertFalse(self.output.exists())

    def test_unreviewed_extra_staging_file_is_rejected(self):
        (self.experiment / "unreviewed.py").write_text("extra")
        with self.assertRaisesRegex(gate.GateError, "inventory"):
            gate.stage_candidate(self.checkout, self.output)

    def test_checkout_or_existing_output_cannot_be_overwritten(self):
        for output in (self.checkout / "inside", self.checkout, self.root):
            with self.subTest(output=output), self.assertRaises(gate.GateError):
                gate.stage_candidate(self.checkout, output)

    def test_non_windows_gate_cannot_claim_windows_acceptance(self):
        with patch.object(gate, "is_windows", return_value=False):
            with self.assertRaisesRegex(gate.GateError, "actual Windows"):
                gate.run_gate(self.checkout, self.output)
        self.assertFalse(self.output.exists())

    def test_skipped_mandatory_windows_case_fails_gate_and_preserves_checkout(self):
        focused = {"total": 21, "success": True, "case_ids": [gate.MANDATORY_WINDOWS_CASE],
                   "failed": [], "skipped": [gate.MANDATORY_WINDOWS_CASE]}
        with patch.object(gate, "is_windows", return_value=True), patch.object(gate, "execute_suite", return_value=focused):
            with self.assertRaisesRegex(gate.GateError, "was skipped"):
                gate.run_gate(self.checkout, self.output)
        receipt = json.loads((self.output / "gate.json").read_text())
        self.assertFalse(receipt["success"])
        self.assertTrue(receipt["checkout_production_unchanged"])
        self.assertFalse(receipt["actual_nvda_gui_verified"])

    def test_missing_mandatory_case_cannot_pass_gate(self):
        focused = {"total": 20, "success": True, "case_ids": [], "failed": [], "skipped": []}
        with patch.object(gate, "is_windows", return_value=True), patch.object(gate, "execute_suite", return_value=focused):
            with self.assertRaisesRegex(gate.GateError, "test missing"):
                gate.run_gate(self.checkout, self.output)


if __name__ == "__main__":
    unittest.main()
