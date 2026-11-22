"""Fixture/identity/output tests; synthetic fixtures do not certify pronunciation."""
import base64
from copy import deepcopy
from hashlib import sha256
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import wave
import zipfile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("zgh_private_probe_test",ROOT/"tools/research/probe_zgh_omni.py")
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class AuthenticFixtureTests(unittest.TestCase):
    def setUp(self):
        self.fixture,self.audio=m.load_fixture(m.FIXTURE)
    def test_actual_creator_audio_has_exact_native_standard_and_full_source_pin(self):
        self.assertEqual(self.fixture["language"],"zgh")
        self.assertEqual(self.fixture["not_alias_of"],"kab")
        self.assertEqual(self.fixture["source"]["size_bytes"],587038815)
        self.assertTrue(self.fixture["source"]["whole_file_sha256_actually_verified"])
        self.assertEqual(len(self.audio),133198)
        self.assertEqual(sha256(self.audio).hexdigest(),"f08b5ae2c53c1888c0988570e26ef74726ec0d1d2ac475f22fcd12284cd5586a")
        self.assertFalse(self.fixture["product_integrated"])
    def test_reference_is_untrimmed_original_pcm48k_mono(self):
        with wave.open(io.BytesIO(self.audio),"rb") as source:
            self.assertEqual((source.getnchannels(),source.getsampwidth(),source.getframerate(),source.getnframes()),(1,2,48000,66560))
        self.assertEqual(self.fixture["reference"]["audio_path"],"Voice 095.wav")
        self.assertEqual([row["index"] for row in self.fixture["targets"]],[1,2])
    def mutate(self,change):
        document=deepcopy(self.fixture);change(document)
        raw=m.json_bytes(document)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"synthetic-modified-fixture.json";path.write_bytes(raw)
            with patch.object(m,"FIXTURE_SHA",sha256(raw).hexdigest()):
                return m.load_fixture(path)
    def test_kabyle_cannot_be_relabelled_as_zgh(self):
        with self.assertRaises(ValueError):
            self.mutate(lambda document:document.__setitem__("language","kab"))
    def test_arabic_or_latin_text_cannot_replace_authentic_tifinagh(self):
        with self.assertRaises(ValueError):
            self.mutate(lambda document:document["reference"].__setitem__("text","Nekkni neqqar aẓawan."))
    def test_audio_mutation_fails_actual_inner_digest(self):
        def change(document):
            blob=bytearray(self.audio);blob[-1]^=1
            document["reference"]["audio_base64"]=base64.b64encode(blob).decode()
        with self.assertRaises(ValueError):self.mutate(change)
    def test_source_language_controls_are_distinct_bpe_sequences(self):
        self.assertEqual(m.CONTROL_ZGH,[151670,89,866,151671])
        self.assertEqual(m.CONTROL_KAB,[151670,74,370,151671])
        self.assertNotEqual(m.CONTROL_ZGH,m.CONTROL_KAB)
        self.assertTrue(self.fixture["omni_model"]["marker_ids_are_regular_subword_encoding_not_a_dedicated_zgh_token"])

