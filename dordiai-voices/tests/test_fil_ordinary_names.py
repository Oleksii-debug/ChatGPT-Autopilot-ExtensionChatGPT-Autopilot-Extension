"""Exact primary28-name scope and shared PCM proof regression checks."""
from pathlib import Path
import importlib.util
import json
import tempfile
import unittest
import wave
HERE=Path(__file__).resolve().parent
TOOL=HERE/'probe_fil_ordinary_names.py'
if not TOOL.is_file():TOOL=HERE.parent/'tools/research/probe_fil_ordinary_names.py'
spec=importlib.util.spec_from_file_location('fil_name_probe_test',TOOL)
probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
m=probe.common;D=probe.DEFINITION
CANDIDATE=TOOL.with_name('fil_ordinary_name_candidate.json')

class SourceFacts(unittest.TestCase):
    def test_full28_ng_is_one_named_letter_not_two_raw_glyphs(self):
        value=m.names_candidate(CANDIDATE,D)
        self.assertEqual(len(value['letter_names']),28)
        self.assertEqual(value['letter_names']['ng'],'en dyi')
        self.assertEqual(value['letter_names']['j'],'dyey')
        self.assertEqual(value['letter_names']['ñ'],'enye')
        self.assertEqual(value['letter_names']['b'],'bi')
        self.assertNotEqual(value['letter_names']['b'],'ba')
        self.assertEqual(D['iso'],'tgl')
        self.assertIn('Printed page9',value['primary_corroboration']['location'])
    def test_changed_fact_other_language_and_acceptance_rejected(self):
        original=json.loads(CANDIDATE.read_text(encoding='utf-8'))
        for change in ('ng','historical-abakada','wrong-language','quality'):
            value=json.loads(json.dumps(original))
            if change=='ng':del value['letter_names']['ng']
            elif change=='historical-abakada':value['letter_names']['b']='ba'
            elif change=='wrong-language':value['iso_code']='eng'
            else:value['letter_names_ready']=True
            with self.subTest(change=change),tempfile.TemporaryDirectory() as tmp:
                file=Path(tmp)/'bad.json';file.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')
                with self.assertRaises(ValueError):m.names_candidate(file,D)
    def test_all_flags_remain_unaccepted_despite_full_source_table(self):
        value=m.names_candidate(CANDIDATE,D)
        self.assertTrue(all(value[k] is False for k in m.FALSE_FLAGS))
        self.assertEqual(value['semantic_role'],'ordinary_letter_name')
    def test_same_shared_engine_spec_rejects_other_candidate_file(self):
        other=dict(D,code='ay',iso='ayr')
        with self.assertRaises(ValueError):m.names_candidate(CANDIDATE,other)

class OfflineAudit(unittest.TestCase):
    def test_local_hostname_permitted_but_socket_dns_and_http_stay_blocked(self):
        m.deny_network_event('socket.gethostname',())
        m.deny_network_event('import',('onnxruntime',))
        for event in ('socket.__new__','socket.connect','socket.sendto','socket.getaddrinfo',
                      'socket.gethostbyname','socket.gethostbyaddr','http.client.connect','urllib.Request'):
            with self.subTest(event=event),self.assertRaises(RuntimeError):
                m.deny_network_event(event,())

class PCMRate(unittest.TestCase):
    def test_projected22050_roundtrip_and_nonfinite_rejection(self):
        import numpy as np
        audio=np.sin(2*np.pi*440*np.arange(22050)/22050).astype(np.float32)*.1
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'projection.wav';facts=m.save_wave(p,audio,22050,np)
            with wave.open(str(p),'rb') as f:
                self.assertEqual(f.getframerate(),22050);self.assertEqual(f.getnframes(),22050)
            self.assertEqual(facts['audio_seconds'],1.)
            with self.assertRaises(ValueError):m.save_wave(Path(tmp)/'bad.wav',np.array([float('nan')]),22050,np)
            self.assertFalse((Path(tmp)/'bad.wav').exists())
if __name__=='__main__':unittest.main()
