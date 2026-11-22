"""Small original Tetun-Dili Joao model probe, never product integration.

The publisher declares Tetun fine-tuning but leaves training URL/licence TBD and
uses the Portuguese text frontend. Preserve that original pipeline and measure
its actual native-h contrast loss; never relabel a Portuguese stock voice or
pretend mechanical PCM verifies Tetun pronunciation. No target-voice conversion.
"""
from __future__ import annotations
import argparse
import ctypes
import ctypes.util
from hashlib import sha256
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from time import perf_counter
from urllib.parse import urlsplit
from urllib.request import Request,urlopen
import wave

ROOT=Path(__file__).resolve().parents[2]
REPOSITORY='raphaelmerx/piper-voices'
REVISION='985bbb918a764710465f9df9afcdde5d86dd7b05'
PREFIX='tdt/tdt_TL/joao/medium/'
FILES={
 'tdt_TL-joao-medium.onnx':(77055182,'4584d1d2ec321944380239a7f416044b348e7f794ca0363193cdcebe7aed0270'),
 'tdt_TL-joao-medium.onnx.json':(7172,'b67d8d1699af69dcf77dadb8a54349aa68a7277483fe5a4d5fff918199157c7c'),
 'MODEL_CARD':(242,'e4ba9ef903a42a22479707c39fd5807c315a12eb275f384ba5f2e45d4d412bed')}
GRAMMAR={'title':'Tetun Dili: A grammar of an East Timorese language','authors':['C. Williams-van Klinken','J. Hajek','R. Nordlinger'],'year':2002,
 'doi':'10.15144/PL-528','url':'https://openresearch-repository.anu.edu.au/server/api/core/bitstreams/59d52d21-1125-4d13-92b0-702c768236ad/content',
 'size_bytes':14960132,'sha256':'b53d86db59c82153af7f163cab1ac9740905ccf92384d7df45f4037ff788c80e',
 'licence':'Online edition2015 CC-BY-SA4.0 per PDF footer; only short linguistic facts retained.',
 'visually_verified_pages':[{'pdf_page':24,'printed_page':10,'fact':'h is a voiceless glottal fricative; intervocalic variants do not imply obligatory initial deletion.'},
    {'pdf_page':38,'printed_page':24,'fact':'au is bamboo.'},{'pdf_page':75,'printed_page':61,'fact':'Hau naran Maria. is example7.42a; hau is first-person singular.'}]}


def fingerprint(path):
    h=sha256();n=0
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1024**2),b''):h.update(block);n+=len(block)
    return {'sha256':h.hexdigest(),'size_bytes':n}


def check_file(path,expected):
    observed=fingerprint(path)
    if observed!={'size_bytes':expected[0],'sha256':expected[1]}:raise ValueError('Original pinned source bytes differ')
    return observed


def checked_output(path,inputs=()):
    path=Path(path).absolute()
    if any(p.is_symlink() or getattr(p,'is_junction',lambda:False)() for p in (path,*path.parents)):
        raise ValueError('Linked research output is forbidden')
    actual=path.resolve()
    protected=[ROOT/p for p in ('source','packages','tools','tests','training-data','evidence')]+[ROOT.parent/'.github']
    if any(actual==p.resolve() or actual.is_relative_to(p.resolve()) for p in protected):raise ValueError('Output overlaps protected project files')
    if any(actual==Path(p).resolve() or Path(p).resolve().is_relative_to(actual) for p in inputs):raise ValueError('Output overlaps source inputs')
    if path.exists():raise FileExistsError('Research output is immutable; choose a fresh path')
    return path


