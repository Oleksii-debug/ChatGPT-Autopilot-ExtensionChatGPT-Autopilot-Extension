"""Source13 receipt fixtures and unchanged historical-auditor contracts."""
import ast
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import textwrap
import unittest

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
new=load("_source13_receipt",ROOT/"tools/validate_source13_integration_receipt.py")
old=load("_source12_receipt",ROOT/"tools/validate_source12_typing_receipt.py")
typed_fixtures=load("_typing12_fixture_data",ROOT/"tests/test_source12_typing_receipt.py")
plain_fixtures=load("_plain_existing_fixture_data",ROOT/"tests/test_windows_nvda_plain_text_probe.py")


def pin():
    return {"format":"dordiai-source13-build-pin","format_version":1,"version":"0.13.1-dev.13",
        "status":"actual-build-verified","source_run_id":13,"source_commit":"1"*40,
        "source_workflow_path":".github/workflows/dordiai-source13-integration.yml",
        "artifact_id":14,"artifact_name":"dordiai-source13-development-core-13","artifact_bytes":400,
        "artifact_sha256":"2"*64,"archive_name":"dordiai-voices-0.13.1-dev.13.nvda-addon",
        "archive_bytes":300,"archive_sha256":"3"*64,"product_ready":False}


def report(mode):
    r=typed_fixtures.fixture(mode if mode in new.SCENARIOS else "characters-only")
    r["addon_sha256"]=pin()["archive_sha256"]
    p=r["probe"]
    if mode=="typing":
        t=p["actual_typing"];t["scenario"]="standard";t["speak_typed_words"]=1
        for row in t["cases"]:
            row.pop("word_echo_must_be_absent",None);row["word_echo_matches"]=True
    elif mode=="plain-text":
        api=plain_fixtures.logic();rows=[]
        for case in api["_plain_cases"]():
            pieces=sum(len(api["_plain_tokens"](w["word"])) for w in case["words"])
            rows.append({"case":case["name"],"input_text":case["text"],"source_words":case["words"],
                "functional_passed":True,"driver_error":None,
                "route_audit":{"routing_passed":True,"mismatches":[],"input_lexical_piece_count":pieces,
                    "observed_lexical_piece_count":pieces,"raw_nonwhitespace_text_preserved":True}})
        p["actual_plain_text"]={"cases":rows,"cleanup":{"errors":[],"private_config_restored":True}}
    elif mode=="normal":
        p["api_latency"]={"alphabet_first_pass":{"count":176},"languages":["uk","en","ru"],
            "warm_letters":{"count":100},"cancel_api":{"count":100},"warm_switch_requests":{"count":100},
            "samples":{"errors":[],"timeouts":[]}}
        p["injected_fatal_recovery"]={"injected":True,"active_synth":"espeak",
            "configured_synth_preserved":True,"old_driver_closed":True,"old_driver_thread_stopped":True,
            "recording_sink_nonzero_bytes":10}
        for name in ("warm_letter_predevice_target","cancel_api_target"):
            p["checks"].append({"name":name,"status":"blocked","measurements":{"count":100},
                "reason":"Recording sink double: internal queue measurements cannot establish audio"})
    elif mode=="ru-missing":
        p["required_resource_recovery"]={"synthetic_error_injected":False,"asset_missing_before_nvda_launch":True,
            "quarantine_verified_before_request":True,"active_synth":"espeak","configured_synth_preserved":True,
            "old_driver_closed":True,"old_driver_thread_stopped":True,"notice_pcm_nonzero_bytes":1,
            "recovery":{"reason":"required-resource-unavailable"}}
        r["required_resource_cleanup"]={"status":"passed","restoration":{"restored":True,"sha256_identical":True}}
    elif mode=="descriptor-corruption":
        p["native_descriptor_recovery"]={"synthetic_exception_injected":False,"descriptor_corrupted":True,
            "mapped_binary_modified_or_renamed":False,"active_synth":"espeak","configured_synth_preserved":True,
            "old_driver_closed":True,"old_driver_thread_stopped":True,"native_resource_closed":True,
            "native_mapping_reader_released":True,"notice_pcm_nonzero_bytes":1,
            "recovery":{"reason":"native-word-membership-unavailable"}}
    return r


def restoration():
    return {"status":"passed","sha256":new.DESCRIPTOR_SHA256,"bytes":558,
        "mapped_binary_modified_or_renamed":False}


