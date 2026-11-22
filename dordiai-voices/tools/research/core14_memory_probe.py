"""One bounded local actual14 worker RAM/commit observation; no sound or NVDA.

Resources are hardlinked read-only from a verified existing13 extraction. Only
the five reviewed small14 payloads and generated inventory are written afresh.
No runtime code/model preparation or performance acceptance occurs here.
"""
from __future__ import annotations
import argparse
import ctypes as ct
import gzip
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path,PurePosixPath
from queue import Queue,Empty
import subprocess
import sys
import threading
import time
import zipfile

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools'))
from windows_owned_memory import OwnedProcessMemorySampler,WindowsMemoryApi

ARCHIVE_BYTES=1992990978
ARCHIVE_SHA='9024506b8250d18868801b5f061d570204ad713d0cfae2a67d77a97df2eb5820'
MIN_AVAILABLE_BYTES=1024**3


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);sys.modules[name]=m;spec.loader.exec_module(m);return m


def digest(path):
    with Path(path).open('rb') as f:return __import__('hashlib').file_digest(f,'sha256').hexdigest()


def relative_name(name):
    p=PurePosixPath(name)
    if '\\' in name or ':' in name or p.is_absolute() or any(x in ('','.','..') for x in p.parts) or p.as_posix()!=name:
        raise ValueError('Unsafe pinned member path')
    return name


def prepare_stage(archive,baseline,target,integration):
    if archive.stat().st_size!=ARCHIVE_BYTES or digest(archive)!=ARCHIVE_SHA:raise ValueError('Actual14 archive pin differs')
    if target.exists() or target.is_symlink():raise FileExistsError('Fresh owned memory stage required')
    old=json.loads((baseline/'dordiai-release.json').read_text(encoding='utf-8'))
    with zipfile.ZipFile(archive) as z:
        raw=z.read('dordiai-release.json');manifest=json.loads(raw)
        preservation=integration.verify_preservation(old,manifest)
        if set(z.namelist())!=set(manifest['files'])|{'dordiai-release.json'}:raise ValueError('Archive member inventory differs')
        target.mkdir()
        linked=written=0
        for name,record in manifest['files'].items():
            relative_name(name);destination=target/name;destination.parent.mkdir(parents=True,exist_ok=True)
            if name in integration.ALLOWED_CHANGES:
                data=z.read(name)
                if len(data)!=record['size_bytes'] or sha256(data).hexdigest()!=record['sha256']:raise ValueError('Pinned small14 overlay differs')
                destination.write_bytes(data);written+=len(data)
            else:
                source=baseline/name
                if source.is_symlink() or not source.is_file() or source.stat().st_size!=record['size_bytes']:raise ValueError('Existing source13 resource differs')
                os.link(source,destination);linked+=1
        (target/'dordiai-release.json').write_bytes(raw)
    return manifest,dict(preservation,hardlinked_payload_files=linked,new_payload_bytes_written=written,
                        model_copy_or_regeneration=False,overlay_created_without_writing_shared_inode=True)


def verify_stage(stage,manifest):
    files=manifest['files']
    for name,row in files.items():
        path=stage/name
        if path.is_symlink() or path.stat().st_size!=row['size_bytes'] or digest(path)!=row['sha256']:
            raise ValueError('Actual14 staged payload differs: '+name)
    return {'all_payload_sha256_verified':True,'verified_files':len(files),
            'verified_payload_bytes':sum(r['size_bytes'] for r in files.values()),'version':manifest['version']}


class MemoryStatus(ct.Structure):
    _fields_=[('length',ct.c_uint32),('load',ct.c_uint32),('total_phys',ct.c_uint64),('avail_phys',ct.c_uint64),
              ('total_page',ct.c_uint64),('avail_page',ct.c_uint64),('total_virtual',ct.c_uint64),
              ('avail_virtual',ct.c_uint64),('avail_extended',ct.c_uint64)]


def available_physical():
    value=MemoryStatus();value.length=ct.sizeof(value)
    api=ct.WinDLL('kernel32',use_last_error=True).GlobalMemoryStatusEx
    api.argtypes=[ct.POINTER(MemoryStatus)];api.restype=ct.c_int
    if not api(ct.byref(value)):raise ct.WinError(ct.get_last_error())
    return int(value.avail_phys)


