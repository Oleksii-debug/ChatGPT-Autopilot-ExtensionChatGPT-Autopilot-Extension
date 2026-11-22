"""Actual frozen-NVDA host compatibility for an external owned DMLX candidate.

No product addon/archive is installed or modified. The only test addon is an
owned probe. A verified leaf and data copy live outside all installed addons.
This proves host imports/finite lookup/lifetime, not production routing,
typing, audio output, pronunciation or author-intent language detection.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT=Path(__file__).resolve().parents[1]
DATA_SHA256="21208748a50ebf3f5dd3e2feb94f0f3caf3490c2be784aaca2209462380e6689"
DATA_BYTES=18661227
SOURCE_REPORT_SHA256="d7c8157a3cfc44d3e6cce9daf45099fb34c4f5f1e80edfed70a50e6cde2d6199"

HOST_PLUGIN=r'''
import globalPluginHandler
import core
import synthDriverHandler
import versionInfo
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import traceback

SETTINGS=__HOST_MEMBERSHIP_SETTINGS__


def run_membership_host_probe():
    report={"format":"dordiai-real-frozen-nvda-membership-host","format_version":1,
        "run_id":SETTINGS["run_id"],"status":"failed",
        "scope":"Real frozen NVDA imports external owned leaf/data; not installed-product integration",
        "product_addon_installed":False,"product_archive_modified":False,
        "production_routing_verified":False,"typing_verified":False,
        "physical_audio_verified":False,"acoustic_latency_verified":False,"pronunciation_verified":False,
        "audio_scope":"Builtin silence; no WavePlayer or output test attempted",
        "nvda_version":versionInfo.version,"python":sys.version,"frozen":bool(getattr(sys,"frozen",False)),
        "checks":[]}
    reader=None
    def check(name,passed,**details):
        report["checks"].append(dict(name=name,status="passed" if passed else "failed",**details))
    try:
        check("real_frozen_nvda",report["frozen"] and report["nvda_version"]=="2026.3.1",
              executable_basename=Path(sys.executable).name)
        check("private_abi_not_used",sys.version_info[:2]==(3,13))
        module_path=Path(SETTINGS["module_path"])
        data_path=Path(SETTINGS["data_path"])
        if hashlib.sha256(module_path.read_bytes()).hexdigest()!=SETTINGS["module_sha256"]:
            raise ValueError("External module hash differs")
        check("external_module_hash",True)
        with data_path.open("rb") as stream:
            if hashlib.file_digest(stream,"sha256").hexdigest()!=SETTINGS["data_sha256"]:
                raise ValueError("External dataset hash differs")
        check("external_dataset_hash",True)
        check("builtin_silence_selected",getattr(synthDriverHandler.getSynth(),"name",None)=="silence")
        before_path=tuple(sys.path)
        spec=importlib.util.spec_from_file_location("_dordiai_external_membership_"+SETTINGS["run_id"],module_path)
        module=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        check("host_stdlib_imports",module.mmap.__name__=="mmap" and module.zlib.__name__=="zlib",
            mmap_origin_basename=Path(getattr(module.mmap,"__file__","builtin")).name,
            zlib_origin_basename=Path(getattr(module.zlib,"__file__","builtin")).name)
        check("host_sys_path_unchanged",tuple(sys.path)==before_path,
              private_python314_path_added=False)
        started=time.perf_counter_ns()
        reader=module.MembershipLexicon(data_path,SETTINGS["data_sha256"])
        report["instance_open_ms"]=(time.perf_counter_ns()-started)/1000000.0
        check("real_dataset_identity",reader.codes==("uk","ru") and reader.word_count==6642550,
              statistics=reader.statistics())
        cases=[]
        for case in SETTINGS["cases"]:
            tick=time.perf_counter_ns()
            got=reader.candidates(case["word"])
            cases.append({"word":case["word"],"expected":case["memberships"],"actual":sorted(got),
                "lookup_ms":(time.perf_counter_ns()-tick)/1000000.0,
                "status":"passed" if got==frozenset(case["memberships"]) else "failed"})
        report["cases"]=cases
        check("actual_primary_source_lookups",len(cases)>=97 and all(row["status"]=="passed" for row in cases),
              case_count=len(cases),scope="96 independent source samples plus invalid-token negative control")
        report["statistics"]=reader.statistics()
        reader.close()
        check("actual_reader_closed",reader.statistics()["closed"] and reader.statistics()["cached_blocks"]==0)
        closed_raises=False
        try:
            reader.candidates(SETTINGS["cases"][0]["word"])
        except module.LexiconError:
            closed_raises=True
        check("closed_reader_does_not_return_stale_membership",closed_raises)
        # This is the controller's disposable external copy, never a product/input file.
        moved=data_path.with_name(data_path.name+".closed-"+SETTINGS["run_id"])
        data_path.rename(moved)
        moved.rename(data_path)
        check("windows_mapping_handles_released",True,
              scope="rename roundtrip of own external data copy after reader.close")
        report["status"]="passed-host-compatibility" if all(row["status"]=="passed" for row in report["checks"]) else "failed"
    except Exception as error:
        report["error"]={"type":type(error).__name__,"import_name":getattr(error,"name",None),
            "frames":[{"file":Path(frame.filename).name,"function":frame.name,"line":frame.lineno}
                      for frame in traceback.extract_tb(error.__traceback__)[-12:]]}
    finally:
        if reader is not None:
            reader.close()
        path=Path(SETTINGS["report_path"])
        temporary=path.with_name(path.name+".writing")
        temporary.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        temporary.replace(path)
        core.callLater(100,core.triggerNVDAExit)


class GlobalPlugin(globalPluginHandler.GlobalPlugin):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        core.callLater(1500,run_membership_host_probe)
'''


def sha256_file(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream,"sha256").hexdigest()


def sample_cases(document):
    if (document.get("format")!="dordiai-primary-native-word-membership" or
            document.get("status")!="source-membership-acquired"):
        raise ValueError("Actual source acquisition receipt required")
    values={}
    for rows in document.get("non_initial_forms_not_in_frequency_sample",{}).values():
        for row in rows:
            values[row["word"]]=sorted(row["memberships"])
    for word in document.get("ambiguous_membership_sample",[]):
        values[word]=["ru","uk"]
    if len(values)!=96:
        raise ValueError("Expected the exact96 independently selected source samples")
    values["invalid control with spaces"]=[]
    return [{"word":word,"memberships":expected} for word,expected in sorted(values.items())]


def prepare_owned_inputs(dataset,run):
    dataset,run=Path(dataset),Path(run)
    binary=dataset/"native-word-membership.bin"
    source=dataset/"acquisition-report.json"
    leaf=ROOT/"source/0.12.2/kx47Runtime/native_word_membership.py"
    if binary.is_symlink() or binary.stat().st_size!=DATA_BYTES or sha256_file(binary)!=DATA_SHA256:
        raise ValueError("Pinned DMLX resource differs")
    if source.stat().st_size>1024*1024 or sha256_file(source)!=SOURCE_REPORT_SHA256:
        raise ValueError("Pinned source receipt differs")
    if not leaf.is_file() or leaf.is_symlink() or leaf.stat().st_size>1024*1024:
        raise ValueError("Trusted project leaf is unavailable")
    cases=sample_cases(json.loads(source.read_text(encoding="utf-8")))
    external=run/"external"
    external.mkdir()
    copied_module=external/"native_word_membership.py"
    copied_data=external/"native-word-membership.bin"
    shutil.copyfile(leaf,copied_module)
    shutil.copyfile(binary,copied_data)
    module_digest=sha256_file(leaf)
    if sha256_file(copied_module)!=module_digest or sha256_file(copied_data)!=DATA_SHA256:
        raise ValueError("Owned external copy changed during preparation")
    return {"module_path":str(copied_module),"module_sha256":module_digest,
            "data_path":str(copied_data),"data_sha256":DATA_SHA256,"cases":cases,
            "source_report_sha256":SOURCE_REPORT_SHA256}


def base_controller():
    spec=importlib.util.spec_from_file_location("_dordiai_pinned_nvda_bootstrap",
        Path(__file__).with_name("windows_nvda_probe.py"))
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stop_owned(process):
    if process is not None and process.poll() is None:
        subprocess.run(["taskkill","/PID",str(process.pid),"/T","/F"],
                       stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
        process.wait(timeout=20)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-dir",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--installer-cache",type=Path)
    parser.add_argument("--timeout",type=float,default=180)
    args=parser.parse_args(argv)
    if not 1<=args.timeout<=300:
        parser.error("Owned probe timeout must be within1..300seconds")
    args.output.mkdir(parents=True,exist_ok=False)
    output=args.output.resolve()
    report={"format":"dordiai-frozen-nvda-membership-controller","format_version":1,"status":"blocked",
        "scope":"Actual host compatibility only; no product addon installed/modified",
        "nvda_host_verified":False,"production_routing_verified":False,
        "physical_audio_verified":False,"acoustic_latency_verified":False,"pronunciation_verified":False,
        "product_ready":False,"product_archive_used":False}
    process=None
    run=None
    try:
        if os.name!="nt":
            report["reason"]="Real Windows frozen NVDA host required"
            return 2
        base=base_controller()
        existing=base.existing_nvda_processes()
        if existing:
            report["reason"]="Unrelated NVDA instance active; refusing interaction"
            return 2
        # A short disposable location avoids the official NVDA portable installer's
        # directory MAX_PATH limitation. This is explicitly NOT installed long-path proof.
        run=Path(tempfile.mkdtemp(prefix="dml-nvda-"))
        run_id=uuid.uuid4().hex
        report.update(run_id=run_id,run_directory=str(run),data_sha256=DATA_SHA256,
                      dataset_bytes=DATA_BYTES,installed_long_path_verified=False)
        settings=prepare_owned_inputs(args.dataset_dir.resolve(),run)
        config=run/"config"
        config.mkdir()
        configuration=("[general]\nshowWelcomeDialog = False\naskToExit = False\nsaveConfigurationOnExit = False\n"
            "playStartAndExitSounds = False\nlanguage = en\n[update]\nautoCheck = False\nstartupNotification = False\n"
            "[speech]\nsynth = silence\n")
        (config/"nvda.ini").write_text(configuration,encoding="utf-8")
        installer=base.verified_installer(args.installer_cache.resolve() if args.installer_cache else output/"nvda_2026.3.1.exe")
        report.update(installer_sha256=base.NVDA_SHA256,nvda_version=base.NVDA_VERSION)
        portable=run/"portable"
        command=[str(installer),"--create-portable-silent","--portable-path="+str(portable),
            "--config-path="+str(config),"--no-sr-flag","--minimal","--log-file="+str(run/"portable-creation.log")]
        with (run/"portable-creation-console.log").open("wb") as console:
            process=subprocess.Popen(command,cwd=run,stdout=console,stderr=subprocess.STDOUT)
            base.wait_process(process,min(args.timeout,180))
        process=None
        executable=portable/"nvda.exe"
        if not executable.is_file():
            raise RuntimeError("Pinned portable NVDA was not created")
        (config/"nvda.ini").write_text(configuration,encoding="utf-8")
        addon=config/"addons/dordiaiMembershipProbe"
        plugins=addon/"globalPlugins"
        plugins.mkdir(parents=True)
        (addon/"manifest.ini").write_text('name = "dordiaiMembershipProbe"\nsummary = "Owned external native membership host probe"\nversion = "1.0.0"\nauthor = "dordiai-voices"\nminimumNVDAVersion = "2026.1"\nlastTestedNVDAVersion = "2026.3.1"\n',encoding="utf-8")
        settings.update(run_id=run_id,report_path=str(run/"host-probe.json"))
        source=HOST_PLUGIN.replace("__HOST_MEMBERSHIP_SETTINGS__",repr(settings))
        compile(source,"owned-frozen-nvda-membership-probe","exec")
        (plugins/"dordiaiMembershipProbe.py").write_text(source,encoding="utf-8")
        report["external_candidate"]={key:value for key,value in settings.items() if key!="cases"}
        command=[str(executable),"--config-path="+str(config),"--log-file="+str(run/"nvda.log"),
                 "--debug-logging","--no-sr-flag","--minimal","--lang=en"]
        with (run/"nvda-console.log").open("wb") as console:
            process=subprocess.Popen(command,cwd=portable,stdout=console,stderr=subprocess.STDOUT)
            base.wait_process(process,args.timeout)
        process=None
        candidate=json.loads((run/"host-probe.json").read_text(encoding="utf-8"))
        if candidate.get("run_id")!=run_id:
            raise ValueError("Owned host receipt identity differs")
        report["probe"]=candidate
        report["status"]=candidate["status"]
        report["nvda_host_verified"]=candidate["status"]=="passed-host-compatibility"
        outcome=0 if report["nvda_host_verified"] else 1
    except Exception as error:
        report.update(status="failed",error_type=type(error).__name__,reason=str(error))
        outcome=1
    finally:
        try:
            stop_owned(process)
        except Exception as cleanup_error:
            report["cleanup_error_type"]=type(cleanup_error).__name__
            report["status"]="failed-cleanup"
            report["nvda_host_verified"]=False
        if run is not None:
            for name in ("host-probe.json","nvda.log","nvda-console.log","portable-creation.log","portable-creation-console.log"):
                source=run/name
                if source.is_file():
                    raw=source.read_bytes()
                    (output/name).write_bytes(raw[-2*1024*1024:])
        (output/"controller.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        print("NATIVE_FROZEN_NVDA_HOST "+json.dumps(report,ensure_ascii=True),flush=True)
    return 1 if report.get("cleanup_error_type") else outcome


if __name__=="__main__":
    raise SystemExit(main())
