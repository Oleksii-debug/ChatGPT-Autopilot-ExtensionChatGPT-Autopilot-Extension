"""Locale provenance logic tests; real NVDA transport is verified separately."""
import ast
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch
from nvda_stubs import Filter, SynthParamCommand, driver_module

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
spec = importlib.util.spec_from_file_location("_origin_unit", RUNTIME / "language_origin.py")
origin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(origin)

class Lang(SynthParamCommand):
    def __init__(self, lang): self.lang = lang

class End: pass
Origin = origin.command_type(SynthParamCommand)


class AnnotationTests(unittest.TestCase):
    def test_original_items_identity_and_order(self):
        items = [Lang(None), "plain", Lang("ru_RU"), "authored", Lang(None), "reset"]
        tagged = origin.annotate(items, Lang, Origin, End)
        self.assertEqual([x.explicit for x in tagged if isinstance(x, Origin)], [False, True, False])
        retained = [x for x in tagged if not isinstance(x, Origin)]
        self.assertTrue(all(a is b for a,b in zip(items, retained)))

    def test_default_is_established_without_language_command(self):
        self.assertEqual(origin.annotate(["text"], Lang, Origin)[0], Origin(False))

    def test_each_call_resets_origin(self):
        origin.annotate([Lang("ru"), "authored"], Lang, Origin)
        self.assertEqual(origin.annotate(["later unmarked"], Lang, Origin)[0], Origin(False))

    def test_utterance_boundary_reestablishes_original_state(self):
        tagged = origin.annotate([Lang("ru"), "first", End(), "second"], Lang, Origin, End)
        self.assertEqual([x.explicit for x in tagged if isinstance(x, Origin)], [True, True])

    def test_both_values_are_replayable_parameters(self):
        for explicit in (False, True):
            item = Origin(explicit)
            self.assertIsInstance(item, SynthParamCommand)
            self.assertFalse(item.isDefault)
        self.assertIs(origin.command_type(SynthParamCommand), Origin)
        with self.assertRaises(ValueError): Origin(1)

    def test_validated_keyboard_context_pins_default_and_none_reset(self):
        tagged=origin.annotate(["word",Lang(None),"letter"],Lang,Origin,End,default_explicit=True)
        self.assertEqual([item.explicit for item in tagged if isinstance(item,Origin)],[True,True])
        self.assertEqual(origin.annotate(["later_document"],Lang,Origin)[0],Origin(False))

    def test_empty_and_nontext_sequences_are_unchanged(self):
        for items in ([], [Lang("ru"), End()], [" ", End()]):
            self.assertIs(origin.annotate(items, Lang, Origin, End), items)

    def test_preannotated_sequence_is_idempotent(self):
        tagged = origin.annotate([Lang(None), "plain"], Lang, Origin)
        self.assertIs(origin.annotate(tagged, Lang, Origin), tagged)


class SubscriptionTests(unittest.TestCase):
    def setUp(self):
        self.point = Filter()
        self.owner = types.SimpleNamespace()
        # SimpleNamespace cannot be weak-referenced; use a faithful driver object.
        self.owner = type("Driver", (), {})()
        self.owner.supportedCommands = {Origin}
        self.owner._closed = False
        self.handler = types.SimpleNamespace(getSynth=lambda: self.owner)
        self.subscription = origin.subscribe(self.owner, types.SimpleNamespace(
            filter_speechSequence=self.point), self.handler, Lang, Origin, End)

    def tearDown(self): self.subscription.close()

    def test_only_active_owned_driver_is_annotated(self):
        items = [Lang(None), "text"]
        self.assertIsInstance(self.point.apply(items)[0], Origin)
        self.handler.getSynth = lambda: object()
        self.assertIs(self.point.apply(items), items)

    def test_closed_snapshot_cannot_affect_replacement_synth(self):
        callback = self.subscription.callback
        self.assertTrue(self.subscription.close())
        self.assertFalse(self.subscription.close())
        items = ["text"]
        self.assertIs(callback(items), items)
        self.assertFalse(self.point.callbacks)

    def test_closed_owner_or_unsupported_command_is_inert(self):
        items = ["text"]
        self.owner._closed = True
        self.assertIs(self.point.apply(items), items)
        self.owner._closed = False
        self.owner.supportedCommands = set()
        self.assertIs(self.point.apply(items), items)

    def test_owner_is_not_retained_by_registered_callback(self):
        import gc, weakref
        reference=weakref.ref(self.owner)
        self.owner=None
        gc.collect()
        self.assertIsNone(reference())
        items=["later"]
        self.assertIs(self.point.apply(items),items)

    def test_unregister_failure_leaves_old_callback_inert(self):
        callback=self.subscription.callback
        def fail(callback): raise RuntimeError("unregister failed")
        with patch.object(self.point,"unregister",fail):
            with self.assertRaises(RuntimeError):self.subscription.close()
        items=["later"]
        self.assertIs(callback(items),items)
        self.assertTrue(self.subscription.closed)

    def test_missing_public_extension_fails_explicitly(self):
        with self.assertRaisesRegex(RuntimeError, "filter_speechSequence"):
            origin.subscribe(self.owner, object(), self.handler, Lang, Origin)


class ActualDriverProvenanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.context = driver_module()
        cls.d = cls.context.__enter__()
    @classmethod
    def tearDownClass(cls): cls.context.__exit__(None,None,None)

    def capture(self, sequence, forced=False, enabled=("uk","ru","en")):
        seen=[]
        def text(pending, language, english, mixed, russian, spelling, explicit, **kwargs):
            if pending: seen.append((" ".join(pending),language,explicit))
            return iter(())
        with patch.object(self.d, "text_parts", text):
            list(self.d.speech_parts(sequence, "uk", "en-US", enabled_languages=enabled, forced=forced))
        return seen

    def test_transformed_default_language_remains_automatic(self):
        d=self.d
        self.assertEqual(self.capture([d.LanguageOriginCommand(False),d.LangChangeCommand("uk"),"RU UK"]),
            [("RU UK","uk",False)])

    def test_authored_same_language_marker_without_redundant_lang_command(self):
        d=self.d
        self.assertEqual(self.capture([d.LanguageOriginCommand(False),d.LangChangeCommand("uk"),"auto",
            d.LanguageOriginCommand(True),"authored"]),
            [("auto","uk",False),("authored","uk",True)])

    def test_authored_and_automatic_segments_preserve_boundaries(self):
        d=self.d
        self.assertEqual(self.capture([d.LanguageOriginCommand(True),d.LangChangeCommand("ru"),"explicit",
            d.LanguageOriginCommand(False),d.LangChangeCommand("uk"),"automatic"]),
            [("explicit","ru",True),("automatic","uk",False)])

    def test_parameter_replay_in_either_order(self):
        d=self.d
        for commands in ([d.LanguageOriginCommand(False),d.LangChangeCommand("ru")],
                         [d.LangChangeCommand("ru"),d.LanguageOriginCommand(False)]):
            self.assertEqual(self.capture(commands+["replayed"]),[("replayed","ru",False)])

    def test_fresh_direct_call_retains_legacy_named_locale(self):
        d=self.d
        self.capture([d.LanguageOriginCommand(False),"automatic"])
        self.assertEqual(self.capture([d.LangChangeCommand("ru"),"direct"]),[("direct","ru",True)])
        self.assertEqual(self.capture(["direct default"]),[("direct default","uk",False)])

    def test_forced_and_disabled_policy_still_precedes_origin(self):
        d=self.d
        self.assertEqual(self.capture([d.LanguageOriginCommand(False),d.LangChangeCommand("ru"),"forced"],True),
            [("forced","uk",True)])
        self.assertEqual(self.capture([d.LanguageOriginCommand(True),d.LangChangeCommand("ru"),"disabled"],
            enabled=("uk","en")),[("disabled","uk",True)])

    def test_typed_spelling_explicit_language_is_preserved(self):
        d=self.d
        with patch.object(d,"character_parts",return_value=iter(())) as character:
            list(d.speech_parts([d.LanguageOriginCommand(True),d.LangChangeCommand("ru"),
                d.CharacterModeCommand(True),"б"],"uk","en-US",enabled_languages=("uk","ru")))
        self.assertEqual(character.call_args.args[1],"ru")
        self.assertTrue(character.call_args.args[4])

    def test_actual_owned_typing_context_pins_default_word_echo_only_until_exit(self):
        d=self.d
        owner=d.SynthDriver.__new__(d.SynthDriver)
        owner._closed=False
        owner._dordiai_mode="auto"
        owner._dordiai_enabled_languages={"uk","ru"}
        point=Filter()
        subscription=d._language_origin.subscribe(owner,types.SimpleNamespace(filter_speechSequence=point),
            types.SimpleNamespace(getSynth=lambda:owner),d.LangChangeCommand,d.LanguageOriginCommand,
            d.EndUtteranceCommand,default_explicit=lambda driver:d._typing_locale.language_for(driver,None) is not None)
        try:
            with owner._dordiai_typing_context("ru_RU"):
                tagged=point.apply([d.LangChangeCommand(None),"абы"])
                self.assertTrue(tagged[0].explicit)
            plain=point.apply([d.LangChangeCommand(None),"абы"])
            self.assertFalse(plain[0].explicit)
            with owner._dordiai_typing_context("ru_RU",valid=lambda:False):
                invalid=point.apply([d.LangChangeCommand(None),"абы"])
                self.assertFalse(invalid[0].explicit)
            owner._dordiai_enabled_languages={"uk"}
            with owner._dordiai_typing_context("ru_RU"):
                disabled=point.apply([d.LangChangeCommand(None),"абы"])
                self.assertFalse(disabled[0].explicit)
        finally:
            subscription.close()

    def test_supported_commands_advertises_real_parameter(self):
        self.assertIn(self.d.LanguageOriginCommand,self.d.SynthDriver.supportedCommands)
        self.assertIsInstance(self.d.LanguageOriginCommand(False),SynthParamCommand)

    def test_real_router_runs_for_auto_but_not_authored_default(self):
        d=self.d
        memberships={"кошками":{"ru"},"мови":{"uk"},"мама":{"uk","ru"}}
        def candidates(word, script):
            return frozenset(memberships.get(word.casefold(),()))
        sequence=[d.LanguageOriginCommand(False),d.LangChangeCommand("uk"),"кошками мови"]
        with patch.object(d._wide,"_lexical_candidates",candidates):
            auto=list(d.speech_parts(sequence,"uk","en-US",enabled_languages=("uk","ru"),detect_russian=True))
            authored=list(d.speech_parts([d.LanguageOriginCommand(True),d.LangChangeCommand("uk"),
                "кошками мови"],"uk","en-US",enabled_languages=("uk","ru"),detect_russian=True))
        self.assertEqual([part[1][0] for part in auto],["ru","uk"])
        self.assertEqual(authored,[("text",("uk","кошками мови"))])

    def test_release_is_idempotent_and_closes_before_unregister_error(self):
        d=self.d
        obj=d.SynthDriver.__new__(d.SynthDriver)
        closed=[]
        obj._language_origin_subscription=types.SimpleNamespace(close=lambda:closed.append(True))
        obj._release_language_origin()
        obj._release_language_origin()
        self.assertEqual(closed,[True])
        self.assertIsNone(obj._language_origin_subscription)

    def test_actual_audio_failure_unregisters_and_preserves_original_exception(self):
        d=self.d
        obj=d.SynthDriver.__new__(d.SynthDriver)
        obj._voice_catalog_epoch=("same",)
        obj._worker_lease=None
        obj._native_membership_token=None
        obj._english_engine=None
        closed=[]
        obj._engine=types.SimpleNamespace(close=lambda:closed.append("engine"))
        obj._language_origin_subscription=types.SimpleNamespace(close=lambda:closed.append("origin"))
        obj._closed=False
        error=OSError("actual device construction failure fixture")
        sonic=types.ModuleType("synthDrivers._sonic")
        sonic.initialize=lambda:None
        with patch.dict(sys.modules,{"synthDrivers._sonic":sonic}),patch.object(
            d,"_resource_epoch",return_value=("same",)),patch.object(
            d.nvwave,"WavePlayer",side_effect=error):
            with self.assertRaises(OSError) as caught:obj._initialize_audio_output()
        self.assertIs(caught.exception,error)
        self.assertTrue(obj._closed)
        self.assertEqual(closed,["engine","origin"])
        self.assertIsNone(obj._language_origin_subscription)

    def test_terminate_unregisters_before_queued_worker_retirement(self):
        import queue,threading
        d=self.d
        obj=d.SynthDriver.__new__(d.SynthDriver)
        obj._closed=False
        obj._state=threading.Condition()
        obj._jobs=queue.Queue()
        obj.cancel=lambda:None
        calls=[]
        obj._language_origin_subscription=types.SimpleNamespace(close=lambda:calls.append(obj._closed))
        obj.terminate()
        self.assertEqual(calls,[True])
        self.assertIsNone(obj._jobs.get_nowait())

if __name__ == "__main__": unittest.main()
