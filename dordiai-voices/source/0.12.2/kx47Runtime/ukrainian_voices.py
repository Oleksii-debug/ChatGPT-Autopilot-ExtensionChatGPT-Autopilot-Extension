"""Synthesize Ukrainian with native Holos acoustic and prosodic voice profiles."""
from functools import cached_property, lru_cache
import json
import re
from threading import Lock

import numpy as np

from converted_voices import ConvertedVoices
from speech_text import split_mixed, speak_numbers
from ukrainian_stress import accent_text
from session_control import GuardedSession
from voice_assets import asset_path

SPACE = re.compile(r"\s+")
SENTENCES = re.compile('.+?(?:[.!?…]+[»”’"\\)\\]]*(?=\\s|$)|$)', re.DOTALL)


def navigation_windows(frame_count, chunk_frames, context_frames, fixed_width=False):
    """Build enough audio ahead of playback without truncating decoder context."""
    start, index = 0, 0
    while start < frame_count:
        # Eight frames left only ~160 ms after boundary trimming: the next
        # 40-frame decode routinely took longer and starved the audio player.
        size = (20, 24)[index] if index < 2 else chunk_frames
        end = min(frame_count, start + min(size, chunk_frames))
        yield start, end, max(0, start - context_frames), min(frame_count, end + context_frames)
        start = end
        index += 1

class StableDurationEncoder:
    """Limit long predicted pauses while retaining the model's phrasing."""
    def __init__(self, session, tokenizer, tempo_voice=None, frication=None):
        self.session = session
        self.tokenizer = tokenizer
        self.tempo_voice = tempo_voice
        self.frication = frication or {}
        inputs = getattr(session, "get_inputs", lambda: ())()
        self.fused_tempo = any(value.name == "tempo_voice" for value in inputs)
        self.pause_caps = {
            ",": 6, ";": 8, ":": 8, "—": 7,
            ".": 10, "!": 10, "?": 10, "…": 13, " ": 6,
        }

    @lru_cache(maxsize=512)
    def _shared_durations(self, tokens, speed):
        import onnxruntime as ort
        options = ort.RunOptions()
        options.only_execute_path_to_fetches = True
        values = {
            "tokens": np.asarray([tokens], dtype=np.int64),
            "voice": self.tempo_voice,
            "speed": np.asarray([speed], dtype=np.float32),
        }
        if self.fused_tempo:
            values["tempo_voice"] = self.tempo_voice
        return self.session.run(["durations"], values, options)[0]

    def run(self, outputs, inputs):
        if self.fused_tempo:
            acoustic, prosodic, durations = self.session.run(outputs, {
                **inputs, "tempo_voice": self.tempo_voice if self.tempo_voice is not None else inputs["voice"],
            })
        else:
            acoustic, prosodic, durations = self.session.run(outputs, inputs)
        speed = float(inputs["speed"][0])
        tokens = inputs["tokens"][0]
        if self.tempo_voice is not None and not self.fused_tempo:
            # One timing reference across the catalog. Identity and pitch still
            # use the selected speaker's acoustic and prosodic embeddings.
            durations = self._shared_durations(tuple(int(x) for x in tokens), speed)
        floor = self.frication.get(inputs["voice"].tobytes(), 3)
        return acoustic, prosodic, self._apply_pause_durations(durations, tokens, speed, floor)

    def _apply_pause_durations(self, durations, tokens, speed, frication_frames=3):
        durations = durations.copy()
        for char, limit in self.pause_caps.items():
            code = self.tokenizer._token_to_id.get(char)
            if code is not None:
                positions = tokens == code
                durations[0, positions] = np.minimum(durations[0, positions], max(1, round(limit / speed)))
        # Preserve a short phrase boundary even when the duration model drops punctuation.
        for symbol, minimum in ((",", 3), (";", 4), (":", 4), ("—", 4)):
            code = self.tokenizer._token_to_id.get(symbol)
            if code is not None:
                positions = tokens == code
                durations[0, positions] = np.maximum(durations[0, positions], max(1, round(minimum / speed)))
        # Keep the initial softened /z/ audible after a word ending in /z/.
        # The shared model often assigns only one frame at this junction.
        ids = self.tokenizer._token_to_id
        z, space, stress, soft = (ids.get(symbol) for symbol in ("z", " ", "ˈ", "ʲ"))
        if None not in (z, space, stress, soft):
            minimum = max(1, round(frication_frames / speed))
            for index in np.flatnonzero(tokens == z):
                boundary = index - 1
                if boundary >= 0 and tokens[boundary] == stress:
                    boundary -= 1
                if (boundary >= 1 and index + 1 < len(tokens) and tokens[boundary] == space
                        and tokens[boundary - 1] == z and tokens[index + 1] == soft):
                    durations[0, index] = max(durations[0, index], minimum)
        return durations

    def reference_frames(self, tokens):
        durations = self._shared_durations(tuple(int(x) for x in tokens), 1.)
        return int(self._apply_pause_durations(durations, tokens, 1.).sum())

