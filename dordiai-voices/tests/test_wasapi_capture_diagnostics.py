import ctypes as C
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

spec=importlib.util.spec_from_file_location("wasapi_tested",Path(__file__).resolve().parents[1]/"tools/wasapi_capture_diagnostics.py")
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Contracts(unittest.TestCase):
    def test_native_x64_layout_and_guid_byteorder(self):
        self.assertEqual(C.sizeof(m.GUID),16)
        self.assertEqual(C.sizeof(m.PropertyKey),20)
        self.assertEqual(C.sizeof(m.PropVariant),24)
        self.assertEqual(C.sizeof(m.WaveFormat),18)
        self.assertEqual(bytes(m.GUID.parse("1cb9ad4c-dbfa-4c32-b178-c2f568a703b2").data).hex(),
                         "4cadb91cfadb324cb178c2f568a703b2")

    def test_only_exact_or_documented_31char_vendor_name_match(self):
        full="CABLE Output (VB-Audio Virtual Cable)"
        self.assertTrue(m.selected_name(full,full))
        self.assertTrue(m.selected_name(full,full[:31]))
        self.assertFalse(m.selected_name(full,full[:20]))
        self.assertFalse(m.selected_name("Other microphone","Other microphone"))
        self.assertFalse(m.selected_name("CABLE Output (Other Vendor)","CABLE Output (Other Vendor)"))

    def test_hresult_retains_original_signed_bitpattern(self):
        self.assertEqual(m.hex_hr(-2147024891),"0x80070005")
        self.assertEqual(m.hex_hr(0),"0x00000000")

    def test_owned_ci_guard_requires_all_six_actual_failures(self):
        with tempfile.TemporaryDirectory() as tmp:
            args=SimpleNamespace(owned_instance_id="ROOT\\DORDIAI_VBCABLE_"+32*"A"+"\\0000",
                all_six_mme_opens_failed=True,capture_name="CABLE Output (VB-Audio Virtual Cable)",
                output=Path(tmp)/"diag-123"/"wasapi.json")
            env={"GITHUB_ACTIONS":"true","RUNNER_ENVIRONMENT":"github-hosted","GITHUB_REPOSITORY":m.REPOSITORY,
                 "RUNNER_ARCH":"X64","GITHUB_RUN_ID":"123","RUNNER_TEMP":tmp}
            m.guard(args,env,"nt")
            args.all_six_mme_opens_failed=False
            with self.assertRaisesRegex(RuntimeError,"six"):m.guard(args,env,"nt")
            args.all_six_mme_opens_failed=True;env["RUNNER_ENVIRONMENT"]="self-hosted"
            with self.assertRaises(RuntimeError):m.guard(args,env,"nt")

class FakeWasapi(m.Wasapi):
    def __init__(self,initialize=-2147024891):
        self.initialization=initialize;self.calls=[];self.freed=[];self.released=[];self.uninitialized=False
        self.format=m.WaveFormat(3,2,48000,384000,8,32,0)
        owner=self
        class Ole:
            def CoInitializeEx(self,*args):return 0
            def CoCreateInstance(self,clsid,outer,context,iid,out):
                C.cast(out,C.POINTER(C.c_void_p))[0]=C.c_void_p(1)
                return 0
            def CoTaskMemFree(self,pointer):owner.freed.append(pointer.value)
            def CoUninitialize(self):owner.uninitialized=True
        self.ole=Ole()
    def release(self,pointer):
        if pointer.value:self.released.append(pointer.value);pointer.value=None
    def identify(self,pointer):
        return "actual-endpoint-id","CABLE Output (VB-Audio Virtual Cable)"
    def invoke(self,pointer,index,args,*values):
        self.calls.append((pointer.value,index))
        if pointer.value==1 and index==3:
            C.cast(values[-1],C.POINTER(C.c_void_p))[0]=C.c_void_p(2)
        elif pointer.value==2 and index==3:
            C.cast(values[-1],C.POINTER(C.c_uint))[0]=1
        elif pointer.value==2 and index==4:
            C.cast(values[-1],C.POINTER(C.c_void_p))[0]=C.c_void_p(3)
        elif pointer.value==1 and index==5:
            C.cast(values[-1],C.POINTER(C.c_void_p))[0]=C.c_void_p(4)
        elif pointer.value==4 and index==3:
            C.cast(values[-1],C.POINTER(C.c_void_p))[0]=C.c_void_p(5)
        elif pointer.value==5 and index==8:
            C.cast(values[-1],C.POINTER(C.c_void_p))[0]=C.cast(C.pointer(self.format),C.c_void_p)
        elif pointer.value==5 and index==3:
            return self.initialization
        elif pointer.value==5 and index==4:
            C.cast(values[-1],C.POINTER(C.c_uint))[0]=480
        return 0

class Lifecycle(unittest.TestCase):
    def test_access_denied_is_recorded_without_start_or_capture_claim(self):
        fake=FakeWasapi();report=fake.diagnose("CABLE Output (VB-Audio Virtual Cable)")
        self.assertEqual(report["IAudioClient_Initialize_shared_mix"],"0x80070005")
        self.assertFalse(report["initialize_succeeded"])
        self.assertTrue(report["com_interfaces_released"])
        self.assertTrue(fake.uninitialized)
        self.assertEqual(fake.released,[3,5,4,2,1])
        self.assertNotIn((5,10),fake.calls) # IAudioClient.Start
        self.assertNotIn((5,14),fake.calls) # IAudioClient.GetService
        self.assertFalse(report["pcm_read"]);self.assertFalse(report["virtual_audio_verified"])

    def test_success_is_initialization_only_and_releases_exact_mix_allocation(self):
        fake=FakeWasapi(0);report=fake.diagnose("CABLE Output (VB-Audio Virtual Cable)")
        self.assertTrue(report["initialize_succeeded"])
        self.assertEqual(report["buffer_frames"],480)
        self.assertEqual(len(fake.freed),1)
        self.assertTrue(report["com_interfaces_released"])
        self.assertFalse(report["capture_started"])

    def test_activation_failure_still_reports_actual_cleanup(self):
        fake=FakeWasapi()
        original=fake.invoke
        def invoke(pointer,index,args,*values):
            if pointer.value==4 and index==3:return -2147024891
            return original(pointer,index,args,*values)
        fake.invoke=invoke
        report=fake.diagnose("CABLE Output (VB-Audio Virtual Cable)")
        self.assertEqual(report["status"],"diagnosed-activation-error")
        self.assertEqual(report["IMMDevice_Activate_IAudioClient"],"0x80070005")
        self.assertTrue(report["com_interfaces_released"])
        self.assertTrue(fake.uninitialized)

if __name__=="__main__":unittest.main()
