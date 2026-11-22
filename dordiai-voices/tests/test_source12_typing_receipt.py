"""Strict receipt fixtures; these unit objects are never NVDA execution proof."""
import ast
import copy
import importlib.util
import json
from hashlib import sha1
from pathlib import Path
import tempfile
import textwrap
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("_typing12_acceptance",ROOT/"tools/validate_source12_typing_receipt.py")
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


def fixture(scenario):
    def row(language="ru",effective="uk",glyph="а"):
        return {"language":language,"effective_languages":[effective],"glyph":glyph,"status":"passed",
            "routing_status":"passed","expected_control_value":glyph,"actual_control_value":glyph,
            "typed_events":[{"glyph":glyph}],"raw_keys":[{"pressed":True,"injected":True}],"driver_error":None}
    count={"characters-only":9,"navigation":2,"forced-uk":1,"disabled-ru":1}[scenario]
    rows=[row() for _ in range(count)]
    typed={"scenario":scenario,"no_manual_language_commands":True,"cases":rows,
        "cleanup":{"errors":[],"keyboard_config_restored":True,"keyboard_layout_restored":True,
                   "speech_mode_restored":True},"speak_typed_words":1,"speak_typed_characters":1}
    if scenario=="characters-only":
        typed["speak_typed_words"]=0
        for item,word in zip(rows[-2:],("ab","абы")):
            item.update(word_echo_must_be_absent=word,word_echo_matches=True,normal_typed_speech=[[{"text":"letter"}]])
    elif scenario=="navigation":
        typed["navigation_cases"]=[]
        for name,label in (("Backspace","ї"),("LeftArrow","бе")):
            typed["navigation_cases"].append({"action":name,"status":"passed","language":"uk","input_language":"ru",
                "effective_languages":["uk"],"actual_control_value":"б","expected_control_value":"б",
                "actual_insertion_point":0,"expected_insertion_point":0,"expected_label":label,
                "routes":[{"text":label}]})
    else:
        typed["preference_application"]={"mode":"forced" if scenario=="forced-uk" else "auto",
            "default_language":"uk","expected_route":"uk","enabled_languages":["uk","en"]}
        typed["preference_restoration"]={"restored":True}
    flags={"status":"partial","product_ready":False,"recording_pcm_sink_test_double":True,
        "physical_audio_verified":False,"wave_player_verified":False,"acoustic_latency_verified":False}
    probe={**flags,"nvda_version_actual":"2026.3.1","actual_typing":typed,
        "checks":[{"name":"physical_audio_output","status":"blocked"},{"name":"actual_typing_language_routes","status":"passed"}]}
    return {**flags,"addon_sha256":module.CORE_SHA256,"installer_sha256":module.INSTALLER_SHA256,"probe":probe,
        "checks":[{"name":"windows_audio_output_enumeration","status":"blocked"},
                  {"name":"official_installer_checksum","status":"passed"}]}


