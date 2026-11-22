"""Gate the owned real-wx package pipeline without claiming full GUI acceptance."""
import argparse
import importlib.util
import json
from pathlib import Path


def base_validator():
    path = Path(__file__).with_name("validate_source13_integration_receipt.py")
    spec = importlib.util.spec_from_file_location("_source13_core_receipt", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PLAN = (
    ("install-v1", "1.0.0", None), ("install-v2", "2.0.0", None),
    ("rollback-v1", "1.0.0", None), ("corrupt-rejected", "1.0.0", None),
    ("locked-remove", None, "1.0.0"), ("retry-remove", None, None),
    ("install-again", "1.0.0", None), ("retain-files", None, "1.0.0"),
    ("activate-retained", "1.0.0", None), ("final-remove", None, None),
)


def validate(report, pin, *, headless):
    base = base_validator()
    require = base.require
    pin = base.validate_pin(pin)
    probe = base.validate_basic(report, headless=headless, core_sha256=pin["archive_sha256"])
    row = probe.get("voice_package_lifecycle", {})
    require(row.get("functional_pipeline_verified") is True and row.get("api_dispatched_operations") is True,
            "Real wx asynchronous package pipeline did not complete")
    for name in ("native_file_chooser_interaction_verified", "full_keyboard_accessibility_verified",
                 "actual_restart_upgrade_verified", "physical_audio_verified", "product_ready"):
        require(row.get(name) is False, "API-dispatch-only pipeline cannot claim " + name)
    steps = row.get("steps")
    require(isinstance(steps, list) and len(steps) == len(PLAN), "Ten real package operations are required")
    require(type(row.get("process_id")) is int and row["process_id"] > 0, "Owned NVDA process identity missing")
    profile_sha = row.get("original_core_profile_sha256")
    require(isinstance(profile_sha, str) and base.re.fullmatch("[0-9a-f]{64}", profile_sha) is not None,
            "Original permitted core profile SHA is missing")
    for step, (name, active, inactive) in zip(steps, PLAN):
        require(isinstance(step, dict) and step.get("name") == name, "Package lifecycle operation order differs")
        require(step.get("active_version") == active and step.get("inactive_version") == inactive,
                "Package active/inactive ownership differs")
        require(type(step.get("index_format_version")) is int and step["index_format_version"] == (2 if inactive else 1),
                "Durable voice index format differs")
        require(all(step.get(key) is True for key in ("fresh_driver", "old_driver_closed", "old_thread_stopped",
                    "espeak_selected_before_async_mutation", "core_profile_unchanged", "maintenance_released")),
                "Real speech maintenance/reload/core preservation failed")
        require(type(step.get("old_driver_id")) is int and type(step.get("new_driver_id")) is int
                and step["old_driver_id"] != step["new_driver_id"], "Fresh driver identity not observed")
        labels = step.get("labels", {})
        require(all(isinstance(labels.get(key), str) and labels[key].strip() for key in
                    ("install_package", "remove_package", "rollback_package")), "Real wx button labels missing")
        modal = step.get("completion_modal", {})
        require(modal.get("kind") == "nvda-wx-message-dialog" and modal.get("module") == "gui.message"
                and modal.get("class") == "MessageDialog" and type(modal.get("pid")) is int
                and modal["pid"] == row["process_id"] and isinstance(step.get("settings_dialog_title"), str)
                and step["settings_dialog_title"].strip() and modal.get("title") == step["settings_dialog_title"]
                and all(modal.get(key) is True for key in
                        ("visible", "modal", "button_parent_owned", "button_is_wx_button", "ok_posted"))
                and type(modal.get("ok_id")) is int and modal["ok_id"] == 5100
                and type(modal.get("button_id")) is int and modal["button_id"] == 5100
                and modal.get("button_label") == "OK" and modal.get("ack_method") == "wx.EVT_BUTTON",
                "Genuine owned NVDA2026.3.1 wx completion dialog/button not observed")
        notice = step.get("result_notice")
        require(isinstance(notice, str) and notice.strip() and notice == modal.get("text"),
                "Actual completion/error notice missing")
        require(("Пакет змінено й перевірено." in notice) == (name not in {"corrupt-rejected", "locked-remove"}),
                "Actual accessible success/error notice contradicts operation outcome")
        if active:
            require(step.get("managed_profile_sha256") == profile_sha, "Imported permitted profile bytes differ")
        require(isinstance(step.get("package_list"), list), "Real wx package-list readback missing")
        if inactive:
            require(any(isinstance(text, str) and "неактивний" in text for text in step["package_list"]),
                    "Retained inactive ownership is not labeled in the real list")
        matches = [check for check in probe["checks"] if check.get("name") == "voice_package_" + name]
        require(len(matches) == 1 and matches[0].get("status") == "passed"
                and matches[0].get("observations") == step,
                "Native operation check stream is missing, duplicated or differs from step readback")
    final = [check for check in probe["checks"] if check.get("name") == "voice_package_functional_pipeline"]
    require(len(final) == 1 and final[0].get("status") == "passed" and final[0].get("operations") == len(PLAN),
            "Actual final ten-operation completion check missing or mismatched")
    return {"format": "dordiai-source13-package-gui-validation", "format_version": 1,
            "status": "passed-functional-pipeline-only", "operations": len(steps),
            "core_sha256": pin["archive_sha256"], "product_ready": False,
            "native_file_chooser_interaction_verified": False, "full_keyboard_accessibility_verified": False,
            "actual_restart_upgrade_verified": False, "physical_audio_verified": False,
            "scope": "Real wx async API-dispatched maintenance and native notices; not complete GUI, keyboard, restart, pronunciation or acoustic acceptance"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pin", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args(argv)
    base = base_validator()
    pin = base.read_pin(args.pin)
    result = validate(base.read_json(args.report), pin, headless=args.headless)
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
