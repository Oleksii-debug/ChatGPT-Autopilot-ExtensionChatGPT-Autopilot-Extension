"""Stream local language pronunciations through the selected registered speaker."""
from functools import lru_cache
from collections import OrderedDict,deque
import json
from pathlib import Path
from time import perf_counter
import numpy as np
from converted_voices import spectrogram, resample
from speech_tempo import stream_tempo
from streaming_resample import stream_resample
from voice_delivery import compact_padding,prepare_letter
from wide_carrier import WideCarrier


MIB=1024**2
MMS_MIN_ESTIMATE_BYTES=512*MIB
MMS_MAX_WARM_MODELS=7
MEMORY_RESERVE_BYTES=1024*MIB


def _headroom():
    from wide_warmup import memory_headroom
    return memory_headroom()


class WideVoices:
    def __init__(self,models,references,owner=None,threads=3,converter=None,mms_cache_budget_bytes=None):
        self.models=Path(models)
        self.folder=self.models/"WideLanguages"
        if converter is None:
            from native_locale import NativeLocaleVoices
            converter=NativeLocaleVoices(models,Path(references)/"classmate_locales",threads=threads,owner=owner)
        self.converter=converter
        self.owner=owner or self.converter
        self.registry=json.loads(Path(__file__).with_name("wide_voice_index.json").read_bytes())
        self._engine=None
        self._hebrew=None
        self._common=None
        self._breton=None
        self._mms_carriers=OrderedDict()
        self._mms_estimates={}
        self._mms_evictions=deque(maxlen=64)
        self._native_timings=deque(maxlen=64)
        self._omni_used=False
        self._extra_used=False
        self._rasa_used=False
        if mms_cache_budget_bytes is None:
            available=_headroom()
            # Unknown headroom retains the conservative original two-model
            # allowance. On roomy Windows PCs 3..7 recently used models can stay
            # warm, while most available RAM remains outside this cache budget.
            self._mms_budget_bytes=(2*MMS_MIN_ESTIMATE_BYTES if available is None else
                max(0,int(min(available*.45,available-MEMORY_RESERVE_BYTES))))
        elif type(mms_cache_budget_bytes) is not int or mms_cache_budget_bytes<0:
            raise ValueError("Invalid native model cache budget")
        else:
            self._mms_budget_bytes=mms_cache_budget_bytes
        self._opened_sources=set()
        self.progress=None

    def _prepare_projection(self):
        # Only announce actual first-time session creation. Eventual reuse of the
        # same speaker model across languages needs no extra reply or timeout.
        for attribute,stage in [('flow','selected-voice'),('decoder','voice-decoder')]:
            if attribute not in self.converter.__dict__:
                self.owner.check_cancelled()
                if self.progress:self.progress(stage)
                getattr(self.converter,attribute)

    @property
    def engine(self):
        if self._engine is None:self._engine=WideCarrier(self.folder)
        return self._engine

    def _backend_info(self,code,text=None,character=False):
        from language_catalog import resolve_backend_info
        return resolve_backend_info(self.models,code,self.registry[code],text=text,character=character)

    def source(self,code,info=None):
        # A single language can use two explicitly calibrated backends depending
        # on input support. Never reuse its preferred embedding for the fallback.
        selected=self._backend_info(code) if info is None else info
        identity=json.dumps(selected,sort_keys=True,separators=(",",":"))
        return self._selected_source(code,identity)

    @lru_cache(maxsize=288)
    def _selected_source(self,code,identity):
        info=json.loads(identity)
        backend=info.get("backend")
        if backend in {"mms-onnx", "mms-vits"}:
            from wide_mms import source
            return source(code,self.models)
        if backend=="extra-onnx":
            from wide_extra_models import source
            return source(code,models=self.models)
        if backend=="omni-onnx":
            from wide_omnivoice_onnx import source
            return source(code,models=self.models)
        if backend=="rasa-onnx":
            from wide_rasa import source
            return source(code,models=self.models)
        file=self.folder/info["source"]
        source=np.load(file,allow_pickle=False)
        if source.shape!=(1,256,1) or not np.isfinite(source).all():raise ValueError("Invalid source for "+code)
        return source

    def _evict_mms(self,preserve=None):
        code=next((code for code in self._mms_carriers if code!=preserve),None)
        if code is None:return False
        previous=self._mms_carriers.pop(code)
        self._mms_estimates.pop(code,None)
        close=getattr(previous,"close",None)
        if close is not None:close()
        self._mms_evictions.append(code)
        return True

    def _ensure_headroom(self,required,preserve=None):
        available=_headroom()
        reserve=256*MIB if required==0 else MEMORY_RESERVE_BYTES
        while available is not None and available<required+reserve:
            self.owner.check_cancelled()
            if not self._evict_mms(preserve):
                raise MemoryError("Insufficient available RAM/commit for the requested native speech model")
            available=_headroom()

    def _mms_estimate(self,code):
        try:
            weights=(self.models/"MMS"/code/"model.onnx").stat().st_size
        except OSError:
            weights=0
        # ONNX weights are only part of the resident model: account for graph
        # optimization, execution buffers and per-request activation memory.
        return max(MMS_MIN_ESTIMATE_BYTES,weights*4+128*MIB)

    def _mms_carrier(self,code):
        """Lazily retain recent native models within RAM and model-count bounds."""
        carrier=self._mms_carriers.get(code)
        if carrier is not None:
            self._ensure_headroom(0,preserve=code)
            self._mms_carriers.move_to_end(code)
            return carrier
        from wide_mms import MMSCarrier,available
        if code not in available(self.models):
            raise ValueError("Required native MMS resources are not installed: "+code)
        self.owner.check_cancelled()
        estimate=self._mms_estimate(code)
        if estimate>self._mms_budget_bytes:
            raise MemoryError("The native model exceeds the available RAM cache budget")
        while (len(self._mms_carriers)>=MMS_MAX_WARM_MODELS or
               sum(self._mms_estimates.values())+estimate>self._mms_budget_bytes):
            if not self._evict_mms():break
        self._ensure_headroom(estimate)
        carrier=MMSCarrier(self.models/"MMS"/code,session_factory=self.converter._session,owner=self.owner)
        self._mms_carriers[code]=carrier
        self._mms_estimates[code]=estimate
        return carrier

    def cache_diagnostics(self):
        """Observations, not a claim about audible/NVDA switching latency."""
        return {"mms_cache_budget_bytes":self._mms_budget_bytes,
                "mms_resident_estimate_bytes":sum(self._mms_estimates.values()),
                "mms_max_warm_models":MMS_MAX_WARM_MODELS,
                "mms_cached_languages":list(self._mms_carriers),
                "mms_recent_evictions":list(self._mms_evictions),
                "native_generation":list(self._native_timings),
                "timing_scope":"carrier audio generation including cold session setup; excludes voice conversion and audio-device/NVDA latency"}

    @lru_cache(maxsize=2)
    def _personal_carrier(self,code,model_digest,config_digest,navigation_digest,audio_digest):
        from personal_catalog import discover
        from personal_voice import PersonalCarrier
        return PersonalCarrier(discover()[code],self.owner)

    @lru_cache(maxsize=64)
    def _personal_source(self,code,digest):
        from personal_catalog import discover,verified_file
        vector=np.load(verified_file(discover()[code],'source.npy'),allow_pickle=False)
        if vector.shape!=(1,256,1) or vector.dtype!=np.float32 or not np.isfinite(vector).all():
            raise ValueError('Invalid optional language source')
        return vector

    def converted(self,audio,source,target,tempo=1.,character=False):
        pad=2048
        spec=spectrogram(np.pad(audio,(pad,pad))).T.copy()[None]
        frames=spec.shape[-1]
        if character and frames<=288:
            first,step=frames,frames
        elif tempo>=1.6:
            first,step=(120,88) if frames>=125 else (frames,frames)
        else:
            first,step=(44,40) if frames<=120 else (68,56)
        zeros=np.zeros_like(target)
        # Project each group once. Forty neighbouring frames preserve the flow's
        # context. Smaller decoder windows can then start playback while sharing
        # the same projected frames. The fixed bound also limits cancellation work.
        for start_group in range(0,frames,288):
            self.owner.check_cancelled()
            stop=min(frames,start_group+288)
            lo=max(0,start_group-40);hi=min(frames,stop+40)
            section=spec[:,:,lo:hi].copy()
            latent=self.converter.flow.run(None,dict(spec=section,spec_lengths=np.array([hi-lo],np.int64),
                                                    src_g=source,tgt_g=target))[0]
            start=start_group
            while start<stop:
                self.owner.check_cancelled()
                end=min(stop,start+(first if start==0 else step))
                if 0<stop-end<step//2:end=stop
                left=max(0,start-12);right=min(frames,end+12)
                window=latent[:,:,left-lo:right-lo]
                decoded=self.converter.decoder.run(None,{"/Mul_output_0":window,
                                                         "/ConstantOfShape_1_output_0":zeros})[0].reshape(-1)
                low=max(start*256,pad);high=min(end*256,pad+len(audio))
                if low<high:
                    pcm=decoded[low-left*256:high-left*256]
                    # Keep the same interval for the existing first-block level
                    # estimate regardless of the faster decoder's output size.
                    if start==0 and len(pcm)>4608:
                        yield pcm[:4608]
                        yield pcm[4608:]
                    else:yield pcm
                start=end

    def blocks(self,profile,code,text,speed=1.,character=False):
        info=self.registry.get(code)
        if info is None:
            from personal_catalog import discover
            info=discover()[code]
        else:
            info=self._backend_info(code,text,character)
        self.owner.check_cancelled()
        event=getattr(self.owner,"cancel_event",None)
        native_factor=1. if character else min(1.85,max(.8,float(speed)))
        backend=info.get("backend")
        new_native=backend in {"mms-onnx", "mms-vits", "extra-onnx", "omni-onnx", "rasa-onnx"}
        shared=info.get("natural")=="shared" and not character and not new_native
        source_family='common' if shared else (code,backend,info.get('source')) if backend else 'espeak'
        if self.progress and source_family not in self._opened_sources:
            self.progress('language-source')
        private=backend=='mms-graphemes'
        if private:
            files=info['files']
            source=self._personal_source(code,files['source.npy'])
            if self.progress and source_family not in self._opened_sources:self.progress('language-phonetics')
            carrier=self._personal_carrier(code,files['model.onnx'],files['config.json'],
                                           files.get('navigation.json'),files.get('navigation_audio.npz'))
            produced,sample_rate,native_factor=carrier.audio(text,character,native_factor)
            audio=resample(produced,sample_rate,22050)
        else:
            source=self.source(code,info=info)
        if backend in {"mms-onnx", "mms-vits"}:
            if self.progress and source_family not in self._opened_sources:self.progress('language-phonetics')
            reused=code in self._mms_carriers
            started=perf_counter()
            carrier=self._mms_carrier(code)
            loaded=getattr(carrier,"_graph",None) is not None
            status="failed"
            try:
                produced,sample_rate,native_factor=carrier.audio(text,character=character,speed=native_factor)
                status="completed"
            finally:
                self._native_timings.append({"code":code,"backend":backend,"carrier_reused":reused,
                    "session_previously_loaded":loaded,"status":status,"generation_ms":(perf_counter()-started)*1000})
            audio=resample(produced,sample_rate,22050)
        elif backend=="rasa-onnx":
            from wide_rasa import audio as rasa_audio,available
            if code not in available(self.models):
                raise ValueError("Required native Rasa resources are not installed: "+code)
            if self.progress and source_family not in self._opened_sources:self.progress('language-phonetics')
            self._rasa_used=True
            produced,sample_rate=rasa_audio(code,text,character,models=self.models,rate=native_factor,owner=self.owner)
            audio=resample(produced,sample_rate,22050)
        elif backend=="extra-onnx":
            from wide_extra_models import audio as extra_audio,available
            if code not in available(self.models):
                raise ValueError("Required additional ONNX resources are not installed: "+code)
            if self.progress and source_family not in self._opened_sources:self.progress('language-phonetics')
            self._extra_used=True
            produced,sample_rate=extra_audio(code,text,character,models=self.models,rate=native_factor,owner=self.owner)
            audio=resample(produced,sample_rate,22050)
        elif backend=="omni-onnx":
            from wide_omnivoice_onnx import audio as omni_audio,available
            if code not in available(self.models):
                raise ValueError("Required native OmniVoice resources are not installed: "+code)
            if self.progress and source_family not in self._opened_sources:self.progress('language-phonetics')
            if not self._omni_used:
                # Shared 1.1 GB weights plus execution buffers are additional
                # to any warm MMS models. Release MMS entries under pressure.
                self._ensure_headroom(2560*MIB)
            started=perf_counter()
            status="failed"
            try:
                produced,sample_rate=omni_audio(code,text,character,models=self.models,rate=native_factor,owner=self.owner)
                status="completed"
            finally:
                self._native_timings.append({"code":code,"backend":backend,
                    "shared_engine_previously_used":self._omni_used,
                    "status":status,"generation_ms":(perf_counter()-started)*1000})
            self._omni_used=True
            audio=resample(produced,sample_rate,22050)
        elif shared:
            from wide_common import CommonSpeech
            if self._common is None:
                self._common=CommonSpeech(self.folder,self.converter)
            native_factor=min(native_factor,1.7)
            audio=self._common.audio(code,text,native_factor)
            if not hasattr(self,"_common_source"):
                self._common_source=np.load(self.folder/"SharedAcoustic/source.npy",allow_pickle=False)
            source=self._common_source
        elif info.get("backend")=="reyd":
            from wide_yiddish import YiddishCarrier
            if not hasattr(self,"_yiddish"):
                self._yiddish=YiddishCarrier(self.folder/"Yiddish",self.converter._session,owner=self.owner)
            native_factor=1. if character else self._yiddish.applied_rate(native_factor)
            audio=self._yiddish.audio(text,character,speed=native_factor)
        elif info.get("backend")=="breton-vits":
            if self._breton is None:
                from wide_breton import BretonCarrier
                self._breton=BretonCarrier(self.folder/"Breton",self.owner)
            audio=self._breton.audio(text,character,native_factor)
        elif info.get("backend")=="nos-vits":
            from wide_extra import audio as extra_audio
            produced,sample_rate=extra_audio(code,text,character,models=self.folder,rate=native_factor,owner=self.owner)
            audio=resample(produced,sample_rate,22050)
        elif info.get("backend")=="renikud-noa":
            if self._hebrew is None:
                from wide_hebrew import HebrewCarrier
                self._hebrew=HebrewCarrier(self.folder/"Hebrew",progress=self.progress,owner=self.owner)
            audio=self._hebrew.audio(text,character,native_factor)
        elif not private:
            if backend is not None:
                raise ValueError("Unsupported registered pronunciation backend: "+str(backend))
            data=self.engine.pcm(info["voice"],text,character=character,rate=round(182*native_factor),
                                 cancelled=event.is_set if event is not None else None)
            audio=np.frombuffer(data,"<i2").astype(np.float32)/32768
            if self.engine.rate!=22050:audio=resample(audio,self.engine.rate,22050)
        self.owner.check_cancelled()
        if not len(audio):return
        self._opened_sources.add(source_family)
        self._prepare_projection()
        if len(audio)<512:audio=np.pad(audio,(0,512-len(audio)))
        target=self.converter.target_profile(profile)
        if info.get("backend")=="reyd":
            target=self._yiddish.target(source,target)
        output=stream_resample(self.converted(audio,source,target,
                                              float(speed)/native_factor,character),22050,24000)
        if character:
            parts=tuple(output)
            output=(prepare_letter(np.concatenate(parts)),) if parts else ()
        else:
            output=self.converter.levelled(output)
        yield from compact_padding(stream_tempo(output,24000,float(speed)/native_factor),text)

    def close(self):
        self._personal_carrier.cache_clear()
        self._personal_source.cache_clear()
        self._selected_source.cache_clear()
        for carrier in self._mms_carriers.values():
            close=getattr(carrier,"close",None)
            if close is not None:close()
        self._mms_carriers.clear()
        self._mms_estimates.clear()
        if self._extra_used:
            from wide_extra_models import clear_engines
            clear_engines(owner=self.owner)
            self._extra_used=False
        if self._rasa_used:
            from wide_rasa import clear_engines
            clear_engines(owner=self.owner)
            self._rasa_used=False
        if self._engine is not None:self._engine.close()
