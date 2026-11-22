"""Owned descriptor fault tool safety; no model/NVDA execution claim."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]


def load(name,filename):
    spec=importlib.util.spec_from_file_location(name,ROOT/"tools"/filename)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TOOL=load("descriptor_fault_tool","windows_nvda_native_descriptor_probe.py")
BASE=load("descriptor_fault_base","windows_nvda_probe.py")
INTEGRATION=load("descriptor_fault_integration","windows_nvda_membership_integration_probe.py")
DESCRIPTOR="{\n  \"format\": \"dordiai-native-word-membership-resource\",\n  \"format_version\": 1,\n  \"filename\": \"native-word-membership.bin\",\n  \"sha256\": \"21208748a50ebf3f5dd3e2feb94f0f3caf3490c2be784aaca2209462380e6689\",\n  \"bytes\": 18661227,\n  \"codes\": [\n    \"uk\",\n    \"ru\"\n  ],\n  \"normalization\": \"nfc-casefold-cyrillic-acute-apostrophes-v1\",\n  \"word_count\": 6642550,\n  \"dataset_version\": \"1.0.0+ci.45027190211.1\",\n  \"binary_format\": \"DMLX0001\",\n  \"build_run_id\": 45027190211,\n  \"acquisition_run_id\": 45022418783,\n  \"notice_filename\": \"native-word-membership.NOTICE.json\"\n}\n".encode("utf-8")


class DescriptorFaultTests(unittest.TestCase):
    def owned(self,root):
        target=Path(root)/TOOL.DESCRIPTOR_RELATIVE
        target.parent.mkdir(parents=True)
        target.write_bytes(DESCRIPTOR)
        return target

    def test_exact_real_descriptor_fixture_identity(self):
        self.assertEqual(len(DESCRIPTOR),558)
        self.assertEqual(hashlib.sha256(DESCRIPTOR).hexdigest(),TOOL.DESCRIPTOR_SHA256)

    def test_arms_only_copied_descriptor_and_preserves_actual_initial_membership_checks(self):
        with tempfile.TemporaryDirectory() as name:
            target=self.owned(name)
            base=SimpleNamespace(PROBE_PLUGIN=BASE.PROBE_PLUGIN)
            INTEGRATION.install_membership_observer(base)
            context=TOOL.arm_owned_fault(base,Path(name))
            self.assertEqual(target.read_bytes(),DESCRIPTOR)
            self.assertIn("native_membership_installed_probe()",base.PROBE_PLUGIN)
            self.assertIn("later(500,start_native_descriptor_corruption_probe)",base.PROBE_PLUGIN)
            self.assertEqual(context["path"],target)
            self.assertEqual(context["corrupt"],b"X"+DESCRIPTOR[1:])

    def test_wrong_descriptor_never_armed(self):
        with tempfile.TemporaryDirectory() as name:
            target=self.owned(name)
            target.write_bytes(b"X"+DESCRIPTOR[1:])
            base=SimpleNamespace(PROBE_PLUGIN=BASE.PROBE_PLUGIN)
            with self.assertRaises(ValueError):
                TOOL.arm_owned_fault(base,Path(name))
            self.assertEqual(base.PROBE_PLUGIN,BASE.PROBE_PLUGIN)

    def test_exact_corruption_restored_without_touching_mapped_binary(self):
        with tempfile.TemporaryDirectory() as name:
            target=self.owned(name)
            binary=target.with_suffix(".bin")
            binary.write_bytes(b"unit sentinel, not a real model")
            context=TOOL.arm_owned_fault(SimpleNamespace(PROBE_PLUGIN=BASE.PROBE_PLUGIN),Path(name))
            target.write_bytes(context["corrupt"])
            result=TOOL.restore_owned_descriptor(context)
            self.assertEqual(result["status"],"passed")
            self.assertEqual(target.read_bytes(),DESCRIPTOR)
            self.assertEqual(binary.read_bytes(),b"unit sentinel, not a real model")

    def test_unexpected_content_is_never_overwritten_by_cleanup(self):
        with tempfile.TemporaryDirectory() as name:
            target=self.owned(name)
            context=TOOL.arm_owned_fault(SimpleNamespace(PROBE_PLUGIN=BASE.PROBE_PLUGIN),Path(name))
            target.write_bytes(b"unrelated change")
            with self.assertRaises(ValueError):
                TOOL.restore_owned_descriptor(context)
            self.assertEqual(target.read_bytes(),b"unrelated change")

    def test_stale_stage_anchor_rejected_before_mutation(self):
        with tempfile.TemporaryDirectory() as name:
            target=self.owned(name)
            with self.assertRaises(ValueError):
                TOOL.arm_owned_fault(SimpleNamespace(PROBE_PLUGIN="changed"),Path(name))
            self.assertEqual(target.read_bytes(),DESCRIPTOR)

    def test_actual_driver_request_not_synthetic_error_or_binary_mutation(self):
        tree=ast.parse(TOOL.PROBE_FUNCTION.replace("__OWNED_DESCRIPTOR_SPEC__","{}"))
        attributes=[node.func.attr for node in ast.walk(tree)
            if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute)]
        self.assertEqual(attributes.count("speak"),1)
        self.assertNotIn("_dordiai_report_error",attributes)
        self.assertNotIn("rename",attributes)
        self.assertNotIn("replace",attributes)
        self.assertIn("filesystem_path",attributes)
        self.assertIn("native_resource_closed",TOOL.PROBE_FUNCTION)
        self.assertIn("native_mapping_reader_released",TOOL.PROBE_FUNCTION)


if __name__=="__main__":
    unittest.main()
