"""Nonblocking optional delegate for the Radeon adapter validated in the fast-reading tests."""
import atexit
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
from queue import Queue
import struct
import subprocess
import sys
from threading import Event, Lock, Thread, Timer
from time import monotonic

import numpy as np

from radeon_worker import read_exact
from session_control import SynthesisCancelled

def supported_display():
    if os.name!='nt' or os.environ.get('DORDIAI_DISABLE_RADEON')=='1':
        return False
    class Display(ctypes.Structure):
        _fields_=[('cb',wintypes.DWORD),('name',wintypes.WCHAR*32),('description',wintypes.WCHAR*128),
                  ('flags',wintypes.DWORD),('deviceId',wintypes.WCHAR*128),('deviceKey',wintypes.WCHAR*128)]
    enum=ctypes.windll.user32.EnumDisplayDevicesW
    enum.argtypes=(wintypes.LPCWSTR,wintypes.DWORD,ctypes.POINTER(Display),wintypes.DWORD)
    enum.restype=wintypes.BOOL
    index=0
    while True:
        display=Display()
        display.cb=ctypes.sizeof(Display)
        if not enum(None,index,ctypes.byref(display),0):return False
        if display.flags&4:
            return 'VEN_1002&DEV_15E7' in display.deviceId.upper()
        index+=1

class Request:
    def __init__(self,inputs):
        self.latent=inputs['/Mul_output_0']
        self.condition=inputs['/ConstantOfShape_1_output_0']
        self.done=Event()
        self.result=None

class RadeonDecoder:
    def __init__(self,owner):
        self.owner=owner
        self.ready=Event()
        self.closed=Event()
        self.busy=Lock()
        self.state=Lock()
        self.queue=Queue(maxsize=2)
        self.process=None
        self.used_blocks=0
        atexit.register(self.close)
        Thread(target=self._worker,daemon=True,name='dordiai Radeon').start()

    def close(self):
        with self.state:
            if self.closed.is_set():return
            self.closed.set()
            process=self.process
        self.queue.put_nowait(None)
        if process is not None and process.poll() is None:
            try:process.kill()
            except OSError:pass

    def _worker(self):
        process=None
        startup=Timer(15,lambda:self.close() if not self.ready.is_set() else None)
        startup.daemon=True
        startup.start()
        try:
            with self.state:
                if self.closed.is_set():return
                process=subprocess.Popen([sys.executable,'-B',str(Path(__file__).with_name('radeon_worker.py'))],
                    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW)
                self.process=process
            if read_exact(process.stdout,1)!=b'R':raise ValueError('Decoder handshake failed')
            self.ready.set()
            startup.cancel()
            while not self.closed.is_set():
                request=self.queue.get()
                if request is None:break
                try:
                    n=request.latent.shape[-1]
                    process.stdin.write(struct.pack('<I',n))
                    process.stdin.write(request.latent.tobytes())
                    process.stdin.write(request.condition.tobytes())
                    process.stdin.flush()
                    data=read_exact(process.stdout,n*256*4)
                    request.result=np.frombuffer(data,dtype='<f4').reshape(1,1,n*256)
                finally:
                    self.busy.release()
                    request.done.set()
        except (OSError,ValueError,EOFError):
            pass
        finally:
            startup.cancel()
            self.close()
            if process is not None:
                for stream in (process.stdin,process.stdout):
                    try:stream.close()
                    except OSError:pass
                try:process.wait(timeout=2)
                except subprocess.TimeoutExpired:pass

    def run(self,outputs,inputs):
        event=self.owner.cancel_event
        if not self.closed.is_set() and self.ready.is_set() and self.busy.acquire(blocking=False):
            request=Request(inputs)
            self.queue.put_nowait(request)
            limit=monotonic()+4.
            while not request.done.wait(.012):
                if event is not None and event.is_set():raise SynthesisCancelled()
                if self.closed.is_set():break
                if monotonic()>=limit:
                    self.close()
                    break
            if event is not None and event.is_set():raise SynthesisCancelled()
            if request.result is not None:
                self.used_blocks+=1
                return [request.result]
        return self.owner.decoder.run(outputs,inputs)

