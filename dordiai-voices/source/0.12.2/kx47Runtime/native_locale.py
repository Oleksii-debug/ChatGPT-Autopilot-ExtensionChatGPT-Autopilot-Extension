"""Registered native pronunciation; one target identity for every language."""
from functools import cached_property,lru_cache
from pathlib import Path
from threading import RLock, get_ident
from native_lookahead import CarrierContext, SharedCarrierSession
import json
import numpy as np
from piper import PiperVoice,SynthesisConfig
from piper.config import PiperConfig
from piper_family_sessions import PiperFamilies
from converted_voices import ConvertedVoices,resample,spectrogram
from english_phonetics import phonemizer
from session_control import GuardedSession
from streaming_resample import stream_resample
from speech_tempo import change_tempo, stream_tempo
from voice_delivery import compact_padding,prepare_letter,speech_level,peak_limit

class NativeLocaleVoices(ConvertedVoices):
    def __init__(self,models,profiles,*,piper=None,variant='global',threads=3,owner=None):
        super().__init__(models,profiles,threads=threads)
        self.directory=Path(piper or self.models/'Piper');self.owner=owner
        self.forecast_context = CarrierContext(self.carrier)
        self.voice_lock = RLock()
        self.carrier_lock = RLock()
        self.private_carriers = {}
        self.families=PiperFamilies(self.directory, self._carrier_session)
        self.languages=json.loads((self.references/'languages.json').read_text(encoding='utf8'))
        if not isinstance(self.languages,dict):raise ValueError('Native model registration is missing')

    def _carrier_session(self, path):
        raw = super()._session(path, threads=2).session
        return SharedCarrierSession(raw, self.owner or self, self.forecast_context)

    def check_cancelled(self):
        if get_ident() == self.forecast_context.cancel_thread:
            return self.forecast_context.check_cancelled()
        if self.owner is None:super().check_cancelled()
        else:self.owner.check_cancelled()

    def _session(self,path):
        session=super()._session(path)
        return GuardedSession(session.session,self.owner) if self.owner is not None else session

    def resource(self,folder,relative):
        path=(folder/relative).resolve()
        if not path.is_relative_to(folder.resolve()):raise ValueError('Native resource escapes package')
        return path

    @cached_property
    def flow(self):return self._session(self.models/'OpenVoiceV2/encoder-flow.onnx')

    @cached_property
    def decoder(self):return self._session(self.models/'OpenVoiceV2/decoder.onnx')

    def voice(self, code):
        with self.voice_lock:
            return self._loaded_voice(code)

    @lru_cache(maxsize=16)
    def _loaded_voice(self,code):
        file=self.resource(self.directory,self.languages[code]['model'])
        config=PiperConfig.from_dict(json.loads(file.with_suffix('.onnx.json').read_text(encoding='utf8')))
        return PiperVoice(session=self.families.for_language(code,file),config=config)

    @lru_cache(maxsize=64)
    def sentence_audio(self, code, phones):
        voice = self.voice(code)
        audio = voice.phoneme_ids_to_audio(
            voice.phonemes_to_ids(phones), SynthesisConfig(noise_scale=.55,noise_w_scale=.65),
        )
        if audio.size:
            audio = resample(audio, voice.config.sample_rate, self.sampling_rate)
            audio.setflags(write=False)
        return audio

    def _private_carrier(self, code, text):
        from rhvoice_carrier import SlovakCarrier
        from ukrainian_voices import SENTENCES
        entry = self.languages[code]
        for sentence in SENTENCES.finditer(text.strip()):
            self.check_cancelled()
            while not self.carrier_lock.acquire(timeout=.012):
                self.check_cancelled()
            try:
                self.check_cancelled()
                owner = (self.forecast_context if get_ident() == self.forecast_context.cancel_thread
                         else self.owner or self)
                engine = self.private_carriers.get(code)
                if engine is None:
                    folder = self.resource(self.models, entry["directory"])
                    engine = self.private_carriers[code] = SlovakCarrier(folder, owner, voice=entry["voice"])
                # The C callback uses the same owner and sample buffer until
                # this message has completed, in the foreground or the forecast.
                engine.owner = owner
                stream = engine.synthesize(sentence.group().strip())
                try:
                    samples = resample(next(stream), 24000, self.sampling_rate)
                finally:
                    stream.close()
            finally:
                self.carrier_lock.release()
            self.check_cancelled()
            yield samples

    def close_locales(self):
        with self.carrier_lock:
            for voice in self.private_carriers.values():
                voice.close()
            self.private_carriers.clear()

    def carrier(self, code, text):
        if self.languages[code].get("backend") == "rhvoice":
            yield from self._private_carrier(code, text)
            return
        self.check_cancelled()
        voice = self.voice(code)
        for phones in phonemizer().phonemize(voice.config.espeak_voice, text,
                                               vowel_clusters=voice.config.vowel_clusters):
            if phones:
                self.check_cancelled()
                audio = self.sentence_audio(code, tuple(phones))
                if audio.size:
                    yield audio

    @lru_cache(maxsize=64)
    def source_profile(self,code):
        value=np.load(self.resource(self.references,self.languages[code]['source']),allow_pickle=False)
        if value.shape!=(1,256,1) or not np.isfinite(value).all():raise ValueError('Invalid source identity')
        return value

    @lru_cache(maxsize=1024)
    def target_profile(self,profile):
        from voice_assets import asset_path
        managed = asset_path(self.references.parent, profile, 'target_embedding', required=True)
        value=np.load(managed if managed is not None else self.resource(self.references,profile+'.npy'),allow_pickle=False)
        if value.shape!=(1,256,1) or not np.isfinite(value).all():raise ValueError('Invalid target identity')
        return value

    def decode_stream(self,spec,source,target,step=96):
        latent=self.flow.run(None,dict(spec=spec,spec_lengths=np.array([spec.shape[-1]],np.int64),src_g=source,tgt_g=target))[0]
        for start in range(0,latent.shape[-1],step):
            self.check_cancelled()
            end=min(latent.shape[-1],start+step);left=max(0,start-16);right=min(latent.shape[-1],end+16)
            audio=self.decoder.run(None,{'/Mul_output_0':latent[:,:,left:right].copy(),
                                        '/ConstantOfShape_1_output_0':np.zeros_like(target)})[0].reshape(-1)
            yield audio[(start-left)*256:(end-left)*256]

    @staticmethod
    def levelled(chunks):
        gain=None
        for block in chunks:
            if not len(block):continue
            if gain is None:
                level=speech_level(block);gain=float(np.clip(.112/level,.32,4.)) if level>1e-5 else 1.
            yield peak_limit(block*gain)

    @lru_cache(maxsize=64)
    def letter_source(self, code, text):
        from navigation_cache import cache_name
        path = self.references / "letter_sources" / (cache_name(code, text)[:-4] + ".npy")
        if not path.is_file():
            return None
        wave = np.load(path, allow_pickle=False)
        if wave.dtype != np.float32 or wave.ndim != 1 or not 384 < wave.size <= 8*self.sampling_rate:
            raise ValueError("Invalid letter source")
        wave.setflags(write=False)
        return wave

    def blocks(self,profile,code,text,speed=1.,character=False,prepared=None,prepare_next=None):
        if character and prepared is None:
            prepared = self.letter_source(code, text)
        self.cancel_thread=get_ident()
        source,target=self.source_profile(code),self.target_profile(profile)
        conversion_speed = min(2.0, speed) if not character and speed >= 2.2 else 1.0
        def converted():
            source_audio = self.carrier(code,text) if prepared is None else (prepared,)
            for number, audio in enumerate(source_audio):
                if number == 0 and prepare_next is not None:
                    prepare_next()
                if conversion_speed != 1.0:
                    audio = change_tempo(audio, self.sampling_rate, conversion_speed)
                if len(audio)<=384:continue
                guard=2048;spec=spectrogram(np.pad(audio,(guard,guard))).T.copy()[None]
                def cropped():
                    position=0
                    for block in self.decode_stream(spec,source,target):
                        left=max(0,guard-position);right=min(len(block),guard+len(audio)-position)
                        position+=len(block)
                        if right>left:yield block[left:right]
                for block in stream_resample(cropped(),self.sampling_rate,24000):
                    if self.owner is not None:self.owner.native_locale_tag=(profile,code)
                    yield block
        raw=converted()
        if character:
            pieces=tuple(raw);raw=(prepare_letter(np.concatenate(pieces)),) if pieces else ()
        else:raw=self.levelled(raw)
        base_tempo = 1.0 if character else self.languages[code].get("tempo", 1.0)
        yield from compact_padding(stream_tempo(raw,24000,speed / conversion_speed * base_tempo),text)
