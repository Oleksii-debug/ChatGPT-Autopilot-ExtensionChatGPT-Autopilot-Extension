"""Owned foreground scheduling and Russian pipe backpressure regressions."""
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

RUNTIME=Path(__file__).resolve().parents[1]/'source/0.12.2/kx47Runtime'
sys.path.insert(0,str(RUNTIME))
import wide_warmup as scheduling
import native_multilingual as native
from session_control import SynthesisCancelled


class Kernel:
    def __init__(self):self.values={1:0x4000,99:0x4000};self.changes=[]
    def GetCurrentProcess(self):return 1
    def GetPriorityClass(self,handle):return self.values[handle]
    def SetPriorityClass(self,handle,value):
        self.changes.append((handle,value));self.values[handle]=value;return True


class ForegroundSchedulingTests(unittest.TestCase):
    def test_priority_is_restored_before_each_yield_and_generator_close(self):
        kernel=Kernel();closed=[]
        def source():
            try:
                self.assertEqual(kernel.values[1],0x20)
                yield b'pcm'
                self.assertEqual(kernel.values[1],0x20)
                yield b'next'
            finally:closed.append(True)
        stream=scheduling.foreground_blocks(source(),kernel)
        self.assertEqual(next(stream),b'pcm')
        self.assertEqual(kernel.values[1],0x4000)
        stream.close()
        self.assertEqual(closed,[True])
        self.assertEqual(kernel.values[1],0x4000)

    def test_tuple_cache_is_iterable_and_unmodified(self):
        kernel=Kernel();pcm=(b'one',b'two')
        self.assertEqual(tuple(scheduling.foreground_blocks(pcm,kernel)),pcm)
        self.assertEqual(kernel.values[1],0x4000)

    def test_cancellation_and_exception_restore_original(self):
        for error in (SynthesisCancelled(),ValueError('model')):
            with self.subTest(error=type(error).__name__):
                kernel=Kernel()
                def fail():
                    self.assertEqual(kernel.values[1],0x20)
                    raise error
                    yield
                with self.assertRaises(type(error)):
                    next(scheduling.foreground_blocks(fail(),kernel))
                self.assertEqual(kernel.values[1],0x4000)

    def test_existing_normal_or_other_priority_is_not_changed(self):
        for previous in (0x20,0x80,0):
            kernel=Kernel();kernel.values[1]=previous
            self.assertEqual(list(scheduling.foreground_blocks((b'a',),kernel)),[b'a'])
            self.assertEqual(kernel.changes,[])
            self.assertEqual(kernel.values[1],previous)

    def test_nested_scope_does_not_prematurely_restore_parent(self):
        kernel=Kernel()
        with scheduling.foreground_priority(kernel):
            with scheduling.foreground_priority(kernel):
                self.assertEqual(kernel.values[1],0x20)
            self.assertEqual(kernel.values[1],0x20)
        self.assertEqual(kernel.values[1],0x4000)

    def test_without_windows_keeps_iterable_and_closes_source(self):
        with patch.object(scheduling,'_scheduling',return_value=None):
            self.assertEqual(list(scheduling.foreground_blocks((b'a',))),[b'a'])


