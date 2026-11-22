"""Synthetic PCM/queue/AST observers only; no hardware/NVDA/device operations."""
from array import array
from collections import deque
import ast
import ctypes as C
import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import wave

TOOLS=Path(__file__).resolve().parents[1]/"tools"
sys.path.insert(0,str(TOOLS))
import windows_virtual_audio_capture as capture
import virtual_capture_probe as observer
import windows_nvda_probe as real_probe


def synthetic():
    obj=object.__new__(capture.VirtualCapture)
    obj.hash=hashlib.sha256()
    obj.frames=obj.nonzero_samples=obj.peak=obj.energy=obj.sample_values=0
    obj.excerpt=bytearray()
    obj.first_nonzero_frame=None
    obj.transitions=[]
    obj.last_active=None
    obj.errors=[]
    obj.starvations=0
    obj.started_ns=10
    obj.stopped_ns=100
    obj.closed=True
    return obj


class CaptureTests(unittest.TestCase):
    def test_pcm_hash_statistics_and_excerpt_are_bounded(self):
        obj=synthetic()
        raw=array("h",[100,-200]*capture.RATE*3).tobytes()
        obj.consume(raw,50)
        self.assertEqual(obj.frames,capture.RATE*3)
        self.assertEqual(obj.nonzero_samples,capture.RATE*6)
        self.assertEqual(obj.hash.hexdigest(),hashlib.sha256(raw).hexdigest())
        self.assertEqual(len(obj.excerpt),capture.RATE*capture.CHANNELS*capture.WIDTH*2)
        with tempfile.TemporaryDirectory() as folder:
            report=obj.report(folder)
            with wave.open(str(Path(folder)/"virtual-capture-excerpt.wav")) as wav:
                self.assertEqual(wav.getnframes(),capture.RATE*2)
        self.assertFalse(report["physical_audio_verified"])
        self.assertFalse(report["cancel_to_capture_silence_verified"])
        self.assertFalse(report["requested_phrase_waveform_match_verified"])
        self.assertEqual(report["capture_identity_scope"],"nonzero request-span overlap only")

    def test_incomplete_stereo_frame_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError,"complete PCM"):
            synthetic().consume(b"\0\0",10)

    def test_fifo_wrap_uses_native_queue_order_not_header_index(self):
        obj=synthetic()
        obj.stop=threading.Event()
        obj.buffers=[C.create_string_buffer(array("h",[i,i]).tobytes(),4) for i in range(4)]
        obj.headers=[capture.Header(None,4,4,0,1,0,None,0) for _ in range(4)]
        obj.queue=deque([2,3,0,1])
        obj.handle=None
        received=[]
        obj.consume=lambda raw,ns:received.append(array("h",raw)[0])
        def add(handle,pointer,size):
            pointer._obj.flags=0
            if len(received)==4:obj.stop.set()
            return 0
        obj.add=add
        obj.worker()
        self.assertEqual(received,[2,3,0,1])
        self.assertEqual(obj.errors,[])

    def test_nonzero_before_requests_is_not_enough_for_overlap(self):
        document={"activity_transitions":[{"active":True,"observed_perf_counter_ns":10},
                    {"active":False,"observed_perf_counter_ns":20}],"capture_stopped_perf_counter_ns":100}
        events=[{"speak_started_ns":50,"observed_return_ns":80}]
        self.assertEqual(capture.capture_request_overlap(document,events)["overlapping_active_intervals"],0)
        document["activity_transitions"].append({"active":True,"observed_perf_counter_ns":60})
        result=capture.capture_request_overlap(document,events)
        self.assertEqual(result["overlapping_active_intervals"],1)
        self.assertFalse(result["cross_process_clock_calibrated"])


    def test_continuous_done_requeue_stops_before_another_native_add(self):
        obj=synthetic()
        obj.stop=threading.Event()
        obj.buffers=[C.create_string_buffer(array("h",[1,1]).tobytes(),4)]
        obj.headers=[capture.Header(None,4,4,0,1,0,None,0)]
        obj.queue=deque([0])
        obj.handle=None
        calls=[]
        obj.consume=lambda raw,ns:None
        def immediate_done(handle,pointer,size):
            calls.append(1)
            if len(calls)==2:obj.stop.set()
            if len(calls)>2:raise AssertionError("Native requeue happened after stop")
            pointer._obj.flags=1
            return 0
        obj.add=immediate_done
        obj.worker()
        self.assertEqual(len(calls),2)
        self.assertEqual(obj.errors,[])

    def test_stop_during_consumption_does_not_requeue(self):
        obj=synthetic()
        obj.stop=threading.Event()
        obj.buffers=[C.create_string_buffer(array("h",[1,1]).tobytes(),4)]
        obj.headers=[capture.Header(None,4,4,0,1,0,None,0)]
        obj.queue=deque([0])
        obj.handle=None
        obj.consume=lambda raw,ns:obj.stop.set()
        def forbidden(*args):raise AssertionError("Cannot queue after a stop request")
        obj.add=forbidden
        obj.worker()
        self.assertEqual(obj.errors,[])


class ProbeObserverTests(unittest.TestCase):
    def test_real_plugin_parses_and_observer_does_not_add_audio_calls(self):
        original=real_probe.PROBE_PLUGIN
        revised=observer.instrument(original)
        def audio_calls(source):
            return [ast.unparse(node.func) for node in ast.walk(ast.parse(source)) if isinstance(node,ast.Call)
                    and ast.unparse(node.func) in ("DRIVER.speak","DRIVER.cancel","ORIGINAL_FEED","ORIGINAL_PLAY")]
        self.assertEqual(audio_calls(original),audio_calls(revised))
        self.assertIn('output["request_events"].append',revised)
        self.assertIn('output["cancel_events"].append',revised)
        self.assertNotIn("headless",observer.__doc__.lower())

    def test_changed_probe_anchors_fail_closed(self):
        with self.assertRaisesRegex(ValueError,"anchor changed"):
            observer.instrument(real_probe.PROBE_PLUGIN.replace('"timeouts": [], "errors": []}',"changed",1))


if __name__=="__main__":
    unittest.main()
