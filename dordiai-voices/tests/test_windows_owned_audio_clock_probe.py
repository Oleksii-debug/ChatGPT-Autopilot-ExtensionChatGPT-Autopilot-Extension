"""No audio/EXE execution: artifact integrity, held-child protocol and full NCC."""
import io
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC=importlib.util.spec_from_file_location('owned_parent_probe',Path(__file__).resolve().parents[1]/'tools/windows_owned_audio_clock_probe.py')
probe=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(probe)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);(self.root/'tools').mkdir()

    def fixture(self,change=None,extra=None):
        data={'owned-clock.exe':b'fixture-not-an-executable','windows_owned_audio_clock.cpp':b'reviewed actual source',
              'windows_process_loopback.cpp':b'frozen source','build.log':b'compiler diagnostics'}
        pins=dict(probe.PINS,source_sha256=probe.sha(data['windows_owned_audio_clock.cpp']),frozen_source_sha256=probe.sha(data['windows_process_loopback.cpp']))
        for name in ('windows_owned_audio_clock.cpp','windows_process_loopback.cpp'):(self.root/'tools'/name).write_bytes(data[name])
        selftest={'status':'self-test-passed','frozen_source_sha256':pins['frozen_source_sha256'],
                  **{k:False for k in ('audio_device_api_called','render_started','capture_started','children_created','product_ready')}}
        data['self-test.json']=json.dumps(selftest).encode()
        tool={'signature_status':'Valid','signer_subject':'CN=Microsoft Corporation, O=Microsoft Corporation',
              'sha256':'c'*64,'signer_thumbprint':'D'*40,'file_version':'1.0'}
        receipt={'format':'dordiai-owned-hardware-clock-build','format_version':1,'repository':pins['repository'],'commit':pins['commit'],
                 'run_id':pins['run_id'],'run_attempt':'1','workflow_ref':pins['repository']+'/.github/workflows/dordiai-owned-clock-build.yml@refs/heads/dordiai-voices/audit-20261122',
                 'source_sha256':pins['source_sha256'],'frozen_source_sha256':pins['frozen_source_sha256'],'runner_os':'Windows','runner_arch':'X64',
                 'helper_executed':True,'helper_execution_mode':'--self-test-only-no-devices','audio_api_called':False,'drivers_installed':False,
                 'dependencies_installed':False,'product_ready':False,'sdk_version':'10.0.26100.0','compiler':dict(tool),'linker':dict(tool),'vswhere':dict(tool),
                 'native_selftest':selftest,'files':{k:{'size_bytes':len(v),'sha256':probe.sha(v)} for k,v in data.items()}}
        if change:change(data,receipt)
        data['build-receipt.json']=json.dumps(receipt).encode()
        path=self.root/'fixture.zip'
        with zipfile.ZipFile(path,'w') as archive:
            for k,v in data.items():archive.writestr(k,v)
            if extra:archive.writestr(extra,b'unsafe')
        pins.update(artifact_bytes=path.stat().st_size,artifact_sha256=probe.sha(path.read_bytes()))
        return path,pins

    def test_complete_fixture_is_verified_without_running_binary(self):
        path,pins=self.fixture()
        with patch.object(probe.subprocess,'Popen',side_effect=AssertionError('never execute fixture')):
            data,receipt=probe.verify_artifact(path,pins=pins,repo=self.root)
        self.assertEqual(len(data),6)
        self.assertFalse(receipt['audio_api_called'])

    def test_outer_size_and_sha_fail_before_any_member_use(self):
        path,pins=self.fixture()
        for key,value in (('artifact_bytes',1),('artifact_sha256','f'*64)):
            p=dict(pins);p[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):probe.verify_artifact(path,pins=p,repo=self.root)

    def test_partial_or_unsafe_member_set_rejected(self):
        for name in ('../owned-clock.exe','nested/owned-clock.exe','pcm\\escape'):
            path,pins=self.fixture(extra=name)
            with self.subTest(name=name),self.assertRaises(ValueError):probe.verify_artifact(path,pins=pins,repo=self.root)

    def test_missing_artifact_member_is_not_a_complete_build(self):
        path,pins=self.fixture(change=lambda data,receipt:data.pop('build.log'))
        with self.assertRaisesRegex(ValueError,'six-member'):probe.verify_artifact(path,pins=pins,repo=self.root)

    def test_member_content_tampering_rejected_even_with_new_zip_pin(self):
        path,pins=self.fixture(change=lambda data,receipt:data.__setitem__('owned-clock.exe',b'tampered'))
        with self.assertRaisesRegex(ValueError,'member SHA/size'):probe.verify_artifact(path,pins=pins,repo=self.root)

    def test_stale_commit_or_source_or_untrusted_compiler_rejected(self):
        changes=[lambda d,r:r.update(commit='d'*40),lambda d,r:r.update(source_sha256='d'*64),
                 lambda d,r:r['compiler'].update(signature_status='NotSigned'),
                 lambda d,r:r['linker'].update(signer_subject='O=Other'),
                 lambda d,r:r['native_selftest'].update(render_started=True)]
        for change in changes:
            path,pins=self.fixture(change=change)
            with self.subTest(change=change),self.assertRaises(ValueError):probe.verify_artifact(path,pins=pins,repo=self.root)

    def test_repo_source_staleness_rejected(self):
        path,pins=self.fixture();(self.root/'tools/windows_owned_audio_clock.cpp').write_bytes(b'stale')
        with self.assertRaisesRegex(ValueError,'repository bytes'):probe.verify_artifact(path,pins=pins,repo=self.root)

    def test_duplicate_json_key_rejected(self):
        with self.assertRaisesRegex(ValueError,'Duplicate'):probe.load_json(b'{"pid":1,"pid":2}')


