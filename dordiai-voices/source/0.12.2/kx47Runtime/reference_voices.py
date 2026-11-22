"""Local OmniVoice speech for the two project reference voices."""
from functools import cached_property
import importlib.util
from pathlib import Path

import numpy as np


REFERENCE_NAMES = {"brianna": "Бріанна", "sara": "Сара"}


class ReferenceVoices:
    def __init__(self, models, references, threads=4):
        self.models = Path(models)
        self.references = Path(references)
        self.threads = threads
        self.prompts = {}

    @cached_property
    def engine(self):
        import onnxruntime
        import torch

        onnxruntime.disable_telemetry_events()
        torch.set_num_threads(self.threads)
        script = self.models / "use_onnx.py"
        spec = importlib.util.spec_from_file_location("kx47_omnivoice", script)
        if spec is None or spec.loader is None:
            raise RuntimeError("OmniVoice backend is missing.")
        backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(backend)
        return backend.load(self.models, self.threads)

    def synthesize(self, profile, language, text, speed=1.0):
        engine = self.engine
        if profile not in self.prompts:
            reference = self.references / (REFERENCE_NAMES[profile] + ".wav")
            transcript = reference.with_suffix(".txt").read_text(encoding="utf-8").strip()
            if not transcript:
                raise ValueError("The voice reference needs a transcript.")
            self.prompts[profile] = engine.create_voice_clone_prompt(
                ref_audio=str(reference), ref_text=transcript,
            )
        for steps in (8, 12):
            result = engine.generate(
                text=text, language=language.split("-")[0] if language else None,
                voice_clone_prompt=self.prompts[profile], num_step=steps, guidance_scale=3.0,
                speed=speed,
            )[0]
            audio = np.asarray(result, dtype=np.float32)
            if audio.ndim == 1 and audio.size >= engine.sampling_rate / 10 and np.isfinite(audio).all():
                return audio, engine.sampling_rate
        raise ValueError("OmniVoice returned invalid audio.")
