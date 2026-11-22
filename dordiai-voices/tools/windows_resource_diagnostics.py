"""Inspect fixed bundled Windows resource paths; no product acceptance."""
from __future__ import annotations
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import zipfile

CHILD = r'''
import contextlib,inspect,json,os,sys
from pathlib import Path
runtime, folder = Path(sys.argv[1]), Path(sys.argv[2])
sys.path.insert(0,str(runtime))
from windows_runtime import configure_worker_import_paths,private_runtime_path,reset_inherited_dll_directory
report={"scope":"fixed Windows resource diagnostics; no user input or product acceptance"}
report["bootstrap"]=reset_inherited_dll_directory()
report["paths"]=configure_worker_import_paths()
import numpy as np
import mms_family_sessions as shared
report["stat_samples"]=[]
for path in (runtime/"models/MMSShared/graph.onnx",folder/"model.onnx"):
 row={"basename":path.name,"path_length":len(str(path)),"before_path":shared.signature(path)}
 with path.open("rb") as stream:
  row["before_fd"]=shared._stat_key(os.fstat(stream.fileno()))
  mapped=np.memmap(stream,dtype=np.uint8,mode="r")
  row["mapped_path"]=shared.signature(path)
  row["mapped_fd"]=shared._stat_key(os.fstat(stream.fileno()))
  del mapped
 row["after_path"]=shared.signature(path)
 report["stat_samples"].append(row)
os.environ["DORDIAI_MMS_SHARED_GRAPH"]="1"
original=shared._assert_current
def traced(model,identity,epoch):
 try:
  return original(model,identity,epoch)
 except Exception:
  report["shared_identity_failure"]={"expected_model":identity,"actual_model":shared.signature(model),
    "epoch":[{"basename":Path(path).name,"expected":saved,"actual":shared.signature(path)}
              for path,saved in epoch if shared.signature(path)!=saved]}
  raise
shared._assert_current=traced
try:
 from wide_mms import MMSCarrier
 carrier=MMSCarrier(folder)
 audio,rate,_=carrier.audio("Sannu duniya.",noise_scale=0.,noise_scale_w=0.)
 report["shared_carrier"]={"status":"passed-engine-only","mode":carrier.model_session_mode,"frames":len(audio)}
 carrier.close()
except Exception as error:
 report["shared_carrier"]={"type":type(error).__name__,"message":str(error)[:4096]}
import stressonnx.download as download
import stressonnx.backends.ruaccent as ruaccent
report["stressor_download_source"]=inspect.getsource(download._download_files)[:12000]
report["stressor_load_source"]=inspect.getsource(ruaccent.RuAccentStressor._load)[:12000] if hasattr(ruaccent,"RuAccentStressor") else None
report["stress_module_classes"]=[key for key,value in vars(ruaccent).items() if isinstance(value,type)]
cache=runtime/"models/stress"
report["stress_cache"]=[{"relative":str(p.relative_to(cache)),"bytes":p.stat().st_size}
 for p in cache.rglob("*") if p.is_file()]
from stressonnx import make_stressor
report["stress_cases"]=[]
for label,path in (("plain_absolute",str(cache)),("extended_absolute",private_runtime_path(cache)),("relative",str(Path("models")/"stress"))):
 row={"label":label,"path_length":len(path)}
 try:
  stressor=make_stressor(lang="ru",cache_dir=path)
  result=stressor("Проверка.")
  row.update(status="passed",result=result)
 except Exception as error:
  row.update(type=type(error).__name__,message=str(error)[:4096])
  cause=error.__cause__
  if cause is not None:row["cause"]={"type":type(cause).__name__,"message":str(cause)[:4096]}
 report["stress_cases"].append(row)
print(json.dumps(report,ensure_ascii=True))
'''

def load(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module
    spec.loader.exec_module(module)
    return module

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--addon",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    output=args.output.resolve()
    output.mkdir(parents=True,exist_ok=True)
    addon=output/"addon"
    with zipfile.ZipFile(args.addon) as archive:
        archive.extractall(addon)
    runtime=addon/"kx47Runtime"
    toolroot=Path(__file__).resolve().parent
    probe=load(toolroot/"windows_mms_probe.py","resource_diagnostic_mms")
    acquire=load(toolroot/"prepare_mms_models.py","resource_diagnostic_acquire")
    fixture=json.loads(probe.DEFAULT_FIXTURE.read_text(encoding="utf-8"))
    index=json.loads(probe.DEFAULT_INDEX.read_text(encoding="utf-8"))
    stage=output/"staging/MMS/ha"
    probe.stage_resources(fixture,index,stage,acquire.download)
    completed=subprocess.run([str(runtime/"python/python.exe"),"-I","-B","-u","-c",CHILD,str(runtime),str(stage)],
        cwd=runtime,capture_output=True,text=True,encoding="utf-8",errors="replace",timeout=180)
    (output/"child-stderr.log").write_text(completed.stderr[-131072:],encoding="utf-8")
    print(completed.stdout[-1048576:],flush=True)
    print(completed.stderr[-131072:].encode("ascii",errors="backslashreplace").decode("ascii"),flush=True)
    report={"scope":"fixed diagnostics only; no product acceptance","exit_code":completed.returncode}
    try:report["observations"]=json.loads(completed.stdout)
    except (ValueError,TypeError):report["status"]="invalid-diagnostic-output"
    (output/"report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    return completed.returncode

if __name__=="__main__":
    raise SystemExit(main())
