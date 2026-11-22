"""Open exact Piper model weights through the matching shared computation graph."""
from functools import lru_cache
import json
from pathlib import Path

import numpy as np


class VoiceSession:
    def __init__(self, session, model, entry):
        self.session = session
        self.mapping = np.memmap(model, dtype=np.uint8, mode='r')
        self.weights = {}
        for name, offset, length, dtype, shape in entry['weights']:
            value = np.ndarray(shape, dtype=dtype, buffer=self.mapping, offset=offset)
            if value.nbytes != length:
                raise ValueError('Invalid native voice weight')
            self.weights[name] = value

    def run(self, outputs, inputs):
        return self.session.run(outputs, self.weights | inputs)


class PiperFamilies:
    def __init__(self, directory, open_session):
        self.directory = directory
        self.open_session = open_session
        index = directory / 'experiment-graphs.json'
        self.index = json.loads(index.read_text(encoding='utf8')) if index.is_file() else {}

    @lru_cache(maxsize=2)
    def graph(self, filename):
        if filename != Path(filename).name:
            raise ValueError('Invalid native graph path')
        return self.open_session(self.directory / filename)

    def for_language(self, code, model):
        entry = self.index.get(code)
        if not entry or model.name != entry['model'] or model.stat().st_size != entry['size']:
            return self.open_session(model)
        return VoiceSession(self.graph(entry['graph']), model, entry)
