"""Local OmniVoice ONNX inference with no PyTorch/transformers runtime.

Uses the pinned gaber ONNX export and ports the conditional/unconditional
unmasking procedure from k2-fsa/OmniVoice (Apache-2.0 code), revision
4d5ed0f0621507e8aebd4560bde316549e85c553. Model weights remain subject to
their upstream non-commercial license. See doc/third-party/OmniVoice-NOTICE.txt.
"""
from pathlib import Path
from collections import OrderedDict
from functools import lru_cache
import math
import os
import re
import threading

LANGUAGES = frozenset({"rm", "ks", "mni", "brx", "ig", "ln", "zu", "xh", "wo", "nso"})
RATE = 24000
MASK = 1024


def _log_softmax(values, np):
    shifted = values - values.max(axis=-1, keepdims=True)
    return shifted - np.log(np.exp(shifted).sum(axis=-1, keepdims=True))


def prepare_inputs(tokenizer, text, language, frames, np, reference_codes=None, reference_text=None,
                   instruction=None):
    if frames < 1 or frames > 750:
        raise ValueError("OmniVoice utterance must contain 1..750 codec frames")
    if "<|" in text or "|>" in text:
        raise ValueError("Reserved OmniVoice control tokens are not supported in literal speech text")
    style = ("<|denoise|>" if reference_codes is not None else "")
    style += "<|lang_start|>" + language + "<|lang_end|>"
    style += "<|instruct_start|>" + (instruction or "None") + "<|instruct_end|>"
    combined = (reference_text.strip() + " " if reference_text else "") + text.strip()
    combined = re.sub(r"[\r\n]+", "", combined).replace("（", "(").replace("）", ")")
    combined = re.sub(r"[ \t]+", " ", combined)
    ids = tokenizer.encode(style, add_special_tokens=False).ids
    ids += tokenizer.encode("<|text_start|>" + combined + "<|text_end|>", add_special_tokens=False).ids
    if not ids:
        raise ValueError("Empty OmniVoice conditioning")
    prefix = np.tile(np.asarray(ids, np.int64), (8, 1))
    if reference_codes is not None:
        reference_codes = np.asarray(reference_codes, np.int64)
        if reference_codes.ndim != 2 or reference_codes.shape[0] != 8 or not np.logical_and(reference_codes >= 0, reference_codes < MASK).all():
            raise ValueError("Invalid OmniVoice reference codec tokens")
        prefix = np.concatenate((prefix, reference_codes), axis=1)
    total = prefix.shape[1] + frames
    if total > 1600:
        raise ValueError("OmniVoice request/reference must be split into shorter utterances")
    batch = np.full((2, 8, total), MASK, dtype=np.int64)
    batch[0, :, :prefix.shape[1]] = prefix
    audio = np.zeros((2, total), dtype=bool)
    audio[0, len(ids):] = True
    audio[1, :frames] = True
    attention = np.zeros((2, 1, total, total), dtype=bool)
    attention[0] = True
    attention[1, :, :frames, :frames] = True
    pad = np.arange(frames, total)
    attention[1, :, pad, pad] = True
    return batch, audio, attention


def worker_threads(requested=None):
    """Reserve UI headroom by default and bound explicit benchmark overrides."""
    chosen = min(6, max(1, (os.cpu_count() or 2) - 2)) if requested is None else int(requested)
    return min(64, max(1, chosen))


