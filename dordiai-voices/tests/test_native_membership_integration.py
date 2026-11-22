"""Actual tiny DMLX reader/lifecycle plus router policy; no pronunciation claim."""
from contextlib import ExitStack
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
RUNTIME=ROOT/"source/0.12.2/kx47Runtime"


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


manager=load("native_manager_integration_fixture",RUNTIME/"native_membership_runtime.py")
leaf=load("native_leaf_integration_fixture",RUNTIME/"native_word_membership.py")
builder=load("native_builder_integration_fixture",ROOT/"tools/build_native_word_membership.py")
speech=load("native_speech_integration_fixture",RUNTIME/"speech_text.py")
wide=load("native_wide_integration_fixture",RUNTIME/"wide_languages.py")
policy=load("native_policy_integration_fixture",RUNTIME/"language_routing.py")
prefs=load("native_preferences_integration_fixture",RUNTIME/"preferences.py")


class OwnedResourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.models=self.root/"kx47Runtime/models"
        self.folder=self.models/"WordLanguage"
        self.folder.mkdir(parents=True)
        self.words={"мама":3,"мови":1,"п'ять":1,"кошками":2,"тест":1}
        self.resource=None
        self.stack=ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(manager,"_resource",None))
        self.stack.enter_context(patch.object(manager,"_leases",set()))
        self.stack.enter_context(patch.object(manager,"_maintenance",None))
        self.addCleanup(self.close)

    def close(self):
        if self.resource is not None:
            self.resource.close()
        current=manager._resource
        if current is not None:
            current.close()

    def write(self,words=None):
        words=words or self.words
        path=self.folder/manager.DATASET_NAME
        if path.exists():
            path.unlink()
        receipt=builder.write_memberships(path,sorted((word.encode("utf-8"),mask) for word,mask in words.items()),
            codes=("uk","ru"))
        doc={"format":"dordiai-native-word-membership-resource","format_version":1,
            "filename":manager.DATASET_NAME,"sha256":receipt["sha256"],"bytes":path.stat().st_size,
            "codes":["uk","ru"],"word_count":len(words),"normalization":manager.NORMALIZATION,"binary_format":"DMLX0001"}
        raw=(json.dumps(doc,ensure_ascii=False,sort_keys=True,indent=2)+"\n").encode("utf-8")
        (self.folder/manager.DESCRIPTOR_NAME).write_bytes(raw)
        self.parameters={"reader_factory":leaf.MembershipLexicon,
            "descriptor_sha256":sha256(raw).hexdigest(),"dataset_sha256":receipt["sha256"],
            "dataset_bytes":path.stat().st_size,"dataset_words":len(words)}
        return path,raw

    def open(self):
        self.resource=manager.Resource(self.models,self.root,**self.parameters)
        return self.resource

    def install_factory(self):
        original=manager.Resource
        self.stack.enter_context(patch.object(manager,"Resource",
            side_effect=lambda models,addon_root=None:original(models,addon_root,**self.parameters)))

    def test_optional_absent_checkout_returns_no_primary_evidence(self):
        self.resource=manager.Resource(self.models,self.root)
        self.assertFalse(self.resource.enabled)
        self.assertEqual(self.resource.candidates("мови"),set())

    def test_real_reader_preserves_all_memberships_and_original_apostrophe_forms(self):
        self.write()
        resource=self.open()
        self.assertEqual(resource.candidates("мови"),{"uk"})
        self.assertEqual(resource.candidates("кошками"),{"ru"})
        self.assertEqual(resource.candidates("мама"),{"uk","ru"})
        for word in ("п’ять","п‘ять","пʼять","П'Я́ТЬ"):
            self.assertEqual(resource.candidates(word),{"uk"})
        self.assertEqual(resource.candidates("невідомий-тестовий-запит"),set())

    def test_partial_or_hash_invalid_resource_never_falls_back(self):
        self.write()
        (self.folder/manager.DATASET_NAME).unlink()
        with self.assertRaises(manager.NativeMembershipResourceError):
            self.open()
        self.write()
        (self.folder/manager.DESCRIPTOR_NAME).write_text("{}",encoding="utf-8")
        with self.assertRaises(manager.NativeMembershipResourceError):
            self.open()

    def test_core_manifest_claim_makes_both_missing_assets_a_failure(self):
        files={"kx47Runtime/models/WordLanguage/"+manager.DATASET_NAME:{"sha256":"0"*64,"size_bytes":1}}
        (self.root/"dordiai-release.json").write_text(json.dumps({
            "format":"dordiai-core-release","format_version":1,"files":files}),encoding="utf-8")
        with self.assertRaises(manager.NativeMembershipResourceError):
            manager.Resource(self.models,self.root)

    def test_core_descriptor_and_binary_records_must_match_actual_trusted_pins(self):
        path,raw=self.write()
        files={"kx47Runtime/models/WordLanguage/"+manager.DATASET_NAME:{
            "sha256":self.parameters["dataset_sha256"],"size_bytes":path.stat().st_size},
            "kx47Runtime/models/WordLanguage/"+manager.DESCRIPTOR_NAME:{
                "sha256":self.parameters["descriptor_sha256"],"size_bytes":len(raw)}}
        release=self.root/"dordiai-release.json"
        release.write_text(json.dumps({"format":"dordiai-core-release","format_version":1,"files":files}),encoding="utf-8")
        self.open().close()
        files["kx47Runtime/models/WordLanguage/"+manager.DATASET_NAME]["sha256"]="0"*64
        release.write_text(json.dumps({"format":"dordiai-core-release","format_version":1,"files":files}),encoding="utf-8")
        with self.assertRaises(manager.NativeMembershipResourceError):
            self.open()

    def test_same_word_cache_cannot_hide_descriptor_or_dataset_change(self):
        path,_=self.write()
        resource=self.open()
        self.assertEqual(resource.candidates("тест"),{"uk"})
        descriptor=self.folder/manager.DESCRIPTOR_NAME
        descriptor.write_bytes(descriptor.read_bytes()+b"\n")
        with self.assertRaises(manager.NativeMembershipResourceError):
            resource.candidates("тест")

    def test_closed_configured_reader_is_failure_not_legacy_unknown(self):
        self.write()
        resource=self.open()
        resource.close()
        with self.assertRaises(manager.NativeMembershipResourceError):
            resource.candidates("тест")

    def test_old_lease_release_does_not_close_a_new_active_owner(self):
        self.write()
        self.install_factory()
        old=manager.acquire(self.models,self.root)
        new=manager.acquire(self.models,self.root)
        self.assertTrue(manager.release(old))
        self.assertEqual(manager.candidates("тест"),{"uk"})
        self.assertFalse(manager.release(old))
        self.assertTrue(manager.release(new))
        with self.assertRaises(manager.NativeMembershipResourceError):
            manager.candidates("тест")

    def test_maintenance_blocks_new_acquisition_and_foreign_owners(self):
        self.write()
        self.install_factory()
        owner=manager.acquire(self.models,self.root)
        foreign=manager.acquire(self.models,self.root)
        transaction=object()
        with self.assertRaises(RuntimeError):
            manager.begin_maintenance(transaction,[owner])
        manager.release(foreign)
        manager.begin_maintenance(transaction,[owner])
        with self.assertRaises(RuntimeError):
            manager.acquire(self.models,self.root)
        manager.quiesce(transaction)
        with self.assertRaises(manager.NativeMembershipResourceError):
            manager.candidates("тест")
        self.assertTrue(manager.end_maintenance(transaction))
        new=manager.acquire(self.models,self.root)
        self.assertEqual(manager.candidates("тест"),{"uk"})
        manager.release(new)

    def test_actual_mmap_replacement_after_quiescence_and_fresh_same_word_lookup(self):
        path,_=self.write()
        self.install_factory()
        owner=manager.acquire(self.models,self.root)
        self.assertEqual(manager.candidates("тест"),{"uk"})
        transaction=object()
        manager.begin_maintenance(transaction,[owner])
        manager.quiesce(transaction)
        # This unlinks/replaces the actual previously mapped DMLX file. Windows
        # would refuse it if the owned reader still held its mapping/handle.
        changed=dict(self.words,тест=2)
        self.write(changed)
        manager.end_maintenance(transaction)
        new=manager.acquire(self.models,self.root)
        self.assertEqual(manager.candidates("тест"),{"ru"})
        manager.release(new)

    @unittest.skipUnless(sys.platform=="win32","Actual Windows extended namespace")
    def test_windows_long_root_and_leaf_paths_keep_explicit_namespace(self):
        self.models=self.root/("long-"+("x"*80))/("middle-"+("y"*80))/("deep-"+("z"*80))/"models"
        self.folder=self.models/"WordLanguage"
        self.folder.mkdir(parents=True)
        self.write()
        resource=self.open()
        self.assertGreater(len(str(self.folder/manager.DATASET_NAME)),260)
        self.assertTrue(str(resource.models).startswith("\\\\?\\"))
        self.assertTrue(str(resource.reader.path).startswith("\\\\?\\"))
        self.assertEqual(resource.candidates("мови"),{"uk"})

    @unittest.skipUnless(sys.platform=="win32","Actual Windows mapped-file locking")
    def test_windows_replace_is_blocked_before_owned_reader_quiesces(self):
        path,_=self.write()
        self.install_factory()
        owner=manager.acquire(self.models,self.root)
        replacement=self.folder/"replacement.bin"
        replacement.write_bytes(path.read_bytes())
        with self.assertRaises(OSError):
            os.replace(replacement,path)
        transaction=object()
        manager.begin_maintenance(transaction,[owner])
        manager.quiesce(transaction)
        os.replace(replacement,path)
        manager.end_maintenance(transaction)


class NativeBeforeBothCachesTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack()
        self.addCleanup(self.stack.close)
        self.current=frozenset()
        self.primary=self.stack.enter_context(patch.dict(sys.modules,{
            "_dordiai_main_native_membership_runtime":SimpleNamespace(candidates=lambda word:self.current)}))
        self.stack.enter_context(patch.object(speech,"legacy_cyrillic_word_candidates",return_value=frozenset({"ru"})))
        self.stack.enter_context(patch.object(wide,"_words",return_value={"тест":["ru","bg"]}))
        original_aux=wide._auxiliary
        self.stack.enter_context(patch.object(wide,"_auxiliary",
            side_effect=lambda name:speech if name=="speech_text" else original_aux(name)))
        wide._lexical_candidates.cache_clear()
        self.addCleanup(wide._lexical_candidates.cache_clear)

    def test_native_result_overrides_already_primed_weak_cache_and_preserves_other_cyrillic(self):
        self.assertEqual(wide._lexical_candidates("тест","cyrillic"),{"ru","bg"})
        self.current=frozenset({"uk"})
        self.assertEqual(wide._lexical_candidates("тест","cyrillic"),{"uk","bg"})
        self.current=frozenset({"uk","ru"})
        self.assertEqual(wide._lexical_candidates("тест","cyrillic"),{"uk","ru","bg"})
        self.current=frozenset()
        self.assertEqual(wide._lexical_candidates("тест","cyrillic"),{"ru","bg"})

    def test_speech_wrapper_never_caches_primary_shared_or_changed_same_word_result(self):
        self.assertEqual(speech.cyrillic_word_candidates("тест"),{"ru"})
        self.current=frozenset({"uk"})
        self.assertEqual(speech.cyrillic_word_candidates("тест"),{"uk"})
        self.current=frozenset({"uk","ru"})
        self.assertEqual(speech.cyrillic_word_candidates("тест"),{"uk","ru"})

    def test_integrity_failure_precedes_legacy_lookup_and_cache(self):
        self.assertEqual(wide._lexical_candidates("тест","cyrillic"),{"ru","bg"})
        stub=sys.modules["_dordiai_main_native_membership_runtime"]
        stub.candidates=lambda word:(_ for _ in ()).throw(manager.NativeMembershipResourceError("fixture"))
        with self.assertRaises(manager.NativeMembershipResourceError):
            wide._lexical_candidates("тест","cyrillic")
        with self.assertRaises(manager.NativeMembershipResourceError):
            speech.cyrillic_word_candidates("тест")

    def test_modifier_apostrophe_and_combining_stress_reach_native_lookup_as_whole_word(self):
        text="пʼять п‘ять П’Я́ТЬ"
        self.assertEqual([match.group() for match in speech.WORDS.finditer(text)],["пʼять","п‘ять","П’Я́ТЬ"])
        self.assertEqual([text[a:b] for a,b in wide._word_ranges(text)],["пʼять","п‘ять","П’Я́ТЬ"])

    def test_trusted_explicit_and_disabled_policy_precedes_contradictory_primary_evidence(self):
        stub=sys.modules["_dordiai_main_native_membership_runtime"]
        stub.candidates=lambda word:(_ for _ in ()).throw(AssertionError("Forced/NVDA language must bypass inference"))
        self.assertEqual(wide.split_extended("мови",preferred="ru",explicit=True,
            enabled_languages={"uk","ru"},mode="words"),[(wide.registered("ru"),"мови")])
        self.assertEqual(wide.split_extended("мови",preferred="ru",explicit=True,
            enabled_languages={"uk"},mode="words"),[(wide.registered("uk"),"мови")])
        decision=policy.resolve_word("мови","ru",{"uk","ru"},explicit=True,candidates={"uk"})
        self.assertEqual(decision.language,"ru")

    def test_actual_shared_native_membership_remains_ambiguous_downstream(self):
        self.current=frozenset({"uk","ru"})
        candidates=speech.cyrillic_word_candidates("мама")
        decision=policy.resolve_word("мама","ru",{"uk","ru"},candidates=candidates)
        self.assertTrue(decision.ambiguous)
        self.assertEqual(decision.language,"ru")
        self.assertEqual(policy.resolve_word("мама","ru",{"uk"},candidates=candidates).language,"uk")


