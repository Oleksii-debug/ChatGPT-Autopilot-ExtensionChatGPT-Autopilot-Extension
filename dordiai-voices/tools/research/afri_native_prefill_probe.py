"""Lossless native voice-prefill cache experiment; isolated research only.

The baseline is the unchanged SixLayerOrtCarrier.audio. The experimental path
only deep-copies past-state AFTER native voice prefill, then clones per request.
Graphs, weights, dtype, noise/RNG, text, EOS policy and decoder chunks are unchanged.
"""
from __future__ import annotations
import argparse
from collections import OrderedDict
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import sys
from time import perf_counter

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("prefill_primary_native",HERE/"afri_three_native_probe.py")
inputs=importlib.util.module_from_spec(spec);spec.loader.exec_module(inputs)
carrier_module,pins,common=inputs.carrier_module,inputs.pins,inputs.common
RATE=carrier_module.RATE
LOOP_SOURCE=carrier_module.LOOP_SOURCE
LANGUAGES={"ssw":{"selected_code":"ss","name":"Swati","trained_hours":12.08},
           "ven":{"selected_code":"ve","name":"Venda","trained_hours":10.62},
           **inputs.LANGUAGES}
FORMAT="dordiai-afri-native-prefill-parity-v1"
CAUTIONS=inputs.CAUTIONS
MAX_BUDGET=160*1024*1024


class VoicePrefills:
    def __init__(self,budget=MAX_BUDGET,max_entries=3):
        if not 0<budget<=MAX_BUDGET or not 1<=max_entries<=3:
            raise ValueError("Voice-only cache must remain within160MiB and3native references")
        self.budget,self.max_entries=budget,max_entries
        self.states=OrderedDict();self.bytes=0;self.peak_bytes=0;self.evictions=[];self.hits=0;self.misses=0

    @staticmethod
    def size(state):
        if not state or any(type(value.nbytes) is not int or value.nbytes<0 for value in state.values()):
            raise ValueError("Invalid recurrent state arrays")
        return sum(value.nbytes for value in state.values())

    def take(self,key,trace):
        if key not in self.states:
            self.misses+=1;return None
        start=perf_counter();state,size=self.states.pop(key);self.states[key]=(state,size)
        if any(value.flags.writeable for value in state.values()):
            raise RuntimeError("Cached voice snapshots lost immutable ownership")
        copied={name:value.copy(order="C") for name,value in state.items()}
        trace["seconds"]["prefill_clone"]=perf_counter()-start
        self.hits+=1
        return copied

    def put(self,key,state,trace):
        size=self.size(state)
        if size>self.budget:
            trace["oversized_uncached_state_bytes"]=size;return False
        if key in self.states:
            self.bytes-=self.states.pop(key)[1]
        while self.states and (self.bytes+size>self.budget or len(self.states)>=self.max_entries):
            old,(_,amount)=self.states.popitem(last=False)
            self.bytes-=amount;self.evictions.append(old[0])
        start=perf_counter()
        snapshot={name:value.copy(order="C") for name,value in state.items()}
        for value in snapshot.values():value.flags.writeable=False
        self.states[key]=(snapshot,size);self.bytes+=size
        self.peak_bytes=max(self.peak_bytes,self.bytes)
        trace["seconds"]["prefill_snapshot"]=perf_counter()-start
        if self.bytes>self.budget:
            raise RuntimeError("Retained voice-prefill budget exceeded")
        return True

    def facts(self):
        return {"budget_bytes":self.budget,"retained_array_bytes":self.bytes,"peak_retained_array_bytes":self.peak_bytes,
                "max_entries":self.max_entries,"entry_count":len(self.states),"hits":self.hits,"misses":self.misses,
                "evictions":list(self.evictions),"entries":[{"native_language":key[0],"reference_sha256":key[1],
                    "array_bytes":size,"readonly":all(not value.flags.writeable for value in state.values())}
                    for key,(state,size) in self.states.items()]}


