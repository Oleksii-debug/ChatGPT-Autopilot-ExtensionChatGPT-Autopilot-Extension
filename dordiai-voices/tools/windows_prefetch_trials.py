"""Six owned Windows/NVDA prefetch trials against immutable source13.

This research controller changes one outer queue count in fresh extracted
copies only. The original installer, production source and acceptance gates
remain unchanged. Real capture is restricted to the reviewed hosted-CI lease.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time
import uuid
from zipfile import ZipFile

import windows_nvda_longread_probe as capture
import windows_nvda_process_capture_probe as short
from nvda_longread_analysis import analyze_longread, cancellation_tail, MIN_NCC
from nvda_process_capture_support import read_json, validate_ready
from plain_word_workload import original_source100, audit_original100, ORIGINAL_INPUT_UTF8_SHA256
from prefetch_research import install_owned_overlay

TOOLS = Path(__file__).resolve().parent
ORDER = (12, 24, 32, 32, 24, 12)
DRIVER_SHA = "17eeda6106858c4eb14ede91dd2a698cae0abaa9894d3df3e3d445d374a042ee"
DRIVER_BYTES = 93785
ARCHIVE_SHA = "4aed1ba48e8600dcd5f80bac9b85e5a3d7ce09b209c76a4a2873fe7b9960876d"
ARCHIVE_BYTES = 1992990314
SOURCE_COMMIT = "2d70515a4c49413efcb23198491bbc675a55db0a"
PLUGIN_BLOB = "ae0baa10909d00bb573747df23afbcc2c7ca7205"
PURE_SHA = "0085c12a1a7da4336a314dd92061ca91ab17ab6c9b91c1448e3c2c4d1d7c630c"
EVIDENCE_NAMES = (
    "prefetch-overlay.json", "plugin-ready.json", "plugin-complete.json",
    "plugin-longread.json", "plugin-cancel.json", "owned-launch.json",
    "longread-reference.pcm", "cancel-reference.pcm", "partial-reference.pcm",
    "original100.txt", "longread-analysis.json", "cancel-analysis.json",
    "longread-capture/ready.json", "longread-capture/capture.json",
    "longread-capture/captured.pcm", "cancel-capture/ready.json",
    "cancel-capture/capture.json", "cancel-capture/captured.pcm",
    "nvda.log", "nvda-console.log", "bootstrap.log", "bootstrap-console.log",
)
MAX_TRIAL_EVIDENCE = 40 * 1024 * 1024


class OwnedProcessJob:
    """Hold only the job containing our exact Popen handle and its workers."""
    def __init__(self):
        import ctypes as ct
        from ctypes import wintypes as wt
        self.ct = ct
        self.kernel = ct.WinDLL("kernel32", use_last_error=True)
        class Limits(ct.Structure):
            _fields_ = [
                ("process_time", ct.c_longlong), ("job_time", ct.c_longlong),
                ("flags", wt.DWORD), ("minimum_set", ct.c_size_t),
                ("maximum_set", ct.c_size_t), ("active_limit", wt.DWORD),
                ("affinity", ct.c_size_t), ("priority", wt.DWORD),
                ("scheduling", wt.DWORD),
            ]
        class ExtendedLimits(ct.Structure):
            _fields_ = [("basic", Limits), ("io", ct.c_ulonglong * 6),
                        ("process_memory", ct.c_size_t), ("job_memory", ct.c_size_t),
                        ("peak_process", ct.c_size_t), ("peak_job", ct.c_size_t)]
        class Accounting(ct.Structure):
            _fields_ = [("times", ct.c_longlong * 4), ("faults", wt.DWORD),
                        ("total", wt.DWORD), ("active", wt.DWORD),
                        ("terminated", wt.DWORD)]
        self.Accounting = Accounting
        for name, args in (
            ("CreateJobObjectW", [ct.c_void_p, wt.LPCWSTR]),
            ("SetInformationJobObject", [wt.HANDLE, ct.c_int, ct.c_void_p, wt.DWORD]),
            ("AssignProcessToJobObject", [wt.HANDLE, wt.HANDLE]),
            ("QueryInformationJobObject", [wt.HANDLE, ct.c_int, ct.c_void_p, wt.DWORD, ct.c_void_p]),
            ("TerminateJobObject", [wt.HANDLE, wt.UINT]),
            ("CloseHandle", [wt.HANDLE]),
        ):
            getattr(self.kernel, name).argtypes = args
            getattr(self.kernel, name).restype = wt.HANDLE if name == "CreateJobObjectW" else wt.BOOL
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ct.WinError(ct.get_last_error())
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
        if not self.kernel.SetInformationJobObject(self.handle, 9, ct.byref(limits), ct.sizeof(limits)):
            error = ct.WinError(ct.get_last_error())
            self.kernel.CloseHandle(self.handle)
            self.handle = None
            raise error

    def assign(self, process):
        # Popen's already-held handle avoids an arbitrary-PID reopening API.
        if not self.kernel.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise self.ct.WinError(self.ct.get_last_error())

    def active(self):
        record = self.Accounting()
        if not self.kernel.QueryInformationJobObject(self.handle, 1, self.ct.byref(record),
                                                      self.ct.sizeof(record), None):
            raise self.ct.WinError(self.ct.get_last_error())
        return record.active

    def finish(self):
        """Reap the bounded owned tree before any extracted payload removal."""
        if self.handle is None:
            raise RuntimeError("Owned job was already closed")
        forced = False
        try:
            remaining = self.active()
            if remaining:
                forced = True
                if not self.kernel.TerminateJobObject(self.handle, 1):
                    raise self.ct.WinError(self.ct.get_last_error())
            deadline = time.monotonic() + 10
            while self.active():
                if time.monotonic() >= deadline:
                    raise RuntimeError("Exact owned NVDA/worker job did not finish")
                time.sleep(.02)
            return {"active_before_cleanup": remaining, "active_after_cleanup": 0,
                    "forced_tree_termination": forced, "all_owned_workers_reaped": True}
        finally:
            self.kernel.CloseHandle(self.handle)
            self.handle = None

# The boundary precedes capture readiness, preserving the unchanged 80/90s
# read/capture limits. All planner generators, including cancelled focus
# announcements, are counted until finally-close.
BOUNDARY = r"""
BOUNDARY_LOCK=threading.Lock()
BOUNDARY={'serial':0,'planners':0,'last_ns':time.perf_counter_ns(),'stable':0,
          'last_cancel':-1,'samples':[],'cancel_calls':0,'published_serial':None}

