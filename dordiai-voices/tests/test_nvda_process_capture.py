"""Owned sibling receipts/passive feed/full-phrase comparison, no device claim."""
import ast
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

TOOLS=Path(__file__).resolve().parents[1]/"tools"
sys.path.insert(0,str(TOOLS))
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
support=load("owned_nvda_support_test",TOOLS/"nvda_process_capture_support.py")
probe=load("owned_nvda_probe_test",TOOLS/"windows_nvda_process_capture_probe.py")


class FullWindowCorrelationTests(unittest.TestCase):
    def setUp(self):
        self.rate=24000
        self.source=np.random.default_rng(1957).integers(-9000,9000,6000,dtype=np.int16)
        self.raw=self.source.astype("<i2").tobytes()

    def capture(self,values):
        return np.asarray(values,dtype="<i2").tobytes()

    def test_full_exact_phrase_positive_offset_and_gain_pass_without_latency_claim(self):
        actual=np.concatenate((np.zeros(317),self.source*.7,np.zeros(2000)))
        row=support.correlate_phrase(self.raw,self.capture(actual),self.rate)
        self.assertTrue(row["requested_phrase_waveform_match_verified"])
        self.assertEqual(row["matched_capture_array_offset_frames"],317)
        self.assertGreater(row["normalized_correlation"],.999)
        self.assertTrue(row["complete_reference_window_used"])
        self.assertFalse(row["physical_audio_verified"])
        self.assertFalse(row["acoustic_latency_verified"])

    def test_silence_unrelated_noise_and_inversion_never_pass(self):
        noise=np.random.default_rng(35).integers(-9000,9000,10000,dtype=np.int16)
        for values in (np.zeros(10000),noise,np.concatenate((-self.source,np.zeros(4000)))):
            with self.subTest():
                self.assertFalse(support.correlate_phrase(self.raw,self.capture(values),self.rate)["virtual_audio_verified"])

    def test_partial_phrase_or_middle_word_drop_is_not_full_waveform_match(self):
        for values in (np.concatenate((self.source[:3000],np.zeros(5000))),
                       np.concatenate((self.source[:2500],self.source[3500:],np.zeros(3000)))):
            self.assertFalse(support.correlate_phrase(self.raw,self.capture(values),self.rate)["virtual_audio_verified"])

    def test_incomplete_or_unbounded_format_is_rejected(self):
        for raw,rate in ((self.raw,12345),(self.raw[:-1],24000),(b"",24000)):
            with self.assertRaises(ValueError):support.correlate_phrase(raw,self.raw,rate)
        with self.assertRaises(ValueError):support.correlate_phrase(self.raw,self.raw[:1000],24000)


