"""Bounded native I/O diagnosis and independent real NVDA render; no PCM capture or policy edits."""
from __future__ import annotations
import argparse
import ctypes as C
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time

import windows_virtual_audio_capture as capture
device=capture.device
VARIANTS=((48000,2),(48000,1),(44100,2),(44100,1),(24000,2),(24000,1))


def native_worker(kind,index,rate,channels):
    if (os.name!="nt" or struct.calcsize("P")!=8 or os.environ.get("GITHUB_ACTIONS")!="true"
            or os.environ.get("RUNNER_ENVIRONMENT")!="github-hosted"
            or os.environ.get("GITHUB_REPOSITORY")!=device.REPOSITORY
            or os.environ.get("RUNNER_ARCH")!="X64" or kind not in ("in","out") or (rate,channels) not in VARIANTS):
        raise ValueError("Only bounded owned Windows native API diagnostics permitted")
    rows=device.endpoints()[kind]
    selected=[row for row in rows if row["index"]==index and row["error"]==0]
    prefix=("CABLE Output (VB-Audio Virtual",) if kind=="in" else (
        "Speakers (VB-Audio Virtual Cabl","CABLE Input (VB-Audio Virtual")
    if len(selected)!=1 or not selected[0]["name"].startswith(prefix):
        raise ValueError("Not the observed vendor endpoint; no mapper or unrelated device permitted")
    winmm=C.WinDLL("winmm",use_last_error=True)
    suffix="In" if kind=="in" else "Out"
    op=device.bind(winmm,"wave"+suffix+"Open",
        [C.POINTER(C.c_void_p),C.c_uint,C.POINTER(capture.Format),C.c_size_t,C.c_size_t,device.DWORD],C.c_uint)
    close=device.bind(winmm,"wave"+suffix+"Close",[C.c_void_p],C.c_uint)
    text=device.bind(winmm,"wave"+suffix+"GetErrorTextW",[C.c_uint,C.c_wchar_p,C.c_uint],C.c_uint)
    fmt=capture.Format(1,channels,rate,rate*channels*2,channels*2,16,0)
    result={"kind":kind,"index":index,"endpoint":selected[0],"rate":rate,"channels":channels,
            "bits":16,"format_size":C.sizeof(fmt),"format_hex":C.string_at(C.byref(fmt),C.sizeof(fmt)).hex(),
            "scope":"Documented QUERY1 and Open0/Close only; no recordingStart/playbackWrite"}
    for label,flags in (("query",1),("actual_open",0)):
        handle=C.c_void_p()
        before=time.perf_counter_ns()
        code=int(op(None if flags else C.byref(handle),index,C.byref(fmt),0,0,flags))
        buffer=C.create_unicode_buffer(512)
        translated=int(text(code,buffer,len(buffer)))
        row={"mmresult":code,"error_text":buffer.value if translated==0 else None,
             "elapsed_ms":(time.perf_counter_ns()-before)/1e6,"flags":flags}
        if flags==0:
            row["handle_opened"]=code==0 and bool(handle.value)
            if row["handle_opened"]:
                row["close_mmresult"]=int(close(handle))
        result[label]=row
    return result


def isolated_trial(kind,index,rate,channels):
    command=[sys.executable,str(Path(__file__).resolve()),"--native-worker",kind,str(index),str(rate),str(channels)]
    try:
        completed=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=10,check=False)
    except subprocess.TimeoutExpired:
        return {"kind":kind,"rate":rate,"channels":channels,"worker_timeout":True,
                "scope":"Only the owned native-query child was terminated; OS closes its handles"}
    if completed.returncode!=0:
        return {"kind":kind,"rate":rate,"channels":channels,"worker_error":completed.stderr[-4096:],
                "returncode":completed.returncode}
    return json.loads(completed.stdout)


def wasapi_after_six_failures(rows,source,instance,output):
    if len(rows)!=6 or not all(isinstance(row.get("actual_open"),dict)
                              and row["actual_open"].get("mmresult") not in (None,0) for row in rows):
        return {"status":"not-attempted","reason":"Not all six actual MME open failures were observed"}
    path=Path(output)/"wasapi-capture-diagnostics.json"
    command=[sys.executable,str(Path(__file__).with_name("wasapi_capture_diagnostics.py")),
             "--capture-name",source["name"],"--owned-instance-id",instance,
             "--all-six-mme-opens-failed","--output",str(path)]
    try:
        completed=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=10,check=False)
    except subprocess.TimeoutExpired:
        return {"status":"native-helper-timeout","scope":"Only the owned COM diagnostic child was stopped"}
    if completed.returncode!=0:
        return {"status":"native-helper-failed","returncode":completed.returncode,"stderr":completed.stderr[-4096:]}
    if not path.is_file():
        return {"status":"native-helper-missing-report"}
    return json.loads(path.read_text(encoding="utf-8"))