def boundary_activity():
    with BOUNDARY_LOCK:
        BOUNDARY['serial']+=1
        BOUNDARY['last_ns']=time.perf_counter_ns()

def on_queued(speechSequence,priority):
    boundary_activity()

def begin_quiet_boundary():
    global PHASE
    PHASE='pre-read-quiescence'
    BOUNDARY['deadline']=time.monotonic()+30.0
    wait_quiet_boundary()

def wait_quiet_boundary():
    if not focus_owned() or synthDriverHandler.getSynth() is not DRIVER:
        raise RuntimeError('Owned focus or driver changed during pre-read boundary')
    with BOUNDARY_LOCK:
        serial=BOUNDARY['serial']
        planners=BOUNDARY['planners']
        quiet_ms=(time.perf_counter_ns()-BOUNDARY['last_ns'])/1000000
    if serial!=BOUNDARY['last_cancel']:
        speech.setSpeechMode(speech.SpeechMode.talk)
        speech.cancelSpeech()
        speech.setSpeechMode(speech.SpeechMode.off)
        BOUNDARY['last_cancel']=serial
        BOUNDARY['cancel_calls']+=1
        BOUNDARY['stable']=0
    sample={'active_planners':planners,'queued_driver_jobs':DRIVER._jobs.qsize(),
            'nvda_is_speaking':bool(speech.isSpeaking()),'quiet_ms':quiet_ms,
            'activity_serial':serial,'generation':DRIVER._generation}
    if len(BOUNDARY['samples'])>=512:
        raise RuntimeError('Bounded quiescence evidence quota exceeded')
    BOUNDARY['samples'].append(sample)
    ready=planners==0 and sample['queued_driver_jobs']==0 and not sample['nvda_is_speaking'] and quiet_ms>=250
    BOUNDARY['stable']=BOUNDARY['stable']+1 if ready else 0
    if BOUNDARY['stable']>=2:
        BOUNDARY['published_serial']=serial
        REPORT['pre_read_quiescence']={
            'passed':True,'quiet_minimum_ms':250,'stable_samples':2,
            'sample_spacing_ms':100,'cancel_calls':BOUNDARY['cancel_calls'],
            'samples':list(BOUNDARY['samples']),
            'workload_warmup_performed':False,'content_filter_used':False}
        return publish_capture_ready()
    if time.monotonic()>=BOUNDARY['deadline']:
        raise TimeoutError('Pre-read planner quiescence exceeded unchanged30second limit')
    core.callLater(100,guarded(wait_quiet_boundary))

