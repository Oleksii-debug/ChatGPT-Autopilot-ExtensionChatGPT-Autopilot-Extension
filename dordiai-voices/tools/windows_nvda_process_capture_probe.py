"""Exact owned NVDA sibling capture with genuine WavePlayer PCM reference.

Only this controller's fresh portable NVDA and capture-helper children are
used. A genuine known phrase is first warmed, then repeated through the actual
driver/player while Windows captures that held NVDA process tree. This is
software transport evidence, never physical/latency/pronunciation acceptance.
"""
from __future__ import annotations
import argparse
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

from nvda_process_capture_support import read_json, read_pcm, validate_ready, validate_capture, correlate_phrase

PHRASE = "Перевірка українського мовлення."
CORE11_SHA = "223e5ea7b29d0f9d16f3ca653711e8ced281c0fc7d5bd2fb891018a73926eceb"
CORE11_BYTES = 1992938157
FROZEN_MARKER_CPP_SHA = "eba7fd78469298b7c4c300fdd80c9da18ffb1d03323c8b72230d92ff59448012"

PLUGIN_CODE = r'''
import hashlib,json,os,sys,time,wave
from pathlib import Path
import core,globalPluginHandler,globalVars,synthDriverHandler,speech
from speech.commands import LangChangeCommand,IndexCommand
SETTINGS=__SETTINGS__
ROOT=Path(SETTINGS["root"])
DRIVER=None
ORIGINAL_FEED=None
PHASE="starting"
PCM=bytearray()
SAMPLE_RATE=24000
STARTED=0
EVENTS=[]
FINISHED=False
LAUNCH_DEADLINE=time.monotonic()+8
INDEX_SEEN=False
DONE_SEEN=False
REPORT={"format":"dordiai-owned-nvda-process-phrase","status":"running","probe_id":SETTINGS["probe_id"],
    "pid":os.getpid(),"controller_pid":SETTINGS["controller_pid"],"requested_phrase":SETTINGS["phrase"],
    "recording_pcm_sink_test_double":False,"physical_audio_verified":False,"acoustic_latency_verified":False,
    "native_pronunciation_verified":False,"product_ready":False}

def publish(name,value):
    path=ROOT/name
    with path.open("x",encoding="utf-8") as out:json.dump(value,out,sort_keys=True,separators=(",",":"),ensure_ascii=True)

def feed(data,*args,**kwargs):
    before=time.perf_counter_ns()
    raw=None
    if PHASE=="capturing":
        if not isinstance(data,(bytes,bytearray,memoryview)):raise TypeError("Expected actual WavePlayer PCM bytes")
        raw=bytes(data)
        if len(PCM)+len(raw)>SAMPLE_RATE*2*8:raise ValueError("Known phrase PCM exceeds explicit8second bound")
    result=ORIGINAL_FEED(data,*args,**kwargs)
    if raw is not None:
        PCM.extend(raw)
        if len(EVENTS)<2048:EVENTS.append({"before_feed_ns":before,"after_feed_ns":time.perf_counter_ns(),"bytes":len(raw)})
    return result

def fail(error):
    global FINISHED
    if FINISHED:return
    FINISHED=True
    REPORT.update(status="failed",error=type(error).__name__+": "+str(error))
    try:publish("plugin-complete.json",REPORT)
    except FileExistsError:pass
    cleanup()

def guarded(function):
    def wrapped():
        try:function()
        except Exception as error:fail(error)
    return wrapped

def cleanup():
    global ORIGINAL_FEED
    try:synthDriverHandler.synthDoneSpeaking.unregister(done)
    except Exception:pass
    try:synthDriverHandler.synthIndexReached.unregister(index_reached)
    except Exception:pass
    if DRIVER is not None:
        try:DRIVER.cancel()
        except Exception:pass
        if ORIGINAL_FEED is not None:
            DRIVER._player.feed=ORIGINAL_FEED
            ORIGINAL_FEED=None

def done(synth=None,**kwargs):
    global DONE_SEEN
    if synth not in (None,DRIVER):return
    if PHASE not in ("warming","capturing"):return
    DONE_SEEN=True
    if INDEX_SEEN:core.callLater(100,guarded(settled))

def index_reached(synth=None,index=None,**kwargs):
    global INDEX_SEEN
    if synth not in (None,DRIVER):return
    expected=881002 if PHASE=="warming" else 881003 if PHASE=="capturing" else None
    if expected is None or index!=expected:return
    INDEX_SEEN=True
    if DONE_SEEN:core.callLater(100,guarded(settled))

def settled():
    global PHASE,FINISHED
    if DRIVER is None or not INDEX_SEEN or not DONE_SEEN:return
    error=getattr(DRIVER,"_dordiai_last_error",None)
    if error:raise RuntimeError("Actual driver error: "+str(error))
    if PHASE=="warming":
        PHASE="ready"
        image=Path(sys.executable).resolve()
        publish("plugin-ready.json",{"format":"dordiai-owned-nvda-capture-ready","status":"ready",
            "probe_id":SETTINGS["probe_id"],"pid":os.getpid(),"controller_pid":SETTINGS["controller_pid"],
            "config":str(Path(globalVars.appArgs.configPath).resolve()),"synth":DRIVER.name,
            "image_sha256":hashlib.sha256(image.read_bytes()).hexdigest(),"sample_rate":SAMPLE_RATE,
            "recording_pcm_sink_test_double":False,"physical_audio_verified":False})
        poll()
    elif PHASE=="capturing":
        PHASE="complete"
        raw=bytes(PCM)
        if not raw or len(raw)%2 or not any(raw):raise ValueError("No finite nonzero actual phrase PCM")
        path=ROOT/"phrase-reference.pcm"
        with path.open("xb") as output:output.write(raw)
        REPORT.update(status="passed-real-waveplayer-phrase",sample_rate=SAMPLE_RATE,channels=1,bits_per_sample=16,
            reference_pcm={"filename":path.name,"size_bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()},
            real_wave_player_type=type(DRIVER._player).__module__+"."+type(DRIVER._player).__name__,
            player_feed_observer="Original feed called once with identical data/args/kwargs, result returned unchanged",
            feed_events=EVENTS,request_started_ns=STARTED,driver_error=None)
        publish("plugin-complete.json",REPORT)
        FINISHED=True
        poll()

def poll():
    global PHASE,STARTED,INDEX_SEEN,DONE_SEEN
    stop=ROOT/"stop.json"
    if stop.is_file():
        value=json.loads(stop.read_text())
        if value.get("probe_id")!=SETTINGS["probe_id"]:raise ValueError("Stop nonce differs")
        cleanup();core.callLater(100,core.triggerNVDAExit);return
    trigger=ROOT/"capture-trigger.json"
    if PHASE=="ready" and trigger.is_file():
        value=json.loads(trigger.read_text())
        if value!={"probe_id":SETTINGS["probe_id"],"phrase":SETTINGS["phrase"]}:raise ValueError("Trigger differs from exact owned phrase")
        DRIVER.cancel();PCM.clear();EVENTS.clear();INDEX_SEEN=False;DONE_SEEN=False;PHASE="capturing";STARTED=time.perf_counter_ns()
        DRIVER.speak([LangChangeCommand("uk"),SETTINGS["phrase"],IndexCommand(881003)])
    core.callLater(50,guarded(poll))

def begin():
    global DRIVER,ORIGINAL_FEED,PHASE,SAMPLE_RATE,INDEX_SEEN,DONE_SEEN
    import config,versionInfo
    if versionInfo.version!="2026.3.1":raise ValueError("Unexpected official NVDA version")
    if Path(globalVars.appArgs.configPath).resolve()!=Path(SETTINGS["config"]):raise ValueError("Actual NVDA config differs")
    launch=ROOT/"owned-launch.json"
    if not launch.is_file():
        if time.monotonic()>LAUNCH_DEADLINE:raise TimeoutError("Exact owned launch lease missing")
        core.callLater(50,guarded(begin));return
    lease=json.loads(launch.read_text())
    if lease!={"pid_expected":os.getpid(),"probe_id":SETTINGS["probe_id"]}:raise ValueError("Actual NVDA pid/nonce differs from owned Popen")
    # Ambient desktop announcements are suppressed; direct driver requests below
    # still traverse the genuine model/queue/unchanged WavePlayer output path.
    speech.setSpeechMode(speech.SpeechMode.off)
    if not synthDriverHandler.setSynth("kx47Preview"):raise RuntimeError("Cannot select actual Dordiai driver")
    DRIVER=synthDriverHandler.getSynth()
    if DRIVER is None or DRIVER.name!="kx47Preview":raise RuntimeError("Wrong actual synthesizer")
    if "Recording" in type(DRIVER._player).__name__:raise RuntimeError("Recording sink is forbidden")
    module=sys.modules[type(DRIVER).__module__];SAMPLE_RATE=module.SAMPLE_RATE
    if SAMPLE_RATE not in (22050,24000,48000):raise ValueError("Unexpected actual driver sample rate")
    REPORT["configured_audio_output_device"]=str(config.conf["audio"]["outputDevice"])
    if REPORT["configured_audio_output_device"]!=SETTINGS["output_device"]:raise ValueError("Wrong isolated NVDA output endpoint")
    ORIGINAL_FEED=DRIVER._player.feed;DRIVER._player.feed=feed
    synthDriverHandler.synthDoneSpeaking.register(done)
    synthDriverHandler.synthIndexReached.register(index_reached)
    INDEX_SEEN=False;DONE_SEEN=False;PHASE="warming"
    DRIVER.speak([LangChangeCommand("uk"),SETTINGS["phrase"],IndexCommand(881002)])

class GlobalPlugin(globalPluginHandler.GlobalPlugin):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        core.callLater(1000,guarded(begin))
    def terminate(self):
        cleanup()
        super().terminate()
'''


