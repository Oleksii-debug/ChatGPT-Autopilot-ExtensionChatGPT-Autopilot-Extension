"""Bounded owned-render WASAPI loopback calibration; no microphone capture.

Only the parent's exact uniquely owned vendor endpoint is selected. Uses native
shared mix format, one second of deterministic own marker, at most three seconds
of loopback data; never alters privacy/default-device/driver/security settings.
Technical capture is separate from correlation acceptance and physical audio.
"""
from __future__ import annotations
import argparse
from array import array
import ctypes as C
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import time
import uuid
from wasapi_capture_diagnostics import Wasapi,GUID,WaveFormat,HRESULT,DWORD,hex_hr

REPOSITORY="Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension"
LOOPBACK=0x00020000
SILENT=2
IID_AUDIO="1cb9ad4c-dbfa-4c32-b178-c2f568a703b2"
IID_CAPTURE="c8adbd64-e71e-48a0-a4de-185c395cd317"
IID_RENDER="f294acfc-3146-4483-a7bf-addca7c260e2"
BUFFER_EMPTY=0x08890001
CAPTURE_SECONDS=3.
MARKER_SECONDS=1.

def selected_render_name(full,observed):
    return (isinstance(full,str) and isinstance(observed,str)
            and full.startswith(("Speakers (VB-Audio Virtual Cable","CABLE Input (VB-Audio Virtual Cable"))
            and (full==observed or (len(observed)==31 and full[:31]==observed)))

def observed_render_name(name):
    full_names=("Speakers (VB-Audio Virtual Cable)","CABLE Input (VB-Audio Virtual Cable)")
    return name in full_names or name in tuple(value[:31] for value in full_names)

def guard(args,environ=os.environ,platform_name=os.name):
    if (platform_name!="nt" or struct.calcsize("P")!=8 or sys.byteorder!="little"
            or environ.get("GITHUB_ACTIONS")!="true" or environ.get("RUNNER_ENVIRONMENT")!="github-hosted"
            or environ.get("GITHUB_REPOSITORY")!=REPOSITORY or environ.get("RUNNER_ARCH")!="X64"
            or not environ.get("GITHUB_RUN_ID","").isdigit() or not environ.get("RUNNER_TEMP")):
        raise RuntimeError("Only this repository's owned ephemeral Windows x64 CI is allowed")
    if not re.fullmatch(r"ROOT\\DORDIAI_VBCABLE_[0-9A-F]{32}\\[0-9A-F]+",args.owned_instance_id.upper()):
        raise RuntimeError("Exact uniquely owned PnP instance required")
    if not observed_render_name(args.render_name):
        raise RuntimeError("Explicit actual vendor render endpoint name required")
    root=Path(environ["RUNNER_TEMP"]).resolve();output=args.output.absolute()
    if output.exists() or output.is_symlink() or not output.resolve().is_relative_to(root):
        raise RuntimeError("Fresh owned temporary output required")
    if environ["GITHUB_RUN_ID"] not in str(output.resolve().relative_to(root)):
        raise RuntimeError("Output must bind current CI run")
    for parent in output.parents:
        if parent.is_symlink() or getattr(parent,"is_junction",lambda:False)():
            raise RuntimeError("Linked evidence roots forbidden")