def verify_loaded_research_source():
    driver_path=Path(sys.modules[type(DRIVER).__module__].__file__).resolve()
    if driver_path!=Path(SETTINGS['driver_path']).resolve():
        raise ValueError('Loaded research driver path differs')
    raw=driver_path.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=SETTINGS['driver_sha256']:
        raise ValueError('Loaded research driver bytes differ')
    engine=DRIVER._engine
    initial={}
    for name in ('_clips','_navigation','_ready_modes'):
        value=getattr(engine,name,None)
        initial[name]={'present':value is not None,'count':len(value) if hasattr(value,'__len__') else None}
    process=getattr(engine,'_process',None)
    REPORT['research_identity']={
        'source_commit':SETTINGS['source_commit'],'archive_sha256':SETTINGS['archive_sha256'],
        'loaded_driver_sha256':hashlib.sha256(raw).hexdigest(),
        'loaded_driver_bytes':len(raw),'pending_count':SETTINGS['pending_count'],
        'profile':'adam','rate':80,'rate_multiplier':1,'initial_worker_pid':getattr(process,'pid',None),
        'initial_cache_and_bootstrap_state':initial,
        'explicit_preload_called_by_probe':False,'warmup_workload_words_synthesized_by_probe':False}
"""

OBSERVER = r"""def observe_parts(*args,**kwargs):
    source=None
    with BOUNDARY_LOCK:BOUNDARY['planners']+=1
    boundary_activity()
    try:
        source=ORIGINAL_PARTS(*args,**kwargs)
        for part in source:
            kind,value=part
            if PHASE in ('longread','cancelling') and kind in ('text','character') and isinstance(value,dict):
                if len(ROUTES)>=1024:raise ValueError('Route observation quota exceeded')
                COUNTERS['planner_requests']+=1
                ROUTES.append({key:value.get(key) for key in ('text','language','profile','character','speed')})
            yield part
    finally:
        try:
            close=getattr(source,'close',None)
            if close is not None:close()
        finally:
            with BOUNDARY_LOCK:BOUNDARY['planners']-=1
            boundary_activity()
