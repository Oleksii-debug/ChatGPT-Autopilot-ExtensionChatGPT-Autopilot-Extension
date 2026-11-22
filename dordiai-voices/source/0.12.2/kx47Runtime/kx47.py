"""Local TTS prototype. All synthesis takes place on the current computer."""
import argparse
import re
import time
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ukrainian_stress import prepare_ukrainian


@dataclass(frozen=True)
class VoiceProfile:
    ukrainian_model: str
    american_sid: int
    british_sid: int
    multilingual_sid: int


PROFILES = {
    "a": VoiceProfile("uk_UA-tetiana-high", 3, 21, 0),
    "b": VoiceProfile("uk_UA-lada-x_low", 2, 20, 1),
}
LANGUAGES = ("uk", "en-US", "en-GB", "ru")
MARKERS = re.compile(r"(\[(?:uk|en-US|en-GB|ru)\])")


def split_languages(text, default):
    current = default
    for index, part in enumerate(MARKERS.split(text)):
        if index % 2:
            current = part[1:-1]
        elif part.strip():
            yield current, part.strip()


class LocalSynthesizer:
    def __init__(self, model_dir, threads=2):
        self.model_dir = Path(model_dir)
        self.threads = threads
        self.ukrainian_voices = {}
        self.english_engines = {}
        self.multilingual_engine = None

    def _piper(self, model):
        import onnxruntime
        from piper import PiperVoice

        onnxruntime.disable_telemetry_events()
        if model not in self.ukrainian_voices:
            path = self.model_dir / "piper" / f"{model}.onnx"
            self._require_files(path, path.with_suffix(".onnx.json"))
            self.ukrainian_voices[model] = PiperVoice.load(path)
        return self.ukrainian_voices[model]

    @staticmethod
    def _require_files(*paths):
        for path in paths:
            if not path.is_file():
                raise FileNotFoundError(f"Model file missing: {path}. See README.md.")

    def _kokoro(self, language):
        import sherpa_onnx as sherpa

        if language not in self.english_engines:
            root = self.model_dir / "kokoro-int8-multi-lang-v1_0"
            model, voices, tokens, lexicon = (
                root / filename for filename in (
                    "model.int8.onnx", "voices.bin", "tokens.txt",
                    f"lexicon-{language[-2:].lower()}-en.txt",
                )
            )
            self._require_files(model, voices, tokens, lexicon, root / "espeak-ng-data" / "phondata")
            config = sherpa.OfflineTtsKokoroModelConfig(
                model=str(model), voices=str(voices), tokens=str(tokens),
                lexicon=str(lexicon), data_dir=str(root / "espeak-ng-data"),
            )
            self.english_engines[language] = sherpa.OfflineTts(sherpa.OfflineTtsConfig(
                model=sherpa.OfflineTtsModelConfig(kokoro=config, num_threads=self.threads),
            ))
        return self.english_engines[language]

    def _supertonic(self):
        import sherpa_onnx as sherpa

        if self.multilingual_engine is None:
            root = self.model_dir / "sherpa-onnx-supertonic-3-tts-int8-2026-05-11"
            parts = {
                "duration_predictor": root / "duration_predictor.int8.onnx",
                "text_encoder": root / "text_encoder.int8.onnx",
                "vector_estimator": root / "vector_estimator.int8.onnx",
                "vocoder": root / "vocoder.int8.onnx",
                "tts_json": root / "tts.json",
                "unicode_indexer": root / "unicode_indexer.bin",
                "voice_style": root / "voice.bin",
            }
            self._require_files(*parts.values())
            config = sherpa.OfflineTtsSupertonicModelConfig(**{
                part: str(path) for part, path in parts.items()
            })
            self.multilingual_engine = sherpa.OfflineTts(sherpa.OfflineTtsConfig(
                model=sherpa.OfflineTtsModelConfig(supertonic=config, num_threads=self.threads),
            ))
        return self.multilingual_engine

    def synthesize(self, profile, language, text, mode="pronunciation", speed=1.0):
        if mode == "pronunciation" and language == "uk":
            from piper import SynthesisConfig

            voice = self._piper(profile.ukrainian_model)
            chunks = [
                chunk.audio_float_array
                for chunk in voice.synthesize(
                    prepare_ukrainian(text, voice),
                    syn_config=SynthesisConfig(length_scale=1 / speed),
                )
            ]
            return np.concatenate(chunks) if chunks else np.array([]), voice.config.sample_rate

        import sherpa_onnx as sherpa

        config = sherpa.GenerationConfig()
        config.speed = speed
        if mode == "pronunciation" and language in ("en-US", "en-GB"):
            engine = self._kokoro(language)
            config.sid = profile.british_sid if language == "en-GB" else profile.american_sid
            config.extra = {"lang": language.lower()}
        else:
            engine = self._supertonic()
            config.sid = profile.multilingual_sid
            config.num_steps = 6
            config.extra = {"lang": language.split("-")[0]}
        audio = engine.generate(text, config)
        return np.asarray(audio.samples), audio.sample_rate


