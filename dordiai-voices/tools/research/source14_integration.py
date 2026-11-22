"""Assemble source14 from exact source13 resources; no model/bank preparation.

Only the manifest, three reviewed runtime Python files and the exact bounded
outer64 driver keyword may differ. Real
worker/NVDA functional probes remain separate from audible acceptance.
"""
from __future__ import annotations
import argparse
import ast
from hashlib import sha1,sha256
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile
import zlib
import platform

PROJECT=Path(__file__).resolve().parents[2]
VERSION='0.13.1-dev.14'
BASE_VERSION='0.13.1-dev.13'
CORE_BYTES=1992990314
CORE_SHA256='4aed1ba48e8600dcd5f80bac9b85e5a3d7ce09b209c76a4a2873fe7b9960876d'
SOURCE13_HELPER_BLOB='92f0937a79e613efef087bb68ad5530ee01c70cd'
NVDA_HELPER_BLOB='ec3d93b5b6e3f92af70d0b989ca9e280db5a840f'
OWNERSHIP_HELPER_BLOB='1da3f64a2257ff5f60c697a66c0227e4144c357b'
ENGINE_HELPER_BLOB='0890cbf4b59747df01561350327a71a0db7226e6'
ALLOWED_CHANGES=frozenset({'manifest.ini','kx47Runtime/wide_warmup.py',
                          'kx47Runtime/nvda_worker.py','kx47Runtime/native_multilingual.py','synthDrivers/kx47Preview.py'})
DRIVER_PATH='synthDrivers/kx47Preview.py'
DRIVER13_SHA256='17eeda6106858c4eb14ede91dd2a698cae0abaa9894d3df3e3d445d374a042ee'
DRIVER13_BYTES=93785
DRIVER64_SHA256='72d4526804111d66e5786da60542e9effbb91a84a7c00a2d785e6e30bbf0acf7'
EXCLUDED=frozenset({'kostia','inna','dina','vira','innesa','veronika_classmate','anatolii','veronika'})
MODELS='kx47Runtime/models/'
PRIVATE='kx47Runtime/python/'
BANKS=('kx47Runtime/models/voices/native_letters/','kx47Runtime/models/voices/native_commands/')


def module(name,path,pin=None):
    path=Path(path);raw=path.read_bytes()
    if pin and sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()!=pin:
        raise ValueError('Frozen helper identity differs: '+path.name)
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec)
    sys.modules[name]=value;spec.loader.exec_module(value);return value


def source13():
    return module('_frozen_source13_resource_extract',PROJECT/'tools/research/source13_integration.py',SOURCE13_HELPER_BLOB)


def write_json(path,value):
    Path(path).parent.mkdir(parents=True,exist_ok=True)
    Path(path).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')


def read_pin(path):
    pin=json.loads(Path(path).read_text(encoding='utf-8'))
    if (pin.get('format')!='dordiai-source13-build-pin' or pin.get('status')!='actual-build-verified'
        or pin.get('version')!=BASE_VERSION or pin.get('archive_bytes')!=CORE_BYTES
        or pin.get('archive_sha256')!=CORE_SHA256 or pin.get('source_run_id')!=45049806570
        or pin.get('source_commit')!='2d70515a4c49413efcb23198491bbc675a55db0a'):
        raise ValueError('Completed immutable source13 pin differs')
    return pin


def check_source_version(source):
    path=Path(source)/'manifest.ini'
    if path.is_symlink() or not path.is_file() or path.stat().st_size>65536:raise ValueError('Bounded source14 manifest required')
    versions=re.findall(r'''(?m)^version\s*=\s*["']?([^"'\s]+)''',path.read_text(encoding='utf-8-sig'))
    if versions!=[VERSION]:raise ValueError('Source manifest must identify exactly source14')
    return VERSION


