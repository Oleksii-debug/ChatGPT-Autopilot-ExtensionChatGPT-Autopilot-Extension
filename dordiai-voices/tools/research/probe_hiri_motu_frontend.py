"""Verify primary raw sources and emit a bounded semantic/future acoustic probe.

This executes the OWN Hiri Motu frontend only. It never loads a foreign voice,
phoneme engine, neural model or audio device and never registers a language.
A future carrier must independently pass the declared native primitive,
calibration, selected-profile, Windows/NVDA and native-listener gates.
"""
from __future__ import annotations
import argparse
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import sys

ROOT=Path(__file__).resolve().parents[2]
FRONTEND=Path(__file__).with_name('hiri_motu_frontend.py')


def fingerprint(path):
    path=Path(path);digest=sha256();amount=0
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024**2),b''):digest.update(block);amount+=len(block)
    return {'sha256':digest.hexdigest(),'size_bytes':amount}


def frontend():
    spec=importlib.util.spec_from_file_location('_hiri_motu_native_research',FRONTEND)
    module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
    return module


def safe_output(path,inputs):
    path=Path(path).absolute()
    if any(p.is_symlink() or getattr(p,'is_junction',lambda:False)() for p in (path,*path.parents)):
        raise ValueError('Linked research output is forbidden')
    actual=path.resolve()
    protected=[ROOT/name for name in ('source','packages','tools','tests','training-data','evidence')]+[ROOT.parent/'.github']
    if any(actual==p.resolve() or actual.is_relative_to(p.resolve()) for p in protected):
        raise ValueError('Research output overlaps protected project inputs')
    for source in inputs:
        source=Path(source).resolve()
        if actual==source or actual.is_relative_to(source) or source.is_relative_to(actual):
            raise ValueError('Research output overlaps a protected source')
    if path.exists():raise FileExistsError('Research report is immutable; use a fresh path')
    return path


