"""Breton character input for the Ofis Publik ar Brezhoneg/Breton TTS VITS voice."""
from pathlib import Path
import re
import unicodedata

import numpy as np
import onnxruntime as ort


DIGITS=("mann","unan","daou","tri","pevar","pemp","c'hwec'h","seizh","eizh","nav")
TEENS=("dek","unnek","daouzek","trizek","pevarzek","pemzek","c'hwezek","seitek","triwec'h","naontek")
TENS=("","dek","ugent","tregont","daou-ugent","hanter-kant","tri-ugent","dek ha tri-ugent","pevar-ugent","dek ha pevar-ugent")


def number(n):
    if n<10:return DIGITS[n]
    if n<20:return TEENS[n-10]
    tens,rest=divmod(n,10)
    if n<100:
        if not rest:return TENS[tens]
        if tens in (7,9):return TEENS[rest]+" ha "+TENS[tens-1]
        return DIGITS[rest]+(" warn-ugent" if tens==2 else " ha "+TENS[tens])
    return " ".join(DIGITS[int(x)] for x in str(n))


class BretonCarrier:
    def __init__(self,folder,owner=None):
        path=Path(folder)
        self.tokens={}
        for line in (path/"tokens.txt").read_text(encoding="utf8").splitlines():
            token,identifier=line.rsplit(" ",1)
            self.tokens[token]=int(identifier)
        opt=ort.SessionOptions();opt.intra_op_num_threads=2;opt.inter_op_num_threads=1
        opt.add_session_config_entry("session.intra_op.allow_spinning","0")
        self.graph=ort.InferenceSession(str(path/"model.onnx"),sess_options=opt,providers=["CPUExecutionProvider"])
        if owner is not None:
            from session_control import GuardedSession
            self.graph=GuardedSession(self.graph,owner)

    def audio(self,text,character=False,speed=1.):
        # The model uses graphemes, including a token for the space and apostrophe.
        text=unicodedata.normalize("NFC",text.strip().lower()).replace("’","'").replace("ʼ","'")
        text=re.sub(r"\d+",lambda m:(" ".join(DIGITS[int(c)] for c in m[0]) if len(m[0])>2 or m[0].startswith("0") else number(int(m[0]))),text)
        ids=[45]
        for char in text:
            if char not in self.tokens:
                char="," if char in ":;" else " " if char.isspace() else ""
            if char in self.tokens:ids.extend((self.tokens[char],45))
        if len(ids)==1:return np.empty(0,dtype=np.float32)
        audio=self.graph.run(None,{"input":np.array([ids],np.int64),"input_lengths":np.array([len(ids)],np.int64),
            "scales":np.array([.55,1./speed,.65],np.float32),"sid":np.array([0],np.int64),"langid":np.array([0],np.int64)})[0]
        return np.ascontiguousarray(audio.ravel(),dtype=np.float32)