def write_json(path,value):
    raw=(json.dumps(value,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode('utf-8')
    if len(raw)>2*1024**2:raise ValueError('Metadata quota exceeded')
    path=checked_output(path);path.parent.mkdir(parents=True,exist_ok=True)
    descriptor,temp=tempfile.mkstemp(prefix='tetun-report-',dir=path.parent)
    try:
        with os.fdopen(descriptor,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
        os.link(temp,path)
    finally:Path(temp).unlink(missing_ok=True)
    return fingerprint(path)


def acquire(directory):
    directory=checked_output(directory);directory.mkdir(parents=True)
    results={}
    for name,expected in FILES.items():
        target=directory/name
        url='https://huggingface.co/'+REPOSITORY+'/resolve/'+REVISION+'/'+PREFIX+name
        with urlopen(Request(url,headers={'User-Agent':'Dordiai-native-Tetun-research/1'}),timeout=60) as source,target.open('xb') as f:
            parts=urlsplit(source.geturl());host=(parts.hostname or '').lower()
            if parts.scheme!='https' or not (host=='huggingface.co' or host.endswith('.hf.co') or host.endswith('.huggingface.co')):
                raise ValueError('Pinned public model left expected storage')
            amount=0
            for block in iter(lambda:source.read(1024**2),b''):
                amount+=len(block)
                if amount>expected[0]:raise ValueError('Pinned model exceeds exact byte count')
                f.write(block)
        results[name]=check_file(target,expected)
    return results


def audit_original_config(config,card):
    if (config.get('num_speakers')!=4 or config.get('audio',{}).get('sample_rate')!=22050
            or config.get('espeak',{}).get('voice')!='pt' or config.get('language',{}).get('code')!='pt'
            or config.get('phoneme_type')!='espeak' or config.get('speaker_id_map')!={'Agostinho':0,'Estefanus':1,'Paulino':2,'':3}):
        raise ValueError('Original model/config speaker/frontend contract changed')
    if 'Tetun Dili, Timor-Leste' not in card or 'Finetuned from Portuguese' not in card or 'License: TBD' not in card:
        raise ValueError('Publisher original native declaration/rights caveats changed')
    return {'declared_native_standard':'Tetun Dili (tdt), not every Tetun variety',
        'native_training_evidence':'Publisher commit985bbb... reports >3k audios from3 different speakers; no independent corpus audit claimed.',
        'original_frontend_language':'pt','actual_config_speaker_count':4,'actual_speaker_id_map':config['speaker_id_map'],
        'stale_voices_json_not_authoritative':{'registry_speakers':1,'registry_model_size_bytes':63511038,
            'actual_model_size_bytes':77055182},
        'dataset_url':'TBD','weights_licence':'TBD; the Space code MIT marker does not license model weights',
        'genuine_native_pronunciation_verified':False,'product_integrated':False,'language_inventory_increment':0}


def deny_network():
    if not sys.platform.startswith('linux'):raise RuntimeError('This small initial probe requires Linux kernel network denial')
    library=ctypes.util.find_library('seccomp')
    if not library:raise RuntimeError('Kernel syscall network-denial library is required')
    s=ctypes.CDLL(library)
    s.seccomp_init.argtypes=[ctypes.c_uint32];s.seccomp_init.restype=ctypes.c_void_p
    s.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p];s.seccomp_syscall_resolve_name.restype=ctypes.c_int
    s.seccomp_rule_add.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,ctypes.c_uint]
    s.seccomp_load.argtypes=[ctypes.c_void_p];s.seccomp_release.argtypes=[ctypes.c_void_p]
    context=s.seccomp_init(0x7fff0000)
    if not context:raise RuntimeError('Cannot initialize kernel network denial')
    try:
        for name in (b'socket',b'connect',b'bind',b'listen',b'accept',b'accept4',b'sendto',b'sendmsg'):
            number=s.seccomp_syscall_resolve_name(name)
            if number<0 or s.seccomp_rule_add(context,0x00050001,number,0)!=0:raise RuntimeError('Cannot install kernel denial rule')
        if s.seccomp_load(context)!=0:raise RuntimeError('Cannot activate kernel network denial')
    finally:s.seccomp_release(context)
    def audit(event,args):
        if event in {'socket.connect','socket.bind','socket.getaddrinfo','socket.sendto'}:raise RuntimeError('Native model execution is offline')
    sys.addaudithook(audit)
    return {'kernel':'libseccomp, errnoEPERM for socket/connect/bind/listen/accept/accept4/sendto/sendmsg',
            'python_audit_guard':True,'network_access_denied_before_native_imports':True}


def safe_runtime():
    if importlib.metadata.version('onnxruntime')!='1.27.0' or importlib.metadata.version('piper-tts')!='1.4.1':
        raise RuntimeError('Exact isolated official inference packages are required')
    spec=importlib.util.find_spec('onnxruntime');directory=Path(next(iter(spec.submodule_search_locations)))
    binaries=[]
    for p in directory.rglob('*.so'):
        raw=p.read_bytes()
        if any(marker in raw for marker in (b'OneCollector',b'mobile.events.data.microsoft.com',b'v10.events.data.microsoft.com')):
            raise RuntimeError('Unexpected native telemetry implementation in research runtime')
        binaries.append({'file':p.name,**fingerprint(p)})
    if not binaries:raise RuntimeError('No actual Linux ORT native runtime was inspected')
    return binaries


def save_wave(path,audio,np):
    audio=np.asarray(audio,np.float32).reshape(-1)
    if len(audio)<2205 or not np.isfinite(audio).all() or np.max(np.abs(audio))<1e-6:raise ValueError('Empty/nonfinite/silent actual model output')
    pcm=np.rint(np.clip(audio,-1,1)*32767).astype('<i2')
    with Path(path).open('xb') as f:
        with wave.open(f,'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(22050);w.writeframes(pcm.tobytes())
    return {**fingerprint(path),'file':Path(path).name,'seconds':len(audio)/22050,'samples':len(audio),
        'raw_float_sha256':sha256(audio.tobytes()).hexdigest(),'peak':float(np.max(np.abs(audio))),'rms':float(np.sqrt(np.mean(audio**2)))}


def probe(assets,grammar,output):
    assets=Path(assets).resolve();grammar=Path(grammar).resolve()
    snapshots={name:check_file(assets/name,row) for name,row in FILES.items()}
    grammar_identity=check_file(grammar,(GRAMMAR['size_bytes'],GRAMMAR['sha256']))
    config=json.loads((assets/'tdt_TL-joao-medium.onnx.json').read_text(encoding='utf-8'))
    card=(assets/'MODEL_CARD').read_text(encoding='utf-8');declaration=audit_original_config(config,card)
    output=checked_output(output,[assets,grammar]);output.mkdir(parents=True)
    binaries=safe_runtime();policy=deny_network()
    import resource
    os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',DO_NOT_TRACK='1',CUDA_VISIBLE_DEVICES='')
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
    from piper import PiperVoice,PiperConfig,SynthesisConfig
    options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
    options.add_session_config_entry('session.intra_op.allow_spinning','0')
    started=perf_counter()
    session=ort.InferenceSession(str(assets/'tdt_TL-joao-medium.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
    load_seconds=perf_counter()-started
    voice=PiperVoice(config=PiperConfig.from_dict(config),session=session)
    words={}
    for text in ('hau','au','Hau naran Maria.'):
        sentences=voice.phonemize(text)
        if len(sentences)!=1:raise ValueError('Unexpected split for bounded original native input')
        phones=sentences[0]
        missing=sorted({p for p in phones if p not in voice.config.phoneme_id_map})
        if missing:raise ValueError('Original frontend generated silently dropped phonemes: '+repr(missing))
        words[text]={'text':text,'original_pt_phonemes':phones,'ids':voice.phonemes_to_ids(phones)}
    h_collapse=words['hau']['ids']==words['au']['ids']
    cases=[]
    for speaker in range(4):
        for text in ('hau','au','Hau naran Maria.'):
            row=words[text];started=perf_counter()
            audio=voice.phoneme_ids_to_audio(row['ids'],SynthesisConfig(speaker_id=speaker))
            seconds=perf_counter()-started
            record=save_wave(output/('speaker'+str(speaker)+'-'+('phrase' if ' ' in text else text)+'.wav'),audio,np)
            cases.append({**row,'speaker_id':speaker,'speaker_label':next(k for k,v in config['speaker_id_map'].items() if v==speaker),
                'original_default_noise':config['inference'],'generation_seconds':seconds,'rtf':seconds/record['seconds'],'wave':record})
    # Inspect ORIGINAL rows without pretending that their existence proves native learning.
    if importlib.metadata.version('onnx')!='1.17.0':raise RuntimeError('Pinned preparation-only ONNX inspector required')
    import onnx
    graph=onnx.load_model(assets/'tdt_TL-joao-medium.onnx',load_external_data=False)
    embeddings={t.name:t for t in graph.graph.initializer if t.name in {'enc_p.emb.weight','emb_g.weight'}}
    embedding=embeddings['enc_p.emb.weight'];speaker_embedding=embeddings['emb_g.weight']
    if list(embedding.dims)!=[256,192] or embedding.data_type!=1 or list(speaker_embedding.dims)!=[4,512]:
        raise ValueError('Original exact vocabulary/speaker tensor architecture changed')
    rows=np.frombuffer(embedding.raw_data,dtype='<f4').reshape(256,192)
    symbols=('h','ʔ','p','t','k','b','d','ɡ','v','s','z','ʃ','ʒ','m','n','ɲ','l','ʎ','r','ɾ','w','j','a','e','i','o','u','ˈ','ː','̯')
    original_rows=[]
    for symbol in symbols:
        ids=config['phoneme_id_map'].get(symbol)
        if not isinstance(ids,list) or len(ids)!=1 or not 0<=ids[0]<len(rows):raise ValueError('Required original phoneme row absent')
        data=rows[ids[0]]
        original_rows.append({'symbol':symbol,'original_id':ids[0],'dtype':'float32','shape':[192],
            'row_sha256':sha256(data.tobytes()).hexdigest(),'norm':float(np.linalg.norm(data)),
            'finite':bool(np.isfinite(data).all()),'learned_native_sound_meaning_verified':False})
    raw_frontend=Path(__file__).with_name('tetun_joao_frontend.py')
    spec=importlib.util.spec_from_file_location('_tetun_own_source_frontend',raw_frontend)
    native=importlib.util.module_from_spec(spec);sys.modules[spec.name]=native;spec.loader.exec_module(native)
    native_facts=native.facts();native_source_files={str(raw_frontend):fingerprint(raw_frontend),str(native.FACTS):fingerprint(native.FACTS)}
    semantic_cases=[]
    deterministic=SynthesisConfig(speaker_id=0,noise_scale=0.,noise_w_scale=0.)
    for entry in native_facts['entries']:
        planned=native.word(entry['annotated_word'])
        ids=native.token_ids(planned,config)
        if ids!=voice.phonemes_to_ids(list(planned.phone_tokens)):raise ValueError('Native strict IDs differ from original Piper schema')
        started=perf_counter();audio=voice.phoneme_ids_to_audio(ids,deterministic);elapsed=perf_counter()-started
        name='native-lexical-'+str(len(semantic_cases))+'.wav'
        semantic_cases.append({'own_semantic_plan':planned.describe(),'original_ids':ids,
            'existing_ids_only':True,'original_pt_text_frontend_invoked':False,'speaker_id':0,
            'generation_seconds':elapsed,'mode':'zero-noise phonetic capability diagnostic, not publisher quality setting',
            'wave':save_wave(output/name,audio,np),'native_phonetic_fidelity_verified':False})
    hare=native.word('háre');hless=[p for p in hare.phone_tokens if p!='h']
    explicit_h=voice.phoneme_ids_to_audio(native.token_ids(hare,config),deterministic)
    no_h=voice.phoneme_ids_to_audio(voice.phonemes_to_ids(hless),deterministic)
    h_diagnostic={'source_native_form':'háre, uncooked rice, PL528printed10','control':'synthetic deleted-h control, not asserted to be a second lexical native word',
        'existing_h_id':config['phoneme_id_map']['h'],'distinct_input_ids':native.token_ids(hare,config)!=voice.phonemes_to_ids(hless),
        'outputs_bit_identical':explicit_h.tobytes()==no_h.tobytes(),
        'native_h_wave':save_wave(output/'existing-h-token.wav',explicit_h,np),
        'synthetic_hless_control_wave':save_wave(output/'synthetic-hless-control.wav',no_h,np),
        'correct_native_h_frication_confirmed':False,'interpretation':'Numerical use of existing h row only; no proof of learned native phonetic meaning.'}
    for path,expected in native_source_files.items():
        if fingerprint(path)!=expected:raise ValueError('Own pinned native lexical frontend changed')
    # Diagnostic only: zero noise distinguishes mathematical frontend collision
    # from the original stochastic decoder. It is NOT the publisher quality mode.
    deterministic=SynthesisConfig(speaker_id=0,noise_scale=0.,noise_w_scale=0.)
    first=voice.phoneme_ids_to_audio(words['hau']['ids'],deterministic)
    second=voice.phoneme_ids_to_audio(words['au']['ids'],deterministic)
    diagnostic={'hau_wave':save_wave(output/'hau-zero-noise.wav',first,np),
        'au_wave':save_wave(output/'au-zero-noise.wav',second,np),'mode':'zero-noise diagnostic only; original default cases above remain unchanged',
        'same_model_input_ids':h_collapse,'raw_waveforms_bit_identical':first.tobytes()==second.tobytes(),
        'hau_raw_float_sha256':sha256(first.tobytes()).hexdigest(),'au_raw_float_sha256':sha256(second.tobytes()).hexdigest()}
    for name,expected in snapshots.items():
        if fingerprint(assets/name)!=expected:raise ValueError('Original pinned model/config/card changed during inference')
    if fingerprint(grammar)!=grammar_identity:raise ValueError('Primary native phonology source changed')
    report={'format':'dordiai-original-tetun-joao-cpu-probe','format_version':1,'status':'actual-original-model-executed-but-native-frontend-unaccepted',
        'repository':REPOSITORY,'revision':REVISION,'files':snapshots,'publisher_declaration':declaration,'primary_native_source':GRAMMAR,
        'runtime':{'python':sys.version,'ort':ort.__version__,'piper_tts':importlib.metadata.version('piper-tts'),'numpy':np.__version__,
            'original_product_private_runtime_used':False,'product_private_runtime_modified':False,'ort_native_binaries':binaries},
        'network_policy':policy,'load_seconds':load_seconds,'cpu_threads':2,'cases':cases,
        'actual_config_speakers_executed':sorted({c['speaker_id'] for c in cases}),
        'original_pt_frontend_erases_native_initial_h_contrast':h_collapse,'zero_noise_diagnostic':diagnostic,
        'original_model_token_rows':original_rows,
        'original_embedding':{'name':embedding.name,'shape':list(embedding.dims),'dtype':'float32','sha256':sha256(embedding.raw_data).hexdigest()},
        'original_speaker_embedding':{'name':speaker_embedding.name,'shape':list(speaker_embedding.dims),'sha256':sha256(speaker_embedding.raw_data).hexdigest()},
        'bounded_native_lexical_diagnostics':semantic_cases,'existing_h_token_diagnostic':h_diagnostic,
        'own_frontend_files':native_source_files,'surface_unreleased_stop_modifier_token_available':'̚' in config['phoneme_id_map'],
        'four_ids_do_not_prove_four_native_tetun_speakers':'Publisher claims3 recording speakers; config has4 IDs, including unnamed ID3 whose training/language identity remains unverified.',
        'peak_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024,
        'all_original_model_config_card_and_primary_source_unchanged':True,
        'weights_requantized':False,'own_native_tetun_frontend_implemented':'Eight source-bounded complete lexical forms only; unknown/unmarked homographs reject; no broad regular-text support',
        'native_training_corpus_independently_verified':False,'native_pronunciation_verified':False,'ordinary_letter_names_ready':False,
        'selected_profile_projection_verified':False,'windows_verified':False,'nvda_verified':False,'product_integrated':False,
        'language_inventory_increment':0,
        'readiness_barriers':['Publisher original pt frontend collapses genuine native hau/au inputs if measured flag true; output audio cannot restore a distinction missing from identical input IDs.',
            'Training data URL and model weights licence remainTBD; do not infer model rights from the Space code MIT licence.',
            'Native phone/stress fidelity, retained selected-profile projection and unchanged private Windows/NVDA interaction are unverified.']}
    write_json(output/'proof.json',report)
    print('TETUN_JOAO_SUMMARY '+json.dumps({'status':report['status'],'cases':len(cases),'h_contrast_lost':h_collapse,
        'zero_noise_wave_equal':diagnostic['raw_waveforms_bit_identical'],'load_seconds':load_seconds,'peak_rss_bytes':report['peak_rss_bytes'],
        'word_seconds':[c['generation_seconds'] for c in cases if c['text']=='hau'],'product_integrated':False}),flush=True)
    return report


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=('acquire','probe'))
    p.add_argument('--assets',type=Path,required=True);p.add_argument('--grammar',type=Path);p.add_argument('--output',type=Path)
    a=p.parse_args(argv)
    if a.command=='acquire':
        value=acquire(a.assets)
        if a.output:write_json(a.output,{'files':value,'repository':REPOSITORY,'revision':REVISION,'product_integrated':False})
    else:probe(a.assets,a.grammar,a.output)
    return 0

if __name__=='__main__':raise SystemExit(main())
