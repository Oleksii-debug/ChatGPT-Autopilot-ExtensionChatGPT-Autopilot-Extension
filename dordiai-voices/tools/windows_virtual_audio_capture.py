"""Real NVDA WavePlayer plus bounded MME virtual capture on an owned signed device.

All driver/package/CI guards are reused. This is software pipeline evidence,
never physical or acoustic acceptance. No recording sink double is permitted.
"""
from __future__ import annotations
import argparse
from array import array
from collections import deque
import ctypes as C
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import wave

import windows_virtual_audio_trial as device

CORE_NAME="dordiai-voices-0.13.1-dev.10.nvda-addon"
CORE_BYTES=1974796411
CORE_SHA256="437bb9394df5b44cb1a99edee21312f6255b8cc74622c0bcc15b3513e6c328d8"
RATE,CHANNELS,WIDTH=48000,2,2
BUFFER_FRAMES=960
BUFFER_COUNT=16
DWORD=device.DWORD


class Format(C.Structure):
    _pack_=1
    _fields_=[("tag",C.c_uint16),("channels",C.c_uint16),("rate",DWORD),
              ("average",DWORD),("alignment",C.c_uint16),("bits",C.c_uint16),("extra",C.c_uint16)]


class Header(C.Structure):
    _fields_=[("data",C.c_void_p),("length",DWORD),("recorded",DWORD),("user",C.c_size_t),
              ("flags",DWORD),("loops",DWORD),("next",C.c_void_p),("reserved",C.c_size_t)]


