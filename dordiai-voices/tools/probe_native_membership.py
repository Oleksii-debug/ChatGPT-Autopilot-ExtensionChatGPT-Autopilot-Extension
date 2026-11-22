"""Measure real finite-dictionary lookup in a fresh stdlib-only host process.

These are membership I/O/parser timings, never speech, keyboard, audio-device,
pronunciation or neural-model acceptance. A cold instance does not imply an
evicted operating-system file cache.
"""
from __future__ import annotations
import argparse
import ctypes
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import sys
import time
import unicodedata

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("_dordiai_real_native_membership_probe",
    ROOT/"source/0.12.2/kx47Runtime/native_word_membership.py")
runtime=importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def memory_snapshot():
    if os.name=="nt":
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_=[("cb",wintypes.DWORD),("PageFaultCount",wintypes.DWORD),
                ("PeakWorkingSetSize",ctypes.c_size_t),("WorkingSetSize",ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage",ctypes.c_size_t),("QuotaPagedPoolUsage",ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage",ctypes.c_size_t),("QuotaNonPagedPoolUsage",ctypes.c_size_t),
                ("PagefileUsage",ctypes.c_size_t),("PeakPagefileUsage",ctypes.c_size_t),
                ("PrivateUsage",ctypes.c_size_t)]
        kernel=ctypes.WinDLL("kernel32",use_last_error=True)
        psapi=ctypes.WinDLL("psapi",use_last_error=True)
        kernel.GetCurrentProcess.argtypes=[]
        kernel.GetCurrentProcess.restype=wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes=[wintypes.HANDLE,ctypes.POINTER(Counters),wintypes.DWORD]
        psapi.GetProcessMemoryInfo.restype=wintypes.BOOL
        value=Counters()
        value.cb=ctypes.sizeof(value)
        if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(),ctypes.byref(value),value.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        return {"working_set_bytes":int(value.WorkingSetSize),"peak_working_set_bytes":int(value.PeakWorkingSetSize),
                "private_bytes":int(value.PrivateUsage),"accessor":"Windows GetProcessMemoryInfo"}
    try:
        pages=Path("/proc/self/statm").read_text(encoding="ascii").split()
        import resource
        return {"working_set_bytes":int(pages[1])*os.sysconf("SC_PAGE_SIZE"),
                "peak_working_set_bytes":int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)*1024,
                "accessor":"Linux proc/self/statm plus getrusage maxrss"}
    except (OSError,ImportError,IndexError):
        return {"accessor":"unavailable","working_set_bytes":None}


