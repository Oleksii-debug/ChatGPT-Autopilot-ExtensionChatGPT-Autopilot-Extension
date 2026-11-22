"""Isolated Arabic ordinary-name facts -> original Arabic-trained shared carrier.

Uses immutable core12 private Python/ORT and the unchanged shared acoustic
optional resources. No eSpeak/MMS substitute, registration or quality promotion.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import time
import unicodedata
import zipfile
from hashlib import sha256

CORE_BYTES=1992944744
CORE_SHA='908a9825a8f3e1574d9d0a370ac0e35e1e1683eb04b998a937c312f0ce3ec573'
WIDE_BYTES=552777798
WIDE_SHA='5e500e6f5a217a39023835352c8b59761cf6d1aff5063376ca96b24fbb8df262'
CANDIDATE_SHA='17ec9499b5e685b4385d0f1c0b1aa3fe6ca7beb9725d4300bb0336c142513ecc'
SOURCE_SHA='940efb9723bab5f877c08dbb1f8bddfd8c79cfb62430c6e5874335406d91a385'
SOURCE_BYTES=5475624
REPERTOIRE='ابتثجحخدذرزسشصضطظعغفقكلمنهويء'
FLOW_SHA='831fe762c0b47137e20753b9023b3901fc229bbc05bd6644ddce7073d7015404'
DECODER_SHA='9d57879aff5d3d50ae810b4e4791170b3fd1d27004be71fc2ae3f90afd588d36'
TARGET_SHA='e880e4ff3c582760073493c9651983a46dfab5a48d1b4ea1e773ef7f31a66f9a'
FALSE_FLAGS=('letter_names_ready','native_pronunciation_verified','listener_pronunciation_verified','windows_nvda_verified','typing_verified','production_registered','physical_audio_verified','product_ready')

def digest(p):
    with Path(p).open('rb') as s:return __import__('hashlib').file_digest(s,'sha256').hexdigest()

def write_json(path,value):
    path=Path(path);tmp=path.with_suffix('.writing')
    with tmp.open('x',encoding='utf-8') as s:json.dump(value,s,ensure_ascii=False,indent=2);s.write('\n')
    os.replace(tmp,path)

def module(name,path):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m

def candidate(path):
    if digest(path)!=CANDIDATE_SHA:raise ValueError('Reviewed Arabic29 candidate SHA differs')
    d=json.loads(Path(path).read_text(encoding='utf-8'))
    if (d.get('language')!='ar' or d.get('semantic_role')!='ordinary_letter_name' or
        d.get('source',{}).get('sha256')!=SOURCE_SHA or d['source'].get('bytes')!=SOURCE_BYTES or
        len(d.get('letter_names',{}))!=29 or set(d['letter_names'])!=set(REPERTOIRE) or
        any(not isinstance(v,str) or not v.strip() or '\n' in v for v in d['letter_names'].values()) or
        d['letter_names']['ا']!='ألف' or d['letter_names']['ء']!='همزة' or d['letter_names']['ل']!='لام' or
        d.get('readiness',{}).get('source_facts_verified') is not True or
        any(value is not False for key,value in d['readiness'].items() if key!='source_facts_verified')):
        raise ValueError('Arabic29 ordinary source/semantic/readiness contract differs')
    return d

def snapshot(root):
    return {str(p.relative_to(root)).replace('\\','/'):digest(p) for p in root.rglob('*') if p.is_file()}

def stage(args):
    helper=module('_ar29_release_helper',Path(__file__).with_name('source11_afri_integration.py'))
    helper.pinned(args.core,CORE_BYTES,CORE_SHA);helper.pinned(args.wide,WIDE_BYTES,WIDE_SHA);candidate(args.candidate)
    helper.extract_release(args.core,args.output)
    runtime=args.output/'kx47Runtime';prefix='kx47Runtime/models/WideLanguages/SharedAcoustic/'
    inner=args.output/'original-wide-package.zip'
    with zipfile.ZipFile(args.wide) as outer:
        names=[i for i in outer.infolist() if Path(i.filename).name=='dordiai-wide-languages-0.13.1-dev.10.zip']
        if len(names)!=1 or names[0].is_dir():raise ValueError('Expected exact original wide package')
        with outer.open(names[0]) as source,inner.open('xb') as target:shutil.copyfileobj(source,target,1024**2)
    records={};seen=set()
    with zipfile.ZipFile(inner) as archive:
        manifest=json.loads(archive.read('dordiai-resource-pack.json'))
        if manifest.get('format')!='dordiai-resource-pack' or manifest.get('id')!='wide-languages' or manifest.get('version')!='0.13.1-dev.10':raise ValueError('Wrong wide package identity')
        for i in archive.infolist():
            if i.is_dir() or not i.filename.startswith(prefix):continue
            helper.valid_name(i.filename)
            if i.orig_filename!=i.filename or i.filename.casefold() in seen or i.flag_bits&1 or stat.S_IFMT(i.external_attr>>16) not in (0,stat.S_IFREG):raise ValueError('Unsafe/shared archive member')
            seen.add(i.filename.casefold())
            dest=args.output/i.filename;dest.parent.mkdir(parents=True,exist_ok=True)
            with archive.open(i) as source,dest.open('xb') as target:shutil.copyfileobj(source,target,1024**2)
            actual={'size_bytes':dest.stat().st_size,'sha256':digest(dest)}
            if actual!=manifest['files'].get(i.filename):raise ValueError('Original shared resource bytes differ')
            records[i.filename]=actual
    inner.unlink()
    required=['onnx/tts.json','onnx/unicode_indexer.json','onnx/duration_predictor.onnx','onnx/text_encoder.onnx','onnx/vector_estimator.static-q8.onnx','onnx/vocoder.onnx','voice_styles/F1.json','source.npy']
    if not all(prefix+r in records for r in required):raise ValueError('Actual shared carrier resources incomplete')
    write_json(args.output/'ar29-stage.json',{'format':'ar29-original-core12-shared-subset','core_sha256':CORE_SHA,'wide_outer_sha256':WIDE_SHA,'candidate_sha256':CANDIDATE_SHA,'shared_files':records,'existing_payload_hashes':snapshot(runtime),'scope':'Full immutable12 core plus original SharedAcoustic subset from original wide optional pack; no production registration or graph rewrite'})

def validate_names(processor,names):
    """A finite WAV cannot hide a dropped native letter/mark in preprocessing."""
    prepared={}
    processor.append_terminal_period=False
    for glyph,name in names.items():
        decomposed=unicodedata.normalize('NFKD',name)
        unsupported=[{'character':c,'codepoint':f'U+{ord(c):04X}','category':unicodedata.category(c),'mapped':processor._model_character(c)} for c in decomposed if processor._model_character(c)!=c]
        if unsupported:raise ValueError('Original Arabic frontend would change/drop source name '+repr(glyph)+': '+json.dumps(unsupported,ensure_ascii=False))
        marked=processor._preprocess_text(name,'ar')
        if marked!='<ar>'+decomposed+'</ar>':raise ValueError('Original Arabic frontend unexpectedly changed source name')
        ids,mask=processor([name],['ar'])
        values=ids.reshape(-1).tolist()
        if not values or any(v<0 for v in values):raise ValueError('Native Arabic vocabulary rejected ordinary name')
        prepared[glyph]={'source_text':name,'nfkd_text':decomposed,'marked_text':marked,'native_input_ids':values,'native_input_mask':mask.reshape(-1).tolist()}
    return prepared

def probe(args):
    shared=module('_ar29_pcm_common',Path(__file__).with_name('ordinary_name_pcm_probe.py'))
    if args.output.exists():raise FileExistsError('Use fresh owned result directory')
    args.output.mkdir(parents=True)
    d=candidate(args.candidate);runtime=args.runtime.resolve(strict=True);private=(runtime/'python').resolve()
    if not Path(sys.executable).resolve().is_relative_to(private):raise RuntimeError('Must use unchanged core12 private interpreter')
    if sys.flags.utf8_mode!=1:raise RuntimeError('Private research subprocess must inherit PYTHONUTF8=1')
    report={'format':'dordiai-ar29-ordinary-name-actual-pcm-v1','status':'running','core_sha256':CORE_SHA,'wide_outer_sha256':WIDE_SHA,'source_pdf_sha256':SOURCE_SHA,'candidate_sha256':CANDIDATE_SHA,'scope':'Literal ordinary names through actual Arabic-conditioned shared neural carrier, original calibrated shared source and original Viktoriia OpenVoice graphs; not eSpeak, MMS, production raw-glyph dispatch, listening or NVDA typing proof','cases':[],'utf8_mode':sys.flags.utf8_mode,'stdout_encoding':sys.stdout.encoding,**{k:False for k in FALSE_FLAGS}}
    write_json(args.output/'report.json',report)
    try:
        os.environ['PYTHONDONTWRITEBYTECODE']='1';sys.addaudithook(shared.deny_network_event)
        module('_ar29_windows_bootstrap',runtime/'windows_runtime.py').reset_inherited_dll_directory();sys.path.insert(0,str(runtime))
        import numpy as np
        import onnxruntime as ort
        ort.disable_telemetry_events()
        if ort.__version__!='1.26.0':raise RuntimeError('Unexpected private ORT version')
        for name in ['numpy','onnxruntime']:
            if not Path(sys.modules[name].__file__).resolve().is_relative_to(private):raise RuntimeError('Dependency escaped unchanged core12')
        import converted_voices
        from wide_common_helpers import UnicodeProcessor,AVAILABLE_LANGS
        from wide_common import CommonSpeech
        if 'ar' not in AVAILABLE_LANGS:raise ValueError('Actual carrier does not declare Arabic')
        models=runtime/'models';folder=models/'WideLanguages/SharedAcoustic'
        processor=UnicodeProcessor(str(folder/'onnx/unicode_indexer.json'),append_terminal_period=False)
        report['prepared_names']=validate_names(processor,d['letter_names']);report['ordinary_names_native_vocabulary_valid']=True
        before=snapshot(runtime);staged=json.loads((runtime.parent/'ar29-stage.json').read_text(encoding='utf-8'))
        if before!=staged['existing_payload_hashes']:raise ValueError('Original staged payload changed before inference')
        paths={'source':folder/'source.npy','flow':models/'OpenVoiceV2/encoder-flow.onnx','decoder':models/'OpenVoiceV2/decoder.onnx','target':models/'voices/classmate_locales/viktoriia.npy'}
        for key,pin in [('flow',FLOW_SHA),('decoder',DECODER_SHA),('target',TARGET_SHA)]:
            if digest(paths[key])!=pin:raise ValueError('Original graph/profile differs')
        source=np.load(paths['source'],allow_pickle=False);target=np.load(paths['target'],allow_pickle=False)
        for vector in [source,target]:
            if vector.dtype!=np.float32 or vector.shape!=(1,256,1) or not np.isfinite(vector).all() or np.linalg.norm(vector)<=1e-7:raise ValueError('Invalid original actual shared/target identity')
        options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1;options.add_session_config_entry('session.intra_op.allow_spinning','0')
        def session(path):return ort.InferenceSession(str(path),sess_options=options,providers=['CPUExecutionProvider'])
        class Owner:
            def check_cancelled(self):pass
            def _session(self,path):return session(path)
        common=CommonSpeech(models/'WideLanguages',Owner());flow=session(paths['flow']);decoder=session(paths['decoder'])
        common.voice.preload();engine,_=common.voice.engine
        report.update(python=sys.version,onnxruntime=ort.__version__,input_hashes={k:digest(v) for k,v in paths.items()},shared_resource_hashes=staged['shared_files'],native_graph_sample_rate=engine.sample_rate,native_common_output_rate=22050,native_output_resampled_by_original_core=True)
        write_json(args.output/'report.json',report)
        for i,(glyph,name) in enumerate(d['letter_names'].items()):
            start=time.perf_counter();native=common.audio('ar',name,1.)
            native_facts=shared.save_wave(args.output/f'{i:02d}-native.wav',native,22050,np);native_seconds=time.perf_counter()-start
            spec=converted_voices.spectrogram(native).T.copy()[None];start=time.perf_counter()
            latent=flow.run(None,{'spec':spec,'spec_lengths':np.asarray([spec.shape[-1]],np.int64),'src_g':source,'tgt_g':target})[0]
            wave=decoder.run(None,{'/Mul_output_0':latent,'/ConstantOfShape_1_output_0':np.zeros_like(target)})[0].reshape(-1)
            facts=shared.save_wave(args.output/f'{i:02d}-viktoriia.wav',wave,22050,np)
            report['cases'].append({'glyph':glyph,'ordinary_name':name,'native':native_facts,'native_render_seconds':native_seconds,'projection':facts,'projection_seconds':time.perf_counter()-start})
            write_json(args.output/'report.json',report);print('AR29_ORDINARY_NAME '+json.dumps(report['cases'][-1],ensure_ascii=False),flush=True)
        if before!=snapshot(runtime):raise ValueError('Experiment changed original private/model/data bytes')
        if len(report['cases'])!=29:raise ValueError('Incomplete Arabic ordinary repertoire')
        report.update(status='passed-isolated-native-and-selected-profile-pcm',actual_cases=29,all_source_names_native_and_projected_finite_nonzero=True,existing_payloads_unchanged=len(before),projected_sample_rate=22050,production_character_resources_unchanged=True)
        write_json(args.output/'report.json',report)
    except BaseException as e:
        report.update(status='failed-isolated-candidate-proof',error_type=type(e).__name__,error=str(e));write_json(args.output/'report.json',report);raise

def main():
    p=argparse.ArgumentParser(description=__doc__);s=p.add_subparsers(dest='mode',required=True)
    q=s.add_parser('stage');q.add_argument('--core',type=Path,required=True);q.add_argument('--wide',type=Path,required=True);q.add_argument('--candidate',type=Path,required=True);q.add_argument('--output',type=Path,required=True)
    q=s.add_parser('probe');q.add_argument('--runtime',type=Path,required=True);q.add_argument('--candidate',type=Path,required=True);q.add_argument('--output',type=Path,required=True)
    a=p.parse_args();globals()[a.mode](a)
if __name__=='__main__':main()