class VirtualCapture:
    def __init__(self,index):
        self.index=index
        self.stop=threading.Event()
        self.thread=None
        self.handle=C.c_void_p()
        self.buffers=[]
        self.headers=[]
        self.queue=deque()
        self.hash=hashlib.sha256()
        self.frames=0
        self.nonzero_samples=0
        self.peak=0
        self.energy=0
        self.sample_values=0
        self.excerpt=bytearray()
        self.first_nonzero_frame=None
        self.transitions=[]
        self.last_active=None
        self.errors=[]
        self.starvations=0
        self.started_ns=None
        self.stopped_ns=None
        self.closed=False
        self.winmm=C.WinDLL("winmm",use_last_error=True)
        bind=device.bind
        PH=C.POINTER(Header)
        self.open=bind(self.winmm,"waveInOpen",[C.POINTER(C.c_void_p),C.c_uint,C.POINTER(Format),C.c_size_t,C.c_size_t,DWORD],C.c_uint)
        self.prepare=bind(self.winmm,"waveInPrepareHeader",[C.c_void_p,PH,C.c_uint],C.c_uint)
        self.add=bind(self.winmm,"waveInAddBuffer",[C.c_void_p,PH,C.c_uint],C.c_uint)
        self.start=bind(self.winmm,"waveInStart",[C.c_void_p],C.c_uint)
        self.reset=bind(self.winmm,"waveInReset",[C.c_void_p],C.c_uint)
        self.unprepare=bind(self.winmm,"waveInUnprepareHeader",[C.c_void_p,PH,C.c_uint],C.c_uint)
        self.close=bind(self.winmm,"waveInClose",[C.c_void_p],C.c_uint)

    @staticmethod
    def check(code,operation):
        if code:
            raise RuntimeError(operation+" failed with MMRESULT "+str(code))

    def consume(self,raw,observed_ns):
        if len(raw)%(CHANNELS*WIDTH):
            raise RuntimeError("Capture buffer is not complete PCM frames")
        samples=array("h")
        samples.frombytes(raw)
        values=len(samples)
        energy=sum(int(value)*int(value) for value in samples)
        peak=max((abs(value) for value in samples),default=0)
        active=peak>32
        if active!=self.last_active and len(self.transitions)<10000:
            self.transitions.append({"active":active,"sample_frame":self.frames,
                                     "observed_perf_counter_ns":observed_ns})
            self.last_active=active
        if active and self.first_nonzero_frame is None:
            self.first_nonzero_frame=self.frames
        if self.first_nonzero_frame is not None and len(self.excerpt)<RATE*CHANNELS*WIDTH*2:
            self.excerpt.extend(raw[:RATE*CHANNELS*WIDTH*2-len(self.excerpt)])
        self.hash.update(raw)
        self.frames+=len(raw)//(CHANNELS*WIDTH)
        self.nonzero_samples+=sum(value!=0 for value in samples)
        self.peak=max(self.peak,peak)
        self.energy+=energy
        self.sample_values+=values

    def worker(self):
        try:
            while not self.stop.is_set():
                if all(header.flags&1 for header in self.headers):
                    self.starvations+=1
                while self.queue and not self.stop.is_set() and self.headers[self.queue[0]].flags&1:
                    index=self.queue.popleft()
                    header=self.headers[index]
                    size=int(header.recorded)
                    if not 0<=size<=C.sizeof(self.buffers[index]):
                        raise RuntimeError("Driver returned an invalid capture length")
                    self.consume(self.buffers[index].raw[:size],time.perf_counter_ns())
                    if self.stop.is_set():break
                    self.check(self.add(self.handle,C.byref(header),C.sizeof(header)),"Requeue capture")
                    self.queue.append(index)
                self.stop.wait(.002)
        except Exception as error:
            self.errors.append(type(error).__name__+": "+str(error))
            self.stop.set()

    def __enter__(self):
        fmt=Format(1,CHANNELS,RATE,RATE*CHANNELS*WIDTH,CHANNELS*WIDTH,WIDTH*8,0)
        try:
            self.check(self.open(C.byref(self.handle),self.index,C.byref(fmt),0,0,0),"Open actual MME capture")
            for index in range(BUFFER_COUNT):
                buffer=C.create_string_buffer(BUFFER_FRAMES*CHANNELS*WIDTH)
                header=Header(C.cast(buffer,C.c_void_p),len(buffer),0,0,0,0,None,0)
                self.check(self.prepare(self.handle,C.byref(header),C.sizeof(header)),"Prepare capture")
                self.buffers.append(buffer)
                self.headers.append(header)
                self.check(self.add(self.handle,C.byref(header),C.sizeof(header)),"Queue capture")
                self.queue.append(index)
            self.started_ns=time.perf_counter_ns()
            self.check(self.start(self.handle),"Start capture")
            self.thread=threading.Thread(target=self.worker,name="OwnedMMECapture",daemon=True)
            self.thread.start()
            return self
        except Exception:
            self.shutdown()
            raise

    def shutdown(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=2)
            if self.thread.is_alive():
                self.errors.append("Capture thread did not stop; preserving buffers until owned process exit")
                return
        if self.handle.value:
            code=self.reset(self.handle)
            if code:self.errors.append("waveInReset MMRESULT "+str(code))
            for header in self.headers:
                code=self.unprepare(self.handle,C.byref(header),C.sizeof(header))
                if code:self.errors.append("waveInUnprepareHeader MMRESULT "+str(code))
            code=self.close(self.handle)
            if code:self.errors.append("waveInClose MMRESULT "+str(code))
            else:self.closed=True
        self.stopped_ns=time.perf_counter_ns()

    def __exit__(self,*args):
        self.shutdown()

    def report(self,output):
        excerpt=Path(output)/"virtual-capture-excerpt.wav"
        if self.excerpt:
            with wave.open(str(excerpt),"wb") as wav:
                wav.setnchannels(CHANNELS)
                wav.setsampwidth(WIDTH)
                wav.setframerate(RATE)
                wav.writeframes(self.excerpt)
        return {"format":"dordiai-real-mme-virtual-capture","sample_rate":RATE,"channels":CHANNELS,"bits":WIDTH*8,
                "buffer_frames":BUFFER_FRAMES,"buffer_count":BUFFER_COUNT,
                "buffer_duration_ms":BUFFER_FRAMES/RATE*1000,"ring_capacity_ms":BUFFER_FRAMES*BUFFER_COUNT/RATE*1000,
                "capture_started_perf_counter_ns":self.started_ns,"capture_stopped_perf_counter_ns":self.stopped_ns,
                "processed_frames":self.frames,"nonzero_samples":self.nonzero_samples,"peak":self.peak,
                "rms":math.sqrt(self.energy/self.sample_values) if self.sample_values else 0,
                "captured_pcm_sha256":self.hash.hexdigest(),"capture_closed":self.closed,"errors":self.errors,
                "observed_all_buffers_done":self.starvations,"activity_transitions":self.transitions,
                "excerpt_bytes":len(self.excerpt),"physical_audio_verified":False,"gapless_audio_verified":False,
                "cancel_to_capture_silence_verified":False,"requested_phrase_waveform_match_verified":False,
                "capture_identity_scope":"nonzero request-span overlap only",
                "clock_scope":"20ms FIFO buffers polled after native DONE; QPC arrival observations, not ADC/acoustic timestamps",
                "tail_scope":"Up to320ms queued capture tail is not included after stop; no complete played-audio claim",
                "capture_source":"Owned virtual audio driver; neither a WavePlayer patch nor a recording sink test double"}


