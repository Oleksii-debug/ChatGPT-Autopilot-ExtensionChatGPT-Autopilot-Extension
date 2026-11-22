"""Streaming pitch, timbre and volume controls for mono PCM."""
from ctypes import CDLL, POINTER, c_double, c_float, c_int, c_uint, c_void_p
from functools import lru_cache
from pathlib import Path
import sys

import numpy as np

FloatPointer = POINTER(c_float)
ChannelPointers = POINTER(FloatPointer)
PRESERVE_FORMANTS = 0x01000000


@lru_cache(maxsize=1)
def _library():
    directory = Path(sys.executable).parent
    runtime = CDLL(str(directory / "rubberband-3.dll"))
    signature = {
        "new": ([c_uint, c_uint, c_int], c_void_p),
        "delete": ([c_void_p], None),
        "set_pitch_scale": ([c_void_p, c_double], None),
        "set_formant_scale": ([c_void_p, c_double], None),
        "get_start_delay": ([c_void_p], c_uint),
        "get_block_size": ([c_void_p], c_uint),
        "shift": ([c_void_p, ChannelPointers, ChannelPointers], None),
    }
    for name, (arguments, returns) in signature.items():
        fn = getattr(runtime, "rubberband_live_" + name)
        fn.argtypes = arguments
        fn.restype = returns
    return runtime


def apply_stream_controls(chunks, rate, pitch=50, timbre=50, volume=100, *, pitch_scale=1.0):
    gain = volume / 100
    if volume == 0 or (pitch == 50 and timbre == 50 and pitch_scale == 1.0):
        for audio in chunks:
            yield audio * gain
        return

    lib = _library()
    state = lib.rubberband_live_new(rate, 1, PRESERVE_FORMANTS)
    if not state:
        raise RuntimeError("Cannot initialize speech pitch control.")
    try:
        lib.rubberband_live_set_pitch_scale(state, (2 ** ((pitch - 50) / 100)) * pitch_scale)
        lib.rubberband_live_set_formant_scale(state, 2 ** ((timbre - 50) / 250))
        size = lib.rubberband_live_get_block_size(state)
        delay = lib.rubberband_live_get_start_delay(state)
        outstanding = 0
        source = np.zeros(size, dtype=np.float32)
        output = np.zeros_like(source)
        in_pointer = (FloatPointer * 1)(source.ctypes.data_as(FloatPointer))
        out_pointer = (FloatPointer * 1)(output.ctypes.data_as(FloatPointer))
        filled = 0

        def shift():
            nonlocal delay, outstanding
            lib.rubberband_live_shift(state, in_pointer, out_pointer)
            skip = min(delay, size)
            delay -= skip
            count = min(outstanding, size - skip)
            outstanding -= count
            return output[skip:skip + count] * gain

        for audio in chunks:
            position = 0
            produced = []
            outstanding += len(audio)
            while position < len(audio):
                take = min(size - filled, len(audio) - position)
                source[filled:filled + take] = audio[position:position + take]
                position += take
                filled += take
                if filled == size:
                    produced.append(shift())
                    filled = 0
            if produced:
                block = np.concatenate(produced)
                if block.size:
                    yield block

        while outstanding:
            source[filled:] = 0
            filled = 0
            block = shift()
            if block.size:
                yield block
    finally:
        lib.rubberband_live_delete(state)


def apply_voice_controls(audio, rate, pitch, timbre, volume):
    chunks = list(apply_stream_controls((audio,), rate, pitch, timbre, volume))
    return np.concatenate(chunks) if chunks else audio[:0]
