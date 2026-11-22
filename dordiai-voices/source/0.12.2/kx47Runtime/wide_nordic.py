"""Corroborate uncertain Scandinavian language decisions with local spelling dictionaries."""
from bisect import bisect_left
from functools import lru_cache
from hashlib import blake2b
from pathlib import Path
import math
import mmap
import re
import struct
import unicodedata

CODES=("da","fo","is","nb","nn","sv")
RESOURCE=Path(__file__).resolve().parent/"models/WideLanguages/Nordic/words.bin"


def word_key(text):
    return int.from_bytes(blake2b(text.encode("utf8"),digest_size=8).digest(),"little")


@lru_cache(maxsize=1)
def index():
    with RESOURCE.open("rb") as stream:
        data=mmap.mmap(stream.fileno(),0,access=mmap.ACCESS_READ)
    if data[:8]!=b"DVNORD01":raise ValueError("Invalid Nordic spelling data")
    length=struct.unpack_from("<I",data,8)[0]
    if len(data)!=12+9*length:raise ValueError("Incorrect Nordic spelling index length")
    return memoryview(data)[12:12+8*length].cast("Q"),memoryview(data)[12+8*length:]


@lru_cache(maxsize=1536)
def detect(text):
    tokens=set(re.findall(r"[^\W\d_]+",unicodedata.normalize("NFC",text).casefold()))
    if len(tokens)<3:return None,0.,0
    keys,masks=index()
    scores=[0.]*len(CODES)
    hits=0
    for token in tokens:
        if len(token)<2:continue
        key=word_key(token)
        at=bisect_left(keys,key)
        if at>=len(keys) or keys[at]!=key:continue
        mask=masks[at]
        hits+=1
        weight=math.log2(len(CODES)/mask.bit_count())
        for i in range(len(CODES)):
            if mask&(1<<i):scores[i]+=weight
    order=sorted(range(len(CODES)),key=scores.__getitem__,reverse=True)
    margin=scores[order[0]]-scores[order[1]]
    return CODES[order[0]],margin,hits
