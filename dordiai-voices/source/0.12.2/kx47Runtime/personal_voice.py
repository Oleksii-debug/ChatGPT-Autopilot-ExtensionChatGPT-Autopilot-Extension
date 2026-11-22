"""Read a separately supplied MMS grapheme model through the existing personal voice projection."""
import json
import re
import unicodedata
import numpy as np
import onnxruntime as ort
from personal_catalog import orthography,verified_file
from wide_loading import DeferredValue


def grapheme_ids(config,text,navigation=None,character=False):
    names=navigation or {}
    value=orthography.fold_text(text,config.get('lang_code')).strip()
    if character:value=names.get('letters',{}).get(value,value)
    digits=names.get('digits')
    if digits and len(digits)==10:
        def speak_number(match):
            code=''.join(str(unicodedata.decimal(ch)) for ch in match[0])
            if not character and (code=='0' or not code.startswith('0')):
                name=names.get('numbers',{}).get(code)
                if name:return ' '+name+' '
            return ' '+' '.join(digits[int(d)] for d in code)+' '
        value=re.sub(r'\d+',speak_number,value)
    vocab=config['phoneme_id_map']
    blank=vocab[config['blank']]
    value=' '.join(orthography.fold_text(value,config.get('lang_code')).split())
    symbols=[c for c in value if c in vocab]
    if not symbols:raise ValueError('No trained graphemes in the requested optional-language phrase')
    tokens=[vocab[c] for c in symbols]
    if config.get('add_blank_char'):
        # The original VitsTokenizer reserves the literal spelling of ID 0
        # before it inserts blanks. In some alphabets this is a real letter,
        # so the beginning/end of a word differs from a simple interleave.
        groups=''.join(symbols).split(config['blank'])
        tokens=[]
        for index,group in enumerate(groups):
            if index:tokens.append(blank)
            if not group:continue
            if config.get('blank_at_start'):tokens.append(blank)
            for position,char in enumerate(group):
                if position:tokens.append(blank)
                tokens.append(vocab[char])
            if config.get('blank_at_end'):tokens.append(blank)
    return np.asarray([tokens],dtype=np.int64)


class PersonalCarrier:
    def __init__(self,entry,owner):
        self.entry=entry
        self.owner=owner
        self.config=json.loads(verified_file(entry,'config.json').read_bytes())
        if self.config.get('engine')!='transformers' or self.config.get('phoneme_type')!='graphemes':
            raise ValueError('Unsupported personal voice tokenizer')
        self.sample_rate=int(self.config['audio']['sample_rate'])
        if not 8000<=self.sample_rate<=48000:raise ValueError('Invalid personal voice sample rate')
        self.navigation={}
        if 'navigation.json' in entry['files']:
            self.navigation=json.loads(verified_file(entry,'navigation.json').read_bytes())
        self.prepared={}
        if 'navigation_audio.npz' in entry['files']:
            path=verified_file(entry,'navigation_audio.npz')
            with np.load(path,allow_pickle=False) as bank:
                for key in bank.files:
                    if not re.fullmatch(r'u[0-9A-F]{4,6}|n[0-9]{1,12}',key):
                        raise ValueError('Invalid optional navigation key')
                    data=bank[key]
                    if data.dtype!=np.int16 or data.ndim!=1 or not 100<=len(data)<=12*self.sample_rate:
                        raise ValueError('Invalid optional navigation waveform')
                    self.prepared[key]=data
        self.model=DeferredValue(self._open)

    def _open(self):
        options=ort.SessionOptions()
        options.intra_op_num_threads=2;options.inter_op_num_threads=1
        options.add_session_config_entry('session.intra_op.allow_spinning','0')
        base=ort.InferenceSession(str(verified_file(self.entry,'model.onnx')),sess_options=options,providers=['CPUExecutionProvider'])
        inputs={p.name:(p.type,p.shape) for p in base.get_inputs()}
        if not set(inputs)<={'input_ids','attention_mask','input','x','x_length','input_lengths','noise_scale','noise_scale_w','noise_scale_duration',
                                 'length_scale','speaking_rate','scales'}:
            raise ValueError('Unsupported optional graph inputs: '+str(tuple(inputs)))
        if not {'input_ids','input','x'}&inputs.keys():raise ValueError('Missing optional grapheme input')
        from session_control import GuardedSession
        graph=GuardedSession(base,self.owner) if self.owner is not None else base
        return graph,inputs

    def _prepared_key(self,text,character):
        value=orthography.fold_text(text,self.config.get('lang_code')).strip()
        if len(value)==1:
            if value.isdecimal():value=str(unicodedata.decimal(value))
            elif not character:return None
            return f'u{ord(value):04X}'
        if not character and value.isdecimal():
            number=''.join(str(unicodedata.decimal(char)) for char in value)
            if not number.startswith('0'):return 'n'+number
        return None

    def audio(self,text,character,requested_speed):
        sample=self.prepared.get(self._prepared_key(text,character))
        if sample is not None:
            return sample.astype(np.float32)/32768.,self.sample_rate,1.
        ids=grapheme_ids(self.config,text,self.navigation,character)
        graph,inputs=self.model.get(self.owner)
        inference=self.config.get('inference',{})
        source_speed=requested_speed if inputs.keys()&{'length_scale','speaking_rate','scales'} else 1.
        floats={'noise_scale':inference.get('noise_scale',.667),'noise_scale_duration':inference.get('noise_w',.8),
                'noise_scale_w':inference.get('noise_w',.8),'length_scale':1./source_speed,'speaking_rate':source_speed}
        feed={}
        for name,(_dtype,shape) in inputs.items():
            if name in ('input_ids','input','x'):feed[name]=ids
            elif name=='attention_mask':feed[name]=np.ones_like(ids)
            elif name in ('input_lengths','x_length'):feed[name]=np.array([ids.shape[-1]],dtype=np.int64)
            elif name=='scales':
                feed[name]=np.array([floats['noise_scale'],floats['length_scale'],floats['noise_scale_duration']],dtype=np.float32)
            else:
                feed[name]=np.full([1]*len(shape),floats[name],dtype=np.float32)
        wave=np.asarray(graph.run(None,feed)[0],dtype=np.float32).reshape(-1)
        if not wave.size or not np.isfinite(wave).all():raise ValueError('Invalid waveform from optional language data')
        return wave,self.sample_rate,source_speed
