"""Pitch-preserving speech speed using the open-source Sonic library."""
from ctypes import CDLL, POINTER, c_float, c_int, c_void_p
from functools import lru_cache
from pathlib import Path
import sys
import os
import numpy as np


@lru_cache(maxsize=1)
def library():
    directory = Path(os.environ.get('DORDIAI_NATIVE_DIRECTORY', str(Path(sys.executable).parent)))
    lib = CDLL(str(directory / "sonic.dll"))
    signatures = {
        "sonicCreateStream": ([c_int, c_int], c_void_p),
        "sonicDestroyStream": ([c_void_p], None),
        "sonicSetSpeed": ([c_void_p, c_float], None),
        "sonicWriteFloatToStream": ([c_void_p, POINTER(c_float), c_int], c_int),
        "sonicReadFloatFromStream": ([c_void_p, POINTER(c_float), c_int], c_int),
        "sonicSamplesAvailable": ([c_void_p], c_int),
        "sonicFlushStream": ([c_void_p], c_int),
    }
    for name, (args, result) in signatures.items():
        function = getattr(lib, name)
        function.argtypes, function.restype = args, result
    return lib


def change_tempo(audio, rate, speed):
    blocks = list(stream_tempo((audio,), rate, speed))
    return np.concatenate(blocks) if blocks else np.empty(0, dtype=np.float32)


def stream_tempo(chunks, rate, speed):
    """Change tempo across an utterance, retaining one Sonic state at chunk joins."""
    if not np.isfinite(speed) or not .25 <= speed <= 10:
        raise ValueError("Invalid speech speed")
    # Sonic keeps stable pitch across ordinary ratios. Stage extreme ratios
    # while keeping both stages streaming and preserving cancellation.
    if speed > 4:
        factor = speed ** .5
        yield from stream_tempo(stream_tempo(chunks, rate, factor), rate, factor)
        return
    if abs(speed - 1.0) < .0001:
        yield from chunks
        return
    lib = library()
    state = lib.sonicCreateStream(rate, 1)
    if not state:
        raise MemoryError("Sonic initialization failed")
    def drain():
        count = lib.sonicSamplesAvailable(state)
        if count:
            result = np.empty(count, dtype=np.float32)
            read = lib.sonicReadFloatFromStream(state, result.ctypes.data_as(POINTER(c_float)), count)
            return result[:read]
        return np.empty(0, dtype=np.float32)
    try:
        lib.sonicSetSpeed(state, speed)
        pending = np.empty(0, dtype=np.float32)
        quantum = max(1, rate // 25)
        def write(data):
            if data.size and not lib.sonicWriteFloatToStream(state, data.ctypes.data_as(POINTER(c_float)), len(data)):
                raise MemoryError("Sonic write failed")
        for audio in chunks:
            data = np.concatenate((pending, np.asarray(audio, dtype=np.float32)))
            complete = len(data) // quantum * quantum
            for start in range(0, complete, quantum):
                write(data[start:start + quantum])
            pending = data[complete:].copy()
            result = drain()
            if result.size:
                yield result
        write(pending)
        if not lib.sonicFlushStream(state):
            raise MemoryError("Sonic flush failed")
        result = drain()
        if result.size:
            yield result
    finally:
        lib.sonicDestroyStream(state)
        close = getattr(chunks, 'close', None)
        if close is not None:
            close()
