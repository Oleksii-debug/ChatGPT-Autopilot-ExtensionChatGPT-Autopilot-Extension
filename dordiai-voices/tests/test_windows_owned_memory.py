"""Owned-handle memory semantics, finite lifetime and small real Windows child."""
import ast
import ctypes as ct
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('owned_memory_test_module',ROOT/'tools/windows_owned_memory.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class Handle:
    closed=False
    def __int__(self):return 77


class OwnedFixture(subprocess.Popen):
    """Metadata fixture only; never claimed as a genuine Windows process."""
    def __init__(self):
        self._child_created=False;self.returncode=None;self.pid=123;self._handle=Handle()


class FakeApi:
    def __init__(self):self.calls=[]
    def is_process_in_job(self,p,j):self.calls.append(('membership',p,j));return True
    def process_memory(self,h):
        self.calls.append(('process',h))
        return dict(working_set_bytes=4096,os_peak_working_set_bytes=8192,
                    private_commit_bytes=100*1024**2,os_peak_pagefile_commit_bytes=200*1024**2)
    def job_memory(self,h):self.calls.append(('job',h));return dict(os_peak_job_commit_bytes=300*1024**2)


class Contracts(unittest.TestCase):
    def observe(self,api=None,job=None,n=2):
        process=OwnedFixture();api=FakeApi() if api is None else api
        sampler=m.OwnedProcessMemorySampler(process,job=job,api=api,interval_seconds=.01,max_samples=n)
        sampler.start()
        try:sampler.wait_for_samples(n);return sampler,sampler.stop()
        finally:sampler.stop()

    def test_integer_byte_units_ram_and_commit_never_conflated(self):
        api=FakeApi();sampler,r=self.observe(api,SimpleNamespace(handle=88))
        self.assertEqual(r['parent_ram_bytes']['maximum_observed_working_set'],4096)
        self.assertEqual(r['parent_ram_bytes']['maximum_observed_os_peak_working_set'],8192)
        self.assertEqual(r['parent_commit_bytes']['maximum_observed_private_usage'],104857600)
        self.assertEqual(r['parent_commit_bytes']['maximum_observed_os_peak_pagefile_usage'],209715200)
        self.assertEqual(r['owned_job_commit_bytes']['maximum_observed_os_peak_job_memory_used'],314572800)
        self.assertIsNone(r['children_resident_ram_bytes']);self.assertIsNone(r['family_resident_ram_bytes'])
        self.assertEqual(api.calls[0],('membership',77,88))
        self.assertTrue(all(v[1] in (77,88) for v in api.calls))
        self.assertFalse(r['product_ready']);self.assertFalse(r['acoustic_latency_verified'])

    def test_no_optional_job_does_not_fabricate_zero_commit(self):
        _,r=self.observe()
        self.assertEqual(r['snapshots'][0]['job_memory']['status'],'not-requested')
        self.assertIsNone(r['owned_job_commit_bytes']['maximum_observed_os_peak_job_memory_used'])

    def test_api_failure_preserved_as_error_and_unknown_not_zero(self):
        api=FakeApi()
        def fail(h):raise m.MemoryApiError('K32GetProcessMemoryInfo',5)
        api.process_memory=fail
        _,r=self.observe(api)
        self.assertEqual(r['status'],'failed')
        self.assertEqual(r['snapshots'][0]['process_memory']['windows_error_code'],5)
        self.assertIsNone(r['parent_ram_bytes']['maximum_observed_working_set'])
        self.assertIsNone(r['parent_commit_bytes']['maximum_observed_private_usage'])

    def test_job_error_does_not_erase_successful_parent_ram(self):
        api=FakeApi()
        def fail(h):raise m.MemoryApiError('QueryInformationJobObject9',6)
        api.job_memory=fail
        _,r=self.observe(api,SimpleNamespace(handle=88))
        self.assertEqual(r['status'],'failed');self.assertEqual(r['parent_ram_bytes']['maximum_observed_working_set'],4096)
        self.assertIsNone(r['owned_job_commit_bytes']['maximum_observed_os_peak_job_memory_used'])

    def test_invalid_counter_values_become_errors(self):
        for value in (-1,1.5,True,'4096'):
            api=FakeApi();original=api.process_memory
            api.process_memory=lambda h,v=value:dict(original(h),working_set_bytes=v)
            _,r=self.observe(api,n=1)
            self.assertEqual(r['status'],'failed');self.assertIsNone(r['parent_ram_bytes']['maximum_observed_working_set'])

    def test_explicit_owned_job_membership_is_required(self):
        api=FakeApi();api.is_process_in_job=lambda p,j:False
        with self.assertRaises(ValueError):m.OwnedProcessMemorySampler(OwnedFixture(),job=SimpleNamespace(handle=88),api=api)
        def fail(p,j):raise m.MemoryApiError('IsProcessInJob',6)
        api.is_process_in_job=fail
        with self.assertRaises(m.MemoryApiError):m.OwnedProcessMemorySampler(OwnedFixture(),job=SimpleNamespace(handle=88),api=api)

    def test_pid_or_missing_handle_and_unbounded_parameters_rejected(self):
        with self.assertRaises(TypeError):m.OwnedProcessMemorySampler(123,api=FakeApi())
        process=OwnedFixture();process._handle=None
        with self.assertRaises(ValueError):m.OwnedProcessMemorySampler(process,api=FakeApi())
        for name,values in (('max_samples',(0,True,10001)),('interval_seconds',(0,True,float('nan'),float('inf'),11))):
            for value in values:
                with self.subTest(name=name,value=value),self.assertRaises(ValueError):
                    m.OwnedProcessMemorySampler(OwnedFixture(),api=FakeApi(),**{name:value})

    def test_sample_quota_and_stop_join_precede_owner_handle_close(self):
        api=FakeApi();process=OwnedFixture();job=SimpleNamespace(handle=88)
        sampler=m.OwnedProcessMemorySampler(process,job=job,api=api,interval_seconds=.01,max_samples=3).start()
        try:
            sampler.wait_for_samples(3);r=sampler.stop();calls=len(api.calls)
            self.assertEqual(r['sample_count'],3);self.assertTrue(r['sample_quota_reached'])
            self.assertTrue(r['sampler_thread_joined']);self.assertTrue(r['handles_observed_held_at_stop'])
            process._handle.closed=True;job.handle=None;time.sleep(.03)
            self.assertEqual(len(api.calls),calls)
            self.assertEqual(sampler.stop()['sample_count'],3)  # Idempotent; no API after close.
        finally:sampler.stop()

    def test_closing_owner_too_early_is_preserved_as_failure(self):
        api=FakeApi();process=OwnedFixture();sampler=m.OwnedProcessMemorySampler(process,api=api,interval_seconds=.01,max_samples=10).start()
        try:
            sampler.wait_for_samples(1);process._handle.closed=True
            r=sampler.stop()
            self.assertFalse(r['handles_observed_held_at_stop']);self.assertEqual(r['status'],'failed')
            self.assertTrue(any(e['operation']=='stop-before-handle-close' for e in r['control_errors']))
        finally:sampler.stop()

    def test_finite_join_timeout_requires_handles_remain_held(self):
        api=FakeApi();entered=threading.Event();release=threading.Event();original=api.process_memory
        def slow(h):entered.set();release.wait(2);return original(h)
        api.process_memory=slow
        sampler=m.OwnedProcessMemorySampler(OwnedFixture(),api=api,max_samples=1).start()
        try:
            self.assertTrue(entered.wait(1))
            with self.assertRaises(TimeoutError):sampler.stop(timeout=.01)
        finally:release.set();r=sampler.stop(timeout=2)
        self.assertTrue(r['sampler_thread_joined']);self.assertTrue(r['handles_observed_held_at_stop'])
        self.assertEqual(r['status'],'failed');self.assertEqual(r['control_errors'][0]['operation'],'stop-join')

    def test_context_finally_stops_observer_when_probe_body_raises(self):
        sampler=m.OwnedProcessMemorySampler(OwnedFixture(),api=FakeApi(),max_samples=2)
        with self.assertRaisesRegex(RuntimeError,'probe body'):
            with sampler:
                sampler.wait_for_samples(1)
                raise RuntimeError('probe body')
        self.assertTrue(sampler.report()['sampler_thread_joined'])

    def test_module_has_no_pid_scan_reopen_process_control_or_close_api(self):
        tree=ast.parse((ROOT/'tools/windows_owned_memory.py').read_text(encoding='utf-8'))
        calls={n.func.attr for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute)}
        self.assertFalse(calls&{'OpenProcess','CloseHandle','kill','terminate','close','Popen','process_iter','TerminateJobObject'})


