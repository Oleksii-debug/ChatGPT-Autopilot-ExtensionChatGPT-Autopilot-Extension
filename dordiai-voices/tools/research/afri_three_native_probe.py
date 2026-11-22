"""Isolated exact six-layer Zulu/Sepedi/Wolof native CPU proof.

Uses existing full-FP32 graphs and the unchanged private core interpreter.
No production registry, voice, runtime DLL, model parameter, or fallback is changed.
"""
from __future__ import annotations
import argparse
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import sys
from time import perf_counter

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("afri_three_verified_carrier",HERE/"afri_six_ort_probe.py")
carrier_module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(carrier_module)
pins,common=carrier_module.pins,carrier_module.common
LANGUAGES={"zul":{"selected_code":"zu","name":"Zulu","trained_hours":21.14},
           "nso":{"selected_code":"nso","name":"Northern Sotho / Sepedi","trained_hours":13.24},
           "wol":{"selected_code":"wo","name":"Wolof","trained_hours":0.56}}
FORMAT="dordiai-afri-three-native-cpu-v1"
CAUTIONS=["Wolof has only0.56h in this checkpoint; publisher warns that languages below2h are weak.",
          "Religious read-speech dominates training; spontaneous and technical pronunciation remains unaccepted.",
          "Literal digits are unsupported by training; no number fallback is introduced here.",
          "Native carrier timings are completed-wave CPU measurements, not streaming first PCM, NVDA or acoustic latency."]


def select_cases(text,per_language=3):
    result=[]
    for code in LANGUAGES:
        rows=[]
        for line in text.splitlines():
            columns=line.split("\t",2)
            if len(columns)==3 and columns[0]==code:
                rows.append({"language":code,"text":columns[1],"expected_training_ipa":columns[2],
                             "source_kind":"unaltered-primary-golden-fixture"})
        if len(rows)<per_language:
            raise ValueError("Pinned primary fixture lacks exact native cases: "+code)
        result.extend(rows[:per_language])
    return result


def first_word(row):
    text,ipa=row["text"].split()[0],row["expected_training_ipa"].split()[0]
    if not text.isalpha() or not ipa:
        raise ValueError("First-word benchmark needs an unambiguous native token")
    return {"language":row["language"],"text":text,"expected_training_ipa":ipa,
            "source_kind":"first-aligned-token-of-primary-golden-fixture",
            "source_fixture_text":row["text"],"source_fixture_ipa":row["expected_training_ipa"]}


def check_ipa(row,g2p):
    if "source_fixture_text" in row and g2p(row["source_fixture_text"],row["language"],output="ipa")!=row["source_fixture_ipa"]:
        raise ValueError("Whole source fixture differs from trained IPA")
    actual=g2p(row["text"],row["language"],output="ipa")
    if actual!=row["expected_training_ipa"]:
        raise ValueError("Native spelling/G2P differs from exact primary IPA")
    return actual


def acquire(args):
    root=args.assets.resolve()
    root.mkdir(parents=True,exist_ok=True)
    metadata=common.read_json_url("https://huggingface.co/api/models/AfriSpeech/africa-tts/revision/"+pins.MODEL_REVISION+"?blobs=true")
    if metadata.get("sha")!=pins.MODEL_REVISION:
        raise ValueError("Publisher revision changed")
    rows={row["rfilename"]:row for row in metadata["siblings"]}
    report={"format":FORMAT,"status":"acquiring","revision":pins.MODEL_REVISION,
            "source_revision":pins.SOURCE_REVISION,"g2p_revision":pins.G2P_REVISION,
            "files":{},"languages":LANGUAGES,"cautions":CAUTIONS,
            "model_weights_downloaded":False,"product_integrated":False,
            "publisher_model_license":(metadata.get("cardData") or {}).get("license")}
    common.write_json(args.report,report,overwrite=args.overwrite)
    targets={"tokenizer.json":pins.PINS["tokenizer.json"],"config.yaml":pins.PINS["config.yaml"]}
    for code in LANGUAGES:
        relative=next((name for name in ("voices/"+code+".wav","sherpa-onnx/voices/"+code+".wav") if name in rows),None)
        if relative is None:
            raise ValueError("Exact native reference absent: "+code)
        targets[relative]=common.artifact_record(rows[relative])
    for relative in ("README.md","LICENSE"):
        if relative in rows:
            targets[relative]=common.artifact_record(rows[relative])
    for relative,expected in targets.items():
        target=root/relative
        common.download("https://huggingface.co/AfriSpeech/africa-tts/resolve/"+pins.MODEL_REVISION+"/"+relative,target,expected)
        role="voice_"+target.stem if relative.endswith(".wav") else relative
        report["files"][role]=dict(expected,relative=relative,raw_sha256=common.digest(target))
    for role,(relative,size,blob) in common.SOURCE_FILES.items():
        path=root/role
        expected={"bytes":size,"git_blob_sha1":blob}
        common.download("https://raw.githubusercontent.com/AfriSpeech/africa-tts/"+pins.SOURCE_REVISION+"/"+relative,path,expected)
        report["files"][role]=dict(expected,relative=role,raw_sha256=common.digest(path))
    trained=json.loads((root/"languages.json").read_text(encoding="utf-8"))
    for code,value in LANGUAGES.items():
        if trained.get(code,{}).get("hours")!=value["trained_hours"]:
            raise ValueError("Not this native standard's actual trained metadata: "+code)
    select_cases((root/"parity_set.tsv").read_text(encoding="utf-8"))
    report["status"]="pinned-three-native-inputs-acquired"
    common.write_json(root/"three-native-inputs.json",report)
    common.write_json(args.report,report)
    return report


