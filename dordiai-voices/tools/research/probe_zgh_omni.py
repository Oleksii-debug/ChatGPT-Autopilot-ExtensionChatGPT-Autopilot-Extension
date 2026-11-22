"""Isolated genuine ZGH OmniVoice + allowed-profile projection proof.

The source11 add-on, private Python3.14 and ORT1.26 stay byte-unchanged.
ZGH is enabled only in the research process's language whitelist. The model is
conditioned with literal zgh, never kab. No production resource is registered.
"""
from __future__ import annotations
import argparse
import ast
import base64
import gc
from datetime import datetime,timezone
from hashlib import sha1,sha256
import importlib.util
import io
import json
import math
import os
from pathlib import Path,PurePosixPath
import stat
import struct
import sys
import tempfile
from time import perf_counter
import traceback
from urllib.parse import urlsplit
from urllib.request import Request,urlopen
import wave
import zipfile

ROOT=Path(__file__).resolve().parents[2]
FIXTURE=ROOT/"tools/data/zgh_native_probe_fixture.json"
FIXTURE_SHA="f0914b056a4dbf131f54eb1cf8cbfbb45097f5539b883ecc17ced740021a1c42"
CORE_SHA="223e5ea7b29d0f9d16f3ca653711e8ced281c0fc7d5bd2fb891018a73926eceb"
CORE_SIZE=1992938157
MODEL_REPOSITORY="gaber/OmniVoice-ONNX-CPU-INT8"
MODEL_REVISION="efddec1c39169c79e57eb65f1a7b650d0906a182"
DOC_REVISION="c8c0a6257b9b652dc7d239df9d911dbb1f9dabdf"
DOC_BLOB="ac4cfedc4cf33e0589952ccf9f49b87bf970bbaf"
REFERENCE_REVISION="34d010c192c97f763207f488f6057fd07fee42ad"
MODELS={
 "SharedOmniONNX/backbone.int8.onnx":(993287060,"241610742675b990eb1cc50b32a86d7088762e43f070a8db36a501227ff855b7",None),
 "SharedOmniONNX/encoder.fp32.onnx":(654395766,"8e9697cf64ad4a2b66b6ae8cf2eedc2e3d80732568fde0ee6177164d8b32fbb9",None),
 "SharedOmniONNX/vocoder.fp32.onnx":(803873,"cfea73af6cf8fe93d16f18e4f8c4a54c9bf37389d5c296e49a896dc3a04c9e4c",None),
 "SharedOmniONNX/vocoder.fp32.onnx.data":(86310912,"ebbdf1cf7ddb8502fa02abf13be9ca0554657954b455cffd839440238da8ffc3",None),
 "SharedOmniONNX/tokenizer.json":(11423986,"408f669b7e2b045fdf54201d815bd364e6667dbd845115da81239c40bc6dcfd1",None),
 "SharedOmniONNX/README.md":(4247,None,"9cc7495d540dc7aa86084bf596aaaa221e93182f"),
 "SharedOmniONNX/LICENSE-HIGGS-AUDIO-2.txt":(9171,None,"000139f87ffdc03106fc422a3bd3cebebb9808b3"),
 "SharedOmniONNX/LICENSE-LLAMA3.txt":(12403,None,"1fec50c8afa68c72420930e6712c88780426457b"),
 "OpenVoiceV2/tone_ref_encoder.onnx":(3259275,"3dd4918cab90e1acf7fa5c6f7539c27710e7a3cdfba550468c5ea49399178bf7",None),
}
CONTROL_ZGH=[151670,89,866,151671]
CONTROL_KAB=[151670,74,370,151671]
PROFILE="viktoriia"
MAX_REPORT=8*1024**2


def fingerprint(path):
    value=sha256()
    size=0
    with Path(path).open("rb") as stream:
        for block in iter(lambda:stream.read(4*1024**2),b""):
            value.update(block);size+=len(block)
    return {"sha256":value.hexdigest(),"size_bytes":size}


def json_bytes(value):
    return (json.dumps(value,ensure_ascii=False,sort_keys=True,indent=2)+"\n").encode("utf-8")


def no_duplicates(pairs):
    result={}
    for key,value in pairs:
        if key in result:raise ValueError("Duplicate JSON property")
        result[key]=value
    return result


def reject_links(path):
    path=Path(path).absolute()
    for entry in (path,)+tuple(path.parents):
        if entry.is_symlink() or getattr(entry,"is_junction",lambda:False)():
            raise ValueError("Linked research input/output path")
    return path


