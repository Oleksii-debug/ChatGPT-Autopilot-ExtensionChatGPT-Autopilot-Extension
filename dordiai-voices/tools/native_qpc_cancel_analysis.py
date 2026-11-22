"""Separate native-packet-QPC cancel diagnostics; existing strict gates unchanged.

GetBuffer first-frame QPC is already in100ns units. Raw public-cancel QPC is
converted exactly once using its own recorded frequency. This pure offline
analysis never substitutes positions/frame counters, modifies audio, or runs NVDA.
"""
from __future__ import annotations
import argparse
from collections import Counter
from fractions import Fraction
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath

import numpy as np

HNS = 10_000_000
SOURCES = [
    {"name":"baseline-12-24-32","run_id":45061544904,"artifact_id":14770561254,"zip_bytes":30299443,
     "zip_sha256":"a9005dbf902ca92402044d8b4754c0ab32da863208a075c9baa68d1d09808258",
     "directory":"source13-prefetch-45061544904","zip":"source13-prefetch-45061544904.zip"},
    {"name":"extended-32-64-128","run_id":45064826804,"artifact_id":14771821304,"zip_bytes":30172616,
     "zip_sha256":"49e09fb53aabb45b0610f45131ec9dee50889e9c68ec76d9570e2ba0e42befae",
     "directory":"source13-prefetch-extended-45064826804","zip":"source13-prefetch-extended-45064826804.zip"}]
OFFICIAL_SOURCES = {
    "GetBuffer":"https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudiocaptureclient-getbuffer",
    "flags":"https://learn.microsoft.com/en-us/windows/win32/api/audioclient/ne-audioclient-_audclnt_bufferflags",
    "process_loopback":"https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/"}


def sha(data): return hashlib.sha256(data).hexdigest()
def integer(value, name, positive=False):
    if type(value) is not int or value < int(positive) or value >= 2**64: raise ValueError("Invalid exact integer: "+name)
    return value
def load(path): return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def cancel_bracket(clock, native_frequency):
    keys=("qpc_frequency","qpc_before_cancel","qpc_after_cancel","perf_before_cancel_ns","perf_after_cancel_ns")
    for key in keys: integer(clock.get(key),key,positive=True)
    frequency=clock["qpc_frequency"]
    if frequency != native_frequency: raise ValueError("Capture/public-cancel frequencies differ")
    before=Fraction(clock["qpc_before_cancel"]*HNS,frequency)
    after=Fraction(clock["qpc_after_cancel"]*HNS,frequency)
    if (after<before or clock["perf_before_cancel_ns"]>before*100 or after*100>clock["perf_after_cancel_ns"]):
        raise ValueError("Public-cancel QPC/perf bracket invalid or inconsistent")
    return before,after


