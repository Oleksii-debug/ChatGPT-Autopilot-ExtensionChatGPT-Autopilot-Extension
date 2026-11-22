"""New native carriers use the shared selected-speaker converter.

Default tests use explicit carrier/session fixtures. Optional real ONNX checks
run only with DORDIAI_REAL_MODELS pointing at a prepared combined models tree;
those checks establish technical inference, never NVDA or pronunciation quality.
"""
from functools import cached_property
from datetime import datetime,timezone
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
import wave

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
sys.path.insert(0, str(RUNTIME))
import wide_voice
from session_control import SynthesisCancelled


class Owner:
    def __init__(self):
        self.cancelled = False
        self.checks = 0

    def check_cancelled(self):
        self.checks += 1
        if self.cancelled:
            raise SynthesisCancelled()


class Flow:
    def __init__(self):
        self.feeds = []

    def run(self, outputs, values):
        self.feeds.append(values)
        return [np.full((1, 1, values["spec"].shape[-1]), .1, np.float32)]


class Decoder:
    def run(self, outputs, values):
        return [np.full((1, 1, values["/Mul_output_0"].shape[-1] * 256), .25, np.float32)]


class Converter:
    def __init__(self):
        self.flow, self.decoder = Flow(), Decoder()
        self.targets = []

    def _session(self, path):
        raise AssertionError("The fixture carrier must not open a real model")

    def target_profile(self, profile):
        self.targets.append(profile)
        return np.full((1, 256, 1), .9, np.float32)

    @staticmethod
    def levelled(chunks):
        yield from chunks


class NewModelIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.models = Path(self.temporary.name) / "models"
        self.owner, self.converter = Owner(), Converter()
        self.voice = wide_voice.WideVoices(self.models, self.models / "voices",
                                           owner=self.owner, converter=self.converter,
                                           mms_cache_budget_bytes=2*wide_voice.MMS_MIN_ESTIMATE_BYTES)
        self.headroom = patch.object(wide_voice, "_headroom", return_value=None)
        self.headroom.start()
        self.addCleanup(self.headroom.stop)
        self.voice.registry = {
            "ha": {"backend": "mms-onnx", "source": "MMS/ha/source.npy"},
            "so": {"backend": "mms-onnx", "source": "MMS/so/source.npy"},
            "ny": {"backend": "mms-onnx", "source": "MMS/ny/source.npy"},
            "sat": {"backend": "extra-onnx", "source": "ExtraLanguages/sat/source.npy"},
            "ig": {"backend": "omni-onnx", "source": "SharedOmniONNX/references/ig/source.npy"},
            "ln": {"backend": "omni-onnx", "source": "SharedOmniONNX/references/ln/source.npy"},
        }
        self.carriers = []
        self.mms_source = np.full((1, 256, 1), .13, np.float32)
        self.extra_source = np.full((1, 256, 1), .31, np.float32)
        owner = self

        class Carrier:
            def __init__(self, directory, session_factory=None, owner=None):
                self.directory, self.factory, self.owner = Path(directory), session_factory, owner
                self.calls, self.closed = [], False
                owner_test.carriers.append(self)

            def audio(self, text, character=False, speed=1.):
                self.calls.append((text, character, speed))
                return np.full(1600, .1, np.float32), 16000, speed

            def close(self):
                self.closed = True

        owner_test = self
        self.mms = ModuleType("wide_mms")
        self.mms.MMSCarrier = Carrier
        self.mms.available = lambda models: {"ha", "so", "ny"}
        self.mms.source = lambda code, models: self.mms_source
        self.extra = ModuleType("wide_extra_models")
        self.extra.available = lambda models: {"sat"}
        self.extra.calls = []

        def extra_audio(code, text, character=False, *, models, rate=1., owner=None):
            self.extra.calls.append((code, text, character, models, rate, owner))
            return np.full(2205, .2, np.float32), 22050
        self.extra.audio = extra_audio
        self.extra.source = lambda code, *, models: self.extra_source
        self.extra.cleared_owners=[]
        self.extra.clear_engines=lambda owner=None:self.extra.cleared_owners.append(owner)
        self.omni_source = np.full((1, 256, 1), .27, np.float32)
        self.omni = ModuleType("wide_omnivoice_onnx")
        self.omni.available = lambda models: {"ig", "ln"}
        self.omni.calls = []
        def omni_audio(code, text, character=False, *, models, rate=1., owner=None):
            self.omni.calls.append((code, text, character, models, rate, owner))
            return np.full(2400, .15, np.float32), 24000
        self.omni.audio = omni_audio
        self.omni.source = lambda code, *, models: self.omni_source
        self.rasa = ModuleType("wide_rasa")
        self.rasa.available = lambda models: {"brx"}
        self.rasa.calls = []
        self.rasa.cleared_owners = []
        self.rasa_source = np.full((1,256,1),.41,np.float32)
        def rasa_audio(code,text,character=False,*,models,rate=1.,owner=None):
            self.rasa.calls.append((code,text,character,models,rate,owner))
            return np.full(2400,.17,np.float32),24000
        self.rasa.audio=rasa_audio
        self.rasa.source=lambda code,*,models:self.rasa_source
        self.rasa.clear_engines=lambda owner=None:self.rasa.cleared_owners.append(owner)
        self.modules = patch.dict(sys.modules, {"wide_mms": self.mms, "wide_extra_models": self.extra,
                                               "wide_omnivoice_onnx": self.omni,"wide_rasa":self.rasa})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.addCleanup(self.voice.close)

    def collect(self, code, *, character=False, speed=1.):
        return np.concatenate(list(self.voice.blocks("viktoriia", code, "Native test", speed, character)))

    def test_mms_uses_global_models_native_source_and_selected_voice_projection(self):
        output = self.collect("ha")
        self.assertTrue(output.size and np.isfinite(output).all() and np.max(np.abs(output)) > 0)
        carrier = self.carriers[0]
        self.assertEqual(carrier.directory, self.models / "MMS/ha")
        self.assertEqual(carrier.factory, self.converter._session)
        self.assertIs(carrier.owner, self.owner)
        self.assertTrue(all(np.array_equal(feed["src_g"], self.mms_source) for feed in self.converter.flow.feeds))
        self.assertTrue(all(np.all(feed["tgt_g"] == .9) for feed in self.converter.flow.feeds))
        self.assertEqual(self.converter.targets, ["viktoriia"])
        self.assertIsNone(self.voice._engine, "New MMS must never open the fallback eSpeak engine")

    def test_extra_onnx_uses_actual_backend_source_not_legacy_widelanguages_path(self):
        output = self.collect("sat")
        self.assertTrue(output.size)
        self.assertEqual(self.extra.calls[0][0], "sat")
        self.assertEqual(self.extra.calls[0][3], self.models)
        self.assertIs(self.extra.calls[0][5], self.owner)
        self.assertTrue(all(np.array_equal(feed["src_g"], self.extra_source) for feed in self.converter.flow.feeds))
        self.assertEqual(self.converter.targets, ["viktoriia"])
        self.assertIsNone(self.voice._engine)

    def test_close_releases_only_the_extra_engines_used_by_this_owner(self):
        self.assertEqual(self.extra.cleared_owners,[])
        self.collect("sat")
        self.voice.close()
        self.assertEqual(self.extra.cleared_owners,[self.owner])
        self.voice.close()
        self.assertEqual(self.extra.cleared_owners,[self.owner])

    def test_rasa_preferred_route_projects_its_own_source_and_cleans_owner(self):
        self.voice.registry["brx"]={"backend":"rasa-onnx","source":"SharedRasaONNX/references/brx/source.npy"}
        with patch("language_catalog.resolve_backend_info",side_effect=lambda models,code,info,**kw:info):
            self.assertTrue(self.collect("brx").size)
        self.assertEqual(self.rasa.calls[0][0],"brx")
        self.assertIs(self.rasa.calls[0][-1],self.owner)
        self.assertTrue(all(np.array_equal(feed["src_g"],self.rasa_source) for feed in self.converter.flow.feeds))
        self.voice.close()
        self.voice.close()
        self.assertEqual(self.rasa.cleared_owners,[self.owner])

    def test_text_selected_same_language_fallback_does_not_reuse_preferred_source(self):
        self.voice.registry["ks"]={"backend":"extra-onnx","family":"matcha","source":"ExtraLanguages/ks/source.npy"}
        self.extra.available=lambda models:{"ks"}
        self.omni.available=lambda models:{"ks"}
        preferred=dict(self.voice.registry["ks"])
        fallback={"backend":"omni-onnx","language":"ks","source":"SharedOmniONNX/references/ks/source.npy"}
        selections=[]
        def resolve(models,code,info,*,text=None,character=False):
            selections.append((code,text,character))
            return fallback if text=="unsupported" else preferred
        with patch("language_catalog.resolve_backend_info",side_effect=resolve):
            for text,expected in (("native",self.extra_source),("unsupported",self.omni_source),("native",self.extra_source)):
                start=len(self.converter.flow.feeds)
                self.assertTrue(list(self.voice.blocks("viktoriia","ks",text)))
                self.assertTrue(all(np.array_equal(feed["src_g"],expected) for feed in self.converter.flow.feeds[start:]))
        self.assertEqual(selections,[("ks","native",False),("ks","unsupported",False),("ks","native",False)])
        self.assertEqual(len(self.extra.calls),2)
        self.assertEqual(len(self.omni.calls),1)
        self.assertEqual(self.voice._selected_source.cache_info().currsize,2)

    def test_mms_cache_reuses_current_and_recent_carrier_and_closes_evicted_model(self):
        self.collect("ha")
        self.collect("so")
        self.collect("ha")
        self.assertEqual(len(self.carriers), 2)
        self.collect("ny")
        self.assertEqual(list(self.voice._mms_carriers), ["ha", "ny"])
        self.assertTrue(self.carriers[1].closed)
        self.assertFalse(self.carriers[0].closed)
        self.voice.close()
        self.assertTrue(all(carrier.closed for carrier in self.carriers))

    def test_three_language_dictionary_cycle_keeps_models_warm_when_budget_allows(self):
        roomy=wide_voice.WideVoices(self.models,self.models/"voices",owner=self.owner,converter=self.converter,
            mms_cache_budget_bytes=3*wide_voice.MMS_MIN_ESTIMATE_BYTES)
        self.addCleanup(roomy.close)
        roomy.registry=dict(self.voice.registry)
        for _ in range(3):
            for code in ("ha", "so", "ny"):
                list(roomy.blocks("viktoriia",code,"Native dictionary word"))
        self.assertEqual(len(self.carriers), 3)
        self.assertFalse(any(carrier.closed for carrier in self.carriers))
        self.assertEqual(len(roomy._mms_carriers), 3)
        diagnostics=roomy.cache_diagnostics()
        self.assertTrue(all(row["carrier_reused"] for row in diagnostics["native_generation"][-3:]))
        self.assertIn("excludes voice conversion", diagnostics["timing_scope"])

    def test_default_roomy_ram_policy_allows_seven_models_but_never_all_catalog(self):
        with patch.object(wide_voice, "_headroom", return_value=8*1024**3):
            roomy=wide_voice.WideVoices(self.models,self.models/"voices",owner=self.owner,converter=self.converter)
            self.addCleanup(roomy.close)
            codes=("ha","so","ny","rw","rn","sn","tpi","fj")
            roomy.registry={code:{"backend":"mms-onnx"} for code in codes}
            self.mms.available=lambda models:set(codes)
            for code in codes:
                list(roomy.blocks("viktoriia",code,"Native dictionary word"))
            self.assertEqual(len(roomy._mms_carriers),7)
            self.assertNotIn("ha",roomy._mms_carriers)
            self.assertTrue(self.carriers[0].closed)
            self.assertLessEqual(sum(roomy._mms_estimates.values()),roomy._mms_budget_bytes)

    def test_too_small_budget_refuses_new_model_before_allocating_a_session(self):
        tiny=wide_voice.WideVoices(self.models,self.models/"voices",owner=self.owner,converter=self.converter,
            mms_cache_budget_bytes=wide_voice.MMS_MIN_ESTIMATE_BYTES-1)
        self.addCleanup(tiny.close)
        tiny.registry=dict(self.voice.registry)
        with self.assertRaises(MemoryError):
            list(tiny.blocks("viktoriia","ha","Native word"))
        self.assertEqual(self.carriers,[])
        self.assertEqual(self.converter.flow.feeds,[])

    def test_omni_shared_backend_uses_same_language_source_and_selected_voice(self):
        self.collect("ig")
        self.collect("ln")
        self.assertEqual([row[0] for row in self.omni.calls],["ig","ln"])
        self.assertTrue(all(row[3]==self.models and row[5] is self.owner for row in self.omni.calls))
        self.assertTrue(all(np.array_equal(feed["src_g"],self.omni_source) for feed in self.converter.flow.feeds))
        self.assertEqual(self.converter.targets,["viktoriia","viktoriia"])
        timings=self.voice.cache_diagnostics()["native_generation"]
        self.assertFalse(timings[0]["shared_engine_previously_used"])
        self.assertTrue(timings[1]["shared_engine_previously_used"])
        self.assertIsNone(self.voice._engine)

    def test_omni_model_loading_releases_mms_cache_under_ram_pressure(self):
        self.collect("ha")
        self.collect("so")
        with patch.object(wide_voice,"_headroom",side_effect=[2*1024**3,4*1024**3]):
            self.collect("ig")
        self.assertTrue(self.carriers[0].closed)
        self.assertEqual(list(self.voice._mms_carriers),["so"])

    def test_missing_omni_resources_are_not_replaced_by_espeak(self):
        self.omni.available=lambda models:set()
        with self.assertRaisesRegex(ValueError,"not installed"):
            self.collect("ig")
        self.assertIsNone(self.voice._engine)

    def test_absent_models_fail_without_fallback_to_another_language(self):
        self.mms.available = lambda models: set()
        with self.assertRaisesRegex(ValueError, "not installed"):
            self.collect("ha")
        self.extra.available = lambda models: set()
        with self.assertRaisesRegex(ValueError, "not installed"):
            self.collect("sat")
        self.assertIsNone(self.voice._engine)
        self.assertEqual(self.converter.targets, [])

    def test_native_character_errors_propagate_without_speaking_foreign_letter_name(self):
        carrier = self.voice._mms_carrier("ha")
        def unsupported(text, character=False, speed=1.):
            raise ValueError("Verified character name is not installed")
        carrier.audio = unsupported
        with self.assertRaisesRegex(ValueError, "character name"):
            self.collect("ha", character=True)
        self.assertIsNone(self.voice._engine)

    def test_cancellation_is_checked_before_new_session_or_projection(self):
        self.owner.cancelled = True
        with self.assertRaises(SynthesisCancelled):
            self.collect("ha")
        self.assertEqual(self.carriers, [])
        self.assertEqual(self.converter.flow.feeds, [])

    def test_applied_native_speed_is_not_applied_twice_after_conversion(self):
        seen = []
        def tempo(chunks, sample_rate, factor):
            seen.append((sample_rate, factor))
            yield from chunks
        with patch.object(wide_voice, "stream_tempo", tempo):
            self.collect("ha", speed=3.)
        self.assertEqual(self.carriers[0].calls[0][2], 1.85)
        self.assertEqual(seen, [(24000, 3. / 1.85)])

    def test_conversion_outputs_bounded_chunks_for_long_new_native_utterance(self):
        carrier = self.voice._mms_carrier("ha")
        carrier.audio = lambda *a, **kw: (np.full(16000 * 4, .1, np.float32), 16000, 1.)
        blocks = list(self.voice.blocks("viktoriia", "ha", "Long native text"))
        self.assertGreater(len(blocks), 2)
        self.assertLessEqual(max(len(block) for block in blocks), 24000 * 2)
        self.assertGreater(self.owner.checks, 4)


