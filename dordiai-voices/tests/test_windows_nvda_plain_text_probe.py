"""Pure observer/accounting checks, never a substitute for real NVDA execution."""
import ast
import importlib.util
from pathlib import Path
import re
import types
import unicodedata
import unittest

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name,path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load("plain_file_probe_fixture", TOOLS/"windows_nvda_plain_text_probe.py")


def logic():
    tree = ast.parse(helper.PLUGIN_CODE)
    names = {"_plain_normalize","_plain_tokens","_plain_source_groups","_plain_cases","_plain_route_audit"}
    selected = [node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
    source_cases = next(node.value for node in tree.body if isinstance(node,ast.Assign)
        and any(isinstance(target,ast.Name) and target.id=="PLAIN_SOURCE_CASES" for target in node.targets))
    namespace = {"_plain_unicode":unicodedata,"_plain_re":re,
                 "PLAIN_SOURCE_CASES":ast.literal_eval(source_cases)}
    exec(compile(ast.fix_missing_locations(ast.Module(body=selected,type_ignores=[])),
                 "plain-file-observer-pure-logic","exec"),namespace)
    return namespace


class PlainTextFixtureAndAccountingTests(unittest.TestCase):
    def setUp(self):
        self.api = logic()
        self.cases = self.api["_plain_cases"]()

    def test_all_authenticated_source_samples_and_actual_membership_groups_are_preserved(self):
        groups = self.api["_plain_source_groups"]()
        self.assertEqual({key:len(value) for key,value in groups.items()},
                         {"uk":29,"ru":29,"shared":38})
        self.assertEqual(len({row["word"] for row in self.api["PLAIN_SOURCE_CASES"]}),96)

    def test_real_word_list_is_exactly100_words_covering_all96_source_samples(self):
        case = self.cases[0]
        self.assertEqual(case["name"],"auto_unmarked_100")
        self.assertEqual(len(case["words"]),100)
        self.assertEqual(len({row["word"] for row in case["words"]}),96)
        self.assertFalse(case["native_metadata"])
        self.assertNotIn("<",case["text"])

    def test_correct_word_routes_preserve_every_input_word_and_order(self):
        case = self.cases[0]
        routes = [{"text":row["word"]+" ","language":row["expected_language"]} for row in case["words"]]
        report = self.api["_plain_route_audit"](case["words"],routes)
        self.assertTrue(report["input_words_preserved_in_order"])
        self.assertTrue(report["routing_passed"])
        self.assertEqual(report["input_word_count"],100)
        self.assertEqual(report["observed_lexical_piece_count"],sum(len(self.api["_plain_tokens"](row["word"])) for row in case["words"]))

    def test_default_locale_pinning_cannot_be_reported_as_successful_mixed_read(self):
        case = self.cases[0]
        report = self.api["_plain_route_audit"](case["words"],
            [{"text":case["text"],"language":"uk"}])
        self.assertTrue(report["input_words_preserved_in_order"])
        self.assertFalse(report["routing_passed"])
        self.assertGreater(len(report["mismatches"]),20)

    def test_dropped_duplicate_or_reordered_words_fail_even_if_language_names_look_right(self):
        case = self.cases[0]
        routes = [{"text":row["word"],"language":row["expected_language"]} for row in case["words"]]
        for changed in (routes[:-1],routes+[routes[-1]],list(reversed(routes))):
            with self.subTest(count=len(changed)):
                self.assertFalse(self.api["_plain_route_audit"](case["words"],changed)["routing_passed"])

    def test_shared_words_inherit_preceding_expected_language_and_remain_explicitly_ambiguous(self):
        current="uk"
        for row in self.cases[0]["words"]:
            if len(row["memberships"])==2:
                self.assertEqual(row["expected_language"],current)
                self.assertEqual(set(row["memberships"]),{"uk","ru"})
            current=row["expected_language"]

    def test_forced_disabled_and_real_metadata_priority_have_separate_cases(self):
        self.assertEqual(len(self.cases),6)
        for case in self.cases:
            if case["mode"]=="forced" or "ru" not in case["enabled"]:
                self.assertEqual({row["expected_language"] for row in case["words"]},{"uk"})
            elif case["native_metadata"]:
                for row in case["words"]:
                    self.assertNotIn(row["expected_language"],row["memberships"])
                    self.assertEqual(row["expected_language"],row["authored_locale"])

    def test_actual_hyphen_splitting_retains_each_original_form_language_and_flags_wrong_piece(self):
        word={"word":"синевато-сером","memberships":["ru"],"expected_language":"ru","authored_locale":None}
        correct=[{"text":"синевато-","language":"ru"},{"text":"сером","language":"ru"}]
        report=self.api["_plain_route_audit"]([word],correct)
        self.assertEqual(report["input_word_count"],1)
        self.assertEqual(report["observed_lexical_piece_count"],2)
        self.assertTrue(report["raw_nonwhitespace_text_preserved"])
        self.assertTrue(report["routing_passed"])
        wrong=[correct[0],{"text":"сером","language":"uk"}]
        report=self.api["_plain_route_audit"]([word],wrong)
        self.assertFalse(report["routing_passed"])
        self.assertEqual(report["mismatches"][0]["source_word"],"синевато-сером")
        self.assertEqual(report["mismatches"][0]["lexical_piece"],"сером")

    def test_apostrophe_and_stress_comparison_does_not_drop_whole_words(self):
        tokens = self.api["_plain_tokens"]("ПʼЯ́ТЬ п‘ять п’ять")
        self.assertEqual(tokens,["п'ять"]*3)


class GenuineHandlerAndCompositionTests(unittest.TestCase):
    def test_plugin_uses_real_file_native_textinfo_and_unchanged_global_read_command(self):
        source = helper.PLUGIN_CODE
        for marker in ("control.LoadFile(str(path))","focus.makeTextInfo(textInfos.POSITION_CARET)",
                       "info.getTextWithFields()","globalCommands.commands.script_reportCurrentLine",
                       "scriptHandler.executeScript","scriptHandler.clearLastScript()",
                       "originalSpeechSequence",'point.register(_plain_on_pre_speech)',
                       'getattr(focus, "ITextDocumentObject", None)',"font.languageID ="):
            self.assertIn(marker,source)

    def test_plugin_never_inserts_language_commands_calls_driver_speak_or_replaces_textinfo(self):
        tree = ast.parse(helper.PLUGIN_CODE)
        for node in ast.walk(tree):
            if isinstance(node,ast.Call):
                self.assertFalse(isinstance(node.func,ast.Name) and node.func.id=="LangChangeCommand")
                self.assertFalse(isinstance(node.func,ast.Attribute) and node.func.attr=="speak")
            if isinstance(node,ast.Assign):
                for target in node.targets:
                    self.assertFalse(isinstance(target,ast.Attribute) and target.attr in
                        {"getTextWithFields","makeTextInfo","speak","script_reportCurrentLine"})

    def test_passive_planner_observer_yields_exact_part_object_and_closes_original_generator(self):
        tree=ast.parse(helper.PLUGIN_CODE)
        function=next(node for node in tree.body if isinstance(node,ast.FunctionDef)
                      and node.name=="_plain_observe_parts")
        part=("text",{"text":"fixture","language":"uk"})
        closed=[]
        def original(*args,**kwargs):
            try:
                yield part
            finally:
                closed.append(True)
        namespace={"_PLAIN":{"original_parts":original},"_plain_current":lambda:None}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[function],type_ignores=[])),
                     "actual-passive-planner-observer","exec"),namespace)
        observed=namespace["_plain_observe_parts"]()
        self.assertIs(next(observed),part)
        observed.close()
        self.assertEqual(closed,[True])

    def test_settings_close_anchor_is_exact_and_plugin_composes_without_controller_file_changes(self):
        base = load("plain_file_base_fixture",TOOLS/"windows_nvda_probe.py")
        original = base.PROBE_PLUGIN
        returned = helper.install_plain_text_probe(base)
        self.assertEqual(returned,original)
        self.assertNotEqual(base.PROBE_PLUGIN,original)
        self.assertIn("later(500, start_actual_plain_text_probe)",base.PROBE_PLUGIN)
        self.assertIn("def start_actual_plain_text_probe(",base.PROBE_PLUGIN)
        with self.assertRaises(ValueError):
            helper.install_plain_text_probe(base)

    def test_stale_base_is_rejected_before_any_execution(self):
        with self.assertRaises(ValueError):
            helper.install_plain_text_probe(types.SimpleNamespace(PROBE_PLUGIN="changed source"))

    def test_cleanup_restores_real_preferences_and_observers_and_preserves_user_synth_choice(self):
        source=helper.PLUGIN_CODE
        self.assertNotIn("section.__delitem__",source)
        for marker in ("speech.pre_speechQueued.unregister","pre_synthSpeak.unregister",
                       'setattr(DRIVER, "_planned_parts", state["original_parts"])',
                       'if synthDriverHandler.getSynth() is DRIVER:',
                       "SelectedSynthChangedPreferencesNotOverwritten",
                       'state["saved_auto_language"]','state["saved_speech_mode"]'):
            self.assertIn(marker,source)

    def test_controller_rejects_incompatible_modes_before_loading_or_launching_anything(self):
        for option in ("--typing-probe","--fatal-recovery-probe","--required-resource-recovery-probe"):
            with self.subTest(option=option),self.assertRaises(ValueError):
                helper.main([option])

    def test_reference_fixture_is_bound_to_actual_authenticated_source_receipt(self):
        self.assertEqual(helper.SOURCE_RECEIPT_SHA256,
                         "d7c8157a3cfc44d3e6cce9daf45099fb34c4f5f1e80edfed70a50e6cde2d6199")
        self.assertEqual(helper.MEMBERSHIP_HELPER_GIT_BLOB,
                         "7386bb6575b45d004eca276c6092549bcb88d52f")


if __name__=="__main__":
    unittest.main()