def write_report(path,value,inputs):
    path=safe_output(path,inputs)
    raw=(json.dumps(value,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode('utf-8')
    if len(raw)>2*1024**2:raise ValueError('Bounded semantic metadata quota exceeded')
    path.parent.mkdir(parents=True,exist_ok=True)
    descriptor,temp=tempfile.mkstemp(prefix='hiri-phonology-',dir=path.parent)
    try:
        with os.fdopen(descriptor,'wb') as stream:
            stream.write(raw);stream.flush();os.fsync(stream.fileno())
        os.link(temp,path)
    finally:Path(temp).unlink(missing_ok=True)
    return fingerprint(path)


def prepare_probe(source1974,source1977):
    module=frontend();facts=module.source_facts()
    snapshots={str(FRONTEND.resolve()):fingerprint(FRONTEND),
               str(module.SOURCES.resolve()):fingerprint(module.SOURCES)};verified=[]
    for path,expected in zip((Path(source1974),Path(source1977)),facts['sources']):
        observed=fingerprint(path)
        if observed!={k:expected[k] for k in ('sha256','size_bytes')}:
            raise ValueError('Actual primary PDF differs from the verified source pin')
        with path.open('rb') as stream:
            if not stream.read(5)==b'%PDF-':raise ValueError('Expected original primary PDF bytes')
        snapshots[str(path.resolve())]=observed
        verified.append({'id':expected['id'],'doi':expected['doi'],'year':expected['year'],**observed,
                         'verified_whole_primary_bytes':True,'licence':expected['licence']})
    lexical=[]
    for entry in facts['stress_lexicon']:
        plan=module.word(entry['form'])
        lexical.append({'source_form':entry['form'],'source':entry['source'],**plan.describe()})
    native_goldens=('tau','niu','gini','ane','bogakunu','dabarere','maganibada','namo','namona',
                    'nega','negana','hereva','herevana','hahine','kekeni')
    for text in native_goldens:module.compile_plan(text)
    annotation_cases=[]
    for text in ('namódi.a','há-o.re.a','gwá','páta','táka','kápa'):
        annotation_cases.append({'text':text,'origin':'explicit-research-annotation, not an independently recorded native lexical pronunciation',
                                 'plan':module.compile_plan(text)})
    negatives=[]
    for text in ('pataka','káu','háorea','láma','fóto','namo 123','ā','kubórukubóru'):
        try:module.compile_plan(text)
        except module.UnsupportedHiriMotu as error:
            negatives.append({'text':text,'rejected':True,'reasons':list(error.reasons),'message':str(error)})
        else:raise ValueError('Unsupported native input was silently rendered')
    inventory={}
    for text in native_goldens+('gwá','páta','táka','kápa'):
        for phone in module.word(text).phones:
            inventory[phone.symbol]={key:value for key,value in phone.__dict__.items() if key not in ('grapheme','nonsyllabic')}
    report={'format':'dordiai-hiri-motu-primary-frontend-proof','format_version':1,
        'language':'ho','iso639_3':'hmo','not_alias_of':'meu','sources':verified,
        'source_facts_sha256':module.SOURCES_SHA256,'frontend_file':fingerprint(FRONTEND),
        'curated_stress_form_count':len(lexical),
        'strict_semantic_primary_golden_count':len(native_goldens),
        'source_lexical_analyses':lexical,'strict_semantic_primary_goldens':list(native_goldens),
        'explicit_annotation_cases':annotation_cases,'strict_rejections':negatives,
        'required_semantic_phone_inventory':inventory,
        'future_native_acoustic_probe':{
            'status':'not-executed; carrier and ordinary names remain unestablished',
            'carrier_boundary':'Own versioned Hiri Motu phoneme/config frontend on disclosed shared acoustic primitives; no Motu/meu alias and no neighbouring-language text/dictionary/phoneme-table fallback.',
            'required_exact_features':['gʷ one voiced labialised velar phone distinct from g and kw',
                'p/t/k explicitly unaspirated','β voiced bilabial friction, selected course variant',
                'ɾ one flap and source-licensed l exceptions','five native vowels without invented contrastive length',
                'tau one nucleus/offglide versus niu two nuclei','explicit native lexical stress and exact morphological forms'],
            'stop_conditions':['Any missing exact primitive, stress or nucleus/domain feature; do not approximate or substitute a neighbouring language.',
                'Unresolved frontend result must stop before synthesis; no English/native-language guessing backoff.',
                'A changed source, phoneme-map/config, selected voice or managed resource epoch invalidates calibration and cached audio.'],
            'future_mechanical_cases':[{'text':x,'semantic_plan':module.compile_plan(x)} for x in native_goldens],
            'future_evidence_required':['Original unchanged private Windows runtime, exact own native voice/phoneme table and dependency file SHA identities.',
                'Actual carrier output with all declared phone/nucleus/stress contrasts, finite/nonzero PCM and uncached deterministic repeats.',
                'Actual generated same-carrier calibration through original FP32 reference encoder; never copy a source vector from Motu or another language.',
                'Exact allowed selected-profile asset resolver/hash and actual original conversion call source/target identity checks.',
                'Measured cold/warm first PCM, stop/cancel, native word-language switching, RAM and package replacement lifecycle.',
                'Primary listening reference/native-speaker phonetic evaluation; output differences or nonzero WAV alone do not certify native correctness.',
                'Ordinary source-backed alphabet/digit/punctuation names, then actual private NVDA keyboard/navigation/reading proof.']},
        'all_native_name_requests_rejected':all(_name_unavailable(module,x) for x in ('a','b','gw','1','!')),
        'no_foreign_acoustic_engine_invoked':True,'acoustic_pronunciation_verified':False,
        'source_embedding_prepared':False,'selected_profile_projection_verified':False,'windows_verified':False,
        'nvda_verified':False,'ordinary_letter_names_ready':False,'language_inventory_increment':0,
        'product_integrated':False,'status':'source-verified-semantic-frontend-only-not-acoustic-support'}
    for name,expected in snapshots.items():
        if fingerprint(name)!=expected:raise ValueError('Primary source changed during semantic proof')
    return report


def _name_unavailable(module,value):
    try:module.ordinary_character_name(value)
    except LookupError:return True
    return False


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-1974',required=True,type=Path);parser.add_argument('--source-1977',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args(argv)
    inputs=(args.source_1974,args.source_1977,FRONTEND,FRONTEND.with_name('hiri_motu_sources.json'))
    safe_output(args.output,inputs)
    report=prepare_probe(args.source_1974,args.source_1977)
    archive=write_report(args.output,report,inputs)
    print('HIRI_MOTU_FRONTEND_SUMMARY '+json.dumps({'status':report['status'],'curated_stress_form_count':report['curated_stress_form_count'],
        'strict_semantic_primary_golden_count':report['strict_semantic_primary_golden_count'],'language_inventory_increment':0,'report':archive}),flush=True)
    return 0

if __name__=='__main__':raise SystemExit(main())