def run(args):
    report={"format":"dordiai-owned-native-audio-io-diagnostics","format_version":1,"status":"blocked",
            "physical_audio_verified":False,"product_ready":False,"virtual_audio_verified":False,
            "recording_pcm_sink_test_double":False,"wave_player_verified":False,
            "reboot_performed":False,"certificates_imported":False,"signature_enforcement_modified":False,
            "vendor_installer_executed":False,"requested_phrase_waveform_match_verified":False,
            "active_render_overlap_tested":False,
            "followup_scope":"Render query handles are closed before followup input; final input is after NVDA exit",
            "scope":"Bounded native I/O queries/opens and independent real NVDA render; no PCM capture or privacy/security changes"}
    created=False
    try:
        if not args.ephemeral_ci:raise device.TrialBlocked("Explicit owned CI scope required")
        device.guard_environment(os.environ,args.package,args.output)
        if args.output.exists():raise device.TrialBlocked("Output already exists")
        args.output.mkdir(parents=True)
        created=True
        if args.addon.is_symlink() or args.addon.name!=capture.CORE_NAME or args.addon.stat().st_size!=capture.CORE_BYTES:
            raise device.TrialBlocked("Wrong immutable core10")
        with args.addon.open("rb") as stream:
            if hashlib.file_digest(stream,"sha256").hexdigest()!=capture.CORE_SHA256:
                raise device.TrialBlocked("Core10 hash mismatch")
        report["core_sha256"]=capture.CORE_SHA256
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
                if time.monotonic()>=deadline:raise device.TrialBlocked("No unique owned endpoints")
                time.sleep(.25)
            report.update(render_endpoint=render,capture_endpoint=source)
            report["capture_before_render"]=[isolated_trial("in",source["index"],rate,channels) for rate,channels in VARIANTS]
            report["wasapi_capture_diagnostic"]=wasapi_after_six_failures(
                report["capture_before_render"],source,report["owned_instance_id"],args.output)
            report["render_open_queries"]=[isolated_trial("out",render["index"],rate,channels) for rate,channels in VARIANTS]
            report["capture_after_render_open"]=isolated_trial("in",source["index"],48000,2)
            report["nvda_returncode"]=capture.run_probe(args.addon,args.output,args.timeout)
            path=args.output/"nvda/windows-nvda-probe.json"
            if path.is_file():
                controller=json.loads(path.read_text(encoding="utf-8"))
                if (controller.get("addon_sha256")!=capture.CORE_SHA256
                        or controller.get("recording_pcm_sink_test_double") is not False
                        or controller.get("physical_audio_verified") is not False):
                    raise RuntimeError("Independent real render controller provenance changed")
                report["wave_player_verified"]=controller.get("wave_player_verified") is True
                report["nvda_status"]=controller.get("status")
                report["normal_api_latency"]=controller.get("probe",{}).get("api_latency")
            report["capture_after_nvda"]=[isolated_trial("in",source["index"],rate,channels) for rate,channels in VARIANTS]
            report["status"]="diagnostic-complete"
    except device.TrialBlocked as error:
        report.update(status="blocked",reason=str(error))
    except Exception as error:
        report.update(status="failed",reason=type(error).__name__+": "+str(error))
    finally:
        if report.get("cleanup",{}).get("attempted") and report["cleanup"].get("removed") is not True:
            report.update(status="failed",cleanup_failure=True,reason="Exact owned instance absence not verified")
        if created:
            (args.output/"native-io-diagnostics.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
        brief={key:report.get(key) for key in ("status","reason","core_sha256","wave_player_verified","nvda_returncode",
                                             "nvda_status","cleanup","physical_audio_verified","virtual_audio_verified")}
        for key in ("capture_before_render","render_open_queries","capture_after_render_open","capture_after_nvda"):
            if key in report:brief[key]=report[key]
        print("VIRTUAL_NATIVE_IO_DIAGNOSTICS "+json.dumps(brief,ensure_ascii=True),flush=True)
    return 0 if report["status"]=="diagnostic-complete" else 2 if report["status"]=="blocked" else 1


def main():
    if len(sys.argv)==6 and sys.argv[1]=="--native-worker":
        # Worker never installs/changes devices. Its parent holds the verified unique lease.
        print(json.dumps(native_worker(sys.argv[2],int(sys.argv[3]),int(sys.argv[4]),int(sys.argv[5]))))
        return 0
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package",required=True,type=Path)
    parser.add_argument("--validation",required=True,type=Path)
    parser.add_argument("--output",required=True,type=Path)
    parser.add_argument("--addon",required=True,type=Path)
    parser.add_argument("--timeout",type=float,default=420)
    parser.add_argument("--ephemeral-ci",action="store_true")
    args=parser.parse_args()
    if not 1<=args.timeout<=600:parser.error("Owned timeout bound exceeded")
    return run(args)


if __name__=="__main__":
    raise SystemExit(main())
