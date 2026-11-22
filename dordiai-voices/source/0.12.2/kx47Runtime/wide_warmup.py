"""Reserve the worker for extended speech when it is the first uncached request."""
from threading import Condition
from time import monotonic
from functools import lru_cache


@lru_cache(maxsize=1)
def _scheduling():
    import os
    if os.name!='nt':return None
    import ctypes as ct
    kernel=ct.WinDLL('kernel32',use_last_error=True)
    kernel.GetCurrentProcess.restype=ct.c_void_p
    kernel.GetCurrentThread.restype=ct.c_void_p
    kernel.GetPriorityClass.argtypes=[ct.c_void_p]
    kernel.SetPriorityClass.argtypes=[ct.c_void_p,ct.c_uint32]
    kernel.SetThreadPriority.argtypes=[ct.c_void_p,ct.c_int]
    return kernel


def background_setup_thread():
    kernel=_scheduling()
    if kernel is not None:
        kernel.SetThreadPriority(kernel.GetCurrentThread(),-1)


def foreground_blocks(source,kernel=None):
    # Windows priority is restored before yielding to playback. Only the
    # isolated speech worker moves from below-normal to the normal class.
    if kernel is None:kernel=_scheduling()
    if kernel is None:
        yield from source
        return
    process=kernel.GetCurrentProcess()
    try:
        while True:
            changed=(kernel.GetPriorityClass(process)==0x4000 and kernel.SetPriorityClass(process,0x20))
            try:
                value=next(source)
            except StopIteration:
                return
            finally:
                if changed and kernel.GetPriorityClass(process)==0x20:
                    kernel.SetPriorityClass(process,0x4000)
            yield value
    finally:
        close=getattr(source,'close',None)
        if close:close()


def memory_headroom():
    """Available physical and commit space before an optional multi-engine preload."""
    import sys
    if sys.platform!='win32':return None
    import ctypes
    class MemoryStatus(ctypes.Structure):
        _fields_=[('length',ctypes.c_uint32),('load',ctypes.c_uint32)]+[
            (name,ctypes.c_uint64) for name in ('physical','physical_free','commit','commit_free',
                                                'address','address_free','extended_free')]
    info=MemoryStatus()
    info.length=ctypes.sizeof(info)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(info)):return None
    return min(info.physical_free,info.commit_free)


class WideWarmupGate:
    def __init__(self):
        self.changed=Condition()
        self.first=None
        self.active=False
        self.needs_core=False
        self.stopped=False
        self.idle_since=monotonic()

    def reference(self,wide):
        with self.changed:
            if self.first is None:self.first=wide
            self.active=wide
            if not wide:self.needs_core=True
            self.changed.notify_all()

    def finished(self):
        with self.changed:
            if self.active:
                self.active=False
                self.idle_since=monotonic()
                self.changed.notify_all()

    def close(self):
        with self.changed:
            self.stopped=True
            self.changed.notify_all()

    def ready(self,initial_wait=.3,idle_wait=.7):
        with self.changed:
            self.changed.wait_for(lambda:self.first is not None or self.stopped,initial_wait)
            while self.first is True and not self.needs_core and not self.stopped:
                timeout=None if self.active else self.idle_since+idle_wait-monotonic()
                if timeout is not None and timeout<=0:break
                self.changed.wait(timeout)
            return not self.stopped