def independent_output(path):
    path=reject_links(path)
    protected=[ROOT/name for name in ("source","packages","tools","tests","training-data","evidence")]
    protected.append(ROOT.parent/".github")
    actual=path.resolve()
    if any(actual==item.resolve() or actual.is_relative_to(item.resolve()) or item.resolve().is_relative_to(actual) for item in protected):
        raise ValueError("Research output overlaps protected project inputs")
    return path


def new_directory(path):
    path=independent_output(path)
    if path.exists():raise FileExistsError("Research directory is immutable; use a fresh path")
    path.mkdir(parents=True)
    return path


class Report:
    def __init__(self,path):
        self.path=independent_output(path)
        self.last=None
        if self.path.exists():raise FileExistsError("Another writer owns report")
    def write(self,value):
        raw=json_bytes(value)
        if len(raw)>MAX_REPORT:raise ValueError("Research metadata quota exceeded")
        if self.last is not None and fingerprint(self.path)!=self.last:
            raise ValueError("Owned report changed outside this process")
        if self.last is None and self.path.exists():
            raise FileExistsError("Another writer owns report")
        self.path.parent.mkdir(parents=True,exist_ok=True)
        fd,tmp=tempfile.mkstemp(prefix="zgh-report-",dir=self.path.parent)
        try:
            with os.fdopen(fd,"wb") as stream:
                stream.write(raw);stream.flush();os.fsync(stream.fileno())
            if self.last is None:os.link(tmp,self.path)
            else:os.replace(tmp,self.path)
            self.last={"sha256":sha256(raw).hexdigest(),"size_bytes":len(raw)}
        finally:Path(tmp).unlink(missing_ok=True)


def load_fixture(path):
    raw=reject_links(path).read_bytes()
    if len(raw)>1024**2 or sha256(raw).hexdigest()!=FIXTURE_SHA:
        raise ValueError("Frozen authentic native ZGH fixture differs")
    fixture=json.loads(raw,object_pairs_hook=no_duplicates)
    if (fixture.get("format")!="dordiai-authentic-zgh-calibration-v1" or fixture.get("language")!="zgh"
            or fixture.get("not_alias_of")!="kab" or fixture["source"]["revision"]!="8bbbc8e9efc363f13d5fd9a92d5c625102cab66a"
            or fixture["source"]["sha256"]!="0eea3e83739d8e49dabbc6659cb9b62ef249b0f8ad4cbba1e03fe79a37812e41"
            or fixture["source"]["licence"]!="Apache-2.0"):
        raise ValueError("Wrong actual native standard or source")
    ref=fixture["reference"]
    blob=base64.b64decode(ref["audio_base64"],validate=True)
    if len(blob)!=ref["audio_size_bytes"] or sha256(blob).hexdigest()!=ref["audio_sha256"]:
        raise ValueError("Authentic reference audio bytes differ")
    with wave.open(io.BytesIO(blob),"rb") as stream:
        if (stream.getnchannels(),stream.getsampwidth(),stream.getframerate(),stream.getnframes(),stream.getcomptype())!=(1,2,48000,66560,"NONE"):
            raise ValueError("Unexpected authentic ZGH WAV format")
    for row in [ref]+fixture["targets"]:
        if not row["text"] or len(row["text"])>180 or "<|" in row["text"] or "|>" in row["text"]:
            raise ValueError("Invalid literal native reference text")
        letters=[char for char in row["text"] if char.isalpha()]
        if not letters or any(not 0x2D30<=ord(char)<=0x2D7F for char in letters):
            raise ValueError("Authentic ZGH fixture must retain its original Tifinagh spelling")
    return fixture,blob


def verify_model(path,record):
    size,digest,git=record
    actual=fingerprint(path)
    if actual["size_bytes"]!=size or digest and actual["sha256"]!=digest:
        raise ValueError("Pinned model file bytes differ")
    if git:
        raw=Path(path).read_bytes()
        if sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest()!=git:
            raise ValueError("Pinned source model metadata differs")
    return actual


def request(url):
    response=urlopen(Request(url,headers={"User-Agent":"Dordiai-native-ZGH-research/1"}),timeout=120)
    parts=urlsplit(response.geturl())
    host=(parts.hostname or "").lower()
    if (parts.scheme!="https" or parts.username or parts.password or parts.port not in (None,443)
            or not (host in {"huggingface.co","raw.githubusercontent.com","github.com"}
                    or host.endswith(".hf.co") or host.endswith(".huggingface.co")
                    or host.endswith(".githubusercontent.com"))):
        response.close();raise ValueError("Public native source left expected storage")
    return response


