"""Build source11 from immutable core10 resources, then probe the real packaged worker.

This never reapplies the old source-bound bank overlay. Existing bank/private
bytes must survive unchanged. Audio is measured at the worker pipe, not a device.
"""
from __future__ import annotations
import argparse
from hashlib import sha1, sha256
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import time
import zipfile

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
CORE10_SIZE = 1974796411
CORE10_SHA256 = "437bb9394df5b44cb1a99edee21312f6255b8cc74622c0bcc15b3513e6c328d8"
CORE10_RUN = 45021069771
VERSION = "0.13.1-dev.11"
BINARY_SIZE = 18661227
BINARY_SHA256 = "21208748a50ebf3f5dd3e2feb94f0f3caf3490c2be784aaca2209462380e6689"
DESCRIPTOR_SIZE = 558
DESCRIPTOR_SHA256 = "2de5611c384e933e19d1cdf5fda37f17bd5c4b7602d09964f53fdb7280877459"
AFRI_SOURCE_PINS = {"wide_afri_six.py":"8b23c8a15fac1cc0f219115f4853907c85db2264",
                    "wide_afri_frontend.py":"a6a765b5ffc28d6c825340a16df528a75d310120"}
WORDS = {"ss":"KUCOLELA","ve":"Tshivhi","zu":"Usizo","wo":"Bul","nso":"Dilo"}
PACKS = {
  "afri-six-shared-1.0.0.zip": {
    "bytes": 369927753,
    "sha256": "647ba0a235404ecca1101795c71d7f7e08d3de3601172f8e0542e1568f27ba1d"
  },
  "afri-six-ss-1.0.0.zip": {
    "bytes": 150948,
    "sha256": "efa397443408e86820599606cab4e1ebd582745060b8deb193092141b9d80ce6"
  },
  "afri-six-ve-1.0.0.zip": {
    "bytes": 171864,
    "sha256": "af379f952c34b1b1a162920ed65d4ddba83caea2221e906a4be320b92ec8a95c"
  },
  "afri-six-zu-1.0.0.zip": {
    "bytes": 192861,
    "sha256": "70225adacc32cd55be92902051d66d6012624961f34873ae18788ab6addcf0a1"
  },
  "afri-six-wo-1.0.0.zip": {
    "bytes": 122837,
    "sha256": "651bd8049d9698b3441d3cf54db926801fc0cf190a269da8dca06f8a521370ac"
  },
  "afri-six-nso-1.0.0.zip": {
    "bytes": 142068,
    "sha256": "d89dbaae31183979eae68a61a101fae6f44a22a0c2b502e5e04957decbaa9d62"
  }
}


def digest(path):
    with Path(path).open("rb") as stream:
        return __import__("hashlib").file_digest(stream,"sha256").hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")


def pinned(path, amount, expected):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size != amount or digest(path) != expected:
        raise ValueError("Immutable input size/SHA differs: "+path.name)


def valid_name(name):
    parts = name.rstrip("/").split("/")
    if ("\\" in name or ":" in name or "\0" in name or name.startswith("/")
            or any(part in ("", ".", "..") for part in parts)):
        raise ValueError("Unsafe release member")
    return name


