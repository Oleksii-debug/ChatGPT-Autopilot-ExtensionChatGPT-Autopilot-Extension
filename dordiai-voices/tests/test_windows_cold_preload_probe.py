import importlib.util
from pathlib import Path
import sys
import unittest
from contextlib import contextmanager
import textwrap
import types
import gc
import weakref

TOOLS=Path(__file__).resolve().parents[1]/'tools';sys.path.insert(0,str(TOOLS))
SPEC=importlib.util.spec_from_file_location('cold_probe',TOOLS/'windows_cold_preload_probe.py')
probe=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(probe)


class ColdPreloadProbeTests(unittest.TestCase):
    def test_observer_wrapper_compiles(self):compile(probe.COLD_WRAPPER,'cold observer','exec')

    def test_json_events_tolerate_concurrent_line_boundaries(self):
        text='DORDIAI_COLD {"event":"one"}DORDIAI_COLD {"event":"two"}\n'
        self.assertEqual([r['event'] for r in probe.events(text)],['one','two'])

    def test_arrival_must_be_before_real_lock_release(self):
        rows=[{'event':'warm-russian-enter','time':1,'thread':'Russian setup'},
              {'event':'lock-wait-begin','time':2,'thread':'MainThread','child_priority':16384},
              {'event':'lock-released','time':4,'released_time':3,'thread':'Russian setup'},
              {'event':'lock-acquired','time':3,'thread':'MainThread','wait_ms':1000}]
        self.assertTrue(probe.judge(rows)['foreground_arrived_during_warmup'])
        rows[1]['time']=3.1
        self.assertFalse(probe.judge(rows)['foreground_arrived_during_warmup'])
        self.assertIsNone(probe.judge([])['foreground_lock_wait_ms'])


class ColdForegroundPrototypeTests(unittest.TestCase):
    def setup_helper(self,lock,process=None):
        class Cancelled(Exception):pass
        transitions=[]
        @contextmanager
        def priority(**kwargs):
            transitions.append(('enter',kwargs['process']))
            try:yield
            finally:transitions.append(('restore',kwargs['process']))
        namespace={'contextmanager':contextmanager,'SynthesisCancelled':Cancelled,'foreground_priority':priority}
        exec(textwrap.dedent(probe.COLD_LOCK_HELPER),namespace)
        owner=types.SimpleNamespace(_russian_lock=lock)
        if process is not None:owner.russian=types.SimpleNamespace(process=process)
        return owner,namespace['_russian_foreground'],Cancelled,transitions

    def test_available_lock_needs_no_child_property_or_boost(self):
        class Lock:
            released=0
            def acquire(self,**kw):return True
            def release(self):self.released+=1
        lock=Lock();owner,helper,_,transitions=self.setup_helper(lock)
        with helper(owner,lambda:False):self.assertEqual(transitions,[])
        self.assertEqual(lock.released,1)
        self.assertNotIn('russian',owner.__dict__)

    def test_child_scope_is_restored_before_real_work_and_lock_released(self):
        class Lock:
            values=iter([False,True]);released=0
            def acquire(self,**kw):
                self.timeout=kw['timeout'];return next(self.values)
            def release(self):self.released+=1
        lock=Lock();owner,helper,_,transitions=self.setup_helper(lock,types.SimpleNamespace(_handle=99,poll=lambda:None))
        with helper(owner,lambda:False):self.assertEqual(transitions,[('enter',99),('restore',99)])
        self.assertEqual(lock.timeout,.01);self.assertEqual(lock.released,1)

    def test_cancel_wait_restores_child_without_releasing_unowned_lock(self):
        class Lock:
            def acquire(self,**kw):return False
            def release(self):raise AssertionError('unowned release')
        owner,helper,Cancelled,transitions=self.setup_helper(Lock(),types.SimpleNamespace(_handle=99,poll=lambda:None))
        checks=iter([False,True])
        with self.assertRaises(Cancelled):
            with helper(owner,lambda:next(checks)):pass
        self.assertEqual(transitions,[('enter',99),('restore',99)])

    def test_cancel_immediately_after_acquisition_releases_owned_lock(self):
        class Lock:
            released=0
            def acquire(self,**kw):return True
            def release(self):self.released+=1
        lock=Lock();owner,helper,Cancelled,_=self.setup_helper(lock)
        checks=iter([False,True])
        with self.assertRaises(Cancelled):
            with helper(owner,lambda:next(checks)):pass
        self.assertEqual(lock.released,1)

    def test_dead_child_is_never_boosted(self):
        class Lock:
            values=iter([False,True])
            def acquire(self,**kw):return next(self.values)
            def release(self):pass
        owner,helper,_,transitions=self.setup_helper(Lock(),types.SimpleNamespace(_handle=99,poll=lambda:1))
        with helper(owner,lambda:False):pass
        self.assertEqual(transitions,[])

    def test_replaced_child_handle_stays_alive_until_original_scope_restores(self):
        testcase=self
        class Process:
            def __init__(self,handle):self._handle=handle
            def poll(self):return None
        class Lock:
            calls=0;released=0
            def acquire(self,**kw):
                self.calls+=1
                if self.calls==2:
                    self.owner.russian.process=Process(100)
                    gc.collect();testcase.assertIsNotNone(original())
                return self.calls==4
            def release(self):self.released+=1
        lock=Lock();owner,helper,_,transitions=self.setup_helper(lock,Process(99))
        lock.owner=owner;original=weakref.ref(owner.russian.process)
        with helper(owner,lambda:False):
            self.assertEqual(transitions,[('enter',99),('restore',99),('enter',100),('restore',100)])
        self.assertEqual(lock.released,1)

    def test_acquire_exception_restores_child_and_does_not_release_unowned_lock(self):
        class Lock:
            calls=0
            def acquire(self,**kw):
                self.calls+=1
                if self.calls==2:raise OSError('closed')
                return False
            def release(self):raise AssertionError('unowned release')
        owner,helper,_,transitions=self.setup_helper(Lock(),types.SimpleNamespace(_handle=99,poll=lambda:None))
        with self.assertRaises(OSError):
            with helper(owner,lambda:False):pass
        self.assertEqual(transitions,[('enter',99),('restore',99)])


if __name__=='__main__':unittest.main()
