"""Validate isolated exact-source12 keyboard receipts; no product/audio claim."""
import argparse
import json
from pathlib import Path

CORE_SHA256 = "908a9825a8f3e1574d9d0a370ac0e35e1e1683eb04b998a937c312f0ce3ec573"
INSTALLER_SHA256 = "6f80a5b0ca720a7d0d314b5be212f37388bbe81a1107ac3298c1821a1cd3f052"
SCENARIOS = ("characters-only", "navigation", "forced-uk", "disabled-ru")


def require(passed, message):
    if not passed:
        raise ValueError(message)


def validate(report, scenario, *, headless):
    require(scenario in SCENARIOS, "Unrecognized source12 keyboard scenario")
    require(isinstance(report, dict), "Controller report must be an object")
    probe = report.get("probe")
    require(isinstance(probe, dict), "Actual NVDA report is missing")
    require(report.get("addon_sha256") == CORE_SHA256, "Actual installed archive pin differs")
    require(report.get("installer_sha256") == INSTALLER_SHA256, "Official installer pin differs")
    require(probe.get("nvda_version_actual") == "2026.3.1", "Actual NVDA version differs")
    for document in (report, probe):
        require(document.get("product_ready") is False, "A keyboard receipt cannot establish product readiness")
        require(document.get("status") == ("partial" if headless else "passed"), "Unexpected controller/host status")
        if headless:
            require(document.get("recording_pcm_sink_test_double") is True, "Headless sink must be explicit")
            for name in ("physical_audio_verified", "wave_player_verified", "acoustic_latency_verified"):
                require(document.get(name) is False, "Headless proof cannot verify output device or acoustics")
        checks = document.get("checks")
        require(isinstance(checks, list) and checks, "Missing host/controller checks")
        for check in checks:
            require(isinstance(check, dict), "Malformed check")
            passed = check.get("status") == "passed"
            scoped_block = (headless and check.get("status") == "blocked" and
                check.get("name") in {"windows_audio_output_enumeration", "physical_audio_output"})
            require(passed or scoped_block, "Unexpected failed/blocked check: " + str(check.get("name")))
    typed = probe.get("actual_typing")
    require(isinstance(typed, dict) and typed.get("scenario") == scenario, "Actual keyboard scenario differs")
    require(typed.get("no_manual_language_commands") is True, "Keyboard language commands must come from NVDA")
    cleanup = typed.get("cleanup", {})
    require(cleanup.get("errors") == [] and all(cleanup.get(name) is True for name in
        ("keyboard_config_restored", "keyboard_layout_restored", "speech_mode_restored")),
        "Actual keyboard configuration/layout/speech mode were not restored")
    rows = typed.get("cases")
    expected_count = {"characters-only": 9, "navigation": 2, "forced-uk": 1, "disabled-ru": 1}[scenario]
    require(isinstance(rows, list) and len(rows) == expected_count, "Wrong genuine typed-key count")
    for row in rows:
        require(isinstance(row, dict) and row.get("status") == "passed" and
            row.get("routing_status") == "passed", "Genuine typed-key or route failed")
        require(row.get("actual_control_value") == row.get("expected_control_value"), "Actual Edit value differs")
        require(not row.get("driver_error"), "Synthesis error during genuine typing")
        require(bool(row.get("typed_events")) and bool(row.get("raw_keys")), "No genuine keyboard event observation")
    if scenario == "characters-only":
        require(typed.get("speak_typed_words") == 0 and typed.get("speak_typed_characters") != 0,
            "Native word echo is not disabled while character echo remains enabled")
        absent = [row for row in rows if "word_echo_must_be_absent" in row]
        require(len(absent) == 2, "Both English/Russian word boundaries must be tested")
        for row in absent:
            expected_absent = row["word_echo_must_be_absent"]
            require(row.get("word_echo_matches") is True and not any(
                item.get("text", "").strip() == expected_absent
                for sequence in row.get("normal_typed_speech", []) for item in sequence),
                "Native word echo sounded despite its disabled setting")
    elif scenario == "navigation":
        navigation = typed.get("navigation_cases")
        require(isinstance(navigation, list) and len(navigation) == 2, "Missing real Backspace/LeftArrow cases")
        require([row.get("action") for row in navigation] == ["Backspace", "LeftArrow"],
            "Native navigation workload differs")
        for row in navigation:
            require(row.get("status") == "passed" and row.get("input_language") == "ru" and
                row.get("language") == "uk" and row.get("effective_languages") == ["uk"],
                "Russian input locale leaked into document navigation")
            require(row.get("actual_control_value") == row.get("expected_control_value") and
                row.get("actual_insertion_point") == row.get("expected_insertion_point"),
                "Actual native deletion/caret position differs")
            require(row.get("expected_label") in [part.get("text", "").strip() for part in row.get("routes", [])],
                "Navigation did not use its exact Ukrainian character name")
    else:
        application = typed.get("preference_application", {})
        require(application.get("mode") == ("forced" if scenario == "forced-uk" else "auto") and
            application.get("default_language") == "uk" and application.get("expected_route") == "uk",
            "Actual preference application differs")
        if scenario == "disabled-ru":
            require("ru" not in application.get("enabled_languages", []), "Russian remains enabled")
        require(typed.get("preference_restoration", {}).get("restored") is True,
            "Actual driver preferences were not restored")
        require(rows[0].get("language") == "ru" and rows[0].get("effective_languages") == ["uk"],
            "Real Russian input did not obey forced/disabled Ukrainian routing")
    return {"format": "dordiai-source12-typing-scenario-validation", "format_version": 1,
        "scenario": scenario, "status": "passed-functional-only", "typed_key_count": len(rows),
        "navigation_key_count": len(typed.get("navigation_cases", [])), "core_sha256": CORE_SHA256,
        "headless": bool(headless), "product_ready": False,
        "physical_audio_verified": probe.get("physical_audio_verified") is True,
        "scope": "Real owned NVDA key handlers and receipt integrity; not pronunciation or acoustic acceptance"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True)
    parser.add_argument("--scenario", required=True, choices=SCENARIOS)
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args(argv)
    path = Path(args.report)
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 16 * 1024 * 1024,
        "Actual owned controller report must be a bounded regular file")
    print(json.dumps(validate(json.loads(path.read_text(encoding="utf-8")), args.scenario,
        headless=args.headless), ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