def verify_driver_change(original,candidate):
    """Require exact immutable13 bytes plus only the tested outer64 keyword."""
    if not isinstance(original,bytes) or len(original)!=DRIVER13_BYTES or sha256(original).hexdigest()!=DRIVER13_SHA256:
        raise ValueError('Actual immutable13 driver bytes differ')
    tree=ast.parse(original.decode('utf-8'))
    classes=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='SynthDriver']
    runs=[n for c in classes for n in c.body if isinstance(n,ast.FunctionDef) and n.name=='_run']
    if len(classes)!=1 or len(runs)!=1:raise ValueError('One original driver speech loop required')
    calls=[n for n in ast.walk(runs[0]) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='buffered_items']
    if len(calls)!=1:raise ValueError('One original outer buffered_items call required')
    outer=calls[0]
    if ([k.arg for k in outer.keywords]!=['short_reserve','cancelling_threads'] or len(outer.args)!=2
        or ast.dump(outer.args[1],include_attributes=False)!=ast.dump(ast.parse('lambda: generation != self._generation',mode='eval').body,include_attributes=False)):
        raise ValueError('Original outer generation/reserve contract differs')
    helper=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='buffered_items')
    defaults=dict(zip((n.arg for n in helper.args.kwonlyargs),helper.args.kw_defaults))
    if not isinstance(defaults.get('pending_count'),ast.Constant) or defaults['pending_count'].value!=12:
        raise ValueError('Original helper default12 differs')
    inner=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='buffered_items' and n is not outer]
    inner_counts=[k.value.value for n in inner for k in n.keywords if k.arg=='pending_count' and isinstance(k.value,ast.Constant)]
    if inner_counts!=[2]:raise ValueError('Original explicit inner2 differs')
    first=outer.keywords[0];lines=original.splitlines(keepends=True)
    position=sum(map(len,lines[:first.lineno-1]))+first.col_offset
    addition=b'pending_count=64, '
    expected=original[:position]+addition+original[position:]
    if candidate!=expected or sha256(candidate).hexdigest()!=DRIVER64_SHA256:
        raise ValueError('Driver must differ ONLY by exact outer pending_count64 insertion')
    after=ast.parse(candidate.decode('utf-8'))
    after_class=next(n for n in after.body if isinstance(n,ast.ClassDef) and n.name=='SynthDriver')
    after_run=next(n for n in after_class.body if isinstance(n,ast.FunctionDef) and n.name=='_run')
    after_call=next(n for n in ast.walk(after_run) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='buffered_items')
    added=after_call.keywords.pop(0)
    if (added.arg!='pending_count' or not isinstance(added.value,ast.Constant) or added.value.value!=64
        or ast.dump(tree,include_attributes=False)!=ast.dump(after,include_attributes=False)):
        raise ValueError('Driver AST changes outside exact outer64 keyword')
    return {'original_driver_sha256':DRIVER13_SHA256,'original_driver_bytes':len(original),
            'candidate_driver_sha256':DRIVER64_SHA256,'candidate_driver_bytes':len(candidate),
            'only_outer_keyword_ast_difference_verified':True,'all_non_insertion_bytes_identical':True,
            'outer_pending_count':64,'original_helper_default_unchanged':12,'explicit_inner_counts_unchanged':[2],
            'generation_and_cancellation_unchanged':True,'first_ready_delivery_helper_ast_unchanged':True,
            'startup_reserve_or_word_warmup_added':False,'maximum_outer_queued_pcm_bytes':30720,
            'candidate_evidence_run':45064826804,'candidate_selection_scope':'Bounded headroom candidate; not a proven optimum or source14 acceptance',
            'source14_waveform_or_cancel_acceptance_proved':False}