class PinAndUnchangedAuditTests(unittest.TestCase):
    def test_checked_in_unfilled_pin_fails_closed_before_download(self):
        path=ROOT/"tools/data/source13_build_pin.json"
        value=json.loads(path.read_text(encoding="utf-8"))
        if value.get("status")=="awaiting-actual-build":
            with self.assertRaisesRegex(ValueError,"download is forbidden"):new.read_pin(path)
            self.assertIsNone(value["source_run_id"])
            self.assertIsNone(value["archive_sha256"])
        else:
            self.assertEqual(new.read_pin(path)["version"],"0.13.1-dev.13")

    def test_schema_rejects_missing_actual_identity_size_hash_or_wrong_version(self):
        for key,value in (("format_version",True),("source_run_id",True),("source_run_id",None),("source_commit",None),
            ("artifact_sha256",""),("archive_bytes",3000000001),("artifact_id",0),
            ("source_workflow_path",".github/workflows/dordiai-source12-integration.yml"),
            ("archive_name","dordiai-voices-0.13.1-dev.12.nvda-addon"),("product_ready",True)):
            candidate=pin();candidate[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):new.validate_pin(candidate)

    def test_historical12_typing_validation_branches_are_unchanged(self):
        source=ast.parse((ROOT/"tools/validate_source12_typing_receipt.py").read_text(encoding="utf-8"))
        expected=copy.deepcopy(next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=="validate"))
        expected.name="validate_typing";expected.args.kwonlyargs.append(ast.arg(arg="core_sha256"))
        expected.args.kw_defaults.append(None)
        class RenamePin(ast.NodeTransformer):
            def visit_Name(self,node):
                if node.id=="CORE_SHA256":node.id="core_sha256"
                return node
            def visit_Constant(self,node):
                if node.value=="dordiai-source12-typing-scenario-validation":
                    node.value="dordiai-source13-typing-scenario-validation"
                return node
        expected=RenamePin().visit(expected)
        target=ast.parse((ROOT/"tools/validate_source13_integration_receipt.py").read_text(encoding="utf-8"))
        actual=next(n for n in target.body if isinstance(n,ast.FunctionDef) and n.name=="validate_typing")
        self.assertEqual(ast.dump(actual,include_attributes=False),ast.dump(expected,include_attributes=False))

    def test_all_nine_scoped_fixtures_pass_but_never_product_readiness(self):
        for mode in new.MODES:
            with self.subTest(mode=mode):
                result=new.validate_mode(report(mode),mode,pin(),headless=True,
                    descriptor_restoration=restoration() if mode=="descriptor-corruption" else None)
                self.assertEqual(result["status"],"passed-functional-only")
                self.assertFalse(result["product_ready"]);self.assertFalse(result["physical_audio_verified"])

    def test_source12_digest_cannot_be_accepted_as_source13(self):
        for mode in new.MODES:
            r=report(mode);r["addon_sha256"]=old.CORE_SHA256
            with self.subTest(mode=mode),self.assertRaises(ValueError):
                new.validate_mode(r,mode,pin(),headless=True,descriptor_restoration=restoration())

    def test_original100_and_plain_audit_cannot_be_relaxed(self):
        for path,value in (("input_text","changed"),("source_words",[])):
            r=report("plain-text");r["probe"]["actual_plain_text"]["cases"][0][path]=value
            with self.assertRaises(ValueError):new.validate_mode(r,"plain-text",pin(),headless=True)
        r=report("plain-text");r["probe"]["actual_plain_text"]["cases"][0]["route_audit"]["mismatches"]=[{"word":"bad"}]
        with self.assertRaises(ValueError):new.validate_mode(r,"plain-text",pin(),headless=True)

    def test_normal_counts_timeouts_and_unexpected_blocks_fail(self):
        for field,value in (("errors",["failure"]),("timeouts",["timeout"])):
            r=report("normal");r["probe"]["api_latency"]["samples"][field]=value
            with self.assertRaises(ValueError):new.validate_mode(r,"normal",pin(),headless=True)
        r=report("normal");r["probe"]["checks"].append({"name":"unknown","status":"blocked"})
        with self.assertRaises(ValueError):new.validate_mode(r,"normal",pin(),headless=True)
        r=report("normal");r["probe"]["checks"]=[c for c in r["probe"]["checks"] if c["name"]!="cancel_api_target"]
        with self.assertRaises(ValueError):new.validate_mode(r,"normal",pin(),headless=True)
        r=report("normal")
        next(c for c in r["probe"]["checks"] if c["name"]=="warm_letter_predevice_target")["status"]="passed"
        with self.assertRaises(ValueError):new.validate_mode(r,"normal",pin(),headless=True)

    def test_standard_genuine_typing_cleanup_and_events_are_required(self):
        r=report("typing");r["probe"]["actual_typing"]["cleanup"]["errors"]=["not-restored"]
        with self.assertRaises(ValueError):new.validate_mode(r,"typing",pin(),headless=True)
        r=report("typing");r["probe"]["actual_typing"]["cases"][0]["typed_events"]=[]
        with self.assertRaises(ValueError):new.validate_mode(r,"typing",pin(),headless=True)

    def test_real_fault_and_exact_restoration_cannot_be_replaced_by_injection(self):
        r=report("ru-missing");r["probe"]["required_resource_recovery"]["synthetic_error_injected"]=True
        with self.assertRaises(ValueError):new.validate_mode(r,"ru-missing",pin(),headless=True)
        r=report("descriptor-corruption");r["probe"]["native_descriptor_recovery"]["native_resource_closed"]=False
        with self.assertRaises(ValueError):new.validate_mode(r,"descriptor-corruption",pin(),headless=True,descriptor_restoration=restoration())
        restored=restoration();restored["sha256"]="0"*64
        with self.assertRaises(ValueError):new.validate_mode(report("descriptor-corruption"),"descriptor-corruption",
            pin(),headless=True,descriptor_restoration=restored)

    def test_recording_sink_cannot_claim_physical_acoustic_or_product_success(self):
        for key in ("product_ready","physical_audio_verified","wave_player_verified","acoustic_latency_verified"):
            r=report("plain-text");r["probe"][key]=True
            with self.assertRaises(ValueError):new.validate_mode(r,"plain-text",pin(),headless=True)


class WorkflowContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow=(ROOT.parent/".github/workflows/dordiai-source13-nvda.yml").read_text(encoding="utf-8")

    def test_nine_modes_and_new_unique_gate_preserve_historical_workflow(self):
        self.assertIn("'[source13-nvda]'",self.workflow)
        self.assertIn("mode: [normal, typing, plain-text, ru-missing, descriptor-corruption, characters-only, navigation, forced-uk, disabled-ru]",self.workflow)
        old_workflow=(ROOT.parent/".github/workflows/dordiai-source12-nvda.yml").read_text(encoding="utf-8")
        self.assertIn("source12_build_pin.json",old_workflow)
        self.assertNotIn("source13_build_pin",old_workflow)

    def test_placeholder_gate_precedes_every_request_and_download(self):
        w=self.workflow
        self.assertLess(w.index("pin=module.read_pin"),w.index("urllib.request.Request"))
        self.assertLess(w.index("pin=module.read_pin"),w.index("actions/download-artifact"))
        self.assertIn('actual.get("conclusion")!="success"',w)
        self.assertIn('artifact.get("digest")!="sha256:"+pin["artifact_sha256"]',w)

    def test_exact_historical_probe_and_new_validator_pins_match(self):
        body=self.workflow.split("          tools=",1)[1].split("          for relative,expected",1)[0]
        for relative,digest in ast.literal_eval(textwrap.dedent(body).strip()).items():
            raw=(ROOT/relative).read_bytes()
            actual=hashlib.sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest()
            self.assertEqual(actual,digest,relative)

    def test_all_python_steps_compile_and_reports_remain_scoped(self):
        count=0
        for step in self.workflow.split("      - "):
            if "        shell: python\n" not in step or "        run: |\n" not in step:continue
            block=step.split("        run: |\n",1)[1];lines=[]
            for line in block.splitlines(True):
                if line.strip() and not line.startswith("          "):break
                lines.append(line)
            ast.parse(textwrap.dedent("".join(lines)));count+=1
        self.assertEqual(count,4)
        self.assertIn("subprocess.run(validation,check=True)",self.workflow)
        self.assertIn("if: always()",self.workflow)
        self.assertIn("gzip.compress(encoded,mtime=0)",self.workflow)

if __name__=="__main__":unittest.main()
