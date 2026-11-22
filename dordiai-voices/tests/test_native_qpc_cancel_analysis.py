"""Offline packet-QPC axis validity, exact conversion and unchanged signal recipe."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import unittest

try:import numpy as np
except ImportError:raise unittest.SkipTest('Offline waveform dependency unavailable')

SPEC=importlib.util.spec_from_file_location('native_packet_qpc_cancel',Path(__file__).resolve().parents[1]/'tools/native_qpc_cancel_analysis.py')
analysis=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(analysis)


class NativeQPCDiagnosticsTests(unittest.TestCase):
    def fixture(self,frequency=3_000_000):
        rate=24000;base=1_000_000_000
        pcm=np.zeros(rate*2,dtype='<i2');pcm[2400:13200]=100
        packets=[{'frames':240,'retained_frames':240,'retained_offset_frames':i*240,'flags':0,'device_position_frames':0,
                  'qpc_position_100ns':base+i*100000,'observed_qpc_ticks':(base+i*100000)*frequency//10_000_000+frequency//50} for i in range(200)]
        native={'native_format':{'sample_rate':rate,'channels':1,'bits_per_sample':16,'block_align':2,'native_encoding':'pcm16le'},
                'captured_bytes':len(pcm.tobytes()),'captured_frames':len(pcm),'captured_pcm':{'size_bytes':len(pcm.tobytes()),'sha256':hashlib.sha256(pcm.tobytes()).hexdigest()},
                'qpc_frequency':frequency,'qpc_before_capture_start':(base-100000)*frequency//10_000_000,
                'qpc_after_capture_start':(base-99900)*frequency//10_000_000,'packets':packets}
        before=(base+5_000_000)*frequency//10_000_000;after=before+frequency//2000
        clock={'qpc_frequency':frequency,'qpc_before_cancel':before,'qpc_after_cancel':after,
               'perf_before_cancel_ns':before*1_000_000_000//frequency-1000,'perf_after_cancel_ns':after*1_000_000_000//frequency+1000}
        return native,pcm.tobytes(),clock

    def test_native_API_QPC_axis_measured_separately_from_allzero_positions(self):
        native,raw,clock=self.fixture();before=copy.deepcopy(native)
        result=analysis.analyze_cancel(native,raw,clock)
        self.assertEqual(result['software_signal_tail_interval_ms'],[39.5,50.0])
        self.assertEqual(result['raw_device_positions_unique'],[0])
        self.assertFalse(result['capture_device_position_axis_available'])
        self.assertFalse(result['device_positions_or_timestamps_replaced'])
        self.assertTrue(result['strict_cancellation_gate_untouched']);self.assertEqual(native,before)

    def test_raw_frequency_conversion_once_for3MHz_and10MHz(self):
        results=[analysis.analyze_cancel(*self.fixture(frequency)) for frequency in (3_000_000,10_000_000)]
        self.assertEqual(results[0]['software_signal_tail_interval_ms'],results[1]['software_signal_tail_interval_ms'])
        self.assertEqual(results[0]['QPC_conversion_count_for_raw_cancel'],1)
        self.assertFalse(results[0]['packet_API_QPC_converted_again'])

    def test_timestamp_error_discontinuity_even_first_and_unknown_flags_reject(self):
        for index,flags in ((0,1),(80,1),(80,4),(80,5),(80,8)):
            native,raw,clock=self.fixture();native['packets'][index]['flags']=flags
            with self.subTest(index=index,flags=flags),self.assertRaises(ValueError):analysis.analyze_cancel(native,raw,clock)

    def test_missing_nonmonotonic_or_future_packet_timestamp_rejects(self):
        for key,value in (('qpc_position_100ns',0),('qpc_position_100ns',1_000_000_000),('qpc_position_100ns',9_000_000_000),('observed_qpc_ticks',0)):
            native,raw,clock=self.fixture();native['packets'][50][key]=value
            with self.subTest(key=key,value=value),self.assertRaises(ValueError):analysis.analyze_cancel(native,raw,clock)
        native,raw,clock=self.fixture();del native['packets'][50]['qpc_position_100ns']
        with self.assertRaises(ValueError):analysis.analyze_cancel(native,raw,clock)

    def test_missing_packet_or_offsets_or_final_trimming_rejected(self):
        for change in (lambda n:n['packets'].pop(50),lambda n:n['packets'][50].update(retained_offset_frames=0),
                       lambda n:n['packets'][-1].update(retained_frames=239)):
            native,raw,clock=self.fixture();change(native)
            with self.subTest(change=change),self.assertRaises(ValueError):analysis.analyze_cancel(native,raw,clock)

    def test_QPC_gap_or_clock_step_inconsistent_with_frames_rejected(self):
        native,raw,clock=self.fixture()
        for row in native['packets'][50:]:row['qpc_position_100ns']+=100000
        with self.assertRaisesRegex(ValueError,'every preceding packet frame'):analysis.analyze_cancel(native,raw,clock)

    def test_corrupt_or_partial_PCM_cannot_be_reported_as_full_capture(self):
        native,raw,clock=self.fixture()
        for changed in (raw[:-2],raw[:-2]+b'xx'):
            with self.subTest(size=len(changed)),self.assertRaises(ValueError):analysis.analyze_cancel(native,changed,clock)

    def test_missing_or_reversed_public_cancel_clock_bracket_rejected(self):
        for change in (lambda c:c.pop('perf_before_cancel_ns'),lambda c:c.update(qpc_after_cancel=c['qpc_before_cancel']-1),
                       lambda c:c.update(qpc_frequency=1),lambda c:c.update(perf_after_cancel_ns=1)):
            native,raw,clock=self.fixture();change(clock)
            with self.subTest(change=change),self.assertRaises(ValueError):analysis.analyze_cancel(native,raw,clock)

    def test_boolean_integer_metadata_not_accepted(self):
        native,raw,clock=self.fixture();native['packets'][10]['flags']=False
        with self.assertRaises(ValueError):analysis.analyze_cancel(native,raw,clock)

    def test_SILENT_flag_must_match_exact_zero_data(self):
        native,raw,clock=self.fixture();native['packets'][20]['flags']=2
        with self.assertRaisesRegex(ValueError,'SILENT'):analysis.analyze_cancel(native,raw,clock)

    def test_rms_threshold_and_full_post_observation_are_not_relaxed(self):
        native,raw,clock=self.fixture();signal=np.frombuffer(raw,dtype='<i2').copy();signal[signal!=0]=2;raw=signal.tobytes()
        native['captured_pcm']['sha256']=hashlib.sha256(raw).hexdigest()
        result=analysis.analyze_cancel(native,raw,clock)
        self.assertFalse(result['active_before_cancel']);self.assertIsNone(result['software_signal_tail_interval_ms'])

    def test_final_packet_remainder_activity_is_never_ignored(self):
        native,raw,clock=self.fixture();raw+=np.full(5,100,dtype='<i2').tobytes();last=native['packets'][-1]
        native['packets'].append({'frames':5,'retained_frames':5,'retained_offset_frames':48000,'flags':0,'device_position_frames':0,
                                  'qpc_position_100ns':last['qpc_position_100ns']+100000,'observed_qpc_ticks':last['observed_qpc_ticks']+30000})
        native.update(captured_bytes=len(raw),captured_frames=len(raw)//2);native['captured_pcm']={'size_bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        result=analysis.analyze_cancel(native,raw,clock)
        self.assertEqual(result['last_active_window']['window_frames'],5)
        self.assertIsNone(result['software_signal_tail_interval_ms'])
        self.assertEqual(result['post_last_active_or_cancel_observation_ms'],0)


if __name__=='__main__':unittest.main()
