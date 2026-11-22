"""Infrastructure helper guards; these tests do not install drivers or verify audio."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("audio_endpoint_setup_test", ROOT / "tools/setup_audio_endpoint.py")
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


class EndpointSetupTests(unittest.TestCase):
    def test_service_changes_require_ephemeral_actions_environment(self):
        for environment in ({}, {"GITHUB_ACTIONS": "true"}, {"RUNNER_OS": "Windows"},
                            {"GITHUB_ACTIONS": "true", "RUNNER_OS": "Linux"}):
            with self.subTest(environment=environment), self.assertRaises(ValueError):
                setup.require_ephemeral_ci(environment)
        setup.require_ephemeral_ci({"GITHUB_ACTIONS": "true", "RUNNER_OS": "Windows"})

    def test_reviewed_vendor_candidate_is_explicitly_not_an_install_action(self):
        self.assertEqual(setup.CANDIDATE_BYTES, 1324680)
        self.assertEqual(len(setup.CANDIDATE_SHA256), 64)
        self.assertIn("Pack46.zip", setup.CANDIDATE_URL)
        source = (ROOT / "tools/setup_audio_endpoint.py").read_text(encoding="utf-8")
        self.assertNotIn("pnputil", source)
        self.assertNotIn("bcdedit", source)
        self.assertNotIn("Start-Process", source)
        self.assertNotIn("TrustedPublisher", source)

    @unittest.skipIf(setup.os.name == "nt", "Non-Windows guard only")
    def test_non_windows_is_blocked_without_changing_services_or_installing_driver(self):
        with tempfile.TemporaryDirectory() as temporary, redirect_stdout(io.StringIO()):
            code = setup.main(["--output", temporary, "--ephemeral-ci", "--start-existing-services"])
            report = json.loads((Path(temporary) / "audio-endpoint.json").read_text(encoding="utf-8"))
        self.assertEqual(code, 2)
        self.assertEqual(report["status"], "blocked")
        self.assertFalse(report["driver_installed"])
        self.assertFalse(report["wave_player_verified"])
        self.assertFalse(report["physical_audio_verified"])


if __name__ == "__main__":
    unittest.main()
