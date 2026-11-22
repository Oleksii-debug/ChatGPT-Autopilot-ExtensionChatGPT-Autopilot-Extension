"""Strict owned-NVDA capture receipts and full-window mono waveform comparison."""
from __future__ import annotations
import hashlib
import json
import math
from pathlib import Path
import stat

SAMPLE_RATES = (22050, 24000, 48000)
MAX_PCM_BYTES = 2 * 48000 * 10


def read_json(path, limit=2*1024*1024):
    path = Path(path)
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode) or not 0 < path.stat().st_size <= limit:
        raise ValueError("Only bounded owned regular JSON accepted")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def read_pcm(path, receipt):
    path = Path(path)
    if (not isinstance(receipt, dict) or receipt.get("filename") != path.name or path.is_symlink()
            or not stat.S_ISREG(path.stat().st_mode) or not 0 < path.stat().st_size <= MAX_PCM_BYTES):
        raise ValueError("Only bounded owned regular PCM accepted")
    raw = path.read_bytes()
    if (len(raw) != receipt.get("size_bytes") or len(raw) % 2
            or hashlib.sha256(raw).hexdigest() != receipt.get("sha256")):
        raise ValueError("Exact owned PCM receipt differs")
    return raw


def validate_ready(document, *, nvda_pid, controller_pid, nonce, config, image_sha):
    if (document.get("format") != "dordiai-owned-nvda-capture-ready" or document.get("status") != "ready"
            or document.get("pid") != nvda_pid or document.get("controller_pid") != controller_pid
            or document.get("probe_id") != nonce or document.get("synth") != "kx47Preview"
            or document.get("config") != str(config) or document.get("image_sha256") != image_sha
            or document.get("sample_rate") not in SAMPLE_RATES
            or document.get("recording_pcm_sink_test_double") is not False
            or document.get("physical_audio_verified") is not False):
        raise ValueError("Ready lease does not bind exact owned official NVDA/config/driver")
    return document["sample_rate"]


def validate_capture(document, *, nvda_pid, controller_pid, helper_pid, image_sha, ready_sha, sample_rate):
    own = document.get("ownership", {})
    if (document.get("status") != "technical-owned-nvda-capture-complete"
            or document.get("capture_mode") != "verified-owned-nvda-sibling-include-tree"
            or document.get("target_pid") != nvda_pid or document.get("current_pid") != helper_pid
            or document.get("async_callback_completed") is not True
            or document.get("all_own_com_interfaces_released") is not True or document.get("cleanup_errors") != []
            or own.get("target_pid") != nvda_pid or own.get("controller_pid") != controller_pid
            or own.get("helper_pid") != helper_pid or own.get("target_parent_pid") != controller_pid
            or own.get("helper_parent_pid") != controller_pid or own.get("same_controller_parent_verified") is not True
            or own.get("image_sha256") != image_sha or own.get("plugin_ready_sha256") != ready_sha):
        raise ValueError("Native capture is not exact held owned sibling-process capture")
    fmt = document.get("native_format", {})
    if (fmt.get("sample_rate") != sample_rate or fmt.get("channels") != 1
            or fmt.get("bits_per_sample") != 16 or fmt.get("block_align") != 2
            or fmt.get("native_encoding") != "pcm16le"):
        raise ValueError("Capture differs from actual real WavePlayer PCM format")
    for key in ("physical_audio_verified", "acoustic_latency_verified", "microphone_capture_used",
                "privacy_settings_changed", "default_device_changed", "format_changed",
                "service_restart_performed", "reboot_performed", "product_ready"):
        if document.get(key) is not False:
            raise ValueError("Owned capture scope changed: " + key)


def correlate_phrase(reference_raw, captured_raw, sample_rate):
    """Use the COMPLETE exact emitted reference at one positive NCC window."""
    import numpy as np
    if sample_rate not in SAMPLE_RATES:
        raise ValueError("Unrecognized actual driver sample rate")
    for raw in (reference_raw, captured_raw):
        if not raw or len(raw) % 2 or len(raw) > MAX_PCM_BYTES:
            raise ValueError("Bounded aligned actual mono PCM16 required")
    reference = np.frombuffer(reference_raw, dtype="<i2").astype(np.float64) / 32768.
    signal = np.frombuffer(captured_raw, dtype="<i2").astype(np.float64) / 32768.
    n, m = len(reference), len(signal)
    if not sample_rate // 10 <= n <= 8 * sample_rate or not n <= m <= 10 * sample_rate:
        raise ValueError("Complete phrase must fit bounded full capture")
    centered = reference - reference.mean()
    energy = float(np.dot(centered, centered))
    if energy <= 1e-12:
        raise ValueError("Actual phrase reference has no variation")
    fft = 1 << (n + m - 2).bit_length()
    dots = np.fft.irfft(np.fft.rfft(signal, fft) * np.fft.rfft(centered[::-1], fft), fft)[n-1:m]
    sums = np.concatenate(([0.], np.cumsum(signal)))
    squares = np.concatenate(([0.], np.cumsum(signal * signal)))
    window_sum = sums[n:] - sums[:-n]
    energies = np.maximum(0., squares[n:] - squares[:-n] - window_sum * window_sum / n)
    denominator = np.sqrt(energies * energy)
    ncc = np.divide(dots, denominator, out=np.zeros_like(dots), where=denominator > 1e-15)
    offset = int(np.argmax(ncc))
    coefficient = float(np.clip(ncc[offset], -1., 1.))
    gain = float(dots[offset] / energy)
    rms = float(math.sqrt(np.mean(signal[offset:offset+n] ** 2)))
    accepted = coefficient >= .98 and gain > 0 and rms > 1e-8
    return {"format": "dordiai-real-nvda-phrase-process-correlation", "format_version": 1,
        "status": "correlated" if accepted else "not-correlated", "reference_frames": n, "captured_frames": m,
        "normalized_correlation": coefficient, "threshold": .98, "least_squares_gain": gain,
        "captured_window_rms": rms, "matched_capture_array_offset_frames": offset,
        "offset_scope": "Index in retained software PCM, not calibrated acoustic or device latency",
        "reference_sha256": hashlib.sha256(reference_raw).hexdigest(),
        "captured_sha256": hashlib.sha256(captured_raw).hexdigest(),
        "complete_reference_window_used": True, "requested_phrase_waveform_match_verified": accepted,
        "virtual_audio_verified": accepted, "physical_audio_verified": False,
        "acoustic_latency_verified": False, "native_pronunciation_verified": False, "product_ready": False}
