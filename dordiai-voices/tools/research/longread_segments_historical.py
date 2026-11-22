from pathlib import Path
import json,math,hashlib,numpy as np
root=Path(__file__).resolve().parent/'extracted';run=next(p for p in root.glob('nvda-*') if p.is_dir());p=json.loads((run/'plugin-longread.json').read_text());native=json.loads((run/'longread-capture/capture.json').read_text());r=np.frombuffer((run/'longread-reference.pcm').read_bytes(),dtype='<i2').astype(float);s=np.frombuffer((run/'longread-capture/captured.pcm').read_bytes(),dtype='<i2').astype(float);rate=24000
bounds=[0,16145,287995,574823,len(r)];offsets=[76865,77760,78310,78522];segments=[];gaps=[]
for first,last,off in zip(bounds[:-1],bounds[1:],offsets):
 a=r[first:last];b=s[first+off:last+off];ac=a-a.mean();bc=b-b.mean();ncc=float(np.dot(ac,bc)/np.sqrt(np.dot(ac,ac)*np.dot(bc,bc)))
 segments.append({'reference_first_frame':first,'reference_last_exclusive':last,'capture_offset_frames':off,'frames':len(a),'ncc':ncc})
packets=native['packets'];qpc0=packets[0]['qpc_position_100ns'];events=p['feed_events']
for i,bound in enumerate(bounds[1:-1],1):
 first=bound+offsets[i-1];last=bound+offsets[i];part=s[first:last];j=next(j for j,e in enumerate(events) if e['reference_offset_frames']==bound)
 before=events[j]['before_feed_ns'];previous=events[j-1]['after_feed_ns']
 gap_first=qpc0+first/rate*10_000_000;gap_last=qpc0+last/rate*10_000_000
 around=[];retained=0
 for k,row in enumerate(packets):
  if retained+row['retained_frames']>=first-480 and retained<=last+480:around.append({'packet':k,'retained_first_frame':retained,**row})
  retained+=row['retained_frames']
 gaps.append({'reference_boundary_frame':bound,'reference_boundary_seconds':bound/rate,'feed_event_index':j,
  'capture_first_frame':first,'capture_last_exclusive':last,'added_frames':last-first,'added_ms':(last-first)/rate*1000,
  'captured_piece_peak_lsb':float(np.max(np.abs(part))),'captured_piece_rms_lsb':float(np.sqrt(np.mean(part*part))),
  'feed_gap_before_next_call_ms':(before-previous)/1e6,
  'capture_gap_start_minus_previous_feed_return_ms':(gap_first*100-previous)/1e6,
  'next_feed_call_minus_capture_gap_end_ms':(before-gap_last*100)/1e6,
  'clock_scope':'Raw software capture packet QPC and Python perf_counter timeline; no physical queued-audio depth or acoustic latency claim',
  'nearby_packets':around})
report={'format':'dordiai-diagnostic-feed-boundary-segment-comparison','format_version':1,'source_run_id':45049366545,
 'scope':'Diagnostic only: four complete adjacent reference segments at independently observed local offsets and ACTUAL feed-call boundaries; this does not repair or pass the failed single-offset full-reference gate',
 'full_reference_ncc':.5856072658391752,'full_reference_gate_passed':False,'warped_waveform_created':False,
 'reference_frames':len(r),'captured_frames':len(s),'sample_rate':rate,'segments':segments,'observed_added_intervals':gaps,
 'sum_added_frames':sum(g['added_frames'] for g in gaps),'sum_added_ms':sum(g['added_ms'] for g in gaps),
 'underrun_cause_not_established_from_this_comparison_alone':True,'physical_audio_verified':False,'acoustic_latency_verified':False,'product_ready':False}
Path(__file__).with_name('feed-boundary-diagnostic.json').write_text(json.dumps(report,sort_keys=True,indent=2)+'\n')
print(json.dumps({'segments':segments,'gaps':[{k:v for k,v in g.items() if k not in ['nearby_packets','clock_scope']} for g in gaps],'sum_added_ms':report['sum_added_ms']}))