@unittest.skipUnless(os.environ.get("DORDIAI_REAL_MODELS"), "Set DORDIAI_REAL_MODELS for actual ONNX integration")
class RealNewModelIntegrationTests(unittest.TestCase):
    """Real native ONNX + shared OpenVoice conversion; no stub model outputs."""
    def test_available_prepared_native_carriers_project_to_actual_selected_voice(self):
        import onnxruntime as ort
        ort.disable_telemetry_events()
        import wide_mms
        import wide_extra_models
        import wide_omnivoice_onnx
        models = Path(os.environ["DORDIAI_REAL_MODELS"]).resolve()
        owner = Owner()

        class ActualConverter:
            def __init__(self):
                self.paths = []

            def _session(self, path):
                options = ort.SessionOptions()
                options.intra_op_num_threads = 2
                options.inter_op_num_threads = 1
                options.add_session_config_entry("session.intra_op.allow_spinning", "0")
                self.paths.append(str(path))
                return ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])

            @cached_property
            def flow(self):
                return self._session(models / "OpenVoiceV2/encoder-flow.onnx")

            @cached_property
            def decoder(self):
                return self._session(models / "OpenVoiceV2/decoder.onnx")

            def target_profile(self, profile):
                target = np.load(models / "voices/classmate_locales" / (profile + ".npy"), allow_pickle=False)
                assert target.shape == (1, 256, 1) and np.isfinite(target).all()
                return target

            @staticmethod
            def levelled(chunks):
                yield from chunks

        converter = ActualConverter()
        voices = wide_voice.WideVoices(models, models / "voices", owner=owner, converter=converter,
            mms_cache_budget_bytes=2*1024**3)
        self.addCleanup(voices.close)
        samples = {}
        if "ha" in wide_mms.available(models):
            samples["ha"] = ("mms-onnx", "Sannu duniya.")
        if "so" in wide_mms.available(models):
            samples["so"] = ("mms-onnx", "Salaan adduunka.")
        if "yo" in wide_mms.available(models):
            samples["yo"] = ("mms-onnx", "Bawo ni.")
        extra_samples={"sat":"ᱡᱚᱦᱟᱨ ᱥᱟᱱᱛᱟᱲᱤ ᱯᱟᱹᱨᱥᱤ","st":"Lumela.","xh":"Molo.",
                       "ig":"Ndewo.","ln":"Mbote."}
        for code,text in extra_samples.items():
            if code in wide_extra_models.available(models):samples[code]=("extra-onnx",text)
        if "brx" in wide_omnivoice_onnx.available(models):
            samples["brx"]=("omni-onnx","खुलुमबाय")
        elif "ig" in wide_omnivoice_onnx.available(models) and "ig" not in samples:
            samples["ig"]=("omni-onnx","Ndewo.")
        self.assertTrue(samples, "No complete real MMS/extra model was prepared")
        report = {"scope": "real native ONNX + OpenVoice selected-voice projection on Linux",
                  "created_utc":datetime.now(timezone.utc).isoformat(),
                  "status": "running", "windows_nvda_verified": False, "pronunciation_verified": False,
                  "voice": "viktoriia", "models_root": str(models), "tests": []}
        output_directory = Path(os.environ["DORDIAI_REAL_OUTPUT"]) if os.environ.get("DORDIAI_REAL_OUTPUT") else None
        if output_directory is not None:
            output_directory.mkdir(parents=True, exist_ok=True)
            (output_directory / "real-new-model-integration.json").write_text(
                json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        for code, (backend, text) in samples.items():
            with self.subTest(language=code):
                voices.registry[code] = {"backend": backend}
                blocks = list(voices.blocks("viktoriia", code, text))
                audio = np.concatenate(blocks)
                self.assertTrue(np.isfinite(audio).all())
                self.assertGreater(len(audio), 2400)
                self.assertGreater(float(np.max(np.abs(audio))), 1e-6)
                self.assertIsNone(voices._engine)
                item = {"code": code, "backend": backend, "text": text, "sample_rate": 24000,
                        "samples": len(audio), "seconds": len(audio) / 24000,
                        "blocks": len(blocks), "peak": float(np.max(np.abs(audio))),
                        "rms": float(np.sqrt(np.mean(audio.astype(np.float64) ** 2))),
                        "pcm_sha256": sha256(np.rint(np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()).hexdigest()}
                if output_directory is not None:
                    path = output_directory / (code + "-viktoriia-real-conversion.wav")
                    with wave.open(str(path), "wb") as stream:
                        stream.setnchannels(1)
                        stream.setsampwidth(2)
                        stream.setframerate(24000)
                        stream.writeframes(np.rint(np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
                    item["wave_file"] = str(path)
                report["tests"].append(item)
        mms_codes=[code for code,(backend,_) in samples.items() if backend=="mms-onnx"]
        if len(mms_codes)>=3:
            for code in mms_codes:
                audio=np.concatenate(list(voices.blocks("viktoriia",code,samples[code][1])))
                self.assertGreater(len(audio),2400)
            cache=voices.cache_diagnostics()
            repeat=cache["native_generation"][-len(mms_codes):]
            self.assertTrue(all(row["carrier_reused"] and row["session_previously_loaded"] for row in repeat))
            self.assertEqual(set(cache["mms_cached_languages"]),set(mms_codes))
            report["three_mms_language_warm_cycle_verified"]=True
        report["native_cache_diagnostics"]=voices.cache_diagnostics()
        report["opened_onnx_graphs"] = converter.paths
        report["status"]="passed"
        if output_directory is not None:
            (output_directory / "real-new-model-integration.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
