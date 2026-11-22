import ctypes as C
import importlib.util
from pathlib import Path
import struct
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

TOOLS=Path(__file__).resolve().parents[1]/"tools"
sys.path.insert(0,str(TOOLS))
spec=importlib.util.spec_from_file_location("loopback_tested",TOOLS/"wasapi_loopback_calibration.py")
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def format_bytes(tag=3,channels=2,rate=48000,bits=32,subtype=None):
    align=channels*(bits//8)
    if subtype:
        return struct.pack("<HHIIHHHHI",0xfffe,channels,rate,rate*align,align,bits,22,bits,3)+uuid.UUID(subtype).bytes_le
    return struct.pack("<HHIIHHH",tag,channels,rate,rate*align,align,bits,0)

class FormatAndIdentity(unittest.TestCase):
    def test_actual_observed_31char_mme_names_pass_guard_but_unrelated_do_not(self):
        for name in ("Speakers (VB-Audio Virtual Cable)","CABLE Input (VB-Audio Virtual Cable)"):
            self.assertTrue(m.observed_render_name(name))
            self.assertTrue(m.observed_render_name(name[:31]))
            self.assertTrue(m.selected_render_name(name,name[:31]))
            self.assertFalse(m.selected_render_name(name,name[:20]))
        self.assertFalse(m.observed_render_name("Other speakers"))
        self.assertFalse(m.observed_render_name("CABLE Output (VB-Audio Virtual C"))
        self.assertFalse(m.selected_render_name("Other speakers","Other speakers"))

    def test_native_standard_and_extensible_formats_keep_exact_bytes(self):
        for tag,bits,sub,encoding in (
            (3,32,None,"float32le"),(1,16,None,"pcm16le"),
            (3,32,"00000003-0000-0010-8000-00aa00389b71","float32le"),
            (1,16,"00000001-0000-0010-8000-00aa00389b71","pcm16le")):
            raw=format_bytes(tag=tag,bits=bits,subtype=sub)
            result=m.describe_format(raw)
            self.assertEqual(result["native_encoding"],encoding)
            self.assertEqual(result["raw_format_hex"],raw.hex())
            self.assertEqual(result["channels"],2)

    def test_unsupported_format_is_rejected_without_conversion(self):
        for raw in (b"",format_bytes(channels=1),format_bytes(bits=24),
                    format_bytes(subtype="00000002-0000-0010-8000-00aa00389b71")):
            with self.assertRaises(ValueError):m.describe_format(raw)

    def test_marker_exact_duration_deterministic_nonzero_and_opposite_stereo(self):
        for tag,bits,code in ((3,32,"f"),(1,16,"h")):
            fmt=m.describe_format(format_bytes(tag=tag,bits=bits))
            first=m.known_marker(fmt);second=m.known_marker(fmt)
            self.assertEqual(first,second)
            self.assertEqual(len(first),48000*2*(bits//8))
            values=m.array(code);values.frombytes(first)
            self.assertTrue(any(values))
            for i in range(100,200,2):
                self.assertAlmostEqual(values[i+1],-.75*values[i],delta=1. if code=="h" else 1e-7)
            # This is PRBS-modulated, not a repeating pure sine calibration tone.
            self.assertNotEqual(first[4000:5000],first[8000:9000])

class FakeLoop(m.LoopbackCalibration):
    def __init__(self):
        self.calls_report=[];self.call_counts={};self.calls=[]
        self.buffer=C.create_string_buffer(128);self.capture_data=C.create_string_buffer(b"abcdefgh"*8)
        self.capture_frames=4;self.capture_flags=0;self.capture_null=False
    def invoke(self,pointer,index,args,*values):
        self.calls.append((pointer.value,index,values))
        if pointer.value==100 and index==3:
            C.cast(values[-1],C.POINTER(C.c_void_p))[0]=C.cast(self.buffer,C.c_void_p)
        elif pointer.value==200 and index==5:
            C.cast(values[-1],C.POINTER(C.c_uint))[0]=self.capture_frames
        elif pointer.value==200 and index==3:
            C.cast(values[0],C.POINTER(C.c_void_p))[0]=C.c_void_p() if self.capture_null else C.cast(self.capture_data,C.c_void_p)
            C.cast(values[1],C.POINTER(C.c_uint))[0]=self.capture_frames
            C.cast(values[2],C.POINTER(m.DWORD))[0]=self.capture_flags
            C.cast(values[3],C.POINTER(C.c_uint64))[0]=960
            C.cast(values[4],C.POINTER(C.c_uint64))[0]=1234567
        return 0

class BufferOwnership(unittest.TestCase):
    def test_render_tail_zero_filled_and_native_buffer_released(self):
        fake=FakeLoop()
        offset=fake.feed(C.c_void_p(100),4,b"abcdefgh",0,4)
        self.assertEqual(offset,8)
        self.assertEqual(fake.buffer.raw[:16],b"abcdefgh"+bytes(8))
        release=[row for row in fake.calls if row[:2]==(100,4)]
        self.assertEqual(release[0][2],(4,0))

    def test_host_render_copy_failure_releases_silent_buffer(self):
        fake=FakeLoop()
        with patch.object(m.C,"memmove",side_effect=ValueError("host copy failed")):
            with self.assertRaisesRegex(ValueError,"host copy failed"):
                fake.feed(C.c_void_p(100),4,b"abcdefgh",0,4)
        release=[row for row in fake.calls if row[:2]==(100,4)]
        self.assertEqual(release[0][2],(4,m.SILENT))

    def test_capture_packet_trim_and_native_qpc_units_preserved(self):
        fake=FakeLoop()
        raw,packet=fake.drain(C.c_void_p(200),2,4)
        self.assertEqual(raw,b"abcdefgh")
        self.assertEqual(packet["frames"],4)
        self.assertEqual(packet["retained_frames"],2)
        self.assertEqual(packet["discarded_tail_frames"],2)
        self.assertEqual(packet["qpc_position_100ns"],1234567)
        release=[row for row in fake.calls if row[:2]==(200,4)]
        self.assertEqual(release[0][2],(4,))

    def test_silent_packet_never_reads_null_data_pointer(self):
        fake=FakeLoop();fake.capture_flags=m.SILENT|1|4;fake.capture_null=True
        raw,packet=fake.drain(C.c_void_p(200),4,4)
        self.assertEqual(raw,bytes(16))
        self.assertTrue(packet["silent"]);self.assertTrue(packet["discontinuity"]);self.assertTrue(packet["timestamp_error"])

    def test_invalid_capture_pointer_still_releases_acquired_packet(self):
        fake=FakeLoop();fake.capture_null=True
        with self.assertRaisesRegex(RuntimeError,"pointer missing"):fake.drain(C.c_void_p(200),4,4)
        self.assertTrue(any(row[:2]==(200,4) for row in fake.calls))

    def test_empty_packet_does_not_release_unacquired_buffer(self):
        fake=FakeLoop();fake.capture_frames=0
        self.assertIsNone(fake.drain(C.c_void_p(200),4,4))
        self.assertFalse(any(row[:2]==(200,4) for row in fake.calls))

if __name__=="__main__":unittest.main()
