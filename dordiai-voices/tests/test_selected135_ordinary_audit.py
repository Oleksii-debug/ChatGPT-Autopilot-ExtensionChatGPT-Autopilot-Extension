import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT=Path(os.environ.get('DORDIAI_PROJECT_ROOT',Path(__file__).resolve().parents[1]))
PACKET=Path(__file__).resolve().parents[1]
def load(name,path):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

class OrdinaryAudit(unittest.TestCase):
    def test_selected135_are_unique_and_missing_tables_are_not_missing_runtime_claims(self):
        m=load('_selected135_audit',PACKET/'tools/research/audit_ordinary_names_selected135.py');d=m.audit(ROOT)
        self.assertEqual(len({r['id'] for r in d['languages']}),135)
        self.assertEqual(d['summary']['source_complete'],14)
        self.assertEqual(d['summary']['identified_explicit_mapping_tables'],19)
        missing=[r for r in d['languages'] if not r['known_ordinary_name_mapping_present']]
        self.assertEqual(len(missing),116)
        self.assertEqual(sum(r['engine_native_spelling_candidate'] for r in missing),67)
        self.assertFalse(d['installed_language_count_recomputed'])
        self.assertFalse(d['acceptance']['product_ready'])
    def test_bank_file_count_is_not_languages_or_full_multilingual_name_acceptance(self):
        m=load('_selected135_bank_audit',PACKET/'tools/research/audit_ordinary_names_selected135.py');d=m.audit(ROOT)
        self.assertEqual(d['bank_evidence']['source12_build']['existing_prepared_bank_files_byte_identical'],180)
        for r in d['languages']:
            if r['runtime_code'] not in {'uk','ru','en'}:
                self.assertEqual(r['prepared_ordinary_bank_evidence'],'not-established-by-this-audit')
        self.assertEqual(sum(v['navigation_spoken_name'] for v in d['bank_evidence']['immutable_ancestor']['aggregate'].values()),4140)
    def test_arabic_candidate_all29_ordinary_names_dispatch_without_sound_or_phonetic_examples(self):
        c=json.loads((PACKET/'tools/research/ar_ordinary_name_candidate.json').read_text())
        self.assertEqual(set(c['letter_names']),set('ابتثجحخدذرزسشصضطظعغفقكلمنهويء'))
        names=load('_ar29_name_dispatch',ROOT/'source/0.12.2/kx47Runtime/character_names.py')
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);(p/'ar.json').write_text(json.dumps({'format':'dordiai-character-name-sources','format_version':1,'language':'ar','letter_names':c['letter_names'],'phonetic_descriptions':{'ب':['an unrelated spelling example']},'symbol_names':{},'letter_names_ready':False}))
            names.clear_cache()
            for glyph,expected in c['letter_names'].items():
                with self.subTest(glyph=glyph):self.assertEqual(names.spoken_name('ar',glyph,directory=p),expected)
            self.assertFalse(names.letter_names_ready('ar',p))
            for glyph in ['أ','إ','آ','ؤ','ئ','ة','ى','ـ','a','qq']:
                with self.subTest(unsupported=glyph),self.assertRaises(LookupError):names.spoken_name('ar',glyph,directory=p)
            names.clear_cache()
    def test_arabic_facts_preserve_contrasts_and_source_scope(self):
        c=json.loads((PACKET/'tools/research/ar_ordinary_name_candidate.json').read_text())
        self.assertEqual(c['source']['sha256'],'940efb9723bab5f877c08dbb1f8bddfd8c79cfb62430c6e5874335406d91a385')
        self.assertEqual(c['source']['bytes'],5475624)
        self.assertEqual(c['letter_names']['ا'],'ألف');self.assertEqual(c['letter_names']['ء'],'همزة')
        for glyphs in ['حخه','تث','دذ','زظ','سص','ضظ','عغ']:
            self.assertEqual(len({c['letter_names'][g] for g in glyphs}),len(glyphs))
        self.assertEqual(c['letter_names']['ل'],'لام') # visually checked; PDF extraction reverses this row
        self.assertTrue(c['readiness']['source_facts_verified'])
        for key,value in c['readiness'].items():
            if key!='source_facts_verified':self.assertFalse(value,key)
if __name__=='__main__':unittest.main()
