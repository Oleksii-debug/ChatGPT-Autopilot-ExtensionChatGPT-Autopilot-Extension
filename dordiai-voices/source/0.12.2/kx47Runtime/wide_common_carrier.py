"""One local multilingual acoustic model, with one shared source identity.

Custom identities are applied separately by SharedIdentity. The public F1
conditioning is only an internal carrier and is never presented as a clone.
"""
from functools import cached_property
import json
import numpy as np
from converted_voices import resample

class CommonCarrier:
    def __init__(self,models,settings,owner):
        self.models,self.settings,self.owner=models,settings,owner

    @cached_property
    def engine(self):
        from wide_common_helpers import TextToSpeech,UnicodeProcessor,load_voice_style
        folder=self.models/self.settings['model']
        config=json.loads((folder/'onnx/tts.json').read_text(encoding='utf8'))
        processor=UnicodeProcessor(str(folder/'onnx/unicode_indexer.json'))
        class DeterministicTTS(TextToSpeech):
            def sample_noisy_latent(inner,durations):
                # The original helper uses the global RNG. This carrier has
                # its own source thread and must not alter any other engine.
                bsz=len(durations)
                wav_length=(durations*inner.sample_rate).astype(np.int64)
                maximum=wav_length.max()
                chunk=inner.base_chunk_size*inner.chunk_compress_factor
                length=int((maximum+chunk-1)//chunk)
                latent=np.random.default_rng(190).standard_normal((bsz,inner.ldim*inner.chunk_compress_factor,length),dtype=np.float32)
                from wide_common_helpers import get_latent_mask
                mask=get_latent_mask(wav_length,inner.base_chunk_size,inner.chunk_compress_factor)
                return latent*mask,mask
        vector=self.settings.get('vector_model','vector_estimator.onnx')
        if vector not in ('vector_estimator.onnx','vector_estimator.static-q8.onnx'):
            raise ValueError('Unsupported common acoustic graph')
        from wide_common import acoustic_graph
        sessions=[self.owner._session(acoustic_graph(folder/'onnx',name)) for name in
                  ('duration_predictor.onnx','text_encoder.onnx',vector,'vocoder.onnx')]
        engine=DeterministicTTS(config,processor,*sessions)
        style=load_voice_style([str(folder/'voice_styles/F1.json')])
        return engine,style

    def preload(self):self.engine

    def synthesize(self,text,language='na',source_tempo=1.,*,append_terminal=False):
        self.owner.check_cancelled()
        engine,style=self.engine
        # A bookmark or a physical line boundary is not punctuation.
        # Keep the upstream letter-name behavior only for explicit spelling.
        engine.text_processor.append_terminal_period=append_terminal
        audio,duration=engine._infer([text],[language],style,int(self.settings.get('steps',4)),source_tempo)
        self.owner.check_cancelled()
        count=int(float(np.asarray(duration).reshape(-1)[0])*engine.sample_rate)
        audio=np.asarray(audio,dtype=np.float32).reshape(-1)[:count]
        yield resample(audio,engine.sample_rate,24000)