"""


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise ValueError("Pinned research plugin anchor differs")
    return source.replace(before, after, 1)


def git_blob(raw):
    return hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()


def plugin_source(settings):
    """Transform only the owned diagnostic plugin, never the product driver."""
    raw = (TOOLS / "windows_nvda_longread_plugin.py").read_bytes()
    if git_blob(raw) != PLUGIN_BLOB:
        raise ValueError("Reviewed longread diagnostic plugin bytes differ")
    helpers = capture.source_helpers(TOOLS / "windows_nvda_plain_text_probe.py")
    if hashlib.sha256(helpers.encode("utf8")).hexdigest() != PURE_SHA:
        raise ValueError("Immutable workload and route auditors differ")
    source = raw.decode("utf8")
    tree = ast.parse(source)
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "observe_parts")
    lines = source.splitlines(keepends=True)
    source = "".join(lines[:node.lineno - 1]) + OBSERVER + "\n" + "".join(lines[node.end_lineno:])
    source = replace_once(source, "def on_high_level(speechSequence,originalSpeechSequence=None,**kwargs):\n",
                          "def on_high_level(speechSequence,originalSpeechSequence=None,**kwargs):\n    boundary_activity()\n")
    source = replace_once(source, "def on_synth(speechSequence):\n",
                          "def on_synth(speechSequence):\n    boundary_activity()\n")
    source = replace_once(source, "    PHASE='ready'\n    publish('plugin-ready.json',",
                          "    begin_quiet_boundary()\n\n\ndef publish_capture_ready():\n    global PHASE\n    PHASE='ready'\n    publish('plugin-ready.json',")
    source = replace_once(source, "    CASE=_plain_cases()[0]",
                          "    verify_loaded_research_source()\n    CASE=_plain_cases()[0]")
    source = replace_once(source, "CASE['enabled'],'uk',SAVED['voice'],{}",
                          "CASE['enabled'],'uk','adam',{}")
    source = replace_once(source, "    DRIVER.rate=80\n", "    DRIVER.rate=80;DRIVER.rateMultiplier=1\n")
    source = replace_once(source, "    if getattr(speech,'pre_speech',None) is not None:speech.pre_speech.register(on_high_level)",
                          "    speech.pre_speech.register(on_high_level)\n    speech.pre_speechQueued.register(on_queued)")
    source = replace_once(source, "    try:speech.pre_speech.unregister(on_high_level)\n    except Exception:pass",
                          "    try:speech.pre_speech.unregister(on_high_level)\n    except Exception:pass\n    try:speech.pre_speechQueued.unregister(on_queued)\n    except Exception:pass")
    source = replace_once(source, "    state_snapshot('read-boundary-before-public-mode-and-cancel')",
                          """    if not cancel:
        with BOUNDARY_LOCK:
            unchanged=BOUNDARY['serial']==BOUNDARY['published_serial'] and BOUNDARY['planners']==0
        if not unchanged or DRIVER._jobs.qsize()!=0 or speech.isSpeaking():
            raise RuntimeError('New activity after capture-ready boundary; no title/content filtering')
    state_snapshot('read-boundary-before-public-mode-and-cancel')""")
    source += "\n" + BOUNDARY
    source = replace_once(source, "SETTINGS=__SETTINGS__", "SETTINGS=" + repr(settings))
    source = replace_once(source, "__SOURCE_HELPERS__", helpers)
    compile(source, "<owned-prefetch-diagnostic>", "exec")
    return source


def verify_input(addon, report):
    pin = read_json(TOOLS / "data/source13_build_pin.json")
    if (pin.get("archive_bytes"), pin.get("archive_sha256"), pin.get("source_commit"), pin.get("version")) != (
            ARCHIVE_BYTES, ARCHIVE_SHA, SOURCE_COMMIT, "0.13.1-dev.13"):
        raise ValueError("Actual source13 pin file differs")
    short.verify_addon_input(addon, ARCHIVE_BYTES, ARCHIVE_SHA, report)
    with ZipFile(addon) as archive:
        source = archive.read("synthDrivers/kx47Preview.py")
        if len(source) != DRIVER_BYTES or hashlib.sha256(source).hexdigest() != DRIVER_SHA:
            raise ValueError("Source13 archived driver differs from independently reviewed original")
    original_source100()
    return pin


def verify_native_helpers(args):
    import process_loopback_guard as guard
    build = guard.verify_build(args.helper, args.helper_build_receipt, TOOLS / "windows_nvda_longread_capture.cpp")
    receipt = read_json(args.helper_build_receipt)
    if (receipt.get("purpose") != "owned-nvda-longread-capture"
            or receipt.get("included_marker_source_sha256") != short.FROZEN_MARKER_CPP_SHA
            or short.digest(TOOLS / "windows_process_loopback.cpp") != short.FROZEN_MARKER_CPP_SHA):
        raise ValueError("Independent longread helper does not bind the frozen marker source")
    guard.verify_build(args.marker_helper, args.marker_build_receipt, TOOLS / "windows_process_loopback.cpp")
    return build


def remove_owned_payload(run, report):
    """Reap first, remove only two exact large directories, retain all evidence."""
    root = Path(run).absolute()
    if not re.fullmatch(r"nvda-[0-9a-f]{32}", root.name):
        raise ValueError("Nonce-bound owned cleanup root required")
    if (not report.get("owned_nvda_reaped") or not report.get("owned_helper_reaped")
            or not report.get("owned_worker_tree_reaped")):
        raise RuntimeError("Owned process reaping must precede payload removal")
    for part in (root, *root.parents):
        if part.is_symlink() or getattr(part.lstat(), "st_file_attributes", 0) & 1024:
            raise ValueError("Cleanup refuses linked roots")
    removed = []
    for name in ("config", "portable"):
        folder = root / name
        if not folder.exists():
            continue
        if folder.is_symlink() or getattr(folder.lstat(), "st_file_attributes", 0) & 1024:
            raise ValueError("Cleanup refuses linked payloads")
        # Refuse descendant junctions too, so traversal cannot leave this trial.
        for current, directories, _files in os.walk(folder, followlinks=False):
            for directory in directories:
                child = Path(current) / directory
                if child.is_symlink() or getattr(child.lstat(), "st_file_attributes", 0) & 1024:
                    raise ValueError("Cleanup refuses descendant links")
        shutil.rmtree(folder)
        removed.append(name)
    report["large_payload_cleanup"] = {"removed": removed, "after_exact_process_reaping": True}


def evidence_index(run):
    rows = []
    total = 0
    for name in EVIDENCE_NAMES:
        path = Path(run) / name
        if not path.is_file():
            continue
        if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
            raise ValueError("Only own regular evidence may be retained")
        size = path.stat().st_size
        cap = 8 * 1024 * 1024 if path.suffix == ".json" else 48000 * 2 * 90 if path.suffix == ".pcm" else 4 * 1024 * 1024
        total += size
        if size > cap or total > MAX_TRIAL_EVIDENCE:
            raise ValueError("Trial evidence exceeds quota; no truncation accepted")
        rows.append({"path": name, "bytes": size, "sha256": short.digest(path)})
    return {"files": rows, "total_bytes": total, "truncated": False}


def judge_trial(result, correlation, tail, overlay):
    audit = result.get("route_audit", {})
    valid = (result.get("status") == "completed-real-waveplayer-longread"
             and result.get("input_utf8_sha256") == ORIGINAL_INPUT_UTF8_SHA256
             and result.get("actual_rate") == 80 and result.get("actual_rate_multiplier") == 1
             and result.get("driver_error") is None
             and result.get("recording_pcm_sink_test_double") is False
             and result.get("research_identity", {}).get("loaded_driver_sha256") == overlay["candidate_source_sha256"]
             and result.get("research_identity", {}).get("profile") == "adam"
             and result.get("research_identity", {}).get("pending_count") == overlay["pending_count"]
             and result.get("pre_read_quiescence", {}).get("passed") is True
             and audit.get("input_word_count") == 100 and audit.get("input_lexical_piece_count") == 102
             and audit.get("lexical_content_preserved_in_order") is True
             and audit.get("raw_nonwhitespace_text_preserved") is True
             and audit.get("routing_passed") is True)
    fixed = correlation.get("complete_reference_window_used") is True and correlation.get("dynamic_warp_or_resampling_used") is False and correlation.get("ncc_threshold") == MIN_NCC
    transport = valid and fixed and correlation.get("full_reference_transport_verified") is True and correlation.get("no_new_transport_gap_verified") is True
    return {"structural_workload_and_identity_verified": valid,
            "strict_full_transport_verified": transport,
            "clock_and_cancel_status": tail.get("gate_status", "open"),
            "all_independent_gates_passed": transport and tail.get("gate_status") == "measured-software-only",
            "product_ready": False, "physical_audio_verified": False, "acoustic_latency_verified": False}


def run_trial(args, output_device, instance, count, index, base):
    run = args.output / ("nvda-" + uuid.uuid4().hex)
    run.mkdir()
    report = {"ordinal": index, "pending_count": count, "status": "failed",
              "source_commit": SOURCE_COMMIT, "archive_sha256": ARCHIVE_SHA,
              "product_ready": False, "physical_audio_verified": False,
              "acoustic_latency_verified": False, "native_pronunciation_verified": False}
    process = None
    job = None
    try:
        image, config = short.create_portable(base, run, args.addon, output_device)
        overlay = install_owned_overlay(run, source_sha256=DRIVER_SHA, pending_count=count)
        report["overlay"] = overlay
        driver = config / "addons/kx47Voices/synthDrivers/kx47Preview.py"
        image_sha = short.digest(image)
        plugins = config / "addons/dordiaiCaptureProbe/globalPlugins"
        plugins.mkdir(parents=True)
        (plugins.parent / "manifest.ini").write_text(
            'name="dordiaiCaptureProbe"\nsummary="Owned source13 prefetch trial"\nversion="1.0.0"\nauthor="dordiai-voices"\nminimumNVDAVersion="2026.1"\nlastTestedNVDAVersion="2026.3.1"\n', encoding="utf8")
        settings = {"root": str(run), "config": str(config.resolve()), "probe_id": run.name[5:],
                    "controller_pid": os.getpid(), "output_device": output_device,
                    "input_sha256": ORIGINAL_INPUT_UTF8_SHA256, "cancel_text": capture.CANCEL_TEXT,
                    "source_probe_sha256": capture.PLAIN_PROBE_SHA, "source_helpers_sha256": PURE_SHA,
                    "source_commit": SOURCE_COMMIT, "archive_sha256": ARCHIVE_SHA,
                    "driver_path": str(driver), "driver_sha256": overlay["candidate_source_sha256"],
                    "pending_count": count}
        (plugins / "dordiaiCaptureProbe.py").write_text(plugin_source(settings), encoding="utf8")
        with (run / "nvda-console.log").open("wb") as console:
            job = OwnedProcessJob()
            process = subprocess.Popen([str(image), "--config-path=" + str(config),
                "--log-file=" + str(run / "nvda.log"), "--debug-logging", "--no-sr-flag",
                "--minimal", "--lang=en"], cwd=image.parent, stdout=console, stderr=subprocess.STDOUT)
            job.assign(process)
            short.publish(run / "owned-launch.json", {"pid_expected": process.pid, "probe_id": run.name[5:]})
            ready = short.wait_file(run / "plugin-ready.json", [process], 180, failed_file=run / "plugin-complete.json")
            rate = validate_ready(ready, nvda_pid=process.pid, controller_pid=os.getpid(),
                                 nonce=run.name[5:], config=config.resolve(), image_sha=image_sha)
            ready_sha = short.digest(run / "plugin-ready.json")
            report.update(owned_nvda_pid=process.pid, controller_pid=os.getpid(), image_sha256=image_sha,
                          plugin_ready_sha256=ready_sha)
            native, pcm = capture.capture_phase(args, run, process, rate, image_sha, ready_sha, instance,
                "longread-capture", 90, "longread-trigger.json", report)
            result = short.wait_file(run / "plugin-longread.json", [process], 2, failed_file=run / "plugin-complete.json")
            if result.get("pid") != process.pid or result.get("probe_id") != run.name[5:] or result.get("sample_rate") != rate:
                raise ValueError("Exact current trial longread receipt differs")
            reference = capture.read_pcm(run / "longread-reference.pcm", result["reference_pcm"], 80)
            correlation = analyze_longread(reference, pcm, rate, native["packets"])
            short.publish(run / "longread-analysis.json", correlation)
            cancel_native, cancel_pcm = capture.capture_phase(args, run, process, rate, image_sha, ready_sha, instance,
                "cancel-capture", 8, "cancel-trigger.json", report)
            cancel = short.wait_file(run / "plugin-cancel.json", [process], 2, failed_file=run / "plugin-complete.json")
            if (cancel.get("pid") != process.pid or cancel.get("probe_id") != run.name[5:]
                    or cancel.get("actual_cancel_api") != "speech.cancelSpeech"
                    or cancel.get("cancel_text") != capture.CANCEL_TEXT
                    or cancel.get("clock", {}).get("qpc_frequency") != cancel_native.get("qpc_frequency")):
                raise ValueError("Exact current trial public cancellation receipt differs")
            tail = cancellation_tail(cancel_pcm, rate, cancel_native["packets"], cancel["clock"])
            short.publish(run / "cancel-analysis.json", tail)
            report.update(status="completed-research-trial", judgment=judge_trial(result, correlation, tail, overlay),
                          correlation=correlation, cancellation=tail,
                          effective_default_tempo=result.get("effective_default_tempo"),
                          actual_request_speeds=[r.get("speed") for r in result.get("planned_routes", [])],
                          initial_state=result.get("research_identity"), pre_read_quiescence=result.get("pre_read_quiescence"))
            short.publish(run / "stop.json", {"probe_id": run.name[5:]})
            process.wait(timeout=20)
    except Exception as error:
        report.update(status="failed", error=type(error).__name__ + ": " + str(error))
    finally:
        try:
            base.stop_owned(process)
        except Exception as error:
            report.update(status="failed", error="Owned NVDA stop failed: " + str(error))
        report["owned_nvda_reaped"] = process is None or process.poll() is not None
        report["owned_helper_reaped"] = all(r["reaped"] for r in report.get("owned_capture_helper_cleanup", []))
        report["owned_worker_tree_reaped"] = process is None
        try:
            if job is not None:
                report["owned_worker_job"] = job.finish()
                report["owned_worker_tree_reaped"] = report["owned_worker_job"]["all_owned_workers_reaped"]
                if report["owned_worker_job"]["forced_tree_termination"]:
                    report.update(status="failed", error="Owned worker tree needed forced cleanup")
            report["evidence"] = evidence_index(run)
            remove_owned_payload(run, report)
        except Exception as error:
            report.update(status="failed", cleanup_error=type(error).__name__ + ": " + str(error))
        short.publish(run / "trial.json", report)
    return report


def summarize(trials):
    """Keep every failed gate and compare the two repetitions of each count."""
    order_valid = tuple(r.get("pending_count") for r in trials) == ORDER
    complete = order_valid and all(r.get("status") == "completed-research-trial" for r in trials)
    groups = {}
    for count in (12, 24, 32):
        group = [r for r in trials if r.get("pending_count") == count]
        groups[str(count)] = {
            "trials": len(group),
            "strict_transport_passes": sum(r.get("judgment", {}).get("strict_full_transport_verified") is True for r in group),
            "independent_all_gate_passes": sum(r.get("judgment", {}).get("all_independent_gates_passed") is True for r in group),
            "ncc": [r.get("correlation", {}).get("normalized_correlation") for r in group],
            "cancel_status": [r.get("judgment", {}).get("clock_and_cancel_status", "open") for r in group],
        }
    return {"declared_order": list(ORDER), "order_verified": order_valid, "six_trials_completed": complete,
            "counts": groups, "automatic_runtime_change_performed": False, "production_fix_accepted": False,
            "product_ready": False, "physical_audio_verified": False, "acoustic_latency_verified": False}


def run(args):
    import windows_virtual_audio_trial as device
    import process_loopback_guard as guard
    report = {"format": "dordiai-source13-six-owned-prefetch-trials", "format_version": 1,
              "status": "failed", "trials": [], "physical_audio_verified": False,
              "acoustic_latency_verified": False, "native_pronunciation_verified": False, "product_ready": False}
    created = False
    try:
        if not args.ephemeral_ci:
            raise device.TrialBlocked("Explicit existing ephemeral CI scope required")
        device.guard_environment(os.environ, args.package, args.output)
        if args.output.exists():
            raise ValueError("Fresh owned trial output required")
        args.output.mkdir()
        created = True
        report["input_pin"] = verify_input(args.addon, report)
        report["helper_build"] = verify_native_helpers(args)
        report["verification"] = device.verify_package(args.package, args.validation)
        report["endpoints_before"] = device.endpoints()
        base = short.module("_source13_prefetch_nvda_base", TOOLS / "windows_nvda_probe.py")
        with device.WindowsPnP().owned_device(args.package / "vbMmeCable64_win10.inf", report):
            deadline = time.monotonic() + 20
            while True:
                current = device.endpoints()
                render, _ = device.select_new_vendor_endpoints(report["endpoints_before"], current)
                if render:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("Unique new owned render endpoint unavailable")
                time.sleep(.25)
            described = guard.own_child([str(args.marker_helper), "--describe-native-format", "--render-name",
                render["name"], "--owned-instance-id", report["owned_instance_id"]], 8)
            if described.returncode:
                raise RuntimeError("Owned endpoint identity description failed")
            endpoint = json.loads(described.stdout)["selected_endpoint"]
            report["selected_endpoint"] = endpoint
            for index, count in enumerate(ORDER, 1):
                trial = run_trial(args, endpoint["id"], report["owned_instance_id"], count, index, base)
                report["trials"].append(trial)
                short.publish(args.output / ("completed-trial-%02d.json" % index), trial)
                if (not trial.get("owned_nvda_reaped") or not trial.get("owned_helper_reaped")
                        or not trial.get("owned_worker_tree_reaped")
                        or "cleanup_error" in trial):
                    raise RuntimeError("Owned cleanup failed; next trial must not start")
            report["summary"] = summarize(report["trials"])
            report["status"] = "six-research-trials-completed" if report["summary"]["six_trials_completed"] else "six-trials-retained-with-failures"
        if short.digest(args.addon) != ARCHIVE_SHA:
            raise ValueError("Immutable source13 archive changed during trials")
    except Exception as error:
        report.update(status="failed", error=type(error).__name__ + ": " + str(error))
    finally:
        report["summary"] = summarize(report["trials"])
        cleanup = report.get("cleanup", {})
        if cleanup.get("attempted") and (cleanup.get("removed") is not True or cleanup.get("absence_verified") is not True):
            report.update(status="failed", error="Exact own endpoint absence was not verified")
        if created:
            short.publish(args.output / "prefetch-trials.json", report)
        print("SOURCE13_PREFETCH_TRIALS " + json.dumps(report), flush=True)
    # Engineering experiment completion is distinct from a product-gate pass.
    return 0 if report["status"] == "six-research-trials-completed" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("package", "validation", "output", "addon", "helper", "helper-build-receipt",
                 "marker-helper", "marker-build-receipt"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--ephemeral-ci", action="store_true")
    return run(parser.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())

