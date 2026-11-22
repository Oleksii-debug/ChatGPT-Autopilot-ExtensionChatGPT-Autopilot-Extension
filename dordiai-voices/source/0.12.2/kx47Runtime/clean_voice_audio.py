"""Reduce high-frequency noise on selected profiles without resetting at speech blocks."""
import numpy as np

# A gradual low-pass near 7.6 kHz at 24 kHz. Mix in some dry signal to
# preserve unvoiced consonants and leave the phoneme timing intact.
_offsets = np.arange(-16, 17, dtype=np.float32)
_coefficients = (2 * 7600 / 24000) * np.sinc(2 * 7600 / 24000 * _offsets) * np.hanning(_offsets.size)
_coefficients = (_coefficients / _coefficients.sum() * .80).astype(np.float32)
_coefficients[16] += .20


def reduce_high_frequency_noise(chunks):
    latest = np.zeros(_coefficients.size - 1, dtype=np.float32)
    for chunk in chunks:
        if chunk.size:
            joined = np.concatenate((latest, chunk))
            yield np.convolve(joined, _coefficients, mode="valid")
            latest = joined[-latest.size:]


# The selected speakers can produce disproportionately loud sibilants.
# Reduce the narrow upper band only when it exceeds the speech ceiling.
_deess_offsets = np.arange(-22, 23, dtype=np.float32)
_deess_low = (np.sinc(2 * 6200 / 24000 * _deess_offsets) * np.hanning(_deess_offsets.size)).astype(np.float32)
_deess_low /= _deess_low.sum()
_deess_high = -_deess_low
_deess_high[22] += 1.0


def tame_sibilance_stream(chunks, ceiling=.016):
    delay = 22
    history = np.zeros(2 * delay, dtype=np.float32)
    skip = delay
    gain = 1.0

    def process(block):
        nonlocal history, skip, gain
        joined = np.concatenate((history, block))
        high = np.convolve(joined, _deess_high, mode="valid")
        signal = joined[delay:delay + len(block)].copy()
        history = joined[-2 * delay:].copy()
        for start in range(0, len(block), 120):
            selected = slice(start, start + 120)
            band = high[selected]
            level = float(np.sqrt(np.mean(band ** 2)))
            target = max(.26, min(1.0, ceiling / max(level, 1e-6)))
            attack = min(gain, target)
            gain = target if target < gain else .35 * target + .65 * gain
            signal[selected] += band * (np.linspace(attack, gain, len(band), dtype=np.float32) - 1.0)
        drop = min(len(signal), skip)
        skip -= drop
        return signal[drop:]

    rendered = False
    for block in chunks:
        if block.size:
            output = process(block)
            if output.size:
                yield output
            rendered = True
    if rendered:
        output = process(np.zeros(delay, dtype=np.float32))
        if output.size:
            yield output
