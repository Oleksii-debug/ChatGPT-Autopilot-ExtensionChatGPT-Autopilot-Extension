"""Windows-only isolated Tongan phonemic contrast/projection proof.

Reuses immutable core10 private runtime/OpenVoice/Viktoriia and its actual wide
eSpeak engine/data. No voice registration, neighbouring-language text fallback,
native-Tongan-NN claim, package installation or physical playback occurs.
"""
from __future__ import annotations
import argparse
import ctypes as C
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import sys
from time import perf_counter
import unicodedata
import wave

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("tongan_strict_candidate",HERE/"tongan_frontend.py")
t=importlib.util.module_from_spec(spec);sys.modules[spec.name]=t;spec.loader.exec_module(t)
FORMAT="dordiai-tongan-strict-phonemic-contrast-v1"
FLOW_SHA="831fe762c0b47137e20753b9023b3901fc229bbc05bd6644ddce7073d7015404"
DECODER_SHA="9d57879aff5d3d50ae810b4e4791170b3fd1d27004be71fc2ae3f90afd588d36"
TARGET_SHA="e880e4ff3c582760073493c9651983a46dfab5a48d1b4ea1e773ef7f31a66f9a"
ENCODER_SHA="3dd4918cab90e1acf7fa5c6f7539c27710e7a3cdfba550468c5ea49399178bf7"
CALIBRATION="Mālō. ʻUma. Tangata. Mālō."
CONVERTER_SAMPLE_RATE=22050

class EventId(C.Union):
    _fields_=[("number",C.c_int),("name",C.c_char_p),("string",C.c_char*8)]
class Event(C.Structure):
    _fields_=[("type",C.c_int),("unique",C.c_uint),("text_position",C.c_int),("length",C.c_int),
              ("audio_position",C.c_int),("sample",C.c_int),("user_data",C.c_void_p),("id",EventId)]

def digest(path):
    h=sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda:source.read(1024*1024),b""):h.update(block)
    return h.hexdigest()

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);sys.modules[name]=value;spec.loader.exec_module(value)
    return value

def save_json(path,doc):
    temporary=path.with_suffix(path.suffix+".writing")
    if temporary.exists() or temporary.is_symlink():raise FileExistsError("Unexpected report temporary")
    with temporary.open("x",encoding="utf-8") as output:
        json.dump(doc,output,ensure_ascii=False,indent=2);output.write("\n")
    os.replace(temporary,path)

def write_wave(path,audio,rate,np):
    pcm=(np.clip(audio,-1.,1.-1./32768.)*32768.).astype("<i2")
    with path.open("xb") as output:
        with wave.open(output,"wb") as stream:
            stream.setnchannels(1);stream.setsampwidth(2);stream.setframerate(rate)
            stream.writeframes(pcm.tobytes())

def write_converted_wave(path,audio,np):
    # The unchanged OpenVoice decoder produces22050Hz. Save those exact samples
    # at their true rate; relabelling them24000 would change speed and pitch.
    write_wave(path,audio,CONVERTER_SAMPLE_RATE,np)
    return {"decoder_output_sample_rate":CONVERTER_SAMPLE_RATE,
            "projected_wav_sample_rate":CONVERTER_SAMPLE_RATE,
            "projected_audio_seconds":len(audio)/CONVERTER_SAMPLE_RATE,
            "projection_resampled":False}

def read_wave(path,np):
    with wave.open(str(path),"rb") as source:
        if source.getnchannels()!=1 or source.getsampwidth()!=2:raise ValueError("Expected own monoPCM16")
        return np.frombuffer(source.readframes(source.getnframes()),dtype="<i2").astype(np.float32)/32768.,source.getframerate()

def vowel_events(events):
    output=[]
    for row in events:
        label=unicodedata.normalize("NFD",row["ipa"]).lstrip("ˈˌ")
        if label and label[0] in t.VOWELS:output.append(row)
    return output