def run_probe(addon,output,timeout):
    command=[sys.executable,str(Path(__file__).with_name("virtual_capture_probe.py")),
             "--addon",str(addon),"--output",str(output/"nvda"),"--timeout",str(timeout)]
    with (output/"real-nvda-controller.log").open("wb") as log:
        process=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT)
        try:
            return process.wait(timeout=2*timeout+90)
        except subprocess.TimeoutExpired:
            if process.poll() is None:
                subprocess.run(["taskkill","/PID",str(process.pid),"/T","/F"],stdout=log,stderr=subprocess.STDOUT,check=False)
                process.wait(timeout=20)
            raise RuntimeError("Owned NVDA controller watchdog expired")


def capture_request_overlap(capture, events):
    valid=[row for row in events if isinstance(row,dict) and type(row.get("speak_started_ns")) is int
           and type(row.get("observed_return_ns")) is int]
    if not valid:
        return {"request_events":0,"overlapping_active_intervals":0,"cross_process_clock_calibrated":False}
    start=min(row["speak_started_ns"] for row in valid)
    end=max(row["observed_return_ns"] for row in valid)
    transitions=capture.get("activity_transitions",[])
    overlaps=0
    for index,row in enumerate(transitions):
        if row.get("active") is not True:continue
        last=(transitions[index+1]["observed_perf_counter_ns"] if index+1<len(transitions)
              else capture.get("capture_stopped_perf_counter_ns",row["observed_perf_counter_ns"]))
        if row["observed_perf_counter_ns"]<=end and last>=start:overlaps+=1
    return {"request_events":len(valid),"request_span_started_ns":start,"request_span_ended_ns":end,
            "overlapping_active_intervals":overlaps,"cross_process_clock_calibrated":False,
            "scope":"QPC polling-observation interval overlap, not exact sample/ADC/acoustic latency"}