class OmniONNX:
    def __init__(self, directory, owner=None, threads=None):
        import numpy as np
        import onnxruntime as ort
        ort.disable_telemetry_events()
        from tokenizers import Tokenizer
        from omnivoice_duration import RuleDurationEstimator
        self.np = np
        self.folder = Path(directory)
        self.owner = owner
        self._lock = threading.RLock()
        self.tokenizer = Tokenizer.from_file(str(self.folder / "tokenizer.json"))
        self.duration = RuleDurationEstimator()
        self.sessions = {}
        self._word_cache = OrderedDict()
        self._word_cache_bytes = 0
        self.options = ort.SessionOptions()
        # Keep two logical CPUs for NVDA/UI and other work; explicit overrides
        # remain available to reproducible benchmarks. Do not spin idle workers.
        self.threads = worker_threads(threads)
        self.options.intra_op_num_threads = self.threads
        self.options.inter_op_num_threads = 1
        self.options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        self._ort = ort

    def check_cancelled(self):
        if self.owner is not None:
            self.owner.check_cancelled()

    def session(self, name):
        if name not in self.sessions:
            self.check_cancelled()
            def factory():
                return self._ort.InferenceSession(str(self.folder / name), sess_options=self.options,
                                                 providers=["CPUExecutionProvider"])
            if self.owner is None:
                self.sessions[name] = factory()
            else:
                from wide_loading import DeferredSession
                self.sessions[name] = DeferredSession(factory, self.owner)
        return self.sessions[name]

    def encode_reference(self, audio, sample_rate):
        """Preparation API; the optional 654 MB encoder need not ship after prompt preparation."""
        from converted_voices import resample
        np = self.np
        waveform = resample(np.asarray(audio, np.float32).reshape(-1), int(sample_rate), RATE)
        if not waveform.size or not np.isfinite(waveform).all():
            raise ValueError("Invalid OmniVoice reference waveform")
        if len(waveform) > RATE * 20:
            waveform = waveform[:RATE * 20]
        padding = (-len(waveform)) % 960
        if padding:
            waveform = np.pad(waveform, (0, padding))
        with self._lock:
            self.check_cancelled()
            codes = self.session("encoder.fp32.onnx").run(None, {"wav": waveform[None, None, :]})[0]
            codes = np.asarray(codes, np.int64)
            if codes.ndim != 3 or codes.shape[:2] != (1, 8):
                raise ValueError("Unexpected OmniVoice reference-code shape")
            return codes[0]

    def generate(self, text, language, rate=1.0, reference_codes=None, reference_text=None,
                 steps=32, guidance=2.0, seed=0, instruction=None, duration=None,
                 split_unconditional=False, return_codes=False):
        if not isinstance(text, str) or not text.strip():
            return self.np.empty(0, dtype=self.np.float32)
        if language not in LANGUAGES and language not in {"uk", "en", "ru", "sat"}:
            raise ValueError("Unregistered OmniVoice language: " + str(language))
        if not 1 <= int(steps) <= 64:
            raise ValueError("Invalid OmniVoice diffusion step count")
        np = self.np
        if duration is not None:
            frames = int(math.ceil(float(duration) * 25))
        else:
            reference_length = reference_codes.shape[-1] if reference_codes is not None else 25
            frames = max(1, int(self.duration.estimate_duration(text, reference_text or "Nice to meet you.", reference_length)
                                / max(.5, min(2.5, float(rate)))))
        inputs, audio_mask, attention_mask = prepare_inputs(self.tokenizer, text, language, frames, np,
                                                          reference_codes, reference_text, instruction)
        tokens = np.full((8, frames), MASK, dtype=np.int64)
        rng = np.random.default_rng(seed)
        times = np.linspace(0, 1, int(steps) + 1, dtype=np.float32)
        times = .1 * times / (1 - .9 * times)
        remaining = frames * 8
        with self._lock:
            backbone = self.session("backbone.int8.onnx")
            for step in range(int(steps)):
                self.check_cancelled()
                count = remaining if step == int(steps) - 1 else min(remaining, int(math.ceil(frames * 8 * float(times[step + 1] - times[step]))))
                if count <= 0:
                    continue
                if split_unconditional:
                    # Algebraically equivalent float attention, but dynamic
                    # quantizer ranges can differ. This remains opt-in until
                    # numerical/acoustic parity is established for these graphs.
                    conditional_logits = backbone.run(None, {
                        "input_ids": inputs[:1], "audio_mask": audio_mask[:1],
                        "attention_mask": attention_mask[:1],
                    })[0][0, :, -frames:, :]
                    unconditional_logits = backbone.run(None, {
                        "input_ids": inputs[1:2, :, :frames], "audio_mask": audio_mask[1:2, :frames],
                        "attention_mask": attention_mask[1:2, :, :frames, :frames],
                    })[0][0]
                else:
                    logits = backbone.run(None, {"input_ids": inputs, "audio_mask": audio_mask,
                                                  "attention_mask": attention_mask})[0]
                    conditional_logits = logits[0, :, -frames:, :]
                    unconditional_logits = logits[1, :, :frames, :]
                conditional = _log_softmax(conditional_logits.astype(np.float32), np)
                if guidance:
                    unconditional = _log_softmax(unconditional_logits.astype(np.float32), np)
                    log_probs = _log_softmax(conditional + float(guidance) * (conditional - unconditional), np)
                else:
                    log_probs = conditional
                log_probs[:, :, MASK] = -np.inf
                predictions = log_probs.argmax(axis=-1)
                scores = log_probs.max(axis=-1) - np.arange(8, dtype=np.float32)[:, None] * 5.0
                uniform = rng.random(scores.shape)
                scores = scores / 5.0 - np.log(-np.log(uniform + 1e-10) + 1e-10)
                scores[tokens != MASK] = -np.inf
                selected = np.argpartition(scores.reshape(-1), -count)[-count:]
                tokens.reshape(-1)[selected] = predictions.reshape(-1)[selected]
                inputs[0, :, -frames:] = tokens
                inputs[1, :, :frames] = tokens
                remaining -= count
            self.check_cancelled()
            if (tokens >= MASK).any():
                raise ValueError("OmniVoice generated undecoded audio tokens")
            waveform = self.session("vocoder.fp32.onnx").run(None, {"audio_codes": tokens[None, :, :]})[0]
            waveform = np.asarray(waveform, np.float32).reshape(-1)
            self.check_cancelled()
        if not waveform.size or not np.isfinite(waveform).all():
            raise ValueError("OmniVoice returned invalid PCM")
        return (waveform, tokens.copy()) if return_codes else waveform