class Carrier:
    CALLBACK=C.CFUNCTYPE(C.c_int,C.POINTER(C.c_int16),C.c_int,C.POINTER(Event))
    def __init__(self,folder,np):
        self.np=np;self.packets=[];self.events=[];self.errors=[];self.closed=False
        if C.sizeof(Event)!=40:raise RuntimeError("Expected original64bit eSpeak eventABI")
        from legacy_data_path import prepare_legacy_data_path
        self.location=prepare_legacy_data_path(folder)
        self.lib=C.CDLL(str(folder/"espeak.dll"))
        signatures={
          "espeak_Initialize":([C.c_int,C.c_int,C.c_char_p,C.c_int],C.c_int),
          "espeak_SetSynthCallback":([self.CALLBACK],None),
          "espeak_SetVoiceByName":([C.c_char_p],C.c_int),
          "espeak_SetParameter":([C.c_int,C.c_int,C.c_int],C.c_int),
          "espeak_Synth":([C.c_char_p,C.c_size_t,C.c_uint,C.c_int,C.c_uint,C.c_uint,C.c_void_p,C.c_void_p],C.c_int),
          "espeak_Terminate":([],C.c_int)}
        for name,(args,result) in signatures.items():
            function=getattr(self.lib,name);function.argtypes=args;function.restype=result
        # RETRIEVAL_SYNCHRONOUS=2, original DONT_EXIT plus documented
        # PHONEME_EVENTS1 and PHONEME_IPA2. Observation does not alter text/PCM.
        self.rate=self.lib.espeak_Initialize(2,35,self.location.encoded,0x8000|1|2)
        if self.rate<=0:
            self.lib.espeak_Terminate();self.closed=True
            raise RuntimeError("Actual bundled eSpeak initialization failed")
        try:
            self.location.verify()
            self.callback=self.CALLBACK(self.capture)
            self.lib.espeak_SetSynthCallback(self.callback)
            if self.lib.espeak_SetVoiceByName(b"es"):
                raise RuntimeError("Original disclosed five-vowel acoustic table is missing")
            if self.lib.espeak_SetParameter(1,182,0):raise RuntimeError("Carrier rate setup failed")
        except Exception:
            self.close();raise

    def capture(self,pointer,length,events):
        try:
            if pointer and length>0:self.packets.append(C.string_at(pointer,2*length))
            if events:
                for index in range(4096):
                    event=events[index]
                    if event.type==0:break
                    if event.type==7:
                        self.events.append({"ipa":bytes(event.id.string).decode("utf-8"),
                            "audio_position_ms":int(event.audio_position),"sample":int(event.sample)})
                else:raise ValueError("Unterminated eSpeak event list")
            return 0
        except Exception as error:
            self.errors.append(type(error).__name__+": "+str(error));return 1

    def audio(self,text,*,research_hypothesis=False):
        # This call always validates the entire native string before any C API.
        # Explicit research opt-in cannot bypass unknown letters or punctuation.
        phonemes=t.encoded(text,allow_ambiguous_phonology=research_hypothesis)
        raw=phonemes.encode("ascii")
        self.packets.clear();self.events.clear();self.errors.clear()
        started=perf_counter()
        status=self.lib.espeak_Synth(raw,len(raw)+1,0,1,0,1|0x100,None,None)
        elapsed=perf_counter()-started
        if status or self.errors:raise RuntimeError("Phonemic render failed: "+repr(self.errors))
        audio=self.np.frombuffer(b"".join(self.packets),dtype="<i2").astype(self.np.float32)/32768.
        if len(audio)<512 or not self.np.isfinite(audio).all() or not self.np.any(audio):
            raise ValueError("Actual carrier returned no finite nonzero PCM")
        return audio,{"encoded":phonemes,"seconds":elapsed,"samples":len(audio),
                      "audio_seconds":len(audio)/self.rate,"phoneme_events":list(self.events),
                      "vowel_event_count":len(vowel_events(self.events)),
                      "research_hypothesis_requested":research_hypothesis}

    def close(self):
        if not self.closed:
            self.lib.espeak_Terminate();self.closed=True

