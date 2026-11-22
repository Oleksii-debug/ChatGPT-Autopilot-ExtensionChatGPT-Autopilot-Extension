"""Matched fresh-process exact-word LRU experiment, never NVDA/audio acceptance.

Original source11 leaf, candidate cache0 and bounded candidate default read the
same immutable authenticated DMLX and identical primary-source sample stream.
No operating-system cache eviction or first-use speed improvement is claimed.
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
import subprocess
import sys
import tempfile
import time

BASELINE_GIT_BLOB="0eec65f898977bbd1c1de6561ddbff2014c0eea2"
DATA_SHA256="21208748a50ebf3f5dd3e2feb94f0f3caf3490c2be784aaca2209462380e6689"
SOURCE_SHA256="d7c8157a3cfc44d3e6cce9daf45099fb34c4f5f1e80edfed70a50e6cde2d6199"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream,"sha256").hexdigest()


def module_source(path):
    raw=Path(path).read_bytes()
    if not 0<len(raw)<1024*1024:
        raise ValueError("Reviewed module source exceeds bounds")
    return {"git_blob":hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest(),
            "sha256":hashlib.sha256(raw).hexdigest(),"bytes":len(raw)}


def load_leaf(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def queries(document):
    if document.get("format")!="dordiai-primary-native-word-membership" or document.get("status")!="source-membership-acquired":
        raise ValueError("Authenticated actual acquisition receipt required")
    values={}
    for rows in document.get("non_initial_forms_not_in_frequency_sample",{}).values():
        for row in rows:
            values[row["word"]]=frozenset(row["memberships"])
    for word in document.get("ambiguous_membership_sample",[]):
        values[word]=frozenset(("uk","ru"))
    if len(values)!=96:
        raise ValueError("Expected exact96 actual source samples")
    # This valid-shaped finite-absence control is verified against the
    # authenticated original reader; it is not a claimed language test word.
    values["я"*96]=frozenset()
    return tuple(values.items())


def percentiles(values):
    if not values:
        raise ValueError("No benchmark observations")
    ordered=sorted(values)
    n=len(ordered)
    return {"count":n,"median_ms":(ordered[(n-1)//2]+ordered[n//2])/2,
            "p95_ms":ordered[math.ceil(n*.95)-1],"p99_ms":ordered[math.ceil(n*.99)-1],
            "minimum_ms":ordered[0],"maximum_ms":ordered[-1]}


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


def variant_options(variant):
    if variant=="original":
        return {}
    if variant=="candidate-cache0":
        return {"word_cache_entries":0}
    if variant=="candidate-default":
        return {}
    raise ValueError("Unknown reviewed benchmark variant")


def child(args):
    baseline=module_source(args.baseline_module)
    candidate=module_source(args.candidate_module)
    if baseline["git_blob"]!=BASELINE_GIT_BLOB:
        raise ValueError("Original source11 baseline leaf differs")
    if candidate["git_blob"]!=args.candidate_git_blob:
        raise ValueError("Candidate source differs from reviewed blob")
    source_raw=args.acquisition_report.read_bytes()
    if len(source_raw)>1024*1024 or hashlib.sha256(source_raw).hexdigest()!=SOURCE_SHA256:
        raise ValueError("Primary acquisition receipt differs")
    cases=queries(json.loads(source_raw))
    selected=args.baseline_module if args.child_variant=="original" else args.candidate_module
    module=load_leaf(selected,"_owned_matched_word_cache_"+args.child_variant.replace("-","_"))
    memory_before=memory_snapshot()
    start=time.perf_counter_ns()
    reader=module.MembershipLexicon(args.lexicon,DATA_SHA256,**variant_options(args.child_variant))
    open_ms=(time.perf_counter_ns()-start)/1e6
    try:
        def measure(count):
            durations=[]
            begin=time.perf_counter_ns()
            for index in range(count):
                word,expected=cases[index%len(cases)]
                tick=time.perf_counter_ns()
                actual=reader.candidates(word)
                durations.append((time.perf_counter_ns()-tick)/1e6)
                if actual!=expected:
                    raise ValueError("Actual source membership/control changed")
            return dict(percentiles(durations),total_ms=(time.perf_counter_ns()-begin)/1e6)
        first=measure(len(cases))
        repeated100=measure(100)
        repeated=measure(args.iterations)
        reader.verify_current()
        stats=reader.statistics()
        memory_after=memory_snapshot()
    finally:
        reader.close()
    result={"variant":args.child_variant,"python":sys.version,"platform":platform.platform(),
        "baseline_module":baseline,"candidate_module":candidate,"dataset_sha256":DATA_SHA256,
        "dataset_bytes":args.lexicon.stat().st_size,"source_receipt_sha256":SOURCE_SHA256,
        "source_sample_count":96,"valid_shaped_unknown_control_checked_against_original":True,
        "instance_open_ms":open_ms,"first_pass_97_unique":first,"repeated100":repeated100,
        "repeated":repeated,"statistics":stats,"memory_before":memory_before,"memory_after":memory_after,
        "reader_closed":reader.statistics()["closed"],"words_remaining_after_close":reader.statistics().get("cached_words",0),
        "scope":"Exact finite membership timings only; no first-use, NVDA, audio or pronunciation acceptance"}
    print(json.dumps(result,ensure_ascii=True),flush=True)
    return 0


def publish_report(path,document):
    path=Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    raw=(json.dumps(document,sort_keys=True,ensure_ascii=False,indent=2)+"\n").encode("utf-8")
    descriptor,name=tempfile.mkstemp(prefix=path.name+".owned-",dir=path.parent)
    temporary=Path(name)
    try:
        with os.fdopen(descriptor,"wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary,path)
    finally:
        temporary.unlink(missing_ok=True)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lexicon",type=Path,required=True)
    parser.add_argument("--acquisition-report",type=Path,required=True)
    parser.add_argument("--baseline-module",type=Path,required=True)
    parser.add_argument("--candidate-module",type=Path,required=True)
    parser.add_argument("--candidate-git-blob",required=True)
    parser.add_argument("--output",type=Path)
    parser.add_argument("--rounds",type=int,default=3)
    parser.add_argument("--iterations",type=int,default=1000)
    parser.add_argument("--child-variant",choices=("original","candidate-cache0","candidate-default"))
    args=parser.parse_args(argv)
    if not 1<=args.rounds<=10 or not 100<=args.iterations<=10000:
        parser.error("Bounded rounds1..10/iterations100..10000 required")
    if len(args.candidate_git_blob)!=40 or any(ch not in "0123456789abcdef" for ch in args.candidate_git_blob):
        parser.error("Full reviewed candidate Git blob required")
    if args.child_variant:
        return child(args)
    if args.output is None:
        parser.error("--output is required for the controller")
    protected=[args.lexicon,args.acquisition_report,args.baseline_module,args.candidate_module]
    output=args.output.resolve()
    if output.exists() or output.is_symlink() or output in {path.resolve() for path in protected}:
        raise FileExistsError("Report must be new and distinct from all protected inputs")
    baseline=module_source(args.baseline_module)
    candidate=module_source(args.candidate_module)
    if baseline["git_blob"]!=BASELINE_GIT_BLOB or candidate["git_blob"]!=args.candidate_git_blob:
        raise ValueError("Reviewed comparison source identities differ")
    if args.lexicon.stat().st_size!=18661227 or digest(args.lexicon)!=DATA_SHA256:
        raise ValueError("Pinned unchanged DMLX differs")
    if digest(args.acquisition_report)!=SOURCE_SHA256:
        raise ValueError("Pinned primary acquisition receipt differs")
    rows=[]
    variants=("original","candidate-cache0","candidate-default")
    for number in range(args.rounds):
        order=variants if number%2==0 else tuple(reversed(variants))
        for variant in order:
            command=[sys.executable,str(Path(__file__).resolve()),"--lexicon",str(args.lexicon.resolve()),
                "--acquisition-report",str(args.acquisition_report.resolve()),
                "--baseline-module",str(args.baseline_module.resolve()),
                "--candidate-module",str(args.candidate_module.resolve()),
                "--candidate-git-blob",args.candidate_git_blob,"--iterations",str(args.iterations),
                "--child-variant",variant]
            completed=subprocess.run(command,capture_output=True,text=True,encoding="utf-8",timeout=180,check=False)
            if completed.returncode or len(completed.stdout)>1024*1024:
                raise RuntimeError("Fresh benchmark child failed: "+variant)
            result=json.loads(completed.stdout)
            if result.get("variant")!=variant or result.get("dataset_sha256")!=DATA_SHA256 or not result.get("reader_closed"):
                raise ValueError("Fresh comparison receipt identity differs")
            rows.append(dict(round=number+1,**result))
            print("NATIVE_WORD_CACHE_MATCHED "+json.dumps({"round":number+1,"variant":variant,
                "first_pass":result["first_pass_97_unique"],"repeated":result["repeated"],
                "statistics":result["statistics"]}),flush=True)
    report={"format":"dordiai-unpublished-word-membership-cache-matched-benchmark","format_version":1,
        "status":"passed-all-finite-membership-comparisons","dataset_sha256":DATA_SHA256,
        "source_receipt_sha256":SOURCE_SHA256,"baseline_module":baseline,"candidate_module":candidate,
        "rounds":args.rounds,"iterations":args.iterations,"comparisons":rows,
        "fresh_child_process_per_variant":True,"order_reversed_alternate_rounds":True,
        "os_file_cache_evicted":False,"first_pass_unique_improvement_claimed":False,
        "production_integrated":False,"nvda_verified":False,"physical_audio_verified":False,
        "pronunciation_verified":False,"product_ready":False}
    publish_report(output,report)
    print("NATIVE_WORD_CACHE_REPORT "+str(output),flush=True)
    return 0


if __name__=="__main__":
    raise SystemExit(main())
