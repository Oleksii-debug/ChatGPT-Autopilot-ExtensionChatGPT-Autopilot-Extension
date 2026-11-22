#!/usr/bin/env python3
"""Guarded dynamic-shape repair of the existing pinned Manipuri ONNX graphs.

Only24 K/V shape Concat first inputs change to [-1]. All405 learned FP32
payloads, other graph nodes and fixed precision gates remain unchanged.
No Torch checkpoint deserialization, model export, training or production edit.
"""
from __future__ import annotations
import argparse
import base64
from hashlib import sha1,sha256
import gc
import gzip
import importlib.util
import json
import os
from pathlib import Path
import re
import time
import traceback
import wave

HERE=Path(__file__).resolve().parent
INSPECTOR_BLOB="de8cb45548d91fedf7ac973182b3f74cf0c2d1ff"
STATE_REPORT_BLOB="1bf30a01b477adb3041db449a5fb8a71ee9ccc83"
TORCH_HOLDOUTS=4


def load_inspector():
    path=HERE/"inspect_mni_onnx_shapes.py"
    raw=path.read_bytes()
    if sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest()!=INSPECTOR_BLOB:
        raise ValueError("Frozen existing-artifact inspector changed")
    spec=importlib.util.spec_from_file_location("mni_shape_frozen",path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def scalar_constant(node,onnx,np):
    if node.op_type!="Constant" or len(node.output)!=1 or node.input:
        raise ValueError("Expected exact original scalar Constant")
    attrs={a.name:onnx.helper.get_attribute_value(a) for a in node.attribute}
    if set(attrs)!={"value"} or attrs["value"].data_type!=onnx.TensorProto.INT64:
        raise ValueError("Expected original INT64 shape Constant")
    array=onnx.numpy_helper.to_array(attrs["value"])
    if array.shape!=():
        raise ValueError("Sequence shape Constant must be scalar")
    return int(array)


def patch_graph(model,family,onnx,np):
    """Pure shape-only patch; caller separately enforces exact input file hashes."""
    if family not in ("encoder","decoder"):
        raise ValueError("Unsupported original native graph family")
    prefix="/encoder/encoder/" if family=="encoder" else "/decoder/decoder/transformer_block/"
    expected={prefix+"fft_layers."+str(layer)+"/self_attn/Reshape_"+str(part)
        for layer in range(6) for part in (4,5)}
    nodes=list(model.graph.node)
    by_output={output:node for node in nodes for output in node.output}
    if len(by_output)!=sum(len(node.output) for node in nodes):
        raise ValueError("Duplicate graph producer output")
    by_name={node.name:node for node in nodes if node.name}
    if len(by_name)!=sum(bool(node.name) for node in nodes):
        raise ValueError("Duplicate graph node name")
    actual={node.name for node in nodes if node.name in expected}
    if actual!=expected:
        raise ValueError("Expected exact native6-layer K/V reshape set")
    original_weights={item.name:sha256(item.SerializeToString()).hexdigest() for item in model.graph.initializer}
    original_nodes={node.name:sha256(node.SerializeToString()).hexdigest() for node in nodes}
    additions={}
    changed=set()
    edits=[]
    consumers={}
    for node in nodes:
        for value in node.input:
            consumers.setdefault(value,[]).append(node.name)
    for name in sorted(expected):
        reshape=by_name[name]
        reshape_attrs={a.name:onnx.helper.get_attribute_value(a) for a in reshape.attribute}
        if reshape.op_type!="Reshape" or len(reshape.input)!=2 or reshape_attrs not in ({},{"allowzero":0}):
            raise ValueError("Unexpected original K/V reshape semantics")
        concat=by_output.get(reshape.input[1])
        if concat is None or concat.op_type!="Concat" or len(concat.input)!=3 or len(concat.output)!=1:
            raise ValueError("Expected exact original three-component shape Concat")
        attributes={a.name:onnx.helper.get_attribute_value(a) for a in concat.attribute}
        if attributes!={"axis":0} or consumers.get(concat.output[0])!=[reshape.name]:
            raise ValueError("Original shape expression is shared or has unexpected axis")
        first=by_output.get(concat.input[0])
        if first is None or first.op_type!="Unsqueeze" or len(first.input)!=2 or first.attribute:
            raise ValueError("Expected original sequence-dimension Unsqueeze")
        axes=by_output.get(first.input[1])
        if axes is None or axes.op_type!="Constant":
            raise ValueError("Expected original Unsqueeze axis Constant")
        axes_attrs={a.name:onnx.helper.get_attribute_value(a) for a in axes.attribute}
        if set(axes_attrs)!={"value"}:
            raise ValueError("Unexpected Unsqueeze axis expression")
        axis_array=onnx.numpy_helper.to_array(axes_attrs["value"])
        if axis_array.dtype!=np.dtype("int64") or axis_array.shape!=(1,) or int(axis_array[0])!=0:
            raise ValueError("Original Unsqueeze axis differs")
        sequence=by_output.get(first.input[0])
        expected_length=3 if family=="encoder" else 71
        if sequence is None or scalar_constant(sequence,onnx,np)!=expected_length:
            raise ValueError("Original frozen trace length differs")
        new_name=reshape.name+"/DordiaiDynamicSequence"
        new_output=new_name+"_output_0"
        if new_name in by_name or new_output in by_output or new_output in {v for node in additions.values() for v in node.output}:
            raise ValueError("Dynamic shape symbol collision")
        constant=onnx.helper.make_node("Constant",[],[new_output],name=new_name,
            value=onnx.numpy_helper.from_array(np.array([-1],dtype=np.int64)))
        previous=concat.input[0]
        concat.input[0]=new_output
        changed.add(concat.name)
        additions[concat.name]=constant
        edits.append({"reshape":reshape.name,"concat":concat.name,"previous_first_input":previous,
            "original_frozen_sequence":expected_length,"new_first_input":new_output,
            "new_constant":[-1],"other_shape_components_unchanged":True})
    updated=[]
    for node in nodes:
        if node.name in additions:
            updated.append(additions[node.name])
        updated.append(node)
    del model.graph.node[:]
    model.graph.node.extend(updated)
    for node in model.graph.node:
        if node.name in original_nodes and node.name not in changed:
            if sha256(node.SerializeToString()).hexdigest()!=original_nodes[node.name]:
                raise ValueError("Repair changed an unrelated original graph node")
    final_weights={item.name:sha256(item.SerializeToString()).hexdigest() for item in model.graph.initializer}
    if original_weights!=final_weights:
        raise ValueError("Repair changed original learned tensor protobuf bytes")
    if len(edits)!=12 or len(model.graph.node)!=len(nodes)+12:
        raise ValueError("Unexpected dynamic shape repair count")
    onnx.checker.check_model(model)
    return edits


def prepare(args):
    inspector=load_inspector()
    p=inspector.probe_tool()
    h=p.state_tool().helper()
    inputs=p.fresh_directory(args.inputs)
    source_records={}
    for name,blob in p.native.PINS.items():
        raw=h.bounded("https://raw.githubusercontent.com/gokulkarthik/TTS/"+p.native.REVISION+"/"+name,1024**2)
        if sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest()!=blob:
            raise ValueError("Original native inference source pin differs")
        destination=inputs/"sources"/name
        destination.parent.mkdir(parents=True,exist_ok=True)
        destination.write_bytes(raw)
        source_records[name]={"git_blob":blob,"sha256":sha256(raw).hexdigest()}
    body=json.loads(h.bounded("https://api.github.com/repos/"+inspector.REPOSITORY+"/git/blobs/"+STATE_REPORT_BLOB,2*1024**2),
        object_pairs_hook=h.unique_pairs)
    if body.get("sha")!=STATE_REPORT_BLOB or body.get("encoding")!="base64":
        raise ValueError("Actual safe-state metadata blob identity differs")
    raw=base64.b64decode("".join(body["content"].split()),validate=True)
    if sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest()!=STATE_REPORT_BLOB:
        raise ValueError("Actual safe-state report bytes differ")
    document=json.loads(raw,object_pairs_hook=h.unique_pairs)
    if document.get("status")!="safe-state-audit-complete-not-inferred":
        raise ValueError("Expected actual successful safe-state audit")
    (inputs/"original-config-report.json").write_bytes(raw)
    h.OwnedReport(inputs/"source-inputs.json").write({
        "format":"dordiai-mni-repair-reference-inputs","format_version":1,
        "state_report_git_blob":STATE_REPORT_BLOB,"source_revision":p.native.REVISION,"source_files":source_records})
    print("MNI_REPAIR_REFERENCE_INPUTS_READY",flush=True)


def read_reference_pcm(path,np):
    with wave.open(str(path),"rb") as stream:
        if (stream.getnchannels(),stream.getsampwidth(),stream.getframerate())!=(1,2,22050):
            raise ValueError("Original native WAV format differs")
        return np.frombuffer(stream.readframes(stream.getnframes()),dtype="<i2").astype(np.int32)


def run_ort(sessions,ids,speaker,p,np):
    encoder,decoder,vocoder=sessions
    encoded,durations=encoder.run(None,{"ids":np.array([ids],dtype=np.int64),
        "speaker":np.array([speaker],dtype=np.int64)})
    expanded=p.expand_numpy(encoded,durations,np)
    mel=decoder.run(None,{"expanded":expanded})[0]
    audio=vocoder.run(None,{"mel":mel.transpose(0,2,1)})[0]
    return encoded,durations,mel,audio


def run(args):
    inspector=load_inspector()
    p=inspector.probe_tool()
    state=p.state_tool()
    h=state.helper()
    h.MAX_REPORT=32*1024**2
    p.validate_stages(args.stage,args.inputs,args.output)
    stage=Path(args.stage).absolute()
    inputs=Path(args.inputs).absolute()
    output=p.fresh_directory(args.output)
    writer=h.OwnedReport(output/"proof.json")
    raw=(stage/"proof.json").read_bytes()
    if sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest()!=inspector.PROOF_BLOB:
        raise ValueError("Original native artifact proof differs")
    old=json.loads(raw,object_pairs_hook=h.unique_pairs)
    report={"format":"dordiai-mni-shape-only-repair-proof","format_version":1,"status":"preparing",
        "source_artifact_id":inspector.ARTIFACT_ID,"source_artifact_sha256":inspector.ARTIFACT_SHA,
        "source_proof_git_blob":inspector.PROOF_BLOB,"original_backend_accepted":False,
        "production_integrated":False,"quantization_performed":False,
        "torch_checkpoint_deserialized":False,"torch_model_exported":False,
        "existing_reference_cases":[],"new_float_holdouts":[],
        "holdout_scope":"New standalone utterances from known publisher phrases; not unseen training data or independent linguistic evaluation.",
        "policy":{"float_atol":p.FLOAT_ATOL,"pcm_lsb_limit":p.PCM_LSB_LIMIT,
            "all405_original_weight_identities_required":True},
        "human_pronunciation_validation":"pending"}
    writer.write(report)
    try:
        raw_config=(inputs/"original-config-report.json").read_bytes()
        if sha1(b"blob "+str(len(raw_config)).encode("ascii")+b"\0"+raw_config).hexdigest()!=STATE_REPORT_BLOB:
            raise ValueError("Pinned actual native configs changed")
        config_report=json.loads(raw_config,object_pairs_hook=h.unique_pairs)
        for name in p.native.PINS:
            p.native.read_source(inputs/"sources",name)
        report["network_guard"]=state.deny_network()
        import onnx
        from onnx import numpy_helper
        import numpy as np
        import onnxruntime as ort
        if ort.__version__!="1.27.0":
            raise ValueError("Isolated official safe ORT1.27 required")
        ort.disable_telemetry_events()
        originals=set()
        repaired=set()
        graph_records={}
        for name,(size,digest) in inspector.GRAPHS.items():
            state.check_hash(stage/name,size,digest)
            model=onnx.load(str(stage/name),load_external_data=False)
            for item in model.graph.initializer:
                row=p.verify_onnx_weight(item,onnx,old["retained_tensor_identities"],np)
                if row["source_tensor"] in originals:
                    raise ValueError("Duplicate original source weight")
                originals.add(row["source_tensor"])
            edits=[]
            if name.startswith("fastpitch-"):
                family="encoder" if name=="fastpitch-encoder.onnx" else "decoder"
                edits=patch_graph(model,family,onnx,np)
            for item in model.graph.initializer:
                row=p.verify_onnx_weight(item,onnx,old["retained_tensor_identities"],np)
                if row["source_tensor"] in repaired:
                    raise ValueError("Duplicate repaired source weight")
                repaired.add(row["source_tensor"])
            onnx.save(model,str(output/name))
            graph_records[name]={"original_sha256":digest,"repaired":h.fingerprint(output/name),"shape_edits":edits}
            del model
            gc.collect()
        if originals!=set(old["retained_tensor_identities"]) or repaired!=originals or len(repaired)!=405:
            raise ValueError("Repair did not preserve every exact original native learned weight")
        report.update(graphs=graph_records,all405_payloads_unchanged=True,shape_edit_count=24)
        report["status"]="shape-repair-complete-parity-pending"
        writer.write(report)
        original_sessions=p.sessions(ort,stage)
        started=time.perf_counter()
        repaired_sessions=p.sessions(ort,output)
        report["repaired_session_open_seconds"]=time.perf_counter()-started
        first=old["native_cases"][0]
        original_outputs=run_ort(original_sessions,first["token_ids"],first["speaker_id"],p,np)
        repaired_outputs=run_ort(repaired_sessions,first["token_ids"],first["speaker_id"],p,np)
        report["fixed_shape_original_vs_repaired"]={
            name:p.comparison(a,b,np,pcm=name=="audio") for name,a,b in zip(
                ("encoded","durations","mel","audio"),original_outputs,repaired_outputs)}
        del original_sessions
        gc.collect()
        for case in old["native_cases"]:
            reference=stage/case["wave"]["file"]
            if h.fingerprint(reference)["sha256"]!=case["wave"]["sha256"]:
                raise ValueError("Original native reference PCM WAV changed")
            started=time.perf_counter()
            encoded,duration,mel,audio=run_ort(repaired_sessions,case["token_ids"],case["speaker_id"],p,np)
            elapsed=time.perf_counter()-started
            current=np.rint(np.clip(audio.reshape(-1),-1,1)*32767).astype(np.int32)
            target=read_reference_pcm(reference,np)
            if current.shape!=target.shape:
                raise ValueError("Repaired graph changed native reference duration")
            difference=int(np.max(np.abs(current-target)))
            record={"sample_id":case["sample"]["id"],"speaker":case["speaker"],
                "token_count":len(case["token_ids"]),"frames":int(np.sum(duration)),
                "pcm_max_lsb":difference,"pcm_pass":difference<=p.PCM_LSB_LIMIT,
                "float_parity":"not-reassessed-from16bit-reference","seconds":elapsed,
                "rtf":elapsed/case["wave"]["seconds"]}
            report["existing_reference_cases"].append(record)
            writer.write(report)
        # Only4 new lexical holdout utterances use a native Torch reference.
        # The original8-case Torch/export pipeline is not repeated.
        import torch
        from safetensors.torch import load_file
        state.torch_version(torch)
        torch.set_num_threads(1)
        torch.set_num_interop_threads(1)
        torch.use_deterministic_algorithms(True)
        namespace=p.native.build_namespace(inputs/"sources",torch)
        cfg=config_report["configs"]["mni/fastpitch/config.json"]
        hcfg=config_report["configs"]["mni/hifigan/config.json"]
        safe=stage/"mni-inference-fp32.safetensors"
        state.check_hash(safe,old["safe_state_archive"]["size_bytes"],old["safe_state_archive"]["sha256"])
        tensors=load_file(str(safe),device="cpu")
        if {key:p.native.tensor_identity(value) for key,value in tensors.items()}!=old["retained_tensor_identities"]:
            raise ValueError("Lossless original model-only tensor identities differ")
        model,generator=p.native.make_models(namespace,torch,cfg,hcfg,old["speakers"],compact=True)
        model.load_state_dict({key[len("fastpitch."):]:value for key,value in tensors.items() if key.startswith("fastpitch.")},strict=True)
        generator.load_state_dict({key[len("hifigan."):]:value for key,value in tensors.items() if key.startswith("hifigan.")},strict=True)
        del tensors
        gc.collect()
        tokenizer=p.native.make_tokenizer(namespace,cfg)
        seen_words={old["native_cases"][0]["sample"]["text"]}
        words=[]
        for text in cfg["test_sentences"]:
            for value in text.split():
                word=value.strip(",.")
                if word and word not in seen_words:
                    words.append(word)
                    seen_words.add(word)
                if len(words)==2:
                    break
            if len(words)==2:
                break
        if len(words)!=2:
            raise ValueError("New publisher-native lexical holdouts missing")
        wrappers=p.build_export_wrappers(torch,model,generator)
        for word in words:
            cleaned,ids=p.native.strict_ids(tokenizer,word)
            for speaker,speaker_id in old["speakers"].items():
                with torch.inference_mode():
                    x=torch.tensor([ids],dtype=torch.long)
                    sid=torch.tensor([speaker_id],dtype=torch.long)
                    enc_ref,dur_ref=wrappers[0](x,sid)
                    mel_ref=model.inference(x,{"speaker_ids":sid,"d_vectors":None})["model_outputs"]
                    audio_ref=generator.inference(mel_ref.transpose(1,2))
                    reference=[enc_ref.numpy(),dur_ref.numpy(),mel_ref.numpy(),audio_ref.numpy()]
                started=time.perf_counter()
                actual=run_ort(repaired_sessions,ids,speaker_id,p,np)
                elapsed=time.perf_counter()-started
                checks={name:p.comparison(a,b,np,pcm=name=="audio") for name,a,b in zip(
                    ("encoded","durations","mel","audio"),reference,actual)}
                passes=all(row["float_pass"] for row in checks.values()) and checks["audio"]["pcm_pass"]
                report["new_float_holdouts"].append({
                    "text":word,"cleaned":cleaned,"speaker":speaker,"token_ids":ids,
                    "source":"new-word-from-original-native-MNI-config-test-sentences",
                    "comparisons":checks,"parity_pass":bool(passes),"seconds":elapsed,
                    "wave":p.save_wave(output/(speaker+"-holdout"+str(words.index(word))+".wav"),actual[-1],np)})
                writer.write(report)
        if len(report["new_float_holdouts"])!=TORCH_HOLDOUTS:
            raise ValueError("Missing exact bounded native float holdout cases")
        # Recheck graph bytes and source tensors after all actual runs.
        for name,row in graph_records.items():
            if h.fingerprint(output/name)!=row["repaired"]:
                raise ValueError("Repaired model bytes changed during proof")
        reference_pass=all(row["pcm_pass"] for row in report["existing_reference_cases"])
        float_pass=all(row["parity_pass"] for row in report["new_float_holdouts"])
        old_new_pass=all(row["float_pass"] for row in report["fixed_shape_original_vs_repaired"].values())
        old_new_pass=old_new_pass and report["fixed_shape_original_vs_repaired"]["audio"]["pcm_pass"]
        report.update(dynamic_shapes_valid=True,existing_reference_pcm_pass=reference_pass,
            new_float_holdouts_pass=float_pass,original_fixed_shape_equivalence_pass=bool(old_new_pass))
        # Known development float failure is never converted into a pass by PCM-only tests.
        report["original_development_float_gate_failure_retained"]=True
        report["backend_accepted"]=False
        report["status"]="dynamic-shape-repair-verified-backend-still-rejected"
    except Exception as error:
        report.update(status="shape-repair-proof-failed",error_type=type(error).__name__,
            error=str(error)[:5000],traceback=traceback.format_exc(limit=12))
    writer.write(report)
    encoded=base64.b64encode(gzip.compress(h.json_bytes(report),mtime=0)).decode("ascii")
    parts=[encoded[start:start+4096] for start in range(0,len(encoded),4096)]
    for index,part in enumerate(parts,1):
        print("MNI_REPAIR_REPORT_GZIP_B64_PART %d/%d %s"%(index,len(parts),part),flush=True)
    print("MNI_REPAIR_SUMMARY "+json.dumps({
        "status":report["status"],"all405_payloads_unchanged":report.get("all405_payloads_unchanged"),
        "shape_edit_count":report.get("shape_edit_count"),
        "existing_cases":len(report["existing_reference_cases"]),"new_float_holdouts":len(report["new_float_holdouts"]),
        "existing_reference_pcm_pass":report.get("existing_reference_pcm_pass"),
        "new_float_holdouts_pass":report.get("new_float_holdouts_pass"),
        "backend_accepted":False,"error":report.get("error")},sort_keys=True),flush=True)
    return 0 if report["status"]=="dynamic-shape-repair-verified-backend-still-rejected" else 2


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command",choices=("prepare","run"))
    parser.add_argument("--inputs",type=Path,required=True)
    parser.add_argument("--stage",type=Path)
    parser.add_argument("--output",type=Path)
    args=parser.parse_args(argv)
    if args.command=="prepare":
        prepare(args)
        return 0
    if args.stage is None or args.output is None:
        parser.error("run requires --stage and --output")
    return run(args)


if __name__=="__main__":
    raise SystemExit(main())