def percentiles(values):
    if not values:
        return None
    ordered=sorted(values)
    return {"count":len(values),"minimum_ms":ordered[0],
        "median_ms":(ordered[(len(ordered)-1)//2]+ordered[len(ordered)//2])/2,
        "p95_ms":ordered[max(0,math.ceil(len(ordered)*.95)-1)],
        "p99_ms":ordered[max(0,math.ceil(len(ordered)*.99)-1)],
        "maximum_ms":ordered[-1]}


def queries_from_source(report):
    if report.get("format")!="dordiai-primary-native-word-membership" or report.get("status")!="source-membership-acquired":
        raise ValueError("No actual completed source acquisition receipt")
    values={}
    for rows in report.get("non_initial_forms_not_in_frequency_sample",{}).values():
        for row in rows:
            values[row["word"]]=frozenset(row["memberships"])
    for word in report.get("ambiguous_membership_sample",[]):
        values[word]=frozenset(("uk","ru"))
    if len(values)<32:
        raise ValueError("Insufficient actual source-wide sample evidence")
    # Invalid-token negative control is explicitly not a natural-language accuracy sample.
    values["invalid control with spaces"]=frozenset()
    return sorted(values.items())


def probe(lexicon_path,digest,source_report,*,repeats=100,opens=5):
    if not 1<=repeats<=200 or not 1<=opens<=20:
        raise ValueError("Benchmark work must remain bounded")
    queries=queries_from_source(source_report)
    cold_word,cold_expected=next((word,expected) for word,expected in queries if expected)
    before=memory_snapshot()
    open_times=[]
    cold_first=[]
    for _ in range(opens):
        start=time.perf_counter_ns()
        with runtime.MembershipLexicon(lexicon_path,digest) as lexicon:
            open_times.append((time.perf_counter_ns()-start)/1000000)
            tick=time.perf_counter_ns()
            actual=lexicon.candidates(cold_word)
            cold_first.append((time.perf_counter_ns()-tick)/1000000)
            if actual!=cold_expected:
                raise ValueError("Fresh instance source membership differs")
    times,first_pass=[],[]
    with runtime.MembershipLexicon(lexicon_path,digest) as lexicon:
        after_open=memory_snapshot()
        for word,expected in queries:
            start=time.perf_counter_ns()
            actual=lexicon.candidates(word)
            first_pass.append((time.perf_counter_ns()-start)/1000000)
            if actual!=expected:
                raise ValueError("Real primary-source membership differs")
        for _ in range(repeats):
            for word,expected in queries:
                start=time.perf_counter_ns()
                actual=lexicon.candidates(word)
                times.append((time.perf_counter_ns()-start)/1000000)
                if actual!=expected:
                    raise ValueError("Repeated primary-source membership differs")
        statistics=lexicon.statistics()
        after_queries=memory_snapshot()
        if (statistics["cached_blocks"]>statistics["cache_block_limit"] or
                statistics["cache_bytes_charged"]>statistics["cache_byte_limit"]):
            raise ValueError("Actual lookup cache exceeded its bound")
    forbidden=[name for name in ("numpy","torch","marisa_trie","pymorphy3","dawg_python") if name in sys.modules]
    if forbidden:
        raise ValueError("A private/model/build extension contaminated the host lookup probe")
    return {"format":"dordiai-actual-native-membership-host-probe","format_version":1,
        "status":"passed-exact-finite-lookup","platform":platform.platform(),"python":sys.version,
        "unicode_version":unicodedata.unidata_version,"artifact_sha256":digest,
        "scope":"Actual stdlib dictionary lookup, including file identity checks; no speech/NVDA/acoustic claim",
        "cold_scope":"New reader/mmap instance, full SHA256 verification; OS file cache not evicted",
        "query_scope":"Source-wide SHA-selected inflected forms absent frequency lexicon, shared native spellings, one invalid-token negative control",
        "source_sample_count":len(queries)-1,"repeats":repeats,"statistics":statistics,
        "instance_open_ms":open_times,"instance_open_summary":percentiles(open_times),
        "new_instance_first_lookup_word":cold_word,"new_instance_first_lookup_ms":cold_first,"new_instance_first_lookup_summary":percentiles(cold_first),
        "first_pass_ms":first_pass,"first_pass_summary":percentiles(first_pass),
        "resident_lookup_ms":times,"resident_lookup_summary":percentiles(times),
        "memory_before":before,"memory_after_open":after_open,"memory_after_queries":after_queries,
        "working_set_increase_bytes":(after_queries["working_set_bytes"]-before["working_set_bytes"]
            if before.get("working_set_bytes") is not None and after_queries.get("working_set_bytes") is not None else None),
        "decoded_cache_accounting_is_process_ram":False,
        "memory_scope":"OS working set includes file-backed mmap pages and stdlib interpreter; cache charge is a conservative software bound, not a total-RAM measurement",
        "third_party_extensions_required":False,"private_python_abi_extensions_required":False,"per_word_network":False,"nvda_verified":False,
        "physical_audio_verified":False,"pronunciation_verified":False,
        "author_intent_language_identification_infallible":False}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lexicon",type=Path,required=True)
    parser.add_argument("--sha256",required=True)
    parser.add_argument("--source-report",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--repeats",type=int,default=100)
    args=parser.parse_args(argv)
    source=json.loads(args.source_report.read_text(encoding="utf-8"))
    report=probe(args.lexicon,args.sha256,source,repeats=args.repeats)
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({key:report[key] for key in ("status","platform","python","instance_open_summary",
        "first_pass_summary","resident_lookup_summary","working_set_increase_bytes","statistics",
        "nvda_verified","physical_audio_verified")},ensure_ascii=True),flush=True)
    return 0


if __name__=="__main__":
    raise SystemExit(main())