class TimedSession:
    def __init__(self,role,session,owner):
        self.role,self.session,self.owner=role,session,owner
    def __getattr__(self,name):
        return getattr(self.session,name)
    def run(self,outputs,values,*args,**kwargs):
        trace=self.owner.trace
        if self.role=="lm_main":
            count=trace["lm_calls"];trace["lm_calls"]+=1
            stage=("text_prefill" if count==0 else "ar_lm") if trace.get("voice_prefill_skipped") else (
                "voice_prefill" if count==0 else "text_prefill" if count==1 else "ar_lm")
        else:stage={"encoder":"reference_encoder","text_conditioner":"text_conditioner","lm_flow":"ar_flow","decoder":"decoder"}[self.role]
        start=perf_counter()
        result=self.session.run(outputs,values,*args,**kwargs)
        trace["seconds"][stage]=trace["seconds"].get(stage,0.)+perf_counter()-start
        if self.role=="lm_flow":
            # This is the exact original float32 noise+direction latent, observed
            # without modifying either tensor or its returned output.
            trace["latent_sha256"].append(sha256((values["x"]+result[0]).tobytes()).hexdigest())
        return result


class CachedCarrier(carrier_module.SixLayerOrtCarrier):
    def __init__(self,*args,cache_budget=MAX_BUDGET,**kwargs):
        super().__init__(*args,**kwargs)
        self.prefills=VoicePrefills(cache_budget);self.native_code=None
        self.trace={}
        self.sessions={role:TimedSession(role,session,self) for role,session in self.sessions.items()}

    def audio(self, ipa, reference, reference_rate, *, temperature=0.3, seed=42, max_frames=500):
        np = self.np
        if reference_rate != RATE:
            raise ValueError("This proof requires genuine native24kHz reference; no implicit resampler")
        wave = np.asarray(reference, dtype=np.float32)
        if wave.ndim != 1 or not np.isfinite(wave).all() or len(wave) < 512:
            raise ValueError("Invalid native reference")
        wave = np.ascontiguousarray(wave[:10 * RATE])
        key = sha256(wave.tobytes()).hexdigest()
        cache_key = (self.native_code, key)
        cached = self.prefills.take(cache_key, self.trace)
        self.trace["voice_prefill_skipped"] = cached is not None
        if cached is None and key not in self.voice_cache:
            if len(self.voice_cache) >= 2:
                self.voice_cache.pop(next(iter(self.voice_cache)))
            self.voice_cache[key] = self.sessions["encoder"].run(None, {"audio": wave[None, None]})[0]
        voice = self.voice_cache[key] if cached is None else None
        ids = self.tokenizer.encode(ipa).ids
        if not ids or (self.unknown_id is not None and self.unknown_id in ids):
            raise ValueError("Empty or unknown tokenizer units")
        text = self.sessions["text_conditioner"].run(None, {"token_ids": np.asarray([ids], np.int64)})[0]
        state = self.zero_state("lm_main", 2) if cached is None else cached
        empty_seq, empty_txt = np.zeros((1, 0, 32), np.float32), np.zeros((1, 0, 1024), np.float32)

        def main(seq, emb):
            outputs = self.sessions["lm_main"].run(None, {"sequence": seq, "text_embeddings": emb, **state})
            if len(outputs) != len(state) + 2:
                raise ValueError("Unexpected recurrent state contract")
            for name, value in zip(list(state), outputs[2:]):
                state[name] = value
            return outputs[0], outputs[1]

        if cached is None:
            main(empty_seq, voice)
            self.prefills.put(cache_key, state, self.trace)
        main(empty_seq, text)
        current = np.full((1, 1, 32), np.nan, np.float32)
        random = np.random.default_rng(seed)
        latents, eos_step, eos_last, reached_cap = [], None, None, True
        for step in range(max_frames):
            conditioning, eos = main(current, empty_txt)
            eos_last = float(eos.reshape(-1)[0])
            if eos_step is None and eos_last > -4.:
                eos_step = step
            # Match the pinned official Sherpa stop policy, including its step-zero detail.
            if eos_step is not None and eos_step > 0 and step >= eos_step + 3:
                reached_cap = False
                break
            noise = random.normal(0., np.sqrt(temperature), (1, 32)).astype(np.float32)
            direction = self.sessions["lm_flow"].run(None, {"c": conditioning,
                          "s": np.zeros((1, 1), np.float32), "t": np.ones((1, 1), np.float32), "x": noise})[0]
            latent = noise + direction  # Exact one-LSD-step Euler update, dt=1.
            if not np.isfinite(latent).all():
                raise ValueError("Nonfinite latent")
            latents.append(latent[0])
            current = latent[:, None]
        if not latents:
            raise ValueError("No generated frames")
        # Release model state before decoder allocations, as in the native implementation.
        state.clear()
        latent = np.asarray(latents, np.float32)[None]
        decoder_state = self.zero_state("decoder", 1)
        chunks = []
        for start in range(0, latent.shape[1], 15):
            outputs = self.sessions["decoder"].run(None, {"latent": latent[:, start:start + 15], **decoder_state})
            if len(outputs) != len(decoder_state) + 1:
                raise ValueError("Unexpected decoder state contract")
            for name, value in zip(list(decoder_state), outputs[1:]):
                decoder_state[name] = value
            chunks.append(outputs[0].reshape(-1))
        audio = np.concatenate(chunks).astype(np.float32)
        if not np.isfinite(audio).all() or len(audio) < 2400:
            raise ValueError("Invalid native PCM")
        self.last_facts = {"token_ids": ids, "latent_frames": len(latents), "eos_step": eos_step,
                           "eos_last": eos_last, "generation_cap_reached": reached_cap,
                           "seed": seed, "temperature": temperature, "frame_limit": max_frames,
                           "source_loop": LOOP_SOURCE, "random_sequence_note":
                           "NumPy generator differs from C++ RNG; deterministic per our fixed seed, not sample-identical to Sherpa."}
        return audio

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


