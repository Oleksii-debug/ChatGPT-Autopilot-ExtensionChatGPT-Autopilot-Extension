"""Stable letter units rendered in the selected speaker's own acoustic context."""
import numpy as np
import json
from functools import lru_cache
from pathlib import Path
from speech_tempo import change_tempo

SPECIAL_NAMES = frozenset(('ес', 'і', 'ї'))

@lru_cache(maxsize=4)
def _alignments(references):
    path=Path(references)/'spelling_alignment.json'
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}

def render_letter(engine, profile, name, speed=1.0, *, alignment=None):
    from ipa_uk import ipa
    from ukrainian_stress import accent_text
    model=engine.holos
    alignment=alignment if alignment is not None else _alignments(str(engine.references)).get(profile,{})
    if name=='і':
        prefix=ipa(accent_text('Починаємо читати.'))+' nʲˈ'
        phones=prefix+'is. '+ipa(accent_text('Наступне слово.'))
        encoded=model._encode(phones,engine._holos_style(profile),1.0)
        index=len(model.tokenizer.encode(prefix))+1
        # Duration boundaries do not mark acoustic transitions exactly. The
        # steady /i/ in this carrier precedes its token boundary by ~120 ms.
        offset=int(alignment.get('i_offset_ms',120))
        if not 30<=offset<=150: raise ValueError('Invalid vowel alignment')
        start=int(encoded.durations[:index].sum())*model.samples_per_frame-offset*24
        length=1920
    elif name=='ї':
        # A bare /ji/ is too short for the model's utterance context. Preserve
        # its consonant onset and vowel from the complete spoken letter name.
        carrier=alignment.get('yi_carrier','letter')
        carriers={'letter':'Це літера ї.','word':'Починаємо читати. Їсти.'}
        if carrier not in carriers: raise ValueError('Invalid yi carrier')
        phones=ipa(accent_text(carriers[carrier]))
        prefix=phones.rsplit('ji',1)[0]
        encoded=model._encode(phones,engine._holos_style(profile),1.0)
        begin=len(model.tokenizer.encode(prefix))+1
        end=begin+len(model.tokenizer.encode('ji'))
        offset=int(alignment.get('yi_offset_ms',100))
        if not 0<=offset<=150: raise ValueError('Invalid yi alignment')
        tail=int(alignment.get('yi_tail_ms',25))
        if not -100<=tail<=50: raise ValueError('Invalid yi tail')
        start=max(0,int(encoded.durations[:begin].sum())*model.samples_per_frame-offset*24)
        length=int(encoded.durations[:end].sum())*model.samples_per_frame+tail*24-start
    elif name=='ес':
        prefix=ipa(accent_text('Це літера.'))+' '
        target='ˈɛs'
        encoded=model._encode(prefix+target+'.',engine._holos_style(profile),1.0)
        begin=len(model.tokenizer.encode(prefix))+1
        end=len(model.tokenizer.encode(prefix+target))+1
        start=max(0,int(encoded.durations[:begin].sum())*model.samples_per_frame-480)
        length=int(encoded.durations[:end].sum())*model.samples_per_frame+720-start
    else:
        raise ValueError('Unsupported contextual letter')
    waveform=np.concatenate(list(model._decode_windows(encoded,40)))
    clip=waveform[start:start+length].copy()
    if len(clip)!=length or not np.isfinite(clip).all():
        raise ValueError('Invalid contextual letter boundaries')
    if name in ('і','ї'):
        target_samples=6000 if name=='і' else 9600
        clip=change_tempo(clip,24000,len(clip)/target_samples)
        # Sonic's end-of-stream rounding depends on the voice's pitch period.
        # Keep the same quarter-second unit for every identity at base rate.
        clip=np.pad(clip,(0,max(0,target_samples-len(clip))))[:target_samples]
    fade=min(120,len(clip)//4)
    clip[:fade]*=np.linspace(0,1,fade,dtype=np.float32)
    clip[-fade:]*=np.linspace(1,0,fade,dtype=np.float32)
    return change_tempo(clip,24000,speed)
