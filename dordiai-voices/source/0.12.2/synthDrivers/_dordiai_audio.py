"""Controls for prepared PCM using the same Rubber Band Live as the worker."""
from array import array
from ctypes import CDLL, POINTER, c_double, c_float, c_int, c_uint, c_void_p
from functools import lru_cache
from math import isfinite


@lru_cache(maxsize=1)
def library(path):
    lib = CDLL(str(path))
    fp = POINTER(c_float)
    signatures = {
        "new": ([c_uint, c_uint, c_int], c_void_p),
        "delete": ([c_void_p], None),
        "set_pitch_scale": ([c_void_p, c_double], None),
        "set_formant_scale": ([c_void_p, c_double], None),
        "get_start_delay": ([c_void_p], c_uint),
        "get_block_size": ([c_void_p], c_uint),
        "shift": ([c_void_p, POINTER(fp), POINTER(fp)], None),
    }
    for name, (args, result) in signatures.items():
        function = getattr(lib, "rubberband_live_" + name)
        function.argtypes, function.restype = args, result
    return lib


def control_pcm(pcm, path, rate, pitch, timbre, volume):
    if len(pcm) % 2 or not isinstance(rate, int) or rate <= 0:
        raise ValueError("Invalid prepared speech PCM format")
    if not all(isfinite(value) and 0 <= value <= 100 for value in (pitch, timbre, volume)):
        raise ValueError("Invalid prepared speech controls")
    if not pcm or volume == 0:
        return bytes(len(pcm))
    if pitch == timbre == 50:
        # Gain alone needs neither a DLL load nor a pitch-shifter state. This
        # also avoids the shifter's buffering delay for unchanged characters.
        if volume == 100:
            return pcm
        return array("h", (round(value * volume / 100) for value in array("h", pcm))).tobytes()
    lib = library(path)
    state = lib.rubberband_live_new(rate, 1, 0x01000000)
    if not state:
        raise MemoryError("Prepared speech pitch control failed")
    try:
        lib.rubberband_live_set_pitch_scale(state, 2 ** ((pitch - 50) / 100))
        lib.rubberband_live_set_formant_scale(state, 2 ** ((timbre - 50) / 250))
        size = lib.rubberband_live_get_block_size(state)
        delay = lib.rubberband_live_get_start_delay(state)
        if not 0 < size <= rate * 2 or not 0 <= delay <= rate * 10:
            raise ValueError("Invalid prepared speech processor block size or delay")
        data = array("h", pcm)
        source = (c_float * size)()
        output = (c_float * size)()
        fp = POINTER(c_float)
        inp, out = (fp * 1)(source), (fp * 1)(output)
        result = array("h")
        position = 0
        remaining = len(data)
        while remaining:
            count = min(size, len(data) - position)
            for i in range(count):
                source[i] = data[position+i] / 32768
            for i in range(count, size):
                source[i] = 0
            position += count
            lib.rubberband_live_shift(state, inp, out)
            skip = min(delay, size)
            delay -= skip
            take = min(remaining, size-skip)
            result.extend(max(-32768, min(32767, round(output[i] * 32768 * volume / 100)))
                          for i in range(skip, skip+take))
            remaining -= take
        return result.tobytes()
    finally:
        lib.rubberband_live_delete(state)
