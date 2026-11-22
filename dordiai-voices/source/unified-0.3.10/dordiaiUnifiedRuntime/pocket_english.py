"""Stream English speech from a speaker reference with Pocket TTS 18M on CPU.

The model layout and sampling settings follow the public ONNX export by Maxime Vidal.
"""
from __future__ import annotations

from functools import cached_property
import json
import math
from pathlib import Path
import re
import sys

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "Моделі/PocketTTS/English 18M"
TOKENIZER = ROOT / "Інструменти/PocketTTS/TokenizerPython"


class PocketEnglish:
    def __init__(self, threads: int = 2, model: Path | None = None):
        self.model = Path(model) if model is not None else MODEL
        if model is None:
            sys.path.insert(0, str(TOKENIZER))
        from sentencepiece import SentencePieceProcessor

        self.config = json.loads((self.model / "bundle.json").read_text(encoding="utf-8"))
        self.rate = int(self.config["sample_rate"])
        self.frame_size = int(self.config["frame_size"])
        self.frame_rate = float(self.config["frame_rate"])
        self.latent_dim = int(self.config["dims"]["latent"])
        self.text_dim = int(self.config["dims"]["text_embedding"])
        self.flow_states = self.config["graphs"]["flow_lm_main"]["states"]
        self.audio_states = self.config["graphs"]["mimi_decoder"]["states"]
        self.empty_sequence = np.zeros((1, 0, self.latent_dim), np.float32)
        self.empty_text = np.zeros((1, 0, self.text_dim), np.float32)
        self.options = self._session_options(threads)
        self.offline_options = self._session_options(threads)
        self.offline_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        self.tokenizer = SentencePieceProcessor(model_file=str(self.model / "tokenizer.model"))

    @staticmethod
    def _session_options(threads):
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        return options

    def _session(self, name: str) -> ort.InferenceSession:
        prepared = self.model / f"{name}.ort"
        if prepared.is_file():
            try:
                return ort.InferenceSession(str(prepared), sess_options=self.offline_options,
                                            providers=["CPUExecutionProvider"])
            except Exception as error:
                print(f"Prepared English model {name}: {type(error).__name__}", file=sys.stderr)
        return ort.InferenceSession(
            str(self.model / f"{name}.onnx"),
            sess_options=self.options,
            providers=["CPUExecutionProvider"],
        )

    @cached_property
    def encoder(self):
        return self._session("mimi_encoder")

    @cached_property
    def main(self):
        return self._session("flow_lm_main_int8")

    @cached_property
    def text_model(self):
        return self._session("text_conditioner")

    @cached_property
    def flow(self):
        return self._session("flow_lm_flow")

    @cached_property
    def decoder(self):
        return self._session("mimi_decoder")

    def warmup(self):
        return self.main, self.flow, self.decoder, self.text_model

    @staticmethod
    def _empty_state(specifications, capacity: int = 0):
        return {
            spec["name"]: np.zeros(
                tuple(capacity if size < 0 else size for size in spec["shape"]),
                np.dtype(spec["dtype"]),
            )
            for spec in specifications
        }

    def _flow_step(self, sequence, text, prior):
        names = [spec["output"] for spec in self.flow_states]
        samples = self.main.run(
            ["conditioning", "eos_logit", *names],
            {"sequence": sequence, "text_embeddings": text, **prior},
        )
        states = {spec["name"]: value for spec, value in zip(self.flow_states, samples[2:])}
        return samples[0], float(samples[1].item()), states

    def enroll(self, sample: np.ndarray):
        sample = np.asarray(sample, dtype=np.float32)
        if sample.ndim != 1 or not self.rate <= sample.size <= self.rate * 15:
            raise ValueError("Для Pocket TTS потрібен монофонічний зразок тривалістю від 1 до 15 секунд.")
        if not np.isfinite(sample).all():
            raise ValueError("Зразок голосу пошкоджений.")
        sample = np.pad(sample, (0, (-len(sample)) % self.frame_size))
        (prompt,) = self.encoder.run(["conditioning"], {"audio": sample.reshape(1, 1, -1)})
        if self.config["insert_bos_before_voice"]:
            bos = np.load(self.model / "bos_before_voice.npy", allow_pickle=False)
            prompt = np.concatenate((bos, prompt), axis=1)
        _, _, states = self._flow_step(
            self.empty_sequence, prompt, self._empty_state(self.flow_states, prompt.shape[1])
        )
        return states

    def _state_for_text(self, speaker, capacity):
        count = int(speaker["state_offset"].item())
        base = self._empty_state(self.flow_states, count + capacity)
        for name, prior in base.items():
            value = speaker[name]
            if name == "state_offset":
                prior[:] = value
            else:
                prior[:, :, :count] = value
        return base

    def _prepared_text(self, text: str):
        text = " ".join(text.strip().translate(str.maketrans({"–": ",", "—": ",", "’": "'", "‘": "'"})).split())
        if not text:
            raise ValueError("Порожній текст.")
        if text[-1] not in ".!?":
            text += "."
        ids = self.tokenizer.encode(text, out_type=int)
        if not ids:
            raise ValueError("У тексті немає токенів для озвучення.")
        return text, ids

    def _chunks(self, text: str):
        for sentence in re.findall(r"[^.!?]+(?:[.!?]+|$)", text):
            words = sentence.split()
            if not words:
                continue
            part = []
            for word in words:
                trial = " ".join([*part, word])
                if len(self.tokenizer.encode(trial, out_type=int)) > 64 and part:
                    yield " ".join(part)
                    part = []
                part.append(word)
            yield " ".join(part)

    def _sentence(self, sentence, speaker, rng, temperature):
        text, tokens = self._prepared_text(sentence)
        settings, eos = self.config["max_gen"], self.config["eos"]
        budget = math.ceil((len(tokens) / settings["tokens_per_second"] +
                            settings["padding_seconds"]) * self.frame_rate)
        (embedding,) = self.text_model.run(["embeddings"], {"token_ids": np.array([tokens], np.int64)})
        prior = self._state_for_text(speaker, len(tokens) + budget)
        _, _, state = self._flow_step(self.empty_sequence, embedding, prior)
        decode = self._empty_state(self.audio_states)
        decode_outputs = [spec["output"] for spec in self.audio_states]
        tail = eos["frames_after_eos"]
        keep = tail["short"] if len(text.split()) <= tail["max_short_words"] else tail["long"]
        latent = np.full((1, 1, self.latent_dim), np.nan, np.float32)
        sigma = math.sqrt(temperature)
        pending = []
        stop = budget
        chunk_size = 1
        for step in range(budget):
            condition, logit, state = self._flow_step(latent, self.empty_text, state)
            if logit > eos["threshold"] and step >= eos["min_frames"] and stop == budget:
                stop = min(stop, step + keep)
            noise = (rng.standard_normal((1, self.latent_dim), dtype=np.float32) * sigma)
            (layer,) = self.flow.run(["latent"], {"c": condition, "x": noise})
            latent = layer[:, None]
            pending.append(latent)
            last = step + 1 >= stop
            if len(pending) >= chunk_size or last:
                clips = self.decoder.run(
                    ["audio", *decode_outputs], {"latent": np.concatenate(pending, axis=1), **decode}
                )
                decode = {spec["name"]: value for spec, value in zip(self.audio_states, clips[1:])}
                audio = clips[0].reshape(-1)
                if chunk_size == 1:
                    audio[:120] *= np.linspace(0, 1, 120, dtype=np.float32)
                yield audio
                pending.clear()
                chunk_size = min(4, chunk_size * 2)
            if last:
                break

    def stream(self, text: str, speaker, seed: int = 190, temperature: float | None = None):
        temperature = float(self.config["temperature"]) if temperature is None else temperature
        if not 0 <= temperature <= 1:
            raise ValueError("Invalid sampling temperature.")
        rng = np.random.default_rng(seed)
        for sentence in self._chunks(text):
            yield from self._sentence(sentence, speaker, rng, temperature)
