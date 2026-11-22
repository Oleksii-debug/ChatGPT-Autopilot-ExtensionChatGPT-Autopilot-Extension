import copy
import ast
import hashlib
import importlib.util
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("_package_receipt", ROOT / "tools/validate_source13_package_receipt.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def fixture():
    base = M.base_validator()
    pin = {"format": "dordiai-source13-build-pin", "format_version": 1,
           "version": "0.13.1-dev.13", "status": "actual-build-verified", "source_run_id": 123,
           "source_commit": "1"*40, "source_workflow_path": ".github/workflows/dordiai-source13-integration.yml",
           "artifact_id": 456, "artifact_name": "dordiai-source13-core", "artifact_bytes": 100,
           "artifact_sha256": "2"*64, "archive_name": "dordiai-voices-0.13.1-dev.13.nvda-addon",
           "archive_bytes": 100, "archive_sha256": "3"*64, "product_ready": False}
    document = {"status": "partial", "product_ready": False, "recording_pcm_sink_test_double": True,
                "wave_player_verified": False, "physical_audio_verified": False,
                "acoustic_latency_verified": False, "checks": [{"name": "physical_audio_output", "status": "blocked"}]}
    report = copy.deepcopy(document)
    report.update(addon_sha256=pin["archive_sha256"], installer_sha256=base.INSTALLER_SHA256)
    probe = report["probe"] = copy.deepcopy(document)
    probe["nvda_version_actual"] = "2026.3.1"
    lifecycle = {"functional_pipeline_verified": True, "api_dispatched_operations": True, "process_id": 1234,
                 "original_core_profile_sha256": "4"*64, "steps": []}
    for key in ("native_file_chooser_interaction_verified", "full_keyboard_accessibility_verified",
                "actual_restart_upgrade_verified", "physical_audio_verified", "product_ready"):
        lifecycle[key] = False
    probe["voice_package_lifecycle"] = lifecycle
    for index, (name, active, inactive) in enumerate(M.PLAN):
        text = "Помилка перевірки." if name in {"corrupt-rejected", "locked-remove"} else "Пакет змінено й перевірено."
        row = {"name": name, "active_version": active, "inactive_version": inactive,
               "settings_dialog_title": "Налаштування голосів",
               "index_format_version": 2 if inactive else 1, "old_driver_id": index+1, "new_driver_id": index+2,
               "labels": {key: "Справжня кнопка" for key in ("install_package", "remove_package", "rollback_package")},
               "completion_modal": {"kind": "nvda-wx-message-dialog", "module": "gui.message",
                                    "class": "MessageDialog", "pid": 1234, "title": "Налаштування голосів",
                                    "visible": True, "modal": True, "ok_id": 5100, "button_id": 5100,
                                    "button_parent_owned": True, "button_is_wx_button": True,
                                    "button_label": "OK", "ack_method": "wx.EVT_BUTTON",
                                    "ok_posted": True, "text": text}, "result_notice": text,
               "package_list": ["Голос — неактивний"] if inactive else [],
               "managed_profile_sha256": "4"*64 if active else None}
        row.update({key: True for key in ("fresh_driver", "old_driver_closed", "old_thread_stopped",
                    "espeak_selected_before_async_mutation", "core_profile_unchanged", "maintenance_released")})
        lifecycle["steps"].append(row)
        probe["checks"].append({"name": "voice_package_" + name, "status": "passed", "observations": copy.deepcopy(row)})
    probe["checks"].append({"name": "voice_package_functional_pipeline", "status": "passed", "operations": 10})
    return report, pin


class ReceiptTests(unittest.TestCase):
    def test_complete_fixture_is_functional_only(self):
        report, pin = fixture()
        result = M.validate(report, pin, headless=True)
        self.assertEqual(result["operations"], 10)
        self.assertFalse(result["product_ready"])
        self.assertFalse(result["full_keyboard_accessibility_verified"])

    def test_placeholder_pin_cannot_be_accepted(self):
        report, pin = fixture()
        pin["status"] = "awaiting-actual-build"
        with self.assertRaises(ValueError): M.validate(report, pin, headless=True)

    def test_operation_order_versions_and_exact_data_are_required(self):
        for key, value in (("name", "different"), ("active_version", "9.0.0"),
                           ("managed_profile_sha256", "f"*64), ("index_format_version", 2)):
            with self.subTest(key=key):
                report, pin = fixture()
                report["probe"]["voice_package_lifecycle"]["steps"][0][key] = value
                with self.assertRaises(ValueError): M.validate(report, pin, headless=True)

    def test_retained_inactive_rows_require_v2_and_visible_label(self):
        for key, value in (("index_format_version", 1), ("package_list", [])):
            report, pin = fixture()
            report["probe"]["voice_package_lifecycle"]["steps"][4][key] = value
            with self.assertRaises(ValueError): M.validate(report, pin, headless=True)

    def test_worker_retirement_and_fallback_are_required(self):
        for key in ("fresh_driver", "old_driver_closed", "old_thread_stopped",
                    "espeak_selected_before_async_mutation", "core_profile_unchanged", "maintenance_released"):
            report, pin = fixture()
            report["probe"]["voice_package_lifecycle"]["steps"][0][key] = False
            with self.assertRaises(ValueError): M.validate(report, pin, headless=True)

    def test_native_modal_and_real_error_notice_are_required(self):
        for key, value in (("class", "#32770"), ("module", "wx"), ("kind", "fake"),
                           ("ok_posted", False), ("pid", 0), ("pid", 5678), ("title", "Unowned"),
                           ("ok_id", 1), ("button_id", 1), ("modal", False), ("button_parent_owned", False),
                           ("button_is_wx_button", False), ("button_label", "Cancel"), ("ack_method", "fake-return")):
            report, pin = fixture()
            report["probe"]["voice_package_lifecycle"]["steps"][3]["completion_modal"][key] = value
            with self.assertRaises(ValueError): M.validate(report, pin, headless=True)
        report, pin = fixture()
        step = report["probe"]["voice_package_lifecycle"]["steps"][3]
        step["result_notice"] = step["completion_modal"]["text"] = "Пакет змінено й перевірено."
        with self.assertRaises(ValueError): M.validate(report, pin, headless=True)

    def test_api_dispatch_cannot_claim_other_acceptance(self):
        for key in ("native_file_chooser_interaction_verified", "full_keyboard_accessibility_verified",
                    "actual_restart_upgrade_verified", "physical_audio_verified", "product_ready"):
            report, pin = fixture()
            report["probe"]["voice_package_lifecycle"][key] = True
            with self.assertRaises(ValueError): M.validate(report, pin, headless=True)

    def test_missing_duplicate_or_contradictory_check_stream_fails(self):
        for change in ("missing", "duplicate", "different", "final"):
            report, pin = fixture()
            checks = report["probe"]["checks"]
            if change == "missing": checks.pop(1)
            elif change == "duplicate": checks.append(copy.deepcopy(checks[1]))
            elif change == "different": checks[1]["observations"]["fresh_driver"] = False
            else: checks[-1]["operations"] = 9
            with self.assertRaises(ValueError): M.validate(report, pin, headless=True)


class WorkflowContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = (ROOT.parent / ".github/workflows/dordiai-source13-package-gui.yml").read_text(encoding="utf-8")

    def test_gate_is_separate_and_precedes_every_download(self):
        text = self.workflow
        self.assertIn("[source13-package-gui]", text)
        self.assertIn("mode: [voice-packages]", text)
        self.assertLess(text.index("pin=module.read_pin("), text.index('actual=fetch('))
        self.assertLess(text.index("pin=module.read_pin("), text.index("uses: actions/download-artifact@"))
        self.assertNotIn("contents: write", text)
        self.assertNotIn("actions: write", text)
        self.assertIn('"--build-pin"', text)
        self.assertIn("a942b244281f1db94fd2f434dd2c570922c83583", text)

    def test_validator_pin_and_all_inline_python_compile(self):
        raw = (ROOT / "tools/validate_source13_package_receipt.py").read_bytes()
        digest = hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()
        self.assertIn('"tools/validate_source13_package_receipt.py":"' + digest + '"', self.workflow)
        python_next = False
        lines = self.workflow.splitlines()
        scripts = []
        for index, line in enumerate(lines):
            if line.strip() == "shell: python": python_next = True
            if python_next and line.strip() == "run: |":
                body = []
                for part in lines[index+1:]:
                    if part and not part.startswith("          "): break
                    body.append(part[10:] if part else "")
                scripts.append("\n".join(body))
                python_next = False
        self.assertEqual(len(scripts), 4)
        for script in scripts: ast.parse(script)


if __name__ == "__main__": unittest.main()
