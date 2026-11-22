"""Isolated causal native decoder interleaving; no product integration.

The original full-wave six-layer loop is the reference. Each experimental request
uses identical graphs, float32, token IDs, seeded noise, AR/EOS policy and fresh
decoder state, but runs the causal decoder before all AR latents exist. PCM is
compared after assembly, with explicit boundary error diagnostics. This does not
prove streaming of the downstream selected-voice converter or physical playback.
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
from threading import Event

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("stream_prefill_proof",HERE/"afri_native_prefill_probe.py")
prefill=importlib.util.module_from_spec(spec);spec.loader.exec_module(prefill)
carrier_module,pins,common,inputs=prefill.carrier_module,prefill.pins,prefill.common,prefill.inputs
RATE=carrier_module.RATE
LOOP_SOURCE=carrier_module.LOOP_SOURCE
LANGUAGES=prefill.LANGUAGES
CHUNKS=(1,3,5,15)
FORMAT="dordiai-afri-native-causal-stream-proof-v1"
# These are numerical comparison gates, not human perceptual quality approval.
FLOAT_ERROR_LIMIT=1e-5
PCM_LSB_LIMIT=1
STREAM_SOURCES={
 "exporter":{"revision":"b4508ae979dd34eea2597d420d67176ef55a21a0","path":"export/onnx/export_onnx.py","blob":"17017c14a7ebd7c26341b7f9f4bb13dfc6fbc4fa",
             "contract":"Explicit recurrent decoder states; dynamic num_latents; output T*1920 samples"},
 "pocket_streaming":{"revision":"a922b912dfa366975294afb568d815b305acde5d","path":"pocket_tts/models/tts_model.py",
                     "contract":"Fresh per-request Mimi state; first frame yields without waiting; configurable causal frame groups"},
 "original_sherpa":LOOP_SOURCE,
 "baseline_difference_preserved":"Original ORT baseline has no initial fade; no upstream fade is introduced"
}

class NativeStreamCancelled(RuntimeError):
    pass

def check_cancel(cancelled):
    if cancelled():
        raise NativeStreamCancelled("Isolated native stream cancelled")

class CancelSession:
    """Check cooperatively before/after each actual synchronous graph invocation."""
    def __init__(self,session,owner):
        self.session,self.owner=session,owner
    def __getattr__(self,name):
        return getattr(self.session,name)
    def run(self,*args,**kwargs):
        check_cancel(self.owner.cancelled)
        self.owner.actual_graph_calls+=1
        result=self.session.run(*args,**kwargs)
        check_cancel(self.owner.cancelled)
        return result

class StreamingCarrier(prefill.CachedCarrier):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.cancelled=lambda:False
        self.actual_graph_calls=0
        self.active_stream=False
        self.sessions={role:CancelSession(session,self) for role,session in self.sessions.items()}

    def stream(self, ipa, reference, reference_rate, *, chunk_frames=1, cancelled=None,
               temperature=0.3, seed=42, max_frames=500):
        if chunk_frames not in (1, 3, 5, 15):
            raise ValueError("Only predeclared streaming boundaries are allowed")
        if getattr(self, "active_stream", False):
            raise RuntimeError("This isolated carrier serializes requests")
        self.active_stream = True
        self.cancelled = cancelled or (lambda: False)
        self.last_facts = None
        facts = {"closed": False, "generation_complete": False, "yield_count": 0,
                 "frames_at_yield": 0, "chunk_frames": chunk_frames}
        self.stream_facts = facts
        state, decoder_state, pending, latents = {}, {}, [], []
        try:
            check_cancel(self.cancelled)
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
            pending = []
            decoder_state = self.zero_state("decoder", 1)
    
            def decode(frames):
                check_cancel(self.cancelled)
                shaped = np.asarray(frames, np.float32)[None]
                outputs = self.sessions["decoder"].run(None, {"latent": shaped, **decoder_state})
                if len(outputs) != len(decoder_state) + 1:
                    raise ValueError("Unexpected decoder state contract")
                for name, value in zip(list(decoder_state), outputs[1:]):
                    decoder_state[name] = value
                audio = outputs[0].reshape(-1).astype(np.float32)
                if not np.isfinite(audio).all() or len(audio) != len(frames) * 1920:
                    raise ValueError("Causal decoder output length or precision differs")
                return audio
            for step in range(max_frames):
                check_cancel(self.cancelled)
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
                pending.append(latent[0])
                if len(pending) >= chunk_frames:
                    audio = decode(pending)
                    pending.clear()
                    facts["frames_at_yield"] = len(latents)
                    facts["yield_count"] += 1
                    check_cancel(self.cancelled)
                    yield audio
                    check_cancel(self.cancelled)
            if not latents:
                raise ValueError("No generated frames")
    
            state.clear()
            facts["generation_complete"] = True
            if pending:
                audio = decode(pending)
                pending.clear()
                facts["frames_at_yield"] = len(latents)
                facts["yield_count"] += 1
                check_cancel(self.cancelled)
                yield audio
                check_cancel(self.cancelled)
            self.last_facts = {"token_ids": ids, "latent_frames": len(latents), "eos_step": eos_step,
                               "eos_last": eos_last, "generation_cap_reached": reached_cap,
                               "seed": seed, "temperature": temperature, "frame_limit": max_frames,
                               "source_loop": LOOP_SOURCE, "random_sequence_note":
                               "NumPy generator differs from C++ RNG; deterministic per our fixed seed, not sample-identical to Sherpa."}
    
        finally:
            state.clear()
            decoder_state.clear()
            pending.clear()
            latents.clear()
            facts.update(closed=True, lm_arrays_remaining=0, decoder_arrays_remaining=0, pending_frames=0)
            self.active_stream = False
            self.cancelled = lambda: False


def fresh_trace():
    return {"seconds":{},"latent_sha256":[],"lm_calls":0,"voice_prefill_skipped":False}

def pcm16(np,audio):
    return (np.clip(audio,-1.,1.-1./32768.)*32768.).astype("<i2")

def audio_facts(engine,audio,elapsed):
    np=engine.np
    if engine.last_facts is None or engine.last_facts["generation_cap_reached"]:
        raise ValueError("No complete native utterance; cap or unfinished generator")
    pcm=pcm16(np,audio)
    if len(engine.trace["latent_sha256"])!=engine.last_facts["latent_frames"]:
        raise ValueError("Unobserved native latent")
    return {"wall_seconds":elapsed,"stage_seconds":dict(engine.trace["seconds"]),
            "float32_sha256":sha256(audio.tobytes()).hexdigest(),
            "pcm16_sha256":sha256(pcm.tobytes()).hexdigest(),"samples":len(audio),
            "latent_sha256":list(engine.trace["latent_sha256"]),"last_facts":dict(engine.last_facts),
            "voice_prefill_skipped":engine.trace["voice_prefill_skipped"]}

def render_full(engine,row,refs,g2p,*,cached=False):
    code=row["language"];ipa=inputs.check_ipa(row,g2p);wave,rate,_=refs[code]
    engine.native_code=code;engine.trace=fresh_trace();engine.cancelled=lambda:False
    start=perf_counter()
    audio=(engine.audio(ipa,wave,rate) if cached else
           carrier_module.SixLayerOrtCarrier.audio(engine,ipa,wave,rate))
    return audio,audio_facts(engine,audio,perf_counter()-start)

def render_stream(engine,row,refs,g2p,chunk_frames):
    code=row["language"];ipa=inputs.check_ipa(row,g2p);wave,rate,_=refs[code]
    engine.native_code=code;engine.trace=fresh_trace()
    np=engine.np;pieces=[];boundaries=[];samples=0
    start=perf_counter();first=None;nonzero=None;above32=None;first_facts=None
    generator=engine.stream(ipa,wave,rate,chunk_frames=chunk_frames)
    try:
        for piece in generator:
            arrived=perf_counter()-start
            if first is None:
                first=arrived
                first_facts=dict(engine.stream_facts)
                first_facts["stage_seconds"]=dict(engine.trace["seconds"])
                first_facts["latent_hash_count"]=len(engine.trace["latent_sha256"])
            pcm=pcm16(np,piece)
            if nonzero is None and np.any(pcm!=0):nonzero=arrived
            if above32 is None and np.any(np.abs(pcm.astype(np.int32))>32):above32=arrived
            if samples:boundaries.append(samples)
            pieces.append(piece);samples+=len(piece)
    finally:
        generator.close()
    elapsed=perf_counter()-start
    if not pieces or nonzero is None:raise ValueError("No actual nonzero native PCM")
    audio=np.concatenate(pieces)
    result=audio_facts(engine,audio,elapsed)
    result.update(chunk_frames=chunk_frames,chunk_count=len(pieces),
                  first_chunk_seconds=first,first_nonzero_pcm_seconds=nonzero,
                  first_above_32_lsb_seconds=above32,first_yield=first_facts,
                  decoder_boundaries=boundaries,final_stream_facts=dict(engine.stream_facts),
                  first_yield_before_ar_completion=first_facts["generation_complete"] is False,
                  timing_scope="Native graph-produced PCM availability; no physical audio or downstream converter")
    if not engine.stream_facts["closed"] or engine.active_stream:
        raise ValueError("Completed stream retained recurrent state")
    return audio,result

def compare(np,baseline,current,expected,actual):
    # Tokenization, AR states, seeded draws, EOS decision, every latent and total
    # sample length must stay EXACT, regardless of decoder matrix partitioning.
    for key in ("latent_sha256","samples","last_facts"):
        if expected[key]!=actual[key]:
            raise ValueError("Causal interleaving changed original AR/EOS/RNG/sample contract: "+key)
    delta=np.abs(baseline.astype(np.float64)-current.astype(np.float64))
    difference=np.abs(pcm16(np,baseline).astype(np.int32)-pcm16(np,current).astype(np.int32))
    error=float(delta.max()) if len(delta) else 0.
    lsb=int(difference.max()) if len(difference) else 0
    mask=np.zeros(len(baseline),dtype=bool)
    for boundary in actual.get("decoder_boundaries",[]):
        mask[max(0,boundary-240):min(len(mask),boundary+240)]=True
    signal=float(np.sum(baseline.astype(np.float64)**2))
    noise=float(np.sum((baseline.astype(np.float64)-current.astype(np.float64))**2))
    snr=None if noise==0 else float(10*np.log10(max(signal,1e-300)/noise))
    same_float=expected["float32_sha256"]==actual["float32_sha256"]
    same_pcm=expected["pcm16_sha256"]==actual["pcm16_sha256"]
    return {"all_latents_and_eos_bit_identical":True,"float32_bit_identical":same_float,
            "pcm16_bit_identical":same_pcm,"max_absolute_float_error":error,"max_pcm16_lsb_error":lsb,
            "changed_float_samples":int(np.count_nonzero(delta)),
            "changed_pcm16_samples":int(np.count_nonzero(difference)),
            "snr_db":snr,"snr_infinite":noise==0,
            "boundary_window_samples_each_side":240,"boundary_count":len(actual.get("decoder_boundaries",[])),
            "boundary_max_absolute_float_error":float(delta[mask].max()) if np.any(mask) else 0.,
            "boundary_max_pcm16_lsb_error":int(difference[mask].max()) if np.any(mask) else 0,
            "nonboundary_max_absolute_float_error":float(delta[~mask].max()) if np.any(~mask) else 0.,
            "numerical_gate":{"float_error_max":FLOAT_ERROR_LIMIT,"pcm_lsb_max":PCM_LSB_LIMIT},
            "within_preregistered_numerical_gate":error<=FLOAT_ERROR_LIMIT and lsb<=PCM_LSB_LIMIT,
            "human_quality_verified":False}

def cancellation_proof(engine,row,refs,g2p,baseline,baseline_facts):
    np=engine.np;code=row["language"];ipa=inputs.check_ipa(row,g2p);wave,rate,_=refs[code]
    engine.native_code=code;engine.trace=fresh_trace()
    event=Event();generator=engine.stream(ipa,wave,rate,chunk_frames=1,cancelled=event.is_set)
    first=next(generator)
    if not len(first) or not np.isfinite(first).all():raise ValueError("No actual first native chunk")
    before=engine.actual_graph_calls;event.set();start=perf_counter()
    try:
        next(generator)
    except NativeStreamCancelled:
        pass
    else:
        raise ValueError("Cancellation did not stop before the next graph")
    finally:
        generator.close()
    cancelled_seconds=perf_counter()-start
    if engine.actual_graph_calls!=before or engine.active_stream or not engine.stream_facts["closed"]:
        raise ValueError("Cancelled stream ran another graph or retained recurrent state")
    cancelled_facts=dict(engine.stream_facts)
    # Abandon an independent request through the public generator.close path.
    engine.trace=fresh_trace()
    abandoned=engine.stream(ipa,wave,rate,chunk_frames=1)
    next(abandoned);abandoned.close()
    if engine.active_stream or not engine.stream_facts["closed"]:raise ValueError("Abandoned stream leaked state")
    # A pre-cancelled request must not enter ORT at all.
    engine.trace=fresh_trace();before=engine.actual_graph_calls
    preset=engine.stream(ipa,wave,rate,chunk_frames=1,cancelled=lambda:True)
    try:
        next(preset)
    except NativeStreamCancelled:
        pass
    else:raise ValueError("Pre-cancelled request reached a native output")
    finally:preset.close()
    if engine.actual_graph_calls!=before:raise ValueError("Pre-cancelled request invoked ORT")
    replay,replayed=render_stream(engine,row,refs,g2p,1)
    parity=compare(np,baseline,replay,baseline_facts,replayed)
    if not parity["within_preregistered_numerical_gate"]:
        raise ValueError("Fresh replay after cancellation changed native output")
    return {"language":code,"cancel_after_actual_chunk":True,"cancel_check_seconds":cancelled_seconds,
            "no_subsequent_graph_calls":True,"closed_state":cancelled_facts,
            "explicit_generator_close_released_state":True,"pre_cancel_invoked_no_graphs":True,
            "fresh_request_replay":parity,"in_flight_ort_interruption_verified":False,
            "scope":"Cooperative checks around synchronous graph calls; no physical output cancellation claim"}

def acquire(args):
    return prefill.acquire(args)

def probe(args):
    root=args.assets.resolve();index=prefill.verified_inputs(root)
    pins.git_head(args.g2p_source.resolve(),pins.G2P_REVISION)
    report={"format":FORMAT,"status":"running","product_integrated":False,
            "native_pronunciation_verified":False,"nvda_verified":False,"physical_audio_verified":False,
            "selected_voice_projection_verified":False,"downstream_converter_streaming_verified":False,
            "languages":LANGUAGES,"chunk_frame_policies":CHUNKS,"cases":[],"word_benchmarks":[],
            "cold_reference_first_use":[],"cancel_and_reset":[],"source_contracts":STREAM_SOURCES,
            "numerical_comparison_gate":{"float_error_max":FLOAT_ERROR_LIMIT,"pcm_lsb_max":PCM_LSB_LIMIT},
            "source_inputs":index,"autoregressive_loop_unchanged":True,"decoder_host_schedule_modified":True}
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
    boot_spec=importlib.util.spec_from_file_location("stream_private_bootstrap",runtime/"windows_runtime.py")
    bootstrap=importlib.util.module_from_spec(boot_spec);boot_spec.loader.exec_module(bootstrap)
    report["private_bootstrap"]=bootstrap.reset_inherited_dll_directory()
    sys.path.insert(0,str(args.g2p_source.resolve()/"src"))
    import numpy as np
    from africa_g2p import g2p
    start=perf_counter()
    engine=StreamingCarrier(args.graphs,root/"tokenizer.json",expected_ort_version="1.26.0",package_python=package_python)
    report["model_load_seconds"]=perf_counter()-start
    report["graph_artifact"]=carrier_module.GRAPH_ARTIFACT
    report["graph_provenance"]=engine.provenance
    report["baseline_audio_source_file_sha256"]=common.digest(Path(carrier_module.__file__))
    report["prefill_source_file_sha256"]=common.digest(Path(prefill.__file__))
    report["runtime_imports"]={name:{"file":str(getattr(sys.modules[name],"__file__","")),
                                   "version":str(getattr(sys.modules[name],"__version__","unreported"))}
                              for name in ("numpy","onnxruntime","tokenizers")}
    if any(not Path(value["file"]).resolve().is_relative_to(package_python) for value in report["runtime_imports"].values()):
        raise ValueError("Dependencies escaped actual private package")
    before={role:common.digest(path) for role,path in engine.paths.items()}
    rows=prefill.fixtures((root/"parity_set.tsv").read_text(encoding="utf-8"))
    refs={code:carrier_module.read_reference_wav(root/index["files"]["voice_"+code]["relative"]) for code in LANGUAGES}
    if any(rate!=RATE for _,rate,_ in refs.values()):raise ValueError("No resampling or neighbouring reference")
    audio_dir=args.report.resolve().parent/(args.report.stem+"-audio")
    audio_dir.mkdir(parents=False,exist_ok=False)
    all_numeric=True;all_exact=True;all_early=True

    def case(row,number,word=False):
        nonlocal all_numeric,all_exact,all_early
        baseline,expected=render_full(engine,row,refs,g2p)
        warm,warmed=render_full(engine,row,refs,g2p,cached=True)
        if any(expected[key]!=warmed[key] for key in ("float32_sha256","pcm16_sha256","latent_sha256","samples","last_facts")):
            raise ValueError("Previously proven unchanged cached baseline differed")
        item=dict(row,original_full_wave=expected,cached_full_wave=warmed,streamed=[])
        for chunk in CHUNKS:
            audio,result=render_stream(engine,row,refs,g2p,chunk)
            parity=compare(np,baseline,audio,expected,result)
            if chunk==15 and not (parity["float32_bit_identical"] and parity["pcm16_bit_identical"]):
                raise ValueError("Identical decoder chunk15 interleaving changed original waveform")
            all_numeric=all_numeric and parity["within_preregistered_numerical_gate"]
            all_exact=all_exact and parity["float32_bit_identical"] and parity["pcm16_bit_identical"]
            if chunk==1:all_early=all_early and result["first_yield_before_ar_completion"]
            result["parity"]=parity
            if word and chunk==1:
                path=audio_dir/(row["language"]+"-native-word-chunk1.wav")
                carrier_module.write_pcm16_wav(path,audio,RATE)
                result["wav_sha256"]=common.digest(path)
            item["streamed"].append(result)
        if word:
            item["cancel_and_reset"]=cancellation_proof(engine,row,refs,g2p,baseline,expected)
            report["cancel_and_reset"].append(item["cancel_and_reset"])
        print(json.dumps({"language":row["language"],"case":number,"word":word,
                          "baseline_full":expected["wall_seconds"],"cached_full":warmed["wall_seconds"],
                          "chunk1_first_native_pcm":item["streamed"][0]["first_nonzero_pcm_seconds"],
                          "chunk1_total":item["streamed"][0]["wall_seconds"],
                          "chunk1_max_lsb_error":item["streamed"][0]["parity"]["max_pcm16_lsb_error"]}),flush=True)
        return item

    for number,row in enumerate(rows):
        report["cases"].append(case(row,number));common.write_json(args.report,report)
    for number,code in enumerate(LANGUAGES):
        row=inputs.first_word(next(row for row in rows if row["language"]==code))
        report["word_benchmarks"].append(case(row,number,True));common.write_json(args.report,report)
        # Include actual cache-miss first-use cost separately from warm statistics.
        engine.prefills=prefill.VoicePrefills();engine.voice_cache.clear()
        audio,cold=render_stream(engine,row,refs,g2p,1)
        report["cold_reference_first_use"].append(dict(language=code,result=cold))
        common.write_json(args.report,report)
    if any(common.digest(path)!=before[role] for role,path in engine.paths.items()):raise ValueError("Graph inputs changed")
    prefill.verified_inputs(root)
    report.update(status="actual-five-native-causal-stream-experiment-unintegrated",
                  all_eighty_streamed_cases_within_numerical_gate=all_numeric,
                  all_eighty_streamed_cases_float_and_pcm_bit_identical=all_exact,
                  all_chunk1_first_yields_before_ar_completion=all_early,
                  all_five_cancel_close_and_fresh_request_replays_passed=len(report["cancel_and_reset"])==5,
                  decoder_same_sample_count_and_no_inserted_silence=True,
                  cache=engine.prefills.facts(),all_original_input_bytes_unchanged=True,
                  windows_verified=True,ort_version=engine.ort.__version__,python_version=sys.version,
                  process_peak_rss_bytes=carrier_module.peak_rss(),
                  cautions=[value for value in inputs.CAUTIONS if not value.startswith("Native carrier timings")]+["Numerical parity is reported separately from bit identity.",
                    "Native chunk availability does not prove selected-voice conversion streaming, NVDA delivery or physical playback.",
                    "Synchronous graph calls are not interrupted mid-run; cancellation is checked before and after each call.",
                    "Full latents remain retained only for this bounded research parity instrumentation."],
                  timing_scope="Actual first graph-produced native PCM and completed waves, instrumented on unchanged private CPU runtime")
    common.write_json(args.report,report)
    if not all_numeric or not all_early:raise ValueError("Streaming numerical or causal-availability gate failed; diagnostic proof retained")
    return report

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
