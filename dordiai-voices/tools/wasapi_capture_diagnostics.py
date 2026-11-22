"""Owned-CI WASAPI capture initialization diagnostics only.

Uses the existing default shared mix format. Never starts recording, reads PCM,
alters microphone policy, changes formats/defaults, restarts services or installs
anything. Run as a separately watchdog-bounded subprocess inside the parent's
verified owned-device lease, only after all six MME actual opens have failed.
"""
from __future__ import annotations
import argparse
import ctypes as C
import json
import os
from pathlib import Path
import re
import struct
import uuid

REPOSITORY="Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension"
DWORD=C.c_uint32
HRESULT=C.c_int32
ULONG=C.c_uint32

class GUID(C.Structure):
    _fields_=[("data",C.c_ubyte*16)]
    @classmethod
    def parse(cls,value):
        return cls.from_buffer_copy(uuid.UUID(value).bytes_le)

class PropertyKey(C.Structure):
    _fields_=[("fmtid",GUID),("pid",DWORD)]

class VariantValue(C.Union):
    _fields_=[("pointer",C.c_void_p),("storage",C.c_ubyte*16)]

class PropVariant(C.Structure):
    _fields_=[("vt",C.c_uint16),("reserved1",C.c_uint16),
              ("reserved2",C.c_uint16),("reserved3",C.c_uint16),("value",VariantValue)]

class WaveFormat(C.Structure):
    _pack_=1
    _fields_=[("tag",C.c_uint16),("channels",C.c_uint16),("rate",DWORD),
              ("average",DWORD),("alignment",C.c_uint16),("bits",C.c_uint16),("extra",C.c_uint16)]

def hex_hr(value):
    return "0x%08X"%(int(value)&0xffffffff)

def selected_name(full,observed):
    # MME legacy device names have a maximum of31visible UTF16 units. The
    # vendor's selected ASCII name is either exact or that precise truncation.
    return (isinstance(full,str) and isinstance(observed,str)
            and full.startswith("CABLE Output") and "VB-Audio" in full
            and (full==observed or (len(observed)==31 and full[:31]==observed)))

def guard(args,environ=os.environ,platform_name=os.name):
    if (platform_name!="nt" or struct.calcsize("P")!=8
            or environ.get("GITHUB_ACTIONS")!="true" or environ.get("RUNNER_ENVIRONMENT")!="github-hosted"
            or environ.get("GITHUB_REPOSITORY")!=REPOSITORY or environ.get("RUNNER_ARCH")!="X64"
            or not environ.get("GITHUB_RUN_ID","").isdigit() or not environ.get("RUNNER_TEMP")):
        raise RuntimeError("Only this repository's owned ephemeral x64 Windows CI is allowed")
    if not re.fullmatch(r"ROOT\\DORDIAI_VBCABLE_[0-9A-F]{32}\\[0-9A-F]+",args.owned_instance_id.upper()):
        raise RuntimeError("Exact uniquely owned temporary PnP instance required")
    if not args.all_six_mme_opens_failed:
        raise RuntimeError("Parent must attest all six bounded actual MME opens failed")
    root=Path(environ["RUNNER_TEMP"]).resolve()
    output=args.output.absolute()
    if output.exists() or output.is_symlink() or not output.resolve().is_relative_to(root):
        raise RuntimeError("Fresh owned RUNNER_TEMP report required")
    if environ["GITHUB_RUN_ID"] not in str(output.relative_to(root)):
        raise RuntimeError("Output must bind current CI run")
    for parent in output.parents:
        if parent.is_symlink() or getattr(parent,"is_junction",lambda:False)():
            raise RuntimeError("Linked report parent is forbidden")
    if not selected_name(args.capture_name,args.capture_name):
        raise RuntimeError("Explicit actually observed vendor capture name required")

