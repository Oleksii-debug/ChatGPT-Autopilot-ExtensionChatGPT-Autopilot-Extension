"""Bounded Hiri Motu research phonology, separate from Motu/meu and all carriers.

Known lexical stress does not resolve every vowel group. Acute marks specify
stress, a dot a syllable boundary, a hyphen a morpheme boundary, and U+032F an
explicit nonsyllabic vowel. These are disclosed research annotations. Unknown
stress/grouping/lateral/loan cases remain analyzable but never renderable.
No ordinary letter names, numeric grammar or foreign spelling engine is supplied.
"""
from dataclasses import asdict,dataclass,replace
from functools import lru_cache
from hashlib import sha256
import json
from pathlib import Path
import re
import unicodedata

LANGUAGE='ho'
ISO639_3='hmo'
NOT_ALIAS_OF='meu'
SOURCES=Path(__file__).with_name('hiri_motu_sources.json')
SOURCES_SHA256='55231b82c64850daac6921666386c37b3c43151b7082219d21587d83809a2f30'
MAX_WORD=128
MAX_TEXT=4096
MAX_WORDS=256
ACUTE='\u0301'
OFFGLIDE='\u032f'
VOWELS=frozenset('aeiou')
CONSONANTS=frozenset('bdgptkfshvmnrl')
_ALLOWED_SEPARATORS=frozenset(' \t\n\r.,!?:;()—–')
_WORD=re.compile(r'[A-Za-z\u00c0-\u024f\u0300-\u036f]+(?:[.-][A-Za-z\u00c0-\u024f\u0300-\u036f]+)*')

class UnsupportedHiriMotu(ValueError):
    def __init__(self,message,*,reasons=()):
        super().__init__(message)
        self.reasons=tuple(reasons)

@dataclass(frozen=True)
class Phone:
    symbol:str
    grapheme:str
    kind:str
    place:str
    voiced:bool
    aspirated:bool=False
    labialised:bool=False
    nonsyllabic:bool=False

@dataclass(frozen=True)
class Word:
    text:str
    spelling:str
    phones:tuple
    nuclei:tuple
    primary_stress_phone:int|None
    primary_stress_syllable:int|None
    explicit_syllable_boundaries:tuple
    morpheme_boundaries:tuple
    stress_evidence:str
    source_ids:tuple
    unresolved:tuple
    warnings:tuple

    @property
    def strictly_renderable(self):return not self.unresolved

    @property
    def ipa_hypothesis(self):
        # An unresolved plan remains explicitly marked as a hypothesis. Never
        # expose this diagnostic string as ordinary character/letter names.
        starts={group[0] for group in self.nuclei}
        stress=self.primary_stress_phone
        onset=stress
        if stress is not None and stress and self.phones[stress-1].kind!='vowel':onset=stress-1
        result=[]
        for index,phone in enumerate(self.phones):
            if index==onset:result.append('ˈ')
            elif index in starts and index and self.phones[index-1].kind=='vowel':result.append('.')
            result.append(phone.symbol+('̯' if phone.nonsyllabic else ''))
        return ''.join(result)

    def describe(self):
        return {**asdict(self),'language':LANGUAGE,'iso639_3':ISO639_3,
                'not_alias_of':NOT_ALIAS_OF,'ipa_hypothesis':self.ipa_hypothesis,
                'strictly_renderable':self.strictly_renderable,
                'ordinary_letter_names':False,'acoustic_pronunciation_verified':False}


def _checked(text,max_size):
    if not isinstance(text,str):raise TypeError('Native text must be a string')
    if not text or len(text)>max_size:raise UnsupportedHiriMotu('Empty or oversized native input')
    return unicodedata.normalize('NFC',text)


def _strip_marks(text):
    return ''.join(c for c in unicodedata.normalize('NFD',text.lower()) if not unicodedata.combining(c) and c not in '.-')


def source_facts():
    raw=SOURCES.read_bytes()
    if sha256(raw).hexdigest()!=SOURCES_SHA256:raise UnsupportedHiriMotu('Pinned Hiri Motu linguistic facts changed')
    document=json.loads(raw)
    if (document.get('language')!='ho' or document.get('not_alias_of')!='meu'
            or document.get('ordinary_letter_names_ready') is not False):
        raise UnsupportedHiriMotu('Wrong language standard or misleading letter-name readiness')
    return document


@lru_cache(maxsize=1)
def _stress_lexicon():
    result={}
    for row in source_facts()['stress_lexicon']:
        decomposed=unicodedata.normalize('NFD',row['form'].lower())
        if decomposed.count(ACUTE)!=1:raise UnsupportedHiriMotu('Curated single-stress entry is not singular')
        vowel=-1;accent=None
        for char in decomposed:
            if char in VOWELS:vowel+=1
            elif char==ACUTE:accent=vowel
        key=_strip_marks(row['form'])
        if key in result:raise UnsupportedHiriMotu('Conflicting lexical stress identity')
        result[key]={**row,'stress_vowel':accent}
    return result


