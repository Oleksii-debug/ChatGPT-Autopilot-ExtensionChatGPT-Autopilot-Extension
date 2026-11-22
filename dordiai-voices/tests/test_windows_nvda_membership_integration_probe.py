"""Readonly instrumentation contracts; real host authority is separate CI."""
import ast
import importlib.util
import inspect
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT=Path(__file__).resolve().parents[1]


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/"tools"/path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TOOL=load("installed_membership_probe_tool","windows_nvda_membership_integration_probe.py")
BASE=load("installed_membership_base_probe","windows_nvda_probe.py")


class InstalledMembershipProbeTests(unittest.TestCase):
    def test_actual_plugin_anchor_and_complete_embedded_source_compile(self):
        base=SimpleNamespace(PROBE_PLUGIN=BASE.PROBE_PLUGIN)
        original=TOOL.install_membership_observer(base)
        self.assertEqual(original,BASE.PROBE_PLUGIN)
        self.assertEqual(base.PROBE_PLUGIN.count("def native_membership_installed_probe("),1)
        self.assertIn("native_membership_installed_probe()\n",base.PROBE_PLUGIN)

    def test_missing_duplicate_and_already_instrumented_anchors_fail_closed(self):
        for source in ("",TOOL.ANCHOR*2,TOOL.ANCHOR+"def native_membership_installed_probe(): pass"):
            base=SimpleNamespace(PROBE_PLUGIN=source)
            with self.assertRaises(ValueError):
                TOOL.install_membership_observer(base)
            self.assertEqual(base.PROBE_PLUGIN,source)

    def test_source96_cases_and_all_shared_memberships_are_preserved(self):
        tree=ast.parse(TOOL.PROBE_FUNCTION)
        assignment=next(n for n in tree.body if isinstance(n,ast.Assign))
        cases=ast.literal_eval(assignment.value)
        self.assertEqual(len(cases),96)
        self.assertEqual(len({row["word"] for row in cases}),96)
        self.assertEqual(sum(row["memberships"]==["ru","uk"] for row in cases),38)
        self.assertEqual(sum(row["memberships"]==["uk"] for row in cases),29)
        self.assertEqual(sum(row["memberships"]==["ru"] for row in cases),29)

    def test_original_speech_and_keyboard_call_sites_are_unchanged(self):
        def calls(source):
            tree=ast.parse(source.replace("__PROBE_SETTINGS__","{}").replace("__NATIVE_IMPORT_DIAGNOSTIC__",repr("")))
            return [ast.dump(node,include_attributes=False) for node in ast.walk(tree)
                if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and
                node.func.attr in {"speak","cancel","feed","SendInput","sendInput","KeyDown","KeyUp"}]
        base=SimpleNamespace(PROBE_PLUGIN=BASE.PROBE_PLUGIN)
        TOOL.install_membership_observer(base)
        self.assertEqual(calls(BASE.PROBE_PLUGIN),calls(base.PROBE_PLUGIN))

    def test_real_resource_not_replaced_or_closed_by_observer(self):
        tree=ast.parse(TOOL.PROBE_FUNCTION)
        names=[n.func.attr for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute)]
        for forbidden in ("close","acquire","release","write_bytes","write_text","_dordiai_apply"):
            self.assertNotIn(forbidden,names)
        self.assertIn("verify_current",names)
        self.assertIn("candidates",names)
        self.assertIn('"production_word_route_verified":False',TOOL.PROBE_FUNCTION)

    def test_helper_and_real_check_call_signatures_bind(self):
        tree=ast.parse(TOOL.PROBE_FUNCTION)
        signatures={
            "check":inspect.Signature([inspect.Parameter("check_name",inspect.Parameter.POSITIONAL_OR_KEYWORD),
                inspect.Parameter("status",inspect.Parameter.POSITIONAL_OR_KEYWORD),
                inspect.Parameter("details",inspect.Parameter.VAR_KEYWORD)]),
            "require":inspect.Signature([inspect.Parameter("name",inspect.Parameter.POSITIONAL_OR_KEYWORD),
                inspect.Parameter("condition",inspect.Parameter.POSITIONAL_OR_KEYWORD),
                inspect.Parameter("details",inspect.Parameter.VAR_KEYWORD)])}
        # Dynamic **details has no statically knowable keyword name. Validate
        # every explicit argument; duplicate explicit name/position still fails.
        for node in ast.walk(tree):
            if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id in signatures:
                signatures[node.func.id].bind(*[object() for _ in node.args],
                    **{kw.arg:object() for kw in node.keywords if kw.arg is not None})


if __name__=="__main__":
    unittest.main()