def verify_preservation(old,new):
    """No extra/missing payload or modified acoustic/private bytes accepted."""
    if old.get('version')!=BASE_VERSION or new.get('version')!=VERSION:raise ValueError('Wrong baseline/output version')
    voices=old.get('voice_ids',[])
    if (len(voices)!=45 or len(set(voices))!=45 or set(voices)&EXCLUDED
        or len(new.get('voice_ids',[]))!=45 or set(new['voice_ids'])!=set(voices)
        or set(old.get('excluded_voice_ids',[]))!=EXCLUDED or set(new.get('excluded_voice_ids',[]))!=EXCLUDED):
        raise ValueError('Exact45 allowed voices/exclusions changed')
    before,after=old.get('files'),new.get('files')
    if not isinstance(before,dict) or not isinstance(after,dict) or set(before)!=set(after):
        raise ValueError('Extra or missing source14 payload')
    changed={name for name,row in before.items() if after[name]!=row}
    if changed!=ALLOWED_CHANGES:raise ValueError('Only manifest+three runtime files+exact outer64 driver may differ: '+repr(sorted(changed)))
    if (before.get(DRIVER_PATH)!={'size_bytes':DRIVER13_BYTES,'sha256':DRIVER13_SHA256}
        or after.get(DRIVER_PATH)!={'size_bytes':DRIVER13_BYTES+18,'sha256':DRIVER64_SHA256}):
        raise ValueError('Exact original13/tested outer64 driver identities differ')
    counts={}
    for label,prefix,expected in [('model_identity',MODELS,8511),('prepared_bank',BANKS,180),('private_runtime',PRIVATE,1596)]:
        names=[name for name in before if name.startswith(prefix)]
        if len(names)!=expected or any(after[name]!=before[name] for name in names):
            raise ValueError('Exact source13 '+label+' bytes/count changed')
        counts[label+'_files_byte_identical']=len(names)
    return dict(changed_files=sorted(changed),all_other_payload_files_byte_identical=len(before)-len(changed),
                exact_payload_set_unchanged=True,allowed45_voice_ids_unchanged=True,excluded_ids_unchanged=True,**counts)


def source_provenance(source,builder):
    paths=builder._source_files(Path(source))
    inputs={name:{'size_bytes':path.stat().st_size,'sha256':sha256(path.read_bytes()).hexdigest()} for name,path in paths.items()}
    tool_paths=(Path(__file__).resolve(),PROJECT/'tools/build_release.py',PROJECT/'tools/verify_release.py',
                PROJECT/'tools/research/source13_integration.py',PROJECT/'tools/vendor/stressonnx-download-original.txt',
                PROJECT/'tools/vendor/NOTICE-stressonnx.txt')
    tools={str(path.relative_to(PROJECT)):{'size_bytes':path.stat().st_size,'sha256':sha256(path.read_bytes()).hexdigest()}
           for path in tool_paths}
    def git(*args):
        result=subprocess.run(['git',*args],cwd=PROJECT,capture_output=True,text=True,encoding='utf-8',check=True)
        return result.stdout.strip()
    try:
        head=git('rev-parse','HEAD')
        status=git('status','--porcelain','--',str(Path(source).resolve()),*(str(path) for path in tool_paths))
    except (OSError,subprocess.CalledProcessError):head=None;status='git provenance unavailable'
    expected=os.environ.get('GITHUB_SHA')
    if expected and head!=expected:raise ValueError('Actual checkout HEAD differs from CI source commit')
    clean=bool(head) and not status
    snapshot={'source_files':inputs,'build_tools':tools}
    return {'source_commit':head if clean else None,'source_tree_base_commit':head,
            'source_inputs_committed_and_clean':clean,'uncommitted_status':status,
            'actual_source_snapshot_sha256':sha256(json.dumps(snapshot,sort_keys=True,separators=(',',':')).encode()).hexdigest(),**snapshot}


