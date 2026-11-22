"""Metadata/output guard tests; no fixture pretends to be native acoustic proof."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('hiri_probe_tests',ROOT/'tools/research/probe_hiri_motu_frontend.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class SafeResearchProbeTests(unittest.TestCase):
    def test_wrong_raw_primary_pdf_cannot_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'false.pdf';p.write_bytes(b'%PDF-synthetic unit fixture')
            with self.assertRaisesRegex(ValueError,'primary PDF differs'):m.prepare_probe(p,p)
    def test_source_and_output_collision_is_rejected_without_mutating_input(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'primary.pdf';p.write_bytes(b'original primary input')
            with self.assertRaises(ValueError):m.write_report(p,{'synthetic':True},[p])
            self.assertEqual(p.read_bytes(),b'original primary input')
    def test_existing_report_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'report.json';p.write_bytes(b'original')
            with self.assertRaises(FileExistsError):m.write_report(p,{'synthetic':True},[])
            self.assertEqual(p.read_bytes(),b'original')
    def test_production_source_output_is_rejected(self):
        with self.assertRaises(ValueError):m.safe_output(ROOT/'source'/'hiri.json',[])
    def test_report_has_real_sha_and_atomic_no_clobber_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'report.json';value={'synthetic_metadata_only':True,'native_audio_verified':False}
            observed=m.write_report(p,value,[])
            self.assertEqual(m.fingerprint(p),observed)
            self.assertEqual(json.loads(p.read_text(encoding='utf-8')),value)
            self.assertFalse(list(Path(directory).glob('hiri-phonology-*')))
    def test_concurrent_writer_keeps_its_existing_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'report.json'
            def collide(temp,target):
                Path(target).write_bytes(b'other writer')
                raise FileExistsError('Race intentionally simulated')
            with patch.object(m.os,'link',collide):
                with self.assertRaises(FileExistsError):m.write_report(p,{'synthetic':True},[])
            self.assertEqual(p.read_bytes(),b'other writer')
            self.assertFalse(list(Path(directory).glob('hiri-phonology-*')))
    def test_linked_output_parent_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);actual=root/'real';actual.mkdir()
            try:(root/'linked').symlink_to(actual,target_is_directory=True)
            except OSError:self.skipTest('Symlinks unavailable to this unit process')
            with self.assertRaises(ValueError):m.safe_output(root/'linked'/'report.json',[])
    @unittest.skipUnless(os.environ.get('HMO_D24_SOURCE') and os.environ.get('HMO_C40_SOURCE'),
                         'Actual pinned primary PDFs supplied to dedicated research proof')
    def test_actual_primary_bytes_and_semantic_gates_not_acoustic_acceptance(self):
        report=m.prepare_probe(os.environ['HMO_D24_SOURCE'],os.environ['HMO_C40_SOURCE'])
        self.assertEqual(report['curated_stress_form_count'],26)
        self.assertEqual(report['strict_semantic_primary_golden_count'],15)
        self.assertTrue(report['all_native_name_requests_rejected'])
        self.assertTrue(report['no_foreign_acoustic_engine_invoked'])
        self.assertFalse(report['product_integrated']);self.assertFalse(report['acoustic_pronunciation_verified'])
        self.assertFalse(report['source_embedding_prepared']);self.assertFalse(report['selected_profile_projection_verified'])
        self.assertEqual(report['language_inventory_increment'],0)
        self.assertIn('gʷ',report['required_semantic_phone_inventory'])

if __name__=='__main__':unittest.main()