def extract_release(path, destination, *, omit_generated_manifest=False):
    """Check every released payload before extraction; retain exact bytes."""
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise FileExistsError("Owned extraction directory must be new")
    with zipfile.ZipFile(path) as archive:
        entries, names = {}, set()
        for entry in archive.infolist():
            name = valid_name(entry.filename)
            if name.casefold() in names:
                raise ValueError("Duplicate or case-colliding release path")
            names.add(name.casefold())
            mode = stat.S_IFMT(entry.external_attr >> 16)
            if mode not in (0,stat.S_IFREG,stat.S_IFDIR) or entry.flag_bits & 1:
                raise ValueError("Linked/encrypted release member")
            if not entry.is_dir():
                entries[name] = entry
        if "dordiai-release.json" not in entries or entries["dordiai-release.json"].file_size > 32*1024**2:
            raise ValueError("Missing/oversized release inventory")
        manifest = json.loads(archive.read(entries["dordiai-release.json"]))
        files = manifest.get("files")
        if (manifest.get("format") != "dordiai-core-release" or not isinstance(files,dict)
                or set(entries) != set(files)|{"dordiai-release.json"}
                or len(files)>100000 or sum(row["size_bytes"] for row in files.values())>12*1024**3):
            raise ValueError("Release inventory does not exactly cover its archive")
        destination.mkdir(parents=True)
        for name, entry in entries.items():
            if name == "dordiai-release.json" and omit_generated_manifest:
                continue
            target = destination / name
            target.parent.mkdir(parents=True,exist_ok=True)
            state, amount = sha256(), 0
            with archive.open(entry) as source, target.open("xb") as output:
                for block in iter(lambda:source.read(1024**2),b""):
                    amount += len(block)
                    if amount > entry.file_size:
                        raise ValueError("Release expansion exceeds declared size")
                    output.write(block); state.update(block)
            if amount != entry.file_size or name in files and files[name] != {
                    "size_bytes":amount,"sha256":state.hexdigest()}:
                raise ValueError("Released payload differs from exact inventory: "+name)
    return manifest


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name,path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_packs(directory):
    directory = Path(directory)
    actual = {path.name for path in directory.glob("*.zip")}
    if actual != set(PACKS):
        raise ValueError("Expected exactly six immutable optional native packs")
    for name,record in PACKS.items():
        pinned(directory/name,record["bytes"],record["sha256"])


