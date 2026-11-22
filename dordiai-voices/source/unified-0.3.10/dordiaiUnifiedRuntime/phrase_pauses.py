"""Limit model-invented silence only in phrases without internal punctuation."""
import re
import numpy as np

def phrase_audio(chunks,text,speed,controls=None,rate=24000):
    body=re.sub(r'''[\s.,!?;:…»”"')\]}]+$''','',text)
    volume=(controls or {}).get('volume',100)/100
    punctuation = re.sub(r'(?<=\d)[.,](?=\d)', '', body)
    if re.search(r'[.,!?;:…—]',punctuation) or volume<=0:
        yield from chunks
        return
    width=rate//100
    maximum=round(max(.12,.24/max(speed,.5))*100)
    threshold=.0025*volume
    pending=np.empty(0,np.float32);quiet=0
    try:
        for chunk in chunks:
            joined=np.concatenate((pending,chunk)) if pending.size else chunk
            count=len(joined)//width
            keep=[]
            for frame in joined[:count*width].reshape(count,width):
                if float(np.max(np.abs(frame)))<=threshold:
                    if quiet<maximum:keep.append(frame)
                    quiet+=1
                else:
                    quiet=0;keep.append(frame)
            pending=joined[count*width:].copy()
            if keep:yield np.concatenate(keep)
        if pending.size and (quiet<maximum or float(np.max(np.abs(pending)))>threshold):yield pending
    finally:
        close=getattr(chunks,'close',None)
        if close is not None:close()
