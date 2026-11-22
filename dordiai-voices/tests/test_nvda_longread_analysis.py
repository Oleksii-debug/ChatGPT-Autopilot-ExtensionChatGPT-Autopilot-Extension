import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import numpy as np
import nvda_longread_analysis as a

RATE=24000

def raw(x):return np.clip(x,-32768,32767).astype('<i2').tobytes()
def packets(frames,rate=RATE,start=10_000_000):
    return [{'frames':min(240,frames-i),'retained_frames':min(240,frames-i),'flags':0,
             'device_position_frames':i,'qpc_position_100ns':start+round(i*10_000_000/rate)} for i in range(0,frames,240)]
def voice(seconds=4):
    rng=np.random.default_rng(713);noise=rng.normal(0,3500,RATE*seconds)
    # Random nonperiodic, speech-like correlated waveform, no fitted matching.
    return np.convolve(noise,[.3,.5,.3],mode='same')

class Longread(unittest.TestCase):
    def check_signal(self,reference,capture):return a.analyze_longread(raw(reference),raw(capture),RATE,packets(len(capture)))
    def test_stable_full_stream(self):
        r=voice();c=np.concatenate((np.zeros(555),r*.997,np.zeros(1000)))
        p=self.check_signal(r,c);self.assertTrue(p['full_reference_transport_verified']);self.assertTrue(p['no_new_transport_gap_verified']);self.assertEqual(p['fixed_offset_frames'],555)
    def test_natural_reference_pause_is_not_new_gap(self):
        r=voice();r[RATE:RATE+RATE//4]=0;p=self.check_signal(r,np.concatenate((np.zeros(500),r,np.zeros(500))))
        self.assertTrue(p['no_new_transport_gap_verified']);self.assertEqual(p['active_drop_windows'],[])
    def test_inserted_pause_not_warped_to_pass(self):
        r=voice();mid=2*RATE;c=np.concatenate((np.zeros(500),r[:mid],np.zeros(RATE//5),r[mid:],np.zeros(500)))
        p=self.check_signal(r,c);self.assertFalse(p['full_reference_transport_verified']);self.assertFalse(p['no_new_transport_gap_verified']);self.assertFalse(p['dynamic_warp_or_resampling_used'])
    def test_middle_word_audio_drop_fails(self):
        r=voice();c=np.concatenate((np.zeros(500),r,np.zeros(500)));c[500+RATE:500+RATE+RATE//20]=0
        p=self.check_signal(r,c);self.assertTrue(p['active_drop_windows']);self.assertFalse(p['no_new_transport_gap_verified'])
    def test_periodic_ambiguous_anchors_cannot_pass_gap(self):
        r=np.sin(np.arange(RATE*4)*2*np.pi*200/RATE)*4000;p=self.check_signal(r,np.concatenate((np.zeros(500),r,np.zeros(500))))
        self.assertTrue(p['full_reference_transport_verified']);self.assertFalse(p['no_new_transport_gap_verified']);self.assertEqual(p['gap_gate_status'],'open-clock-or-anchor-ambiguity')
    def test_clock_drift_cannot_masquerade_as_verified_continuity(self):
        r=voice();positions=np.linspace(0,len(r)-1,len(r)+40);c=np.interp(positions,np.arange(len(r)),r)
        p=self.check_signal(r,np.concatenate((np.zeros(500),c,np.zeros(500))))
        self.assertFalse(p['no_new_transport_gap_verified'])
    def test_missing_complete_end_rejected(self):
        r=voice()
        with self.assertRaises(ValueError):self.check_signal(r,r[:-1])
    def test_constant_reference_rejected(self):
        with self.assertRaises(ValueError):self.check_signal(np.ones(RATE)*1000,np.ones(RATE*2)*1000)
    def test_bad_packet_accounting_rejected(self):
        with self.assertRaises(ValueError):a.packet_integrity(packets(500),499,RATE)
    def test_later_packet_discontinuity_opens_gate(self):
        r=voice();p=packets(len(r));p[3]['flags']=1
        result=a.analyze_longread(raw(r),raw(r),RATE,p);self.assertFalse(result['no_new_transport_gap_verified'])
    def test_initial_discontinuity_not_confused_with_read_gap(self):
        p=packets(500);p[0]['flags']=1;self.assertTrue(a.packet_integrity(p,500,RATE)['continuous'])
    def test_initial_timestamp_error_keeps_clock_gate_open(self):
        r=voice();p=packets(len(r));p[0]['flags']=4
        result=a.analyze_longread(raw(r),raw(r),RATE,p)
        self.assertTrue(result['full_reference_transport_verified']);self.assertFalse(result['packet_integrity']['continuous']);self.assertFalse(result['no_new_transport_gap_verified'])
    def test_packet_quota_matches_ninety_seconds(self):
        p=packets(RATE*90);self.assertEqual(len(p),9000);self.assertTrue(a.packet_integrity(p,RATE*90,RATE)['continuous']);self.assertGreater(a.MAX_PACKETS,len(p))
    def test_partial_nonfinal_packet_rejected(self):
        p=packets(500);p[0]['retained_frames']=239
        with self.assertRaises(ValueError):a.packet_integrity(p,499,RATE)
    def test_timestamp_jump_leaves_gate_open(self):
        p=packets(500);p[1]['qpc_position_100ns']+=50000;self.assertFalse(a.packet_integrity(p,500,RATE)['continuous'])
    def test_software_cancel_interval_and_no_resumption(self):
        r=np.zeros(RATE*2);r[:RATE//2]=voice(1)[:RATE//2]
        clock={'qpc_frequency':10_000_000,'qpc_before_cancel':14_900_000,'qpc_after_cancel':14_910_000,'perf_before_cancel_ns':490000000,'perf_after_cancel_ns':491000000}
        p=a.cancellation_tail(raw(r),RATE,packets(len(r)),clock)
        self.assertEqual(p['gate_status'],'measured-software-only');self.assertGreaterEqual(p['software_tail_interval_ms'][1],10);self.assertFalse(p['acoustic_latency_verified'])
    def test_no_prior_speech_cannot_pass_cancel(self):
        clock={'qpc_frequency':10_000_000,'qpc_before_cancel':14_900_000,'qpc_after_cancel':14_910_000,'perf_before_cancel_ns':490000000,'perf_after_cancel_ns':491000000}
        self.assertEqual(a.cancellation_tail(raw(np.zeros(RATE*2)),RATE,packets(RATE*2),clock)['gate_status'],'open')
    def test_timestamp_error_prevents_cancel_measurement(self):
        r=np.zeros(RATE*2);r[:RATE//2]=voice(1)[:RATE//2];p=packets(len(r));p[2]['flags']=4
        clock={'qpc_frequency':10_000_000,'qpc_before_cancel':14_900_000,'qpc_after_cancel':14_910_000,'perf_before_cancel_ns':490000000,'perf_after_cancel_ns':491000000}
        self.assertEqual(a.cancellation_tail(raw(r),RATE,p,clock)['gate_status'],'open')
    def test_cancel_remainder_resumption_is_not_ignored(self):
        frames=RATE*3;r=np.zeros(frames);r[:RATE//2]=voice(1)[:RATE//2]
        rows=[]
        for first in range(0,frames,241):
            count=min(241,frames-first)
            rows.append({'frames':count,'retained_frames':count,'flags':0,'device_position_frames':first,
                         'qpc_position_100ns':10_000_000+round(first*10_000_000/RATE)})
        # This burst occupies ONLY a packet's one-sample 10ms remainder, after
        # a long quiet period and too near capture end for sustained silence.
        r[241*270+240]=5000
        clock={'qpc_frequency':10_000_000,'qpc_before_cancel':14_900_000,'qpc_after_cancel':14_910_000,'perf_before_cancel_ns':490000000,'perf_after_cancel_ns':491000000}
        self.assertEqual(a.cancellation_tail(raw(r),RATE,rows,clock)['gate_status'],'open')
    def test_invalid_clock_rejected(self):
        with self.assertRaises(ValueError):a.cancellation_tail(raw(np.ones(RATE)),RATE,packets(RATE),{})

if __name__=='__main__':unittest.main()