class NativeApiContracts(unittest.TestCase):
    def test_native_abi_and_exact_counter_fields(self):
        if ct.sizeof(ct.c_void_p)==8:
            self.assertEqual(ct.sizeof(m.ProcessMemoryCountersEx),80)
            self.assertEqual(ct.sizeof(m.JobExtendedLimits),144)
        calls=[]
        def process(h,pointer,size):
            calls.append(('process',h,size));v=pointer._obj
            v.WorkingSetSize=11;v.PeakWorkingSetSize=22;v.PrivateUsage=33;v.PeakPagefileUsage=44;return 1
        def job(h,kind,pointer,size,returned):calls.append(('job',h,kind,size));pointer._obj.PeakJobMemoryUsed=55;return 1
        api=m.WindowsMemoryApi.__new__(m.WindowsMemoryApi)
        api.kernel=SimpleNamespace(K32GetProcessMemoryInfo=process,QueryInformationJobObject=job)
        self.assertEqual(api.process_memory(77),dict(zip(m.PROCESS_FIELDS,(11,22,33,44))))
        self.assertEqual(api.job_memory(88),{'os_peak_job_commit_bytes':55})
        self.assertEqual(calls[1][2],9)

    def test_false_native_return_is_error_not_zero_initialized_counters(self):
        api=m.WindowsMemoryApi.__new__(m.WindowsMemoryApi)
        api.kernel=SimpleNamespace(K32GetProcessMemoryInfo=lambda *a:0,QueryInformationJobObject=lambda *a:0)
        with patch.object(m.ct,'get_last_error',return_value=6,create=True):
            for function,handle in ((api.process_memory,77),(api.job_memory,88)):
                with self.assertRaises(m.MemoryApiError) as ctx:function(handle)
                self.assertEqual(ctx.exception.error_code,6)