OUTPUT_RATE = 24000


def write_audio(path, sections, gap=0.24):
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, OUTPUT_RATE, 0, "NONE", "not compressed"))
        for index, (audio, rate) in enumerate(sections):
            if index:
                output.writeframes(b"\x00\x00" * round(OUTPUT_RATE * gap))
            if rate != OUTPUT_RATE:
                positions = np.arange(round(len(audio) * OUTPUT_RATE / rate)) * rate / OUTPUT_RATE
                audio = np.interp(positions, np.arange(len(audio)), audio)
            output.writeframes(np.rint(np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())


UK_DEMO = (
    "На горі стоїть за́мок. На дверях висить замо́к. "
    "Просійте муку́. Це справжня му́ка. "
    "Перед нами а́тлас світу. Для сукні взяли атла́с. "
    "Ви́брано три файли. Кнопка Зберегти́. Оно́влення завершено."
)
EN_DEMO = (
    "The last train is at half past four. Would you like a glass of water? "
    "Open the folder. Three files are selected. Press Control, Shift, S."
)
MIXED_DEMO = (
    "[uk] Відкрийте [en-US] Google Drive [uk] і натисніть [en-US] Save. "
    "[uk] Оно́влення завершено."
)


def render_segments(engine, profile, segments, mode, speed):
    sections = []
    for language, text in segments:
        start = time.perf_counter()
        audio, rate = engine.synthesize(profile, language, text, mode, speed)
        if rate <= 0 or not len(audio) or not np.isfinite(audio).all():
            raise RuntimeError(f"Invalid synthesis output for {language}.")
        elapsed_ms = (time.perf_counter() - start) * 1000
        print(f"{language}: {len(audio) / rate:.2f} s audio, {elapsed_ms:.0f} ms processing")
        sections.append((audio, rate))
    if not sections:
        raise ValueError("Text contains no speech.")
    return sections


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--profile", choices=PROFILES, default="a")
    parser.add_argument("--mode", choices=("pronunciation", "same-voice"), default="pronunciation")
    parser.add_argument("--lang", choices=LANGUAGES, default="uk")
    parser.add_argument("--speed", type=float, default=1)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--out", type=Path, required=True)
    text_input = parser.add_mutually_exclusive_group(required=True)
    text_input.add_argument("--text")
    text_input.add_argument("--text-file", type=Path)
    text_input.add_argument("--demo", action="store_true")
    args = parser.parse_args()
    if not 0.5 <= args.speed <= 2 or args.threads < 1:
        parser.error("speed must be between 0.5 and 2.0 and threads must be positive")
    engine = LocalSynthesizer(args.models, args.threads)
    profile = PROFILES[args.profile]
    if args.demo:
        segments = [("uk", UK_DEMO), ("en-US", EN_DEMO), ("en-GB", EN_DEMO)]
        if args.mode == "same-voice":
            segments = list(split_languages(MIXED_DEMO, "uk"))
    else:
        text = args.text_file.read_text(encoding="utf-8-sig") if args.text_file else args.text
        segments = list(split_languages(text, args.lang))
    try:
        audio = render_segments(engine, profile, segments, args.mode, args.speed)
        write_audio(args.out, audio)
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