def two_cpu_mask(allowed):
    if type(allowed) is not int or allowed<=0:raise ValueError('Positive existing process affinity required')
    selected=allowed&-allowed;remaining=allowed^selected
    return selected|(remaining&-remaining) if remaining else selected


def restrict_affinity(process):
    k=ct.WinDLL('kernel32',use_last_error=True);current=ct.c_size_t();system=ct.c_size_t()
    k.GetProcessAffinityMask.argtypes=[ct.c_void_p,ct.POINTER(ct.c_size_t),ct.POINTER(ct.c_size_t)];k.GetProcessAffinityMask.restype=ct.c_int
    k.SetProcessAffinityMask.argtypes=[ct.c_void_p,ct.c_size_t];k.SetProcessAffinityMask.restype=ct.c_int
    handle=int(process._handle)
    if not k.GetProcessAffinityMask(handle,ct.byref(current),ct.byref(system)):raise ct.WinError(ct.get_last_error())
    selected=two_cpu_mask(current.value)
    if not k.SetProcessAffinityMask(handle,selected):raise ct.WinError(ct.get_last_error())
    return {'original_mask':current.value,'selected_mask':selected,'effective_logical_cpu_count':selected.bit_count(),
            'internal_ort_threads':'Unchanged explicit3/4 runtime pools; affinity is NOT a thread-count2 claim'}


class GuardedMemoryApi(WindowsMemoryApi):
    def __init__(self):super().__init__();self.available=[];self.low=threading.Event()
    def process_memory(self,handle):
        amount=available_physical();self.available.append({'monotonic_ns':time.monotonic_ns(),'available_physical_bytes':amount})
        if amount<MIN_AVAILABLE_BYTES:self.low.set()
        return super().process_memory(handle)


class OwnedSpawn:
    def __init__(self,executable,owner):self.executable=executable.resolve();self.owner=owner;self.process=None;self.job=None;self.sampler=None
    def __getattr__(self,name):return getattr(subprocess,name)
    def Popen(self,command,*args,**kwargs):
        if self.process is not None or Path(command[0]).resolve()!=self.executable:raise ValueError('Only one exact owned14 worker allowed')
        if available_physical()<MIN_AVAILABLE_BYTES:raise MemoryError('Available physical RAM below1GiB before spawn')
        env=dict(os.environ,HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',DO_NOT_TRACK='1',
                 OMP_NUM_THREADS='2',MKL_NUM_THREADS='2',OPENBLAS_NUM_THREADS='2')
        kwargs.update(env=env,creationflags=kwargs.get('creationflags',0)|4|subprocess.BELOW_NORMAL_PRIORITY_CLASS)
        self.job=self.owner.OwnedNvdaJob()
        try:self.process=subprocess.Popen(command,*args,**kwargs)
        except BaseException:self.job.finish(grace_seconds=0);raise
        try:
            self.affinity=restrict_affinity(self.process)
            self.job.assign_and_resume(self.process)
            self.api=GuardedMemoryApi()
            self.sampler=OwnedProcessMemorySampler(self.process,job=self.job,api=self.api,interval_seconds=.25,max_samples=600).start()
        except BaseException:
            try:self.process.kill();self.process.wait(timeout=5)
            finally:
                if self.job.handle is not None:self.job.finish(grace_seconds=0)
            raise
        return self.process


def guarded_call(function,spawn,deadline,threads):
    result=Queue(maxsize=1)
    def invoke():
        try:result.put((True,function()))
        except BaseException as e:result.put((False,e))
    thread=threading.Thread(target=invoke,name='owned14-bounded-pipe-call',daemon=False);threads.append(thread);thread.start()
    while True:
        if spawn.api.low.is_set():raise MemoryError('Available physical RAM crossed below1GiB; cancel and reap owned worker')
        if time.monotonic()>=deadline:raise TimeoutError('Whole owned memory run exceeded150seconds')
        try:ok,value=result.get(timeout=.1)
        except Empty:continue
        thread.join(2)
        if not ok:raise value
        return value


def phase_summary(memory,phase):
    rows=[r for r in memory['snapshots'] if phase['started_ns']<=r['monotonic_ns']<=phase['finished_ns']]
    def maximum(section,field):
        values=[r[section][field] for r in rows if r[section]['status']=='measured']
        return max(values) if values else None
    return {'samples':len(rows),'parent_working_set_max_bytes':maximum('process_memory','working_set_bytes'),
            'parent_os_peak_working_set_max_bytes':maximum('process_memory','os_peak_working_set_bytes'),
            'parent_private_commit_max_bytes':maximum('process_memory','private_commit_bytes'),
            'job_os_peak_commit_max_bytes':maximum('job_memory','os_peak_job_commit_bytes'),
            'children_resident_ram_bytes':None,'family_resident_ram_bytes':None}