def verify_source_overlay(builder,source,empty,old):
    """Use the builder's deterministic normalization before comparing payload."""
    empty.mkdir()
    files,excluded=builder.collect_inputs(empty,source,version=VERSION)
    if excluded:raise ValueError('Excluded voice input must not enter source14 assembly')
    changed=set()
    for item in files:
        if item.path not in old['files']:raise ValueError('New source payload: '+item.path)
        raw=item.transformed if item.transformed is not None else item.source.read_bytes()
        row={'size_bytes':len(raw),'sha256':sha256(raw).hexdigest()}
        if row!=old['files'][item.path]:changed.add(item.path)
    if changed!=ALLOWED_CHANGES:raise ValueError('Unreviewed source overlay changes: '+repr(sorted(changed)))
    return sorted(changed)


def _new_directory(path):
    path=Path(path).absolute()
    if path.exists() or path.is_symlink():raise FileExistsError('Fresh owned output required: '+str(path))
    for parent in path.parents:
        if parent.is_symlink() or parent.exists() and getattr(parent.stat(),'st_file_attributes',0)&1024:
            raise ValueError('Reparse point in owned output ancestry')
    path.mkdir(parents=True);return path.resolve()


def _remove_owned_tree(path,root):
    path=Path(path);root=Path(root).resolve()
    if path.is_symlink() or path.resolve()==root or not path.resolve().is_relative_to(root):
        raise ValueError('Owned deletion boundary differs')
    for child in path.rglob('*'):
        if child.is_symlink() or getattr(child.lstat(),'st_file_attributes',0)&1024:raise ValueError('Reparse point in owned cleanup')
    shutil.rmtree(path)


def build(args):
    check_source_version(args.source);pin=read_pin(args.pin);frozen=source13()
    frozen.pinned(args.baseline_addon,CORE_BYTES,CORE_SHA256)
    sys.path.insert(0,str(PROJECT/'tools'))
    builder=module('_source14_generic_builder',PROJECT/'tools/build_release.py')
    if builder.VERSION!=VERSION:raise ValueError('Generic builder version is not explicit14')
    provenance=source_provenance(args.source,builder)
    if any(Path(path).resolve().is_relative_to(args.source.resolve()) for path in (args.work,args.output)):
        raise ValueError('Assembly output must remain outside source inputs')
    if args.output.exists() or args.output.is_symlink():raise FileExistsError('New source14 artifact destination required')
    work=_new_directory(args.work)
    baseline=work/'immutable-core13-resources'
    old=frozen.extract_release(args.baseline_addon,baseline,omit_generated_manifest=True)
    if old.get('version')!=BASE_VERSION:raise ValueError('Wrong source13 inventory version')
    driver_change=verify_driver_change((baseline/DRIVER_PATH).read_bytes(),(args.source/DRIVER_PATH).read_bytes())
    overlay_changes=verify_source_overlay(builder,args.source,work/'empty-source-validation',old)
    result=builder.build_release(baseline,args.source,args.output,version=VERSION,only=['core'])
    artifact=next(row for row in result['artifacts'] if row['group']=='core')
    addon=args.output/artifact['filename']
    verifier=module('_source14_archive_verifier',PROJECT/'tools/verify_release.py')
    verified=verifier.verify_archive(addon)
    with zipfile.ZipFile(addon) as z:new=json.loads(z.read('dordiai-release.json'))
    preservation=verify_preservation(old,new)
    after=source_provenance(args.source,builder)
    if after!=provenance:raise ValueError('Source inputs changed during assembly')
    proof={'format':'dordiai-source14-integration-build','format_version':1,
           'status':'actual-source14-built-from-immutable-source13','version':VERSION,'artifact':artifact,
           'resource_baseline':pin,'source_provenance':provenance,'source_overlay_changed_files':overlay_changes,
           'preservation':preservation,'archive_verification':verified,'generated_old_inventory_omitted':True,
           'bounded_driver_candidate':driver_change,
           'build_environment':{'python_full_version':sys.version,'python_executable':sys.executable,
                                'platform':platform.platform(),'zlib_compile_version':zlib.ZLIB_VERSION,
                                'zlib_runtime_version':zlib.ZLIB_RUNTIME_VERSION},
           'source13_extractor_git_blob':SOURCE13_HELPER_BLOB,'model_download_performed':False,
           'acoustic_model_preparation_performed':False,'bank_regeneration_performed':False,
           'nvda_verified':False,'physical_audio_verified':False,'acoustic_latency_verified':False,'product_ready':False}
    write_json(args.report,proof)
    # Remove only the newly created resource extraction after full proof exists.
    if baseline.resolve().parent!=work or baseline.is_symlink():raise ValueError('Owned cleanup boundary differs')
    _remove_owned_tree(baseline,work)
    return proof


