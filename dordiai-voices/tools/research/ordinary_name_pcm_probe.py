"""Isolated all-source-name ordinary-name native/projected PCM proof.

No production resource is edited, registered, promoted or pronounced correct by
this experiment. The original core11 and restored exact same-language package supply all
runtime/acoustic bytes. Candidate facts are source-backed, not a new G2P model.
"""
from __future__ import annotations
import argparse
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import wave

CORE_BYTES=1992938157
CORE_SHA='223e5ea7b29d0f9d16f3ca653711e8ced281c0fc7d5bd2fb891018a73926eceb'
FLOW_SHA='831fe762c0b47137e20753b9023b3901fc229bbc05bd6644ddce7073d7015404'
DECODER_SHA='9d57879aff5d3d50ae810b4e4791170b3fd1d27004be71fc2ae3f90afd588d36'
TARGET_SHA='e880e4ff3c582760073493c9651983a46dfab5a48d1b4ea1e773ef7f31a66f9a'
FALSE_FLAGS=('letter_names_ready','native_pronunciation_verified','windows_nvda_verified','typing_verified','production_registered')


def digest(path):
    with Path(path).open('rb') as stream:
        return __import__('hashlib').file_digest(stream,'sha256').hexdigest()


def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);sys.modules[name]=value;spec.loader.exec_module(value)
    return value


def write_json(path,value):
    path=Path(path);temp=path.with_suffix('.writing')
    with temp.open('x',encoding='utf-8') as target:
        json.dump(value,target,ensure_ascii=False,indent=2);target.write('\n')
    os.replace(temp,path)


def names_candidate(path,definition):
    if digest(path)!=definition['candidate_sha']:raise ValueError('Reviewed candidate file SHA differs')
    value=json.loads(Path(path).read_text(encoding='utf-8'))
    names=value.get('letter_names',{})
    if (value.get('format')!=definition['format'] or value.get('code')!=definition['code']
            or value.get('iso_code')!=definition['iso'] or value.get('semantic_role')!='ordinary_letter_name'
            or set(names)!=set(definition['repertoire']) or len(names)!=definition['count']
            or value.get('primary_corroboration',{}).get('sha256')!=definition['source_sha']
            or any(value.get(key) is not False for key in FALSE_FLAGS)
            or any(not isinstance(v,str) or not v or not v.strip() or '\n' in v for v in names.values())
            or any(names[k]!=v for k,v in definition['required_names'].items())):
        raise ValueError('Expected reviewed unregistered full-name candidate and original source pin')
    return value


def deny_network_event(event,details):
    # CPython platform.system on Windows reads the LOCAL computer name during
    # unchanged ORT import. gethostname is not DNS, a socket or external IO.
    if ((event.startswith('socket.') and event!='socket.gethostname')
            or event.startswith(('http.client.','urllib.'))):
        raise RuntimeError('Offline native inference forbids network access: '+event)


def snapshot(root):
    """Measure existing files; all must survive experiment byte-for-byte."""
    return {str(p.relative_to(root)).replace('\\','/'):digest(p) for p in root.rglob('*') if p.is_file()}


def stage(args,definition):
    helper=module('_ordinary_release_stage',Path(__file__).with_name('source11_afri_integration.py'))
    helper.pinned(args.core,CORE_BYTES,CORE_SHA)
    helper.pinned(args.pack,definition['pack_bytes'],definition['pack_sha'])
    candidate=names_candidate(args.candidate,definition)
    helper.extract_release(args.core,args.output)
    runtime=args.output/'kx47Runtime'
    sys.path.insert(0,str(runtime))
    import package_manager
    pack=package_manager.inspect_pack(args.pack)
    if pack.get('id')!='mms-'+definition['code'] or pack.get('languages')!=[definition['code']]:
        raise ValueError('Expected actual selected native-language resource pack')
    package_manager.install_pack(args.pack,args.output)
    write_json(args.output/'ordinary-name-probe-stage.json',{
        'core_sha256':CORE_SHA,'core_bytes':CORE_BYTES,'pack_sha256':definition['pack_sha'],'pack_bytes':definition['pack_bytes'],
        'candidate_sha256':digest(args.candidate),'source_pdf_sha256':definition['source_sha'],
        'scope':'owned disposable experiment directory; exact core11 plus selected native optional pack; no published source/resource modification',
        'installed_pack_id':pack['id'],'existing_payload_hashes':snapshot(runtime)})
    print(json.dumps({'staged':str(args.output),'candidate_names':len(candidate['letter_names']),'core_sha256':CORE_SHA}))


