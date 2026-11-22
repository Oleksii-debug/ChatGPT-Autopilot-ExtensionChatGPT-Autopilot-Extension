"""Cheap lexical evidence; ambiguous shared words still need context/defaults."""
from functools import lru_cache
from pathlib import Path
import os,re,unicodedata
from data_registry import REGISTRY

@lru_cache(maxsize=1)
def tables():
    import marisa_trie
    folder=REGISTRY.resource('LanguageWords')
    # Host-side development imports source code separately from staged models.
    native=os.environ.get('DORDIAI_NATIVE_DIRECTORY')
    if not folder.is_dir() and native:folder=Path(native).parent/'models/LanguageWords'
    result={}
    for code in REGISTRY.languages:
        path=folder/(code+'.marisa')
        if path.is_file():
            table=marisa_trie.RecordTrie('<H');table.mmap(str(path));result[code]=table
    return result

@lru_cache(maxsize=4096)
def evidence(word):
    key=unicodedata.normalize('NFKC',word).casefold().replace('’',"'")
    scores=[]
    for code,table in tables().items():
        value=table.get(key)
        if value:scores.append((value[0][0],code))
    scores.sort(reverse=True)
    if not scores or scores[0][0]<350:return None,False,tuple(scores)
    first,code=scores[0]
    margin=first-(scores[1][0] if len(scores)>1 else 0)
    return (code if margin>=75 else None),True,tuple(scores)

def short_language(text):
    words=re.findall(r"[^\W\d_]+(?:['’][^\W\d_]+)*",text,re.UNICODE)
    if not 1<=len(words)<=2:return None
    found=set()
    for word in words:
        code,known,scores=evidence(word)
        if code:found.add(code)
        elif known and any(lang=='en' and value>=scores[0][0]-75 for value,lang in scores):found.add('en')
    return next(iter(found)) if len(found)==1 else None
