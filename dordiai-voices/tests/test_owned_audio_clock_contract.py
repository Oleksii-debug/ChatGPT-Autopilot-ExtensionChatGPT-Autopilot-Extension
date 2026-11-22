import importlib.util
from pathlib import Path
import unittest

SPEC=importlib.util.spec_from_file_location("clock_contract",Path(__file__).resolve().parents[1]/"tools/owned_audio_clock_contract.py")
clock=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(clock)


class ClockContractTests(unittest.TestCase):
    def test_qpc_raw_ticks_convert_once_to_api_100ns_units(self):
        self.assertEqual(clock.qpc_to_hns(7_000_000,3_000_000),23_333_333)
        self.assertEqual(clock.qpc_to_hns(2**63,1_000_000_000),(2**63)*10_000_000//1_000_000_000)

    def test_position_uses_device_frequency_not_sample_rate(self):
        self.assertEqual(clock.seconds_from_position(384000,192000),2)

    def test_zero_negative_boolean_frequency_rejected(self):
        for value in (0,-1,False,2**64):
            with self.subTest(value=value),self.assertRaises(ValueError):clock.qpc_to_hns(1,value)

    def test_good_render_clock_is_only_clock_axis(self):
        report=clock.assess_render_clock([{'hresult':0,'position':0,'qpc_hns':20_000_000},{'hresult':0,'position':96000,'qpc_hns':30_000_000}],96000)
        self.assertTrue(report['clock_axis_available'])
        self.assertEqual(report['position_delta_seconds'],1)
        self.assertFalse(report['physical_audio_verified'])
        self.assertFalse(report['actual_NVDA_verified'])

    def test_all_zero_positions_never_gain_synthetic_frame_counter(self):
        packets=[{'frames':480,'flags':0,'device_position_frames':0,'qpc_hns':i*100000} for i in range(3)]
        report=clock.assess_capture_positions(packets)
        self.assertFalse(report['capture_position_axis_available'])
        self.assertFalse(report['software_frame_counter_substituted'])
        self.assertEqual(report['raw_packets'],packets)

    def test_timestamp_error_and_discontinuity_not_accurate_packet_axis(self):
        for flags in (1,4,5):
            packets=[{'frames':480,'flags':flags,'device_position_frames':i*480,'qpc_hns':i*100000} for i in range(3)]
            with self.subTest(flags=flags):self.assertFalse(clock.assess_capture_positions(packets)['capture_position_axis_available'])

    def test_packet_positions_without_correlated_qpc_progress_not_clock_proof(self):
        packets=[{'frames':480,'flags':0,'device_position_frames':i*480,'qpc_hns':0} for i in range(3)]
        self.assertFalse(clock.assess_capture_positions(packets)['capture_position_axis_available'])

    def test_backwards_readings_not_hidden_by_sort(self):
        rows=[{'hresult':0,'position':480,'qpc_hns':100000},{'hresult':0,'position':10,'qpc_hns':200000}]
        self.assertEqual(clock.assess_render_clock(rows,48000)['reason'],'position_or_qpc_moved_backwards')

    def test_S_FALSE_is_preserved_but_not_promoted_to_accurate(self):
        rows=[{'hresult':1,'position':i*480,'qpc_hns':i*100000} for i in range(3)]
        report=clock.assess_render_clock(rows,48000)
        self.assertFalse(report['clock_axis_available'])
        self.assertEqual(report['raw_readings'],rows)

    def request(self):
        return {'format':'dordiai-owned-clock-design-v1','mode':'self-test','nonce':'a'*32,'expected_executable_sha256':'b'*64,
                'render_endpoint_id':'{0.0.0.00000000}.{fc1f7846-3543-4cff-aaee-de24d7de09b4}',
                'maximum_capture_ms':1500,'marker_duration_ms':100,'marker_peak':.03}

    def validate(self,request):
        return clock.validate_proposed_request(request,parent_observed_child_pid=1234,expected_nonce='a'*32,
                  expected_endpoint_id=self.request()['render_endpoint_id'],expected_executable_sha256='b'*64)

    def test_design_request_never_enables_audio(self):
        report=self.validate(self.request())
        self.assertTrue(report['validated_design_only'])
        self.assertFalse(report['audio_api_called'])
        self.assertFalse(report['actual_run_implemented'])

    def test_arbitrary_pid_exclude_mode_or_run_mode_rejected(self):
        for key,value in (('target_pid',999),('exclude_mode',True),('mode','run'),('capture_system',True)):
            req=self.request();req[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.validate(req)

    def test_mismatched_nonce_endpoint_and_binary_rejected(self):
        for key,value in (('nonce','c'*32),('render_endpoint_id','other'),('expected_executable_sha256','d'*64)):
            req=self.request();req[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.validate(req)

    def test_unbounded_marker_or_duration_rejected(self):
        for key,value in (('marker_duration_ms',5000),('maximum_capture_ms',300000),('marker_peak',1)):
            req=self.request();req[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.validate(req)

    def test_cpp_design_contains_no_audio_start_or_activation_code(self):
        source=(Path(__file__).resolve().parents[1]/'tools/windows_owned_audio_clock_design.cpp').read_text(encoding='utf-8')
        for token in ('ActivateAudioInterfaceAsync(', 'CoCreateInstance(', '->Start(', 'IAudioCaptureClient', 'CreateProcessW('):
            self.assertNotIn(token,source)
        self.assertIn('argc!=2',source)
        self.assertIn('actual_run_implemented',source)


if __name__=='__main__':unittest.main()
