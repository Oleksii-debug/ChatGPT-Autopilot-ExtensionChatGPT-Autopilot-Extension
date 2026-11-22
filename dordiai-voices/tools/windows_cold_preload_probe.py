"""Observe foreground arrival during real cold Russian preload lock ownership.

Resource directories and production14 stay read-only. Each owned interpreter is
fresh; filesystem cache is deliberately not cleared. No host prewarm utterances.
"""
from __future__ import annotations
import argparse
import ctypes as ct
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import re
import os
import shutil
import subprocess
import sys
import time
from unittest.mock import patch

TOOLS=Path(__file__).resolve().parent;sys.path.insert(0,str(TOOLS))
from windows_engine_probe import PipeWorker,make_request
from windows_core_worker_priority_probe import WRAPPER
from windows_prefetch_trials import OwnedProcessJob

OBSERVERS=r'''
import ctypes as _cold_ct,threading as _cold_threading
def _cold_emit(event,owner=None,process=None,**extra):
    kernel=original()
    if process is None and owner is not None:
        pipe=owner.__dict__.get('russian')
        process=pipe.process if pipe is not None else None
    record={'event':event,'time':time.perf_counter(),'thread':_cold_threading.current_thread().name,
            'parent_priority':kernel.GetPriorityClass(kernel.GetCurrentProcess()),**extra}
    if process is not None:
        record.update(child_pid=process.pid,held_handle=int(process._handle),
                      child_priority=kernel.GetPriorityClass(int(process._handle)))
    sys.stderr.write('DORDIAI_COLD '+json.dumps(record)+'\n');sys.stderr.flush()
class _ColdLock:
    def __init__(self,inner,owner):self.inner,self.owner=inner,owner;self.pending={}
    def acquire(self,*args,**kwargs):
        name=_cold_threading.current_thread().name
        if name not in self.pending:
            self.pending[name]=time.perf_counter();_cold_emit('lock-wait-begin',self.owner)
        acquired=self.inner.acquire(*args,**kwargs)
        if acquired:
            start=self.pending.pop(name)
            _cold_emit('lock-acquired',self.owner,wait_ms=(time.perf_counter()-start)*1000)
        return acquired
    def __enter__(self):
        self.acquire()
        return self
    def release(self):
        released=time.perf_counter();self.inner.release()
        _cold_emit('lock-released',self.owner,released_time=released)
    def __exit__(self,*args):self.release()
_cold_import_previous=builtins.__import__
def _cold_import(name,*args,**kwargs):
    module=_cold_import_previous(name,*args,**kwargs)
    if name=='native_multilingual' and not getattr(module.NativeMultilingual,'_cold_observed',False):
        constructor=module.NativeMultilingual.__init__
        def initialize(owner,*a,**kw):
            constructor(owner,*a,**kw);owner._russian_lock=_ColdLock(owner._russian_lock,owner)
        module.NativeMultilingual.__init__=initialize
        warm=module.NativeMultilingual.warm_russian
        def warming(owner):
            _cold_emit('warm-russian-enter',owner)
            try:return warm(owner)
            finally:_cold_emit('warm-russian-exit',owner)
        module.NativeMultilingual.warm_russian=warming
        start=module.RussianPipe.start
        def starting(pipe,*a,**kw):
            began=time.perf_counter()
            _cold_emit('russian-start-begin',process=pipe.process,foreground=bool(kw.get('foreground')))
            try:return start(pipe,*a,**kw)
            finally:_cold_emit('russian-start-end',process=pipe.process,
                elapsed_ms=(time.perf_counter()-began)*1000,foreground=bool(kw.get('foreground')))
        module.RussianPipe.start=starting
        spawn=module.subprocess.Popen
        def spawned(*a,**kw):
            process=spawn(*a,**kw)
            if str(a[0][0]).lower().endswith('pocket-ru.exe'):
                _cold_emit('russian-child-created',process=process,
                           creationflags=kw.get('creationflags'))
            return process
        module.subprocess.Popen=spawned
        module.NativeMultilingual._cold_observed=True
    return module
builtins.__import__=_cold_import
'''
COLD_WRAPPER=WRAPPER.replace('builtins.__import__=imported\n',
                              'builtins.__import__=imported\n'+OBSERVERS,1)

