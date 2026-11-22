"""CPU speech synthesis with Piper and the OpenVoice V2 tone converter."""
from concurrent.futures import ThreadPoolExecutor
from functools import cached_property, lru_cache
from math import gcd
from pathlib import Path
from threading import get_ident
import json
import re

import numpy as np

from reference_voices import REFERENCE_NAMES
from voice_catalog import PROFILES
from speech_text import english_text, split_mixed
from session_control import GuardedSession, SynthesisCancelled
from voice_assets import asset_path
from voice_policy import require_voice_allowed


VOICE_FILES = {"uk": "uk_UA-tetiana-high.onnx", "en": "en_US-amy-low.onnx", "en_male": "en_US-ryan-low.onnx"}
CALIBRATION = {
    "uk": "Відкрийте меню. Натисніть кнопку, щоб зберегти зміни. Щоб вибрати наступний елемент, натисніть стрілку вниз.",
    "en": "Open the file menu. Press the Save button to keep your changes. Select an item with the down arrow key.",
}


@lru_cache(maxsize=16)
def _resample_kernel(source, target):
    divisor = gcd(source, target)
    up, down = target // divisor, source // divisor
    radius = 10 * max(up, down)
    offsets = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.sinc(offsets / max(up, down)) * np.kaiser(offsets.size, 5.0)
    kernel = (kernel * (up / kernel.sum())).astype(np.float32)
    width = (kernel.size + up - 1) // up
    table = np.zeros((up, width), dtype=np.float32)
    for phase in range(up):
        taps = kernel[phase::up]
        table[phase, :len(taps)] = taps
    return table, up, down, radius