def prepare(args):
    root=independent_output(args.assets)
    if not root.exists():new_directory(root)
    if not root.is_dir():raise ValueError("Model cache is not a directory")
    fixture,blob=load_fixture(args.fixture)
    files={}
    for name,record in MODELS.items():
        path=root/name
        reject_links(path)
        if path.exists():
            files[name]=verify_model(path,record)
            continue
        path.parent.mkdir(parents=True,exist_ok=True)
        size,digest,git=record
        if name.startswith("SharedOmniONNX/"):
            url="https://huggingface.co/"+MODEL_REPOSITORY+"/resolve/"+MODEL_REVISION+"/"+name.split("/",1)[1]
        else:
            url="https://huggingface.co/TigreGotico/voiceclonnx-openvoice-v2/resolve/"+REFERENCE_REVISION+"/tone_ref_encoder.onnx"
        fd,tmp=tempfile.mkstemp(prefix="zgh-source-",dir=path.parent)
        try:
            with os.fdopen(fd,"wb") as target:
                with request(url) as source:
                    amount=0
                    for block in iter(lambda:source.read(1024**2),b""):
                        amount+=len(block)
                        if amount>size:raise ValueError("Public model exceeds exact pinned size")
                        target.write(block)
            files[name]=verify_model(tmp,record)
            os.link(tmp,path)
        finally:Path(tmp).unlink(missing_ok=True)
        print("ZGH_PINNED_ASSET "+name+" "+files[name]["sha256"],flush=True)
    doc_url="https://raw.githubusercontent.com/k2-fsa/OmniVoice/"+DOC_REVISION+"/docs/languages.md"
    with request(doc_url) as response:doc=response.read(1024**2+1)
    if len(doc)>1024**2 or sha1(b"blob "+str(len(doc)).encode("ascii")+b"\0"+doc).hexdigest()!=DOC_BLOB:
        raise ValueError("Exact primary language table differs")
    if b"| 535 | Standard Moroccan Tamazight | zgh | zgh | 1.19 |" not in doc or b"| 274 | Kabyle | kab | kab | 529.52 |" not in doc:
        raise ValueError("Native training standard distinction missing")
    receipt={"format":"dordiai-zgh-pinned-model-acquisition-v1","files":files,
        "fixture_sha256":FIXTURE_SHA,"native_source":fixture["source"],"language":"zgh",
        "not_alias_of":"kab","model_repository":MODEL_REPOSITORY,"model_revision":MODEL_REVISION,
        "language_table_revision":DOC_REVISION,"language_table_git_blob":DOC_BLOB,
        "declared_training_hours":1.19,
        "licences":{"native_reference":"Apache-2.0","Omni_weights":"CC-BY-NC upstream OmniVoice; existing third-party INT8 export unchanged",
                    "Higgs_audio":"Included LICENSE-HIGGS-AUDIO-2.txt","Llama":"Included LICENSE-LLAMA3.txt","OpenVoiceV2_reference_encoder":"MIT"},
        "models_executed":False,"product_integrated":False}
    writer=Report(args.report);writer.write(receipt)
    return receipt


def safe_member(info):
    name=info.filename
    p=PurePosixPath(name)
    if (getattr(info,"orig_filename",name)!=name or "\\" in name or ":" in name or "\0" in name
            or p.is_absolute() or any(part in ("..",".") for part in p.parts) or p.as_posix()!=name):
        raise ValueError("Unsafe immutable core member")
    mode=stat.S_IFMT(info.external_attr>>16)
    if mode not in (0,stat.S_IFREG) or info.flag_bits&1:
        raise ValueError("Nonregular or encrypted immutable core member")
    return name


def selected_core_file(name):
    if name in {"dordiai-release.json","manifest.ini"}:return True
    if name.startswith("kx47Runtime/python/"):return True
    if name.startswith("kx47Runtime/") and name.count("/")==1:
        return Path(name).suffix.lower() in {".py",".json",".gz",".bin"}
    if name.startswith("kx47Runtime/models/OpenVoiceV2/"):return True
    if name.startswith("kx47Runtime/models/voices/") and name.endswith(".json"):return True
    return (name.startswith("kx47Runtime/models/voices/")
            and PurePosixPath(name).name==PROFILE+".npy")