def describe_format(raw):
    if len(raw)<18:raise ValueError("Truncated native mix format")
    tag,channels,rate,average,alignment,bits,extra=struct.unpack_from("<HHIIHHH",raw)
    if len(raw)!=18+extra or extra>512 or channels!=2 or not 8000<=rate<=192000:
        raise ValueError("Expected bounded two-channel native render mix")
    native_tag=tag
    if tag==0xfffe:
        if extra<22:raise ValueError("Truncated native extensible format")
        valid=struct.unpack_from("<H",raw,18)[0]
        subtype=raw[24:40]
        if subtype==uuid.UUID("00000003-0000-0010-8000-00aa00389b71").bytes_le:native_tag=3
        elif subtype==uuid.UUID("00000001-0000-0010-8000-00aa00389b71").bytes_le:native_tag=1
        else:raise ValueError("Unsupported native extensible subtype; no format change attempted")
        if valid not in (0,bits):raise ValueError("Native valid bits do not match container")
    encoding="float32le" if native_tag==3 and bits==32 else "pcm16le" if native_tag==1 and bits==16 else None
    if encoding is None or alignment!=channels*(bits//8) or average!=rate*alignment:
        raise ValueError("Only unmodified native float32 or PCM16 is supported")
    return {"format_tag":tag,"channels":channels,"sample_rate":rate,"average_bytes_per_second":average,
            "block_align":alignment,"bits_per_sample":bits,"extra_bytes":extra,
            "native_encoding":encoding,"raw_format_hex":raw.hex()}

def known_marker(format):
    rate=format["sample_rate"]
    result=array("f" if format["native_encoding"]=="float32le" else "h")
    if result.itemsize!=format["bits_per_sample"]//8:raise ValueError("Native array width differs")
    state=0x6d2b79f5;sign=1.
    for index in range(int(rate*MARKER_SECONDS)):
        if index%12==0:
            state^=(state<<13)&0xffffffff;state^=state>>17;state^=(state<<5)&0xffffffff;state&=0xffffffff
            sign=1. if state&1 else -1.
        fade=min(1.,index/(rate*.005),(rate-1-index)/(rate*.005))
        value=.12*sign*math.sin(2*math.pi*997*index/rate)*max(0.,fade)
        for sample in (value,-.75*value):
            result.append(sample if result.typecode=="f" else int(round(sample*32767)))
    return result.tobytes()

def publish_raw(path,raw):
    with path.open("xb") as output:output.write(raw)
    return {"filename":path.name,"size_bytes":len(raw),"sha256":sha256(raw).hexdigest()}

class LoopbackCalibration(Wasapi):
    def __init__(self):
        super().__init__();self.calls_report=[];self.call_counts={}

    def hr(self,pointer,index,args,operation,*values):
        value=self.invoke(pointer,index,args,*values)
        self.call_counts[operation]=self.call_counts.get(operation,0)+1
        if len(self.calls_report)<256:
            self.calls_report.append({"operation":operation,"hresult":hex_hr(value)})
        self.require(value,operation)
        return value

    def service(self,client,iid,out,operation):
        guid=GUID.parse(iid)
        self.hr(client,14,[C.POINTER(GUID),C.POINTER(C.c_void_p)],operation,C.byref(guid),C.byref(out))

    def native_format(self,client):
        allocated=C.c_void_p()
        try:
            self.hr(client,8,[C.POINTER(C.c_void_p)],"IAudioClient.GetMixFormat",C.byref(allocated))
            if not allocated.value:raise RuntimeError("Missing native mix-format pointer")
            fmt=C.cast(allocated,C.POINTER(WaveFormat)).contents
            if fmt.extra>512:raise ValueError("Native mix-format extension exceeds bound")
            raw=C.string_at(allocated,18+fmt.extra)
            return raw,describe_format(raw)
        finally:
            if allocated.value:self.ole.CoTaskMemFree(allocated)

    def activate(self,device,out,operation):
        guid=GUID.parse(IID_AUDIO)
        self.hr(device,3,[C.POINTER(GUID),DWORD,C.c_void_p,C.POINTER(C.c_void_p)],operation,
                C.byref(guid),1,None,C.byref(out))

    def initialize(self,client,raw,flags,operation):
        memory=C.create_string_buffer(raw)
        self.hr(client,3,[C.c_int,DWORD,C.c_int64,C.c_int64,C.c_void_p,C.c_void_p],
                operation,0,flags,0,0,C.cast(memory,C.c_void_p),None)

    def feed(self,render,frames,reference,offset,align):
        pointer=C.c_void_p()
        self.hr(render,3,[C.c_uint,C.POINTER(C.c_void_p)],"IAudioRenderClient.GetBuffer",frames,C.byref(pointer))
        filled=False
        try:
            if not pointer.value:raise RuntimeError("Native render buffer missing")
            remaining=max(0,len(reference)-offset)
            amount=min(frames*align,remaining)
            raw=reference[offset:offset+amount]+bytes(frames*align-amount)
            C.memmove(pointer,raw,len(raw));filled=True
            return offset+amount
        finally:
            # Even host exceptions release the acquired native buffer. SILENT
            # prevents any uninitialized render samples being submitted.
            self.hr(render,4,[C.c_uint,DWORD],"IAudioRenderClient.ReleaseBuffer",frames,0 if filled else SILENT)

    def drain(self,capture,remaining_frames,align):
        frames=C.c_uint()
        self.hr(capture,5,[C.POINTER(C.c_uint)],"IAudioCaptureClient.GetNextPacketSize",C.byref(frames))
        if not frames.value:return None
        pointer=C.c_void_p();count=C.c_uint();flags=DWORD();position=C.c_uint64();qpc=C.c_uint64()
        value=self.invoke(capture,3,[C.POINTER(C.c_void_p),C.POINTER(C.c_uint),C.POINTER(DWORD),
                          C.POINTER(C.c_uint64),C.POINTER(C.c_uint64)],
                          C.byref(pointer),C.byref(count),C.byref(flags),C.byref(position),C.byref(qpc))
        if value==BUFFER_EMPTY and not count.value:return None
        self.require(value,"IAudioCaptureClient.GetBuffer")
        if value!=0:raise RuntimeError("Unexpected positive capture status "+hex_hr(value))
        try:
            if not count.value or count.value>192000*2:raise ValueError("Invalid or unbounded native capture packet")
            keep=min(count.value,remaining_frames)
            if flags.value&SILENT:raw=bytes(keep*align)
            else:
                if not pointer.value:raise RuntimeError("Native capture pointer missing")
                raw=C.string_at(pointer,keep*align)
            packet={"frames":int(count.value),"retained_frames":keep,"discarded_tail_frames":int(count.value)-keep,
                    "flags":int(flags.value),"silent":bool(flags.value&SILENT),
                    "discontinuity":bool(flags.value&1),"timestamp_error":bool(flags.value&4),
                    "device_position_frames":int(position.value),"qpc_position_100ns":int(qpc.value),
                    "observed_perf_counter_ns":time.perf_counter_ns()}
            return raw,packet
        finally:
            self.hr(capture,4,[C.c_uint],"IAudioCaptureClient.ReleaseBuffer",count.value)

    def calibrate(self,observed_name):
        enumerator,collection,target,loop_client,render_client,capture,render=[C.c_void_p() for unused in range(7)]
        loop_started=False;render_started=False;initialized_com=False
        report={"format":"dordiai-owned-render-loopback-calibration","format_version":1,"status":"running",
                "physical_audio_verified":False,"acoustic_latency_verified":False,"product_ready":False,
                "known_marker_correlated_verified":False,"virtual_audio_verified":False,
                "microphone_capture_used":False,"privacy_settings_changed":False,"default_device_changed":False,
                "format_changed":False,"service_restart_performed":False,"reboot_performed":False,
                "scope":"Exact newly owned render endpoint shared-mode loopback; own marker only; no NVDA or physical recording",
                "endpoints":[],"packets":[],"cleanup_errors":[]}
        captured=bytearray();reference=b""
        hr=int(self.ole.CoInitializeEx(None,2));report["CoInitializeEx_STA"]=hex_hr(hr)
        if hr<0:return dict(report,status="failed",reason="CoInitializeEx failed "+hex_hr(hr)),reference,bytes(captured)
        initialized_com=True
        try:
            clsid=GUID.parse("bcde0395-e52f-467c-8e3d-c4579291692e");iid=GUID.parse("a95664d2-9614-4f35-a746-de8db63617e6")
            self.require(int(self.ole.CoCreateInstance(C.byref(clsid),None,1,C.byref(iid),C.byref(enumerator))),"Create MMDeviceEnumerator")
            # eRender=0, DEVICE_STATE_ACTIVE=1. No default endpoint or microphone.
            self.hr(enumerator,3,[C.c_int,DWORD,C.POINTER(C.c_void_p)],"Enumerate render endpoints",0,1,C.byref(collection))
            count=C.c_uint();self.hr(collection,3,[C.POINTER(C.c_uint)],"Get render endpoint count",C.byref(count))
            if count.value>32:raise ValueError("Unexpected endpoint inventory")
            candidates=[]
            for index in range(count.value):
                endpoint=C.c_void_p()
                try:
                    self.hr(collection,4,[C.c_uint,C.POINTER(C.c_void_p)],"Get render endpoint",index,C.byref(endpoint))
                    identifier,name=self.identify(endpoint)
                    row={"id":identifier,"name":name,"selected_name_match":selected_render_name(name,observed_name)}
                    report["endpoints"].append(row)
                    if row["selected_name_match"]:candidates.append(row)
                finally:self.release(endpoint)
            if len(candidates)!=1:raise RuntimeError("Exact owned vendor render name absent or ambiguous")
            report["selected_endpoint"]=candidates[0]
            self.hr(enumerator,5,[C.c_wchar_p,C.POINTER(C.c_void_p)],"Resolve exact render endpoint",candidates[0]["id"],C.byref(target))
            self.activate(target,loop_client,"Activate loopback IAudioClient")
            self.activate(target,render_client,"Activate render IAudioClient")
            raw,format=self.native_format(loop_client)
            report["native_format"]=format;reference=known_marker(format)
            report["reference_frames"]=len(reference)//format["block_align"]
            self.initialize(loop_client,raw,LOOPBACK,"Initialize shared LOOPBACK on eRender")
            self.initialize(render_client,raw,0,"Initialize shared render same native format")
            self.service(loop_client,IID_CAPTURE,capture,"Get loopback IAudioCaptureClient")
            self.service(render_client,IID_RENDER,render,"Get IAudioRenderClient")
            capacity=C.c_uint()
            self.hr(render_client,4,[C.POINTER(C.c_uint)],"Get native render buffer size",C.byref(capacity))
            rate=format["sample_rate"];align=format["block_align"]
            if not 0<capacity.value<=rate*2:raise ValueError("Native render capacity exceeds declared bound")
            report["render_buffer_frames"]=int(capacity.value)
            offset=self.feed(render,capacity.value,reference,0,align)
            self.hr(loop_client,10,[],"Start render-loopback capture");loop_started=True
            started=time.perf_counter();report["loopback_started_perf_counter_ns"]=time.perf_counter_ns()
            self.hr(render_client,10,[],"Start own marker render");render_started=True
            report["render_started_perf_counter_ns"]=time.perf_counter_ns()
            maximum=int(rate*CAPTURE_SECONDS);total=0
            while time.perf_counter()-started<CAPTURE_SECONDS and total<maximum:
                for unused in range(1024):
                    packet=self.drain(capture,maximum-total,align)
                    if packet is None:break
                    data,meta=packet;captured.extend(data);report["packets"].append(meta);total+=meta["retained_frames"]
                    if len(report["packets"])>4096:raise RuntimeError("Native packet metadata exceeds bounded calibration scope")
                    if total>=maximum:break
                else:raise RuntimeError("Unbounded capture drain loop")
                if total>=maximum:break
                padding=C.c_uint()
                self.hr(render_client,6,[C.POINTER(C.c_uint)],"Get render padding",C.byref(padding))
                if padding.value>capacity.value:raise ValueError("Invalid render padding")
                available=capacity.value-padding.value
                if available:offset=self.feed(render,available,reference,offset,align)
                time.sleep(.002)
            report.update(status="technical-loopback-capture-complete",capture_wall_seconds=time.perf_counter()-started,
                          captured_frames=total,reference_frames_submitted=offset//align,
                          reference_all_submitted=offset==len(reference),native_capture_nonempty=bool(captured),
                          capture_data_discontinuity_packets=sum(row["discontinuity"] for row in report["packets"]),
                          timestamp_error_packets=sum(row["timestamp_error"] for row in report["packets"]),
                          clock_scope="Native device frame/QPC100ns packet observations, not calibrated acoustic latency",
                          capture_duration_limit_seconds=CAPTURE_SECONDS,own_marker_duration_seconds=MARKER_SECONDS)
            if not captured or offset!=len(reference):raise RuntimeError("No bounded loopback data or incomplete marker submission")
        except Exception as error:
            report.update(status="failed",reason=type(error).__name__+": "+str(error))
        finally:
            for client,started,name in ((render_client,render_started,"render"),(loop_client,loop_started,"loopback")):
                if started:
                    try:
                        value=self.invoke(client,11,[])
                        if value<0:report["cleanup_errors"].append(name+" Stop "+hex_hr(value))
                    except Exception as error:report["cleanup_errors"].append(name+" Stop "+repr(error))
            for pointer in (capture,render,loop_client,render_client,target,collection,enumerator):
                try:self.release(pointer)
                except Exception as error:report["cleanup_errors"].append("COM release "+repr(error))
            if initialized_com:self.ole.CoUninitialize()
            report["all_own_com_interfaces_released"]=not report["cleanup_errors"]
            report["native_call_hresult_log"]=self.calls_report
            report["native_call_counts"]=self.call_counts
            report["native_call_log_scope"]="First256 observed synchronous calls; per-operation counts retained; errors additionally preserved in reason"
            if report["cleanup_errors"]:report["status"]="failed"
        return report,reference,bytes(captured)

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--render-name",required=True)
    parser.add_argument("--owned-instance-id",required=True)
    parser.add_argument("--output",required=True,type=Path)
    args=parser.parse_args(argv);guard(args)
    import windows_virtual_audio_trial as device
    pnp=device.WindowsPnP()
    if pnp.matching()!=[args.owned_instance_id] or not pnp.instance_exists(args.owned_instance_id):
        raise RuntimeError("Parent's unique verified device lease is not live")
    args.output.mkdir(parents=True)
    report,reference,captured=LoopbackCalibration().calibrate(args.render_name)
    report["owned_instance_id"]=args.owned_instance_id
    if reference:report["reference_pcm"]=publish_raw(args.output/"reference.pcm",reference)
    if captured:report["captured_pcm"]=publish_raw(args.output/"captured.pcm",captured)
    with (args.output/"capture.json").open("x",encoding="utf-8") as output:
        json.dump(report,output,indent=2);output.write("\n")
    print("OWNED_RENDER_LOOPBACK_CALIBRATION "+json.dumps({key:report.get(key) for key in
          ("status","reason","native_format","captured_frames","reference_frames_submitted","reference_all_submitted",
           "native_capture_nonempty","known_marker_correlated_verified","physical_audio_verified","microphone_capture_used",
           "cleanup_errors","all_own_com_interfaces_released")}),flush=True)
    return 0 if report["status"]=="technical-loopback-capture-complete" else 1

if __name__=="__main__":raise SystemExit(main())
