"""Stream local language pronunciations through the selected registered speaker."""
from functools import lru_cache
import json
from pathlib import Path
import numpy as np
from converted_voices import spectrogram, resample
from native_locale import NativeLocaleVoices
from speech_tempo import stream_tempo
from streaming_resample import stream_resample
from voice_delivery import compact_padding,prepare_letter
from wide_carrier import WideCarrier


class WideVoices:
    def __init__(self,models,references,owner=None,threads=3,converter=None):
        self.folder=Path(models)/"WideLanguages"
        self.converter=converter or NativeLocaleVoices(models,Path(references)/"classmate_locales",threads=threads,owner=owner)
        self.owner=owner or self.converter
        self.registry=json.loads(Path(__file__).with_name("wide_voice_index.json").read_bytes())
        self._engine=None
        self._hebrew=None
        self._common=None
        self._breton=None
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

    @lru_cache(maxsize=144)
    def source(self,code):
        file=self.folder/self.registry[code]["source"]
        source=np.load(file,allow_pickle=False)
        if source.shape!=(1,256,1) or not np.isfinite(source).all():raise ValueError("Invalid source for "+code)
        return source

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
        self.owner.check_cancelled()
        event=getattr(self.owner,"cancel_event",None)
        native_factor=1. if character else min(1.85,max(.8,float(speed)))
        shared=info.get("natural")=="shared" and not character
        source_family='common' if shared else code if info.get('backend') else 'espeak'
        if self.progress and source_family not in self._opened_sources:
            self.progress('language-source')
        private=info.get('backend')=='mms-graphemes'
        if private:
            files=info['files']
            source=self._personal_source(code,files['source.npy'])
            if self.progress and source_family not in self._opened_sources:self.progress('language-phonetics')
            carrier=self._personal_carrier(code,files['model.onnx'],files['config.json'],
                                           files.get('navigation.json'),files.get('navigation_audio.npz'))
            produced,sample_rate,native_factor=carrier.audio(text,character,native_factor)
            audio=resample(produced,sample_rate,22050)
        else:
            source=self.source(code)
        if shared:
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
        if self._engine is not None:self._engine.close()