def model_folder(models):
    return Path(models) / "SharedOmniONNX"


def available(models, require_source=True):
    root = model_folder(models)
    shared = ("backbone.int8.onnx", "vocoder.fp32.onnx", "vocoder.fp32.onnx.data", "tokenizer.json")
    if not all((root / name).is_file() for name in shared):
        return set()
    required = ("codes.npy", "text.txt") + (("source.npy",) if require_source else ())
    return {code for code in LANGUAGES if all((root / "references" / code / name).is_file() for name in required)}


@lru_cache(maxsize=16)
def _reference(root, code):
    import numpy as np
    directory = root / "references" / code
    codes = np.load(directory / "codes.npy", allow_pickle=False)
    text = (directory / "text.txt").read_text(encoding="utf-8").strip()
    if codes.ndim != 2 or codes.shape[0] != 8 or not text:
        raise ValueError("Invalid native OmniVoice conditioning for " + code)
    return codes, text


@lru_cache(maxsize=1)
def _engine(models, owner=None):
    return OmniONNX(model_folder(models), owner=owner)


def audio(code, text, character=False, *, models, rate=1.0, owner=None):
    if code not in LANGUAGES:
        raise KeyError(code)
    if character:
        from character_names import spoken_name
        try:
            text = spoken_name(code, text, directory=Path(models) / "CharacterNames")
        except LookupError as error:
            raise ValueError("Native OmniVoice symbol names require a validated language navigation resource") from error
    root = model_folder(models)
    engine = _engine(str(Path(models).resolve()), owner)
    engine.check_cancelled()
    key = (code, text, float(rate))
    with engine._lock:
        cached = engine._word_cache.get(key)
        if cached is not None:
            engine._word_cache.move_to_end(key)
            return cached, RATE
        codes, reference_text = _reference(root, code)
        result = engine.generate(text, code, rate=rate, reference_codes=codes, reference_text=reference_text)
        # Share native short-word carriers across selected voices, but bound
        # actual PCM bytes rather than assuming every cache entry is small.
        if len(text) <= 64 and result.nbytes <= 32 * 1024**2:
            result.setflags(write=False)
            engine._word_cache[key] = result
            engine._word_cache_bytes += result.nbytes
            while engine._word_cache_bytes > 32 * 1024**2:
                _, removed = engine._word_cache.popitem(last=False)
                engine._word_cache_bytes -= removed.nbytes
        return result, RATE


@lru_cache(maxsize=16)
def source(code, *, models):
    import numpy as np
    if code not in LANGUAGES:
        raise KeyError(code)
    vector = np.load(model_folder(models) / "references" / code / "source.npy", allow_pickle=False)
    if vector.shape != (1, 256, 1) or vector.dtype != np.float32 or not np.isfinite(vector).all():
        raise ValueError("Invalid OmniVoice source identity")
    vector.setflags(write=False)
    return vector