def verified_inputs(root):
    index=json.loads((root/"three-native-inputs.json").read_text(encoding="utf-8"))
    if (index.get("format")!=FORMAT or index.get("revision")!=pins.MODEL_REVISION
            or index.get("source_revision")!=pins.SOURCE_REVISION
            or index.get("g2p_revision")!=pins.G2P_REVISION
            or index.get("languages")!=LANGUAGES
            or index.get("status")!="pinned-three-native-inputs-acquired"):
        raise ValueError("Exact native frontend/reference inventory differs")
    for row in index["files"].values():
        path=root/row["relative"]
        if not path.resolve().is_relative_to(root) or not common.verify_file(path,row) or common.digest(path)!=row["raw_sha256"]:
            raise ValueError("Pinned native input changed")
    trained=json.loads((root/"languages.json").read_text(encoding="utf-8"))
    if any(trained.get(code,{}).get("hours")!=value["trained_hours"] for code,value in LANGUAGES.items()):
        raise ValueError("Pinned native training metadata differs")
    return index


def probe(args):
    root=args.assets.resolve()
    index=verified_inputs(root)
    pins.git_head(args.g2p_source.resolve(),pins.G2P_REVISION)
    report={"format":FORMAT,"status":"running","product_integrated":False,
            "native_pronunciation_verified":False,"typing_or_character_names_verified":False,
            "selected_voice_projection_verified":False,"nvda_verified":False,
            "physical_audio_verified":False,"streaming_first_pcm_measured":False,
            "languages":LANGUAGES,"cautions":CAUTIONS,"source_inputs":index,
            "graph_artifact":carrier_module.GRAPH_ARTIFACT,"cases":[],"word_benchmarks":[]}
    common.write_json(args.report,report,overwrite=args.overwrite)
    if sys.platform!="win32" or args.packaged_runtime is None:
        raise ValueError("This proof requires the actual unchanged Windows private core")
    runtime=args.packaged_runtime.resolve()
    package_python=runtime/"python"
    if not os.path.samefile(sys.executable,package_python/"python.exe") or not sys.version.startswith("3.14."):
        raise ValueError("Not the actual unchanged core Python3.14 interpreter")
    policy=json.loads(args.network_policy.read_text(encoding="utf-8-sig"))
    required={str(Path(value).resolve()).casefold() for value in (sys.executable,getattr(sys,"_base_executable",None) or sys.executable)}
    programs={str(Path(value).resolve()).casefold() for value in policy.get("programs",[])}
    if (policy.get("action")!="Block" or policy.get("direction")!="Outbound"
            or policy.get("enabled") is not True or policy.get("all_firewall_profiles_enabled") is not True
            or not required.issubset(programs)):
        raise ValueError("Actual inference executable lacks scoped outbound denial")
    report["network_policy"]=policy
    carrier_module.python_socket_guard()
    os.environ.update(HF_HUB_OFFLINE="1",TRANSFORMERS_OFFLINE="1",DO_NOT_TRACK="1",CUDA_VISIBLE_DEVICES="")
    boot_spec=importlib.util.spec_from_file_location("afri_three_private_bootstrap",runtime/"windows_runtime.py")
    bootstrap=importlib.util.module_from_spec(boot_spec);boot_spec.loader.exec_module(bootstrap)
    report["private_bootstrap"]=bootstrap.reset_inherited_dll_directory()
    sys.path.insert(0,str(args.g2p_source.resolve()/"src"))
    import numpy as np
    from africa_g2p import g2p
    start=perf_counter()
    carrier=carrier_module.SixLayerOrtCarrier(args.graphs,root/"tokenizer.json",expected_ort_version="1.26.0",package_python=package_python)
    report["model_load_seconds"]=perf_counter()-start
    report["runtime_imports"]={name:{"file":str(getattr(sys.modules[name],"__file__","")),
                                   "version":str(getattr(sys.modules[name],"__version__","unreported"))}
                              for name in ("numpy","onnxruntime","tokenizers")}
    if any(not Path(row["file"]).resolve().is_relative_to(package_python) for row in report["runtime_imports"].values()):
        raise ValueError("A native dependency escaped the unchanged private package")
    report["packaged_runtime_verified"]=True
    report["graph_provenance"]=carrier.provenance
    originals={role:common.digest(path) for role,path in carrier.paths.items()}
    rows=select_cases((root/"parity_set.tsv").read_text(encoding="utf-8"))
    references={}
    for code in LANGUAGES:
        path=root/index["files"]["voice_"+code]["relative"]
        wave,rate,facts=carrier_module.read_reference_wav(path)
        if rate!=24000:
            raise ValueError("No silent resampler or different-language reference is allowed")
        references[code]=(wave,rate,facts)
    output=args.report.resolve().parent/"audio";output.mkdir(parents=True,exist_ok=True)

    def render(row,label):
        ipa=check_ipa(row,g2p)
        ref,rate,facts=references[row["language"]]
        start=perf_counter()
        audio=carrier.audio(ipa,ref,rate)
        elapsed=perf_counter()-start
        if carrier.last_facts["generation_cap_reached"]:
            raise ValueError("Generation cap reached; utterance completion is unproven")
        peak,rms=float(np.max(np.abs(audio))),float(np.sqrt(np.mean(audio**2)))
        if peak<1e-5 or rms<1e-6:
            raise ValueError("Silent native waveform")
        target=output/(row["language"]+"-"+label+".wav")
        carrier_module.write_pcm16_wav(target,audio,24000)
        return dict(row,status="passed",ipa=ipa,samples=len(audio),sample_rate=24000,
                    seconds=len(audio)/24000,inference_seconds=elapsed,real_time_factor=elapsed/(len(audio)/24000),
                    peak=peak,rms=rms,clip_fraction=float(np.mean(np.abs(audio)>=1.)),
                    wav_file=str(target),wav_sha256=common.digest(target),float32_sha256=sha256(audio.tobytes()).hexdigest(),
                    reference_sha256=index["files"]["voice_"+row["language"]]["raw_sha256"],
                    reference_wav_format=facts,host_facts=carrier.last_facts,
                    process_peak_rss_bytes=carrier_module.peak_rss())

    for code in LANGUAGES:
        first=next(row for row in rows if row["language"]==code)
        benchmark=render(first_word(first),"word-cold")
        benchmark["timing_scope"]="completed native word incl first reference encoding; not streaming or NVDA"
        report["word_benchmarks"].append(benchmark)
        common.write_json(args.report,report)
        print(json.dumps({"kind":"native-word","language":code,"inference_seconds":benchmark["inference_seconds"],
                          "audio_seconds":benchmark["seconds"]}),flush=True)
    for number,row in enumerate(rows):
        item=render(row,"golden-"+str(number))
        report["cases"].append(item)
        common.write_json(args.report,report)
        print(json.dumps({key:item[key] for key in ("language","seconds","inference_seconds","real_time_factor")}),flush=True)
    first=report["word_benchmarks"][0]
    ref,rate,_=references[first["language"]]
    replay=carrier.audio(first["ipa"],ref,rate)
    if sha256(replay.tobytes()).hexdigest()!=first["float32_sha256"]:
        raise ValueError("Recurrent state or native reference leaked after mixed languages")
    if any(common.digest(path)!=originals[role] for role,path in carrier.paths.items()):
        raise ValueError("Original verified full-FP32 graphs were modified")
    verified_inputs(root)
    report.update(status="actual-three-native-private-core-cpu-unintegrated",
                  all_nine_native_cases_passed=len(report["cases"])==9,
                  all_three_native_word_benchmarks_passed=len(report["word_benchmarks"])==3,
                  recurrent_state_reset_replay_passed=True,all_input_bytes_unchanged=True,
                  windows_verified=True,python_version=sys.version,ort_version=carrier.ort.__version__,
                  provider="CPUExecutionProvider",process_peak_rss_bytes=carrier_module.peak_rss(),
                  executable=sys.executable,wave_io="stdlib PCM16; no soundfile or new DLL",
                  existing_omni_word_comparison="Prior Omni carrier22.53s32steps; different texts and this model not acoustically equivalent.")
    common.write_json(args.report,report)
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase",choices=("acquire","probe"))
    parser.add_argument("--assets",type=Path,required=True)
    parser.add_argument("--report",type=Path,required=True)
    parser.add_argument("--graphs",type=Path)
    parser.add_argument("--g2p-source",type=Path)
    parser.add_argument("--network-policy",type=Path)
    parser.add_argument("--packaged-runtime",type=Path)
    parser.add_argument("--overwrite",action="store_true")
    args=parser.parse_args()
    if args.report.is_symlink() or args.report.exists() and not args.overwrite:
        parser.error("Refusing existing proof output")
    if args.phase=="probe" and any(getattr(args,name) is None for name in ("graphs","g2p_source","network_policy","packaged_runtime")):
        parser.error("Actual unchanged private runtime/graphs/G2P/firewall proof required")
    if args.report.resolve().is_relative_to(args.assets.resolve()) or args.graphs and args.report.resolve().is_relative_to(args.graphs.resolve()):
        parser.error("Proof output must be separate from immutable assets")
    try:
        return (acquire(args) if args.phase=="acquire" else probe(args)) and 0
    except Exception as error:
        previous=json.loads(args.report.read_text(encoding="utf-8")) if args.report.is_file() else {}
        previous.update(status="failed",error_type=type(error).__name__,error=str(error),product_integrated=False)
        common.write_json(args.report,previous)
        raise


if __name__=="__main__":
    raise SystemExit(main())
