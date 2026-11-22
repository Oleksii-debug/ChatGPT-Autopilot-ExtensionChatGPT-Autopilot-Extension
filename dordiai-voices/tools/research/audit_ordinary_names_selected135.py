#!/usr/bin/env python3
"""Data-only audit: name tables, route candidates and measured audio are distinct."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

BANK_PROOF='evidence/core8_character_bank_summary_45009758998.json'
CORE12_SHA='908a9825a8f3e1574d9d0a370ac0e35e1e1683eb04b998a937c312f0ce3ec573'

def audit(root):
    root=Path(root)
    p=root/'tools/audit_character_names.py'
    s=importlib.util.spec_from_file_location('_ordinary135_audit',p)
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
    d=m.audit(root/'evidence/language_coverage_dev2.json',root/'source/0.12.2/kx47Runtime/models/CharacterNames',root/'source/0.12.2/kx47Runtime')
    if d['summary']['selected']!=135:raise ValueError('Expected exact reviewed selected135 scope')
    def relative(v):
        if isinstance(v,dict):return {k:relative(x) for k,x in v.items()}
        if isinstance(v,list):return [relative(x) for x in v]
        if isinstance(v,str) and v.startswith(str(root)+'/'):return v[len(str(root))+1:]
        return v
    d=relative(d)
    proof_raw=(root/BANK_PROOF).read_bytes();proof=json.loads(proof_raw)
    if proof['core_archive_sha256']!='568e49547f386b17fc82d1def13257749774eecaf999f4823d74100e47bf7ac6':raise ValueError('Unexpected immutable bank ancestor')
    for code,letters in [('uk',33),('ru',33),('en-us',26)]:
        a=proof['aggregate'][code]
        if a['profiles']!=45 or a['navigation_spoken_name']!=letters*45 or a['no_default_prepared_candidate']!=0:raise ValueError('Bank aggregate differs')
    d['format']='dordiai-selected135-ordinary-name-gap-audit';d['format_version']=1
    d['reproduce']='python tools/research/audit_ordinary_names_selected135.py --project-root . --output evidence/ordinary_names_selected135_after12.json'
    d['installed_language_count_recomputed']=False
    d['inventory_caution']='The named dev2 inventory is historical resource metadata, not current source12 installation. Its inherited 125 count is not a new installation/quality/count assertion.'
    d['bank_evidence']={'immutable_ancestor':{'path':BANK_PROOF,'sha256':hashlib.sha256(proof_raw).hexdigest(),'run':45009758998,'core_archive_sha256':proof['core_archive_sha256'],'aggregate':proof['aggregate']},'source12_build':{'run':45040668513,'source_commit':'be7f4e2468dc18bd155d2c205f89bf61c8e235a2','archive_sha256':CORE12_SHA,'existing_prepared_bank_files_byte_identical':180,'old_source_bound_overlay_reapplied':False,'scope':'Actual source12 builder reports 180 existing bank files preserved against immutable11. 180 is files across 45 profiles/categories, not 180 languages. Ancestor name keys do not prove native pronunciation or NVDA typing.'},'uninspected_languages':'Unknown bank coverage, never inferred empty from this audit','ay_fil':'Separate actual 32/28 native+Viktoriia PCM research proof exists; generated bank_entries are plans, not installed PCM.'}
    european=[]
    for row in d['languages']:
        code=row['runtime_code']
        row['prepared_ordinary_bank_evidence']='ancestor45-profiles-navigation-name-keys' if code in {'uk','ru','en'} else 'not-established-by-this-audit'
        row['ordinary_name_pcm_evidence']=('isolated-native-and-viktoriia-32-names-run45038768977' if code=='ay' else 'isolated-native-and-viktoriia-28-names-run45038769182' if code=='fil' else 'not-established-by-this-audit')
        row['writing_system_scope_caution']= {'cmn':'Han characters are not a finite ordinary alphabet-name table; require character readings and disambiguation policy.','ja':'Mixed kana/kanji: kana names/readings and open kanji readings require separate repertoires, not one Latin-style alphabet table.','ko':'Finite Jamo letter names and compositional Hangul syllable readings are distinct tasks.'}.get(code)
        if 'Європа' in row['regions'] and not row['known_ordinary_name_mapping_present']:european.append(row['id'])
    d['next_work_priority']=[{'scope':'Europe-first missing identified explicit tables','selected_ids':european,'acceptance':'Primary ordinary-name facts before acoustic tests; existing eSpeak route does not supply a transcribed table.'},{'scope':'Finish partial Romanian','selected_ids':['ro'],'missing':'q','reason':'Pinned academy source kü is pronunciation notation; an independently sourced native orthographic renderer is needed before adding q.'},{'scope':'Concrete next source-backed world candidate','selected_ids':['ar'],'candidate':'tools/research/ar_ordinary_name_candidate.json','facts':29,'scope_note':'28 base Arabic alphabet letters plus independent hamza, no contextual-form aliases; not production integrated or audio tested.'}]
    d['acceptance']={'source_table_completeness_is_audio_acceptance':False,'all135_runtime_spelling_verified':False,'all135_prepared_banks_verified':False,'native_pronunciation_verified_by_this_audit':False,'nvda_typing_verified_by_this_audit':False,'product_ready':False}
    return d

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--project-root',type=Path,default=Path(__file__).resolve().parents[2]);ap.add_argument('--output',type=Path,required=True);a=ap.parse_args();d=audit(a.project_root);a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(json.dumps(d['summary']))
if __name__=='__main__':main()