# Prototype only. This text is inserted into a fresh isolated package; the
# production14 tree and the frozen baseline/candidate are never changed.
COLD_LOCK_HELPER='''    @contextmanager
    def _russian_foreground(self, cancelled):
        acquired = False
        try:
            while not acquired:
                if cancelled():
                    raise SynthesisCancelled()
                acquired = self._russian_lock.acquire(timeout=.01)
                if acquired:
                    break
                pipe = self.__dict__.get("russian")
                held = getattr(pipe, "process", None)
                if held is None or held.poll() is not None:
                    continue
                held_handle = held._handle
                with foreground_priority(process=int(held_handle)):
                    while not acquired:
                        if cancelled():
                            raise SynthesisCancelled()
                        acquired = self._russian_lock.acquire(timeout=.01)
                        if pipe.process is not held or held.poll() is not None:
                            break
            # The cold child's temporary boost is gone before normal stream
            # work/yielding; RussianPipe applies its own per-packet scope.
            if cancelled():
                raise SynthesisCancelled()
            yield
        finally:
            if acquired:
                self._russian_lock.release()

'''


def prototype_copy(source,target):
    if target.exists():raise ValueError('Fresh prototype path required')
    shutil.copytree(source,target,copy_function=os.link)
    path=target/'kx47Runtime/native_multilingual.py'
    data=path.read_bytes();newline='\r\n' if b'\r\n' in data else '\n'
    text=data.decode('utf8')
    text=text.replace('from contextlib import nullcontext','from contextlib import nullcontext, contextmanager',1)
    anchor='    def stream(self, profile, language, text, speed=1.0, cancelled=lambda: False):'
    if text.count(anchor)!=1:raise ValueError('Prototype insertion anchor changed')
    text=text.replace(anchor,COLD_LOCK_HELPER.replace('\n',newline)+anchor,1)
    original='            def russian_chunks():'+newline+'                with self._russian_lock:'
    replacement='            def russian_chunks():'+newline+'                with self._russian_foreground(cancelled):'
    if text.count(original)!=1:raise ValueError('Prototype lock anchor changed')
    text=text.replace(original,replacement,1)
    path.unlink();path.write_bytes(text.encode('utf8'))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def events(text):
    decoder=json.JSONDecoder();result=[]
    for match in re.finditer('DORDIAI_COLD ',text):
        value,_=decoder.raw_decode(text[match.end():]);result.append(value)
    return result


def judge(rows):
    waits=[r for r in rows if r['event']=='lock-wait-begin' and r['thread']=='MainThread']
    acquisitions=[r for r in rows if r['event']=='lock-acquired' and r['thread']=='MainThread']
    releases=[r.get('released_time',r['time']) for r in rows if r['event']=='lock-released' and r['thread']=='Russian setup']
    warm=[r['time'] for r in rows if r['event']=='warm-russian-enter']
    return {'foreground_arrived_during_warmup':bool(waits and releases and warm and min(warm)<=waits[0]['time']<releases[0]),
            'foreground_lock_wait_ms':acquisitions[0]['wait_ms'] if acquisitions else None,
            'priorities_on_foreground_wait':waits[0] if waits else None}