class Wasapi:
    def __init__(self):
        if C.sizeof(GUID)!=16 or C.sizeof(PropertyKey)!=20 or C.sizeof(PropVariant)!=24 or C.sizeof(WaveFormat)!=18:
            raise RuntimeError("Unexpected Windows x64 COM/format ABI")
        self.ole=C.WinDLL("ole32")
        self.ole.CoInitializeEx.argtypes=[C.c_void_p,DWORD];self.ole.CoInitializeEx.restype=HRESULT
        self.ole.CoUninitialize.argtypes=[];self.ole.CoUninitialize.restype=None
        self.ole.CoCreateInstance.argtypes=[C.POINTER(GUID),C.c_void_p,DWORD,C.POINTER(GUID),C.POINTER(C.c_void_p)]
        self.ole.CoCreateInstance.restype=HRESULT
        self.ole.CoTaskMemFree.argtypes=[C.c_void_p];self.ole.CoTaskMemFree.restype=None
        self.ole.PropVariantClear.argtypes=[C.POINTER(PropVariant)];self.ole.PropVariantClear.restype=HRESULT

    @staticmethod
    def method(pointer,index,result,args):
        if not pointer.value:raise RuntimeError("Missing COM interface")
        address=C.cast(pointer,C.POINTER(C.POINTER(C.c_void_p))).contents[index]
        return C.WINFUNCTYPE(result,C.c_void_p,*args)(address)

    def invoke(self,pointer,index,args,*values):
        return int(self.method(pointer,index,HRESULT,args)(pointer,*values))

    def release(self,pointer):
        if pointer.value:
            self.method(pointer,2,ULONG,[])(pointer)
            pointer.value=None

    @staticmethod
    def require(hr,operation):
        if hr<0:raise RuntimeError(operation+" failed "+hex_hr(hr))

    def identify(self,device):
        value=C.c_void_p()
        try:
            self.require(self.invoke(device,5,[C.POINTER(C.c_void_p)],C.byref(value)),"IMMDevice.GetId")
            if not value.value:raise RuntimeError("Endpoint returned no identifier")
            identifier=C.wstring_at(value.value)
        finally:
            if value.value:self.ole.CoTaskMemFree(value)
        properties=C.c_void_p();variant=PropVariant()
        try:
            self.require(self.invoke(device,4,[DWORD,C.POINTER(C.c_void_p)],0,C.byref(properties)),"IMMDevice.OpenPropertyStore")
            key=PropertyKey(GUID.parse("a45c254e-df1c-4efd-8020-67d146a850e0"),14)
            self.require(self.invoke(properties,5,[C.POINTER(PropertyKey),C.POINTER(PropVariant)],C.byref(key),C.byref(variant)),"IPropertyStore.GetValue friendly name")
            if variant.vt!=31 or not variant.value.pointer:
                raise RuntimeError("Friendly name is not native LPWSTR")
            name=C.wstring_at(variant.value.pointer)
            return identifier,name
        finally:
            self.ole.PropVariantClear(C.byref(variant))
            self.release(properties)

    def diagnose(self,observed_name):
        enumerator,collection,target,client=[C.c_void_p() for unused in range(4)]
        mix=C.c_void_p();closest=C.c_void_p();initialized=False
        report={"format":"dordiai-owned-wasapi-capture-initialization","format_version":1,
                "status":"running","capture_started":False,"pcm_read":False,"physical_audio_verified":False,
                "wave_player_verified":False,"virtual_audio_verified":False,"privacy_settings_changed":False,
                "service_restart_performed":False,"format_changed":False,"default_device_changed":False,
                "scope":"Exact owned vendor capture endpoint initialization HRESULTs only, not capture/playback proof",
                "endpoints":[]}
        init=int(self.ole.CoInitializeEx(None,2)) # Fresh diagnostic subprocess STA.
        report["CoInitializeEx_STA"]=hex_hr(init)
        if init<0:
            report.update(status="diagnosed-com-initialization-error",com_interfaces_released=True,no_stream_start_or_pcm_capture=True)
            return report
        try:
            self.require(int(self.ole.CoCreateInstance(C.byref(GUID.parse("bcde0395-e52f-467c-8e3d-c4579291692e")),
                None,1,C.byref(GUID.parse("a95664d2-9614-4f35-a746-de8db63617e6")),C.byref(enumerator))),"Create MMDeviceEnumerator")
            # eCapture=1, DEVICE_STATE_ACTIVE=1.
            self.require(self.invoke(enumerator,3,[C.c_int,DWORD,C.POINTER(C.c_void_p)],1,1,C.byref(collection)),"Enumerate active capture endpoints")
            count=C.c_uint()
            self.require(self.invoke(collection,3,[C.POINTER(C.c_uint)],C.byref(count)),"Get capture count")
            if count.value>32:raise RuntimeError("Unexpected unbounded endpoint inventory")
            candidates=[]
            for index in range(count.value):
                endpoint=C.c_void_p()
                try:
                    self.require(self.invoke(collection,4,[C.c_uint,C.POINTER(C.c_void_p)],index,C.byref(endpoint)),"Get capture endpoint")
                    identifier,name=self.identify(endpoint)
                    row={"id":identifier,"name":name,"matches_observed_vendor_name":selected_name(name,observed_name)}
                    report["endpoints"].append(row)
                    if row["matches_observed_vendor_name"]:candidates.append(row)
                finally:self.release(endpoint)
            if len(candidates)!=1:raise RuntimeError("Observed vendor capture name is absent or ambiguous in CoreAudio")
            report["selected_endpoint"]=candidates[0]
            self.require(self.invoke(enumerator,5,[C.c_wchar_p,C.POINTER(C.c_void_p)],candidates[0]["id"],C.byref(target)),"Resolve exact selected endpoint")
            iid=GUID.parse("1cb9ad4c-dbfa-4c32-b178-c2f568a703b2")
            hr=self.invoke(target,3,[C.POINTER(GUID),DWORD,C.c_void_p,C.POINTER(C.c_void_p)],C.byref(iid),1,None,C.byref(client))
            report["IMMDevice_Activate_IAudioClient"]=hex_hr(hr)
            if hr<0:
                report["status"]="diagnosed-activation-error"
                return report
            hr=self.invoke(client,8,[C.POINTER(C.c_void_p)],C.byref(mix))
            report["IAudioClient_GetMixFormat"]=hex_hr(hr)
            if hr<0:
                report["status"]="diagnosed-mix-format-error"
                return report
            if not mix.value:raise RuntimeError("Successful mix-format call returned no format")
            fmt=C.cast(mix,C.POINTER(WaveFormat)).contents
            if fmt.extra>512:raise RuntimeError("Unexpectedly large native mix-format extension")
            report["mix_format"]={key:int(getattr(fmt,key)) for key in ("tag","channels","rate","average","alignment","bits","extra")}
            report["mix_format"]["raw_hex"]=C.string_at(mix,18+fmt.extra).hex()
            # AUDCLNT_SHAREMODE_SHARED=0. A closest-format allocation must always
            # be freed, even when HRESULT reports S_FALSE rather than failure.
            hr=self.invoke(client,7,[C.c_int,C.c_void_p,C.POINTER(C.c_void_p)],0,mix,C.byref(closest))
            report["IAudioClient_IsFormatSupported_shared_mix"]=hex_hr(hr)
            report["closest_format_returned"]=bool(closest.value)
            if closest.value:self.ole.CoTaskMemFree(closest);closest.value=None
            # Use exact engine-owned shared mix format, not a guessed PCM override.
            # Never Start/GetService/Read; release closes the initialized stream.
            hr=self.invoke(client,3,[C.c_int,DWORD,C.c_int64,C.c_int64,C.c_void_p,C.c_void_p],0,0,0,0,mix,None)
            report["IAudioClient_Initialize_shared_mix"]=hex_hr(hr)
            initialized=hr>=0
            report["initialize_succeeded"]=initialized
            if initialized:
                size=C.c_uint()
                size_hr=self.invoke(client,4,[C.POINTER(C.c_uint)],C.byref(size))
                report["IAudioClient_GetBufferSize"]=hex_hr(size_hr)
                if size_hr>=0:report["buffer_frames"]=int(size.value)
            report["status"]="diagnosed-initialization-success-no-capture" if initialized else "diagnosed-initialization-error"
            return report
        except Exception as error:
            report.update(status="diagnostic-error",error=type(error).__name__+": "+str(error))
            return report
        finally:
            if closest.value:self.ole.CoTaskMemFree(closest)
            if mix.value:self.ole.CoTaskMemFree(mix)
            self.release(client);self.release(target);self.release(collection);self.release(enumerator)
            self.ole.CoUninitialize()
            report["com_interfaces_released"]=True
            report["no_stream_start_or_pcm_capture"]=True

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-name",required=True)
    parser.add_argument("--owned-instance-id",required=True)
    parser.add_argument("--all-six-mme-opens-failed",action="store_true")
    parser.add_argument("--output",required=True,type=Path)
    args=parser.parse_args(argv);guard(args)
    import windows_virtual_audio_trial as device
    pnp=device.WindowsPnP()
    if pnp.matching()!=[args.owned_instance_id] or not pnp.instance_exists(args.owned_instance_id):
        raise RuntimeError("Verified parent's unique owned vendor device lease is not live")
    report=Wasapi().diagnose(args.capture_name)
    report["owned_instance_id"]=args.owned_instance_id
    report["all_six_mme_opens_failed"]=True
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with args.output.open("x",encoding="utf-8") as output:
        json.dump(report,output,indent=2)
        output.write("\n")
    print("WASAPI_CAPTURE_INITIALIZATION "+json.dumps(report,ensure_ascii=True),flush=True)
    return 0

if __name__=="__main__":raise SystemExit(main())