def build(args):
    pinned(args.baseline_addon,CORE10_SIZE,CORE10_SHA256)
    check_packs(args.packs)
    work = args.work.resolve()
    if work.exists() or work.is_symlink():
        raise FileExistsError("Build staging must be new")
    work.mkdir(parents=True)
    baseline = work/"immutable-core10-resources"
    old = extract_release(args.baseline_addon,baseline,omit_generated_manifest=True)
    if old.get("version") != "0.13.1-dev.10" or len(old.get("voice_ids",[])) != 45:
        raise ValueError("Wrong immutable core10 resource baseline")
    source = args.source.resolve()
    runtime = source/"kx47Runtime"
    for name,expected in AFRI_SOURCE_PINS.items():
        raw = (runtime/name).read_bytes()
        actual = sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest()
        if actual != expected:
            raise ValueError("Production native adapter differs from actual225-tested reviewed source: "+name)
    if ("afri-six-onnx" not in (runtime/"wide_voice.py").read_text(encoding="utf-8")
            or "afri-six-onnx" not in (runtime/"language_catalog.py").read_text(encoding="utf-8")):
        raise ValueError("Production controller/catalog integration has not been merged")
    index = json.loads((runtime/"wide_voice_index.json").read_text(encoding="utf-8"))
    for code in WORDS:
        if index.get(code,{}).get("backend") != "afri-six-onnx":
            raise ValueError("Production catalogue does not select exact native carrier: "+code)
    overlay = work/"source11-overlay"
    shutil.copytree(source,overlay,symlinks=True)
    word_root = overlay/"kx47Runtime/models/WordLanguage"
    word_root.mkdir(parents=True,exist_ok=True)
    pinned(args.membership/"native-word-membership.bin",BINARY_SIZE,BINARY_SHA256)
    descriptor = PROJECT/"tools/data/native_word_membership_resource_v1.json"
    pinned(descriptor,DESCRIPTOR_SIZE,DESCRIPTOR_SHA256)
    shutil.copyfile(descriptor,word_root/"native-word-membership.json")
    shutil.copyfile(args.membership/"native-word-membership.bin",word_root/"native-word-membership.bin")
    notice = args.membership/"SOURCE-NOTICES.json"
    if not notice.is_file() or notice.stat().st_size>1024**2:
        raise ValueError("Native membership source attribution is absent/oversized")
    json.loads(notice.read_text(encoding="utf-8"))
    shutil.copyfile(notice,word_root/"native-word-membership.NOTICE.json")
    sys.path.insert(0,str(PROJECT/"tools"))
    import build_release
    result = build_release.build_release(baseline,overlay,args.output,version=VERSION,only=["core"])
    result.update(baseline="0.13.1-dev.10",baseline_archive_sha256=CORE10_SHA256,
                  baseline_source_run=CORE10_RUN,old_prepared_bank_overlay_reapplied=False)
    write_json(args.output/"release-build.json",result)
    artifact = next(row for row in result["artifacts"] if row["group"]=="core")
    addon = args.output/artifact["filename"]
    subprocess.run([sys.executable,str(PROJECT/"tools/verify_release.py"),str(addon)],check=True)
    with zipfile.ZipFile(addon) as archive:
        manifest = json.loads(archive.read("dordiai-release.json"))
        if len(archive.namelist()) != len(set(archive.namelist())):
            raise ValueError("Generated core contains duplicate inventory entry")
        banks = {name:row for name,row in old["files"].items() if
                 name.startswith(("kx47Runtime/models/voices/native_letters/",
                                  "kx47Runtime/models/voices/native_commands/"))}
        if len(banks) != 180 or any(manifest["files"].get(name)!=row for name,row in banks.items()):
            raise ValueError("Existing180 prepared bank files changed")
        private = {name:row for name,row in old["files"].items() if name.startswith("kx47Runtime/python/")}
        if not private or any(manifest["files"].get(name)!=row for name,row in private.items()):
            raise ValueError("An original private Python/package/DLL byte changed")
        if manifest["files"]["kx47Runtime/models/WordLanguage/native-word-membership.bin"] != {
                "size_bytes":BINARY_SIZE,"sha256":BINARY_SHA256}:
            raise ValueError("Built core does not ship exact complete native membership")
    proof = {"status":"actual-source11-built-from-immutable-core10-resources",
             "source_commit":os.environ.get("GITHUB_SHA"),"version":VERSION,"artifact":artifact,
             "resource_baseline":{"run":CORE10_RUN,"sha256":CORE10_SHA256,"bytes":CORE10_SIZE},
             "old_source_bound_overlay_reapplied":False,"generated_old_inventory_omitted":True,
             "existing_prepared_bank_files_byte_identical":len(banks),
             "existing_private_files_byte_identical":len(private),
             "native_membership_sha256":BINARY_SHA256,
             "native_membership_descriptor_sha256":DESCRIPTOR_SHA256,
             "optional_pack_files":PACKS,"nvda_verified":False,
             "physical_audio_verified":False,"pronunciation_verified":False,"product_ready":False}
    write_json(args.report,proof)
    # Free ONLY this function's newly created immutable-baseline extraction.
    shutil.rmtree(baseline)
    return proof



def native_backend_inventory(catalog, models, registry, *, native_expected):
    """Distinguish an installed native carrier from a valid same-language fallback."""
    labels = catalog.installed_languages(models)
    result = {}
    for code in WORDS:
        selected = catalog.resolve_backend_info(models,code,registry.get(code))
        if not isinstance(selected,dict):
            raise ValueError("Missing explicit native language registration: "+code)
        backend, choice = selected.get("backend"), selected.get("_backend_selection")
        native_ready = backend=="afri-six-onnx" and choice=="preferred"
        if native_expected:
            if not native_ready or code not in labels:
                raise ValueError("Installed native resources still select missing or fallback backend: "+code)
        else:
            if native_ready:
                raise ValueError("Native Afri resources unexpectedly installed before optional packs: "+code)
            if code in labels and not (code in {"zu","wo","nso"} and backend=="omni-onnx"
                    and choice=="explicit-same-language-fallback" and selected.get("language")==code):
                raise ValueError("Preinstalled language has no valid declared same-language fallback: "+code)
        result[code] = {"backend":backend,"selection":choice,"installed_language":code in labels,
                        "native_preferred_installed":native_ready,
                        "preferred_missing_resources":selected.get("_preferred_missing_resources",[])}
    return labels,result


