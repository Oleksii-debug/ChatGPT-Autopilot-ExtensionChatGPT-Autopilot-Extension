"""Apply one language-independent speaker vector to every acoustic carrier."""
from functools import cached_property, lru_cache
from collections import OrderedDict
from pathlib import Path
import json
import numpy as np
from converted_voices import ConvertedVoices, resample, spectrogram
from streaming_resample import stream_resample
from data_registry import Registry


class SharedIdentity:
    def __init__(self, models, references, owner):
        self.models, self.references, self.owner = Path(models), Path(references), owner
        self.tone = ConvertedVoices(models, references, threads=4)
        self.voices = OrderedDict()
        self.rhvoices = OrderedDict()
        self.registry=Registry(models)

    def preload(self):
        if (self.models/'OpenVoiceV2/encoder-flow.onnx').is_file():
            self.tone.flow
            self.tone.decoder
        else:
            self.tone.converter
        for code,language in self.registry.languages.items():
            if language.get('preload') and language['backend']=='piper':self.piper(code)
            elif language.get('preload') and language['backend']=='rhvoice':self.rhvoice(code)

    @cached_property
    def slovak(self):
        return self.rhvoice('sk')

    def rhvoice(self,language):
        from rhvoice_carrier import SlovakCarrier
        if language not in self.rhvoices:
            settings=self.registry.language(language)
            while len(self.rhvoices)>=3:self.rhvoices.popitem(last=False)[1].close()
            self.rhvoices[language]=SlovakCarrier(self.registry.resource(settings['model']),self.owner,settings['voice'])
        self.rhvoices.move_to_end(language)
        return self.rhvoices[language]

    def carrier_key(self,language):
        return 'language:'+self.registry.locale(language)

    @lru_cache(maxsize=8)
    def target(self, profile):
        target = np.load(self.references/self.registry.voice(profile)['target'], allow_pickle=False)
        if target.shape != (1,256,1) or not np.isfinite(target).all():
            raise ValueError('Invalid shared speaker profile')
        return target

    @lru_cache(maxsize=16)
    def source(self, key):
        if key.startswith('language:'):
            return np.load(self.references/self.registry.language(key.split(':',1)[1])['source'],allow_pickle=False)
        return np.load(self.references/'shared/sources'/(key+'.npy'), allow_pickle=False)

    def piper(self, language):
        from piper import PiperVoice
        from piper.config import PiperConfig
        if language not in self.voices:
            model = self.registry.resource(self.registry.language(language)['model'])
            config = PiperConfig.from_dict(json.loads(model.with_suffix('.onnx.json').read_text(encoding='utf8')))
            self.voices[language] = PiperVoice(session=self.owner._session(model), config=config)
            while len(self.voices)>4:self.voices.popitem(last=False)
        self.voices.move_to_end(language)
        return self.voices[language]

    def native(self, language, text):
        if self.registry.language(language)['backend']=='rhvoice':
            yield from self.rhvoice(language).synthesize(text)
            return
        from piper import SynthesisConfig
        voice = self.piper(language)
        for chunk in voice.synthesize(text, SynthesisConfig(length_scale=1.)):
            yield resample(chunk.audio_float_array, voice.config.sample_rate, 24000)

    def convert(self, profile, carrier, blocks, tempo=1., *, stream=False, fast_reading=False):
        # Short, word-bounded requests are converted once with full neural
        # context. Overlapping decoder windows repeated most CPU work and
        # changed consonants/timbre at their edges, starving faster playback.
        self.owner.check_cancelled()
        self.tone.cancel_event=self.owner.cancel_event
        self.tone.cancel_thread=__import__('threading').get_ident()
        pieces=tuple(blocks)
        if not pieces:
            return
        audio=np.concatenate(pieces)
        if tempo>1.0001:
            from speech_tempo import change_tempo
            audio=change_tempo(audio,24000,tempo)
        audio=resample(audio,24000,22050)
        if len(audio)<=512:
            return
        guard=2048
        padded=np.pad(audio,(guard,guard))
        spec=spectrogram(padded).T.copy()[None]
        source,target=self.source(carrier),self.target(profile)
        if stream and (self.models/'OpenVoiceV2/encoder-flow.onnx').is_file():
            def cropped():
                position=0
                decode=(getattr(self.tone,'accelerated_blocks',self.tone.decode_stream)
                        if fast_reading else self.tone.decode_stream)
                for converted in decode(spec,source,target):
                    left=max(0,guard-position)
                    right=min(len(converted),guard+len(audio)-position)
                    position+=len(converted)
                    if right>left:yield converted[left:right]
            yield from stream_resample(cropped(),22050,24000)
            return
        converted=self.tone._convert(spec,source,target)
        converted=converted[guard:guard+len(audio)]
        self.owner.check_cancelled()
        yield resample(converted,22050,24000)

    def _convert_stream(self, profile, carrier, blocks):
        self.owner.check_cancelled()
        event = self.owner.cancel_event
        self.tone.cancel_event = event
        self.tone.cancel_thread = __import__('threading').get_ident()
        source, target = self.source(carrier), self.target(profile)
        upstream = iter(blocks)
        raw, count, ended = [], 0, False
        start, end, previous = 0, 25, None
        overlap = 512
        fade = np.linspace(0, 1, overlap, dtype=np.float32)
        while True:
            # Keep 24 real future frames for the converter. Resample the complete
            # prefix at aligned positions, avoiding independent-chunk FIR seams.
            required = int(np.ceil(((end+24)*256+400)*24000/22050))
            while count < required and not ended:
                self.owner.check_cancelled()
                chunk = next(upstream, None)
                if chunk is None:
                    ended = True
                    break
                if len(chunk):
                    raw.append(chunk)
                    count += len(chunk)
            if count <= 600:
                return
            spoken = resample(np.concatenate(raw), 24000, 22050)
            spec = spectrogram(spoken).T.copy()[None]
            frame_count = spec.shape[-1]
            if start >= frame_count:
                return
            if ended:
                end = min(end, frame_count)
            left, right = max(0,start-24), min(frame_count,end+24)
            converted = self.tone._convert(spec[:,:,left:right].copy(), source, target)
            block = converted[(start-left)*256:(end-left)*256]
            if previous is not None:
                block[:overlap] = previous*(1-fade)+block[:overlap]*fade
            self.owner.check_cancelled()
            if ended and end == frame_count:
                yield block
                return
            yield block[:-overlap]
            previous = block[-overlap:].copy()
            start = end-2
            end = start+56
