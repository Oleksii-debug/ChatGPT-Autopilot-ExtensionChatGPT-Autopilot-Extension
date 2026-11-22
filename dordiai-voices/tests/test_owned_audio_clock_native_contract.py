"""Pure source/receipt guards; never activates COM, audio or an EXE."""
import hashlib
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location("native_clock_contract",ROOT/'tools/owned_audio_clock_contract.py')
clock=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(clock)


class NativeClockContractTests(unittest.TestCase):
    def receipt(self):
        return {'format':'dordiai-owned-hardware-clock-transport','status':'own-marker-transport-complete-clock-quality-not-yet-accepted',
                'current_pid':123,'target_pid':123,'process_start_filetime':999,'nonce':'a'*32,'executable_sha256':'b'*64,
                'selected_endpoint':{'id':'explicit-endpoint'},'native_format':{'raw_format_hex':'native-bytes'},
                'capture_mode':'process-include-current-pid','children_created':False,'child_processes_created':False,
                'requested_exclude_mode':False,'timestamps_replaced_or_improved':False,'all_own_com_interfaces_released':True,
                'async_callback_completed':True,'physical_audio_verified':False,'product_ready':False,
                'render_clock_frequency_device_units_per_second':48000,'render_maximum_stream_latency_100ns':100000,
                'render_clock_readings':[{'hresult':'0x00000000','position_device_units':i*480,'api_qpc_100ns':100000+i*100000,
                                         'qpc_before_ticks':i*100,'qpc_after_ticks':i*100+1} for i in range(3)],
                'packets':[{'frames':480,'flags':0,'device_position_frames':0,'api_qpc_100ns':100000+i*100000} for i in range(3)]}

    def assess(self,report):
        return clock.assess_native_receipt(report,child_pid=123,process_start_filetime=999,nonce='a'*32,
                    executable_sha256='b'*64,endpoint_id='explicit-endpoint',native_format_hex='native-bytes')

    def test_real_render_clock_does_not_fill_zero_process_capture_positions(self):
        report=self.assess(self.receipt())
        self.assertTrue(report['render_clock']['clock_axis_available'])
        self.assertFalse(report['capture_clock']['capture_position_axis_available'])
        self.assertFalse(report['capture_clock']['render_clock_axis_substituted'])
        self.assertEqual(report['render_maximum_stream_latency_ms'],10)
        self.assertFalse(report['maximum_latency_is_measured_audible_onset'])
        self.assertFalse(report['product_ready'])

    def test_ownership_and_audio_claim_tampering_rejected(self):
        for key,value in (('target_pid',4),('current_pid',4),('process_start_filetime',998),('nonce','c'*32),
                          ('executable_sha256','c'*64),('requested_exclude_mode',True),('children_created',True),
                          ('timestamps_replaced_or_improved',True),('physical_audio_verified',True),('product_ready',True),
                          ('async_callback_completed',False),('all_own_com_interfaces_released',False)):
            row=self.receipt();row[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.assess(row)

    def test_exact_endpoint_and_unchanged_format_bound(self):
        for key,value in (('selected_endpoint',{'id':'default'}),('native_format',{'raw_format_hex':'changed'})):
            row=self.receipt();row[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.assess(row)

    def test_early_or_failed_clock_hresult_never_promoted(self):
        row=self.receipt()
        for clock_row in row['render_clock_readings']:clock_row['hresult']='0x00000001'
        self.assertFalse(self.assess(row)['render_clock']['clock_axis_available'])

    def test_timestamp_error_packet_preserved(self):
        row=self.receipt();row['packets'][0]['flags']=4
        report=self.assess(row)
        self.assertEqual(report['capture_clock']['timestamp_error_packets'],1)
        self.assertEqual(row['packets'][0]['device_position_frames'],0)

    def test_frozen_source_exact_and_legacy_entrypoint_not_called(self):
        source=(ROOT/'tools/windows_process_loopback.cpp').read_bytes()
        self.assertEqual(hashlib.sha256(source).hexdigest(),'eba7fd78469298b7c4c300fdd80c9da18ffb1d03323c8b72230d92ff59448012')
        cpp=(ROOT/'tools/windows_owned_audio_clock.cpp').read_text(encoding='utf-8')
        self.assertIn('#define wmain dordiai_frozen_hosted_main_not_an_entrypoint',cpp)
        self.assertNotIn('dordiai_frozen_hosted_main_not_an_entrypoint(',cpp)
        self.assertNotIn('guard_environment();',cpp)

    def test_ownership_format_and_handshake_precede_COM(self):
        cpp=(ROOT/'tools/windows_owned_audio_clock.cpp').read_text(encoding='utf-8')
        main=cpp[cpp.index('int wmain('):]
        for token in ('local_format(unhex(args[','Own executable SHA differs','Parent-observed own PID/time/hash permit differs','Fresh nonce directory may contain only'):
            self.assertLess(main.index(token),main.index('CoInitializeEx('))

    def test_no_system_controls_or_external_child_creation(self):
        cpp=(ROOT/'tools/windows_owned_audio_clock.cpp').read_text(encoding='utf-8')
        for token in ('SetMasterVolume','SetDefaultEndpoint','SetMute(','CreateProcess','ShellExecute','GetDefaultAudioEndpoint('):
            self.assertNotIn(token,cpp)
        self.assertIn('TerminateProcess(GetCurrentProcess(),124)',cpp)
        self.assertIn('std::chrono::milliseconds(1400)',cpp)
        self.assertIn('if(seconds>1.5)',cpp)
        self.assertIn('WaitForSingleObject(completion->event(),5000)',cpp)

    def test_build_workflow_pins_actions_and_only_executes_no_device_selftest(self):
        workflow=(ROOT.parent/'.github/workflows/dordiai-owned-clock-build.yml').read_text(encoding='utf-8')
        self.assertIn('actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',workflow)
        self.assertIn('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',workflow)
        self.assertIn('Get-AuthenticodeSignature',workflow)
        self.assertIn("helper_execution_mode='--self-test-only-no-devices'",workflow)
        self.assertIn('& $exe --self-test',workflow)
        self.assertIn("git config --global core.autocrlf false",workflow)
        self.assertLess(workflow.index('core.autocrlf false'),workflow.index('actions/checkout@'))
        self.assertIn("contains(github.event.head_commit.message, '[owned-clock-build]')",workflow)
        self.assertIn(hashlib.sha256((ROOT/'tools/windows_owned_audio_clock.cpp').read_bytes()).hexdigest(),workflow)
        for forbidden in ('--mode run','--mode describe','winget install','choco install','pip install'):
            self.assertNotIn(forbidden,workflow)


if __name__=='__main__':unittest.main()