def probe(args):
    if os.name != "nt":
        raise RuntimeError("Actual packaged worker probe requires Windows")
    build_proof = json.loads(args.build_report.read_text(encoding="utf-8"))
    artifact = build_proof["artifact"]
    addon = args.addon
    pinned(addon,artifact["size_bytes"],artifact["sha256"])
    check_packs(args.packs)
    package = args.work.resolve()/"assembled-source11"
    manifest = extract_release(addon,package)
    if manifest.get("version") != VERSION or len(manifest.get("voice_ids",[])) != 45:
        raise ValueError("Actual source11 assembled core/version differs")
    runtime = package/"kx47Runtime"
    sys.path.insert(0,str(runtime))
    import package_manager
    import language_catalog
    registry = json.loads((runtime/"wide_voice_index.json").read_text(encoding="utf-8"))
    before,before_backends = native_backend_inventory(
        language_catalog,runtime/"models",registry,native_expected=False)
    ordered = ["afri-six-shared-1.0.0.zip"]+[name for name in PACKS if name!="afri-six-shared-1.0.0.zip"]
    for name in ordered:
        package_manager.install_pack(args.packs/name,addon_root=package)
    installed,installed_backends = native_backend_inventory(
        language_catalog,runtime/"models",registry,native_expected=True)
    profiles = sorted(manifest["voice_ids"])
    for code in WORDS:
        compatible = language_catalog.compatible_voice_ids(runtime/"models",code,profiles)
        if set(compatible) != set(profiles):
            raise ValueError("Native resources do not expose all45 allowed voice profiles")
    try:
        package_manager.uninstall_pack("afri-six-shared",addon_root=package)
    except package_manager.PackageError:
        dependency_guard = True
    else:
        raise ValueError("Shared resource dependency removal was not blocked")
    harness = load_module("afri_integrated_engine_probe",PROJECT/"tools/windows_engine_probe.py")
    report = {"status":"running","version":VERSION,"source_commit":os.environ.get("GITHUB_SHA"),
              "actual_assembled_source11":True,"actual_package_installer":True,
              "resource_baseline_sha256":CORE10_SHA256,"addon_sha256":artifact["sha256"],
              "shared_dependency_guard":dependency_guard,"native_backend":"afri-six-onnx",
              "before_install_backend_inventory":before_backends,
              "installed_native_backend_inventory":installed_backends,"cases":[],
              "scope":"Actual packaged worker/controller/native-carrier/selected-profile PCM at pipe; no NVDA/audio device",
              "nvda_verified":False,"physical_audio_verified":False,
              "typing_verified":False,"pronunciation_verified":False,"product_ready":False}
    write_json(args.report,report)
    worker = None
    try:
        worker = harness.PipeWorker(runtime,args.report.parent/"worker-stderr.log")
        for code,word in WORDS.items():
            for profile in profiles:
                pcm,facts = worker.render(harness.make_request(code,profile,word),args.timeout)
                renderers = facts.get("renderers",[])
                if not renderers or any(row.get("engine")!="wide:"+code or row.get("speaker")!=profile for row in renderers):
                    raise ValueError("Actual worker routed to another native language or speaker")
                target = args.report.parent/"selected-profiles"/(code+"-"+profile+".wav")
                target.parent.mkdir(parents=True,exist_ok=True)
                harness.save_wave(target,pcm)
                report["cases"].append({"code":code,"profile":profile,"text":word,
                    "pcm_sha256":sha256(pcm).hexdigest(),"wav":str(target),
                    **facts})
                write_json(args.report,report)
        report["excluded_voice_checks"] = [worker.check_excluded_voice(voice,args.timeout)
                                            for voice in harness.EXCLUDED]
        long_request = harness.make_request("ss",profiles[0],("KUCOLELA " * 12).strip())
        report["actual_native_cancel"] = worker.cancel_request(long_request,args.timeout,30)
        pcm,facts = worker.render(harness.make_request("ve",profiles[0],WORDS["ve"]),args.timeout)
        report["post_cancel_recovery"] = {"finite_nonzero":bool(pcm),**facts}
        # Same persistent worker must refuse a removed native source, then recover
        # after the exact same own pack is reinstalled; no stale source/audio reuse.
        package_manager.uninstall_pack("afri-six-ss",addon_root=package)
        if "ss" in language_catalog.installed_languages(runtime/"models"):
            raise ValueError("Removed native language remains advertised")
        rejected = False
        try:
            worker.render(harness.make_request("ss",profiles[0],WORDS["ss"]),args.timeout)
        except harness.ProbeError as error:
            if "Speech engine error:" not in str(error):
                raise
            rejected = True
        if not rejected:
            raise ValueError("Removed optional native source still emitted cached audio")
        package_manager.install_pack(args.packs/"afri-six-ss-1.0.0.zip",addon_root=package)
        pcm,facts = worker.render(harness.make_request("ss",profiles[0],WORDS["ss"]),args.timeout)
        report["same_worker_resource_removal_and_restore"] = {
            "missing_source_rejected_before_pcm":True,"restored_source_emitted_pcm":bool(pcm),**facts}
        if len(report["cases"]) != 225 or len({row["pcm_sha256"] for row in report["cases"]}) != 225:
            raise ValueError("Actual worker225 selected-profile outputs are missing or unexpectedly identical")
        report.update(status="actual-source11-worker225-and-resource-recovery-passed",
                      actual_selected_profile_cases=225,
                      initial_installed_labels={code:installed[code] for code in WORDS})
    except Exception as error:
        report.update(status="failed",error_type=type(error).__name__,error=str(error))
        raise
    finally:
        if worker is not None:
            report["worker_shutdown"] = worker.close()
            if report["worker_shutdown"]["forced_termination"] or report["worker_shutdown"]["exit_code"] != 0:
                report.update(status="failed",shutdown_error="Actual owned worker did not exit cleanly")
        write_json(args.report,report)
    if report["status"] != "actual-source11-worker225-and-resource-recovery-passed":
        raise RuntimeError("Actual source11 worker integration did not complete cleanly")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase",choices=("build","probe"))
    parser.add_argument("--source",type=Path)
    parser.add_argument("--baseline-addon",type=Path)
    parser.add_argument("--membership",type=Path)
    parser.add_argument("--packs",type=Path,required=True)
    parser.add_argument("--work",type=Path,required=True)
    parser.add_argument("--output",type=Path)
    parser.add_argument("--report",type=Path,required=True)
    parser.add_argument("--addon",type=Path)
    parser.add_argument("--build-report",type=Path)
    parser.add_argument("--timeout",type=float,default=120)
    args = parser.parse_args()
    if args.report.exists() or args.report.is_symlink():
        parser.error("Report must be new")
    needed = ("source","baseline_addon","membership","output") if args.phase=="build" else ("addon","build_report")
    if any(getattr(args,name) is None for name in needed):
        parser.error("Missing phase-specific input")
    if not 0<args.timeout<=300:
        parser.error("Request timeout must be0..300seconds")
    result = globals()[args.phase](args)
    print("AFRI_SOURCE11_RESULT "+json.dumps({key:result.get(key) for key in
        ("status","version","actual_selected_profile_cases","existing_prepared_bank_files_byte_identical",
         "existing_private_files_byte_identical","nvda_verified","physical_audio_verified","product_ready")}),flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