def acquire_native_inputs(args):
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
    report["status"]="pinned-five-native-inputs-acquired"
    common.write_json(root/"prefill-native-inputs.json",report)
    common.write_json(args.report,report)
    return report


def verified_inputs(root):
    index=json.loads((root/"prefill-native-inputs.json").read_text(encoding="utf-8"))
    if (index.get("format")!=FORMAT or index.get("revision")!=pins.MODEL_REVISION
            or index.get("source_revision")!=pins.SOURCE_REVISION
            or index.get("g2p_revision")!=pins.G2P_REVISION
            or index.get("languages")!=LANGUAGES
            or index.get("status")!="pinned-five-native-inputs-acquired"):
        raise ValueError("Exact native frontend/reference inventory differs")
    for row in index["files"].values():
        path=root/row["relative"]
        if not path.resolve().is_relative_to(root) or not common.verify_file(path,row) or common.digest(path)!=row["raw_sha256"]:
            raise ValueError("Pinned native input changed")
    trained=json.loads((root/"languages.json").read_text(encoding="utf-8"))
    if any(trained.get(code,{}).get("hours")!=value["trained_hours"] for code,value in LANGUAGES.items()):
        raise ValueError("Pinned native training metadata differs")
    return index





def fixtures(text):
    output=[]
    for code in LANGUAGES:
        selected=[]
        for line in text.splitlines():
            row=line.split("\t",2)
            if len(row)==3 and row[0]==code:
                selected.append({"language":code,"text":row[1],"expected_training_ipa":row[2]})
        if len(selected)<3:raise ValueError("Missing same-language golden fixtures: "+code)
        output.extend(selected[:3])
    return output


def acquire(args):
    # Use the same already-reviewed acquisition code with independent globals,
    # not a mutation of the original3-language module.
    index=acquire_native_inputs(args)
    if set(index["languages"])!=set(LANGUAGES):raise ValueError("Five actual native references required")
    return index


