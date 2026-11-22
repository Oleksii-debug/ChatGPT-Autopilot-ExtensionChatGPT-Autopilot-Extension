#!/usr/bin/env python3
"""Read-only inspection of actual pinned MNI ONNX attention shape expressions.

Downloads only the existing hash-pinned Actions artifact, never exports a model.
GitHub credentials are sent only to api.github.com, never to its signed redirect.
"""
from __future__ import annotations
import argparse
import base64
import gc
import gzip
from hashlib import sha1,sha256
import importlib.util
import json
import os
from pathlib import Path,PurePosixPath
import stat
import tempfile
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request,build_opener,HTTPRedirectHandler,urlopen
import zipfile

HERE=Path(__file__).resolve().parent
REPOSITORY="Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension"
ARTIFACT_ID=14757527796
ARTIFACT_SIZE=547019006
ARTIFACT_SHA="81b5dc8fa87f3f6604264de435c05c9e6feb2deeb6d3e889f6808b6d6764d51a"
PROOF_BLOB="c74f720a09a3f2a9bc9d2dc7acc23ee5fa2db797"
PROBE_BLOB="56e455feee6eeb690c09d4d98a41d6e7415b8f0f"
GRAPHS={
 "fastpitch-encoder.onnx":(105985856,"abbac5ab7e2fb005b917e9622038f6a335b1afd331c4cc5cf49dcab46be6dd48"),
 "fastpitch-decoder.onnx":(111390571,"ca15ba06692c2ec4c3653b817766c05ff68f932f4fffd69f1c5eb731d4a28e27"),
 "hifigan.onnx":(55823329,"68dde10994f7a87bcc7f18fd8e5b74f21446b902a33b6b0b8206013fdfe1586e"),
}


