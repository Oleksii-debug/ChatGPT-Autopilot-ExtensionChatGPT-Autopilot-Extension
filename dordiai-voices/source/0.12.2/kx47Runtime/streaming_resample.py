"""Stateful polyphase conversion with the same alignment as offline resample."""
import numpy as np
from converted_voices import _resample_kernel

class Resampler:
    def __init__(self, source, target):
        self.table,self.up,self.down,self.radius=_resample_kernel(source,target)
        self.width=self.table.shape[1]
        self.buffer=np.empty(0,dtype=np.float32)
        self.offset=self.seen=self.produced=0

    def feed(self, block, final=False):
        self.buffer=np.concatenate((self.buffer,np.asarray(block,dtype=np.float32)))
        self.seen+=len(block)
        count=(self.seen*self.up+(self.down-1 if final else self.down-1-self.radius))//self.down
        count=max(self.produced,count)
        if count==self.produced:
            return np.empty(0,dtype=np.float32)
        steps=np.arange(self.produced,count,dtype=np.int64)*self.down+self.radius
        indexes=steps[:,None]//self.up-np.arange(self.width)
        valid=(indexes>=self.offset)&(indexes<self.seen)
        local=np.clip(indexes-self.offset,0,max(0,self.buffer.size-1))
        audio=np.sum(np.where(valid,self.buffer[local],0)*self.table[steps%self.up],axis=1,dtype=np.float32)
        self.produced=count
        needed=max(0,(count*self.down+self.radius)//self.up-(self.width-1))
        remove=min(len(self.buffer),max(0,needed-self.offset))
        self.buffer=self.buffer[remove:]
        self.offset+=remove
        return audio

def stream_resample(chunks, source, target):
    if source==target:
        yield from chunks
        return
    state=Resampler(source,target)
    for block in chunks:
        out=state.feed(block)
        if len(out):
            yield out
    tail=state.feed(np.empty(0,dtype=np.float32),final=True)
    if len(tail):
        yield tail
