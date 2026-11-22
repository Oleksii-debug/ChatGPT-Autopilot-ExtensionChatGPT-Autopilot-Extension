"""Build source12 from immutable core11 resources, then probe the real packaged worker.

This never reapplies the old source-bound bank overlay. Existing bank/private
bytes must survive unchanged. Audio is measured at the worker pipe, not a device.
"""
from __future__ import annotations
import argparse
from hashlib import sha1, sha256
import importlib.util
import json
import os
import re
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import time
import zipfile

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
CORE11_SIZE = 1992938157
CORE11_SHA256 = "223e5ea7b29d0f9d16f3ca653711e8ced281c0fc7d5bd2fb891018a73926eceb"
CORE11_RUN = 45029834209
VERSION = "0.13.1-dev.12"
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


IMMUTABLE_MODELS = "kx47Runtime/models/"
PRIVATE_PREFIX = "kx47Runtime/python/"
BANK_PREFIXES = ("kx47Runtime/models/voices/native_letters/",
                 "kx47Runtime/models/voices/native_commands/")
CHARACTER_NAME_SOURCES = {
    "ay": (32, "227ed343f0d68d460159bfb7f9a2a785085f82629a50fdd0d2498e3a2260b072"),
    "fil": (28, "5f20b7eb93ef53af129822bede538121b8967fbc0e7fd93c64bef646d740f66f"),
}
CHARACTER_NAME_PATHS = {"kx47Runtime/models/CharacterNames/" + code + ".json" for code in CHARACTER_NAME_SOURCES}


def character_name_review(source, pin_path):
    """Approve only the two exact source-backed factual name payloads for12."""
    pin_path = Path(pin_path)
    if pin_path.is_symlink() or not pin_path.is_file() or pin_path.stat().st_size > 65536:
        raise ValueError("Bounded reviewed character-name pin file required")
    document = json.loads(pin_path.read_text(encoding="utf-8"))
    files = document.get("files")
    if (document.get("format") != "dordiai-source12-character-name-review"
            or document.get("format_version") != 1
            or not isinstance(files, dict) or set(files) != CHARACTER_NAME_PATHS):
        raise ValueError("Exactly the two reviewed CharacterNames paths are required")
    approved = {}
    for code, (count, primary_sha) in CHARACTER_NAME_SOURCES.items():
        name = "kx47Runtime/models/CharacterNames/" + code + ".json"
        row = files[name]
        if (not isinstance(row, dict) or row.get("source_repertoire_count") != count
                or row.get("primary_source_sha256") != primary_sha
                or not isinstance(row.get("sha256"), str) or not re.fullmatch("[0-9a-f]{64}", row["sha256"])
                or type(row.get("size_bytes")) is not int or not 0 < row["size_bytes"] <= 2*1024**2):
            raise ValueError("Invalid exact reviewed ordinary-name payload record: " + code)
        path = Path(source) / name
        pinned(path, row["size_bytes"], row["sha256"])
        value = json.loads(path.read_text(encoding="utf-8"))
        repertoire = value.get("ordinary_alphabet_source_repertoire", [])
        names = value.get("letter_names", {})
        semantics = value.get("semantics", {})
        primary = value.get("sources", {}).get("curated_primary_alphabet_names", {})
        # AY retains the earlier ILCA attribution and records the newly checked
        # Ministry table as explicit primary corroboration, rather than erasing
        # the original source history. FIL uses the KWF table directly.
        actual_primary_sha = (primary.get("primary_corroboration", {}).get("sha256")
                              if code == "ay" else primary.get("sha256"))
        if (value.get("format") != "dordiai-character-name-sources" or value.get("format_version") != 1
                or value.get("language") != code or value.get("ordinary_alphabet_source_complete") is not True
                or not isinstance(repertoire, list) or len(repertoire) != count or len(set(repertoire)) != count
                or not isinstance(names, dict) or any(not isinstance(names.get(glyph), str) or not names[glyph].strip()
                                                   for glyph in repertoire)
                or actual_primary_sha != primary_sha
                or value.get("letter_names_ready") is not False
                or semantics.get("native_pronunciation_verified") is not False):
            raise ValueError("Reviewed character facts/counts/source or honest acceptance flags differ: " + code)
        approved[name] = {"sha256": row["sha256"], "size_bytes": row["size_bytes"]}
    return approved


