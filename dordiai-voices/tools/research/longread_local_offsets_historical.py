from pathlib import Path
import json,sys,numpy as np
sys.path.insert(0,'/workspace/scratch/eb1194a9e557/nvda-process-capture-review/tools')
from nvda_longread_analysis import ncc_windows
root=Path(__file__).resolve().parent/'extracted';run=next(p for p in root.glob('nvda-*') if p.is_dir());p=json.loads((run/'plugin-longread.json').read_text());rate=p['sample_rate']
r=np.frombuffer((run/'longread-reference.pcm').read_bytes(),dtype='<i2').astype(float)/32768
s=np.frombuffer((run/'longread-capture/captured.pcm').read_bytes(),dtype='<i2').astype(float)/32768
width=rate//4;search=rate//2;hop=rate//20;global_offset=78522
ranges=[(0,2*rate),(11*rate,13*rate),(23*rate,25*rate)]
rows=[]
for low,high in ranges:
 for start in range(low,high,hop):
  anchor=r[start:start+width]
  if len(anchor)!=width or float(np.sqrt(np.mean(anchor*anchor)))<256/32768:continue
  left=max(0,global_offset+start-search);right=min(len(s),global_offset+start+search+width)
  v,_=ncc_windows(anchor,s[left:right]);best=int(np.argmax(v));other=v.copy();other[max(0,best-48):min(len(v),best+49)]=-1;second=float(np.max(other))
  rows.append({'reference_start_frame':start,'reference_end_frame':start+width,'capture_start_frame':left+best,'offset_frames':left+best-start,'ncc':float(v[best]),'competing_ncc':second,'confident':float(v[best])>=.98 and float(v[best])-second>=.02})
report={'format':'dordiai-diagnostic-local-offsets-not-a-pass','source_run_id':45049366545,'scope':'Short local anchors ONLY to locate observed offset changes; never used to warp, resample, or convert the failed whole-reference result to a pass','fixed_full_reference_ncc_gate_still_failed':True,'window_frames':width,'hop_frames':hop,'rows':rows}
Path(__file__).with_name('local-offset-diagnostic.json').write_text(json.dumps(report,sort_keys=True,indent=2)+'\n')
last=None
for row in rows:
 if row['confident'] and row['offset_frames']!=last:
  print(json.dumps({**row,'reference_start_sec':row['reference_start_frame']/rate}));last=row['offset_frames']
print('Most relevant feed submission gaps')
ev=p['feed_events']
for i,e in enumerate(ev):
 if i and (e['before_feed_ns']-ev[i-1]['after_feed_ns'])/1e6>150:print(json.dumps({'index':i,'reference_offset':e['reference_offset_frames'],'reference_seconds':e['reference_offset_frames']/rate,'submission_gap_ms':(e['before_feed_ns']-ev[i-1]['after_feed_ns'])/1e6}))