def analyze_cancel(native, raw, clock):
    f=native.get("native_format",{});rate=f.get("sample_rate")
    if (rate not in (22050,24000,48000) or type(rate) is not int or f.get("channels")!=1
            or f.get("bits_per_sample")!=16 or f.get("block_align")!=2 or f.get("native_encoding")!="pcm16le"):
        raise ValueError("Exact supported mono PCM16 native format required")
    if not raw or len(raw)%2 or len(raw)>rate*2*10: raise ValueError("Full bounded aligned capture required")
    if (native.get("captured_bytes")!=len(raw) or native.get("captured_frames")!=len(raw)//2
            or native.get("captured_pcm",{}).get("size_bytes")!=len(raw) or native["captured_pcm"].get("sha256")!=sha(raw)):
        raise ValueError("Full captured PCM identity/size/frame metadata differs")
    frequency=integer(native.get("qpc_frequency"),"native QPC frequency",True)
    start_low=integer(native.get("qpc_before_capture_start"),"before capture",True)
    start_high=integer(native.get("qpc_after_capture_start"),"after capture",True)
    if start_high<start_low: raise ValueError("Capture start bracket invalid")
    cancel_low,cancel_high=cancel_bracket(clock,frequency)
    packets=native.get("packets")
    if not isinstance(packets,list) or not 1<=len(packets)<=32768: raise ValueError("Complete bounded native packet metadata required")
    signal=np.frombuffer(raw,dtype="<i2").astype(np.float64)/32768.
    total=0;previous=None;last=None;active_before=False;active_windows=0;maximum_step_error=Fraction(0)
    rms_window=max(1,int(rate*.010));all_positions=[]
    for index,row in enumerate(packets):
        for key in ("frames","retained_frames","retained_offset_frames","flags","device_position_frames","qpc_position_100ns","observed_qpc_ticks"):
            integer(row.get(key),"packet "+key)
        frames=row["frames"]
        if not 0<frames<=384000 or row["retained_frames"]!=frames or row["retained_offset_frames"]!=total:
            raise ValueError("Missing, trimmed, reordered or incomplete retained packet data")
        flags=row["flags"]
        if flags&~7 or flags&5: raise ValueError("Timestamp error/discontinuity/unknown flag rejects QPC precision")
        qpc=row["qpc_position_100ns"]
        observed=Fraction(row["observed_qpc_ticks"]*HNS,frequency)
        if qpc<=0 or qpc>observed or qpc<Fraction(start_low*HNS,frequency):
            raise ValueError("Missing/future/pre-start native packet timestamp")
        if previous is not None:
            if qpc<=previous["qpc_position_100ns"] or row["observed_qpc_ticks"]<previous["observed_qpc_ticks"]:
                raise ValueError("Nonmonotonic native timestamps")
            error=abs(Fraction(qpc-previous["qpc_position_100ns"])-Fraction(previous["frames"]*HNS,rate))
            maximum_step_error=max(maximum_step_error,error)
            # At most1 encoded100ns tick rounding; no drift fit/gap allowance.
            if error>1: raise ValueError("Native QPC step does not describe every preceding packet frame")
        chunk=signal[total:total+frames]
        if len(chunk)!=frames or (flags&2 and np.any(chunk)): raise ValueError("PCM missing or SILENT flag/data inconsistent")
        for offset in range(0,frames,rms_window):
            piece=chunk[offset:offset+rms_window]
            low=Fraction(qpc)+Fraction(offset*HNS,rate);high=low+Fraction(len(piece)*HNS,rate)
            if float(np.sqrt(np.mean(piece*piece)))>2/32768:
                last={"packet":index,"offset_in_packet_frames":offset,"window_frames":len(piece),
                      "capture_array_offset_frames":total+offset,"low":low,"high":high}
                active_windows+=1
                if high<cancel_low:active_before=True
        total+=frames;previous=row;all_positions.append(row["device_position_frames"])
    if total!=len(signal): raise ValueError("Full packet frame sum does not equal complete captured PCM")
    first=Fraction(packets[0]["qpc_position_100ns"])
    end=Fraction(packets[-1]["qpc_position_100ns"])+Fraction(packets[-1]["frames"]*HNS,rate)
    if not first<=cancel_low<=cancel_high<=end: raise ValueError("Public cancel bracket outside complete native capture")
    silence=end-max(cancel_high,last["high"] if last else cancel_high)
    available=bool(active_before and last and silence>=5_000_000)
    result={"format":"dordiai-separate-native-packet-QPC-cancel-diagnostic","format_version":1,
            "diagnostic_status":"packet-QPC-software-signal-interval" if available else "open-insufficient-signal-or-post-observation",
            "strict_cancellation_gate_untouched":True,"physical_audio_verified":False,"actual_NVDA_latency_acceptance":False,"product_ready":False,
            "sample_rate":rate,"captured_frames":total,"packets":len(packets),"buffer_flags_counts":dict(Counter(str(r["flags"]) for r in packets)),
            "raw_device_positions_unique":sorted(set(all_positions)),"capture_device_position_axis_available":False,
            "device_positions_or_timestamps_replaced":False,"QPC_conversion_count_for_raw_cancel":1,
            "packet_API_QPC_converted_again":False,"packet_QPC_step_max_error_100ns":float(maximum_step_error),
            "encoded_step_tolerance_100ns":1,"step_tolerance_is_absolute_timestamp_accuracy_guarantee":False,
            "cancel_bracket":clock,"cancel_bracket_width_ms":float((cancel_high-cancel_low)/10000),
            "activity_threshold_pcm_LSB":2,"RMS_window_ms":10,"all_packet_remainders_examined":True,
            "complete_capture_examined":True,"active_windows":active_windows,"active_before_cancel":active_before,
            "post_last_active_or_cancel_observation_ms":float(silence/10000),"software_signal_tail_interval_ms":None}
    if last:
        result["last_active_window"]={k:v for k,v in last.items() if k not in ("low","high")}
        result["last_active_window"]["first_sample_API_QPC_100ns_fraction"]=[last["low"].numerator,last["low"].denominator]
        result["last_active_window"]["end_API_QPC_100ns_fraction"]=[last["high"].numerator,last["high"].denominator]
    if available:
        result["software_signal_tail_interval_ms"]=[float(max(0,last["low"]-cancel_high)/10000),float(max(0,last["high"]-cancel_low)/10000)]
    return result