class SourceAndOutputSafetyTests(unittest.TestCase):
    def test_source11_core_and_reference_encoder_are_exact_existing_bytes(self):
        self.assertEqual(m.CORE_SIZE,1992938157)
        self.assertEqual(m.CORE_SHA,"223e5ea7b29d0f9d16f3ca653711e8ced281c0fc7d5bd2fb891018a73926eceb")
        self.assertEqual(m.MODELS["OpenVoiceV2/tone_ref_encoder.onnx"][1],"3dd4918cab90e1acf7fa5c6f7539c27710e7a3cdfba550468c5ea49399178bf7")
    def test_private_sdk_and_target_asset_subset_does_not_copy_blocked_embeddings(self):
        self.assertTrue(m.selected_core_file("manifest.ini"))
        self.assertTrue(m.selected_core_file("kx47Runtime/python/Lib/site-packages/numpy/core.pyd"))
        self.assertTrue(m.selected_core_file("kx47Runtime/models/OpenVoiceV2/encoder-flow.onnx"))
        self.assertTrue(m.selected_core_file("kx47Runtime/models/voices/english/viktoriia.npy"))
        self.assertTrue(m.selected_core_file("kx47Runtime/models/voices/classmate_locales/viktoriia.npy"))
        self.assertTrue(m.selected_core_file("kx47Runtime/models/voices/deeper/native/viktoriia.npy"))
        self.assertFalse(m.selected_core_file("kx47Runtime/models/voices/kostia.npy"))
        self.assertFalse(m.selected_core_file("kx47Runtime/models/Piper/unneeded.onnx"))

    def test_managed_selected_profile_preserves_every_declared_original_asset(self):
        raw=io.BytesIO()
        with zipfile.ZipFile(raw,"w") as archive:
            archive.writestr("kx47Runtime/models/voices/packages/viktoriia/1.0/voice-package.json",json.dumps({"id":"viktoriia","files":{"target-original.npy":{"role":"target_embedding"},"bank.pcm":{"role":"native_letters_audio"}}}))
            archive.writestr("kx47Runtime/models/voices/packages/kostia/1.0/voice-package.json",json.dumps({"id":"kostia","files":{"target.npy":{}}}))
        with zipfile.ZipFile(io.BytesIO(raw.getvalue())) as archive:
            names=m.selected_managed_assets(archive)
        self.assertIn("kx47Runtime/models/voices/packages/viktoriia/1.0/target-original.npy",names)
        self.assertIn("kx47Runtime/models/voices/packages/viktoriia/1.0/bank.pcm",names)
        self.assertFalse(any("kostia" in name for name in names))
    def test_selected_managed_asset_cannot_escape_its_exact_package(self):
        raw=io.BytesIO()
        with zipfile.ZipFile(raw,"w") as archive:
            archive.writestr("kx47Runtime/models/voices/packages/viktoriia/1.0/voice-package.json",json.dumps({"id":"viktoriia","files":{"../kostia.npy":{}}}))
        with zipfile.ZipFile(io.BytesIO(raw.getvalue())) as archive:
            with self.assertRaises(ValueError):m.selected_managed_assets(archive)
    def test_target_uses_native_wide_resolver_not_the_different_english_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime=Path(directory);voices=runtime/"models/voices"
            selected=voices/"classmate_locales/viktoriia.npy"
            selected.parent.mkdir(parents=True);selected.write_bytes(b"synthetic selected-profile identity")
            (voices/"catalog.json").write_text(json.dumps({"viktoriia":"synthetic test profile"}),encoding="utf-8")
            value=SimpleNamespace(dtype="float32",shape=(1,256,1),tobytes=lambda:b"synthetic vector")
            fake_np=SimpleNamespace(float32="float32",load=lambda path,**kw:value,isfinite=lambda x:SimpleNamespace(all=lambda:True),linalg=SimpleNamespace(norm=lambda x:1.))
            calls=[]
            converter=SimpleNamespace(resource=lambda root,name:root/name,target_profile=lambda profile:(calls.append(profile) or value),_reference=lambda profile:(_ for _ in ()).throw(AssertionError("English fallback forbidden")))
            policy=SimpleNamespace(require_voice_allowed=lambda profile:None,EXCLUDED_VOICE_IDS={"kostia"})
            assets=SimpleNamespace(asset_path=lambda root,profile,role,**kw:None)
            with patch.dict(sys.modules,{"voice_policy":policy,"voice_assets":assets}):
                actual,facts=m.target_profile(runtime,converter,fake_np)
            self.assertIs(actual,value);self.assertEqual(calls,["viktoriia"])
            self.assertEqual(Path(facts["asset"]),Path("models/voices/classmate_locales/viktoriia.npy"))
            self.assertEqual(facts["original_target_resolver"],"NativeLocaleVoices.target_profile")

    def test_zip_path_and_link_rejected(self):
        for name in ("../bad","/absolute","kx47Runtime/C:bad","kx47Runtime\\bad"):
            with self.assertRaises(ValueError):m.safe_member(zipfile.ZipInfo(name))
        info=zipfile.ZipInfo("kx47Runtime/python/link");info.external_attr=(stat.S_IFLNK|0o777)<<16
        with self.assertRaises(ValueError):m.safe_member(info)
    def test_model_cache_bytes_cannot_be_silently_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"model.onnx";path.write_bytes(b"synthetic")
            with self.assertRaises(ValueError):m.verify_model(path,(9,"0"*64,None))
            self.assertEqual(path.read_bytes(),b"synthetic")
    def test_owned_report_rejects_external_change(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"proof.json";writer=m.Report(path);writer.write({"scope":"synthetic"})
            path.write_text("external",encoding="utf-8")
            with self.assertRaises(ValueError):writer.write({"changed":True})
            self.assertEqual(path.read_text(encoding="utf-8"),"external")
    def test_report_does_not_clobber_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"proof.json";path.write_bytes(b"existing")
            with self.assertRaises(FileExistsError):m.Report(path)
    def test_private_acoustic_probe_cannot_run_in_host_interpreter(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):m.probe(SimpleNamespace(runtime=Path(directory)))
    def test_original_standard_training_counts_are_not_merged(self):
        value,_=m.load_fixture(m.FIXTURE)
        self.assertEqual(value["omni_model"]["declared_zgh_training_hours"],1.19)
        self.assertEqual(value["omni_model"]["declared_kab_training_hours"],529.52)
        self.assertNotIn("zgh",("kab",))

@unittest.skipUnless(os.environ.get("ZGH_TEST_TOKENIZER"),"Actual pinned tokenizer is checked in dedicated preparation/private probe")
class ActualPinnedTokenizerTests(unittest.TestCase):
    def test_exact_regular_language_tokens_and_native_tifinagh_roundtrip(self):
        from tokenizers import Tokenizer
        path=Path(os.environ["ZGH_TEST_TOKENIZER"])
        self.assertEqual(m.fingerprint(path)["sha256"],m.MODELS["SharedOmniONNX/tokenizer.json"][1])
        tokenizer=Tokenizer.from_file(str(path))
        for code,expected in (("zgh",m.CONTROL_ZGH),("kab",m.CONTROL_KAB)):
            text="<|lang_start|>"+code+"<|lang_end|>"
            encoded=tokenizer.encode(text,add_special_tokens=False)
            self.assertEqual(encoded.ids,expected)
            self.assertEqual(tokenizer.decode(encoded.ids,skip_special_tokens=False),text)
        fixture,_=m.load_fixture(m.FIXTURE)
        for row in [fixture["reference"]]+fixture["targets"]:
            encoded=tokenizer.encode(row["text"],add_special_tokens=False)
            self.assertNotIn(tokenizer.token_to_id("<unk>"),encoded.ids)
            self.assertEqual(tokenizer.decode(encoded.ids,skip_special_tokens=False),row["text"])

if __name__=="__main__":unittest.main()