def validate_nvda_functional(controller,*,typing,addon_sha256):
    probe=controller.get('probe',{})
    if (controller.get('addon_sha256')!=addon_sha256 or controller.get('recording_pcm_sink_test_double') is not True
        or probe.get('recording_pcm_sink_test_double') is not True):
        raise ValueError('Exact14 package or explicit headless mode differs')
    if probe.get('nvda_version_actual')!='2026.3.1':raise ValueError('Actual official NVDA version differs')
    if controller.get('status') not in {'passed','partial'} or probe.get('status') not in {'passed','partial'}:
        raise ValueError('Actual NVDA functional probe failed')
    all_checks=list(controller.get('checks',[]))+list(probe.get('checks',[]))
    checks={r['name']:r for r in probe.get('checks',[])}
    required={'select_dordiai','allowed_voice_catalog','fresh_default_languages'}
    required|={'actual_typing_keyboard_pipeline','actual_typing_language_routes','actual_typing_cleanup'} if typing else {
        'settings_dialog','settings_hotkey_binding','keyboard_tab','keyboard_checkbox_space','phrase_pcm_submission','character_pcm_submission'}
    if any(checks.get(name,{}).get('status')!='passed' for name in required):raise ValueError('Required same14 NVDA functional check missing/failed')
    allowed_blocked={'windows_audio_output_enumeration','physical_audio_output','warm_letter_predevice_target','cancel_api_target'}
    if any(r.get('status')!='passed' and not (r.get('status')=='blocked' and r.get('name') in allowed_blocked) for r in all_checks):
        raise ValueError('Unexpected failed/blocked same14 NVDA integration check')
    for receipt in (controller,probe):
        if any(receipt.get(flag) is not False for flag in ('physical_audio_verified','acoustic_latency_verified','product_ready')):
            raise ValueError('Headless functional evidence cannot claim acoustic/product acceptance')
    return {'required_functional_checks':sorted(required),'open_checks':[r for r in checks.values() if r.get('status')!='passed'],
            'scope':'Actual isolated Windows/NVDA functions with labeled RecordingSink, not physical sound/latency acceptance'}


class OwnedWorkerProcesses:
    """Enroll only the exact packaged worker before its first instruction."""
    def __init__(self,executable,job_factory):
        self.executable=Path(executable).resolve();self.job_factory=job_factory;self.children=[]
    def __getattr__(self,name):return getattr(subprocess,name)
    def Popen(self,command,*args,**kwargs):
        if Path(command[0]).resolve()!=self.executable:raise ValueError('Unexpected worker executable')
        job=self.job_factory();kwargs['creationflags']=kwargs.get('creationflags',0)|4
        try:process=subprocess.Popen(command,*args,**kwargs)
        except BaseException:job.finish(grace_seconds=0);raise
        self.children.append((process,job))
        try:job.assign_and_resume(process)
        except BaseException:
            try:process.kill();process.wait(timeout=20)
            finally:job.finish(grace_seconds=0)
            raise
        return process
    def reap(self):
        rows=[];errors=[]
        for process,job in self.children:
            try:
                if job.handle is None:raise RuntimeError('Packaged worker job failed before normal cleanup')
                row=job.finish();process.wait(timeout=20)
                rows.append(dict(pid=process.pid,returncode=process.returncode,**row))
                if row['forced_tree_termination'] or process.returncode!=0:errors.append('Owned worker did not exit normally')
            except Exception as error:errors.append(type(error).__name__+': '+str(error))
        return {'jobs':rows,'errors':errors,'all_owned_workers_reaped':len(rows)==len(self.children) and bool(rows)
                and all(row['active_after_cleanup']==0 for row in rows),'normal_shutdown_verified':bool(rows) and not errors}