def check_network_policy(path):
    policy=json.loads(path.read_text(encoding="utf-8-sig"))
    needed={str(Path(value).resolve()).casefold() for value in (sys.executable,getattr(sys,"_base_executable",None) or sys.executable)}
    if (policy.get("action")!="Block" or policy.get("direction")!="Outbound" or policy.get("enabled") is not True
            or policy.get("all_firewall_profiles_enabled") is not True
            or not needed.issubset({str(Path(value).resolve()).casefold() for value in policy.get("programs",[])})):
        raise ValueError("No actual scoped firewall denial for unchanged private process")
    return policy

def run(args):
    runtime=args.packaged_runtime.resolve();python=runtime/"python"
    if sys.platform!="win32" or not sys.version.startswith("3.14.") or not os.path.samefile(sys.executable,python/"python.exe"):
        raise ValueError("Original Windows private Python3.14 required")
    if args.output.exists() or args.output.is_symlink():raise FileExistsError("Fresh immutable research output required")
    args.output.mkdir(parents=True)
    report_path=args.output/"proof.json"
    report={"format":FORMAT,"status":"running","registered":False,"product_integrated":False,
            "native_tongan_nn_weights":False,"native_phonetic_fidelity_verified":False,
            "native_listener_verified":False,"windows_nvda_verified":False,"physical_audio_verified":False,
            "carrier":"Original eSpeak Spanish five-vowel acoustic primitives, explicit Tongan phonemes only; no Spanish word pronunciation",
            "cases":[],"structural_contrasts":[],"old_inventory_rows":27,
            "limits":["Shared acoustic table remains experimental, not a native Tongan voice.",
              "Finite nonzero projection is technical execution, not native pronunciation approval.",
              "Unmarked heterovowel grouping, connected one-mora stress domains and acute-on-already-long are rejected by default.",
              "Explicit research hypotheses are separated from strictly renderable native input.",
              "Documented long/double orthography is represented distinctly; native perceptual realization still requires validation."]}
    save_json(report_path,report)
    carrier=None
    try:
        report["network_policy"]=check_network_policy(args.network_policy)
        def deny(event,values):
            if event in ("socket.connect","socket.connect_ex","socket.bind","socket.getaddrinfo"):
                raise RuntimeError("Native inference network is forbidden")
        sys.addaudithook(deny)
        bootstrap=module("tongan_private_bootstrap",runtime/"windows_runtime.py")
        report["dll_bootstrap"]=bootstrap.reset_inherited_dll_directory()
        sys.path.insert(0,str(runtime))
        import numpy as np
        import onnxruntime as ort
        ort.disable_telemetry_events()
        if ort.__version__!="1.26.0":raise RuntimeError("Expected unchanged packaged ORT1.26")
        import converted_voices
        from voice_delivery import speech_level,peak_limit
        if not Path(converted_voices.__file__).resolve().is_relative_to(runtime):
            raise RuntimeError("Spectrogram/resampling escaped original private core")
        report["runtime"]={"python":sys.version,"onnxruntime":ort.__version__,"dependencies":{}}
        for name in ("numpy","onnxruntime"):
            path=Path(sys.modules[name].__file__).resolve()
            if not path.is_relative_to(python):raise RuntimeError("Scientific module escaped private core")
            report["runtime"]["dependencies"][name]=str(path)
        models=runtime/"models"
        paths={"flow":models/"OpenVoiceV2/encoder-flow.onnx","decoder":models/"OpenVoiceV2/decoder.onnx",
               "target":models/"voices/classmate_locales/viktoriia.npy","encoder":args.reference_encoder.resolve(),
               "espeak":args.espeak.resolve()/"espeak.dll"}
        for key,expected in (("flow",FLOW_SHA),("decoder",DECODER_SHA),("target",TARGET_SHA),("encoder",ENCODER_SHA)):
            if digest(paths[key])!=expected:raise ValueError("Original model/identity hash differs: "+key)
        before={key:digest(path) for key,path in paths.items()}
        report["input_hashes"]=before
        options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
        options.add_session_config_entry("session.intra_op.allow_spinning","0")
        def session(path):return ort.InferenceSession(str(path),sess_options=options,providers=["CPUExecutionProvider"])
        encoder,flow,decoder=[session(paths[key]) for key in ("encoder","flow","decoder")]
        target=np.load(paths["target"],allow_pickle=False)
        if target.shape!=(1,256,1) or not np.isfinite(target).all():raise ValueError("Original target profile invalid")
        carrier=Carrier(args.espeak.resolve(),np)
        calibration,calibration_facts=carrier.audio(CALIBRATION)
        calibration_path=args.output/"calibration.wav";write_wave(calibration_path,calibration,carrier.rate,np)
        recorded,recorded_rate=read_wave(calibration_path,np)
        spectrum=converted_voices.spectrogram(converted_voices.resample(recorded,recorded_rate,22050))[None]
        source=np.asarray(encoder.run(None,{"spec":spectrum})[0],np.float32).reshape(1,256,1)
        if not np.isfinite(source).all() or float(np.linalg.norm(source))<=1e-7:raise ValueError("No actual same-carrier source identity")
        np.save(args.output/"source.npy",source,allow_pickle=False)
        report["same_carrier_calibration"]={"text":CALIBRATION,"native_character_strict":True,
            "facts":calibration_facts,"wav_sha256":digest(calibration_path),"source_sha256":digest(args.output/"source.npy"),
            "source_norm":float(np.linalg.norm(source)),"source_shape":list(source.shape),
            "reused_neighbouring_source":False,"unit_normalized":False}
        names_path=HERE/"tongan_letter_names.json"
        names=json.loads(names_path.read_text(encoding="utf-8"))["letter_names"]
        base=[("ordinary-text",None,text) for text in
            ("uma","ʻuma","kaka","kakā","kākā","tangata","tangatá","koté","Mālō e lelei.","Kuo´ u fiu, mālō.")]
        base.extend(("ordinary-letter-name",glyph,text) for glyph,text in names.items())
        if len(base)!=27:raise ValueError("Original27case semantic inventory changed")
        cases=base+[("source-vocabulary-contrast",None,text) for text in ("mama","māmā","maama")]
        cases.extend(("structural-phonological-unit",None,text) for pair in zip("āēīōū","aeiou") for text in ("k"+pair[0],"k"+pair[1]*2))
        rendered={}
        for number,(kind,glyph,text) in enumerate(cases):
            parts=t.text_words(text);analysis=[value.describe() for value in parts if isinstance(value,t.Word)]
            reasons=tuple(dict.fromkeys(reason for value in parts if isinstance(value,t.Word) for reason in value.unresolved))
            strict=not reasons
            # Retain the original27case research inventory, but never silently
            # promote its previously unresolved syllable grouping to support.
            audio,facts=carrier.audio(text,research_hypothesis=not strict)
            native_path=args.output/("%02d-native.wav"%number);write_wave(native_path,audio,carrier.rate,np)
            spec=converted_voices.spectrogram(converted_voices.resample(audio,carrier.rate,22050)).T[None]
            started=perf_counter()
            latent=flow.run(None,{"spec":spec,"spec_lengths":np.asarray([spec.shape[-1]],np.int64),
                                  "src_g":source,"tgt_g":target})[0]
            projected=decoder.run(None,{"/Mul_output_0":latent,"/ConstantOfShape_1_output_0":np.zeros_like(target)})[0].reshape(-1)
            level=speech_level(projected);gain=float(np.clip(.112/level,.32,4.)) if level>1e-5 else 1.
            projected=peak_limit(projected*gain)
            if not np.isfinite(projected).all() or not np.any(projected):raise ValueError("Actual selected-profile projection silent/nonfinite")
            output_path=args.output/("%02d-viktoriia.wav"%number)
            rate_facts=write_converted_wave(output_path,projected,np)
            row={"kind":kind,"glyph":glyph,"text":text,"analysis":analysis,"strictly_renderable":strict,
                 "unresolved_reasons":list(reasons),"carrier":facts,"carrier_wav_sha256":digest(native_path),
                 "projection_seconds":perf_counter()-started,"projected_samples":len(projected),
                 "projected_wav_sha256":digest(output_path),"projected_nonzero":True,**rate_facts,
                 "native_pronunciation_verified":False}
            report["cases"].append(row);rendered[text]=row;save_json(report_path,report)
        for long,short in zip("āēīōū","aeiou"):
            a,b=rendered["k"+long],rendered["k"+short*2]
            if a["carrier"]["encoded"]==b["carrier"]["encoded"]:
                raise ValueError("Long/double phonemic collision survived")
            if a["carrier"]["vowel_event_count"]!=1 or b["carrier"]["vowel_event_count"]!=2:
                raise ValueError("Actual eSpeak vowel events do not preserve one versus two nuclei")
            if a["carrier_wav_sha256"]==b["carrier_wav_sha256"] or a["projected_wav_sha256"]==b["projected_wav_sha256"]:
                raise ValueError("Actual long/double carrier or projection collapsed")
            report["structural_contrasts"].append({"vowel":short,"long_text":a["text"],"double_text":b["text"],
                "one_long_vs_two_vowel_events":True,"long_vowel_events":vowel_events(a["carrier"]["phoneme_events"]),
                "double_vowel_events":vowel_events(b["carrier"]["phoneme_events"]),
                "distinct_encoded_carrier_and_projected_waves":True,
                "scope":"Actual native-character phonemic unit contrast; these five synthetic units are not asserted lexical vocabulary"})
        # Invalid input fails before the carrier or C text engine sees it.
        rejected=[]
        for text in ("hello","xyz","café","a\0b","[en]","tau","lelei","e fale","kākā́"):
            try:carrier.audio(text)
            except t.UnsupportedTonganInput as error:rejected.append({"text":repr(text),"reasons":error.reasons,"error":str(error)})
            else:raise ValueError("Unsupported native input reached a foreign/raw text path")
        report["strict_rejections"]=rejected
        carrier.location.verify()
        if any(digest(path)!=before[key] for key,path in paths.items()):raise ValueError("Immutable model/identity inputs changed")
        report.update(status="actual-windows-strict-tongan-phonemic-contrast-projection-unregistered",
            all_five_long_double_event_contrasts_passed=True,all_projected_waves_finite_nonzero=True,
            actual_cases=len(cases),strictly_renderable_original27=sum(row["strictly_renderable"] for row in report["cases"][:27]),
            original27_research_hypothesis_count=sum(not row["strictly_renderable"] for row in report["cases"][:27]),
            frontend_sha256=digest(HERE/"tongan_frontend.py"),names_metadata_sha256=digest(names_path),
            original_input_bytes_unchanged=True,windows_engine_technical_execution_verified=True,
            selected_profile="viktoriia",selected_profile_acoustic_quality_verified=False)
        save_json(report_path,report)
        print("TONGAN_CONTRAST_SUMMARY "+json.dumps({key:report.get(key) for key in
            ("status","actual_cases","strictly_renderable_original27","original27_research_hypothesis_count",
             "all_five_long_double_event_contrasts_passed","original_input_bytes_unchanged","native_phonetic_fidelity_verified",
             "native_listener_verified","windows_nvda_verified","physical_audio_verified","registered")}),flush=True)
        return report
    except Exception as error:
        report.update(status="failed",error_type=type(error).__name__,error=str(error))
        save_json(report_path,report);raise
    finally:
        if carrier is not None:carrier.close()

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ("packaged-runtime","espeak","reference-encoder","network-policy","output"):
        parser.add_argument("--"+name,type=Path,required=True)
    return run(parser.parse_args()) and 0

if __name__=="__main__":raise SystemExit(main())