def run(args):
    report={"format":"dordiai-owned-real-waveplayer-virtual-capture","format_version":1,
            "status":"blocked","endpoint_kind":"owned-virtual-audio","physical_audio_verified":False,
            "acoustic_latency_verified":False,"product_ready":False,"virtual_audio_verified":False,
            "wave_player_verified":False,"recording_pcm_sink_test_double":False,
            "requested_phrase_waveform_match_verified":False,
            "capture_identity_scope":"nonzero request-span overlap only",
            "reboot_performed":False,"certificates_imported":False,"signature_enforcement_modified":False,
            "vendor_installer_executed":False,"vendor_requires_finalization_reboot":True,
            "scope":"Actual immutable core10, real NVDA/WavePlayer and virtual MME capture; no physical/pronunciation acceptance"}
    created=False
    capture=None
    try:
        if not args.ephemeral_ci:raise device.TrialBlocked("Explicit owned CI scope required")
        device.guard_environment(os.environ,args.package,args.output)
        if args.output.exists():raise device.TrialBlocked("Output already exists")
        args.output.mkdir(parents=True)
        created=True
        if args.addon.is_symlink() or args.addon.name!=CORE_NAME or args.addon.stat().st_size!=CORE_BYTES:
            raise device.TrialBlocked("Wrong immutable core10 input")
        with args.addon.open("rb") as stream:
            if hashlib.file_digest(stream,"sha256").hexdigest()!=CORE_SHA256:
                raise device.TrialBlocked("Immutable core10 SHA differs")
        report["core_sha256"]=CORE_SHA256
        report["verification"]=device.verify_package(args.package,args.validation)
        report["endpoints_before"]=device.endpoints()
        pnp=device.WindowsPnP()
        with pnp.owned_device(args.package/"vbMmeCable64_win10.inf",report):
            deadline=time.monotonic()+20
            while True:
                during=device.endpoints()
                render,source=device.select_new_vendor_endpoints(report["endpoints_before"],during)
                report["endpoints_during"]=during
                if render and source:break
                if time.monotonic()>=deadline:raise device.TrialBlocked("No unique newly-created vendor endpoints")
                time.sleep(.25)
            report.update(render_endpoint=render,capture_endpoint=source,
                          output_device_selection="Unmodified NVDA Windows default; only newly observed vendor outputs")
            capture=VirtualCapture(source["index"])
            with capture:
                report["nvda_returncode"]=run_probe(args.addon,args.output,args.timeout)
                time.sleep(.5)
            report["capture"]=capture.report(args.output)
            controller=json.loads((args.output/"nvda/windows-nvda-probe.json").read_text(encoding="utf-8"))
            probe=controller.get("probe",{})
            if (controller.get("addon_sha256")!=CORE_SHA256 or controller.get("recording_pcm_sink_test_double") is not False
                    or controller.get("physical_audio_verified") is not False or controller.get("product_ready") is not False):
                raise RuntimeError("Real controller provenance/physical-acceptance flags differ")
            report["wave_player_verified"]=controller.get("wave_player_verified") is True
            report["normal_api_latency"]=probe.get("api_latency")
            report["normal_pcm_metrics"]=probe.get("pcm_metrics")
            samples=(probe.get("api_latency") or {}).get("samples",{})
            report["capture_request_overlap"]=capture_request_overlap(report["capture"],samples.get("request_events",[]))
            report["observed_cancel_event_count"]=len(samples.get("cancel_events",[]))
            nonzero=report["capture"]["nonzero_samples"]>100 and report["capture"]["peak"]>32
            report["virtual_audio_verified"]=(report["wave_player_verified"] and nonzero and not capture.errors
                and capture.closed and report["capture_request_overlap"]["overlapping_active_intervals"]>0)
            report["status"]="measured-software-pipeline" if report["virtual_audio_verified"] and report["nvda_returncode"]==0 else "failed"
            if report["status"]=="failed":report["reason"]="Real NVDA or actual virtual capture did not pass; inspect original reports"
    except device.TrialBlocked as error:
        report.update(status="blocked",reason=str(error))
    except Exception as error:
        report.update(status="failed",reason=type(error).__name__+": "+str(error))
    finally:
        if capture is not None and "capture" not in report and created:
            report["capture"]=capture.report(args.output)
        if report.get("cleanup",{}).get("attempted") and report["cleanup"].get("removed") is not True:
            report.update(status="failed",cleanup_failure=True,reason="Exact owned instance absence not verified")
        if created:
            (args.output/"virtual-waveplayer-capture.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
        brief={key:report.get(key) for key in ("status","reason","core_sha256","wave_player_verified","virtual_audio_verified",
                                             "physical_audio_verified","nvda_returncode","cleanup")}
        if "capture" in report:
            brief["capture"]={key:report["capture"].get(key) for key in ("processed_frames","nonzero_samples","peak","rms",
                "captured_pcm_sha256","capture_closed","errors","observed_all_buffers_done","excerpt_bytes")}
        print("VIRTUAL_WAVEPLAYER_CAPTURE "+json.dumps(brief,ensure_ascii=True),flush=True)
    return 0 if report["status"]=="measured-software-pipeline" else 2 if report["status"]=="blocked" else 1


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package",required=True,type=Path)
    parser.add_argument("--validation",required=True,type=Path)
    parser.add_argument("--output",required=True,type=Path)
    parser.add_argument("--addon",required=True,type=Path)
    parser.add_argument("--timeout",type=float,default=420)
    parser.add_argument("--ephemeral-ci",action="store_true")
    args=parser.parse_args()
    if not 1<=args.timeout<=600:parser.error("Timeout outside owned trial bound")
    return run(args)


if __name__=="__main__":
    raise SystemExit(main())
