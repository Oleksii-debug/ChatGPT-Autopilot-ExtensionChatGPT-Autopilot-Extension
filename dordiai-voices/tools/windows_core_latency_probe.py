"""Isolated packaged Holos stage/window measurements, never a latency acceptance gate.

Runs the embedded interpreter and actual selected profile offline. Only in-memory
session observers and the documented chunk_frames argument vary; installed code,
live NVDA, models and voice banks are never edited. No audio device is opened.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


PHRASES = (
    "Виберіть наступний доступний документ.",
    "Синій перемикач розташований біля правого краю вікна.",
    "Збережені налаштування залишаються доступними після повторного запуску програми, "
    "а вибрана основна мова визначає вимову повідомлень і коротких слів під час "
    "переміщення між елементами інтерфейсу за допомогою клавіатури.",
)
FILES = (
    "dordiai-release.json", "kx47Runtime/nvda_worker.py",
    "kx47Runtime/ukrainian_voices.py", "kx47Runtime/ukrainian_stress.py",
    "kx47Runtime/python/Lib/site-packages/holos_onnx/inference.py",
)


def snapshot(package):
    return {name: hashlib.sha256((package / name).read_bytes()).hexdigest() for name in FILES}


def schedule(frames, repeats, phrase_count):
    # Rotate order to avoid always giving the last choice a warmed CPU/cache.
    return [(repeat, phrase, frames[(offset + repeat + phrase) % len(frames)])
            for repeat in range(repeats) for phrase in range(phrase_count)
            for offset in range(len(frames))]


@contextmanager
def owned_priority_scope(kernel, handles, target):
    """Only NORMAL/BELOW_NORMAL on already owned handles; restore on all exits."""
    if target not in (0x20, 0x4000):
        raise ValueError('Only NORMAL and BELOW_NORMAL are permitted')
    originals = []
    try:
        for handle in handles:
            previous = kernel.GetPriorityClass(handle)
            if previous not in (0x20, 0x4000):
                raise RuntimeError('Unexpected priority on owned process')
            originals.append((handle, previous))
            if not kernel.SetPriorityClass(handle, target):
                raise RuntimeError('Cannot set owned process priority')
        yield
    finally:
        failures=[]
        for handle, previous in reversed(originals):
            if not kernel.SetPriorityClass(handle, previous):
                failures.append(handle)
        if failures:
            raise RuntimeError('Cannot restore owned process priority on %d handle(s)' % len(failures))


CHILD = r'''
import hashlib, json, sys, time, wave
from pathlib import Path
boot = time.perf_counter()
root = Path(sys.argv[1]); sys.path.insert(0, str(root / 'kx47Runtime'))
from windows_runtime import reset_inherited_dll_directory, configure_worker_import_paths
bootstrap = reset_inherited_dll_directory(); bootstrap['paths'] = configure_worker_import_paths()
import numpy as np
import onnxruntime as ort
ort.disable_telemetry_events()
from ukrainian_voices import UkrainianVoices
from ukrainian_stress import accent_text
imports_ms = (time.perf_counter() - boot) * 1000
config = json.loads(sys.argv[2])
voice = UkrainianVoices(root/'kx47Runtime/models', root/'kx47Runtime/models/voices', threads=4)
stages = []
def measure(name, fn):
    start=time.perf_counter(); result=fn()
    stages.append({'stage':name, 'duration_ms':(time.perf_counter()-start)*1000})
    return result
# This is the exact uk setup portion of nvda_worker's runtimeOnly preload;
# unlike the direct-worker smoke run it separates loading from synthesis.
model = measure('load_holos', lambda:voice.holos)
measure('warm_stress', lambda:accent_text('Готово.'))
calls=[]
class Observer:
    def __init__(self, inner, name): self.inner,self.name=inner,name
    def __getattr__(self, name): return getattr(self.inner,name)
    def run(self, outputs, inputs, *args, **kwargs):
        start=time.perf_counter()
        try: return self.inner.run(outputs,inputs,*args,**kwargs)
        finally:
            calls.append({'stage':self.name,'start_ms':(start-request_start)*1000,
                          'duration_ms':(time.perf_counter()-start)*1000,
                          'input_shapes':{key:list(value.shape) for key,value in inputs.items()
                                          if hasattr(value,'shape')}})
for name in ('encoder_session','prosody_session','source_session','decoder_session'):
    setattr(model,name,Observer(getattr(model,name),name))
original=model.stream
result=[]; signals=[]
for repeat,phrase_index,frames in config['schedule']:
    # Only the existing documented window-size argument changes. Text, identity,
    # sessions, prosody, gain and model speed are exactly the packaged pipeline.
    def stream(*args, **kwargs):
        kwargs['chunk_frames']=frames
        return original(*args,**kwargs)
    model.stream=stream; calls.clear()
    request_start=time.perf_counter(); first=None; speech=None; audio=[]
    for block in voice.chunks(config['profile'],'uk',config['phrases'][phrase_index],1.0):
        now=(time.perf_counter()-request_start)*1000
        if block.size:
            if first is None:first=now
            if speech is None and np.max(np.abs(block))>=.007:speech=now
            audio.append(block)
    completed=(time.perf_counter()-request_start)*1000
    joined=np.concatenate(audio) if audio else np.zeros(0,np.float32)
    if not joined.size or not np.isfinite(joined).all() or not np.any(joined):
        raise RuntimeError('Actual model produced invalid/silent audio')
    pcm=np.rint(np.clip(joined,-1,1)*32767).astype('<i2').tobytes()
    audio_file=Path(config['audio_output'])/('r%d-p%d-c%d.wav'%(repeat,phrase_index,frames))
    with wave.open(str(audio_file),'wb') as output:
        output.setparams((1,2,24000,0,'NONE','not compressed')); output.writeframes(pcm)
    signals.append(joined)
    result.append({'repeat':repeat,'phrase':phrase_index,'chunk_frames':frames,
                   'first_pcm_ms':first,'first_nonsilent_block_ms':speech,'completed_ms':completed,
                   'frames':int(joined.size),'audio_seconds':joined.size/24000,
                   'peak':float(np.max(np.abs(joined))),'stage_calls':list(calls),
                   'pcm_sha256':hashlib.sha256(pcm).hexdigest(),'audio_file':str(audio_file)})
for index, run in enumerate(result):
    baseline=next(i for i,r in enumerate(result) if r['phrase']==run['phrase'] and r['chunk_frames']==40)
    reference=signals[baseline]; actual=signals[index]; n=min(len(reference),len(actual))
    tail=min(n,2400); delta=actual[:n]-reference[:n]
    source_call=next(call for call in run['stage_calls'] if call['stage']=='source_session')
    source_frames=source_call['input_shapes']['f0'][1]//2
    trimmed=source_frames*model.samples_per_frame-len(actual)
    boundaries=[end*model.samples_per_frame-trimmed for _,end,_,_ in model._stream_windows(
        source_frames,run['chunk_frames'],model.streaming['context_frames'])]
    boundaries=[position for position in boundaries if 0<position<len(actual)]
    boundary_steps=[float(abs(actual[position]-actual[position-1])) for position in boundaries]
    # PCM differences include source-graph random excitation; compare the
    # repeated chunk40 control as well before attributing changes to windows.
    run['waveform_comparison_to_first_c40']={
        'reference_run':baseline,'length_delta_frames':len(actual)-len(reference),
        'rmse':float(np.sqrt(np.mean(delta**2))),
        'reference_rms':float(np.sqrt(np.mean(reference[:n]**2))),
        'max_abs_delta':float(np.max(np.abs(delta))),
        'last_100ms_rmse':float(np.sqrt(np.mean(delta[-tail:]**2))),
        'last_100ms_peak':float(np.max(np.abs(actual[-tail:]))),
        'maximum_sample_step':float(np.max(np.abs(np.diff(actual)))),
        'decoder_boundary_positions_pcm':boundaries,
        'maximum_decoder_boundary_sample_step':max(boundary_steps,default=0.0),
        'decoder_boundary_sample_steps':boundary_steps,
    }
print(json.dumps({'imports_ms':imports_ms,'bootstrap':bootstrap,'preload_stages':stages,
                  'sample_rate':int(model.sample_rate),'samples_per_frame':int(model.samples_per_frame),
                  'streaming':model.streaming,'runs':result}))
'''


CHILD_PRIORITY = r'''
import ctypes as ct, hashlib, importlib.util, json, subprocess, sys, time
from pathlib import Path
root=Path(sys.argv[1]); config=json.loads(sys.argv[2])
sys.path.insert(0,str(root/'kx47Runtime'))
from windows_runtime import reset_inherited_dll_directory,configure_worker_import_paths
reset_inherited_dll_directory(); configure_worker_import_paths()
import numpy as np
import onnxruntime as ort
ort.disable_telemetry_events()
from ukrainian_voices import UkrainianVoices
from native_multilingual import NativeMultilingual
from ukrainian_stress import accent_text
spec=importlib.util.spec_from_file_location('_own_latency_helpers',config['probe_file'])
helpers=importlib.util.module_from_spec(spec);spec.loader.exec_module(helpers)
k=ct.WinDLL('kernel32',use_last_error=True)
k.GetCurrentProcess.restype=ct.c_void_p
k.GetPriorityClass.argtypes=[ct.c_void_p];k.GetPriorityClass.restype=ct.c_uint32
k.SetPriorityClass.argtypes=[ct.c_void_p,ct.c_uint32];k.SetPriorityClass.restype=ct.c_int
k.GetProcessAffinityMask.argtypes=[ct.c_void_p,ct.POINTER(ct.c_size_t),ct.POINTER(ct.c_size_t)]
k.SetProcessAffinityMask.argtypes=[ct.c_void_p,ct.c_size_t]
own=k.GetCurrentProcess()
voice=UkrainianVoices(root/'kx47Runtime/models',root/'kx47Runtime/models/voices',threads=4)
native=NativeMultilingual(root/'kx47Runtime/models/PocketTTS',root/'kx47Runtime/models/voices/native_profiles',threads=3)
rows=[];burn=None;affinity_originals=[]
def run(language,text):
    return (voice.chunks(config['profile'],'uk',text,1.0) if language=='uk' else
            native.stream(config['profile'],language,text,1.0))
try:
    # Resource setup is explicit and outside the warmed-request measurements.
    voice.holos;accent_text('Готово.');native.warm_english();native.warm_russian()
    for language,text in [('uk','Перевірено.'),('en','Prepared.'),('ru','Проверено.')]:
        list(run(language,text))
    russian=native.russian.process
    handles=[own,int(russian._handle)]
    for handle in handles:
        mask=ct.c_size_t();system=ct.c_size_t()
        if not k.GetProcessAffinityMask(handle,ct.byref(mask),ct.byref(system)):
            raise ct.WinError(ct.get_last_error())
        affinity_originals.append((handle,mask.value))
    core=affinity_originals[0][1]&-affinity_originals[0][1]
    if not all(original&core for _,original in affinity_originals):
        raise RuntimeError('Owned workers do not share an allowed logical CPU')
    for handle,_ in affinity_originals:
        if not k.SetProcessAffinityMask(handle,core):raise ct.WinError(ct.get_last_error())
    # One synthetic competitor on one owned test logical CPU, bounded at 150s.
    # It never changes global scheduling, another program or live NVDA.
    burn=subprocess.Popen([sys.executable,'-I','-B','-c',
        'import time;end=time.monotonic()+150\nwhile time.monotonic()<end:\n'
        ' until=time.monotonic()+.012\n while time.monotonic()<until: pass\n time.sleep(.008)'],
        creationflags=subprocess.CREATE_NO_WINDOW|subprocess.NORMAL_PRIORITY_CLASS)
    if not k.SetProcessAffinityMask(int(burn._handle),core):raise ct.WinError(ct.get_last_error())
    for round_index in range(4):
        order=(0x4000,0x20) if round_index%2==0 else (0x20,0x4000)
        for language,text in [('uk','Наступне вікно готове до роботи.'),
                              ('en','The next window is ready for work.'),
                              ('ru','Следующее окно готово к работе.')]:
            for priority in order:
                load_active_before=burn.poll() is None
                with helpers.owned_priority_scope(k,handles,priority):
                    start=time.perf_counter();first=None;pieces=[]
                    for block in run(language,text):
                        if block.size:
                            if first is None:first=(time.perf_counter()-start)*1000
                            pieces.append(block)
                    elapsed=(time.perf_counter()-start)*1000
                joined=np.concatenate(pieces)
                pcm=np.rint(np.clip(joined,-1,1)*32767).astype('<i2').tobytes()
                rows.append({'round':round_index,'language':language,'priority':priority,
                    'first_pcm_ms':first,'completed_ms':elapsed,'frames':int(joined.size),
                    'pcm_sha256':hashlib.sha256(pcm).hexdigest(),
                    'synthetic_load_active_before':load_active_before,
                    'synthetic_load_active_after':burn.poll() is None})
    print(json.dumps({'synthetic_cpu_load':True,'logical_cpu_affinity_mask':core,
        'comparison_scope':'both owned UK/EN process and owned RU child; one synthetic same-core competitor',
        'competitor_requested_duty_cycle':.60,'competitor_maximum_seconds':150,
        'priority_restored':[k.GetPriorityClass(handle) for handle in handles],'runs':rows}))
finally:
    if burn is not None:
        if burn.poll() is None:burn.terminate()
        burn.wait(timeout=5)
    for handle,mask in reversed(affinity_originals):k.SetProcessAffinityMask(handle,mask)
    native.close()
'''

START_GATE = r'''
import sys,time
from pathlib import Path
_owned_gate=Path(sys.argv[3]);_owned_until=time.monotonic()+10
while not _owned_gate.is_file():
    if time.monotonic()>_owned_until:raise RuntimeError('Owned process job gate was not released')
    time.sleep(.01)
'''


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--profile', default='sara_archive')
    parser.add_argument('--repeats', type=int, default=2)
    parser.add_argument('--audio-output', type=Path, required=True)
    parser.add_argument('--priority-comparison', action='store_true')
    args = parser.parse_args(argv)
    if sys.platform != 'win32':
        parser.error('Actual Windows packaged interpreter is required')
    if not 1 <= args.repeats <= 5:
        parser.error('--repeats must be between 1 and 5')
    package = args.package_root.resolve()
    catalogue = json.loads((package/'kx47Runtime/models/voices/catalog.json').read_text(encoding='utf8'))
    sys.path.insert(0, str(package/'kx47Runtime'))
    from voice_policy import require_voice_allowed
    require_voice_allowed(args.profile)
    if args.profile not in catalogue:
        parser.error('Profile is absent from actual package')
    before = snapshot(package)
    args.audio_output.mkdir(parents=True,exist_ok=True)
    probe_source = Path(__file__).read_bytes()
    pinned_probe = args.audio_output / 'probe-driver.py'
    pinned_probe.write_bytes(probe_source)
    config = {'profile': args.profile, 'phrases': PHRASES,'audio_output':str(args.audio_output.resolve()),
              'probe_file':str(pinned_probe.resolve()),
              'schedule': schedule((40,20,10),args.repeats,len(PHRASES))}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    started = datetime.now(timezone.utc).isoformat()
    # The child cannot load models or spawn descendants before assignment to
    # this kill-on-close job. No PID reopening or arbitrary process termination.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from windows_prefetch_trials import OwnedProcessJob
    job=OwnedProcessJob()
    gate=args.audio_output/('owned-start-'+uuid.uuid4().hex)
    process=None;stdout=b'';stderr=b'';run_error=None;cleanup=None
    try:
        process = subprocess.Popen([str(package/'kx47Runtime/python/python.exe'),'-I','-B','-u',
            '-c',START_GATE+(CHILD_PRIORITY if args.priority_comparison else CHILD),
            str(package),json.dumps(config,ensure_ascii=True),str(gate.resolve())],
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW,
            env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1'))
        job.assign(process)
        gate.write_bytes(b'owned')
        stdout,stderr=process.communicate(timeout=240)
    except Exception as error:
        run_error=type(error).__name__+': '+str(error)
    finally:
        cleanup=job.finish()
        if process is not None:
            stdout,stderr=process.communicate(timeout=10)
        if gate.exists():gate.unlink()
    after = snapshot(package)
    report = {'format':'dordiai-isolated-core-latency-diagnosis','format_version':1,
              'created_utc':started,'package_root':str(package),'profile':args.profile,
              'experiment':'owned-priority' if args.priority_comparison else 'decoder-windows',
              'probe_driver_sha256':hashlib.sha256(probe_source).hexdigest(),
              'probe_driver_copy':str(pinned_probe.resolve()),
              'scope':'software PCM delivery only; no NVDA or audio-output acceptance',
              'runtime_before':before,'runtime_after':after,'code_unchanged':before==after,
              'phrases':PHRASES,'exit_code':process.returncode if process is not None else None,
              'run_error':run_error,'owned_process_cleanup':cleanup,
              'stderr':stderr.decode('utf8','replace')}
    if process is not None and process.returncode == 0 and run_error is None:
        report['observations']=json.loads(stdout)
    else:
        report['stdout']=stdout.decode('utf8','replace')
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    return 0 if process is not None and process.returncode==0 and before==after and run_error is None else 1


if __name__ == '__main__':
    raise SystemExit(main())