class ReadyAndLineageTests(unittest.TestCase):
    def ready(self):
        return {"format":"dordiai-owned-nvda-capture-ready","status":"ready","pid":2020,"controller_pid":1010,
            "probe_id":"a"*32,"synth":"kx47Preview","config":"owned/config","image_sha256":"f"*64,
            "sample_rate":24000,"recording_pcm_sink_test_double":False,"physical_audio_verified":False}

    def validate_ready(self,row):
        return support.validate_ready(row,nvda_pid=2020,controller_pid=1010,nonce="a"*32,config="owned/config",image_sha="f"*64)

    def test_ready_binds_actual_child_controller_config_nonce_and_image(self):
        self.assertEqual(self.validate_ready(self.ready()),24000)
        for key,value in (("pid",55),("controller_pid",55),("probe_id","b"*32),("config","other/config"),
                          ("image_sha256","e"*64),("synth","espeak"),("recording_pcm_sink_test_double",True)):
            row=self.ready();row[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.validate_ready(row)

    def capture(self):
        result={"status":"technical-owned-nvda-capture-complete","capture_mode":"verified-owned-nvda-sibling-include-tree",
            "target_pid":2020,"current_pid":3030,"async_callback_completed":True,"all_own_com_interfaces_released":True,"cleanup_errors":[],
            "ownership":{"target_pid":2020,"controller_pid":1010,"helper_pid":3030,"target_parent_pid":1010,
                         "helper_parent_pid":1010,"same_controller_parent_verified":True,"image_sha256":"f"*64,"plugin_ready_sha256":"c"*64},
            "native_format":{"sample_rate":24000,"channels":1,"bits_per_sample":16,"block_align":2,"native_encoding":"pcm16le"}}
        result.update({key:False for key in ("physical_audio_verified","acoustic_latency_verified","microphone_capture_used",
            "privacy_settings_changed","default_device_changed","format_changed","service_restart_performed","reboot_performed","product_ready")})
        return result

    def validate_capture(self,row):
        support.validate_capture(row,nvda_pid=2020,controller_pid=1010,helper_pid=3030,image_sha="f"*64,ready_sha="c"*64,sample_rate=24000)

    def test_only_native_sibling_lineage_can_be_accepted(self):
        self.validate_capture(self.capture())
        for key,value in (("target_pid",45),("controller_pid",45),("helper_parent_pid",45),("target_parent_pid",45),
                          ("same_controller_parent_verified",False),("plugin_ready_sha256","d"*64)):
            row=self.capture();row["ownership"][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.validate_capture(row)

    def test_failed_async_cleanup_scope_or_format_never_passes(self):
        for key,value in (("async_callback_completed",False),("all_own_com_interfaces_released",False),
                          ("cleanup_errors",["Stop failed"]),("physical_audio_verified",True),("microphone_capture_used",True)):
            row=self.capture();row[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.validate_capture(row)
        row=self.capture();row["native_format"]["channels"]=2
        with self.assertRaises(ValueError):self.validate_capture(row)

    def test_pcm_exact_receipt_and_regular_file_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);path=root/"owned.pcm";path.write_bytes(b"\1\0\2\0")
            receipt={"filename":path.name,"size_bytes":4,"sha256":sha256(path.read_bytes()).hexdigest()}
            self.assertEqual(support.read_pcm(path,receipt),path.read_bytes())
            path.write_bytes(b"\2\0\3\0")
            with self.assertRaises(ValueError):support.read_pcm(path,receipt)
            link=root/"link.pcm"
            try:link.symlink_to(path)
            except OSError:return
            with self.assertRaises(ValueError):support.read_pcm(link,{**receipt,"filename":link.name})


class PassivePluginAndControllerTests(unittest.TestCase):
    def function(self,name,namespace):
        tree=ast.parse(probe.PLUGIN_CODE.replace("__SETTINGS__","{}"))
        node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),"actual-observer-function","exec"),namespace)
        return namespace[name]

    def test_observer_calls_original_once_with_identical_arguments_and_return(self):
        calls=[];outcome=object();data=bytearray(b"\1\0\2\0")
        def original(value,*args,**kwargs):calls.append((value,args,kwargs));return outcome
        ns={"time":SimpleNamespace(perf_counter_ns=lambda:123),"PHASE":"capturing","SAMPLE_RATE":24000,
            "PCM":bytearray(),"EVENTS":[],"ORIGINAL_FEED":original}
        feed=self.function("feed",ns)
        self.assertIs(feed(data,45,index=7),outcome)
        self.assertEqual(len(calls),1);self.assertIs(calls[0][0],data)
        self.assertEqual(calls[0][1:],((45,),{"index":7}))
        self.assertEqual(ns["PCM"],data)

    def test_warmup_is_not_inserted_into_final_phrase_reference(self):
        ns={"time":SimpleNamespace(perf_counter_ns=lambda:123),"PHASE":"warming","SAMPLE_RATE":24000,
            "PCM":bytearray(),"EVENTS":[],"ORIGINAL_FEED":lambda data:55}
        self.assertEqual(self.function("feed",ns)(b"\1\0"),55)
        self.assertEqual(ns["PCM"],b"");self.assertEqual(ns["EVENTS"],[])

    def test_matching_own_index_and_done_both_required_in_either_arrival_order(self):
        for first in ("done","index"):
            callbacks=[];driver=object()
            ns={"DRIVER":driver,"PHASE":"warming","INDEX_SEEN":False,"DONE_SEEN":False,
                "core":SimpleNamespace(callLater=lambda delay,callback:callbacks.append(callback)),
                "guarded":lambda callback:callback,"settled":lambda:None}
            done=self.function("done",ns);index=self.function("index_reached",ns)
            index(synth=driver,index=881003)
            self.assertFalse(ns["INDEX_SEEN"])
            if first=="done":done(synth=driver)
            else:index(synth=driver,index=881002)
            self.assertEqual(callbacks,[])
            if first=="done":index(synth=driver,index=881002)
            else:done(synth=driver)
            self.assertEqual(len(callbacks),1)

    def test_other_synth_or_other_request_index_cannot_complete_own_phase(self):
        callbacks=[];driver=object()
        ns={"DRIVER":driver,"PHASE":"capturing","INDEX_SEEN":False,"DONE_SEEN":False,
            "core":SimpleNamespace(callLater=lambda delay,callback:callbacks.append(callback)),
            "guarded":lambda callback:callback,"settled":lambda:None}
        done=self.function("done",ns);index=self.function("index_reached",ns)
        done(synth=object());index(synth=object(),index=881003);index(synth=driver,index=881002)
        self.assertFalse(ns["INDEX_SEEN"]);self.assertFalse(ns["DONE_SEEN"]);self.assertEqual(callbacks,[])

    def test_oversized_reference_fails_before_real_feed_or_unbounded_retention(self):
        ns={"time":SimpleNamespace(perf_counter_ns=lambda:123),"PHASE":"capturing","SAMPLE_RATE":24000,
            "PCM":bytearray(),"EVENTS":[],"ORIGINAL_FEED":lambda data:self.fail("oversize reached actual player")}
        with self.assertRaises(ValueError):self.function("feed",ns)(bytes(24000*2*8+2))

    def test_plugin_compiles_and_does_not_replace_player_or_generate_reference_audio(self):
        source=probe.PLUGIN_CODE.replace("__SETTINGS__","{}")
        compile(source,"owned-nvda-capture-plugin","exec")
        self.assertNotIn("nvwave.WavePlayer =",source)
        self.assertNotIn("DRIVER._play =",source)
        self.assertIn("result=ORIGINAL_FEED(data,*args,**kwargs)",source)
        self.assertIn('lease!={"pid_expected":os.getpid(),"probe_id":SETTINGS["probe_id"]}',source)

    def test_unrelated_existing_nvda_prevents_any_creation(self):
        base=SimpleNamespace(existing_nvda_processes=lambda:[{"pid":99}])
        with self.assertRaisesRegex(RuntimeError,"unrelated"):
            probe.create_portable(base,Path("must-not-create"),Path("unknown-addon"),"unknown-endpoint")

    def test_wait_file_rejects_exited_child_and_uses_existing_exact_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"ready.json"
            with self.assertRaisesRegex(RuntimeError,"owned child"):
                probe.wait_file(path,[SimpleNamespace(poll=lambda:1)],.1)
            path.write_text('{"pid":2020}')
            self.assertEqual(probe.wait_file(path,[],.1),{"pid":2020})

    def test_plugin_failure_during_warmup_is_detected_without_full_watchdog_wait(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);failure=root/"plugin-complete.json"
            failure.write_text('{"status":"failed","error":"actual model failed"}')
            with self.assertRaisesRegex(RuntimeError,"actual model failed"):
                probe.wait_file(root/"plugin-ready.json",[SimpleNamespace(poll=lambda:None)],180,failed_file=failure)


if __name__=="__main__":unittest.main()
