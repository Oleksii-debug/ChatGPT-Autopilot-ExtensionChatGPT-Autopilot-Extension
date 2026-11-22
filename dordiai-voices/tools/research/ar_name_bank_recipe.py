"""Noninstallable, append-only ordinary-name bank recipe using existing keys.

No installed bank files are opened for writing. Source/target/file identities are
independent of display names. The optional identity gate is research code only;
existing driver13 does not yet enforce this new recipe manifest.
"""
from __future__ import annotations
from hashlib import sha256
import json
from pathlib import Path
import re
from unicodedata import normalize

MAX_PCM=24000*2*8
PROFILE=re.compile(r'[a-z][a-z0-9_-]{0,63}\Z')
EXCLUDED=frozenset({'kostia','inna','dina','vira','innesa','veronika_classmate','anatolii','veronika'})

def digest(path):
    with Path(path).open('rb') as s:return __import__('hashlib').file_digest(s,'sha256').hexdigest()

def key(language,glyph):
    return sha256((language.lower().replace('_','-')+'\0'+normalize('NFC',glyph).strip().casefold()).encode('utf-8')).hexdigest()[:24]

def validate_profile(profile):
    if not isinstance(profile,str) or not PROFILE.fullmatch(profile) or profile.casefold() in EXCLUDED:raise ValueError('Invalid/excluded bank profile')
    return profile

def json_write(path,value):
    path=Path(path);tmp=path.with_suffix('.writing')
    with tmp.open('x',encoding='utf-8') as s:json.dump(value,s,ensure_ascii=False,indent=2,sort_keys=True);s.write('\n')
    tmp.replace(path)

def validate_pcm(pcm):
    if not isinstance(pcm,bytes) or not 2<=len(pcm)<=MAX_PCM or len(pcm)%2:raise ValueError('Bank requires bounded mono16 PCM at actual24000Hz')
    if not any(pcm):raise ValueError('Digital silence is not an ordinary-name proof')

def new_bank(directory,profile,clips):
    """Existing flat NativeLetterBank schema; AR-char differs from AR-text.

    Each clip is (literal glyph, reviewed ordinary name, genuine 24k PCM).
    Names are provenance, never second unreviewed hash aliases.
    """
    validate_profile(profile);clips=list(clips);directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    index_path=directory/(profile+'.json');audio_path=directory/(profile+'.pcm')
    if index_path.exists() or audio_path.exists():raise FileExistsError('Append-only NEW bank source; refusing an existing bank')
    entries={};facts=[];offset=0
    # Validate whole selected batch before creating either bank file.
    for glyph,name,pcm in clips:
        validate_pcm(pcm)
        if not isinstance(glyph,str) or len(glyph)!=1 or not isinstance(name,str) or not name.strip():raise ValueError('Expected exact ordinary glyph/name')
        k=key('ar-char',glyph)
        if k in entries:raise ValueError('Duplicate ordinary glyph hash')
        entries[k]=[offset,len(pcm)];facts.append({'glyph':glyph,'ordinary_name':name,'key':k,'offset':offset,'size_bytes':len(pcm),'pcm_sha256':sha256(pcm).hexdigest()});offset+=len(pcm)
    if not entries:raise ValueError('Empty bank plan')
    with audio_path.open('xb') as s:
        for _,_,pcm in clips:s.write(pcm)
    json_write(index_path,entries)
    return {'profile':profile,'kind':'ar-char','sample_rate':24000,'channels':1,'sample_width':2,'clips':facts,'index':{'name':index_path.name,'size_bytes':index_path.stat().st_size,'sha256':digest(index_path)},'audio':{'name':audio_path.name,'size_bytes':audio_path.stat().st_size,'sha256':digest(audio_path)}}

class BoundReader:
    """Minimal future14 identity gate around the UNCHANGED NativeLetterBank.

    Caller must also retain the existing driver resource epoch/managed-voice
    guard. Cold file verification is cached by full file signature+expectedSHA.
    The research proof preloads this reader; no production registration occurs.
    """
    def __init__(self,reader,directory,records,target_resolver):
        self.reader,self.directory,self.records,self.target_resolver=reader,Path(directory),records,target_resolver
        self.checked={}
        for profile,row in records.items():
            validate_profile(profile)
            if row.get('profile')!=profile or row.get('sample_rate')!=24000:raise ValueError('Bank recipe profile/rate mismatch')
            for role,suffix in [('index','.json'),('audio','.pcm')]:
                record=row.get(role,{})
                if record.get('name')!=profile+suffix:raise ValueError('Bank filename differs from exact profile role')
            for record in [row['index'],row['audio'],row.get('target_identity',{})]:
                if type(record.get('size_bytes')) is not int or record['size_bytes']<1 or not re.fullmatch('[0-9a-f]{64}',str(record.get('sha256'))):raise ValueError('Invalid exact bank/target identity pin')
    def _verify(self,path,record):
        path=Path(path)
        if path.is_symlink():raise ValueError('Linked prepared bank identity asset')
        s=path.stat();signature=(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,record['sha256'])
        if s.st_size!=record['size_bytes']:raise ValueError('Prepared identity asset size changed')
        if self.checked.get(str(path))!=signature:
            if digest(path)!=record['sha256']:raise ValueError('Prepared identity asset checksum changed')
            self.checked[str(path)]=signature
    def read(self,profile,language,name):
        validate_profile(profile)
        if language!='ar-char' or profile not in self.records:return None
        row=self.records[profile]
        # Do not borrow a clip for an updated target, even under the same ID.
        self._verify(self.target_resolver(profile),row['target_identity'])
        for role in ['index','audio']:self._verify(self.directory/row[role]['name'],row[role])
        result=self.reader.read(profile,language,name)
        # Refuse file/target replacement between verified metadata and actual
        # PCM read. Existing caller resource-epoch check remains mandatory too.
        self._verify(self.target_resolver(profile),row['target_identity'])
        for role in ['index','audio']:self._verify(self.directory/row[role]['name'],row[role])
        return result