def resample(audio, source, target):
    if source == target or not audio.size:
        return audio
    table, up, down, radius = _resample_kernel(source, target)
    steps = np.arange((audio.size * up + down - 1) // down) * down + radius
    padded = np.pad(audio, (table.shape[1], table.shape[1]))
    indexes = steps[:, None] // up + table.shape[1] - np.arange(table.shape[1])
    return np.sum(padded[indexes] * table[steps % up], axis=1, dtype=np.float32)

def spectrogram(audio):
    nfft, hop = 1024, 256
    padded = np.pad(audio, 384, mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, nfft)[::hop]
    window = np.hanning(nfft + 1)[:-1].astype(np.float32)
    spectrum = np.fft.rfft(frames * window, axis=1)
    return np.sqrt(np.abs(spectrum) ** 2 + 1e-6).astype(np.float32)


class ConvertedVoices:
    sampling_rate = 22050

    def __init__(self, models, references, threads=6):
        self.models = Path(models)
        self.references = Path(references)
        self.threads = threads
        self.voices = {}
        self.source_embeddings = {}
        self.reference_embeddings = {}
        self.english_ready = None
        self.cancel_event = None
        self.cancel_thread = get_ident()

    def check_cancelled(self):
        if get_ident() == self.cancel_thread and self.cancel_event is not None and self.cancel_event.is_set():
            raise SynthesisCancelled()

    def _session(self, path, *, threads=None):
        import onnxruntime as ort

        ort.disable_telemetry_events()
        settings = ort.SessionOptions()
        if ((Path(path).parent / "offline-optimized").is_file() or
                Path(path).parent.name == "Piper" and Path(path).name in
                {"experiment-graph-pl.onnx", "experiment-graph-sk.onnx"}):
            settings.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        settings.intra_op_num_threads = self.threads if threads is None else threads
        settings.inter_op_num_threads = 1
        settings.add_session_config_entry("session.intra_op.allow_spinning", "0")
        return GuardedSession(ort.InferenceSession(str(path), settings, providers=["CPUExecutionProvider"]), self)

    @cached_property
    def converter(self):
        model_dir = self.models / "OpenVoiceV2"
        model = model_dir / "tone_converter.deterministic.onnx"
        if not model.is_file():
            model = model_dir / "tone_converter.fp32.onnx"
        if not model.is_file():
            model = model_dir / "tone_converter_q8.onnx"
        return self._session(model)

    @cached_property
    def encoder(self):
        directory = self.models / "OpenVoiceV2"
        full_precision = directory / "tone_ref_encoder.onnx"
        return self._session(full_precision if full_precision.is_file()
                             else directory / "tone_ref_encoder_q8.onnx")

    @property
    def engine(self):
        return self.encoder, self.converter

    def preload(self):
        # Initialize the main NVDA language before the first focus announcement.
        pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="English voice")
        self.english_ready = pool.submit(self._piper_audio, "en", "Ready.", 1.0)
        pool.shutdown(wait=False)
        self.synthesize("brianna", "uk", "Готово.", 1.0)

    @lru_cache(maxsize=64)
    def _piper_audio(self, language, text, speed, *, accent=None):
        from piper import PiperVoice, SynthesisConfig

        if language not in self.voices:
            model = self.models / "Piper" / VOICE_FILES[language]
            from piper.config import PiperConfig

            config = json.loads(model.with_suffix(".onnx.json").read_text(encoding="utf-8"))
            self.voices[language] = PiperVoice(
                session=self._session(model),
                config=PiperConfig.from_dict(config),
            )
        voice = self.voices[language]
        settings = SynthesisConfig(length_scale=1 / speed)
        if language == "uk":
            from ukrainian_stress import piper_sentences

            chunks = [
                voice.phoneme_ids_to_audio(voice.phonemes_to_ids(phones), settings)
                for phones in piper_sentences(text, voice)
            ]
        else:
            from english_phonetics import phonemizer

            phonetic_voice = "en" if accent == "en-gb" else voice.config.espeak_voice
            chunks = [
                voice.phoneme_ids_to_audio(voice.phonemes_to_ids(phones), settings)
                for phones in phonemizer().phonemize(phonetic_voice, text, vowel_clusters=voice.config.vowel_clusters)
                if phones
            ]
        if not chunks:
            return np.zeros(0, dtype=np.float32)
        audio = np.concatenate(chunks).astype(np.float32)
        peak = np.max(np.abs(audio))
        if peak > 1e-6:
            audio *= 0.82 / peak
        return resample(audio, voice.config.sample_rate, self.sampling_rate)

    def _embedding(self, audio):
        return self.encoder.run(None, {"spec": spectrogram(audio)[None]})[0].reshape(1, 256, 1)

    def _reference(self, profile):
        require_voice_allowed(profile)
        if profile not in self.reference_embeddings:
            filename = profile + ".npy"
            managed = asset_path(self.references, profile, "english_embedding")
            if managed is None:
                managed = asset_path(self.references, profile, "target_embedding", required=True)
            if managed is not None:
                value = np.load(managed, allow_pickle=False)
                if value.shape != (1, 256, 1) or not np.isfinite(value).all():
                    raise ValueError("Invalid installed target voice identity")
                self.reference_embeddings[profile] = value
                return value
            calibrated = self.references / "english" / filename
            embedding = calibrated if calibrated.is_file() else self.references / filename
            if embedding.is_file():
                self.reference_embeddings[profile] = np.load(embedding, allow_pickle=False)
                return self.reference_embeddings[profile]
            from scipy.io import wavfile

            rate, audio = wavfile.read(self.references / (REFERENCE_NAMES[profile] + ".wav"))
            if np.issubdtype(audio.dtype, np.integer):
                audio = audio.astype(np.float32) / max(-np.iinfo(audio.dtype).min, np.iinfo(audio.dtype).max)
            else:
                audio = audio.astype(np.float32)
            if audio.ndim == 2:
                audio = audio.mean(axis=1)
            self.reference_embeddings[profile] = self._embedding(resample(audio, rate, self.sampling_rate))
        return self.reference_embeddings[profile]

    def _convert(self, spec, source, target):
        return self.converter.run(None, {
            "spec": spec, "spec_lengths": np.array([spec.shape[-1]], dtype=np.int64),
            "src_g": source, "tgt_g": target,
        })[0].reshape(-1)

    def _blocks(self, spec, source, target):
        frame_size = 256
        frame_count = spec.shape[-1]
        start = 0
        end = min(frame_count, 25)
        previous = None
        overlap = 2 * frame_size
        fade = np.linspace(0, 1, overlap, dtype=np.float32)
        while start < frame_count:
            left = max(0, start - 24)
            right = min(frame_count, end + 24)
            wave = self._convert(spec[:, :, left:right].copy(), source, target)
            block = wave[(start-left)*frame_size:(end-left)*frame_size]
            if previous is not None:
                block[:overlap] = previous * (1 - fade) + block[:overlap] * fade
            if end == frame_count:
                yield block
                return
            yield block[:-overlap]
            previous = block[-overlap:]
            start = end - 2
            end = min(frame_count, start + 56)

    def chunks(self, profile, language, text, speed=1.0, stream=True, *, wait_for_warmup=True):
        accent = (language or "").lower().replace("_", "-")
        lang = accent.split("-")[0]
        languages = [(lang, text)] if lang in VOICE_FILES else split_mixed(text)
        reference = self._reference(profile)
        for lang, phrase in languages:
            if not phrase:
                continue
            if wait_for_warmup and lang == "en" and self.english_ready is not None:
                ready, self.english_ready = self.english_ready, None
                ready.result()
            if lang == "en" and profile in PROFILES:
                lang = PROFILES[profile][2]
            spoken = self._piper_audio(lang, english_text(phrase) if lang.startswith("en") else phrase, speed, accent=accent)
            if lang == "en_male":
                from speech_tempo import change_tempo
                timing = self._piper_audio("en", english_text(phrase), speed, accent=accent)
                if len(timing) and len(spoken):
                    spoken = change_tempo(spoken, self.sampling_rate, len(spoken) / len(timing))
            if spoken.size <= 384:
                continue
            if lang not in self.source_embeddings:
                embedding = self.references / (lang + ".npy")
                if embedding.is_file():
                    self.source_embeddings[lang] = np.load(embedding, allow_pickle=False)
                else:
                    calibration = self._piper_audio(lang, CALIBRATION["en" if lang == "en_male" else lang], 1.0)
                    self.source_embeddings[lang] = self._embedding(calibration)
            spec = spectrogram(spoken).T.copy()[None]
            if stream:
                yield from self._blocks(spec, self.source_embeddings[lang], reference)
            else:
                yield self._convert(spec, self.source_embeddings[lang], reference)

    def synthesize(self, profile, language, text, speed=1.0):
        clips = list(self.chunks(profile, language, text, speed, stream=False))
        if not clips:
            return np.zeros(self.sampling_rate // 50, dtype=np.float32), self.sampling_rate
        return np.concatenate(clips), self.sampling_rate
