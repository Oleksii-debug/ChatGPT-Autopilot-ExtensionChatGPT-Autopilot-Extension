"""Meaningful source/glyph/identity and honest PCM-rate regression checks."""
from pathlib import Path
import importlib.util
import json
import tempfile
import unittest
import wave

HERE=Path(__file__).resolve().parent
TOOL=HERE/'probe_ay_ordinary_names.py'
if not TOOL.is_file():TOOL=HERE.parent/'tools/research/probe_ay_ordinary_names.py'
spec=importlib.util.spec_from_file_location('ay_name_probe_test',TOOL)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
CANDIDATE=TOOL.with_name('ay_ordinary_name_candidate.json')

class SourceFacts(unittest.TestCase):
    def test_full32_names_include_confirmed_aspirate_and_explicit_long_names(self):
        value=m.names_candidate(CANDIDATE)
        self.assertEqual(len(value['letter_names']),32)
        self.assertEqual(value['letter_names']['qh'],'qha')
        self.assertNotEqual(value['letter_names']['qh'],value['letter_names']['q'])
        self.assertEqual([value['letter_names'][k] for k in 'äïü'],['aa','ii','uu'])
        self.assertFalse(value['letter_names_ready'])
        self.assertIn('Printed page12',value['primary_corroboration']['location'])
    def test_unreviewed_mapping_source_or_acceptance_changes_rejected(self):
        original=json.loads(CANDIDATE.read_text(encoding='utf-8'))
        for change in ('qh','other-name','source','quality'):
            value=json.loads(json.dumps(original))
            if change=='qh':del value['letter_names']['qh']
            elif change=='other-name':value['letter_names']['q']='qha'
            elif change=='source':value['primary_corroboration']['sha256']='0'*64
            else:value['native_pronunciation_verified']=True
            with self.subTest(change=change),tempfile.TemporaryDirectory() as tmp:
                file=Path(tmp)/'changed.json';file.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')
                with self.assertRaises(ValueError):m.names_candidate(file)
    def test_candidate_has_no_production_acceptance(self):
        value=m.names_candidate(CANDIDATE)
        self.assertTrue(all(value[k] is False for k in m.FALSE_FLAGS))
        self.assertEqual(value['semantic_role'],'ordinary_letter_name')

class PCMRate(unittest.TestCase):
    def test_projected22050_roundtrip_preserves_duration(self):
        import numpy as np
        audio=np.sin(2*np.pi*440*np.arange(22050)/22050).astype(np.float32)*.1
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'projection.wav';facts=m.save_wave(p,audio,22050,np)
            with wave.open(str(p),'rb') as f:
                self.assertEqual(f.getframerate(),22050);self.assertEqual(f.getnframes(),22050)
            self.assertEqual(facts['audio_seconds'],1.)
    def test_nonfinite_or_silent_pcm_rejected_before_writing(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as tmp:
            for a in (np.zeros(8),np.array([1.,float('nan')]),np.array([])):
                with self.assertRaises(ValueError):m.save_wave(Path(tmp)/'bad.wav',a,16000,np)
            self.assertFalse((Path(tmp)/'bad.wav').exists())
if __name__=='__main__':unittest.main()