class RussianPriorityTests(unittest.TestCase):
    def setUp(self):
        self.kernel=Kernel()
        self.pipe=native.RussianPipe(Path('model'),Path('profiles'))
        self.pipe.process=types.SimpleNamespace(_handle=99,poll=lambda:None)
        self.enterContext(patch.object(native,'foreground_priority',
            side_effect=lambda **kwargs:scheduling.foreground_priority(self.kernel,kwargs['process'])))
        self.start=self.enterContext(patch.object(self.pipe,'start'))
        self.close=self.enterContext(patch.object(self.pipe,'close'))
        self.commands=[]
        def send(data):
            self.assertEqual(self.kernel.values[99],0x20)
            self.commands.append(data)
        self.send=self.enterContext(patch.object(self.pipe,'_send',side_effect=send))

    def sizes(self,values):
        sequence=iter(values)
        def take():
            self.assertEqual(self.kernel.values[99],0x20)
            return next(sequence)
        self.enterContext(patch.object(self.pipe,'_size',side_effect=take))

    def read(self):
        def take(size):
            self.assertEqual(self.kernel.values[99],0x20)
            return b'\x01\x00\xff\xff'[:size]
        self.enterContext(patch.object(self.pipe,'_read',side_effect=take))

    def test_normal_stream_retains_next_backpressure_and_no_stop(self):
        self.sizes([4,4,0]);self.read()
        stream=self.pipe.stream('sara_archive','Текст.',seed=42)
        self.assertEqual(len(next(stream)),2)
        self.assertEqual(self.kernel.values[99],0x4000)
        self.assertEqual(len(self.commands),1,'next must wait until consumer resumes')
        self.assertEqual(len(next(stream)),2)
        with self.assertRaises(StopIteration):next(stream)
        self.assertEqual(self.commands[1:],[b'next\n',b'next\n'])
        self.start.assert_called_once_with(foreground=True)
        self.close.assert_not_called()
        self.assertEqual(self.kernel.values[99],0x4000)

    def test_close_sends_stop_ack_with_child_foreground_and_restores(self):
        self.sizes([4,0]);self.read()
        stream=self.pipe.stream('sara_archive','Текст.')
        next(stream);stream.close()
        self.assertEqual(self.commands[-1],b'stop\n')
        self.close.assert_not_called()
        self.assertEqual(self.kernel.values[99],0x4000)

    def test_cancel_preserves_warm_process_after_stop_ack(self):
        self.sizes([4,0]);self.read()
        with self.assertRaises(SynthesisCancelled):
            next(self.pipe.stream('sara_archive','Текст.',cancelled=lambda:True))
        self.assertEqual(self.commands[-1],b'stop\n')
        self.close.assert_not_called()
        self.assertEqual(self.kernel.values[99],0x4000)

    def test_invalid_packet_restores_before_closing_process(self):
        self.sizes([3]);self.read()
        with self.assertRaisesRegex(ValueError,'Invalid Russian'):
            next(self.pipe.stream('sara_archive','Текст.'))
        self.close.assert_called_once()
        self.assertEqual(self.kernel.values[99],0x4000)

    def test_missing_stop_ack_closes_process_and_restores_priority(self):
        self.sizes([4,7]);self.read()
        stream=self.pipe.stream('sara_archive','Текст.')
        next(stream);stream.close()
        self.close.assert_called_once()
        self.assertEqual(self.kernel.values[99],0x4000)


class RussianStartupPriorityTests(unittest.TestCase):
    def test_preload_stays_below_normal_but_actual_cold_handshake_is_foreground(self):
        for foreground in (False,True):
            with self.subTest(foreground=foreground):
                kernel=Kernel();pipe=native.RussianPipe(Path('model'),Path('profiles'))
                process=types.SimpleNamespace(_handle=99,poll=lambda:None)
                observed=[]
                with patch.object(native.subprocess,'CREATE_NO_WINDOW',0,create=True), \
                     patch.object(native.subprocess,'BELOW_NORMAL_PRIORITY_CLASS',0x4000,create=True), \
                     patch.object(native.subprocess,'Popen',return_value=process) as spawn, \
                     patch.object(pipe,'close'), \
                     patch.object(pipe,'_size',side_effect=lambda:observed.append(kernel.values[99]) or 24000), \
                     patch.object(native,'foreground_priority',side_effect=lambda **kw:scheduling.foreground_priority(kernel,kw['process'])):
                    pipe.start(foreground=foreground)
                self.assertEqual(observed,[0x20 if foreground else 0x4000])
                self.assertTrue(spawn.call_args.kwargs['creationflags']&0x4000)
                self.assertEqual(kernel.values[99],0x4000)


if __name__=='__main__':unittest.main()
