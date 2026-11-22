"""Optional-default policy/profile tests, without installing any optional model."""
from collections import OrderedDict
from contextlib import ExitStack
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from nvda_stubs import BaseDriver,driver_module

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("_personal_language_policy",ROOT/"source/0.12.2/kx47Runtime/personal_language.py")
policy=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy)


class Name:
    def __init__(self,lang):self.lang=lang
class Origin:
    def __init__(self,explicit):self.explicit=explicit


class PureDefaultPolicyTests(unittest.TestCase):
    def test_available_is_exact_verified_installed_enabled_intersection(self):
        personal={"gag":{"name":"Gagauz"},"kaa":{"name":"Karakalpak"},"missing":{"name":"Missing"},
            "invalid":{"name":""}}
        self.assertEqual(list(policy.available(personal,{"gag","kaa","invalid"},{"gag","missing","invalid"})),["gag"])

    def test_unknown_disabled_and_malformed_saved_choices_normalize_auto(self):
        for value in ("auto","missing",None,False,{},[],7):
            self.assertEqual(policy.normalized_choice(value,{"gag"}),"auto")
        self.assertEqual(policy.normalized_choice(" GAG ",{"gag"}),"gag")

    def test_automatic_choice_does_not_touch_input(self):
        sequence=[Name("uk"),"word"]
        self.assertIs(policy.apply_default(sequence,"auto","uk",Name,Origin),sequence)

    def test_no_text_does_not_create_parameter_only_utterance(self):
        sequence=[Name(None)]
        self.assertIs(policy.apply_default(sequence,"gag","uk",Name,Origin),sequence)

    def test_text_and_unrelated_commands_are_retained_by_identity(self):
        command=object();text="unchanged"
        result=policy.apply_default([Origin(False),Name("uk"),text,command],"gag","uk",Name,Origin)
        self.assertTrue(any(item is text for item in result))
        self.assertIs(result[-1],command)

    def test_source_origin_and_language_objects_are_never_modified(self):
        origin=Origin(False);language=Name("uk")
        policy.apply_default([origin,language,"text"],"gag","uk",Name,Origin)
        self.assertFalse(origin.explicit)
        self.assertEqual(language.lang,"uk")


class DriverOptionalDefaultTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.context=driver_module();cls.d=cls.context.__enter__()
    @classmethod
    def tearDownClass(cls):cls.context.__exit__(None,None,None)

    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(self.d._wide,"PERSONAL",{"gag":{"name":"Gagauz"},"kaa":{"name":"Karakalpak"}}))
        self.stack.enter_context(patch.object(self.d._wide,"refresh_personal",return_value=None))
        real=self.d._wide.registered
        self.stack.enter_context(patch.object(self.d._wide,"registered",
            side_effect=lambda code:"gag" if code=="gag" else real(code)))

    def parts(self,sequence,forced=False):
        d=self.d
        selected=policy.apply_default(sequence,"gag","uk",d.LangChangeCommand,d.LanguageOriginCommand)
        return list(d.speech_parts(selected,"uk","en-US",forced=forced,enabled_languages={"uk","ru","en","gag"}))

    def test_normalized_none_concrete_uk_keeps_selected_optional_default(self):
        d=self.d
        self.assertEqual(self.parts([d.LanguageOriginCommand(False),d.LangChangeCommand("uk"),"text"]),
            [("text",("gag","text"))])

    def test_explicit_same_locale_without_redundant_language_command_is_restored(self):
        d=self.d
        parts=self.parts([d.LanguageOriginCommand(False),d.LangChangeCommand("uk"),"automatic",
            d.LanguageOriginCommand(True),"authored"])
        self.assertEqual(parts,[("text",("gag","automatic")),("text",("uk","authored"))])

    def test_named_metadata_and_validated_typing_locale_win_over_optional_default(self):
        d=self.d
        self.assertEqual(self.parts([d.LanguageOriginCommand(True),d.LangChangeCommand("ru"),"абы"]),
            [("text",("ru","абы"))])

    def test_nonprimary_typed_locale_survives_omitted_redundant_language_command(self):
        d=self.d
        self.assertEqual(self.parts([d.LanguageOriginCommand(True),d.LangChangeCommand("ru"),"first",
            d.LanguageOriginCommand(True),"second"]),
            [("text",("ru","first")),("text",("ru","second"))])

    def test_fresh_default_call_does_not_inherit_a_previous_typed_origin(self):
        d=self.d
        self.parts([d.LanguageOriginCommand(True),d.LangChangeCommand("ru"),"typed"])
        self.assertEqual(self.parts([d.LanguageOriginCommand(False),d.LangChangeCommand("uk"),"document"]),
            [("text",("gag","document"))])

    def test_direct_legacy_named_default_and_none_reset_contract(self):
        d=self.d
        self.assertEqual(self.parts(["default",d.LangChangeCommand("ru"),"named",d.LangChangeCommand(None),"reset"]),
            [("text",("gag","default")),("text",("ru","named")),("text",("gag","reset"))])

    def test_origin_marker_alone_and_parameter_replay_order_both_work(self):
        d=self.d
        for seq in ([d.LanguageOriginCommand(False),"default"],
                    [d.LangChangeCommand("uk"),d.LanguageOriginCommand(False),"default"]):
            self.assertEqual(self.parts(seq),[("text",("gag","default"))])

    def test_forced_primary_still_overrides_optional_and_authored_locale(self):
        d=self.d
        self.assertEqual(self.parts([d.LanguageOriginCommand(True),d.LangChangeCommand("ru"),"forced"],True),
            [("text",("uk","forced"))])

    def obj(self,installed=("uk","gag"),enabled=("uk","gag")):
        d=self.d
        obj=d.SynthDriver.__new__(d.SynthDriver);obj._dordiai_init()
        obj._dordiai_enabled_languages=frozenset(enabled)
        obj._dordiai_all_languages=lambda:OrderedDict((code,code) for code in installed)
        obj._dordiai_compatible_voices=lambda code:("adam",)
        obj._voices={"adam":("Adam","adam","reference","en-US")};obj._voice="adam"
        obj._personalLanguage="auto";obj.invalidateCache=lambda:None
        return obj

    def test_choice_control_filters_disabled_uninstalled_and_unverified_locales(self):
        obj=self.obj(installed=("uk","gag","zz"),enabled=("uk","gag","kaa","zz"))
        self.assertEqual(list(obj._get_availablePersonallanguages()),["auto","gag"])
        self.assertEqual(obj._get_availablePersonallanguages()["gag"].displayName,"Gagauz")

    def test_disabled_choice_resets_and_does_not_resurrect_when_reenabled(self):
        obj=self.obj();obj._set_personalLanguage("gag")
        self.assertEqual(obj._get_personalLanguage(),"gag")
        obj._dordiai_enabled_languages=frozenset({"uk"})
        self.assertEqual(obj._get_personalLanguage(),"auto")
        obj._dordiai_enabled_languages=frozenset({"uk","gag"})
        self.assertEqual(obj._get_personalLanguage(),"auto")

    def test_missing_optional_resources_and_invalid_assignments_remain_auto(self):
        obj=self.obj(installed=("uk",),enabled=("uk","gag"))
        obj._set_personalLanguage("gag")
        self.assertEqual(obj._get_personalLanguage(),"auto")
        obj=self.obj()
        for value in (None,{},["gag"],"unavailable"):
            obj._set_personalLanguage(value)
            self.assertEqual(obj._get_personalLanguage(),"auto")

    def profile(self,enabled="uk gag",choice="gag"):
        d=self.d
        section={d._prefs.ENABLED_LANGUAGES_KEY:enabled,d._prefs.CONFIG_KEYS[2]:"uk","personalLanguage":choice}
        self.stack.enter_context(patch.dict(d.config.conf,{"speech":{d.SynthDriver.name:section}}))
        self.stack.enter_context(patch.object(BaseDriver,"loadSettings",lambda self,onlyChanged=False:None,create=True))
        self.stack.enter_context(patch.object(BaseDriver,"saveSettings",lambda self:None,create=True))
        return section

    def test_profile_load_validates_choice_after_enabled_state_not_constructor_defaults(self):
        section=self.profile();obj=self.obj(enabled=("uk","en","ru"))
        obj.loadSettings()
        self.assertEqual(obj._dordiai_enabled_languages,{"uk","gag"})
        self.assertEqual(obj._get_personalLanguage(),"gag")
        obj.saveSettings()
        self.assertEqual(section["personalLanguage"],"gag")

    def test_profile_change_disabled_missing_and_saved_reset_are_consistent(self):
        section=self.profile();obj=self.obj();obj.loadSettings()
        section[self.d._prefs.ENABLED_LANGUAGES_KEY]="uk"
        obj.loadSettings(onlyChanged=True)
        self.assertEqual(obj._get_personalLanguage(),"auto")
        obj.saveSettings()
        self.assertEqual(section["personalLanguage"],"auto")
        section[self.d._prefs.ENABLED_LANGUAGES_KEY]="uk gag"
        obj.loadSettings(onlyChanged=True)
        self.assertEqual(obj._get_personalLanguage(),"auto")

    def test_saved_auto_and_uninstalled_selection_do_not_survive_profile_reload(self):
        self.profile(choice="auto");obj=self.obj();obj._personalLanguage="gag"
        obj.loadSettings()
        self.assertEqual(obj._get_personalLanguage(),"auto")
        self.d.config.conf["speech"][obj.name]["personalLanguage"]="gag"
        obj._dordiai_all_languages=lambda:OrderedDict(uk="Ukrainian")
        obj.loadSettings()
        self.assertEqual(obj._get_personalLanguage(),"auto")

    def test_profile_config_spec_remains_defined_when_control_is_not_exposed(self):
        self.stack.enter_context(patch.object(BaseDriver,"_getConfigSpecForSettings",
            classmethod(lambda cls,settings:{}),create=True))
        self.assertEqual(self.d.SynthDriver._getConfigSpecForSettings([])["personalLanguage"],
            "string(default='auto')")

if __name__=="__main__":unittest.main()
