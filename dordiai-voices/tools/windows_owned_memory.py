"""Bounded read-only Windows memory observations on already-owned handles.

Working sets describe the held parent process's resident RAM. Private/pagefile
and job peaks describe COMMIT, never family RAM. No PID enumeration, OpenProcess,
handle duplication, process control or handle closing occurs in this module.
"""
from __future__ import annotations
import copy
import ctypes as ct
import os
import subprocess
import threading
import time

PROCESS_FIELDS=('working_set_bytes','os_peak_working_set_bytes','private_commit_bytes','os_peak_pagefile_commit_bytes')
JOB_FIELDS=('os_peak_job_commit_bytes',)


class MemoryApiError(RuntimeError):
    def __init__(self,operation,error_code):
        self.operation=operation;self.error_code=int(error_code)
        super().__init__(operation+' failed with Windows error '+str(error_code))


class ProcessMemoryCountersEx(ct.Structure):
    _fields_=[('cb',ct.c_uint32),('PageFaultCount',ct.c_uint32),
              ('PeakWorkingSetSize',ct.c_size_t),('WorkingSetSize',ct.c_size_t),
              ('QuotaPeakPagedPoolUsage',ct.c_size_t),('QuotaPagedPoolUsage',ct.c_size_t),
              ('QuotaPeakNonPagedPoolUsage',ct.c_size_t),('QuotaNonPagedPoolUsage',ct.c_size_t),
              ('PagefileUsage',ct.c_size_t),('PeakPagefileUsage',ct.c_size_t),('PrivateUsage',ct.c_size_t)]


class JobBasicLimits(ct.Structure):
    _fields_=[('PerProcessUserTimeLimit',ct.c_int64),('PerJobUserTimeLimit',ct.c_int64),
              ('LimitFlags',ct.c_uint32),('MinimumWorkingSetSize',ct.c_size_t),('MaximumWorkingSetSize',ct.c_size_t),
              ('ActiveProcessLimit',ct.c_uint32),('Affinity',ct.c_size_t),('PriorityClass',ct.c_uint32),('SchedulingClass',ct.c_uint32)]


class JobExtendedLimits(ct.Structure):
    _fields_=[('BasicLimitInformation',JobBasicLimits),('IoInfo',ct.c_uint64*6),
              ('ProcessMemoryLimit',ct.c_size_t),('JobMemoryLimit',ct.c_size_t),
              ('PeakProcessMemoryUsed',ct.c_size_t),('PeakJobMemoryUsed',ct.c_size_t)]


class WindowsMemoryApi:
    def __init__(self):
        if os.name!='nt':raise RuntimeError('Actual Windows memory APIs required')
        self.kernel=ct.WinDLL('kernel32',use_last_error=True)
        for name,args in [('K32GetProcessMemoryInfo',[ct.c_void_p,ct.POINTER(ProcessMemoryCountersEx),ct.c_uint32]),
                          ('QueryInformationJobObject',[ct.c_void_p,ct.c_int,ct.c_void_p,ct.c_uint32,ct.c_void_p]),
                          ('IsProcessInJob',[ct.c_void_p,ct.c_void_p,ct.POINTER(ct.c_int)])]:
            api=getattr(self.kernel,name);api.argtypes=args;api.restype=ct.c_int
    @staticmethod
    def _require(result,operation):
        if not result:raise MemoryApiError(operation,ct.get_last_error())
    def is_process_in_job(self,process_handle,job_handle):
        value=ct.c_int()
        self._require(self.kernel.IsProcessInJob(process_handle,job_handle,ct.byref(value)),'IsProcessInJob')
        return bool(value.value)
    def process_memory(self,handle):
        value=ProcessMemoryCountersEx();value.cb=ct.sizeof(value)
        self._require(self.kernel.K32GetProcessMemoryInfo(handle,ct.byref(value),ct.sizeof(value)),'K32GetProcessMemoryInfo')
        return {'working_set_bytes':int(value.WorkingSetSize),'os_peak_working_set_bytes':int(value.PeakWorkingSetSize),
                'private_commit_bytes':int(value.PrivateUsage),'os_peak_pagefile_commit_bytes':int(value.PeakPagefileUsage)}
    def job_memory(self,handle):
        value=JobExtendedLimits()
        self._require(self.kernel.QueryInformationJobObject(handle,9,ct.byref(value),ct.sizeof(value),None),'QueryInformationJobObject9')
        return {'os_peak_job_commit_bytes':int(value.PeakJobMemoryUsed)}


