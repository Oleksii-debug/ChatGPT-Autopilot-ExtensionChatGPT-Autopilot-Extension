"""Actual Sesotho Simba ONNX carrier with its matching grapheme tokenizer.

Tokenizer rules follow Transformers VitsTokenizer v4.45.1, Apache-2.0,
Copyright Kakao Enterprise, MMS-TTS authors and Hugging Face. The upstream
tokenizer marks ``h`` as a special pad token, so ordinary interspersing around
every character produces incorrect IDs at a leading/trailing h. In-vocabulary
apostrophes and hyphens are retained. No phoonnx package, Torch or network is used.
"""
import json
from pathlib import Path
import re
import unicodedata

SUPPORTED = {"st": "sot", "xh": "xho"}


class SimbaFrontend:
    def __init__(self, vocabulary, tokenizer, code="st"):
        self.vocabulary, self.tokenizer, self.code = vocabulary, tokenizer, code
        if (tokenizer.get("is_uroman") or tokenizer.get("phonemize") or not tokenizer.get("add_blank")
                or tokenizer.get("pad_token") != "h" or vocabulary.get("h") != 0
                or not all(isinstance(key, str) and len(key) == 1 and isinstance(value, int) and 0 <= value < 30
                           for key, value in vocabulary.items())):
            raise ValueError("Unsupported native Simba tokenizer configuration: " + code)

    def ids(self, text, character=False):
        if character:
            raise ValueError("Verified native character names are not prepared for " + self.code + "; phonemes are not letter names")
        text = unicodedata.normalize("NFC", str(text)).lower()
        # This speech boundary cleanup preserves words across line breaks. The
        # upstream tokenizer otherwise strips out-of-vocabulary punctuation.
        text = re.sub(r"\s+", " ", text).strip()
        missing = {char for char in text if char not in self.vocabulary
                   and (unicodedata.category(char).startswith(("L", "M")) or char.isdecimal())}
        if missing:
            raise ValueError("Unsupported native Simba graphemes/number names (" + self.code + "): " +
                             " ".join("U+%04X" % ord(char) for char in sorted(missing)))
        text = "".join(char for char in text if char in self.vocabulary).strip()
        if not text:
            raise ValueError("No native Sesotho graphemes in input")
        result = []
        for chunk in re.split("(h)", text):
            if chunk == "h":
                result.append(0)  # Special added token bypasses _tokenize.
            elif chunk:
                sequence = [0] * (len(chunk) * 2 + 1)
                sequence[1::2] = [self.vocabulary[char] for char in chunk]
                result.extend(sequence)
        if len(result) > 4096:
            raise ValueError("Sesotho text must be split into shorter utterances")
        return result


class NativeSimba:
    def __init__(self, directory, session_factory=None, owner=None, threads=2):
        import numpy as np
        self.np, self.folder, self.owner = np, Path(directory), owner
        configuration = json.loads((self.folder / "runtime_config.json").read_text(encoding="utf-8"))
        self.code = configuration.get("code")
        if (configuration.get("format") != "dordiai-simba-onnx-v1" or self.code not in SUPPORTED
                or configuration.get("iso_code") != SUPPORTED[self.code] or configuration.get("sample_rate") != 16000):
            raise ValueError("Simba graph does not match the registered native standard")
        self.rate = 16000
        self.frontend = SimbaFrontend(
            json.loads((self.folder / "upstream-vocab.json").read_text(encoding="utf-8")),
            json.loads((self.folder / "upstream-tokenizer_config.json").read_text(encoding="utf-8")), self.code)
        if session_factory is None:
            import onnxruntime as ort
            ort.disable_telemetry_events()
            options = ort.SessionOptions()
            options.intra_op_num_threads = max(1, int(threads))
            options.inter_op_num_threads = 1
            options.add_session_config_entry("session.intra_op.allow_spinning", "0")
            session_factory = lambda path: ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
        def open_graph():
            graph = session_factory(self.folder / "model.onnx")
            inputs = {item.name: item for item in graph.get_inputs()}
            if (set(inputs) != {"input_ids", "attention_mask", "scales"}
                    or inputs["input_ids"].type != "tensor(int64)" or inputs["attention_mask"].type != "tensor(int64)"):
                raise ValueError("Unexpected Sesotho Simba ONNX input contract")
            return graph
        if owner is None:
            self.session = open_graph()
        else:
            from wide_loading import DeferredSession
            self.session = DeferredSession(open_graph, owner)

    def audio(self, text, character=False, rate=1.0):
        session = self.session
        if session is None:
            raise RuntimeError("Simba carrier is closed")
        if self.owner is not None:
            self.owner.check_cancelled()
        np = self.np
        if any(char.isdecimal() for char in text):
            from wide_numbers import spell_numbers
            expanded = spell_numbers(self.code, text)
            if character and len(text) == 1 and text.isdecimal() and expanded != text:
                character = False
            text = expanded
        if character:
            from character_names import spoken_name
            try:
                text = spoken_name(self.code, text, directory=self.folder.parents[1] / "CharacterNames")
            except LookupError as error:
                raise ValueError("Verified native character names are not prepared for " + self.code) from error
            character = False
        ids = np.asarray([self.frontend.ids(text, character)], dtype=np.int64)
        speed = min(2.5, max(.5, float(rate)))
        # Verified exporter graph applies two reciprocal operations to scales[1],
        # yielding the standard length multiplier. It is not a speaking-rate slot.
        feed = {"input_ids": ids, "attention_mask": np.ones_like(ids),
                "scales": np.asarray([.667, 1.0 / speed, .8], dtype=np.float32)}
        audio = np.asarray(session.run(["waveform"], feed)[0], dtype=np.float32).reshape(-1)
        if self.owner is not None:
            self.owner.check_cancelled()
        if len(audio) < 32 or not np.isfinite(audio).all() or np.max(np.abs(audio)) < 1e-7:
            raise ValueError("Sesotho Simba returned invalid or silent native audio")
        return audio

    def close(self):
        self.session = None
