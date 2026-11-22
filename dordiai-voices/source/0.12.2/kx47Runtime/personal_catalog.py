"""Discover explicitly prepared local language data without loading a model in NVDA."""
from hashlib import file_digest
from collections import Counter
from functools import lru_cache
import json
import os
from pathlib import Path
import re
import unicodedata
from threading import RLock
from time import monotonic
import importlib.util as _import_util
_spec=_import_util.spec_from_file_location('_dordiai_personal_orthography',Path(__file__).with_name('personal_orthography.py'))
orthography=_import_util.module_from_spec(_spec)
_spec.loader.exec_module(orthography)

DEFAULT=Path('D:/Синтезатор мовлення KX-47/Особисті мовні моделі')
REQUIRED={'model.onnx','config.json','source.npy','LICENSE.txt','NOTICE.txt'}
_lock=RLock()
_checked=-10.
_stamp=None
_entries={}


def _directory():
    override=os.environ.get('DORDIAI_PERSONAL_LANGUAGE_DIR')
    path=Path(override) if override else DEFAULT
    if not path.is_absolute() or path.drive.startswith('\\\\'):
        return None
    if os.name=='nt':
        import ctypes as ct
        if ct.windll.kernel32.GetDriveTypeW(str(path.anchor)) not in (2,3,6):
            return None
    return path


def _entries_from(root):
    raw=(root/'languages.json').read_bytes()
    if len(raw)>1024*1024:raise ValueError('Invalid optional language catalog size')
    doc=json.loads(raw)
    if not isinstance(doc,dict) or doc.get('format')!=1 or not isinstance(doc.get('languages'),dict):
        raise ValueError('Unsupported optional language catalog')
    entries={}
    for code,row in doc['languages'].items():
        if not re.fullmatch('[a-z]{2,3}(?:-[a-z0-9]{2,8})?',code) or not isinstance(row,dict):continue
        if row.get('backend')!='mms-graphemes':continue
        name=row.get('name');sample=row.get('sample');hashes=row.get('files');sizes=row.get('sizes',{})
        if not isinstance(name,str) or not 0<len(name)<=100 or not isinstance(sample,str) or not 0<len(sample)<=2048:continue
        if not isinstance(hashes,dict) or not REQUIRED<=hashes.keys() or not isinstance(sizes,dict):continue
        directory=(root/code).resolve()
        if directory.parent!=root:continue
        for filename,expected in hashes.items():
            if (not isinstance(filename,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*',filename)
                    or not isinstance(expected,str) or not re.fullmatch('[a-fA-F0-9]{64}',expected)):break
            path=(directory/filename).resolve()
            if path.parent!=directory or not path.is_file():break
            size=sizes.get(filename)
            if size is not None and size!=path.stat().st_size:break
        else:
            letters=[unicodedata.name(c,'') for c in sample if c.isalpha()]
            script='cyrillic' if sum(x.startswith('CYRILLIC') for x in letters)>len(letters)/2 else 'latin'
            entries[code]=dict(name=name,voice='personal:'+code,backend='mms-graphemes',sample=sample,script=script,
                               directory=str(directory),files=hashes,source='source.npy')
    return entries


def discover(force=False):
    global _checked,_stamp,_entries
    with _lock:
        now=monotonic()
        if not force and now-_checked<1.:return _entries
        _checked=now
        try:
            path=_directory()
            if path is None:
                _entries={};_stamp=None
                return _entries
            root=path.resolve()
            index=root/'languages.json'
            stat=index.stat()
            if stat.st_size>1024*1024:raise ValueError('Invalid optional catalog size')
            stamp=(str(root),stat.st_mtime_ns,stat.st_size)
            if force or stamp!=_stamp:
                result=_entries_from(root)
                _entries=result;_stamp=stamp
        except (OSError,ValueError,TypeError):
            _entries={};_stamp=None
        return _entries


def verified_file(entry,filename):
    """Read the large acoustic file only in the speech worker at first use."""
    expected=entry['files'][filename]
    directory=Path(entry['directory'])
    path=(directory/filename).resolve()
    if path.parent!=directory:raise ValueError('Optional speech data moved outside its folder')
    with path.open('rb') as stream:actual=file_digest(stream,'sha256').hexdigest()
    if actual!=expected.lower():raise ValueError('Optional language data has changed: '+filename)
    return path


@lru_cache(maxsize=12)
def _vocabulary(directory,digest):
    path=verified_file({'directory':directory,'files':{'identify.json':digest}},'identify.json')
    if path.stat().st_size>1024*1024:return frozenset()
    items=json.loads(path.read_bytes())
    if not isinstance(items,list):return frozenset()
    return frozenset(word for word in items if isinstance(word,str) and 4<=len(word)<=80)


def detect_phrase(text,script,entries):
    tokens=set(re.findall(r"[^\W\d_]{3,}",unicodedata.normalize('NFC',text).casefold()))
    if len(tokens)<2:return None
    scores=Counter()
    for code,entry in entries.items():
        digest=entry['files'].get('identify.json')
        if not digest or entry['script']!=script:continue
        try:vocabulary=_vocabulary(entry['directory'],digest)
        except (OSError,ValueError,TypeError):continue
        matching=tokens
        if code=='gag':
            matching=set(re.findall(r"[^\W\d_]{3,}",orthography.fold_text(text,code)))
        scores[code]=sum(word in vocabulary for word in matching)
    if not scores:return None
    top=scores.most_common(2)
    code,hits=top[0]
    runner_up=top[1][1] if len(top)>1 else 0
    return code if hits>=2 and hits-runner_up>=2 and hits/len(tokens)>=.30 else None