@unittest.skipUnless(os.name=='nt','Genuine bounded Windows owned-handle memory APIs')
class ActualOwnedProcess(unittest.TestCase):
    validation=None
    def test_real_own_32mib_child_and_job_observed_then_cleanly_reaped(self):
        spec=importlib.util.spec_from_file_location('owned_memory_validation_job',ROOT/'tools/windows_nvda_settings_keyboard_probe.py')
        owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)
        job=owner.OwnedNvdaJob();process=None;sampler=None
        amount=32*1024**2
        code='import sys,json;v=bytearray('+str(amount)+');v[::4096]=b"x"*len(v[::4096]);print(json.dumps({"ready":True,"allocated_bytes":len(v)}),flush=True);sys.stdin.buffer.readline()'
        try:
            process=subprocess.Popen([sys.executable,'-I','-B','-c',code],creationflags=4,stdin=subprocess.PIPE,stdout=subprocess.PIPE)
            job.assign_and_resume(process)
            # readline is bounded by an owned helper thread and a finite wait.
            receipt=[];ready=threading.Event()
            def read_ready():
                try:receipt.append(process.stdout.readline(4096))
                finally:ready.set()
            reader=threading.Thread(target=read_ready,daemon=True);reader.start()
            self.assertTrue(ready.wait(5));reader.join(1)
            child=json.loads(receipt[0]);self.assertTrue(child['ready']);self.assertEqual(child['allocated_bytes'],amount)
            sampler=m.OwnedProcessMemorySampler(process,job=job,interval_seconds=.02,max_samples=3).start()
            sampler.wait_for_samples(3);memory=sampler.stop()
            self.assertEqual(memory['status'],'stopped');self.assertTrue(memory['handles_observed_held_at_stop'])
            self.assertGreater(memory['parent_ram_bytes']['maximum_observed_working_set'],0)
            self.assertGreaterEqual(memory['parent_commit_bytes']['maximum_observed_private_usage'],amount)
            self.assertIsNone(memory['family_resident_ram_bytes'])
            process.stdin.write(b'\n');process.stdin.flush();process.stdin.close();process.wait(timeout=5)
            cleanup=job.finish();self.assertEqual(process.returncode,0);self.assertFalse(cleanup['forced_tree_termination'])
            self.assertEqual(cleanup['active_after_cleanup'],0)
            self.__class__.validation={'allocated_child_bytes':amount,'parent_pid':process.pid,'child_returncode':process.returncode,
                'actual_memory_api_samples':memory,'actual_owned_job_cleanup':cleanup,
                'scope':'Only a newly created Python child; not a source14 worker/NVDA/model memory result',
                'physical_audio_verified':False,'acoustic_latency_verified':False,'product_ready':False}
        finally:
            if sampler is not None:sampler.stop()
            if process is not None and process.poll() is None:process.kill();process.wait(timeout=5)
            if job.handle is not None:job.finish(grace_seconds=0)
            if process is not None:
                for stream in (process.stdin,process.stdout):
                    if stream is not None and not stream.closed:stream.close()


if __name__=='__main__':unittest.main()
