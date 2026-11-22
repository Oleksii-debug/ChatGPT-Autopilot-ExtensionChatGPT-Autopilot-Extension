"""Host-probe contracts only; real NVDA config API acceptance comes from Windows."""
import ast
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import textwrap
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("_personal_host_probe",ROOT/"tools/windows_nvda_personal_settings_probe.py")
probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
PAYLOAD=ROOT/"candidates/personal-language/host-inputs"


class InputAndTemplateTests(unittest.TestCase):
    def test_all_five_reviewed_inputs_match_exact_git_blob_pins(self):
        self.assertEqual(set(probe.EXPECTED_INPUTS),{
            "driver.py","personal_language.py","preferences.py","language_codes.py","language_iso_aliases.json"})
        for name,digest in probe.EXPECTED_INPUTS.items():
            raw=(PAYLOAD/name).read_bytes()
            self.assertEqual(hashlib.sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest(),digest)

    def test_owned_copies_are_exact_without_touching_reviewed_inputs(self):
        with tempfile.TemporaryDirectory() as temp:
            run=Path(temp)/"перевірка";run.mkdir()
            before={name:(PAYLOAD/name).read_bytes() for name in probe.EXPECTED_INPUTS}
            settings=probe.prepare_owned_inputs(PAYLOAD,PAYLOAD,run)
            self.assertEqual(set(settings["payload_sha256"]),set(probe.EXPECTED_INPUTS))
            for name,raw in before.items():
                self.assertEqual((PAYLOAD/name).read_bytes(),raw)
                self.assertEqual((run/"external"/name).read_bytes(),raw)

    def test_changed_or_missing_input_fails_before_launch(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);candidate=root/"candidate";shutil.copytree(PAYLOAD,candidate)
            (candidate/"driver.py").write_text("# changed\n",encoding="utf-8")
            run=root/"run";run.mkdir()
            with self.assertRaisesRegex(ValueError,"Git blob differs"):
                probe.prepare_owned_inputs(candidate,candidate,run)
            (candidate/"driver.py").unlink();other=root/"other";other.mkdir()
            with self.assertRaisesRegex(ValueError,"regular file"):
                probe.prepare_owned_inputs(candidate,candidate,other)

    def test_symlink_input_is_rejected_where_platform_allows_links(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);candidate=root/"candidate";shutil.copytree(PAYLOAD,candidate)
            path=candidate/"driver.py";path.unlink()
            try:path.symlink_to(PAYLOAD/"driver.py")
            except (OSError,NotImplementedError):self.skipTest("Symlink creation unavailable")
            run=root/"run";run.mkdir()
            with self.assertRaisesRegex(ValueError,"regular file"):
                probe.prepare_owned_inputs(candidate,candidate,run)

    def test_host_plugin_compiles_without_private_python_or_models(self):
        source=probe.HOST_PLUGIN.replace("__PERSONAL_SETTINGS__",repr({"run_id":"fixture"}))
        compile(source,"owned-real-settings-api-plugin","exec")
        self.assertIn("NativeSynthDriver",source)
        self.assertIn("prefs.PreferencesMixin",source)
        self.assertNotIn("onnxruntime",source)
        self.assertNotIn("RecordingSink",source)

    def test_real_config_profile_apis_and_exact_candidate_methods_are_used(self):
        source=probe.HOST_PLUGIN
        for marker in ("fixture.initSettings()","fixture.getConfigSpec()","fixture.loadSettings()",
            "fixture.saveSettings()","config.conf.createProfile(name)","config.conf.manualActivateProfile(a)",
            "config.conf.save()","config.conf.deleteProfile(name)","inspect.getattr_static(",
            'ConfigObj(str(profile_a_filename),encoding="UTF-8",file_error=True)'):
            self.assertIn(marker,source)
        self.assertIn('"actual_classmethod_config_api"',source)
        self.assertIn('"profile_a_choice_survives_profile_b_save"',source)

    def test_no_global_synth_selection_monkeypatch_or_fake_audio(self):
        tree=ast.parse(probe.HOST_PLUGIN.replace("__PERSONAL_SETTINGS__",repr({})))
        for node in ast.walk(tree):
            if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute):
                self.assertNotIn(node.func.attr,{"setSynth","speak","feed"})
            if isinstance(node,ast.Assign):
                for target in node.targets:
                    if isinstance(target,ast.Attribute):
                        self.assertNotIn(target.attr,{"getSynth","loadSettings","saveSettings","createProfile"})
        self.assertIn('raise AssertionError("A configuration-only fixture has no speech engine")',probe.HOST_PLUGIN)

    def test_exact_utf8_is_explicit_for_all_new_text_io(self):
        tree=ast.parse((ROOT/"tools/windows_nvda_personal_settings_probe.py").read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr in {"read_text","write_text"}:
                self.assertTrue(any(k.arg=="encoding" and isinstance(k.value,ast.Constant)
                    and k.value.value=="utf-8" for k in node.keywords),ast.unparse(node))
        inner=ast.parse(probe.HOST_PLUGIN.replace("__PERSONAL_SETTINGS__",repr({})))
        for node in ast.walk(inner):
            if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr in {"read_text","write_text"}:
                self.assertTrue(any(k.arg=="encoding" and isinstance(k.value,ast.Constant)
                    and k.value.value=="utf-8" for k in node.keywords),ast.unparse(node))

    @unittest.skipIf(os.name=="nt","Non-Windows refusal contract")
    def test_non_windows_cannot_report_actual_host_success(self):
        with tempfile.TemporaryDirectory() as temp,redirect_stdout(io.StringIO()):
            out=Path(temp)/"output"
            result=probe.main(["--candidate-dir",str(PAYLOAD),"--output",str(out)])
            report=json.loads((out/"controller.json").read_text(encoding="utf-8"))
            self.assertEqual(result,2)
            self.assertFalse(report["nvda_host_verified"])
            self.assertFalse(report["product_ready"])
            self.assertFalse(report["product_archive_used"])


class WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow=(ROOT.parent/".github/workflows/dordiai-personal-settings-host.yml").read_text(encoding="utf-8")

    def test_unique_gate_no_product_artifact_or_model_download(self):
        w=self.workflow
        self.assertIn("'[personal-settings-host]'",w)
        self.assertNotIn("actions/download-artifact",w)
        self.assertNotIn(".nvda-addon",w)
        self.assertIn("--candidate-dir dordiai-voices/candidates/personal-language/host-inputs",w)
        self.assertIn("--timeout 180",w)

    def test_probe_controller_pins_match_actual_source_bytes(self):
        marker='          expected='
        body=self.workflow.split(marker,1)[1].split("          for name,digest",1)[0]
        expected=ast.literal_eval(textwrap.dedent(body).strip())
        for name,digest in expected.items():
            raw=(ROOT/name).read_bytes()
            self.assertEqual(hashlib.sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest(),digest)

    def test_embedded_python_steps_compile_and_receipts_are_always_kept(self):
        count=0
        for step in self.workflow.split("      - "):
            if "        shell: python\n" not in step or "        run: |\n" not in step:continue
            code=step.split("        run: |\n",1)[1]
            lines=[]
            for line in code.splitlines(True):
                if line.strip() and not line.startswith("          "):break
                lines.append(line)
            ast.parse(textwrap.dedent("".join(lines)));count+=1
        self.assertEqual(count,2)
        self.assertIn("if: always()",self.workflow)
        self.assertIn("gzip.compress(encoded,mtime=0)",self.workflow)
        self.assertIn('"product_archive_used":False',self.workflow)

if __name__=="__main__":unittest.main()