def probe(args):
    root=args.assets.resolve();index=verified_inputs(root)
    pins.git_head(args.g2p_source.resolve(),pins.G2P_REVISION)
    report={"format":FORMAT,"status":"running","product_integrated":False,"native_pronunciation_verified":False,
            "nvda_verified":False,"physical_audio_verified":False,"selected_voice_projection_verified":False,
            "cache_budget_bytes":MAX_BUDGET,"languages":LANGUAGES,"cases":[],"word_benchmarks":[],"post_eviction_replays":[],
            "optimization":"readonly-deep-copy voice-only past; per-request writable clone; original arrays and graph bytes unchanged",
            "source_inputs":index}
    common.write_json(args.report,report,overwrite=args.overwrite)
    if sys.platform!="win32":raise ValueError("Actual unchanged Windows private runtime required")
    runtime=args.packaged_runtime.resolve();package_python=runtime/"python"
    if not os.path.samefile(sys.executable,package_python/"python.exe") or not sys.version.startswith("3.14."):
        raise ValueError("Not original private Python3.14")
    policy=json.loads(args.network_policy.read_text(encoding="utf-8-sig"))
    needed={str(Path(value).resolve()).casefold() for value in (sys.executable,getattr(sys,"_base_executable",None) or sys.executable)}
    if (policy.get("action")!="Block" or policy.get("direction")!="Outbound" or policy.get("enabled") is not True
            or policy.get("all_firewall_profiles_enabled") is not True
            or not needed.issubset({str(Path(value).resolve()).casefold() for value in policy.get("programs",[])})):
        raise ValueError("No effective scoped native-network denial")
    report["network_policy"]=policy;carrier_module.python_socket_guard()
    os.environ.update(HF_HUB_OFFLINE="1",TRANSFORMERS_OFFLINE="1",DO_NOT_TRACK="1",CUDA_VISIBLE_DEVICES="")
    boot_spec=importlib.util.spec_from_file_location("prefill_private_bootstrap",runtime/"windows_runtime.py")
    bootstrap=importlib.util.module_from_spec(boot_spec);boot_spec.loader.exec_module(bootstrap)
    report["private_bootstrap"]=bootstrap.reset_inherited_dll_directory()
    sys.path.insert(0,str(args.g2p_source.resolve()/"src"))
    import numpy as np
    from africa_g2p import g2p
    start=perf_counter()
    engine=CachedCarrier(args.graphs,root/"tokenizer.json",expected_ort_version="1.26.0",package_python=package_python)
    report["model_load_seconds"]=perf_counter()-start
    report["graph_artifact"]=carrier_module.GRAPH_ARTIFACT
    report["graph_provenance"]=engine.provenance
    report["baseline_audio_source_file_sha256"]=common.digest(Path(carrier_module.__file__))
    report["runtime_imports"]={name:{"file":str(getattr(sys.modules[name],"__file__","")),
                                   "version":str(getattr(sys.modules[name],"__version__","unreported"))}
                              for name in ("numpy","onnxruntime","tokenizers")}
    if any(not Path(value["file"]).resolve().is_relative_to(package_python) for value in report["runtime_imports"].values()):
        raise ValueError("Dependencies escaped actual private package")
    before={role:common.digest(path) for role,path in engine.paths.items()}
    rows=fixtures((root/"parity_set.tsv").read_text(encoding="utf-8"))
    refs={code:carrier_module.read_reference_wav(root/index["files"]["voice_"+code]["relative"]) for code in LANGUAGES}
    for code,(_,rate,_) in refs.items():
        if rate!=RATE:raise ValueError("No resampling or neighbouring-language reference")
    audio_dir=args.report.resolve().parent/"audio";audio_dir.mkdir(parents=True,exist_ok=True)

    def render(row,cached):
        ipa=inputs.check_ipa(row,g2p);code=row["language"];wave,rate,_=refs[code]
        engine.native_code=code;engine.trace={"seconds":{},"latent_sha256":[],"lm_calls":0,"voice_prefill_skipped":False}
        start=perf_counter()
        audio=(engine.audio(ipa,wave,rate) if cached else carrier_module.SixLayerOrtCarrier.audio(engine,ipa,wave,rate))
        elapsed=perf_counter()-start
        if engine.last_facts["generation_cap_reached"]:raise ValueError("Generation cap; no complete utterance")
        pcm=(np.clip(audio,-1.,1.-1./32768.)*32768.).astype("<i2")
        result={"wall_seconds":elapsed,"stage_seconds":dict(engine.trace["seconds"]),
                "unattributed_host_seconds":elapsed-sum(engine.trace["seconds"].values()),
                "float32_sha256":sha256(audio.tobytes()).hexdigest(),"pcm16_sha256":sha256(pcm.tobytes()).hexdigest(),
                "latent_sha256":list(engine.trace["latent_sha256"]),"samples":len(audio),
                "voice_prefill_skipped":engine.trace["voice_prefill_skipped"],
                "last_facts":engine.last_facts,"cache":engine.prefills.facts()}
        if len(result["latent_sha256"])!=engine.last_facts["latent_frames"]:raise ValueError("Unobserved latent frame")
        return audio,result

    def same(baseline,current):
        if any(baseline[key]!=current[key] for key in ("float32_sha256","pcm16_sha256","latent_sha256","samples","last_facts")):
            raise ValueError("Voice-prefill optimization changed original waveform, latent, RNG or EOS facts")

    # Full native golden text is kept unchanged; both cache misses and hits must
    # reproduce the ORIGINAL implementation using the SAME sessions and seed.
    for number,row in enumerate(rows):
        _,baseline=render(row,False)
        _,first=render(row,True);same(baseline,first)
        audio,warm=render(row,True);same(baseline,warm)
        if not warm["voice_prefill_skipped"]:raise ValueError("No proven voice-prefill cache hit")
        path=audio_dir/(row["language"]+"-golden-"+str(number)+".wav")
        carrier_module.write_pcm16_wav(path,audio,RATE)
        item=dict(row,baseline=baseline,experimental_first=first,experimental_hit=warm,
                  full_float_pcm_and_latents_bit_identical=True,wav_sha256=common.digest(path),
                  audio_seconds=len(audio)/RATE)
        report["cases"].append(item);common.write_json(args.report,report)
        print(json.dumps({"language":row["language"],"case":number,"baseline":baseline["wall_seconds"],
                          "cached":warm["wall_seconds"],"bit_identical":True}),flush=True)
    # Isolated native words are observed separately; no instantaneous or physical
    # keyboard/audio claim follows from completed-wave timings.
    for code in LANGUAGES:
        row=inputs.first_word(next(row for row in rows if row["language"]==code))
        _,baseline=render(row,False);_,first=render(row,True);same(baseline,first)
        _,warm=render(row,True);same(baseline,warm)
        report["word_benchmarks"].append(dict(row,baseline=baseline,experimental_first=first,experimental_hit=warm,
                                             full_float_pcm_and_latents_bit_identical=True))
        common.write_json(args.report,report)
    # Five native references exceed explicit3-entry cap. Revisit EACH after
    # cycling the others; compare to its unmodified baseline again.
    evictions_before=len(engine.prefills.evictions)
    for code in LANGUAGES:
        row=next(row for row in rows if row["language"]==code)
        _,baseline=render(row,False);_,cached=render(row,True);same(baseline,cached)
        report["post_eviction_replays"].append({"language":code,"bit_identical":True,"cache":cached["cache"]})
    if len(engine.prefills.evictions)<=evictions_before:raise ValueError("No actual eviction was exercised")
    if any(common.digest(path)!=before[role] for role,path in engine.paths.items()):raise ValueError("Graph inputs changed")
    verified_inputs(root)
    report.update(status="actual-five-native-lossless-prefill-experiment-unintegrated",
                  all_fifteen_golden_cases_bit_identical=len(report["cases"])==15,
                  all_five_native_word_cases_bit_identical=len(report["word_benchmarks"])==5,
                  all_five_post_eviction_replays_bit_identical=len(report["post_eviction_replays"])==5,
                  cached_array_budget_respected=engine.prefills.peak_bytes<=MAX_BUDGET,
                  cache=engine.prefills.facts(),all_original_input_bytes_unchanged=True,
                  windows_verified=True,ort_version=engine.ort.__version__,python_version=sys.version,
                  process_peak_rss_bytes=carrier_module.peak_rss(),
                  cautions=inputs.CAUTIONS,
                  timing_scope="Completed native CPU waves; instrumentation overhead retained; not first packet/NVDA/physical audio")
    common.write_json(args.report,report);return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase",choices=("acquire","probe"))
    parser.add_argument("--assets",type=Path,required=True);parser.add_argument("--report",type=Path,required=True)
    for name in ("graphs","g2p-source","network-policy","packaged-runtime"):parser.add_argument("--"+name,type=Path)
    parser.add_argument("--overwrite",action="store_true");args=parser.parse_args()
    if args.report.exists() or args.report.is_symlink():parser.error("Fresh immutable report required")
    if args.phase=="probe" and any(getattr(args,name) is None for name in ("graphs","g2p_source","network_policy","packaged_runtime")):
        parser.error("Exact private runtime, native inputs, graphs and network denial required")
    try:return (acquire(args) if args.phase=="acquire" else probe(args)) and 0
    except Exception as error:
        previous=json.loads(args.report.read_text(encoding="utf-8")) if args.report.is_file() else {}
        previous.update(status="failed",error_type=type(error).__name__,error=str(error),product_integrated=False)
        common.write_json(args.report,previous);raise

if __name__=="__main__":raise SystemExit(main())
