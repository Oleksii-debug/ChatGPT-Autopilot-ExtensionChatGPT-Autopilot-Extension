"""Actual 2name x2profile OPTIONAL bank feasibility; no production source edits.

All45x29 entries are planned from exact allowed catalogue/targets. Only2x2
render initially. New PCM/index files live outside original core. They use the
existing wide-navigation key schema and an experimental source-identity gate.
The result is NONINSTALLABLE until future14 integration reviews this gate.
"""
from __future__ import annotations
import argparse
import ast
from functools import lru_cache
import gc
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
from time import perf_counter,perf_counter_ns
from types import SimpleNamespace
from unicodedata import normalize
from unittest.mock import patch

HERE=Path(__file__).resolve().parent

def load(name,path):
    import importlib.util
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m

ar=load('_ar_bank_original_probe',HERE/'probe_ar_ordinary_names.py')
bank=load('_ar_bank_recipe',HERE/'ar_name_bank_recipe.py')


def driver_slice(runtime):
    """Execute exact AST methods, not a replacement method or full NVDA host."""
    import voice_assets,voice_policy,wide_languages,host_paths
    raw=(runtime.parent/'synthDrivers/kx47Preview.py').read_bytes();tree=ast.parse(raw.decode('utf-8'))
    wanted={'fast_clip','_assert_resource_epoch','_checked_prepared_clip','_control_prepared_clip'}
    original=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='SpeechWorker')
    methods=[n for n in original.body if isinstance(n,ast.FunctionDef) and n.name in wanted]
    if {n.name for n in methods}!=wanted:raise ValueError('Original prepared driver method set differs')
    functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'_package_file_signature','_resource_epoch'}]
    scope={'Path':Path,'RUNTIME':runtime,'_host_paths':host_paths,'_voice_policy':voice_policy,'_wide':wide_languages,'normalize':normalize,'_runtime_module':lambda name:voice_assets if name=='voice_assets' else __import__(name)}
    cls=ast.ClassDef(name='ActualPreparedSlice',bases=[],keywords=[],body=methods,decorator_list=[],type_params=[])
    exec(compile(ast.fix_missing_locations(ast.Module(body=[*functions,cls],type_ignores=[])),'<exact-core12-prepared-methods>','exec'),scope)
    return scope['ActualPreparedSlice'],scope['_resource_epoch'],ar.sha256(raw).hexdigest()


