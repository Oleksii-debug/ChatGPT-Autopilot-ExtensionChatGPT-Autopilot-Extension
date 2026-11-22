"""Small offline lexical language identifier for unmarked Latin and Cyrillic text."""
from bisect import bisect_left
from functools import lru_cache
from hashlib import blake2b
import gzip
import json
import math
import mmap
from pathlib import Path
import re
import struct
import unicodedata

RESOURCE=Path(__file__).resolve().parent/'models/WideLanguages/wide-profiles.bin'
MAGIC=b'DVLID01\0'
TOKENS=re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*")

def words(text):
    return [v.casefold().replace('’',"'") for v in TOKENS.findall(unicodedata.normalize('NFC',text)) if len(v)<=45]

def features(word):
    stem='^'+word+'$'
    yield 'w'+word
    for n in (3,4):
        yield from ('g'+stem[i:i+n] for i in range(len(stem)-n+1))

@lru_cache(maxsize=8192)
def feature_hash(key):
    return int.from_bytes(blake2b(key.encode('utf8'),digest_size=8).digest(),'little')

class Profiles:
    def __init__(self,path):
        with Path(path).open('rb') as f:self.data=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ)
        if self.data[:8]!=MAGIC:raise ValueError('Incompatible language profiles')
        n,length=struct.unpack_from('<II',self.data,8)
        self.labels=json.loads(self.data[16:16+length])
        off=16+length
        mem=memoryview(self.data)
        self.keys=mem[off:off+8*n].cast('Q');off+=8*n
        self.offset=mem[off:off+4*(n+1)].cast('I');off+=4*(n+1)
        self.rows=mem[off:]
        if self.offset[-1]!=len(self.rows):raise ValueError('Invalid language profile index')
        self.function_words={}
        self.function_codes={}
        helper=Path(path).with_name('wide-functions.json.gz')
        if helper.is_file():
            with gzip.open(helper,'rt',encoding='utf8') as source:
                grammar=json.load(source)
            self.function_codes={code:i for i,code in enumerate(grammar['codes'])}
            self.function_words=grammar['probabilities']

    def grammatical_agreement(self,tokens,candidates):
        allowed=self.function_codes
        if not self.function_words or any(c not in allowed for c in candidates[:2]):return 0.
        known={t for t in tokens if t in self.function_words}
        if len(known)<2:return 0.
        candidates=[c for c in candidates if c in allowed]
        score=dict.fromkeys(candidates,0.)
        for token in known:
            row=self.function_words[token]
            high=max(row[allowed[c]] for c in candidates)
            if high<16*math.log2(.015):continue
            for c in candidates:
                score[c]+=max(-4.5,(row[allowed[c]]-high)/16.)
        order=sorted(candidates,key=score.get,reverse=True)
        if order[0]!=candidates[0]:return 0.
        odds=score[order[0]]-score[order[1]]
        return 1./(1.+2**(-odds)) if odds>=2.75 else 0.

    def score(self,tokens,script):
        allowed={i for i,(_,scripts) in enumerate(self.labels) if script in scripts}
        scores=[0.0]*len(self.labels)
        word_support=[0]*len(scores)
        seen_grams=[0]*len(scores)
        matching=0
        for token in set(tokens):
            local={}
            whole={}
            for feature in set(features(token)):
                key=feature_hash(feature)
                idx=bisect_left(self.keys,key)
                if idx==len(self.keys) or self.keys[idx]!=key:continue
                exact=feature.startswith('w')
                for pos in range(self.offset[idx],self.offset[idx+1],2):
                    i=self.rows[pos]
                    if i not in allowed:continue
                    weight=self.rows[pos+1]/20.
                    if exact:whole[i]=weight
                    else:local[i]=local.get(i,0.)+weight
            if local or whole:matching+=1
            norm=max(1.,(len(token)+1)**.60)
            for i in local.keys()|whole.keys():
                scores[i]+=min(12.,local.get(i,0.)/norm)+2.8*whole.get(i,0.)
                if i in whole:word_support[i]+=1
                if i in local:seen_grams[i]+=1
        leaders=sorted(allowed,key=scores.__getitem__,reverse=True)
        if len(leaders)<2:return None,0.
        best,runner=leaders[:2]
        first,second=scores[best],scores[runner]
        if not first:return None,0.
        margin=first-second
        separation=margin/max(14.,first)
        support=word_support[best]
        token_count=len(set(tokens))
        if token_count==1 and (len(tokens[0])<4 or (support==0 and len(tokens[0])<7)):return None,0.
        if matching==0:return None,0.
        certainty=1.-math.exp(-margin/(5.8 if token_count>1 else 8.))
        certainty*=min(1.,separation/.35)
        if token_count==1 and support==0:certainty*=.88
        if token_count>=3 and seen_grams[best]<2:certainty*=.75
        if token_count>=2 and certainty<.95:
            ranked=[self.labels[i][0] for i in leaders[:6]]
            certainty=max(certainty,self.grammatical_agreement(tokens,ranked))
        return self.labels[best][0],max(0.,min(1.,certainty))

@lru_cache(maxsize=1)
def _model():
    try:return Profiles(RESOURCE)
    except (OSError,ValueError,IndexError,struct.error):return None

@lru_cache(maxsize=768)
def _predict(tokens,script):
    model=_model()
    if model is None:return None,0.
    return model.score(tokens,script)

def predict(text,script):
    """Return the strongest language plus its relative evidence on a 0..1 scale."""
    if script not in ('latin','cyrillic') or not text:return None,0.
    tokens=words(text[:1200])[:48]
    if not tokens:return None,0.
    return _predict(tuple(tokens),script)