class MeeteiAndRecoveryTests(unittest.TestCase):
    def test_registered_meetei_spans_keep_marks_exact_and_respect_enabled_explicit_locales(self):
        with patch.object(wide,"CODES",wide.CODES|{"mni","en","uk"}):
            text="ꯃꯤꯇꯩ"
            self.assertEqual(wide.split_extended(text,preferred="uk",enabled_languages={"mni","uk"}),[("mni",text)])
            disabled=wide.split_extended(text,preferred="uk",enabled_languages={"uk"})
            self.assertTrue(all(code!="mni" for code,_ in disabled))
            self.assertEqual("".join(value for _,value in disabled),text)
            self.assertEqual(wide.split_extended(text,preferred="uk",explicit=True,
                enabled_languages={"mni","uk"}),[("uk",text)])
            mixed=text+" পা"
            spans=wide.split_extended(mixed,preferred="uk",enabled_languages={"uk","mni","bn"})
            self.assertEqual("".join(value for _,value in spans),mixed)
            self.assertIn("bn",wide.FAMILIES["bengali"])
            self.assertIn("mni",wide.FAMILIES["bengali"])
            self.assertNotEqual(wide.FAMILIES["bengali"],("mni",))

    def test_one_native_base_plus_vowel_mark_routes_as_word_without_overriding_explicit_locale(self):
        with patch.object(wide,"CODES",wide.CODES|{"mni","uk"}):
            text="ꯅꯤ"
            self.assertEqual(sum(char.isalpha() for char in text),1)
            self.assertEqual(wide.split_extended(text,preferred="uk",
                enabled_languages={"uk","mni"},mode="words"),[("mni",text)])
            self.assertEqual(wide.split_extended(text,preferred="uk",explicit=True,
                enabled_languages={"uk","mni"},mode="words"),[("uk",text)])
            self.assertEqual(wide.split_extended("ꯅ",preferred="uk",
                enabled_languages={"uk","mni"},mode="words"),[("uk","ꯅ")])

    def test_only_actual_registered_resource_error_is_fatal(self):
        with patch.dict(sys.modules,{"_dordiai_main_native_membership_runtime":manager}):
            self.assertTrue(prefs.is_fatal_speech_failure(manager.NativeMembershipResourceError("fixture")))
            lookalike=type("NativeMembershipResourceError",(RuntimeError,),{})
            self.assertFalse(prefs.is_fatal_speech_failure(lookalike("fixture")))
            self.assertFalse(prefs.is_fatal_speech_failure(ValueError("unsupported text")))
            self.assertFalse(prefs.is_fatal_speech_failure(InterruptedError("cancelled")))


class QueuedNativeResourceRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack()
        self.addCleanup(self.stack.close)
        class Driver(prefs.PreferencesMixin):
            name="kx47Preview"
            def saveSettings(self):
                self.saved=True
        self.driver=Driver()
        self.current=self.driver
        self.calls=[]
        self.queue=[]
        self.notices=[]
        def choose(name,isFallback=False):
            self.calls.append((name,isFallback))
            self.current=None if name is None else SimpleNamespace(name=name)
            return True
        self.stack.enter_context(patch.dict(sys.modules,{
            "_dordiai_main_native_membership_runtime":manager,
            "queueHandler":SimpleNamespace(eventQueue=object(),
                queueFunction=lambda queue,func,*args:self.queue.append((func,args))),
            "speech":SimpleNamespace(cancelSpeech=lambda:None),
            "synthDriverHandler":SimpleNamespace(getSynth=lambda:self.current,setSynth=choose),
            "ui":SimpleNamespace(message=self.notices.append)}))

    def dispatch(self):
        func,args=self.queue.pop(0)
        func(*args)

    def test_real_registered_error_is_attested_before_event_thread_and_names_resource(self):
        self.driver._dordiai_report_error(manager.NativeMembershipResourceError("fixture"))
        self.assertIs(self.current,self.driver,"Producer must not switch synthesizer")
        self.assertEqual(self.driver._dordiai_last_error_details["required_resource_kind"],"native-word-membership")
        self.dispatch()
        self.assertEqual(self.current.name,"espeak")
        self.assertTrue(all(fallback for _,fallback in self.calls))
        self.assertIn("словник",self.notices[-1])
        self.assertEqual(self.driver._dordiai_last_error_details["recovery"]["reason"],
                         "native-word-membership-unavailable")

    def test_same_name_lookalike_uses_ordinary_notice_without_resource_attestation_or_switch(self):
        lookalike=type("NativeMembershipResourceError",(RuntimeError,),{})
        self.driver._dordiai_report_error(lookalike("fixture"))
        self.dispatch()
        self.assertIs(self.current,self.driver)
        self.assertEqual(self.calls,[])
        self.assertNotIn("required_resource_kind",self.driver._dordiai_last_error_details)

    def test_user_selected_synth_is_preserved_before_queued_native_recovery(self):
        self.driver._dordiai_report_error(manager.NativeMembershipResourceError("fixture"))
        other=SimpleNamespace(name="other-user-selection")
        self.current=other
        self.dispatch()
        self.assertIs(self.current,other)
        self.assertEqual(self.calls,[])
        self.assertIn("словник",self.notices[-1])


if __name__=="__main__":
    unittest.main()
