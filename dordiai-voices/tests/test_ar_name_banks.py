"""The recipe is synthetic here; actual model audio is checked only by CI probe."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import sys
from types import SimpleNamespace
from unittest.mock import patch

HERE=Path(__file__).resolve().parents[1]
ROOT=Path(os.environ.get('DORDIAI_PROJECT_ROOT',HERE))
def load(name,path):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
recipe=load('_ar_bank_recipe_test',HERE/'tools/research/ar_name_bank_recipe.py')
bankmod=load('_ar_bank_existing_reader',ROOT/'source/0.12.2/synthDrivers/_dordiai_letter_bank.py')

class OptionalNameBanks(unittest.TestCase):
    def make(self,root):
        directory=Path(root)/'banks/ar';target=Path(root)/'viktoriia.npy';target.write_bytes(b'synthetic target identity, NOT a model')
        clips=[('ا','ألف',b'\x01\x00'*240),('ء','همزة',b'\x02\x00'*300)]
        row=recipe.new_bank(directory,'viktoriia',clips);row['target_identity']={'size_bytes':target.stat().st_size,'sha256':recipe.digest(target)}
        raw=bankmod.NativeLetterBank(directory.parent,'ar');bound=recipe.BoundReader(raw,directory,{'viktoriia':row},lambda profile:target)
        return row,target,bound
    def test_existing_reader_consumes_exact_ar_char_keys_without_old_banks(self):
        with tempfile.TemporaryDirectory() as tmp:
            row,target,reader=self.make(tmp)
            self.assertEqual(reader.read('viktoriia','ar-char','ا'),b'\x01\x00'*240)
            self.assertEqual(reader.read('viktoriia','ar-char','ء'),b'\x02\x00'*300)
            self.assertEqual(row['sample_rate'],24000)
            for lang,glyph in [('ar-text','ا'),('ru-char','ا'),('ar-char','أ'),('ar-char','ألف')]:self.assertIsNone(reader.read('viktoriia',lang,glyph))
            self.assertIsNone(reader.read('oksana','ar-char','ا'))
    def test_target_replacement_invalidates_previously_cached_binding(self):
        with tempfile.TemporaryDirectory() as tmp:
            row,target,reader=self.make(tmp);reader.read('viktoriia','ar-char','ا')
            replacement=target.with_suffix('.new');replacement.write_bytes(b'X'*target.stat().st_size);replacement.replace(target)
            with self.assertRaisesRegex(ValueError,'checksum'):reader.read('viktoriia','ar-char','ا')
    def test_bank_audio_replacement_invalidates_previous_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            row,target,reader=self.make(tmp);reader.read('viktoriia','ar-char','ا')
            audio=Path(tmp)/'banks/ar/viktoriia.pcm';audio.write_bytes(b'\x03\x00'*(audio.stat().st_size//2))
            with self.assertRaisesRegex(ValueError,'checksum'):reader.read('viktoriia','ar-char','ا')
    def test_replacement_during_pcm_read_is_rejected_before_return(self):
        with tempfile.TemporaryDirectory() as tmp:
            row,target,reader=self.make(tmp);original=reader.reader.read
            def replacing_read(*args):
                audio=Path(tmp)/'banks/ar/viktoriia.pcm'
                audio.write_bytes(b'\x03\x00'*(audio.stat().st_size//2))
                return original(*args)
            reader.reader.read=replacing_read
            with self.assertRaisesRegex(ValueError,'checksum'):reader.read('viktoriia','ar-char','ا')
    def test_append_only_refuses_even_same_profile_existing_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            row,target,reader=self.make(tmp);p=Path(tmp)/'banks/ar/viktoriia.pcm';before=p.read_bytes()
            with self.assertRaises(FileExistsError):recipe.new_bank(p.parent,'viktoriia',[('ب','باء',b'\x03\x00'*20)])
            self.assertEqual(p.read_bytes(),before)
    def test_rate_alignment_silence_duplicate_and_blocked_profile_rejected(self):
        for pcm in [b'',b'\x01',b'\0\0',b'\x01\0'*(24000*8+1)]:
            with self.subTest(size=len(pcm)),self.assertRaises(ValueError):recipe.validate_pcm(pcm)
        for profile in [*recipe.EXCLUDED,'../viktoriia','viktoriia:mode','']:
            with self.subTest(profile=profile),self.assertRaises(ValueError):recipe.validate_profile(profile)
        with tempfile.TemporaryDirectory() as tmp,self.assertRaisesRegex(ValueError,'Duplicate'):
            recipe.new_bank(Path(tmp),'viktoriia',[('ا','ألف',b'\x01\0'),('ا','ألف',b'\x01\0')])
    def test_role_path_escape_and_wrong_profile_are_rejected_before_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            row,target,reader=self.make(tmp)
            for field,value in [('profile','oksana'),('sample_rate',22050),('index',row['index']|{'name':'../escape.json'})]:
                bad=row|{field:value}
                with self.subTest(field=field),self.assertRaises(ValueError):recipe.BoundReader(reader.reader,reader.directory,{'viktoriia':bad},lambda profile:target)
    def test_exact_driver_prepared_methods_consume_synthetic_bank_without_model_or_subprocess(self):
        # This is ONLY a synthetic host semantic regression. Actual native PCM,
        # private ORT and complete original-byte proof belong to the CI probe.
        import numpy as np
        probe=load('_ar_bank_actual_method_semantics',HERE/'tools/research/probe_ar_name_banks.py')
        with tempfile.TemporaryDirectory() as tmp,patch.dict(sys.modules,{'onnxruntime':SimpleNamespace(InferenceSession=lambda *a,**k:None)}):
            root=Path(tmp);row,target,reader=self.make(root)
            original=list(sys.path);sys.path[:0]=[str(ROOT/'source/0.12.2/kx47Runtime'),str(ROOT/'source/0.12.2')]
            try:
                evidence=probe.lookup_proof(ROOT/'source/0.12.2/kx47Runtime',root,{'viktoriia':row},{'viktoriia':target},np)
            finally:sys.path[:]=original
            self.assertEqual(len(evidence['lookups']),2)
            self.assertTrue(evidence['resource_epoch_stale_rejected'])
            self.assertTrue(evidence['model_creation_and_subprocess_forbidden'])
    def test_existing_hash_schema_distinguishes_letters_words_and_locales(self):
        self.assertEqual(recipe.key('ar-char','ا'),bankmod.bank_key('ar-char','ا'))
        self.assertNotEqual(recipe.key('ar-char','ا'),recipe.key('ar-text','ا'))
        self.assertNotEqual(recipe.key('ar-char','ا'),recipe.key('ar-char','ء'))
        self.assertNotEqual(recipe.key('ar-char','و'),recipe.key('ar-char','واو'))
if __name__=='__main__':unittest.main()
