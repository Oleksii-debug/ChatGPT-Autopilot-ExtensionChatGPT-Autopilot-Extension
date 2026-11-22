"""Controller safety tests, without loading models or opening NVDA."""
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock,patch
import zipfile

SPEC=importlib.util.spec_from_file_location('memory14_controller',Path(__file__).resolve().parents[1]/'tools/research/core14_memory_probe.py')
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)


class ControllerTests(unittest.TestCase):
    def test_affinity_is_existing_subset_not_thread_count(self):
        self.assertEqual(m.two_cpu_mask(0b110100),0b10100)
        self.assertEqual(m.two_cpu_mask(8),8)
        for bad in (0,-1,True,1.5):
            with self.assertRaises(ValueError):m.two_cpu_mask(bad)

    def test_member_paths_cannot_escape(self):
        for bad in ('../x','/x','a\\x','C:x','a/../x','a//x','./a',''):
            with self.assertRaises(ValueError,msg=bad):m.relative_name(bad)
        self.assertEqual(m.relative_name('models/voice.bin'),'models/voice.bin')

    def test_small_overlay_never_overwrites_hardlinked_baseline(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);old=base/'old';old.mkdir();new=base/'new';archive=base/'a.zip'
            (old/'model.bin').write_bytes(b'unchanged model');(old/'manifest.ini').write_bytes(b'version13')
            (old/'dordiai-release.json').write_text('{}')
            data={'model.bin':b'unchanged model','manifest.ini':b'version14'}
            manifest={'version':'14','files':{k:{'size_bytes':len(v),'sha256':m.sha256(v).hexdigest()} for k,v in data.items()}}
            with zipfile.ZipFile(archive,'w') as z:
                for k,v in data.items():z.writestr(k,v)
                z.writestr('dordiai-release.json',json.dumps(manifest))
            integration=SimpleNamespace(ALLOWED_CHANGES={'manifest.ini'},verify_preservation=Mock(return_value={'checked':True}))
            with patch.object(m,'ARCHIVE_BYTES',archive.stat().st_size),patch.object(m,'ARCHIVE_SHA',m.digest(archive)):
                result,facts=m.prepare_stage(archive,old,new,integration)
            self.assertEqual((old/'model.bin').stat().st_ino,(new/'model.bin').stat().st_ino)
            self.assertNotEqual((old/'manifest.ini').stat().st_ino,(new/'manifest.ini').stat().st_ino)
            self.assertEqual((old/'manifest.ini').read_bytes(),b'version13')
            self.assertEqual(facts['hardlinked_payload_files'],1)
            self.assertTrue(m.verify_stage(new,result)['all_payload_sha256_verified'])
            (new/'manifest.ini').write_bytes(b'bad')
            with self.assertRaisesRegex(ValueError,'payload differs'):m.verify_stage(new,result)

    def test_archive_pin_rejected_before_stage_created(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder);a=p/'bad';a.write_bytes(b'bad')
            with self.assertRaisesRegex(ValueError,'archive pin'):m.prepare_stage(a,p,p/'stage',None)
            self.assertFalse((p/'stage').exists())

    def test_suspended_process_affinity_failure_reaps_exact_child(self):
        owner=SimpleNamespace(OwnedNvdaJob=Mock())
        job=owner.OwnedNvdaJob.return_value;job.handle=123
        process=Mock();process.wait.return_value=0
        with patch.object(m,'available_physical',return_value=2*m.MIN_AVAILABLE_BYTES),patch.object(m.subprocess,'Popen',return_value=process),patch.object(m,'restrict_affinity',side_effect=OSError('affinity')):
            spawn=m.OwnedSpawn(Path('python.exe'),owner)
            with self.assertRaisesRegex(OSError,'affinity'):spawn.Popen(['python.exe'])
        process.kill.assert_called_once();process.wait.assert_called_once_with(timeout=5);job.finish.assert_called_once_with(grace_seconds=0)
        job.assign_and_resume.assert_not_called()

    def _cleanup(self,stop_error=False,wait_error=False):
        order=[];process=Mock();process.stdin=io.BytesIO();process.returncode=0;process.poll.return_value=0
        def stop(**kw):
            order.append('stop')
            if stop_error and order.count('stop')==1:raise TimeoutError('keep held')
            return {'sampler_thread_joined':True}
        sampler=SimpleNamespace(stop=Mock(side_effect=stop));job=Mock();job.handle=123
        job.finish.side_effect=lambda **kw:(order.append('job-close') or {'active_after_cleanup':0,'forced_tree_termination':False})
        if wait_error:process.wait.side_effect=[TimeoutError('shutdown'),0]
        spawn=SimpleNamespace(sampler=sampler,process=process,job=job,api=SimpleNamespace(available=[]))
        return m.cleanup_owned(spawn,None,[]),order,process

    def test_sampler_stops_before_job_handle_close(self):
        result,order,process=self._cleanup()
        self.assertEqual(order,['stop','job-close']);self.assertTrue(result['normal_owned_cleanup']);process.kill.assert_not_called()

    def test_sampler_error_is_preserved_even_after_safe_retry(self):
        result,order,_=self._cleanup(stop_error=True)
        self.assertEqual(order,['stop','stop','job-close']);self.assertFalse(result['normal_owned_cleanup'])
        self.assertIn('initial sampler stop',result['cleanup_errors'][0])

    def test_forced_parent_reap_cannot_pass_normal_cleanup(self):
        result,order,process=self._cleanup(wait_error=True)
        process.kill.assert_called_once();self.assertTrue(result['all_owned_processes_reaped']);self.assertFalse(result['normal_owned_cleanup'])

    def test_unjoined_sampler_keeps_job_handle_held_and_fails(self):
        process=Mock();process.stdin=io.BytesIO();process.returncode=0;process.poll.return_value=0
        sampler=SimpleNamespace(stop=Mock(side_effect=TimeoutError('still sampling')))
        job=Mock();job.handle=123
        spawn=SimpleNamespace(sampler=sampler,process=process,job=job,api=SimpleNamespace(available=[]))
        result=m.cleanup_owned(spawn,None,[])
        self.assertEqual(sampler.stop.call_count,2);job.finish.assert_not_called()
        self.assertFalse(result['normal_owned_cleanup']);self.assertFalse(result['all_owned_processes_reaped'])
        self.assertTrue(any('deliberately not closed' in x for x in result['cleanup_errors']))

    def test_no_samples_does_not_invent_zero_ram(self):
        result=m.phase_summary({'snapshots':[]},{'started_ns':1,'finished_ns':2})
        self.assertEqual(result['samples'],0);self.assertIsNone(result['parent_working_set_max_bytes']);self.assertIsNone(result['family_resident_ram_bytes'])


if __name__=='__main__':unittest.main()
