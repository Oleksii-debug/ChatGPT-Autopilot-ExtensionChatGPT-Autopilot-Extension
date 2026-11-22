"""Compare frozen and candidate actual workers with owned scheduling traces.

No model, text, voice or buffer changes. The diagnostic wrapper only observes
kernel priority calls and protocol phase labels. No NVDA or audio device opens.
"""
from __future__ import annotations
import argparse
import ctypes as ct
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from unittest.mock import patch
import uuid

TOOLS=Path(__file__).resolve().parent
sys.path.insert(0,str(TOOLS))
from windows_engine_probe import PipeWorker,make_request
from windows_prefetch_trials import OwnedProcessJob

CHANGED=('wide_warmup.py','nvda_worker.py','native_multilingual.py')
TEXT={'uk':'Наступне вікно готове до роботи.',
      'en':'The next window is ready for work.',
      'ru':'Следующее окно готово к работе.'}
WRAPPER=r'''
import json,runpy,sys,time
from pathlib import Path
script=Path(sys.argv[1]);gate=Path(sys.argv[2]);deadline=time.monotonic()+10
while not gate.is_file():
    if time.monotonic()>deadline:raise RuntimeError('Owned job was not assigned')
    time.sleep(.01)
sys.path.insert(0,str(script.parent))
import wide_warmup
import builtins
original_import=builtins.__import__
def imported(name,*args,**kwargs):
    module=original_import(name,*args,**kwargs)
    if name=='native_multilingual' and not getattr(module.RussianPipe,'_priority_close_observed',False):
        original_close=module.RussianPipe.close
        def close(pipe):
            process=pipe.process
            try:return original_close(pipe)
            finally:
                if process is not None:
                    print('DORDIAI_RU_CLOSE '+json.dumps({'pid':process.pid,
                        'held_handle':int(process._handle),'exit_code':process.poll(),
                        'process_cleared':pipe.process is None,
                        'stdin_closed':process.stdin.closed,'stdout_closed':process.stdout.closed}),
                        file=sys.stderr,flush=True)
        module.RussianPipe.close=close
        module.RussianPipe._priority_close_observed=True
    return module
builtins.__import__=imported
original=wide_warmup._scheduling
class TraceKernel:
    def __init__(self,kernel):self.kernel=kernel
    def __getattr__(self,name):return getattr(self.kernel,name)
    def SetPriorityClass(self,handle,value):
        before=self.kernel.GetPriorityClass(handle)
        ok=self.kernel.SetPriorityClass(handle,value)
        after=self.kernel.GetPriorityClass(handle)
        print('DORDIAI_PRIORITY '+json.dumps({'time':time.perf_counter(),
            'handle':int(handle),'before':before,'target':value,'after':after,'ok':bool(ok)}),
            file=sys.stderr,flush=True)
        return ok
def observed():
    kernel=original()
    return None if kernel is None else TraceKernel(kernel)
wide_warmup._scheduling=observed
original_loads=json.loads
def loads(*args,**kwargs):
    value=original_loads(*args,**kwargs)
    if isinstance(value,dict) and 'probePhase' in value:
        print('DORDIAI_PHASE '+json.dumps({'phase':value['probePhase'],'mode':value.get('mode')}),
              file=sys.stderr,flush=True)
    return value
json.loads=loads
sys.argv=[str(script),*sys.argv[3:]]
runpy.run_path(str(script),run_name='__main__')
'''


def trace_summary(text):
    records=[json.loads(line.split(' ',1)[1]) for line in text.splitlines()
             if line.startswith('DORDIAI_PRIORITY ')]
    states={};errors=[]
    for record in records:
        handle=record['handle']
        if record['target'] not in (0x20,0x4000) or not record['ok'] or record['after']!=record['target']:
            errors.append(record)
        if handle in states and record['before']!=states[handle]:errors.append(record)
        states[handle]=record['after']
    phases=[json.loads(line.split(' ',1)[1]) for line in text.splitlines() if line.startswith('DORDIAI_PHASE ')]
    native_closes=[json.loads(line.split(' ',1)[1]) for line in text.splitlines() if line.startswith('DORDIAI_RU_CLOSE ')]
    return {'calls':len(records),'handles':len(states),'final_priorities':list(states.values()),
            'all_observed_restored_below_normal':bool(records) and not errors and all(value==0x4000 for value in states.values()),
            'errors':errors,'phases':phases,'native_child_closes':native_closes,
            'all_known_native_children_reaped':bool(native_closes) and all(
                r['exit_code'] is not None and r['process_cleared'] and r['stdin_closed'] and r['stdout_closed']
                for r in native_closes)}