def verified_index(root):
    root=Path(root).resolve();index=load(root/"evidence-index.json");verified={}
    for row in index["files"]:
        name=row["path"]
        if ("\\" in name or ":" in name or name.startswith("/") or any(x in ("",".","..") for x in name.split("/"))
                or name.casefold() in {key.casefold() for key in verified}): raise ValueError("Unsafe/duplicate evidence index path")
        path=root/PurePosixPath(name)
        if path.is_symlink() or not path.resolve().is_relative_to(root):raise ValueError("Linked/outside evidence path")
        data=path.read_bytes()
        if type(row["bytes"]) is not int or len(data)!=row["bytes"] or sha(data)!=row["sha256"]:raise ValueError("Indexed raw bytes differ: "+name)
        verified[name]={"bytes":len(data),"sha256":sha(data)}
    return verified


def run(project):
    project=Path(project).resolve();rows=[];groups=[]
    strict_file=project/"tools/nvda_longread_analysis.py";strict_bytes=strict_file.read_bytes()
    spec=importlib.util.spec_from_file_location("unchanged_strict_cancel_analysis",strict_file)
    strict=importlib.util.module_from_spec(spec);spec.loader.exec_module(strict)
    for source in SOURCES:
        zip_path=project/"downloads"/source["zip"]
        if zip_path.stat().st_size!=source["zip_bytes"] or sha(zip_path.read_bytes())!=source["zip_sha256"]:raise ValueError("Exact pinned source evidence ZIP differs")
        root=project/"windows-evidence"/source["directory"];index=verified_index(root)
        controller=load(root/"prefetch-trials.json")
        if controller["input_pin"]["archive_sha256"]!="4aed1ba48e8600dcd5f80bac9b85e5a3d7ce09b209c76a4a2873fe7b9960876d":raise ValueError("Immutable source13 input differs")
        groups.append({**source,"indexed_files_verified":len(index),"evidence_index_sha256":sha((root/"evidence-index.json").read_bytes())})
        trials=sorted((p for p in root.glob("nvda-*") if p.is_dir()),key=lambda p:load(p/"trial.json")["ordinal"])
        if len(trials)!=6:raise ValueError("Exact six archived actual trials required")
        for folder in trials:
            native=load(folder/"cancel-capture/capture.json");plugin=load(folder/"plugin-cancel.json");trial=load(folder/"trial.json")
            raw=(folder/"cancel-capture/captured.pcm").read_bytes();old=load(folder/"cancel-analysis.json")
            if (plugin["actual_cancel_api"]!="speech.cancelSpeech" or plugin["pid"]!=native["target_pid"] or plugin["pid"]!=trial["owned_nvda_pid"]
                    or plugin["probe_id"]!=folder.name[5:] or native["ownership"]["same_controller_parent_verified"] is not True
                    or native["ownership"]["target_pid"]!=plugin["pid"] or native["status"]!="technical-owned-nvda-capture-complete"
                    or native["capture_mode"]!="verified-owned-nvda-sibling-include-tree" or native["requested_exclude_mode"] is not False
                    or native["helper_child_processes_created"] is not False or not native["all_own_com_interfaces_released"] or native["cleanup_errors"]):
                raise ValueError("Exact actual owned NVDA public-cancel provenance differs")
            unchanged_result=strict.cancellation_tail(raw,native["native_format"]["sample_rate"],native["packets"],plugin["clock"])
            if unchanged_result!=old or old["gate_status"]!="open":raise ValueError("Existing strict gate/input differs from preserved result")
            try:diagnostic=analyze_cancel(native,raw,plugin["clock"])
            except (ValueError,KeyError,TypeError) as error:diagnostic={"diagnostic_status":"unavailable","reason":str(error),"software_signal_tail_interval_ms":None,"product_ready":False}
            names=("trial.json","plugin-cancel.json","cancel-analysis.json","cancel-capture/capture.json","cancel-capture/captured.pcm","cancel-reference.pcm")
            raw_pins={name:index[folder.name+"/"+name] for name in names}
            rows.append({"experiment":source["name"],"source_run_id":source["run_id"],"folder":folder.name,"ordinal":trial["ordinal"],
                         "pending_count":trial["pending_count"],"owned_nvda_pid":plugin["pid"],"raw_inputs":raw_pins,
                         "old_strict_gate_status":old["gate_status"],"old_strict_result_recomputed_identically":True,"diagnostic":diagnostic})
    if strict_file.read_bytes()!=strict_bytes:raise ValueError("Strict source was modified")
    intervals=[row["diagnostic"]["software_signal_tail_interval_ms"] for row in rows if row["diagnostic"].get("software_signal_tail_interval_ms") is not None]
    return {"format":"dordiai-source13-native-QPC-cancel-diagnostics","format_version":1,"source_groups":groups,"actual_trials":len(rows),"rows":rows,
            "diagnostic_intervals_available":len(intervals),"interval_envelope_ms":[min(x[0] for x in intervals),max(x[1] for x in intervals)] if intervals else None,
            "existing_strict_cancellation_gate_status":"open in all12; not replaced or waived","strict_analysis_source_sha256_unchanged":sha(strict_bytes),
            "official_sources":OFFICIAL_SOURCES,"interpretation_uk":[
                "Це окрема діагностична вісь GetBuffer firstframeQPC+offset/sample_rate проти rawQPC bracket навколо справжнього speech.cancelSpeech. RawQPC конвертується одинраз; packetAPIQPC вже100ns і не конвертується вдруге.",
                "Уся PCM і metadata перевірені по pinnedZIP/index SHA; flags timestamp-error/discontinuity, missing/trimmed packets, не монотонний або frame-inconsistent QPC відхиляються. DevicePosition не підміняється cumulativeframes чиQPC.",
                "Детектор незмінний: RMS10ms >2PCM LSB, усі packet remainder samples; потрібні activitybeforecancel та ≥500ms подальшого спостереження. Дані/сигнал/offsets старих перевірок не редагувались.",
                "Інтервали описують captured signal/process-endpoint software timing; неDAC, не фізичну чутність і не приймання NVDA P95/P99. Дванадцять observations не сертифікують tails.",
                "Strict cancellation_tail залишаєтьсяopen через rawDevicePosition0. Новий аналіз не перетворює старий fail/open наpass і не встановлює продуктготовим. Rawpositions0 спостерігалися й наlocalhardware, тому пояснення лишеCI virtualdriver необґрунтоване."],
            "new_NVDA_or_audio_execution":False,"physical_audible_verified":False,"actual_NVDA_latency_acceptance":False,"P95_P99_acceptance":False,"product_ready":False}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--project",type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output",type=Path,required=True);args=parser.parse_args()
    if args.output.resolve().drive.lower()!="d:":raise ValueError("Evidence output must remain on D")
    result=run(args.project);args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"trials":result["actual_trials"],"diagnostic_intervals":result["diagnostic_intervals_available"],"interval_envelope_ms":result["interval_envelope_ms"],"strict_gate":"open","product_ready":False}))


if __name__=="__main__":main()
