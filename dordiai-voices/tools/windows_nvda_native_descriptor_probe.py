"""Genuine installed descriptor-integrity fallback; owned copied resource only."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

DESCRIPTOR_SHA256="2de5611c384e933e19d1cdf5fda37f17bd5c4b7602d09964f53fdb7280877459"
DESCRIPTOR_RELATIVE=Path("kx47Runtime/models/WordLanguage/native-word-membership.json")
PROBE_FUNCTION="\nNATIVE_DESCRIPTOR_FAULT=__OWNED_DESCRIPTOR_SPEC__\n\n\ndef start_native_descriptor_corruption_probe():\n    global STAGE,RECOVERY_ORIGINAL_WAVE_FACTORY,REQUIRED_RESOURCE_ORIGINAL_UI_MESSAGE\n    import base64\n    import config\n    import hashlib\n    import nvwave\n    import speech\n    import ui\n    from speech.commands import IndexCommand\n    STAGE=\"native_descriptor_corruption\"\n    RESULT[\"scope\"]=\"actual-installed-native-descriptor-integrity-fallback-proof\"\n    RESULT[\"normal_performance_benchmark_skipped\"]=True\n    manager=sys.modules.get(\"_dordiai_main_native_membership_runtime\")\n    resource=manager._resource if manager is not None else None\n    target=resource.descriptor if resource is not None else None\n    spec=NATIVE_DESCRIPTOR_FAULT\n    from pathlib import Path\n    driver_module=sys.modules[type(DRIVER).__module__]\n    expected_path=driver_module._host_paths.filesystem_path(Path(spec[\"path\"]).absolute())\n    same_target=(target is not None and target.samefile(expected_path))\n    if (not same_target or not resource.enabled or resource.closed or\n            synthDriverHandler.getSynth() is not DRIVER):\n        check(STAGE,\"failed\",reason=\"Owned installed descriptor/resource identity is not active\")\n        finish()\n        return\n    raw=target.read_bytes()\n    if len(raw)!=558 or hashlib.sha256(raw).hexdigest()!=spec[\"sha256\"]:\n        raise ValueError(\"Owned descriptor was not the pinned original before corruption\")\n    row=RESULT[\"native_descriptor_recovery\"]={\n        \"scope\":\"Actual copied installed558B descriptor mutation; genuine planner resource error and eSpeak fallback\",\n        \"configured_synth_before\":config.conf[\"speech\"][\"synth\"],\n        \"descriptor_sha256_before\":spec[\"sha256\"],\"descriptor_bytes_before\":len(raw),\n        \"original_resource_enabled\":resource.enabled,\n        \"synthetic_exception_injected\":False,\"production_archive_modified\":False,\n        \"mapped_binary_modified_or_renamed\":False,\"physical_audio_verified\":False,\n        \"acoustic_latency_verified\":False,\"pronunciation_verified\":False,\n        \"recording_pcm_sink_test_double\":bool(SETTINGS.get(\"headless_ui_probe\")),\n        \"notice_request_observed\":False,\n        \"restoration_owner\":\"Controller finally after its owned NVDA process has stopped\",\n    }\n    RECOVERY_ORIGINAL_WAVE_FACTORY=nvwave.WavePlayer\n    def create_observed_output(*args,**kwargs):\n        player=(RecordingPCMSink(*args,**kwargs) if SETTINGS.get(\"headless_ui_probe\")\n                else RECOVERY_ORIGINAL_WAVE_FACTORY(*args,**kwargs))\n        counter=RecordingPCMSink(1,24000,16)\n        RECOVERY_OUTPUTS.append(counter)\n        original_feed=player.feed\n        def notice_feed(data,size=None,onDone=None):\n            result=original_feed(data,size=size,onDone=onDone)\n            if row[\"notice_request_observed\"]:\n                counter.feed(data,size=size)\n            return result\n        player.feed=notice_feed\n        return player\n    nvwave.WavePlayer=create_observed_output\n    REQUIRED_RESOURCE_ORIGINAL_UI_MESSAGE=ui.message\n    def notice(text,*args,**kwargs):\n        active=synthDriverHandler.getSynth()\n        if (isinstance(text,str) and text.startswith(\"Не вдалося прочитати словник української та російської мов dordiai-voices.\") and\n                getattr(active,\"name\",None)==\"espeak\"):\n            row.update(notice_request_observed=True,notice_request_synth=active.name,\n                       notice_request_ns=time.perf_counter_ns())\n        return REQUIRED_RESOURCE_ORIGINAL_UI_MESSAGE(text,*args,**kwargs)\n    ui.message=notice\n    speech.setSpeechMode(speech.SpeechMode.talk)\n    DRIVER.cancel()\n    DRIVER._dordiai_last_error=None\n    DRIVER._dordiai_last_error_details=None\n    # Only a controller-owned copied558B plain JSON descriptor is altered.\n    # The active mapped18MB binary is never renamed, changed or replaced.\n    corrupted=b\"X\"+raw[1:]\n    target.write_bytes(corrupted)\n    row[\"descriptor_sha256_after\"]=hashlib.sha256(target.read_bytes()).hexdigest()\n    row[\"descriptor_corrupted\"]=row[\"descriptor_sha256_after\"]==spec[\"corrupt_sha256\"]\n    row[\"request_started_ns\"]=time.perf_counter_ns()\n    # A genuine normal driver request reaches its planner's resource validation.\n    # No direct manager exception call or _dordiai_report_error injection.\n    DRIVER.speak([NATIVE_SOURCE_CASES[0][\"word\"]+\" \"+NATIVE_SOURCE_CASES[32][\"word\"],IndexCommand(889911)])\n    save()\n    later(100,lambda:observe_native_descriptor_recovery(resource,time.monotonic()+90))\n\n\ndef observe_native_descriptor_recovery(resource,deadline):\n    import config\n    import hashlib\n    row=RESULT[\"native_descriptor_recovery\"]\n    active=synthDriverHandler.getSynth()\n    details=getattr(DRIVER,\"_dordiai_last_error_details\",None)\n    recovery=dict(details.get(\"recovery\",{})) if isinstance(details,dict) else {}\n    row.update(diagnostics=details,recovery=recovery,active_synth=getattr(active,\"name\",None),\n        active_driver_module=type(active).__module__ if active is not None else None,\n        configured_synth_preserved=config.conf[\"speech\"][\"synth\"]==row[\"configured_synth_before\"],\n        old_driver_closed=bool(getattr(DRIVER,\"_closed\",False)),\n        old_driver_thread_stopped=not DRIVER._thread.is_alive(),\n        native_resource_closed=bool(resource.closed),\n        native_mapping_reader_released=resource.reader is None,\n        notice_pcm_bytes=sum(sink.submitted_bytes for sink in RECOVERY_OUTPUTS),\n        notice_pcm_nonzero_bytes=sum(sink.nonzero_bytes for sink in RECOVERY_OUTPUTS))\n    passed=(row.get(\"descriptor_corrupted\") is True and isinstance(details,dict) and\n        details.get(\"required_resource_kind\")==\"native-word-membership\" and\n        row[\"active_synth\"]==\"espeak\" and row[\"active_driver_module\"]==\"synthDrivers.espeak\" and\n        row[\"configured_synth_preserved\"] and row[\"old_driver_closed\"] and row[\"old_driver_thread_stopped\"] and\n        row[\"native_resource_closed\"] and row[\"native_mapping_reader_released\"] and\n        recovery.get(\"reason\")==\"native-word-membership-unavailable\" and\n        recovery.get(\"state\")==\"builtin-espeak-selected\" and recovery.get(\"espeak_selection_succeeded\") is True and\n        row[\"notice_request_observed\"] and row.get(\"notice_request_synth\")==\"espeak\" and\n        row[\"notice_pcm_nonzero_bytes\"]>0)\n    if not passed and time.monotonic()<deadline:\n        save()\n        later(100,lambda:observe_native_descriptor_recovery(resource,deadline))\n        return\n    row[\"elapsed_ms\"]=(time.perf_counter_ns()-row[\"request_started_ns\"])/1000000.0\n    check(\"native_descriptor_genuine_integrity_recovery\",\"passed\" if passed else \"failed\",observations=row)\n    restore_recovery_output_factory()\n    finish()\n\n"
BRANCH='    later(500, start_required_resource_recovery_probe if SETTINGS.get("required_resource_recovery_probe") else\n          start_actual_typing_probe if SETTINGS.get("typing_probe") else start_phrase)\n'


def controller_module(name,filename):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename))
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def arm_owned_fault(base,owned):
    if base.PROBE_PLUGIN.count(BRANCH)!=1:
        raise ValueError("NVDA post-settings stage changed")
    target=owned/"kx47Runtime/models/WordLanguage/native-word-membership.json"
    raw=target.read_bytes()
    if target.is_symlink() or len(raw)!=558 or hashlib.sha256(raw).hexdigest()!=DESCRIPTOR_SHA256:
        raise ValueError("Copied native descriptor is not the exact pinned558B resource")
    mutated=b"X"+raw[1:]
    spec={"path":str(target),"sha256":DESCRIPTOR_SHA256,
          "corrupt_sha256":hashlib.sha256(mutated).hexdigest()}
    candidate=base.PROBE_PLUGIN.replace(BRANCH,'    later(500,start_native_descriptor_corruption_probe)\n',1)
    candidate+=PROBE_FUNCTION.replace("__OWNED_DESCRIPTOR_SPEC__",repr(spec))
    compile(candidate.replace("__PROBE_SETTINGS__","{}").replace("__NATIVE_IMPORT_DIAGNOSTIC__",repr("")),"owned-native-descriptor-integrity-probe","exec")
    base.PROBE_PLUGIN=candidate
    return {"path":target,"original":raw,"corrupt":mutated}


def restore_owned_descriptor(context):
    target=context["path"]
    if target.is_symlink() or target.read_bytes() not in (context["original"],context["corrupt"]):
        raise ValueError("Owned descriptor changed outside exact probe mutations")
    temporary=target.with_name(target.name+".restore-probe")
    with temporary.open("xb") as stream:
        stream.write(context["original"])
    temporary.replace(target)
    restored=target.read_bytes()
    if restored!=context["original"] or hashlib.sha256(restored).hexdigest()!=DESCRIPTOR_SHA256:
        raise ValueError("Owned descriptor restoration differs")
    return {"status":"passed","sha256":DESCRIPTOR_SHA256,"bytes":len(restored),
            "scope":"Owned copied descriptor restored only after owned NVDA shutdown",
            "mapped_binary_modified_or_renamed":False}


def main(argv=None):
    arguments=list(sys.argv[1:] if argv is None else argv)
    parser=argparse.ArgumentParser(add_help=False)
    parser.add_argument("--output",type=Path,required=True)
    selected,unused=parser.parse_known_args(arguments)
    if any(flag in arguments for flag in ("--typing-probe","--required-resource-recovery-probe","--fatal-recovery-probe")):
        raise ValueError("Descriptor corruption must run in its own fresh NVDA process")
    base=controller_module("_dordiai_descriptor_fault_base","windows_nvda_probe.py")
    integration=controller_module("_dordiai_descriptor_readonly","windows_nvda_membership_integration_probe.py")
    integration.install_membership_observer(base)
    original_extract=base.extract_addon
    context=None
    def extract(addon,destination):
        nonlocal context
        owned=original_extract(addon,destination)
        context=arm_owned_fault(base,owned)
        return owned
    base.extract_addon=extract
    actual_subprocess=base.subprocess
    owned_processes=[]
    class ObservedSubprocess:
        def __getattr__(self,name):
            return getattr(actual_subprocess,name)
        def Popen(self,*args,**kwargs):
            process=actual_subprocess.Popen(*args,**kwargs)
            owned_processes.append(process)
            return process
    base.subprocess=ObservedSubprocess()
    result=1
    cleanup={"status":"not-armed"}
    try:
        result=base.main(arguments)
    finally:
        # base.main has already stopped only its owned NVDA Popen tree.
        if context is not None:
            try:
                if any(process.poll() is None for process in owned_processes):
                    raise RuntimeError("Owned NVDA process is still active; descriptor restoration deferred")
                cleanup=restore_owned_descriptor(context)
            except Exception as error:
                cleanup={"status":"failed","error_type":type(error).__name__}
                result=1
        selected.output.mkdir(parents=True,exist_ok=True)
        (selected.output/"native-descriptor-restoration.json").write_text(json.dumps(cleanup,indent=2)+"\n",encoding="utf-8")
        print("NATIVE_DESCRIPTOR_RESTORATION "+json.dumps(cleanup),flush=True)
    return result


if __name__=="__main__":
    raise SystemExit(main())
