"""Galician native voice carrier supplied as an optional, locally installed pack."""
from functools import lru_cache
from pathlib import Path
import json
import re
import unicodedata
AVAILABLE={'gl'}
DIGITS=('cero','un','dous','tres','catro','cinco','seis','sete','oito','nove')
TEENS=('dez','once','doce','trece','catorce','quince','dezaseis','dezasete','dezaoito','dezanove')
TENS=('','','vinte','trinta','corenta','cincuenta','sesenta','setenta','oitenta','noventa')
HUNDREDS=('','cento','douscentos','trescentos','catrocentos','cincocentos','seiscentos','setecentos','oitocentos','novecentos')
LETTERS=dict(zip('abcdefghijklmnopqrstuvwxyz',('a','be','ce','de','e','efe','gue','hache','i','iota','ka','ele','eme','ene','o','pe','cu','erre','ese','te','u','uve','uve dobre','xe','i grego','ceta')))
LETTERS.update({'ñ':'eñe','á':'a con acento','é':'e con acento','í':'i con acento','ó':'o con acento','ú':'u con acento','ü':'u con diérese',' ':'espazo'})
LETTERS.update({' ': 'espazo', '!': 'pechar exclamación', '%': 'porcento', '&': 'et', '(': 'abrir paréntese', ')': 'pechar paréntese', '*': 'estrela', ',': 'coma', '-': 'guion', '.': 'punto', '/': 'barra', ':': 'dous puntos', ';': 'punto e coma', '?': 'pechar interrogación', '@': 'arroba', '+': 'máis'})

def number(s):
    if len(s)>6 or len(s)>1 and s[0]=='0':return ' '.join(DIGITS[int(k)] for k in s)
    n=int(s)
    if n<10:return DIGITS[n]
    if n<20:return TEENS[n-10]
    if n<100:
        q,r=divmod(n,10);return TENS[q]+(' e '+number(str(r)) if r else '')
    if n==100:return 'cen'
    if n<1000:
        q,r=divmod(n,100);return HUNDREDS[q]+(' '+number(str(r)) if r else '')
    q,r=divmod(n,1000)
    return ('' if q==1 else number(str(q))+' ')+'mil'+(' '+number(str(r)) if r else '')
def normalize(text,character=False):
    s=unicodedata.normalize('NFC',text)
    if character and len(s)==1:s=LETTERS.get(s.casefold(),s)
    s=re.sub(r'[0-9]+',lambda m:number(m[0]),s).lower()
    s=re.sub(r'[<>()[\]"]+','',s)
    s=s.replace(';',',').replace(':',',').replace('-',' ')
    s=s.translate(str.maketrans({'’':"'",'‘':"'",'“':'"','”':'"','—':',','–':'-','…':'...','\t':' ','\r':' ','Ñ':'ñ','ç':'Ç'}))
    return re.sub(r'\s+',' ',s).strip()
class NativeGalician:
    def __init__(self,directory,session_factory=None,owner=None):
        import numpy as np
        self.np=np;folder=Path(directory)
        self.folder=folder
        config=json.loads((folder/'config.json').read_text(encoding='utf8'))
        c=config['characters']
        # This family uses Coqui VitsCharacters, whose fixed-order alphabet
        # is PAD + punctuation + literal characters + BLANK (no BOS/EOS).
        alphabet=[c['pad'],*c['punctuations'],*c['characters'],c['blank']]
        self.ids={ch:i for i,ch in enumerate(alphabet)}
        if len(self.ids)!=config['model_args']['num_chars']:raise ValueError('Galician voice vocabulary differs')
        self.blank=self.ids[c['blank']];self.rate=int(config['audio']['sample_rate'])
        self.scales=np.asarray([config.get('inference_noise_scale',.667),config.get('length_scale',1.),config.get('inference_noise_scale_dp',1.)],np.float32)
        self.path=folder/('model-q8.onnx' if (folder/'model-q8.onnx').is_file() else 'model.onnx')
        if session_factory is None:
            import onnxruntime as ort
            o=ort.SessionOptions();o.intra_op_num_threads=2;o.inter_op_num_threads=1
            o.add_session_config_entry('session.intra_op.allow_spinning','0')
            session_factory=lambda p:ort.InferenceSession(str(p),sess_options=o,providers=['CPUExecutionProvider'])
        if owner is None:
            self.session=session_factory(self.path)
        else:
            from wide_loading import DeferredSession
            self.session=DeferredSession(lambda:session_factory(self.path),owner)
    def audio(self,text,character=False,rate=1.):
        t=normalize(text,character);np=self.np
        symbols=[]
        for c in t:
            i=self.ids.get(c)
            if i is None:i=self.ids.get(c.lower())
            if i is not None:symbols.append(i)
        if not symbols:return np.empty(0,np.float32)
        a=np.full(len(symbols)*2+1,self.blank,np.int64);a[1::2]=symbols
        scales=self.scales.copy();scales[1]/=min(2.5,max(.5,float(rate)))
        out=self.session.run(None,{'input':a[None,:],'input_lengths':np.array([len(a)],np.int64),
            'scales':scales})[0]
        return out.reshape(-1).astype(np.float32,copy=False)
def _folder(code,models):
    if code not in AVAILABLE:raise KeyError(code)
    return Path(models)/'wide_extra'/code
def available(models):
    return {c for c in AVAILABLE if (_folder(c,models)/'source.npy').is_file() and (_folder(c,models)/'config.json').is_file()
            and any((_folder(c,models)/n).is_file() for n in ('model-q8.onnx','model.onnx'))}
@lru_cache(maxsize=2)
def _engine(code,models,owner=None):return NativeGalician(_folder(code,models),owner=owner)
@lru_cache(maxsize=2)
def _short_words(directory):
    import numpy as np
    path=Path(directory)/'short_vowels.npz'
    if not path.is_file():return {}
    with np.load(path,allow_pickle=False) as archive:
        return {k:archive[k].astype(np.float32)/32768. for k in archive.files}

def audio(code,text,character=False,*,models,rate=1.,owner=None):
    """Return (float32 audio, sample rate) in the original native source voice."""
    if owner is not None:owner.check_cancelled()
    folder=_folder(code,models)
    name=normalize(text,character)
    if len(name)==1 and name in 'aeiou':
        samples=_short_words(str(folder.resolve())).get(name)
        if samples is not None:
            if abs(float(rate)-1.)>.015:
                import numpy as np
                from speech_tempo import stream_tempo
                chunks=tuple(stream_tempo((samples,),16000,float(rate)))
                if chunks:samples=np.concatenate(chunks)
            if owner is not None:owner.check_cancelled()
            return samples,16000
    engine=_engine(code,str(Path(models).resolve()),owner)
    return engine.audio(text,character,rate),engine.rate
@lru_cache(maxsize=2)
def source(code,*,models):
    import numpy as np
    vec=np.load(_folder(code,models)/'source.npy',allow_pickle=False)
    if vec.shape!=(1,256,1) or not np.isfinite(vec).all():raise ValueError('Invalid Galician identity')
    vec.setflags(write=False);return vec