def verify_preservation(old, new, reviewed_character_names=None):
    """Require exact existing models, identities,180 banks and private runtime."""
    if (old.get("version") != "0.13.1-dev.11" or new.get("version") != VERSION
            or len(old.get("voice_ids", [])) != 45
            or len(set(old.get("voice_ids", []))) != 45
            or set(new.get("voice_ids", [])) != set(old["voice_ids"])
            or len(new.get("voice_ids", [])) != 45):
        raise ValueError("Wrong core11 baseline, core12 output or allowed identity set")
    approved = reviewed_character_names or {}
    if approved and set(approved) != CHARACTER_NAME_PATHS:
        raise ValueError("No model exception outside the exact two reviewed CharacterNames files")
    original, produced = old.get("files"), new.get("files")
    if not isinstance(original, dict) or not isinstance(produced, dict):
        raise ValueError("Missing release inventories")
    banks = {name: row for name, row in original.items() if name.startswith(BANK_PREFIXES)}
    private = {name: row for name, row in original.items() if name.startswith(PRIVATE_PREFIX)}
    models = {name: row for name, row in original.items() if name.startswith(IMMUTABLE_MODELS) and name not in approved}
    extra_models = {name for name in produced if name.startswith(IMMUTABLE_MODELS) and name not in original}
    if extra_models - set(approved):
        raise ValueError("Unreviewed new model/identity payload in core12")
    if any(name.startswith(PRIVATE_PREFIX) and name not in original for name in produced):
        raise ValueError("New private runtime/package payload in core12")
    if len(banks) != 180 or len(private) != 1596:
        raise ValueError("Expected exact source11 bank/private inventories")
    for label, records in (("prepared bank", banks), ("private runtime", private), ("model/identity", models)):
        if any(produced.get(name) != row for name, row in records.items()):
            raise ValueError("An immutable core11 " + label + " payload changed")
    if any(produced.get(name) != row for name, row in approved.items()):
        raise ValueError("A reviewed character-name payload is missing or differs from its exact pin")
    required = {
        "kx47Runtime/models/WordLanguage/native-word-membership.bin":
            {"size_bytes": BINARY_SIZE, "sha256": BINARY_SHA256},
        "kx47Runtime/models/WordLanguage/native-word-membership.json":
            {"size_bytes": DESCRIPTOR_SIZE, "sha256": DESCRIPTOR_SHA256},
    }
    if any(original.get(name) != row or produced.get(name) != row for name, row in required.items()):
        raise ValueError("Exact dictionary/descriptor pins missing or changed")
    notice = "kx47Runtime/models/WordLanguage/native-word-membership.NOTICE.json"
    if notice not in original or produced.get(notice) != original[notice]:
        raise ValueError("Exact original dictionary source notice was not retained")
    return {"existing_prepared_bank_files_byte_identical": len(banks),
            "existing_private_files_byte_identical": len(private),
            "existing_model_identity_files_byte_identical": len(models),
            "allowed_voice_identity_set_unchanged": True,
            "native_membership_data_descriptor_notice_byte_identical": True,
            "reviewed_character_name_payloads": approved}


