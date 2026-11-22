"""Local, in-process OmniVoice runtime for testing one bilingual voice identity."""
from ctypes import (CDLL, CFUNCTYPE, cast, POINTER, Structure, c_bool, c_char_p, c_float, c_int, c_int32,
                    c_uint64, c_void_p)
from pathlib import Path
import os
import wave
import numpy as np

FLOAT = POINTER(c_float)
CODES = POINTER(c_int32)
CANCEL = CFUNCTYPE(c_bool, c_void_p)


class Init(Structure):
    _fields_ = [
        ("abi", c_int), ("model", c_char_p), ("codec", c_char_p),
        ("flash_attention", c_bool), ("clamp", c_bool), ("device", c_char_p),
    ]


class Audio(Structure):
    _fields_ = [("samples", FLOAT), ("count", c_int), ("rate", c_int), ("channels", c_int)]


class Reference(Structure):
    _fields_ = [("codes", CODES), ("frames", c_int), ("codebooks", c_int)]


class Request(Structure):
    _fields_ = [
        ("abi", c_int), ("text", c_char_p), ("lang", c_char_p), ("instruct", c_char_p),
        ("target", c_int), ("chunk_duration", c_float), ("chunk_threshold", c_float),
        ("denoise", c_bool), ("preprocess", c_bool),
        ("steps", c_int), ("guidance", c_float), ("shift", c_float),
        ("layer_penalty", c_float), ("position_temp", c_float), ("class_temp", c_float),
        ("seed", c_uint64), ("ref_codes", CODES), ("ref_frames", c_int),
        ("ref_pcm", FLOAT), ("ref_samples", c_int), ("ref_text", c_char_p),
        ("dump", c_char_p), ("cancel", c_void_p), ("cancel_data", c_void_p),
        ("on_chunk", c_void_p), ("chunk_data", c_void_p), ("postprocess", c_bool),
    ]


class UnifiedVoiceModel:
    sampling_rate = 24000

    def __init__(self, models, refs, native, device="CPU"):
        self.refs = Path(refs)
        self.cached_references = {}
        self.context = None
        libdir = Path(native).resolve()
        with os.add_dll_directory(str(libdir)):
            self.lib = CDLL(str(libdir / "libomnivoice.dll"))
        signatures = (
            ("ov_init_default_params", [POINTER(Init)], None),
            ("ov_init", [POINTER(Init)], c_void_p),
            ("ov_free", [c_void_p], None),
            ("ov_last_error", [], c_char_p),
            ("ov_tts_default_params", [POINTER(Request)], None),
            ("ov_extract_voice_ref", [c_void_p, FLOAT, c_int, POINTER(Reference)], c_int),
            ("ov_voice_ref_free", [POINTER(Reference)], None),
            ("ov_audio_free", [POINTER(Audio)], None),
            ("ov_synthesize", [c_void_p, POINTER(Request), POINTER(Audio)], c_int),
            ("ov_duration_sec_to_tokens", [c_void_p, c_float], c_int),
        )
        for name, argtypes, restype in signatures:
            fn = getattr(self.lib, name)
            fn.argtypes, fn.restype = argtypes, restype
        p = Init()
        self.lib.ov_init_default_params(p)
        location = Path(models).resolve()
        p.model = str(location / "omnivoice-base-Q4_K_M.gguf").encode()
        p.codec = str(location / "omnivoice-tokenizer-Q4_K_M.gguf").encode()
        p.device = device.encode("ascii")
        self.context = self.lib.ov_init(p)
        if not self.context:
            raise RuntimeError(self._error())

    def _error(self):
        return self.lib.ov_last_error().decode("utf8", "replace")

    def _reference(self, profile):
        if profile in self.cached_references:
            return self.cached_references[profile]
        with wave.open(str(self.refs / (profile + ".wav")), "rb") as audio:
            if (audio.getnchannels(), audio.getframerate(), audio.getsampwidth()) != (1, 24000, 2):
                raise ValueError("Reference must be 24 kHz 16-bit mono PCM.")
            data = np.frombuffer(audio.readframes(audio.getnframes()), "<i2").astype(np.float32) / 32768
        text = (self.refs / (profile + ".txt")).read_text(encoding="utf8").strip()
        ref = Reference()
        try:
            if self.lib.ov_extract_voice_ref(self.context, data.ctypes.data_as(FLOAT), len(data), ref):
                raise RuntimeError(self._error())
            tokens = np.ctypeslib.as_array(ref.codes, (ref.codebooks * ref.frames,)).copy()
            result = tokens, ref.frames, text
            self.cached_references[profile] = result
            return result
        finally:
            self.lib.ov_voice_ref_free(ref)

    def close(self):
        if self.context:
            self.lib.ov_free(self.context)
            self.context = None

    def synthesize(self, profile, language, text, *, steps=8, cancelled=lambda: False,
                   duration=None, guidance=2.0):
        codes, frames, transcript = self._reference(profile)
        request = Request()
        self.lib.ov_tts_default_params(request)
        request.text = text.encode("utf8")
        request.lang = (language or "").encode("ascii")
        request.steps = steps
        request.guidance = guidance
        request.seed = 19
        cancel = CANCEL(lambda _: bool(cancelled()))
        request.cancel = cast(cancel, c_void_p)
        request.ref_codes = codes.ctypes.data_as(CODES)
        request.ref_frames = frames
        request.ref_text = transcript.encode("utf8")
        if duration is not None:
            request.target = self.lib.ov_duration_sec_to_tokens(self.context, duration)
        audio = Audio()
        try:
            if self.lib.ov_synthesize(self.context, request, audio):
                if cancelled():
                    return np.empty(0, dtype=np.float32), self.sampling_rate
                raise RuntimeError(self._error())
            return np.ctypeslib.as_array(audio.samples, (audio.count,)).copy(), audio.rate
        finally:
            self.lib.ov_audio_free(audio)