def save_wave(path,audio,rate,np):
    audio=np.asarray(audio,dtype=np.float32).reshape(-1)
    if not len(audio) or not np.isfinite(audio).all() or float(np.max(np.abs(audio)))<=1e-7:
        raise ValueError('Actual native/projection output silent or nonfinite')
    data=(np.clip(audio,-1.,1.-1./32768.)*32768.).astype('<i2').tobytes()
    with Path(path).open('xb') as target:
        with wave.open(target,'wb') as out:
            out.setnchannels(1);out.setsampwidth(2);out.setframerate(rate);out.writeframes(data)
    return {'samples':len(audio),'sample_rate':rate,'audio_seconds':len(audio)/rate,
            'peak':float(np.max(np.abs(audio))),'wav_sha256':digest(path),'file':Path(path).name}


def probe(args,definition):
    output=args.output
    if output.exists():raise FileExistsError('Use new isolated result directory')
    output.mkdir(parents=True)
    candidate=names_candidate(args.candidate,definition)
    runtime=args.runtime.resolve(strict=True);python=runtime/'python'
    if not Path(sys.executable).resolve().is_relative_to(python.resolve()):
        raise RuntimeError('Must execute unchanged core11 private Python')
    os.environ['PYTHONDONTWRITEBYTECODE']='1'
    sys.addaudithook(deny_network_event)
    bootstrap=module('_ordinary_private_bootstrap',runtime/'windows_runtime.py')
    bootstrap.reset_inherited_dll_directory()
    sys.path.insert(0,str(runtime))
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
    if ort.__version__!='1.26.0':raise RuntimeError('Unexpected private ORT version')
    for key in ('numpy','onnxruntime'):
        if not Path(sys.modules[key].__file__).resolve().is_relative_to(python.resolve()):
            raise RuntimeError('Dependency escaped unchanged private core')
    import converted_voices
    from wide_mms import MMSCarrier,read_tokens,MMSFrontend
    if not Path(converted_voices.__file__).resolve().is_relative_to(runtime):
        raise RuntimeError('Conversion frontend escaped immutable core')
    models=runtime/'models';folder=models/'MMS'/definition['code']
    config=json.loads((folder/'config.json').read_text(encoding='utf-8'))
    if config.get('iso_code')!=definition['iso'] or config.get('code')!=definition['code']:raise ValueError('Wrong native model identity')
    frontend=MMSFrontend(config,read_tokens(folder/'tokens.txt'))
    # Validate all names before any synthesis; never drop unknown native letters.
    prepared={glyph:frontend.ids(name) for glyph,name in candidate['letter_names'].items()}
    paths={'model':folder/'model.onnx','tokens':folder/'tokens.txt','source':folder/'source.npy',
           'flow':models/'OpenVoiceV2/encoder-flow.onnx','decoder':models/'OpenVoiceV2/decoder.onnx',
           'target':models/'voices/classmate_locales/viktoriia.npy'}
    for key,expected in [('model',definition['model_sha']),('flow',FLOW_SHA),('decoder',DECODER_SHA),('target',TARGET_SHA)]:
        if digest(paths[key])!=expected:raise ValueError('Immutable model/profile differs: '+key)
    source=np.load(paths['source'],allow_pickle=False);target=np.load(paths['target'],allow_pickle=False)
    for value in (source,target):
        if value.dtype!=np.float32 or value.shape!=(1,256,1) or not np.isfinite(value).all() or np.linalg.norm(value)<=1e-7:
            raise ValueError('Invalid original calibrated source/selected identity')
    if config.get('source_identity',{}).get('source_sha256')!=digest(paths['source']):
        raise ValueError('Actual same-carrier source pin differs')
    before=snapshot(runtime)
    report={'format':'dordiai-'+definition['code']+str(definition['count'])+'-ordinary-name-actual-pcm-v1','status':'running',
            'python':sys.version,'onnxruntime':ort.__version__,'source_pdf_sha256':definition['source_sha'],
            'candidate_sha256':digest(args.candidate),'input_hashes':{key:digest(path) for key,path in paths.items()},
            'source_identity':config['source_identity'],'ordinary_names_native_vocabulary_valid':True,
            'scope':'candidate names explicitly provided as ordinary spoken text; native MMS + original OpenVoice to Viktoriia, not production glyph dispatch or NVDA typing proof',
            'cases':[],**{key:False for key in FALSE_FLAGS},'physical_audio_verified':False,'product_ready':False}
    write_json(output/'report.json',report)
    options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
    options.add_session_config_entry('session.intra_op.allow_spinning','0')
    def session(path):return ort.InferenceSession(str(path),sess_options=options,providers=['CPUExecutionProvider'])
    carrier=MMSCarrier(folder,session_factory=session)
    flow=session(paths['flow']);decoder=session(paths['decoder'])
    try:
        for index,(glyph,name) in enumerate(candidate['letter_names'].items()):
            start=time.perf_counter()
            native,native_rate,_=carrier.audio(name,character=False,speed=1.,noise_scale=0.,noise_scale_w=0.)
            native_facts=save_wave(output/f'{index:02d}-native.wav',native,native_rate,np)
            native_seconds=time.perf_counter()-start
            # Original source.npy was calibrated from THIS exact pinned carrier.
            # No cross-language embedding or fresh surrogate identity is used.
            audio=converted_voices.resample(native,native_rate,22050)
            spec=converted_voices.spectrogram(audio).T.copy()[None]
            start=time.perf_counter()
            latent=flow.run(None,{'spec':spec,'spec_lengths':np.asarray([spec.shape[-1]],np.int64),
                                 'src_g':source,'tgt_g':target})[0]
            projected=decoder.run(None,{'/Mul_output_0':latent,'/ConstantOfShape_1_output_0':np.zeros_like(target)})[0].reshape(-1)
            facts=save_wave(output/f'{index:02d}-viktoriia.wav',projected,22050,np)
            report['cases'].append({'glyph':glyph,'ordinary_name':name,'native_input_ids':prepared[glyph],
                                    'native':native_facts,'native_render_seconds':native_seconds,
                                    'projection':facts,'projection_seconds':time.perf_counter()-start})
            write_json(output/'report.json',report)
            print('ORDINARY_NAME '+json.dumps(report['cases'][-1],ensure_ascii=False),flush=True)
        after=snapshot(runtime)
        if before!=after:raise ValueError('Experiment changed an immutable core/private/pack payload')
        report.update(status='passed-isolated-native-and-selected-profile-pcm',actual_cases=len(report['cases']),
                      all_source_names_native_and_projected_finite_nonzero=True,existing_payloads_unchanged=len(before),
                      projected_sample_rate=22050,production_character_resources_unchanged=True)
        write_json(output/'report.json',report)
    finally:carrier.close()
    if len(report['cases'])!=definition['count']:raise ValueError('Full ordinary repertoire not rendered')


def main(definition):
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='mode',required=True)
    p=sub.add_parser('stage');p.add_argument('--core',type=Path,required=True);p.add_argument('--pack',type=Path,required=True)
    p.add_argument('--candidate',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p=sub.add_parser('probe');p.add_argument('--runtime',type=Path,required=True);p.add_argument('--candidate',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();globals()[args.mode](args,definition)