def digest(path):
    with Path(path).open("rb") as source:
        return __import__("hashlib").file_digest(source,"sha256").hexdigest()


def publish(path, value):
    with Path(path).open("x", encoding="utf-8") as out:
        json.dump(value, out, sort_keys=True, separators=(",", ":"))


def module(name, path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
    return value


def wait_file(path, processes, seconds, failed_file=None):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if Path(path).is_file():return read_json(path)
        if failed_file is not None and Path(failed_file).is_file():
            failure=read_json(failed_file)
            if failure.get("status")=="failed":
                raise RuntimeError("Owned NVDA plugin failed: "+str(failure.get("error")))
        if any(process.poll() is not None for process in processes):
            raise RuntimeError("Exact owned child exited before its ready/result file")
        time.sleep(.02)
    raise TimeoutError("Owned native/NVDA ready-file watchdog")


def create_portable(base, run, addon, endpoint):
    if base.existing_nvda_processes():raise RuntimeError("Existing unrelated NVDA present; no replacement attempted")
    config=run/"config";config.mkdir()
    installer=base.verified_installer(run.parent/"nvda_2026.3.1.exe")
    portable=run/"portable"
    command=[str(installer),"--create-portable-silent","--portable-path="+str(portable),
        "--config-path="+str(config),"--no-sr-flag","--minimal","--log-file="+str(run/"bootstrap.log")]
    with (run/"bootstrap-console.log").open("wb") as log:
        process=subprocess.Popen(command,cwd=run,stdout=log,stderr=subprocess.STDOUT)
        try:base.wait_process(process,240)
        finally:base.stop_owned(process)
    image=portable/"nvda.exe"
    if not image.is_file():raise RuntimeError("Pinned official NVDA portable image missing")
    base.extract_addon(addon,config/"addons"/base.addon_name(addon))
    (config/"nvda.ini").write_text('[general]\nshowWelcomeDialog=False\naskToExit=False\nsaveConfigurationOnExit=False\nplayStartAndExitSounds=False\nlanguage=en\n[update]\nautoCheck=False\nstartupNotification=False\n[speech]\nsynth=silence\n[audio]\noutputDevice='+endpoint+'\n',encoding="utf-8")
    return image,config


def run_nvda(args, output_device, owned_instance, report):
    base=module("_owned_nvda_capture_base",Path(__file__).with_name("windows_nvda_probe.py"))
    import process_loopback_guard as guard
    build=guard.verify_build(args.helper,args.helper_build_receipt,Path(__file__).with_name("windows_nvda_process_capture.cpp"))
    build_doc=read_json(args.helper_build_receipt)
    if (build_doc.get("purpose")!="owned-nvda-sibling-capture"
            or build_doc.get("included_marker_source_sha256")!=FROZEN_MARKER_CPP_SHA
            or digest(Path(__file__).with_name("windows_process_loopback.cpp"))!=FROZEN_MARKER_CPP_SHA):
        raise ValueError("Capture helper does not include exact frozen reviewed marker primitives")
    report["helper_build"]=build
    nonce=uuid.uuid4().hex;run=args.output/("nvda-"+nonce);run.mkdir()
    image,config=create_portable(base,run,args.addon,output_device)
    image_sha=digest(image)
    probe=config/"addons/dordiaiCaptureProbe";plugins=probe/"globalPlugins";plugins.mkdir(parents=True)
    (probe/"manifest.ini").write_text('name="dordiaiCaptureProbe"\nsummary="Owned NVDA capture proof"\nversion="1.0.0"\nauthor="dordiai-voices"\nminimumNVDAVersion="2026.1"\nlastTestedNVDAVersion="2026.3.1"\n',encoding="utf-8")
    # Suspend launch until the plugin's exact Popen pid is written. Windows
    # CREATE_SUSPENDED is deliberately avoided: the plugin waits for this lease.
    settings={"root":str(run),"config":str(config.resolve()),"probe_id":nonce,"controller_pid":os.getpid(),
        "phrase":PHRASE,"output_device":output_device}
    plugin=plugins/"dordiaiCaptureProbe.py"
    # The complete immutable settings file is published immediately after launch;
    # the plugin reads it in begin(), before any synthesizer selection/request.
    plugin.write_text(PLUGIN_CODE.replace('SETTINGS=__SETTINGS__','SETTINGS='+repr(settings)),encoding="utf-8")
    nvda=None;helper=None;helper_stdout="";helper_stderr=""
    try:
        with (run/"nvda-console.log").open("wb") as console:
            nvda=subprocess.Popen([str(image),"--config-path="+str(config),"--log-file="+str(run/"nvda.log"),
                "--debug-logging","--no-sr-flag","--minimal","--lang=en"],cwd=image.parent,
                stdout=console,stderr=subprocess.STDOUT)
            publish(run/"owned-launch.json",{"pid_expected":nvda.pid,"probe_id":nonce})
            # The plugin reads the sibling controller launch lease; no source
            # file changes or PID patching occurs after NVDA has started.
            ready=wait_file(run/"plugin-ready.json",[nvda],180,failed_file=run/"plugin-complete.json")
            rate=validate_ready(ready,nvda_pid=nvda.pid,controller_pid=os.getpid(),nonce=nonce,config=config.resolve(),image_sha=image_sha)
            ready_sha=digest(run/"plugin-ready.json")
            capture=run/"process-capture"
            command=[str(args.helper),"--owned-nvda-pid",str(nvda.pid),"--controller-pid",str(os.getpid()),
                "--owned-run-root",str(run),"--probe-id",nonce,"--nvda-image-sha256",image_sha,
                "--plugin-ready-sha256",ready_sha,"--sample-rate",str(rate),"--seconds","10",
                "--output",str(capture),"--owned-instance-id",owned_instance]
            helper=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            capture_ready=wait_file(capture/"ready.json",[nvda,helper],7)
            if (capture_ready.get("status")!="capture-started" or capture_ready.get("target_pid")!=nvda.pid
                    or capture_ready.get("helper_pid")!=helper.pid or capture_ready.get("controller_pid")!=os.getpid()):
                raise ValueError("Native capture-start receipt does not bind exact owned siblings")
            publish(run/"capture-trigger.json",{"probe_id":nonce,"phrase":PHRASE})
            try:helper_stdout,helper_stderr=helper.communicate(timeout=13)
            except subprocess.TimeoutExpired:
                helper.kill();helper.communicate();raise RuntimeError("Exact owned capture helper watchdog; helper killed and reaped")
            if len(helper_stdout)>65536 or len(helper_stderr)>65536:raise ValueError("Capture helper metadata output exceeded quota")
            report["capture_helper"]={"pid":helper.pid,"returncode":helper.returncode,"stdout":helper_stdout,"stderr":helper_stderr}
            native=read_json(capture/"capture.json")
            if helper.returncode:raise RuntimeError("Actual owned capture helper failed: "+str(native.get("reason")))
            validate_capture(native,nvda_pid=nvda.pid,controller_pid=os.getpid(),helper_pid=helper.pid,image_sha=image_sha,ready_sha=ready_sha,sample_rate=rate)
            result=read_json(run/"plugin-complete.json")
            if (result.get("status")!="passed-real-waveplayer-phrase" or result.get("pid")!=nvda.pid
                    or result.get("probe_id")!=nonce or result.get("requested_phrase")!=PHRASE
                    or result.get("recording_pcm_sink_test_double") is not False or result.get("sample_rate")!=rate
                    or result.get("driver_error") is not None):
                raise ValueError("Actual known phrase did not complete through genuine WavePlayer")
            reference=read_pcm(run/"phrase-reference.pcm",result["reference_pcm"])
            captured=read_pcm(capture/"captured.pcm",native["captured_pcm"])
            correlation=correlate_phrase(reference,captured,rate)
            publish(run/"correlation.json",correlation)
            report.update(status="phrase-correlated" if correlation["virtual_audio_verified"] else "phrase-not-correlated",
                core_sha256=args.addon_sha256,official_installer_sha256=base.NVDA_SHA256,
                official_nvda_image_sha256=image_sha,run_directory=str(run),phrase=PHRASE,
                actual_nvda_pid=nvda.pid,controller_pid=os.getpid(),capture_helper_pid=helper.pid,
                wave_player_verified=True,requested_phrase_waveform_match_verified=correlation["requested_phrase_waveform_match_verified"],
                virtual_audio_verified=correlation["virtual_audio_verified"],correlation=correlation)
            publish(run/"stop.json",{"probe_id":nonce})
            try:nvda.wait(timeout=20)
            except subprocess.TimeoutExpired:base.stop_owned(nvda)
    finally:
        if helper is not None:
            if helper.poll() is None:helper.kill()
            final_stdout,final_stderr=helper.communicate()
            # Preserve failures before the native ready file as well as normal
            # completion. Always drain/reap/close this exact helper's pipes.
            report.setdefault("capture_helper",{"pid":helper.pid,"returncode":helper.returncode,
                "stdout":final_stdout[-8192:],"stderr":final_stderr[-8192:]})
        base.stop_owned(nvda)
        report["owned_helper_reaped"]=helper is None or helper.poll() is not None
        report["owned_nvda_reaped"]=nvda is None or nvda.poll() is not None


def run(args):
    import windows_virtual_audio_trial as device
    import process_loopback_guard as guard
    report={"format":"dordiai-owned-real-nvda-process-capture","format_version":1,"status":"failed",
        "recording_pcm_sink_test_double":False,"physical_audio_verified":False,"acoustic_latency_verified":False,
        "virtual_audio_verified":False,"requested_phrase_waveform_match_verified":False,"wave_player_verified":False,
        "native_pronunciation_verified":False,"product_ready":False,"microphone_capture_used":False,
        "privacy_settings_changed":False,"default_device_changed":False,"security_settings_changed":False,"reboot_performed":False}
    created=False
    try:
        if not args.ephemeral_ci:raise device.TrialBlocked("Explicit owned CI scope required")
        device.guard_environment(os.environ,args.package,args.output)
        if args.output.exists():raise ValueError("Fresh owned evidence output required")
        if (args.addon.is_symlink() or args.addon.stat().st_size!=args.addon_bytes
                or not re.fullmatch(r"[a-f0-9]{64}",args.addon_sha256) or digest(args.addon)!=args.addon_sha256):
            raise ValueError("Exact caller-pinned immutable addon bytes differ")
        args.output.mkdir();created=True
        report["verification"]=device.verify_package(args.package,args.validation)
        report["endpoints_before"]=device.endpoints()
        pnp=device.WindowsPnP()
        with pnp.owned_device(args.package/"vbMmeCable64_win10.inf",report):
            deadline=time.monotonic()+20
            while True:
                during=device.endpoints();render,_=device.select_new_vendor_endpoints(report["endpoints_before"],during)
                if render:break
                if time.monotonic()>deadline:raise RuntimeError("No unique new owned render endpoint")
                time.sleep(.25)
            # Resolve exact CoreAudio endpoint identity using the independently
            # accepted frozen marker helper, without starting any capture.
            guard.verify_build(args.marker_helper,args.marker_build_receipt,Path(__file__).with_name("windows_process_loopback.cpp"))
            described=guard.own_child([str(args.marker_helper),"--describe-native-format","--render-name",render["name"],
                "--owned-instance-id",report["owned_instance_id"]],8)
            if described.returncode:raise RuntimeError("Exact native endpoint identity resolution failed")
            endpoint=json.loads(described.stdout)["selected_endpoint"];report["selected_endpoint"]=endpoint
            run_nvda(args,endpoint["id"],report["owned_instance_id"],report)
    except Exception as error:
        report.update(status="failed",error=type(error).__name__+": "+str(error))
    finally:
        if report.get("cleanup",{}).get("attempted") and report["cleanup"].get("removed") is not True:
            report.update(status="failed",error="Exact owned PnP device absence was not verified")
        if created:publish(args.output/"nvda-process-capture.json",report)
        print("OWNED_NVDA_PROCESS_CAPTURE "+json.dumps(report),flush=True)
    return 0 if report["status"]=="phrase-correlated" else 1


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ("package","validation","output","addon","helper","helper-build-receipt","marker-helper","marker-build-receipt"):
        parser.add_argument("--"+name,required=True,type=Path)
    parser.add_argument("--addon-sha256",default=CORE11_SHA)
    parser.add_argument("--addon-bytes",type=int,default=CORE11_BYTES)
    parser.add_argument("--ephemeral-ci",action="store_true")
    args=parser.parse_args()
    if not 0<args.addon_bytes<=3_000_000_000:parser.error("Bounded immutable core size required")
    return run(args)


if __name__=="__main__":raise SystemExit(main())