class ReceiptValidationTests(unittest.TestCase):
    def test_four_complete_scoped_fixtures_pass_without_product_acceptance(self):
        for scenario in module.SCENARIOS:
            with self.subTest(scenario=scenario):
                result=module.validate(fixture(scenario),scenario,headless=True)
                self.assertEqual(result["status"],"passed-functional-only")
                self.assertFalse(result["product_ready"])
                self.assertFalse(result["physical_audio_verified"])

    def reject(self,report,scenario="forced-uk"):
        with self.assertRaises(ValueError):module.validate(report,scenario,headless=True)

    def test_wrong_archive_installer_or_host_is_rejected(self):
        for key in ("addon_sha256","installer_sha256"):
            r=fixture("forced-uk");r[key]="0"*64;self.reject(r)
        r=fixture("forced-uk");r["probe"]["nvda_version_actual"]="2026.1";self.reject(r)

    def test_product_device_or_acoustic_claim_cannot_leak_from_headless_receipt(self):
        for target in ("controller","probe"):
            for name in ("product_ready","physical_audio_verified","wave_player_verified","acoustic_latency_verified"):
                r=fixture("forced-uk");document=r if target=="controller" else r["probe"]
                document[name]=True;self.reject(r)

    def test_only_two_named_physical_blocks_are_allowed(self):
        for status in ("failed","blocked"):
            r=fixture("forced-uk");r["probe"]["checks"].append({"name":"unrecognized","status":status});self.reject(r)

    def test_missing_or_mismatched_actual_scenario_and_events_are_rejected(self):
        r=fixture("forced-uk");r["probe"]["actual_typing"]["scenario"]="standard";self.reject(r)
        for key in ("typed_events","raw_keys"):
            r=fixture("forced-uk");r["probe"]["actual_typing"]["cases"][0][key]=[];self.reject(r)

    def test_case_count_control_content_route_and_synthesis_errors_are_not_ignored(self):
        for key,value in (("actual_control_value","changed"),("routing_status","mismatch"),
                          ("status","failed"),("driver_error","ImportError")):
            r=fixture("forced-uk");r["probe"]["actual_typing"]["cases"][0][key]=value;self.reject(r)
        r=fixture("forced-uk");r["probe"]["actual_typing"]["cases"]*=2;self.reject(r)

    def test_cleanup_and_actual_preference_restoration_are_required(self):
        for key in ("keyboard_config_restored","keyboard_layout_restored","speech_mode_restored"):
            r=fixture("forced-uk");r["probe"]["actual_typing"]["cleanup"][key]=False;self.reject(r)
        r=fixture("forced-uk");r["probe"]["actual_typing"]["preference_restoration"]["restored"]=False;self.reject(r)

    def test_disabled_russian_must_be_disabled_and_actual_russian_key_routed_ukrainian(self):
        r=fixture("disabled-ru");r["probe"]["actual_typing"]["preference_application"]["enabled_languages"].append("ru")
        self.reject(r,"disabled-ru")
        r=fixture("disabled-ru");r["probe"]["actual_typing"]["cases"][0]["effective_languages"]=["ru"]
        self.reject(r,"disabled-ru")

    def test_native_word_echo_must_be_absent_at_both_tested_boundaries(self):
        r=fixture("characters-only");r["probe"]["actual_typing"]["speak_typed_words"]=1
        self.reject(r,"characters-only")
        r=fixture("characters-only");row=r["probe"]["actual_typing"]["cases"][-1]
        row["normal_typed_speech"]=[[{"text":row["word_echo_must_be_absent"]}]]
        self.reject(r,"characters-only")

    def test_navigation_must_keep_ukrainian_names_with_real_russian_input(self):
        for key,value in (("effective_languages",["ru"]),("actual_insertion_point",99),
                          ("input_language","uk"),("routes",[{"text":"бэ"}])):
            r=fixture("navigation");r["probe"]["actual_typing"]["navigation_cases"][-1][key]=value
            self.reject(r,"navigation")

    def test_cli_rejects_symlink_and_oversized_report(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/"report.json";source.write_text(json.dumps(fixture("forced-uk")),encoding="utf-8")
            link=root/"link.json"
            try:link.symlink_to(source)
            except (OSError,NotImplementedError):pass
            else:
                with self.assertRaises(ValueError):module.main(["--report",str(link),"--scenario","forced-uk","--headless"])
            with source.open("wb") as stream:stream.truncate(16*1024*1024+1)
            with self.assertRaises(ValueError):module.main(["--report",str(source),"--scenario","forced-uk","--headless"])


class WorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow=(ROOT.parent/".github/workflows/dordiai-source12-typing.yml").read_text(encoding="utf-8")

    def test_exact_four_scenarios_unique_push_gate_and_readonly_permissions(self):
        w=self.workflow
        self.assertIn("scenario: [characters-only, navigation, forced-uk, disabled-ru]",w)
        self.assertIn("'[source12-typing]'",w)
        self.assertIn("contents: read",w);self.assertIn("actions: read",w)
        self.assertNotIn("contents: write",w)
        self.assertNotIn("dordiai-voices-0.13.1-dev.10",w)

    def test_proven_build_and_artifact_and_tools_are_immutable_pins(self):
        for value in ("45040668513","14761553443","1992944744",
            module.CORE_SHA256,"be7f4e2468dc18bd155d2c205f89bf61c8e235a2",
            "48e1b921e16074a557cfb669124bdc6123cccb481a34fc4d10e7e8fad4e2064a",
            "93d1157d3762d7baf1db38d615aafb3c6378cacd",
            "47f8c1ec06ad41dac17845db5e79af705fb51abc"):
            self.assertIn(value,self.workflow)
        self.assertIn('hashlib.file_digest(stream,"sha256")',self.workflow)
        self.assertIn('actual.get("conclusion")!="success"',self.workflow)

    def test_exact_reviewed_tool_blob_pins_match_actual_candidate_files(self):
        block=self.workflow.split("          expected_tools=",1)[1].split("          for relative,expected",1)[0]
        expected=ast.literal_eval(textwrap.dedent(block).strip())
        for relative,digest in expected.items():
            raw=(ROOT/relative).read_bytes()
            actual=sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest()
            self.assertEqual(actual,digest,relative)

    def test_all_embedded_python_steps_compile(self):
        steps=self.workflow.split("      - ")
        count=0
        for step in steps:
            if "        shell: python\n" not in step or "        run: |\n" not in step:continue
            block=step.split("        run: |\n",1)[1]
            lines=[]
            for line in block.splitlines(True):
                if line.strip() and not line.startswith("          "):break
                lines.append(line)
            ast.parse(textwrap.dedent("".join(lines)))
            count+=1
        self.assertEqual(count,4)

    def test_actual_existing_controller_and_strict_receipt_validation_are_used(self):
        w=self.workflow
        self.assertIn("windows_nvda_membership_integration_probe.py",w)
        self.assertIn('"--typing-probe","--typing-scenario",scenario',w)
        self.assertIn("validate_source12_typing_receipt.py",w)
        self.assertIn("subprocess.run(validation,check=True)",w)
        self.assertIn("if: always()",w)
        self.assertIn("gzip.compress(encoded,mtime=0)",w)

if __name__=="__main__":unittest.main()