def _error(operation,error):
    return {'status':'error','operation':getattr(error,'operation',operation),
            'error_type':type(error).__name__,'error':str(error),'windows_error_code':getattr(error,'error_code',None)}


def _measurement(values,fields):
    if not isinstance(values,dict) or set(values)!=set(fields) or any(type(values[k]) is not int or values[k]<0 for k in fields):
        raise ValueError('Memory API must return exact nonnegative integer byte counters')
    return dict(status='measured',units='bytes',**values)


class OwnedProcessMemorySampler:
    """Caller retains handles and must stop/join BEFORE their owner closes them.

    Strong Popen/job references prevent garbage-collection handle release. The
    optional job must contain this process. It is never found by PID or name.
    """
    def __init__(self,process,*,job=None,interval_seconds=.1,max_samples=256,api=None):
        if not isinstance(process,subprocess.Popen):raise TypeError('An already-owned Popen object, not PID, is required')
        if isinstance(interval_seconds,bool) or not isinstance(interval_seconds,(int,float)) or not .01<=interval_seconds<=10:
            raise ValueError('Finite sampling interval .01..10 seconds required')
        if type(max_samples) is not int or not 1<=max_samples<=10000:raise ValueError('Finite sample quota1..10000 required')
        self.process=process;self.job=job;self.api=WindowsMemoryApi() if api is None else api
        self.interval_seconds=float(interval_seconds);self.max_samples=max_samples
        self._process_handle=getattr(process,'_handle',None)
        if self._process_handle is None or isinstance(self._process_handle,bool) or int(self._process_handle)<=0:
            raise ValueError('Already-held Popen process handle required')
        self._job_handle=getattr(job,'handle',None) if job is not None else None
        self._assert_handles_held()
        if job is not None and not self.api.is_process_in_job(int(self._process_handle),int(self._job_handle)):
            raise ValueError('Explicit owned job does not contain the held process')
        self._condition=threading.Condition();self._stop=threading.Event();self._finished=threading.Event()
        self._thread=None;self._snapshots=[];self._control_errors=[];self._started_ns=None;self._finished_ns=None
        self._stop_reason=None;self._joined=False;self._handles_held_at_stop=None

    def _assert_handles_held(self):
        if (getattr(self.process,'_handle',None) is not self._process_handle
            or getattr(self._process_handle,'closed',False)):
            raise ValueError('Owned process handle changed/closed before sampler stop')
        if self.job is not None:
            value=getattr(self.job,'handle',None)
            if value is None or isinstance(value,bool) or int(value)<=0 or value!=self._job_handle:
                raise ValueError('Owned job handle changed/closed before sampler stop')

    def _snapshot(self):
        start=time.monotonic_ns()
        row={'monotonic_ns':start,'parent_pid_label_only':self.process.pid,
             'process_memory':{'status':'not-observed'},'job_memory':{'status':'not-requested'},'children_resident_ram_bytes':None}
        try:self._assert_handles_held()
        except Exception as error:
            row['process_memory']=_error('held-handle-lifetime',error)
            if self.job is not None:row['job_memory']=_error('held-handle-lifetime',error)
        else:
            try:row['process_memory']=_measurement(self.api.process_memory(int(self._process_handle)),PROCESS_FIELDS)
            except Exception as error:row['process_memory']=_error('K32GetProcessMemoryInfo',error)
            if self.job is not None:
                try:row['job_memory']=_measurement(self.api.job_memory(int(self._job_handle)),JOB_FIELDS)
                except Exception as error:row['job_memory']=_error('QueryInformationJobObject9',error)
        row['sampling_duration_ns']=time.monotonic_ns()-start
        return row

    def start(self):
        with self._condition:
            if self._thread is not None:raise RuntimeError('Owned memory sampler is one-shot')
            self._assert_handles_held();self._started_ns=time.monotonic_ns()
            self._thread=threading.Thread(target=self._run,name='owned-memory-observer',daemon=False)
            self._thread.start()
        return self

    def _run(self):
        try:
            while not self._stop.is_set():
                row=self._snapshot()
                with self._condition:
                    row['sample_index']=len(self._snapshots);self._snapshots.append(row);self._condition.notify_all()
                    if len(self._snapshots)>=self.max_samples:self._stop_reason='sample-quota-reached';break
                if self._stop.wait(self.interval_seconds):break
        except Exception as error:
            with self._condition:self._control_errors.append(_error('sampler-thread',error));self._condition.notify_all()
        finally:
            with self._condition:
                self._finished_ns=time.monotonic_ns();self._finished.set();self._condition.notify_all()

    def wait_for_samples(self,count,timeout=5):
        if type(count) is not int or not 1<=count<=self.max_samples or not 0<timeout<=30:raise ValueError('Bounded valid sample wait required')
        with self._condition:
            if not self._condition.wait_for(lambda:len(self._snapshots)>=count or self._finished.is_set(),timeout):
                raise TimeoutError('Owned memory sample wait timed out')
            if len(self._snapshots)<count:raise RuntimeError('Sampler ended before requested observations')

    def stop(self,timeout=5):
        if isinstance(timeout,bool) or not isinstance(timeout,(int,float)) or not 0<timeout<=30:raise ValueError('Finite stop/join timeout0..30 required')
        if self._thread is None:raise RuntimeError('Memory sampler was never started')
        if self._joined:return self.report()
        self._stop.set();self._thread.join(timeout)
        if self._thread.is_alive():
            with self._condition:self._control_errors.append(_error('stop-join',TimeoutError('Sampler still owns live API work; handles must remain held')))
            raise TimeoutError('Sampler did not stop; do not close owned handles')
        self._joined=True
        try:self._assert_handles_held();self._handles_held_at_stop=True
        except Exception as error:
            self._handles_held_at_stop=False
            with self._condition:self._control_errors.append(_error('stop-before-handle-close',error))
        if self._stop_reason is None:self._stop_reason='stop-requested'
        return self.report()

    def report(self):
        with self._condition:
            rows=copy.deepcopy(self._snapshots);errors=copy.deepcopy(self._control_errors)
        def maximum(section,field):
            values=[r[section][field] for r in rows if r[section]['status']=='measured']
            return max(values) if values else None
        failed=bool(errors) or any(r['process_memory']['status']=='error' or r['job_memory']['status']=='error' for r in rows)
        return {'format':'dordiai-owned-process-memory-samples','format_version':1,
            'status':'failed' if failed else 'stopped' if self._joined else 'not-started' if self._thread is None
                     else 'complete-awaiting-stop-join' if self._finished.is_set() else 'sampling',
            'parent_pid_label_only':self.process.pid,'handle_source':'Existing exact Popen handle; optional explicitly owned containing job handle',
            'interval_seconds':self.interval_seconds,'max_samples':self.max_samples,'sample_count':len(rows),
            'sample_quota_reached':len(rows)==self.max_samples,'started_monotonic_ns':self._started_ns,'finished_monotonic_ns':self._finished_ns,
            'stop_reason':self._stop_reason,'sampler_thread_joined':self._joined,
            'handles_observed_held_at_stop':self._handles_held_at_stop,'control_errors':errors,'snapshots':rows,
            'parent_ram_bytes':{'maximum_observed_working_set':maximum('process_memory','working_set_bytes'),
                                'maximum_observed_os_peak_working_set':maximum('process_memory','os_peak_working_set_bytes')},
            'parent_commit_bytes':{'maximum_observed_private_usage':maximum('process_memory','private_commit_bytes'),
                                   'maximum_observed_os_peak_pagefile_usage':maximum('process_memory','os_peak_pagefile_commit_bytes')},
            'owned_job_commit_bytes':{'maximum_observed_os_peak_job_memory_used':maximum('job_memory','os_peak_job_commit_bytes')},
            'children_resident_ram_bytes':None,'family_resident_ram_bytes':None,
            'semantics':{'working_set':'Resident pages of the held parent process, including shared pages; OS peak is process-lifetime peak',
                'private_usage_and_peak_pagefile':'Process COMMIT counters, not RAM',
                'peak_job_memory_used':'OS peak aggregate job COMMIT, not resident working set; not current RAM',
                'children_rss':'Not measured. Never infer it from job commit or add overlapping shared working sets.',
                'sampling_overhead':'Periodic observer API time is recorded separately; these observations are not a CPU or acoustic latency benchmark',
                'units':'All memory counters are integer bytes; no MiB/MB conversion is applied to raw values'},
            'physical_audio_verified':False,'acoustic_latency_verified':False,'product_ready':False}

    def __enter__(self):return self.start()
    def __exit__(self,exc_type,exc,tb):self.stop();return False