def cleanup_owned(spawn,worker,threads):
    report={};errors=[]
    if spawn is None:return report
    sampler=spawn.sampler;process=spawn.process
    if sampler is not None:
        try:report['memory_samples']=sampler.stop(timeout=5)
        except Exception as e:errors.append('initial sampler stop: '+repr(e))
        report['available_physical_samples']=spawn.api.available
    if process is not None:
        try:
            if process.stdin is not None and not process.stdin.closed:process.stdin.close()
            process.wait(timeout=5)
        except Exception as e:
            errors.append('normal worker shutdown: '+repr(e));report['owned_parent_forced']=True
            try:process.kill();process.wait(timeout=5)  # Exact already-held Popen only.
            except Exception as final:errors.append('held parent reap: '+repr(final))
        if sampler is not None and 'memory_samples' not in report:
            try:report['memory_samples']=sampler.stop(timeout=5)
            except Exception as e:errors.append('final sampler stop: '+repr(e))
        joined=sampler is None or report.get('memory_samples',{}).get('sampler_thread_joined') is True
        if joined and spawn.job is not None and spawn.job.handle is not None:
            try:report['owned_job_cleanup']=spawn.job.finish(grace_seconds=2)
            except Exception as e:errors.append('owned job cleanup: '+repr(e))
        elif not joined:errors.append('Sampler still active: owned job handle deliberately not closed')
        report['owned_worker_exit_code']=process.poll()
        for thread in threads:thread.join(2)
        report['owned_call_threads_joined']=not any(t.is_alive() for t in threads)
        if not report['owned_call_threads_joined']:errors.append('Owned request thread did not end')
        if worker is not None:
            worker.reader.join(2);report['owned_pipe_reader_joined']=not worker.reader.is_alive()
            if report['owned_pipe_reader_joined']:process.stdout.close()
            else:errors.append('Owned pipe reader did not end')
            worker.stderr.close()
    report['cleanup_errors']=errors
    report['all_owned_processes_reaped']=process is None or (process.poll() is not None and
        report.get('owned_job_cleanup',{}).get('active_after_cleanup')==0)
    report['normal_owned_cleanup']=report['all_owned_processes_reaped'] and not errors and (
        process is None or process.returncode==0) and not report.get('owned_job_cleanup',{}).get('forced_tree_termination')
    return report