def build(args):
    pinned(args.baseline_addon, CORE11_SIZE, CORE11_SHA256)
    check_packs(args.packs)
    reviewed_names = character_name_review(args.source, args.character_name_pins) if args.character_name_pins else {}
    work = args.work.resolve()
    if work.exists() or work.is_symlink():
        raise FileExistsError("Build staging must be new")
    work.mkdir(parents=True)
    baseline = work / "immutable-core11-resources"
    old = extract_release(args.baseline_addon, baseline, omit_generated_manifest=True)
    if old.get("version") != "0.13.1-dev.11" or len(old.get("voice_ids", [])) != 45:
        raise ValueError("Wrong immutable core11 resource baseline")
    source = args.source.resolve()
    runtime = source / "kx47Runtime"
    for name, expected in AFRI_SOURCE_PINS.items():
        raw = (runtime / name).read_bytes()
        actual = sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()
        if actual != expected:
            raise ValueError("Production native adapter differs from actual225-tested source: " + name)
    index = json.loads((runtime / "wide_voice_index.json").read_text(encoding="utf-8"))
    if any(index.get(code, {}).get("backend") != "afri-six-onnx" for code in WORDS):
        raise ValueError("Production native carrier mapping changed")
    overlay = work / "source12-overlay"
    shutil.copytree(source, overlay, symlinks=True)
    # All acoustic resources and dictionary data already exist in exact core11.
    # No old generated bank overlay, model preparation or dictionary rebuild runs.
    sys.path.insert(0, str(PROJECT / "tools"))
    import build_release
    result = build_release.build_release(baseline, overlay, args.output, version=VERSION, only=["core"])
    result.update(baseline="0.13.1-dev.11", baseline_archive_sha256=CORE11_SHA256,
                  baseline_source_run=CORE11_RUN, old_prepared_bank_overlay_reapplied=False,
                  acoustic_model_preparation_performed=False, native_dictionary_rebuilt=False)
    write_json(args.output / "release-build.json", result)
    artifact = next(row for row in result["artifacts"] if row["group"] == "core")
    addon = args.output / artifact["filename"]
    subprocess.run([sys.executable, str(PROJECT / "tools/verify_release.py"), str(addon)], check=True)
    with zipfile.ZipFile(addon) as archive:
        manifest = json.loads(archive.read("dordiai-release.json"))
        if len(archive.namelist()) != len(set(archive.namelist())):
            raise ValueError("Generated core contains duplicate inventory entry")
        unchanged = verify_preservation(old, manifest, reviewed_names)
    proof = {"status": "actual-source12-built-from-immutable-core11-resources",
             "source_commit": os.environ.get("GITHUB_SHA"), "version": VERSION, "artifact": artifact,
             "resource_baseline": {"run": CORE11_RUN, "sha256": CORE11_SHA256, "bytes": CORE11_SIZE,
                                   "source_commit": "84ca83e36e729fece88fc56af078a0de826d9db3"},
             "old_source_bound_overlay_reapplied": False, "generated_old_inventory_omitted": True,
             "acoustic_model_preparation_performed": False, "native_dictionary_rebuilt": False,
             **unchanged, "native_membership_sha256": BINARY_SHA256,
             "native_membership_descriptor_sha256": DESCRIPTOR_SHA256,
             "optional_pack_files": PACKS, "nvda_verified": False,
             "physical_audio_verified": False, "pronunciation_verified": False, "product_ready": False}
    write_json(args.report, proof)
    # Only this call's owned newly created baseline extraction is removed.
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
    package = args.work.resolve()/"assembled-source12"
    manifest = extract_release(addon,package)
    if manifest.get("version") != VERSION or len(manifest.get("voice_ids",[])) != 45:
        raise ValueError("Actual source12 assembled core/version differs")
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
              "actual_assembled_source12":True,"actual_package_installer":True,
              "resource_baseline_sha256":CORE11_SHA256,"addon_sha256":artifact["sha256"],
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
        report.update(status="actual-source12-worker225-and-resource-recovery-passed",
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
    if report["status"] != "actual-source12-worker225-and-resource-recovery-passed":
        raise RuntimeError("Actual source12 worker integration did not complete cleanly")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase",choices=("build","probe"))
    parser.add_argument("--source",type=Path)
    parser.add_argument("--baseline-addon",type=Path)
    parser.add_argument("--character-name-pins",type=Path)
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
    needed = ("source","baseline_addon","output") if args.phase=="build" else ("addon","build_report")
    if any(getattr(args,name) is None for name in needed):
        parser.error("Missing phase-specific input")
    if not 0<args.timeout<=300:
        parser.error("Request timeout must be0..300seconds")
    result = globals()[args.phase](args)
    print("SOURCE12_RESULT "+json.dumps({key:result.get(key) for key in
        ("status","version","actual_selected_profile_cases","existing_prepared_bank_files_byte_identical",
         "existing_private_files_byte_identical","nvda_verified","physical_audio_verified","product_ready")}),flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
