"""Pass a short list of confidently identified foreign words through one batched acoustic call."""
import re

_WORD=re.compile(r"[^\W\d_]+(?:[-’'][^\W\d_]+)*",re.UNICODE)

def word_batch(runs):
    if not 3<=len(runs)<=8 or len({code for code,_ in runs})<3:
        return None
    if any(len(_WORD.findall(text))!=1 or any(c.isdecimal() for c in text) for _,text in runs):
        return None
    if sum(len(text) for _,text in runs)>100:
        return None
    return tuple(runs)

def synthesize(carrier,runs,tempo):
    import numpy as np
    from converted_voices import resample
    from supertonic_helpers import Style
    from voice_delivery import trim_source_padding
    carrier.owner.check_cancelled()
    engine,style=carrier.engine
    engine.text_processor.append_terminal_period=False
    codes,words=zip(*runs)
    conditioning=Style(np.repeat(style.ttl,len(runs),axis=0),np.repeat(style.dp,len(runs),axis=0))
    wave,durations=engine._infer(list(words),list(codes),conditioning,int(carrier.settings.get('steps',8)),tempo)
    result=[]
    for i,(output,duration) in enumerate(zip(wave,np.ravel(durations))):
        carrier.owner.check_cancelled()
        sound=resample(np.ravel(output)[:int(duration*engine.sample_rate)],engine.sample_rate,24000)
        if sound.size<128 or np.max(np.abs(sound))<.001:
            return ()
        punctuation=r"[.!?…,:;][»”’\"')\]]*$"
        previous_ends=not i or re.search(punctuation,words[i-1].rstrip())
        next_ends=i==len(words)-1 or re.search(punctuation,words[i].rstrip())
        result.append(trim_source_padding(sound,onset_margin=.08 if previous_ends else .018,
                                          tail_margin=.10 if next_ends else .022))
    return tuple(result)
