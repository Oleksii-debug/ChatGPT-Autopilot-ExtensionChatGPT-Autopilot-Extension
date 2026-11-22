"""Actual prepared ordinary-name tables through the native adapter lookup seam.

No neural model, fabricated audio or phonetic example is substituted in these
semantic tests. Actual original-weight PCM evidence is recorded separately.
"""
from pathlib import Path
import importlib.util
import json
import sys
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
RUNTIME=ROOT/'source/0.12.2/kx47Runtime'
DIRECTORY=RUNTIME/'models/CharacterNames'

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module

names=load('_ay_fil_dispatch_names',RUNTIME/'character_names.py')
native=load('_ay_fil_dispatch_native',RUNTIME/'wide_mms.py')

class PreparedOrdinaryDispatch(unittest.TestCase):
    def setUp(self):names.clear_cache()
    def tearDown(self):names.clear_cache()
    def candidate(self,code):
        return json.loads((ROOT/f'tools/research/{code}_ordinary_name_candidate.json').read_text(encoding='utf-8'))
    def test_all60_primary_names_dispatch_through_real_native_lookup(self):
        count=0
        with patch.dict(sys.modules,{'character_names':names}):
            for code in ('ay','fil'):
                for glyph,expected in self.candidate(code)['letter_names'].items():
                    with self.subTest(code=code,glyph=glyph):
                        self.assertEqual(native.prepared_character_name(code,glyph,RUNTIME/'models'),expected)
                        self.assertEqual(names.spoken_name(code,glyph,directory=DIRECTORY),expected)
                        for variant in (glyph.upper(),glyph.title()):
                            self.assertEqual(native.prepared_character_name(code,variant,RUNTIME/'models'),expected)
                    count+=1
        self.assertEqual(count,60)
    def test_all60_bank_jobs_keep_literal_glyph_and_ordinary_name_semantics(self):
        for code in ('ay','fil'):
            data=names.data(code,DIRECTORY)
            entries={r['lookup_text']:r for r in data['bank_entries']}
            for glyph,expected in self.candidate(code)['letter_names'].items():
                with self.subTest(code=code,glyph=glyph):
                    row=entries[glyph]
                    self.assertEqual(row['text'],expected)
                    self.assertEqual(row['source_kind'],'letter_name')
                    self.assertEqual(row['semantic_kind'],'spoken_name')
                    self.assertEqual(row['source_id'],'curated_primary_alphabet_names')
                    self.assertEqual(row['acoustic_validation'],'pending')
            self.assertTrue(data['ordinary_alphabet_source_complete'])
            self.assertFalse(data['letter_names_ready'])
            self.assertFalse(data['semantics']['native_pronunciation_verified'])
    def test_existing_filipino_symbols_and_primary_cldr_provenance_survive(self):
        d=names.data('fil',DIRECTORY)
        self.assertEqual(len(d['symbol_names']),1531)
        self.assertEqual(d['sources']['cldr_annotations']['sha256'],
                         '19f0875055c57e10f0676262b53b5dbc34634cff5738dd3c9be4b8c496c0d9be')
        self.assertEqual(d['sources']['cldr_characters']['sha256'],
                         '41b317292895ea90fe67ba23c9f12597bde2439fad55333f200cf00abf4164e9')
        with patch.dict(sys.modules,{'character_names':names}):
            self.assertEqual(native.prepared_character_name('fil','😀',RUNTIME/'models'),d['symbol_names']['😀'])
        self.assertNotIn('😀',d['letter_names'])

    def test_native_unknown_names_do_not_borrow_english_or_phonetic_examples(self):
        with patch.dict(sys.modules,{'character_names':names}):
            for code,glyph in [('ay','h'),('ay','€'),('fil','qq'),('fil','a phonetic example')]:
                with self.subTest(code=code,glyph=glyph),self.assertRaises(native.UnsupportedMMSInput):
                    native.prepared_character_name(code,glyph,RUNTIME/'models')
    def test_primary_pins_and_measured_pcm_are_distinct_from_quality_acceptance(self):
        for code,count,source_sha in [
            ('ay',32,'227ed343f0d68d460159bfb7f9a2a785085f82629a50fdd0d2498e3a2260b072'),
            ('fil',28,'5f20b7eb93ef53af129822bede538121b8967fbc0e7fd93c64bef646d740f66f')]:
            d=names.data(code,DIRECTORY);source=d['sources']['curated_primary_alphabet_names']
            if code=='ay':self.assertEqual(source['primary_corroboration']['sha256'],source_sha)
            else:self.assertEqual(source['sha256'],source_sha)
            proof=source['technical_name_pcm_proof']
            self.assertEqual(proof['source_names_rendered'],count)
            self.assertTrue(proof['native_and_viktoriia_finite_pcm'])
            for field in ('native_pronunciation_verified','listener_pronunciation_verified','windows_nvda_verified','typing_verified','physical_audio_verified'):
                self.assertFalse(proof[field])
    def test_filipino_collision_cannot_replace_letter_i_with_letter_e_audio(self):
        d=names.data('fil',DIRECTORY)
        entries={r['lookup_text']:r for r in d['bank_entries']}
        self.assertEqual(entries['e']['text'],'i')
        self.assertEqual(entries['i']['text'],'ay')
        self.assertNotIn('i',entries['e']['aliases'])
        self.assertEqual(names.spoken_name('fil','E',directory=DIRECTORY),'i')
        self.assertEqual(names.spoken_name('fil','I',directory=DIRECTORY),'ay')
        self.assertEqual(d['ordinary_letter_name_alternatives']['ng'],['endyi'])
if __name__=='__main__':unittest.main()