def overlay_copy(baseline,candidate,source):
    if candidate.exists():raise ValueError('Fresh candidate directory required')
    shutil.copytree(baseline,candidate,copy_function=os.link)
    for name in CHANGED:
        target=candidate/'kx47Runtime'/name
        target.unlink() # break only these code hardlinks before any write
        target.write_bytes((source/name).read_bytes())
        if os.path.samefile(target,baseline/'kx47Runtime'/name):raise ValueError('Candidate code shares baseline inode')


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline',type=Path,required=True)
    parser.add_argument('--candidate',type=Path,required=True)
    parser.add_argument('--source-runtime',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--cleanup-only',action='store_true')
    args=parser.parse_args(argv)
    if sys.platform!='win32':parser.error('Actual Windows workers required')
    baseline=args.baseline.resolve();candidate=args.candidate.resolve()
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=False)
    if args.cleanup_only:
        if not candidate.is_dir():raise ValueError('Existing isolated candidate required for cleanup repeat')
        for name in CHANGED:
            if (candidate/'kx47Runtime'/name).read_bytes()!=(args.source_runtime/name).read_bytes():
                raise ValueError('Existing candidate patch changed before cleanup repeat')
    else:
        overlay_copy(baseline,candidate,args.source_runtime.resolve())
    source=Path(__file__).read_bytes();(output/'probe-driver.py').write_bytes(source)
    report={'format':'dordiai-actual-core-worker-priority-comparison','format_version':1,
        'created_utc':datetime.now(timezone.utc).isoformat(),'software_pcm_only':True,
        'candidate_is_source_overlay_not_release':True,'live_nvda_edited':False,
        'baseline':str(baseline),'candidate':str(candidate),'runs':[],
        'cleanup_only':args.cleanup_only,'probe_driver_sha256':hashlib.sha256(source).hexdigest(),
        'synthetic_load_requested_duty_cycle':.60,'synthetic_load_maximum_seconds':150,
        'patch_sha256':{name:hashlib.sha256((candidate/'kx47Runtime'/name).read_bytes()).hexdigest() for name in CHANGED}}
    job=OwnedProcessJob();workers={};burn=None;gates=[]
    k=ct.WinDLL('kernel32',use_last_error=True)
    k.SetProcessAffinityMask.argtypes=[ct.c_void_p,ct.c_size_t]
    k.GetProcessAffinityMask.argtypes=[ct.c_void_p,ct.POINTER(ct.c_size_t),ct.POINTER(ct.c_size_t)]
    original_popen=subprocess.Popen
    def spawn(*positional,**kwargs):
        command=positional[0]
        gate=output/('owned-start-'+uuid.uuid4().hex);gates.append(gate)
        wrapped=[*command[:4],'-c',WRAPPER,command[4],str(gate),*command[5:]]
        process=original_popen(wrapped,*positional[1:],**kwargs)
        job.assign(process);gate.write_bytes(b'owned')
        return process
    try:
        for label,package in [('baseline',baseline),('candidate',candidate)]:
            with patch('subprocess.Popen',side_effect=spawn):
                worker=PipeWorker(package/'kx47Runtime',output/(label+'-stderr.log'))
            workers[label]=worker
            mask=ct.c_size_t();system=ct.c_size_t()
            if not k.GetProcessAffinityMask(int(worker.process._handle),ct.byref(mask),ct.byref(system)):
                raise ct.WinError(ct.get_last_error())
            core=mask.value&-mask.value
            if not k.SetProcessAffinityMask(int(worker.process._handle),core):raise ct.WinError(ct.get_last_error())
            # All resources warmed outside the measured workload, no background loader.
            for language,text in TEXT.items():
                request=make_request(language,'sara_archive',text);request['probePhase']='warm-'+language
                worker.render(request,60)
        report['logical_cpu_affinity_mask']=core
        if not args.cleanup_only:
            burn=original_popen([str(baseline/'kx47Runtime/python/python.exe'),'-I','-B','-c',
            'import time;end=time.monotonic()+150\nwhile time.monotonic()<end:\n'
            ' until=time.monotonic()+.012\n while time.monotonic()<until: pass\n time.sleep(.008)'],
            creationflags=subprocess.CREATE_NO_WINDOW|subprocess.NORMAL_PRIORITY_CLASS)
            job.assign(burn)
            if not k.SetProcessAffinityMask(int(burn._handle),core):raise ct.WinError(ct.get_last_error())
        for round_index in range(0 if args.cleanup_only else 4):
            order=('baseline','candidate') if round_index%2==0 else ('candidate','baseline')
            for language,text in TEXT.items():
                for label in order:
                    active_before=burn.poll() is None
                    request=make_request(language,'sara_archive',text);request['probePhase']='normal-'+language
                    pcm,stats=workers[label].render(request,45)
                    report['runs'].append({'round':round_index,'case':label,'language':language,
                        'load_active_before':active_before,'load_active_after':burn.poll() is None,
                        'pcm_sha256':hashlib.sha256(pcm).hexdigest(),**stats})
        # Real dispatcher error followed by recovery, and cancel/drop a native
        # Russian stream while its child is waiting for consumer acknowledgement.
        worker=workers['candidate']
        request=make_request('uk','sara_archive',TEXT['uk']);request.update(speed=0,probePhase='error')
        worker.send(request);error=worker.receive(10)
        if error.get('error')!='ValueError':raise RuntimeError('Actual error path was not exercised')
        report['error_response']=error
        request=make_request('ru','sara_archive',TEXT['ru']);request['probePhase']='cancel-ru'
        worker.send(request);first=worker.receive(20)
        if 'chunk' not in first:raise RuntimeError('Actual Russian first chunk missing')
        worker.send({'mode':'cancel','probePhase':'cancel-signal'})
        worker.send({'mode':'drop','probePhase':'cancel-drop'})
        if worker.receive(10)!={'finished':True}:raise RuntimeError('Actual cancel/drop acknowledgment missing')
        report['cancel_drop_acknowledged']=True
        pcm,stats=worker.render(make_request('uk','sara_archive','Завершено перевірку.'),20)
        report['recovery_after_error_cancel']={'pcm_sha256':hashlib.sha256(pcm).hexdigest(),**stats}
    except Exception as error:
        report['error']=type(error).__name__+': '+str(error)
    finally:
        if burn is not None:
            if burn.poll() is None:burn.terminate()
            burn.wait(timeout=5)
        for label,worker in workers.items():
            report[label+'_cleanup']=worker.close()
        # Preserve every observation. A signalled process may remain briefly
        # in kernel job accounting; wait a finite natural-exit grace only.
        active_samples=[];until=time.monotonic()+2
        while True:
            active=job.active();active_samples.append({'time':time.perf_counter(),'active':active})
            if not active or time.monotonic()>=until:break
            time.sleep(.02)
        report['natural_exit_grace_samples']=active_samples
        report['owned_job_cleanup']=job.finish()
        for gate in gates:
            if gate.exists():gate.unlink()
        for label in workers:
            text=(output/(label+'-stderr.log')).read_text(encoding='utf8',errors='replace')
            report[label+'_priority_trace']=trace_summary(text)
        report['all_measured_requests_load_controlled']=len(report['runs'])==24 and all(
            r['load_active_before'] and r['load_active_after'] for r in report['runs'])
        report['status']='measured' if 'error' not in report else 'failed'
        (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    return 0 if report['status']=='measured' else 1


if __name__=='__main__':raise SystemExit(main())