def probe_tool():
    path=HERE/"probe_mni_native.py"
    raw=path.read_bytes()
    if sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest()!=PROBE_BLOB:
        raise ValueError("Frozen native proof helper changed")
    spec=importlib.util.spec_from_file_location("mni_graph_pinned_probe",path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        return None


def signed_artifact_location(token):
    if not token or any(char in token for char in "\r\n"):
        raise ValueError("Read-only Actions token missing or malformed")
    url="https://api.github.com/repos/"+REPOSITORY+"/actions/artifacts/"+str(ARTIFACT_ID)+"/zip"
    request=Request(url,headers={"Authorization":"Bearer "+token,
        "Accept":"application/vnd.github+json","User-Agent":"Dordiai-MNI-shape-inspection"})
    try:
        result=build_opener(NoRedirect()).open(request,timeout=120)
    except HTTPError as error:
        if error.code!=302:
            raise RuntimeError("Pinned Actions artifact redirect unavailable") from None
        location=error.headers.get("Location","")
        error.close()
    else:
        result.close()
        raise RuntimeError("Expected GitHub signed artifact redirect")
    parsed=urlsplit(location)
    host=(parsed.hostname or "").lower()
    if parsed.scheme!="https" or parsed.port not in (None,443) or parsed.username or parsed.password:
        raise ValueError("Unsafe signed artifact redirect")
    if not (host.endswith(".blob.core.windows.net") or host.endswith(".actions.githubusercontent.com")
            or host.endswith(".githubusercontent.com")):
        raise ValueError("Signed artifact redirect left expected result storage")
    return location


def acquire(args):
    p=probe_tool()
    state=p.state_tool()
    h=state.helper()
    archive=state.regular(Path(args.archive).absolute())
    p.validate_stages(archive,args.stage)
    stage=p.fresh_directory(args.stage)
    hit=archive.exists()
    if hit:
        state.check_hash(archive,ARTIFACT_SIZE,ARTIFACT_SHA)
    else:
        state.new_path(archive)
        archive.parent.mkdir(parents=True,exist_ok=True)
        fd,temporary=tempfile.mkstemp(prefix="mni-existing-artifact-",suffix=".zip",dir=archive.parent)
        try:
            with os.fdopen(fd,"wb") as target:
                location=signed_artifact_location(os.environ.get("GITHUB_TOKEN",""))
                # New request has NO Authorization or any GitHub API headers.
                with urlopen(Request(location,headers={"User-Agent":"Dordiai-MNI-shape-inspection"}),timeout=120) as source:
                    total,digest=0,sha256()
                    for block in iter(lambda:source.read(1024**2),b""):
                        total+=len(block)
                        if total>ARTIFACT_SIZE:
                            raise ValueError("Existing artifact exceeds pinned size")
                        target.write(block)
                        digest.update(block)
                if total!=ARTIFACT_SIZE or digest.hexdigest()!=ARTIFACT_SHA:
                    raise ValueError("Existing artifact whole ZIP SHA differs")
            os.link(temporary,archive)
        finally:
            Path(temporary).unlink(missing_ok=True)
    members={}
    expanded=0
    prefix=None
    with zipfile.ZipFile(archive) as zipped:
        if len(zipped.infolist())>40:
            raise ValueError("Unexpected native proof artifact member count")
        for info in zipped.infolist():
            path=h.member_name(info)
            if info.is_dir():
                continue
            normalized=path[len("mni-native-proof/"):] if path.startswith("mni-native-proof/") else path
            family="mni-native-proof/" if path.startswith("mni-native-proof/") else ""
            if prefix is None:
                prefix=family
            if family!=prefix or "/" in normalized or normalized in members:
                raise ValueError("Ambiguous native proof artifact layout")
            if normalized not in set(GRAPHS)|{"proof.json","mni-inference-fp32.safetensors"}:
                import re
                if re.fullmatch(r"(female|male)-(word|phrase0|phrase1|meetei-word)-(native|onnx)\.wav",normalized) is None:
                    raise ValueError("Unexpected model research artifact member")
            if info.file_size<0 or info.file_size>300*1024**2:
                raise ValueError("Oversized native proof member")
            expanded+=info.file_size
            if expanded>700*1024**2:
                raise ValueError("Expanded research artifact quota exceeded")
            destination=stage/normalized
            digest,total=sha256(),0
            with zipped.open(info) as source,destination.open("xb") as output:
                for block in iter(lambda:source.read(1024**2),b""):
                    total+=len(block)
                    if total>info.file_size:
                        raise ValueError("Research artifact member exceeds declared size")
                    output.write(block)
                    digest.update(block)
            if total!=info.file_size:
                raise ValueError("Truncated research artifact member")
            members[normalized]={"sha256":digest.hexdigest(),"size_bytes":total}
    for name,(size,digest) in GRAPHS.items():
        if members.get(name)!={"sha256":digest,"size_bytes":size}:
            raise ValueError("Pinned actual exported graph missing or changed")
    raw=(stage/"proof.json").read_bytes()
    if sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest()!=PROOF_BLOB:
        raise ValueError("Actual original native proof JSON differs")
    original=json.loads(raw,object_pairs_hook=h.unique_pairs)
    expected=original["safe_state_archive"]
    if members.get("mni-inference-fp32.safetensors")!=expected:
        raise ValueError("Actual lossless safe-state archive differs")
    for case in original["native_cases"]:
        name=case["wave"]["file"]
        if members.get(name,{}).get("sha256")!=case["wave"]["sha256"]:
            raise ValueError("Original native reference WAV differs")
    h.OwnedReport(stage/"artifact-receipt.json").write({
        "format":"dordiai-existing-mni-proof-artifact","format_version":1,
        "artifact_id":ARTIFACT_ID,"archive":{"sha256":ARTIFACT_SHA,"size_bytes":ARTIFACT_SIZE},
        "proof_git_blob":PROOF_BLOB,"cache_hit":hit,"members":members})
    print("MNI_EXISTING_ARTIFACT_VERIFIED",flush=True)


def expression(graph,name,onnx,np,depth=0,seen=None):
    """Only bounded shape constants are read; weights/input data never evaluated."""
    seen=set() if seen is None else seen
    if depth>8 or name in seen:
        return {"value":name,"kind":"depth-or-cycle-bound"}
    initial={item.name:item for item in graph.initializer}
    producers={output:node for node in graph.node for output in node.output}
    if name in initial:
        item=initial[name]
        if len(item.dims)>2 or int(np.prod(item.dims))>64:
            return {"value":name,"kind":"large-initializer-not-expanded"}
        return {"value":name,"kind":"initializer","constant":onnx.numpy_helper.to_array(item).tolist()}
    node=producers.get(name)
    if node is None:
        return {"value":name,"kind":"graph-input-or-unresolved"}
    attributes={item.name:onnx.helper.get_attribute_value(item) for item in node.attribute}
    if node.op_type=="Constant" and "value" in attributes:
        item=attributes["value"]
        if int(np.prod(item.dims))<=64:
            return {"value":name,"kind":"Constant","constant":onnx.numpy_helper.to_array(item).tolist()}
    seen=seen|{name}
    return {"value":name,"kind":node.op_type,"node":node.name,
        "inputs":[expression(graph,item,onnx,np,depth+1,seen) for item in node.input[:4]],
        "axis":attributes.get("axis")}


def inspect(args):
    p=probe_tool()
    state=p.state_tool()
    h=state.helper()
    stage=Path(args.stage).absolute()
    destination=state.new_path(args.report)
    raw=(stage/"proof.json").read_bytes()
    if sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest()!=PROOF_BLOB:
        raise ValueError("Exact source native proof changed")
    original=json.loads(raw,object_pairs_hook=h.unique_pairs)
    report={"format":"dordiai-mni-actual-onnx-shape-inspection","format_version":1,
        "status":"inspecting","artifact_id":ARTIFACT_ID,
        "artifact_sha256":ARTIFACT_SHA,"source_proof_git_blob":PROOF_BLOB,
        "models_modified":False,"model_inference_executed":False,"graphs":{},
        "original_proof_status":original["status"],"original_onnx_backend_accepted":False}
    writer=h.OwnedReport(destination)
    writer.write(report)
    try:
        report["network_guard"]=state.deny_network()
        import onnx
        from onnx import numpy_helper
        import numpy as np
        seen=set()
        for name,(size,digest) in GRAPHS.items():
            state.check_hash(stage/name,size,digest)
            model=onnx.load(str(stage/name),load_external_data=False)
            onnx.checker.check_model(model)
            verified=[]
            for item in model.graph.initializer:
                row=p.verify_onnx_weight(item,onnx,original["retained_tensor_identities"],np)
                if row["source_tensor"] in seen:
                    raise ValueError("Duplicate original learned tensor")
                seen.add(row["source_tensor"])
                verified.append(row["source_tensor"])
            nodes=[]
            for node in model.graph.node:
                if node.op_type=="Reshape" and "/self_attn/" in node.name:
                    nodes.append({"node":node.name,"data":node.input[0],
                        "shape":expression(model.graph,node.input[1],onnx,np)})
            report["graphs"][name]={"sha256":digest,"size_bytes":size,
                "verified_original_tensors":len(verified),
                "inputs":[{"name":item.name,"dims":[dim.dim_param or dim.dim_value for dim in item.type.tensor_type.shape.dim]} for item in model.graph.input],
                "attention_reshapes":nodes}
            del model
            gc.collect()
            writer.write(report)
        if seen!=set(original["retained_tensor_identities"]):
            raise ValueError("Missing original learned tensor")
        report.update(status="actual-shape-inspection-complete",verified_original_tensors=len(seen))
    except Exception as error:
        report.update(status="actual-shape-inspection-failed",error_type=type(error).__name__,error=str(error)[:4000])
    writer.write(report)
    encoded=base64.b64encode(gzip.compress(h.json_bytes(report),mtime=0)).decode("ascii")
    parts=[encoded[start:start+4096] for start in range(0,len(encoded),4096)]
    for index,part in enumerate(parts,1):
        print("MNI_SHAPE_REPORT_GZIP_B64_PART %d/%d %s"%(index,len(parts),part),flush=True)
    print("MNI_SHAPE_SUMMARY "+json.dumps({
        "status":report["status"],"graphs":{name:len(row["attention_reshapes"]) for name,row in report["graphs"].items()},
        "verified_original_tensors":report.get("verified_original_tensors"),"error":report.get("error")},sort_keys=True),flush=True)
    return 0 if report["status"]=="actual-shape-inspection-complete" else 2


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command",choices=("acquire","inspect"))
    parser.add_argument("--archive",type=Path)
    parser.add_argument("--stage",type=Path,required=True)
    parser.add_argument("--report",type=Path)
    args=parser.parse_args(argv)
    if args.command=="acquire":
        if args.archive is None:
            parser.error("acquire requires --archive")
        acquire(args)
        return 0
    if args.report is None:
        parser.error("inspect requires --report")
    return inspect(args)


if __name__=="__main__":
    raise SystemExit(main())
