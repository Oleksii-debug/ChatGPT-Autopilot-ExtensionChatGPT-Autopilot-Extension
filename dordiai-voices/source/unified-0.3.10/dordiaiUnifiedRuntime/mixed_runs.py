"""Find confident spelling changes within one Latin-script sentence; keep shared words in context."""
import re
from language_words import evidence

WORD=re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*",re.UNICODE)

def lexical_runs(sentence,default):
    words=list(WORD.finditer(sentence))
    anchors=[]
    for i,m in enumerate(words):
        code,known,scores=evidence(m.group())
        if code and len(m.group())>=3 and code not in ('uk','ru'):
            anchors.append((i,code))
    if len({c for _,c in anchors})<2:
        return [(default,sentence)]
    labels=[]
    right=0
    for index,m in enumerate(words):
        while right<len(anchors) and anchors[right][0]<index:right+=1
        before=anchors[right-1] if right else None
        after=anchors[right] if right<len(anchors) else None
        if before and after and before[1]!=after[1] and after[0]!=index:
            scores={c:v for v,c in evidence(m.group())[2]}
            delta=scores.get(after[1],0)-scores.get(before[1],0)
            pick=after if delta>65 else before if delta< -65 else min((before,after),key=lambda p:abs(p[0]-index))
        else:
            pick=after if before is None or after and after[0]==index else before
        labels.append(pick[1])
    result=[]
    start=0
    for index in range(1,len(words)):
        if labels[index]!=labels[index-1]:
            boundary=words[index].start()
            result.append((labels[index-1],sentence[start:boundary].strip()))
            start=boundary
    result.append((labels[-1],sentence[start:].strip()))
    return result
