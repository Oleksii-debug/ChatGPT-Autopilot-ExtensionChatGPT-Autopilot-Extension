#!/usr/bin/env python3
"""Isolated native Manipuri CPU + FP32 safe-state/ONNX parity research.

No product registry changes, training, quantization, unsafe pickle or online
text normalization. Raw native carrier WAVs have pending human pronunciation
review. All original inference numerical methods come from pinned source AST.
"""
from __future__ import annotations
import argparse
import base64
import copy
import gc
import gzip
from hashlib import sha1, sha256
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import traceback
import wave

HERE = Path(__file__).resolve().parent
STATE_TOOL_BLOB = "23db98ad67d2165c455faa85445511838fabc8f5"
MAX_REPORT = 32*1024**2
MAX_FRAMES = 1200
FLOAT_ATOL = 1e-5
PCM_LSB_LIMIT = 1


def load_python(name, path, blob=None):
    raw = Path(path).read_bytes()
    if blob and sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest() != blob:
        raise ValueError("Frozen audit tool differs")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


native = load_python("mni_pinned_native", HERE/"mni_native_definitions.py")


def state_tool():
    return load_python("mni_safe_source", HERE/"inspect_mni_checkpoint_state.py", STATE_TOOL_BLOB)


def fresh_directory(path):
    path = Path(path).absolute()
    h = state_tool().helper()
    if path.exists() or path.is_symlink():
        raise FileExistsError("Research stage/output is immutable")
    for parent in path.parents:
        if parent.is_symlink() or getattr(parent,"is_junction",lambda:False)():
            raise ValueError("Linked research directory")
    h.safe_outputs(path/"unused-owned.zip", path/"unused-owned-report.json")
    path.mkdir(parents=True)
    return path


def validate_stages(archive,inputs,output=None):
    paths=[Path(archive).absolute().resolve(),Path(inputs).absolute().resolve()]
    if output is not None:
        paths.append(Path(output).absolute().resolve())
    for index,first in enumerate(paths):
        for second in paths[index+1:]:
            if first==second or first in second.parents or second in first.parents:
                raise ValueError("Raw source, pinned inputs and output must be disjoint")


def prepare(args):
    state = state_tool()
    h = state.helper()
    validate_stages(args.archive,args.inputs)
    directory = fresh_directory(args.inputs)
    receipt = state.acquire(args.archive, directory/"source-receipt.json")
    records = {}
    for name, expected in native.PINS.items():
        raw = h.bounded("https://raw.githubusercontent.com/gokulkarthik/TTS/"+native.REVISION+"/"+name,1024**2)
        actual = sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest()
        if actual != expected:
            raise ValueError("Pinned compatible native inference source differs")
        path = directory/"sources"/name
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(raw)
        records[name] = {"git_blob":actual,"sha256":sha256(raw).hexdigest(),"size_bytes":len(raw)}
    h.OwnedReport(directory/"native-inputs.json").write({
        "format":"dordiai-native-mni-inference-inputs","format_version":1,
        "archive":receipt["archive"],"source_revision":native.REVISION,
        "source_code_licence":"MPL-2.0 for historical TTS; MIT for AI4Bharat wrapper; no weights licence inferred",
        "source_files":records})
    print("MNI_NATIVE_INPUTS_READY",flush=True)


def fingerprint(path):
    return state_tool().helper().fingerprint(path)