class UkrainianVoices(ConvertedVoices):
    output_rate = 24000

    def __init__(self, models, references, threads=6):
        super().__init__(models, references, threads)
        self._holos_lock = Lock()

    @cached_property
    def holos(self):
        # The background loader and the first Ukrainian request share one set of sessions.
        with self._holos_lock:
            model = self.__dict__.get("holos")
            if model is None:
                model = self._load_holos()
                self.__dict__["holos"] = model
            return model

    def _load_holos(self):
        import onnxruntime as ort
        from holos_onnx import HolosTTS

        ort.disable_telemetry_events()
        settings = ort.SessionOptions()
        # The packaged CPU bundle already contains the portable graph fusions.
        model_path = self.models / "Holos"
        if (model_path / "offline-optimized").is_file():
            settings.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        settings.intra_op_num_threads = min(self.threads, 4)
        settings.inter_op_num_threads = 1
        settings.add_session_config_entry("session.intra_op.allow_spinning", "0")
        kernels = model_path / "dordiai_kernels.dll"
        if kernels.is_file():
            # Fused periodic activations use the same Eigen math as ORT.
            # SSE2 is available on every supported x64 CPU; no AVX requirement.
            settings.register_custom_ops_library(str(kernels))
        model = HolosTTS(model_path, streaming=True, session_options=settings)
        for name in ("encoder_session", "prosody_session", "source_session", "decoder_session"):
            setattr(model, name, GuardedSession(getattr(model, name), self))
        calibration_file = self.references / "reference_prosody.json"
        if calibration_file.is_file():
            from reference_prosody import ReferenceProsody
            calibration = json.loads(calibration_file.read_text(encoding="utf-8"))
            by_voice = {self._holos_style(name).tobytes(): values for name, values in calibration.items()}
            model.prosody_session = ReferenceProsody(model.prosody_session, by_voice)
        articulation = self.references / "ukrainian_articulation.json"
        frication = {}
        if articulation.is_file():
            settings = json.loads(articulation.read_text(encoding="utf-8"))
            frication = {self._holos_style(name).tobytes(): frames for name, frames in settings.items()}
        model.encoder_session = StableDurationEncoder(
            model.encoder_session, model.tokenizer, self._holos_style("sara_archive"), frication,
        )
        model._stream_windows = navigation_windows
        return model

    @lru_cache(maxsize=16)
    def _holos_style(self, profile):
        managed = asset_path(self.references, profile, "holos_profile", required=True)
        value = np.load(managed if managed is not None else self.references / "holos" / (profile + ".npy"), allow_pickle=False)
        if value.shape != (1, 256) or not np.isfinite(value).all():
            raise ValueError("Invalid Holos voice identity")
        return value

    def _ukrainian(self, profile, text, speed):
        from ipa_uk import ipa

        expanded = speak_numbers(text, "uk")
        normalized = SPACE.sub(" ", expanded).strip()
        from spelling_audio import SPECIAL_NAMES, render_letter
        if normalized.casefold() in SPECIAL_NAMES:
            yield render_letter(self, profile, normalized.casefold(), speed)
            return
        for sentence in SENTENCES.finditer(normalized):
            marked = accent_text(sentence.group().strip())
            phonemes = ipa(marked)
            if phonemes.strip(" .,!?:;…—"):
                yield from self.holos.stream(
                    phonemes, voice=self._holos_style(profile), speed=speed, chunk_frames=40,
                )

    def preload(self, language="mixed"):
        # The ready reply must mean both languages are actually warm. Background
        # graph optimization previously stalled the first several focus events.
        if language in {"mixed", "uk"}:
            list(self._ukrainian("sara_archive", "Готово.", 1.0))
        if language in {"mixed", "en"}:
            self._warm_english()

    def _warm_english(self):
        from english_phonetics import english_phones
        english_phones("12", "en-us")  # Warm Ukrainian number stress before reporting ready.
        list(self._english("sara_archive", "Ready.", 1.0, "en-us"))

    def _english(self, profile, text, speed, accent):
        from english_phonetics import english_phones
        accent = "en-gb" if accent == "en-gb" else "en-us"
        for sentence in SENTENCES.finditer(SPACE.sub(" ", text).strip()):
            phonemes = english_phones(sentence.group().strip(), accent)
            if phonemes.strip(" .,!?:;…—"):
                yield from self.holos.stream(
                    phonemes, voice=self._holos_style(profile), speed=speed, chunk_frames=40,
                )

    def synthesize(self, profile, language, text, speed=1.0):
        clips = list(self.chunks(profile, language, text, speed, stream=False))
        audio = np.concatenate(clips) if clips else np.zeros(self.output_rate // 50, dtype=np.float32)
        return audio, self.output_rate

    def chunks(self, profile, language, text, speed=1.0, stream=True, segments=None):
        from speech_tempo import stream_tempo
        # Keep every phoneme and its natural contour. Scaling integer model
        # durations directly erased short vowels and consonants at higher rates.
        chunks = self._joined_chunks(profile, segments) if segments else self._natural_chunks(profile, language, text)
        delivery = self.delivery_profiles.get(profile)
        if delivery is not None:
            from voice_delivery import condition_shared
            chunks = condition_shared(chunks, delivery["gain"], delivery["quiet"])
        elif profile in {"innesa", "vira"}:
            from clean_voice_audio import reduce_high_frequency_noise
            chunks = reduce_high_frequency_noise(chunks)
        yield from stream_tempo(chunks, self.output_rate, speed)

    @cached_property
    def delivery_profiles(self):
        path = self.references / "delivery_profiles.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}

    @lru_cache(maxsize=512)
    def english_reference_length(self, text, language):
        from english_phonetics import english_phones
        phonemes = english_phones(text, language)
        if not phonemes.strip(" .,!?:;…—"):
            return 0
        tokens = self.holos.tokenizer.encode_with_boundaries(phonemes)
        return self.holos.encoder_session.reference_frames(tokens) * self.holos.samples_per_frame

    @cached_property
    def english_voice_profiles(self):
        path = self.models / "english_voice_profiles.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def native_english_chunks(self, profile, language, text, speed):
        from converted_voices import resample
        from speech_text import english_text
        from speech_tempo import stream_tempo
        from voice_controls import apply_stream_controls
        from voice_delivery import calibrated_english, condition_shared

        source, pitch = self.english_voice_profiles[profile]
        delivery = self.delivery_profiles.get(profile)
        accent = language.lower().replace("_", "-")

        def render():
            normalized = english_text(text, number_language="uk")
            for part_language, part in split_mixed(normalized, "en"):
                self.check_cancelled()
                if part_language == "uk":
                    blocks = self._ukrainian(profile, part, 1.0)
                    if delivery is not None:
                        blocks = condition_shared(blocks, delivery["gain"], delivery["quiet"])
                    yield from blocks
                    continue
                audio = self._piper_audio(source, part, 1.0, accent=accent)
                if audio.size:
                    audio = resample(audio, self.sampling_rate, self.output_rate) * .70
                    pitched = np.concatenate(list(apply_stream_controls((audio,), self.output_rate, pitch_scale=pitch)))
                    if delivery is None:
                        yield pitched
                        continue
                    reference = self.english_reference_length(part, accent)
                    target = int(np.clip(reference, len(pitched) * .60, len(pitched) * 2.10)) if reference else None
                    yield calibrated_english(pitched, delivery["english_eq"], target)

        yield from stream_tempo(render(), self.output_rate, speed)

    def _joined_chunks(self, profile, segments):
        from english_phonetics import english_phones
        from russian_phonetics import russian_phones
        from latin_phonetics import latin_phones
        from latin_languages import EXTRA
        from ipa_uk import ipa
        phones = []
        for language, text in segments:
            if language == "uk":
                part = ipa(accent_text(speak_numbers(text, "uk")))
            elif language == "ru":
                part = russian_phones(text)
            elif language in EXTRA:
                part = latin_phones(text,language)
            else:
                part = english_phones(text, language)
            if part.strip():
                phones.append(part)
        if phones:
            yield from self.holos.stream(" ".join(phones), voice=self._holos_style(profile),
                                         speed=1.0, chunk_frames=40)

    def _natural_chunks(self, profile, language, text):
        accent = (language or "").lower().replace("_", "-")
        lang = accent.split("-")[0]
        from latin_languages import EXTRA
        if lang in EXTRA:
            for sentence in SENTENCES.finditer(SPACE.sub(" ", text).strip()):
                yield from self._joined_chunks(profile, [(lang, sentence.group())])
            return
        if lang == "uk":
            yield from self._ukrainian(profile, text, 1.0)
            return
        if lang == "en":
            yield from self._english(profile, text, 1.0, accent)
            return
        if lang == "ru":
            for sentence in SENTENCES.finditer(SPACE.sub(" ", text).strip()):
                yield from self._joined_chunks(profile, [("ru", sentence.group())])
            return
        # Language changes inside a sentence are phonetic changes, not new
        # utterances. Restarting the model for each Latin word reset its
        # intonation and inserted an audible boundary around application names.
        from english_phonetics import english_phones
        from ipa_uk import ipa
        for sentence in SENTENCES.finditer(SPACE.sub(" ", text).strip()):
            runs = list(split_mixed(sentence.group()))
            if len(runs) == 1:
                target, phrase = runs[0]
                if target == "uk":
                    yield from self._ukrainian(profile, phrase, 1.0)
                else:
                    yield from self._english(profile, phrase, 1.0, accent)
                continue
            phones = []
            for target, phrase in runs:
                phones.append(ipa(accent_text(speak_numbers(phrase, "uk"))) if target == "uk"
                              else english_phones(phrase, "en-us"))
            phonemes = " ".join(phones)
            if phonemes.strip(" .,!?:;…—"):
                yield from self.holos.stream(
                    phonemes, voice=self._holos_style(profile), speed=1.0, chunk_frames=40,
                )
