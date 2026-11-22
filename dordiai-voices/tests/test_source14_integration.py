"""Source14 exact-resource and functional-scope contracts; no acoustic claim."""
import ast
import copy
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('source14_test',ROOT/'tools/research/source14_integration.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


def inventories():
    before={name:{'size_bytes':1,'sha256':'a'*64} for name in m.ALLOWED_CHANGES}
    for i in range(180):before[f'kx47Runtime/models/voices/native_letters/bank{i}.pcm']={'size_bytes':2,'sha256':'a'*64}
    for i in range(8511-180):before[f'kx47Runtime/models/fixture{i}.bin']={'size_bytes':3,'sha256':'a'*64}
    for i in range(1596):before[f'kx47Runtime/python/private{i}.bin']={'size_bytes':4,'sha256':'a'*64}
    old={'version':m.BASE_VERSION,'voice_ids':['voice'+str(i) for i in range(45)],
         'excluded_voice_ids':sorted(m.EXCLUDED),'files':before}
    new=copy.deepcopy(old);new['version']=m.VERSION
    for name in m.ALLOWED_CHANGES:new['files'][name]={'size_bytes':2,'sha256':'b'*64}
    old['files'][m.DRIVER_PATH]={'size_bytes':m.DRIVER13_BYTES,'sha256':m.DRIVER13_SHA256}
    new['files'][m.DRIVER_PATH]={'size_bytes':m.DRIVER13_BYTES+18,'sha256':m.DRIVER64_SHA256}
    return old,new


class Preservation(unittest.TestCase):
    def test_exact_five_changes_preserve_every_resource_and_identity(self):
        old,new=inventories();r=m.verify_preservation(old,new)
        self.assertEqual(r['model_identity_files_byte_identical'],8511)
        self.assertEqual(r['prepared_bank_files_byte_identical'],180)
        self.assertEqual(r['private_runtime_files_byte_identical'],1596)
        self.assertEqual(set(r['changed_files']),m.ALLOWED_CHANGES)

    def test_modified_model_bank_and_private_runtime_are_rejected(self):
        for name in ('kx47Runtime/models/fixture0.bin','kx47Runtime/models/voices/native_letters/bank0.pcm','kx47Runtime/python/private0.bin'):
            old,new=inventories();new['files'][name]['sha256']='c'*64
            with self.subTest(name=name),self.assertRaises(ValueError):m.verify_preservation(old,new)

    def test_extra_and_missing_files_are_rejected_even_if_not_acoustic(self):
        for extra in (True,False):
            old,new=inventories()
            if extra:new['files']['doc/hidden-new.txt']={'size_bytes':1,'sha256':'a'*64}
            else:del new['files']['kx47Runtime/models/fixture0.bin']
            with self.subTest(extra=extra),self.assertRaises(ValueError):m.verify_preservation(old,new)

    def test_noop_runtime_patch_does_not_claim_exact_reviewed_source14(self):
        old,new=inventories();name='kx47Runtime/wide_warmup.py';new['files'][name]=old['files'][name]
        with self.assertRaises(ValueError):m.verify_preservation(old,new)

    def test_unreviewed_driver_sha_cannot_hide_inside_allowed_changed_path(self):
        old,new=inventories();new['files'][m.DRIVER_PATH]['sha256']='c'*64
        with self.assertRaises(ValueError):m.verify_preservation(old,new)

    def test_wrong_input_or_output_version_rejected(self):
        for which in ('old','new'):
            old,new=inventories();(old if which=='old' else new)['version']='0.13.1-dev.12'
            with self.subTest(which=which),self.assertRaises(ValueError):m.verify_preservation(old,new)

    def test_excluded_or_different_voice_and_duplicate_identity_rejected(self):
        for change in ('excluded','different','duplicate','exclusions'):
            old,new=inventories()
            if change=='excluded':new['voice_ids'][0]='kostia'
            elif change=='different':new['voice_ids'][0]='unapproved'
            elif change=='duplicate':new['voice_ids'][0]=new['voice_ids'][1]
            else:new['excluded_voice_ids'].remove('inna')
            with self.subTest(change=change),self.assertRaises(ValueError):m.verify_preservation(old,new)

    def test_baseline_count_change_cannot_be_hidden_in_matching_output(self):
        old,new=inventories();name='kx47Runtime/models/fixture0.bin'
        del old['files'][name];del new['files'][name]
        with self.assertRaises(ValueError):m.verify_preservation(old,new)


class Inputs(unittest.TestCase):
    def test_actual_source13_pin_and_frozen_extract_helpers(self):
        self.assertEqual(m.read_pin(ROOT/'tools/data/source13_build_pin.json')['archive_sha256'],m.CORE_SHA256)
        self.assertTrue(callable(m.source13().extract_release))

    def test_source14_manifest_rejects_old_and_duplicate_versions(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'manifest.ini'
            for content in ('version="0.13.1-dev.13"\n','version="'+m.VERSION+'"\nversion="'+m.VERSION+'"\n'):
                path.write_text(content,encoding='utf-8')
                with self.assertRaises(ValueError):m.check_source_version(Path(d))
            path.write_text('version="'+m.VERSION+'"\n',encoding='utf-8')
            self.assertEqual(m.check_source_version(Path(d)),m.VERSION)

    def test_changed_completed_archive_pin_is_rejected(self):
        pin=json.loads((ROOT/'tools/data/source13_build_pin.json').read_bytes())
        with tempfile.TemporaryDirectory() as d:
            for field,value in (('archive_bytes',1),('archive_sha256','0'*64),('version',m.VERSION),('source_commit','0'*40)):
                bad=dict(pin);bad[field]=value;path=Path(d)/'pin.json';path.write_text(json.dumps(bad),encoding='utf-8')
                with self.subTest(field=field),self.assertRaises(ValueError):m.read_pin(path)

    def test_dirty_source_is_not_attributed_to_existing_commit(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d);manifest=source/'manifest.ini';manifest.write_text('version="'+m.VERSION+'"\n',encoding='utf-8')
            builder=SimpleNamespace(_source_files=lambda p:{'manifest.ini':manifest})
            with patch.dict(os.environ,{},clear=True),patch.object(m.subprocess,'run',side_effect=[
                    SimpleNamespace(stdout='a'*40+'\n'),SimpleNamespace(stdout=' M source/manifest.ini\n')]):
                r=m.source_provenance(source,builder)
            self.assertIsNone(r['source_commit']);self.assertEqual(r['source_tree_base_commit'],'a'*40)
            self.assertFalse(r['source_inputs_committed_and_clean'])
            self.assertEqual(r['source_files']['manifest.ini']['sha256'],sha256(manifest.read_bytes()).hexdigest())

    def test_ci_source_commit_cannot_differ_from_real_checkout(self):
        with tempfile.TemporaryDirectory() as d:
            builder=SimpleNamespace(_source_files=lambda p:{})
            with patch.dict(os.environ,{'GITHUB_SHA':'b'*40}),patch.object(m.subprocess,'run',side_effect=[
                    SimpleNamespace(stdout='a'*40+'\n'),SimpleNamespace(stdout='')]):
                with self.assertRaises(ValueError):m.source_provenance(Path(d),builder)

    def test_effective_builder_bytes_must_match_outside_five_reviewed_paths(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);old={'files':{name:{'size_bytes':1,'sha256':sha256(b'a').hexdigest()} for name in m.ALLOWED_CHANGES}}
            old['files']['kx47Runtime/models/voice.json']={'size_bytes':1,'sha256':sha256(b'a').hexdigest()}
            rows=[SimpleNamespace(path=name,transformed=b'b',source=None) for name in m.ALLOWED_CHANGES]
            rows.append(SimpleNamespace(path='kx47Runtime/models/voice.json',transformed=b'a',source=None))
            builder=SimpleNamespace(collect_inputs=lambda *a,**kw:(rows,[]))
            self.assertEqual(set(m.verify_source_overlay(builder,root,root/'empty1',old)),m.ALLOWED_CHANGES)
            rows[-1].transformed=b'changed model'
            with self.assertRaises(ValueError):m.verify_source_overlay(builder,root,root/'empty2',old)
            rows[-1].path='kx47Runtime/models/extra.json'
            with self.assertRaises(ValueError):m.verify_source_overlay(builder,root,root/'empty3',old)


class DriverCandidate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw=(ROOT/'source/0.12.2/synthDrivers/kx47Preview.py').read_bytes()
        if sha256(raw).hexdigest()==m.DRIVER13_SHA256:
            cls.original=raw
            cls.candidate=raw.replace(b'short_reserve=short_reserve',b'pending_count=64, short_reserve=short_reserve',1)
        else:
            cls.candidate=raw;cls.original=raw.replace(b'pending_count=64, ',b'',1)
        if sha256(cls.original).hexdigest()!=m.DRIVER13_SHA256 or sha256(cls.candidate).hexdigest()!=m.DRIVER64_SHA256:
            raise AssertionError('Repository driver no longer matches exact immutable13/tested outer64 pair')

    def test_actual_pinned_driver_only_adds_outer64_without_startup_reserve(self):
        r=m.verify_driver_change(self.original,self.candidate)
        self.assertTrue(r['only_outer_keyword_ast_difference_verified'])
        self.assertTrue(r['all_non_insertion_bytes_identical'])
        self.assertEqual(r['original_helper_default_unchanged'],12)
        self.assertEqual(r['explicit_inner_counts_unchanged'],[2])
        self.assertTrue(r['generation_and_cancellation_unchanged'])
        self.assertTrue(r['first_ready_delivery_helper_ast_unchanged'])
        self.assertEqual(r['maximum_outer_queued_pcm_bytes'],30720)
        self.assertFalse(r['startup_reserve_or_word_warmup_added'])
        self.assertFalse(r['source14_waveform_or_cancel_acceptance_proved'])

    def test_wrong_outer_count_default_inner_cancel_or_reserve_change_rejected(self):
        pairs=((b'pending_count=64, ',b'pending_count=32, '),
               (b'pending_count=12',b'pending_count=24'),
               (b'pending_count=2)',b'pending_count=3)'),
               (b'generation != self._generation',b'generation == self._generation'),
               (b'short_reserve=False',b'short_reserve=True'))
        for before,after in pairs:
            bad=self.candidate.replace(before,after,1)
            self.assertNotEqual(bad,self.candidate,'Negative fixture did not alter a real driver contract')
            with self.subTest(token=before),self.assertRaises(ValueError):m.verify_driver_change(self.original,bad)

    def test_even_ast_equivalent_comment_or_line_ending_changes_rejected(self):
        for bad in (self.candidate+b'\n# unreviewed\n',self.candidate.replace(b'\n',b'\r\n')):
            with self.assertRaises(ValueError):m.verify_driver_change(self.original,bad)
        with self.assertRaises(ValueError):m.verify_driver_change(self.original+b'\n',self.candidate)


def nvda_receipt(typing):
    required={'select_dordiai','allowed_voice_catalog','fresh_default_languages'}|(
        {'actual_typing_keyboard_pipeline','actual_typing_language_routes','actual_typing_cleanup'} if typing else {
        'settings_dialog','settings_hotkey_binding','keyboard_tab','keyboard_checkbox_space','phrase_pcm_submission','character_pcm_submission'})
    flags={'physical_audio_verified':False,'acoustic_latency_verified':False,'product_ready':False,'recording_pcm_sink_test_double':True}
    return dict(flags,addon_sha256='a'*64,status='partial',checks=[{'name':'windows_audio_output_enumeration','status':'blocked'}],
                probe=dict(flags,status='partial',nvda_version_actual='2026.3.1',checks=[{'name':n,'status':'passed'} for n in required]+
                           [{'name':'physical_audio_output','status':'blocked'}]))


class FunctionalScope(unittest.TestCase):
    def test_headless_functional_success_never_implies_device_acceptance(self):
        for typing in (False,True):
            r=m.validate_nvda_functional(nvda_receipt(typing),typing=typing,addon_sha256='a'*64)
            self.assertIn('not physical',r['scope'])

    def test_required_typing_or_menu_blocked_failed_missing_is_not_partial_success(self):
        for typing,name in ((False,'keyboard_tab'),(True,'actual_typing_language_routes')):
            for status in ('blocked','failed','missing'):
                r=nvda_receipt(typing)
                if status=='missing':r['probe']['checks']=[v for v in r['probe']['checks'] if v['name']!=name]
                else:next(v for v in r['probe']['checks'] if v['name']==name)['status']=status
                with self.subTest(typing=typing,status=status),self.assertRaises(ValueError):m.validate_nvda_functional(r,typing=typing,addon_sha256='a'*64)

    def test_unknown_blocker_wrong_package_or_physical_claim_is_rejected(self):
        for kind in ('unknown_blocker','wrong_package','physical_claim','non_headless'):
            r=nvda_receipt(False)
            if kind=='unknown_blocker':r['probe']['checks'].append({'name':'unexpected_model_failure','status':'blocked'})
            elif kind=='wrong_package':r['addon_sha256']='b'*64
            elif kind=='physical_claim':r['probe']['physical_audio_verified']=True
            else:r['probe']['recording_pcm_sink_test_double']=False
            with self.subTest(kind=kind),self.assertRaises(ValueError):m.validate_nvda_functional(r,typing=False,addon_sha256='a'*64)

    def test_worker_job_uses_only_exact_executable_and_forced_cleanup_fails(self):
        calls=[];job=SimpleNamespace(handle=1,assign_and_resume=lambda p:calls.append('assigned'))
        job.finish=lambda **kw:{'active_after_cleanup':0,'forced_tree_termination':True,'all_owned_workers_reaped':True}
        child=SimpleNamespace(pid=3,returncode=0,wait=lambda **kw:None)
        owner=m.OwnedWorkerProcesses(Path('owned-python.exe'),lambda:job)
        def popen(command,**kw):self.assertEqual(kw['creationflags']&4,4);calls.append('suspended');return child
        with patch.object(m.subprocess,'Popen',side_effect=popen):owner.Popen(['owned-python.exe'])
        self.assertEqual(calls,['suspended','assigned'])
        report=owner.reap();self.assertTrue(report['all_owned_workers_reaped']);self.assertFalse(report['normal_shutdown_verified'])
        with self.assertRaises(ValueError):owner.Popen(['unrelated-python.exe'])


class Workflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.source=(ROOT.parent/'.github/workflows/dordiai-source14-integration.yml').read_text(encoding='utf-8')
    def test_pinned_host_baseline_full_tests_and_same14_functional_steps(self):
        for text in ("python-version: '3.13.9'",'numpy==2.3.5','python -m unittest discover -s dordiai-voices/tests -v',
                     'name: dordiai-source13-development-core-45049806570','run-id: 45049806570',
                     'source14_integration.py build','source14_integration.py worker','source14_integration.py nvda',
                     'Remove-NetFirewallRule -Name $name','restored=($remaining.Count -eq 0)','[source14-build]'):
            self.assertIn(text,self.source)
        self.assertNotIn('continue-on-error: true',self.source)
        self.assertNotIn('character-name-pins',self.source)
        self.assertNotIn('afri-packs',self.source)
        self.assertNotIn('prepared-bank-overlay',self.source)
        self.assertLess(self.source.index('m.check_source_version'),self.source.index('uses: actions/download-artifact'))
    def test_all_python_workflow_blocks_compile(self):
        count=0
        for step in self.source.split('      - '):
            if '        shell: python\n' not in step or '        run: |\n' not in step:continue
            lines=[]
            for line in step.split('        run: |\n',1)[1].splitlines(True):
                if line.strip() and not line.startswith('          '):break
                lines.append(line[10:] if line.startswith('          ') else line)
            ast.parse(''.join(lines));count+=1
        self.assertEqual(count,4)


if __name__=='__main__':unittest.main()