def save_wave(path, waveform, np, rate=22050):
    audio = np.asarray(waveform,dtype=np.float32).reshape(-1)
    if not len(audio) or not np.isfinite(audio).all() or not np.any(audio):
        raise ValueError("Native carrier produced empty/nonfinite/silent audio")
    if len(audio)>rate*30:
        raise ValueError("Native carrier exceeded bounded utterance duration")
    pcm=np.rint(np.clip(audio,-1,1)*32767).astype("<i2")
    with Path(path).open("xb") as output:
        with wave.open(output,"wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(rate)
            stream.writeframes(pcm.tobytes())
    return {"file":Path(path).name,"sha256":fingerprint(path)["sha256"],
        "samples":len(audio),"sample_rate":rate,"seconds":len(audio)/rate,
        "finite":True,"nonzero":True,"peak":float(np.max(np.abs(audio))),
        "pcm_sha256":sha256(pcm.tobytes()).hexdigest()}


def comparison(reference, actual, np, pcm=False):
    ref=np.asarray(reference,dtype=np.float32)
    value=np.asarray(actual,dtype=np.float32)
    if ref.shape != value.shape or not np.isfinite(value).all():
        raise ValueError("Native parity shape/finite mismatch")
    delta=ref.astype(np.float64)-value.astype(np.float64)
    maximum=float(np.max(np.abs(delta)))
    power=float(np.sum(ref.astype(np.float64)**2))
    noise=float(np.sum(delta**2))
    snr=None if noise==0 else float(10*np.log10(max(power,1e-30)/noise))
    result={"shape":list(ref.shape),"max_abs":maximum,"bit_exact":bool(ref.tobytes()==value.tobytes()),
            "snr_db":snr,"float_atol":FLOAT_ATOL,"float_pass":maximum<=FLOAT_ATOL}
    if pcm:
        a=np.rint(np.clip(ref,-1,1)*32767).astype(np.int32)
        b=np.rint(np.clip(value,-1,1)*32767).astype(np.int32)
        lsb=int(np.max(np.abs(a-b)))
        result.update(pcm_max_lsb=lsb,pcm_lsb_limit=PCM_LSB_LIMIT,pcm_pass=lsb<=PCM_LSB_LIMIT)
    return result


def tensor_bits_equal(torch,first,second):
    return first.shape==second.shape and first.dtype==second.dtype and torch.equal(
        first.contiguous().view(torch.int32),second.contiguous().view(torch.int32))


def build_export_wrappers(torch, model, generator):
    class Encoder(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.model=model
        def forward(self, ids, speaker):
            mask=torch.ones_like(ids).unsqueeze(1).to(torch.float32)
            en,mask,_,_=self.model._forward_encoder(ids,mask,speaker)
            logdur=self.model.duration_predictor(en,mask)
            duration=self.model.format_durations(logdur,mask).squeeze(1)
            pitch,_=self.model._forward_pitch_predictor(en,mask)
            return en+pitch,duration
    class Decoder(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.model=model
        def forward(self, expanded):
            mask=torch.ones_like(expanded[:,0:1,:])
            positioned=self.model.pos_encoder(expanded,mask)
            return self.model.decoder(positioned,mask,g=None).transpose(1,2)
    class Vocoder(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.generator=generator
        def forward(self, mel):
            return self.generator.inference(mel)
    return Encoder().eval(),Decoder().eval(),Vocoder().eval()


def export_models(torch, wrappers, samples, output):
    axes=[
      {"ids":{1:"characters"},"encoded":{2:"characters"},"durations":{1:"characters"}},
      {"expanded":{2:"frames"},"mel":{1:"frames"}},
      {"mel":{2:"frames"},"audio":{2:"samples"}},
    ]
    inputs=[["ids","speaker"],["expanded"],["mel"]]
    outputs=[["encoded","durations"],["mel"],["audio"]]
    names=["fastpitch-encoder.onnx","fastpitch-decoder.onnx","hifigan.onnx"]
    records={}
    for wrapper,example,name,ia,oa,dynamic in zip(wrappers,samples,names,inputs,outputs,axes):
        path=output/name
        torch.onnx.export(wrapper,example,path,input_names=ia,output_names=oa,
            dynamic_axes=dynamic,opset_version=17,dynamo=False,do_constant_folding=False)
        records[name]=fingerprint(path)
    return records


def sessions(ort, output):
    if ort.__version__!="1.27.0":
        raise ValueError("This isolated CPU proof pins telemetry-free official ORT1.27.0")
    ort.disable_telemetry_events()
    result=[]
    for name in ("fastpitch-encoder.onnx","fastpitch-decoder.onnx","hifigan.onnx"):
        options=ort.SessionOptions()
        options.intra_op_num_threads=1
        options.inter_op_num_threads=1
        options.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
        result.append(ort.InferenceSession(str(output/name),sess_options=options,providers=["CPUExecutionProvider"]))
    return result


def expand_numpy(encoded,durations,np):
    duration=np.asarray(durations)
    if duration.shape[0]!=1 or not np.isfinite(duration).all():
        raise ValueError("Invalid native predicted durations")
    rounded=np.rint(duration).astype(np.int64)
    if not np.array_equal(rounded,duration) or np.min(rounded)<1 or int(np.sum(rounded))>MAX_FRAMES:
        raise ValueError("Native predicted duration outside bounded probe")
    return np.repeat(encoded,rounded[0],axis=2)


def native_samples(config, transliterate):
    # Authoritative MNI phrases come from the actual pinned checkpoint config.
    phrases=config["test_sentences"]
    if not isinstance(phrases,list) or len(phrases)<2 or not all(isinstance(item,str) for item in phrases):
        raise ValueError("Published native test phrases missing")
    word=phrases[0].split()[0].strip(",.")
    meetei=transliterate("Bengali","MeeteiMayek",word)
    restored=transliterate("MeeteiMayek","Bengali",meetei)
    if not meetei or meetei==word or not any(0xABC0<=ord(char)<=0xABFF for char in meetei):
        raise ValueError("Actual native-script transliteration did not yield Meetei")
    return [
      {"id":"word","source":"published-MNI-test-sentence-first-word","text":word,"script":"Bengali"},
      {"id":"phrase0","source":"published-MNI-config-test_sentences0","text":phrases[0],"script":"Bengali"},
      {"id":"phrase1","source":"published-MNI-config-test_sentences1","text":phrases[1],"script":"Bengali"},
      {"id":"meetei-word","source":"algorithmic-Meetei-roundtrip-of-published-MNI-word",
       "original_meetei":meetei,"text":restored,"script":"Meetei-to-native-Bengali",
       "roundtrip_exact":restored==word},
    ]


def run(args):
    state=state_tool()
    h=state.helper()
    h.MAX_REPORT=MAX_REPORT
    validate_stages(args.archive,args.inputs,args.output)
    output=fresh_directory(args.output)
    writer=h.OwnedReport(output/"proof.json")
    inputs=Path(args.inputs).absolute()
    descriptor=json.loads((inputs/"native-inputs.json").read_text(encoding="utf-8"),object_pairs_hook=h.unique_pairs)
    if descriptor.get("format")!="dordiai-native-mni-inference-inputs" or descriptor.get("source_revision")!=native.REVISION:
        raise ValueError("Pinned inference source descriptor missing")
    for name in native.PINS:
        native.read_source(inputs/"sources",name)
    if descriptor.get("archive")!={"sha256":state.ARCHIVE_SHA256,"size_bytes":state.ARCHIVE_SIZE}:
        raise ValueError("Source archive receipt mismatch")
    report={"format":"dordiai-native-mni-fp32-cpu-proof","format_version":1,"status":"preparing",
      "archive":descriptor["archive"],"source_revision":native.REVISION,
      "source_files":descriptor["source_files"],"selected_ast_definitions":native.SELECTION,
      "tool_sha256":sha256(Path(__file__).read_bytes()).hexdigest(),
      "definitions_sha256":sha256((HERE/"mni_native_definitions.py").read_bytes()).hexdigest(),
      "raw_native_carrier_only":True,"official_application_postprocessing_reproduced":False,"human_pronunciation_validation":"pending",
      "selected_voice_projection_verified":False,"production_integrated":False,
      "quantization_performed":False,"weights_precision":"unchanged-original-FP32",
      "weights_licence_asserted":False,"native_cases":[],"onnx_cases":[],
      "policy":{"onnx_float_atol":FLOAT_ATOL,"onnx_pcm_lsb_limit":PCM_LSB_LIMIT,
                "safestate_requires_all_tensor_hashes_equal":True}}
    # Sets are represented explicitly in the report, rather than dropped.
    report["selected_ast_definitions"]=[(p,{k:sorted(v) if v is not None else None for k,v in names.items()})
        for p,names in native.SELECTION]
    writer.write(report)
    try:
        with tempfile.TemporaryDirectory(prefix="dordiai-mni-native-") as temporary:
            stage=state.extract(args.archive,Path(temporary)/"weights")
            configs={name:json.loads((stage/name).read_text(encoding="utf-8"),object_pairs_hook=h.unique_pairs)
                for name in state.FILES if name.endswith(".json")}
            fast_config=configs["mni/fastpitch/config.json"]
            hifi_config=configs["mni/hifigan/config.json"]
            if fast_config["audio"]!=hifi_config["audio"] or fast_config["audio"]["signal_norm"] is not False:
                raise ValueError("Identity spectrogram normalization requires matching native configs")
            if fast_config["audio"]["sample_rate"]!=22050:
                raise ValueError("Unexpected native carrier rate")
            os.environ.update(HF_HUB_OFFLINE="1",TRANSFORMERS_OFFLINE="1",DO_NOT_TRACK="1",
                OMP_NUM_THREADS="1",MKL_NUM_THREADS="1",TOKENIZERS_PARALLELISM="false")
            report["network_guard"]=state.deny_network()
            import torch
            import numpy as np
            import onnxruntime as ort
            from safetensors.torch import load_file,save_file
            from aksharamukha.transliterate import process as transliterate
            report["torch_version"]=state.torch_version(torch)
            ort.disable_telemetry_events()
            report["dependencies"]={name:importlib.metadata.version(name) for name in (
                "torch","numpy","onnx","onnxruntime","safetensors","aksharamukha")}
            if report["dependencies"]["aksharamukha"]!="1.9.7":
                raise ValueError("Official wrapper pins Aksharamukha1.9.7")
            torch.set_num_threads(1)
            torch.set_num_interop_threads(1)
            torch.manual_seed(0)
            torch.use_deterministic_algorithms(True)
            namespace=native.build_namespace(inputs/"sources",torch)
            fp,_=state.safe_load(torch,stage/"mni/fastpitch/best_model.pth")
            hi,_=state.safe_load(torch,stage/"mni/hifigan/best_model.pth")
            speakers,_=state.safe_load(torch,stage/"mni/fastpitch/speakers.pth")
            fp_state,gen_state=native.selected_states(fp,hi)
            reference,generator=native.make_models(namespace,torch,fast_config,hifi_config,speakers)
            reference.load_state_dict(fp_state,strict=True)
            generator.load_state_dict(gen_state,strict=True)
            report["strict_original_architecture_match"]=True
            report["speakers"]=speakers
            compact_tensors={"fastpitch."+key:value.detach().contiguous()
                for key,value in fp_state.items() if not key.startswith("aligner.")}
            compact_tensors.update({"hifigan."+key:value.detach().contiguous() for key,value in gen_state.items()})
            removed={key:native.tensor_identity(value) for key,value in fp_state.items() if key.startswith("aligner.")}
            identities={key:native.tensor_identity(value) for key,value in compact_tensors.items()}
            report["retained_tensor_identities"]=identities
            report["removed_training_only_aligner_tensors"]=removed
            report["retained_fp32_logical_bytes"]=sum(row["size_bytes"] for row in identities.values())
            safe_path=output/"mni-inference-fp32.safetensors"
            save_file(compact_tensors,str(safe_path),metadata={
                "source_archive_sha256":state.ARCHIVE_SHA256,"language":"mni",
                "no_quantization":"true","original_precision":"float32"})
            report["safe_state_archive"]=fingerprint(safe_path)
            reloaded=load_file(str(safe_path),device="cpu")
            if {key:native.tensor_identity(value) for key,value in reloaded.items()}!=identities:
                raise ValueError("Safe-state export changed an original tensor")
            report["safe_state_all_original_tensor_hashes_equal"]=True
            model,vocoder=native.make_models(namespace,torch,fast_config,hifi_config,speakers,compact=True)
            model.load_state_dict({key[len("fastpitch."):]:value for key,value in reloaded.items() if key.startswith("fastpitch.")},strict=True)
            vocoder.load_state_dict({key[len("hifigan."):]:value for key,value in reloaded.items() if key.startswith("hifigan.")},strict=True)
            del fp,hi,fp_state,gen_state,compact_tensors,reloaded
            gc.collect()
            tokenizer=native.make_tokenizer(namespace,fast_config)
            report["tokenizer"]={"num_tokens":tokenizer.characters.num_chars,
                "ordered_tokens":tokenizer.characters.vocab,"unsupported_characters":"explicit-rejection",
                "text_cleaner":"original-multilingual_cleaners","source_language":"mni"}
            samples=native_samples(fast_config,transliterate)
            export_samples=None
            with torch.inference_mode():
                for sample in samples:
                    clean,ids=native.strict_ids(tokenizer,sample["text"])
                    for speaker,speaker_id in speakers.items():
                        x=torch.tensor([ids],dtype=torch.long)
                        sid=torch.tensor([speaker_id],dtype=torch.long)
                        aux={"speaker_ids":sid,"d_vectors":None}
                        started=time.perf_counter()
                        original=reference.inference(x,aux)["model_outputs"]
                        if original.shape[1]>MAX_FRAMES:
                            raise ValueError("Native reference utterance exceeds bounded frame count")
                        original_audio=generator.inference(original.transpose(1,2))
                        cold=time.perf_counter()-started
                        started=time.perf_counter()
                        compact=model.inference(x,aux)["model_outputs"]
                        compact_audio=vocoder.inference(compact.transpose(1,2))
                        compact_seconds=time.perf_counter()-started
                        repeated=model.inference(x,aux)["model_outputs"]
                        repeated_audio=vocoder.inference(repeated.transpose(1,2))
                        if not tensor_bits_equal(torch,original,compact) or not tensor_bits_equal(torch,original_audio,compact_audio):
                            raise ValueError("FP32 model-only archive changed native output")
                        if not tensor_bits_equal(torch,compact,repeated) or not tensor_bits_equal(torch,compact_audio,repeated_audio):
                            raise ValueError("Native repeated output is not deterministic")
                        audio=compact_audio.detach().cpu().numpy()
                        case={"sample":sample,"speaker":speaker,"speaker_id":speaker_id,
                            "cleaned_text":clean,"token_ids":ids,
                            "original_to_compact_mel_bit_exact":True,
                            "original_to_compact_audio_bit_exact":True,
                            "deterministic_repeat_bit_exact":True,"native_seconds":cold,
                            "compact_seconds":compact_seconds,
                            "wave":save_wave(output/(speaker+"-"+sample["id"]+"-native.wav"),audio,np)}
                        case["compact_rtf"]=compact_seconds/case["wave"]["seconds"]
                        report["native_cases"].append(case)
                        writer.write(report)
                        if export_samples is None:
                            wrapper=build_export_wrappers(torch,model,vocoder)[0]
                            encoded,durations=wrapper(x,sid)
                            expanded=expand_numpy(encoded.numpy(),durations.numpy(),np)
                            export_samples=((x,sid),(torch.from_numpy(expanded),),(compact.transpose(1,2),))
            report["native_safe_state_pass"]=True
            report["status"]="native-and-safe-state-pass-onnx-pending"
            writer.write(report)
            wrappers=build_export_wrappers(torch,model,vocoder)
            with torch.no_grad():
                report["onnx_exports"]=export_models(torch,wrappers,export_samples,output)
            import onnx
            for name in report["onnx_exports"]:
                graph=onnx.load(str(output/name),load_external_data=False)
                onnx.checker.check_model(graph)
                if any(item.data_type in (onnx.TensorProto.FLOAT16,onnx.TensorProto.BFLOAT16,onnx.TensorProto.INT8,onnx.TensorProto.UINT8)
                       for item in graph.graph.initializer):
                    raise ValueError("Export introduced lower precision or quantized initializers")
                if any(item.data_location==onnx.TensorProto.EXTERNAL for item in graph.graph.initializer):
                    raise ValueError("Unexpected unpinned external ONNX tensors")
                report["onnx_exports"][name]["initializers"]=[
                    {"name":item.name,"dtype":item.data_type,"shape":list(item.dims)} for item in graph.graph.initializer]
            started=time.perf_counter()
            encoder_session,decoder_session,vocoder_session=sessions(ort,output)
            report["onnx_session_open_seconds"]=time.perf_counter()-started
            all_pass=True
            for case in report["native_cases"]:
                x=np.array([case["token_ids"]],dtype=np.int64)
                sid=np.array([case["speaker_id"]],dtype=np.int64)
                with torch.inference_mode():
                    enc_ref,dur_ref=wrappers[0](torch.from_numpy(x),torch.from_numpy(sid))
                    expanded_ref=expand_numpy(enc_ref.numpy(),dur_ref.numpy(),np)
                    mel_ref=wrappers[1](torch.from_numpy(expanded_ref)).numpy()
                    native_mel=model.inference(torch.from_numpy(x),{"speaker_ids":torch.from_numpy(sid),"d_vectors":None})["model_outputs"].numpy()
                    if mel_ref.tobytes()!=native_mel.tobytes():
                        raise ValueError("Host duration expansion differs from original native inference")
                    audio_ref=wrappers[2](torch.from_numpy(mel_ref).transpose(1,2)).numpy()
                started=time.perf_counter()
                encoded,duration=encoder_session.run(None,{"ids":x,"speaker":sid})
                exact_duration=np.array_equal(duration,dur_ref.numpy())
                expanded=expand_numpy(encoded,duration,np)
                mel=decoder_session.run(None,{"expanded":expanded})[0]
                audio=vocoder_session.run(None,{"mel":mel.transpose(0,2,1)})[0]
                elapsed=time.perf_counter()-started
                checks={"encoded":comparison(enc_ref.numpy(),encoded,np),
                    "mel":comparison(mel_ref,mel,np),"audio":comparison(audio_ref,audio,np,pcm=True)}
                passed=exact_duration and all(item["float_pass"] for item in checks.values()) and checks["audio"]["pcm_pass"]
                all_pass=all_pass and passed
                result={"sample_id":case["sample"]["id"],"speaker":case["speaker"],
                    "durations_exact":bool(exact_duration),"comparisons":checks,"parity_pass":bool(passed),
                    "seconds":elapsed,"rtf":elapsed/case["wave"]["seconds"],
                    "wave":save_wave(output/(case["speaker"]+"-"+case["sample"]["id"]+"-onnx.wav"),audio,np)}
                report["onnx_cases"].append(result)
                writer.write(report)
            report["onnx_parity_pass"]=bool(all_pass)
            report["status"]="native-fp32-safestate-onnx-pass-human-review-pending" if all_pass else "native-safestate-pass-onnx-parity-failed"
    except Exception as error:
        report.update(status="native-proof-blocked-or-failed",error_type=type(error).__name__,
            error=str(error)[:6000],traceback=traceback.format_exc(limit=12))
    import resource
    report["peak_rss_kib"]=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    writer.write(report)
    raw=h.json_bytes(report)
    encoded=base64.b64encode(gzip.compress(raw,mtime=0)).decode("ascii")
    chunks=[encoded[start:start+4096] for start in range(0,len(encoded),4096)]
    for index,chunk in enumerate(chunks,1):
        print("MNI_NATIVE_REPORT_GZIP_B64_PART %d/%d %s"%(index,len(chunks),chunk),flush=True)
    print("MNI_NATIVE_SUMMARY "+json.dumps({
        "status":report["status"],"native_cases":len(report["native_cases"]),
        "onnx_cases":len(report["onnx_cases"]),"retained_fp32_logical_bytes":report.get("retained_fp32_logical_bytes"),
        "safe_state_equal":report.get("safe_state_all_original_tensor_hashes_equal"),
        "onnx_parity_pass":report.get("onnx_parity_pass"),"error_type":report.get("error_type"),
        "peak_rss_kib":report["peak_rss_kib"],"production_integrated":False},sort_keys=True),flush=True)
    return 0 if report["status"]=="native-fp32-safestate-onnx-pass-human-review-pending" else 2


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command",choices=("prepare","run"))
    parser.add_argument("--archive",type=Path,required=True)
    parser.add_argument("--inputs",type=Path,required=True)
    parser.add_argument("--output",type=Path)
    args=parser.parse_args(argv)
    if args.command=="prepare":
        prepare(args)
        return 0
    if args.output is None:
        parser.error("run requires --output")
    return run(args)


if __name__=="__main__":
    raise SystemExit(main())