def worker(args):
    if os.name!='nt' or not args.ephemeral_ci or os.environ.get('GITHUB_ACTIONS')!='true':
        raise ValueError('Packaged worker integration requires owned ephemeral Windows CI')
    proof=json.loads(args.build_report.read_text(encoding='utf-8'));artifact=proof['artifact'];frozen=source13()
    if proof.get('version')!=VERSION:raise ValueError('Exact source14 build proof required')
    frozen.pinned(args.addon,artifact['size_bytes'],artifact['sha256'])
    work=_new_directory(args.work);package=work/'assembled-source14';manifest=frozen.extract_release(args.addon,package)
    if manifest.get('version')!=VERSION:raise ValueError('Assembled worker package version differs')
    ownership=module('_source14_worker_jobs',PROJECT/'tools/windows_nvda_settings_keyboard_probe.py',OWNERSHIP_HELPER_BLOB)
    harness=module('_source14_engine_probe',PROJECT/'tools/windows_engine_probe.py',ENGINE_HELPER_BLOB)
    owner=OwnedWorkerProcesses(package/'kx47Runtime/python/python.exe',ownership.OwnedNvdaJob)
    original=harness.subprocess;harness.subprocess=owner
    report={'format':'dordiai-source14-default-worker-functional','version':VERSION,'status':'running',
            'addon_sha256':artifact['sha256'],'source_provenance':proof['source_provenance'],
            'physical_audio_verified':False,'acoustic_latency_verified':False,'product_ready':False}
    try:
        output=args.report.parent/'default-engines'
        code=harness.main(['--package-root',str(package),'--output',str(output),'--languages','uk,en,ru',
                           '--repetitions','1','--timeout',str(min(args.timeout,120))])
        report['worker_report']=json.loads((output/'report.json').read_text(encoding='utf-8'));report['worker_returncode']=code
        if code!=0 or report['worker_report'].get('status')!='passed':raise ValueError('Same14 packaged default worker regression failed')
        report['status']='passed-pipe-functional-only'
    except Exception as error:report.update(status='failed',error=type(error).__name__+': '+str(error));raise
    finally:
        harness.subprocess=original;report['owned_worker_cleanup']=owner.reap()
        if not report['owned_worker_cleanup']['normal_shutdown_verified']:report['status']='failed'
        write_json(args.report,report)
    if report['status']=='failed':raise RuntimeError('Owned source14 worker cleanup failed')
    _remove_owned_tree(package,work)
    report['large_owned_payload_removed_after_job_cleanup']=True;write_json(args.report,report)
    return report


