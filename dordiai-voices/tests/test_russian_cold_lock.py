"""Exercise the actual runtime cold-lock context, without model stubs as proof."""
from contextlib import contextmanager
import gc
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch
import weakref

RUNTIME=Path(__file__).resolve().parents[1]/'source/0.12.2/kx47Runtime'
sys.path.insert(0,str(RUNTIME))
import native_multilingual as native


class Lock:
    def __init__(self,values):self.values=iter(values);self.released=0;self.calls=0
    def acquire(self,*,timeout):
        if timeout!=.01:raise AssertionError('Unbounded or changed lock polling')
        self.calls+=1;return next(self.values)
    def release(self):self.released+=1


class RussianColdLockTests(unittest.TestCase):
    def fixture(self,lock,process=None):
        transitions=[]
        @contextmanager
        def priority(*,process):
            transitions.append(('enter',process))
            try:yield
            finally:transitions.append(('restore',process))
        self.enterContext(patch.object(native,'foreground_priority',side_effect=priority))
        owner=types.SimpleNamespace(_russian_lock=lock)
        if process is not None:owner.russian=types.SimpleNamespace(process=process)
        return owner,native.NativeMultilingual._russian_foreground,transitions

    def test_immediate_acquisition_does_not_construct_cached_backend(self):
        lock=Lock([True]);owner,context,changes=self.fixture(lock)
        with context(owner,lambda:False):self.assertNotIn('russian',owner.__dict__)
        self.assertEqual(changes,[]);self.assertEqual(lock.released,1)

    def test_contention_restores_child_before_yielding_actual_work(self):
        lock=Lock([False,True]);owner,context,changes=self.fixture(lock,types.SimpleNamespace(_handle=99,poll=lambda:None))
        with context(owner,lambda:False):self.assertEqual(changes,[('enter',99),('restore',99)])
        self.assertEqual(lock.released,1)

    def test_already_cancelled_does_not_acquire_or_change_priority(self):
        lock=Lock([]);owner,context,changes=self.fixture(lock)
        with self.assertRaises(native.SynthesisCancelled):
            with context(owner,lambda:True):pass
        self.assertEqual((lock.calls,lock.released),(0,0));self.assertEqual(changes,[])

    def test_cancel_while_waiting_restores_child_without_unowned_release(self):
        lock=Lock([False]);owner,context,changes=self.fixture(lock,types.SimpleNamespace(_handle=99,poll=lambda:None))
        checks=iter([False,True])
        with self.assertRaises(native.SynthesisCancelled):
            with context(owner,lambda:next(checks)):pass
        self.assertEqual(lock.released,0);self.assertEqual(changes,[('enter',99),('restore',99)])

    def test_cancel_after_acquisition_releases_exactly_once(self):
        lock=Lock([True]);owner,context,_=self.fixture(lock);checks=iter([False,True])
        with self.assertRaises(native.SynthesisCancelled):
            with context(owner,lambda:next(checks)):pass
        self.assertEqual(lock.released,1)

    def test_dead_child_is_never_boosted(self):
        lock=Lock([False,True]);owner,context,changes=self.fixture(lock,types.SimpleNamespace(_handle=99,poll=lambda:1))
        with context(owner,lambda:False):pass
        self.assertEqual(changes,[]);self.assertEqual(lock.released,1)

    def test_missing_child_keeps_timed_polling_without_cached_property_creation(self):
        lock=Lock([False,True]);owner,context,changes=self.fixture(lock)
        with context(owner,lambda:False):self.assertNotIn('russian',owner.__dict__)
        self.assertEqual(changes,[]);self.assertEqual(lock.calls,2)

    def test_replacement_keeps_old_popen_alive_through_its_restore(self):
        testcase=self
        class Process:
            def __init__(self,handle):self._handle=handle
            def poll(self):return None
        class ReplaceLock(Lock):
            def acquire(self,**kwargs):
                acquired=super().acquire(**kwargs)
                if self.calls==2:
                    self.owner.russian.process=Process(100)
                    gc.collect();testcase.assertIsNotNone(old())
                return acquired
        lock=ReplaceLock([False,False,False,True]);owner,context,changes=self.fixture(lock,Process(99))
        lock.owner=owner;old=weakref.ref(owner.russian.process)
        with context(owner,lambda:False):
            self.assertEqual(changes,[('enter',99),('restore',99),('enter',100),('restore',100)])
        self.assertEqual(lock.released,1)

    def test_acquire_exception_restores_child_without_releasing_unowned_lock(self):
        class BrokenLock(Lock):
            def acquire(self,**kwargs):
                if self.calls==1:raise OSError('test failure')
                return super().acquire(**kwargs)
        lock=BrokenLock([False]);owner,context,changes=self.fixture(lock,types.SimpleNamespace(_handle=99,poll=lambda:None))
        with self.assertRaises(OSError):
            with context(owner,lambda:False):pass
        self.assertEqual(changes,[('enter',99),('restore',99)]);self.assertEqual(lock.released,0)

    def test_actual_work_exception_releases_the_owned_lock(self):
        lock=Lock([True]);owner,context,_=self.fixture(lock)
        with self.assertRaisesRegex(ValueError,'work'):
            with context(owner,lambda:False):raise ValueError('work')
        self.assertEqual(lock.released,1)


if __name__=='__main__':unittest.main()
