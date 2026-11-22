"""Eight source-bounded Tetun Dili lexical phone plans, no foreign text frontend.

Unmarked stress homographs are ambiguous and stop. Only source-listed complete
forms are accepted; no generated suffixes, ordinary letter names, numeric rules
or guessed Portuguese spelling. Existing model IDs are checked, never added.
Whether the original model learned their native phonetic meanings is unverified.
"""
from dataclasses import dataclass,asdict
from hashlib import sha256
import json
from pathlib import Path
import unicodedata

FACTS=Path(__file__).with_name('tetun_joao_native_facts.json')
FACTS_SHA256='e9ecd89510c709e6c3b28ca1f87c93c611b91de32daa67a9aeb82d88316079dc'

class UnsupportedTetunInput(ValueError):pass
class AmbiguousTetunStress(UnsupportedTetunInput):pass

@dataclass(frozen=True)
class Word:
    input:str
    annotated_word:str
    gloss:str
    phone_tokens:tuple
    stress_syllable:int
    selected_final_lengthening:bool
    source_printed_page:int
    unvalidated_acoustic_constraints:tuple

    def describe(self):
        return {**asdict(self),'language':'tdt','primary_doi':'10.15144/PL-528','source_facts_sha256':FACTS_SHA256,
                'native_sound_meaning_confirmed_in_carrier':False,'ordinary_character_name':False,
                'product_integrated':False,'language_inventory_increment':0}


def facts():
    raw=FACTS.read_bytes()
    if sha256(raw).hexdigest()!=FACTS_SHA256:raise UnsupportedTetunInput('Pinned primary lexical facts changed')
    value=json.loads(raw)
    if value.get('language')!='tdt' or value.get('ordinary_names_ready') is not False:
        raise UnsupportedTetunInput('Wrong native variety/name-readiness contract')
    return value


def plain(value):
    return ''.join(c for c in unicodedata.normalize('NFD',value) if c!='\u0301')


def word(text):
    if not isinstance(text,str) or not text or len(text)>64:raise UnsupportedTetunInput('Expected one bounded native word')
    normalized=unicodedata.normalize('NFC',text.casefold())
    raw=unicodedata.normalize('NFD',normalized)
    if any(c not in 'abcdefghijklmnopqrstuvwxyz\u0301' for c in raw) or raw.count('\u0301')>1:
        raise UnsupportedTetunInput('Unestablished spelling/annotation; no foreign text fallback')
    source=facts();matches=[e for e in source['entries'] if plain(e['annotated_word'])==plain(normalized)]
    if not matches:raise UnsupportedTetunInput('Native complete word is outside the finite primary lexicon')
    if '\u0301' in raw:
        matches=[e for e in matches if e['annotated_word']==normalized]
        if not matches:raise UnsupportedTetunInput('Accent conflicts with the exact primary lexical form')
    if len(matches)>1:raise AmbiguousTetunStress('Unmarked native stress homograph requires an explicit source-listed accent')
    entry=matches[0]
    constraints=['Surface aspiration/release and native identity of every token require acoustic/listener validation.']
    if entry['phone_tokens'][-1] in ('p','t','k'):constraints.append('Final voiceless stop generally unreleased in this source; no dedicated release token is silently invented.')
    return Word(text,entry['annotated_word'],entry['gloss'],tuple(entry['phone_tokens']),entry['stress_syllable'],
                entry['selected_final_lengthening'],entry['source_printed_page'],tuple(constraints))


def token_ids(value,config):
    """Use original Piper BOS/PAD/EOS schema; require every existing exact token."""
    if not isinstance(value,Word):raise TypeError('Expected own primary native lexical plan')
    table=config.get('phoneme_id_map');size=config.get('num_symbols')
    if not isinstance(table,dict) or type(size) is not int or size<1:raise UnsupportedTetunInput('Original token table is invalid')
    tokens=('^','_',*value.phone_tokens,'$')
    for token in tokens:
        ids=table.get(token)
        if (not isinstance(ids,list) or not ids or any(type(x) is not int or not 0<=x<size for x in ids)):
            raise UnsupportedTetunInput('Original model lacks an exact required token; do not add untrained IDs: '+repr(token))
    output=[*table['^'],*table['_']]
    for token in value.phone_tokens:output.extend(table[token]);output.extend(table['_'])
    output.extend(table['$'])
    return output


def ordinary_character_name(glyph):
    raise LookupError('Ordinary source-backed Tetun alphabet/symbol names are outside this lexical phone probe')