def nvda(args):
    if os.name!='nt' or not args.ephemeral_ci or os.environ.get('GITHUB_ACTIONS')!='true':
        raise ValueError('Only owned ephemeral Windows CI may launch this NVDA integration')
    proof=json.loads(args.build_report.read_text(encoding='utf-8'));artifact=proof['artifact']
    frozen=source13();frozen.pinned(args.addon,artifact['size_bytes'],artifact['sha256'])
    if proof.get('version')!=VERSION:raise ValueError('Actual build14 proof required')
    sys.path.insert(0,str(PROJECT/'tools'))
    base=module('_source14_owned_nvda',PROJECT/'tools/windows_nvda_probe.py',NVDA_HELPER_BLOB)
    ownership=module('_source14_held_jobs',PROJECT/'tools/windows_nvda_settings_keyboard_probe.py',OWNERSHIP_HELPER_BLOB)
    output=_new_directory(args.work);report={'format':'dordiai-source14-nvda-functional','version':VERSION,'status':'running',
        'addon_sha256':artifact['sha256'],'source_provenance':proof['source_provenance'],'phases':[],
        'recording_pcm_sink_test_double':True,'physical_audio_verified':False,'acoustic_latency_verified':False,'product_ready':False}
    try:
        for typing in (False,True):
            phase=output/('typing' if typing else 'core-menus');observed=ownership.OwnedProcesses(subprocess)
            original=base.subprocess;base.subprocess=observed
            row={'typing':typing,'status':'running'};report['phases'].append(row)
            try:
                command=['--addon',str(args.addon),'--output',str(phase),'--headless-ui-probe','--long-installed-config',
                         '--timeout',str(args.timeout),'--installer-cache',str(args.installer_cache)]
                if typing:command+=['--typing-probe','--typing-scenario','standard']
                code=base.main(command)
                value=json.loads((phase/'windows-nvda-probe.json').read_text(encoding='utf-8'))
                row.update(controller=value,controller_returncode=code)
                if code not in {0,2}:raise ValueError('Actual14 NVDA controller returned a failure')
                row['functional']=validate_nvda_functional(value,typing=typing,addon_sha256=artifact['sha256'])
                row['status']='passed-functional-only'
            finally:
                try:observed.reap(base,row)
                finally:base.subprocess=original;write_json(args.report,report)
            if any(p['returncode']!=0 for p in row['owned_process_cleanup']['children']):raise RuntimeError('Owned NVDA process did not exit normally')
            run=Path(value['run_directory']).resolve()
            if run.parent!=phase.resolve() or not run.name.startswith('nvda-probe-'):raise ValueError('Owned NVDA run identity differs')
            evidence=args.report.parent/('nvda-typing' if typing else 'nvda-core-menus');evidence.mkdir()
            for path in [phase/'windows-nvda-probe.json',*run.glob('*.log'),*run.glob('*.wav'),run/'nvda-probe.json']:
                if not path.is_file():continue
                if path.is_symlink() or path.stat().st_size>32*1024**2:raise ValueError('Unbounded owned NVDA evidence')
                shutil.copyfile(path,evidence/path.name)
            for payload in (run/'portable',Path(value['config_directory'])):_remove_owned_tree(payload,run)
            row['large_owned_payload_removed_after_job_cleanup']=True
        report['status']='passed-functional-only'
        return report
    except Exception as error:
        report.update(status='failed',error=type(error).__name__+': '+str(error));raise
    finally:write_json(args.report,report)


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('phase',choices=('build','worker','nvda'))
    p.add_argument('--source',type=Path,default=PROJECT/'source/0.12.2')
    p.add_argument('--pin',type=Path,default=PROJECT/'tools/data/source13_build_pin.json')
    p.add_argument('--baseline-addon',type=Path);p.add_argument('--output',type=Path)
    p.add_argument('--work',required=True,type=Path);p.add_argument('--report',required=True,type=Path)
    p.add_argument('--addon',type=Path);p.add_argument('--build-report',type=Path);p.add_argument('--installer-cache',type=Path)
    p.add_argument('--timeout',type=float,default=1200);p.add_argument('--ephemeral-ci',action='store_true')
    args=p.parse_args(argv)
    if args.phase=='build' and (args.baseline_addon is None or args.output is None):p.error('Build needs exact baseline and fresh output')
    if args.phase in {'worker','nvda'} and any(v is None for v in (args.addon,args.build_report)):p.error('Probe needs exact14 addon/build proof')
    if args.phase=='nvda' and args.installer_cache is None:p.error('NVDA needs pinned installer cache')
    if not 60<=args.timeout<=1800:p.error('Bounded timeout60..1800 required')
    value={'build':build,'worker':worker,'nvda':nvda}[args.phase](args)
    print(json.dumps({'status':value['status'],'version':VERSION,'product_ready':False}),flush=True);return 0


if __name__=='__main__':raise SystemExit(main())
