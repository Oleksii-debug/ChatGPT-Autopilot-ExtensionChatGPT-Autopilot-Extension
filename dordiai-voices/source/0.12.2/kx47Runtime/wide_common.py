"""Render additional high-resource languages with one shared resident acoustic model."""
from functools import lru_cache
from pathlib import Path
import numpy as np
from converted_voices import resample
from wide_common_carrier import CommonCarrier


def acoustic_graph(folder,name):
    target=folder/name
    prepared=target.with_suffix(".ort")
    return prepared if prepared.is_file() else target


class CommonSpeech:
    def __init__(self,folder,owner):
        self.folder=Path(folder)
        self.voice=CommonCarrier(self.folder,{"model":"SharedAcoustic","steps":8,
            "vector_model":"vector_estimator.static-q8.onnx"},owner)
        self._ja=None

    @lru_cache(maxsize=16)
    def audio(self,lang,text,speed=1.):
        from wide_numbers import spell_numbers
        text=spell_numbers(lang,text)
        if lang=="ja":
            from wide_japanese import JapaneseReading
            if self._ja is None:self._ja=JapaneseReading(self.folder/"Japanese")
            text=self._ja.pronounce(text)
        x=np.concatenate(tuple(self.voice.synthesize(text,lang,min(1.7,max(.8,speed)),append_terminal=False)))
        return resample(x,24000,22050)
