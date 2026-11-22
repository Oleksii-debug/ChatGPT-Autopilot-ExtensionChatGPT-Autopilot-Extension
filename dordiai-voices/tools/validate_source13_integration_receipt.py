"""Receipt gates for a future exact source13 build; no missing-build bypass.

Historical source12 probes, workloads and validators remain byte-identical.
Only the four-keyboard receipt function below is copied with its expected core
digest parameterized; its decision branches are regression-compared to source12.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

INSTALLER_SHA256 = "6f80a5b0ca720a7d0d314b5be212f37388bbe81a1107ac3298c1821a1cd3f052"
SCENARIOS = ("characters-only", "navigation", "forced-uk", "disabled-ru")
MODES = ("normal", "typing", "plain-text", "ru-missing", "descriptor-corruption") + SCENARIOS
INPUT100_SHA256 = "c7cfa1ba024ee6f59bfa0152a4016318c9f8542fbec79f6b7accb07645acbe16"
DESCRIPTOR_SHA256 = "2de5611c384e933e19d1cdf5fda37f17bd5c4b7602d09964f53fdb7280877459"


def require(passed, message):
    if not passed:
        raise ValueError(message)


def read_json(path, limit=16*1024*1024):
    path=Path(path)
    require(path.is_file() and not path.is_symlink() and path.stat().st_size<=limit,
        "Receipt must be a bounded regular file")
    return json.loads(path.read_text(encoding="utf-8"))


def validate_pin(pin):
    require(isinstance(pin,dict), "Source13 build pin must be an object")
    require(pin.get("status")=="actual-build-verified",
        "Source13 has no verified actual build receipt; download is forbidden")
    require(pin.get("format")=="dordiai-source13-build-pin" and type(pin.get("format_version")) is int and pin["format_version"]==1
        and pin.get("version")=="0.13.1-dev.13" and pin.get("product_ready") is False,
        "Source13 build pin format/version/scope differs")
    for key in ("source_run_id","artifact_id"):
        require(type(pin.get(key)) is int and pin[key]>0,"Invalid actual build/artifact identity")
    for key in ("archive_bytes","artifact_bytes"):
        require(type(pin.get(key)) is int and 0<pin[key]<=3000000000,"Invalid bounded source13 artifact size")
    for key in ("archive_sha256","artifact_sha256"):
        require(isinstance(pin.get(key),str) and re.fullmatch("[0-9a-f]{64}",pin[key]) is not None,
            "Missing actual source13 SHA256")
    require(isinstance(pin.get("source_commit"),str) and
        re.fullmatch("[0-9a-f]{40}",pin["source_commit"]) is not None,"Missing actual source13 source commit")
    require(isinstance(pin.get("source_workflow_path"),str) and
        re.fullmatch(r"\.github/workflows/dordiai-source13-[a-z0-9-]+\.ya?ml",pin["source_workflow_path"]) is not None,
        "Actual source13 build workflow path is required")
    require(pin.get("archive_name")=="dordiai-voices-0.13.1-dev.13.nvda-addon",
        "Expected exact source13 archive name")
    require(isinstance(pin.get("artifact_name"),str) and
        re.fullmatch(r"dordiai-[A-Za-z0-9._-]*13[A-Za-z0-9._-]*",pin["artifact_name"]) is not None
        and len(pin["artifact_name"])<=200,"Expected owned source13 core artifact name")
    return pin


def read_pin(path):
    return validate_pin(read_json(path,65536))


def validate_typing(report, scenario, *, headless, core_sha256):
    require(scenario in SCENARIOS, "Unrecognized source12 keyboard scenario")
    require(isinstance(report, dict), "Controller report must be an object")
    probe = report.get("probe")
    require(isinstance(probe, dict), "Actual NVDA report is missing")
    require(report.get("addon_sha256") == core_sha256, "Actual installed archive pin differs")
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
    return {"format": "dordiai-source13-typing-scenario-validation", "format_version": 1,
        "scenario": scenario, "status": "passed-functional-only", "typed_key_count": len(rows),
        "navigation_key_count": len(typed.get("navigation_cases", [])), "core_sha256": core_sha256,
        "headless": bool(headless), "product_ready": False,
        "physical_audio_verified": probe.get("physical_audio_verified") is True,
        "scope": "Real owned NVDA key handlers and receipt integrity; not pronunciation or acoustic acceptance"}



def validate_basic(report, *, headless, core_sha256, normal=False):
    require(isinstance(report,dict) and isinstance(report.get("probe"),dict),"Actual controller/host receipt missing")
    require(report.get("addon_sha256")==core_sha256,"Actual installed source13 archive differs")
    require(report.get("installer_sha256")==INSTALLER_SHA256,"Official NVDA installer differs")
    probe=report["probe"]
    require(probe.get("nvda_version_actual")=="2026.3.1","Actual frozen NVDA version differs")
    allowed={"windows_audio_output_enumeration","physical_audio_output"}
    if normal:allowed.update(("warm_letter_predevice_target","cancel_api_target"))
    for document in (report,probe):
        require(document.get("product_ready") is False,"Integration alone cannot establish product readiness")
        require(document.get("status")==("partial" if headless else "passed"),"Unexpected actual receipt status")
        if headless:
            require(document.get("recording_pcm_sink_test_double") is True,"Headless output double must be explicit")
            for key in ("wave_player_verified","physical_audio_verified","acoustic_latency_verified"):
                require(document.get(key) is False,"A recording sink cannot verify devices or acoustics")
        checks=document.get("checks")
        require(isinstance(checks,list) and checks,"Actual NVDA checks missing")
        for row in checks:
            require(isinstance(row,dict),"Malformed actual check")
            passed=row.get("status")=="passed"
            blocked=headless and row.get("status")=="blocked" and row.get("name") in allowed
            require(passed or blocked,"Unexpected failed/blocked check: "+str(row.get("name")))
            if blocked and row["name"] in {"warm_letter_predevice_target","cancel_api_target"}:
                require(row.get("measurements",{}).get("count")==100 and row.get("reason","").startswith(
                    "Recording sink double: internal queue measurements"),"Unrecognized measurement exclusion")
    if normal and headless:
        names={"warm_letter_predevice_target","cancel_api_target"}
        observations=[row for document in (report,probe) for row in document["checks"]
            if row.get("name") in names]
        require({row.get("name") for row in observations}==names and all(
            row.get("status")=="blocked" and row.get("measurements",{}).get("count")==100 and
            row.get("reason","").startswith("Recording sink double: internal queue measurements")
            for row in observations),"Both headless measurement targets must remain explicitly blocked")
    return probe


def validate_cleanup(typed):
    cleanup=typed.get("cleanup",{})
    require(cleanup.get("errors")==[] and all(cleanup.get(key) is True for key in
        ("keyboard_config_restored","keyboard_layout_restored","speech_mode_restored")),
        "Real typing configuration/layout/speech mode were not restored")


def validate_mode(report, mode, pin, *, headless, descriptor_restoration=None):
    pin=validate_pin(pin)
    require(mode in MODES,"Unknown source13 integration mode")
    if mode in SCENARIOS:
        return validate_typing(report,mode,headless=headless,core_sha256=pin["archive_sha256"])
    probe=validate_basic(report,headless=headless,core_sha256=pin["archive_sha256"],normal=mode=="normal")
    counts={}
    if mode=="plain-text":
        plain=probe.get("actual_plain_text",{})
        rows=plain.get("cases",[])
        names=["auto_unmarked_100","forced_uk_unmarked_12","disabled_ru_unmarked_12",
            "native_rich_metadata_6","forced_uk_native_metadata_6","disabled_ru_native_metadata_6",
            "auto_native_known_compound_1"]
        require([row.get("case") for row in rows]==names,"Original seven plain cases differ")
        require(all(row.get("functional_passed") is True and not row.get("driver_error") and
            row.get("route_audit",{}).get("routing_passed") is True and
            row["route_audit"].get("mismatches")==[] for row in rows),"Genuine plain route/content failed")
        first=rows[0]
        require(hashlib.sha256(first.get("input_text","").encode("utf-8")).hexdigest()==INPUT100_SHA256
            and len(first.get("source_words",[]))==100
            and first["route_audit"].get("input_lexical_piece_count")==102
            and first["route_audit"].get("observed_lexical_piece_count")==102
            and first["route_audit"].get("raw_nonwhitespace_text_preserved") is True,
            "Original100 workload/content changed")
        require(plain.get("cleanup",{}).get("errors")==[] and
            plain["cleanup"].get("private_config_restored") is True,"Plain private settings were not restored")
        counts={"plain_cases":7,"original_source_words":100,"original_lexical_pieces":102}
    elif mode=="typing":
        typed=probe.get("actual_typing",{})
        require(typed.get("scenario")=="standard" and typed.get("no_manual_language_commands") is True,
            "Actual standard keyboard scenario differs")
        rows=typed.get("cases",[])
        require(len(rows)==9 and all(row.get("status")=="passed" and row.get("routing_status")=="passed"
            and row.get("actual_control_value")==row.get("expected_control_value")
            and row.get("typed_events") and row.get("raw_keys") and not row.get("driver_error")
            and row.get("word_echo_matches") is True for row in rows),"Real standard keyboard event/route failed")
        require(typed.get("speak_typed_words")!=0 and typed.get("speak_typed_characters")!=0,
            "Standard native echo settings differ")
        validate_cleanup(typed);counts={"standard_typed_keys":9}
    elif mode=="normal":
        metrics=probe.get("api_latency",{})
        require(metrics.get("alphabet_first_pass",{}).get("count")==176 and
            metrics.get("languages")==["uk","en","ru"],"Original core glyph workload differs")
        require(all(metrics.get(key,{}).get("count")==100 for key in
            ("warm_letters","cancel_api","warm_switch_requests")),"Repeated API workload differs")
        require(metrics.get("samples",{}).get("errors")==[] and
            metrics["samples"].get("timeouts")==[],"Repeated API errors/timeouts occurred")
        recovery=probe.get("injected_fatal_recovery",{})
        require(recovery.get("injected") is True and recovery.get("active_synth")=="espeak" and
            all(recovery.get(key) is True for key in
                ("configured_synth_preserved","old_driver_closed","old_driver_thread_stopped")) and
            recovery.get("recording_sink_nonzero_bytes",0)>0,
            "Injected notification-boundary recovery failed")
        counts={"first_pass_glyphs":176,"warm_letters":100,"switches":100,"cancel_calls":100}
    elif mode=="ru-missing":
        row=probe.get("required_resource_recovery",{})
        require(row.get("synthetic_error_injected") is False and
            row.get("asset_missing_before_nvda_launch") is True and
            row.get("quarantine_verified_before_request") is True,"Real missing-resource fault not proved")
        require(row.get("active_synth")=="espeak" and all(row.get(key) is True for key in
            ("configured_synth_preserved","old_driver_closed","old_driver_thread_stopped")) and
            row.get("notice_pcm_nonzero_bytes",0)>0 and
            row.get("recovery",{}).get("reason")=="required-resource-unavailable",
            "Genuine missing-resource fallback failed")
        cleanup=report.get("required_resource_cleanup",{})
        require(cleanup.get("status")=="passed" and cleanup.get("restoration",{}).get("restored") is True and
            cleanup["restoration"].get("sha256_identical") is True,"Exact required-resource restoration failed")
    elif mode=="descriptor-corruption":
        row=probe.get("native_descriptor_recovery",{})
        require(row.get("synthetic_exception_injected") is False and row.get("descriptor_corrupted") is True and
            row.get("mapped_binary_modified_or_renamed") is False,"Real bounded descriptor fault not proved")
        require(row.get("active_synth")=="espeak" and all(row.get(key) is True for key in
            ("configured_synth_preserved","old_driver_closed","old_driver_thread_stopped",
             "native_resource_closed","native_mapping_reader_released")) and
            row.get("notice_pcm_nonzero_bytes",0)>0 and
            row.get("recovery",{}).get("reason")=="native-word-membership-unavailable",
            "Genuine descriptor failure did not close resources and recover")
        require(isinstance(descriptor_restoration,dict) and descriptor_restoration.get("status")=="passed" and
            descriptor_restoration.get("sha256")==DESCRIPTOR_SHA256 and descriptor_restoration.get("bytes")==558 and
            descriptor_restoration.get("mapped_binary_modified_or_renamed") is False,
            "Exact original558B descriptor restoration failed")
    return {"format":"dordiai-source13-integration-validation","format_version":1,"mode":mode,
        "status":"passed-functional-only","core_sha256":pin["archive_sha256"],"counts":counts,
        "headless":bool(headless),"product_ready":False,
        "physical_audio_verified":probe.get("physical_audio_verified") is True,
        "scope":"Exact actual source13 core and unchanged probes/workloads; not optional-model or acoustic acceptance"}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pin",required=True)
    parser.add_argument("--report")
    parser.add_argument("--mode",choices=MODES)
    parser.add_argument("--headless",action="store_true")
    parser.add_argument("--descriptor-restoration")
    args=parser.parse_args(argv)
    pin=read_pin(args.pin)
    require(bool(args.report)==bool(args.mode),"Actual report and integration mode must be supplied together")
    if args.report:
        restoration=read_json(args.descriptor_restoration) if args.descriptor_restoration else None
        result=validate_mode(read_json(args.report),args.mode,pin,headless=args.headless,
            descriptor_restoration=restoration)
    else:
        result={"format":"dordiai-source13-build-preflight","status":"actual-pin-structurally-verified",
            "source_run_id":pin["source_run_id"],"archive_sha256":pin["archive_sha256"],
            "network_receipt_still_required":True,"product_ready":False}
    print(json.dumps(result,ensure_ascii=True,sort_keys=True))
    return 0


if __name__=="__main__":raise SystemExit(main())