def selected_managed_assets(archive):
    """Preserve exact selected-profile package assets required by the real resolver."""
    result=set()
    for info in archive.infolist():
        if not (info.filename.startswith("kx47Runtime/models/voices/packages/")
                and info.filename.endswith("/voice-package.json")):continue
        name=safe_member(info)
        if info.file_size>2*1024**2:raise ValueError("Oversize original voice manifest")
        document=json.loads(archive.read(info),object_pairs_hook=no_duplicates)
        if document.get("id")!=PROFILE:continue
        files=document.get("files")
        if not isinstance(files,dict):raise ValueError("Selected-profile package lacks asset map")
        result.add(name)
        for relative,record in files.items():
            part=PurePosixPath(relative)
            if (not isinstance(relative,str) or part.is_absolute() or any(x in {"..","."} for x in part.parts)
                    or part.as_posix()!=relative or "\\" in relative or ":" in relative or "\0" in relative
                    or not isinstance(record,dict)):
                raise ValueError("Unsafe selected-profile managed asset")
            result.add((PurePosixPath(name).parent/part).as_posix())
    return result


def extract_core(args):
    if fingerprint(args.addon)!={"sha256":CORE_SHA,"size_bytes":CORE_SIZE}:
        raise ValueError("Not the immutable actual source11 core")
    output=new_directory(args.output)
    files={}
    with zipfile.ZipFile(args.addon) as archive:
        managed_assets=selected_managed_assets(archive)
        seen=set()
        for info in archive.infolist():
            if info.is_dir():continue
            name=safe_member(info)
            if name.casefold() in seen:raise ValueError("Ambiguous immutable core member")
            seen.add(name.casefold())
            if not selected_core_file(name) and name not in managed_assets:continue
            destination=output.joinpath(*PurePosixPath(name).parts)
            destination.parent.mkdir(parents=True,exist_ok=True)
            with archive.open(info) as source,destination.open("xb") as target:
                while block:=source.read(1024**2):target.write(block)
            files[name]=fingerprint(destination)
    runtime=output/"kx47Runtime"
    required=("python/python.exe","windows_runtime.py","wide_omnivoice_onnx.py","wide_voice.py",
              "models/OpenVoiceV2/encoder-flow.onnx","models/OpenVoiceV2/decoder.onnx","models/voices/catalog.json")
    if any(not (runtime/name).is_file() for name in required):
        raise ValueError("Immutable core lacks required original source/SDK/projection assets")
    if not ((runtime/"models/voices/classmate_locales"/(PROFILE+".npy")).is_file() or managed_assets):
        raise ValueError("Actual native wide-engine selected target asset missing")
    inventory={"format":"dordiai-zgh-private-core-inventory-v1","core_sha256":CORE_SHA,
        "core_size_bytes":CORE_SIZE,"version":"0.13.1-dev.11","files":files,
        "extraction_scope":"Exact private interpreter, original top-level acoustic code, OpenVoice projection and selected-profile assets only",
        "all_core_models_extracted":False,"product_integrated":False}
    Report(args.report).write(inventory)
    return inventory


def verify_core(runtime,inventory):
    root=Path(runtime).resolve().parent
    if inventory.get("format")!="dordiai-zgh-private-core-inventory-v1" or inventory.get("core_sha256")!=CORE_SHA:
        raise ValueError("Wrong immutable private core inventory")
    for name,expected in inventory["files"].items():
        path=root.joinpath(*PurePosixPath(name).parts)
        if fingerprint(path)!=expected:raise ValueError("Actual private core file changed: "+name)
    return len(inventory["files"])


def network_guard():
    def audit(event,args):
        if event in {"socket.connect","socket.bind","socket.getaddrinfo","socket.sendto"}:
            raise RuntimeError("ZGH inference is offline")
    sys.addaudithook(audit)