class ParentPermitTests(unittest.TestCase):
    TIME=134_082_123_456_789_013
    def ready(self):
        return {'format':'dordiai-owned-clock-ready','nonce':'a'*32,'current_pid':123,'process_start_filetime':self.TIME,
                'executable_sha256':'b'*64,'audio_api_called':False}

    def permit(self,row):return probe.ready_permit(row,pid=123,start_filetime=self.TIME,nonce='a'*32,executable_sha256='b'*64)

    def test_exact_FILETIME_above_JS_precision_retains_every_digit(self):
        self.assertIn(str(self.TIME).encode(),self.permit(self.ready()))
        self.assertNotEqual(int(float(self.TIME)),self.TIME)

    def test_float_or_wrong_pid_time_hash_nonce_rejected(self):
        for key,value in (('current_pid',456),('process_start_filetime',float(self.TIME)),('process_start_filetime',self.TIME+1),
                          ('executable_sha256','c'*64),('nonce','c'*32),('audio_api_called',True)):
            row=self.ready();row[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.permit(row)

    def test_unknown_target_pid_or_capture_options_not_accepted(self):
        for key in ('target_pid','exclude_mode','capture_system'):
            row=self.ready();row[key]=True
            with self.subTest(key=key),self.assertRaises(ValueError):self.permit(row)


class RecordingInput:
    def __init__(self):self.data=b'';self.closed=False
    def write(self,data):self.data+=data
    def flush(self):pass
    def close(self):self.closed=True


class FakeOwnedProcess:
    def __init__(self,ready,timeout=False):
        self.pid=123;self._handle=999;self.returncode=None;self.kills=0;self.timeout=timeout
        self.stdin=RecordingInput();self.stderr=io.BytesIO(b'')
        self.stdout=io.BytesIO((json.dumps(ready)+'\n'+json.dumps({'status':'done'})+'\n').encode())
    def poll(self):return self.returncode
    def wait(self,timeout):
        if self.timeout and self.returncode is None:raise probe.subprocess.TimeoutExpired('owned-child',timeout)
        if self.returncode is None:self.returncode=0
        return self.returncode
    def kill(self):self.kills+=1;self.returncode=-9


class OwnChildTests(unittest.TestCase):
    TIME=ParentPermitTests.TIME
    ready=ParentPermitTests.ready
    def execute(self,process):
        with patch.object(probe.subprocess,'Popen',return_value=process) as spawn,patch.object(probe,'child_start_filetime',return_value=self.TIME):
            report=probe.execute_owned(Path('own.exe'),Path('owned'),'a'*32,'b'*64,'describe')
        return report,spawn

    def test_matching_own_child_permit_and_reap(self):
        process=FakeOwnedProcess(self.ready());report,spawn=self.execute(process)
        self.assertIsNone(report['failure']);self.assertTrue(report['own_child_reaped']);self.assertEqual(process.kills,0)
        self.assertIn(str(self.TIME).encode(),process.stdin.data)
        self.assertNotIn('--pid',spawn.call_args.args[0]);self.assertIn(probe.USB_ENDPOINT,spawn.call_args.args[0])

    def test_parent_timeout_kills_only_exact_Popen_child_and_reaps(self):
        process=FakeOwnedProcess(self.ready(),timeout=True);report,spawn=self.execute(process)
        self.assertEqual(process.kills,1);self.assertTrue(report['own_child_reaped']);self.assertTrue(report['forced_own_child_kill'])
        self.assertIn('TimeoutExpired',report['failure']);self.assertEqual(spawn.call_count,1)

    def test_wrong_ready_pid_never_gets_permit_and_only_own_child_is_killed(self):
        ready=self.ready();ready['current_pid']=456;process=FakeOwnedProcess(ready);report,_=self.execute(process)
        self.assertEqual(process.stdin.data,b'');self.assertEqual(process.kills,1);self.assertTrue(report['own_child_reaped'])

    def test_malformed_ready_is_retained_as_failure_without_permit(self):
        process=FakeOwnedProcess(self.ready());process.stdout=io.BytesIO(b'not-json\n')
        report,_=self.execute(process)
        self.assertEqual(process.stdin.data,b'');self.assertEqual(process.kills,1)
        self.assertTrue(report['pipe_errors']);self.assertEqual(report['stdout_raw_utf8'],['not-json\n'])

    def test_changed_defaults_fail_assessment_without_restoring_them(self):
        report={'directory':'unused','nonce':'a'*32,'default_endpoints_unchanged':False,
                'child':{'failure':None,'pipe_errors':[],'exit_code':0,'forced_own_child_kill':False,
                         'own_child_reaped':True,'stdout':[{},{}]}}
        self.assertFalse(probe.analyze_run(report,{},True,None))


class FormatAndMarkerTests(unittest.TestCase):
    def setUp(self):
        try:import numpy as np
        except ImportError:self.skipTest('NumPy waveform-analysis dependency unavailable')
        self.np=np;self.hex=struct.pack('<HHIIHHH',1,2,8000,32000,4,16,0).hex();self.format=probe.parse_format(self.hex)

    def pcm(self,data):return (self.np.clip(data,-1,1)*32767).round().astype('<i2').tobytes()

    def samples(self):
        np=self.np;t=np.arange(800)/8000;ref=.03*np.sin(2*np.pi*(600*t+6000*t*t))
        ref=np.repeat(ref[:,None],2,axis=1);cap=np.concatenate([np.zeros((77,2)),ref*.4,np.zeros((81,2))])
        return ref,cap

    def test_native_format_length_channel_rate_and_kind_fail_closed(self):
        for value in (self.hex+'00','bad',struct.pack('<HHIIHHH',1,1,8000,16000,2,16,0).hex(),struct.pack('<HHIIHHH',3,2,8000,64000,8,16,0).hex()):
            with self.subTest(value=value),self.assertRaises(ValueError):probe.parse_format(value)

    def test_full_marker_and_all_ordinary_windows_use_single_exact_offset(self):
        ref,cap=self.samples();r=probe.marker_analysis(self.pcm(ref),self.pcm(cap),self.format)
        self.assertTrue(r['known_own_marker_correlated']);self.assertEqual(r['matched_capture_array_offset_frames'],77)
        self.assertEqual(len(r['windows']),12);self.assertFalse(r['per_window_offset_search']);self.assertFalse(r['offset_is_calibrated_latency'])

    def test_silence_and_inverted_second_channel_not_correlated(self):
        ref,cap=self.samples()
        for changed in (self.np.zeros_like(cap),cap*self.np.array([1,-1])):
            self.assertFalse(probe.marker_analysis(self.pcm(ref),self.pcm(changed),self.format)['known_own_marker_correlated'])

    def test_partial_marker_and_separately_shifted_windows_not_accepted(self):
        ref,cap=self.samples();cap[77+400:77+600]=0
        self.assertFalse(probe.marker_analysis(self.pcm(ref),self.pcm(cap),self.format)['known_own_marker_correlated'])

    def test_good_marker_does_not_supply_missing_render_or_capture_clock(self):
        ref,cap=self.samples()
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary);data={'owned-clock.exe':b'fake-not-executed'}
            native={'format':'dordiai-owned-hardware-clock-transport','status':'own-marker-transport-complete-clock-quality-not-yet-accepted',
                    'current_pid':123,'target_pid':123,'process_start_filetime':999,'nonce':'a'*32,'executable_sha256':probe.sha(data['owned-clock.exe']),
                    'selected_endpoint':{'id':probe.USB_ENDPOINT},'native_format':{'raw_format_hex':self.hex},'capture_mode':'process-include-current-pid',
                    'children_created':False,'child_processes_created':False,'requested_exclude_mode':False,'timestamps_replaced_or_improved':False,
                    'all_own_com_interfaces_released':True,'async_callback_completed':True,'physical_audio_verified':False,'product_ready':False,
                    'frozen_source_sha256':probe.PINS['frozen_source_sha256'],'marker_duration_ms':100,'marker_peak_limit':.03,'session_limit_ms':1500,
                    'session_through_both_stops_seconds':1.4,
                    'render_clock_frequency_device_units_per_second':48000,'render_maximum_stream_latency_100ns':100000,
                    'render_clock_readings':[{'hresult':'0x00000000','position_device_units':0,'api_qpc_100ns':i*100000,
                                             'qpc_before_ticks':i*10,'qpc_after_ticks':i*10+1} for i in range(3)],
                    'packets':[{'frames':480,'flags':0,'device_position_frames':0,'api_qpc_100ns':i*100000} for i in range(3)]}
            for key,name,raw in (('reference_pcm','reference.pcm',self.pcm(ref)),('captured_pcm','captured.pcm',self.pcm(cap))):
                (directory/name).write_bytes(raw);native[key]={'filename':name,'size_bytes':len(raw),'sha256':probe.sha(raw)}
            (directory/'clock.json').write_text(json.dumps(native),encoding='utf-8')
            report={'directory':str(directory),'nonce':'a'*32,'default_endpoints_unchanged':True,
                    'child':{'failure':None,'pipe_errors':[],'exit_code':0,'forced_own_child_kill':False,'own_child_reaped':True,'stdout':[{},{}],
                             'pid':123,'process_start_filetime':999}}
            self.assertFalse(probe.analyze_run(report,data,False,self.hex))
            self.assertTrue(report['marker_analysis']['known_own_marker_correlated'])
            self.assertFalse(report['clock_assessment']['render_clock']['clock_axis_available'])
            self.assertFalse(report['clock_assessment']['capture_clock']['capture_position_axis_available'])


if __name__=='__main__':unittest.main()
