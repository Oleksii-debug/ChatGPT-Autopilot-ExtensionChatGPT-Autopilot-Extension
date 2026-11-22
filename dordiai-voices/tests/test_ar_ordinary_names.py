"""Source facts, original UnicodeProcessor no-drop validation, honest PCM rate."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import unicodedata
import wave
from unittest.mock import patch

ROOT=Path(os.environ.get('DORDIAI_PROJECT_ROOT',Path(__file__).resolve().parents[1]))
PACKET=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
p=load('_ar29_probe_test',PACKET/'tools/research/probe_ar_ordinary_names.py')
CANDIDATE=PACKET/'tools/research/ar_ordinary_name_candidate.json'

class ArabicOrdinaryNames(unittest.TestCase):
    def test_exact29_source_names_not_sound_values_and_no_form_aliases(self):
        d=p.candidate(CANDIDATE);self.assertEqual(len(d['letter_names']),29)
        self.assertEqual(d['letter_names']['ل'],'لام');self.assertEqual(d['letter_names']['ء'],'همزة')
        self.assertEqual(d['letter_names']['ا'],'ألف')
        for glyph in ['أ','إ','ؤ','ئ','ة','ى','ـ']:self.assertNotIn(glyph,d['letter_names'])
        self.assertTrue(d['readiness']['source_facts_verified'])
        self.assertTrue(all(v is False for k,v in d['readiness'].items() if k!='source_facts_verified'))
    def test_changed_fact_deleted_name_different_language_or_quality_rejected(self):
        d=json.loads(CANDIDATE.read_text())
        for key in ['fact','deleted','language','quality']:
            v=json.loads(json.dumps(d))
            if key=='fact':v['letter_names']['ل']='a spelling example'
            elif key=='deleted':del v['letter_names']['ء']
            elif key=='language':v['language']='fa'
            else:v['readiness']['typing_verified']=True
            with tempfile.TemporaryDirectory() as tmp:
                bad=Path(tmp)/'bad.json';bad.write_text(json.dumps(v,ensure_ascii=False))
                with self.subTest(key=key),self.assertRaises(ValueError):p.candidate(bad)
    def processor(self,indexer):
        import numpy as np,re
        source=(ROOT/'source/0.12.2/kx47Runtime/wide_common_helpers.py').read_text()
        tree=ast.parse(source);nodes=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='UnicodeProcessor' or isinstance(n,ast.FunctionDef) and n.name=='length_to_mask']
        scope={'json':json,'np':np,'re':re,'normalize':unicodedata.normalize,'category':unicodedata.category,'AVAILABLE_LANGS':['ar'],'Optional':__import__('typing').Optional}
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'<exact-original-UnicodeProcessor>', 'exec'),scope)
        proc=object.__new__(scope['UnicodeProcessor']);proc.indexer=indexer;proc.append_terminal_period=False;return proc
    def indexer(self):
        names=p.candidate(CANDIDATE)['letter_names'];chars=unicodedata.normalize('NFKD',''.join(names.values()))+'<ar></ar>'
        indexer=[-1]*(max(map(ord,chars))+1)
        for c in chars:indexer[ord(c)]=ord(c)
        return indexer
    def test_all29_prevalidated_through_exact_original_nfkd_and_language_marker(self):
        names=p.candidate(CANDIDATE)['letter_names'];prepared=p.validate_names(self.processor(self.indexer()),names)
        self.assertEqual(len(prepared),29)
        self.assertEqual(prepared['ا']['nfkd_text'],'ا\u0654لف')
        self.assertTrue(all(r['marked_text'].startswith('<ar>') and r['marked_text'].endswith('</ar>') for r in prepared.values()))
    def test_original_silent_dropping_letter_or_combining_hamza_is_rejected_before_inference(self):
        names=p.candidate(CANDIDATE)['letter_names']
        for char in ['ب','\u0654']:
            indexer=self.indexer();indexer[ord(char)]=-1
            with self.subTest(char=char),self.assertRaisesRegex(ValueError,'change/drop'):
                p.validate_names(self.processor(indexer),names)
    def test_wrong_native_conditioning_marker_rejected(self):
        proc=self.processor(self.indexer());original=proc._preprocess_text
        proc._preprocess_text=lambda name,language:original(name,language).replace('ar>','fa>')
        with self.assertRaisesRegex(ValueError,'unexpectedly changed'):
            p.validate_names(proc,p.candidate(CANDIDATE)['letter_names'])
    def test_original_common_pcm_writer_22050_duration_and_no_silent_or_nan_files(self):
        import numpy as np
        common=load('_ar29_existing_pcm_helper',ROOT/'tools/research/ordinary_name_pcm_probe.py')
        audio=(np.sin(2*np.pi*440*np.arange(22050)/22050)*.1).astype(np.float32)
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'actual-rate.wav';r=common.save_wave(output,audio,22050,np)
            with wave.open(str(output)) as wav:self.assertEqual((wav.getframerate(),wav.getnframes()),(22050,22050))
            self.assertEqual(r['audio_seconds'],1.)
            for bad in [np.zeros(100),np.array([float('nan')])]:
                path=Path(tmp)/'bad.wav'
                with self.assertRaises(ValueError):common.save_wave(path,bad,22050,np)
                self.assertFalse(path.exists())
    def test_offline_guard_keeps_dns_socket_http_blocked_while_local_hostname_allowed(self):
        common=load('_ar29_existing_offline_helper',ROOT/'tools/research/ordinary_name_pcm_probe.py')
        common.deny_network_event('socket.gethostname',())
        for e in ['socket.__new__','socket.connect','socket.getaddrinfo','socket.sendto','http.client.connect','urllib.Request']:
            with self.subTest(event=e),self.assertRaises(RuntimeError):common.deny_network_event(e,())
if __name__=='__main__':unittest.main()