def load_file_module(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def check_network_policy(path):
    policy=json.loads(Path(path).read_text(encoding="utf-8-sig"),object_pairs_hook=no_duplicates)
    required={str(Path(x).resolve()).casefold() for x in (sys.executable,getattr(sys,"_base_executable",None) or sys.executable)}
    programs={str(Path(x).resolve()).casefold() for x in policy.get("programs",[])}
    if (policy.get("action")!="Block" or policy.get("direction")!="Outbound" or policy.get("enabled") is not True
            or policy.get("all_firewall_profiles_enabled") is not True or not required<=programs):
        raise ValueError("Actual inference interpreter lacks scoped outbound firewall denial")
    return policy


def save_wave(path,audio,rate,np):
    audio=np.asarray(audio,dtype=np.float32).reshape(-1)
    if len(audio)<2400 or not np.isfinite(audio).all() or float(np.max(np.abs(audio)))<1e-6:
        raise ValueError("Native/projected speech is empty, nonfinite or silent")
    pcm=np.rint(np.clip(audio,-1,1)*32767).astype("<i2")
    with Path(path).open("xb") as output:
        with wave.open(output,"wb") as stream:
            stream.setnchannels(1);stream.setsampwidth(2);stream.setframerate(rate);stream.writeframes(pcm.tobytes())
    return dict(fingerprint(path),file=Path(path).name,samples=len(audio),sample_rate=rate,
        seconds=len(audio)/rate,peak=float(np.max(np.abs(audio))),rms=float(np.sqrt(np.mean(audio**2))),
        float32_sha256=sha256(audio.tobytes()).hexdigest())


def target_profile(runtime,converter,np):
    from voice_policy import require_voice_allowed,EXCLUDED_VOICE_IDS
    from voice_assets import asset_path
    require_voice_allowed(PROFILE)
    voices=runtime/"models/voices"
    catalog=json.loads((voices/"catalog.json").read_text(encoding="utf-8"),object_pairs_hook=no_duplicates)
    if PROFILE not in catalog or any(key in EXCLUDED_VOICE_IDS for key in catalog):
        raise ValueError("Selected original voice catalogue identity is missing or contains excluded profiles")
    # This is the original wide-engine resolver (NativeLocaleVoices), not the
    # different ConvertedVoices English embedding fallback.
    path=asset_path(voices,PROFILE,"target_embedding",required=True)
    if path is None:path=converter.resource(voices/"classmate_locales",PROFILE+".npy")
    path=Path(path).resolve()
    if not path.is_relative_to(voices.resolve()):raise ValueError("Selected profile asset escaped immutable voice directory")
    value=converter.target_profile(PROFILE)
    actual=np.load(path,allow_pickle=False)
    if (value.dtype!=np.float32 or value.shape!=(1,256,1) or not np.isfinite(value).all()
            or float(np.linalg.norm(value))<1e-6 or value.tobytes()!=actual.tobytes()):
        raise ValueError("Actual selected-profile resolver/embedding mismatch")
    return value,{"profile":PROFILE,"catalog_entry":catalog[PROFILE],"asset":str(path.relative_to(runtime)),
        **fingerprint(path),"binding":"immutable-core catalogue + actual NativeLocaleVoices.target_profile + verified asset resolver + exact original file hash",
        "original_target_resolver":"NativeLocaleVoices.target_profile",
        "human_biometric_identity_independently_verified":False}


def process_memory():
    import ctypes
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_=[("cb",wintypes.DWORD),("PageFaultCount",wintypes.DWORD)]+[(name,ctypes.c_size_t) for name in ("PeakWorkingSetSize","WorkingSetSize","QuotaPeakPagedPoolUsage","QuotaPagedPoolUsage","QuotaPeakNonPagedPoolUsage","QuotaNonPagedPoolUsage","PagefileUsage","PeakPagefileUsage")]
    counters=Counters();counters.cb=ctypes.sizeof(counters)
    kernel=ctypes.WinDLL("kernel32",use_last_error=True)
    kernel.GetCurrentProcess.restype=wintypes.HANDLE
    psapi=ctypes.WinDLL("psapi",use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes=[wintypes.HANDLE,ctypes.POINTER(Counters),wintypes.DWORD]
    if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(),ctypes.byref(counters),counters.cb):
        raise ctypes.WinError(ctypes.get_last_error())
    return {"working_set_bytes":counters.WorkingSetSize,"peak_working_set_bytes":counters.PeakWorkingSetSize,"commit_bytes":counters.PagefileUsage,"peak_commit_bytes":counters.PeakPagefileUsage}


def probe(args):
    runtime=reject_links(args.runtime).resolve()
    if sys.platform!="win32" or not sys.version.startswith("3.14.") or not os.path.samefile(sys.executable,runtime/"python/python.exe"):
        raise ValueError("Only actual unchanged Windows private Python3.14 may execute this proof")
    inventory=json.loads(Path(args.inventory).read_text(encoding="utf-8"),object_pairs_hook=no_duplicates)
    verify_core(runtime,inventory)
    fixture,blob=load_fixture(args.fixture)
    output=new_directory(args.output)
    writer=Report(output/"proof.json")
    report={"format":"dordiai-zgh-actual-private-native-projection-v1","status":"running",
        "language":"zgh","not_alias_of":"kab","product_integrated":False,"resource_count_increment":0,
        "core_sha256":CORE_SHA,"fixture_sha256":FIXTURE_SHA,"native_source":fixture["source"],
        "model_revision":MODEL_REVISION,"declared_training_hours":1.19,
        "native_pronunciation_verified":False,"character_names_verified":False,"nvda_verified":False,
        "physical_audio_verified":False,"perceived_selected_voice_similarity_verified":False,
        "cases":[],"readiness":"unintegrated slow research candidate until actual measured proof"}
    writer.write(report)
    result=1
    try:
        report["network_policy"]=check_network_policy(args.network_policy)
        network_guard()
        os.environ.update(HF_HUB_OFFLINE="1",TRANSFORMERS_OFFLINE="1",DO_NOT_TRACK="1",CUDA_VISIBLE_DEVICES="")
        boot=load_file_module(runtime/"windows_runtime.py","zgh_original_private_bootstrap")
        report["private_bootstrap"]=boot.reset_inherited_dll_directory()
        sys.path.insert(0,str(runtime))
        import numpy as np
        import onnxruntime as ort
        ort.disable_telemetry_events()
        from tokenizers import Tokenizer
        if ort.__version__!="1.26.0":raise ValueError("Private ORT1.26 must remain unchanged")
        for name in ("numpy","onnxruntime","tokenizers"):
            module=sys.modules[name]
            if not Path(module.__file__).resolve().is_relative_to(runtime/"python"):
                raise ValueError("Acoustic dependency escaped original private interpreter")
        if "torch" in sys.modules or "transformers" in sys.modules:
            raise ValueError("Unrelated ML runtime was imported")
        report["runtime"]={"python":sys.version,"executable":sys.executable,"ort":ort.__version__,
            "imports":{name:{"file":str(sys.modules[name].__file__),"version":getattr(sys.modules[name],"__version__","unknown")}
                       for name in ("numpy","onnxruntime","tokenizers")}}
        assets=Path(args.assets).resolve()
        originals={name:verify_model(assets/name,record) for name,record in MODELS.items()}
        report["model_files"]=originals
        import wide_omnivoice_onnx as omni
        from converted_voices import ConvertedVoices,resample,spectrogram
        from wide_voice import WideVoices
        for module in (omni,sys.modules["converted_voices"],sys.modules["wide_voice"]):
            if not Path(module.__file__).resolve().is_relative_to(runtime):
                raise ValueError("Acoustic code escaped immutable original core")
        previous=omni.LANGUAGES
        if "zgh" in previous:raise ValueError("Unexpected already-integrated source baseline")
        omni.LANGUAGES=frozenset(previous)|{"zgh"}
        report["research_only_language_gate"]={"before":sorted(previous),"added_only_in_process":["zgh"],
            "production_files_modified":False,"standard_evidence_git_blob":DOC_BLOB}
        engine=omni.OmniONNX(assets/"SharedOmniONNX",threads=2)
        zgh=engine.tokenizer.encode("<|lang_start|>zgh<|lang_end|>",add_special_tokens=False)
        kab=engine.tokenizer.encode("<|lang_start|>kab<|lang_end|>",add_special_tokens=False)
        if zgh.ids!=CONTROL_ZGH or kab.ids!=CONTROL_KAB or zgh.ids==kab.ids:
            raise ValueError("Actual model tokenizer lost exact ZGH/Kabyle distinction")
        for row in [fixture["reference"]]+fixture["targets"]:
            encoded=engine.tokenizer.encode(row["text"],add_special_tokens=False)
            if engine.tokenizer.token_to_id("<unk>") in encoded.ids or engine.tokenizer.decode(encoded.ids,skip_special_tokens=False)!=row["text"]:
                raise ValueError("Native Tifinagh tokenizer did not preserve actual source spelling")
        report["tokenizer"]={"zgh_marker_ids":zgh.ids,"kab_marker_ids":kab.ids,
            "zgh_marker_tokens":zgh.tokens,"kab_marker_tokens":kab.tokens,
            "language_code_is_regular_subwords_between_control_tokens":True,"native_text_roundtrip":True}
        with wave.open(io.BytesIO(blob),"rb") as stream:
            reference=np.frombuffer(stream.readframes(stream.getnframes()),dtype="<i2").astype(np.float32)/32768
            reference_rate=stream.getframerate()
        started=perf_counter()
        codes=engine.encode_reference(reference,reference_rate)
        report["authentic_reference_encoding_seconds"]=perf_counter()-started
        # Reference preparation is finished; do not retain its optional 654 MB session.
        engine.sessions.pop("encoder.fp32.onnx",None);gc.collect()
        report["reference_codes"]={"shape":list(codes.shape),"sha256":sha256(codes.tobytes()).hexdigest(),
            "actual_native_audio_sha256":fixture["reference"]["audio_sha256"],
            "actual_native_text":fixture["reference"]["text"]}
        reference_text=fixture["reference"]["text"]
        requested=[("calibration",fixture["targets"][0]["text"]),
                   ("word",fixture["reference"]["text"].split()[0]),
                   ("phrase",fixture["targets"][1]["text"])]
        native=[]
        for name,text in requested:
            started=perf_counter()
            audio,tokens=engine.generate(text,"zgh",reference_codes=codes,reference_text=reference_text,
                steps=32,guidance=2.,seed=0,return_codes=True)
            elapsed=perf_counter()-started
            wave_record=save_wave(output/(name+"-native.wav"),audio,24000,np)
            row={"process_memory":process_memory(),"name":name,"text":text,"literal_language_id":"zgh","steps":32,"guidance":2.,"seed":0,
                "native_seconds":elapsed,"native_rtf":elapsed/wave_record["seconds"],"native_wave":wave_record,
                "generated_codes_shape":list(tokens.shape),"generated_codes_sha256":sha256(tokens.tobytes()).hexdigest()}
            report["cases"].append(row);native.append((audio,tokens))
            writer.write(report)
        replay,replay_codes=engine.generate(requested[0][1],"zgh",reference_codes=codes,reference_text=reference_text,
            steps=32,guidance=2.,seed=0,return_codes=True)
        if replay_codes.tobytes()!=native[0][1].tobytes() or replay.tobytes()!=native[0][0].tobytes():
            raise ValueError("Actual fixed-input native replay changed discrete codes or waveform")
        report["same_process_fixed_seed_repeat_byte_identical"]=True
        report["native_graph_contracts"]={name:{"providers":session.get_providers(),
            "inputs":[{"name":item.name,"shape":item.shape,"type":item.type} for item in session.get_inputs()],
            "outputs":[{"name":item.name,"shape":item.shape,"type":item.type} for item in session.get_outputs()]}
            for name,session in engine.sessions.items()}
        engine.sessions.clear();gc.collect()
        options=ort.SessionOptions()
        options.intra_op_num_threads=2;options.inter_op_num_threads=1
        options.add_session_config_entry("session.intra_op.allow_spinning","0")
        ref_encoder=ort.InferenceSession(str(assets/"OpenVoiceV2/tone_ref_encoder.onnx"),
            sess_options=options,providers=["CPUExecutionProvider"])
        if ref_encoder.get_inputs()[0].name!="spec" or ref_encoder.get_inputs()[0].shape[-1]!=513:
            raise ValueError("Unexpected exact reference-encoder contract")
        actual_calibration=resample(native[0][0],24000,22050)
        source=np.asarray(ref_encoder.run(None,{"spec":spectrogram(actual_calibration)[None]})[0],np.float32).reshape(1,256,1)
        if not np.isfinite(source).all() or float(np.linalg.norm(source))<1e-6:
            raise ValueError("Invalid actual generated-carrier source embedding")
        np.save(output/"source.npy",source,allow_pickle=False)
        report["actual_source_identity"]={"shape":list(source.shape),"norm":float(np.linalg.norm(source)),
            "source_npy":fingerprint(output/"source.npy"),
            "basis":"actual-generated-ZGH-calibration-audio-from-this-same-reference-and-pinned-model",
            "source_native_float_sha256":report["cases"][0]["native_wave"]["float32_sha256"],
            "encoder_sha256":MODELS["OpenVoiceV2/tone_ref_encoder.onnx"][1],
            "not_copied_from_other_language_or_target_voice":True}
        from native_locale import NativeLocaleVoices
        if not Path(sys.modules["native_locale"].__file__).resolve().is_relative_to(runtime):
            raise ValueError("Original native selected-profile resolver escaped immutable core")
        baseline_converter=NativeLocaleVoices(runtime/"models",runtime/"models/voices/classmate_locales",threads=2)
        target,target_facts=target_profile(runtime,baseline_converter,np)
        report["selected_profile"]=target_facts
        if target.tobytes()==source.tobytes():raise ValueError("Source and target identity unexpectedly identical")
        class AuditedSession:
            def __init__(self,path,flow=False):
                self.session=ort.InferenceSession(str(path),sess_options=options,providers=["CPUExecutionProvider"])
                self.calls=0;self.flow=flow
            def run(self,*args,**kwargs):
                if self.flow:
                    inputs=args[1]
                    if (inputs["src_g"].tobytes()!=source.tobytes() or inputs["tgt_g"].tobytes()!=target.tobytes()):
                        raise ValueError("Projection changed source or selected target identity")
                self.calls+=1
                return self.session.run(*args,**kwargs)
        class Owner:
            def check_cancelled(self):pass
        class Projector:
            def __init__(self):
                self.flow=AuditedSession(runtime/"models/OpenVoiceV2/encoder-flow.onnx",True)
                self.decoder=AuditedSession(runtime/"models/OpenVoiceV2/decoder.onnx")
        projector=Projector()
        wide=WideVoices(runtime/"models",runtime/"models/voices",owner=Owner(),converter=projector)
        for row,(audio,tokens) in zip(report["cases"],native):
            before=(projector.flow.calls,projector.decoder.calls)
            started=perf_counter()
            blocks=list(wide.converted(resample(audio,24000,22050),source,target))
            projected=np.concatenate(blocks).astype(np.float32)
            projected=resample(projected,22050,24000)
            row["projection_seconds"]=perf_counter()-started
            row["projected_wave"]=save_wave(output/(row["name"]+"-"+PROFILE+".wav"),projected,24000,np)
            row["projection"]={"profile":PROFILE,"source_binding_passed":True,"target_binding_passed":True,
                "flow_calls":projector.flow.calls-before[0],"decoder_calls":projector.decoder.calls-before[1],
                "actual_original_code":"source11.WideVoices.converted",
                "actual_original_models":["OpenVoiceV2/encoder-flow.onnx","OpenVoiceV2/decoder.onnx"]}
            if row["projection"]["flow_calls"]<1 or row["projection"]["decoder_calls"]<1:
                raise ValueError("Projection was bypassed")
            writer.write(report)
        for name,expected in originals.items():
            if fingerprint(assets/name)!=expected:raise ValueError("Pinned input model changed")
        verify_core(runtime,inventory)
        report["process_memory"]=process_memory()
        report.update(status="actual-private-ZGH-native-and-selected-profile-projection-passed-unintegrated",
            all_original_private_files_unchanged=True,all_model_files_unchanged=True,
            native_model_execution_verified=True,selected_profile_projection_mechanically_verified=True,
            language_standard_count_increment=0,
            readiness="Real native/projection CPU proof only; pronunciation, NVDA, character names and interactive latency remain unaccepted")
        result=0
    except Exception as error:
        report.update(status="actual-private-ZGH-proof-failed",error_type=type(error).__name__,
            error=str(error)[:5000],traceback=traceback.format_exc(limit=12))
    finally:
        if "omni" in locals() and "previous" in locals():omni.LANGUAGES=previous
        try:verify_core(runtime,inventory)
        except Exception as error:
            report.update(status="actual-private-ZGH-proof-failed",integrity_error=type(error).__name__)
            result=1
        writer.write(report)
    print("ZGH_PRIVATE_SUMMARY "+json.dumps({
        "status":report["status"],"cases":len(report["cases"]),"native_model_execution_verified":report.get("native_model_execution_verified"),
        "selected_profile_projection_mechanically_verified":report.get("selected_profile_projection_mechanically_verified"),
        "all_original_private_files_unchanged":report.get("all_original_private_files_unchanged"),
        "product_integrated":False,"error_type":report.get("error_type")},ensure_ascii=True),flush=True)
    return result


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command",choices=("prepare","extract-core","probe","verify-core"))
    parser.add_argument("--assets",type=Path)
    parser.add_argument("--fixture",type=Path,default=FIXTURE)
    parser.add_argument("--report",type=Path)
    parser.add_argument("--addon",type=Path)
    parser.add_argument("--runtime",type=Path)
    parser.add_argument("--output",type=Path)
    parser.add_argument("--inventory",type=Path)
    parser.add_argument("--network-policy",type=Path)
    args=parser.parse_args(argv)
    if args.command=="prepare":prepare(args);return 0
    if args.command=="extract-core":extract_core(args);return 0
    if args.command=="verify-core":
        value=json.loads(args.inventory.read_text(encoding="utf-8"),object_pairs_hook=no_duplicates)
        count=verify_core(args.runtime,value)
        Report(args.report).write({"all_extracted_original_core_files_unchanged":True,"checked_files":count,
            "core_sha256":CORE_SHA,"private_dependency_upgrade_performed":False,"product_integrated":False})
        return 0
    return probe(args)


if __name__=="__main__":
    raise SystemExit(main())

