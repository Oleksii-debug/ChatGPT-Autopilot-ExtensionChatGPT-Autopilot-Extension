"""Correlate the exact own calibration marker with bounded render-loopback PCM.

This measures a software transport waveform match, never audible/acoustic latency.
NumPy is a CI-only dependency; no product or device configuration is modified.
"""
from __future__ import annotations
import hashlib
import math
import numpy as np

MAX_BYTES = 32 * 1024 * 1024


def decode(raw, format):
    rate, channels = format["sample_rate"], format["channels"]
    encoding = format["native_encoding"]
    if type(rate) is not int or not 8000 <= rate <= 192000 or channels != 2:
        raise ValueError("Expected bounded native stereo format")
    dtype, bits = ("<f4", 32) if encoding == "float32le" else ("<i2", 16) if encoding == "pcm16le" else (None, None)
    if dtype is None or format["bits_per_sample"] != bits or format["block_align"] != channels * (bits // 8):
        raise ValueError("Unsupported or inconsistent native format")
    if not raw or len(raw) > MAX_BYTES or len(raw) % format["block_align"]:
        raise ValueError("Empty, unbounded or unaligned PCM")
    data = np.frombuffer(raw, dtype=dtype).astype(np.float64).reshape(-1, channels)
    if encoding == "pcm16le":
        data /= 32768.0
    if not np.isfinite(data).all():
        raise ValueError("Nonfinite PCM")
    return data


def correlate(reference_raw, captured_raw, format):
    reference, captured = decode(reference_raw, format), decode(captured_raw, format)
    rate = format["sample_rate"]
    n, m = len(reference), len(captured)
    if n != rate or not n <= m <= 3 * rate:
        raise ValueError("Expected complete one-second reference within three-second capture")
    coefficients, gains = [], []
    fft_size = 1 << (n + m - 2).bit_length()
    for channel in range(2):
        ref, signal = reference[:, channel], captured[:, channel]
        centered = ref - ref.mean()
        ref_energy = float(np.dot(centered, centered))
        if ref_energy <= 1e-12:
            raise ValueError("Reference has no usable variation")
        # valid cross-correlation. Prefix sums give each candidate window's
        # exact mean/energy, so padding or unrelated silence cannot inflate NCC.
        convolution = np.fft.irfft(np.fft.rfft(signal, fft_size) *
                                    np.fft.rfft(centered[::-1], fft_size), fft_size)[n-1:m]
        sums = np.concatenate(([0.0], np.cumsum(signal)))
        squares = np.concatenate(([0.0], np.cumsum(signal * signal)))
        window_sum = sums[n:] - sums[:-n]
        energies = np.maximum(0.0, squares[n:] - squares[:-n] - window_sum * window_sum / n)
        denominator = np.sqrt(energies * ref_energy)
        coefficient = np.divide(convolution, denominator, out=np.zeros_like(convolution), where=denominator > 1e-15)
        coefficients.append(np.clip(coefficient, -1.0, 1.0))
        gains.append(convolution / ref_energy)
    combined = np.minimum(coefficients[0], coefficients[1])
    offset = int(np.argmax(combined))
    channel_results = []
    for channel in range(2):
        window = captured[offset:offset+n, channel]
        channel_results.append({"channel": channel, "normalized_correlation": float(coefficients[channel][offset]),
                                "least_squares_gain": float(gains[channel][offset]),
                                "captured_window_rms": float(math.sqrt(np.mean(window * window)))})
    verified = all(row["normalized_correlation"] >= .98 and row["least_squares_gain"] > 0 and
                   row["captured_window_rms"] > 1e-8 for row in channel_results)
    return {"format": "dordiai-own-marker-loopback-correlation", "format_version": 1,
            "status": "correlated" if verified else "not-correlated",
            "known_marker_correlated_verified": verified, "virtual_audio_verified": verified,
            "physical_audio_verified": False, "acoustic_latency_verified": False,
            "requested_phrase_waveform_match_verified": False, "product_ready": False,
            "reference_sha256": hashlib.sha256(reference_raw).hexdigest(),
            "captured_sha256": hashlib.sha256(captured_raw).hexdigest(),
            "reference_frames": n, "captured_frames": m, "matched_capture_array_offset_frames": offset,
            "offset_scope": "Index in retained software PCM array, not calibrated time or acoustic latency",
            "threshold_each_channel": .98, "channels": channel_results,
            "numpy_version": np.__version__,
            "scope": "Complete exact own marker positive waveform NCC in both native channels; amplitude/physical sound not certified"}