def _phone(grapheme):
    if grapheme in VOWELS:return Phone(grapheme,grapheme,'vowel','native-five-vowel',True)
    if grapheme=='gw':return Phone('gʷ','gw','stop','velar',True,labialised=True)
    if grapheme in 'bdgptk':
        return Phone(grapheme,grapheme,'stop',{'b':'bilabial','p':'bilabial','d':'dental-alveolar','t':'dental-alveolar','g':'velar','k':'velar'}[grapheme],grapheme in 'bdg',aspirated=False)
    if grapheme in 'mn':return Phone(grapheme,grapheme,'nasal','bilabial' if grapheme=='m' else 'dental-alveolar',True)
    if grapheme=='r':return Phone('ɾ','r','flap','dental-alveolar',True)
    if grapheme=='l':return Phone('l','l','lateral','dental-alveolar',True)
    if grapheme=='v':return Phone('β','v','fricative','bilabial',True)
    if grapheme in 'fsh':return Phone(grapheme,grapheme,'fricative',{'f':'labiodental','s':'dental-alveolar','h':'glottal'}[grapheme],False)
    raise UnsupportedHiriMotu('Unsupported native grapheme '+repr(grapheme))


def word(text):
    original=_checked(text,MAX_WORD)
    chars=unicodedata.normalize('NFD',original.lower())
    phones=[];acute=None;dots=[];morph=[];i=0
    while i<len(chars):
        char=chars[i]
        if char in '.-':
            if not phones or i+1==len(chars) or chars[i-1] in '.-':
                raise UnsupportedHiriMotu('Empty annotated syllable/morpheme domain')
            (dots if char=='.' else morph).append(len(phones));i+=1;continue
        if char in VOWELS:
            j=i+1;marks=[]
            while j<len(chars) and unicodedata.combining(chars[j]):marks.append(chars[j]);j+=1
            if any(mark not in (ACUTE,OFFGLIDE) for mark in marks) or len(marks)!=len(set(marks)):
                raise UnsupportedHiriMotu('Unsupported or duplicate vowel annotation; no invented length/tone rule')
            if ACUTE in marks:
                if acute is not None:raise UnsupportedHiriMotu('Multiple accents require unestablished compound stress domains')
                if OFFGLIDE in marks:raise UnsupportedHiriMotu('A nonsyllabic offglide cannot be the stress head')
                acute=len(phones)
            phones.append(replace(_phone(char),nonsyllabic=OFFGLIDE in marks));i=j;continue
        if chars.startswith('gw',i):phones.append(_phone('gw'));i+=2;continue
        if char in CONSONANTS:phones.append(_phone(char));i+=1;continue
        raise UnsupportedHiriMotu('Unsupported native unit '+repr(char))
    if not phones or phones[-1].kind!='vowel':raise UnsupportedHiriMotu('Unsupported closed syllable or nonvocalic native word')
    if any(a.kind!='vowel' and b.kind!='vowel' for a,b in zip(phones,phones[1:])):
        raise UnsupportedHiriMotu('Unsupported consonant cluster; gw is one explicitly labialised phone')
    vowels=[i for i,p in enumerate(phones) if p.kind=='vowel']
    if not vowels:raise UnsupportedHiriMotu('A native word requires a vocalic nucleus')
    spelling=_strip_marks(original);facts=source_facts();lexical=_stress_lexicon().get(spelling)
    warnings=['Native-listener and acoustic validation pending; selected 1974-course realization is not every dialect.']
    unresolved=[];sources=['D24-1974:printed2','C40-1977:printed769-771']
    # Retain one exact lexical correspondence; never merge arbitrary ao.
    override=facts['lexical_segment_overrides'].get(spelling)
    if override:
        expected=override['phone_symbols']
        if len(expected)!=len(phones):raise UnsupportedHiriMotu('Lexical segment override changed shape')
        phones=[replace(p,symbol=symbol) for p,symbol in zip(phones,expected)]
        sources.append(override['source']);warnings.append('Exact source-backed lao/lau segment correspondence, not an ao replacement rule.')
    saved_morph=facts['morpheme_boundaries'].get(spelling)
    if saved_morph:
        morph=sorted(set(morph)|set(saved_morph['phone_offsets']));sources.append(saved_morph['source'])
    if acute is None and lexical:
        acute=vowels[lexical['stress_vowel']];evidence='curated-primary-lexical-stress';sources.append(lexical['source'])
    elif acute is not None:
        if lexical and vowels.index(acute)!=lexical['stress_vowel']:
            raise UnsupportedHiriMotu('Explicit accent conflicts with this selected source-backed lexical form')
        evidence='explicit-caller-stress-confirmed-by-primary' if lexical else 'explicit-caller-stress-unverified-word'
        if lexical:sources.append(lexical['source'])
        else:warnings.append('Caller supplied stress; lexical language membership has not been established.')
    else:
        evidence='unresolved';unresolved.append('lexical-stress-unresolved')
    if any(p.grapheme=='l' for p in phones) and spelling not in facts['lateral_exceptions']:
        unresolved.append('written-l-realization-unverified')
    if any(p.grapheme=='f' for p in phones):unresolved.append('loanword-phonology-unverified')
    groups=[]
    for index in vowels:
        phone=phones[index]
        if phone.nonsyllabic:
            if (not groups or index!=groups[-1][-1]+1 or index in dots or index in morph
                    or phones[groups[-1][0]].symbol==phone.symbol):
                raise UnsupportedHiriMotu('Offglide needs a distinct adjacent vowel in the same explicit domain')
            groups[-1]=groups[-1]+(index,)
        else:groups.append((index,))
    group_kind=lexical.get('syllable_groups') if lexical else None
    if group_kind=='tau-single':
        if dots or morph:raise UnsupportedHiriMotu('Explicit grouping conflicts with source-backed one-syllable tau')
        groups=[tuple(vowels)]
        phones=[replace(p,nonsyllabic=(i==vowels[1])) for i,p in enumerate(phones)]
    elif group_kind=='niu-hiatus':
        if any(p.nonsyllabic for p in phones):raise UnsupportedHiriMotu('Explicit grouping conflicts with source-backed niu hiatus')
    for first,second in zip(vowels,vowels[1:]):
        if second!=first+1:continue
        grouped=any(first in group and second in group for group in groups)
        curated=group_kind in ('tau-single','niu-hiatus')
        separated=second in dots or second in morph
        if not grouped and not curated and not separated:unresolved.append('adjacent-vowel-grouping-unresolved')
        pair=phones[first].symbol+phones[second].symbol
        if pair in ('ae','ao','oe') and second not in morph:
            unresolved.append('native-morpheme-boundary-unresolved')
    # Explicit boundaries cannot create a closed syllable or strand a consonant.
    for boundary in dots+morph:
        if not 0<boundary<len(phones) or phones[boundary-1].kind!='vowel':
            raise UnsupportedHiriMotu('Boundary creates an unsupported closed native domain')
    stress_group=next((i for i,g in enumerate(groups) if acute in g),None) if acute is not None else None
    if acute is not None and phones[acute].nonsyllabic:raise UnsupportedHiriMotu('Stress must belong to a syllabic head')
    return Word(original,spelling,tuple(phones),tuple(groups),acute,stress_group,tuple(dots),tuple(morph),evidence,
                tuple(dict.fromkeys(sources)),tuple(dict.fromkeys(unresolved)),tuple(warnings))


