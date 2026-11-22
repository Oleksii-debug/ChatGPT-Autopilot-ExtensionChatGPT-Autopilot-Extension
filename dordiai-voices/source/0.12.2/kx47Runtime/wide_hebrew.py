"""Local modern Hebrew stressed phonemes and neural carrier for the enrolled speaker."""
from functools import lru_cache
from importlib.util import module_from_spec,spec_from_file_location
import json
from pathlib import Path
import re
import unicodedata

import numpy as np
import onnxruntime as ort


LETTERS=dict(zip("אבגדהוזחטיכךלמםנןסעפףצץקרשת",
    ("ˈalef","bet","ˈgimel","ˈdalet","he","vav","ˈzajin","χet","tet","jud","kaf","kaf sofit",
     "ˈlamed","mem","mem sofit","nun","nun sofit","ˈsameχ","ˈajin","pe","pe sofit","ˈtsadi","ˈtsadi sofit","kuf","reʃ","ʃin","tav"),strict=True))
ONES=("אפס","אחד","שניים","שלושה","ארבעה","חמישה","שישה","שבעה","שמונה","תשעה")
TEENS=("עשרה","אחד עשר","שנים עשר","שלושה עשר","ארבעה עשר","חמישה עשר","שישה עשר","שבעה עשר","שמונה עשר","תשעה עשר")
TENS=("","","עשרים","שלושים","ארבעים","חמישים","שישים","שבעים","שמונים","תשעים")
HUNDREDS=("","מאה","מאתיים","שלוש מאות","ארבע מאות","חמש מאות","שש מאות","שבע מאות","שמונה מאות","תשע מאות")


def cardinal(value):
    if value<10:return ONES[value]
    if value<20:return TEENS[value-10]
    if value<100:
        return TENS[value//10]+(" ו"+ONES[value%10] if value%10 else "")
    if value<1000:
        return HUNDREDS[value//100]+(" ו"+cardinal(value%100) if value%100 else "")
    if value<1000000:
        thousands=value//1000
        group=("אלף" if thousands==1 else "אלפיים" if thousands==2 else
               ("שלושת ארבעת חמשת ששת שבעת שמונת תשעת".split()[thousands-3]+" אלפים") if thousands<10 else cardinal(thousands)+" אלף")
        return group+(" ו"+cardinal(value%1000) if value%1000 else "")
    return " ".join(ONES[int(d)] for d in str(value))


def _numbers(match):
    digits=match.group()
    if len(digits)>6 or len(digits)>1 and digits[0]=="0":
        return " "+" ".join(ONES[int(d)] for d in digits)+" "
    return " "+cardinal(int(digits))+" "


class HebrewCarrier:
    def __init__(self,folder,progress=None,owner=None):
        folder=Path(folder)
        spec=spec_from_file_location("_dordiai_renikud",folder/"renikud.py")
        mod=module_from_spec(spec);spec.loader.exec_module(mod)
        if progress:progress('language-phonetics')
        self.g2p=mod.G2P(str(folder/"g2p.onnx"))
        options=ort.SessionOptions()
        options.intra_op_num_threads=2;options.inter_op_num_threads=1
        options.add_session_config_entry("session.intra_op.allow_spinning","0")
        if (folder/"prepared").is_file():
            options.graph_optimization_level=ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        if progress:progress('language-source')
        self.voice=ort.InferenceSession(str(folder/"noa.onnx"),sess_options=options,providers=["CPUExecutionProvider"])
        if owner is not None:
            from session_control import GuardedSession
            self.g2p._session=GuardedSession(self.g2p._session,owner)
            self.voice=GuardedSession(self.voice,owner)
        self.ids=json.loads((folder/"noa.onnx.json").read_bytes())["phoneme_id_map"]

    @lru_cache(maxsize=256)
    def phonemes(self,text,character):
        if character and text in LETTERS:return LETTERS[text]
        text=re.sub(r"\d+",_numbers,text)
        if text.strip().rstrip(".!?")=="שלום":
            stem=text.strip()
            return "ʃalˈom"+stem[len("שלום"):]
        from wide_hebrew_niqqud import has_marks,pronounce
        if has_marks(text):
            return pronounce(text,self.g2p.phonemize)
        return self.g2p.phonemize(text)

    def audio(self,text,character=False,speed=1.):
        phones=unicodedata.normalize("NFD",self.phonemes(text,character))
        ids=self.ids["^"]+self.ids["_"]
        for phoneme in phones:
            if phoneme in self.ids:
                ids.extend(self.ids[phoneme]);ids.extend(self.ids["_"])
        ids.extend(self.ids["$"])
        result=self.voice.run(None,{"input":np.array([ids],np.int64),
                                   "input_lengths":np.array([len(ids)],np.int64),
                                   "scales":np.array([.55,1./speed,.65],np.float32),
                                   "sid":np.array([0],np.int64)})[0]
        return np.ascontiguousarray(result.ravel(),dtype=np.float32)
