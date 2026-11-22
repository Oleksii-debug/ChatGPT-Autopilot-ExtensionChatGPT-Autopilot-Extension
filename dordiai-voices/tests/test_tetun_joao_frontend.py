"""Finite primary lexical plans and original-token safety, not phonetic approval."""
from dataclasses import FrozenInstanceError
import importlib.util
from pathlib import Path
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('_tetun_native_test',ROOT/'tools/research/tetun_joao_frontend.py')
n=importlib.util.module_from_spec(spec);sys.modules[spec.name]=n;spec.loader.exec_module(n)
spec=importlib.util.spec_from_file_location('_tetun_probe_test',ROOT/'tools/research/probe_tetun_joao.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)

# Synthetic metadata only, original known IDs; this does not represent learned
# phonetic meanings or substitute for the actual model run.
TABLE={'^':[1],'_':[0],'$':[2],'h':[20],'a':[14],'r':[30],'e':[18],'k':[23],
       'b':[15],'s':[31],'n':[26],'m':[25],'i':[21],'z':[38],'ˈ':[120],'ː':[122]}
CONFIG={'num_symbols':256,'phoneme_id_map':TABLE}

class BoundedNativeFrontendTests(unittest.TestCase):
    def test_primary_source_and_eight_finite_forms_not_broad_support(self):
        d=n.facts();self.assertEqual(d['language'],'tdt');self.assertEqual(d['source']['doi'],'10.15144/PL-528')
        self.assertEqual(d['source']['sha256'],'b53d86db59c82153af7f163cab1ac9740905ccf92384d7df45f4037ff788c80e')
        self.assertEqual(len(d['entries']),8);self.assertFalse(d['native_pronunciation_verified']);self.assertEqual(d['language_inventory_increment'],0)
    def test_unmarked_stress_homographs_do_not_guess_a_meaning(self):
        for text in ('hare','kabas','kaben'):
            with self.subTest(text=text),self.assertRaises(n.AmbiguousTetunStress):n.word(text)
    def test_explicit_stress_and_final_length_contrasts_are_source_exact(self):
        for first,second in (('háre','haré'),('kábas','kabás'),('káben','kabén')):
            a=n.word(first);b=n.word(second)
            self.assertNotEqual(a.gloss,b.gloss);self.assertNotEqual(n.token_ids(a,CONFIG),n.token_ids(b,CONFIG))
            self.assertFalse(a.selected_final_lengthening);self.assertTrue(b.selected_final_lengthening)
            self.assertNotIn('ː',a.phone_tokens);self.assertIn('ː',b.phone_tokens)
    def test_unique_primary_form_has_exact_known_stress_without_generic_rule(self):
        self.assertEqual(n.word('hakarak').annotated_word,'hakárak')
        self.assertEqual(n.word('kamiza').annotated_word,'kamíza')
        with self.assertRaises(n.UnsupportedTetunInput):n.word('papara')
    def test_native_h_is_retained_and_existing_original_id_is_used(self):
        w=n.word('háre');self.assertIn('h',w.phone_tokens)
        self.assertEqual(n.token_ids(w,CONFIG),[1,0,120,0,20,0,14,0,30,0,18,0,2])
    def test_missing_h_does_not_drop_or_add_an_untrained_id(self):
        config={**CONFIG,'phoneme_id_map':{k:v for k,v in TABLE.items() if k!='h'}}
        with self.assertRaisesRegex(n.UnsupportedTetunInput,'do not add untrained IDs'):n.token_ids(n.word('háre'),config)
        self.assertNotIn('h',config['phoneme_id_map'])
    def test_missing_stress_length_or_special_token_rejects(self):
        for token in ('ˈ','ː','^','_','$'):
            config={**CONFIG,'phoneme_id_map':{k:v for k,v in TABLE.items() if k!=token}}
            with self.subTest(token=token),self.assertRaises(n.UnsupportedTetunInput):n.token_ids(n.word('haré'),config)
    def test_invalid_id_cannot_escape_the_original_vocabulary(self):
        for ids in ([256],[-1],[True],[],['20']):
            config={**CONFIG,'phoneme_id_map':{**TABLE,'h':ids}}
            with self.subTest(ids=ids),self.assertRaises(n.UnsupportedTetunInput):n.token_ids(n.word('háre'),config)
    def test_unicode_case_and_accent_normalization_preserve_plan(self):
        self.assertEqual(n.word('HA\u0301RE').phone_tokens,n.word('háre').phone_tokens)
    def test_unestablished_spelling_numbers_and_raw_phone_markup_reject(self):
        for text in ('','123','[[h a]]','ha\'u','la’o','háre!','hàre','háré','hakarák',None,'a'*65):
            with self.subTest(text=text),self.assertRaises(n.UnsupportedTetunInput):n.word(text)
    def test_ordinary_letter_names_are_not_fabricated_from_phone_symbols(self):
        for char in ('a','h','ʔ','1','!'):
            with self.assertRaises(LookupError):n.ordinary_character_name(char)
    def test_source_pin_is_checked_after_prior_success(self):
        n.word('háre')
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'bad.json';path.write_bytes(b'{}')
            with patch.object(n,'FACTS',path):
                with self.assertRaises(n.UnsupportedTetunInput):n.word('háre')
    def test_plan_is_immutable_and_does_not_claim_learned_native_phonetics(self):
        w=n.word('háre')
        with self.assertRaises(FrozenInstanceError):w.annotated_word='pt'
        self.assertFalse(w.describe()['native_sound_meaning_confirmed_in_carrier'])
        self.assertFalse(w.describe()['product_integrated']);self.assertFalse(w.describe()['ordinary_character_name'])
    def test_final_stop_constraint_is_not_forged_as_a_supported_id(self):
        w=n.word('hakarak');self.assertEqual(w.phone_tokens[-1],'k')
        self.assertTrue(any('unreleased' in x for x in w.unvalidated_acoustic_constraints))
        self.assertNotIn('̚',TABLE)

class OriginalModelAndOutputContractTests(unittest.TestCase):
    def original(self):
        return {'num_speakers':4,'audio':{'sample_rate':22050},'espeak':{'voice':'pt'},'language':{'code':'pt'},
                'phoneme_type':'espeak','speaker_id_map':{'Agostinho':0,'Estefanus':1,'Paulino':2,'':3}}
    def card(self):return 'Tetun Dili, Timor-Leste\nFinetuned from Portuguese\nLicense: TBD'
    def test_stale_one_speaker_registry_is_not_actual_original_config(self):
        d=p.audit_original_config(self.original(),self.card())
        self.assertEqual(d['actual_config_speaker_count'],4)
        self.assertEqual(d['stale_voices_json_not_authoritative']['registry_speakers'],1)
        self.assertEqual(d['stale_voices_json_not_authoritative']['actual_model_size_bytes'],77055182)
    def test_original_portuguese_frontend_is_disclosed_not_mislabeled_native(self):
        d=p.audit_original_config(self.original(),self.card())
        self.assertEqual(d['original_frontend_language'],'pt');self.assertFalse(d['genuine_native_pronunciation_verified'])
        self.assertEqual(d['language_inventory_increment'],0)
    def test_model_rights_are_not_inferred_from_space_code_license(self):
        d=p.audit_original_config(self.original(),self.card())
        self.assertIn('TBD',d['weights_licence']);self.assertIn('does not license model',d['weights_licence'])
    def test_wrong_speaker_or_frontend_contract_is_rejected(self):
        for change in ({'num_speakers':1},{'espeak':{'voice':'tdt'}},{'language':{'code':'tet'}}):
            with self.subTest(change=change),self.assertRaises(ValueError):p.audit_original_config({**self.original(),**change},self.card())
    def test_existing_output_and_source_collision_cannot_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            f=Path(directory)/'report.json';f.write_bytes(b'original')
            with self.assertRaises(FileExistsError):p.write_json(f,{'synthetic':True})
            self.assertEqual(f.read_bytes(),b'original')
            with self.assertRaises(ValueError):p.checked_output(f,[f])
    def test_exact_model_bytes_are_required_before_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            f=Path(directory)/'model.onnx';f.write_bytes(b'synthetic metadata-only fixture')
            with self.assertRaises(ValueError):p.check_file(f,p.FILES['tdt_TL-joao-medium.onnx'])
    @unittest.skipUnless(os.environ.get('TETUN_JOAO_ACTUAL_CONFIG'),'Actual pinned config supplied to isolated ML validation')
    def test_original_piper_token_ids_match_our_strict_existing_only_encoder(self):
        from piper import PiperConfig,PiperVoice
        config=json.loads(Path(os.environ['TETUN_JOAO_ACTUAL_CONFIG']).read_text(encoding='utf-8'))
        voice=PiperVoice(config=PiperConfig.from_dict(config),session=None)
        for entry in n.facts()['entries']:
            w=n.word(entry['annotated_word'])
            self.assertEqual(n.token_ids(w,config),voice.phonemes_to_ids(list(w.phone_tokens)))

if __name__=='__main__':unittest.main()
