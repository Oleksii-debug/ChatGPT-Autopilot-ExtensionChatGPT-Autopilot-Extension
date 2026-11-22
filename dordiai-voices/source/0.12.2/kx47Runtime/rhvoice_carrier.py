"""Private read-only RHVoice language carrier, independent of the NVDA driver.

Uses the public RHVoice C API (Olga Yakovleva and contributors; see the supplied library license).
The library and language data live inside this add-on; no installed RHVoice
configuration, voice selection, or audio device is accessed.
"""
import ctypes as c
import os
from pathlib import Path
import numpy as np
from converted_voices import resample

class Callbacks(c.Structure):
    _fields_=[(name,c.c_void_p) for name in ('rate','play','mark','wordstart','wordend','sentencestart','sentenceend','audio','done')]
class Init(c.Structure):
    _fields_=[('data',c.c_char_p),('config',c.c_char_p),('resources',c.POINTER(c.c_char_p)),('callbacks',Callbacks),('options',c.c_uint)]
class Params(c.Structure):
    _fields_=[('voice',c.c_char_p),('rate',c.c_double),('pitch',c.c_double),('volume',c.c_double),('relative_rate',c.c_double),('relative_pitch',c.c_double),('relative_volume',c.c_double),('punctuation',c.c_int),('punctuation_list',c.c_char_p),('capitals',c.c_int),('flags',c.c_int)]
RATE=c.CFUNCTYPE(c.c_int,c.c_int,c.c_void_p)
PLAY=c.CFUNCTYPE(c.c_int,c.POINTER(c.c_short),c.c_uint,c.c_void_p)
DONE=c.CFUNCTYPE(None,c.c_void_p)

class SlovakCarrier:
    def __init__(self,folder,owner,voice='Jasietka'):
        self.folder,self.owner=Path(folder),owner
        self.voice=voice.encode('utf8')
        self.clips=[];self.rate=0
        self._dll_directory=os.add_dll_directory(str(self.folder/'lib'))
        self.lib=c.CDLL(str(self.folder/'lib/RHVoice.dll'))
        for name,args,result in [('RHVoice_new_tts_engine',[c.POINTER(Init)],c.c_void_p),('RHVoice_delete_tts_engine',[c.c_void_p],None),('RHVoice_new_message',[c.c_void_p,c.c_char_p,c.c_uint,c.c_int,c.POINTER(Params),c.c_void_p],c.c_void_p),('RHVoice_speak',[c.c_void_p],c.c_int),('RHVoice_delete_message',[c.c_void_p],None)]:
            fn=getattr(self.lib,name);fn.argtypes=args;fn.restype=result
        self.callbacks=[RATE(self.set_rate),PLAY(self.play),DONE(lambda _:None)]
        cb=Callbacks(c.cast(self.callbacks[0],c.c_void_p),c.cast(self.callbacks[1],c.c_void_p),None,None,None,None,None,None,c.cast(self.callbacks[2],c.c_void_p))
        self.resources=(c.c_char_p*3)(str(self.folder/'data').encode(),str(self.folder/'langdata').encode(),None)
        self.engine=self.lib.RHVoice_new_tts_engine(Init(None,str(self.folder/'config').encode(),self.resources,cb,0))
        if not self.engine:raise RuntimeError('Could not initialize the private Slovak pronunciation engine')

    def set_rate(self,value,_):
        self.rate=value;return 1

    def play(self,ptr,size,_):
        event=self.owner.cancel_event
        if event is not None and event.is_set():return 0
        self.clips.append(np.ctypeslib.as_array(ptr,(size,)).copy());return 1

    def synthesize(self,text):
        self.owner.check_cancelled();self.clips.clear()
        encoded=text.encode('utf8');params=Params(self.voice,0,0,0,1,1,1,1,None,1,0)
        message=self.lib.RHVoice_new_message(self.engine,encoded,len(encoded),2 if len(text)==1 else 0,params,None)
        if not message:raise RuntimeError('Slovak message could not be prepared')
        try:
            succeeded=self.lib.RHVoice_speak(message)
            self.owner.check_cancelled()
            if not succeeded or not self.clips:raise RuntimeError('Slovak carrier did not produce speech')
        finally:self.lib.RHVoice_delete_message(message)
        yield resample(np.concatenate(self.clips).astype('float32')/32768,self.rate,24000)

    def close(self):
        if self.engine:self.lib.RHVoice_delete_tts_engine(self.engine);self.engine=None
