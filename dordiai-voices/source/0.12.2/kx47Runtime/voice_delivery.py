"""Shared amplitude and timing treatment for prepared and live speech."""
from functools import lru_cache
import json
from pathlib import Path

import numpy as np

SAMPLE_RATE = 24000
REFERENCE_LEVEL = .112
LIMITER_START = .82
LIMITER_RANGE = .16


def speech_level(audio):
    samples = np.asarray(audio, dtype=np.float32)
    width = min(len(samples), SAMPLE_RATE // 50)
    if width == 0:
        return 0.0
    frames = samples[:len(samples) // width * width].reshape(-1, width)
    energy = np.sqrt(np.mean(frames ** 2, axis=1))
    return float(np.quantile(energy, .80))


def peak_limit(audio):
    limit = np.abs(audio) > LIMITER_START
    if np.any(limit):
        audio = audio.copy()
        samples = audio[limit]
        audio[limit] = np.sign(samples) * (LIMITER_START + LIMITER_RANGE *
                                          np.tanh((np.abs(samples) - LIMITER_START) / LIMITER_RANGE))
    return audio


def match_level(audio, reference=REFERENCE_LEVEL):
    level = speech_level(audio)
    if level < 1e-5:
        return audio
    return peak_limit(audio * np.clip(reference / level, .32, 4.0))


def fir(chunks, taps):
    coefficients = np.asarray(taps, dtype=np.float32)
    history = np.zeros(len(coefficients) - 1, dtype=np.float32)
    for chunk in chunks:
        if chunk.size:
            joined = np.concatenate((history, np.asarray(chunk, dtype=np.float32)))
            yield np.convolve(joined, coefficients, mode="valid")
            history = joined[-history.size:].copy()


@lru_cache(maxsize=1)
def rumble_filter():
    positions = np.arange(-120, 121, dtype=np.float32)
    low = np.sinc(2 * 76 / SAMPLE_RATE * positions) * np.hanning(positions.size)
    high = (-low / low.sum() * .75).astype(np.float32)
    high[positions.size // 2] += 1
    return high


def quiet_expander(chunks, threshold):
    level_before = 1.0
    frame = 240
    for chunk in chunks:
        if not chunk.size:
            continue
        filtered = np.empty_like(chunk)
        for offset in range(0, len(chunk), frame):
            section = chunk[offset:offset + frame]
            level = min(1.0, max(.25, float(np.sqrt(np.mean(section ** 2))) / threshold))
            # Keep consonant attacks and crossfade the release.
            target = level if level > level_before else .60 * level + .40 * level_before
            start = target if target > level_before else level_before
            filtered[offset:offset + len(section)] = section * np.linspace(start, target, len(section), dtype=np.float32)
            level_before = target
        yield filtered


def condition_shared(chunks, gain, threshold=0.0):
    if threshold:
        chunks = quiet_expander(fir(chunks, rumble_filter()), threshold)
    for audio in chunks:
        yield peak_limit(audio * gain)


def compact_padding(chunks, text):
    """Remove model padding at utterance edges while preserving pauses within speech."""
    frame = SAMPLE_RATE // 100
    leading = 4 * frame
    maximum_pending = 80 * frame
    ending = text.rstrip().rstrip('»”’"\')]}')
    trailing = (16 if ending.endswith((".", "!", "?", "…")) else
                11 if ending.endswith((",", ";", ":", "—")) else 7) * frame
    heard_speech = False
    pending = np.empty(0, dtype=np.float32)
    for audio in chunks:
        if not audio.size:
            continue
        starts = np.arange(0, len(audio), frame)
        voiced = np.flatnonzero(np.maximum.reduceat(np.abs(audio), starts) >= .007)
        if not voiced.size:
            pending = np.concatenate((pending, audio))
            if not heard_speech:
                pending = pending[-leading:]
            elif pending.size > maximum_pending:
                yield pending[:-maximum_pending]
                pending = pending[-maximum_pending:]
            continue
        start = int(starts[voiced[0]])
        stop = min(len(audio), int(starts[voiced[-1]]) + frame)
        prefix = np.concatenate((pending, audio[:start]))
        if not heard_speech:
            prefix = prefix[-leading:]
            heard_speech = True
        yield np.concatenate((prefix, audio[start:stop])) if prefix.size else audio[start:stop]
        pending = audio[stop:].copy()
    if pending.size:
        yield pending[:trailing]


@lru_cache(maxsize=4)
def delivery_equalizers(references):
    path = Path(references) / "delivery_equalizers.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def equalize_voice(chunks, references, profile, language):
    locale = language.split("-")[0] if language else "uk"
    taps = delivery_equalizers(references).get(profile, {}).get(locale)
    if not taps:
        yield from chunks
        return
    for audio in fir(chunks, taps):
        yield peak_limit(audio)


def clean_onset(chunks, *, character=False):
    """De-click phrase edges and soften upper-band noise without deleting consonants."""
    position = 0
    past = np.zeros(2, dtype=np.float32)
    for block in chunks:
        if not block.size:
            continue
        joined = np.concatenate((past, block))
        filtered = .59 * joined[2:] + .28 * joined[1:-1] + .13 * joined[:-2]
        past = joined[-2:].copy()
        indices = np.arange(position, position + len(block), dtype=np.float32)
        position += len(block)
        weight = .82 if character else np.clip((1680.0 - indices) / 1440.0, 0., 1.) * .72
        sound = block + (filtered - block) * weight
        ramp = np.clip(indices / 110, 0., 1.)
        if indices[0] < 110:
            sound *= ramp * ramp * (3. - 2. * ramp)
        yield sound


def prepare_letter(audio):
    """Keep the onset near the first clear sound and preserve the full letter name."""
    audio = np.asarray(audio, dtype=np.float32)
    if audio.size < SAMPLE_RATE // 25:
        raise ValueError("Letter sound is too short")
    width = 120
    frames = audio[:len(audio) // width * width].reshape(-1, width)
    amplitude = np.max(np.abs(frames), axis=1)
    active = np.flatnonzero(amplitude >= max(.004, float(amplitude.max()) * .055))
    if active.size:
        begin = max(0, (int(active[0]) - 3) * width)
        end = min(len(audio), (int(active[-1]) + 5) * width)
        if end - begin >= SAMPLE_RATE // 25:
            audio = audio[begin:end]
    output = next(clean_onset((audio,), character=True))
    tail = min(120, len(output) // 8)
    if tail:
        output[-tail:] *= np.linspace(1, 0, tail, dtype=np.float32)
    return match_level(output)


def calibrated_english(audio, tone, target_frames):
    from speech_tempo import change_tempo

    if tone:
        audio = np.concatenate(list(fir((audio,), tone)))
    if target_frames is not None and target_frames > 0:
        ratio = min(4.0, max(.25, len(audio) / target_frames))
        audio = change_tempo(audio, SAMPLE_RATE, ratio)
        if len(audio) > target_frames:
            audio = audio[:target_frames].copy()
            tail = min(144, target_frames // 8)
            if tail:
                audio[-tail:] *= np.linspace(1, 0, tail, dtype=np.float32)
        elif len(audio) < target_frames:
            audio = np.pad(audio, (0, target_frames - len(audio)))
    return match_level(audio)
