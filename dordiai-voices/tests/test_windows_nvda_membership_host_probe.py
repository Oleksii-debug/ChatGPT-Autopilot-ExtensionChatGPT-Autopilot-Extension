"""Controller contract tests, not evidence of frozen NVDA execution."""
import ast
import importlib.util
import inspect
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location("owned_nvda_membership_host_tool",
    ROOT/"tools/windows_nvda_membership_host_probe.py")
TOOL=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)


def receipt():
    return {"format":"dordiai-primary-native-word-membership",
        "status":"source-membership-acquired",
        "non_initial_forms_not_in_frequency_sample":{
            "uk":[{"word":"укр"+str(i),"memberships":["uk"]} for i in range(32)],
            "ru":[{"word":"рус"+str(i),"memberships":["ru"]} for i in range(32)]},
        "ambiguous_membership_sample":["спільне"+str(i) for i in range(32)]}


class HostProbeTests(unittest.TestCase):
    def test_source_samples_preserve_all_ambiguous_memberships(self):
        cases=TOOL.sample_cases(receipt())
        self.assertEqual(len(cases),97)
        self.assertEqual(sum(c["memberships"]==["ru","uk"] for c in cases),32)
        self.assertEqual(sum(c["memberships"]==[] for c in cases),1)

    def test_incomplete_or_wrong_source_receipt_rejected(self):
        source=receipt()
        source["ambiguous_membership_sample"].pop()
        with self.assertRaises(ValueError):
            TOOL.sample_cases(source)
        source=receipt()
        source["status"]="invented"
        with self.assertRaises(ValueError):
            TOOL.sample_cases(source)

    def test_real_plugin_compiles_and_check_call_signatures_bind(self):
        tree=ast.parse(TOOL.HOST_PLUGIN.replace("__HOST_MEMBERSHIP_SETTINGS__",repr({})))
        compile(tree,"actual-owned-membership-plugin","exec")
        signature=inspect.Signature([
            inspect.Parameter("name",inspect.Parameter.POSITIONAL_OR_KEYWORD),
            inspect.Parameter("passed",inspect.Parameter.POSITIONAL_OR_KEYWORD),
            inspect.Parameter("details",inspect.Parameter.VAR_KEYWORD)])
        calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=="check"]
        self.assertGreater(len(calls),8)
        for call in calls:
            signature.bind(*[object() for _ in call.args],**{k.arg:object() for k in call.keywords})

    def test_no_fake_host_or_audio_fallback(self):
        tree=ast.parse(TOOL.HOST_PLUGIN.replace("__HOST_MEMBERSHIP_SETTINGS__",repr({})))
        imports={alias.name for n in ast.walk(tree) if isinstance(n,ast.Import) for alias in n.names}
        self.assertIn("versionInfo",imports)
        self.assertNotIn("buildVersion",imports)
        self.assertIn('module.mmap.__name__=="mmap"',TOOL.HOST_PLUGIN)
        self.assertIn('"production_routing_verified":False',TOOL.HOST_PLUGIN)
        self.assertIn('"physical_audio_verified":False',TOOL.HOST_PLUGIN)
        self.assertNotIn("sys.path.insert",TOOL.HOST_PLUGIN)
        self.assertNotIn("WavePlayer",TOOL.HOST_PLUGIN.replace("no WavePlayer or output test attempted",""))

    def test_wrong_binary_rejected_before_external_copy(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name)
            source=root/"dataset"
            run=root/"run"
            source.mkdir()
            run.mkdir()
            (source/"native-word-membership.bin").write_bytes(b"wrong")
            with self.assertRaises(ValueError):
                TOOL.prepare_owned_inputs(source,run)
            self.assertFalse((run/"external").exists())

    def test_nonwindows_emits_explicit_blocked_receipt(self):
        with tempfile.TemporaryDirectory() as name:
            output=Path(name)/"result"
            with mock.patch.object(TOOL,"os",SimpleNamespace(name="posix")),mock.patch("builtins.print"):
                code=TOOL.main(["--dataset-dir",name,"--output",str(output)])
            self.assertEqual(code,2)
            result=json.loads((output/"controller.json").read_text(encoding="utf-8"))
            self.assertEqual(result["status"],"blocked")
            self.assertFalse(result["nvda_host_verified"])
            self.assertFalse(result["product_archive_used"])

    def test_existing_output_is_never_reused(self):
        with tempfile.TemporaryDirectory() as name:
            with self.assertRaises(FileExistsError):
                TOOL.main(["--dataset-dir",name,"--output",name])

    def test_stop_only_targets_owned_process_pid(self):
        process=mock.Mock()
        process.pid=12345
        process.poll.return_value=None
        with mock.patch.object(TOOL.subprocess,"run") as run:
            TOOL.stop_owned(process)
        self.assertEqual(run.call_args.args[0],["taskkill","/PID","12345","/T","/F"])
        process.wait.assert_called_once_with(timeout=20)


if __name__=="__main__":
    unittest.main()