def run(args):
    if os.name!='nt':raise RuntimeError('Actual Windows owned process required')
    integration=load('_memory14_integration',ROOT/'tools/research/source14_integration.py')
    owner=integration.module('_memory14_job',ROOT/'tools/windows_nvda_settings_keyboard_probe.py',integration.OWNERSHIP_HELPER_BLOB)
    harness=integration.module('_memory14_pipe',ROOT/'tools/windows_engine_probe.py',integration.ENGINE_HELPER_BLOB)
    if args.work.exists():raise FileExistsError('Fresh owned memory work required')
    args.work.mkdir();stage=args.work/'actual14-hardlink-stage'
    report={'format':'dordiai-local-core14-owned-worker-memory','format_version':1,'status':'preparing',
            'controller_sha256':digest(Path(__file__)),'sampler_sha256':digest(ROOT/'tools/windows_owned_memory.py'),
            'archive_sha256':ARCHIVE_SHA,'archive_bytes':ARCHIVE_BYTES,'phases':[],'physical_audio_verified':False,
            'acoustic_latency_verified':False,'product_ready':False,'performance_benchmark':False,
            'scope':'Actual14 worker parent RAM and parent/job COMMIT under affinity2; children/family RSS unknown. No installed NVDA or playback.'}
    spawn=None;worker=None;threads=[];original=harness.subprocess
    try:
        manifest,preparation=prepare_stage(args.archive,args.baseline,stage,integration);report['preparation']=preparation
        report['before_worker_payload_verification']=verify_stage(stage,manifest)
        spawn=OwnedSpawn(stage/'kx47Runtime/python/python.exe',owner);harness.subprocess=spawn
        deadline=time.monotonic()+150;started=time.monotonic_ns();worker=harness.PipeWorker(stage/'kx47Runtime',args.work/'worker-stderr.log')
        report.update(status='running',owned_worker_pid=worker.process.pid,affinity=spawn.affinity,
                      private_python=worker.command[0],constructor_preload='mixed, unchanged; first EN/RU requests may already be preloaded')
        cases=[('cold-session-first-uk','uk'),('first-en-in-same-session','en'),('first-ru-in-same-session','ru'),
               ('prepared-uk','uk'),('prepared-en','en'),('prepared-ru','ru'),('cancel-uk','uk'),('post-cancel-recovery-uk','uk')]
        for label,language in cases:
            phase={'name':label,'language':language,'started_ns':started if not report['phases'] else time.monotonic_ns()}
            report['phases'].append(phase)
            request=harness.make_request(language,'adam',harness.SAMPLES[language])
            def work():
                if label=='cancel-uk':
                    request['text']=(harness.SAMPLES['uk']+' ')*12
                    return worker.cancel_request(request,45,30)
                pcm,facts=worker.render(request,45)
                return {'pcm_sha256':sha256(pcm).hexdigest(),'pcm_bytes':len(pcm),'audio':facts['audio'],
                        'renderers':facts['renderers'],'loading_stages':facts['loading_stages']}
            phase['worker_result']=guarded_call(work,spawn,deadline,threads)
            count=spawn.sampler.report()['sample_count']
            if count<600:spawn.sampler.wait_for_samples(count+1,timeout=2)
            phase['finished_ns']=time.monotonic_ns()
            integration.write_json(args.work/'partial-memory-probe.json',report)
        report['status']='completed-software-memory-observation'
    except BaseException as error:
        report.update(status='blocked-memory-pressure' if isinstance(error,MemoryError) else 'failed',error=type(error).__name__+': '+str(error))
        if worker is not None:
            try:worker.send({'mode':'cancel'})
            except Exception as e:report['cancel_on_abort_error']=repr(e)
    finally:
        harness.subprocess=original
        cleanup=cleanup_owned(spawn,worker,threads);report.update(cleanup)
        if spawn is not None and not cleanup.get('normal_owned_cleanup'):report['status']='failed-owned-process-cleanup'
        if stage.exists() and 'before_worker_payload_verification' in report and cleanup.get('all_owned_processes_reaped'):
            try:
                report['after_worker_payload_verification']=verify_stage(stage,manifest)
                integration._remove_owned_tree(stage,args.work)
                report['own_hardlink_stage_removed_after_reaping']=True
            except Exception as e:report.update(status='failed-postrun-payload-verification',verification_error=repr(e))
        memory=report.get('memory_samples',{})
        for phase in report['phases']:
            if phase.get('finished_ns'):phase['memory']=phase_summary(memory,phase)
        if memory.get('status')=='failed':report['status']='failed-memory-sampling'
        raw=json.dumps(report,ensure_ascii=False,indent=2).encode()+b'\n';packed=gzip.compress(raw,mtime=0)
        args.raw_gzip.parent.mkdir(parents=True,exist_ok=True);args.raw_gzip.write_bytes(packed)
        compact={k:v for k,v in report.items() if k not in {'memory_samples','available_physical_samples'}}
        compact['raw_gzip']={'path':str(args.raw_gzip),'bytes':len(packed),'sha256':sha256(packed).hexdigest()}
        compact['parent_ram_bytes']=memory.get('parent_ram_bytes');compact['parent_commit_bytes']=memory.get('parent_commit_bytes')
        compact['owned_job_commit_bytes']=memory.get('owned_job_commit_bytes');compact['family_resident_ram_bytes']=None
        compact['memory_semantics']=memory.get('semantics')
        compact['sampler']={k:memory.get(k) for k in ('sample_count','max_samples','sample_quota_reached','sampler_thread_joined','handles_observed_held_at_stop')}
        values=[r['available_physical_bytes'] for r in report.get('available_physical_samples',[])]
        compact['minimum_observed_available_physical_bytes']=min(values) if values else None
        integration.write_json(args.report,compact)
    return 0 if report['status']=='completed-software-memory-observation' else 1


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('archive','baseline','work','report','raw-gzip'):p.add_argument('--'+name,type=Path,required=True)
    return run(p.parse_args())


if __name__=='__main__':raise SystemExit(main())