def text_words(text):
    text=_checked(text,MAX_TEXT);result=[];position=0;count=0
    for match in _WORD.finditer(text):
        separator=text[position:match.start()]
        if any(c not in _ALLOWED_SEPARATORS for c in separator):
            raise UnsupportedHiriMotu('Unestablished numeric, symbol or punctuation grammar')
        if separator:result.append(separator)
        result.append(word(match.group()));position=match.end();count+=1
        if count>MAX_WORDS:raise UnsupportedHiriMotu('Too many native words in one bounded plan')
    separator=text[position:]
    if any(c not in _ALLOWED_SEPARATORS for c in separator) or not count:
        raise UnsupportedHiriMotu('No native words or unsupported trailing symbol/number')
    if separator:result.append(separator)
    return tuple(result)


def compile_plan(text):
    """Strict semantic phone plan only; no acoustic or letter-name claims."""
    parts=text_words(text)
    reasons=tuple(dict.fromkeys(reason for part in parts if isinstance(part,Word) for reason in part.unresolved))
    if reasons:raise UnsupportedHiriMotu('Native phonology is unresolved; no foreign/default backoff',reasons=reasons)
    return {'format':'dordiai-hiri-motu-semantic-phone-plan','format_version':1,'language':LANGUAGE,
            'iso639_3':ISO639_3,'not_alias_of':NOT_ALIAS_OF,'source_facts_sha256':SOURCES_SHA256,
            'events':[part.describe() if isinstance(part,Word) else {'separator':part} for part in parts],
            'carrier':'not-established','native_pronunciation_verified':False,'ordinary_letter_names':False,
            'product_integrated':False,'language_inventory_increment':0}


def ordinary_character_name(glyph):
    raise LookupError('Primary ordinary Hiri Motu letter/symbol names are not established; phonemes are not names')