def trial(package,output,load,*,one_core=True,cancel_wait=False):
    output.mkdir(parents=True,exist_ok=False)
    report={'package':str(package),'requested_synthetic_duty_cycle':load,
            'host_prewarm_utterances_sent':False,'events':[],
            'runtime_sha256':{name:hashlib.sha256((package/'kx47Runtime'/name).read_bytes()).hexdigest()
                              for name in ('nvda_worker.py','wide_warmup.py','native_multilingual.py')}}
    job=OwnedProcessJob();worker=None;burn=None;gate=output/'owned-start'
    k=ct.WinDLL('kernel32',use_last_error=True)
    k.GetProcessAffinityMask.argtypes=[ct.c_void_p,ct.POINTER(ct.c_size_t),ct.POINTER(ct.c_size_t)]
    k.SetProcessAffinityMask.argtypes=[ct.c_void_p,ct.c_size_t]
    real_popen=subprocess.Popen
    def spawn(command,*args,**kwargs):
        process=real_popen([*command[:4],'-c',COLD_WRAPPER,command[4],str(gate),*command[5:]],*args,**kwargs)
        job.assign(process);gate.write_bytes(b'owned');return process
    try:
        with patch('subprocess.Popen',side_effect=spawn):worker=PipeWorker(package/'kx47Runtime',output/'worker-stderr.log')
        mask=ct.c_size_t();system=ct.c_size_t()
        if not k.GetProcessAffinityMask(int(worker.process._handle),ct.byref(mask),ct.byref(system)):raise ct.WinError(ct.get_last_error())
        core=mask.value&-mask.value
        report['inherited_affinity_mask']=mask.value
        report['owned_worker_affinity_mask']=core if one_core else mask.value
        report['single_core_constraint']=one_core
        if one_core and not k.SetProcessAffinityMask(int(worker.process._handle),core):raise ct.WinError(ct.get_last_error())
        if load:
            burn=real_popen([str(package/'kx47Runtime/python/python.exe'),'-I','-B','-c',
                'import time;end=time.monotonic()+60\nwhile time.monotonic()<end:\n'
                ' until=time.monotonic()+.012\n while time.monotonic()<until: pass\n time.sleep(.008)'],
                creationflags=subprocess.CREATE_NO_WINDOW|subprocess.NORMAL_PRIORITY_CLASS)
            job.assign(burn)
            if not k.SetProcessAffinityMask(int(burn._handle),core):raise ct.WinError(ct.get_last_error())
        start=time.perf_counter()
        worker.send({'mode':'preload','runtimeOnly':True,'probePhase':'cold-preload'})
        ready=worker.receive(25)
        if not ready.get('ready'):raise RuntimeError('Actual preload ready reply missing')
        report['preload_ready_ms']=(time.perf_counter()-start)*1000
        until=time.monotonic()+25
        while True:
            rows=events((output/'worker-stderr.log').read_text(encoding='utf8',errors='replace'))
            if any(r['event']=='russian-child-created' for r in rows):break
            if time.monotonic()>until:raise RuntimeError('Preload did not create an owned Russian child within25s; inspect memory guard and trace')
            time.sleep(.01)
        request=make_request('ru','sara_archive','Следующее окно готово к работе.')
        request['probePhase']='foreground-during-cold-preload'
        start=time.perf_counter();report['foreground_send_time']=start
        worker.send(request)
        if cancel_wait:
            until=time.monotonic()+10
            while True:
                rows=events((output/'worker-stderr.log').read_text(encoding='utf8',errors='replace'))
                if any(r['event']=='lock-wait-begin' and r['thread']=='MainThread' for r in rows):break
                if time.monotonic()>until:raise RuntimeError('Actual foreground lock wait was not observed')
                time.sleep(.005)
            cancelled_at=time.perf_counter()
            worker.send({'mode':'cancel','probePhase':'cancel-while-waiting'})
            worker.send({'mode':'drop','probePhase':'drop-while-waiting'})
            if worker.receive(30)!={'finished':True}:raise RuntimeError('Waiting foreground cancel acknowledgment missing')
            report['cancel_while_waiting_ack_ms']=(time.perf_counter()-cancelled_at)*1000
            report['cancel_sent_before_pcm']=True
            if worker.receive(10)!={'finished':True}:raise RuntimeError('Waiting foreground drop acknowledgment missing')
            report['cancel_drop_acknowledged']=True
            # Cancellation timing is already captured. Let the preserved cold
            # preload finish naturally before evaluating teardown separately.
            if burn is not None and burn.poll() is None:burn.terminate();burn.wait(timeout=5)
            until=time.monotonic()+30
            while True:
                rows=events((output/'worker-stderr.log').read_text(encoding='utf8',errors='replace'))
                if any(r['event']=='warm-russian-exit' for r in rows):break
                if time.monotonic()>until:raise RuntimeError('Retained preload did not finish after cancellation')
                time.sleep(.02)
            return report
        first=worker.receive(30)
        report['foreground_first_reply_ms']=(time.perf_counter()-start)*1000
        if 'chunk' not in first:raise RuntimeError('Actual foreground request did not return PCM')
        report['load_alive_at_first_reply']=burn is None or burn.poll() is None
        worker.send({'mode':'cancel','probePhase':'cancel'})
        worker.send({'mode':'drop','probePhase':'drop'})
        if worker.receive(10)!={'finished':True}:raise RuntimeError('Cancel/drop not acknowledged')
        report['cancel_drop_acknowledged']=True
    except Exception as error:
        report['error']=type(error).__name__+': '+str(error)
    finally:
        if burn is not None:
            if burn.poll() is None:burn.terminate()
            burn.wait(timeout=5)
        if worker is not None:report['worker_cleanup']=worker.close()
        samples=[];until=time.monotonic()+2
        while True:
            active=job.active();samples.append({'time':time.perf_counter(),'active':active})
            if not active or time.monotonic()>until:break
            time.sleep(.02)
        report['natural_exit_grace_samples']=samples;report['owned_job_cleanup']=job.finish()
        if gate.exists():gate.unlink()
        log=output/'worker-stderr.log'
        if log.exists():report['events']=events(log.read_text(encoding='utf8',errors='replace'))
        report.update(judge(report['events']))
        (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    return report


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline',type=Path,required=True);parser.add_argument('--candidate',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--unconstrained-candidate-only',action='store_true')
    parser.add_argument('--prototype-root',type=Path)
    parser.add_argument('--cancel-while-waiting',action='store_true')
    args=parser.parse_args(argv)
    if sys.platform!='win32':parser.error('Actual Windows workers required')
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=False)
    source=Path(__file__).read_bytes();(output/'probe-driver.py').write_bytes(source)
    report={'format':'dordiai-actual-cold-preload-foreground-probe','format_version':1,
            'created_utc':datetime.now(timezone.utc).isoformat(),'software_pcm_only':True,
            'production14_edited':False,'live_nvda_edited':False,
            'cold_scope':'fresh interpreter/model state; shared filesystem cache is not reset',
            'probe_driver_sha256':hashlib.sha256(source).hexdigest(),'trials':[]}
    candidate=args.candidate
    if args.prototype_root:
        report['prototype_native_multilingual_sha256']=prototype_copy(candidate.resolve(),args.prototype_root.resolve())
        candidate=args.prototype_root
    cases=([('candidate-all-cores',args.candidate,0)] if args.unconstrained_candidate_only else
           [('baseline-unloaded',args.baseline,0),('candidate-load60',candidate,.6),
            ('candidate-unloaded',candidate,0),('baseline-load60',args.baseline,.6)])
    if args.unconstrained_candidate_only:cases=[('candidate-all-cores',candidate,0)]
    for label,path,load in cases:
        row=trial(path.resolve(),output/label,load,one_core=not args.unconstrained_candidate_only,
                  cancel_wait=args.cancel_while_waiting)
        row['case']=label;report['trials'].append(row)
        (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
        if not row.get('owned_job_cleanup',{}).get('all_owned_workers_reaped'):break
    return 0 if len(report['trials'])==len(cases) and all('error' not in r for r in report['trials']) else 1


if __name__=='__main__':raise SystemExit(main())
