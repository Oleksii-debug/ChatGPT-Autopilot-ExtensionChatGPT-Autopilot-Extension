"""Native semantic facts only: these tests do not certify an acoustic carrier."""
from dataclasses import FrozenInstanceError
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('hiri_frontend_tests',ROOT/'tools/research/hiri_motu_frontend.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)

class GenuineSourceFactsTests(unittest.TestCase):
    def test_two_exact_primary_raw_downloads_and_actual_publication_year(self):
        d=m.source_facts();self.assertEqual(d['language'],'ho');self.assertEqual(d['not_alias_of'],'meu')
        self.assertEqual(d['sources'][0]['sha256'],'b97373c996d6a09ddcd24ce0b1ff2f1c94c51945e24d653604e74c5aa8e0917c')
        self.assertEqual(d['sources'][1]['year'],1977)
        self.assertEqual(d['sources'][1]['sha256'],'f58e42ef22591a9b425900e5c0ad2f11fa3292b0bbb875f97ecba90361055926')
        self.assertTrue(all(x['whole_raw_bytes_actually_verified'] for x in d['sources']))
        self.assertEqual(sha256(m.SOURCES.read_bytes()).hexdigest(),m.SOURCES_SHA256)
    def test_no_standard_alias_or_false_readiness(self):
        d=m.source_facts();self.assertFalse(d['product_integrated']);self.assertEqual(d['language_inventory_increment'],0)
        self.assertFalse(d['ordinary_letter_names_ready']);self.assertFalse(d['native_pronunciation_verified'])
    def test_every_curated_stress_remains_sourced_but_not_every_group_is_claimed(self):
        for row in m.source_facts()['stress_lexicon']:
            a=m.word(row['form']);b=m.word(m._strip_marks(row['form']))
            self.assertEqual(a.primary_stress_phone,b.primary_stress_phone)
            self.assertEqual(b.stress_evidence,'curated-primary-lexical-stress')
            self.assertIn(row['source'],a.source_ids)
        self.assertIn('adjacent-vowel-grouping-unresolved',m.word('namodia').unresolved)
    def test_visual_source_corrects_ocr_dawn_last_accent(self):
        a=m.word('dabarere')
        self.assertEqual(a.primary_stress_phone,1)
        self.assertEqual(a.ipa_hypothesis,'ˈdabaɾeɾe')
        with self.assertRaises(m.UnsupportedHiriMotu):m.word('dábareré')
    def test_source_pin_mutation_is_rejected(self):
        m.word('namo')  # Prime the separate immutable lexical-stress cache.
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'facts.json';p.write_bytes(b'{}')
            with patch.object(m,'SOURCES',p):
                with self.assertRaises(m.UnsupportedHiriMotu):m.source_facts()
                with self.assertRaises(m.UnsupportedHiriMotu):m.word('namo')

class NativeStressAndGroupingTests(unittest.TestCase):
    def test_tau_one_nucleus_and_niu_two_are_not_collapsed(self):
        tau=m.word('tau');niu=m.word('niu')
        self.assertEqual(tau.nuclei,((1,2),));self.assertEqual(niu.nuclei,((1,),(2,)))
        self.assertTrue(tau.phones[2].nonsyllabic);self.assertFalse(niu.phones[2].nonsyllabic)
        self.assertEqual(tau.primary_stress_syllable,0);self.assertEqual(niu.primary_stress_syllable,1)
        self.assertTrue(tau.strictly_renderable);self.assertTrue(niu.strictly_renderable)
    def test_stress_changes_are_exact_forms_not_general_suffix_guess(self):
        self.assertEqual([m.word(x).primary_stress_phone for x in ('namo','namona','namodia')],[1,3,3])
        self.assertEqual([m.word(x).primary_stress_phone for x in ('nega','negana','negadia')],[1,3,3])
        self.assertIn('lexical-stress-unresolved',m.word('namoma').unresolved)
    def test_explicit_annotation_resolves_only_stated_vowel_boundary(self):
        self.assertFalse(m.word('namodia').strictly_renderable)
        w=m.word('namódi.a');self.assertTrue(w.strictly_renderable);self.assertEqual(w.primary_stress_phone,3)
        self.assertEqual(w.explicit_syllable_boundaries,(6,))
    def test_no_universal_penultimate_stress(self):
        a=m.word('pataka');self.assertIsNone(a.primary_stress_phone)
        with self.assertRaises(m.UnsupportedHiriMotu) as error:m.compile_plan('pataka')
        self.assertIn('lexical-stress-unresolved',error.exception.reasons)
        self.assertEqual(m.word('pataká').primary_stress_phone,5)
    def test_explicit_source_conflict_is_not_silently_overwritten(self):
        for text in ('namó','námona','níu','tá.u','níu̯'):
            with self.subTest(text=text),self.assertRaises(m.UnsupportedHiriMotu):m.word(text)
    def test_general_vowel_group_is_not_guessed_from_one_tau_example(self):
        self.assertIn('adjacent-vowel-grouping-unresolved',m.word('káu').unresolved)
        self.assertTrue(m.word('káu̯').strictly_renderable)
        self.assertTrue(m.word('ká.u').strictly_renderable)
        self.assertNotEqual(m.word('káu̯').nuclei,m.word('ká.u').nuclei)
    def test_cross_morpheme_ao_is_preserved_and_never_replaced_by_au(self):
        w=m.word('haorea')
        self.assertEqual([p.symbol for p in w.phones][:3],['h','a','o'])
        self.assertEqual(w.morpheme_boundaries,(2,))
        self.assertTrue(m.word('há-o.re.a').strictly_renderable)
        self.assertEqual([p.symbol for p in m.word('káo').phones],['k','a','o'])
        self.assertIn('native-morpheme-boundary-unresolved',m.word('káo').unresolved)
    def test_lao_lau_exact_segment_fact_is_not_general_ao_rewrite(self):
        self.assertEqual([p.symbol for p in m.word('lao').phones],[p.symbol for p in m.word('lau').phones])
        self.assertFalse(m.word('lao').strictly_renderable)
        self.assertEqual([p.symbol for p in m.word('káo').phones],['k','a','o'])
    def test_native_plural_stress_is_not_borrowed_from_motu(self):
        for x in ('hahine','kekeni'):
            self.assertEqual(m.word(x).primary_stress_phone,3)
        with self.assertRaises(m.UnsupportedHiriMotu):m.word('kékeni')
    def test_multiple_reduplicated_accents_need_real_domain_analysis(self):
        with self.assertRaises(m.UnsupportedHiriMotu):m.word('kubórukubóru')
    def test_unicode_canonical_marks_preserve_the_same_plan(self):
        a=m.word('namóna');b=m.word('namo\u0301na')
        self.assertEqual(a.phones,b.phones);self.assertEqual(a.primary_stress_phone,b.primary_stress_phone)
    def test_marked_unknown_does_not_become_a_learned_dictionary_entry(self):
        self.assertTrue(m.word('pátaka').strictly_renderable)
        self.assertIsNone(m.word('pataka').primary_stress_phone)

class NativeSegmentAndBoundaryTests(unittest.TestCase):
    def test_gw_is_one_native_labialised_voiced_velar_stop(self):
        p=m.word('gwá').phones[0]
        self.assertEqual((p.symbol,p.kind,p.place,p.voiced,p.labialised),('gʷ','stop','velar',True,True))
        self.assertEqual(len(m.word('gwá').phones),2)
        self.assertNotEqual(p.symbol,m.word('gá').phones[0].symbol)
        with self.assertRaises(m.UnsupportedHiriMotu):m.word('kwá')
    def test_all_three_plain_voiceless_stops_keep_unaspirated_requirement(self):
        for text in ('páta','táka','kápa'):
            for p in m.word(text).phones:
                if p.kind=='stop':self.assertIs(p.aspirated,False)
    def test_course_bilabial_friction_flap_and_retained_h_are_structured(self):
        w=m.word('héreva');self.assertEqual([p.symbol for p in w.phones],['h','e','ɾ','e','β','a'])
        p=w.phones[4];self.assertEqual((p.kind,p.place,p.voiced),('fricative','bilabial',True))
    def test_lateral_requires_exact_lexical_exception(self):
        self.assertTrue(m.word('dála').strictly_renderable)
        self.assertIn('written-l-realization-unverified',m.word('láma').unresolved)
    def test_loan_f_does_not_gain_an_automatic_foreign_spelling_path(self):
        self.assertIn('loanword-phonology-unverified',m.word('fóto').unresolved)
        with self.assertRaises(m.UnsupportedHiriMotu):m.compile_plan('fóto')
    def test_invalid_clusters_closed_syllables_foreign_symbols_or_length_fail(self):
        for text in ('pát','strá','ñá','ā','námo\u0301','a̯','á̯','gw','g-wá','ná..mo','ná-'):
            with self.subTest(text=text),self.assertRaises(m.UnsupportedHiriMotu):m.word(text)
    def test_plan_is_frozen_and_does_not_contain_foreign_acoustic_tokens(self):
        w=m.word('namo')
        with self.assertRaises(FrozenInstanceError):w.spelling='meu'
        plan=m.compile_plan('namo, namona!')
        self.assertEqual(plan['language'],'ho');self.assertEqual(plan['not_alias_of'],'meu')
        self.assertEqual(plan['carrier'],'not-established');self.assertFalse(plan['product_integrated'])
        self.assertFalse(plan['ordinary_letter_names']);self.assertEqual(plan['language_inventory_increment'],0)
        self.assertTrue(all(not part.get('ipa_hypothesis','').startswith('[[') for part in plan['events']))
        self.assertFalse(hasattr(w,'encoded'))
    def test_numbers_symbols_and_ordinary_letter_names_are_not_invented(self):
        for text in ('123','namo 1','namo @','a'):
            with self.subTest(text=text),self.assertRaises(m.UnsupportedHiriMotu):m.compile_plan(text)
        for char in ('a','b','gw','!','1'):
            with self.assertRaises(LookupError):m.ordinary_character_name(char)
    def test_quotas_and_types_are_bounded(self):
        for value in ('',None,123,'a'*129):
            with self.subTest(value=str(value)[:10]),self.assertRaises((TypeError,m.UnsupportedHiriMotu)):m.word(value)
        with self.assertRaises(m.UnsupportedHiriMotu):m.compile_plan('namo '*257)

if __name__=='__main__':unittest.main()