def lookup_proof(runtime,output,records,targets,np):
    from synthDrivers._dordiai_letter_bank import NativeLetterBank
    actual,epoch,source_sha=driver_slice(runtime)
    references=output/'lookup-view/models/voices';references.mkdir(parents=True)
    directory=output/'banks/ar'
    reader=NativeLetterBank(directory.parent,'ar')
    bound=bank.BoundReader(reader,directory,records,lambda profile:targets[profile])
    worker=actual();worker._references=references;worker._retired=False;worker._resource_epoch=epoch(references)
    worker._wideNavigation={'ar':bound};worker._letterBank=NativeLetterBank(references)
    worker._commandBank=NativeLetterBank(references,'native_commands');worker._cached_clip=lambda request:None
    timings=[];lookups=[]
    import onnxruntime as ort
    with patch.object(ort,'InferenceSession',side_effect=AssertionError('Prepared lookup attempted model creation')),patch.object(subprocess,'Popen',side_effect=AssertionError('Prepared lookup attempted worker subprocess')):
        for profile,row in records.items():
            for clip in row['clips']:
                request={'profile':profile,'language':'ar','text':clip['glyph'],'character':True,'wideLocale':True,'speed':1.,'controls':{'pitch':50,'timbre':50,'volume':100}}
                result=worker.fast_clip(request)
                if result is None or ar.sha256(result).hexdigest()!=clip['pcm_sha256']:raise ValueError('Actual fast_clip missed or changed prepared PCM')
                samples=np.frombuffer(result,dtype='<i2')
                if not len(samples) or not np.any(samples):raise ValueError('Prepared lookup silent')
                for _ in range(100):
                    start=perf_counter_ns();again=worker.fast_clip(request);timings.append((perf_counter_ns()-start)/1e6)
                    if again!=result:raise ValueError('Prepared lookup changed exact PCM')
                lookups.append({'profile':profile,'glyph':clip['glyph'],'pcm_bytes':len(result),'pcm_sha256':ar.sha256(result).hexdigest()})
                for wrong in [{'language':'ru'},{'character':False},{'text':'@'}]:
                    if worker.fast_clip(request|wrong) is not None:raise ValueError('Prepared clip escaped language/mode/glyph key')
        if bound.read('adam','ar-char','ا') is not None and 'adam' not in records:raise ValueError('Unprepared profile borrowed another voice')
        try:bound.read('veronika','ar-char','ا')
        except ValueError:pass
        else:raise ValueError('Excluded profile accepted')
        worker._resource_epoch=('deliberately-stale',)
        try:worker.fast_clip(request)
        except RuntimeError:pass
        else:raise ValueError('Original resource epoch guard did not reject stale lookup')
    ordered=sorted(timings)
    return {'scope':'Exact immutable driver AST fast_clip/epoch/control methods + actual NativeLetterBank, research caller view only; NOT full NVDA/WavePlayer/typing execution','driver_sha256':source_sha,'lookups':lookups,'model_creation_and_subprocess_forbidden':True,'resource_epoch_stale_rejected':True,'wrong_mode_locale_glyph_and_profile_rejected':True,'warm_read_samples':len(ordered),'warm_lookup_ms':{'minimum':ordered[0],'median':statistics.median(ordered),'p95':ordered[(len(ordered)*95+99)//100-1],'maximum':ordered[-1]}}


def run(args):
    runtime=args.runtime.resolve(strict=True);private=runtime/'python'
    if not Path(sys.executable).resolve().is_relative_to(private.resolve()) or sys.flags.utf8_mode!=1:raise RuntimeError('Use unchanged private interpreter with -X utf8')
    if args.output.exists():raise FileExistsError('Use NEW optional-bank research directory')
    if args.output.resolve().is_relative_to(runtime.parent):raise ValueError('Prepared data must stay outside original addon')
    args.output.mkdir(parents=True)
    common_pcm=load('_ar_bank_pcm_helpers',HERE/'ordinary_name_pcm_probe.py')
    os.environ['PYTHONDONTWRITEBYTECODE']='1';sys.addaudithook(common_pcm.deny_network_event)
    load('_ar_bank_original_bootstrap',runtime/'windows_runtime.py').reset_inherited_dll_directory();sys.path.insert(0,str(runtime));sys.path.insert(1,str(runtime.parent))
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
    if ort.__version__!='1.26.0':raise RuntimeError('Original private ORT differs')
    for name in ['numpy','onnxruntime']:
        if not Path(sys.modules[name].__file__).resolve().is_relative_to(private.resolve()):raise RuntimeError('Dependency escaped original private runtime')
    import converted_voices,voice_policy
    from wide_common import CommonSpeech
    from wide_common_helpers import UnicodeProcessor
    if bank.EXCLUDED!=voice_policy.EXCLUDED_VOICE_IDS:raise ValueError('Research bank exclusion policy differs from actual runtime')
    facts=ar.candidate(args.candidate);models=runtime/'models';shared=models/'WideLanguages/SharedAcoustic'
    staged=json.loads((runtime.parent/'ar29-stage.json').read_text(encoding='utf-8'));before=ar.snapshot(runtime)
    if before!=staged['existing_payload_hashes']:raise ValueError('Original staged runtime changed before bank preparation')
    native_prepared=ar.validate_names(UnicodeProcessor(str(shared/'onnx/unicode_indexer.json'),append_terminal_period=False),facts['letter_names'])
    catalogue=json.loads((models/'voices/catalog.json').read_text(encoding='utf-8'));ids=sorted(catalogue)
    release=json.loads((runtime.parent/'dordiai-release.json').read_text(encoding='utf-8'))
    if len(ids)!=45 or set(ids)!=set(release['voice_ids']):raise ValueError('Pinned builtin45 profile catalogue differs')
    targets={}
    target_records={}
    for profile in ids:
        voice_policy.require_voice_allowed(profile);bank.validate_profile(profile)
        path=models/'voices/classmate_locales'/(profile+'.npy')
        target=np.load(path,allow_pickle=False)
        if target.dtype!=np.float32 or target.shape!=(1,256,1) or not np.isfinite(target).all() or np.linalg.norm(target)<=1e-7:raise ValueError('Invalid actual profile target')
        targets[profile]=path;target_records[profile]={'size_bytes':path.stat().st_size,'sha256':bank.digest(path)}
    selected_profiles=['viktoriia','oksana'] if args.scope=='mini' else ids
    selected_glyphs=['ا','ء'] if args.scope=='mini' else list(facts['letter_names'])
    if not set(selected_profiles)<=set(ids):raise ValueError('Mini selected target is missing')
    report={'format':'dordiai-ar-name-bank-isolated-proof','format_version':1,'status':'running','source_commit':os.environ.get('GITHUB_SHA'),'preparation_tool_sha256':bank.digest(Path(__file__)),'recipe_tool_sha256':bank.digest(HERE/'ar_name_bank_recipe.py'),'scope':args.scope,'source_core_sha256':ar.CORE_SHA,'source_wide_sha256':ar.WIDE_SHA,'candidate_sha256':ar.CANDIDATE_SHA,'native_source_sha256':bank.digest(shared/'source.npy'),'target_identities':target_records,'all45_profile_ids':ids,'planned_full_clip_count':len(ids)*len(facts['letter_names']),'selected_profiles':selected_profiles,'selected_glyphs':selected_glyphs,'sample_rate':24000,'native_input_rate':22050,'bank_key_language':'ar-char','data_only_new_location':'research banks/ar/<profile>.json+.pcm, no production installable resource manifest','existing_bank_files_modified':0,'previous3330_regenerated':False,'model_retraining':False,'new_model_weights':False,'nvda_verified':False,'typing_verified':False,'physical_audio_verified':False,'pronunciation_verified':False,'product_ready':False,'production_registered':False,'generation':[],'banks':{}}
    ar.write_json(args.output/'report.json',report)
    options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1;options.add_session_config_entry('session.intra_op.allow_spinning','0')
    opened=[]
    def session(path):opened.append(str(path));return ort.InferenceSession(str(path),sess_options=options,providers=['CPUExecutionProvider'])
    class Owner:
        def check_cancelled(self):pass
        def _session(self,path):return session(path)
    carrier=CommonSpeech(models/'WideLanguages',Owner());carrier.voice.preload()
    flow=session(models/'OpenVoiceV2/encoder-flow.onnx');decoder=session(models/'OpenVoiceV2/decoder.onnx');source=np.load(shared/'source.npy',allow_pickle=False)
    native_cache={}
    try:
        for glyph in selected_glyphs:
            name=facts['letter_names'][glyph];start=perf_counter();native=carrier.audio('ar',name,1.)
            spec=converted_voices.spectrogram(native).T.copy()[None];native_cache[glyph]=(native,spec)
            i=list(facts['letter_names']).index(glyph);wave=common_pcm.save_wave(args.output/f'{i:02d}-native.wav',native,22050,np)
            report['generation'].append({'kind':'native_source_once','glyph':glyph,'ordinary_name':name,'render_seconds':perf_counter()-start,'wave':wave,'native_input':native_prepared[glyph]})
        for profile in selected_profiles:
            target=np.load(targets[profile],allow_pickle=False);clips=[]
            for glyph in selected_glyphs:
                _,spec=native_cache[glyph];start=perf_counter()
                latent=flow.run(None,{'spec':spec,'spec_lengths':np.asarray([spec.shape[-1]],np.int64),'src_g':source,'tgt_g':target})[0]
                projected=decoder.run(None,{'/Mul_output_0':latent,'/ConstantOfShape_1_output_0':np.zeros_like(target)})[0].reshape(-1)
                actual24=converted_voices.resample(projected,22050,24000)
                i=list(facts['letter_names']).index(glyph);wave=common_pcm.save_wave(args.output/f'{profile}-{i:02d}-projected24k.wav',actual24,24000,np)
                pcm=(np.clip(np.asarray(actual24,dtype=np.float32),-1.,1.-1./32768.)*32768.).astype('<i2').tobytes()
                bank.validate_pcm(pcm);clips.append((glyph,facts['letter_names'][glyph],pcm))
                report['generation'].append({'kind':'same_selected_profile_projection','profile':profile,'glyph':glyph,'ordinary_name':facts['letter_names'][glyph],'projection_and_real_resampling_seconds':perf_counter()-start,'wave':wave,'target_sha256':target_records[profile]['sha256'],'pcm_sha256':ar.sha256(pcm).hexdigest()})
            row=bank.new_bank(args.output/'banks/ar',profile,clips);row['target_identity']=target_records[profile];report['banks'][profile]=row
            ar.write_json(args.output/'report.json',report)
        for glyph in selected_glyphs:
            hashes={next(c['pcm_sha256'] for c in report['banks'][profile]['clips'] if c['glyph']==glyph) for profile in selected_profiles}
            if len(selected_profiles)>1 and len(hashes)<2:raise ValueError('Distinct selected profiles produced identical prepared clips')
        carrier.audio.cache_clear();carrier=None;flow=None;decoder=None;gc.collect()
        report['native_generation_calls']=len(native_cache);report['projection_calls']=len(selected_profiles)*len(selected_glyphs);report['model_sessions_created_before_lookup']=len(opened)
        report['lookup']=lookup_proof(runtime,args.output,report['banks'],targets,np)
        if len(opened)!=report['model_sessions_created_before_lookup']:raise ValueError('Lookup created another native model')
        if before!=ar.snapshot(runtime):raise ValueError('Optional bank experiment modified original addon payload')
        report.update(status='passed-noninstallable-optional-bank-feasibility',actual_clip_count=report['projection_calls'],all45_and29_prepared=args.scope=='full',original_payloads_unchanged=len(before),original180_banks_untouched=True,existing_generic_schema_consumed=True,minimal_future14_hook='Verify optional bank/profile identity and file pins through BoundReader plus existing resource epoch; managed replacement profiles must never use legacy builtin bank. No production13 hook changed.')
        ar.write_json(args.output/'report.json',report)
    except BaseException as e:
        report.update(status='failed-optional-bank-research',error_type=type(e).__name__,error=str(e));ar.write_json(args.output/'report.json',report);raise

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--runtime',type=Path,required=True);p.add_argument('--candidate',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--scope',choices=['mini','full'],default='mini');run(p.parse_args())
if __name__=='__main__':main()
